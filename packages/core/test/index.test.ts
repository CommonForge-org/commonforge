import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("@commonforge-org/core", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@commonforge-org/core");
  });
});
