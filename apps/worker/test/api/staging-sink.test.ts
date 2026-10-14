import { describe, expect, it } from "vitest";
import { ensureSink, sweepCaptures } from "../../src/services/sink.js";
import { stagingFixture } from "../staging-helpers.js";

describe("capture sink", () => {
  it("records what staging sends, without credentials, and shows it to the project", async () => {
    const f = await stagingFixture();
    const token = await ensureSink(f.svc, f.o.orgId, f.pid);
    expect(token).toMatch(/^snk_[A-Za-z0-9_-]{43}$/);
    expect(await ensureSink(f.svc, f.o.orgId, f.pid)).toBe(token);
    const r = await f.h.api("POST", `/api/sink/${token}/payments`, {
      raw: '{"amount":12}',
      headers: { "content-type": "application/json", authorization: "Bearer secret", cookie: "sid=secret", "x-api-key": "secret", "proxy-authorization": "secret", "x-auth-token": "secret", "x-goog-api-key": "secret", origin: "https://cfapp-x-staging.example.workers.dev" },
    });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true });
    const sent = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/sent`, { token: f.o.token });
    expect(sent.status).toBe(200);
    expect(sent.body.captures[0]).toMatchObject({ method: "POST", path: "/payments", body: '{"amount":12}', truncated: false });
    expect(sent.body.captures[0].headers["content-type"]).toBe("application/json");
    expect(JSON.stringify(sent.body)).not.toContain("secret");
  });

  it("unknown tokens are 404; oversized bodies are truncated", async () => {
    const f = await stagingFixture();
    expect((await f.h.api("POST", "/api/sink/snk_nope", { raw: "x" })).status).toBe(404);
    const token = await ensureSink(f.svc, f.o.orgId, f.pid);
    expect((await f.h.api("POST", `/api/sink/${token}`, { raw: "x".repeat(20_000) })).status).toBe(202);
    const sent = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/sent`, { token: f.o.token });
    expect(sent.body.captures[0].path).toBe("/");
    expect(sent.body.captures[0].body).toHaveLength(16_384);
    expect(sent.body.captures[0].truncated).toBe(true);
  });

  it("is not reachable by another project's token and needs no session or origin", async () => {
    const f = await stagingFixture();
    const token = await ensureSink(f.svc, f.o.orgId, f.pid);
    const other = await ensureSink(f.svc, f.o.orgId, "prj-other");
    expect(other).not.toBe(token);
    // a cross-origin browser POST without a bearer is not refused as CSRF (the sink changes only its own log)
    const r = await f.h.api("POST", `/api/sink/${token}/x`, { raw: "{}", headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(202);
    // a project's feed only lists its own captures
    const sent = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/prj-other/staging/sent`, { token: f.o.token });
    expect(sent.status).toBe(200);
    expect(sent.body.captures).toEqual([]);
  });

  it("rate limits per project (120/min) with 429", async () => {
    const f = await stagingFixture();
    const token = await ensureSink(f.svc, f.o.orgId, f.pid);
    let last = 202;
    for (let i = 0; i < 121; i++) last = (await f.h.api("POST", `/api/sink/${token}`, { raw: "{}" })).status;
    expect(last).toBe(429);
  });

  it("the sent feed needs project read access", async () => {
    const f = await stagingFixture();
    expect((await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/sent`)).status).toBe(401);
  });

  it("keeps only the newest 200 captures per project", async () => {
    const f = await stagingFixture();
    const token = await ensureSink(f.svc, f.o.orgId, f.pid);
    // the per-project rate limit is 120/min, so seed the first batch directly and send the rest through the sink
    const ins = f.svc.db.prepare("INSERT INTO staging_captures (capture_id, org_id, project_id, received_at, method, path, headers_json, body, truncated) VALUES (?, ?, ?, ?, 'POST', '/', '{}', ?, 0)");
    await f.svc.db.batch(Array.from({ length: 200 }, (_, i) => ins.bind(`cap-seed-${i}`, f.o.orgId, f.pid, new Date(Date.now() - 3_600_000 + i * 1000).toISOString(), `seed-${i}`)));
    for (let i = 0; i < 5; i++) expect((await f.h.api("POST", `/api/sink/${token}`, { raw: `live-${i}` })).status).toBe(202);
    const n = await f.svc.db.prepare("SELECT COUNT(*) AS n FROM staging_captures WHERE project_id = ?").bind(f.pid).first<{ n: number }>();
    expect(n?.n).toBe(200);
    const sent = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/sent`, { token: f.o.token });
    expect(sent.body.captures).toHaveLength(100);
    expect(sent.body.captures[0].body).toBe("live-4");
    const oldest = await f.svc.db.prepare("SELECT body FROM staging_captures WHERE project_id = ? ORDER BY received_at ASC, rowid ASC LIMIT 1").bind(f.pid).first<{ body: string }>();
    expect(oldest?.body).toBe("seed-5");
  });

  it("keeps captures for 7 days", async () => {
    const f = await stagingFixture();
    const token = await ensureSink(f.svc, f.o.orgId, f.pid);
    await f.h.api("POST", `/api/sink/${token}`, { raw: "old" });
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await f.svc.db.prepare("UPDATE staging_captures SET received_at = ?").bind(old).run();
    await f.h.api("POST", `/api/sink/${token}`, { raw: "new" });
    await sweepCaptures(f.svc);
    const sent = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/sent`, { token: f.o.token });
    expect(sent.body.captures.map((c: { body: string }) => c.body)).toEqual(["new"]);
  });
});
