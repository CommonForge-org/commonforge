// Pure parts of scripts/bootstrap/deployment.mjs (no fs/network): deployment-name rules, argument
// parsing and the secret selection. Imported by deployment.mjs and by the worker unit tests
// (apps/worker/test/bootstrap-args.test.ts).
import { assertNoProduction, buildFromSources } from "../ci-config-core.mjs";
import { checkDomain, customDomain } from "../live-config-core.mjs";

/** A deployment name: also the release-Worker prefix (deploy-targets.ts allows 2-16), hence no `-`. */
export const NAME_RE = /^[a-z][a-z0-9]{2,15}$/;
/** Production, CI and words that read as production (exact). */
export const RESERVED = new Set(["ci", "cfci", "cfapp", "dev", "prod", "production", "live", "main", "staging", "commonforge"]);

/** Why `name` may not be a non-production deployment (null: it may). */
export function nameProblem(name) {
  if (typeof name !== "string" || !NAME_RE.test(name)) return "a deployment name is 3-16 lowercase letters and digits, starting with a letter (it is also the release Worker prefix)";
  if (name.startsWith("commonforge")) return "names starting with commonforge belong to production and CI";
  if (RESERVED.has(name)) return `${name} is reserved (production or CI)`;
  return null;
}

const BOOLEAN = new Set(["--production", "--adopt", "--yes", "--json", "--expect-empty", "--owned", "--rotate-keys", "--replace-tokens"]);
const VALUED = new Set(["--email-mode", "--email-from", "--admin-emails", "--app-domain", "--preview-domain", "--out-dir", "--kind", "--resource"]);

/**
 * argv (after `node deployment.mjs`) → { cmd, name, flags, opts }. Flags come only from the option
 * list: a positional that starts with `-` is refused, never read as a name or a flag (review I2),
 * so `names --production` is production with no name and `names -- --production` is refused.
 */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = new Set();
  const opts = {};
  let name;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (BOOLEAN.has(a)) flags.add(a);
    else if (VALUED.has(a)) {
      const v = rest[++i];
      if (v === undefined || v.startsWith("-")) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (name !== undefined) throw new Error(`unexpected argument ${a}`);
    else name = a;
  }
  if (flags.has("--production")) {
    if (name !== undefined && name !== "commonforge") throw new Error("--production deploys the canonical production names; pass no name");
    name = "commonforge";
  } else if (name !== undefined) {
    const why = nameProblem(name);
    if (why) throw new Error(`refusing deployment name "${name}": ${why}`);
  }
  return { cmd, name, flags, opts };
}

/** The Worker secrets each deployment script needs: generated keys, then operator-supplied tokens. */
export const KEY_SECRETS = ["COMMONFORGE_SESSION_SECRET", "COMMONFORGE_RUNNER_JOB_KEY", "COMMONFORGE_PREVIEW_KEY"];
export const TOKEN_SECRETS = ["CF_ACCOUNT_ID", "CF_API_TOKEN", "COMMONFORGE_DEPLOY_API_TOKEN"];
export const WORKER_SECRETS = [...KEY_SECRETS, ...TOKEN_SECRETS];
export const PREVIEW_SECRETS = ["COMMONFORGE_PREVIEW_KEY"];

/**
 * Which secrets to send (review I4, mirrors deploy-ci.sh): only the names the Worker does not have
 * yet. `rotateKeys` re-sends the generated keys (session, runner job, preview: everyone is signed
 * out); `replaceTokens` re-sends CF_ACCOUNT_ID / CF_API_TOKEN / COMMONFORGE_DEPLOY_API_TOKEN from
 * the environment (sessions survive). `COMMONFORGE_DEPLOY_API_TOKEN`, when MISSING on the Worker and
 * not in env, defaults to CF_API_TOKEN with a warning; when replacing tokens it must be given
 * explicitly, so a dedicated token is never replaced implicitly. Returns { send, warnings } or
 * throws naming a value that is needed but absent.
 */
export function pickSecrets(wanted, have, env, { rotateKeys = false, replaceTokens = false } = {}) {
  const haveSet = new Set(have);
  const send = {};
  const warnings = [];
  for (const k of wanted) {
    const forced = (rotateKeys && KEY_SECRETS.includes(k)) || (replaceTokens && TOKEN_SECRETS.includes(k));
    if (!forced && haveSet.has(k)) continue;
    let v = env[k];
    if (!v && k === "COMMONFORGE_DEPLOY_API_TOKEN" && !forced && env.CF_API_TOKEN) {
      v = env.CF_API_TOKEN;
      warnings.push("COMMONFORGE_DEPLOY_API_TOKEN is not set: installing CF_API_TOKEN in its place. Give it a dedicated token (Workers Scripts + Workers KV Storage: Edit), ideally on a separate account.");
    }
    if (!v) throw new Error(`${k} is needed (${forced ? "it is being replaced" : "the Worker does not have it yet"}) but is not set in the environment`);
    send[k] = v;
  }
  return { send, warnings };
}

