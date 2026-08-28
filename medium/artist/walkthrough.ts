// The piece being made, one step at a time, next to the reason it was made that way.
//
// Both halves of this already existed and neither was any use alone. filmstrip.ts rebuilds the
// pixels after every step; story.ts folds the log into what the artist said. Looking at a strip of
// near-identical plates tells you something moved and not why, and reading the reasoning tells you
// what it meant to do and not whether it happened. The join is the whole value: *this* sentence,
// *that* change to the sheet, and the number saying how much of it was still there at the end.
//
// A pure fold over lines that were already written, like story.ts and transition.ts and for the same
// reason — so a walkthrough of a run collected before this file existed is the same walkthrough as
// one taken live. It renders nothing and reads no files; the frames are handed in, because deciding
// what a frame is belongs to filmstrip.ts and there must be exactly one answer to that.

import { storyOf, summarise, type Entry, type Note } from './story.js';
import type { SurvivalRow } from './filmstrip.js';
import type { LogLine } from './studio-log.js';
import { processOf, type Transition } from './transition.js';

/** One frame of the strip with everything the log knows about how it came to look like that. */
export interface Scene {
  /** Frame index. 0 is the sheet the artist started from, before it did anything. */
  k: number;
  /** The file the frame was written to, relative to the walkthrough. */
  frame: string;
  /** The verdict and the first line of the artist's own words: `kept · 3 edits — ...`. */
  title: string;
  /** What the artist said it was doing, in full. Empty on the seed frame; nobody had spoken yet. */
  said: string;
  /** Refusals folded to families, triggers that fired, and what a replan changed. */
  notes: Note[];
  /** Null on the seed frame, which was not a decision. */
  accepted: boolean | null;
  revertedBecause: string | null;
  edits: { actionId: string; kind: string; applied: boolean; refusedBecause: string | null }[];
  born: string[];
  destroyed: string[];
  /** Share of the canvas this step moved, as the run measured it. */
  pixelsMoved: number | null;
  standing: { before: number; after: number } | null;
  /**
   * How much of what this step laid down is still visible in the finished piece. Null on the seed
   * frame and on any step that moved no pixels.
   */
  survival: SurvivalRow | null;
  replanTrigger: string | null;
  isRiskMove: boolean;
  /** studio.jsonl line numbers folded into this scene, so the raw record is one lookup away. */
  seqs: number[];
}

export interface Walkthrough {
  positionId: string;
  briefId: string;
  control: boolean;
  scenes: Scene[];
  meanSurvival: number | null;
  totals: { usd: number; ms: number; calls: number; refused: number; steps: number };
}

const first = (text: string, fallback: string): string => {
  const line = text.split('\n').find((l) => l.trim().replace(/^[-*]\s*/, '').length > 0);
  return line ? line.trim().replace(/^[-*]\s*/, '') : fallback;
};

/**
 * Joins the three folds on the step index.
 *
 * `k` is the join key and it is the same `k` in all three by construction: filmstrip pushes one
 * frame per `step` line after the seed, transition.ts emits one record per `step` line, and the
 * MAKE act labels its beats `step k` off the same counter. If a run ever produced a step the
 * filmstrip could not rebuild, filmstrip.ts throws long before this is reached.
 */
