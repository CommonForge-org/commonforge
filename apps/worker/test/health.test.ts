import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { defaultEmailTransport, emailLogAllowed, LogEmailTransport } from "../src/services/email.js";
import type { Env } from "../src/env.js";

const base = { COMMONFORGE_EMAIL_FROM: "login@example.com", EMAIL: {} } as unknown as Env;

describe("@commonforge-org/worker", () => {
  it("GET /health returns ok", async () => {
    const res = await createApp().request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "commonforge-worker" });
  });

  it("review m4/m8: /health names the deployment and email mode; production log mode is not ok", async () => {
    const prod = { ...base, COMMONFORGE_PUBLIC_URL: "https://commonforge-worker.acct.workers.dev", COMMONFORGE_EMAIL_MODE: "send" } as Env;
    expect(await (await createApp().request("/health", {}, prod)).json()).toEqual({ ok: true, service: "commonforge-worker", deployment: "production", emailMode: "send" });
    const bad = await (await createApp().request("/health", {}, { ...prod, COMMONFORGE_EMAIL_MODE: "log" } as Env)).json();
    expect(bad).toMatchObject({ ok: false, deployment: "production", emailMode: "log" });
    const ci = { ...prod, COMMONFORGE_PUBLIC_URL: "https://commonforge-ci-worker.acct.workers.dev", COMMONFORGE_EMAIL_MODE: "log", COMMONFORGE_DEPLOYMENT: "ci", COMMONFORGE_QUEUE_SUFFIX: "-ci" } as Env;
    expect(await (await createApp().request("/health", {}, ci)).json()).toEqual({ ok: true, service: "commonforge-worker", deployment: "ci", emailMode: "log" });
  });

  it("review m4: log-mode email is refused on a deployed non-CI Worker (no link is written)", async () => {
    const prod = { ...base, COMMONFORGE_PUBLIC_URL: "https://commonforge-worker.acct.workers.dev", COMMONFORGE_EMAIL_MODE: "log" } as Env;
    expect(emailLogAllowed(prod)).toBe(false);
    await expect(defaultEmailTransport(prod).sendMagicLink({ to: "a@b.c", link: "https://x/auth/verify?token=cfm_x", expiresAt: "t" })).rejects.toMatchObject({ code: "email_log_refused" });
    expect(defaultEmailTransport({ ...prod, COMMONFORGE_DEPLOYMENT: "ci", COMMONFORGE_QUEUE_SUFFIX: "-ci" } as Env)).toBeInstanceOf(LogEmailTransport);
    expect(defaultEmailTransport({ ...prod, COMMONFORGE_PUBLIC_URL: "http://localhost:8787" } as Env)).toBeInstanceOf(LogEmailTransport);
  });

  it("Task 24 (review I1): log mode needs a deployment name AND its own queue suffix; production can never satisfy it", async () => {
    const boot = { ...base, COMMONFORGE_PUBLIC_URL: "https://cfboot-worker.acct.workers.dev", COMMONFORGE_EMAIL_MODE: "log", COMMONFORGE_DEPLOYMENT: "cfboot", COMMONFORGE_QUEUE_SUFFIX: "-cfboot" } as Env;
    expect(emailLogAllowed(boot)).toBe(true);
    expect(await (await createApp().request("/health", {}, boot)).json()).toEqual({ ok: true, service: "commonforge-worker", deployment: "cfboot", emailMode: "log" });
    // production: no queue suffix, so a stray COMMONFORGE_DEPLOYMENT var or secret never enables log mode
    const prod = { ...base, COMMONFORGE_PUBLIC_URL: "https://commonforge-worker.acct.workers.dev", COMMONFORGE_EMAIL_MODE: "log" } as Env;
    for (const d of ["prod", "cfboot", "ci", "staging", "production"]) {
      expect(emailLogAllowed({ ...prod, COMMONFORGE_DEPLOYMENT: d } as Env)).toBe(false);
      expect(await (await createApp().request("/health", {}, { ...prod, COMMONFORGE_DEPLOYMENT: d } as Env)).json()).toMatchObject({ ok: false, emailMode: "log" });
    }
    // a mismatched suffix
    expect(emailLogAllowed({ ...boot, COMMONFORGE_QUEUE_SUFFIX: "-ci" } as Env)).toBe(false);
    expect(emailLogAllowed({ ...boot, COMMONFORGE_QUEUE_SUFFIX: "cfboot" } as Env)).toBe(false);
    // reserved words and non-names, even with the matching suffix; exact match (no trim/lowercase)
    for (const d of ["production", "prod", "live", "main", "staging", "commonforge", "dev", "cfapp", "cfci", "Cfboot", " cfboot", "cf-boot", "", "a"]) {
      expect(emailLogAllowed({ ...boot, COMMONFORGE_DEPLOYMENT: d, COMMONFORGE_QUEUE_SUFFIX: `-${d}` } as Env)).toBe(false);
    }
  });
});
