// A policy and an environment model that are not models.
//
// Both are deterministic and free, and between them they let the whole loop run — FIND through
// EXAMINE, real renders, real checks, real edits through the real validator — with no API key and no
// network. That is worth more than it sounds: it means replay, recompute and the blindness assertions
// are tested against the actual driver rather than against a mock of it.
//
// The stub deliberately produces *legal but unremarkable* work. It is not trying to make a good
// poster. It is trying to exercise every branch the driver has: an edit that lands, an edit that is
// refused, a risk move, a destruction, a replan and a finish.

import { setEnvModel, type EnvRequest, type EnvResponse } from '../env-model.js';
import type { Policy, PolicyRequest, PolicyResponse } from '../policy/interface.js';

export interface StubCall {
  name: string;
  observationHash: string;
}

/**
 * The three strings `two-million-slips` requires. They used to be two of the three plus a fourth,
 * which was fine when finishing was an assertion: the third constraint was violated, the trajectory
 * said `declared-finished` anyway, and nothing noticed. The finish gate notices, so the stub now has
 * to actually do the job it was given before it is allowed to stop — which is the point.
 */
const TEXTS = ['1961', '2.1 MILLION', '14 JANUARY'];

/**
 * 48 on the 700-unit seed canvas is 0.069 of the height, clear of withheld's `p-no-caption` floor
 * of 0.05. It was 34, which is 0.0486 — under the floor by a unit and a half, and the whole loop
 * test failed the day the caption ban landed. The size is scaffolding and has never carried a
 * claim; the margin above the floor does, so do not shave it back.
 */
function textNode(id: string, y: number, text: string): Record<string, unknown> {
  return {
    id,
    type: 'op',
    op: 'text',
    rngKey: id,
    args: { x: 40, y, size: 48, text, font: 'special-elite', color: 'ink', align: 'left' },
  };
}

/**
 * Ink, and short of the right margin. Both on purpose: a rule spanning the sheet is vertically
 * symmetric and a second colour is a claim this stub is not making. The stub is meant to exercise
 * the driver, not the revert path twice over.
 */
function ruleNode(id: string, y: number): Record<string, unknown> {
  return {
    id,
    type: 'op',
    op: 'rule',
    rngKey: id,
    args: { from: [40, y], to: [300, y], weight: 6, brush: 'marker', color: 'ink' },
  };
}

/**
 * Answers every decision the driver can ask for, in the schema it asks for. The `act` answers walk a
 * fixed script, so a stubbed trajectory has the same shape every time and the tests can assert on it.
 */
export class StubPolicy implements Policy {
  readonly kind = 'stub';
  readonly model = 'stub';
  readonly calls: string[] = [];
  private acts = 0;

  constructor(private readonly steps = 4) {}

  async call<T>(request: PolicyRequest): Promise<PolicyResponse<T>> {
    this.calls.push(request.name);
    const action = this.answer(request);
    return {
      action: action as T,
      raw: JSON.stringify(action),
      usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
      attempts: 1,
      failures: [],
      model: this.model,
    };
  }

  private intention(): unknown {
    return {
      purpose: 'Put the two dates and the building where a passer-by cannot avoid reading them.',
      tension: { between: 'legibility', and: 'refusal', claim: 'the poster must be readable to be refused' },
      elements: [
        { id: 'dates', role: 'the two dates, stacked', nodeIds: [] },
        { id: 'bar', role: 'a rule that separates the dates from the place', nodeIds: [] },
      ],
      edges: [
        { from: 'dates', to: 'bar', type: 'aligned-to', claim: 'both start at the same left margin' },
        { from: 'bar', to: 'dates', type: 'contradicts', claim: 'the bar interrupts the reading' },
      ],
      riskMove: { convention: 'a poster leads with an image', why: 'this one leads with a date and may be ignored' },
    };
  }

