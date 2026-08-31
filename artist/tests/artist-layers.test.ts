// The prompt stack, asserted where it would otherwise decay silently.
//
// The arrangement only measures anything if each layer answers exactly one question. L1 varies with
// the artist and never with the job; L2 varies with the job and never with the artist; L4 varies
// with nothing. A layer that answers two of those has not broken anything visible — the run still
// completes and still scores — it has quietly supplied the derivation the run exists to watch the
// artist perform. Nothing but a test notices.
//
// So: the documents are checked for completeness, the brief is checked for aesthetic direction, and
// the assembly order is checked in every phase that assembles it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import {
  aestheticDirection,
  artistLayers,
  loadBrief,
  loadCommission,
  practiceOf,
} from '../field.js';
import {
  PROTOCOL_HASH,
  chooseObservation,
  examineObservation,
  findObservation,
  makeObservation,
  type MakeContext,
} from '../observation.js';
import { framesOf } from '../phases/act.js';
import { loadAestheticProgram } from '../../aesthetic/check.js';
import type { CheckReport } from '../../aesthetic/types.js';
import type { Intention } from '../types.js';

const ids = (dir: string, suffix = '.json') =>
  readdirSync(path.join(ROOT, 'aesthetic', dir))
    .filter((f) => f.endsWith(suffix) && !f.endsWith('.field.json'))
    .sort()
    .map((f) => f.slice(0, -suffix.length));

const POSITIONS = ids('positions');
const BRIEFS = ids('briefs');

// --- L1: the practice ----------------------------------------------------------------------------

test('L1: every position carries a practice, and the practice says something', () => {
  assert.ok(POSITIONS.length >= 2, 'a stack with one position tests nothing');
  for (const id of POSITIONS) {
    const practice = practiceOf(loadAestheticProgram(path.join(ROOT, 'aesthetic/positions', `${id}.json`)));
    // Lengths rather than presence: `practiceOf` already refuses empty strings, and the failure that
    // actually happens is a one-word period or an origin that restates the position's name.
    assert.ok(practice.origin.length > 60, `${id}: origin is too short to be an origin`);
    assert.ok(practice.doing.length > 20, `${id}: doing is too short`);
    assert.ok(/\d{4}/.test(practice.period), `${id}: period must name years, not a mood — got "${practice.period}"`);
    assert.ok(practice.register.length > 20, `${id}: register is too short`);
    assert.ok(practice.refusals.length >= 3, `${id}: ${practice.refusals.length} refusals`);
  }
});

const position = (id: string) => loadAestheticProgram(path.join(ROOT, 'aesthetic/positions', `${id}.json`));

/**
 * Lineage is a record, not an instruction.
 *
 * Every position cites five or six real works by real people, and `aesthetic-fixtures.test.ts`
 * requires them — they are how a reader knows where the vocabulary came from. What they must not do
 * is reach the model. A policy handed "Jamie Reid, artwork for the Sex Pistols" imitates Jamie
 * Reid's surface, and the run then measures the model's recall of a 1977 sleeve rather than whether
 * the position changed anything, which is the one thing it was built to measure.
 *
 * The position's `name` is the same failure in one word: "Interference" is a label for a look, and
 * a model given a label produces the look rather than deriving it from the practice underneath.
 *
 * Asserted on the assembled prompt rather than on `practiceSection`, so that a phase which starts
 * quoting the position itself is caught too.
 */
test('L1 sends no proper nouns: neither the position name nor its lineage enters the prompt', () => {
  for (const id of POSITIONS) {
    const c = loadCommission(id, BRIEFS[0]!);
    const prompt = findObservation(artistLayers(c), c.field);

    const p = c.positionAsWritten;
    assert.ok(!prompt.includes(p.name), `${id}: the prompt names the position "${p.name}"`);
    for (const l of p.lineage) {
      assert.ok(!prompt.includes(l.ref), `${id}: the prompt cites lineage "${l.ref}"`);
      assert.ok(!prompt.includes(l.why), `${id}: the prompt carries the lineage note for "${l.ref}"`);
    }
    // The lineage still has to exist to have been excluded — otherwise this passes vacuously the day
    // someone empties the field.
    assert.ok(p.lineage.length > 0, `${id}: no lineage, so this test proved nothing`);
  }
});

// --- L2: the condition ---------------------------------------------------------------------------

