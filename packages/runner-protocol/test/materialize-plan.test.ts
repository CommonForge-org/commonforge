import { describe, expect, it } from 'vitest';
import {
  artRevisionId,
  computeAssetManifestIdSync,
  r2mRevisionId,
  sha256HexSync,
  type AssetManifest,
  type ResourceId,
  type SnapshotEntry,
} from '@commonforge-org/core';
import {
  WORKSPACE_JSON_PATH,
  PROJECT_CONTEXT_PATH,
  containsSecret,
  planMaterialization,
  type MaterializationAuthorization,
} from '../src/index.js';
import { artifactsCoords, snapshot, sha, workspaceHandle } from './fixtures.js';

const res = (s: string) => s as ResourceId;
const assetBytes = new TextEncoder().encode('logo-bytes');

function manifest(): AssetManifest {
  const entries = [
    {
      path: 'img/logo.png',
      sha256: sha256HexSync(assetBytes),
      size: assetBytes.length,
      mime: 'image/png',
      objectKey: `org/org1/res/res-assets/obj/${sha256HexSync(assetBytes)}`,
    },
  ];
  const manifestId = computeAssetManifestIdSync({ resourceId: 'res-assets', parentManifestId: null, entries });
  return { manifestId, resourceId: res('res-assets'), parentManifestId: null, entries, createdAt: '2026-10-06T00:00:00.000Z' };
}

function entries(): SnapshotEntry[] {
  return [
    { resourceId: res('res-site'), revisionId: artRevisionId('site', sha('b')), mode: 'pinned-reference', mountName: 'site', operations: ['read', 'write'] },
    { resourceId: res('res-api'), revisionId: artRevisionId('api', sha('c')), mode: 'must-match-accepted', mountName: 'api', operations: ['read'] },
    { resourceId: res('res-assets'), revisionId: r2mRevisionId(manifest().manifestId), mode: 'pinned-reference', mountName: 'assets', operations: ['read'] },
    { resourceId: res('res-hidden'), revisionId: artRevisionId('hidden', sha('e')), mode: 'pinned-reference', mountName: 'hidden', operations: ['read'] },
  ];
}

const forkCoords = artifactsCoords('site-tw-1', 'commonforge-org1-tasks');

function authz(overrides: Partial<MaterializationAuthorization> = {}): MaterializationAuthorization {
  return {
    principal: { kind: 'agent', id: 'agent-1', onBehalfOf: { kind: 'user', id: 'dev-1' } },
    workspaceRoot: '/work/run-1',
    grants: [
      { resourceId: res('res-site'), operations: ['read', 'write'], coords: artifactsCoords('site') },
      { resourceId: res('res-api'), operations: ['read'], coords: artifactsCoords('api') },
      { resourceId: res('res-assets'), operations: ['read'], coords: { kind: 'r2-assets', bucket: 'cf-assets', prefix: 'org/org1/res/res-assets/', manifestId: manifest().manifestId }, manifest: manifest() },
    ],
    context: {
      request: 'Add a pricing page to the site.',
      roles: [{ principal: 'dev-1', role: 'developer' }],
      rules: ['Do not change the api contract.'],
      validationCommands: [{ checkId: 'test', mountName: 'site', command: 'pnpm test' }],
    },
    ...overrides,
  };
}

function plan(a = authz()) {
  return planMaterialization(snapshot(entries()), [workspaceHandle('res-site', 'site', sha('b'), forkCoords)], a);
}

function contextFile(p: ReturnType<typeof plan>, path: string): string {
  const f = p.contextFiles.find((c) => c.path === path);
  if (!f) throw new Error(`missing ${path}`);
  return f.content;
}

