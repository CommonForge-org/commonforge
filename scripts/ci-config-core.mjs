// Pure core of scripts/ci-config.mjs (no fs), imported by the generator, by scripts/bootstrap/ and by
// the worker unit test (apps/worker/test/ci-config.test.ts).
//
// The CI deployment (owner-approved, Task 23) runs on the same Cloudflare account as production,
// so every account-wide name is replaced: Workers commonforge-ci-{worker,preview,runner}, D1
// `commonforge-ci`, queues `<name>-ci`, R2 `commonforge-assets-ci`, Artifacts namespace prefix
// `commonforge-ci`, release Worker prefix `cfci`. It runs COMMONFORGE_EMAIL_MODE=log with COMMONFORGE_DEPLOYMENT=ci (the Worker allows log mode
// only on a named non-production deployment; scripts/bootstrap.sh test deployments may use it too).
// Its account-specific values (workers.dev host, D1 id, sender) are not committed: ciSettings reads
// them from the environment and the generated configs are git-ignored (scripts/deploy-ci.sh).
//
// A top-level key (or nested queue / container key) this file does not know fails the run: a new
// binding in the production config must get an explicit CI mapping here, never silently point CI
// at a production resource. After mapping, no string in a CI config may equal a production
// resource name, or contain a production URL / hostname / D1 id / namespace prefix.

import { PLACEHOLDERS } from "./live-config-core.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `base`: the account's workers.dev host; `d1Id`: the commonforge-ci database (scripts/deploy-ci.sh setup) */
export function ciNames(base, d1Id) {
  const CI = {
    suffix: "-ci",
    worker: "commonforge-ci-worker",
    preview: "commonforge-ci-preview",
    runner: "commonforge-ci-runner",
    d1: { database_name: "commonforge-ci", database_id: d1Id },
    bucket: "commonforge-assets-ci",
    namespacePrefix: "commonforge-ci",
    deployPrefix: "cfci",
    deployment: "ci",
  };
  CI.workerUrl = `https://${CI.worker}.${base}`;
  CI.previewUrl = `https://${CI.preview}.${base}`;
  return CI;
}

/**
 * env → the CI generator's inputs; throws on anything missing or malformed.
 *   COMMONFORGE_LIVE_BASE          the account's workers.dev host (<subdomain>.workers.dev)
 *   COMMONFORGE_CI_D1_DATABASE_ID  the commonforge-ci D1 database's id
 *   COMMONFORGE_EMAIL_FROM         the sender (CI logs sign-in links, but its send_email binding
 *                                  must still name an onboarded address)
 *   COMMONFORGE_D1_DATABASE_ID     production's D1 id: required, so CI's id can never be production's
 *                                  (the leak check refuses it anywhere in the generated configs)
 */
export function ciSettings(env) {
  const need = ["COMMONFORGE_LIVE_BASE", "COMMONFORGE_CI_D1_DATABASE_ID", "COMMONFORGE_EMAIL_FROM", "COMMONFORGE_D1_DATABASE_ID"];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) throw new Error(`not set (apps/worker/.dev.vars or the environment): ${missing.join(", ")}`);
  const base = env.COMMONFORGE_LIVE_BASE;
  const d1Id = env.COMMONFORGE_CI_D1_DATABASE_ID;
  const emailFrom = env.COMMONFORGE_EMAIL_FROM;
  const prodD1Id = env.COMMONFORGE_D1_DATABASE_ID;
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(base)) throw new Error(`COMMONFORGE_LIVE_BASE must be a hostname such as <subdomain>.workers.dev, not ${base}`);
  if (!UUID.test(d1Id) || d1Id === PLACEHOLDERS.d1Id) throw new Error(`COMMONFORGE_CI_D1_DATABASE_ID must be the commonforge-ci database's id, not ${d1Id}`);
  if (!UUID.test(prodD1Id) || prodD1Id === PLACEHOLDERS.d1Id) throw new Error(`COMMONFORGE_D1_DATABASE_ID must be production's D1 database id (CI refuses to share it), not ${prodD1Id}`);
  if (d1Id.toLowerCase() === prodD1Id.toLowerCase()) throw new Error("COMMONFORGE_CI_D1_DATABASE_ID is production's database (COMMONFORGE_D1_DATABASE_ID)");
  if (emailFrom === PLACEHOLDERS.emailFrom || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailFrom)) throw new Error(`COMMONFORGE_EMAIL_FROM must be the sender address onboarded for Email Sending, not ${emailFrom}`);
  return { base, d1Id, emailFrom, prodD1Id };
}