test('L2: every condition says what the situation is, and nothing about the object', () => {
  assert.ok(BRIEFS.length >= 2);
  const required = ['title', 'material', 'occasion', 'when', 'where', 'means', 'atStake', 'fear'] as const;
  for (const id of BRIEFS) {
    const brief = loadBrief(id);
    for (const key of required) {
      assert.equal(typeof brief[key], 'string', `condition ${id} has no ${key}`);
      assert.ok((brief[key] as string).trim().length > 0, `condition ${id} leaves ${key} empty`);
    }
    assert.ok(Array.isArray(brief.refusals) && brief.refusals.length > 0, `condition ${id} permits everything`);
  }
});

/**
 * L2 is a condition, not a commission. There is no client, no audience, no run size and no date the
 * work is late for, because a surface obliged to deliver named facts to a named audience by a
 * deadline is a poster and had its composition settled before the artist saw it.
 *
 * This test is the guard on that. It is not decoration: every one of these fields was here, and the
 * catalogue was producing posters for exactly as long as they were.
 */
test('L2: no condition is a commission', () => {
  const gone = ['client', 'audience', 'function', 'quantity', 'budget', 'timeline', 'mustAppear', 'clientFear', 'clientWantThatHurtsTheWork'];
  for (const id of BRIEFS) {
    const doc = loadBrief(id) as unknown as Record<string, unknown>;
    for (const key of gone) {
      assert.equal(doc[key], undefined, `condition ${id} still carries ${key}, which is a commission field`);
    }
  }
});

/**
 * A condition may bind the work materially — one ink, because there is one ink. It may not require a
 * string. A fact that has to come off the surface is a message, and a surface that owes somebody a
 * message is the thing this layer was rewritten to stop being.
 */
test('L2: no condition requires a string to be legible', () => {
  for (const id of BRIEFS) {
    for (const c of loadBrief(id).hard_constraints) {
      assert.notEqual(c.kind, 'textRequired', `condition ${id} constraint ${c.id} requires words on the surface`);
    }
  }
});

/**
 * The field that makes the experiment separable at all. A situation that only pushes in helpful
 * directions is answered identically by an artist with a practice and an artist without one: there
 * is nothing in it to decline, so declining leaves no trace and the null twin looks the same.
 *
 * Not a hard constraint, and the two must not be confused. A hard constraint is checked and cannot
 * be traded away; a pressure is something the artist may give in to, refuse or answer, and which of
 * the three it picks is what the run is for.
 */
test('L2: every condition pushes towards something that damages the work', () => {
  for (const id of BRIEFS) {
    const brief = loadBrief(id);
    assert.ok(
      Array.isArray(brief.pressures) && brief.pressures.length > 0,
      `condition ${id} pushes towards nothing that hurts the work, so there is nothing in it to resist`
    );
    for (const want of brief.pressures) {
      assert.ok(typeof want === 'string' && want.trim().length > 0, `condition ${id} has an empty pressure`);
    }
  }
});

/** And the pressures are scanned like the rest of the prose, so they cannot smuggle in a style word. */
test('L2: a pressure carrying aesthetic direction is caught like any other field', () => {
  const told = { ...loadBrief(BRIEFS[0]!), pressures: ['it has to be striking'] };
  assert.deepEqual(aestheticDirection(told), ['pressures: "striking"']);
});

/**
 * The mechanical half of the L2 rule. It is a smoke alarm rather than a proof — see `STYLE_WORDS` —
 * but the failure it catches is the one that actually happens, which is a brief that could not
 * resist telling the artist what the thing should look like.
 */
test('L2: no brief tells the artist what it should look like', () => {
  for (const id of BRIEFS) {
    const found = aestheticDirection(loadBrief(id));
    assert.deepEqual(found, [], `brief ${id} carries aesthetic direction: ${found.join('; ')}`);
  }
});

// --- L4 and the assembly -------------------------------------------------------------------------

test('L4: the protocol hashes, so an edit to it is a version bump', () => {
  assert.match(PROTOCOL_HASH, /^[0-9a-f]{16,64}$/);
});

/**
 * Context assembly order: L4, then L1, then L2. Every artist-side phase goes through `stack`, so
 * this is really a test that no phase assembles the three itself — but it is asserted per phase
 * rather than on `stack` alone, because the failure mode is a new phase that does.
 */
