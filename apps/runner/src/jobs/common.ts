/** Helpers shared by job handlers. */
import type { RepoCoords } from '@commonforge-org/core';
import type { IntegrationJobKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { JobFailure } from '../errors.js';
import { fetchShas, initBare, lsRemote, type PushOutcome } from '../git.js';

/** A fresh bare scratch repository. */
export async function scratchRepo<K extends IntegrationJobKind>(ctx: JobContext<K>, label: string): Promise<string> {
  const dir = await ctx.scratch(label);
  await initBare(ctx.git, dir);
  return dir;
}

/** Fetch commits from `coords` (read access) or fail the job with `provider_unavailable`. */
export async function fetchCommits<K extends IntegrationJobKind>(ctx: JobContext<K>, dir: string, coords: RepoCoords, shas: readonly string[], what: string): Promise<void> {
  const env = await ctx.readEnv(coords);
  const r = await fetchShas(ctx.git, dir, coords.remoteUrl, shas, env);
  if (!r.ok) throw new JobFailure('provider_unavailable', ctx.redact(`${what} not found in ${coords.namespace}/${coords.repoName}: ${r.stderr.trim().slice(-1000)}`));
}

/** `ls-remote` with read access; unreachable remote → `provider_unavailable`. */
export async function remoteRef<K extends IntegrationJobKind>(ctx: JobContext<K>, dir: string, coords: RepoCoords, ref: string, access: 'read' | 'write' = 'read'): Promise<string | null> {
  const env = access === 'read' ? await ctx.readEnv(coords) : await ctx.writeEnv(coords);
  try {
    return await lsRemote(ctx.git, dir, coords.remoteUrl, ref, env);
  } catch (e) {
    throw new JobFailure('provider_unavailable', ctx.redact(`cannot list ${ref} on ${coords.namespace}/${coords.repoName}: ${(e as Error).message}`));
  }
}

/** Map a push outcome; lease failures become `onLease` (default `scope_violation`). */
export function requirePushed<K extends IntegrationJobKind>(ctx: JobContext<K>, outcome: PushOutcome, what: string, onLease: 'scope_violation' | 'stale_base' = 'scope_violation'): void {
  if (outcome.status === 'pushed' || outcome.status === 'already') return;
  if (outcome.status === 'lease_failed') {
    throw new JobFailure(onLease, ctx.redact(`${what}: ref holds ${outcome.observed ?? 'nothing'}, lease refused`));
  }
  throw new JobFailure('provider_unavailable', ctx.redact(`${what} failed: ${'detail' in outcome ? outcome.detail.slice(-1500) : ''}`));
}
