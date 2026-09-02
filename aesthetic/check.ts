// checkProgram: does this tree honour this position?
//
// Pure and synchronous. Everything decidable from the JSON is decided here in microseconds, which is
// what makes it usable inside a search loop rather than at the end of one. Render-scope constraints
// need a RenderMetrics, produced separately by ./measure.ts, because that is the one part that needs
// a browser; hand it null and those constraints come back `unverified`, never assumed.
//
// Nothing here may import ./measure.ts or env/browser.ts: this module stays free of Playwright so
// the search loop pays for a checker and not for a browser.
//
// No LLM is called here and none ever will be. Judge-scope rubrics are returned as text.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { treeFacts } from './facts.js';
import { checkConstraintWithFacts } from './kinds.js';
import { COUNTING_KINDS, HARD_TREE_KINDS, MAX_HARD_CONSTRAINTS } from './types.js';
import type { AestheticProgram, CheckReport, Constraint, ConstraintResult, RenderMetrics } from './types.js';

const Ajv = _Ajv2020 as unknown as typeof _Ajv2020.default;

/**
 * The schema sits beside this file in the source tree but is not copied into `dist/`, so it is found
 * from the package root rather than relative to the module. Works from `aesthetic/` and
 * `dist/aesthetic/` alike, which is the same trick `env/browser.ts` uses for ROOT — repeated here
 * rather than imported, because importing it would pull Playwright into the pure path.
 */
const SCHEMA_FILE = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, 'package.json'))) {
      return path.join(dir, 'aesthetic', 'aesthetic-program.schema.json');
    }
    dir = path.dirname(dir);
  }
  throw new Error('cannot locate the medium root (package.json not found above this file)');
})();

let compiled: ValidateFunction | null = null;

/** The aesthetic program schema is a gate like any other: a malformed position is not a position. */
export function validateAestheticProgram(value: unknown): string[] {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    compiled = ajv.compile(JSON.parse(readFileSync(SCHEMA_FILE, 'utf8')) as object);
  }
  if (compiled(value)) return [];
  return (compiled.errors ?? []).map((e) => `${e.instancePath || '/'}: ${e.message ?? 'invalid'}`);
}

export function loadAestheticProgram(file: string): AestheticProgram {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const issues = validateAestheticProgram(raw);
  if (issues.length) throw new Error(`${file} is not a valid aesthetic program:\n  ${issues.join('\n  ')}`);
  return raw as AestheticProgram;
}

/** commitments, then prohibitions, then whichever generative rules happened to be decidable. */
export function constraintsOf(ap: AestheticProgram): { constraint: Constraint; part: ConstraintResult['part'] }[] {
  return [
    ...ap.commitments.map((c) => ({ constraint: c, part: 'commitment' as const })),
    ...ap.prohibitions.map((c) => ({ constraint: c, part: 'prohibition' as const })),
    ...ap.generative_rules
      .filter((r): r is { rule: string; constraint: Constraint } => r.constraint !== undefined)
      .map((r) => ({ constraint: r.constraint, part: 'generative_rule' as const })),
  ];
}

/**
 * What a *position* may insist on, over and above what the schema allows any aesthetic program.
 *
 * Not in loadAestheticProgram on purpose: the six cross-check programs in examples/aesthetic/ are
 * read through the same loader and are meant to be over-determined — they exist to show what a
 * position looks like when it is a picture spec. This runs where a position enters a run.
 *
 * Returns human-readable issues, empty when the position is within budget.
 */
export function positionIssues(ap: AestheticProgram): string[] {
  const issues: string[] = [];
  const hard = constraintsOf(ap).filter(({ constraint }) => constraint.severity === 'hard');

  for (const { constraint: c } of hard) {
    if (COUNTING_KINDS.includes(c.kind)) {
      issues.push(
        `${c.id}: "${c.kind}" counts nodes in the source tree and may not be hard. Make it soft, or say what ` +
          `you mean about the picture — "four opaque areas" is regionCountRange, not requireMark.`
      );
    } else if (c.scope === 'tree' && !HARD_TREE_KINDS.includes(c.kind)) {
      issues.push(
        `${c.id}: "${c.kind}" is a tree-scope requirement and may not be hard. A hard constraint has to be a ` +
          `ban, a ceiling, or a render measure; anything else can be satisfied by adding a node nobody sees.`
      );
    }
  }

  const decidable = hard.filter(({ constraint }) => constraint.scope !== 'judge');
  if (decidable.length > MAX_HARD_CONSTRAINTS) {
    issues.push(
      `${decidable.length} hard decidable constraints (${decidable.map(({ constraint }) => constraint.id).join(', ')}), ` +
        `and a position may carry ${MAX_HARD_CONSTRAINTS}. Past four they stop describing a practice and start ` +
        `describing one object. Move the rest into rubrics, where a reader can weigh them, or make them soft.`
    );
  }
  return issues;
}

/**
 * Fraction satisfied, hard weighted double. Constraints that could not be decided — blocked by a
 * missing primitive, or waiting on render metrics — are left out of both numerator and denominator,
 * so a position that cannot be tested does not score well by being untestable. An empty denominator
 * is null, not 1.
 */
function score(results: ConstraintResult[]): number | null {
  let got = 0;
  let total = 0;
  for (const r of results) {
    if (r.status === 'unverified') continue;
    const weight = r.severity === 'hard' ? 2 : 1;
    total += weight;
    if (r.status === 'satisfied') got += weight;
  }
  return total === 0 ? null : got / total;
}

export function checkProgram(tree: unknown, ap: AestheticProgram, metrics: RenderMetrics | null = null): CheckReport {
  const facts = treeFacts(tree);
  const results: ConstraintResult[] = [];

  for (const { constraint, part } of constraintsOf(ap)) {
    const { status, evidence, nodeIds } = checkConstraintWithFacts(constraint, facts, metrics);
    const result: ConstraintResult = {
      id: constraint.id,
      kind: constraint.kind,
      scope: constraint.scope,
      severity: constraint.severity,
      status,
      part,
      evidence,
      nodeIds,
      why: constraint.why,
    };
    if (constraint.blocked_by !== undefined) result.blocked_by = constraint.blocked_by;
    if (constraint.kind === 'rubric' && typeof constraint.params['text'] === 'string') {
      result.rubric = constraint.params['text'];
    }
    results.push(result);
  }

  const violated = results.filter((r) => r.status === 'violated');
  return {
    aesthetic: ap.id,
    hardViolations: violated.filter((r) => r.severity === 'hard').length,
    softViolations: violated.filter((r) => r.severity === 'soft').length,
    treeScore: score(results.filter((r) => r.scope === 'tree')),
    renderScore: score(results.filter((r) => r.scope === 'render')),
    blocked: results.filter((r) => r.blocked_by !== undefined).length,
    pendingRubrics: results
      .filter((r) => r.rubric !== undefined)
      .map((r) => ({ id: r.id, text: r.rubric as string })),
    results,
  };
}
