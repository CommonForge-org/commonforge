/**
 * `integrate` (plan §B.8, §B.7, §C.1 rows 6–7): merge prepared candidates onto each target's
 * ledger head, run allowlisted checks and contract checks against the merged trees, push each
 * target's integration commit to the per-job ref `refs/commonforge/integrations/<proposalId>/<jobId>`
 * and return signed ValidationEvidence.
 *
 * Order and rules:
 * 1. Stale check per target (`stale_base`): the job's `must-match-accepted` snapshot entry and the
 *    ledger head (when the Worker provides it) must equal `expectedHead`. Canonical
 *    `refs/heads/main` is never consulted: it is a projection that may lag or diverge.
 * 2. Merge without a working tree (`git merge-tree --write-tree`) in a bare scratch repo, reading
 *    candidates from their canonical retention refs only (they must be prepared). Conflicts in
 *    any target → `textual_conflict` listing the paths; nothing is pushed.
 * 3. All fetching is finished before any check starts, so no git process holding a token runs
 *    concurrently with candidate code. Before the checks, the runner installs each mount's
 *    dependencies from its committed lockfile (`install.ts`: no scripts, check uid, the only step
 *    with network), so checks can run with no network at all. Checks run in an exported copy of the merged trees (no
 *    `.git`), in isolated child processes (see `commands.ts`). Contract checks run the producer
 *    command there too, but the JSON Schema is read from git (trusted), never from the check
 *    copy, and validated in this process. Contract failure → `contract_failed`; a failed required
 *    check → `check_failed`.
 * 4. Push targets sequentially, one lease-guarded ref per push (no `--atomic`); a later failure
 *    reports which refs were already pushed (they are unique per job and inert).
 * 5. Evidence is signed here, in the supervisor, with the per-job derived key, bound to the
 *    proposal's candidate snapshot (`job.candidateSnapshotId`; the ledger checks it there).
 *
 * Assets-only proposals (follow-up Task 23): the job has no candidates and no targets, only
 * `assetChanges`. Steps 1, 2 and 4 then do nothing; the checks and contracts of step 3 run on the
 * snapshot's git mounts, all of them references at their pinned revisions, after the same
 * runner-controlled install. The evidence has `mergeOutcome: []` and the receipt `results: []`. Asset
 * bytes are never read here: the evidence binds the manifests through `proposalHash`.
 */
