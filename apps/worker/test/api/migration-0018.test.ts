import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const columns = async (table: string) => (await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((c) => c.name);

describe("migration 0018", () => {
  it("sessions record how they were opened; magic links record a hand-off code", async () => {
    expect(await columns("sessions")).toContain("client");
    expect(await columns("magic_links")).toContain("via");
  });
});
