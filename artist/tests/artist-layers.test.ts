// The five-layer stack, asserted where it would otherwise decay silently.
//
// The arrangement only measures anything if each layer answers exactly one question. L1 varies with
// the artist and never with the job; L2 varies with the job and never with the artist; L3 varies
// with the kind of object and nothing else; L4 varies with nothing. A layer that answers two of
// those has not broken anything visible — the run still completes and still scores — it has quietly
// supplied the derivation the run exists to watch the artist perform. Nothing but a test notices.
//
// So: the documents are checked for completeness, the brief is checked for aesthetic direction, the
// practice is checked for knowing what kind of object it is making, and the assembly order is
// checked in every phase that assembles it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../env/browser.js';
import {
  aestheticDirection,
  deliverableFacts,
  listDeliverables,
  loadBrief,
  loadCommission,
  loadDeliverable,
  namesDeliverable,
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
const DELIVERABLES = ids('deliverables');

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
 * The rule the whole arrangement rests on, checked through the same function the studio refuses a
 * save with. `deliverableFacts` carries the argument; this asserts the catalog on disk obeys it.
 *
 * Sharing the function is the point. The rule lived in this file alone once, which meant the studio
 * would happily write the next position with the defect in it and nothing would say so until a test
 * run long afterwards — by which time the file is on disk and every run against it is confounded.
 */
test('L1 holds no facts about L3: no position names a deliverable outside its lineage', () => {
  for (const id of POSITIONS) {
    assert.deepEqual(
      deliverableFacts(position(id)),
      [],
      `position ${id}: L1 may hold beliefs about a medium but not facts about one`
    );
  }
});

/** The predicate has to fail on something, or it is asserting that a regex found nothing. */
test('L1 holds no facts about L3: and the check would catch one', () => {
  const clean = position(POSITIONS[0]!);
  assert.deepEqual(deliverableFacts(clean), []);
  assert.deepEqual(deliverableFacts({ ...clean, worldview: 'A poster is read at fifteen feet.' }), [
    'it names the deliverable "poster"',
  ]);
  // Cited rather than asserted: the same sentence inside lineage is a reference to an object that
  // existed, and it stays legal.
  assert.deepEqual(
    deliverableFacts({ ...clean, lineage: [{ ref: 'A poster, 1977', why: 'a poster that existed' }] }),
    []
  );
});

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
    const c = loadCommission(id, BRIEFS[0]!, DELIVERABLES[0]!);
    const prompt = findObservation(c, c.field);

    assert.ok(!prompt.includes(c.position.name), `${id}: the prompt names the position "${c.position.name}"`);
    for (const l of c.position.lineage) {
      assert.ok(!prompt.includes(l.ref), `${id}: the prompt cites lineage "${l.ref}"`);
      assert.ok(!prompt.includes(l.why), `${id}: the prompt carries the lineage note for "${l.ref}"`);
    }
    // The lineage still has to exist to have been excluded — otherwise this passes vacuously the day
    // someone empties the field.
    assert.ok(c.position.lineage.length > 0, `${id}: no lineage, so this test proved nothing`);
  }
});

test('L3 names no position, and the practice itself stays clean', () => {
  const OBJECT_WORDS = [...DELIVERABLES, 'poster', 'flyer', 'handbill', 'placard', 'leaflet', 'sticker'];
  for (const id of POSITIONS) {
    const practice = practiceOf(position(id));
    const text = [practice.origin, practice.doing, practice.period, practice.register, ...practice.refusals]
      .join(' ')
      .toLowerCase();
    for (const word of OBJECT_WORDS) {
      assert.ok(!new RegExp(`\\b${word}s?\\b`).test(text), `position ${id} practice names the deliverable: "${word}"`);
    }
  }
  for (const id of DELIVERABLES) {
    const d = loadDeliverable(id);
    const text = JSON.stringify(d).toLowerCase();
    for (const p of POSITIONS) {
      assert.ok(!text.includes(p), `deliverable ${id} names position ${p}`);
      assert.ok(!text.includes(position(p).name.toLowerCase()), `deliverable ${id} names position ${position(p).name}`);
    }
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
 * L2 used to be allowed exactly one kind of object on the grounds that the client knows what it
 * ordered. There is no client now, and the kind of object is the third axis, chosen when the run is
 * launched: the same condition is meant to be workable as any of them. One that names an object is
 * wrong in most of the cells it appears in, and it hands the artist a fact L3 may contradict.
 *
 * Scoped to the condition and not to its `.field.json`. The field describes the world this lands in,
 * and the world contains other people's objects: "still on half the flyers in the shop" is a true
 * statement about a visual environment, not a claim about what is being made.
 */
test('L2: no condition says what kind of object it is', () => {
  for (const id of BRIEFS) {
    assert.deepEqual(namesDeliverable(loadBrief(id)), [], `condition ${id} decides an axis that is not its to decide`);
  }
  // And the check would catch one: this is the shape every one of them had before the axis was split.
  const told = { ...loadBrief(BRIEFS[0]!), atStake: 'the poster is asking for that' };
  assert.deepEqual(namesDeliverable(told), ['it calls the work a "poster"']);
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

// --- L3: the deliverable -------------------------------------------------------------------------

test('L3: every deliverable says what the object has to do and what it does not decide', () => {
  const all = listDeliverables();
  assert.equal(all.length, DELIVERABLES.length);
  for (const d of all) {
    assert.ok(d.name.length > 0, `${d.id} has no name`);
    assert.ok(d.function.length > 60, `${d.id}: function is too short to be a function`);
    assert.ok(d.consequences.length >= 3, `${d.id}: ${d.consequences.length} consequences; physics has more`);
    assert.ok(d.doesNotDecide.length > 40, `${d.id}: doesNotDecide is the line that keeps L3 out of L1's job`);
  }
});

// --- L4 and the assembly -------------------------------------------------------------------------

test('L4: the protocol hashes, so an edit to it is a version bump', () => {
  assert.match(PROTOCOL_HASH, /^[0-9a-f]{16,64}$/);
});

/**
 * Context assembly order: L4, then L1, then L3, then L2. Every artist-side phase goes through
 * `stack`, so this is really a test that no phase assembles the four itself — but it is asserted per
 * phase rather than on `stack` alone, because the failure mode is a new phase that does.
 */
test('assembly order is L4 then L1 then L3 then L2, in every phase that assembles it', () => {
  const c = loadCommission(POSITIONS[0]!, BRIEFS[0]!, DELIVERABLES[0]!);
  const report: CheckReport = {
    aesthetic: c.position.id,
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
    position: c.position,
    practice: c.practice,
    deliverable: c.deliverable,
    brief: c.brief,
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
    find: findObservation(c, c.field),
    choose: chooseObservation(c, [], 'none'),
    make: makeObservation(make),
    examine: examineObservation(c, intention, report, 'd', null),
  };
  const markers = ['HOW YOU WORK', 'YOUR PRACTICE', `THE OBJECT: ${c.deliverable.name.toUpperCase()}`, `THE CONDITION: ${c.brief.title}`];
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

test('the four layer files are four files; nothing generates them', () => {
  // A layer produced by a model is a layer whose hash means nothing, so the documents have to be on
  // disk and parseable without running anything.
  for (const [dir, list] of [['positions', POSITIONS], ['briefs', BRIEFS], ['deliverables', DELIVERABLES]] as const) {
    for (const id of list) {
      const raw = readFileSync(path.join(ROOT, 'aesthetic', dir, `${id}.json`), 'utf8');
      assert.equal((JSON.parse(raw) as { id: string }).id, id, `${dir}/${id}.json declares a different id`);
    }
  }
});
