/**
 * Integration-runner endpoints, matching the runner's `worker-client.ts` / `blob-store.ts`
 * (Task 14). The credential is the `SignedJob` itself, verified with the job key on every call
 * (the runner never holds that key); pull-mode polling additionally needs the runner bearer
 * (`COMMONFORGE_RUNNER_TOKEN`).
 */
import { deriveEvidenceKey, evidenceKeyToWire, type IntegrationJob } from "@commonforge-org/runner-protocol";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv, Services } from "../context.js";
import { keyedHash } from "../lib/crypto.js";
import { ApiError, badRequest, conflict, forbidden, notFound, readJson } from "../lib/http.js";
import { bearer } from "../middleware/authz.js";
import { issueRunnerCredential, revokeRunnerCredential } from "../services/capability-broker.js";
import { acceptRunnerResult, verifyPresentedJob, type RunnerJobRow } from "../services/runner-jobs.js";
import { releaseForDeployJob } from "../services/releases.js";
import { verifiedObjectBody } from "../services/lfs-hash.js";
import type { LfsObjectRow } from "../services/lfs-store.js";

export const runnerRoutes = new Hono<AppEnv>();

/** A pull-mode runner re-claims a job whose claim is older than this. */
export const CLAIM_TIMEOUT_MS = 10 * 60_000;

runnerRoutes.post("/runner/credential", async (c) => {
  const body = await readJson(c, z.object({ signedJob: z.unknown(), repo: z.unknown(), access: z.unknown() }));
  c.header("cache-control", "no-store");
  return c.json(await issueRunnerCredential(c.get("svc"), body));
});

/** `POST <credentialBroker>/revoke`: revoke a token minted for this job (best effort; TTL bounds it). */
runnerRoutes.post("/runner/credential/revoke", async (c) => {
  const body = await readJson(c, z.object({ signedJob: z.unknown(), tokenId: z.string().min(1).max(200) }));
  await revokeRunnerCredential(c.get("svc"), body.signedJob, body.tokenId);
  return c.json({ ok: true });
});

/** 201 new; 200 identical replay; 409 a different result is already applied (the runner treats 409 as applied). */
runnerRoutes.post("/runner/results", async (c) => {
  const body = await readJson(c, z.object({ signedJob: z.unknown(), result: z.unknown() }));
  const r = await acceptRunnerResult(c.get("svc"), { signedJob: body.signedJob, result: body.result });
  return c.json(r, r.replayed ? 200 : 201);
});

/** Per-job evidence key (`deriveEvidenceKey`): signs evidence for this one job only. Integrate jobs, while open. */
runnerRoutes.post("/runner/evidence-key", async (c) => {
  const body = await readJson(c, z.object({ signedJob: z.unknown() }));
  const svc = c.get("svc");
  const { signedJob, row } = await verifyPresentedJob(svc, body.signedJob, { allowedKinds: ["integrate"] });
  if (row.status !== "queued") throw conflict("job_finished", "the job already reported its result");
  c.header("cache-control", "no-store");
  return c.json(evidenceKeyToWire(await deriveEvidenceKey(svc.jobKey(), signedJob.jobId)));
});

/**
 * The account deploy token, for an OPEN `release-deploy` job only (Task 22, AT-34). Broker-mode
 * runners hand it to their pinned wrangler process; the Sandbox runner Worker gives it to its
 * egress gateway, so the container never holds it. Never cached, never logged.
 */
runnerRoutes.post("/runner/deploy-credential", async (c) => {
  const body = await readJson(c, z.object({ signedJob: z.unknown() }));
  const svc = c.get("svc");
  const { signedJob, row } = await verifyPresentedJob(svc, body.signedJob, { allowedKinds: ["release-deploy"] });
  if (row.status !== "queued") throw conflict("job_finished", "the job already reported its result");
  const token = svc.env.COMMONFORGE_DEPLOY_API_TOKEN;
  if (!token) throw new ApiError(503, "config_missing", "COMMONFORGE_DEPLOY_API_TOKEN is not configured");
  // only the deploy (or rollback, review I-4) the release service started, never a stale or foreign job
  const found = await releaseForDeployJob(svc, row.org_id, row.job_id);
  const deploys = found ? (found.rollback ? found.release.previous_release_id : found.release.release_id) : null;
  if (!found || deploys !== (signedJob.job as { releaseId: string }).releaseId) throw forbidden("scope_violation", "this job is not the release's current deploy");
  c.header("cache-control", "no-store");
  return c.json({ token, accountId: (signedJob.job as { accountId: string }).accountId });
});

