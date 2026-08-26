// checkProgram: does this tree honour this position?
//
// Pure and synchronous. Everything decidable from the JSON is decided here in microseconds, which is
// what makes it usable inside a search loop rather than at the end of one. Render-scope constraints
// need a RenderMetrics, produced separately by src/aesthetic/measure.ts, because that is the one part
// that needs a browser; hand it null and those constraints come back `unverified`, never assumed.
//
// No LLM is called here and none ever will be. Judge-scope rubrics are returned as text.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { ROOT } from '../../env/browser.js';
import { treeFacts } from './facts.js';
import { checkConstraintWithFacts } from './kinds.js';
import type { AestheticProgram, CheckReport, Constraint, ConstraintResult, RenderMetrics } from './types.js';

const Ajv = _Ajv2020 as unknown as typeof _Ajv2020.default;

let compiled: ValidateFunction | null = null;

/** The aesthetic program schema is a gate like any other: a malformed position is not a position. */
export function validateAestheticProgram(value: unknown): string[] {
  if (!compiled) {
    const ajv = new Ajv({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    const file = path.join(ROOT, 'spec', 'aesthetic-program.schema.json');
    compiled = ajv.compile(JSON.parse(readFileSync(file, 'utf8')) as object);
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
    const { status, evidence } = checkConstraintWithFacts(constraint, facts, metrics);
    const result: ConstraintResult = {
      id: constraint.id,
      kind: constraint.kind,
      scope: constraint.scope,
      severity: constraint.severity,
      status,
      part,
      evidence,
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
