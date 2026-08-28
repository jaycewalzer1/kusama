// L5: the three critics, offline and in a fresh context.
//
// Nothing else in this repo judges. `check.ts` decides compliance mechanically and `reward.ts`
// counts what the loop did; neither has an opinion about whether the thing is any good, and
// `docs/artist/NEEDS.md` records the cost of that as plainly as it can be put: without this file the
// ablation grid has no dependent variable. Separation between two arms could be proven. Improvement
// could not.
//
// Three dimensions and no more. The other two that were proposed — "does it obey the stated formal
// rules" and "does it violate a stated refusal" — are struck permanently, because `check.ts` already
// decides both on the tree and on the render without a model. Routing them through here would
// launder a deterministic check into a subjective score and then report the agreement between the
// judge and the checker as a finding.
//
//   attribution   forced choice over the catalog. Which practice made this? Chance is 1/n.
//   necessity     could this have been otherwise at no cost? Consumes the position's own rubrics.
//   derivation    does the work derive from the practice or quote it? Consumes the cliche list.
//
// Four rules hold this honest and each one is load-bearing:
//
//   fresh      the judge shares no state with the run. Its own model constant, its own cache
//              directory, its own door to the network. It never reaches `envModel` — a guard test
//              pins the environment's callers to two files — and it never reaches the policy, so
//              nothing here can be trained against.
//   blind      the attribution critic is never told which position it is looking at, and the
//              candidates are shuffled per work. A critic handed the answer returns the answer.
//   pending    necessity and derivation consume `pendingRubrics` rather than inventing questions.
//              The rubrics were written by whoever wrote the position, which is a circularity this
//              cannot escape; what it can do is not add a second one on top.
//   frozen     one model id, temperature 0, prompts hashed into every judgment. A judge that
//              improves next quarter makes every score taken before it incomparable with every
//              score taken after, exactly as the environment model would.
//
// What this still does not fix: the judge and the position were written in the same repo by the same
// kind of author, so agreement between them is weak evidence. `attribution` is the one dimension
// that escapes it, because it has a baseline a coin could beat and a control arm that predicts
// chance.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../env/browser.js';
import { canonicalJson } from '../env/profile.js';
import { checkProgram } from '../aesthetic/check.js';
import { loadPosition, practiceOf, type Practice } from './field.js';
import { schemaErrors } from './policy/schema-check.js';
import { usd } from './pricing.js';
import type { Trajectory } from './types.js';

/**
 * Frozen. Changing either is a new judge version, not a tweak — `judgeVersion()` hashes both, so
 * judgments recorded under different values never join.
 *
 * Repointed from `claude-opus-4-6` on 2026-08-28: the Anthropic account has no credit, so the
 * choice is between an OpenAI judge and no judge. Two constraints survive the move and one does not.
 * `temperature: 0` survives, and it is the binding one — a judgment that changes when you rescore is
 * not a measurement — which rules out `gpt-5` and `o3` entirely, since both accept only their
 * default temperature of 1. What does not survive is "the judge is the strongest model available":
 * the artist runs on `gpt-5` and the judge does not. That is the conservative direction for the one
 * critic with a baseline — a weaker attributor pushes accuracy toward chance, so it can fail to find
 * signal but cannot manufacture it — and it is a real limit on the other two, which have no baseline
 * and are therefore only as good as the reader.
 *
 * It is deliberately a different model from the environment's describer, which a guard test checks
 * by reading both files. The judge already shares no door and no cache with the environment;
 * sharing its eyes would undo most of what that isolation buys.
 */
export const JUDGE_MODEL = 'gpt-4.1-2025-04-14';
export const JUDGE_TEMPERATURE = 0;

const CACHE_DIR = path.join(ROOT, '.cache', 'artist-judge');

// The three system prompts. Hashed into every judgment; edit one and old scores stop joining to new
// ones, which is the intended consequence and not an inconvenience.

