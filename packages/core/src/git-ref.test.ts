import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { candidateRetentionRef, candidateId, ID_SEGMENT, integrationJobRef, integrationRef, isValidGitRef, proposalId, resourceId } from './ids.js';
import { GitRefSchema } from './schemas.js';

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const gitAccepts = (ref: string): boolean => spawnSync('git', ['check-ref-format', ref]).status === 0;

const refs = [
  'refs/heads/main',
  'refs/commonforge/candidates/ws-1/' + 'a'.repeat(40),
  'refs/commonforge/integrations/prop.1',
  'refs/tags/v1.2.3',
  'refs/heads/feature/x_y-z',
  'refs/heads/日本',
  'main',
  'refs/heads/a..b',
  'refs/heads/.hidden',
  'refs/.x/y',
  'refs/heads/x.lock',
  'refs/x.lock/y',
  'refs/heads/x.',
  'refs/heads/a@{b',
  'refs/heads/a@b',
  '@',
  'refs/heads/a b',
  'refs/heads/a\tb',
  'refs/heads/a~1',
  'refs/heads/a^',
  'refs/heads/a:b',
  'refs/heads/a?',
  'refs/heads/a*',
  'refs/heads/a[b',
  'refs/heads/a\\b',
  'refs//heads',
  '/refs/heads/x',
  'refs/heads/x/',
  'refs/heads/a\u007fb',
  'refs/heads/.',
  'refs/heads/..',
  'refs/heads/a.lock.b',
];

describe.skipIf(!gitAvailable)('isValidGitRef agrees with `git check-ref-format`', () => {
  it.each(refs)('%j', (ref) => {
    expect(isValidGitRef(ref)).toBe(gitAccepts(ref));
    expect(GitRefSchema.safeParse(ref).success).toBe(gitAccepts(ref));
  });

  it('every id that passes ID_SEGMENT is a ref-safe component', () => {
    const re = new RegExp(`^${ID_SEGMENT}$`);
    for (const id of ['a', 'a.b', 'a-b_c', 'x.lockx', 'v1.2.3', '0b6f7c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e']) {
      expect(re.test(id)).toBe(true);
      expect(gitAccepts(`refs/commonforge/x/${id}`)).toBe(true);
    }
  });
});

describe('ID_SEGMENT is ref-safe', () => {
  it.each(['a..b', 'a.', 'x.lock', 'a.lock', '.a', 'a/b', 'a:b'])('rejects %j', (bad) => {
    expect(() => resourceId(bad)).toThrow(/invalid_id/);
  });
  it('ref helpers emit valid refs', () => {
    expect(isValidGitRef(candidateRetentionRef(candidateId('ws.1', 'b'.repeat(40))))).toBe(true);
    expect(isValidGitRef(integrationRef(proposalId('prop.1')))).toBe(true);
    expect(integrationJobRef('prop.1', 'job-1')).toBe('refs/commonforge/integrations/prop.1/job-1');
    expect(() => integrationJobRef('prop/1', 'job-1')).toThrow(/invalid_id/);
    expect(() => integrationJobRef('prop-1', '')).toThrow(/invalid_id/);
    expect(() => integrationJobRef('prop-1', 'a..b')).toThrow(/invalid_id/);
    expect(() => candidateId('ws.lock', 'b'.repeat(40))).toThrow();
  });
});
