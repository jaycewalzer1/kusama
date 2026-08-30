// Schema checking for model output, shared by both policy implementations.
//
// The provider is asked to emit against the schema and usually does. This checks it anyway, because
// "the provider enforced it" is a claim about the provider and not about the bytes that arrived, and
// because the retry needs a validator error to hand back that is specific enough to act on.

import _Ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

const Ajv = _Ajv2020 as unknown as typeof _Ajv2020.default;

const cache = new Map<string, ValidateFunction>();

function compile(schema: object): ValidateFunction {
  const key = JSON.stringify(schema);
  let v = cache.get(key);
  if (!v) {
    v = new Ajv({ allErrors: true, strict: false }).compile(schema);
    cache.set(key, v);
  }
  return v;
}

/** Empty means it validated. Otherwise, one readable line per problem, for the retry to read. */
export function schemaErrors(value: unknown, schema: object): string[] {
  const v = compile(schema);
  if (v(value)) return [];
  return (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}