const ATTRIBUTION_SYSTEM = `You are shown one work and several accounts of artistic practices. Exactly one of those practices made the work; the others made different works you are not being shown.

Say which. You are not being asked whether the work is good, and you are not being asked which practice you like. You are being asked which one this came out of.

Read the evidence off the sheet. What is actually there — what kind of mark, what is covered and what is not, where the weight sits, what the edges do, what was clearly decided and what was clearly allowed — and match that against what each practice says it does and what it says it refuses. A practice's refusals are the most useful part: a work from a practice does not do the things that practice will not do.

If two candidates fit equally, pick the one whose refusals the work honours more completely, and say in your reasoning that you were choosing between them.`;

const NECESSITY_SYSTEM = `You are shown one work, the account of the practice that made it, and a specific question that practice asks of its own results.

Answer the question about this work, then rate necessity from 1 to 7.

Necessity is the question of whether the decisions in the work had to be those decisions. A necessary work is one where the parts constrain each other: move any of them and something else stops working. An unnecessary work is one where the parts are merely permitted — nothing about any of them requires any of the others, and each could slide, resize or change colour without consequence.

The scale, and use the whole of it:
1  arbitrary. Nothing here constrains anything else. Every element could be elsewhere.
4  mixed. Some relationships are load-bearing and some elements are furniture.
7  every element is doing work no other element could do.

Do not reward difficulty, density or effort. A sparse work can be entirely necessary and a crowded one entirely arbitrary. Do not reward the work for matching the practice's description — that is a different question and it is being asked elsewhere. You are looking only at whether the thing in front of you holds together under its own weight.

Name the single most necessary thing present and what it carries. Name the single most arbitrary. Both must be things visible in the work, not intentions.`;

const DERIVATION_SYSTEM = `You are shown one work, the account of the practice that made it, and the list of cliches that practice has named as the obvious moves it must not take.

Decide one thing: does this work DERIVE from the practice or QUOTE it?

A work derives when it reasons from what the practice is doing and arrives somewhere the practice did not already specify. The practice's method is visible in the result; the result is not a picture of the practice.

A work quotes when it reproduces the practice's recognisable outputs — its motifs, its signature moves, the look somebody would name if asked to describe the practice in one sentence. Quotation can be highly competent. It is still quotation.

The cliche list is the sharpest test available. A work that lands on a named cliche is quoting, whatever else it is doing, because the practice named that move in advance precisely so that taking it would mean nothing. Name every cliche you can see the work taking. Name none if it takes none — an empty list is an answer and the commonest mistake here is finding one because you were asked.

Then say what the work does that the practice's description does not already contain. If you cannot name anything, that is quotation and you should say so.`;

const SYSTEMS = {
  attribution: ATTRIBUTION_SYSTEM,
  necessity: NECESSITY_SYSTEM,
  derivation: DERIVATION_SYSTEM,
} as const;

/**
 * One hash over the model, the temperature and all three prompts. On every judgment, for the same
 * reason `envVersion` is on every trajectory: two numbers produced under different questions are not
 * two measurements of one thing, and the only way to stop them being averaged is to make them refuse
 * to join.
 */
export function judgeVersion(): string {
  return createHash('sha256')
    .update(canonicalJson({ model: JUDGE_MODEL, temperature: JUDGE_TEMPERATURE, systems: SYSTEMS }))
    .digest('hex')
    .slice(0, 12);
}

export interface Attribution {
  /** The position the judge picked. */
  chose: string;
  /** The position that actually made it. */
  actual: string;
  correct: boolean;
  /** How many practices it was choosing between. 1/candidates is the chance rate. */
  candidates: number;
  why: string;
}

export interface Necessity {
  /** 1..7. See NECESSITY_SYSTEM for what the ends mean. */
  score: number;
  mostNecessary: string;
  mostArbitrary: string;
  /** The position's own rubric ids that were put to the judge. Empty means it asked none. */
  rubricIds: string[];
  answer: string;
}

export interface Derivation {
  verdict: 'derives' | 'quotes';
  /** Cliches from the position's own list that the judge says the work took. */
  clichesTaken: string[];
  /** What the work does that the practice's description does not already contain. */
  beyond: string;
  why: string;
}

