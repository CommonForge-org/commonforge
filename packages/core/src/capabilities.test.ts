import { describe, expect, it } from 'vitest';
import { CapabilityError, DEFAULT_CAPABILITIES, requireBlobSize, requireCapability } from './capabilities.js';
import { CoreError } from './errors.js';
import { ProviderCapabilitiesSchema } from './schemas.js';

describe('capabilities', () => {
  it('CapabilityError carries provider and capability with the §B.1 message', () => {
    const e = new CapabilityError('legacy-vc-storage', 'retainedHistory');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(CoreError);
    expect(e.message).toBe('provider_capability_unsupported:legacy-vc-storage:retainedHistory');
    expect(e.code).toBe('provider_capability_unsupported');
    expect([e.provider, e.capability]).toEqual(['legacy-vc-storage', 'retainedHistory']);
  });
  it('requireCapability throws only when unsupported', () => {
    expect(() => requireCapability(DEFAULT_CAPABILITIES.artifacts, 'writableCandidates')).not.toThrow();
    expect(() => requireCapability(DEFAULT_CAPABILITIES['r2-assets'], 'gitTransport')).toThrow(CapabilityError);
  });
  it('requireBlobSize enforces the Artifacts 32 MiB limit', () => {
    expect(() => requireBlobSize(DEFAULT_CAPABILITIES.artifacts, 32 * 1024 * 1024)).not.toThrow();
    expect(() => requireBlobSize(DEFAULT_CAPABILITIES.artifacts, 32 * 1024 * 1024 + 1)).toThrow(/maxBlobBytes/);
    expect(() => requireBlobSize(DEFAULT_CAPABILITIES['r2-assets'], 50 * 1024 * 1024)).not.toThrow();
  });
  it('default capability sets are schema-valid and keyed by kind', () => {
    for (const [kind, caps] of Object.entries(DEFAULT_CAPABILITIES)) {
      expect(ProviderCapabilitiesSchema.parse(caps)).toEqual(caps);
      expect(caps.kind).toBe(kind);
    }
  });
});