/** Ledger heads of the resources the job names (the runner's early stale check; the ledger decides at accept). */
runnerRoutes.post("/runner/heads", async (c) => {
  const body = await readJson(c, z.object({ signedJob: z.unknown() }));
  const svc = c.get("svc");
  const { signedJob, row } = await verifyPresentedJob(svc, body.signedJob);
  const ledger = svc.ledger(row.org_id);
  const heads: Record<string, string | null> = {};
  for (const id of jobResourceIds(signedJob.job)) heads[id] = (await ledger.getHead(id))?.revisionId ?? null;
  return c.json({ heads });
});

function jobResourceIds(job: IntegrationJob): string[] {
  switch (job.kind) {
    case "integrate":
      return job.targets.map((t) => t.resourceId);
    case "prepare-candidate":
      return [job.candidate.resourceId];
    case "reconcile-ref":
      return job.resourceId ? [job.resourceId] : [];
    case "seed-workspace":
    case "init-folder":
      return [job.resourceId];
    case "edition-return":
    case "apply-files":
      return [job.target.resourceId];
    case "export":
      return job.resources.map((r) => r.resourceId);
    case "build-edition":
      return job.sources.map((s) => s.resourceId);
    case "preview-build":
      return job.sources.map((s) => s.resourceId);
    case "release-build":
      return job.sources.map((s) => s.resourceId);
    case "staging-build":
      return job.targets.map((t) => t.resourceId);
    case "inventory":
    case "release-deploy":
      return [];
  }
}

/**
 * Pull mode: claim the oldest open job (queue delivery is the default; a job delivered both ways is
 * harmless: results apply once per jobId). Needs `Authorization: Bearer <COMMONFORGE_RUNNER_TOKEN>`.
 * 200 `RunnerJobDelivery { signedJob }` (no evidence key: fetched per job from /evidence-key) or 204.
 */
runnerRoutes.post("/runner/jobs/next", async (c) => {
  const svc = c.get("svc");
  await requireRunnerBearer(c, svc);
  const body = await readJson(c, z.object({ runnerId: z.string().min(1).max(128) }));
  const now = svc.now().getTime();
  const row = await svc.db
    .prepare(
      // review m-4: release-deploy jobs (which can fetch the account deploy token) are never handed
      // to pull-mode runners unless the operator opts in with COMMONFORGE_RUNNER_DEPLOY=1
      `UPDATE runner_jobs SET claimed_by = ?, claimed_at = ? WHERE job_id = (SELECT job_id FROM runner_jobs WHERE status = 'queued' AND expires_at > ? AND (claimed_at IS NULL OR claimed_at < ?)${svc.env.COMMONFORGE_RUNNER_DEPLOY === "1" ? "" : " AND kind != 'release-deploy'"} ORDER BY issued_at LIMIT 1) RETURNING signed_json`,
    )
    .bind(body.runnerId, now, now + 60_000, now - CLAIM_TIMEOUT_MS)
    .first<{ signed_json: string }>();
  if (!row) return c.body(null, 204);
  return c.json({ signedJob: JSON.parse(row.signed_json) as unknown });
});

async function requireRunnerBearer(c: Context<AppEnv>, svc: Services): Promise<void> {
  const expected = svc.env.COMMONFORGE_RUNNER_TOKEN;
  if (!expected) throw new ApiError(503, "runner_poll_disabled", "pull mode is disabled (COMMONFORGE_RUNNER_TOKEN is not set)");
  const got = bearer(c);
  // compare keyed hashes: constant-time enough and never compares raw secrets
  const secret = svc.env.COMMONFORGE_SESSION_SECRET;
  if (!got || (await keyedHash(secret, "runner-bearer", got)) !== (await keyedHash(secret, "runner-bearer", expected))) {
    throw new ApiError(401, "unauthenticated", "runner bearer required");
  }
}

// ------------------------------------------------------------------------------------------ blobs

/** Keys a job may read / write (`GET|PUT /api/runner/blobs/<key>`). */
/** A read of a verified LFS object: served only as the bytes the hash step verified (etag pinned). */
type PinnedRead = { pinned: Pick<LfsObjectRow, "staging_id" | "org_id" | "resource_id" | "r2_key" | "etag"> };