/** JSONC → value: strips // and /* *\/ comments outside strings, and trailing commas. */
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** keys copied unchanged (no account-wide resource names inside) */
const PLAIN = new Set(["$schema", "main", "compatibility_date", "compatibility_flags", "observability", "assets", "migrations", "triggers", "workers_dev", "limits", "durable_objects", "exports", "send_email"]);
const CONTAINER_KEYS = new Set(["class_name", "scheduling_policy", "images", "image", "instance_type", "max_instances"]);

function mapCommon(src, file, mapped) {
  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (PLAIN.has(k)) out[k] = structuredClone(v);
    else if (k in mapped) out[k] = mapped[k](v);
    else throw new Error(`${file}: no CI mapping for top-level key "${k}" (add one to scripts/ci-config-core.mjs)`);
  }
  return out;
}

/** containers: the application name derives from the Worker name; an explicit `name` would target production's (review m1) */
function containers(file) {
  return (v) =>
    v.map((c) => {
      for (const k of Object.keys(c)) if (!CONTAINER_KEYS.has(k)) throw new Error(`${file}: containers[].${k} has no CI mapping (an explicit name would reuse the production container application)`);
      return structuredClone(c);
    });
}

function oneBucket(file, bucket) {
  return (v) => {
    if (v.length !== 1) throw new Error(`${file}: ${v.length} R2 buckets; the CI mapping knows one (add a CI bucket per binding)`);
    return v.map((b) => ({ ...b, bucket_name: bucket }));
  };
}

function queues(file, q) {
  return (v) => {
    for (const k of Object.keys(v)) if (k !== "producers" && k !== "consumers") throw new Error(`${file}: queues.${k} has no CI mapping`);
    return {
      ...(v.producers ? { producers: v.producers.map((p) => ({ ...p, queue: q(p.queue) })) } : {}),
      ...(v.consumers ? { consumers: v.consumers.map((c) => ({ ...c, queue: q(c.queue), ...(c.dead_letter_queue ? { dead_letter_queue: q(c.dead_letter_queue) } : {}) })) } : {}),
    };
  };
}

function strings(v, acc = []) {
  if (typeof v === "string") acc.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, acc));
  else if (v && typeof v === "object") {
    Object.keys(v).forEach((k) => acc.push(k));
    Object.values(v).forEach((x) => strings(x, acc));
  }
  return acc;
}

/** every account-wide production name (exact) and every production URL/host/id/prefix (substring) */
function productionNames(prod, base) {
  const w = prod.worker;
  const exact = new Set([
    w.name, prod.preview.name, prod.runner.name,
    ...(w.artifacts ?? []).map((a) => a.namespace),
    ...(w.d1_databases ?? []).map((d) => d.database_name),
    ...(w.r2_buckets ?? []).map((b) => b.bucket_name), ...(prod.preview.r2_buckets ?? []).map((b) => b.bucket_name),
    ...(w.queues?.producers ?? []).map((p) => p.queue),
    ...(w.queues?.consumers ?? []).flatMap((c) => [c.queue, c.dead_letter_queue].filter(Boolean)),
    ...(prod.runner.queues?.producers ?? []).map((p) => p.queue),
    ...(prod.runner.queues?.consumers ?? []).map((c) => c.queue),
    w.vars.COMMONFORGE_DEPLOY_WORKER_PREFIX,
  ]);
  const substrings = [
    `${w.name}.${base}`, `${prod.preview.name}.${base}`, `${prod.runner.name}.${base}`,
    ...(w.d1_databases ?? []).map((d) => d.database_id),
    `${w.vars.COMMONFORGE_NAMESPACE_PREFIX}-`, w.vars.COMMONFORGE_NAMESPACE_PREFIX,
  ];
  return { exact, substrings };
}

