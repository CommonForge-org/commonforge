import { describe, expect, it } from 'vitest';
import { diffAgainstInventory, mapEditionDelta, mapEditionPath, matchesProtected } from './edition.js';
import { EditionDeltaSchema, EditionManifestServerSideSchema, MappedChangeSchema } from './schemas.js';

const H = (c: string) => c.repeat(64);
const G = (c: string) => c.repeat(40);

const inventory = [
  { editionPath: 'site/index.html', sha256: H('1'), size: 10 },
  { editionPath: 'site/about.html', sha256: H('2'), size: 10 },
  { editionPath: 'site/logo.svg', sha256: H('3'), size: 10 },
  { editionPath: 'docs/README.md', sha256: H('4'), size: 10 },
];

describe('diffAgainstInventory (AT-29)', () => {
  it('partial upload omits files without deleting them', () => {
    const d = diffAgainstInventory(inventory, [{ path: 'site/index.html', sha256: H('a') }], 'partial', []);
    expect(d.changes).toEqual([{ path: 'site/index.html', kind: 'modified', sha256: H('a'), previousSha256: H('1') }]);
    expect(d.omitted).toEqual(['docs/README.md', 'site/about.html', 'site/logo.svg']);
    expect(d.changes.some((c) => c.kind === 'deleted')).toBe(false);
  });

  it('full upload deletes inventory files that were not returned', () => {
    const d = diffAgainstInventory(
      inventory,
      [
        { path: 'site/index.html', sha256: H('1') },
        { path: 'site/about.html', sha256: H('b') },
        { path: 'docs/README.md', sha256: H('4') },
      ],
      'full',
      [],
    );
    expect(d.changes).toEqual([
      { path: 'site/about.html', kind: 'modified', sha256: H('b'), previousSha256: H('2') },
      { path: 'site/logo.svg', kind: 'deleted', previousSha256: H('3') },
    ]);
    expect(d.unchanged).toEqual(['docs/README.md', 'site/index.html']);
    expect(d.omitted).toEqual([]);
  });

  it('explicit additions, deletions and renames produce accurate diffs (partial)', () => {
    const d = diffAgainstInventory(
      inventory,
      [
        { path: 'site/new.html', sha256: H('c') },
        { path: 'site/brand/logo.svg', sha256: H('3') }, // moved
      ],
      'partial',
      ['site/about.html', 'site/logo.svg', 'site/ghost.html'],
    );
    expect(d.changes).toEqual([
      { path: 'site/about.html', kind: 'deleted', previousSha256: H('2') },
      { path: 'site/brand/logo.svg', kind: 'renamed', oldPath: 'site/logo.svg', sha256: H('3'), previousSha256: H('3') },
      { path: 'site/new.html', kind: 'added', sha256: H('c') },
    ]);
    expect(d.omitted).toEqual(['docs/README.md', 'site/index.html']);
    expect(d.unknownDeletions).toEqual(['site/ghost.html']);
    expect(EditionDeltaSchema.parse(d)).toEqual(d);
  });

  it('does not pair ambiguous renames', () => {
    const inv = [
      { editionPath: 'a.txt', sha256: H('5'), size: 1 },
      { editionPath: 'b.txt', sha256: H('5'), size: 1 },
    ];
    const d = diffAgainstInventory(inv, [{ path: 'c.txt', sha256: H('5') }], 'full', []);
    expect(d.changes.map((c) => c.kind)).toEqual(['deleted', 'deleted', 'added']);
  });

  it('normalizes returned paths before comparing', () => {
    const d = diffAgainstInventory(inventory, [{ path: './site//index.html', sha256: H('1') }], 'partial', []);
    expect(d.unchanged).toEqual(['site/index.html']);
    expect(d.changes).toEqual([]);
  });

  it('refuses duplicate returned paths and returned+deleted conflicts', () => {
    expect(() =>
      diffAgainstInventory(inventory, [{ path: 'x', sha256: H('1') }, { path: './x', sha256: H('2') }], 'partial', []),
    ).toThrow(/invalid_edition_return/);
    expect(() => diffAgainstInventory(inventory, [{ path: 'x', sha256: H('1') }], 'partial', ['x'])).toThrow(
      /invalid_edition_return/,
    );
  });
});

