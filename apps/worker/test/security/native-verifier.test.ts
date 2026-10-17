import { describe, expect, it, vi } from 'vitest';
import { nativeVerifierCapabilities, nativeVerifierUrl } from '../../src/services/native-verifier.js';
import { harness } from '../helpers.js';

describe('operator-pinned scenario transport', () => {
  it('never permits loopback fallback from a deployed control plane', () => {
    const h = harness();
    h.envOverrides.COMMONFORGE_PUBLIC_URL = 'https://control.example.org';
    h.envOverrides.COMMONFORGE_LOCAL_RUNNER_URL = 'http://127.0.0.1:1234';
    expect(() => nativeVerifierUrl(h.services())).toThrow(expect.objectContaining({code:"verification_unavailable"}));
    h.envOverrides.COMMONFORGE_SCENARIO_RUNNER_URL = 'https://isolated-runner.example.org/g1/';
    expect(nativeVerifierUrl(h.services())).toBe('https://isolated-runner.example.org/g1');
    for (const url of ['http://runner.example.org', 'https://localhost', 'https://runner.example.org?redirect=elsewhere', 'https://user:secret@runner.example.org', 'https://runner.example.org/#part']) {
      h.envOverrides.COMMONFORGE_SCENARIO_RUNNER_URL = url;
      expect(() => nativeVerifierUrl(h.services())).toThrow(expect.objectContaining({code:"verification_unavailable"}));
    }
  });

  it('rejects redirects and malformed remote protocol instead of following another origin', async () => {
    const h = harness(); h.envOverrides.COMMONFORGE_SCENARIO_RUNNER_URL = 'https://isolated-runner.example.org';
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://other.example.org' } }));
    try {
      await expect(nativeVerifierCapabilities(h.services())).rejects.toMatchObject({code:"verification_failed"});
      expect(mock).toHaveBeenCalledWith('https://isolated-runner.example.org/capabilities', expect.objectContaining({ redirect: 'manual' }));
      mock.mockResolvedValue(Response.json({ protocolVersion: 2, runtimeRecipeDigest: 'a'.repeat(64) }));
      await expect(nativeVerifierCapabilities(h.services())).rejects.toThrow();
      mock.mockResolvedValue(Response.json({ protocolVersion: 1, runtimeRecipeDigest: 'a'.repeat(64) }));
      await expect(nativeVerifierCapabilities(h.services())).resolves.toMatchObject({ runtimeRecipeDigest: 'a'.repeat(64) });
    } finally { mock.mockRestore(); }
  });
});