/**
 * Names of a non-production deployment `<name>` made by scripts/bootstrap.sh (same shape as
 * ciNames): Workers `<name>-{worker,preview,runner}`, D1 `<name>`, queues `<queue>-<name>`, R2
 * `<name>-assets`, Artifacts prefix `<name>`, release Worker prefix `<name>`. `base` is the
 * account's workers.dev host (`<subdomain>.workers.dev`); `d1Id` the database the bootstrap
 * created. Validating `name` (refusing production and CI names) is the caller's job
 * (scripts/bootstrap/deployment.mjs); buildFromSources still refuses any production name.
 */
export function deploymentNames(name, { base, d1Id }) {
  const D = {
    suffix: `-${name}`,
    worker: `${name}-worker`,
    preview: `${name}-preview`,
    runner: `${name}-runner`,
    d1: { database_name: name, database_id: d1Id },
    bucket: `${name}-assets`,
    namespacePrefix: name,
    deployPrefix: name,
    deployment: name,
  };
  D.workerUrl = `https://${D.worker}.${base}`;
  D.previewUrl = `https://${D.preview}.${base}`;
  return D;
}

/**
 * prod: the three parsed production configs → the three configs of another deployment on the same
 * account (throws on anything unmapped). Default: the CI deployment in email log mode. `opts.emailMode`
 * is `send` or `log`; `opts.emailFrom` replaces the sender address (and the send_email allowlist);
 * `opts.adminEmails` sets COMMONFORGE_ADMIN_EMAILS (who may create orgs).
 */