/**
 * What the bootstrap may do with one account resource (review I3, I3a). `exists`; `existingId`: the
 * resource's identity on the account (queue id, D1 uuid, R2 creation date, Worker creation time,
 * container application id); `existingCreated`: its creation time; `owned`: the record in
 * deployment.json (`{ id?, claimedAt?, adopted? }`) or undefined.
 *   - reuse only when the recorded identity equals the account's;
 *   - a Worker / container application the state claimed but has not identified yet (the deploy
 *     that creates it did not finish) is reused only if it was created AFTER the claim;
 *   - anything else that exists is someone else's: refused unless `adopt`.
 *   → "create" | "reuse" | "adopt" | "conflict"
 */
export function ownership({ exists, existingId, existingCreated, owned, adopt }) {
  if (!exists) return "create";
  if (owned?.id !== undefined && existingId !== undefined && owned.id === existingId) return "reuse";
  if (owned && owned.id === undefined && owned.claimedAt && existingCreated && Date.parse(existingCreated) >= Date.parse(owned.claimedAt)) return "reuse";
  return adopt ? "adopt" : "conflict";
}

/**
 * Before teardown deletes anything (review I3a): the state must belong to this account, and every
 * recorded resource that exists under its name must still carry the recorded identity. Otherwise the
 * resource may be someone else's (a state reused on another account, or a resource replaced since),
 * and nothing is deleted. `observed[kind][name]` = { id, created } as the account reports it.
 * Returns a list of problems (empty: safe to delete).
 */
export function teardownProblems(state, accountId, observed) {
  const problems = [];
  if (!state.accountId) problems.push("the state records no Cloudflare account id (made by an older bootstrap): refusing to guess");
  else if (state.accountId !== accountId) problems.push(`the state belongs to account ${state.accountId.slice(0, 6)}…, not the current ${String(accountId).slice(0, 6)}…`);
  const o = state.owned ?? {};
  const records = [
    ...Object.entries(o.queues ?? {}).map(([n, r]) => ["queue", n, r]),
    ...(o.d1 ? [["D1", o.d1.name, o.d1]] : []),
    ...(o.r2 ? [["R2", o.r2.name, o.r2]] : []),
    ...Object.entries(o.workers ?? {}).map(([n, r]) => ["Worker", n, r]),
    ...Object.entries(o.containers ?? {}).map(([n, r]) => ["container application", n, r]),
  ];
  for (const [kind, name, rec] of records) {
    const seen = observed?.[kind]?.[name];
    if (!seen) continue; // gone already: nothing to delete
    if (rec.id !== undefined ? rec.id !== seen.id : !(rec.claimedAt && seen.created && Date.parse(seen.created) >= Date.parse(rec.claimedAt)))
      problems.push(`${kind} ${name} on the account is not the one this deployment recorded`);
  }
  return problems;
}

/** Resources only a deployment's own Worker creates are named <name>-o-<12 hex org id>[-…] (M-a). */
export function orgScoped(name, resourceName) {
  return new RegExp(`^${name}-o-[0-9a-f]{12}(-|$)`).test(resourceName);
}

/**
 * Custom domains (--app-domain / --preview-domain): a hostname sets one, `none` clears it, and an
 * absent option keeps what deployment.json recorded, so a rerun keeps the deployment's domains.
 * → { appDomain, previewDomain } (each a hostname or undefined).
 */
export function pickDomains(recorded, opts) {
  const one = (flag, key) => {
    const v = opts[flag];
    if (v === undefined) return recorded?.[key] || undefined;
    if (v === "none") return undefined;
    return checkDomain(`--${flag}`, v);
  };
  const d = { appDomain: one("app-domain", "appDomain"), previewDomain: one("preview-domain", "previewDomain") };
  if (d.appDomain && d.appDomain === d.previewDomain) throw new Error("--app-domain and --preview-domain must differ: previews never share the app's origin");
  return d;
}

/**
 * The app and preview URLs of a deployment with names `n` (workers.dev defaults) and custom
 * `domains`; refuses one origin for both (previews run untrusted site code).
 */
export function domainUrls(n, domains) {
  const workerUrl = domains.appDomain ? `https://${domains.appDomain}` : n.workerUrl;
  const previewUrl = domains.previewDomain ? `https://${domains.previewDomain}` : n.previewUrl;
  // before the probe, the workers.dev host is the placeholder `<subdomain>.workers.dev`, which URL rejects
  const origin = (u) => { try { return new URL(u).origin; } catch { return u; } };
  if (origin(workerUrl) === origin(previewUrl)) throw new Error(`the app and preview URLs share an origin (${workerUrl})`);
  return { workerUrl, previewUrl };
}

