import { describe, expect, it } from 'vitest';
import { CoreError } from './errors.js';
import {
  artRevisionId,
  CandidateIdSchema,
  candidateId,
  candidateRetentionRef,
  formatRevisionId,
  ghRevisionId,
  isRevisionId,
  legacyRevisionId,
  localRevisionId,
  parseCandidateId,
  parseRevisionId,
  r2mRevisionId,
  resourceId,
  RevisionIdSchema,
  revisionCommitSha,
  revisionId,
} from './ids.js';
import { GitRefSchema } from './schemas.js';

const SHA1 = 'a'.repeat(40);
const SHA256 = 'b'.repeat(64);

describe('RevisionId', () => {
  it.each([
    [`art:repo-1:${SHA1}`, { kind: 'art', repoId: 'repo-1', sha: SHA1 }],
    [`art:0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e:${SHA256}`, { kind: 'art', repoId: '0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e', sha: SHA256 }],
    [`gh:octo-org/my.repo_x:${SHA1}`, { kind: 'gh', owner: 'octo-org', repo: 'my.repo_x', sha: SHA1 }],
    [`r2m:${SHA256}`, { kind: 'r2m', manifestId: SHA256 }],
    ['legacy:proj-1:42', { kind: 'legacy', projectId: 'proj-1', version: '42' }],
    [`local:repoA:${SHA1}`, { kind: 'local', repoId: 'repoA', sha: SHA1 }],
  ])('parses and re-formats %s', (s, parsed) => {
    expect(parseRevisionId(s)).toEqual(parsed);
    expect(formatRevisionId(parseRevisionId(s))).toBe(s);
    expect(RevisionIdSchema.parse(s)).toBe(s);
    expect(isRevisionId(s)).toBe(true);
  });

  it.each([
    'art:repo:aaa', // abbreviated sha
    `art:repo:${SHA1.toUpperCase()}`,
    `art::${SHA1}`,
    `art:a:b:${SHA1}`,
    `gh:owner:${SHA1}`,
    `gh:own/../x:${SHA1}`.replace('/../x', '/..'),
    `r2m:${SHA1}`,
    'legacy:p:',
    `svn:repo:${SHA1}`,
    '',
  ])('rejects %j', (s) => {
    expect(isRevisionId(s)).toBe(false);
    expect(() => parseRevisionId(s)).toThrow(CoreError);
    expect(() => revisionId(s)).toThrow(/invalid_revision_id/);
    expect(RevisionIdSchema.safeParse(s).success).toBe(false);
  });

  it('constructors build each form', () => {
    expect(artRevisionId('r', SHA1)).toBe(`art:r:${SHA1}`);
    expect(ghRevisionId('o', 'r', SHA1)).toBe(`gh:o/r:${SHA1}`);
    expect(r2mRevisionId(SHA256)).toBe(`r2m:${SHA256}`);
    expect(legacyRevisionId('p', 7)).toBe('legacy:p:7');
    expect(localRevisionId('r', SHA1)).toBe(`local:r:${SHA1}`);
    expect(() => artRevisionId('r', 'abc')).toThrow(CoreError);
  });

  it('revisionCommitSha returns the sha for git-backed revisions only', () => {
    expect(revisionCommitSha(artRevisionId('r', SHA1))).toBe(SHA1);
    expect(revisionCommitSha(r2mRevisionId(SHA256))).toBeNull();
  });
});

describe('CandidateId', () => {
  it('builds, parses and validates cand:<ws>:<sha>', () => {
    const id = candidateId('ws-1', SHA1);
    expect(id).toBe(`cand:ws-1:${SHA1}`);
    expect(parseCandidateId(id)).toEqual({ taskWorkspaceId: 'ws-1', sha: SHA1 });
    expect(CandidateIdSchema.safeParse('cand:ws:abc').success).toBe(false);
    expect(() => candidateId('ws:x', SHA1)).toThrow(/invalid_candidate_id/);
  });
  it('retention ref is a valid git ref (no ":")', () => {
    const ref = candidateRetentionRef(candidateId('ws-1', SHA1));
    expect(ref).toBe(`refs/commonforge/candidates/ws-1/${SHA1}`);
    expect(GitRefSchema.safeParse(ref).success).toBe(true);
  });
});

describe('opaque ids', () => {
  it('accepts UUIDs and slugs, rejects separators', () => {
    expect(resourceId('0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e')).toBe('0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e');
    expect(resourceId('r1')).toBe('r1');
    for (const bad of ['', 'a:b', 'a/b', '-x', 'x'.repeat(129)]) expect(() => resourceId(bad)).toThrow(/invalid_id/);
  });
});
