/**
 * `OpsGate`: one Durable Object per Artifacts namespace (plan §0.3 A9).
 *
 * - Counting semaphore: at most {@link MAX_CONCURRENT_OPS} (25) concurrent fork/create/token
 *   control-plane operations per namespace. Slots carry a lease so a crashed holder frees itself.
 * - Named locks: serialize work per key (e.g. one provisioning step per task workspace id).
 *
 * State lives in the DO's SQLite storage, so it survives eviction.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.js";

export const MAX_CONCURRENT_OPS = 25;
export const SLOT_LEASE_MS = 60_000;

export class OpsGate extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS slots (ticket TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS locks (lock_key TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS hits (hit_key TEXT NOT NULL, at INTEGER NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS hits_by_key ON hits (hit_key, at);",
    );
  }

  /** Take a slot if fewer than `limit` unexpired slots are held; returns the ticket or null. */
  async acquire(limit = MAX_CONCURRENT_OPS, leaseMs = SLOT_LEASE_MS): Promise<string | null> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM slots WHERE expires_at <= ?", now);
    const held = sql.exec<{ n: number }>("SELECT count(*) AS n FROM slots").one().n;
    if (held >= limit) return null;
    const ticket = crypto.randomUUID();
    sql.exec("INSERT INTO slots (ticket, expires_at) VALUES (?, ?)", ticket, now + leaseMs);
    return ticket;
  }

  async release(ticket: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM slots WHERE ticket = ?", ticket);
  }

  async held(): Promise<number> {
    const now = Date.now();
    return this.ctx.storage.sql.exec<{ n: number }>("SELECT count(*) AS n FROM slots WHERE expires_at > ?", now).one().n;
  }

  /**
   * Sliding-window rate limit: record a hit for every key in `keys` only if **all** of them are under
   * their limit (atomic: a DO method runs to completion before the next one starts).
   */
  async hit(keys: Array<{ key: string; limit: number; windowMs: number }>): Promise<{ ok: true } | { ok: false; key: string }> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const maxWindow = Math.max(...keys.map((k) => k.windowMs));
    sql.exec("DELETE FROM hits WHERE at <= ?", now - maxWindow);
    for (const k of keys) {
      const n = sql.exec<{ n: number }>("SELECT count(*) AS n FROM hits WHERE hit_key = ? AND at > ?", k.key, now - k.windowMs).one().n;
      if (n >= k.limit) return { ok: false, key: k.key };
    }
    for (const k of keys) sql.exec("INSERT INTO hits (hit_key, at) VALUES (?, ?)", k.key, now);
    return { ok: true };
  }

  /** Exclusive lock on `key` for `owner` (re-entrant for the same owner). */
  async lock(key: string, owner: string, leaseMs: number): Promise<boolean> {
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ owner: string; expires_at: number }>("SELECT owner, expires_at FROM locks WHERE lock_key = ?", key).toArray()[0];
    if (row && row.expires_at > now && row.owner !== owner) return false;
    sql.exec("INSERT OR REPLACE INTO locks (lock_key, owner, expires_at) VALUES (?, ?, ?)", key, owner, now + leaseMs);
    return true;
  }

  async unlock(key: string, owner: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM locks WHERE lock_key = ? AND owner = ?", key, owner);
  }
}

export interface GateClient {
  /** Run `fn` holding one of the namespace's slots; waits (jittered) up to `waitMs`. */
  withSlot<T>(namespace: string, fn: () => Promise<T>): Promise<T>;
  /** Run `fn` holding the named lock, or return `{ locked: true }` when someone else holds it. */
  withLock<T>(scope: string, key: string, leaseMs: number, fn: () => Promise<T>): Promise<{ locked: false; value: T } | { locked: true }>;
}

export class GateBusyError extends Error {
  readonly code = "provider_unavailable";
  constructor(namespace: string) {
    super(`provider_unavailable: too many concurrent Artifacts operations in ${namespace}; retry later`);
  }
}

export function gateClient(ns: DurableObjectNamespace<OpsGate>, opts: { waitMs?: number; sleep?: (ms: number) => Promise<void> } = {}): GateClient {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = opts.waitMs ?? 10_000;
  const stub = (name: string) => ns.get(ns.idFromName(name));
  return {
    async withSlot(namespace, fn) {
      const gate = stub(`ns:${namespace}`);
      const deadline = Date.now() + waitMs;
      let ticket: string | null = null;
      for (let attempt = 0; ticket === null; attempt++) {
        ticket = await gate.acquire();
        if (ticket !== null) break;
        if (Date.now() > deadline) throw new GateBusyError(namespace);
        await sleep(Math.min(1000, 50 * 2 ** attempt) * (0.5 + Math.random()));
      }
      try {
        return await fn();
      } finally {
        await gate.release(ticket);
      }
    },
    async withLock(scope, key, leaseMs, fn) {
      const gate = stub(`lock:${scope}`);
      const owner = crypto.randomUUID();
      if (!(await gate.lock(key, owner, leaseMs))) return { locked: true };
      try {
        return { locked: false, value: await fn() };
      } finally {
        await gate.unlock(key, owner);
      }
    },
  };
}