export function walkthroughOf(
  lines: LogLine[],
  frames: { k: number }[],
  survival: SurvivalRow[],
  meanSurvival: number | null
): Walkthrough {
  const entries: Entry[] = lines.map((l) => ({ seq: l.seq, t: l.t, kind: l.kind, summary: summarise(l.kind, l.data) }));
  const story = storyOf(entries);
  const { transitions } = processOf(lines);

  const start = (lines.find((l) => l.kind === 'trajectory-start')?.data ?? {}) as {
    positionId?: string;
    briefId?: string;
    control?: boolean;
  };

  const make = story.acts.find((a) => a.id === 'make');
  const beatFor = (k: number) => make?.beats.find((b) => b.label === `step ${k}`);
  const byK = new Map<number, Transition>(transitions.map((t) => [t.k, t]));
  const survivalFor = new Map<number, SurvivalRow>(survival.map((r) => [r.k, r]));

  // Read off the step line rather than through the Transition, which defaults a missing
  // `pixelsMoved` to 0. Runs collected before that field existed would otherwise render as "moved
  // 0.00% of the sheet" on a step that visibly repainted the canvas, and a page that states a wrong
  // number confidently is worse than one that omits it. Absent stays absent.
  const movedByK = new Map<number, number>();
  for (const l of lines) {
    if (l.kind !== 'step') continue;
    const d = l.data as { k: number; pixelsMoved?: number };
    if (typeof d.pixelsMoved === 'number') movedByK.set(d.k, d.pixelsMoved);
  }

  const scenes: Scene[] = frames.map(({ k }) => {
    const file = `step-${String(k).padStart(2, '0')}.png`;
    if (k === 0) {
      const opening = make?.beats.find((b) => b.label === 'start');
      return {
        k,
        frame: file,
        title: 'the sheet it started from',
        said: '',
        notes: opening?.notes ?? [],
        accepted: null,
        revertedBecause: null,
        edits: [],
        born: [],
        destroyed: [],
        pixelsMoved: null,
        standing: null,
        survival: null,
        replanTrigger: null,
        isRiskMove: false,
        seqs: opening?.seqs ?? [],
      };
    }

    const beat = beatFor(k);
    const t = byK.get(k);
    const said = beat?.said ?? '';
    const landed = t ? t.edits.filter((e) => e.applied).length : 0;

    return {
      k,
      frame: file,
      // The beat's title already reads `kept · 3 edits — <first line>`; fall back to building the
      // same shape from the transition when the story could not find a beat for this step.
      title:
        beat?.title ??
        `${t?.accepted ? 'kept' : 'reverted'} · ${landed} edit${landed === 1 ? '' : 's'} — ${first(said, 'an edit')}`,
      said,
      notes: beat?.notes ?? [],
      accepted: t?.accepted ?? null,
      revertedBecause: t?.revertedBecause ?? null,
      edits:
        t?.edits.map((e) => ({ actionId: e.actionId, kind: e.kind, applied: e.applied, refusedBecause: e.refusedBecause })) ??
        [],
      born: t?.born ?? [],
      destroyed: t?.destroyedNodeIds ?? [],
      pixelsMoved: movedByK.get(k) ?? null,
      standing: t ? { before: t.before.standing, after: t.after.standing } : null,
      survival: survivalFor.get(k) ?? null,
      replanTrigger: t?.replanTrigger ?? null,
      isRiskMove: t?.isRiskMove ?? false,
      seqs: beat?.seqs ?? [],
    };
  });

  return {
    positionId: start.positionId ?? '',
    briefId: start.briefId ?? '',
    control: start.control ?? false,
    scenes,
    meanSurvival,
    totals: story.totals,
  };
}

// --- the page -----------------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * A self-contained scrubber. The frames sit next to it as the PNGs the filmstrip already wrote, so
 * this file is small and the images are the ones that were measured rather than copies of them.
 */
