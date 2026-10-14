/**
 * What the capture points at: org, project and proposal ids. Fixture mode uses the in-page demo
 * story's fixed ids (apps/web/src/api/fake.ts); cookie mode reads the seeder's output (or env)
 * and finds the demo's proposals through the API once the agents have produced them.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { APIRequestContext } from 'playwright';

export type RestoreKey = 'resourceWebsite' | 'resourceBrand';

export interface Targets {
  org: string;
  project: string;
  /** The Change's first proposal: Git merged cleanly, the contract check failed. */
  failProposal?: string | undefined;
  /** The repair: a newer proposal of the same Change whose integration passed. */
  fixProposal?: string | undefined;
  /** Fixture only: a proposal accepted before scene 8 so there is a version to restore. */
  prepAcceptProposal?: string | undefined;
  /** Versions-screen resource buttons to restore, in order. */
  restore: RestoreKey[];
  /** What the client types into "What do you want to change?". */
  updateRequest: string;
  /** The client's edited working copy (ZIP) for scene 3; cookie mode waits for it to appear. */
  editedZip?: string | undefined;
}

export const FIXTURE_TARGETS: Targets = {
  org: 'o-0de0c11e0001',
  project: 'p-c0570a1e0001',
  failProposal: 'prop-a15e0000-0000-4000-8000-00000000a100',
  fixProposal: 'prop-a25e0000-0000-4000-8000-00000000a200',
  prepAcceptProposal: 'prop-c15e0000-0000-4000-8000-00000000c100',
  restore: ['resourceBrand'],
  updateRequest: 'Add a price breakdown to the quote form',
};

const RESTORE_KEYS: Record<string, RestoreKey> = { website: 'resourceWebsite', brand: 'resourceBrand' };

export function parseRestore(value: string): RestoreKey[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const key = RESTORE_KEYS[s];
      if (!key) throw new Error(`CAPTURE_RESTORE: unknown resource "${s}" (use website, brand)`);
      return key;
    });
}

/** Live targets from env, falling back to the seeder's `seed-output.json`. */
export function liveTargets(env: NodeJS.ProcessEnv, seedOutputPath: string): Targets {
  let seed: { orgId?: string; projectId?: string } = {};
  if (existsSync(seedOutputPath)) seed = JSON.parse(readFileSync(seedOutputPath, 'utf8')) as typeof seed;
  const org = env.CAPTURE_ORG ?? seed.orgId;
  const project = env.CAPTURE_PROJECT ?? seed.projectId;
  if (!org || !project) throw new Error(`set CAPTURE_ORG and CAPTURE_PROJECT, or run the seeder first (${seedOutputPath})`);
  return {
    org,
    project,
    failProposal: env.CAPTURE_FAIL_PROPOSAL,
    fixProposal: env.CAPTURE_FIX_PROPOSAL,
    restore: parseRestore(env.CAPTURE_RESTORE ?? 'website,brand'),
    updateRequest: env.CAPTURE_UPDATE_REQUEST ?? FIXTURE_TARGETS.updateRequest,
    editedZip: env.CAPTURE_EDITED_ZIP,
  };
}

interface Summary {
  proposalId: string;
  changeId: string;
  createdAt?: string;
  updatedAt: string;
}

interface Detail extends Summary {
  lastAttempt: { state: string; code: string | null } | null;
}

/**
 * The newest proposal whose integration failed on a contract check, and the newest proposal of
 * the same Change created after it whose integration succeeded.
 */
export function pickProposals(details: Detail[]): { fail?: string; fix?: string } {
  const created = (p: Summary) => Date.parse(p.createdAt ?? p.updatedAt);
  const byNewest = [...details].sort((a, b) => created(b) - created(a));
  const fail = byNewest.find((p) => p.lastAttempt?.code === 'contract_failed');
  if (!fail) return {};
  const fix = byNewest.find((p) => p.changeId === fail.changeId && created(p) > created(fail) && p.lastAttempt?.state === 'succeeded');
  return { fail: fail.proposalId, ...(fix ? { fix: fix.proposalId } : {}) };
}

export async function discoverProposals(request: APIRequestContext, baseUrl: string, org: string, project: string): Promise<{ fail?: string; fix?: string }> {
  const api = (path: string) => new URL(`/api/orgs/${encodeURIComponent(org)}${path}`, baseUrl).toString();
  const list = await request.get(api(`/proposals?projectId=${encodeURIComponent(project)}`));
  if (!list.ok()) throw new Error(`listing proposals failed: ${list.status()}`);
  const { proposals } = (await list.json()) as { proposals: Summary[] };
  const details = await Promise.all(
    proposals.map(async (p) => {
      const res = await request.get(api(`/proposals/${encodeURIComponent(p.proposalId)}`));
      if (!res.ok()) throw new Error(`reading proposal ${p.proposalId} failed: ${res.status()}`);
      return (await res.json()) as Detail;
    }),
  );
  return pickProposals(details);
}
