// The discovery half, wired into the driver and run end to end.
//
// Two runs of the same cell on the same seed, one with `discovery` off and one with it on. The
// off run is the contract the whole layer rests on: no second file, no research, no material block
// in FIND's observation, no `workRefs` in FIND's schema, and the same phases in the same order the
// driver has always made them in. If that ever stops being true, every golden and every replay in
// the repo is silently measuring a different environment, and it will not announce itself.
//
// The on run is the brief's "one brief, one artist, one run": research, widening, a dozen sketches
// a lens, pairwise judgments, a commitment the choice is answerable to, a made piece with a hash,
// and a practice version that has a parent. It is stubbed — the point is that the wiring holds and
// that discovery lands in the unchained file, not that any of the prose is good.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTrajectory } from '../run.js';
import { readDiscovery } from '../discovery-log.js';
import { readLog } from '../studio-log.js';
import { latestVersion } from '../practice-version.js';
import { StubPolicy, installStubEnvModel } from './artist-stub.js';
import type { PolicyRequest, PolicyResponse } from '../policy/interface.js';

const LENSES = 3;

/**
 * The shared stub plus the six discovery calls it has never been asked for.
 *
 * A subclass rather than six more branches inside `StubPolicy`, because the shared stub is the
 * fixture forty other tests are written against and widening it to answer calls only one path makes
 * would put this test's assumptions inside all of them.
 */
class WiredStub extends StubPolicy {
  private pairwise = 0;

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    const action = this.discoveryAnswer(request);
    if (action === null) return super.call<T>(request);
    // Recorded through the same two arrays the parent keeps, so a test can assert on the whole
    // call order across both halves of the run.
    this.calls.push(request.name);
    this.requests.push(request);
    return {
      action: action as T,
      raw: JSON.stringify(action),
      usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      attempts: 1,
      failures: [],
      model: this.model,
    };
  }

  private discoveryAnswer(request: PolicyRequest): unknown {
    if (request.name === 'research-queries' || request.name === 'research-followup') {
      return {
        queries: [
          { looking_for: 'sheets that were ruled before anything was written on them', classification: 'Drawings' },
          { looking_for: 'anything where a margin outlives its text', medium: 'ink' },
        ],
      };
    }

    if (request.name === 'research-sheet') {
      // No citations. A stub cannot know a real accession number, and inventing one would make this
      // test assert that fabricated provenance survives the pipeline — which it does, reported, and
      // that is `coverage`'s business and is tested there.
      return {
        materials: [
          {
            id: 'm1',
            material: 'A rule drawn the full width of the sheet before any text was placed on it.',
            borrowing: 'The sheet commits to a shape before it commits to a content.',
            works: [],
          },
          {
            id: 'm2',
            material: 'An initial that ignores the column it sits in and runs past its own line.',
            borrowing: 'One element is allowed to be out of scale with the system it is inside.',
            works: [],
          },
        ],
      };
    }

    if (request.name === 'diverge-propose') {
      return {
        lenses: Array.from({ length: LENSES }, (_, i) => ({
          id: `l${i + 1}`,
          problem: i === 0 ? 'p-date' : 'p-legibility',
          source: 'm1',
          sourceClaim: `Only of the source, number ${i + 1}: a ruled sheet has a shape before it has words.`,
          lens: `Read the problem as a sheet that was ruled before anyone knew what would go on it, ${i + 1}.`,
          emergent: `Neither input has this on its own, ${i + 1}: the date becomes a thing the sheet was waiting for.`,
        })),
      };
    }

    if (request.name === 'diverge-cut') {
      // Most cut, with reasons — the shape the brief asks for, in miniature. Two survive rather
      // than one because a single survivor drawn once is a single card, and a single card has
      // nothing to be compared against: COMPARE would correctly ask no pairwise question at all.
      return {
        keep: ['l1', 'l2'],
        cut: [{ id: 'l3', reason: 'the emergent claim is really just "both involve waiting"' }],
      };
    }

    if (request.name === 'wide-sketch') {
      return {
        approach: 'One date on a sheet that was ruled first, so the rule is older than the date.',
        logic: 'The rule reads as a thing that was there before the text, which is what m1 contributes.',
        borrowings: [{ sourceId: 'm1', contributes: 'the rule that predates the text' }],
        edits: [
          {
            actionId: 'w1',
            kind: 'add_node',
            targets: ['sheet'],
            parent: 'sheet',
            node: { id: `w-rule-${this.requests.length}`, type: 'rule', x: 40, y: 120, w: 300, h: 2 },
          },
        ],
      };
    }

    if (request.name === 'compare-pairwise') {
      // Alternates, so no card sweeps the round and the ranking has something in it to order.
      return { winner: this.pairwise++ % 2 === 0 ? 'A' : 'B', why: 'it says more with the rule than the other does' };
    }

    if (request.name === 'compare-commit') {
      return {
        survivors: ['p-date#s1'],
        why: 'The ruled sheet holds; the rest are the same picture with the rule moved.',
        series: false,
      };
    }

    if (request.name === 'compare-account') {
      return { whyTheSketchesChangedMyMind: 'The sketches showed the date does the work, not the legibility problem.' };
    }

    if (request.name === 'update-practice') {
      return {
        changed:
          'What changed is that the rule stopped being a separator and became the older thing on the sheet. ' +
          'That came out of looking at ruled manuscripts, and it is the first time this practice has had a ' +
          'reason to draw a line before it knows what the line is dividing.',
      };
    }

    return null;
  }
}

