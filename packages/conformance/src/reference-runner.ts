/**
 * A reference `RunnerSubmit` that executes `prepare-candidate`, `integrate`, `reconcile-ref` and
 * `seed-workspace` jobs with real git (Node only). It is the default runner of the provider suite and a readable
 * statement of what those jobs must do; the production runner (`apps/runner`) replaces it.
 *
 * Behavior follows plan §B.8 and the spike results in §0.3:
 * - every push updates exactly one ref and uses `--force-with-lease=<ref>:<sha>` (no `--atomic`:
 *   Artifacts refuses it). A multi-target `integrate` pushes its targets sequentially; if a later
 *   push fails, the job fails with `provider_unavailable` naming the refs already pushed. Those
 *   refs are unique per job (`.../<proposalId>/<jobId>`) and unreferenced by the ledger, so a
 *   partial result is inert and a retry runs as a new job;
 * - candidates are retained in canonical under `refs/commonforge/candidates/<ws>/<sha>`;
 * - integrations are pushed to `refs/commonforge/integrations/<proposalId>/<jobId>`;
 * - everything is addressed by sha (refs are only listed with `ls-remote`);
 * - an assets-only `integrate` (no targets, non-empty `assetChanges`) merges and pushes nothing and
 *   signs evidence with an empty `mergeOutcome` and `results: []`.
 *
 * Every job is validated with runner-protocol's `IntegrationJobSchema` first, so a provider that
 * builds a malformed job fails loudly. It does not sign jobs, run checks or contracts, or retry
 * `receive-pack busy`; it signs integration evidence with a per-job key derived from `jobKey`.
 *
 * Staleness: the "current head" of a resource is the **ledger** head, never canonical
 * `refs/heads/main` (a projection that may be `pending` or `diverged`). An `integrate` target is
 * `stale_base` when the job's own `must-match-accepted` snapshot entry disagrees with its
 * `expectedHead`, or when the injected `currentHead(resourceId)` port (fed from the ledger)
 * returns a different revision. The ledger CAS at accept time remains the authority.
 *
 * Job ids: `RunnerSubmit` carries the bare job, so this runner assigns `ref-job-<n>`; integrate
 * pushes to the job's `integrationRef` verbatim. A production runner uses `SignedJob.jobId`.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  candidateRetentionRef,
  revisionCommitSha,
  toIsoUtc,
  type IntegrationReceipt,
  type PreparedReceipt,
  type ReconcileResult,
  type RevisionId,
  type SeedWorkspaceReceipt,
  type RunnerOutcome,
  type RunnerSubmit,
} from '@commonforge-org/core';
import {
  deriveEvidenceKey,
  IntegrationJobSchema,
  signEvidence,
  type IntegrationJob,
  type JobOfKind,
  type JobSigningKey,
} from '@commonforge-org/runner-protocol';
import { COMMIT_CONFIG, gitOk, initBareRepo, initWorkRepo, lsRemote, pushRef, revisionForCoords, type GitRunner } from './git-helpers.js';

export interface ReferenceRunnerOptions {
  /** git used for every fetch/push (must be able to read task forks and write canonical repos) */
  git: GitRunner;
  /** scratch directory for temporary repositories */
  workDir: string;
  /** the ledger's current accepted head of a resource (null = none); used for `stale_base` */
  currentHead?: (resourceId: string) => RevisionId | null | Promise<RevisionId | null>;
  /** key the per-job evidence keys are derived from (default: a random key, kid `conformance`) */
  jobKey?: JobSigningKey;
  runnerId?: string;
  /** called with every validated job before it runs (tests use it to inject concurrent writers) */
  beforeJob?: (job: IntegrationJob) => void | Promise<void>;
  now?: () => string;
}

export interface ReferenceRunner {
  submit: RunnerSubmit;
  /** every validated job, in submission order */
  readonly jobs: IntegrationJob[];
  /** the key evidence is derived from (to verify integration evidence) */
  readonly jobKey: JobSigningKey;
}

type Outcome = RunnerOutcome<unknown>;

