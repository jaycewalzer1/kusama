// The studio page: start runs, watch the log arrive, read what the artist decided.
//
// Everything here is a view of `studio.jsonl`. Nothing is computed in the browser that the run did
// not already write down, and nothing is drawn in the browser at all — the pictures are PNGs the
// pinned Chromium produced, served out of the run directory and the render cache. That is the whole
// reason this page can be trusted about what it shows.

const $ = (id) => document.getElementById(id);

let catalog = { positions: [], briefs: [], deliverables: [], hasKey: false };
let selected = null;
let plates = [];
let pinned = null;
let run = null;
let wantPrefix = null;
let sketchSheet = null;
let poller = null;
let story = null;
// What a person opened stays open across polls. Acts are shut by default rather than open, because
// the whole complaint the fold answers is that everything is shown at once; only the act that is
// still being written opens itself.
const openActs = new Set();
const openBeats = new Set();

// --- the launcher ---------------------------------------------------------------------------

function checked(container) {
  return [...container.querySelectorAll('input:checked')].map((i) => i.value);
}

/**
 * `single` makes the layer an either/or rather than a set. The kind of object is one axis of a run
 * and one axis of a grid alike — the grid crosses positions with commissions, never with objects —
 * so offering it as a checkbox would offer a cross that cannot be run.
 */
function picks(container, items, label, kind, single = false) {
  const was = new Set(checked(container));
  container.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    const box = document.createElement('input');
    box.type = single ? 'radio' : 'checkbox';
    box.name = kind;
    box.value = item.id;
    box.checked = was.has(item.id);
    row.append(box);
    const name = document.createElement('span');
    name.textContent = label(item);
    // Reading one is a different act from choosing it, so it is a different target.
    const read = document.createElement('button');
    read.className = 'read';
    read.textContent = 'read';
    read.title = `read ${item.id}`;
    read.addEventListener('click', (e) => {
      e.stopPropagation();
      preview(kind, item.id);
    });
    row.append(document.createTextNode(item.id), name, read);
    row.addEventListener('click', (e) => {
      if (e.target !== box) box.checked = single ? true : !box.checked;
      plan();
    });
    container.append(row);
  }
}

// One control does both jobs: one position and one commission is a run, more of either is the
// grid over them.
function plan() {
  const p = checked($('positions')).length;
  const b = checked($('briefs')).length;
  const d = checked($('deliverables')).length;
  const control = $('control').value ? 1 : 0;
  const cells = p === 1 && b === 1 ? 1 : p * (b + control);
  $('start').disabled = p === 0 || b === 0 || d === 0;
  $('start').textContent = cells <= 1 ? 'Start run' : `Start grid — ${cells} runs`;
  const note = $('plan');
  if (!catalog.hasKey) {
    note.className = 'note bad';
    note.textContent = 'ANTHROPIC_API_KEY is not set, so a run would fail on its first policy call.';
    return;
  }
  note.className = 'note';
  note.textContent = p === 0 || b === 0 || d === 0 ? 'pick a position, a commission and a kind of object' : estimate(cells);
}

/**
 * What the settings on this panel will cost, priced on the runs in this directory.
 *
 * A trajectory is one FIND, one CHOOSE, one EXAMINE, `sketches` calls for each problem FIND
 * returns, and per step an ACT and a REPLAN except after the last: 2 + sketches * problems +
 * 2 * steps. FIND may return three problems or six, and the artist usually finishes well inside
 * the step budget, so both ends are shown rather than one number that will be wrong.
 */
function estimate(cells) {
  const o = catalog.observed ?? { runs: 0, usdPerCall: 0.08, msPerCall: 55000, leastSteps: 3 };
  const sketches = Math.max(0, Number($('sketches').value) || 0);
  const budget = Math.max(1, Number($('steps').value) || 1);
  const calls = (problems, steps) => 2 + sketches * problems + 2 * steps;
  const lo = cells * calls(3, Math.min(o.leastSteps, budget));
  const hi = cells * calls(6, budget);
  const money = (n) => (n * o.usdPerCall).toFixed(n * o.usdPerCall < 10 ? 1 : 0);
  const minutes = (n) => (n * o.msPerCall) / 60000;
  const clock = minutes(hi) < 90 ? `${Math.round(minutes(lo))}-${Math.round(minutes(hi))} min` : `${(minutes(lo) / 60).toFixed(1)}-${(minutes(hi) / 60).toFixed(1)} h`;
  const basis = o.runs > 0 ? `, at the $${o.usdPerCall.toFixed(3)} and ${(o.msPerCall / 60000).toFixed(1)} min a call has cost over ${o.runs} finished run${o.runs === 1 ? '' : 's'} here` : ', on the loop shape alone — nothing has finished here yet';
  return `${cells} trajector${cells === 1 ? 'y' : 'ies'}, serial · ${lo}-${hi} calls · $${money(lo)}-${money(hi)} · ${clock}${basis}`;
}

