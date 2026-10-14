/**
 * Finding and killing check processes after a check ends (review I-1): a check may start
 * descendants in their own session/process group, so killing the child's group is not enough.
 *
 * - With a separate check uid (the supported mode) every process whose real, effective or saved
 *   uid is the check uid is killed: a check cannot change its uid, so this is complete.
 * - In `--unsafe-same-uid-checks` mode the runner can only find processes whose initial
 *   environment still carries the per-run marker variable (best effort: code that re-execs with
 *   a scrubbed environment escapes; that mode is for trusted content only).
 */
import { readdir, readFile } from 'node:fs/promises';

export interface ProcInfo {
  pid: number;
  /** real, effective, saved, filesystem uids */
  uids: number[];
}

export interface ProcessOps {
  list(): Promise<ProcInfo[]>;
  /** initial environment of `pid` as `K=V` strings, or null when unreadable */
  environ(pid: number): Promise<string[] | null>;
  kill(pid: number): void;
}

export const linuxProcessOps: ProcessOps = {
  async list() {
    const out: ProcInfo[] = [];
    let names: string[] = [];
    try {
      names = await readdir('/proc');
    } catch {
      return out;
    }
    for (const n of names) {
      if (!/^\d+$/.test(n)) continue;
      try {
        const status = await readFile(`/proc/${n}/status`, 'utf8');
        if (/^State:\s+[ZX]/m.test(status)) continue; // zombies run nothing (PID 1 may never reap them)
        const m = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
        if (m) out.push({ pid: Number(n), uids: m.slice(1, 5).map(Number) });
      } catch {
        /* exited */
      }
    }
    return out;
  },
  async environ(pid) {
    try {
      return (await readFile(`/proc/${pid}/environ`, 'latin1')).split('\0').filter(Boolean);
    } catch {
      return null;
    }
  },
  kill(pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone or not ours */
    }
  },
};

export const CHECK_MARKER_VAR = 'COMMONFORGE_CHECK_RUN';

export class CheckUidError extends Error {}

/**
 * A check uid must be a real, separate, unprivileged user: never 0 and never the runner's own uid
 * (that would run candidate code as the runner and make the reaper kill the runner user's processes).
 */
export function assertSeparateCheckUid(uid: number, gid: number = uid): void {
  const own = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (!Number.isInteger(uid) || uid <= 0) throw new CheckUidError(`check uid ${uid} is not allowed (must be a positive, unprivileged uid)`);
  if (uid === own) throw new CheckUidError(`check uid ${uid} is the runner's own uid; use a separate user (or --unsafe-same-uid-checks for trusted content)`);
  if (!Number.isInteger(gid) || gid <= 0) throw new CheckUidError(`check gid ${gid} is not allowed`);
}

/** Pids that belong to checks: by uid, else by marker. Never includes the runner itself. */
export async function findCheckProcesses(ops: ProcessOps, sel: { uid?: number; markers?: readonly string[] }): Promise<number[]> {
  // never sweep root or the runner's own user (review R-1): that would kill PID 1 / the user's session
  if (sel.uid !== undefined) assertSeparateCheckUid(sel.uid);
  const self = process.pid;
  const procs = await ops.list();
  if (sel.uid !== undefined) return procs.filter((p) => p.pid !== self && p.uids.includes(sel.uid!)).map((p) => p.pid);
  const wanted = new Set((sel.markers ?? []).map((m) => `${CHECK_MARKER_VAR}=${m}`));
  if (wanted.size === 0) return [];
  const out: number[] = [];
  for (const p of procs) {
    if (p.pid === self) continue;
    const env = await ops.environ(p.pid);
    if (env?.some((e) => wanted.has(e))) out.push(p.pid);
  }
  return out;
}

/** Kill check processes repeatedly until none is left (forking loops); returns survivors. */
export async function reapCheckProcesses(ops: ProcessOps, sel: { uid?: number; markers?: readonly string[] }, rounds = 50): Promise<number[]> {
  let left = await findCheckProcesses(ops, sel);
  for (let i = 0; i < rounds && left.length > 0; i++) {
    for (const pid of left) ops.kill(pid);
    await new Promise((r) => setTimeout(r, 20));
    left = await findCheckProcesses(ops, sel);
  }
  return left;
}
