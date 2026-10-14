/**
 * A small JSON Schema (draft 2020-12 subset) validator for contract checks. No dependency.
 * Unsupported keywords are an error, so a contract can never pass silently because the runner
 * ignored part of it.
 */

const ANNOTATIONS = new Set(['$schema', '$id', '$comment', 'title', 'description', 'examples', 'default', 'deprecated', 'readOnly', 'writeOnly']);
const SUPPORTED = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'items',
  'minItems',
  'maxItems',
  'anyOf',
  'oneOf',
  'allOf',
]);

export class UnsupportedSchemaError extends Error {}

type Schema = boolean | Record<string, unknown>;

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Validate `value`; returns human-readable errors (`$.path: message`); empty means valid. */
export function validateJsonSchema(schema: unknown, value: unknown): string[] {
  const errors: string[] = [];
  walk(schema as Schema, value, '$', errors);
  return errors;
}

function walk(schema: Schema, v: unknown, at: string, errors: string[]): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${at}: not allowed`);
    return;
  }
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) throw new UnsupportedSchemaError(`${at}: schema must be an object or boolean`);
  for (const k of Object.keys(schema)) {
    if (!ANNOTATIONS.has(k) && !SUPPORTED.has(k)) throw new UnsupportedSchemaError(`unsupported JSON Schema keyword ${JSON.stringify(k)} at ${at}`);
  }
  const s = schema as Record<string, unknown>;
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => typeMatches(v, t))) {
      errors.push(`${at}: expected ${types.join('|')}, got ${typeOf(v)}`);
      return;
    }
  }
  if (s.enum !== undefined && !(s.enum as unknown[]).some((e) => deepEqual(e, v))) errors.push(`${at}: not one of ${JSON.stringify(s.enum)}`);
  if (s.const !== undefined && !deepEqual(s.const, v)) errors.push(`${at}: must equal ${JSON.stringify(s.const)}`);
  if (typeof v === 'string') {
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${at}: does not match ${s.pattern}`);
    const len = [...v].length;
    if (typeof s.minLength === 'number' && len < s.minLength) errors.push(`${at}: shorter than ${s.minLength}`);
    if (typeof s.maxLength === 'number' && len > s.maxLength) errors.push(`${at}: longer than ${s.maxLength}`);
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) errors.push(`${at}: below ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) errors.push(`${at}: above ${s.maximum}`);
    if (typeof s.exclusiveMinimum === 'number' && v <= s.exclusiveMinimum) errors.push(`${at}: not above ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === 'number' && v >= s.exclusiveMaximum) errors.push(`${at}: not below ${s.exclusiveMaximum}`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) errors.push(`${at}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) errors.push(`${at}: more than ${s.maxItems} items`);
    if (s.items !== undefined) v.forEach((item, i) => walk(s.items as Schema, item, `${at}[${i}]`, errors));
  }
  if (typeOf(v) === 'object') {
    const obj = v as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in obj)) errors.push(`${at}.${r}: is required`);
    for (const [k, val] of Object.entries(obj)) {
      if (k in props) walk(props[k]!, val, `${at}.${k}`, errors);
      else if (s.additionalProperties === false) errors.push(`${at}.${k}: is not declared in the contract`);
      else if (s.additionalProperties !== undefined && s.additionalProperties !== true) walk(s.additionalProperties as Schema, val, `${at}.${k}`, errors);
    }
  }
  if (Array.isArray(s.allOf)) for (const sub of s.allOf as Schema[]) walk(sub, v, at, errors);
  if (Array.isArray(s.anyOf)) {
    if (!(s.anyOf as Schema[]).some((sub) => validateJsonSchema(sub, v).length === 0)) errors.push(`${at}: matches none of anyOf`);
  }
  if (Array.isArray(s.oneOf)) {
    const n = (s.oneOf as Schema[]).filter((sub) => validateJsonSchema(sub, v).length === 0).length;
    if (n !== 1) errors.push(`${at}: matches ${n} of oneOf (expected 1)`);
  }
}
