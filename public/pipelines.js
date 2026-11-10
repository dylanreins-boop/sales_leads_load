'use strict';
// Admins set up the pipelines (the boards on the Leads page): add one (e.g. Boats), pick the vehicle
// types that go on it and who sees it, rename, reorder or remove. Leads follow their vehicle type,
// so they move as soon as it's saved. Uses the helpers from app.js ($, h, fill, api, toast, fail...).

const pipe = { list: [], types: [], people: [] };

// Fills every pipeline picker (Revenue, Analytics, Export) with the pipelines this person sees.
function fillPipelineSelects() {
  document.querySelectorAll('select[data-pipelines]').forEach((sel) => {
    const keep = sel.value;
    const all = sel.options[0];
    fill(sel, all, ...state.meta.pipelines.map((p) => h('option', { value: p.id }, p.label)));
    sel.value = state.meta.pipelines.some((p) => p.id === keep) ? keep : '';
  });
}

async function openPipelines() {
  try {
    const data = await api('/api/pipelines');
    pipe.list = data.pipelines.map((p) => ({ ...p, types: [...p.types], visible_to: [...p.visible_to], only: p.visible_to.length > 0 }));
    pipe.types = data.vehicle_types;
    pipe.people = data.people;
    renderPipelines();
    showPanel($('#pipelinesPanel'));
  } catch (err) { fail(err); }
}

// Leads on the board now with each vehicle type, so the admin sees what moves.
function typeCounts() {
  const n = {};
  for (const l of state.leads) n[l.vehicle_type || ''] = (n[l.vehicle_type || ''] || 0) + 1;
  return n;
}

function renderPipelines() {
  const counts = typeCounts();
  const owner = (type) => pipe.list.find((p) => p.id !== 'other' && p.types.includes(type));
  const leftover = pipe.types.filter((t) => !owner(t));
  const leadsOn = (p) => (p.id === 'other' ? [...leftover, ''] : p.types).reduce((n, t) => n + (counts[t] || 0), 0);
  const move = (i, step) => {
    const j = i + step;
    if (j < 0 || j >= pipe.list.length - 1) return; // All Other Vehicles stays last
    [pipe.list[i], pipe.list[j]] = [pipe.list[j], pipe.list[i]];
    renderPipelines();
  };

  const card = (p, i) => {
    const other = p.id === 'other';
    return h('section', { class: 'card-section pipe-card' },
      h('div', { class: 'pipe-head' },
        h('input', { class: 'pipe-name', value: p.label, maxlength: '40', 'aria-label': 'Pipeline name', oninput: (e) => { p.label = e.target.value; } }),
        h('span', { class: 'muted pipe-count' }, `${leadsOn(p)} lead${leadsOn(p) === 1 ? '' : 's'} on the board`),
        !other && h('div', { class: 'pipe-order' },
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move ${p.label} up`, disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Move ${p.label} down`, disabled: i >= pipe.list.length - 2, onclick: () => move(i, 1) }, '↓'))),
      other
        ? h('p', { class: 'hint' }, leftover.length ? `Gets every lead no other pipeline takes: ${leftover.join(', ')}, and leads with no vehicle type yet.` : 'Gets leads with no vehicle type yet.')
        : h('div', {},
          h('div', { class: 'pipe-label' }, 'Vehicle types that go here'),
          h('div', { class: 'pipe-types' }, ...pipe.types.map((t) => {
            const on = p.types.includes(t);
            const elsewhere = !on && owner(t);
            return h('button', {
              type: 'button', class: `pipe-type ${on ? 'on' : ''}`, 'aria-pressed': String(on),
              title: elsewhere ? `Now on ${elsewhere.label}; click to move it here` : '',
              onclick: () => {
                if (on) p.types = p.types.filter((x) => x !== t);
                else {
                  for (const q of pipe.list) q.types = q.types.filter((x) => x !== t);
                  p.types.push(t);
                }
                renderPipelines();
              },
            }, t, counts[t] ? h('small', {}, ` ${counts[t]}`) : null, elsewhere ? h('small', { class: 'pipe-elsewhere' }, ` · ${elsewhere.label}`) : null);
          }))),
      !other && h('div', { class: 'pipe-who' },
        h('div', { class: 'pipe-label' }, 'Who sees it in their menu'),
        h('label', { class: 'check' }, h('input', { type: 'radio', name: `who-${i}`, checked: !p.only, onchange: () => { p.only = false; renderPipelines(); } }), ' Everyone'),
        h('label', { class: 'check' }, h('input', { type: 'radio', name: `who-${i}`, checked: p.only, onchange: () => { p.only = true; renderPipelines(); } }), ' Only the people I pick'),
        p.only && h('div', { class: 'pipe-people' }, ...pipe.people.map((person) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: p.visible_to.includes(person.name), onchange: (e) => {
            p.visible_to = e.target.checked ? [...p.visible_to, person.name] : p.visible_to.filter((n) => n !== person.name);
          } }), ` ${person.name}`, person.role === 'admin' ? h('small', { class: 'muted' }, ' (admin: always sees every pipeline)') : null)))),
      !other && p.id !== 'rv' && h('button', { type: 'button', class: 'danger-btn pipe-remove', onclick: async () => {
        if (!await askConfirm(`Remove ${p.label}?`, `Its leads go to ${pipe.list.at(-1).label} when you save.`, { ok: 'Remove', danger: true })) return;
        pipe.list.splice(i, 1);
        renderPipelines();
      } }, 'Remove this pipeline'));
  };

  fill($('#pipelinesBody'),
    h('p', { class: 'hint' }, 'Each pipeline is a tab on the Leads board. A lead goes on the pipeline that has its vehicle type, so leads move as soon as you save; changing a lead\'s vehicle type moves it too.'),
    ...pipe.list.map(card),
    h('div', { class: 'pipe-actions' },
      h('button', { type: 'button', onclick: () => {
        pipe.list.splice(pipe.list.length - 1, 0, { id: '', label: 'New pipeline', types: [], visible_to: [], only: false });
        renderPipelines();
        const names = $('#pipelinesBody').querySelectorAll('.pipe-name');
        names[names.length - 2]?.select();
      } }, '+ Add a pipeline'),
      h('button', { type: 'button', class: 'primary', onclick: savePipelines }, 'Save pipelines')));
}

async function savePipelines() {
  const body = pipe.list.map((p) => ({ id: p.id, label: p.label, types: p.types, visible_to: p.only ? p.visible_to : [] }));
  if (pipe.list.some((p) => p.only && !p.visible_to.length && p.id !== 'other')) return toast('Pick at least one person for each pipeline set to "Only the people I pick".', 'error');
  try {
    await api('/api/pipelines', { method: 'PUT', body: { pipelines: body } });
    state.meta = await api('/api/meta');
    fillPipelineSelects();
    if (!state.meta.pipelines.some((p) => p.id === state.pipeline) && !['old', 'customers'].includes(state.pipeline)) state.pipeline = state.meta.pipelines[0].id;
    await loadLeads();
    showPanel(null);
    toast('Pipelines saved. Leads are on their new boards.');
  } catch (err) { fail(err); }
}

function initPipelines() {
  fillPipelineSelects();
  $('#pipelinesBtn').addEventListener('click', openPipelines);
}