/** Generated configs + domains → custom-domain routes on the worker / preview Worker. */
export function withDomainRoutes(out, domains) {
  if (domains.appDomain) out.worker.routes = customDomain(domains.appDomain);
  if (domains.previewDomain) out.preview.routes = customDomain(domains.previewDomain);
  return out;
}

/**
 * The sender of a deployment's config (review M4): `--email-from` when given, else the one
 * deployment.json recorded. Without either, send mode would deploy the template's placeholder
 * sender. That is allowed (with a warning) on a deployment's first run, and on reruns of a
 * deployment that knowingly started with it (`st.placeholderSender`), so the documented flow
 * "deploy, onboard a sending domain, rerun with --email-from" works. A deployment whose Worker is
 * already deployed with a sender this state does not know (deployment.json written before the sender
 * was recorded, or an adopted Worker) is refused: its real sender would be silently replaced.
 * → { emailFrom } | { emailFrom: undefined, warn } | { refuse }
 */
export function pickSender(st, given, { emailMode, worker, placeholder }) {
  const emailFrom = given || st?.emailFrom || undefined;
  if (emailFrom || emailMode !== "send") return { emailFrom };
  const deployed = st?.owned?.workers?.[worker]?.id !== undefined;
  if (deployed && !st.placeholderSender)
    return { refuse: `${worker} is already deployed and its deployment.json does not record its sender (written by an earlier version of this script): rerun with --email-from <the address it sends sign-in email from> once to record it; without it the sender would become the template's placeholder ${placeholder} and sign-in email would stop` };
  return { emailFrom: undefined, warn: `no --email-from: the sender is the template's placeholder ${placeholder}, so sign-in email will fail until you onboard a domain for Email Sending and rerun with --email-from (see the next steps)` };
}

/**
 * Production's custom domains as far as this machine knows them (review L5): the live settings in
 * the environment (COMMONFORGE_LIVE_APP_DOMAIN / _PREVIEW_DOMAIN, as scripts/deploy-live.sh uses) and
 * the domains a `--production` bootstrap recorded. → lowercased hostnames.
 */
export function productionDomains(env, productionState) {
  return [env.COMMONFORGE_LIVE_APP_DOMAIN, env.COMMONFORGE_LIVE_PREVIEW_DOMAIN, productionState?.appDomain, productionState?.previewDomain]
    .filter((d) => typeof d === "string" && d)
    .map((d) => d.toLowerCase());
}

/**
 * The three wrangler configs of a bootstrap deployment (`deployment.mjs config`): `prod` the parsed
 * templates, `n` its names with URLs (resolveNames, custom domains applied). Production keeps the
 * template's names with this account's D1 id and URLs; any other deployment is derived by
 * buildFromSources (which refuses production names). Custom domains add Custom Domain routes; on a
 * non-production deployment they are checked like every other value (a route on a production
 * workers.dev host is refused) and may not be one of `productionDomains`: a Custom Domain route
 * would take the hostname over from production's Worker.
 */
export function deploymentConfigs(prod, n, { production, base, d1Id, emailMode, emailFrom, adminEmails, domains = {}, productionDomains = [] }) {
  let out;
  if (production) {
    if (emailMode !== "send") throw new Error("production sends sign-in email (COMMONFORGE_EMAIL_MODE=send); log mode is refused");
    out = structuredClone(prod);
    out.worker.d1_databases[0].database_id = d1Id;
    Object.assign(out.worker.vars, { COMMONFORGE_APP_URL: n.workerUrl, COMMONFORGE_PUBLIC_URL: n.workerUrl, COMMONFORGE_PREVIEW_URL: n.previewUrl, COMMONFORGE_EMAIL_MODE: "send" });
    if (emailFrom) {
      out.worker.vars.COMMONFORGE_EMAIL_FROM = emailFrom;
      out.worker.send_email = out.worker.send_email.map((b) => ({ ...b, allowed_sender_addresses: [emailFrom] }));
    }
    if (adminEmails) out.worker.vars.COMMONFORGE_ADMIN_EMAILS = adminEmails;
    Object.assign(out.runner.vars, { COMMONFORGE_WORKER_URL: n.workerUrl, COMMONFORGE_PREVIEW_URL: n.previewUrl });
    return withDomainRoutes(out, domains);
  }
  for (const [flag, d] of [["--app-domain", domains.appDomain], ["--preview-domain", domains.previewDomain]])
    if (d && productionDomains.includes(d.toLowerCase())) throw new Error(`${flag} ${d} is production's custom domain: a test deployment's route would take it over`);
  out = withDomainRoutes(buildFromSources(prod, base, n, { emailMode, emailFrom, adminEmails }), domains);
  assertNoProduction(prod, base, out, n.namespacePrefix);
  return out;
}
