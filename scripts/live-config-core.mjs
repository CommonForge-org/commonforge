// Pure core of scripts/live-config.mjs (no fs), imported by the generator and by the worker unit test
// (apps/worker/test/live-config.test.ts).
//
// The committed apps/worker/wrangler*.jsonc are generic templates (what `wrangler dev`, the tests and
// scripts/bootstrap.sh start from): their sender address and D1 database id are placeholders. A
// deployment's own values live outside the repository (apps/worker/.dev.vars, or the environment)
// and are written into git-ignored wrangler.deploy-live*.jsonc at deploy time:
//
//   COMMONFORGE_EMAIL_FROM            sign-in sender: the var and the send_email allowlist
//   COMMONFORGE_D1_DATABASE_ID        the production D1 database (wrangler d1 list)
//   COMMONFORGE_LIVE_BASE             the account's workers.dev host (<subdomain>.workers.dev)
//   COMMONFORGE_LIVE_APP_URL          optional: the app's origin (default https://<worker>.<base>,
//                                     or https://<COMMONFORGE_LIVE_APP_DOMAIN> when that is set)
//   COMMONFORGE_LIVE_PREVIEW_URL      optional: the preview Worker's origin, never the app's
//                                     (default https://<preview>.<base>, or its custom domain)
//   COMMONFORGE_LIVE_APP_DOMAIN       optional: a custom domain routed to the app Worker
//   COMMONFORGE_LIVE_PREVIEW_DOMAIN   optional: a custom domain routed to the preview Worker
//
// The URLs are not written into the configs: scripts/deploy-live.sh passes them as --var, as before.

/** The committed templates' stand-ins; a live config may never carry them. */
export const PLACEHOLDERS = { emailFrom: "login@example.com", d1Id: "00000000-0000-0000-0000-000000000000" };