const manifest = EditionManifestServerSideSchema.parse({
  editionId: 'ed-1',
  policyRevision: 2,
  sourceReleaseId: 'rel-1',
  exportedSnapshotId: H('9'),
  inventory,
  mappings: [
    { editionPathPrefix: 'site', resourceId: 'website', canonicalPathPrefix: 'apps/web/public', writable: true },
    { editionPathPrefix: 'site/vendor', resourceId: 'website', canonicalPathPrefix: 'vendor', writable: false },
    { editionPathPrefix: 'docs', resourceId: 'requirements', canonicalPathPrefix: '', writable: true },
    { editionPathPrefix: 'orphan', resourceId: 'nobase', canonicalPathPrefix: '', writable: true },
  ],
  canonicalBases: [
    { resourceId: 'website', revisionId: `art:web:${G('a')}` },
    { resourceId: 'requirements', revisionId: `art:req:${G('b')}` },
  ],
  allowedAssetNamespaces: [],
  contractVersions: {},
  protectedPaths: ['package.json', '**/.env*', 'contracts/**'],
});

describe('mapEditionDelta', () => {
  it('maps allowed changes to canonical paths with their base revision', () => {
    const delta = diffAgainstInventory(inventory, [{ path: 'site/index.html', sha256: H('a') }], 'partial', []);
    const { allowed, blocked } = mapEditionDelta(delta, manifest);
    expect(blocked).toEqual([]);
    expect(allowed).toEqual([
      {
        resourceId: 'website',
        baseRevision: `art:web:${G('a')}`,
        kind: 'modified',
        editionPath: 'site/index.html',
        canonicalPath: 'apps/web/public/index.html',
        sha256: H('a'),
        previousSha256: H('1'),
      },
    ]);
    for (const a of allowed) expect(MappedChangeSchema.parse(a)).toEqual(a);
  });

  it.each([
    ['not_mapped', 'elsewhere/x.html'],
    ['not_mapped', 'orphan/x.md'], // mapping without a canonical base
    ['read_only', 'site/vendor/lib.js'],
    ['protected', 'docs/package.json'],
    ['protected', 'site/.env.production'],
    ['protected', 'docs/contracts/quote.json'],
    ['protected', 'site/.git/config'],
    ['protected', 'docs/.commonforge/workspace.json'],
    ['path_escape', '../site/index.html'],
    ['path_escape', 'site/../../etc/passwd'],
    ['path_escape', '/site/index.html'],
    ['path_escape', 'site\\index.html'],
    ['path_escape', 'site/a\0b'],
  ] as const)('blocks %s: %j', (reason, path) => {
    const delta = { mode: 'partial' as const, changes: [{ path, kind: 'added' as const, sha256: H('e') }], unchanged: [], omitted: [], unknownDeletions: [] };
    const { allowed, blocked } = mapEditionDelta(delta, manifest);
    expect(allowed).toEqual([]);
    expect(blocked).toEqual([{ path, reason }]);
  });

  it('every change is either allowed or blocked (none silently dropped)', () => {
    const delta = diffAgainstInventory(
      inventory,
      [
        { path: 'site/index.html', sha256: H('a') },
        { path: 'site/vendor/x.js', sha256: H('b') },
        { path: 'docs/package.json', sha256: H('c') },
        { path: 'zzz/new.txt', sha256: H('d') },
      ],
      'full',
      [],
    );
    const { allowed, blocked } = mapEditionDelta(delta, manifest);
    expect(allowed.length + blocked.length).toBe(delta.changes.length);
  });

  it('renames within a resource stay renames; a blocked side splits the rename into delete + add', () => {
    const okRename = {
      mode: 'partial' as const,
      changes: [{ path: 'site/b.html', kind: 'renamed' as const, oldPath: 'site/a.html', sha256: H('1'), previousSha256: H('1') }],
      unchanged: [],
      omitted: [],
      unknownDeletions: [],
    };
    expect(mapEditionDelta(okRename, manifest).allowed).toEqual([
      expect.objectContaining({
        kind: 'renamed',
        canonicalPath: 'apps/web/public/b.html',
        oldCanonicalPath: 'apps/web/public/a.html',
      }),
    ]);
    const intoReadOnly = { ...okRename, changes: [{ ...okRename.changes[0]!, path: 'site/vendor/a.html' }] };
    expect(mapEditionDelta(intoReadOnly, manifest)).toEqual({
      allowed: [
        {
          resourceId: 'website',
          baseRevision: `art:web:${G('a')}`,
          kind: 'deleted',
          editionPath: 'site/a.html',
          canonicalPath: 'apps/web/public/a.html',
          previousSha256: H('1'),
        },
      ],
      blocked: [{ path: 'site/vendor/a.html', reason: 'read_only' }],
    });
  });

  describe('rename out of a read-only area (review I-1)', () => {
    const policy = EditionManifestServerSideSchema.parse({
      editionId: 'ed-2',
      policyRevision: 1,
      sourceReleaseId: 'rel-1',
      exportedSnapshotId: H('9'),
      inventory: [],
      mappings: [
        { editionPathPrefix: 'ro', resourceId: 'website', canonicalPathPrefix: 'ro', writable: false },
        { editionPathPrefix: 'rw', resourceId: 'website', canonicalPathPrefix: 'rw', writable: true },
      ],
      canonicalBases: [{ resourceId: 'website', revisionId: `art:web:${G('a')}` }],
      allowedAssetNamespaces: [],
      contractVersions: {},
    });
    const addRw = {
      resourceId: 'website',
      baseRevision: `art:web:${G('a')}`,
      kind: 'added',
      editionPath: 'rw/a.txt',
      canonicalPath: 'rw/a.txt',
      sha256: H('5'),
    };

    it('ro/a.txt -> rw/a.txt (full return): the add is allowed, the delete is blocked, nothing vanishes', () => {
      const inv = [{ editionPath: 'ro/a.txt', sha256: H('5'), size: 1 }];
      const delta = diffAgainstInventory(inv, [{ path: 'rw/a.txt', sha256: H('5') }], 'full', []);
      expect(delta.changes.map((c) => c.kind)).toEqual(['renamed']);
      expect(mapEditionDelta(delta, policy)).toEqual({ allowed: [addRw], blocked: [{ path: 'ro/a.txt', reason: 'read_only' }] });
    });

    it('result does not flip when duplicate content defeats rename pairing', () => {
      const inv = [
        { editionPath: 'ro/a.txt', sha256: H('5'), size: 1 },
        { editionPath: 'ro/b.txt', sha256: H('5'), size: 1 },
      ];
      const paired = mapEditionDelta(
        diffAgainstInventory(inv, [{ path: 'rw/a.txt', sha256: H('5') }, { path: 'ro/b.txt', sha256: H('5') }], 'full', []),
        policy,
      );
      const unpaired = mapEditionDelta(diffAgainstInventory(inv, [{ path: 'rw/a.txt', sha256: H('5') }], 'full', []), policy);
      // paired: ro/b.txt returned unchanged, so ro/a.txt->rw/a.txt pairs as a rename
      expect(paired).toEqual({ allowed: [addRw], blocked: [{ path: 'ro/a.txt', reason: 'read_only' }] });
      // unpaired: two deletes with the same sha → no pairing; the add is still allowed identically
      expect(unpaired.allowed).toEqual([addRw]);
      expect(unpaired.blocked).toEqual([
        { path: 'ro/a.txt', reason: 'read_only' },
        { path: 'ro/b.txt', reason: 'read_only' },
      ]);
    });
  });

  it('a rename across resources becomes delete + add', () => {
    const delta = {
      mode: 'partial' as const,
      changes: [{ path: 'docs/a.md', kind: 'renamed' as const, oldPath: 'site/a.md', sha256: H('1'), previousSha256: H('1') }],
      unchanged: [],
      omitted: [],
      unknownDeletions: [],
    };
    const { allowed } = mapEditionDelta(delta, manifest);
    expect(allowed.map((a) => [a.resourceId, a.kind, a.canonicalPath])).toEqual([
      ['requirements', 'added', 'a.md'],
      ['website', 'deleted', 'apps/web/public/a.md'],
    ]);
  });
});