test('assembly order is L4 then L1 then L2, in every phase that assembles it', () => {
  const c = loadCommission(POSITIONS[0]!, BRIEFS[0]!);
  const report: CheckReport = {
    aesthetic: c.positionAsWritten.id,
    hardViolations: 0,
    softViolations: 0,
    treeScore: null,
    renderScore: null,
    blocked: 0,
    pendingRubrics: [],
    results: [],
  };
  const intention: Intention = {
    elements: [],
    edges: [],
    purpose: 'p',
    tension: { between: 'a', and: 'b', claim: 'c' },
    riskMove: null,
  };
  const make: MakeContext = {
    ...artistLayers(c),
    capabilitySheet: 'sheet',
    program: {},
    report,
    description: 'd',
    audienceRead: null,
    intention,
    affect: { arousal: 0.5, valence: 0 },
    steps: [],
    maxEdits: 1,
    stepsLeft: 1,
    canvasAttached: false,
    changeAttached: false,
    textOps: { used: 0, max: 8 },
  };

  const observations = {
    find: findObservation(artistLayers(c), c.field),
    choose: chooseObservation(artistLayers(c), [], 'none'),
    make: makeObservation(make),
    examine: examineObservation(artistLayers(c), intention, report, 'd', null),
  };
  const markers = ['HOW YOU WORK', 'YOUR PRACTICE', `THE CONDITION: ${c.brief.title}`];
  for (const [phase, text] of Object.entries(observations)) {
    const at = markers.map((m) => text.indexOf(m));
    for (let i = 0; i < markers.length; i++) assert.ok(at[i]! >= 0, `${phase} is missing "${markers[i]}"`);
    for (let i = 1; i < markers.length; i++) {
      assert.ok(at[i]! > at[i - 1]!, `${phase} has "${markers[i]}" before "${markers[i - 1]}"`);
    }
  }

  // What the observation says about the images and what the call carries have to be the same two
  // switches, or `canvasVisibleRate` measures the flag rather than the run.
  const png = Buffer.from('not really a png');
  const blind = makeObservation(make);
  assert.equal(framesOf(make, png, png), undefined, 'the blind arm attaches nothing');
  assert.ok(!blind.includes('The canvas itself is attached'), 'and claims nothing');

  const seeing: MakeContext = { ...make, canvasAttached: true, changeAttached: true };
  assert.equal(framesOf(seeing, png, png)?.length, 2);
  assert.ok(makeObservation(seeing).includes('The canvas itself is attached'));
  // A first step has a plate and no change yet: one image, and the sentence about the second one
  // is not written either.
  const noChange: MakeContext = { ...make, canvasAttached: true, changeAttached: false };
  assert.equal(framesOf(noChange, png, null)?.length, 1);
  assert.ok(!makeObservation(noChange).includes('marked in red'));
  // MUST MOVE. This is the case that used to pass silently: the text promises an image, the payload
  // carries none, and the step is recorded as having seen the canvas.
  assert.throws(() => framesOf(seeing, null, png), /no plate/);
});

// --- the elements have to reach the artist, not only the checker ---------------------------------
//
// The bug these two pin was silent for the whole life of the elements layer, and it was not in the
// elements layer. `Layers` has a `position` and `Commission` used to have one too, so every phase
// that wrote `findObservation(commission, ...)` compiled, read the document off disk, and showed the
// artist a position with none of the adopted lineage in it. Measured before the fix: a commission
// adopting `ma-interval` and `rodchenko-red-black` composed 21 constraints and 4 conflicts, and not
// one of the two elements' worldview fragments, cliches, constraint ids or reasons appeared anywhere
// in the FIND prompt. The run was graded on lineages it had never been told about.
//
// The rename of `Commission.position` to `positionAsWritten` is what makes the mistake a compile
// error. These are what make the fix visible as behaviour rather than as a diff.

/** Two elements with real constraints, adopted together, against a position that is not theirs. */
const WITH_ELEMENTS = ['ma-interval', 'rodchenko-red-black'];

test('an adopted element reaches every artist-facing prompt, not just the checker', () => {
  const c = loadCommission('withheld', BRIEFS[0]!, WITH_ELEMENTS);
  assert.ok(c.composition, 'the fixture adopted no elements, so this test proves nothing');
  assert.ok(c.composition.constraints.length > 0, 'the composition is empty');

  const prompt = findObservation(artistLayers(c), c.field);
  const pack = path.join(ROOT, 'aesthetic', 'elements', 'pack');
  for (const id of WITH_ELEMENTS) {
    const e = JSON.parse(readFileSync(path.join(pack, `${id}.json`), 'utf8')) as {
      worldviewFragment: string;
      cliches: string[];
      commitments?: { id: string; why: string }[];
      prohibitions: { id: string; why: string }[];
      generativeRules: { id: string; why: string }[];
    };
    assert.ok(prompt.includes(e.worldviewFragment), `${id}: the stance it carries never reaches the artist`);
    for (const cliche of e.cliches) {
      assert.ok(prompt.includes(cliche), `${id}: the artist is not told it refuses "${cliche}"`);
    }
    // The reasons, not the ids: an id is namespaced on the way into the composition, so matching one
    // would be matching `qualify`, and `why` is the sentence the artist actually has to read.
    for (const k of [...(e.commitments ?? []), ...e.prohibitions, ...e.generativeRules]) {
      assert.ok(prompt.includes(k.why), `${id}: rule ${k.id} is graded but never stated to the artist`);
    }
  }
});