export function buildFromSources(prod, base, names = ciNames(base), opts = {}) {
  if (!base) throw new Error("buildFromSources: the workers.dev host (base) is required");
  if (!names.d1?.database_id) throw new Error(`${names.deployment ?? "derived"} deployment: no D1 database id`);
  const CI = names;
  const emailMode = opts.emailMode ?? "log";
  if (emailMode !== "send" && emailMode !== "log") throw new Error(`email mode must be send or log, not ${emailMode}`);
  if (!CI.deployment || CI.deployment === "production") throw new Error("a derived deployment must name itself (COMMONFORGE_DEPLOYMENT), never production");
  const q = (name) => `${name}${CI.suffix}`;
  if (prod.worker.vars?.COMMONFORGE_EMAIL_MODE !== "send") throw new Error("wrangler.jsonc: production COMMONFORGE_EMAIL_MODE must be send");
  if (prod.worker.vars?.COMMONFORGE_DEPLOYMENT) throw new Error("wrangler.jsonc: production must not set COMMONFORGE_DEPLOYMENT");
  const ci = {
    worker: mapCommon(prod.worker, "wrangler.jsonc", {
      name: () => CI.worker,
      containers: containers("wrangler.jsonc"),
      artifacts: (v) => v.map((b) => ({ ...b, namespace: CI.namespacePrefix })),
      d1_databases: (v) => {
        if (v.length !== 1 || Object.keys(v[0]).some((k) => !["binding", "database_name", "database_id", "migrations_dir"].includes(k))) throw new Error("wrangler.jsonc: d1_databases: the CI mapping knows one database (binding, name, id, migrations_dir)");
        return v.map((b) => ({ ...b, ...CI.d1 }));
      },
      r2_buckets: oneBucket("wrangler.jsonc", CI.bucket),
      queues: queues("wrangler.jsonc", q),
      vars: (v) => ({
        ...v,
        COMMONFORGE_NAMESPACE_PREFIX: CI.namespacePrefix,
        COMMONFORGE_ASSETS_BUCKET: CI.bucket,
        COMMONFORGE_APP_URL: CI.workerUrl,
        COMMONFORGE_PUBLIC_URL: CI.workerUrl,
        COMMONFORGE_PREVIEW_URL: CI.previewUrl,
        COMMONFORGE_DEPLOY_WORKER_PREFIX: CI.deployPrefix,
        COMMONFORGE_QUEUE_SUFFIX: CI.suffix,
        COMMONFORGE_DEPLOYMENT: CI.deployment,
        // CI, and non-production bootstraps that ask for it: sign-in links are written to this
        // Worker's log (scripts/ci-live/ and scripts/bootstrap/smoke.mjs read them)
        COMMONFORGE_EMAIL_MODE: emailMode,
        ...(opts.emailFrom ? { COMMONFORGE_EMAIL_FROM: opts.emailFrom } : {}),
        ...(opts.adminEmails ? { COMMONFORGE_ADMIN_EMAILS: opts.adminEmails } : {}),
      }),
    }),
    preview: mapCommon(prod.preview, "wrangler.preview.jsonc", {
      name: () => CI.preview,
      containers: containers("wrangler.preview.jsonc"),
      r2_buckets: oneBucket("wrangler.preview.jsonc", CI.bucket),
    }),
    runner: mapCommon(prod.runner, "wrangler.runner.jsonc", {
      name: () => CI.runner,
      containers: containers("wrangler.runner.jsonc"),
      services: (v) =>
        v.map((s) => {
          if (s.service !== prod.worker.name) throw new Error(`wrangler.runner.jsonc: unknown service ${s.service}`);
          return { ...s, service: CI.worker };
        }),
      queues: queues("wrangler.runner.jsonc", q),
      vars: (v) => ({ ...v, COMMONFORGE_WORKER_URL: CI.workerUrl, COMMONFORGE_PREVIEW_URL: CI.previewUrl, COMMONFORGE_DEPLOY_WORKER_PREFIX: CI.deployPrefix }),
    }),
  };
  if (opts.emailFrom) ci.worker.send_email = (ci.worker.send_email ?? []).map((b) => ({ ...b, allowed_sender_addresses: [opts.emailFrom] }));
  assertNoProduction(prod, base, ci, CI.namespacePrefix);
  return ci;
}

/**
 * Throws if any string in the derived configs `cfgs` ({ worker, preview, runner }) names a production
 * resource or contains a production URL / host / D1 id / prefix. buildFromSources runs it; callers
 * that add to its output afterwards (bootstrap custom-domain routes) run it again.
 */
export function assertNoProduction(prod, base, cfgs, namespacePrefix) {
  const { exact, substrings } = productionNames(prod, base);
  for (const [k, cfg] of Object.entries(cfgs)) {
    for (const s of strings(cfg)) {
      if (exact.has(s)) throw new Error(`CI ${k} config still names production resource "${s}"`);
      const sub = substrings.find((p) => p && s.includes(p) && !s.startsWith(namespacePrefix));
      if (sub) throw new Error(`CI ${k} config value "${s}" contains production "${sub}"`);
    }
  }
}

export const FILES = { worker: "wrangler.deploy-ci.jsonc", preview: "wrangler.deploy-ci-preview.jsonc", runner: "wrangler.deploy-ci-runner.jsonc" };
export const SOURCES = { worker: "wrangler.jsonc", preview: "wrangler.preview.jsonc", runner: "wrangler.runner.jsonc" };
const HEADER = "// GENERATED by scripts/ci-config.mjs from the production wrangler config. Git-ignored; do not edit or commit. Rerun the script.\n// CI deployment only (Task 23): its own D1, queues, R2, Artifacts prefix and release prefix; email log mode.\n";

/** the text of each generated file */
export function render(ci) {
  return Object.fromEntries(Object.entries(FILES).map(([k, f]) => [f, HEADER + JSON.stringify(ci[k], null, 2) + "\n"]));
}