describe('EditionManifestServerSide.sourceReleaseId (AT-30)', () => {
  it('is the live release id, or null while the project has no recorded release', () => {
    const base = { ...manifest } as Record<string, unknown>;
    expect(EditionManifestServerSideSchema.parse({ ...base, sourceReleaseId: null }).sourceReleaseId).toBeNull();
    expect(EditionManifestServerSideSchema.safeParse({ ...base, sourceReleaseId: undefined }).success).toBe(false);
    expect(EditionManifestServerSideSchema.safeParse({ ...base, sourceReleaseId: '../x' }).success).toBe(false);
  });
});

describe('case-insensitive protection and case collisions (review I-2)', () => {
  const inv = [
    { editionPath: 'tests/quote-contract.test.ts', sha256: H('1'), size: 1 },
    { editionPath: 'src/a.ts', sha256: H('2'), size: 1 },
  ];
  const policy = {
    mappings: [{ editionPathPrefix: '', resourceId: 'website', canonicalPathPrefix: '', writable: true }],
    canonicalBases: [{ resourceId: 'website', revisionId: `art:web:${G('a')}` }],
    protectedPaths: ['tests/quote-contract.test.ts', 'package.json'],
    inventory: inv,
  } as unknown as Parameters<typeof mapEditionDelta>[1];

  it('protected patterns match whatever the case', () => {
    expect(mapEditionPath('Package.JSON', policy)).toEqual({ ok: false, reason: 'protected' });
    expect(matchesProtected('TESTS/Quote-Contract.test.ts', ['tests/quote-contract.test.ts'])).toBe(true);
  });

  it('an added file differing only by case from a published one is a case_collision', () => {
    const d = diffAgainstInventory(inv, [{ path: 'tests/Quote-Contract.test.ts', sha256: H('9') }, { path: 'src/new.ts', sha256: H('8') }], 'partial', []);
    const m = mapEditionDelta(d, policy);
    expect(m.allowed.map((a) => a.canonicalPath)).toEqual(['src/new.ts']);
    expect(m.blocked).toEqual([{ path: 'tests/Quote-Contract.test.ts', reason: 'case_collision' }]);
  });

  it('a case-only rename (or a full return replacing a file by its case variant) applies neither side', () => {
    const renamed = mapEditionDelta(diffAgainstInventory(inv, [{ path: 'src/A.ts', sha256: H('2') }], 'partial', ['src/a.ts']), policy);
    expect(renamed.allowed).toEqual([]);
    expect(renamed.blocked.map((b) => [b.path, b.reason])).toEqual([
      ['src/A.ts', 'case_collision'],
      ['src/a.ts', 'case_collision'],
    ]);
    const full = mapEditionDelta(diffAgainstInventory(inv, [{ path: 'src/A.ts', sha256: H('7') }, { path: 'tests/quote-contract.test.ts', sha256: H('1') }], 'full', []), policy);
    expect(full.allowed).toEqual([]);
    expect(full.blocked.map((b) => b.path).sort()).toEqual(['src/A.ts', 'src/a.ts']);
  });
});

