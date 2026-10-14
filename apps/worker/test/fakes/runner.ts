/**
 * Fake integration runner: consumes SignedJobs the Worker enqueues, asks the broker for credentials
 * exactly like the real runner would, performs the git effects on the in-memory Artifacts double,
 * signs evidence with the per-job evidence key, and posts results to `/api/runner/results`.
 */
import {
  artRevisionId,
  candidateId,
  candidateRetentionRef,
  diffAgainstInventory,
  hasAlwaysProtectedSegment,
  isWithinPrefix,
  mapEditionDelta,
  matchesPathPattern,
  parseRevisionId,
  sha256Hex,
  sha256HexSync,
  type FrozenCandidate,
  type RepoCoords,
} from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { readReturnZip, RETURN_ZIP_LIMITS } from "../../src/lib/zip.js";
import { gitBlobSha1 } from "../../src/lib/crypto.js";
import {
  APPLY_FILES_LIMITS,
  classifyPath,
  evidenceKeyFromWire,
  gitattributesLfsEntry,
  jobRepoAccess,
  LFS_POINTER_MAX_BYTES,
  lfsAttributesMatcher,
  lfsPointer,
  looksBinary,
  parseApplyFilesOps,
  parseLfsPointer,
  releaseOutputDigest,
  releaseTargetDigest,
  signEvidence,
  type ApplyFilesOp,
  type ApplyFilesReceipt,
  type IntegrationJob,
  type SignedJob,
} from "@commonforge-org/runner-protocol";
import type { Harness } from "../helpers.js";

export interface FakeRunnerOptions {
  /** per kind: return a failure instead of doing the work */
  fail?: Partial<Record<IntegrationJob["kind"], { code: string; detail: string }>>;
  /** inventory listing the fake reports for any ZIP */
  inventory?: { entries: Array<{ path: string; size: number; sha256: string }>; rejected: Array<{ path: string; reason: string }> };
  /** integrate: answer ok:false *with signed evidence* (a failed contract and/or a text conflict), like the real runner */
  integrateFailure?: { code: string; detail: string; contractId?: string; conflictPaths?: string[] };
  /** integrate: mark these check ids as failed */
  failChecks?: string[];
  /**
   * integrate: per job, answer ok:false with signed evidence when this returns a failure (after the
   * merge; a textual conflict of the merge comes first); `failChecks` are marked `fail` in the evidence
   */
  integrateFailureIf?: (job: { candidates: FrozenCandidate[] }) => { code: string; detail: string; failChecks?: string[] } | undefined;
  /** do not answer automatically */
  manual?: boolean;
  /** do not answer jobs of these kinds automatically (they wait in `pending` for `runPending`) */
  hold?: string[];
  /** fail seed-workspace jobs for this resource only */
  failSeedResource?: string;
  /** sign integrate evidence for this snapshot id instead of the job's candidate snapshot */
  evidenceSnapshotId?: string;
  /** build-edition: canary strings that fail the build when found (AT-26 tripwire) */
  canaries?: string[];
  /** release-deploy: called with each deployed Worker (the test's "live" services) */
  onDeploy?: (workerName: string, vars: Record<string, string>) => void;
  /** release-deploy: deploy the first target, then fail (partial) */
  partialDeploy?: boolean;
  /** release-deploy: report success, but the account keeps running the old versions */
  deployWithoutActivating?: boolean;
  /** rewrite a receipt before it is posted (a runner reporting something it should not) */
  mutateReceipt?: Partial<Record<IntegrationJob["kind"], (receipt: any) => unknown>>;
  /** staging-build: answer ok:false `textual_conflict` blaming this landing when a job contains it (nothing is built) */
  stagingConflict?: { landingId: string; paths: string[] };
}

const CONFLICT = Symbol("conflict");

/**
 * Three-way merge of one file (undefined = absent): a side that left it as the base takes the other
 * side; both sides equal is that; else, when all three exist with the same number of lines, per
 * line (a line both sides changed differently conflicts); anything else is a conflict.
 */
function mergeFile(base: string | undefined, ours: string | undefined, theirs: string | undefined): string | undefined | typeof CONFLICT {
  if (ours === base) return theirs;
  if (theirs === base || ours === theirs) return ours;
  if (base === undefined || ours === undefined || theirs === undefined) return CONFLICT;
  const [b, o, t] = [base.split("\n"), ours.split("\n"), theirs.split("\n")];
  if (b.length !== o.length || b.length !== t.length) return CONFLICT;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) {
    if (o[i] === b[i]) out.push(t[i]!);
    else if (t[i] === b[i] || o[i] === t[i]) out.push(o[i]!);
    else return CONFLICT;
  }
  return out.join("\n");
}