async function start() {
  const positions = checked($('positions'));
  const briefs = checked($('briefs'));
  const single = positions.length === 1 && briefs.length === 1;
  const body = {
    kind: single ? 'run' : 'grid',
    position: positions[0],
    brief: briefs[0],
    deliverable: checked($('deliverables'))[0],
    positions,
    briefs,
    seed: Number($('seed').value),
    steps: Number($('steps').value),
    sketches: Number($('sketches').value),
    control: Boolean($('control').value),
  };
  $('start').disabled = true;
  const res = await fetch('/api/launch', { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json();
  if (data.error) {
    $('plan').className = 'note bad';
    $('plan').textContent = data.error;
    return;
  }
  // A grid's cells are created one at a time, so the page waits for the first one to appear.
  wantPrefix = data.run;
  await runs();
}

// --- the run list ---------------------------------------------------------------------------

let lastRuns = '';

async function runs() {
  const raw = await (await fetch('/api/runs')).text();
  // The list is rebuilt whole, which throws away scroll position and whatever the pointer was over,
  // so it is only worth doing when the answer changed. With no run in progress it never changes.
  if (raw === lastRuns) return;
  lastRuns = raw;
  const list = JSON.parse(raw);
  const box = $('runs');
  box.innerHTML = '';
  for (const r of list) {
    const div = document.createElement('div');
    div.className = `run${r.id === selected ? ' on' : ''}`;
    const who = document.createElement('div');
    who.className = 'who';
    who.innerHTML = `<span class="dot ${r.status}"></span>`;
    who.append(`${r.position} x ${r.brief}${r.control ? ' (control)' : ''}`);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const s = r.scores;
    meta.textContent = s
      ? `tree ${fmt(s.tree)} render ${fmt(s.render)} hard ${s.hardViolations}`
      : `${r.status} · seed ${r.seed} · ${r.started.slice(5, 16).replace('T', ' ')}`;
    // Several runs can be the same position against the same brief, so the directory is the name.
    const where = document.createElement('div');
    where.className = 'meta';
    where.textContent = r.id;
    div.title = r.id;
    div.append(who, meta, where);
    div.addEventListener('click', () => select(r.id));
    box.append(div);
  }
  if (wantPrefix) {
    const found = list.find((r) => r.id === wantPrefix || r.id.startsWith(`${wantPrefix}/`));
    if (found) {
      wantPrefix = null;
      select(found.id);
    }
  }
  plan();
}

const fmt = (v) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(3));

function select(id) {
  selected = id;
  plates = [];
  pinned = null;
  run = null;
  story = null;
  sketchSheet = null;
  openActs.clear();
  openBeats.clear();
  $('story').innerHTML = '';
  $('strip').innerHTML = '';
  $('scores').innerHTML = '';
  $('stage').innerHTML = '<div class="empty">reading the log...</div>';
  clearTimeout(poller);
  runs();
  poll();
}

// --- the feed --------------------------------------------------------------------------------

async function poll() {
  if (!selected) return;
  const res = await fetch(`/api/story?run=${encodeURIComponent(selected)}`);
  if (!res.ok) return;
  const data = await res.json();
  run = data.run;
  story = data.story;
  tellStory();
  if (data.stderr?.length && run.status !== 'finished') {
    $('stderr').hidden = false;
    $('stderr').textContent = data.stderr.join('\n');
  } else {
    $('stderr').hidden = true;
  }
  header();
  stage();
  if (!sketchSheet) await sketches();
  if (run.status === 'running') poller = setTimeout(poll, 1500);
}

function header() {
  $('title').textContent = `${run.position} x ${run.brief}${run.control ? ' (control)' : ''}`;
  const t = story.totals;
  $('subtitle').textContent = [
    run.id,
    run.status,
    `seed ${run.seed}`,
    `${t.steps} steps`,
    `${t.calls} calls`,
    `$${t.usd.toFixed(2)}`,
    t.ms ? `${Math.round(t.ms / 60000)} min` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  $('stop').hidden = run.status !== 'running';

  const s = run.scores;
  $('scores').innerHTML = '';
  if (!s) return;
  const rows = [
    ['tree', fmt(s.tree)],
    ['render', fmt(s.render)],
    ['hard', s.hardViolations],
    ['soft', s.softViolations],
    ['realized', `${fmt(s.realization?.score)} (${s.realization?.judgePending ?? 0} pending)`],
    ['fused', s.realization?.fused ? fmt(s.realization.fused.score) : 'n/a'],
    // The stop and the gradient sit with the scores, not under them: a green board over an
    // illegitimate stop, or over a run that stopped improving at step 2, is the case worth seeing.
    ['stop', `${s.termination?.kind ?? '?'}${s.termination && !s.termination.legitimate ? ' (not legitimate)' : ''}`],
    ['gradient', s.gradient ? `${s.gradient.improvedSteps} up, ${s.gradient.trailing} trailing` : 'n/a'],
    ['drift', s.drift],
    ['replans', s.problemFindingSteps],
    ['destroyed', s.destructionRate],
    ['risk', s.riskMoveTaken ? 'taken' : s.riskDeclared ? 'declared only' : 'no'],
    ['self', s.selfScore ?? 'n/a'],
  ];
  for (const [k, v] of rows) {
    const span = document.createElement('span');
    span.innerHTML = `${k} <b></b>`;
    span.querySelector('b').textContent = String(v);
    $('scores').append(span);
  }
}

// The picture: whatever is pinned in the strip, else the finished plate, else the last one rendered.
function stage() {
  // Every plate the run has stood on, in order, with the repeats a reverted step leaves out.
  const seen = story.track;
  if (seen.length !== plates.length) {
    plates = seen;
    strip();
  }
  const src = pinned
    ? pinned
    : run.status === 'finished'
      ? `/api/file?run=${encodeURIComponent(selected)}&name=final.png`
      : plates.length
        ? `/api/plate?hash=${plates.at(-1).plate}`
        : null;
  if (!src) {
    $('stage').innerHTML = '<div class="empty"></div>';
    $('stage').firstChild.textContent =
      run.status === 'running' ? 'the artist is thinking; the first plate comes at the end of SKETCH' : 'this run rendered nothing';
    return;
  }
  let img = $('stage').querySelector('img');
  if (!img) {
    $('stage').innerHTML = '';
    img = document.createElement('img');
    img.title = 'click to see it at full size';
    img.addEventListener('click', () => img.classList.toggle('full'));
    $('stage').append(img);
  }
  if (img.getAttribute('src') !== src) {
    img.src = src;
    img.classList.remove('full');
  }
}

/**
 * The plates the run stood on, in order, each under a bar of the tree score it stood at.
 *
 * The bar is the point. A trajectory's shape is "did it get better, and where did it stall", and a
 * row of near-identical thumbnails cannot answer that; a row of thumbnails with the score under each
 * one answers it at a glance, which is what an engine analysis bar does for a game.
 */
function strip() {
  const box = $('strip');
  box.innerHTML = '';
  const add = (src, title, point) => {
    const cell = document.createElement('div');
    cell.className = `plate${point?.hard ? ' hard' : ''}`;
    const img = document.createElement('img');
    img.src = src;
    img.className = pinned === src ? 'on' : '';
    cell.title = title;
    cell.append(img);
    if (point) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.round((point.tree ?? 0) * 100)}%`;
      bar.append(fill);
      cell.append(bar);
    }
    cell.addEventListener('click', () => {
      pinned = pinned === src ? null : src;
      strip();
      stage();
    });
    box.append(cell);
  };
  if (sketchSheet) add(sketchSheet, 'sketches', null);
  for (const [i, p] of plates.entries()) {
    add(`/api/plate?hash=${p.plate}`, `plate ${i + 1}${p.label ? ` — ${p.label}` : ''} — tree ${fmt(p.tree)}, ${p.hard} hard`, p);
  }
}

async function sketches() {
  const files = await (await fetch(`/api/sketches?run=${encodeURIComponent(selected)}`)).json();
  if (!files.includes?.('contact.png')) return;
  sketchSheet = `/api/file?run=${encodeURIComponent(selected)}&name=sketches/contact.png`;
  strip();
}

// --- the story -------------------------------------------------------------------------------

/**
 * The run as acts and beats, folded.
 *
 * Redrawn whole on every poll rather than appended to, because the fold is a function of the log so
 * far and a beat's title changes when the line after it arrives — a policy call becomes "step 3 ·
 * kept · 4 edits" only once the step line lands. What a person opened is kept in `openActs` and
 * `openBeats` and re-applied, so redrawing does not close anything.
 */
function tellStory() {
  const box = $('story');
  box.innerHTML = '';
  const last = story.acts.at(-1);
  for (const act of story.acts) {
    // Shut, unless it went wrong, is the one still being written, or was opened by hand.
    const open = openActs.has(act.id) || (!openActs.size && act === last && run.status === 'running') || act.tone === 'bad';
    box.append(actNode(act, open));
  }
  const t = story.totals;
  $('fold').textContent = `${story.acts.reduce((n, a) => n + a.beats.length, 0)} beats${t.refused ? ` · ${t.refused} edits refused` : ''}`;
  $('expand').textContent = openActs.size >= story.acts.length ? 'collapse all' : 'expand all';
  $('export').hidden = false;
}

function actNode(act, open) {
  const div = document.createElement('div');
  div.className = `act ${act.tone}`;

  const cap = document.createElement('div');
  cap.className = 'cap';
  const arrow = el('span', open ? '▾' : '▸', 'arrow');
  const title = el('b', act.title);
  const roll = el('span', act.summary, 'roll');
  cap.append(arrow, title, roll);
  div.append(cap);

  const beats = el('div', undefined, 'beats');
  beats.hidden = !open;
  for (const beat of act.beats) beats.append(beatNode(beat));
  div.append(beats);

  cap.addEventListener('click', () => {
    beats.hidden = !beats.hidden;
    arrow.textContent = beats.hidden ? '▸' : '▾';
    if (beats.hidden) openActs.delete(act.id);
    else openActs.add(act.id);
  });
  return div;
}

function beatNode(beat) {
  const div = document.createElement('div');
  div.className = `beat ${beat.tone}`;

  const line = document.createElement('div');
  line.className = 'line';
  line.append(el('span', beat.label, 'tag'), el('span', beat.title, 'what'));
  const cost = [beat.usd ? `$${beat.usd.toFixed(2)}` : '', beat.ms > 1000 ? `${Math.round(beat.ms / 1000)}s` : '', beat.refused ? `${beat.refused} refused` : '']
    .filter(Boolean)
    .join(' · ');
  line.append(el('span', cost, 'cost'));
  div.append(line);

  const body = el('div', undefined, 'body');
  body.hidden = !openBeats.has(beat.seq);
  if (beat.said) body.append(el('div', beat.said, 'said'));
  for (const note of beat.notes) {
    const n = el('div', undefined, `note ${note.tone}`);
    n.append(el('span', note.count > 1 ? `${note.count}x` : '', 'n'), el('span', note.text));
    body.append(n);
  }
  // The lines behind the beat, whole: the observation the model saw, its raw answer, every retry.
  // This is the audit and it is enormous — a single observation runs to tens of kilobytes — so it
  // lives one click further in, on the beat it belongs to rather than in a log somewhere else.
  const label = `raw log — ${beat.seqs.length} line${beat.seqs.length === 1 ? '' : 's'}`;
  const raw = el('button', `▸ ${label}`, 'raw');
  raw.addEventListener('click', async (e) => {
    e.stopPropagation();
    const shown = body.querySelector('pre');
    if (shown) {
      shown.remove();
      raw.textContent = `▸ ${label}`;
      return;
    }
    raw.textContent = `▾ ${label}`;
    const pre = el('pre', 'reading...');
    body.append(pre);
    const lines = [];
    for (const seq of beat.seqs) {
      const res = await fetch(`/api/line?run=${encodeURIComponent(selected)}&seq=${seq}`);
      if (res.ok) lines.push(JSON.stringify(await res.json(), null, 2));
    }
    pre.textContent = lines.join('\n\n');
  });
  body.append(raw);
  div.append(body);

  line.addEventListener('click', () => {
    body.hidden = !body.hidden;
    if (body.hidden) openBeats.delete(beat.seq);
    else openBeats.add(beat.seq);
    // A beat that ended on a plate puts that plate on the stage: the picture and the reason for it
    // are the same act of looking.
    if (!body.hidden && beat.plate) {
      pinned = `/api/plate?hash=${beat.plate}`;
      strip();
      stage();
    }
  });
  return div;
}

// --- positions and commissions ----------------------------------------------------------------

// The centre column shows one of two things: a run, or the document a run would be held to. This
// puts the second one there and remembers nothing else — closing it re-selects the run.
function centre(nodes) {
  const stage = $('stage');
  stage.innerHTML = '';
  const doc = document.createElement('div');
  doc.className = 'doc';
  doc.append(...nodes);
  stage.append(doc);
  stage.scrollTop = 0;
}

function closeDoc() {
  $('doc-title').hidden = true;
  if (selected) select(selected);
  else {
    $('stage').innerHTML = '<div class="empty">Pick a position and a commission on the left and press Start, or choose a finished run to read it.</div>';
  }
}

function docHeader(title) {
  $('title').textContent = title;
  $('subtitle').textContent = '';
  $('stop').hidden = true;
  $('scores').innerHTML = '';
  $('strip').innerHTML = '';
  $('export').hidden = true;
  clearTimeout(poller);
  const close = $('doc-title');
  close.hidden = false;
}

const el = (tag, text, cls) => {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};

// `whenAndWhere` is a key, not a title: split it into words and keep them lower case, so a list item
// reads "when and where" rather than "when And Where". The headings uppercase themselves in CSS.
const words = (key) =>
  key.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, (_, a, b) => `${a} ${b.toLowerCase()}`);

/** A document read as prose, because that is what it is. Order is the file's own. */
function render(obj, skip = new Set(['version', 'id', 'briefId'])) {
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    if (skip.has(key)) continue;
    out.push(el('h3', words(key)));
    if (typeof value === 'string' || typeof value === 'number') out.push(el('p', String(value)));
    else if (Array.isArray(value)) {
      const ul = el('ul');
      for (const item of value) ul.append(el('li', typeof item === 'string' ? item : flat(item)));
      out.push(ul);
    } else if (value && typeof value === 'object') out.push(...render(value, new Set()));
  }
  return out;
}

/** One object on one line, for the lists whose items are records rather than sentences. */
function flat(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${words(k)}: ${typeof v === 'object' && v !== null ? Object.values(v).flat().join(', ') : v}`)
    .join(' · ');
}

async function preview(kind, id) {
  const res = await fetch(`/api/doc?kind=${kind}&id=${encodeURIComponent(id)}`);
  const data = await res.json();
  if (data.error) return;
  docHeader(`${kind} · ${id}`);
  const nodes = [el('h2', data.doc.name ?? data.doc.title ?? id), ...render(data.doc)];
  if (data.field) {
    nodes.push(el('h2', 'the field it sits in'), ...render(data.field));
  }
  centre(nodes);
}

// The two documents a commission is: the brief, and the field FIND reads the problem out of.
// Both are written from one form, because a brief saved without a field cannot be run.
//
// Every hint here is written in the client's voice on purpose. A commission says what the job is,
// who is paying for it, what they can afford to have made and what they are afraid of — and says
// nothing about what it should look like, and nothing about what kind of object it is. The server
// scans for both and refuses the save if one turns up, so a hint that invited one would be inviting
// a rejection. `whereItLives` and `format` used to be here and were L3 in the client's voice.
//
// `[name, label, hint, tall]`.
const BRIEF_FORM = [
  ['title', 'title', 'One line, as the job would be referred to', false],
  ['client', 'client', 'Who is commissioning this, in enough detail to know what they can and cannot do', true],
  ['function', 'what it has to do', 'The job it is being made to do, and what counts as having done it', true],
  ['event', 'what happened', 'The occasion, in as much detail as is actually known', true],
  ['when', 'when', 'Dates and times a reader could act on', false],
  ['where', 'where', 'The place, named', false],
  ['audience', 'audience', 'Who will see it, what they already know, and what they are doing at the time', true],
  ['production', 'production', 'Process, colours, stock, printer, and anything the printer cannot do', true],
  ['quantity', 'quantity', 'How many', false],
  ['budget', 'budget', 'The money, and what it has to cover', false],
  ['timeline', 'timeline', 'When the artwork is due and when the thing has to be up', false],
  ['clientFear', "the client's fear", 'The thing the client is afraid this will turn out to be. Say it as they would', true],
  ['stakes', 'what is at stake', 'What is lost if it fails', true],
  ['notes', 'notes', 'Anything the commission deliberately leaves open', true],
];
const FIELD_FORM = [
  ['whenAndWhere', 'the scene', 'Where and when this sits, in a sentence or two'],
  ['inTheAir', 'in the air', 'One per line: what everyone there already knows'],
  ['contested', 'contested', 'One per line: what people there disagree about'],
  ['exhausted', 'exhausted', 'One per line: the images that have stopped working'],
  // `watching`, not `audience`: the brief has an audience field of its own, and two inputs with one
  // id means the field silently takes the brief's paragraph. They are different paragraphs — the
  // brief's is who will see it, this one is the single person the audience model is shown.
  ['watching', 'the reader', 'One person who will see it, described'],
  ['adversary', 'the adversary', 'Who else is reading it, and what they will do with it'],
  ['transplants', 'transplants', 'One per line, as "reference — why it is relevant"'],
  ['stakesLevelWhy', 'why that stakes level', 'One line arguing the number below'],
];

function field(name, label, hint, tall) {
  const wrap = el('div');
  wrap.append(el('label', label));
  const input = tall ? el('textarea') : el('input');
  input.id = `f-${name}`;
  input.placeholder = hint;
  if (tall) input.rows = 3;
  wrap.append(input);
  return wrap;
}

const lines = (id) =>
  $(id).value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

function newBrief() {
  docHeader('new commission');
  const nodes = [
    el('p', 'A commission is what the artist is asked to make and the field it is asked to read. Both are hand-written: the run hashes them, and FIND takes its problem out of the field rather than out of the model.', 'doc-note'),
    el('p', 'Write it as the client would. Say what the job is, what you can afford to have made, what it costs and what you are afraid of — and do not say what it should look like, or what kind of object it is. Those are the artist\u2019s and the launcher\u2019s to decide, and a commission that decides either is refused here rather than quietly ruining the run.', 'doc-note'),
    field('id', 'name', 'lowercase-with-hyphens; the id it is run by'),
  ];
  for (const [name, label, hint, tall] of BRIEF_FORM) nodes.push(field(name, label, hint, tall));
  nodes.push(field('mustAppear', 'must appear, legibly', 'One per line: the facts that have to survive whatever is done to them', true));
  nodes.push(
    field(
      'clientWantThatHurtsTheWork',
      'what you have asked for that will damage it',
      'One per line, in your own voice, as a demand and not as an admission. At least one: with nothing here to resist, an artist who complies and an artist who judges leave the same trace',
      true
    )
  );
  nodes.push(el('h2', 'the field'));
  for (const [name, label, hint] of FIELD_FORM) nodes.push(field(name, label, hint, true));
  nodes.push(field('stakesLevel', 'stakes level', '0 to 1; the artist never sees it, it sets arousal'));

  const save = el('button', 'Save commission');
  const note = el('div', '', 'note');
  save.addEventListener('click', async () => {
    const id = $('f-id').value.trim();
    const doc = { version: '1.0', id };
    for (const [name] of BRIEF_FORM) doc[name] = $(`f-${name}`).value.trim();
    doc.mustAppear = lines('f-mustAppear');
    doc.clientWantThatHurtsTheWork = lines('f-clientWantThatHurtsTheWork');
    doc.hard_constraints = [];
    const fieldDoc = {
      version: '1.0',
      briefId: id,
      whenAndWhere: $('f-whenAndWhere').value.trim(),
      inTheAir: lines('f-inTheAir'),
      contested: lines('f-contested'),
      exhausted: lines('f-exhausted'),
      whoIsWatching: { audience: $('f-watching').value.trim(), adversary: $('f-adversary').value.trim() },
      transplants: lines('f-transplants').map((l) => {
        const [ref, why] = l.split(/\s+[—-]\s+/);
        return { ref: ref ?? l, why: why ?? '' };
      }),
      stakesLevel: Number($('f-stakesLevel').value),
      stakesLevelWhy: $('f-stakesLevelWhy').value.trim(),
    };
    await write({ kind: 'brief', id, doc, field: fieldDoc }, note);
  });
  nodes.push(save, note);
  centre(nodes);
}

/**
 * A position is an aesthetic program: commitments, prohibitions, generative rules and the
 * constraint kinds that decide them. There is no short form of it, so a new one starts as a copy
 * of one that works and is checked by the same validator the run uses.
 */
async function newPosition() {
  docHeader('new position');
  const from = catalog.positions[0]?.id;
  const data = from ? await (await fetch(`/api/doc?kind=position&id=${from}`)).json() : { doc: {} };
  const nodes = [
    el('p', `A position is an aesthetic program — commitments, prohibitions, and the constraint kinds that decide them. This starts as a copy of ${from}. Change its id, its name, what it is committed to, and every word of meta.practice: the practice is the artist's account of its own work and is the whole of what a copy leaves behind.`, 'doc-note'),
    el('p', 'Say what this way of working believes about a medium. Do not say what the object does — that it is read at fifteen feet, that it is A3, that a copier crushes the midtones. Those are facts the artist could be wrong about, they belong to the deliverable, and a position that states them has answered a question the run exists to watch the artist answer. The save is refused if one turns up outside lineage.', 'doc-note'),
    field('id', 'name', 'lowercase-with-hyphens'),
  ];
  const area = el('textarea');
  area.id = 'f-json';
  area.rows = 26;
  area.value = JSON.stringify(data.doc, null, 2);
  nodes.push(el('label', 'the program'), area);
  const save = el('button', 'Save position');
  const note = el('div', '', 'note');
  save.addEventListener('click', async () => {
    const id = $('f-id').value.trim();
    let doc;
    try {
      doc = JSON.parse($('f-json').value);
    } catch (e) {
      note.className = 'note bad';
      note.textContent = `that is not JSON: ${e.message}`;
      return;
    }
    doc.id = id;
    await write({ kind: 'position', id, doc }, note);
  });
  nodes.push(save, note);
  centre(nodes);
}

/** The server validates; this only reports what it said and refreshes what can be launched. */
async function write(body, note) {
  note.className = 'note';
  note.textContent = 'checking...';
  const res = await fetch('/api/doc', { method: 'POST', body: JSON.stringify(body) });
  const data = await res.json();
  if (data.errors) {
    note.className = 'note bad';
    note.textContent = data.errors.join('\n');
    return;
  }
  catalog = await (await fetch('/api/catalog')).json();
  fillLists();
  plan();
  preview(body.kind, body.id);
}

function fillLists() {
  picks($('positions'), catalog.positions, (p) => p.name, 'position');
  picks($('briefs'), catalog.briefs, (b) => b.title, 'brief');
  picks($('deliverables'), catalog.deliverables, (d) => d.name, 'deliverable', true);
}

// --- start up ---------------------------------------------------------------------------------

$('start').addEventListener('click', start);
$('control').addEventListener('change', plan);
for (const id of ['steps', 'sketches']) $(id).addEventListener('input', plan);
$('new-position').addEventListener('click', newPosition);
$('new-brief').addEventListener('click', newBrief);
$('doc-title').addEventListener('click', closeDoc);
$('expand').addEventListener('click', () => {
  const all = story ? story.acts.length : 0;
  if (openActs.size >= all) openActs.clear();
  else for (const a of story.acts) openActs.add(a.id);
  tellStory();
});
// The server builds the document and sends it as an attachment. The page cannot build it: what it
// holds is the small form of each line, and the observations and raw answers are the point of it.
$('export').addEventListener('click', () => {
  if (selected) window.location.href = `/api/transcript?run=${encodeURIComponent(selected)}`;
});
$('stop').addEventListener('click', async () => {
  if (!confirm('Stop this run? What it has written stays; the rest is lost.')) return;
  await fetch(`/api/stop?run=${encodeURIComponent(selected)}`, { method: 'POST' });
});

catalog = await (await fetch('/api/catalog')).json();
fillLists();
await runs();
// Every poll re-walks the runs directory and re-reads a scores.json per run, and nothing arrives
// while the tab is hidden that will not still be there when it is shown again.
setInterval(() => void (document.hidden || runs()), 5000);
document.addEventListener('visibilitychange', () => void (document.hidden || runs()));
