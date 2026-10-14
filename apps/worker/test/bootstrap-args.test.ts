/**
 * Task 24 review fixes: the pure parts of scripts/bootstrap/deployment.mjs (scripts/bootstrap/args.mjs).
 * I2 flags come only from the option list; I3 same-named resources the state does not record are
 * refused unless --adopt; I4 only missing secrets are sent unless rotating, and a dedicated token is
 * never replaced implicitly.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module outside the package
import { KEY_SECRETS, TOKEN_SECRETS, WORKER_SECRETS, deploymentConfigs, domainUrls, nameProblem, orgScoped, ownership, parseArgs, pickDomains, pickSecrets, pickSender, productionDomains, teardownProblems } from "../../../scripts/bootstrap/args.mjs";
// @ts-expect-error -- plain JS module outside the package
import { deploymentNames, parseJsonc } from "../../../scripts/ci-config-core.mjs";
// @ts-expect-error -- Vite `?raw` imports (the templates' text)
import prodRaw from "../wrangler.jsonc?raw";
// @ts-expect-error -- Vite `?raw` import
import prevRaw from "../wrangler.preview.jsonc?raw";
// @ts-expect-error -- Vite `?raw` import
import runnerRaw from "../wrangler.runner.jsonc?raw";

describe("bootstrap args (review I2)", () => {
  it("a positional starting with - is never a name or a flag", () => {
    expect(parseArgs(["names", "--production"])).toMatchObject({ cmd: "names", name: "commonforge" });
    expect(parseArgs(["names", "--production"]).flags.has("--production")).toBe(true);
    expect(() => parseArgs(["names", "--", "--production"])).toThrow(/unknown option --/);
    expect(() => parseArgs(["names", "--name"])).toThrow(/unknown option --name/);
    expect(() => parseArgs(["names", "-production"])).toThrow(/unknown option/);
    expect(() => parseArgs(["config", "cfboot", "--email-mode", "--production"])).toThrow(/--email-mode needs a value/);
    expect(() => parseArgs(["config", "cfboot", "--email-mode"])).toThrow(/needs a value/);
  });

  it("--admin-emails takes a value", () => {
    expect(parseArgs(["config", "cfboot", "--admin-emails", "ops@example.org"]).opts["admin-emails"]).toBe("ops@example.org");
    expect(() => parseArgs(["config", "cfboot", "--admin-emails"])).toThrow(/needs a value/);
  });

  it("a name and --production together are refused; names are validated", () => {
    expect(() => parseArgs(["ensure", "cfboot", "--production"])).toThrow(/pass no name/);
    expect(() => parseArgs(["ensure", "a", "b"])).toThrow(/unexpected argument/);
    const ok = parseArgs(["config", "cfboot", "--email-mode", "log", "--adopt"]);
    expect(ok).toMatchObject({ cmd: "config", name: "cfboot", opts: { "email-mode": "log" } });
    expect(ok.flags.has("--adopt")).toBe(true);
    expect(ok.flags.has("--production")).toBe(false);
    for (const bad of ["commonforge", "commonforgex", "ci", "cfci", "cfapp", "prod", "production", "live", "main", "dev", "staging", "cf", "my-dep", "My", "a b", "$(id)", "x".repeat(17)]) {
      expect(nameProblem(bad), bad).not.toBeNull();
      expect(() => parseArgs(["names", bad]), bad).toThrow(/refusing deployment name/);
    }
    for (const good of ["cfboot", "abc", "cfapp1", "ci1", "e2e"]) expect(nameProblem(good), good).toBeNull();
  });
});

describe("bootstrap ownership (review I3, I3a)", () => {
  it("reuses only what carries the recorded identity; a claimed Worker only if created after the claim", () => {
    expect(ownership({ exists: false })).toBe("create");
    expect(ownership({ exists: true, existingId: "d1", owned: { id: "d1" } })).toBe("reuse");
    expect(ownership({ exists: true, existingId: "d1" })).toBe("conflict"); // someone else's
    expect(ownership({ exists: true, existingId: "d1", adopt: true })).toBe("adopt");
    expect(ownership({ exists: true, existingId: "d2", owned: { id: "d1" } })).toBe("conflict"); // replaced since
    expect(ownership({ exists: true, existingId: "d2", owned: { id: "d1" }, adopt: true })).toBe("adopt");
    // a recorded name without identity is never enough (a foreign same-named Worker is not ours)
    expect(ownership({ exists: true, existingId: "2026-01-01T00:00:00Z", owned: {} })).toBe("conflict");
    const claim = { claimedAt: "2026-10-06T21:00:00Z" };
    expect(ownership({ exists: true, existingId: "w", existingCreated: "2026-10-06T21:01:00Z", owned: claim })).toBe("reuse"); // our deploy
    expect(ownership({ exists: true, existingId: "w", existingCreated: "2026-10-01T00:00:00Z", owned: claim })).toBe("conflict"); // older: foreign
    expect(ownership({ exists: true, existingId: "w", owned: claim })).toBe("conflict");
  });

  it("teardown refuses on another account, a missing account id, or any changed identity", () => {
    const st = {
      accountId: "acct-a",
      owned: { queues: { "q-abc": { id: "q1" } }, d1: { name: "abc", id: "d1" }, r2: { name: "abc-assets", id: "r-t" }, workers: { "abc-worker": { id: "w-t" }, "abc-runner": { claimedAt: "2026-10-06T21:00:00Z" } }, containers: { "abc-runner-runnerbox": { id: "c1" } } },
    };
    const same = { queue: { "q-abc": { id: "q1" } }, D1: { abc: { id: "d1" } }, R2: { "abc-assets": { id: "r-t" } }, Worker: { "abc-worker": { id: "w-t" }, "abc-runner": { id: "x", created: "2026-10-06T21:05:00Z" } }, "container application": { "abc-runner-runnerbox": { id: "c1" } } };
    expect(teardownProblems(st, "acct-a", same)).toEqual([]);
    expect(teardownProblems(st, "acct-a", { queue: {}, D1: {}, R2: {}, Worker: {}, "container application": {} })).toEqual([]); // all gone already
    expect(teardownProblems(st, "acct-b", same).join()).toMatch(/belongs to account/);
    expect(teardownProblems({ ...st, accountId: undefined }, "acct-a", same).join()).toMatch(/no Cloudflare account id/);
    for (const [kind, name, seen] of [
      ["queue", "q-abc", { id: "q9" }],
      ["D1", "abc", { id: "d9" }],
      ["R2", "abc-assets", { id: "r-other" }],
      ["Worker", "abc-worker", { id: "w-other" }],
      ["Worker", "abc-runner", { id: "x", created: "2026-01-01T00:00:00Z" }], // created before the claim
      ["container application", "abc-runner-runnerbox", { id: "c9" }],
    ] as const) {
      const obs = structuredClone(same) as Record<string, Record<string, unknown>>;
      obs[kind]![name] = seen;
      expect(teardownProblems(st, "acct-a", obs), `${kind} ${name}`).toEqual([`${kind} ${name} on the account is not the one this deployment recorded`]);
    }
  });

  it("org-scoped names are <name>-o-<12 hex>[-…] only (review M-a)", () => {
    for (const ok of ["abc-o-ee6e69499c15", "abc-o-ee6e69499c15-canonical", "abc-o-ee6e69499c15-orders"]) expect(orgScoped("abc", ok), ok).toBe(true);
    for (const no of ["abc-o-matic", "abc-o-x", "abc-o-ee6e69499c1", "abc-o-EE6E69499C15", "abc-o-ee6e69499c15x", "abco-o-ee6e69499c15", "xabc-o-ee6e69499c15", "abc"]) expect(orgScoped("abc", no), no).toBe(false);
  });
});

describe("bootstrap secrets (review I4)", () => {
  const env = { COMMONFORGE_SESSION_SECRET: "s", COMMONFORGE_RUNNER_JOB_KEY: "r", COMMONFORGE_PREVIEW_KEY: "p", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" };

  it("first deploy: every secret, the deploy token defaulting to CF_API_TOKEN with a warning", () => {
    const { send, warnings } = pickSecrets(WORKER_SECRETS, [], env);
    expect(Object.keys(send).sort()).toEqual([...WORKER_SECRETS].sort());
    expect(send.COMMONFORGE_DEPLOY_API_TOKEN).toBe("t");
    expect(warnings).toHaveLength(1);
  });

  it("rerun: secrets the Worker has are kept, even when the environment holds other values", () => {
    expect(pickSecrets(WORKER_SECRETS, WORKER_SECRETS, { ...env, CF_API_TOKEN: "other", COMMONFORGE_DEPLOY_API_TOKEN: "other" })).toEqual({ send: {}, warnings: [] });
    const { send } = pickSecrets(WORKER_SECRETS, WORKER_SECRETS.filter((k: string) => k !== "COMMONFORGE_PREVIEW_KEY"), env);
    expect(send).toEqual({ COMMONFORGE_PREVIEW_KEY: "p" });
    expect(() => pickSecrets(WORKER_SECRETS, [], { ...env, CF_API_TOKEN: "" })).toThrow(/CF_API_TOKEN is needed/);
  });

  it("--replace-tokens replaces only the tokens (sessions survive) and never defaults the deploy token", () => {
    expect(() => pickSecrets(WORKER_SECRETS, WORKER_SECRETS, env, { replaceTokens: true })).toThrow(/COMMONFORGE_DEPLOY_API_TOKEN is needed/);
    const { send, warnings } = pickSecrets(WORKER_SECRETS, WORKER_SECRETS, { ...env, COMMONFORGE_DEPLOY_API_TOKEN: "d" }, { replaceTokens: true });
    expect(Object.keys(send).sort()).toEqual([...TOKEN_SECRETS].sort());
    expect(send.COMMONFORGE_DEPLOY_API_TOKEN).toBe("d");
    expect(warnings).toEqual([]);
  });

  it("--rotate-keys replaces only the generated keys; both flags replace everything", () => {
    expect(Object.keys(pickSecrets(WORKER_SECRETS, WORKER_SECRETS, env, { rotateKeys: true }).send).sort()).toEqual([...KEY_SECRETS].sort());
    const all = pickSecrets(WORKER_SECRETS, WORKER_SECRETS, { ...env, COMMONFORGE_DEPLOY_API_TOKEN: "d" }, { rotateKeys: true, replaceTokens: true });
    expect(Object.keys(all.send)).toHaveLength(WORKER_SECRETS.length);
  });
});

describe("bootstrap custom domains (--app-domain / --preview-domain)", () => {
  const BASE = "acct.workers.dev";
  const D1 = "44444444-4444-4444-8444-444444444444";
  const templates = () => ({ worker: parseJsonc(prodRaw as string), preview: parseJsonc(prevRaw as string), runner: parseJsonc(runnerRaw as string) });
  /** what deployment.mjs config does: names + domains → URLs → configs */
  const generate = (domains: { appDomain?: string; previewDomain?: string }, production = false) => {
    const base = production
      ? { workerUrl: `https://commonforge-worker.${BASE}`, previewUrl: `https://commonforge-preview.${BASE}` }
      : deploymentNames("cfboot", { base: BASE, d1Id: D1 });
    const n = { ...base, ...domainUrls(base, domains) };
    return { n, out: deploymentConfigs(templates(), n, { production, base: BASE, d1Id: D1, emailMode: production ? "send" : "log", emailFrom: "login@mail.example.org", domains }) };
  };

  it("parses the options; a value is required", () => {
    expect(parseArgs(["config", "cfboot", "--app-domain", "forge.example.org", "--preview-domain", "p.example.net"]).opts).toMatchObject({ "app-domain": "forge.example.org", "preview-domain": "p.example.net" });
    expect(() => parseArgs(["config", "cfboot", "--app-domain"])).toThrow(/needs a value/);
    expect(() => parseArgs(["config", "cfboot", "--preview-domain", "--production"])).toThrow(/needs a value/);
  });

  it("given domains replace the recorded ones, `none` clears, absent keeps (reruns keep them)", () => {
    const rec = { appDomain: "forge.example.org", previewDomain: "p.example.net" };
    expect(pickDomains(rec, {})).toEqual(rec);
    expect(pickDomains({}, {})).toEqual({ appDomain: undefined, previewDomain: undefined });
    expect(pickDomains(rec, { "app-domain": "none" })).toEqual({ appDomain: undefined, previewDomain: "p.example.net" });
    expect(pickDomains(rec, { "app-domain": "New.Example.org" })).toEqual({ appDomain: "new.example.org", previewDomain: "p.example.net" });
    expect(() => pickDomains({}, { "app-domain": "https://forge.example.org" })).toThrow(/bare hostname/);
    expect(() => pickDomains({}, { "app-domain": "forge.example.org/x" })).toThrow(/bare hostname/);
    expect(() => pickDomains({}, { "app-domain": "x.example.org", "preview-domain": "x.example.org" })).toThrow(/must differ/);
    expect(() => pickDomains({ previewDomain: "x.example.org" }, { "app-domain": "x.example.org" })).toThrow(/must differ/);
  });

  it("without domains the URLs stay workers.dev and no routes are added", () => {
    const { n, out } = generate({});
    expect(n.workerUrl).toBe(`https://cfboot-worker.${BASE}`);
    expect(out.worker.routes).toBeUndefined();
    expect(out.preview.routes).toBeUndefined();
    expect(out.worker.vars.COMMONFORGE_APP_URL).toBe(`https://cfboot-worker.${BASE}`);
  });

  it("a deployment on custom domains: routes, app/public/preview URLs and the runner's URLs follow", () => {
    for (const production of [false, true]) {
      const { out } = generate({ appDomain: "forge.example.org", previewDomain: "preview.example.net" }, production);
      expect(out.worker.routes).toEqual([{ pattern: "forge.example.org", custom_domain: true }]);
      expect(out.preview.routes).toEqual([{ pattern: "preview.example.net", custom_domain: true }]);
      expect(out.runner.routes).toBeUndefined();
      expect(out.worker.vars).toMatchObject({ COMMONFORGE_APP_URL: "https://forge.example.org", COMMONFORGE_PUBLIC_URL: "https://forge.example.org", COMMONFORGE_PREVIEW_URL: "https://preview.example.net" });
      expect(out.runner.vars).toMatchObject({ COMMONFORGE_WORKER_URL: "https://forge.example.org", COMMONFORGE_PREVIEW_URL: "https://preview.example.net" });
    }
    // only the app on a custom domain: previews stay on the preview Worker's workers.dev origin
    const { out } = generate({ appDomain: "forge.example.org" });
    expect(out.worker.vars.COMMONFORGE_PREVIEW_URL).toBe(`https://cfboot-preview.${BASE}`);
    expect(out.preview.routes).toBeUndefined();
  });

  it("refuses one origin for the app and previews", () => {
    expect(() => domainUrls({ workerUrl: "https://a.example.org", previewUrl: "https://b.example.org" }, { previewDomain: "a.example.org" })).toThrow(/share an origin/);
  });

  it("review L5: a test deployment may not route production's custom domain or workers.dev host", () => {
    const prodDomains = productionDomains({ COMMONFORGE_LIVE_APP_DOMAIN: "Forge.Example.org" }, { appDomain: "boot.example.org", previewDomain: "bootprev.example.org" });
    expect(prodDomains).toEqual(["forge.example.org", "boot.example.org", "bootprev.example.org"]);
    expect(productionDomains({}, null)).toEqual([]);
    const n = deploymentNames("cfboot", { base: BASE, d1Id: D1 });
    const cfg = (domains: { appDomain?: string; previewDomain?: string }) =>
      deploymentConfigs(templates(), { ...n, ...domainUrls(n, domains) }, { production: false, base: BASE, d1Id: D1, emailMode: "log", domains, productionDomains: prodDomains });
    expect(() => cfg({ appDomain: "forge.example.org" })).toThrow(/--app-domain forge.example.org is production's custom domain/);
    expect(() => cfg({ previewDomain: "boot.example.org" })).toThrow(/--preview-domain boot.example.org is production's/);
    expect(cfg({ appDomain: "test.example.org" }).worker.routes).toEqual([{ pattern: "test.example.org", custom_domain: true }]);
    // the production check now also sees the routes: a route alone on production's workers.dev host is refused
    const routeOnly = { appDomain: `commonforge-worker.${BASE}` };
    expect(() => deploymentConfigs(templates(), n, { production: false, base: BASE, d1Id: D1, emailMode: "log", domains: routeOnly })).toThrow(/contains production/);
    // production's own bootstrap keeps its domains
    expect(() => generate({ appDomain: "forge.example.org" }, true)).not.toThrow();
  });
});