describe('planMaterialization', () => {
  it('maps writable entries to the task fork and reads to canonical; omits ungranted resources', () => {
    const p = plan();
    expect(p.workspaceRoot).toBe('/work/run-1');
    expect(p.mounts.map((m) => m.mountName)).toEqual(['api', 'assets', 'site']);
    const site = p.mounts.find((m) => m.mountName === 'site')!;
    expect(site).toMatchObject({
      writable: true,
      taskWorkspaceId: 'tw-res-site',
      source: { kind: 'git', remoteUrl: forkCoords.remoteUrl, sha: sha('b'), credential: 'helper' },
    });
    const api = p.mounts.find((m) => m.mountName === 'api')!;
    expect(api).toMatchObject({ writable: false, source: { kind: 'git', remoteUrl: artifactsCoords('api').remoteUrl, sha: sha('c') } });
    expect(api.taskWorkspaceId).toBeUndefined();
    const assets = p.mounts.find((m) => m.mountName === 'assets')!;
    expect(assets).toMatchObject({ writable: false, source: { kind: 'assets', objectUrlResolver: 'broker' } });
    expect(JSON.stringify(p)).not.toContain('hidden');
  });

  it('writes workspace.json, PROJECT-CONTEXT.md and a publication file per writable mount', () => {
    const p = plan();
    expect(p.contextFiles.map((f) => f.path).sort()).toEqual(
      [WORKSPACE_JSON_PATH, PROJECT_CONTEXT_PATH, '.commonforge/site-publication.json'].sort(),
    );
    const ws = JSON.parse(contextFile(p, WORKSPACE_JSON_PATH));
    expect(ws).toMatchObject({
      $schema: 'cf.workspace/1',
      snapshotId: snapshot(entries()).snapshotId,
      projectId: 'proj-1',
      organizationId: 'org1',
      taskWorkspaceIds: ['tw-res-site'],
    });
    expect(ws.mounts.map((m: { mountName: string; writable: boolean }) => [m.mountName, m.writable])).toEqual([
      ['api', false],
      ['assets', false],
      ['site', true],
    ]);
    const pub = JSON.parse(contextFile(p, '.commonforge/site-publication.json'));
    expect(pub).toMatchObject({ mountName: 'site', taskWorkspaceId: 'tw-res-site', remoteUrl: forkCoords.remoteUrl, baseSha: sha('b'), credential: 'helper' });
    const md = contextFile(p, PROJECT_CONTEXT_PATH);
    expect(md).toContain('Add a pricing page to the site.');
    expect(md).toContain('pnpm test');
    expect(md).toContain('Do not change the api contract.');
    expect(md).toMatch(/generated by the CommonForge server/i);
  });

  it('is deterministic', () => {
    expect(plan()).toEqual(plan());
  });

  it('refuses a snapshot whose id does not match its content', () => {
    const s = snapshot(entries());
    const tampered = { ...s, policyRevision: 99 };
    expect(() => planMaterialization(tampered, [], authz())).toThrow(/snapshot_id_mismatch/);
  });

  it('refuses inconsistent workspaces', () => {
    const s = snapshot(entries());
    expect(() => planMaterialization(s, [workspaceHandle('res-site', 'site', sha('f'), forkCoords)], authz())).toThrow(/workspace_base_mismatch/);
    expect(() => planMaterialization(s, [{ ...workspaceHandle('res-site', 'site', sha('b'), forkCoords), state: 'frozen' }], authz())).toThrow(
      /workspace_not_writable/,
    );
    expect(() => planMaterialization(s, [workspaceHandle('res-other', 'x', sha('b'), forkCoords)], authz())).toThrow(/workspace_not_in_snapshot/);
    const readOnly = authz({ grants: authz().grants.map((g) => ({ ...g, operations: ['read' as const] })) });
    expect(() => planMaterialization(s, [workspaceHandle('res-site', 'site', sha('b'), forkCoords)], readOnly)).toThrow(
      /materialization_unauthorized/,
    );
  });

  it('refuses a relative workspace root', () => {
    expect(() => plan(authz({ workspaceRoot: 'relative/ws' }))).toThrow(/invalid_materialization_input/);
    // one validator with core (isAbsoluteDir): non-normalised and control-character roots fail early
    for (const root of ['/a/../b', '/a/./b', '/ws\n']) expect(() => plan(authz({ workspaceRoot: root })), root).toThrow(/invalid_materialization_input/);
  });

  it('refuses a task workspace that points at the canonical repo or a non-task namespace', () => {
    const s = snapshot(entries());
    expect(() => planMaterialization(s, [workspaceHandle('res-site', 'site', sha('b'), artifactsCoords('site'))], authz())).toThrow(
      /materialization_unauthorized/,
    );
    expect(() =>
      planMaterialization(s, [workspaceHandle('res-site', 'site', sha('b'), artifactsCoords('site-x', 'commonforge-org1-editions'))], authz()),
    ).toThrow(/materialization_unauthorized/);
  });

  it('refuses an asset manifest that does not match the pinned revision', () => {
    const other = { ...manifest(), manifestId: 'f'.repeat(64) as never };
    const a = authz({ grants: authz().grants.map((g) => (g.resourceId === 'res-assets' ? { ...g, manifest: other } : g)) });
    expect(() => plan(a)).toThrow(/manifest_mismatch/);
  });

  it('refuses token-like values in anything written to workspace.json', () => {
    const tokenRepo = { ...artifactsCoords('api'), repoName: 'art_v1_0123456789abcdef0123456789abcdef' };
    const a = authz({ grants: authz().grants.map((g) => (g.resourceId === 'res-api' ? { ...g, coords: tokenRepo } : g)) });
    expect(() => plan(a)).toThrow(/secret_in_workspace/);
  });
});

