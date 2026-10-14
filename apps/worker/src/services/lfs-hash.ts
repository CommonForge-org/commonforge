/**
 * Queue step `lfs.hash` (plan phase 2, decision 1): the platform hashes every finished upload by
 * streaming it from R2 through SHA-256 (`crypto.DigestStream`), and records whether it is binary
 * (a NUL byte in its first 8000 bytes, git's heuristic). Nothing uses an object before this step
 * verified it; a git-lfs upload whose bytes do not hash to the oid it claimed is deleted.
 *
 * The step records the R2 etag of the bytes it hashed, and every reader pins it
 * ({@link verifiedObjectBody}): a presigned PUT can write the key again until it expires, and
 * bytes that changed after verification are never served (the row is rejected `object_changed`).
 */
import { lfsPointer, looksBinary } from "@commonforge-org/runner-protocol";
import type { Services } from "../context.js";
import { gitBlobSha1 } from "../lib/crypto.js";
import { getLfsObject, markChanged, markRejected, markVerified, type LfsObjectRow } from "./lfs-store.js";
import { enqueueStep, onStep, onStepFailed } from "./steps.js";

export async function enqueueHash(svc: Services, orgId: string, stagingId: string): Promise<void> {
  await enqueueStep(svc, { type: "lfs.hash", orgId, stagingId });
}

const hexOf = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Delete the object first: if that fails the row stays `uploaded` and a redelivery tries again. Waiting changes then hear about it. */
async function reject(svc: Services, row: LfsObjectRow, reason: string): Promise<void> {
  await svc.env.COMMONFORGE_ASSETS.delete(row.r2_key);
  await markRejected(svc, row.staging_id, reason);
  await wakeFileChanges(svc, row.org_id, row.resource_id);
}

/** The git blob id of the LFS pointer text for this object (tree entries carry it; plan phase 3, P3-2). */
export async function pointerOidOf(sha256: string, size: number): Promise<string> {
  return gitBlobSha1(new TextEncoder().encode(lfsPointer(sha256, size)));
}

async function hashObject(svc: Services, row: LfsObjectRow): Promise<void> {
  const bucket = svc.env.COMMONFORGE_ASSETS;
  let sha: string;
  let binary = false;
  let etag: string;
  if (row.size === 0) {
    // a ranged GET on an empty object throws, and there is nothing to read anyway
    const head = await bucket.head(row.r2_key);
    if (!head || head.size !== 0) return reject(svc, row, "size_mismatch");
    sha = EMPTY_SHA256;
    etag = head.etag;
  } else {
    const first = await bucket.get(row.r2_key, { range: { offset: 0, length: 8000 } });
    if (!first) {
      await markRejected(svc, row.staging_id, "missing");
      await wakeFileChanges(svc, row.org_id, row.resource_id);
      return;
    }
    binary = looksBinary(new Uint8Array(await first.arrayBuffer()));
    etag = first.etag;
    // the bytes whose first 8000 were just read: written again in between, this delivery retries
    const obj = await bucket.get(row.r2_key, { onlyIf: { etagMatches: etag } });
    if (!obj) {
      await markRejected(svc, row.staging_id, "missing");
      await wakeFileChanges(svc, row.org_id, row.resource_id);
      return;
    }
    if (!("body" in obj)) throw new Error("the object was written again while it was being hashed");
    if (obj.size !== row.size) {
      await obj.body.cancel();
      return reject(svc, row, "size_mismatch");
    }
    const digest = new crypto.DigestStream("SHA-256");
    await obj.body.pipeTo(digest);
    sha = hexOf(await digest.digest);
  }
  if (row.claimed_oid && row.claimed_oid !== sha) return reject(svc, row, "hash_mismatch");
  await markVerified(svc, row.staging_id, sha, binary, etag, await pointerOidOf(sha, row.size));
  await wakeFileChanges(svc, row.org_id, row.resource_id);
}

onStep("lfs.hash", async (svc, msg) => {
  const row = await getLfsObject(svc, msg.orgId, msg.stagingId);
  if (!row) return { done: true };
  if (row.state === "verified" || row.state === "rejected") {
    // a redelivery: the wake after the state change may have been lost, and waking again is idempotent
    await wakeFileChanges(svc, row.org_id, row.resource_id);
    return { done: true };
  }
  if (row.state !== "uploaded") return { done: true };
  try {
    await hashObject(svc, row);
  } catch (e) {
    // R2, stream or D1 trouble: the step queue retries `provider_unavailable` with backoff, and calls onStepFailed after the last attempt
    throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { code: "provider_unavailable" });
  }
  return { done: true };
});

onStepFailed("lfs.hash", async (svc, msg, reason) => {
  const row = await getLfsObject(svc, msg.orgId, msg.stagingId);
  if (!row) return;
  if (row.state === "uploaded") await markRejected(svc, row.staging_id, `hash_failed: ${reason}`);
  if (row.state === "uploaded" || row.state === "rejected" || row.state === "verified") await wakeFileChanges(svc, row.org_id, row.resource_id);
});

/**
 * The verified bytes of an object, pinned to the etag the hash step recorded: null when the key is
 * gone, or when it was written again since (the row is then rejected `object_changed`, waiting
 * changes of its folder are woken, and nothing is deleted). A row without an etag (none is
 * verified without one) is never served.
 */
export async function verifiedObjectBody(svc: Services, row: Pick<LfsObjectRow, "staging_id" | "org_id" | "resource_id" | "r2_key" | "etag">): Promise<R2ObjectBody | null> {
  if (!row.etag) return null;
  const obj = await svc.env.COMMONFORGE_ASSETS.get(row.r2_key, { onlyIf: { etagMatches: row.etag } });
  if (!obj) return null;
  if (!("body" in obj)) {
    console.warn(`lfs object ${row.staging_id}: its bytes changed after the hash step verified them; rejected`);
    if (await markChanged(svc, row.staging_id, row.etag)) await wakeFileChanges(svc, row.org_id, row.resource_id);
    return null;
  }
  return obj;
}

/** File changes of this folder that are waiting for their uploads get another look. */
export async function wakeFileChanges(svc: Services, orgId: string, resourceId: string): Promise<void> {
  const rows = (
    await svc.db
      .prepare("SELECT change_id FROM file_changes WHERE org_id = ? AND resource_id = ? AND state = 'applying' AND job_id IS NULL")
      .bind(orgId, resourceId)
      .all<{ change_id: string }>()
  ).results;
  for (const r of rows) await enqueueStep(svc, { type: "files.apply", orgId, changeId: r.change_id });
}
