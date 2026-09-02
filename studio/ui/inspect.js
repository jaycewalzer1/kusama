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
  ['prompt', 'prompt & answer', true],
  ['tree', 'program tree', true],
  ['plate', 'plate', true],
  ['corpus', 'corpus shown', true],
  ['retrieval', 'retrieval / embeddings', true],
  ['scores', 'scores & cost', true],
  ['raw', 'raw log line', false],
];

const KINDS = [
  ['trajectory-start', true],
  ['phase', true],
  ['policy-call', true],
  ['step', true],
  ['render', true],
  ['trigger', true],
  ['edit-refused', true],
  ['env-call', true],
  ['note', false],
  ['trajectory-end', true],
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
  selected: null,
  status: 'unknown',
  scores: null,
  influences: null,
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
  Object.assign(state, { run: id, lines: [], next: 0, selected: null, influences: null, scores: null, final: null });
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

/** Everything about the run that is not in the log: its status, its scores, its corpus. */
async function side() {
  const [list, infl, scores, final] = await Promise.all([
    fetch('/api/runs').then((r) => r.json()).catch(() => []),
    fetch(`/api/influences?run=${encodeURIComponent(state.run)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`/api/file?run=${encodeURIComponent(state.run)}&name=scores.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`/api/file?run=${encodeURIComponent(state.run)}&name=final.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const me = list.find((r) => r.id === state.run);
  state.status = me?.status ?? 'unknown';
  state.influences = infl;
  state.scores = scores;
  state.final = final;
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
    case 'note':
      return Object.keys(d).filter((k) => k !== 'phase').join(', ');
    default:
      return JSON.stringify(d).slice(0, 120);
  }
}

const selected = () => state.lines.find((l) => l.seq === state.selected) ?? null;

/** The program the run was standing on at a line: this line's hash, or the last one before it. */
function hashAt(seq) {
  for (let i = state.lines.findIndex((l) => l.seq === seq); i >= 0; i--) {
    const h = state.lines[i]?.data?.programHash;
    if (typeof h === 'string') return h;
  }
  return null;
}

/** The one before that, so a tree can be diffed against what it replaced. */
function hashBefore(seq) {
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
  for (const l of state.lines) {
    if (!on[`kind.${l.kind}`]) continue;
    const s = summary(l);
    if (needle && !`${l.kind} ${s}`.toLowerCase().includes(needle)) continue;
    const row = el('div', `row${l.seq === state.selected ? ' on' : ''}`);
    row.append(el('div', 'seq', String(l.seq)));
    const right = el('div');
    right.append(el('div', `k k-${l.kind}`, l.kind), el('div', 's', s));
    row.append(right);
    row.onclick = () => {
      state.selected = l.seq;
      draw();
    };
    host.append(row);
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
  const d = l?.data ?? {};
  if (l?.kind !== 'policy-call') {
    return pane('prompt', 'prompt & answer', 'select a policy-call in the spine', (b) => {
      b.append(el('p', 'miss', 'This line is not a call to the model. Pick a POLICY-CALL row to see the prompt it was given and the answer it gave.'));
    });
  }
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
  const here = hashAt(l?.seq ?? -1);
  const before = on['tree.diff'] ? hashBefore(l?.seq ?? -1) : null;
  return pane('tree', 'program tree', here ? `${here.slice(0, 12)}${before ? ` ← ${before.slice(0, 12)}` : ''}` : 'no program yet', (b) => {
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
    if (!here) {
      host.append(el('p', 'miss', 'No program hash at or before this line — the run had not rendered anything yet.'));
      return;
    }
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
  const here = hashAt(l?.seq ?? -1);
  return pane('plate', 'plate', here ? here.slice(0, 12) : 'nothing rendered yet', (b) => {
    const wrap = el('div', 'plate');
    if (here) {
      const img = el('img');
      img.src = `/api/plate?hash=${here}`;
      img.onerror = () => {
        wrap.innerHTML = '';
        wrap.append(el('p', 'miss', 'not in the render cache'));
      };
      wrap.append(img);
    } else {
      wrap.append(el('p', 'miss', 'no plate at this point in the run'));
    }
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

function scoresPane() {
  const end = state.lines.find((l) => l.kind === 'trajectory-end');
  return pane('scores', 'scores & cost', end ? String(end.data?.outcome ?? '') : state.status, (b) => {
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
  $('runline').append(
    el('span', state.status === 'running' ? 'live' : 'dead', state.status),
    document.createTextNode(` · ${state.lines.length} lines`)
  );

  // Every line names the hash of the one before it. If that chain is intact the record is whole,
  // and if it is not, no pane below is worth reading — so it is said here rather than buried.
  const broken = state.lines.filter((x, i) => x.seq !== i || (i > 0 && x.prev !== state.lines[i - 1].hash));
  $('chain').textContent = state.lines.length
    ? broken.length
      ? `log chain BROKEN at seq ${broken[0].seq}`
      : 'log chain intact'
    : '';
  $('chain').className = broken.length ? 'note dead' : 'note';

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
  for (const p of [promptPane(l), treePane(l), platePane(l), corpusPane(), retrievalPane(), scoresPane()]) {
    if (p) host.append(p);
  }
  if (on['pane.raw'] && l) {
    host.append(
      pane('raw', 'raw log line', `seq ${l.seq} · ${l.kind}`, (b) => {
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
toggles($('part-toggles'), PARTS, 'part');
toggles($('tree-toggles'), TREE_OPTS, 'tree');

$('run').onchange = (e) => open(e.target.value);
$('reload').onclick = () => open(state.run);
$('filter').oninput = () => spine();

await runs();
