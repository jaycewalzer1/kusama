// The inspector: one run, opened all the way up.
//
// The studio's own page tells the story of a run — acts, beats, a plate. This one refuses to tell a
// story. It shows the record: every line of studio.jsonl unfolded, the exact prompt that produced
// each decision beside the exact answer, the program tree at every iteration diffed against the
// iteration before, and the corpus works the retrieval actually put in front of the artist with the
// query and cosine that put them there. Nothing here is summarised unless a toggle says to.
//
// It holds no state the server has. `/api/lines` is incremental, so a live run costs one small
// request per poll, and everything else is content-addressed and cached forever in the browser: a
// program hash and a corpus sha256 name exactly one thing for all time.

const $ = (id) => document.getElementById(id);

// --- what can be turned off ---------------------------------------------------------------------
//
// Defaults are what you want when a run is going wrong: the spine, the prompt and the tree. The
// noisy kinds and the whole-record dumps are off until asked for, because a page that shows
// everything at once is the same as a page that shows nothing.

const PANES = [
  ['spine-only', 'iterations', true],
  ['discovery', 'discovery feed in spine', true],
  ['detail', 'what this line says', true],
  ['prompt', 'prompt & answer', true],
  ['images', 'what it was shown', true],
  ['tree', 'program tree', true],
  ['plate', 'plate', true],
  ['progression', 'iteration progression', true],
  ['sketches', 'every sketch', true],
  ['sampling', 'sampling', true],
  ['corpus', 'corpus shown', true],
  ['retrieval', 'retrieval / embeddings', true],
  ['artefacts', 'files on disk', false],
  ['corpus-scores', 'corpus scores', true],
  ['practice', 'practice history', false],
  ['scores', 'scores & cost', true],
  ['raw', 'raw log line', false],
];

// Every kind artist/studio-log.ts can emit, and no kind it cannot.
//
// This list used to hold eleven of the eighteen, and `spine()` drops a line whose kind it has no
// entry for — `on['kind.sample_selected']` is `undefined`, which is falsy, which is silence. So the
// entire sampling half of a run was invisible on a page whose whole claim is that it shows the
// record. A kind that is missing here is not merely untoggleable, it is gone.
//
// `replan` is in the LineKind union and is never emitted: act.ts writes it as `phase{phase:'replan'}`.
// It is left out rather than added dead, and this sentence is why.
const KINDS = [
  ['trajectory-start', true],
  ['phase', true],
  ['policy-call', true],
  ['step', true],
  ['render', true],
  ['trigger', true],
  ['edit-refused', true],
  ['env-call', true],
  ['sample_requested', true],
  ['sample_selected', true],
  ['sample_rejected', true],
  ['binding_declared', true],
  ['ablation_rendered', true],
  ['sample_revised', true],
  ['note', true],
  ['trajectory-end', true],
  ['trajectory-failed', true],
];

/**
 * The other log: discovery.jsonl, which nothing in this repo displayed.
 *
 * Kept in its own list and its own block of the spine because it is NOT the chain. Its lines carry a
 * seq of their own file but no `prev` and no `hash` — by design, since what RESEARCH asked the corpus
 * is deliberately not part of what a trajectory replays from. Merging the two feeds would produce a
 * page that either checks a chain that does not exist or stops checking the one that does.
 */
const DISCOVERY_KINDS = [
  ['policy-call', true],
  ['query', true],
  ['material-sheet', true],
  ['lens-proposed', true],
  ['lens-kept', true],
  ['lens-cut', true],
  ['sketch', true],
  ['pairwise', true],
  ['note', false],
];

const PARTS = [
  ['system', 'system prompt', false],
  ['observation', 'observation (the prompt)', true],
  ['obsdiff', 'diff vs previous same call', false],
  ['schema', 'schema demanded', false],
  ['raw', 'raw answer', true],
  ['action', 'parsed action', false],
  ['failures', 'retries & failures', true],
  ['usage', 'tokens & cost', true],
];

const TREE_OPTS = [
  ['args', 'show args', true],
  ['diff', 'diff against previous', true],
  ['onlychanged', 'only changed subtrees', false],
];

const on = {};
const store = (k, v) => localStorage.setItem(`inspect.${k}`, v ? '1' : '');
const restore = (k, d) => {
  const v = localStorage.getItem(`inspect.${k}`);
  return v === null ? d : v === '1';
};

function toggles(host, spec, prefix) {
  host.innerHTML = '';
  for (const [key, label, dflt] of spec) {
    const id = `${prefix}.${key}`;
    on[id] = restore(id, dflt === undefined ? label : dflt);
    const l = document.createElement('label');
    l.className = 'check';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = on[id];
    box.onchange = () => {
      on[id] = box.checked;
      store(id, box.checked);
      draw();
    };
    const text = document.createElement('span');
    text.textContent = typeof label === 'string' ? label : key;
    const count = document.createElement('b');
    count.dataset['count'] = id;
    l.append(box, text, count);
    host.append(l);
  }
}

// --- state --------------------------------------------------------------------------------------

const state = {
  run: null,
  lines: [],
  next: 0,
  /**
   * discovery.jsonl, kept apart from `lines` rather than merged into it.
   *
   * Merging would read better and be wrong. `hashAt`, the chain check and the incremental `next`
   * cursor all assume `lines[i].seq === i` over one chained file; a discovery line has a seq of its
   * own file and no `prev` or `hash` at all. So the two feeds are two feeds, and the spine says
   * which is which.
   */
  discovery: [],
  /** `[{name, bytes}]` — every png the run left on disk, sketches and sampling pairs included. */
  artefacts: [],
  /** Either a number (a studio seq) or `d:<i>` (an index into `discovery`). */
  selected: null,
  status: 'unknown',
  scores: null,
  influences: null,
  corpusScores: null,
  practice: null,
  final: null,
  timer: null,
};

/** Program trees by hash. A hash names one tree for all time, so this never needs invalidating. */
const trees = new Map();

async function tree(hash) {
  if (!hash) return null;
  if (trees.has(hash)) return trees.get(hash);
  const got = await fetch(`/api/program?hash=${hash}`)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  // A run made before trees were cached kept exactly one of them: the last. final.json has it, so
  // the final tree is readable for every run that ever finished, and the intermediate ones are not.
  if (!got && state.final?.finalHash === hash && state.final.finalProgram) {
    trees.set(hash, state.final.finalProgram);
    return state.final.finalProgram;
  }
  trees.set(hash, got);
  return got;
}

// --- loading ------------------------------------------------------------------------------------

async function runs() {
  const list = await fetch('/api/runs').then((r) => r.json());
  const sel = $('run');
  sel.innerHTML = '';
  for (const r of list) {
    const o = document.createElement('option');
    o.value = r.id;
    o.textContent = `${r.status === 'running' ? '• ' : '  '}${r.id}`;
    sel.append(o);
  }
  const wanted = new URLSearchParams(location.search).get('run');
  if (wanted && list.some((r) => r.id === wanted)) sel.value = wanted;
  if (sel.value) await open(sel.value);
}

async function open(id) {
  clearInterval(state.timer);
  Object.assign(state, {
    run: id, lines: [], next: 0, discovery: [], artefacts: [],
    selected: null, influences: null, scores: null, corpusScores: null, practice: null, final: null,
  });
  history.replaceState(null, '', `/inspect?run=${encodeURIComponent(id)}`);
  await Promise.all([more(), side()]);
  // Nothing was selected, so land on the last thing that happened — which when a run is going is
  // the thing you opened the page to look at.
  state.selected = state.lines.at(-1)?.seq ?? null;
  draw();
  state.timer = setInterval(poll, 1500);
}