/** The per-problem properties of whatever schema object FIND actually sent. */
function problemProperties(schema: object): Record<string, unknown> {
  const dig = (o: unknown, key: string): Record<string, unknown> =>
    (o as Record<string, Record<string, unknown>>)[key]!;
  return dig(dig(dig(dig(schema, 'properties'), 'problems'), 'items'), 'properties');
}

function runIn(name: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `${name}-`)), 'cell');
}

test('discovery off writes no second record and shows FIND nothing it did not show before', async () => {
  const { restore } = installStubEnvModel();
  try {
    const policy = new StubPolicy(3);
    const outDir = runIn('unflagged');
    await runTrajectory({
      policy,
      positionId: 'withheld',
      briefId: 'two-million-slips',
      seed: 77,
      outDir,
      maxSteps: 3,
      sketchesPerProblem: 1,
      useAudience: false,
    });

    assert.equal(existsSync(path.join(outDir, 'discovery.jsonl')), false, 'no discovery record was opened');
    assert.deepEqual(
      policy.calls.filter((c) => c.startsWith('research') || c.startsWith('diverge') || c.startsWith('compare')),
      [],
      'not one discovery call was made'
    );
    assert.equal(policy.calls.includes('update-practice'), false, 'and no practice version was written');

    const find = policy.requests.find((r) => r.name === 'find')!;
    assert.doesNotMatch(find.observation, /WHAT YOU FOUND WHEN YOU WENT LOOKING/, 'no material block');
    assert.equal('workRefs' in problemProperties(find.schema), false, 'and the schema is the one FIND has always sent');
  } finally {
    restore();
  }
});

