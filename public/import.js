'use strict';
// Import leads from a spreadsheet (admins): pick a file, match its columns, preview, import, undo.
// Uses the helpers from app.js ($, h, api, toast, fail, state, showPanel, ...).

const imp = { upload: null, mapping: {}, timer: null };
const STAGE_NAMES = { new: 'New', voicemail: 'Voicemail', contacted: 'Contacted', booked: 'Booked', waste: 'Waste' };

async function openImport() {
  importStep('start');
  showPanel($('#importPanel'));
  loadImportHistory();
}

function importStep(step) {
  $('#importStart').hidden = step !== 'start';
  $('#importMatch').hidden = step !== 'match';
  $('#importDone').hidden = step !== 'done';
  if (step === 'start') { $('#importFile').value = ''; $('#importError').hidden = true; }
}

async function uploadImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  $('#importError').hidden = true;
  try {
    const res = await fetch(`/api/import/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
    imp.upload = data;
    imp.mapping = { ...data.mapping };
    $('#importFileName').textContent = `· ${file.name}, ${data.total} row${data.total === 1 ? '' : 's'}`;
    renderImportColumns();
    importStep('match');
    await checkImport();
  } catch (err) {
    $('#importError').textContent = err.message;
    $('#importError').hidden = false;
  }
}

function renderImportColumns() {
  const { fields, headers } = imp.upload;
  const used = new Map(Object.entries(imp.mapping).map(([k, v]) => [v, k]));
  $('#importColumns').replaceChildren(...fields.map((f) => h('label', { class: 'import-column' },
    h('span', {}, f.label),
    h('select', {
      'data-field': f.key,
      onchange: (e) => {
        const col = e.target.value;
        // A column feeds one field: take it from wherever it was.
        for (const [k, v] of Object.entries(imp.mapping)) if (String(v) === col) delete imp.mapping[k];
        if (col === '') delete imp.mapping[f.key]; else imp.mapping[f.key] = Number(col);
        renderImportColumns();
        clearTimeout(imp.timer);
        imp.timer = setTimeout(() => checkImport().catch(fail), 150);
      },
    }, h('option', { value: '' }, '(not in my file)'),
    ...headers.map((head, i) => h('option', { value: i, selected: imp.mapping[f.key] === i, disabled: used.has(i) && used.get(i) !== f.key }, head || `Column ${i + 1}`))))));
}

async function checkImport() {
  const r = await api('/api/import/check', { method: 'POST', body: { token: imp.upload.token, mapping: imp.mapping } });
  const stages = Object.entries(r.stages).map(([s, n]) => `${n} ${STAGE_NAMES[s] || s}`).join(', ');
  $('#importSummary').textContent = `${r.ready} of ${r.total} will be imported${stages ? ` (${stages})` : ''}${r.skipped ? `; ${r.skipped} skipped` : ''}.`;
  $('#importGo').textContent = `Import ${r.ready} lead${r.ready === 1 ? '' : 's'}`;
  $('#importGo').disabled = !r.ready;
  const vehicle = (l) => [l.vehicle_year, l.vehicle_make, l.vehicle_model].filter(Boolean).join(' ') || l.vehicle_type || '';
  $('#importPreview').replaceChildren(
    h('thead', {}, h('tr', {}, ...['Row', 'Name', 'Phone', 'Email', 'Vehicle', 'Came in', 'Stage', 'Notes'].map((t) => h('th', {}, t)))),
    h('tbody', {}, ...r.sample.map((l) => h('tr', { class: l.skip ? 'skipped' : '' },
      h('td', {}, l.row),
      h('td', {}, [l.first_name, l.last_name].filter(Boolean).join(' ') || l.full_name || '', l.skip && h('div', { class: 'muted' }, `Skipped: ${l.skip}`)),
      h('td', {}, l.phone || ''),
      h('td', {}, l.email || ''),
      h('td', {}, vehicle(l)),
      h('td', {}, l.received_at ? new Date(l.received_at).toLocaleDateString() : 'Today'),
      h('td', {}, STAGE_NAMES[l.stage] || l.stage),
      h('td', { class: 'import-notes' }, l.message || '')))));
  const skips = $('#importSkips');
  skips.hidden = !r.skips.length;
  skips.querySelector('summary').textContent = `See the ${r.skipped} skipped row${r.skipped === 1 ? '' : 's'}`;
  skips.querySelector('ul').replaceChildren(...r.skips.map((s) => h('li', {}, `Row ${s.row}${s.name ? ` · ${s.name}` : ''}: ${s.reason}`)));
}

async function runImport() {
  const placement = document.querySelector('[name=importPlace]:checked').value;
  $('#importGo').disabled = true;
  try {
    const r = await api('/api/import/commit', { method: 'POST', body: { token: imp.upload.token, mapping: imp.mapping, placement } });
    $('#importDone').replaceChildren(
      h('h3', {}, `Imported ${r.created} lead${r.created === 1 ? '' : 's'}`),
      h('ul', { class: 'import-result' },
        r.board > 0 && h('li', {}, `${r.board} on the board`),
        r.old > 0 && h('li', {}, `${r.old} in Old & Dead Leads`),
        r.customers > 0 && h('li', {}, `${r.customers} in Past Customers`),
        r.skipped > 0 && h('li', {}, `${r.skipped} skipped (already in the app, repeated, or no contact details)`)),
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', onclick: () => undoImport(r.batch, r.created) }, 'Undo this import'),
        h('button', { type: 'button', onclick: () => importStep('start') }, 'Import another file'),
        h('button', { type: 'button', class: 'primary', onclick: () => showPanel(null) }, 'Done')));
    importStep('done');
    toast(`Imported ${r.created} leads`);
    await Promise.all([loadLeads(), loadImportHistory()]);
  } catch (err) { fail(err); $('#importGo').disabled = false; }
}

async function undoImport(batch, count) {
  if (!window.confirm(`Remove the ${count} lead${count === 1 ? '' : 's'} this import added, and anything done to them since?`)) return;
  try {
    const { removed } = await api(`/api/import/batches/${batch}/undo`, { method: 'POST' });
    toast(`Removed ${removed} imported lead${removed === 1 ? '' : 's'}`);
    importStep('start');
    await Promise.all([loadLeads(), loadImportHistory()]);
  } catch (err) { fail(err); }
}

async function loadImportHistory() {
  try {
    const batches = await api('/api/import/batches');
    $('#importHistory').replaceChildren(...(batches.length ? batches.map((b) => h('li', {},
      h('div', { class: 'email-line' },
        h('span', {}, `${b.file} · ${b.created_count} lead${b.created_count === 1 ? '' : 's'}`),
        h('span', { class: 'muted' }, `${fmtDateTime(b.created_at)}${b.created_by ? ` by ${b.created_by}` : ''}${b.undone_at ? ` · undone ${fmtDateTime(b.undone_at)}` : ''}`)),
      !b.undone_at && h('div', { class: 'small-btns' }, h('button', { type: 'button', onclick: () => undoImport(b.id, b.still_there) }, 'Undo'))))
      : [h('li', { class: 'muted' }, 'Nothing imported yet')]));
  } catch { /* the list is optional */ }
}

function initImport() {
  if (!isAdmin()) return;
  $('#importBtn').addEventListener('click', openImport);
  $('#importFile').addEventListener('change', uploadImport);
  $('#importGo').addEventListener('click', runImport);
  $('#importRestart').addEventListener('click', () => importStep('start'));
}
