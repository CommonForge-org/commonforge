import { describe, expect, it } from 'vitest';
import type { Artifacts } from '@cloudflare/workers-types/index.ts';
import { BindingArtifactsTransport, type ArtifactsBindingLike, type ArtifactsRepoBindingLike } from '../src/artifacts-binding.js';
import { RestArtifactsTransport } from '../src/artifacts-rest.js';
import { ArtifactsVersionProvider } from '../src/artifacts.js';
import { ArtifactsProviderError, redactSecrets } from '../src/errors.js';
import {
  artifactsRemoteUrl,
  canonicalRepoName,
  isCanonicalNamespace,
  namespaceFor,
  parseNamespace,
  parseTaskWorkspaceRepoName,
  taskWorkspaceRepoName,
} from '../src/naming.js';

// Compile-time: the real workers-types binding satisfies the structural interface we accept.
const _conforms = (a: Artifacts): ArtifactsBindingLike => a;
void _conforms;

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const API_TOKEN = 'cf-api-token-very-secret-value';
const SHA = 'a'.repeat(40);

describe('naming', () => {
  it('builds and parses <prefix>-<org>-<kind>', () => {
    expect(namespaceFor('commonforge-dev', 'org1', 'tasks')).toBe('commonforge-dev-org1-tasks');
    expect(parseNamespace('commonforge-dev', 'commonforge-dev-org-a-canonical')).toEqual({ organizationId: 'org-a', kind: 'canonical' });
    expect(parseNamespace('commonforge-dev', 'commonforge-ci-org1-tasks')).toBeNull();
    expect(parseNamespace('commonforge-dev', 'commonforge-dev--tasks')).toBeNull();
    expect(isCanonicalNamespace('anything-canonical')).toBe(true);
    expect(isCanonicalNamespace('x-org-tasks')).toBe(false);
    expect(taskWorkspaceRepoName('abc')).toBe('ws-abc');
    expect(parseTaskWorkspaceRepoName('ws-abc')).toBe('abc');
    expect(parseTaskWorkspaceRepoName('abc')).toBeNull();
    expect(canonicalRepoName('res1')).toBe('res1');
    expect(artifactsRemoteUrl(ACCOUNT, 'ns', 'r')).toBe(`https://${ACCOUNT}.artifacts.cloudflare.net/git/ns/r.git`);
  });

  it('rejects bad prefixes and ids', () => {
    expect(() => namespaceFor('Bad_Prefix', 'org', 'tasks')).toThrow(ArtifactsProviderError);
    expect(() => namespaceFor('commonforge-dev', 'org/evil', 'tasks')).toThrow(ArtifactsProviderError);
    expect(() => namespaceFor('commonforge-dev', 'x'.repeat(128), 'tasks')).toThrow(/longer than/);
    expect(() => new ArtifactsVersionProvider({ transport: { kind: 'binding', bindings: {} }, namespacePrefix: '-x' })).toThrow(ArtifactsProviderError);
  });
});

describe('redactSecrets', () => {
  it('removes Artifacts tokens (v1 and v2), bearer headers, URL userinfo and extra literals', () => {
    const s = redactSecrets(
      `art_v1_0123abcd?expires=17 art_v2_x_cc679c1af79b?expires=1791349457 Authorization: Bearer abc.def https://u:p@h/x vc-resource-v1.zzz ${API_TOKEN}`,
      [API_TOKEN],
    );
    expect(s).not.toMatch(/0123abcd|cc679c1a|abc\.def|u:p@|zzz|very-secret/);
    expect(s).toContain('Bearer <redacted>');
    expect(s).toContain('https://<redacted>@h/x');
  });

  it('applies to error messages and details', () => {
    const e = new ArtifactsProviderError('provider_error', 'push failed art_v2_x_deadbeef', { detail: 'Bearer art_v2_x_deadbeef' });
    expect(e.message).not.toContain('deadbeef');
    expect(JSON.stringify(e.details)).not.toContain('deadbeef');
  });
});

function fakeFetch(handler: (method: string, url: URL, body: unknown, headers: Headers) => Response) {
  const calls: Array<{ method: string; url: URL; body: unknown; headers: Headers }> = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ method, url, body, headers });
    return handler(method, url, body, headers);
  }) as typeof fetch;
  return { f, calls };
}

const ok = (result: unknown, extra: object = {}) => Response.json({ success: true, errors: [], messages: [], result, ...extra });
const err = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], result: null }, { status });

