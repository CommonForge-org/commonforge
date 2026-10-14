import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("commonforge-worker (workerd)", () => {
  it("serves GET /health through the module entrypoint", async () => {
    const res = await SELF.fetch("https://example.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "commonforge-worker", deployment: "production", emailMode: "log" });
  });
});