export function walkthroughHtml(w: Walkthrough): string {
  // `<` is escaped inside the JSON so that a `</script>` in the artist's own words cannot end the
  // block early. Every other character is safe in a script element.
  const data = JSON.stringify(w).replace(/</g, '\\u003c');
  const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
  const title = `${w.positionId} × ${w.briefId}${w.control ? ' (control)' : ''}`;

  return `<!doctype html>
<meta charset="utf-8">
<title>${esc(title)} — walkthrough</title>
<style>
  :root { color-scheme: dark; --bg:#111; --panel:#191919; --line:#2c2c2c; --dim:#8a8a8a; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:#e8e8e8;
         font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex;
           gap:20px; align-items:baseline; flex-wrap:wrap; }
  header b { font-size:15px; font-weight:600; }
  header span { color:var(--dim); font-size:12px; }
  main { display:grid; grid-template-columns:minmax(0,1fr) 400px; gap:0; height:calc(100vh - 150px); }
  #stage { display:flex; align-items:center; justify-content:center; padding:20px; min-width:0; }
  #plate { max-width:100%; max-height:100%; object-fit:contain;
           background:#fff; box-shadow:0 4px 30px #0009; image-rendering:pixelated; }
  aside { border-left:1px solid var(--line); background:var(--panel); overflow-y:auto; padding:18px 20px; }
  h2 { font-size:14px; margin:0 0 4px; line-height:1.4; }
  .said { white-space:pre-wrap; margin:12px 0 16px; color:#dcdcdc; }
  .said:empty { display:none; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:3px 12px; margin:12px 0 14px;
       padding-bottom:14px; border-bottom:1px solid var(--line); font-size:12px; }
  dl:empty { display:none; }
  dt { color:var(--dim); }
  dd { margin:0; }
  ul { margin:0 0 16px; padding-left:16px; font-size:12px; }
  li { margin-bottom:3px; }
  li.warn { color:#e0b060; } li.bad { color:#e07070; } li.good { color:#7fc07f; }
  .kept { color:#7fc07f; } .revert { color:#e07070; }
  code { color:#9fc4e8; }
  footer { border-top:1px solid var(--line); padding:10px 20px; display:flex;
           gap:14px; align-items:center; }
  #scrub { flex:1; accent-color:#7fc07f; }
  button { background:#242424; color:#e8e8e8; border:1px solid var(--line);
           border-radius:4px; padding:5px 12px; font:inherit; font-size:12px; cursor:pointer; }
  button:hover { background:#2e2e2e; }
  #at { color:var(--dim); font-size:12px; min-width:150px; }
  .none { color:var(--dim); font-style:italic; }
</style>
<header>
  <b>${esc(title)}</b>
  <span>${w.totals.steps} steps · ${w.totals.calls} calls · ${w.totals.refused} edits refused
        · $${w.totals.usd.toFixed(2)} · ${Math.round(w.totals.ms / 60000)} min</span>
  <span>mean survival <b>${pct(w.meanSurvival)}</b> of what was laid down is still visible</span>
</header>
<main>
  <div id="stage"><img id="plate" alt=""></div>
  <aside>
    <h2 id="title"></h2>
    <dl id="facts"></dl>
    <div class="said" id="said"></div>
    <ul id="notes"></ul>
    <ul id="edits"></ul>
  </aside>
</main>
<footer>
  <button id="prev">&larr; prev</button>
  <button id="next">next &rarr;</button>
  <button id="play">play</button>
  <input type="range" id="scrub" min="0" value="0">
  <span id="at"></span>
</footer>
<script type="application/json" id="data">${data}</script>
<script>
const W = JSON.parse(document.getElementById('data').textContent);
const S = W.scenes;
const $ = (id) => document.getElementById(id);
const pct = (n) => n === null || n === undefined ? 'n/a' : (n * 100).toFixed(2) + '%';
let at = 0, timer = null;

$('scrub').max = String(S.length - 1);

function row(dl, k, v) {
  const dt = document.createElement('dt'); dt.textContent = k;
  const dd = document.createElement('dd'); dd.innerHTML = v;
  dl.append(dt, dd);
}

function show(i) {
  at = Math.max(0, Math.min(S.length - 1, i));
  const s = S[at];
  $('plate').src = s.frame;
  $('title').textContent = s.title;
  $('said').textContent = s.said;
  $('at').textContent = 'frame ' + s.k + ' of ' + (S.length - 1);
  $('scrub').value = String(at);

  const facts = $('facts');
  facts.textContent = '';
  if (s.accepted !== null) {
    row(facts, 'verdict', s.accepted
      ? '<span class="kept">kept</span>'
      : '<span class="revert">reverted' + (s.revertedBecause ? ' — ' + s.revertedBecause : '') + '</span>');
  }
  if (s.pixelsMoved !== null) row(facts, 'moved', pct(s.pixelsMoved) + ' of the sheet');
  if (s.survival) {
    row(facts, 'laid down', pct(s.survival.laidDown));
    row(facts, 'survives', s.survival.survival === null
      ? 'moved nothing'
      : pct(s.survival.survival) + ' of it is still in the finished piece');
  }
  if (s.standing) row(facts, 'standing', s.standing.before.toFixed(3) + ' &rarr; ' + s.standing.after.toFixed(3));
  if (s.born.length) row(facts, 'added', s.born.map((b) => '<code>' + b + '</code>').join(' '));
  if (s.destroyed.length) row(facts, 'destroyed', s.destroyed.map((b) => '<code>' + b + '</code>').join(' '));
  if (s.replanTrigger) row(facts, 'replanned', s.replanTrigger);
  if (s.isRiskMove) row(facts, 'risk', 'this was the risk move');

  const notes = $('notes');
  notes.textContent = '';
  for (const n of s.notes) {
    const li = document.createElement('li');
    li.className = n.tone;
    li.textContent = (n.count > 1 ? n.count + 'x ' : '') + n.text;
    notes.append(li);
  }

  const edits = $('edits');
  edits.textContent = '';
  for (const e of s.edits) {
    const li = document.createElement('li');
    li.className = e.applied ? 'good' : 'bad';
    li.textContent = (e.applied ? '+ ' : '× ') + e.kind + (e.refusedBecause ? ' — ' + e.refusedBecause : '');
    edits.append(li);
  }
}

function stop() { clearInterval(timer); timer = null; $('play').textContent = 'play'; }

$('prev').onclick = () => { stop(); show(at - 1); };
$('next').onclick = () => { stop(); show(at + 1); };
$('scrub').oninput = (e) => { stop(); show(Number(e.target.value)); };
$('play').onclick = () => {
  if (timer) return stop();
  $('play').textContent = 'pause';
  if (at === S.length - 1) show(0);
  timer = setInterval(() => { if (at >= S.length - 1) stop(); else show(at + 1); }, 1200);
};
addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') { stop(); show(at - 1); }
  if (e.key === 'ArrowRight') { stop(); show(at + 1); }
  if (e.key === ' ') { e.preventDefault(); $('play').click(); }
});
show(0);
</script>
`;
}
