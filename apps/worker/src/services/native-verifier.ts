/** Operator-configured scenario transport. No request parameter selects a verifier origin. */
import { z } from 'zod';
import type { Services } from '../context.js';
import { ApiError } from '../lib/http.js';
import { isLocalUrl } from '../lib/local-host.js';

export function nativeVerifierUrl(svc: Services): string {
  const configured = svc.env.COMMONFORGE_SCENARIO_RUNNER_URL;
  if (configured) {
    let url: URL;
    try { url = new URL(configured); } catch { throw new ApiError(503, 'verification_unavailable', 'invalid configured scenario verifier'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || isLocalUrl(url.href)) throw new ApiError(503, 'verification_unavailable', 'remote scenario verifier requires an operator-configured HTTPS origin');
    return url.href.replace(/\/$/, '');
  }
  const local = svc.env.COMMONFORGE_LOCAL_RUNNER_URL;
  if (!local || !isLocalUrl(local) || !isLocalUrl(svc.env.COMMONFORGE_PUBLIC_URL)) throw new ApiError(503, 'verification_unavailable', 'configure an isolated trusted scenario verifier');
  return local.replace(/\/$/, '');
}
export async function nativeVerifierCapabilities(svc: Services): Promise<{ runtimeRecipeDigest: string }> {
  const response = await fetch(`${nativeVerifierUrl(svc)}/capabilities`, { signal: AbortSignal.timeout(10000), redirect: 'manual' });
  if (!response.ok) throw new ApiError(502, 'verification_failed', 'scenario verifier capabilities unavailable');
  return z.object({ protocolVersion: z.literal(1), runtimeRecipeDigest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await response.json());
}
