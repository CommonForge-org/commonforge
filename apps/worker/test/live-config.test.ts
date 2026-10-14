/**
 * scripts/live-config.mjs: the live (production) configs are the committed templates plus the
 * deployment's own sender, D1 id and optional custom domains, all from the environment; anything
 * missing or still a placeholder is refused, and previews never share the app's origin.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error -- Vite `?raw` imports (the files' text)
import prodRaw from "../wrangler.jsonc?raw";
// @ts-expect-error -- Vite `?raw` import
import prevRaw from "../wrangler.preview.jsonc?raw";
// @ts-expect-error -- plain JS module outside the package
import { parseJsonc } from "../../../scripts/ci-config-core.mjs";
// @ts-expect-error -- plain JS module outside the package
import { PLACEHOLDERS, buildLive, liveSettings, renderLive } from "../../../scripts/live-config-core.mjs";

const template = () => ({ worker: parseJsonc(prodRaw as string), preview: parseJsonc(prevRaw as string) });
const ENV = { COMMONFORGE_EMAIL_FROM: "login@mail.example.org", COMMONFORGE_D1_DATABASE_ID: "33333333-3333-4333-8333-333333333333", COMMONFORGE_LIVE_BASE: "acct.workers.dev" };
const settings = (env: Record<string, string | undefined>) => liveSettings(env, template());

describe("live deployment config", () => {
  it("the committed template carries only placeholders", () => {
    const t = template();
    expect(t.worker.d1_databases[0].database_id).toBe(PLACEHOLDERS.d1Id);
    expect(t.worker.vars.COMMONFORGE_EMAIL_FROM).toBe(PLACEHOLDERS.emailFrom);
    expect(t.worker.send_email[0].allowed_sender_addresses).toEqual([PLACEHOLDERS.emailFrom]);
    expect(t.worker.routes).toBeUndefined();
    expect(t.preview.routes).toBeUndefined();
  });

  it("only the sender, its allowlist and the D1 id change; URLs default to workers.dev", () => {
    const s = settings(ENV);
    expect(s).toMatchObject({ appUrl: "https://commonforge-worker.acct.workers.dev", previewUrl: "https://commonforge-preview.acct.workers.dev" });
    const live = buildLive(template(), s);
    const want = template();
    want.worker.d1_databases[0].database_id = ENV.COMMONFORGE_D1_DATABASE_ID;
    want.worker.vars.COMMONFORGE_EMAIL_FROM = ENV.COMMONFORGE_EMAIL_FROM;
    want.worker.send_email[0].allowed_sender_addresses = [ENV.COMMONFORGE_EMAIL_FROM];
    expect(live).toEqual(want);
    const files = renderLive(live) as Record<string, string>;
    expect(Object.keys(files).sort()).toEqual(["wrangler.deploy-live-preview.jsonc", "wrangler.deploy-live.jsonc"]);
    expect(parseJsonc(files["wrangler.deploy-live.jsonc"]!)).toEqual(want.worker);
  });

  it("refuses missing, malformed or placeholder values", () => {
    for (const k of Object.keys(ENV)) expect(() => settings({ ...ENV, [k]: undefined })).toThrow(new RegExp(k));
    expect(() => settings({ ...ENV, COMMONFORGE_EMAIL_FROM: PLACEHOLDERS.emailFrom })).toThrow(/COMMONFORGE_EMAIL_FROM/);
    expect(() => settings({ ...ENV, COMMONFORGE_D1_DATABASE_ID: PLACEHOLDERS.d1Id })).toThrow(/COMMONFORGE_D1_DATABASE_ID/);
    expect(() => settings({ ...ENV, COMMONFORGE_D1_DATABASE_ID: "commonforge-dev" })).toThrow(/COMMONFORGE_D1_DATABASE_ID/);
    expect(() => settings({ ...ENV, COMMONFORGE_CI_D1_DATABASE_ID: ENV.COMMONFORGE_D1_DATABASE_ID })).toThrow(/must not share a database/);
    expect(() => settings({ ...ENV, COMMONFORGE_CI_D1_DATABASE_ID: "44444444-4444-4444-8444-444444444444" })).not.toThrow();
    expect(() => settings({ ...ENV, COMMONFORGE_LIVE_BASE: "https://acct.workers.dev" })).toThrow(/COMMONFORGE_LIVE_BASE/);
  });

  it("review L3: the runner alone needs only the URL settings", () => {
    const urlsOnly = (env: Record<string, string | undefined>) => liveSettings(env, template(), { urlsOnly: true });
    const s = urlsOnly({ COMMONFORGE_LIVE_BASE: "acct.workers.dev" });
    expect(s).toEqual({ base: "acct.workers.dev", appUrl: "https://commonforge-worker.acct.workers.dev", previewUrl: "https://commonforge-preview.acct.workers.dev", appDomain: undefined, previewDomain: undefined });
    expect(s).not.toHaveProperty("d1Id");
    expect(urlsOnly({ COMMONFORGE_LIVE_APP_DOMAIN: "forge.example.org", COMMONFORGE_LIVE_PREVIEW_DOMAIN: "preview.example.net" })).toMatchObject({ appUrl: "https://forge.example.org", previewUrl: "https://preview.example.net" });
    // the URL rules still hold
    expect(() => urlsOnly({})).toThrow(/COMMONFORGE_LIVE_BASE/);
    expect(() => urlsOnly({ COMMONFORGE_LIVE_BASE: "acct.workers.dev", COMMONFORGE_LIVE_PREVIEW_URL: "https://commonforge-worker.acct.workers.dev" })).toThrow(/share an origin/);
  });

  it("custom domains: routes on the Workers, the URLs follow, and the base is optional", () => {
    const env = { ...ENV, COMMONFORGE_LIVE_BASE: undefined, COMMONFORGE_LIVE_APP_DOMAIN: "forge.example.org", COMMONFORGE_LIVE_PREVIEW_DOMAIN: "preview.example.net" };
    const s = settings(env);
    expect(s).toMatchObject({ appUrl: "https://forge.example.org", previewUrl: "https://preview.example.net" });
    const live = buildLive(template(), s);
    expect(live.worker.routes).toEqual([{ pattern: "forge.example.org", custom_domain: true }]);
    expect(live.preview.routes).toEqual([{ pattern: "preview.example.net", custom_domain: true }]);
    // only the app on a custom domain: the preview stays on workers.dev (so the base is needed)
    expect(() => settings({ ...env, COMMONFORGE_LIVE_PREVIEW_DOMAIN: undefined })).toThrow(/COMMONFORGE_LIVE_BASE/);
    expect(settings({ ...ENV, COMMONFORGE_LIVE_APP_DOMAIN: "forge.example.org" }).previewUrl).toBe("https://commonforge-preview.acct.workers.dev");
    expect(buildLive(template(), settings({ ...ENV, COMMONFORGE_LIVE_APP_URL: "https://forge.example.org/" })).worker.routes).toBeUndefined();
    expect(settings({ ...ENV, COMMONFORGE_LIVE_APP_URL: "https://forge.example.org/" }).appUrl).toBe("https://forge.example.org");
  });

  it("refuses a shared app/preview origin, non-https or non-origin URLs, and URLs off their domain", () => {
    expect(() => settings({ ...ENV, COMMONFORGE_LIVE_APP_URL: "https://x.example.org", COMMONFORGE_LIVE_PREVIEW_URL: "https://x.example.org/" })).toThrow(/share an origin/);
    expect(() => settings({ ...ENV, COMMONFORGE_LIVE_APP_DOMAIN: "x.example.org", COMMONFORGE_LIVE_PREVIEW_DOMAIN: "x.example.org" })).toThrow(/share an origin|must differ/);
    expect(() => settings({ ...ENV, COMMONFORGE_LIVE_APP_URL: "http://forge.example.org" })).toThrow(/https/);
    expect(() => settings({ ...ENV, COMMONFORGE_LIVE_PREVIEW_URL: "https://p.example.org/p" })).toThrow(/origin only/);
    expect(() => settings({ ...ENV, COMMONFORGE_LIVE_APP_DOMAIN: "forge.example.org", COMMONFORGE_LIVE_APP_URL: "https://other.example.org" })).toThrow(/not on COMMONFORGE_LIVE_APP_DOMAIN/);
    expect(() => settings({ ...ENV, COMMONFORGE_LIVE_APP_DOMAIN: "https://forge.example.org" })).toThrow(/bare hostname/);
  });
});