/**
 * The tensions an element carries are merged into the position the artist reads.
 *
 * This is the one FIND grounds every problem in: the system prompt asks for the place the situation
 * rubs against a tension already held, so a lineage whose tensions are not in that list can forbid
 * things but cannot change how the situation is read — which is the claim the elements layer exists
 * to test.
 *
 * NOTHING IS BEING MEASURED HERE YET, and the test says so rather than passing quietly. All four
 * hand-authored elements predate the `tensions` field and carry none, so the merge currently merges
 * an empty list. The assertion below is written as an equality against the pack read independently,
 * so that it starts doing real work the moment `corpus derive` writes an element that has them —
 * and the explicit count is what stops "0 elements with tensions" from reading as a pass.
 */
test('element tensions are merged into what the artist holds (today: none exist, stated)', () => {
  const pack = path.join(ROOT, 'aesthetic', 'elements', 'pack');
  const elements = WITH_ELEMENTS.map(
    (id) => JSON.parse(readFileSync(path.join(pack, `${id}.json`), 'utf8')) as { tensions?: unknown[] }
  );
  const carried = elements.flatMap((e) => e.tensions ?? []);

  const c = loadCommission('withheld', BRIEFS[0]!, WITH_ELEMENTS);
  assert.deepEqual(
    c.effective.tensions,
    [...c.positionAsWritten.tensions, ...carried],
    'the composed position does not hold the position tensions followed by the elements own'
  );

  const withTensions = elements.filter((e) => (e.tensions ?? []).length > 0).length;
  if (withTensions === 0) {
    // Deliberately not an assertion failure — it is the true state of the pack. It is a statement,
    // so that a reader of a green run does not conclude the merge was exercised.
    assert.equal(carried.length, 0, 'an element grew tensions; delete this branch, the test is live now');
  } else {
    const prompt = findObservation(artistLayers(c), c.field);
    for (const t of carried as { between: string; and: string; claim: string }[]) {
      assert.ok(prompt.includes(t.claim), `a tension the artist inherited never reaches the prompt: ${t.claim}`);
    }
  }
});

/**
 * The other half, and the reason this change is not a version bump. `artistLayers` hands over
 * `effective` rather than the document on disk, and `effective` is the document plus the condition's
 * hard constraints plus any element. With no element and a condition that fixes nothing — which is
 * every condition in the catalogue today — those are the same object, so every prompt is unchanged
 * byte for byte and `observationHash` did not have to move.
 *
 * If a condition ever does fix a constraint materially this test starts failing, and that failure is
 * correct: it means the artist has begun to see something it did not see before, and the runs
 * collected before that are a different experiment.
 */
test('an element-free commission is shown byte-for-byte what it was shown before', () => {
  for (const id of POSITIONS) {
    for (const b of BRIEFS) {
      const c = loadCommission(id, b);
      assert.equal(c.brief.hard_constraints.length, 0, `${b} now fixes constraints; see the note above`);
      const asWritten = { ...artistLayers(c), position: c.positionAsWritten };
      assert.equal(
        findObservation(artistLayers(c), c.field),
        findObservation(asWritten, c.field),
        `${id}+${b}: the prompt moved for a commission that adopted nothing`
      );
    }
  }
});

test('the layer files are files; nothing generates them', () => {
  // A layer produced by a model is a layer whose hash means nothing, so the documents have to be on
  // disk and parseable without running anything.
  for (const [dir, list] of [['positions', POSITIONS], ['briefs', BRIEFS]] as const) {
    for (const id of list) {
      const raw = readFileSync(path.join(ROOT, 'aesthetic', dir, `${id}.json`), 'utf8');
      assert.equal((JSON.parse(raw) as { id: string }).id, id, `${dir}/${id}.json declares a different id`);
    }
  }
});