/** Only the lines this page has not seen. A finished run costs one empty response per poll. */
async function more() {
  const text = await fetch(`/api/lines?run=${encodeURIComponent(state.run)}&from=${state.next}`)
    .then((r) => (r.ok ? r.text() : ''))
    .catch(() => '');
  const fresh = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  state.lines.push(...fresh);
  if (state.lines.length) state.next = state.lines.at(-1).seq + 1;
  return fresh.length;
}

/** Everything about the run that is not in the studio log: status, scores, corpus, discovery, files. */
async function side() {
  const run = encodeURIComponent(state.run);
  const [list, infl, scores, final, disc, files, corpusScores] = await Promise.all([
    fetch('/api/runs').then((r) => r.json()).catch(() => []),
    fetch(`/api/influences?run=${run}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`/api/file?run=${run}&name=scores.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`/api/file?run=${run}&name=final.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`/api/discovery?run=${run}`).then((r) => (r.ok ? r.text() : '')).catch(() => ''),
    fetch(`/api/artefacts?run=${run}`).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    fetch(`/api/corpus-scores?run=${run}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const me = list.find((r) => r.id === state.run);
  state.status = me?.status ?? 'unknown';
  state.influences = infl;
  state.scores = scores;
  state.corpusScores = corpusScores;
  state.final = final;
  state.artefacts = files;
  // Practice is keyed by position, not by run. Fetch it once side() knows the position.
  const positionId = state.lines[0]?.data?.positionId;
  if (positionId) {
    state.practice = await fetch(`/api/practice?position=${encodeURIComponent(positionId)}`)
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }
  // Re-read whole rather than incrementally. Discovery is a few hundred lines at most and is
  // written only in the first third of a run, so the saving would be a rounding error against the
  // risk of a cursor that disagrees with a file allowed to be resumed and rewritten.
  state.discovery = disc
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function poll() {
  const wasEnd = state.lines.at(-1)?.seq;
  const n = await more();
  if (state.status === 'running') await side();
  // Follow a live run only if the page was already sitting on its last line. Once you click
  // something, the feed stops moving under you.
  if (n && state.selected === wasEnd) state.selected = state.lines.at(-1).seq;
  if (n || state.status === 'running') draw();
  if (state.status !== 'running') clearInterval(state.timer);
}

// --- reading a line -----------------------------------------------------------------------------

const n2 = (v) => (typeof v === 'number' ? (Math.round(v * 100) / 100).toString() : '?');

function summary(l) {
  const d = l.data ?? {};
  switch (l.kind) {
    case 'trajectory-start':
      return `${d.positionId} × ${d.briefId}${d.control ? ' [control]' : ''} · seed ${d.seed} · ${d.maxSteps} steps${
        d.influencesId ? ` · influences ${d.influencesId} (${d.influenceWorks})` : ' · no influences'
      }`;
    case 'phase':
      return [d.phase, d.problemId, d.trigger, d.profile, d.sketches != null ? `${d.sketches} sketches` : '']
        .filter(Boolean)
        .join(' · ');
    case 'policy-call':
      return `${d.name}${d.ok ? '' : '  FAILED'}${d.attempts > 1 ? `  ${d.attempts} attempts` : ''}${
        d.hasImages ? '  +images' : ''
      }  ${d.observation ? `${(d.observation.length / 1000).toFixed(1)}k chars` : ''}`;
    case 'step':
      return `k=${d.k} ${d.accepted ? 'accepted' : `reverted: ${d.revertedBecause ?? '?'}`} · ${
        (d.edits ?? []).length
      } edits · ${d.pixelsMoved ?? 0} px${d.inert ? ' · INERT' : ''}${d.improved === false ? ' · worse' : ''}`;
    case 'render':
      return `tree ${n2(d.treeScore)} render ${n2(d.renderScore)} · hard ${d.hardViolations} soft ${d.softViolations}`;
    case 'edit-refused':
      return `${d.actionId ?? ''} ${d.reason ?? ''}`;
    case 'trigger':
      return `${d.trigger} · ${d.detail ?? ''}`;
    case 'env-call':
      return `${d.name}${d.cached ? ' (cached)' : ''}`;
    case 'trajectory-end':
      return `${d.outcome} · ${n2(d.cost?.usd)} usd · ${d.cost?.policyCalls} calls`;
    case 'trajectory-failed':
      return String(d.error ?? '').split('\n')[0];
    case 'sample_requested':
      return `${(d.intents ?? []).length} intents${d.fallback ? ' · FALLBACK (the artist did not state them)' : ''}`;
    case 'sample_selected': {
      const p = d.plan ?? {};
      return `${(p.samples ?? []).length} samples · ${p.createdBy?.kind ?? '?'}${p.goal?.subject ? ` · ${p.goal.subject}` : ''}`;
    }
    case 'sample_rejected':
      return `${d.fragmentId ?? ''} — ${d.reason ?? ''}`;
    case 'binding_declared':
      return `${d.status} · ${d.accepted ? 'accepted' : `REFUSED: ${(d.faults ?? []).join('; ')}`}`;
    case 'ablation_rendered':
      return `${d.differingPixels ?? '?'} of ${d.totalPixels ?? '?'} px differ (${
        d.totalPixels ? ((100 * d.differingPixels) / d.totalPixels).toFixed(2) : '?'
      }%)`;
    case 'sample_revised':
      return `${d.revision?.kind ?? '?'} · ${d.accepted ? 'accepted' : 'refused'}`;
    case 'note':
      // A sketch note is the one note worth reading at a glance: it is the only record that a
      // particular sketch existed at all.
      if (d.phase === 'sketch') {
        return `sketch ${d.problemId}#${d.index} · ${
          d.drawn ? `drew ${String(d.programHash).slice(0, 12)}` : d.retry ? `retrying: ${d.retry}` : `DIED: ${d.failure}`
        }`;
      }
      if (d.phase === 'finish-gate') {
        const blockerKinds = (d.blockers ?? []).map((b) => { const m = b.match(/^\[([^\]]+)\]/); return m ? m[1] : '?'; }).join(', ');
        const hasCopy = (d.blockers ?? []).some((b) => b.includes('[corpus-copy]'));
        return `finish-gate #${d.attempt ?? '?'} · ${d.accepted ? 'accepted' : `REFUSED: ${blockerKinds}`}${hasCopy ? ' · CORPUS COPY' : ''}`;
      }
      return Object.keys(d).filter((k) => k !== 'phase').join(', ');
    default:
      return JSON.stringify(d).slice(0, 120);
  }
}

/** The same job for the unchained feed. Its kinds do not overlap studio's except for `policy-call`. */
function dsummary(l) {
  const d = l.data ?? {};
  switch (l.kind) {
    case 'policy-call':
      return summary(l);
    case 'query':
      return `round ${d.round} · ${d.returned} returned${d.error ? ` · FAILED: ${d.error}` : ''} · ${d.lookingFor ?? ''}`;
    case 'material-sheet':
      return `${d.shown} shown of ${d.candidatesSeen} seen`;
    // A discovery Lens is `{ id, lens, emergent? }` (wide-sketch.ts) — the text is under `lens`, and
    // `lens-cut` wraps the whole lens as `{ lens, reason }`, so the field is one level down there.
    case 'lens-proposed':
    case 'lens-kept':
      return `${d.id ?? ''} · ${d.lens ?? ''}${d.emergent ? ` → ${d.emergent}` : ''}`;
    case 'lens-cut':
      return `${d.lens?.id ?? ''} · ${d.lens?.lens ?? ''} — CUT: ${d.reason ?? ''}`;
    case 'sketch':
      return `${d.lensId}#${d.index} · ${d.drawn === false ? `DIED: ${d.failure}` : String(d.programHash ?? '').slice(0, 12)} · ${d.approach ?? ''}`;
    case 'pairwise':
      return `${d.a ?? ''} vs ${d.b ?? ''} → ${d.winner ?? '?'}`;
    default:
      return JSON.stringify(d).slice(0, 120);
  }
}

function selected() {
  if (typeof state.selected === 'string' && state.selected.startsWith('d:')) {
    return state.discovery[Number(state.selected.slice(2))] ?? null;
  }
  return state.lines.find((l) => l.seq === state.selected) ?? null;
}

/** True when what is selected came out of discovery.jsonl, which has no chain and no programs. */
const inDiscovery = () => typeof state.selected === 'string' && state.selected.startsWith('d:');

/** The program the run was standing on at a line: this line's hash, or the last one before it. */
function hashAt(seq) {
  if (typeof seq !== 'number') return null;
  for (let i = state.lines.findIndex((l) => l.seq === seq); i >= 0; i--) {
    const h = state.lines[i]?.data?.programHash;
    if (typeof h === 'string') return h;
  }
  return null;
}

/** The one before that, so a tree can be diffed against what it replaced. */
function hashBefore(seq) {
  if (typeof seq !== 'number') return null;
  const here = hashAt(seq);
  let seen = false;
  for (let i = state.lines.findIndex((l) => l.seq === seq); i >= 0; i--) {
    const h = state.lines[i]?.data?.programHash;
    if (typeof h !== 'string') continue;
    if (!seen) {
      seen = h === here;
      if (h !== here) return h;
      continue;
    }
    if (h !== here) return h;
  }
  return null;
}

// --- drawing ------------------------------------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function spine() {
  const host = $('spine');
  const needle = $('filter').value.trim().toLowerCase();
  host.innerHTML = '';
  const counts = {};
  for (const l of state.lines) counts[l.kind] = (counts[l.kind] ?? 0) + 1;
  for (const [k] of KINDS) {
    const b = document.querySelector(`b[data-count="kind.${k}"]`);
    if (b) b.textContent = counts[k] ?? 0;
  }
  const dcounts = {};
  for (const l of state.discovery) dcounts[l.kind] = (dcounts[l.kind] ?? 0) + 1;
  for (const [k] of DISCOVERY_KINDS) {
    const b = document.querySelector(`b[data-count="disc.${k}"]`);
    if (b) b.textContent = dcounts[k] ?? 0;
  }

  const row = (key, kind, s, cls) => {
    if (needle && !`${kind} ${s}`.toLowerCase().includes(needle)) return;
    const r = el('div', `row${cls ?? ''}${key === state.selected ? ' on' : ''}`);
    r.append(el('div', 'seq', String(typeof key === 'string' ? key.slice(2) : key)));
    const right = el('div');
    right.append(el('div', `k k-${kind}`, kind), el('div', 's', s));
    r.append(right);
    r.onclick = () => {
      state.selected = key;
      draw();
    };
    host.append(r);
  };

  // Discovery first because it happens first: RESEARCH and DIVERGE run before the chained log has
  // anything but its opening line. The band says plainly that this half is not the record — a page
  // that let the two look alike would be lying about which lines a trajectory replays from.
  if (state.discovery.length && on['pane.discovery']) {
    const head = el('div', 'band');
    head.textContent = `discovery.jsonl — ${state.discovery.length} lines, unchained`;
    host.append(head);
    for (const [i, l] of state.discovery.entries()) {
      if (!on[`disc.${l.kind}`]) continue;
      row(`d:${i}`, l.kind, dsummary(l), ' disc');
    }
    const tail = el('div', 'band');
    tail.textContent = `studio.jsonl — ${state.lines.length} lines, hash-chained`;
    host.append(tail);
  }

  for (const l of state.lines) {
    if (!on[`kind.${l.kind}`]) continue;
    row(l.seq, l.kind, summary(l));
  }
}

function pane(key, title, note, build) {
  if (!on[`pane.${key}`]) return null;
  const p = el('div', `pane${restore(`shut.${key}`, false) ? ' shut' : ''}`);
  const head = el('header');
  head.append(el('b', null, title), el('i', null, note ?? ''));
  head.onclick = () => {
    p.classList.toggle('shut');
    store(`shut.${key}`, p.classList.contains('shut'));
  };
  p.append(head);
  const body = el('div', 'body');
  p.append(body);
  build(body);
  return p;
}

function block(host, label, text) {
  if (label) host.append(el('h2', null, label));
  host.append(el('pre', null, text));
}

// --- reading a line as prose rather than as JSON -------------------------------------------------
//
// Every kind but `policy-call` used to fall out of the bottom of this page into a raw JSON dump, so
// a step — the richest line in the file, carrying the edits, the refusals, the warrant, the moves
// and whether any of it moved a pixel — was legible only to someone who already knew the shape.
//
// The renderers below are deliberately mostly one generic walk. A bespoke renderer per kind reads
// better in the two or three cases where it exists and silently drops a field the day someone adds
// one; the walk cannot, because it is driven by the keys that are actually there. Where prose
// matters more than a table — a `think`, a description, a fault — the walk is told so by name.

/** A label/value table. Skips nothing that is present: `false` and `0` are answers. */
function facts(host, rows) {
  const t = el('table', 'facts');
  let any = false;
  for (const [k, v] of rows) {
    if (v === undefined || v === null || v === '') continue;
    any = true;
    const tr = el('tr');
    tr.append(el('th', null, k), el('td', null, String(v)));
    t.append(tr);
  }
  if (any) host.append(t);
}

const cell = (v) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** An array of objects as one table, columns being the union of every key that appears. */
function rowsTable(host, arr) {
  const keys = [...new Set(arr.flatMap((o) => Object.keys(o ?? {})))];
  const t = el('table');
  const hr = el('tr');
  for (const k of keys) hr.append(el('th', null, k));
  t.append(hr);
  for (const o of arr) {
    const tr = el('tr');
    for (const k of keys) tr.append(el('td', null, cell(o?.[k])));
    t.append(tr);
  }
  host.append(t);
}

/** Fields whose value is a sentence, not a token — shown as prose however short they happen to be. */
const PROSE = new Set([
  'think', 'description', 'audienceRead', 'wouldAct', 'evidence', 'reason', 'detail', 'error',
  'stack', 'assessment', 'why', 'whyChosen', 'borrowed', 'intendedDifference', 'claimedEffect',
  'failure', 'revertedBecause', 'approach', 'logic', 'retry', 'lookingFor', 'cost',
]);

function autoDetail(b, d, skip = new Set()) {
  const scalars = [];
  const later = [];
  for (const [k, v] of Object.entries(d ?? {})) {
    if (skip.has(k)) continue;
    if (v === null || v === undefined) {
      scalars.push([k, '(null)']);
    } else if (Array.isArray(v)) {
      if (!v.length) scalars.push([k, '(empty)']);
      else if (v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
        later.push(() => {
          b.append(el('h2', null, `${k} (${v.length})`));
          rowsTable(b, v);
        });
      } else later.push(() => block(b, `${k} (${v.length})`, v.map(cell).join('\n')));
    } else if (typeof v === 'object') {
      later.push(() => block(b, k, JSON.stringify(v, null, 2)));
    } else if (typeof v === 'string' && (PROSE.has(k) || v.length > 90)) {
      later.push(() => block(b, k, v));
    } else {
      scalars.push([k, v]);
    }
  }
  facts(b, scalars);
  for (const f of later) f();
}

function stepDetail(b, d) {
  b.append(
    el(
      'p',
      d.accepted ? 'note' : 'miss',
      d.accepted
        ? `Kept. ${d.pixelsMoved ?? 0} pixels moved${
            d.inert ? ' — below the inert threshold, so this step is on the record as having changed nothing anyone could see' : ''
          }.`
        : `Reverted: ${d.revertedBecause ?? '(no reason recorded)'}`
    )
  );
  const landed = new Set(d.applied ?? []);
  const edits = d.edits ?? [];
  if (edits.length) {
    b.append(el('h2', null, `edits — ${edits.length} proposed, ${landed.size} landed`));
    rowsTable(b, edits.map((e) => ({ ...e, landed: landed.has(e.actionId) ? 'yes' : 'NO' })));
  }
  autoDetail(b, d, new Set(['edits', 'applied', 'accepted', 'revertedBecause', 'pixelsMoved']));
}

/**
 * A sampling plan unfolded: what was borrowed, from what, and what it was chosen over.
 *
 * The trap this pane has to be honest about: a fragment comes out of the sampling index, not out of
 * `corpus/images/`. It has a `sourceImageHash` that names nothing this server can serve, so there is
 * no picture to show and the pane says that rather than rendering a broken frame.
 */
function planDetail(b, plan) {
  facts(b, [
    ['plan', plan.planId],
    ['seed', plan.seed],
    ['index', plan.indexId],
    ['made by', plan.createdBy?.kind + (plan.createdBy?.profile ? ` (${plan.createdBy.profile})` : '')],
    ['fallback', plan.fallback],
    ['subject', plan.goal?.subject],
    ['percepts', (plan.goal?.percepts ?? []).join(' · ')],
    ['avoid', (plan.goal?.avoid ?? []).join(' · ')],
  ]);
  b.append(
    el(
      'p',
      'note',
      'Each fragment below is a crop of a Met work held in the sampling index. It carries a sourceImageHash, ' +
        'not a corpus sha256, so the picture itself is not servable from here — what is on the record is the ' +
        'provenance, the measured features and what it beat.'
    )
  );
  for (const s of plan.samples ?? []) {
    const p = s.fragment?.provenance ?? {};
    b.append(el('h2', null, `${s.sampleId} · ${s.role} · ${s.enabled === false ? 'DISABLED' : 'enabled'}`));
    facts(b, [
      ['borrowed', s.borrowed],
      ['why chosen', s.whyChosen],
      ['perceptual goal', s.perceptualGoal],
      ['intended difference', s.intendedDifference],
      ['channels', (s.channels ?? []).join(' · ')],
      ['transformation', s.transformation],
      ['mode', s.mode],
      ['preset', s.preset],
      ['source', [p.title, p.artist, p.date, p.medium, p.culture, p.department, p.classification].filter(Boolean).join(' · ')],
      ['met object', p.objectId],
      ['fragment', `${s.fragment?.fragmentKind ?? ''} ${s.fragment?.fragmentId ?? ''}`],
      ['crop', JSON.stringify(s.fragment?.normalizedBounds ?? [])],
    ]);
    const f = s.fragment?.formalFeatures;
    if (f) {
      facts(b, [
        ['contrast', n2(f.contrast)],
        ['edge density', n2(f.edgeDensity)],
        ['spatial density', n2(f.spatialDensity)],
        ['symmetry', n2(f.symmetry)],
        ['negative space', n2(f.negativeSpace)],
        ['flow', `${n2(f.dominantDirectionalFlow)}°`],
      ]);
    }
    const c = s.candidates ?? [];
    if (c.length > 1) {
      b.append(el('h2', null, `chosen over ${c.length - 1} others`));
      rowsTable(
        b,
        c.map((x) => ({
          rank: x.rank,
          title: x.fragment?.provenance?.title,
          hybrid: n2(x.scores?.hybrid),
          embedding: n2(x.scores?.embedding),
          formal: n2(x.scores?.formal),
          quality: n2(x.scores?.quality),
          diversity: n2(x.scores?.diversity),
        }))
      );
    }
  }
}

function detailPane(l) {
  if (!l) return null;
  const d = l.data ?? {};
  const where = inDiscovery() ? 'discovery' : `seq ${l.seq}`;
  return pane('detail', l.kind, `${where} · ${String(l.t ?? '').slice(11, 19)}`, (b) => {
    if (l.kind === 'policy-call') {
      b.append(el('p', 'note', 'The prompt, the schema, the raw answer and the retries are in the pane below. Only the accounting is here.'));
      autoDetail(b, d, new Set(['system', 'observation', 'schema', 'raw', 'action', 'failures', 'images']));
      return;
    }
    if (l.kind === 'step') return stepDetail(b, d);
    if (l.kind === 'sample_selected') return planDetail(b, d.plan ?? {});
    autoDetail(b, d);
  });
}

// --- the pictures a call was actually given ------------------------------------------------------

function imagesPane(l) {
  if (l?.kind !== 'policy-call') return null;
  const d = l?.data ?? {};
  const imgs = d.images ?? [];
  return pane('images', 'what it was shown', `${imgs.length} attached`, (b) => {
    if (!imgs.length) {
      b.append(
        el(
          'p',
          'miss',
          d.hasImages
            ? 'This call WAS given pictures — hasImages is true — and the line does not say which. Runs made before ' +
              'the shown-image record kept only that one boolean; the bytes were never written down and cannot be recovered.'
            : 'No picture was attached. This decision was made from text alone.'
        )
      );
      return;
    }
    const works = new Map((state.influences?.resolved?.works ?? []).map((w) => [w.sha256, w]));
    const g = el('div', 'grid');
    for (const im of imgs) {
      const card = el('div', 'work shown');
      const img = el('img');
      img.loading = 'lazy';
      img.src = `/api/shown?sha=${im.sha256}`;
      img.onerror = () => img.replaceWith(el('div', 'miss', 'those bytes are not in the cache'));
      const meta = el('div', 'meta');
      meta.append(el('div', 't', im.label), el('div', 'v', `${im.sha256.slice(0, 12)} · ${(im.bytes / 1024).toFixed(0)} kB`));
      // The whole point of the corpus label: it is the sha256 of the bytes, which is also the name
      // of the file in corpus/images and the key of the manifest row. So "which inspiration, and why
      // was it there" is one lookup away from the picture the model was handed.
      if (im.label.startsWith('corpus:')) {
        const w = works.get(im.label.slice(7));
        if (w) {
          meta.append(
            el('div', 't', w.title ?? w.id),
            el('div', 'v', `w ${w.weight?.toFixed(2)} · cos ${w.cosine?.toFixed(3)} · ${w.museum}`),
            el('div', 'v', `via: ${w.via ?? ''}`)
          );
        } else {
          meta.append(el('div', 'v', 'not in the influence set now loaded'));
        }
      }
      card.append(img, meta);
      g.append(card);
    }
    b.append(g);
  });
}

// --- progression: every iteration's plate, side by side ------------------------------------------

function progressionPane(l) {
  // Collect every unique program hash from step/render lines, in order.
  const seen = new Set();
  const frames = [];
  for (const line of state.lines) {
    const h = line.data?.programHash;
    if (!h || seen.has(h)) continue;
    seen.add(h);
    const isStep = line.kind === 'step';
    const isRender = line.kind === 'render';
    const isSketchNote = line.kind === 'note' && line.data?.phase === 'sketch' && line.data?.drawn;
    if (!isStep && !isRender && !isSketchNote) continue;
    frames.push({ hash: h, seq: line.seq, kind: line.kind, data: line.data });
  }
  if (!frames.length) return null;
  const currentHash = hashAt(l?.seq ?? -1);
  return pane('progression', 'iteration progression', `${frames.length} states`, (b) => {
    const strip = el('div', 'progression-strip');
    for (const [i, f] of frames.entries()) {
      const frame = el('div', `step-frame${f.hash === currentHash ? ' current' : ''}`);
      const img = el('img');
      img.loading = 'lazy';
      img.src = `/api/plate?hash=${f.hash}`;
      img.onerror = () => img.replaceWith(el('div', 'gone', 'no plate'));
      const label = el('div', 'step-label');
      const idx = el('span', 'idx', `#${i + 1}`);
      const info = f.kind === 'step'
        ? ` · ${f.data.accepted ? 'kept' : 'reverted'} · ${f.data.pixelsMoved ?? 0}px`
        : f.kind === 'note'
        ? ` · sketch ${f.data.problemId ?? ''}#${f.data.index ?? ''}`
        : ` · render`;
      label.append(idx, document.createTextNode(info));
      frame.append(img, label);
      frame.onclick = () => { state.selected = f.seq; draw(); };
      strip.append(frame);
    }
    b.append(strip);
  });
}

// --- every sketch, drawn or dead -----------------------------------------------------------------

function sketchesPane() {
  // Read from `lines` rather than from what the spine is showing: whether NOTE is toggled on is a
  // question about the spine, not about whether these sketches happened.
  const notes = state.lines.filter((l) => l.kind === 'note' && l.data?.phase === 'sketch');
  const cells = new Map();
  for (const l of notes) {
    const d = l.data;
    const key = `${d.problemId}#${d.index}`;
    const c = cells.get(key) ?? { key, problemId: d.problemId, index: d.index, seq: l.seq, retries: 0 };
    if (d.drawn) Object.assign(c, { programHash: d.programHash, approach: d.approach, attempt: d.attempt, seq: l.seq });
    else if (d.retry !== undefined) c.retries++;
    else if (d.failure !== undefined) Object.assign(c, { failure: d.failure, seq: l.seq });
    cells.set(key, c);
  }
  const sheets = state.artefacts.filter((f) => f.name.startsWith('sketches/'));
  if (!cells.size && !sheets.length) return null;
  const drawn = [...cells.values()].filter((c) => c.programHash).length;
  return pane('sketches', 'every sketch', `${drawn} drew, ${cells.size - drawn} died`, (b) => {
    if (!cells.size) {
      b.append(
        el(
          'p',
          'miss',
          'This run predates the sketch record: a sketch that drew left no line at all, only a file. The contact ' +
            'sheet and the plates below are all there is of it.'
        )
      );
    }
    const g = el('div', 'grid');
    for (const c of cells.values()) {
      const card = el('div', `work${c.programHash ? ' seen' : ' died'}`);
      if (c.programHash) {
        const img = el('img');
        img.loading = 'lazy';
        img.src = `/api/plate?hash=${c.programHash}`;
        img.onerror = () => img.replaceWith(el('div', 'miss', 'not in the render cache'));
        card.append(img);
      } else {
        // A dead sketch is a cell, not an absence. The old page showed the survivors and let the
        // failures be inferred from a gap in the numbering.
        card.append(el('div', 'gone', 'nothing drew'));
      }
      const meta = el('div', 'meta');
      meta.append(el('div', 't', c.key), el('div', 'v', c.programHash ? String(c.programHash).slice(0, 12) : ''));
      if (c.approach) meta.append(el('div', 'v2', c.approach));
      if (c.failure) meta.append(el('div', 'v2 bad', c.failure));
      if (c.retries) meta.append(el('div', 'v', `${c.retries} retry`));
      card.append(meta);
      card.style.cursor = 'pointer';
      card.onclick = () => {
        state.selected = c.seq;
        draw();
      };
      g.append(card);
    }
    b.append(g);
    for (const f of sheets) {
      b.append(el('h2', null, `${f.name} · ${(f.bytes / 1024).toFixed(0)} kB`));
      const img = el('img');
      img.loading = 'lazy';
      img.src = `/api/file?run=${encodeURIComponent(state.run)}&name=${encodeURIComponent(f.name)}`;
      const wrap = el('div', 'plate');
      wrap.append(img);
      b.append(wrap);
    }
  });
}

// --- sampling ------------------------------------------------------------------------------------

function samplingPane() {
  const of = (k) => state.lines.filter((l) => l.kind === k);
  const requested = of('sample_requested');
  const selectedPlans = of('sample_selected');
  const rejected = of('sample_rejected');
  const bound = of('binding_declared');
  const ablations = of('ablation_rendered');
  const revised = of('sample_revised');
  if (!requested.length && !selectedPlans.length && !bound.length && !ablations.length) return null;
  return pane('sampling', 'sampling', `${selectedPlans.length} plans · ${bound.length} bindings · ${ablations.length} ablations`, (b) => {
    for (const r of requested) {
      b.append(el('h2', null, `requested${r.data?.fallback ? ' — FALLBACK, the artist did not state these' : ''}`));
      rowsTable(b, r.data?.intents ?? []);
    }
    if (rejected.length) {
      b.append(el('h2', null, `rejected by the artist (${rejected.length})`));
      rowsTable(b, rejected.map((l) => l.data));
    }
    if (bound.length) {
      b.append(el('h2', null, `bindings declared (${bound.length})`));
      rowsTable(
        b,
        bound.map((l) => ({
          seq: l.seq,
          status: l.data?.status,
          where: l.data?.problemId ? `${l.data.problemId}#${l.data.sketchIndex}` : l.data?.lensId ?? '',
          accepted: l.data?.accepted,
          bindings: l.data?.bindings,
          faults: (l.data?.faults ?? []).join('; '),
        }))
      );
    }
    if (revised.length) {
      b.append(el('h2', null, `revisions (${revised.length})`));
      rowsTable(b, revised.map((l) => ({ seq: l.seq, kind: l.data?.revision?.kind, accepted: l.data?.accepted, faults: (l.data?.faults ?? []).join('; ') })));
    }
    // The pair is the whole argument that the sample did anything: the same program rendered with
    // the sample and with its salience set to zero. Side by side, with the count of pixels between.
    for (const a of ablations) {
      const d = a.data ?? {};
      const share = d.totalPixels ? `${((100 * d.differingPixels) / d.totalPixels).toFixed(2)}%` : '?';
      b.append(el('h2', null, `sampled vs salience-0 ablation — ${d.differingPixels} of ${d.totalPixels} px (${share})`));
      const pairing = el('div', 'grid');
      for (const [label, name] of [['sampled', d.sampledFile], ['ablation', d.ablationFile]]) {
        const card = el('div', 'work shown');
        if (name) {
          const img = el('img');
          img.loading = 'lazy';
          img.src = `/api/file?run=${encodeURIComponent(state.run)}&name=${encodeURIComponent(name)}`;
          img.onerror = () => img.replaceWith(el('div', 'miss', 'not written'));
          card.append(img);
        }
        card.append(el('div', 'meta', `${label} — ${name ?? 'no file'}`));
        pairing.append(card);
      }
      b.append(pairing);
      if ((d.effects ?? []).length) {
        b.append(el('h2', null, 'what each sample claimed to do, and what it touched'));
        rowsTable(b, d.effects);
      }
      if ((d.resolutions ?? []).length) {
        b.append(el('h2', null, 'how each role found its nodes'));
        rowsTable(b, d.resolutions);
      }
    }
  });
}

// --- what the run left on disk -------------------------------------------------------------------

function artefactsPane() {
  if (!state.artefacts.length) return null;
  return pane('artefacts', 'files on disk', `${state.artefacts.length} images`, (b) => {
    const g = el('div', 'grid');
    for (const f of state.artefacts) {
      const card = el('div', 'work shown');
      const img = el('img');
      img.loading = 'lazy';
      img.src = `/api/file?run=${encodeURIComponent(state.run)}&name=${encodeURIComponent(f.name)}`;
      const meta = el('div', 'meta');
      meta.append(el('div', 't', f.name), el('div', 'v', `${(f.bytes / 1024).toFixed(0)} kB`));
      card.append(img, meta);
      g.append(card);
    }
    b.append(g);
  });
}

/**
 * Line-level diff, trimmed at both ends.
 *
 * Not an LCS. Two observations for the same call differ by an appended paragraph and a changed
 * number, so common prefix plus common suffix finds the change exactly, and when it does not it
 * over-reports rather than hides — which is the safe direction for a thing whose job is to show you
 * what moved between two prompts.
 */
function diffText(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out = [];
  if (head) out.push(`  … ${head} identical lines`);
  for (const l of a.slice(head, a.length - tail)) out.push(`- ${l}`);
  for (const l of b.slice(head, b.length - tail)) out.push(`+ ${l}`);
  if (tail) out.push(`  … ${tail} identical lines`);
  return out.length ? out.join('\n') : '(byte-identical)';
}

function promptPane(l) {
  if (l?.kind !== 'policy-call') return null;
  const d = l?.data ?? {};
  const prev = state.lines
    .filter((x) => x.kind === 'policy-call' && x.seq < l.seq && x.data?.name === d.name)
    .at(-1);
  return pane('prompt', `prompt & answer — ${d.name}`, `${d.model ?? '?'} · obs ${String(d.observationHash ?? '').slice(0, 12)}`, (b) => {
    const parts = el('div', 'sub');
    for (const [key, label] of PARTS) {
      const bt = el('button', on[`part.${key}`] ? 'on' : null, label);
      bt.onclick = () => {
        on[`part.${key}`] = !on[`part.${key}`];
        store(`part.${key}`, on[`part.${key}`]);
        draw();
      };
      parts.append(bt);
    }
    b.append(parts);

    if (on['part.system']) block(b, 'system', d.system ?? '(none)');
    if (on['part.observation']) block(b, `observation — ${(d.observation ?? '').length} chars`, d.observation ?? '(not logged)');
    if (on['part.obsdiff']) {
      block(
        b,
        prev ? `diff against ${d.name} at seq ${prev.seq}` : 'diff against previous',
        prev ? diffText(prev.data.observation ?? '', d.observation ?? '') : '(this is the first call of this kind)'
      );
    }
    if (on['part.schema']) block(b, 'schema demanded', JSON.stringify(d.schema, null, 2));
    if (on['part.raw']) block(b, 'raw answer', d.raw ?? '(none — the call failed before an answer)');
    if (on['part.action']) block(b, 'parsed action', JSON.stringify(d.action, null, 2));
    if (on['part.failures']) {
      const f = d.failures ?? [];
      block(
        b,
        `retries — ${d.attempts ?? 1} attempt(s), ${f.length} rejected`,
        f.length ? f.map((x, i) => `${i + 1}. ${x}`).join('\n\n') : d.ok ? '(accepted first time)' : d.error ?? '(no failures recorded)'
      );
    }
    if (on['part.usage']) {
      const u = d.usage ?? {};
      block(b, 'tokens & cost', JSON.stringify({ model: d.model, hasImages: d.hasImages, ...u }, null, 2));
    }
  });
}

// --- the program tree ---------------------------------------------------------------------------

function index(node, into = new Map()) {
  if (!node || typeof node !== 'object') return into;
  if (node.id) into.set(node.id, node);
  for (const c of node.children ?? []) index(c, into);
  return into;
}

const bodyOf = (n) => JSON.stringify({ type: n.type, op: n.op, macro: n.macro, rngKey: n.rngKey, args: n.args });

function drawTree(host, node, was, showArgs, onlyChanged, depth = 0) {
  if (!node) return false;
  const old = was?.get(node.id);
  const mark = !was ? '' : !old ? 'added' : bodyOf(old) !== bodyOf(node) ? 'changed' : '';
  const kids = node.children ?? [];
  const box = el('div');
  const changedBelow = [];
  for (const c of kids) changedBelow.push(drawTree(box, c, was, showArgs, onlyChanged, depth + 1));
  const anyChange = Boolean(mark) || changedBelow.some(Boolean);
  if (onlyChanged && was && !anyChange) return false;

  const label = el('span', `n ${mark}`);
  label.append(el('span', 'ty', node.type ?? '?'), document.createTextNode(' '), el('span', 'id', node.id ?? ''));
  if (node.op) label.append(document.createTextNode(' '), el('span', 'op', node.op));
  if (node.macro) label.append(document.createTextNode(' '), el('span', 'op', `macro:${node.macro}`));
  if (node.rngKey) label.append(document.createTextNode('  '), el('span', 'rk', node.rngKey));
  if (showArgs && node.args) {
    label.append(document.createTextNode('  '), el('span', 'args', JSON.stringify(node.args)));
  }
  host.append(label, box);
  return anyChange;
}

function treePane(l) {
  if (inDiscovery()) return null;
  const here = hashAt(l?.seq ?? -1);
  if (!here) return null;
  const before = on['tree.diff'] ? hashBefore(l?.seq ?? -1) : null;
  return pane('tree', 'program tree', `${here.slice(0, 12)}${before ? ` ← ${before.slice(0, 12)}` : ''}`, (b) => {
    const opts = el('div', 'sub');
    for (const [key, label] of TREE_OPTS) {
      const bt = el('button', on[`tree.${key}`] ? 'on' : null, label);
      bt.onclick = () => {
        on[`tree.${key}`] = !on[`tree.${key}`];
        store(`tree.${key}`, on[`tree.${key}`]);
        draw();
      };
      opts.append(bt);
    }
    b.append(opts);
    const host = el('div', 'tree');
    b.append(host);
    Promise.all([tree(here), before ? tree(before) : null]).then(([now, was]) => {
      host.innerHTML = '';
      if (!now) {
        host.append(
          el(
            'p',
            'miss',
            `The tree for ${here.slice(0, 12)} is not in the render cache. Trees are written beside plates from this build onwards; runs made before it kept only their edits, so their intermediate trees are gone.`
          )
        );
        return;
      }
      const removed = [];
      const wasIndex = was ? index(was.root) : null;
      drawTree(host, now.root, wasIndex, on['tree.args'], on['tree.onlychanged']);
      if (wasIndex) {
        const nowIndex = index(now.root);
        for (const [id, node] of wasIndex) if (!nowIndex.has(id)) removed.push(node);
      }
      if (removed.length) {
        host.append(el('h2', null, `removed (${removed.length})`));
        const gone = el('div', 'tree');
        for (const r of removed) {
          const s = el('span', 'n removed');
          s.append(el('span', 'ty', r.type ?? '?'), document.createTextNode(' '), el('span', 'id', r.id ?? ''));
          gone.append(s);
        }
        host.append(gone);
      }
      const top = el('div', 'note');
      top.textContent = `canvas ${now.canvas?.width}×${now.canvas?.height} ground ${now.canvas?.ground} · profile ${now.profile} · pack ${now.assetPack} · palette ${Object.values(
        now.palette ?? {}
      ).join(' ')} · ${index(now.root).size} nodes`;
      host.prepend(top);
    });
  });
}

function platePane(l) {
  if (inDiscovery()) return null;
  const here = hashAt(l?.seq ?? -1);
  if (!here) return null;
  return pane('plate', 'plate', here.slice(0, 12), (b) => {
    const wrap = el('div', 'plate');
    const img = el('img');
    img.src = `/api/plate?hash=${here}`;
    img.onerror = () => {
      wrap.innerHTML = '';
      wrap.append(el('p', 'miss', 'not in the render cache'));
    };
    wrap.append(img);
    b.append(wrap);
  });
}

// --- the corpus ---------------------------------------------------------------------------------

/**
 * The set picker, on both corpus panes.
 *
 * A set is a document on disk, not a property of a run, and no run so far has been given one. So the
 * picker offers every set that resolves and the caption says, in the one place it matters, whether
 * the set on screen is the one this trajectory saw or one you are browsing.
 */
function setPicker(host) {
  const inf = state.influences;
  const sets = inf?.sets ?? [];
  if (!sets.length) return;
  const sel = el('select');
  for (const s of sets) {
    const o = el('option', null, `${s}${s === inf?.ranWith ? '  (this run)' : ''}`);
    o.value = s;
    sel.append(o);
  }
  sel.value = inf?.influencesId ?? sets[0];
  sel.style.width = 'auto';
  sel.onchange = async () => {
    state.influences = await fetch(
      `/api/influences?run=${encodeURIComponent(state.run)}&set=${encodeURIComponent(sel.value)}`
    ).then((r) => r.json());
    draw();
  };
  host.append(sel);
}

function corpusPane() {
  const inf = state.influences;
  const works = inf?.resolved?.works ?? [];
  const shown = new Set(inf?.shown ?? []);
  const mine = inf?.influencesId && inf.influencesId === inf.ranWith;
  return pane(
    'corpus',
    'corpus shown to the artist',
    inf?.influencesId ? `${inf.influencesId} · ${works.length} works, ${shown.size} with a picture` : 'none',
    (b) => {
      if (!inf?.ranWith) {
        b.append(
          el(
            'p',
            'miss',
            'THIS RUN SAW NO CORPUS WORK AT ALL. It was given no influence set, so the 19,807 images and the ' +
              'CLIP matrix took no part in it — nothing below entered any prompt. Pass --influences <id> to a run ' +
              'to change that. The sets on disk are browsable here regardless.'
          )
        );
      }
      setPicker(b);
      if (!inf?.influencesId) return;
      b.append(
        el(
          'p',
          'note',
          mine
            ? `Reached FIND${inf.inMake ? ' and MAKE' : ' only — MAKE saw none of this'}. ` +
              'Bordered works were attached as pictures; the rest were named in the catalogue text and never seen.'
            : `Browsing ${inf.influencesId}. This run was not given it. Bordered works are the ones that would be ` +
              'attached as pictures; the rest would be named in the catalogue text only.'
        )
      );
      const g = el('div', 'grid');
      for (const w of works) {
        const card = el('div', `work${shown.has(w.sha256) ? ' seen' : ''}`);
        const img = el('img');
        img.loading = 'lazy';
        img.src = `/corpus/images/${w.sha256}.jpg`;
        img.title = `${w.title}\n${w.museum} ${w.id}\nweight ${w.weight?.toFixed(3)} cosine ${w.cosine?.toFixed(3)}\nvia: ${w.via}`;
        const bar = el('div', 'bar');
        const fill = el('i');
        fill.style.width = `${Math.max(0, Math.min(1, w.weight ?? 0)) * 100}%`;
        bar.append(fill);
        const meta = el('div', 'meta');
        meta.append(
          el('div', 't', w.title ?? w.id),
          el('div', 'v', `w ${w.weight?.toFixed(2)} · cos ${w.cosine?.toFixed(3)} · ${w.museum}`),
          el('div', 'v', w.via ?? '')
        );
        card.append(img, bar, meta);
        g.append(card);
      }
      b.append(g);
    }
  );
}

function retrievalPane() {
  const inf = state.influences;
  return pane('retrieval', 'retrieval / embeddings', inf?.influencesId ? `hash ${String(inf.hash).slice(0, 12)}` : 'none', (b) => {
    if (!inf?.ranWith) {
      b.append(el('p', 'miss', 'No retrieval ran for this trajectory. Nothing was embedded, queried or ranked for it.'));
    }
    if (!inf?.influencesId) return;
    setPicker(b);
    const r = inf.resolved ?? {};
    const spec = inf.spec ?? {};
    b.append(
      el(
        'p',
        'note',
        'Every query below was put through the CLIP text tower and matched against corpus/clip.f32 (19,807 × 512, cosine). ' +
          'No model was called and nothing was read: this is nearest-neighbour retrieval over an encoder, and a high cosine means the ' +
          'words photograph like the picture, not that the work is what the words name.'
      )
    );

    b.append(el('h2', null, 'queries'));
    const t = el('table');
    t.innerHTML = '<tr><th>source</th><th>weight</th><th>k</th><th>text</th></tr>';
    for (const q of spec.queries ?? []) {
      const tr = el('tr');
      tr.append(el('td', null, q.source), el('td', 'num', String(q.weight)), el('td', 'num', String(q.k)), el('td', null, q.text));
      t.append(tr);
    }
    b.append(t);

    if ((spec.avoid ?? []).length) block(b, 'avoid (down-weight, never remove)', spec.avoid.join('\n'));
    if ((spec.picks ?? []).length) block(b, 'hand-picked (weight 1.0, never capped away)', spec.picks.join('\n'));
    if (spec.limits) block(b, 'limits', JSON.stringify(spec.limits, null, 2));

    if ((r.axes ?? []).length) {
      b.append(el('h2', null, 'axes of the resolved set (PCA)'));
      const a = el('table');
      a.innerHTML = '<tr><th>axis</th><th>explained</th><th>label</th></tr>';
      for (const x of r.axes) {
        const tr = el('tr');
        tr.append(el('td', 'num', String(x.index)), el('td', 'num', `${(100 * x.explained).toFixed(1)}%`), el('td', null, x.label));
        a.append(tr);
      }
      b.append(a);
    }

    block(
      b,
      'geometry & separation',
      JSON.stringify({ centroidDim: (r.centroid ?? []).length, spread: r.spread, radius: r.radius, truncated: r.truncated, empty: r.empty, stats: r.stats }, null, 2)
    );
    block(b, 'the block, exactly as the artist read it', inf.section ?? '(not built)');
  });
}

function corpusScoresPane() {
  const cs = state.corpusScores;
  const plates = cs?.plates ?? [];
  const final = plates.find((p) => p.kind === 'final');
  const hasCopy = plates.some((p) => p.copyFlag);
  const note = final
    ? `novelty ${final.novelty.toFixed(4)}${final.copyFlag ? '  COPY FLAG' : ''}` +
      (final.influencePercentile != null ? `  influence pctile ${(final.influencePercentile * 100).toFixed(1)}%` : '')
    : cs ? `${plates.length} plates` : 'not computed';
  return pane('corpus-scores', 'corpus scores', note, (b) => {
    if (!cs) {
      b.append(el('p', 'miss', 'No scores.corpus.json — run `corpus plates <trajectory_dir>` to compute it.'));
      return;
    }
    if (hasCopy) {
      const warn = el('p');
      warn.style.color = 'var(--bad)';
      warn.style.fontWeight = '600';
      warn.textContent = 'COPY FLAG: at least one plate is above the copy-cosine threshold (0.95) to a corpus work.';
      b.append(warn);
    }
    if (final) {
      b.append(el('h2', null, 'final plate'));
      const rows = [
        ['novelty', final.novelty.toFixed(4)],
        ['copyFlag', String(final.copyFlag)],
        ['nearest corpus work', `${final.nearestCorpus?.id ?? '?'} — ${(final.nearestCorpus?.title ?? '').slice(0, 50)}`],
        ['cosine to nearest', final.nearestCorpus?.cosine?.toFixed(4) ?? '?'],
        ['corpus percentile', `${(final.corpusPercentile * 100).toFixed(1)}%`],
      ];
      if (final.influencePercentile != null) {
        rows.push(
          ['cosine to influence centroid', final.cosineToInfluenceCentroid?.toFixed(4) ?? '?'],
          ['influence percentile', `${(final.influencePercentile * 100).toFixed(1)}%`],
        );
      }
      if (final.nearestInfluence) {
        rows.push(['nearest influence', `${final.nearestInfluence.id} — ${(final.nearestInfluence.title ?? '').slice(0, 50)}`]);
      }
      facts(b, rows);
    }
    if (plates.length > 1) {
      b.append(el('h2', null, `all plates (${plates.length})`));
      const t = el('table');
      t.innerHTML = '<tr><th>file</th><th>kind</th><th class="num">novelty</th><th class="num">pctile</th><th class="num">infl pctile</th><th>copy</th><th>nearest</th></tr>';
      for (const p of plates) {
        const tr = el('tr');
        tr.append(
          el('td', null, p.file),
          el('td', null, p.kind),
          el('td', 'num', p.novelty.toFixed(4)),
          el('td', 'num', `${(p.corpusPercentile * 100).toFixed(1)}%`),
          el('td', 'num', p.influencePercentile != null ? `${(p.influencePercentile * 100).toFixed(1)}%` : '—'),
          el('td', p.copyFlag ? 'dead' : null, p.copyFlag ? 'YES' : ''),
          el('td', null, (p.nearestCorpus?.title ?? p.nearestCorpus?.id ?? '?').slice(0, 30)),
        );
        if (p.copyFlag) tr.style.color = 'var(--bad)';
        t.append(tr);
      }
      b.append(t);
    }
    b.append(el('h2', null, 'band'));
    facts(b, [
      ['corpus rows', String(cs.corpusRows)],
      ['band works', String(cs.band?.works)],
      ['band median', cs.band?.median?.toFixed(4) ?? '?'],
    ]);
    if (cs.drift) {
      b.append(el('h2', null, 'drift'));
      b.append(el('p', 'miss', cs.drift.reason ?? (cs.drift.measured === false ? 'not measured' : JSON.stringify(cs.drift))));
    }
  });
}

function practicePane() {
  const versions = state.practice;
  const note = versions ? `${versions.length} version${versions.length === 1 ? '' : 's'}` : 'none';
  return pane('practice', 'practice history', note, (b) => {
    if (!versions || versions.length === 0) {
      b.append(el('p', 'miss', 'No practice versions exist for this position. A run through UPDATE PRACTICE writes the first.'));
      return;
    }
    for (const v of versions) {
      b.append(el('h2', null, `v${v.version} — ${v.trajectoryId}`));
      block(b, 'changed', v.changed);
      if ((v.borrowed ?? []).length) {
        const bt = el('table');
        bt.innerHTML = '<tr><th>material</th><th>works</th><th>borrowing</th></tr>';
        for (const bw of v.borrowed) {
          const tr = el('tr');
          tr.append(el('td', null, bw.id), el('td', null, (bw.works ?? []).join(', ')), el('td', null, bw.borrowing));
          bt.append(tr);
        }
        b.append(bt);
      }
      if ((v.fertile ?? []).length) {
        b.append(el('h2', null, 'fertile lenses'));
        for (const f of v.fertile) {
          b.append(el('p', null, `[${f.id}] ${f.what}`));
          b.append(el('p', 'note', f.why));
        }
      }
      if ((v.rejected ?? []).length) {
        b.append(el('h2', null, 'rejected'));
        for (const r of v.rejected) {
          b.append(el('p', null, `[${r.id}] ${r.what}`));
          b.append(el('p', 'note', r.why));
        }
      }
    }
  });
}

function scoresPane() {
  const end = state.lines.find((l) => l.kind === 'trajectory-end');
  const died = state.lines.find((l) => l.kind === 'trajectory-failed');
  return pane('scores', 'scores & cost', end ? String(end.data?.outcome ?? '') : state.status, (b) => {
    // First, because a run that threw has no scores and the reason is the only thing worth reading.
    if (died) {
      b.append(el('h2', null, 'the run threw and stopped'));
      b.append(el('p', 'miss', String(died.data?.error ?? 'no message')));
      if (died.data?.stack) block(b, 'stack', String(died.data.stack));
      if (died.data?.policySpend) block(b, 'what it had spent by then', JSON.stringify(died.data.policySpend, null, 2));
    }
    const renders = state.lines.filter((l) => l.kind === 'render');
    if (renders.length) {
      b.append(el('h2', null, `every render (${renders.length})`));
      const t = el('table');
      t.innerHTML = '<tr><th>seq</th><th>tree</th><th>render</th><th>hard</th><th>soft</th><th>standing</th><th>program</th></tr>';
      for (const r of renders) {
        const d = r.data;
        const tr = el('tr');
        tr.append(
          el('td', 'num', String(r.seq)),
          el('td', 'num', n2(d.treeScore)),
          el('td', 'num', n2(d.renderScore)),
          el('td', 'num', String(d.hardViolations ?? '')),
          el('td', 'num', String(d.softViolations ?? '')),
          el('td', 'num', n2(d.standing)),
          el('td', null, String(d.programHash ?? '').slice(0, 12))
        );
        tr.onclick = () => {
          state.selected = r.seq;
          draw();
        };
        tr.style.cursor = 'pointer';
        t.append(tr);
      }
      b.append(t);
    }
    if (state.scores) block(b, 'scores.json', JSON.stringify(state.scores, null, 2));
    else b.append(el('p', 'miss', 'scores.json is not written until the run ends.'));
    if (end) block(b, 'trajectory-end', JSON.stringify(end.data, null, 2));
    if (state.final?.cost) block(b, 'cost', JSON.stringify(state.final.cost, null, 2));
    if (state.final?.envVersion) block(b, 'envVersion — what this run was, exactly', JSON.stringify(state.final.envVersion, null, 2));
  });
}

// --- the page -----------------------------------------------------------------------------------

function draw() {
  const l = selected();
  $('runline').innerHTML = '';
  const died = state.lines.find((x) => x.kind === 'trajectory-failed');
  $('runline').append(
    el('span', state.status === 'running' ? 'live' : 'dead', state.status),
    document.createTextNode(` · ${state.lines.length} lines`)
  );
  // The reason a run is dead belongs beside the word "dead", not three panes down.
  if (died) {
    $('runline').append(document.createTextNode(' · '), el('span', 'dead', String(died.data?.error ?? '').split('\n')[0]));
  }

  // Every line names the hash of the one before it. If that chain is intact the record is whole,
  // and if it is not, no pane below is worth reading — so it is said here rather than buried.
  const broken = state.lines.filter((x, i) => x.seq !== i || (i > 0 && x.prev !== state.lines[i - 1].hash));
  $('chain').textContent = state.lines.length
    ? broken.length
      ? `log chain BROKEN at seq ${broken[0].seq}`
      : 'log chain intact'
    : '';
  $('chain').className = broken.length ? 'note dead' : 'note';

  // Corpus score indicators: novelty and copy flag, shown beside the chain status.
  const csFinal = (state.corpusScores?.plates ?? []).find((p) => p.kind === 'final');
  if (csFinal) {
    const parts = [`novelty ${csFinal.novelty.toFixed(3)}`];
    if (csFinal.influencePercentile != null) parts.push(`infl ${(csFinal.influencePercentile * 100).toFixed(0)}%`);
    $('runline').append(document.createTextNode(` · ${parts.join(' · ')}`));
    if (csFinal.copyFlag) {
      $('runline').append(document.createTextNode(' · '), el('span', 'dead', 'COPY FLAG'));
    }
  }

  spine();

  const host = $('panes');
  host.innerHTML = '';
  const start = state.lines[0];
  if (start && on['pane.spine-only']) {
    host.append(
      pane('spine-only', 'this run', `${start.data?.positionId} × ${start.data?.briefId}`, (b) => {
        block(b, null, JSON.stringify(start.data, null, 2));
      })
    );
  }
  const panes = [detailPane(l), promptPane(l), imagesPane(l), treePane(l), platePane(l),
    progressionPane(l), sketchesPane(), samplingPane(), corpusPane(), retrievalPane(), artefactsPane(), corpusScoresPane(), practicePane(), scoresPane()];
  for (const p of panes) if (p) host.append(p);
  if (on['pane.raw'] && l) {
    host.append(
      pane('raw', 'raw log line', `${inDiscovery() ? 'discovery.jsonl' : 'studio.jsonl'} seq ${l.seq} · ${l.kind}`, (b) => {
        block(b, null, JSON.stringify(l, null, 2));
      })
    );
  }
}

toggles($('panes-toggles'), PANES, 'pane');
toggles(
  $('kind-toggles'),
  KINDS.map(([k, d]) => [k, k, d]),
  'kind'
);
toggles(
  $('disc-toggles'),
  DISCOVERY_KINDS.map(([k, d]) => [k, k, d]),
  'disc'
);
toggles($('part-toggles'), PARTS, 'part');
toggles($('tree-toggles'), TREE_OPTS, 'tree');

$('run').onchange = (e) => open(e.target.value);
$('reload').onclick = () => open(state.run);
$('filter').oninput = () => spine();

await runs();