  private answer(request: PolicyRequest): unknown {
    if (request.name === 'find') {
      return {
        questions: [
          {
            question: 'Is the meeting open to people who are not tenants of the block?',
            whyItChangesTheObject: 'If it is closed, the sheet is a summons to fifty people; if it is open it is an appeal to a street.',
            decidingInstead: 'Treating it as open, because a poster on a wall cannot check who reads it.',
          },
        ],
        problems: [
          {
            id: 'p-legibility',
            text: 'The reader has decided this is not for them before any word is read, so legibility is not the problem.',
            tension: { between: 'urgency', and: 'suspicion', claim: 'urgency reads as advertising' },
            fieldRefs: ['the field says the audience is busy and did not ask to see it'],
          },
          {
            id: 'p-date',
            text: 'A date is the only part of this that anyone can act on, and a date is the least interesting thing to draw.',
            tension: { between: 'information', and: 'form', claim: 'the actionable part is the dull part' },
            fieldRefs: ['a date he can put in a diary would stop him'],
          },
          {
            id: 'p-exhausted',
            text: 'Every image this subject suggests has already been used until it stopped meaning anything at all.',
            tension: { between: 'recognition', and: 'exhaustion', claim: 'recognisable is used up' },
            fieldRefs: ['what is exhausted'],
          },
        ],
      };
    }

    if (request.name === 'sketch') {
      return {
        approach: 'One date, set large, with nothing else on the sheet at all.',
        edits: [{ actionId: 'sk1', kind: 'add_node', targets: ['sheet'], parent: 'sheet', node: textNode('sk-date', 120, TEXTS[2]!) }],
      };
    }

    if (request.name === 'choose') {
      return {
        collision: {
          requirement: 'the two dates have to be readable from across a road',
          principle: 'one identifiable person talking, unedited',
          statement: 'A sheet legible at ten metres cannot also be somebody at length, and the commission needs both.',
        },
        problemId: 'p-date',
        why: 'The sketches show that a date alone holds the sheet, and the other two are pictures of a mood.',
        cost: 'They give up the account of what happened to the people in the block; what is left is an instruction.',
        terms: {
          outOfScope: ['anything for a screen', 'a second version with the logo larger'],
          willNotChange: ['the two dates stay the largest thing on the sheet'],
          wouldLoseTheCommissionOver: 'Putting a photograph of a tenant on it without their name and their say-so.',
        },
        intention: this.intention(),
      };
    }

    if (request.name === 'replan') {
      return { why: 'The describer read the rule as the subject, not as a separator.', intention: this.intention() };
    }

    if (request.name === 'examine') {
      return {
        selfScore: 5,
        edgeEstimates: [
          { from: 'dates', to: 'bar', type: 'aligned-to', status: 'satisfied', evidence: 'both sit on the same left margin' },
          { from: 'bar', to: 'dates', type: 'contradicts', status: 'judge-pending', evidence: 'nobody could tell from looking' },
        ],
        paragraph:
          'It puts the dates where they cannot be missed and does nothing else, which is both what it is for and its ' +
          'whole failure: there is no reason to look at it twice, and the risk of leading with a date rather than an ' +
          'image was probably not worth taking here.',
      };
    }

    // act
    const k = this.acts++;
    if (k >= this.steps) {
      return { think: 'The dates and the place are all on the sheet and legible. Nothing more is needed.', control: 'finished', risk: null, unrealizable: null, edits: [] };
    }
    if (k === 0) {
      return {
        think: 'Put the first date down at the top left, large, before anything else competes with it.',
        control: 'continue',
        risk: null,
        unrealizable: null,
        edits: [
          { actionId: 'a0', kind: 'add_node', targets: ['sheet'], parent: 'sheet', servesElementId: 'dates', node: textNode('t-since', 120, TEXTS[0]!) },
          // Deliberately illegal: no such parent. Exercises the refusal path and the invalid-edit count.
          { actionId: 'a0-bad', kind: 'add_node', targets: ['nowhere'], parent: 'nowhere', node: textNode('t-lost', 200, 'X') },
        ],
      };
    }
    if (k === 1) {
      return {
        think: 'The second date, directly under the first, on the same margin so they read as one block.',
        control: 'continue',
        risk: 'leading with a date rather than an image, which this genre would not do',
        unrealizable: null,
        edits: [
          { actionId: 'a1', kind: 'add_node', targets: ['sheet'], parent: 'sheet', servesElementId: 'dates', node: textNode('t-extent', 180, TEXTS[1]!) },
          { actionId: 'a1b', kind: 'add_node', targets: ['sheet'], parent: 'sheet', servesElementId: 'bar', node: ruleNode('r-bar', 120) },
        ],
      };
    }
    return {
      think: 'The building has to be named, or this is a poster about gentrification in general.',
      control: 'continue',
      risk: null,
      unrealizable: null,
      edits: [
        { actionId: `a${k}`, kind: 'add_node', targets: ['sheet'], parent: 'sheet', servesElementId: 'dates', node: textNode(`t-date-${k}`, 260 + 40 * k, TEXTS[2]!) },
      ],
    };
  }
}

/**
 * A describer that is not a model. Installed with setEnvModel, so it also bypasses the disk cache —
 * which is what makes the stubbed tests independent of whatever a real run left behind.
 */
export function installStubEnvModel(): { requests: EnvRequest[]; restore: () => void } {
  const requests: EnvRequest[] = [];
  setEnvModel(async <T>(request: EnvRequest): Promise<EnvResponse<T>> => {
    requests.push(request);
    const value =
      request.name === 'describe'
        ? { description: 'A pale sheet. Dark text sits at the upper left. A red bar crosses it. The rest is empty. The eye goes to the text.' }
        : request.name === 'transcribe'
          ? // Stands in for a reader who can make out everything the stub policy wrote. A stub that
            // returned less would block the gate on every run and there would be no accept path
            // under test; the refusal path is tested against `finishBlockers` directly.
            { strings: TEXTS.map((text) => ({ text, legible: true })) }
          : request.name === 'audience'
            ? { read: 'It looks like a notice about a date. I would read the date and keep walking.', wouldAct: 'consider' }
            : { agree: true, reason: 'the report names the same marks in the same places' };
    return { value: value as T, cached: true, inputTokens: 0, outputTokens: 0, usd: 0, cacheKey: 'stub' };
  });
  return { requests, restore: () => setEnvModel(null) };
}
