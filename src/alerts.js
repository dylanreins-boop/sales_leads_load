// Speed to lead: a new Facebook, website or text lead pings the sales team's phones right away. If
// nobody has called, texted or logged anything on it within a few minutes, the admins get pinged.
// Alerts only go out during alert hours (7 AM to 8 PM by default); a lead that comes in overnight
// is alerted when alert hours start. Customer text replies ping the rep working that lead.
const { toE164 } = require('./sms');

const ALERT_SOURCES = ['facebook', 'website', 'text', 'online'];
const FRESH_MS = 2 * 3600000; // older leads (e.g. a Facebook sync catching up) don't ping anyone

function createAlertService(db, { leads, users, push, texter, minutes = 15, hours = { start: 7, end: 20 } }) {
  const stmt = (sql) => db.prepare(sql);
  const norm = (name) => String(name ?? '').trim().toLowerCase();
  const nowIso = () => new Date().toISOString();

  const inHours = (at) => at.getHours() >= hours.start && at.getHours() < hours.end;
  function nextStart(at) {
    const d = new Date(at);
    if (d.getHours() >= hours.end) d.setDate(d.getDate() + 1);
    d.setHours(hours.start, 0, 0, 0);
    return d;
  }

  // ---- each person's alert settings ----
  function prefs(name) {
    const row = stmt('SELECT * FROM user_prefs WHERE name_norm = ?').get(norm(name));
    return { alert_phone: row?.alert_phone || '', devices: push.devicesFor(name), texting: texter.configured };
  }
  function savePrefs(name, { alert_phone: phone } = {}) {
    const clean = String(phone ?? '').trim();
    if (clean && !toE164(clean)) throw Object.assign(new Error('That doesn\'t look like a mobile number.'), { status: 400 });
    stmt(`INSERT INTO user_prefs (name_norm, name, alert_phone, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT (name_norm) DO UPDATE SET alert_phone = excluded.alert_phone, updated_at = excluded.updated_at`)
      .run(norm(name), name, clean || null, nowIso());
    return prefs(name);
  }

  const people = (roles) => users.list().filter((u) => u.active && roles.includes(u.role)).map((u) => u.name);

  // Phone alert to every device each person turned on, plus a text if they gave a number.
  async function deliver(names, message) {
    const reached = new Set(await push.sendTo(names, message));
    if (texter.configured) {
      for (const name of names) {
        const phone = stmt('SELECT alert_phone FROM user_prefs WHERE name_norm = ?').get(norm(name))?.alert_phone;
        if (!phone) continue;
        try {
          await texter.send({ to: phone, body: `${message.title}: ${message.body}${message.link ? ` ${message.link}` : ''}` });
          reached.add(name);
        } catch (err) { console.error(`Alert text to ${name} failed:`, err.message); }
      }
    }
    return [...reached];
  }

  const leadName = (l) => l.full_name || [l.first_name, l.last_name].filter(Boolean).join(' ') || l.phone || l.email || 'New lead';
  const vehicle = (l) => [l.vehicle_year, l.vehicle_make, l.vehicle_model].filter(Boolean).join(' ') || l.vehicle_type || '';
  const SOURCE = { facebook: 'Facebook', website: 'the website', text: 'a text message', online: 'online booking' };

  // A brand-new lead: schedule its alert (now, or when alert hours start).
  function leadArrived(lead, at = new Date()) {
    if (!ALERT_SOURCES.includes(lead.source)) return;
    if (at - new Date(lead.received_at) > FRESH_MS) return;
    const due = inHours(at) ? at : nextStart(at);
    stmt('UPDATE leads SET alert_due_at = ? WHERE id = ?').run(due.toISOString(), lead.id);
  }

  // Has anyone worked the lead since the alert went out?
  function worked(lead, since) {
    if (lead.stage !== 'new') return true;
    return Boolean(stmt(`SELECT 1 FROM activities WHERE lead_id = ? AND created_at >= ? AND user_name IS NOT NULL
                         AND type IN ('disposition', 'stage_change', 'text', 'note', 'email') LIMIT 1`).get(lead.id, since));
  }

  // Sends the alerts that are due; runs every minute (and right after a new lead comes in).
  async function process({ at = new Date(), baseUrl = '' } = {}) {
    if (!inHours(at)) return { alerted: 0, escalated: 0 };
    const ts = at.toISOString();
    let alerted = 0;
    let escalated = 0;
    const due = stmt(`SELECT * FROM leads WHERE alert_due_at IS NOT NULL AND alert_due_at <= ? AND alerted_at IS NULL AND archived_at IS NULL`).all(ts);
    for (const lead of due) {
      stmt('UPDATE leads SET alerted_at = ? WHERE id = ?').run(ts, lead.id);
      if (worked(lead, lead.received_at)) continue;
      const team = people(['sales']);
      const to = team.length ? team : people(['admin']);
      const reached = await deliver(to, {
        title: `New lead: ${leadName(lead)}`,
        body: [vehicle(lead), `from ${SOURCE[lead.source] || lead.source}`, lead.phone && `Call ${lead.phone}`].filter(Boolean).join(' · '),
        url: `/?lead=${lead.id}`,
        link: baseUrl ? `${baseUrl}/?lead=${lead.id}` : '',
        tag: `lead-${lead.id}`,
      });
      leads.logActivity(lead.id, 'alert', { note: reached.length ? `New-lead alert sent to ${reached.join(', ')}` : 'New-lead alert: nobody has phone alerts turned on yet' });
      alerted++;
    }
    const cutoff = new Date(at.getTime() - minutes * 60000).toISOString();
    const late = stmt(`SELECT * FROM leads WHERE alerted_at IS NOT NULL AND alerted_at <= ? AND escalated_at IS NULL AND archived_at IS NULL`).all(cutoff);
    for (const lead of late) {
      stmt('UPDATE leads SET escalated_at = ? WHERE id = ?').run(ts, lead.id);
      if (worked(lead, lead.alerted_at)) continue;
      const waited = Math.round((at - new Date(lead.alerted_at)) / 60000);
      const reached = await deliver(people(['admin']), {
        title: `Nobody has called ${leadName(lead)} yet`,
        body: `New lead from ${SOURCE[lead.source] || lead.source} ${waited} minutes ago${lead.phone ? ` · ${lead.phone}` : ''}`,
        url: `/?lead=${lead.id}`,
        link: baseUrl ? `${baseUrl}/?lead=${lead.id}` : '',
        tag: `lead-${lead.id}-late`,
      });
      leads.logActivity(lead.id, 'alert', { note: `Not worked within ${minutes} minutes${reached.length ? `; admins alerted (${reached.join(', ')})` : ''}` });
      escalated++;
    }
    return { alerted, escalated };
  }

  // A customer texted back: ping whoever last worked the lead, or the whole sales team.
  async function replied(lead, text, { baseUrl = '' } = {}) {
    const last = stmt(`SELECT user_name FROM activities WHERE lead_id = ? AND user_name IS NOT NULL ORDER BY id DESC LIMIT 1`).get(lead.id)?.user_name;
    const active = last && users.list().some((u) => u.active && norm(u.name) === norm(last) && u.role !== 'shop');
    return deliver(active ? [last] : people(['sales', 'admin']), {
      title: `Text from ${leadName(lead)}`,
      body: text.slice(0, 180),
      url: `/?lead=${lead.id}`,
      link: baseUrl ? `${baseUrl}/?lead=${lead.id}` : '',
      tag: `text-${lead.id}`,
    });
  }

  return { prefs, savePrefs, leadArrived, process, replied, inHours, notify: deliver };
}

module.exports = { createAlertService, ALERT_SOURCES };