export interface Judgment {
  trajectoryId: string;
  positionId: string;
  briefId: string;
  deliverableId: string;
  /** Which arm. A control is judged exactly like a position and that is the point of judging it. */
  control: boolean;
  judgeVersion: string;
  attribution: Attribution;
  necessity: Necessity;
  derivation: Derivation;
  usd: number;
  cached: boolean;
}

interface JudgeRequest {
  name: keyof typeof SYSTEMS;
  system: string;
  text: string;
  imageBase64: string;
  schema: object;
}

interface ChatResponse {
  choices: { message: { tool_calls?: { function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

type JudgeModelFn = <T>(request: JudgeRequest) => Promise<{ value: T; cached: boolean; usd: number }>;

let override: JudgeModelFn | null = null;

/** Tests install a deterministic stand-in here. There is no env var for this, on purpose. */
export function setJudgeModel(fn: JudgeModelFn | null): void {
  override = fn;
}

/**
 * Written against the wire format with `fetch` rather than the SDK, for the reason `env-model.ts`
 * is: a frozen thing cannot depend on a package whose minor version can change how it answers, and
 * the guard test that says only `policy/anthropic.ts` imports a model SDK is worth more than the
 * convenience.
 */
async function ask<T>(request: JudgeRequest): Promise<{ value: T; cached: boolean; usd: number }> {
  if (override) return override<T>(request);

  const key = createHash('sha256')
    .update(
      canonicalJson({
        model: JUDGE_MODEL,
        temperature: JUDGE_TEMPERATURE,
        name: request.name,
        system: request.system,
        text: request.text,
        image: createHash('sha256').update(request.imageBase64).digest('hex'),
        schema: request.schema,
      })
    )
    .digest('hex');
  const file = path.join(CACHE_DIR, `${key}.json`);
  try {
    const hit = JSON.parse(readFileSync(file, 'utf8')) as { value: T };
    return { value: hit.value, cached: true, usd: 0 };
  } catch {
    // A miss is the normal path the first time and is not an error.
  }

  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set, so there is no judge');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: JUDGE_MODEL,
      max_completion_tokens: 2048,
      temperature: JUDGE_TEMPERATURE,
      messages: [
        { role: 'system', content: request.system },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${request.imageBase64}` } },
            { type: 'text', text: request.text },
          ],
        },
      ],
      tools: [{ type: 'function', function: { name: 'emit', description: 'Emit the answer.', parameters: request.schema } }],
      tool_choice: { type: 'function', function: { name: 'emit' } },
    }),
  });
  if (!res.ok) throw new Error(`the judge answered ${res.status}: ${await res.text()}`);
  const response = (await res.json()) as ChatResponse;

  const call = response.choices[0]?.message.tool_calls?.find((c) => c.function.name === 'emit');
  if (!call) throw new Error(`judge call "${request.name}" answered without calling the emit tool`);
  let value: unknown;
  try {
    value = JSON.parse(call.function.arguments);
  } catch (e) {
    throw new Error(`judge call "${request.name}" emitted arguments that are not JSON: ${(e as Error).message}`);
  }
  const errors = schemaErrors(value, request.schema);
  // No retry, for the same reason the environment does not retry: if a frozen thing cannot answer
  // its own fixed question in its own fixed shape, that is a fact about it and not a hiccup.
  if (errors.length) throw new Error(`judge call "${request.name}" broke its own schema: ${errors.join('; ')}`);

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ request: { name: request.name, text: request.text }, value }, null, 2)}\n`);

  return {
    value: value as T,
    cached: false,
    usd: usd(JUDGE_MODEL, response.usage?.prompt_tokens ?? 0, response.usage?.completion_tokens ?? 0),
  };
}

/**
 * xorshift32 keyed on the trajectory id, so the candidate order a work was judged under is
 * reproducible from the trajectory alone and is different for different works. A fixed order would
 * let a positional bias in the judge read as an attribution result.
 */
function shuffle<T>(items: T[], seedText: string): T[] {
  let s = parseInt(createHash('sha256').update(seedText).digest('hex').slice(0, 8), 16) || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function practiceText(p: Practice): string {
  return [
    `WHERE IT CAME FROM: ${p.origin}`,
    `WHAT IT IS DOING: ${p.doing}`,
    `PERIOD: ${p.period}`,
    `HOW IT SPEAKS: ${p.register}`,
    'WHAT IT REFUSES:',
    ...p.refusals.map((r) => `  - ${r}`),
  ].join('\n');
}

const ATTRIBUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['chose', 'why'],
  properties: {
    chose: { type: 'string', description: 'The letter of the practice that made this work.' },
    why: { type: 'string', description: 'The evidence on the sheet that decided it.' },
  },
};

const NECESSITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'mostNecessary', 'mostArbitrary', 'answer'],
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 7 },
    mostNecessary: { type: 'string' },
    mostArbitrary: { type: 'string' },
    answer: { type: 'string', description: 'The answer to the questions the practice asked.' },
  },
};

const DERIVATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'clichesTaken', 'beyond', 'why'],
  properties: {
    verdict: { type: 'string', enum: ['derives', 'quotes'] },
    clichesTaken: { type: 'array', items: { type: 'string' }, description: 'Verbatim entries from the list given. Empty is an answer.' },
    beyond: { type: 'string', description: 'What the work does that the practice description does not already contain.' },
    why: { type: 'string' },
  },
};

/**
 * The forced choice. Candidates are every position in the catalog, lettered after a shuffle keyed on
 * the work, and the judge is told nothing about which one is the answer — not the id, not the name,
 * not the lineage. `position.name` and `lineage` are kept out for the reason they are kept out of
 * the policy prompt: a name is a label for a look and a model handed one produces the look.
 */
async function judgeAttribution(
  png: string,
  actual: string,
  catalog: string[],
  seedText: string
): Promise<{ value: Attribution; cached: boolean; usd: number }> {
  const shuffled = shuffle(catalog, seedText);
  const letters = shuffled.map((_, i) => String.fromCharCode(65 + i));
  const blocks = shuffled.map((id, i) => `PRACTICE ${letters[i]}\n${practiceText(practiceOf(loadPosition(id)))}`);
  const text = [
    `Here is one work and ${shuffled.length} practices. One of them made it.`,
    '',
    blocks.join('\n\n'),
    '',
    `Answer with a single letter from ${letters.join(', ')}.`,
  ].join('\n');

  const r = await ask<{ chose: string; why: string }>({
    name: 'attribution',
    system: ATTRIBUTION_SYSTEM,
    text,
    imageBase64: png,
    schema: ATTRIBUTION_SCHEMA,
  });
  const index = letters.indexOf(r.value.chose.trim().toUpperCase().slice(0, 1));
  // An unreadable letter is not silently a miss. A miss and a non-answer are different facts and
  // scoring them the same would let a judge that stopped answering look like a judge that was wrong.
  if (index < 0) throw new Error(`the judge chose "${r.value.chose}", which is not one of ${letters.join(', ')}`);
  const chose = shuffled[index]!;
  return {
    value: { chose, actual, correct: chose === actual, candidates: shuffled.length, why: r.value.why },
    cached: r.cached,
    usd: r.usd,
  };
}

export interface JudgeOptions {
  /** The positions the attribution critic chooses between. Defaults to the catalog on disk. */
  catalog?: string[];
}

/**
 * Judge one trajectory directory. Reads `final.json` and `final.png` off disk and nothing else, so
 * this can be run in a fresh process, months later, against runs that are already finished.
 */
