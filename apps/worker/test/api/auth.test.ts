import { describe, expect, it } from "vitest";
import { email, harness, provisionedTask } from "../helpers.js";
import { CLI_CODE_LIMIT, HANDOFF_SESSION_TTL_MS, SESSION_TTL_MS } from "../../src/services/auth.js";

describe("auth: magic link and sessions", () => {
  it("refuses to mail the sender address (it has no inbox)", async () => {
    const h = harness();
    const r = await h.api("POST", "/api/auth/magic-link", { body: { email: "Login@Example.COM" } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_email");
    expect(h.email.sent).toHaveLength(0);
  });

  it("web: link to the app, POST verify once → HttpOnly cookie only (no token in the body)", async () => {
    const h = harness();
    const addr = email("alice");
    const r = await h.api("POST", "/api/auth/magic-link", { body: { email: `  ${addr.toUpperCase()} ` } });
    expect(r.status).toBe(202);
    expect(h.email.sent).toHaveLength(1);
    expect(h.email.sent[0]!.to).toBe(addr);
    expect(h.email.sent[0]!.link).toMatch(/^https:\/\/app\.test\/auth\/verify\?token=cfm_/);
    const token = h.email.lastToken(addr)!;

    const v = await h.api("POST", "/api/auth/verify", { body: { token }, headers: { origin: "https://app.test" } });
    expect(v.status).toBe(200);
    expect(v.body.user.email).toBe(addr);
    expect(v.body.sessionToken).toBeUndefined(); // I-5: XSS in the app cannot read the session
    expect(v.headers.get("cache-control")).toBe("no-store");
    const cookie = v.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^__Host-cf_session=cfs_/);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    const session = /__Host-cf_session=([^;]+)/.exec(cookie)![1]!;

    // single use; nothing is consumed on GET
    expect((await h.api("POST", "/api/auth/verify", { body: { token } })).status).toBe(401);
    expect((await h.api("GET", `/api/auth/verify?token=${token}`)).status).toBe(404);

    const me = await h.api("GET", "/api/me", { headers: { cookie: `__Host-cf_session=${session}` } });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(addr);
    // review I-2: the pre-review name is never a credential, and a planted duplicate is refused
    expect((await h.api("GET", "/api/me", { headers: { cookie: `cf_session=${session}` } })).status).toBe(401);
    expect((await h.api("GET", "/api/me", { headers: { cookie: `__Host-cf_session=cfs_attacker; __Host-cf_session=${session}` } })).status).toBe(401);
    const out = await h.api("POST", "/api/auth/logout", { headers: { cookie: `__Host-cf_session=${session}`, origin: "https://app.test" } });
    expect(out.status).toBe(200);
    expect((await h.api("GET", "/api/me", { headers: { cookie: `__Host-cf_session=${session}` } })).status).toBe(401);
  });

  it("cli: a code exchanged at /auth/cli/verify yields a bearer; web and cli codes are not interchangeable", async () => {
    const h = harness();
    const addr = email("cli");
    await h.api("POST", "/api/auth/magic-link", { body: { email: addr, client: "cli" } });
    const code = h.email.lastCode(addr)!;
    expect(h.email.sent[0]!.link).toMatch(/^https:\/\/app\.test\/auth\/cli\?code=cfm_/);
    expect((await h.api("POST", "/api/auth/verify", { body: { token: code } })).status).toBe(401);
    const v = await h.api("POST", "/api/auth/cli/verify", { body: { code } });
    expect(v.status).toBe(200);
    expect(v.body.sessionToken).toMatch(/^cfs_/);
    expect(v.headers.get("set-cookie")).toBeNull();
    expect((await h.api("GET", "/api/me", { token: v.body.sessionToken })).status).toBe(200);
    await h.api("POST", "/api/auth/magic-link", { body: { email: addr } });
    expect((await h.api("POST", "/api/auth/cli/verify", { body: { code: h.email.lastToken(addr) } })).status).toBe(401);
  });

  it("cli code for a signed-in person (the hand-off prompt): no email, single use, same user, signed-in only, cross-origin refused", async () => {
    const h = harness();
    const addr = email("handoff");
    expect((await h.api("POST", "/api/auth/cli/code")).status).toBe(401);
    const token = await h.signIn(addr);
    const sent = h.email.sent.length;
    const r = await h.api("POST", "/api/auth/cli/code", { token });
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^cfm_[A-Za-z0-9_-]{20,}$/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(h.email.sent.length).toBe(sent);
    // a CLI code only: never a web sign-in
    expect((await h.api("POST", "/api/auth/verify", { body: { token: r.body.code } })).status).toBe(401);
    const v = await h.api("POST", "/api/auth/cli/verify", { body: { code: r.body.code } });
    expect(v.status).toBe(200);
    expect(v.body.user.email).toBe(addr);
    expect((await h.api("POST", "/api/auth/cli/verify", { body: { code: r.body.code } })).status).toBe(401);
    // a cookie session from another site never gets one (csrfGuard)
    await h.api("POST", "/api/auth/magic-link", { body: { email: addr } });
    const w = await h.api("POST", "/api/auth/verify", { body: { token: h.email.lastToken(addr) } });
    const cookie = `__Host-cf_session=${/__Host-cf_session=([^;]+)/.exec(w.headers.get("set-cookie")!)![1]}`;
    expect((await h.api("POST", "/api/auth/cli/code", { headers: { cookie, origin: "https://evil.test" } })).status).toBe(403);
    expect((await h.api("POST", "/api/auth/cli/code", { headers: { cookie, origin: "https://app.test" } })).status).toBe(201);
  });

  it("cli code: at most CLI_CODE_LIMIT per person per window (429 rate_limited); never for a task lease token", async () => {
    const h = harness();
    const token = await h.signIn(email("many"));
    for (let i = 0; i < CLI_CODE_LIMIT; i++) expect((await h.api("POST", "/api/auth/cli/code", { token })).status).toBe(201);
    const over = await h.api("POST", "/api/auth/cli/code", { token });
    expect([over.status, over.body.error.code]).toEqual([429, "rate_limited"]);
    // another person is not limited by it
    expect((await h.api("POST", "/api/auth/cli/code", { token: await h.signIn(email("other")) })).status).toBe(201);
    const h2 = harness();
    const t = await provisionedTask(h2);
    const lease = await h2.api("POST", `/api/tasks/${t.taskId}/lease`, { token: t.o.token, body: {} });
    expect(lease.status).toBe(200);
    const agent = await h2.api("POST", "/api/auth/cli/code", { token: lease.body.leaseToken });
    expect([agent.status, agent.body.error.code]).toEqual([403, "agent_not_allowed"]);
  });

  it("sessions: list your own (browser, cforge, hand-off; the current one marked), end one, end all others; hand-off logins last a week", async () => {
    const h = harness();
    const addr = email("sess");
    const cli = await h.signIn(addr);
    await h.api("POST", "/api/auth/magic-link", { body: { email: addr } });
    const w = await h.api("POST", "/api/auth/verify", { body: { token: h.email.lastToken(addr) } });
    const cookie = `__Host-cf_session=${/__Host-cf_session=([^;]+)/.exec(w.headers.get("set-cookie")!)![1]}`;
    const code = (await h.api("POST", "/api/auth/cli/code", { token: cli })).body.code;
    const handoff = (await h.api("POST", "/api/auth/cli/verify", { body: { code } })).body;
    expect(Date.parse(handoff.expiresAt) - Date.now()).toBeLessThanOrEqual(HANDOFF_SESSION_TTL_MS);
    expect(Date.parse(handoff.expiresAt) - Date.now()).toBeLessThan(SESSION_TTL_MS / 2);
    const other = await h.signIn(email("someone-else"));

    const list = await h.api("GET", "/api/auth/sessions", { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const sessions = list.body.sessions as Array<{ sessionId: string; client: string; current: boolean }>;
    expect(sessions.map((x) => x.client).sort()).toEqual(["cli", "handoff", "web"]);
    expect(sessions.filter((x) => x.current).map((x) => x.client)).toEqual(["web"]);
    expect(JSON.stringify(list.body)).not.toMatch(/cfs_/);

    // end the hand-off session by its id: its bearer stops working
    const hid = sessions.find((x) => x.client === "handoff")!.sessionId;
    expect((await h.api("POST", "/api/auth/sessions/revoke", { body: { sessionId: hid }, headers: { cookie, origin: "https://app.test" } })).body.ended).toBe(1);
    expect((await h.api("GET", "/api/me", { token: handoff.sessionToken })).status).toBe(401);
    // another person's session id is never yours to end
    const otherId = (await h.api("GET", "/api/auth/sessions", { token: other })).body.sessions[0].sessionId;
    expect((await h.api("POST", "/api/auth/sessions/revoke", { body: { sessionId: otherId }, headers: { cookie, origin: "https://app.test" } })).body.ended).toBe(0);
    expect((await h.api("GET", "/api/me", { token: other })).status).toBe(200);
    // all others: the cforge login ends, this browser stays
    expect((await h.api("POST", "/api/auth/sessions/revoke", { body: { others: true }, headers: { cookie, origin: "https://app.test" } })).body.ended).toBe(1);
    expect((await h.api("GET", "/api/me", { token: cli })).status).toBe(401);
    expect((await h.api("GET", "/api/me", { headers: { cookie } })).status).toBe(200);
    // cross-site and signed-out callers get nothing
    expect((await h.api("POST", "/api/auth/sessions/revoke", { body: { others: true }, headers: { cookie, origin: "https://evil.test" } })).status).toBe(403);
    expect((await h.api("GET", "/api/auth/sessions")).status).toBe(401);
    expect((await h.api("POST", "/api/auth/sessions/revoke", { body: { sessionId: "xyz" }, headers: { cookie, origin: "https://app.test" } })).status).toBe(400);
  });

  it("CSRF (I-5): cookie-authenticated writes need the app/self origin and JSON", async () => {
    const h = harness();
    const addr = email("csrf");
    await h.api("POST", "/api/auth/magic-link", { body: { email: addr } });
    const v = await h.api("POST", "/api/auth/verify", { body: { token: h.email.lastToken(addr) } });
    const cookie = `__Host-cf_session=${/__Host-cf_session=([^;]+)/.exec(v.headers.get("set-cookie")!)![1]}`;
    const evil = await h.api("POST", "/api/orgs", { raw: JSON.stringify({ name: "csrf" }), headers: { "content-type": "text/plain", cookie, origin: "https://evil.test" } });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe("csrf_refused");
    const sibling = await h.api("POST", "/api/orgs", { body: { name: "x" }, headers: { cookie, origin: "https://other.app.test" } });
    expect(sibling.status).toBe(403);
    const crossSite = await h.api("POST", "/api/orgs", { body: { name: "x" }, headers: { cookie, "sec-fetch-site": "same-site" } });
    expect(crossSite.status).toBe(403);
    const plain = await h.api("POST", "/api/orgs", { raw: JSON.stringify({ name: "x" }), headers: { "content-type": "text/plain", cookie, origin: "https://app.test" } });
    expect(plain.status).toBe(415);
    const ok = await h.api("POST", "/api/orgs", { body: { name: "ok" }, headers: { cookie, origin: "https://app.test" } });
    expect(ok.status).toBe(201);
    const self = await h.api("POST", "/api/orgs", { body: { name: "ok2" }, headers: { cookie, origin: "https://worker.test" } });
    expect(self.status).toBe(201);
    // login CSRF through /auth/verify is refused too
    await h.api("POST", "/api/auth/magic-link", { body: { email: addr } });
    expect((await h.api("POST", "/api/auth/verify", { body: { token: h.email.lastToken(addr) }, headers: { origin: "https://evil.test" } })).status).toBe(403);
  });

  it("I-4: per-IP and global limits on magic-link sends", async () => {
    const h = harness();
    const ip = `198.51.100.${Math.floor(Math.random() * 250)}`;
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await h.api("POST", "/api/auth/magic-link", { body: { email: email("victim") }, headers: { "cf-connecting-ip": ip } })).status);
    expect(codes.slice(0, 10).every((c) => c === 202)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    expect((await h.api("POST", "/api/auth/magic-link", { body: { email: email("other") }, headers: { "cf-connecting-ip": "203.0.113.9" } })).status).toBe(202);
  });

  it("rejects malformed email, unknown session, and rate-limits links per address", async () => {
    const h = harness();
    expect((await h.api("POST", "/api/auth/magic-link", { body: { email: "not-an-email" } })).status).toBe(400);
    expect((await h.api("GET", "/api/me", { token: "cfs_forged" })).status).toBe(401);
    const addr = email("spam");
    for (let i = 0; i < 5; i++) expect((await h.api("POST", "/api/auth/magic-link", { body: { email: addr } })).status).toBe(202);
    const limited = await h.api("POST", "/api/auth/magic-link", { body: { email: addr } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    expect(h.email.sent).toHaveLength(5);
  });

  it("an expired link is refused", async () => {
    let now = Date.now();
    const h = harness({ now: () => new Date(now) });
    const addr = email("late");
    await h.api("POST", "/api/auth/magic-link", { body: { email: addr } });
    now += 16 * 60_000;
    const r = await h.api("POST", "/api/auth/verify", { body: { token: h.email.lastToken(addr) } });
    expect(r.status).toBe(401);
  });

  it("CORS: only the configured web app origin may call the API with credentials", async () => {
    const h = harness();
    const ok = await h.api("OPTIONS", "/api/me", { headers: { origin: "https://app.test", "access-control-request-method": "GET" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.test");
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");
    const evil = await h.api("OPTIONS", "/api/me", { headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});
