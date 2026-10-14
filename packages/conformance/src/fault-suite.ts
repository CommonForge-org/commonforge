/**
 * `describeProviderFaultConformance` — the provider-generic rows of the fault-injection plan
 * (plan §G.5) against real git, for any git-backed `VersionProvider` (same factory contract as
 * {@link describeProviderConformance}):
 *
 * - **crash after fork, before the ledger record**: the app lost the handle, so only the
 *   deterministic workspace coordinates remain; `collectWorkspace` must delete the orphan (the GC
 *   sweep's job) and nothing can be minted for it afterwards; canonical is untouched.
 * - **provider/runner failure (5xx) during prepare**: `prepareForAcceptance` rejects, canonical
 *   keeps neither a retention ref nor a moved `main` (AT-12: no accepted state changes), and the
 *   retry prepares normally.
 * - **crash after the prepare receipt, before the ledger commit**: preparing again is idempotent
 *   (same retention ref, sha and revision), even after the workspace was collected.
 * - **crash after the ledger commit, before reconcile** (AT-13): a reconcile that died before its
 *   job leaves `refs/heads/main` lagging; the replay syncs it, and a duplicate replay is a no-op.
 *
 * Ledger-side rows (lost accept response → same idempotency key → same version, AT-14; partial
 * preparation, AT-12) are store-generic and live in `describeLedgerConformance` (scenarios
 * `AT-12.partial-preparation`, `AT-13.AT-14.replay`). Worker-specific rows (queue redelivery,
 * runner job expiry) are in apps/worker/test/fault, driven by `COMMONFORGE_CHAOS`.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptedVersionId,
  candidateRetentionRef,
  changeId as toChangeId,
  resourceId as toResourceId,
  toIsoUtc,
  type AcceptedHead,
  type FrozenCandidate,
  type PreparedReceipt,
  type RepoCoords,
  type ResourceRef,
  type RevisionId,
  type RunnerOutcome,
  type RunnerSubmit,
  type TaskWorkspaceHandle,
  type VersionProvider,
  type WorkspaceGrant,
} from '@commonforge-org/core';
import { IntegrationJobSchema } from '@commonforge-org/runner-protocol';
import { AgentCheckout, createSeedRepo, createTempDir, lsRemote, nodeGitRunner, removeDir, revisionForCoords, type GitRunner, type SeedRepo } from './git-helpers.js';
import { CONFORMANCE_ORG, CONFORMANCE_RESOURCE, SEED_FILES, type ProviderConformanceOptions, type ProviderUnderTest, type RunnerFactoryContext } from './provider-suite.js';
import { createReferenceRunner } from './reference-runner.js';

/** A thrown runner failure that stands in for a crash / 5xx between the provider and the runner. */
export class InjectedFault extends Error {
  constructor(readonly point: string) {
    super(`injected fault: ${point}`);
    this.name = 'InjectedFault';
  }
}