describe('RestArtifactsTransport', () => {
  const base = `/client/v4/accounts/${ACCOUNT}/artifacts/namespaces/ns1`;

  it('maps endpoints, bodies and fields', async () => {
    const { f, calls } = fakeFetch((method, url) => {
      const p = url.pathname.slice(base.length);
      if (method === 'POST' && p === '/repos') return ok({ id: 'r1', name: 'repo', default_branch: 'main', remote: 'https://x/git/ns1/repo.git', token: 'art_v2_x_t' });
      if (method === 'POST' && p === '/tokens') return ok({ id: 't1', plaintext: 'art_v2_x_p', scope: 'read', expires_at: '2026-10-06T00:01:00.000Z' });
      if (method === 'GET' && p === '/repos/repo/tokens') return ok([{ id: 't1', scope: 'write', state: 'active', created_at: 'x', expires_at: 'y' }], { result_info: { total_pages: 1 } });
      if (method === 'DELETE' && p === '/tokens/t1') return ok({ id: 't1' });
      if (method === 'GET' && p === '/repos/repo/log') return ok([]);
      if (method === 'GET' && p === `/repos/repo/tree/${SHA}`) return ok([{ name: 'a', mode: '100644', hash: SHA, type: 'blob' }]);
      if (method === 'GET' && p === '/repos/repo/file') return new Response(new Uint8Array([0, 1, 255]), { headers: { 'content-type': 'application/octet-stream' } });
      if (method === 'DELETE' && p === '/repos/repo') return new Response(null, { status: 202 });
      return err(404, 10200, 'not found');
    });
    const t = new RestArtifactsTransport({ accountId: ACCOUNT, apiToken: API_TOKEN, fetch: f });
    const repo = await t.createRepo('ns1', 'repo', { description: 'd' });
    expect(repo).toMatchObject({ id: 'r1', defaultBranch: 'main', token: 'art_v2_x_t' });
    expect(calls[0]!.body).toEqual({ name: 'repo', default_branch: 'main', description: 'd' });
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${API_TOKEN}`);
    expect(await t.createToken('ns1', 'repo', 'read', 60)).toEqual({ id: 't1', plaintext: 'art_v2_x_p', scope: 'read', expiresAt: '2026-10-06T00:01:00.000Z' });
    expect(calls[1]!.body).toEqual({ repo: 'repo', scope: 'read', ttl: 60 });
    expect(await t.listTokens('ns1', 'repo')).toEqual([{ id: 't1', scope: 'write', state: 'active', expiresAt: 'y', createdAt: 'x' }]);
    expect(await t.revokeToken('ns1', 'repo', 't1')).toBe(true);
    expect(await t.revokeToken('ns1', 'repo', 'gone')).toBe(false);
    expect(await t.log('ns1', 'repo', { ref: 'main' })).toEqual([]);
    expect(calls.find((c) => c.url.pathname.endsWith('/log'))!.url.search).toBe('?ref=main&limit=1');
    expect(await t.readTree('ns1', 'repo', SHA)).toHaveLength(1);
    expect(await t.readCommit('ns1', 'repo', SHA)).toBeNull();
    expect(await t.readFile('ns1', 'repo', SHA, 'dir/a b.bin')).toEqual(new Uint8Array([0, 1, 255]));
    expect(calls.find((c) => c.url.pathname.endsWith('/file'))!.url.searchParams.get('path')).toBe('dir/a b.bin');
    expect(await t.getRepo('ns1', 'missing')).toBeNull();
    expect(await t.deleteRepo('ns1', 'repo')).toBe(true);
    expect(await t.deleteRepo('ns1', 'missing')).toBe(false);
  });

  it('review I2: retries a transient 403 10004 (any method), then succeeds', async () => {
    let n = 0;
    const { f, calls } = fakeFetch((method) => (method === 'POST' && ++n <= 2 ? err(403, 10004, 'Access denied') : ok({ id: 't1', plaintext: 'art_v2_x_p', scope: 'write', expires_at: '2026-10-06T00:01:00.000Z' })));
    const t = new RestArtifactsTransport({ accountId: ACCOUNT, apiToken: API_TOKEN, fetch: f, accessDeniedRetryDelaysMs: [0, 0] });
    expect((await t.createToken('ns1', 'repo', 'write', 60)).id).toBe('t1');
    expect(calls).toHaveLength(3);
  });

  it('review I2: a persistent 403 10004 is provider_unavailable (503) after two retries; other 403s are not retried', async () => {
    const { f, calls } = fakeFetch(() => err(403, 10004, 'Access denied'));
    const t = new RestArtifactsTransport({ accountId: ACCOUNT, apiToken: API_TOKEN, fetch: f, accessDeniedRetryDelaysMs: [0, 0] });
    const e = await t.getRepo('ns1', 'repo').catch((x) => x);
    expect(e).toMatchObject({ code: 'provider_unavailable', status: 503 });
    expect(calls).toHaveLength(3);
    const other = fakeFetch(() => err(403, 10000, 'Authentication error'));
    const t2 = new RestArtifactsTransport({ accountId: ACCOUNT, apiToken: API_TOKEN, fetch: other.f, accessDeniedRetryDelaysMs: [0, 0] });
    expect(await t2.getRepo('ns1', 'repo').catch((x) => x)).toMatchObject({ code: 'provider_error', status: 403 });
    expect(other.calls).toHaveLength(1);
  });

  it('maps 5xx to provider_unavailable and never leaks the API token or account id', async () => {
    const { f } = fakeFetch(() => err(500, 10400, `An internal error occurred for ${API_TOKEN} art_v2_x_abcdef`));
    const t = new RestArtifactsTransport({ accountId: ACCOUNT, apiToken: API_TOKEN, fetch: f });
    const e = await t.createRepo('ns1', 'r').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ArtifactsProviderError);
    expect((e as ArtifactsProviderError).code).toBe('provider_unavailable');
    expect((e as ArtifactsProviderError).status).toBe(500);
    expect(String((e as Error).message)).not.toMatch(/very-secret|abcdef|0123456789abcdef0123/);
  });

  it('maps 409 to already_exists and 400 to provider_error', async () => {
    let status = 409;
    const { f } = fakeFetch(() => err(status, 10001, 'x'));
    const t = new RestArtifactsTransport({ accountId: ACCOUNT, apiToken: API_TOKEN, fetch: f });
    await expect(t.createRepo('ns1', 'r')).rejects.toMatchObject({ code: 'already_exists' });
    status = 400;
    await expect(t.createToken('ns1', 'r', 'read', 59)).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('M-3: 429 is retryable with Retry-After; 200 success:false and non-JSON 2xx are provider_error', async () => {
    let mode = '429';
    const { f } = fakeFetch(() => {
      if (mode === '429') return Response.json({ success: false, errors: [{ code: 971, message: 'rate limited' }] }, { status: 429, headers: { 'retry-after': '3' } });
      if (mode === 'false') return Response.json({ success: false, errors: [{ code: 10001, message: 'nope' }], result: null });
      return new Response('<html>oops</html>', { status: 200 });
    });
    const t = new RestArtifactsTransport({ accountId: ACCOUNT, apiToken: API_TOKEN, fetch: f });
    await expect(t.createRepo('ns1', 'r')).rejects.toMatchObject({ code: 'provider_unavailable', status: 429, details: { retryAfter: '3' } });
    mode = 'false';
    await expect(t.createRepo('ns1', 'r')).rejects.toMatchObject({ code: 'provider_error', status: 200 });
    mode = 'html';
    await expect(t.getRepo('ns1', 'r')).rejects.toMatchObject({ code: 'provider_error' });
  });

  it('maps network errors to provider_unavailable', async () => {
    const t = new RestArtifactsTransport({ accountId: ACCOUNT, apiToken: API_TOKEN, fetch: (async () => { throw new TypeError(`fetch failed ${API_TOKEN}`); }) as typeof fetch });
    const e = (await t.getRepo('ns1', 'r').catch((x: unknown) => x)) as ArtifactsProviderError;
    expect(e.code).toBe('provider_unavailable');
    expect(e.message).not.toContain('very-secret');
  });
});

describe('BindingArtifactsTransport', () => {
  function bindingError(code: string) {
    return Object.assign(new Error(code), { name: 'ArtifactsError', code, numericCode: 0 });
  }

  function makeBinding() {
    const disposed: string[] = [];
    const calls: string[] = [];
    const repoStub = (name: string): ArtifactsRepoBindingLike & { [Symbol.dispose]?: () => void } => ({
      createToken: async (scope, ttl) => { calls.push(`createToken ${scope} ${ttl}`); return { id: 't', plaintext: 'art_v2_x_s', scope: scope ?? 'write', expiresAt: 'e' }; },
      listTokens: async () => ({ tokens: [{ id: 't', scope: 'write', state: 'active', expiresAt: 'e', createdAt: 'c' }] }),
      revokeToken: async (id) => { calls.push(`revoke ${id}`); return id === 't'; },
      info: async () => ({ id: 'rid', name, defaultBranch: 'main', remote: 'https://x', source: null, readOnly: false }),
      readTree: async () => [{ name: 'f', mode: '100755', hash: SHA, type: 'exec' }],
      readCommit: async (h) => (h === SHA ? { hash: SHA, treeHash: SHA, message: 'm', parents: [], author: { name: 'a', email: 'e' }, committer: { name: 'a', email: 'e' }, authoredAt: 0, committedAt: 0 } : null),
      readFile: async ({ path }) => (path === 'a' ? new Blob([new Uint8Array([7])]) : null),
      log: async (o) => { calls.push(`log ${o?.ref} ${o?.limit}`); return []; },
      [Symbol.dispose]: () => disposed.push(name),
    });
    const binding: ArtifactsBindingLike = {
      create: async (name, opts) => {
        calls.push(`create ${name} ${opts?.setDefaultBranch}`);
        if (name === 'boom') throw bindingError('INTERNAL_ERROR');
        if (name === 'dup') throw bindingError('ALREADY_EXISTS');
        return { id: 'rid', name, defaultBranch: 'main', remote: 'https://x', token: 'art_v2_x_s' };
      },
      get: async (name) => {
        if (name === 'missing') throw bindingError('NOT_FOUND');
        return repoStub(name);
      },
      delete: async (name) => name !== 'missing',
    };
    return { binding, disposed, calls };
  }

  it('selects the binding by namespace and maps every operation', async () => {
    const { binding, disposed, calls } = makeBinding();
    const t = new BindingArtifactsTransport({ ns1: binding });
    expect((await t.createRepo('ns1', 'r')).token).toBe('art_v2_x_s');
    expect(calls).toContain('create r main');
    expect(await t.getRepo('ns1', 'r')).toMatchObject({ id: 'rid', defaultBranch: 'main' });
    expect(await t.getRepo('ns1', 'missing')).toBeNull();
    expect((await t.createToken('ns1', 'r', 'read', 120)).plaintext).toBe('art_v2_x_s');
    expect(calls).toContain('createToken read 120');
    expect(await t.listTokens('ns1', 'r')).toEqual([{ id: 't', scope: 'write', state: 'active', expiresAt: 'e', createdAt: 'c' }]);
    expect(await t.revokeToken('ns1', 'r', 't')).toBe(true);
    expect(await t.revokeToken('ns1', 'missing', 't')).toBe(false);
    expect(await t.log('ns1', 'r', { ref: 'main' })).toEqual([]);
    expect(calls).toContain('log main 1');
    expect(await t.readCommit('ns1', 'r', SHA)).toMatchObject({ treeHash: SHA });
    expect(await t.readTree('ns1', 'r', SHA)).toEqual([{ name: 'f', mode: '100755', hash: SHA, type: 'exec' }]);
    expect(await t.readFile('ns1', 'r', SHA, 'a')).toEqual(new Uint8Array([7]));
    expect(await t.readFile('ns1', 'r', SHA, 'b')).toBeNull();
    expect(await t.deleteRepo('ns1', 'r')).toBe(true);
    expect(await t.deleteRepo('ns1', 'missing')).toBe(false);
    expect(disposed.length).toBeGreaterThanOrEqual(8); // every repo stub released
  });

  it('maps ArtifactsError codes; unknown namespace → binding_missing', async () => {
    const { binding } = makeBinding();
    const t = new BindingArtifactsTransport((ns) => (ns === 'ns1' ? binding : undefined));
    await expect(t.createRepo('ns1', 'boom')).rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(t.createRepo('ns1', 'dup')).rejects.toMatchObject({ code: 'already_exists' });
    await expect(t.createToken('ns1', 'missing', 'read', 60)).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.getRepo('other', 'r')).rejects.toMatchObject({ code: 'binding_missing' });
  });

  it('is selectable from the provider constructor', () => {
    const { binding } = makeBinding();
    const p = new ArtifactsVersionProvider({ transport: { kind: 'binding', bindings: { ns1: binding } }, namespacePrefix: 'commonforge-dev' });
    expect(p.transport.kind).toBe('binding');
    const r = new ArtifactsVersionProvider({ transport: { kind: 'rest', accountId: ACCOUNT, apiToken: API_TOKEN }, namespacePrefix: 'commonforge-dev' });
    expect(r.transport.kind).toBe('rest');
    expect(r.capabilities()).toMatchObject({ kind: 'artifacts', writableCandidates: true, maxBlobBytes: 32 * 1024 * 1024 });
  });
});
