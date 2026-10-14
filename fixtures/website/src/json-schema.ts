/**
 * Tiny JSON Schema (draft 2020-12) subset validator for the contract test.
 * Supported: type, enum, const, required, properties, additionalProperties,
 * items, minimum, maximum, minLength, maxLength, pattern. Annotation keywords
 * ($schema, $id, title, description, examples, $comment) are ignored. Any other
 * keyword throws, so a contract edit that relies on an unsupported keyword is
 * noticed instead of silently passing.
 */

export type JsonSchema = { [keyword: string]: unknown } | boolean;

export interface SchemaError {
  path: string;
  message: string;
}

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "examples", "$comment", "default"]);
const SUPPORTED = new Set([
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
]);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  return actual === type;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function validate(schema: JsonSchema, value: unknown, path = "$"): SchemaError[] {
  if (schema === true) return [];
  if (schema === false) return [{ path, message: "is not allowed" }];
  for (const keyword of Object.keys(schema)) {
    if (!ANNOTATIONS.has(keyword) && !SUPPORTED.has(keyword)) {
      throw new Error(`json-schema: unsupported keyword "${keyword}" at ${path}`);
    }
  }

  const errors: SchemaError[] = [];
  const s = schema as Record<string, unknown>;

  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push({ path, message: `expected ${types.join("|")}, got ${typeOf(value)}` });
      return errors;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => sameJson(e, value))) {
    errors.push({ path, message: `must be one of ${JSON.stringify(s.enum)}` });
  }
  if ("const" in s && !sameJson(s.const, value)) {
    errors.push({ path, message: `must equal ${JSON.stringify(s.const)}` });
  }

  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) {
      errors.push({ path, message: `must be >= ${s.minimum}` });
    }
    if (typeof s.maximum === "number" && value > s.maximum) {
      errors.push({ path, message: `must be <= ${s.maximum}` });
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof s.minLength === "number" && length < s.minLength) {
      errors.push({ path, message: `length must be >= ${s.minLength}` });
    }
    if (typeof s.maxLength === "number" && length > s.maxLength) {
      errors.push({ path, message: `length must be <= ${s.maxLength}` });
    }
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) {
      errors.push({ path, message: `must match ${s.pattern}` });
    }
  }

  if (Array.isArray(value) && s.items !== undefined) {
    value.forEach((item, i) => errors.push(...validate(s.items as JsonSchema, item, `${path}[${i}]`)));
  }

  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (s.required ?? []) as string[]) {
      if (!(key in obj)) errors.push({ path: `${path}.${key}`, message: "is required" });
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key in props) {
        errors.push(...validate(props[key] as JsonSchema, child, `${path}.${key}`));
      } else if (s.additionalProperties !== undefined) {
        const extra = s.additionalProperties as JsonSchema;
        if (extra === false) {
          errors.push({ path: `${path}.${key}`, message: "is not declared in the contract" });
        } else {
          errors.push(...validate(extra, child, `${path}.${key}`));
        }
      }
    }
  }

  return errors;
}