export function describeProviderFaultConformance(options: ProviderConformanceOptions): void {
  const timeout = options.timeoutMs ?? 60_000;
  const git = options.git ?? nodeGitRunner();

  describe.sequential(`${options.name ?? 'VersionProvider'}: fault injection (plan §G.5)`, () => {
    let workDir = '';
    let seed: SeedRepo;
    let put: ProviderUnderTest;
    let provider: VersionProvider;
    let resource: ResourceRef;
    let canonical: RepoCoords;
    let serviceGit: GitRunner;
    let baseRevision: RevisionId;
    let ledgerHead: RevisionId | null = null;
    let innerSubmit: RunnerSubmit;
    /** per job kind: fail the next N submissions before they reach the runner */
    const faults = new Map<string, { remaining: number; outcome: 'reject' | 'provider_unavailable' }>();
    let dirSeq = 0;
    const scratch = (label: string) => join(workDir, `fault-${++dirSeq}-${label}`);
    const canonicalSha = (ref: string) => lsRemote(serviceGit, workDir, canonical.remoteUrl, ref);

    const submit = (async (request: unknown): Promise<RunnerOutcome<unknown>> => {
      const job = IntegrationJobSchema.parse(request);
      const f = faults.get(job.kind);
      if (f && f.remaining > 0) {
        f.remaining--;
        if (f.outcome === 'reject') throw new InjectedFault(`${job.kind} crashed before the runner answered`);
        return { jobId: `job-fault-${dirSeq++}`, ok: false, code: 'provider_unavailable', detail: `injected: provider 5xx during ${job.kind}` };
      }
      return (innerSubmit as (j: unknown) => Promise<RunnerOutcome<unknown>>)(request);
    }) as RunnerSubmit;

    const grant = (ops: WorkspaceGrant['operations'], id: string): WorkspaceGrant => ({
      principal: { kind: 'agent', id, onBehalfOf: { kind: 'user', id: 'user-fault' } },
      operations: ops,
      ttlSeconds: 3600,
      leaseGeneration: 1,
    });
    const newWorkspace = (n: string) =>
      provider.createIsolatedChange({ resource, baseRevision, taskId: `task-fault-${n}`, organizationId: resource.organizationId, changeId: toChangeId(`change-fault-${n}`), purpose: 'agent-task' });
    const gitFor = (cred: Parameters<NonNullable<ProviderUnderTest['gitForCredential']>>[0]): GitRunner => put.gitForCredential?.(cred) ?? git;

    /** A workspace with one pushed commit, frozen. */
    const frozenCandidate = async (n: string, files: Record<string, string>): Promise<{ handle: TaskWorkspaceHandle; frozen: FrozenCandidate }> => {
      const handle = await newWorkspace(n);
      const cred = await provider.issueWorkspaceCredential(handle, grant(['read', 'write'], `agent-${n}`));
      const checkout = await AgentCheckout.clone(gitFor(cred), cred.remoteUrl, scratch(`agent-${n}`));
      const sha = await checkout.commit(files, `agent ${n}`);
      const pushed = await checkout.push();
      expect(pushed.code, pushed.stderr).toBe(0);
      const frozen = await provider.freezeCandidate(handle, { expectedSha: sha, submitter: { kind: 'agent', id: `agent-${n}`, onBehalfOf: { kind: 'user', id: 'user-fault' } }, tool: 'conformance' });
      return { handle, frozen };
    };

    beforeAll(async () => {
      workDir = await createTempDir();
      seed = await createSeedRepo(git, join(workDir, 'seed'), SEED_FILES);
      put = await options.makeProvider({ workDir, git, seed, organizationId: CONFORMANCE_ORG, resourceId: toResourceId(CONFORMANCE_RESOURCE) });
      ({ provider, resource, canonical } = put);
      serviceGit = put.serviceGit ?? git;
      baseRevision = revisionForCoords(canonical, seed.sha);
      ledgerHead = baseRevision;
      const runnerCtx: RunnerFactoryContext = { git: serviceGit, workDir: join(workDir, 'runner'), currentHead: (rid) => (rid === resource.resourceId ? ledgerHead : null) };
      innerSubmit = options.makeRunner?.(runnerCtx) ?? createReferenceRunner(runnerCtx).submit;
    }, timeout);

    afterAll(async () => {
      await put?.dispose?.();
      if (workDir) await removeDir(workDir);
    });

    let prepared: { handle: TaskWorkspaceHandle; frozen: FrozenCandidate; receipt?: PreparedReceipt } | undefined;

    it('crash after fork, before the ledger record: the orphan is collected and refuses credentials; canonical is untouched', async () => {
      const orphan = await newWorkspace('orphan');
      // the app "crashed": it never recorded the handle; the sweep finds the workspace by its coordinates
      expect((await serviceGit(['ls-remote', orphan.coords.remoteUrl], workDir)).code, 'the fork exists').toBe(0);
      await provider.collectWorkspace({ ...orphan, state: 'abandoned' });
      expect((await serviceGit(['ls-remote', orphan.coords.remoteUrl], workDir)).code, 'the orphan is gone').not.toBe(0);
      await expect(provider.issueWorkspaceCredential(orphan, grant(['read', 'write'], 'agent-orphan'))).rejects.toMatchObject({ code: expect.stringMatching(/^(workspace_not_writable|not_found)$/) });
      expect(await canonicalSha('refs/heads/main')).toBe(seed.sha);
      // collecting again is harmless (a sweep can run twice)
      await provider.collectWorkspace({ ...orphan, state: 'abandoned' }).catch((e: { code?: string }) => expect(e.code).toMatch(/^(not_found|workspace_not_writable)$/));
    }, timeout);

    it('provider 5xx during prepare (AT-12): nothing is retained in canonical and main does not move; the retry prepares', async () => {
      const c = await frozenCandidate('prep', { 'README.md': '# Conformance fixture\nline: fault\n' });
      const ref = candidateRetentionRef(c.frozen.candidateId);
      for (const outcome of ['provider_unavailable', 'reject'] as const) {
        faults.set('prepare-candidate', { remaining: 1, outcome });
        await expect(provider.prepareForAcceptance(c.frozen, submit)).rejects.toBeTruthy();
        expect(await canonicalSha(ref), `${outcome}: no retention ref`).toBeNull();
        expect(await canonicalSha('refs/heads/main'), `${outcome}: main unchanged`).toBe(seed.sha);
      }
      const receipt = await provider.prepareForAcceptance(c.frozen, submit);
      expect(receipt).toMatchObject({ candidateId: c.frozen.candidateId, canonicalRef: ref, sha: c.frozen.sha });
      expect(await canonicalSha(ref)).toBe(c.frozen.sha);
      expect(await canonicalSha('refs/heads/main')).toBe(seed.sha);
      prepared = { ...c, receipt };
    }, timeout);

    it('crash after the prepare receipt, before commit: preparing again is idempotent, also after the workspace is collected', async () => {
      if (!prepared?.receipt) throw new Error('earlier step failed: no prepared candidate');
      const again = await provider.prepareForAcceptance(prepared.frozen, submit);
      expect(again).toMatchObject({ canonicalRef: prepared.receipt.canonicalRef, sha: prepared.receipt.sha, revisionId: prepared.receipt.revisionId });
      await provider.collectWorkspace(prepared.handle);
      const afterCollect = await provider.prepareForAcceptance(prepared.frozen, submit).catch((e: unknown) => e);
      // a provider may refuse to re-prepare from a collected fork, but never with a different receipt
      if (afterCollect && typeof afterCollect === 'object' && 'canonicalRef' in afterCollect) {
        expect(afterCollect).toMatchObject({ canonicalRef: prepared.receipt.canonicalRef, sha: prepared.receipt.sha });
      }
      expect(await canonicalSha(prepared.receipt.canonicalRef)).toBe(prepared.receipt.sha);
    }, timeout);

    it('crash after commit, before reconcile (AT-13): main lags until the replay; a duplicate replay is a no-op', async () => {
      if (!prepared?.receipt) throw new Error('earlier step failed: no prepared candidate');
      // the ledger commits (simulated): the head moves, refs/heads/main is only its projection
      ledgerHead = prepared.receipt.revisionId;
      const head: AcceptedHead = {
        resourceId: resource.resourceId,
        revisionId: prepared.receipt.revisionId,
        versionSeq: 2,
        acceptedVersionId: acceptedVersionId('av-fault-000000000002'),
        acceptedAt: toIsoUtc(),
        reconciliation: 'pending',
      };
      faults.set('reconcile-ref', { remaining: 1, outcome: 'reject' });
      await expect(provider.reconcileAccepted(resource, head, submit)).rejects.toBeInstanceOf(InjectedFault);
      expect(await canonicalSha('refs/heads/main'), 'main still lags').toBe(seed.sha);

      const replay = await provider.reconcileAccepted(resource, head, submit);
      expect(replay).toMatchObject({ status: 'synced', targetSha: prepared.receipt.sha, observedSha: prepared.receipt.sha });
      expect(await canonicalSha('refs/heads/main')).toBe(prepared.receipt.sha);
      const duplicate = await provider.reconcileAccepted(resource, head, submit);
      expect(duplicate).toMatchObject({ status: 'synced', observedSha: prepared.receipt.sha });
      expect(await canonicalSha('refs/heads/main')).toBe(prepared.receipt.sha);
    }, timeout);
  });
}
