import { describe, expect, it } from "vitest";
import { validate } from "../src/json-schema.js";

describe("json-schema subset validator", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["id", "n"],
    properties: {
      id: { type: "string", pattern: "^a", minLength: 2 },
      n: { type: "integer", minimum: 1, maximum: 3 },
      tag: { enum: ["x", "y"] },
      list: { type: "array", items: { type: "number" } },
    },
  };

  it("accepts a valid value", () => {
    expect(validate(schema, { id: "ab", n: 2, tag: "x", list: [1, 2.5] })).toEqual([]);
  });

  it("reports missing, extra and invalid fields", () => {
    const errors = validate(schema, { id: "b", n: 1.5, extra: true, list: ["z"] });
    expect(errors.map((e) => e.path).sort()).toEqual(["$.extra", "$.id", "$.id", "$.list[0]", "$.n"]);
  });

  it("rejects unsupported keywords loudly", () => {
    expect(() => validate({ oneOf: [] }, 1)).toThrow(/unsupported keyword "oneOf"/);
  });
});