async function blobScope(svc: Services, job: IntegrationJob, row: RunnerJobRow): Promise<{ read: (k: string) => boolean | PinnedRead | Promise<boolean | PinnedRead>; write: (k: string) => boolean }> {
  const org = `org/${row.org_id}/`;
  const none = () => false;
  switch (job.kind) {
    case "inventory":
    case "edition-return": {
      const key = job.upload.r2Key;
      return { read: (k) => k === key && key.startsWith(org), write: none };
    }
    case "export": {
      const prefix = job.sink.r2Prefix;
      const ok = prefix.startsWith(`${org}exports/`);
      return { read: (k) => ok && k.startsWith(prefix), write: (k) => ok && k.startsWith(prefix) };
    }
    case "preview-build": {
      // Task 22 layout: org/<org>/previews/<previewId>/{site,bundles/<name>}/… (meta.json is the Worker's)
      const prefix = `${org}previews/${job.previewId}/`;
      const ok = (k: string) => (k.startsWith(`${prefix}site/`) || k.startsWith(`${prefix}bundles/`));
      return { read: ok, write: ok };
    }
    case "release-build": {
      // immutable release outputs: org/<org>/releases/<releaseId>/<targetId>/…
      const prefix = `${org}releases/${job.releaseId}/`;
      return { read: none, write: (k) => job.outputPrefix === prefix && k.startsWith(prefix) };
    }
    case "release-deploy": {
      const prefix = `${org}releases/${job.releaseId}/`;
      return { read: (k) => job.outputPrefix === prefix && k.startsWith(prefix), write: none };
    }
    case "apply-files": {
      // the job's ops manifest (under its change's prefix), and the small text files the change puts,
      // under the folder's staging prefix (LFS objects are never fetched). The operations are not in
      // the job (R5): the change is the one this job was issued for, and its puts are its
      // file_change_objects; "small text" is decided by the recorded hash-step values against the
      // job's threshold, exactly as the Worker resolved the operations.
      const manifest = job.opsManifest.r2Key;
      const manifestOk = manifest.startsWith(`${org}file-changes/${job.changeId}/`);
      const prefix = `${org}lfs/${job.target.resourceId}/obj/`;
      return {
        read: async (k) => {
          if (k === manifest) return manifestOk;
          if (!k.startsWith(prefix)) return false;
          const hit = await svc.db
            .prepare(
              "SELECT o.staging_id, o.org_id, o.resource_id, o.r2_key, o.etag FROM file_changes c JOIN file_change_objects fo ON fo.change_id = c.change_id JOIN lfs_objects o ON o.staging_id = fo.staging_id AND o.org_id = c.org_id WHERE c.job_id = ? AND c.change_id = ? AND c.org_id = ? AND c.resource_id = ? AND o.r2_key = ? AND o.state = 'verified' AND o.binary = 0 AND o.size <= ? LIMIT 1",
            )
            .bind(row.job_id, job.changeId, row.org_id, job.target.resourceId, k, job.lfsThresholdBytes)
            .first<PinnedRead["pinned"]>();
          return hit ? { pinned: hit } : false;
        },
        write: none,
      };
    }
    default:
      return { read: none, write: none };
  }
}

async function blobJob(c: Context<AppEnv>) {
  const header = c.req.header("x-commonforge-signed-job");
  if (!header) throw new ApiError(403, "job_invalid", "x-commonforge-signed-job header required");
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(base64UrlToBytes(header)));
  } catch {
    throw new ApiError(403, "job_invalid", "malformed x-commonforge-signed-job header");
  }
  const svc = c.get("svc");
  const { signedJob, row } = await verifyPresentedJob(svc, value);
  if (row.status !== "queued") throw conflict("job_finished", "the job already reported its result");
  const key = c.req.param("key")!;
  if (!key || key.includes("..") || key.startsWith("/")) throw badRequest("invalid_path", "invalid object key");
  return { svc, key, scope: await blobScope(svc, signedJob.job, row) };
}

function base64UrlToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("bad base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

runnerRoutes.get("/runner/blobs/:key{.+}", async (c) => {
  const { svc, key, scope } = await blobJob(c);
  const allowed = await scope.read(key);
  if (!allowed) throw forbidden("scope_violation", "the job does not name this object");
  // a staged upload: only the bytes the hash step verified (written again since: rejected, 404)
  const obj = allowed === true ? await svc.env.COMMONFORGE_ASSETS.get(key) : await verifiedObjectBody(svc, allowed.pinned);
  if (!obj) throw notFound("object not found");
  return new Response(obj.body, { headers: { "content-type": "application/octet-stream", "content-length": String(obj.size) } });
});

runnerRoutes.put("/runner/blobs/:key{.+}", async (c) => {
  const { svc, key, scope } = await blobJob(c);
  if (!scope.write(key)) throw forbidden("scope_violation", "the job may not write this object");
  const data = await c.req.arrayBuffer();
  const sha = c.req.header("x-commonforge-sha256");
  const put = await svc.env.COMMONFORGE_ASSETS.put(key, data, {
    ...(sha && /^[0-9a-f]{64}$/.test(sha) ? { sha256: sha } : {}),
    httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" },
  });
  if (!put) throw new ApiError(500, "internal", "object write failed");
  return c.json({ key, size: data.byteLength }, 201);
});