export const LIVE_FILES = { worker: "wrangler.deploy-live.jsonc", preview: "wrangler.deploy-live-preview.jsonc" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/** an https origin (no path, query or credentials); returns it without a trailing slash */
function origin(name, raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL: ${raw}`);
  }
  if (u.protocol !== "https:") throw new Error(`${name} must be https: ${raw}`);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) throw new Error(`${name} must be an origin only (https://host), not ${raw}`);
  return u.origin;
}

/** a custom domain setting: undefined when unset; throws unless a bare hostname (lowercased) */
export function checkDomain(name, raw) {
  if (!raw) return undefined;
  if (!HOST.test(raw)) throw new Error(`${name} must be a bare hostname (e.g. forge.example.org), not ${raw}`);
  return raw.toLowerCase();
}

/**
 * env → the live deployment's settings; throws on anything missing, malformed or still a
 * placeholder. `template` is the parsed production configs ({ worker, preview }) for the Worker names.
 * `urlsOnly`: only the app and preview URLs are needed (deploying the runner alone), so the sender
 * and D1 id are neither required nor returned.
 */
export function liveSettings(env, template, { urlsOnly = false } = {}) {
  const missing = [];
  const emailFrom = env.COMMONFORGE_EMAIL_FROM ?? "";
  const d1Id = env.COMMONFORGE_D1_DATABASE_ID ?? "";
  if (!emailFrom && !urlsOnly) missing.push("COMMONFORGE_EMAIL_FROM");
  if (!d1Id && !urlsOnly) missing.push("COMMONFORGE_D1_DATABASE_ID");
  const appDomain = checkDomain("COMMONFORGE_LIVE_APP_DOMAIN", env.COMMONFORGE_LIVE_APP_DOMAIN);
  const previewDomain = checkDomain("COMMONFORGE_LIVE_PREVIEW_DOMAIN", env.COMMONFORGE_LIVE_PREVIEW_DOMAIN);
  const base = env.COMMONFORGE_LIVE_BASE ?? "";
  const needBase = (!env.COMMONFORGE_LIVE_APP_URL && !appDomain) || (!env.COMMONFORGE_LIVE_PREVIEW_URL && !previewDomain);
  if (needBase && !base) missing.push("COMMONFORGE_LIVE_BASE");
  if (missing.length) throw new Error(`not set (apps/worker/.dev.vars or the environment): ${missing.join(", ")}`);

  if (!urlsOnly) {
    if (emailFrom === PLACEHOLDERS.emailFrom || !EMAIL.test(emailFrom)) throw new Error(`COMMONFORGE_EMAIL_FROM must be the sender address onboarded for Email Sending, not ${emailFrom}`);
    if (d1Id === PLACEHOLDERS.d1Id || !UUID.test(d1Id)) throw new Error(`COMMONFORGE_D1_DATABASE_ID must be the production D1 database's id (wrangler d1 list), not ${d1Id}`);
    if (env.COMMONFORGE_CI_D1_DATABASE_ID && env.COMMONFORGE_CI_D1_DATABASE_ID.toLowerCase() === d1Id.toLowerCase()) throw new Error("COMMONFORGE_D1_DATABASE_ID equals COMMONFORGE_CI_D1_DATABASE_ID: production and CI must not share a database");
  }
  if (base && !HOST.test(base)) throw new Error(`COMMONFORGE_LIVE_BASE must be a hostname such as <subdomain>.workers.dev, not ${base}`);

  const appUrl = origin("COMMONFORGE_LIVE_APP_URL", env.COMMONFORGE_LIVE_APP_URL || (appDomain ? `https://${appDomain}` : `https://${template.worker.name}.${base}`));
  const previewUrl = origin("COMMONFORGE_LIVE_PREVIEW_URL", env.COMMONFORGE_LIVE_PREVIEW_URL || (previewDomain ? `https://${previewDomain}` : `https://${template.preview.name}.${base}`));
  if (appDomain && new URL(appUrl).hostname !== appDomain) throw new Error(`COMMONFORGE_LIVE_APP_URL (${appUrl}) is not on COMMONFORGE_LIVE_APP_DOMAIN (${appDomain})`);
  if (previewDomain && new URL(previewUrl).hostname !== previewDomain) throw new Error(`COMMONFORGE_LIVE_PREVIEW_URL (${previewUrl}) is not on COMMONFORGE_LIVE_PREVIEW_DOMAIN (${previewDomain})`);
  // previews run untrusted site code: never on the app's origin (src/services/previews.ts refuses it too)
  if (appUrl === previewUrl) throw new Error(`the app and preview URLs share an origin (${appUrl}); previews need their own`);
  if (appDomain && appDomain === previewDomain) throw new Error("COMMONFORGE_LIVE_APP_DOMAIN and COMMONFORGE_LIVE_PREVIEW_DOMAIN must differ");
  if (urlsOnly) return { base, appUrl, previewUrl, appDomain, previewDomain };
  return { emailFrom, d1Id, base, appUrl, previewUrl, appDomain, previewDomain };
}

/** wrangler `routes` serving a Worker on a custom domain (the zone must be on the same account) */
export const customDomain = (host) => [{ pattern: host, custom_domain: true }];

/**
 * The production templates ({ worker, preview }) + settings → the live configs. Only the sender, the
 * send_email allowlist, the D1 id and (when asked) custom-domain routes change.
 */
export function buildLive(template, s) {
  const worker = structuredClone(template.worker);
  const preview = structuredClone(template.preview);
  if (worker.vars?.COMMONFORGE_EMAIL_MODE !== "send") throw new Error("wrangler.jsonc: production COMMONFORGE_EMAIL_MODE must be send");
  if (worker.d1_databases?.length !== 1) throw new Error("wrangler.jsonc: expected exactly one D1 database");
  if (worker.routes || preview.routes) throw new Error("the templates must not carry routes; set COMMONFORGE_LIVE_*_DOMAIN instead");
  worker.d1_databases[0].database_id = s.d1Id;
  worker.vars.COMMONFORGE_EMAIL_FROM = s.emailFrom;
  worker.send_email = (worker.send_email ?? []).map((b) => ({ ...b, allowed_sender_addresses: [s.emailFrom] }));
  if (s.appDomain) worker.routes = customDomain(s.appDomain);
  if (s.previewDomain) preview.routes = customDomain(s.previewDomain);
  return { worker, preview };
}

const HEADER = "// GENERATED by scripts/live-config.mjs from the wrangler templates and this deployment's settings.\n// Git-ignored; do not edit or commit. Rerun the script (scripts/deploy-live.sh does).\n";

export function renderLive(live) {
  return Object.fromEntries(Object.entries(LIVE_FILES).map(([k, f]) => [f, HEADER + JSON.stringify(live[k], null, 2) + "\n"]));
}
