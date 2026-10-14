/**
 * Secret redaction (plan §F "Token leakage"). Applied to everything a runner returns or logs, and
 * used as a tripwire (`containsSecret`) before writing workspace.json or signing a job.
 *
 * Covered formats:
 * - `Authorization: <scheme> <value>` headers and bare `Bearer …` / `Basic …` credentials;
 * - VibeControl resource tokens `vc-resource-v1.…`;
 * - Cloudflare Artifacts repo tokens `art_v1_<hex>` / `art_v2_x_<...>` (any version) with an optional `?expires=<epoch>` suffix
 *   (format observed in spikes S2/S3);
 * - GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`) for connected resources;
 * - credentials embedded in URLs (`scheme://user:pass@host`, and any userinfo on http(s) URLs);
 * - query-string tokens (`?access_token=…`, `&token=…`, `?api_key=…`, …).
 *
 * Over-redaction is acceptable; under-redaction is not. `redact` is idempotent.
 */

export const REDACTED = '<redacted>';

/** Characters that can appear in a bearer/opaque token value (RFC 6750 b64token plus `%`). */
const TOKEN_CHARS = '\\-A-Za-z0-9._~+/%';

export type SecretKind =
  | 'authorization-header'
  | 'bearer'
  | 'vc-resource-token'
  | 'artifacts-token'
  | 'github-token'
  | 'url-credentials'
  | 'query-token';

interface Rule {
  kind: SecretKind;
  re: RegExp;
  replace: string;
}

// Order matters: header-level rules first so their output is stable under later rules.
const RULES: readonly Rule[] = [
  {
    kind: 'authorization-header',
    re: new RegExp(`(\\bauthorization\\s*[:=]\\s*["']?)(?:[A-Za-z][A-Za-z0-9-]*\\s+)?(?!${REDACTED})[${TOKEN_CHARS}]{8,}=*`, 'gi'),
    replace: `$1${REDACTED}`,
  },
  { kind: 'bearer', re: new RegExp(`\\b(Bearer|Basic)\\s+[${TOKEN_CHARS}]{8,}=*`, 'gi'), replace: `$1 ${REDACTED}` },
  { kind: 'vc-resource-token', re: new RegExp(`\\bvc-resource-v1\\.[${TOKEN_CHARS}=]+`, 'g'), replace: `vc-resource-v1.${REDACTED}` },
  { kind: 'artifacts-token', re: /\bart_v\d+_[A-Za-z0-9_]{8,}(?:\?expires=\d+)?/g, replace: REDACTED },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, replace: REDACTED },
  {
    kind: 'query-token',
    re: /([?&](?:access_token|token|auth_token|id_token|api_key|apikey|password|client_secret)=)[^&\s#"'<>]+/gi,
    replace: `$1${REDACTED}`,
  },
  {
    kind: 'url-credentials',
    // scheme://user:pass@  (any scheme)  or  http(s)://anything@  (token-as-username)
    re: /\b([a-z][a-z0-9+.-]*:\/\/)(?:[^\s/@:"'<>]+:[^\s/@"'<>]*|(?<=https?:\/\/)[^\s/@:"'<>]+)@/gi,
    replace: `$1${REDACTED}@`,
  },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace known token formats and every explicitly listed secret with {@link REDACTED}. */
export function redact(text: string, ...secrets: ReadonlyArray<string | null | undefined>): string {
  let out = String(text);
  const explicit = secrets.filter((s): s is string => typeof s === 'string' && s.length > 0).sort((a, b) => b.length - a.length);
  if (explicit.length > 0) out = out.replace(new RegExp(explicit.map(escapeRe).join('|'), 'g'), REDACTED);
  for (const rule of RULES) out = out.replace(rule.re, rule.replace);
  return out;
}

/** Deep-redact every string inside a JSON-like value. Returns a new value; the input is not mutated. */
export function redactDeep<T>(value: T, ...secrets: ReadonlyArray<string | null | undefined>): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v, ...secrets);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Which secret formats occur in `text` (deduplicated). */
export function findSecrets(text: string): SecretKind[] {
  const found = new Set<SecretKind>();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      // A header whose value is already redacted is not a secret.
      if (!m[0].includes(REDACTED)) {
        found.add(rule.kind);
        break;
      }
    }
  }
  return [...found];
}

/** True when `text` contains any recognized secret format. */
export function containsSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}
