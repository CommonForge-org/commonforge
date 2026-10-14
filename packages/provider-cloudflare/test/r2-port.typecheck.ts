/**
 * Compile-time check (run by `pnpm typecheck`, no runtime test): the Workers `R2Bucket` binding is
 * assignable to {@link R2PortBucket}, so a Worker passes `env.COMMONFORGE_ASSETS` unchanged.
 * Imports the module (non-ambient) form of the Workers types so its globals do not clash with Node's.
 */
import type { R2Bucket } from '@cloudflare/workers-types/index.ts';
import type { R2PortBucket } from '../src/r2-port.js';

export function asPort(binding: R2Bucket): R2PortBucket {
  return binding;
}