export function createReferenceRunner(options: ReferenceRunnerOptions): ReferenceRunner {
  const { git, workDir } = options;
  const now = options.now ?? (() => toIsoUtc());
  const jobKey: JobSigningKey = options.jobKey ?? { kid: 'conformance', secret: crypto.getRandomValues(new Uint8Array(32)) };
  const runnerId = options.runnerId ?? 'conformance-reference';
  const jobs: IntegrationJob[] = [];
  let seq = 0;

  const scratch = async (label: string): Promise<string> => {
    const dir = join(workDir, `runner-${++seq}-${label}`);
    await mkdir(dir, { recursive: true });
    return dir;
  };

  /** A bare scratch repo holding `sha` fetched from `remote` (by sha; falls back to all refs). */
  const fetchSha = async (dir: string, remote: string, sha: string): Promise<boolean> => {
    if ((await git(['fetch', '-q', '--no-tags', remote, sha], dir)).code !== 0) {
      await git(['fetch', '-q', '--no-tags', remote, '+refs/*:refs/fetched/*'], dir);
    }
    return (await git(['cat-file', '-e', `${sha}^{commit}`], dir)).code === 0;
  };

  async function prepareCandidate(jobId: string, job: JobOfKind<'prepare-candidate'>): Promise<Outcome> {
    const { candidate, canonical, retentionRef } = job;
    const dir = await scratch('prepare');
    await initBareRepo(git, dir);
    const existing = await lsRemote(git, dir, canonical.remoteUrl, retentionRef);
    if (existing !== null && existing !== candidate.sha) {
      // a retention ref names its sha; a different sha there is a conflicting claim no retry fixes
      return { jobId, ok: false, code: 'scope_violation', detail: `${retentionRef} already holds ${existing}` };
    }
    if (existing === null) {
      if (!(await fetchSha(dir, candidate.fork.remoteUrl, candidate.sha))) {
        return { jobId, ok: false, code: 'provider_unavailable', detail: `candidate ${candidate.sha} not found in task fork` };
      }
      const tree = (await gitOk(git, ['rev-parse', `${candidate.sha}^{tree}`], dir)).trim();
      if (tree !== candidate.treeId) {
        return { jobId, ok: false, code: 'scope_violation', detail: `candidate tree ${tree} != frozen treeId ${candidate.treeId}` };
      }
      const push = await pushRef(git, dir, canonical.remoteUrl, candidate.sha, retentionRef, { expectedSha: null });
      if (push.code !== 0 && (await lsRemote(git, dir, canonical.remoteUrl, retentionRef)) !== candidate.sha) {
        return { jobId, ok: false, code: 'provider_unavailable', detail: `retention push refused: ${push.stderr.trim()}` };
      }
    }
    const receipt: PreparedReceipt = {
      receiptId: `rcpt-${jobId}`,
      jobId,
      candidateId: candidate.candidateId,
      resourceId: candidate.resourceId,
      canonicalRef: retentionRef,
      sha: candidate.sha,
      revisionId: revisionForCoords(canonical, candidate.sha),
      verifiedAssetObjects: [],
      preparedAt: now(),
    };
    return { jobId, ok: true, receipt };
  }

  async function integrate(jobId: string, job: JobOfKind<'integrate'>): Promise<Outcome> {
    if (job.checks.length > 0 || job.contracts.length > 0) {
      throw new Error('reference runner does not execute checks or contracts');
    }
    const results: IntegrationReceipt['results'] = [];
    const pushes: Array<{ dir: string; remote: string; sha: string }> = [];
    for (const target of job.targets) {
      const expectedSha = revisionCommitSha(target.expectedHead as RevisionId)!;
      const dir = await scratch('integrate');
      await initWorkRepo(git, dir);
      const entry = job.baseSnapshot.entries.find((e) => e.resourceId === target.resourceId && e.mode === 'must-match-accepted');
      if (entry && entry.revisionId !== target.expectedHead) {
        return { jobId, ok: false, code: 'stale_base', detail: `${target.resourceId}: snapshot pins ${entry.revisionId}, expectedHead is ${target.expectedHead}` };
      }
      if (options.currentHead) {
        const current = await options.currentHead(target.resourceId);
        if (current !== target.expectedHead) {
          return { jobId, ok: false, code: 'stale_base', detail: `${target.resourceId}: ledger head is ${current ?? 'none'}, expected ${target.expectedHead}` };
        }
      }
      if (!(await fetchSha(dir, target.canonical.remoteUrl, expectedSha))) {
        return { jobId, ok: false, code: 'provider_unavailable', detail: `expected head ${expectedSha} not in canonical` };
      }
      await gitOk(git, ['checkout', '-q', '--detach', expectedSha], dir);
      for (const c of job.candidates.filter((x) => x.resourceId === target.resourceId)) {
        // Candidates must already be retained in canonical (prepared); never read from the task fork.
        const ref = candidateRetentionRef(c.candidateId);
        if ((await git(['fetch', '-q', '--no-tags', target.canonical.remoteUrl, `+${ref}:${ref}`], dir)).code !== 0) {
          return { jobId, ok: false, code: 'provider_unavailable', detail: `candidate ${c.candidateId} is not retained in canonical (${ref})` };
        }
        const merge = await git([...COMMIT_CONFIG, 'merge', '--no-ff', '--no-edit', '-m', `integrate ${c.candidateId}`, c.sha], dir);
        if (merge.code !== 0) {
          const paths = (await gitOk(git, ['diff', '--name-only', '--diff-filter=U'], dir)).split('\n').filter(Boolean).sort();
          await git(['merge', '--abort'], dir);
          return { jobId, ok: false, code: 'textual_conflict', detail: `${target.resourceId}: conflict in ${paths.join(', ') || '(unknown)'}` };
        }
      }
      const sha = (await gitOk(git, ['rev-parse', 'HEAD'], dir)).trim();
      pushes.push({ dir, remote: target.canonical.remoteUrl, sha });
      results.push({
        resourceId: target.resourceId,
        integrationRef: job.integrationRef,
        sha,
        revisionId: revisionForCoords(target.canonical, sha),
        expectedHead: target.expectedHead,
      });
    }
    const pushed: string[] = [];
    for (const p of pushes) {
      const r = await pushRef(git, p.dir, p.remote, p.sha, job.integrationRef, { expectedSha: null });
      if (r.code !== 0 && (await lsRemote(git, p.dir, p.remote, job.integrationRef)) !== p.sha) {
        const partial = pushed.length ? ` (partial: already pushed to ${pushed.join(', ')})` : '';
        return { jobId, ok: false, code: 'provider_unavailable', detail: `integration push to ${p.remote} refused: ${r.stderr.trim()}${partial}` };
      }
      pushed.push(p.remote);
    }
    const producedAt = now();
    const evidence = await signEvidence(
      {
        evidenceId: `ev-${jobId}`,
        proposalHash: job.proposalHash,
        snapshotId: job.candidateSnapshotId,
        runnerId,
        runnerKind: 'node-runner',
        checks: [],
        contractChecks: [],
        mergeOutcome: job.targets.map((t) => ({ resourceId: t.resourceId, result: 'clean' as const })),
        producedAt,
      },
      await deriveEvidenceKey(jobKey, jobId),
      { jobId },
    );
    const receipt: IntegrationReceipt = { jobId, proposalId: job.proposalId, results, evidence, integratedAt: producedAt };
    return { jobId, ok: true, receipt };
  }

  async function reconcileRef(jobId: string, job: JobOfKind<'reconcile-ref'>): Promise<Outcome> {
    const { canonical, ref, targetSha, expectedCurrentSha } = job;
    const dir = await scratch('reconcile');
    await initBareRepo(git, dir);
    const result = (observedSha: string | null): Outcome => {
      const receipt: ReconcileResult = {
        jobId,
        ...(job.resourceId ? { resourceId: job.resourceId } : {}),
        ref,
        targetSha,
        observedSha,
        status: observedSha === targetSha ? 'synced' : 'diverged',
        reconciledAt: now(),
      };
      return { jobId, ok: true, receipt };
    };
    const before = await lsRemote(git, dir, canonical.remoteUrl, ref);
    if (before === targetSha) return result(before);
    if (!(await fetchSha(dir, canonical.remoteUrl, targetSha))) {
      return { jobId, ok: false, code: 'provider_unavailable', detail: `target ${targetSha} is not retained in canonical` };
    }
    const push = await pushRef(git, dir, canonical.remoteUrl, targetSha, ref, { expectedSha: expectedCurrentSha });
    const after = await lsRemote(git, dir, canonical.remoteUrl, ref);
    if (push.code !== 0 && after !== targetSha && after === expectedCurrentSha) {
      // the ref did not move: the push failed (busy, network, auth), not a concurrent writer
      return { jobId, ok: false, code: 'provider_unavailable', detail: `reconcile push failed: ${push.stderr.trim()}` };
    }
    return result(after);
  }

  /**
   * Seed a fresh task repo: fetch `baseSha` from canonical, push exactly `<baseSha>:<ref>` with a
   * must-not-exist lease; a lease failure where the ref already holds `baseSha` is success.
   */
  async function seedWorkspace(jobId: string, job: JobOfKind<'seed-workspace'>): Promise<Outcome> {
    const dir = await scratch('seed');
    await initBareRepo(git, dir);
    const existing = await lsRemote(git, dir, job.taskFork.remoteUrl, job.ref);
    if (existing !== null && existing !== job.baseSha) {
      return { jobId, ok: false, code: 'scope_violation', detail: `${job.ref} already holds ${existing}` };
    }
    if (existing === null) {
      if (!(await fetchSha(dir, job.canonical.remoteUrl, job.baseSha))) {
        return { jobId, ok: false, code: 'provider_unavailable', detail: `base ${job.baseSha} not in canonical` };
      }
      const push = await pushRef(git, dir, job.taskFork.remoteUrl, job.baseSha, job.ref, { expectedSha: null });
      if (push.code !== 0 && (await lsRemote(git, dir, job.taskFork.remoteUrl, job.ref)) !== job.baseSha) {
        return { jobId, ok: false, code: 'provider_unavailable', detail: `seed push refused: ${push.stderr.trim()}` };
      }
    }
    const receipt: SeedWorkspaceReceipt = {
      jobId,
      taskWorkspaceId: job.taskWorkspaceId,
      resourceId: job.resourceId,
      ref: job.ref,
      sha: job.baseSha,
      seededAt: now(),
    };
    return { jobId, ok: true, receipt };
  }

  const submit = (async (request: unknown): Promise<Outcome> => {
    const job = IntegrationJobSchema.parse(request);
    jobs.push(job);
    await options.beforeJob?.(job);
    const jobId = `ref-job-${jobs.length}`;
    switch (job.kind) {
      case 'prepare-candidate':
        return prepareCandidate(jobId, job);
      case 'integrate':
        return integrate(jobId, job);
      case 'reconcile-ref':
        return reconcileRef(jobId, job);
      case 'seed-workspace':
        return seedWorkspace(jobId, job);
      default:
        throw new Error(`reference runner does not execute ${job.kind} jobs`);
    }
  }) as RunnerSubmit;

  return { submit, jobs, jobKey };
}
