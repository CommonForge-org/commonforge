/**
 * Hosts that are never a deployed Worker: loopback, `*.localhost` and the reserved `.test` TLD
 * (vitest uses `worker.test`). Shared by the chaos-flag guard (chaos.ts), the e2e stack guard and
 * the broker URL check (runner-jobs.ts), so the three never drift.
 */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".localhost") || h.endsWith(".test");
}

/** True when `url` parses and its host is local (see {@link isLocalHostname}). */
export function isLocalUrl(url: string | undefined): boolean {
  try {
    return isLocalHostname(new URL(url ?? "").hostname);
  } catch {
    return false;
  }
}