import { join } from 'node:path';
import {
  candidateRetentionRef,
  revisionCommitSha,
  type CheckResult,
  type ContractCheckResult,
  type MergeOutcome,
  type RevisionId,
} from '@commonforge-org/core';
import type { JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { fetchRef, RUNNER_IDENTITY_ENV } from '../git.js';
import { UnsupportedSchemaError, validateJsonSchema } from '../json-schema.js';
import { INSTALLED_CHECK_ENV, installMountDependencies } from '../install.js';
import { exportTree, readBlob } from '../tree.js';
import { fetchCommits, scratchRepo } from './common.js';

type Ctx = JobContext<'integrate'>;

interface MergedTarget {
  resourceId: string;
  dir: string;
  sha: string;
  expectedHead: RevisionId;
}

/** Fail the job, attaching signed evidence when the evidence key is available. */
async function fail(ctx: Ctx, code: 'stale_base' | 'textual_conflict' | 'check_failed' | 'contract_failed' | 'scope_violation', detail: string, ev: { checks?: CheckResult[]; contractChecks?: ContractCheckResult[]; mergeOutcome: MergeOutcome[] }): Promise<never> {
  const evidence = ctx.evidenceKey
    ? await ctx.signEvidence({
        proposalHash: ctx.job.proposalHash,
        snapshotId: ctx.job.candidateSnapshotId,
        checks: ev.checks ?? [],
        contractChecks: ev.contractChecks ?? [],
        mergeOutcome: ev.mergeOutcome,
      })
    : undefined;
  throw new JobFailure(code, ctx.redact(detail), evidence);
}

export async function integrate(ctx: Ctx): Promise<JobReceiptByKind['integrate']> {
  const job = ctx.job;
  const entries = job.baseSnapshot.entries;

  // 1. stale checks (ledger authority, never refs/heads/main)
  const stale: MergeOutcome[] = [];
  const staleWhy: string[] = [];
  for (const t of job.targets) {
    const entry = entries.find((e) => e.resourceId === t.resourceId && e.mode === 'must-match-accepted');
    if (entry && entry.revisionId !== t.expectedHead) {
      stale.push({ resourceId: t.resourceId, result: 'stale-base' });
      staleWhy.push(`${t.resourceId}: snapshot pins ${entry.revisionId}, expectedHead is ${t.expectedHead}`);
      continue;
    }
    const head = await ctx.currentHead(t.resourceId);
    if (head !== undefined && head !== t.expectedHead) {
      stale.push({ resourceId: t.resourceId, result: 'stale-base' });
      staleWhy.push(`${t.resourceId}: ledger head is ${head ?? 'none'}, expected ${t.expectedHead}`);
    }
  }
  if (stale.length > 0) await fail(ctx, 'stale_base', staleWhy.join('; '), { mergeOutcome: stale });

  // 2. merge per target
  const merged: MergedTarget[] = [];
  const outcomes: MergeOutcome[] = [];
  const conflicts: string[] = [];
  for (const t of job.targets) {
    const expectedSha = revisionCommitSha(t.expectedHead as RevisionId)!;
    const dir = await scratchRepo(ctx, `integrate-${t.resourceId}`);
    const env = await ctx.writeEnv(t.canonical);
    await fetchCommits(ctx, dir, t.canonical, [expectedSha], `expected head ${expectedSha}`);
    let current = expectedSha;
    let conflictPaths: string[] = [];
    for (const c of job.candidates.filter((x) => x.resourceId === t.resourceId)) {
      const ref = candidateRetentionRef(c.candidateId);
      const fetched = await fetchRef(ctx.git, dir, t.canonical.remoteUrl, ref, env);
      if (fetched !== c.sha) {
        throw new JobFailure('provider_unavailable', `candidate ${c.candidateId} is not retained in canonical (${ref}); prepare it first`);
      }
      // promotion builds name each candidate's own base: it is merged from there and never skipped by ancestry
      const base = job.mergeBases?.[c.candidateId];
      if (base === undefined && (await ctx.git.run(['merge-base', '--is-ancestor', c.sha, current], dir)).code === 0) continue; // already contained
      if (base !== undefined) {
        await fetchCommits(ctx, dir, t.canonical, [base], `merge base ${base} of ${c.candidateId}`);
        if ((await ctx.git.run(['merge-base', '--is-ancestor', base, c.sha], dir)).code !== 0) {
          throw new JobFailure('scope_violation', `candidate ${c.sha} does not descend from its merge base ${base}`);
        }
      }
      const mt = await ctx.git.run(['merge-tree', '--write-tree', '--name-only', '-z', '--no-messages', ...(base !== undefined ? [`--merge-base=${base}`] : []), current, c.sha], dir);
      const parts = mt.stdout.split('\0').filter(Boolean);
      if (mt.code === 1) {
        conflictPaths = [...new Set([...conflictPaths, ...parts.slice(1)])].sort();
        continue;
      }
      if (mt.code !== 0 || !parts[0]) throw new JobFailure('provider_unavailable', ctx.redact(`merge of ${c.candidateId} failed: ${mt.stderr.trim()}`));
      const msg = `${base !== undefined ? 'promote' : 'integrate'} ${c.candidateId}\n\nproposal ${job.proposalId}\njob ${ctx.jobId}\n`;
      const parentArgs = base !== undefined ? ['-p', current] : ['-p', current, '-p', c.sha];
      current = (await ctx.git.ok(['commit-tree', parts[0], ...parentArgs, '-m', msg], dir, { env: RUNNER_IDENTITY_ENV(ctx.commitDate()) })).trim();
    }
    if (conflictPaths.length > 0) {
      outcomes.push({ resourceId: t.resourceId, result: 'textual-conflict', conflictPaths });
      conflicts.push(`${t.resourceId}: ${conflictPaths.join(', ')}`);
    } else {
      outcomes.push({ resourceId: t.resourceId, result: 'clean' });
    }
    merged.push({ resourceId: t.resourceId, dir, sha: current, expectedHead: t.expectedHead });
  }
  if (conflicts.length > 0) await fail(ctx, 'textual_conflict', `conflict in ${conflicts.join('; ')}`, { mergeOutcome: outcomes });

  // reference mounts at their pinned revisions (read only)
  const sources = new Map<string, { dir: string; sha: string }>();
  for (const m of merged) sources.set(m.resourceId, { dir: m.dir, sha: m.sha });
  const needed = new Set<string>([
    ...job.contracts.map((c) => c.schema.resourceId as string),
    ...job.checks.map((c) => entries.find((e) => e.mountName === c.mountName)?.resourceId as string),
    ...job.contracts.map((c) => entries.find((e) => e.mountName === c.producerOutput.mountName)?.resourceId as string),
  ]);
  if (job.checks.length > 0 || job.contracts.length > 0) {
    for (const ref of job.references ?? []) {
      if (sources.has(ref.resourceId)) continue;
      const entry = entries.find((e) => e.resourceId === ref.resourceId);
      const sha = entry ? revisionCommitSha(entry.revisionId as RevisionId) : null;
      if (!sha) continue;
      const dir = await scratchRepo(ctx, `ref-${ref.resourceId}`);
      await fetchCommits(ctx, dir, ref.coords, [sha], `reference ${ref.resourceId}@${sha}`);
      sources.set(ref.resourceId, { dir, sha });
    }
    for (const rid of needed) {
      if (rid && !sources.has(rid)) throw new JobFailure('scope_violation', `checks need resource ${rid}, which is neither a target nor a reference of this job`);
    }
  }

  // 3. checks and contracts — no token-holding git process runs from here until the pushes
  const checks: CheckResult[] = [];
  const contractChecks: ContractCheckResult[] = [];
  const failures: string[] = [];
  if (job.checks.length > 0 || job.contracts.length > 0) {
    ctx.assertCheckIsolation();
    // outside the job dir: candidate code never sits next to the repositories we push from
    const root = await ctx.checkScratch('checkout');
    for (const e of entries) {
      const src = sources.get(e.resourceId);
      if (src) await exportTree(ctx.git, src.dir, src.sha, join(root, e.mountName));
    }
    await ctx.prepareCheckDir(root);
    // runner-controlled dependency install (lockfile only, no scripts), then the checks run offline
    let checkEnv: Record<string, string> = {};
    try {
      const installed = await installMountDependencies(ctx, root, entries.filter((e) => sources.has(e.resourceId)).map((e) => e.mountName));
      // pnpm 12 would otherwise re-verify (and re-install, with network) before `pnpm exec`/`run`
      if (installed.some((m) => m.status === 'installed')) checkEnv = INSTALLED_CHECK_ENV;
    } catch (e) {
      if (e instanceof JobFailure && e.code === 'check_failed') return fail(ctx, 'check_failed', e.detail, { mergeOutcome: outcomes });
      throw e;
    }
    for (const c of job.checks) {
      const startedAt = ctx.nowIso();
      const run = await ctx.runCommand(c.command, join(root, c.mountName), c.timeoutSeconds * 1000, checkEnv);
      if ('refused' in run) {
        checks.push({ checkId: c.checkId, command: c.command, result: 'fail', required: c.required, startedAt, endedAt: ctx.nowIso() });
        return fail(ctx, 'scope_violation', `check ${c.checkId}: ${run.refused}`, { checks, mergeOutcome: outcomes });
      }
      const pass = run.exitCode === 0 && !run.timedOut;
      checks.push({ checkId: c.checkId, command: c.command, result: pass ? 'pass' : 'fail', required: c.required, startedAt: run.startedAt.toISOString(), endedAt: run.endedAt.toISOString() });
      if (!pass && c.required) {
        const why = run.timedOut ? `timed out after ${c.timeoutSeconds}s` : `exit ${run.exitCode ?? run.signal}`;
        failures.push(`check ${c.checkId} (${c.command}) ${why}\n${tail(run.stderr || run.stdout)}`);
      }
    }
    for (const k of job.contracts) {
      const base = { contractId: k.contractId, producerResource: k.producerResource, consumerResource: k.consumerResource };
      const run = await ctx.runCommand(k.producerOutput.command, join(root, k.producerOutput.mountName), 120_000, checkEnv);
      if ('refused' in run) {
        contractChecks.push({ ...base, result: 'fail', detail: run.refused });
        return fail(ctx, 'scope_violation', `contract ${k.contractId}: ${run.refused}`, { checks, contractChecks, mergeOutcome: outcomes });
      }
      const src = sources.get(k.schema.resourceId)!;
      const schemaBytes = await readBlob(ctx.git, src.dir, src.sha, k.schema.path);
      let detail: string | null = null;
      if (run.exitCode !== 0 || run.timedOut) detail = `producer command failed (exit ${run.exitCode ?? run.signal}): ${tail(run.stderr, 500)}`;
      else if (!schemaBytes) detail = `schema ${k.schema.path} not found in ${k.schema.resourceId}`;
      else {
        try {
          const errors = validateJsonSchema(JSON.parse(Buffer.from(schemaBytes).toString('utf8')), JSON.parse(run.stdout));
          if (errors.length > 0) detail = errors.slice(0, 20).join('; ');
        } catch (e) {
          detail = e instanceof UnsupportedSchemaError ? e.message : `invalid JSON: ${(e as Error).message}`;
        }
      }
      contractChecks.push(detail ? { ...base, result: 'fail', detail: ctx.redact(detail) } : { ...base, result: 'pass' });
    }
  }
  const failedContracts = contractChecks.filter((c) => c.result === 'fail');
  if (failedContracts.length > 0) {
    await fail(ctx, 'contract_failed', failedContracts.map((c) => `contract ${c.contractId}: ${c.detail}`).join('\n'), { checks, contractChecks, mergeOutcome: outcomes });
  }
  if (failures.length > 0) await fail(ctx, 'check_failed', failures.join('\n'), { checks, contractChecks, mergeOutcome: outcomes });

  // 4. sequential lease-guarded pushes
  const pushed: string[] = [];
  for (const m of merged) {
    const t = job.targets.find((x) => x.resourceId === m.resourceId)!;
    const outcome = await ctx.push({ coords: t.canonical, ref: job.integrationRef, sha: m.sha, dir: m.dir });
    if (outcome.status !== 'pushed' && outcome.status !== 'already') {
      const partial = pushed.length ? ` (partial: already pushed ${job.integrationRef} to ${pushed.join(', ')})` : '';
      const why = outcome.status === 'lease_failed' ? `ref holds ${outcome.observed}` : 'detail' in outcome ? outcome.detail.slice(-1000) : '';
      throw new JobFailure('provider_unavailable', ctx.redact(`integration push to ${m.resourceId} failed: ${why}${partial}`));
    }
    pushed.push(m.resourceId);
  }

  // 5. evidence (supervisor-side) and receipt
  const evidence = await ctx.signEvidence({
    proposalHash: job.proposalHash,
    snapshotId: job.candidateSnapshotId,
    checks,
    contractChecks,
    mergeOutcome: outcomes,
  });
  return {
    jobId: ctx.jobId,
    proposalId: job.proposalId,
    results: merged.map((m) => {
      const t = job.targets.find((x) => x.resourceId === m.resourceId)!;
      return { resourceId: t.resourceId, integrationRef: job.integrationRef, sha: m.sha, revisionId: ctx.revisionFor(t.canonical, m.sha), expectedHead: t.expectedHead };
    }),
    evidence,
    integratedAt: evidence.producedAt,
  };
}

function tail(text: string, n = 2000): string {
  return text.length > n ? `…${text.slice(-n)}` : text;
}
