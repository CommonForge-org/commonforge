/**
 * Process boundary for every command: environment, cwd, output streams, fetch and clocks are
 * injected so commands are testable in-process against a fake API.
 */
import { redact } from "@commonforge-org/runner-protocol";

export interface CliIo {
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** whole stdin (the credential helper reads git's request from it) */
  readStdin: () => Promise<string>;
  /** a line from the terminal, or null when stdin is not interactive */
  prompt: (question: string) => Promise<string | null>;
  fetch: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /**
   * Argv prefix git runs as the credential helper (`[node, /abs/dist/index.js]`). Written into the
   * mounts' git config, never a token.
   */
  helperCommand: readonly string[];
}

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

/** Secrets seen during this process (session, lease and git tokens); scrubbed from all output. */
const knownSecrets = new Set<string>();

export function rememberSecret(secret: string | null | undefined): void {
  if (secret) knownSecrets.add(secret);
}

/** CommonForge bearers (session, lease, magic code), which runner-protocol `redact` does not know. */
const CF_BEARER_RE = /\bcf[slm]_[A-Za-z0-9_-]{8,}/g;

export function scrub(text: string): string {
  return redact(text, ...knownSecrets).replace(CF_BEARER_RE, "<redacted>");
}

export interface GlobalOptions {
  json: boolean;
  apiUrl?: string;
  org?: string;
}

/** Writes one result: a JSON document (`--json`, for agents) or human text, always redacted. */
export class Output {
  constructor(
    readonly io: CliIo,
    readonly json: boolean,
  ) {}

  /** Human progress line (stderr; suppressed in --json mode so stdout stays one JSON document). */
  info(line: string): void {
    if (!this.json) this.io.stderr(scrub(`${line}\n`));
  }

  /** Warning line on stderr, in every mode (stdout stays one JSON document under --json). */
  warn(line: string): void {
    this.io.stderr(scrub(`${line}\n`));
  }

  result(value: unknown, human: string | (() => string)): void {
    if (this.json) this.io.stdout(scrub(`${JSON.stringify(value)}\n`));
    else {
      const text = typeof human === "function" ? human() : human;
      if (text) this.io.stdout(scrub(text.endsWith("\n") ? text : `${text}\n`));
    }
  }

  error(e: CliError): void {
    if (this.json) this.io.stdout(scrub(`${JSON.stringify({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } })}\n`));
    else this.io.stderr(scrub(`cforge: ${e.message} (${e.code})\n`));
  }
}
