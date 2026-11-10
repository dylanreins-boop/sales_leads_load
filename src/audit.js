'use strict';
// The admin log: who signed in (and failed to), exported data, changed logins and roles, edited time and
// pay, moved money, changed settings or deleted something, when, and from where. Admins read it under
// Settings → Admin log. Passwords and other secrets are never written here.

// Which requests are logged, the area they belong to, and how they read.
const RULES = [
  { area: 'team', methods: ['POST'], re: /^\/api\/users$/, say: (b) => `Added the login ${b.name || ''}${b.role ? ` (${b.role})` : ''}` },
  { area: 'team', methods: ['PATCH'], re: /^\/api\/users\/\d+$/, say: (b, r) => `Changed the login ${r?.name || ''}: ${changed(b)}` },
  { area: 'payroll', methods: ['POST', 'PATCH', 'DELETE'], re: /^\/api\/time\/punches(\/\d+)?$/, say: (b, r, m) => `${m === 'POST' ? 'Added' : m === 'DELETE' ? 'Removed' : 'Changed'} clocked time${b.user_name || r?.user_name ? ` for ${b.user_name || r.user_name}` : ''}` },
  { area: 'payroll', methods: ['PUT'], re: /^\/api\/pay-rates$/, say: (b) => `Set the hourly rate for ${b.user_name || 'someone'}` },
  { area: 'payroll', methods: ['PUT'], re: /^\/api\/payroll\/settings$/, say: (b) => `Changed the payroll rules: ${changed(b)}` },
  { area: 'payroll', methods: ['POST'], re: /^\/api\/payroll\/weeks\/[^/]+\/(approve|email)$/, say: (b, r, m, p) => (p.endsWith('approve') ? 'Approved a payroll week' : 'Emailed a payroll week') },
  { area: 'payroll', methods: ['PATCH'], re: /^\/api\/(timecard\/corrections|time-off)\/\d+$/, say: (b, r, m, p) => `${b.status === 'approved' ? 'Approved' : b.status === 'denied' ? 'Denied' : 'Changed'} ${p.includes('time-off') ? 'a time-off request' : 'a timecard correction'}` },
  { area: 'money', methods: ['POST'], re: /^\/api\/commissions\/pay$/, say: (b) => `Marked ${Array.isArray(b.job_ids) ? b.job_ids.length : ''} commission${b.job_ids?.length === 1 ? '' : 's'} paid` },
  { area: 'money', methods: ['PATCH', 'POST'], re: /^\/api\/jobs\/\d+\/(commission|commission\/unpay|amount|deposit|payments)$/, say: (b, r, m, p) => ({ commission: 'Changed a commission', unpay: 'Marked a commission unpaid', amount: 'Changed a job amount', deposit: b.waived ? 'Waived a deposit' : 'Changed a deposit', payments: 'Recorded a payment' })[p.split('/').pop()] },
  { area: 'money', methods: ['DELETE'], re: /^\/api\/payments\/\d+$/, say: () => 'Removed a payment' },
  { area: 'settings', methods: ['PUT', 'PATCH'], re: /^\/api\/(settings\/[\w-]+|automations\/[\w-]+|goals|pipelines|social\/settings)$/, say: (b, r, m, p) => `Changed ${p.replace(/^\/api\/(settings\/)?/, '').replace(/[/-]/g, ' ')}${changed(b) ? `: ${changed(b)}` : ''}` },
  { area: 'export', methods: ['GET'], re: /^\/api\/export\.xlsx$/, say: () => 'Downloaded the leads spreadsheet' },
  { area: 'delete', methods: ['DELETE'], re: /^\/api\//, say: (b, r, m, p) => `Deleted ${p.replace(/^\/api\//, '').replace(/\/\d+/g, '').replace(/[/-]/g, ' ')}` },
];
const SECRET = /pass|secret|token|key|code/i;
// The names of what changed (never the values of anything secret).
function changed(body = {}) {
  return Object.entries(body).filter(([k]) => !k.startsWith('_')).map(([k, v]) => {
    if (SECRET.test(k)) return `${k.replace(/_/g, ' ')} (changed)`;
    if (v == null || typeof v === 'object') return k.replace(/_/g, ' ');
    const text = String(v);
    return `${k.replace(/_/g, ' ')} ${text.length > 40 ? `${text.slice(0, 40)}…` : text}`;
  }).join(', ').slice(0, 300);
}

function createAuditLog(db) {
  const stmt = (sql) => db.prepare(sql);
  function write({ user = null, role = null, ip = null, area, action, detail = null }) {
    stmt('INSERT INTO audit_log (at, user_name, role, ip, area, action, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), user, role, ip ? String(ip).slice(0, 64) : null, area, String(action).slice(0, 300), detail ? String(detail).slice(0, 500) : null);
  }
  // Called after every request that worked: logs it if it's one of the kinds above.
  function record({ method, path, actor, body, result, ip }) {
    const rule = RULES.find((r) => r.methods.includes(method) && r.re.test(path));
    if (!rule) return;
    let action;
    try { action = rule.say(body || {}, result, method, path); } catch { action = `${method} ${path}`; }
    write({ user: actor?.user || null, role: actor?.role || null, ip, area: rule.area, action: action || `${method} ${path}` });
  }
  function list({ area, before, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (area) { where.push('area = ?'); params.push(area); }
    if (before) { where.push('id < ?'); params.push(Number(before)); }
    return stmt(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...params, Math.min(500, Number(limit) || 200));
  }
  return { write, record, list };
}

module.exports = { createAuditLog, changed };