export async function judgeTrajectory(dir: string, options: JudgeOptions = {}): Promise<Judgment> {
  const trajectory = JSON.parse(readFileSync(path.join(dir, 'final.json'), 'utf8')) as Trajectory;
  const png = readFileSync(path.join(dir, 'final.png')).toString('base64');
  const position = loadPosition(trajectory.positionId);
  const practice = practiceOf(position);
  const catalog = options.catalog ?? defaultCatalog();

  const attribution = await judgeAttribution(png, trajectory.positionId, catalog, trajectory.id);

  // The rubrics the checker carried forward unread. Re-derived from the position rather than read
  // off `scores.judgePending`, which flattens them to `[id] text` and loses the id as a field; the
  // ids are how a judgment joins back to the constraint that asked for it.
  const pending = checkProgram(trajectory.finalProgram, position).pendingRubrics;

  const necessityText = [
    practiceText(practice),
    '',
    pending.length
      ? ['THE QUESTIONS THIS PRACTICE ASKS OF ITS OWN RESULTS:', ...pending.map((r) => `  [${r.id}] ${r.text}`)].join('\n')
      : 'This practice asks no specific question of its results. Answer the general one.',
  ].join('\n');

  const necessity = await ask<Omit<Necessity, 'rubricIds'>>({
    name: 'necessity',
    system: NECESSITY_SYSTEM,
    text: necessityText,
    imageBase64: png,
    schema: NECESSITY_SCHEMA,
  });

  const cliches = position.cliches ?? [];
  const derivationText = [
    practiceText(practice),
    '',
    cliches.length
      ? ['THE MOVES THIS PRACTICE HAS NAMED AS CLICHE AND WILL NOT TAKE:', ...cliches.map((c) => `  - ${c}`)].join('\n')
      : 'This practice has named no cliches, so there is no list to check against.',
  ].join('\n');

  const derivation = await ask<Derivation>({
    name: 'derivation',
    system: DERIVATION_SYSTEM,
    text: derivationText,
    imageBase64: png,
    schema: DERIVATION_SCHEMA,
  });

  return {
    trajectoryId: trajectory.id,
    positionId: trajectory.positionId,
    briefId: trajectory.briefId,
    deliverableId: trajectory.deliverableId,
    control: trajectory.control,
    judgeVersion: judgeVersion(),
    attribution: attribution.value,
    necessity: { ...necessity.value, rubricIds: pending.map((r) => r.id) },
    derivation: derivation.value,
    usd: attribution.usd + necessity.usd + derivation.usd,
    cached: attribution.cached && necessity.cached && derivation.cached,
  };
}

function defaultCatalog(): string[] {
  // Read off disk for the reason cli/artist.ts reads its ids off disk: a hardcoded list goes stale
  // the first time a position is added, and it goes stale silently — the forced choice just gets
  // easier, and every attribution rate recorded after that point is inflated.
  return readdirSync(path.join(ROOT, 'aesthetic', 'positions'))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => f.slice(0, -'.json'.length));
}

/**
 * The summary a grid is actually read through. Attribution is reported against its own chance rate
 * rather than as a bare percentage, because 33% means something different over three candidates than
 * over nine, and control rows are kept separate rather than averaged in: the control is the arm that
 * predicts chance, so folding it into the mean is throwing away the comparison.
 */
export function judgeSummary(judgments: Judgment[]): string {
  const arm = (control: boolean) => judgments.filter((j) => j.control === control);
  const lines: string[] = [`judge ${judgeVersion()}  ${judgments.length} works`];
  for (const [label, rows] of [['position', arm(false)], ['control ', arm(true)]] as const) {
    if (!rows.length) continue;
    const hits = rows.filter((j) => j.attribution.correct).length;
    const chance = rows.reduce((a, j) => a + 1 / j.attribution.candidates, 0);
    const necessity = rows.reduce((a, j) => a + j.necessity.score, 0) / rows.length;
    const derives = rows.filter((j) => j.derivation.verdict === 'derives').length;
    const cliches = rows.reduce((a, j) => a + j.derivation.clichesTaken.length, 0);
    lines.push(
      `  ${label}  n=${rows.length}  attribution ${hits}/${rows.length} (chance ${chance.toFixed(1)})  ` +
        `necessity ${necessity.toFixed(2)}/7  derives ${derives}/${rows.length}  cliches ${cliches}`
    );
  }
  return lines.join('\n');
}