test('discovery on runs the whole loop and keeps every proposal out of the chain', async () => {
  const { restore } = installStubEnvModel();
  const practiceStore = mkdtempSync(path.join(tmpdir(), 'practice-'));
  try {
    const policy = new WiredStub(3);
    const outDir = runIn('flagged');
    const trajectory = await runTrajectory({
      policy,
      positionId: 'withheld',
      briefId: 'two-million-slips',
      seed: 77,
      outDir,
      maxSteps: 3,
      // Read as the per-lens count on this arm. One apiece keeps the test to a handful of renders.
      sketchesPerProblem: 1,
      useAudience: false,
      discovery: true,
      practiceStore,
    });

    // The phases ran, in the brief's order.
    const order = policy.calls.filter((c) => c !== 'act' && c !== 'replan');
    assert.deepEqual(
      order.slice(0, order.indexOf('choose') + 1).filter((c) => c !== 'wide-sketch' && c !== 'compare-pairwise'),
      ['research-queries', 'research-followup', 'research-sheet', 'find', 'diverge-propose', 'diverge-cut', 'compare-commit', 'choose'],
      `the order was: ${policy.calls.join(', ')}`
    );
    assert.ok(policy.calls.includes('wide-sketch'), 'sketches were drawn against the kept lenses');
    assert.ok(policy.calls.includes('compare-pairwise'), 'and compared in pairs');

    // FIND was researched: it got the block and the extra optional field.
    const find = policy.requests.find((r) => r.name === 'find')!;
    assert.match(find.observation, /WHAT YOU FOUND WHEN YOU WENT LOOKING/);
    assert.ok('workRefs' in problemProperties(find.schema), 'a problem may now be read out of a work');

    // The two records, and which lines are in which. This is the two-modes contract as an assertion:
    // every lens, every pairwise judgment and every discovery model call is in the unchained file,
    // and none of it is in the one `replay` walks.
    const discovery = readDiscovery(path.join(outDir, 'discovery.jsonl'));
    const kinds = new Set(discovery.map((l) => l.kind));
    for (const kind of ['material-sheet', 'lens-proposed', 'lens-cut', 'sketch', 'pairwise']) {
      assert.ok(kinds.has(kind as never), `discovery.jsonl is missing ${kind}`);
    }
    assert.equal(
      discovery.some((l) => 'hash' in (l as unknown as Record<string, unknown>)),
      false,
      'and not one discovery line carries a chain field'
    );

    const chain = readLog(path.join(outDir, 'studio.jsonl'));
    const chained = chain.filter((l) => l.kind === 'policy-call').map((l) => (l.data as { name: string }).name);
    assert.deepEqual(
      chained.filter((n) => n.startsWith('diverge') || n.startsWith('compare') || n.startsWith('research') || n === 'wide-sketch'),
      [],
      `a discovery call reached the chain: ${chained.join(', ')}`
    );
    assert.ok(chained.includes('choose') && chained.includes('examine') && chained.includes('update-practice'));
    // UPDATE PRACTICE is last, because `replay` walks calls in order and one inserted in the middle
    // would shift the cursor for every call after it.
    assert.equal(chained[chained.length - 1], 'update-practice');

    // CHOOSE was handed the problems COMPARE committed to and no others.
    const choose = policy.requests.find((r) => r.name === 'choose')!;
    assert.match(choose.observation, /p-date/);
    assert.doesNotMatch(choose.observation, /p-exhausted/, 'a problem the artist argued its way off is not on offer');

    // A promoted work with a hash, and a practice version with a place to grow a parent.
    assert.ok(trajectory.finalHash.length > 0);
    assert.equal(existsSync(path.join(outDir, 'final.png')), true);
    const version = latestVersion('withheld', practiceStore)!;
    assert.equal(version.version, 1);
    assert.equal(version.parent, null, 'the first version has no parent');
    assert.equal(version.trajectoryId, trajectory.id, 'and it names the run that produced it');
    assert.ok(version.rejected.length >= 1, 'the lens that was cut is in it, with its reason');

    // The counts the chain keeps about a half of the run it deliberately does not hold.
    const notes = chain.filter((l) => l.kind === 'note').map((l) => l.data as Record<string, unknown>);
    const diverged = notes.find((n) => n['phase'] === 'diverge')!;
    assert.equal(diverged['proposed'], LENSES);
    assert.equal(diverged['kept'], 2);
    assert.equal(diverged['cut'], LENSES - 2);
    assert.ok(notes.some((n) => n['phase'] === 'compare' && Array.isArray(n['survivors'])));
  } finally {
    restore();
  }
});

test('a second discovery run on the same position writes a version with a parent', async () => {
  const { restore } = installStubEnvModel();
  const practiceStore = mkdtempSync(path.join(tmpdir(), 'practice-'));
  try {
    for (const seed of [11, 12]) {
      await runTrajectory({
        policy: new WiredStub(2),
        positionId: 'withheld',
        briefId: 'two-million-slips',
        seed,
        outDir: runIn(`series-${seed}`),
        maxSteps: 2,
        sketchesPerProblem: 1,
        useAudience: false,
        discovery: true,
        practiceStore,
      });
    }
    const second = latestVersion('withheld', practiceStore)!;
    assert.equal(second.version, 2);
    assert.ok(second.parent, 'the second version points back at the first');
    // The previous version is still on disk and still passes its own hash check, which is what
    // "the previous version stays reproducible" means operationally.
    const file = path.join(practiceStore, 'withheld', '001.json');
    assert.equal(existsSync(file), true);
    const first = JSON.parse(readFileSync(file, 'utf8')) as { hash: string };
    assert.equal(second.parent, first.hash);
  } finally {
    restore();
  }
});