describe('file/folder conflicts (re-review R-1)', () => {
  const inv = [
    { editionPath: 'tests/quote-view.test.ts', sha256: H('1'), size: 1 },
    { editionPath: 'src/a.ts', sha256: H('2'), size: 1 },
  ];
  const policy = {
    mappings: [{ editionPathPrefix: '', resourceId: 'website', canonicalPathPrefix: '', writable: true }],
    canonicalBases: [{ resourceId: 'website', revisionId: `art:web:${G('a')}` }],
    protectedPaths: [],
    inventory: inv,
  } as unknown as Parameters<typeof mapEditionDelta>[1];
  const map = (paths: string[]) => mapEditionDelta(diffAgainstInventory(inv, paths.map((p, i) => ({ path: p, sha256: H(String((i % 7) + 3)) })), 'partial', []), policy);

  it('a file over a published folder, a folder over a published file, and case variants are path_conflict', () => {
    const m = map(['tests', 'src/a.ts/x.ts', 'Tests', 'SRC/A.ts/y.ts', 'src/ok.ts']);
    expect(m.allowed.map((a) => a.canonicalPath)).toEqual(['src/ok.ts']);
    expect(m.blocked.map((b) => [b.path, b.reason])).toEqual([
      ['SRC/A.ts/y.ts', 'path_conflict'],
      ['Tests', 'path_conflict'],
      ['src/a.ts/x.ts', 'path_conflict'],
      ['tests', 'path_conflict'],
    ]);
  });

  it('a new folder spelled like a published folder in another case is a path_conflict', () => {
    const m = map(['Tests/new.test.ts', 'tests/new.test.ts']);
    expect(m.allowed.map((a) => a.canonicalPath)).toEqual(['tests/new.test.ts']);
    expect(m.blocked).toEqual([{ path: 'Tests/new.test.ts', reason: 'path_conflict' }]);
  });

  it('two new paths of one return that conflict with each other are both refused', () => {
    const m = map(['docs', 'docs/x.md']);
    expect(m.allowed).toEqual([]);
    expect(m.blocked.map((b) => b.reason)).toEqual(['path_conflict', 'path_conflict']);
  });
});
