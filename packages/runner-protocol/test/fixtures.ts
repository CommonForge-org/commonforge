import {
  artRevisionId,
  candidateId,
  candidateRetentionRef,
  computeSnapshotIdSync,
  localRevisionId,
  type ArtifactsCoords,
  type FrozenCandidate,
  type LocalGitCoords,
  type ProjectSnapshot,
  type ProposalHash,
  type ProposalId,
  type ResourceId,
  type SnapshotEntry,
  type TaskWorkspaceHandle,
  type TaskWorkspaceId,
} from '@commonforge-org/core';
import type { IntegrationJob, JobSigningKey } from '../src/index.js';

export const sha = (c: string): string => c.repeat(40);

export const KEY_A: JobSigningKey = { kid: 'k-2026-10', secret: 'test-job-key-A-0123456789abcdef0123456789' };
export const KEY_B: JobSigningKey = { kid: 'k-2026-11', secret: 'test-job-key-B-0123456789abcdef0123456789' };

export function artifactsCoords(name: string, ns = 'commonforge-org1-canonical'): ArtifactsCoords {
  return {
    kind: 'artifacts',
    namespace: ns,
    repoName: name,
    repoId: name,
    remoteUrl: `https://acct.artifacts.cloudflare.net/git/${ns}/${name}.git`,
  };
}

export function localCoords(name: string, dir: string): LocalGitCoords {
  return { kind: 'local-git', namespace: 'local', repoName: name, repoId: name, remoteUrl: `file://${dir}` };
}

export function frozenCandidate(overrides: Partial<FrozenCandidate> = {}): FrozenCandidate {
  return {
    candidateId: candidateId('tw-1', sha('a')),
    taskWorkspaceId: 'tw-1' as TaskWorkspaceId,
    fork: artifactsCoords('site-tw-1', 'commonforge-org1-tasks'),
    resourceId: 'res-site' as ResourceId,
    baseRevision: artRevisionId('site', sha('b')),
    sha: sha('a'),
    treeId: sha('c'),
    frozenAt: '2026-10-06T00:00:00.000Z',
    submitter: { kind: 'agent', id: 'agent-1' },
    changedPaths: ['index.html'],
    ...overrides,
  };
}

export function prepareJob(): IntegrationJob {
  const candidate = frozenCandidate();
  return {
    kind: 'prepare-candidate',
    candidate,
    canonical: artifactsCoords('site'),
    retentionRef: candidateRetentionRef(candidate.candidateId),
  };
}

export function snapshot(entries: SnapshotEntry[]): ProjectSnapshot {
  const base = { projectId: 'proj-1', organizationId: 'org1', membershipRevision: 1, policyRevision: 3, entries };
  return { ...base, snapshotId: computeSnapshotIdSync(base), createdAt: '2026-10-06T00:00:00.000Z' };
}

export const PROPOSAL_ID = 'prop-1' as ProposalId;
export const PROPOSAL_HASH = 'd'.repeat(64) as ProposalHash;

export function workspaceHandle(resource: string, repoId: string, base: string, coords: ArtifactsCoords | LocalGitCoords): TaskWorkspaceHandle {
  return {
    taskWorkspaceId: `tw-${resource}` as TaskWorkspaceId,
    resourceId: resource as ResourceId,
    baseRevision: coords.kind === 'local-git' ? localRevisionId(repoId, base) : artRevisionId(repoId, base),
    provider: coords.kind,
    coords,
    state: 'writable',
  };
}