describe("bootstrap sender (review M4)", () => {
  const opts = { emailMode: "send", worker: "cfboot-worker", placeholder: "login@example.com" };
  const deployed = { owned: { workers: { "cfboot-worker": { id: "2026-10-01T00:00:00Z" } } } };

  it("uses --email-from, else the recorded sender", () => {
    expect(pickSender(deployed, "login@mail.example.org", opts)).toEqual({ emailFrom: "login@mail.example.org" });
    expect(pickSender({ ...deployed, emailFrom: "a@mail.example.org" }, undefined, opts)).toEqual({ emailFrom: "a@mail.example.org" });
    expect(pickSender({ ...deployed, emailFrom: "a@mail.example.org" }, "b@mail.example.org", opts)).toEqual({ emailFrom: "b@mail.example.org" });
    expect(pickSender(deployed, undefined, { ...opts, emailMode: "log" })).toEqual({ emailFrom: undefined });
  });

  it("first run (or a deployment that started on the placeholder): a warning, the documented flow", () => {
    for (const st of [{}, { owned: { workers: { "cfboot-worker": { claimedAt: "2026-10-01T00:00:00Z" } } } }, { ...deployed, placeholderSender: true }]) {
      const r = pickSender(st, undefined, opts);
      expect(r.refuse).toBeUndefined();
      expect(r.warn).toMatch(/placeholder login@example.com/);
    }
  });

  it("a deployed Worker whose deployment.json does not record its sender is refused, not switched to the placeholder", () => {
    expect(pickSender(deployed, undefined, opts).refuse).toMatch(/rerun with --email-from/);
    const adopted = { owned: { workers: { "cfboot-worker": { id: "x", adopted: true } } } };
    expect(pickSender(adopted, undefined, opts).refuse).toMatch(/does not record its sender/);
  });
});