// ---------------------------------------------------------------------------------------------
// Property test: whatever token-like strings reach the planner, workspace.json never contains them.
// ---------------------------------------------------------------------------------------------

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const HEXCH = '0123456789abcdef';

function randomToken(rnd: () => number): string {
  const pick = (chars: string, n: number) => Array.from({ length: n }, () => chars[Math.floor(rnd() * chars.length)]).join('');
  const kinds = [
    () => `Bearer ${pick(ALNUM, 24 + Math.floor(rnd() * 20))}`,
    () => `vc-resource-v1.${pick(ALNUM, 20)}.${pick(ALNUM, 30)}`,
    () => `art_v1_${pick(HEXCH, 40)}?expires=${1_790_000_000 + Math.floor(rnd() * 1e6)}`,
    () => `https://user:${pick(ALNUM, 16)}@acct.artifacts.cloudflare.net/git/ns/r.git`,
    () => `ghs_${pick(ALNUM, 36)}`,
  ];
  return kinds[Math.floor(rnd() * kinds.length)]!();
}

describe('workspace.json never contains secrets (property)', () => {
  it('holds for 300 random injections into every free-text and stray field', () => {
    const rnd = prng(0xc0ffee);
    for (let i = 0; i < 300; i++) {
      const t = () => randomToken(rnd);
      const injected = [t(), t(), t(), t(), t(), t()];
      const base = authz();
      const a = {
        ...base,
        context: {
          request: `Please do X. ${injected[0]}`,
          roles: [{ principal: 'dev-1', role: `developer ${injected[1]}` }],
          rules: [`rule ${injected[2]}`],
          validationCommands: [{ checkId: 'test', mountName: 'site', command: `curl -H "${injected[3]}" x` }],
        },
        // Strays a careless caller might attach: credentials must never be copied through.
        credential: { tokenId: 'tok-1', secret: injected[4], scope: 'write', expiresAt: '2026-10-06T00:00:00.000Z', remoteUrl: forkCoords.remoteUrl },
        principal: { ...base.principal, displayName: `Agent ${injected[5]}` },
        grants: base.grants.map((g) => ({ ...g, token: injected[4] })),
      } as MaterializationAuthorization;
      const p = plan(a);
      for (const f of p.contextFiles) {
        expect(containsSecret(f.content), `${f.path} iteration ${i}`).toBe(false);
        for (const tok of injected) expect(f.content.includes(tok), `${f.path} contains ${tok}`).toBe(false);
      }
      const ws = contextFile(p, WORKSPACE_JSON_PATH);
      expect(ws).not.toMatch(/Bearer|vc-resource-v1\.|art_v1_|ghs_|:\/\/[^/\s]*:[^/\s]*@/);
      // Mount and plan metadata (everything but the human-readable context) stays clean too.
      expect(containsSecret(JSON.stringify(p.mounts))).toBe(false);
    }
  });
});