/** `x-commonforge-signed-job`: base64url JSON of the signed job (runner blob-store contract). */
export function jobHeader(signedJob: SignedJob): Record<string, string> {
  const bytes = new TextEncoder().encode(JSON.stringify(signedJob));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return { "x-commonforge-signed-job": btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
}

export class FakeRunner {
  readonly handled: SignedJob[] = [];
  readonly errors: unknown[] = [];
  readonly credentials: Array<{ jobId: string; repo: string; access: string; status: number }> = [];
  readonly pending: SignedJob[] = [];
  /** release-deploy jobs: status of the deploy-credential call (the token itself is never kept) */
  readonly deployCredentials: Array<{ jobId: string; status: number; gotToken: boolean }> = [];
  /** automatic runs not yet finished, from enqueue until their result POST has been answered */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly h: Harness,
    public opts: FakeRunnerOptions = {},
  ) {
    h.onRunnerJob = (msg: { signedJob: SignedJob }) => {
      if (this.opts.manual || this.opts.hold?.includes(msg.signedJob.job.kind)) {
        this.pending.push(msg.signedJob);
        return;
      }
      const p = new Promise<void>((resolve) => {
        setTimeout(() => {
          this.run(msg.signedJob)
            .catch((e) => this.errors.push(e))
            .finally(resolve);
        }, 1);
      });
      this.inFlight.add(p);
      void p.finally(() => this.inFlight.delete(p));
    };
  }

  /** Wait until every automatic run (and any run it caused) has posted its result and been answered. */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight]);
  }

  async runPending(): Promise<void> {
    for (const j of this.pending.splice(0)) await this.run(j);
  }

  /** Run the pending jobs `pred` picks (in order); the others keep waiting. Returns how many ran. */
  async runWhere(pred: (job: IntegrationJob) => boolean): Promise<number> {
    const take = this.pending.filter((j) => pred(j.job));
    for (const j of take) this.pending.splice(this.pending.indexOf(j), 1);
    for (const j of take) await this.run(j);
    return take.length;
  }

  async credential(signedJob: SignedJob, repo: RepoCoords, access: "read" | "write") {
    const r = await this.h.api("POST", "/api/runner/credential", { body: { signedJob, repo, access } });
    this.credentials.push({ jobId: signedJob.jobId, repo: `${repo.namespace}/${repo.repoName}`, access, status: r.status });
    return r;
  }

  async post(signedJob: SignedJob, result: unknown) {
    return this.h.api("POST", "/api/runner/results", { body: { signedJob, result } });
  }

  async run(signedJob: SignedJob): Promise<void> {
    this.handled.push(signedJob);
    const job = signedJob.job;
    // like the real runner: fetch a token for every repo the job names (exercises the broker)
    for (const a of jobRepoAccess(job)) {
      const r = await this.credential(signedJob, a.coords, a.access);
      if (r.status !== 200) throw new Error(`broker refused ${a.coords.repoName}: ${JSON.stringify(r.body)}`);
    }
    const failure = this.opts.fail?.[job.kind] ?? (job.kind === "seed-workspace" && job.resourceId === this.opts.failSeedResource ? { code: "provider_unavailable", detail: "seed failed (test)" } : undefined);
    if (failure) {
      await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: failure.code, detail: failure.detail });
      return;
    }
    const now = new Date().toISOString();
    const fake = this.h.artifacts;
    let receipt: unknown;
    switch (job.kind) {
      case "seed-workspace": {
        const branch = job.ref.replace(/^refs\/heads\//, "");
        fake.push(job.taskFork.namespace, job.taskFork.repoName, branch, job.baseSha);
        receipt = { jobId: signedJob.jobId, taskWorkspaceId: job.taskWorkspaceId, resourceId: job.resourceId, ref: job.ref, sha: job.baseSha, seededAt: now };
        break;
      }
      case "prepare-candidate": {
        fake.addObject(job.canonical.namespace, job.canonical.repoName, job.candidate.sha);
        receipt = {
          receiptId: `rcpt-${signedJob.jobId}`,
          jobId: signedJob.jobId,
          candidateId: job.candidate.candidateId,
          resourceId: job.candidate.resourceId,
          canonicalRef: candidateRetentionRef(job.candidate.candidateId),
          sha: job.candidate.sha,
          revisionId: artRevisionId(job.canonical.repoId, job.candidate.sha),
          verifiedAssetObjects: [],
          preparedAt: now,
        };
        break;
      }
      case "integrate": {
        // like the real runner (Task 14): each target's snapshot entry must pin expectedHead
        for (const t of job.targets) {
          const entry = job.baseSnapshot.entries.find((e) => e.resourceId === t.resourceId);
          if (!entry || entry.revisionId !== t.expectedHead) {
            await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: "stale_base", detail: `${t.resourceId}: snapshot pins ${entry?.revisionId}, expectedHead is ${t.expectedHead}` });
            return;
          }
        }
        // like the real runner: everything a check/contract needs is a target or a reference
        const entries = job.baseSnapshot.entries;
        const sources = new Set([...job.targets.map((t) => t.resourceId as string), ...(job.references ?? []).map((r) => r.resourceId as string)]);
        const needed = [
          ...job.contracts.map((ct) => ct.schema.resourceId as string),
          ...job.checks.map((ch) => entries.find((e) => e.mountName === ch.mountName)?.resourceId as string),
          ...job.contracts.map((ct) => entries.find((e) => e.mountName === ct.producerOutput.mountName)?.resourceId as string),
        ];
        const missing = needed.find((rid) => rid && !sources.has(rid));
        if (missing) {
          await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: "scope_violation", detail: `checks need resource ${missing}, which is neither a target nor a reference of this job` });
          return;
        }
        const results = [];
        const conflictPaths: string[] = [];
        for (const t of job.targets) {
          const head = parseRevisionId(t.expectedHead) as { sha: string };
          const cands = job.candidates.filter((c: FrozenCandidate) => c.resourceId === t.resourceId);
          let sha: string;
          const only = cands.length === 1 ? cands[0]! : undefined;
          if (job.mergeBases) {
            // like the real runner (promotion builds): each candidate's own change set (its diff
            // from its merge base) on top of the result so far, one single-parent commit each
            // (a line-level three-way merge per path, like `git merge-tree --merge-base` for
            // equal-length edits; anything else both sides changed is a conflict)
            sha = head.sha;
            for (const c of cands) {
              const files = { ...(fake.files.get(sha) ?? {}) };
              const base = fake.files.get(job.mergeBases[c.candidateId]!) ?? {};
              const next = fake.files.get(c.sha) ?? {};
              for (const p of new Set([...Object.keys(base), ...Object.keys(next)])) {
                if (base[p] === next[p]) continue; // the candidate did not change it
                const merged = mergeFile(base[p], files[p], next[p]);
                if (merged === CONFLICT) conflictPaths.push(p);
                else if (merged === undefined) delete files[p];
                else files[p] = merged;
              }
              sha = fake.makeCommit(files, [sha]);
            }
          } else if (only &&parseRevisionId(only.baseRevision).kind === "art" && (parseRevisionId(only.baseRevision) as { sha: string }).sha === head.sha) {
            sha = only.sha; // fast-forward
          } else {
            const files = { ...(fake.files.get(head.sha) ?? {}) };
            for (const c of cands) Object.assign(files, fake.files.get(c.sha) ?? {});
            sha = fake.makeCommit(files, [head.sha, ...cands.map((c) => c.sha)]);
          }
          fake.addObject(t.canonical.namespace, t.canonical.repoName, sha);
          results.push({ resourceId: t.resourceId, integrationRef: job.integrationRef, sha, revisionId: artRevisionId(t.canonical.repoId, sha), expectedHead: t.expectedHead });
        }
        const keyRes = await this.h.api("POST", "/api/runner/evidence-key", { body: { signedJob } });
        if (keyRes.status !== 200) throw new Error(`evidence key refused: ${JSON.stringify(keyRes.body)}`);
        const failure: { code: string; detail: string; contractId?: string; conflictPaths?: string[]; failChecks?: string[] } | undefined =
          this.opts.integrateFailure ??
          (conflictPaths.length > 0 ? { code: "textual_conflict", detail: `merge conflict in ${conflictPaths.join(", ")}`, conflictPaths } : this.opts.integrateFailureIf?.({ candidates: job.candidates }));
        const failChecks = [...(this.opts.failChecks ?? []), ...(failure?.failChecks ?? [])];
        const evidence = await signEvidence(
          {
            evidenceId: `ev-${signedJob.jobId}`,
            proposalHash: job.proposalHash,
            snapshotId: this.opts.evidenceSnapshotId ?? job.candidateSnapshotId,
            runnerId: "fake-runner",
            runnerKind: "node-runner",
            checks: job.checks.map((c) => ({ checkId: c.checkId, command: c.command, result: failChecks.includes(c.checkId) ? ("fail" as const) : ("pass" as const), startedAt: now, endedAt: now })),
            contractChecks: failure?.contractId
              ? [{ contractId: failure.contractId, producerResource: job.targets[0]!.resourceId, consumerResource: job.targets[0]!.resourceId, result: "fail" as const, detail: "response has an unexpected field" }]
              : // like the real runner: every policy contract of the job is evaluated (re-review m1)
                job.contracts.map((ct) => ({ contractId: ct.contractId, producerResource: ct.producerResource, consumerResource: ct.consumerResource, result: "pass" as const })),
            mergeOutcome: job.targets.map((t) =>
              failure?.conflictPaths ? { resourceId: t.resourceId, result: "textual-conflict" as const, conflictPaths: failure.conflictPaths } : { resourceId: t.resourceId, result: "clean" as const },
            ),
            producedAt: now,
          },
          evidenceKeyFromWire(keyRes.body),
          { jobId: signedJob.jobId },
        );
        if (failure) {
          const r = await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: failure.code, detail: failure.detail, evidence });
          if (r.status >= 300) throw new Error(`result refused: ${r.status} ${JSON.stringify(r.body)}`);
          return;
        }
        receipt = { jobId: signedJob.jobId, proposalId: job.proposalId, results, evidence, integratedAt: now };
        break;
      }
      case "inventory": {
        const blob = await this.h.api("GET", `/api/runner/blobs/${encodeURIComponent(job.upload.r2Key)}`, { headers: jobHeader(signedJob) });
        if (blob.status !== 200) throw new Error(`blob refused: ${blob.status}`);
        const inv = this.opts.inventory ?? { entries: [], rejected: [] };
        receipt = { jobId: signedJob.jobId, intakeId: job.intakeId, entries: inv.entries, rejected: inv.rejected, totalBytes: inv.entries.reduce((n, e) => n + e.size, 0), inventoriedAt: now };
        break;
      }
      case "export": {
        const items = [];
        for (const r of job.resources) {
          const key = `${job.sink.r2Prefix}${r.resourceId}.bundle`;
          const put = await this.h.api("PUT", `/api/runner/blobs/${encodeURIComponent(key)}`, { raw: `bundle of ${r.sha}`, headers: jobHeader(signedJob) });
          if (put.status !== 201) throw new Error(`blob write refused: ${put.status} ${JSON.stringify(put.body)}`);
          items.push({ resourceId: r.resourceId, kind: "git-bundle", r2Key: key, sha256: "0".repeat(64), headSha: r.sha, historyMode: "full" });
        }
        receipt = { exportId: job.exportId, snapshotId: job.snapshotId, items, createdAt: now };
        break;
      }
      case "reconcile-ref": {
        // like the real runner: --force-with-lease=<ref>:<expectedCurrentSha>
        const branch = job.ref.replace(/^refs\/heads\//, "");
        const before = fake.repo(job.canonical.namespace, job.canonical.repoName).refs.get(branch) ?? null;
        let observed = job.targetSha;
        if (before !== job.targetSha) {
          if (before === job.expectedCurrentSha) fake.push(job.canonical.namespace, job.canonical.repoName, branch, job.targetSha);
          else observed = before as string;
        }
        receipt = { jobId: signedJob.jobId, ...(job.resourceId ? { resourceId: job.resourceId } : {}), ref: job.ref, targetSha: job.targetSha, observedSha: observed, status: observed === job.targetSha ? "synced" : "diverged", reconciledAt: now };
        break;
      }
      case "build-edition": {
        // like the real runner: only allowlisted blobs, one parentless commit, nothing of history
        const files: Record<string, string> = {};
        for (const src of job.sources) {
          for (const [path, content] of Object.entries(fake.files.get(src.sha) ?? {})) {
            if (!isWithinPrefix(path, src.canonicalPathPrefix) || !src.include.some((p) => matchesPathPattern(path, p))) continue;
            const rel = src.canonicalPathPrefix === "" ? path : path.slice(src.canonicalPathPrefix.length + 1);
            const ep = [src.editionPathPrefix, rel].filter(Boolean).join("/");
            if (job.exclude.some((p) => matchesPathPattern(path, p) || matchesPathPattern(ep, p))) continue;
            if (hasAlwaysProtectedSegment(path) || hasAlwaysProtectedSegment(ep)) continue;
            files[ep] = content;
          }
        }
        const canaries = this.opts.canaries ?? [];
        for (const [p, content] of Object.entries(files)) {
          if (canaries.some((c) => content.includes(c) || p.includes(c))) {
            await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: "scope_violation", detail: `edition file ${p} contains a canary string` });
            return;
          }
        }
        const sha = fake.makeCommit(files);
        fake.push(job.editionRepo.namespace, job.editionRepo.repoName, "main", sha);
        const inventory = [];
        for (const p of Object.keys(files).sort()) {
          const bytes = new TextEncoder().encode(files[p]!);
          inventory.push({ editionPath: p, sha256: await sha256Hex(bytes), size: bytes.length });
        }
        receipt = { jobId: signedJob.jobId, editionId: job.editionId, sha, revisionId: artRevisionId(job.editionRepo.repoId, sha), inventory, builtAt: now };
        break;
      }
      case "edition-return": {
        const heads = await this.h.api("POST", "/api/runner/heads", { body: { signedJob } });
        const head = heads.body.heads?.[job.target.resourceId];
        if (head !== job.target.expectedHead) {
          await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: "stale_base", detail: `${job.target.resourceId}: ledger head is ${head}, expected ${job.target.expectedHead}` });
          return;
        }
        const blob = await this.h.api("GET", `/api/runner/blobs/${encodeURIComponent(job.upload.r2Key)}`, { headers: jobHeader(signedJob) });
        if (blob.status !== 200) throw new Error(`blob refused: ${blob.status}`);
        // (the harness decodes bodies as text; read the same object's bytes directly)
        const raw = new Uint8Array(await (await env.COMMONFORGE_ASSETS.get(job.upload.r2Key))!.arrayBuffer());
        const zip = await readReturnZip(raw, RETURN_ZIP_LIMITS, null);
        if (zip.rejected.length) {
          await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: "scope_violation", detail: `upload refused: ${zip.rejected.map((r) => r.path).join(", ")}` });
          return;
        }
        const returned = [];
        for (const e of zip.entries) returned.push({ path: e.path, sha256: await sha256Hex(e.data) });
        const mapped = mapEditionDelta(diffAgainstInventory(job.edition.inventory, returned, job.upload.mode, job.upload.deletions ?? []), job.edition);
        const base = (parseRevisionId(job.target.expectedHead) as { sha: string }).sha;
        const files = { ...(fake.files.get(base) ?? {}) };
        const blocked: Array<{ path: string; reason: string }> = [...mapped.blocked, ...mapped.allowed.filter((a) => a.resourceId !== job.target.resourceId).map((a) => ({ path: a.editionPath, reason: "not_mapped" as const }))];
        // like the real runner (review M-2/I-2): no new path onto (or case-colliding with) an unpublished canonical file
        const folds = new Set(Object.keys(files).map((p) => p.toLowerCase()));
        const dirFolds = new Set(Object.keys(files).flatMap((p) => p.toLowerCase().split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
        const exactDirs = new Set(Object.keys(files).flatMap((p) => p.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
        const hit = (p: string) => {
          const f = p.toLowerCase();
          if (folds.has(f) || dirFolds.has(f)) return true;
          const parts = f.split("/");
          const exact = p.split("/");
          for (let i = 1; i < parts.length; i++) {
            const anc = parts.slice(0, i).join("/");
            if (folds.has(anc) || (dirFolds.has(anc) && !exactDirs.has(exact.slice(0, i).join("/")))) return true;
          }
          return false;
        };
        const allowed = mapped.allowed.filter((a) => {
          if (a.resourceId !== job.target.resourceId) return false;
          if ((a.kind === "added" || a.kind === "renamed") && hit(a.canonicalPath)) {
            blocked.push({ path: a.editionPath, reason: "not_mapped" });
            if (a.kind === "renamed") blocked.push({ path: a.oldEditionPath!, reason: "not_mapped" });
            return false;
          }
          return true;
        });
        blocked.sort((x, y) => (x.path < y.path ? -1 : 1));
        const hashOf = async (p: string) => (files[p] === undefined ? null : await sha256Hex(new TextEncoder().encode(files[p]!)));
        const content = new Map(zip.entries.map((e) => [e.path, new TextDecoder().decode(e.data)]));
        const conflicts: string[] = [];
        for (const a of allowed) {
          const now = await hashOf(a.canonicalPath);
          if (a.kind === "modified" && now !== a.previousSha256) conflicts.push(a.canonicalPath);
          else if (a.kind === "added" && now !== null && now !== a.sha256) conflicts.push(a.canonicalPath);
          else if (a.kind === "deleted" && now !== null && now !== a.previousSha256) conflicts.push(a.canonicalPath);
          else if (a.kind === "renamed" && (await hashOf(a.oldCanonicalPath!)) !== a.previousSha256) conflicts.push(a.oldCanonicalPath!);
          else if (a.kind === "deleted") delete files[a.canonicalPath];
          else {
            if (a.kind === "renamed") delete files[a.oldCanonicalPath!];
            files[a.canonicalPath] = content.get(a.editionPath)!;
          }
        }
        if (conflicts.length) {
          await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: "textual_conflict", detail: `conflict in ${conflicts.join(", ")}` });
          return;
        }
        let candidate: { candidateId: string; taskWorkspaceId: string; sha: string } | undefined;
        if (allowed.length > 0) {
          const sha = fake.makeCommit(files, [base]);
          fake.push(job.candidateFork.coords.namespace, job.candidateFork.coords.repoName, "main", sha);
          candidate = { candidateId: candidateId(job.candidateFork.taskWorkspaceId, sha), taskWorkspaceId: job.candidateFork.taskWorkspaceId, sha };
        }
        receipt = { jobId: signedJob.jobId, editionId: job.edition.editionId, resourceId: job.target.resourceId, ...(candidate ? { candidate } : {}), expectedHead: job.target.expectedHead, allowed, blocked, returnedAt: now };
        break;
      }
      case "apply-files": {
        const heads = await this.h.api("POST", "/api/runner/heads", { body: { signedJob } });
        const head = heads.body.heads?.[job.target.resourceId];
        if (head !== undefined && head !== job.target.expectedHead) {
          await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: "stale_base", detail: `${job.target.resourceId}: ledger head is ${head}, expected ${job.target.expectedHead}` });
          return;
        }
        const base = (parseRevisionId(job.target.expectedHead) as { sha: string }).sha;
        // the manifest and small text files only, through the job's blob scope (like the runner's ctx.blobs())
        const readBlob = async (key: string) => {
          const r = await this.h.api("GET", `/api/runner/blobs/${encodeURIComponent(key)}`, { headers: jobHeader(signedJob) });
          if (r.status === 404) return null;
          if (r.status !== 200) throw new Error(`blob refused: ${r.status} ${key}`);
          // (the harness decodes bodies as text; read the same object's bytes directly)
          const obj = await env.COMMONFORGE_ASSETS.get(key);
          return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
        };
        let out;
        try {
          // like the runner: the operations come from the job's R2 manifest, bound by sha256 and count
          const m = job.opsManifest;
          const bytes = await readBlob(m.r2Key);
          if (!bytes) throw new FakeJobFailure("provider_unavailable", `the operations manifest ${m.r2Key} is missing`);
          if (sha256HexSync(bytes) !== m.sha256) throw new FakeJobFailure("scope_violation", "the operations manifest does not match the job (sha256)");
          let ops: ApplyFilesOp[];
          try {
            ops = parseApplyFilesOps(JSON.parse(new TextDecoder().decode(bytes)), job.lfsThresholdBytes);
          } catch (e) {
            throw new FakeJobFailure("scope_violation", `the operations manifest is invalid: ${e instanceof Error ? e.message : String(e)}`);
          }
          if (ops.length !== m.count) throw new FakeJobFailure("scope_violation", `the operations manifest has ${ops.length} operations, the job says ${m.count}`);
          out = await fakeApplyFiles(job, ops, fake.files.get(base) ?? {}, readBlob);
        } catch (e) {
          if (!(e instanceof FakeJobFailure)) throw e;
          await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: e.code, detail: e.message });
          return;
        }
        let candidate: { candidateId: string; taskWorkspaceId: string; sha: string } | undefined;
        if (out.changedPaths.length > 0) {
          const sha = fake.makeCommit(out.files, [base]);
          fake.push(job.candidateFork.coords.namespace, job.candidateFork.coords.repoName, "main", sha);
          candidate = { candidateId: candidateId(job.candidateFork.taskWorkspaceId, sha), taskWorkspaceId: job.candidateFork.taskWorkspaceId, sha };
        }
        receipt = {
          jobId: signedJob.jobId,
          changeId: job.changeId,
          resourceId: job.target.resourceId,
          expectedHead: job.target.expectedHead,
          ...(candidate ? { candidate } : {}),
          changedPaths: out.changedPaths,
          lfsObjects: candidate ? out.lfsObjects : [],
          appliedAt: now,
        };
        break;
      }
      case "init-folder": {
        // like the real runner (apps/runner/src/jobs/init-folder.ts): one parentless commit of exactly
        // the job's files, pushed to canonical main only while main is absent. The real commit id is a
        // function of the job; the fake's is not, so "main already holds this commit" is checked as
        // "main is a parentless commit of exactly these files" (`already`); anything else fails.
        const repo = fake.repo(job.canonical.namespace, job.canonical.repoName);
        const files = Object.fromEntries(job.files.map((f) => [f.path, f.content]));
        const sorted = (m: Record<string, string>) => JSON.stringify(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : 1)));
        const current = repo.refs.get("main");
        let sha: string;
        let status: "created" | "already" = "created";
        if (current) {
          if (fake.commits.get(current)?.parents.length !== 0 || sorted(fake.files.get(current) ?? {}) !== sorted(files)) {
            await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: "branch_not_empty", detail: `refs/heads/main already holds ${current}` });
            return;
          }
          sha = current;
          status = "already";
        } else {
          sha = fake.makeCommit(files);
          fake.push(job.canonical.namespace, job.canonical.repoName, "main", sha);
        }
        receipt = { jobId: signedJob.jobId, resourceId: job.resourceId, commitSha: sha, status };
        break;
      }
      case "preview-build": {
        const prefix = job.outputPrefix ?? `previews/${job.previewId}/`;
        const put = async (key: string, raw: string) => {
          const r = await this.h.api("PUT", `/api/runner/blobs/${encodeURIComponent(key)}`, { raw, headers: { ...jobHeader(signedJob), "content-type": key.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" } });
          if (r.status !== 201) throw new Error(`blob write refused: ${r.status} ${JSON.stringify(r.body)}`);
        };
        await put(`${prefix}site/index.html`, `<h1>preview ${job.previewId}</h1>`);
        for (const b of job.bundles ?? []) await put(`${prefix}bundles/${b.name}/index.js`, "export default { fetch() { return new Response('api'); } };");
        receipt = { jobId: signedJob.jobId, previewId: job.previewId, url: `https://preview.test/p/${job.previewId}/`, integrationSha: job.integrationSha, recipe: { recipeId: job.recipe.recipeId, revision: job.recipe.revision }, readyAt: now, expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
        break;
      }
      case "release-build": {
        const targets = [];
        for (const t of job.targets) {
          const data = t.kind === "worker" ? `export default { fetch() { return new Response("${job.releaseId}"); } };` : `<p>${job.releaseId} ${JSON.stringify(job.sources.map((x) => x.sha))}</p>`;
          const path = t.kind === "worker" ? t.main! : "index.html";
          const key = `${job.outputPrefix}${t.targetId}/${path}`;
          const r = await this.h.api("PUT", `/api/runner/blobs/${encodeURIComponent(key)}`, { raw: data, headers: jobHeader(signedJob) });
          if (r.status !== 201) throw new Error(`blob write refused: ${r.status} ${JSON.stringify(r.body)}`);
          const files = [{ path, sha256: sha256HexSync(data), size: new TextEncoder().encode(data).byteLength }];
          const env: { vars: Record<string, string>; kvNamespaces: Array<{ binding: string; id: string }>; d1Databases?: Array<{ binding: string; id: string }>; data?: string[]; compatibilityFlags?: string[] } = job.environment[t.targetId] ?? { vars: {}, kvNamespaces: [] };
          const config = {
            compatibilityDate: "2026-08-22",
            compatibilityFlags: env.compatibilityFlags ?? [],
            vars: { APP_VERSION: "1.0.0", ...env.vars, COMMONFORGE_RELEASE_ID: job.releaseId },
            kvNamespaces: env.kvNamespaces,
            ...(env.d1Databases?.length ? { d1Databases: env.d1Databases } : {}),
          };
          // like the real runner: `data` paths (files or directories of the target's mount) are copied to <target>/__data/
          const dataFiles: Array<{ path: string; sha256: string; size: number }> = [];
          const mountFiles = fake.files.get(job.sources.find((s) => s.mountName === t.mountName)?.sha ?? "") ?? {};
          for (const p of env.data ?? []) {
            for (const [fp, content] of Object.entries(mountFiles).sort(([a], [b]) => (a < b ? -1 : 1))) {
              if ((fp !== p && !fp.startsWith(`${p}/`)) || dataFiles.some((d) => d.path === fp)) continue;
              const w = await this.h.api("PUT", `/api/runner/blobs/${encodeURIComponent(`${job.outputPrefix}${t.targetId}/__data/${fp}`)}`, { raw: content, headers: jobHeader(signedJob) });
              if (w.status !== 201) throw new Error(`blob write refused: ${w.status} ${JSON.stringify(w.body)}`);
              dataFiles.push({ path: fp, sha256: sha256HexSync(content), size: new TextEncoder().encode(content).byteLength });
            }
          }
          dataFiles.sort((a, b) => (a.path < b.path ? -1 : 1));
          targets.push({ targetId: t.targetId, digest: releaseTargetDigest(files, config, dataFiles), files, config, ...(dataFiles.length ? { dataFiles } : {}) });
        }
        receipt = { jobId: signedJob.jobId, releaseId: job.releaseId, outputDigest: releaseOutputDigest(targets), targets, builtAt: now };
        break;
      }
      case "release-deploy": {
        const cred = await this.h.api("POST", "/api/runner/deploy-credential", { body: { signedJob } });
        this.deployCredentials.push({ jobId: signedJob.jobId, status: cred.status, gotToken: typeof cred.body?.token === "string" });
        if (cred.status !== 200) throw new Error(`deploy credential refused: ${cred.status} ${JSON.stringify(cred.body)}`);
        for (const t of job.targets) {
          for (const f of t.files) {
            const r = await this.h.api("GET", `/api/runner/blobs/${encodeURIComponent(`${job.outputPrefix}${t.targetId}/${f.path}`)}`, { headers: jobHeader(signedJob) });
            if (r.status !== 200) throw new Error(`blob read refused: ${r.status}`);
          }
          for (const f of t.dataFiles ?? []) {
            const r = await this.h.api("GET", `/api/runner/blobs/${encodeURIComponent(`${job.outputPrefix}${t.targetId}/__data/${f.path}`)}`, { headers: jobHeader(signedJob) });
            if (r.status !== 200) throw new Error(`blob read refused: ${r.status}`);
          }
          // like the real runner: the target digest (files, config and data files) must match before anything is uploaded
          if (releaseTargetDigest(t.files, t.config, t.dataFiles ?? []) !== t.digest) {
            await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: "scope_violation", detail: `release target ${t.targetId} digest does not match its files and config` });
            return;
          }
        }
        const deployments = [];
        for (const [i, t] of job.targets.entries()) {
          if (this.opts.partialDeploy && i > 0) {
            await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: "provider_unavailable", detail: `partial: ${deployments.map((d) => d.targetId).join(",")}\nwrangler deploy of ${t.targetId} failed` });
            return;
          }
          this.opts.onDeploy?.(t.workerName, t.config.vars);
          // the deploy account now runs this upload (what the health check reads back)
          if (!this.opts.deployWithoutActivating) this.h.cf.active.set(t.workerName, [`ver-${signedJob.jobId}-${t.targetId}`]);
          deployments.push({ targetId: t.targetId, workerName: t.workerName, versionId: `ver-${signedJob.jobId}-${t.targetId}`, url: `https://${t.workerName}.demo.workers.dev` });
        }
        receipt = { jobId: signedJob.jobId, releaseId: job.releaseId, outputDigest: job.outputDigest, deployments, deployedAt: now };
        break;
      }
      case "staging-build": {
        const conflict = this.opts.stagingConflict;
        if (conflict && job.targets.some((t) => t.landings.some((l) => l.landingId === conflict.landingId))) {
          await this.post(signedJob, { jobId: signedJob.jobId, ok: false, code: "textual_conflict", detail: `landing ${conflict.landingId} conflicts in ${job.targets[0]!.resourceId}: ${conflict.paths.join(", ")}` });
          return;
        }
        // like the real runner: main plus each candidate's own change set (its diff from its baseSha),
        // in landing order, committed on top of main and pushed to refs/commonforge/staging (not a
        // branch), so the commit is only made reachable
        const results = job.targets.map((t) => {
          let sha = t.mainSha;
          if (t.landings.length > 0) {
            const files: Record<string, string> = { ...(fake.files.get(t.mainSha) ?? {}) };
            for (const l of t.landings) {
              for (const c of l.candidates) {
                const base = fake.files.get(c.baseSha) ?? {};
                const next = fake.files.get(c.sha) ?? {};
                for (const [p, v] of Object.entries(next)) if (base[p] !== v) files[p] = v;
                for (const p of Object.keys(base)) if (!(p in next)) delete files[p];
              }
            }
            sha = fake.makeCommit(files, [t.mainSha]);
          }
          fake.addObject(t.canonical.namespace, t.canonical.repoName, sha);
          return { resourceId: t.resourceId, sha, revisionId: artRevisionId(t.canonical.repoId, sha) };
        });
        receipt = { jobId: signedJob.jobId, buildId: job.buildId, results, builtAt: now };
        break;
      }
      default:
        throw new Error(`fake runner: ${(job as { kind: string }).kind} not supported`);
    }
    const mutate = this.opts.mutateReceipt?.[job.kind];
    if (mutate) receipt = mutate(receipt);
    const r = await this.post(signedJob, { jobId: signedJob.jobId, ok: true, receipt });
    if (r.status >= 300) throw new Error(`result refused: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

class FakeJobFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const ATTRS = ".gitattributes";
const enc = new TextEncoder();
const isPointerText = (s: string | undefined) => s !== undefined && enc.encode(s).length <= LFS_POINTER_MAX_BYTES && parseLfsPointer(s) !== null;

/**
 * The runner's `apply-files` (apps/runner/src/jobs/apply-files.ts) on a flat file map of strings:
 * pointers from the recorded hash for large/binary/pattern puts (exact `.gitattributes` entries
 * decided at the end against the final attributes), small text puts fetched and hash-checked, edits
 * checked against their blob, idempotent deletes and moves, path conflicts, classified paths.
 */
async function fakeApplyFiles(
  job: Extract<IntegrationJob, { kind: "apply-files" }>,
  ops: readonly ApplyFilesOp[],
  base: Record<string, string>,
  readSmall: (key: string) => Promise<Uint8Array | null>,
): Promise<{ files: Record<string, string>; changedPaths: ApplyFilesReceipt["changedPaths"]; lfsObjects: ApplyFilesReceipt["lfsObjects"] }> {
  const files: Record<string, string> = { ...base };
  const fail = (code: string, detail: string): never => {
    throw new FakeJobFailure(code, detail);
  };
  const isFolder = (p: string) => Object.keys(files).some((f) => f.startsWith(`${p}/`));
  const under = (p: string) => (files[p] !== undefined ? [p] : Object.keys(files).filter((f) => f.startsWith(`${p}/`)));
  const placeable = (p: string) => {
    if (isFolder(p)) fail("path_conflict", `${p} is a folder`);
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join("/");
      if (files[anc] !== undefined) fail("path_conflict", `${anc} is a file, so ${p} cannot be created below it`);
    }
  };
  let attrsText = files[ATTRS] ?? "";
  let attrsByOps = false;
  let isLfs = lfsAttributesMatcher(attrsText);
  const refreshAttrs = () => {
    attrsText = files[ATTRS] ?? "";
    attrsByOps = true;
    isLfs = lfsAttributesMatcher(attrsText);
  };
  const lfsObjects = new Map<string, { stagingId: string; sha256: string; size: number; pointer: string }>();
  const ours = new Set<string>();
  for (const op of ops) {
    if ("put" in op) {
      placeable(op.put);
      const small = op.size <= job.lfsThresholdBytes && !op.binary;
      if (op.put !== ATTRS && (!small || isLfs(op.put))) {
        const pointer = lfsPointer(op.sha256, op.size);
        files[op.put] = pointer;
        lfsObjects.set(op.stagingId, { stagingId: op.stagingId, sha256: op.sha256, size: op.size, pointer });
        ours.add(op.put);
      } else {
        if (!small || op.r2Key === undefined) fail("limit_exceeded", `${op.put} must be a small text file`);
        const bytes = await readSmall(op.r2Key!);
        if (!bytes) fail("provider_unavailable", `staged object ${op.stagingId} not found`);
        if (bytes!.length !== op.size || sha256HexSync(bytes!) !== op.sha256 || looksBinary(bytes!)) fail("hash_mismatch", `${op.put}: the staged file does not match what the platform verified`);
        files[op.put] = new TextDecoder().decode(bytes!);
      }
      if (op.put === ATTRS) refreshAttrs();
    } else if ("edit" in op) {
      const cur = files[op.edit];
      const changed = op.baseBlob === "" ? cur !== undefined : cur === undefined || (await gitBlobSha1(enc.encode(cur))) !== op.baseBlob;
      if (changed) fail("file_changed", `${op.edit} changed since it was opened`);
      if (isPointerText(cur)) fail("limit_exceeded", `${op.edit} is stored in LFS and cannot be edited in place`);
      if (enc.encode(op.content).length > job.lfsThresholdBytes) fail("limit_exceeded", `${op.edit}: edits are text under the LFS threshold`);
      if (cur === undefined) placeable(op.edit);
      files[op.edit] = op.content;
      if (op.edit === ATTRS) refreshAttrs();
    } else if ("delete" in op) {
      const paths = under(op.delete);
      for (const p of paths) delete files[p];
      if (paths.includes(ATTRS)) refreshAttrs();
    } else {
      const sources = under(op.move);
      if (sources.length === 0) {
        if (files[op.to] !== undefined || isFolder(op.to)) continue; // already moved (re-apply)
        fail("path_not_found", `${op.move} does not exist`);
      }
      if (op.to === op.move || op.to.startsWith(`${op.move}/`)) fail("path_conflict", `cannot move ${op.move} into itself`);
      const moves = sources.map((p) => ({ from: p, to: op.to + p.slice(op.move.length), content: files[p]! }));
      for (const m of moves) if (files[m.to] !== undefined && files[m.to] !== m.content) fail("path_conflict", `${m.to} already exists`);
      for (const m of moves) delete files[m.from];
      for (const m of moves) {
        placeable(m.to);
        files[m.to] = m.content;
        if (isPointerText(m.content)) ours.add(m.to);
      }
      if (sources.includes(ATTRS) || moves.some((m) => m.to === ATTRS)) refreshAttrs();
    }
  }
  // exact entries against the final .gitattributes, for pointers this job wrote that no pattern matches
  const pointers = [...ours].filter((p) => isPointerText(files[p]));
  const entries = pointers.filter((p) => !isLfs(p)).map((p) => gitattributesLfsEntry(p));
  let finalAttrs = attrsText;
  if (entries.length > 0) {
    finalAttrs = `${attrsText}${attrsText && !attrsText.endsWith("\n") ? "\n" : ""}${entries.join("\n")}\n`;
    if (files[ATTRS] === undefined) placeable(ATTRS);
    files[ATTRS] = finalAttrs;
  }
  const tracked = lfsAttributesMatcher(finalAttrs);
  for (const p of pointers) if (!tracked(p)) fail("limit_exceeded", `${p}: no .gitattributes entry stores this path in LFS`);
  const changedPaths: ApplyFilesReceipt["changedPaths"] = [];
  for (const p of [...new Set([...Object.keys(base), ...Object.keys(files)])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (base[p] === files[p]) continue;
    const change = base[p] === undefined ? "added" : files[p] === undefined ? "deleted" : "modified";
    const lfs = isPointerText(change === "deleted" ? base[p] : files[p]);
    // R7: a code file that was not in LFS, replaced (even by an LFS object), is a code change
    const replacesCode = change === "modified" && classifyPath(p, false) === "code" && !isPointerText(base[p]);
    changedPaths.push({ path: p, change, lfs, class: p === ATTRS && !attrsByOps ? "content" : replacesCode ? "code" : classifyPath(p, lfs) });
  }
  if (changedPaths.length > APPLY_FILES_LIMITS.maxChangedPaths) fail("limit_exceeded", `the change would touch ${changedPaths.length} paths; at most ${APPLY_FILES_LIMITS.maxChangedPaths} per change`);
  const final = new Set(Object.values(files));
  return { files, changedPaths, lfsObjects: [...lfsObjects.values()].filter((o) => final.has(o.pointer)).map(({ stagingId, sha256, size }) => ({ stagingId, sha256, size })) };
}
