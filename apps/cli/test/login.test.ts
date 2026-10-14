import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractCode } from "../src/login.js";
import { EMAIL, harness, loginAs, type Harness } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.world.close());

describe("cforge login (CLI code flow)", () => {
  it("requests a cli code, exchanges it for a bearer and stores it 0600 in a 0700 config dir", async () => {
    const r1 = await h.cli(["login", "--email", EMAIL, "--json"]);
    expect(r1.code).toBe(0);
    expect(r1.json()).toMatchObject({ status: "code_sent", email: EMAIL });
    const magic = h.world.calls.find((c) => c.path === "/api/auth/magic-link")!;
    expect(magic.body).toEqual({ email: EMAIL, client: "cli" });
    expect(magic.auth).toBeNull();

    const code = [...h.world.codes.keys()][0]!;
    const r2 = await h.cli(["login", "--code", `http://app.example/auth/cli?code=${code}`, "--json"]);
    expect(r2.code).toBe(0);
    const out = r2.json();
    expect(out).toMatchObject({ status: "logged_in", user: { email: EMAIL } });
    expect(r2.stdout).not.toContain("cfs_");

    const file = join(h.configDir, "session.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(h.configDir).mode & 0o777).toBe(0o700);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.sessionToken).toMatch(/^cfs_/);
    expect(h.world.sessions.has(saved.sessionToken)).toBe(true);
  });

  it("prompts for the code when interactive", async () => {
    h.world.overrides.set("POST /api/auth/magic-link", () => {
      h.world.codes.set("cfm_promptedcode0123456789", EMAIL);
      h.world.addUser(EMAIL);
      return { status: 202, body: { ok: true } };
    });
    const r = await h.cli(["login", "--email", EMAIL], { prompt: "cfm_promptedcode0123456789" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`as ${EMAIL}`);
  });

  it("refuses malformed codes and surfaces server refusals", async () => {
    expect(() => extractCode("hello")).toThrow(/login code/);
    const c = "cfm_UaIhKsW4kUZEOGQOhnYabc";
    expect(extractCode(`cforge login --code ${c}`)).toBe(c);
    expect(extractCode(`  cforge login --code=${c}  `)).toBe(c);
    expect(extractCode(`cforge login --code '${c}'`)).toBe(c);
    expect(extractCode(`https://app.example/auth/cli?code=${c}`)).toBe(c);
    expect(() => extractCode("cforge login --code hello")).toThrow(/login code/);
    const r = await h.cli(["login", "--code", "cfm_doesnotexist0123456789", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("invalid_token");
  });

  it("whoami uses the bearer; logout revokes and forgets it", async () => {
    await loginAs(h);
    const me = await h.cli(["whoami", "--json"]);
    expect(me.json()).toMatchObject({ user: { email: EMAIL }, memberships: [{ role: "owner" }] });
    const bearer = h.world.calls.at(-1)!.auth!;
    expect(bearer).toMatch(/^cfs_/);
    expect((await h.cli(["logout", "--json"])).code).toBe(0);
    expect(h.world.sessions.has(bearer)).toBe(false);
    const after = await h.cli(["whoami", "--json"]);
    expect(after.json().error.code).toBe("login_required");
  });

  it("never sends a session to an API other than the one that issued it", async () => {
    await loginAs(h);
    const r = await h.cli(["whoami", "--json", "--api-url", "https://evil.example"]);
    expect(r.json().error.code).toBe("login_required");
    expect(h.world.calls.filter((c) => c.path === "/api/me")).toHaveLength(0);
  });

  it("refuses plain http to anything but localhost", async () => {
    const r = await h.cli(["login", "--email", EMAIL, "--json", "--api-url", "http://api.example.com"]);
    expect(r.json().error.code).toBe("insecure_url");
    expect(h.world.calls).toHaveLength(0);
    for (const ok of ["http://localhost:8787", "http://127.0.0.1:9", "http://[::1]:8787"]) {
      expect((await h.cli(["login", "--email", EMAIL, "--json", "--api-url", ok])).code).toBe(0);
    }
  });

  it("never echoes token fragments from a corrupt config file", async () => {
    mkdirSync(h.configDir, { recursive: true });
    writeFileSync(join(h.configDir, "session.json"), "cfs_SECRETSECRETSECRET not json");
    const r = await h.cli(["whoami", "--json"]);
    expect(r.json().error.code).toBe("config_corrupt");
    expect(r.stdout + r.stderr).not.toContain("SECRET");
  });
});
