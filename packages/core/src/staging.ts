/**
 * Always-on staging (spec 2026-10-07): pure rules shared by the Worker and later the web app.
 * - promotion levels: which review a promotion needs, from the paths it changes;
 * - migration lint: the deterministic veto (only additive SQL may skip a developer);
 * - migration reset: an applied migration cannot be undone in place, so staging data resets
 *   whenever the applied list stops being a prefix of the next deploy's list.
 */
import { z } from 'zod';
import { canonicalJson, sha256HexSync } from './canonical-json.js';
import { CoreError } from './errors.js';
import { matchesPathPattern } from './path-policy.js';

export const PROMOTION_LEVELS = ['self', 'classify', 'developer'] as const;
export type PromotionLevel = (typeof PROMOTION_LEVELS)[number];

export const PromotionRuleSchema = z.object({
  paths: z.array(z.string().min(1).max(512)).min(1).max(50),
  level: z.enum(PROMOTION_LEVELS),
});
export type PromotionRule = z.infer<typeof PromotionRuleSchema>;

const RANK: Record<PromotionLevel, number> = { self: 0, classify: 1, developer: 2 };

/** Paths are `<mountName>/<path>`. First matching rule wins; unmatched paths need a developer. */
export function promotionLevel(rules: readonly PromotionRule[], changedPaths: readonly string[]) {
  const perPath = changedPaths.map((path) => {
    const i = rules.findIndex((r) => r.paths.some((p) => matchesPathPattern(path, p)));
    return { path, level: i === -1 ? ('developer' as PromotionLevel) : rules[i]!.level, rule: i === -1 ? null : i };
  });
  const level = perPath.reduce<PromotionLevel>((acc, p) => (RANK[p.level] > RANK[acc] ? p.level : acc), 'self');
  return { level, perPath };
}

/** Split SQL into statements on `;` outside quotes and comments; comments are dropped. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      cur += ' ';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 1;
      cur += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '[') quote = ']';
    if (ch === ';') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.replace(/[ \t\n\f\r]+/g, ' ').trim()).filter(Boolean);
}

/**
 * The statement text with string literals and parenthesised groups removed and each quoted
 * identifier replaced by `Q`. SQLite reads only ASCII space, tab, LF, FF and CR as whitespace, so
 * the whitespace here is the same set (JS `\s` would also match NBSP and friends).
 */
function skeleton(stmt: string): string {
  let out = '';
  let depth = 0;
  let quote: string | null = null;
  for (const ch of stmt) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '"' || ch === '`' || ch === '[') {
      quote = ch === '[' ? ']' : ch;
      if (depth === 0) out += 'Q';
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out.replace(/[ \t\n\f\r]+/g, ' ').trim().toUpperCase();
}

function additive(stmt: string): boolean {
  const s = skeleton(stmt);
  // SQLite reads any byte >= 0x80 as an identifier character; outside quotes that is never trusted.
  if (/[^\x20-\x7e\t\n\f\r]/.test(s)) return false;
  if (/^CREATE (UNIQUE )?INDEX\b/.test(s)) return true;
  if (/^CREATE TABLE\b/.test(s)) return true;
  const add = /^ALTER TABLE \S+ ADD (COLUMN )?(.*)$/.exec(s);
  if (add) {
    const def = add[2]!;
    return !/\bNOT NULL\b/.test(def) || /\bDEFAULT\b/.test(def);
  }
  return false;
}

export function lintMigrations(previous: Readonly<Record<string, string>>, next: Readonly<Record<string, string>>) {
  const offending: Array<{ file: string; statement: string }> = [];
  for (const [file, sql] of Object.entries(previous)) {
    if (!Object.hasOwn(next, file)) offending.push({ file, statement: '(existing migration removed)' });
    else if (next[file] !== sql) offending.push({ file, statement: '(existing migration changed)' });
  }
  for (const file of Object.keys(next).sort()) {
    if (Object.hasOwn(previous, file)) continue;
    for (const stmt of statements(next[file]!)) if (!additive(stmt)) offending.push({ file, statement: stmt });
  }
  return { kind: offending.length === 0 ? ('additive' as const) : ('destructive' as const), offending };
}

/** The applied-migration key: `<file name>@<sha256 of its content>` (an edited file is a new key). */
export function migrationKey(name: string, sha256: string): string {
  return `${name}@${sha256}`;
}

const KEY = /^(.*)@([0-9a-f]{64})$/;
const keyName = (k: string) => KEY.exec(k)?.[1] ?? k;

/** An applied entry matches the next one when name and content match; an entry without `@sha256`
 * (recorded before content tracking) matches by name only. */
function sameMigration(applied: string, next: string | undefined): boolean {
  if (next === undefined) return false;
  return KEY.test(applied) ? applied === next : applied === keyName(next);
}

/**
 * True when the applied list is not a prefix of the next one: an applied migration was removed,
 * reordered, renamed or edited (its `name@sha256` key changed). Entries are file names or
 * `migrationKey` keys.
 */
export function migrationsNeedReset(applied: readonly string[], next: readonly string[]): boolean {
  return applied.some((a, i) => !sameMigration(a, next[i]));
}

/** Whether `next` (a `migrationKey` key or a name) is already in the applied list. */
export function migrationApplied(applied: readonly string[], next: string): boolean {
  return applied.some((a) => sameMigration(a, next));
}

export function stagingWorkerName(workerName: string): string {
  const name = `${workerName}-staging`;
  if (name.length > 63) throw new CoreError('invalid_input', `staging Worker name ${name} is longer than 63 characters`);
  return name;
}

type SetLanding = { landingId: string; seq: number; paths: readonly string[]; after?: readonly string[]; with?: readonly string[] };

/**
 * The landings to promote together: the target plus every predecessor that shares a path with a
 * landing already in the set (transitively), in `seq` order. A predecessor of a landing is any
 * landing with a lower `seq`, or one listed in its `after` (staging phase 2: a revision part was
 * seeded from a staging build that contained those landings, which may come later in `seq`). Ids
 * in `after` that name no given landing are ignored. A landing listed in the `with` of a member
 * (a developer-declared "must travel with") joins unconditionally, without sharing a path, and
 * then contributes its paths like any member.
 */
export function promotionSet(landings: ReadonlyArray<SetLanding>, target: string): string[] {
  const t = landings.find((l) => l.landingId === target);
  if (!t) throw new CoreError('invalid_input', `unknown landing ${target}`);
  const inSet = new Map([[t.landingId, t]]);
  const paths = new Set(t.paths);
  const isPredecessor = (l: SetLanding) => [...inSet.values()].some((m) => l.seq < m.seq || (m.after ?? []).includes(l.landingId));
  const isForced = (l: SetLanding) => [...inSet.values()].some((m) => (m.with ?? []).includes(l.landingId));
  for (let grew = true; grew; ) {
    grew = false;
    for (const l of landings) {
      if (inSet.has(l.landingId)) continue;
      if (!isForced(l) && (!l.paths.some((p) => paths.has(p)) || !isPredecessor(l))) continue;
      inSet.set(l.landingId, l);
      for (const p of l.paths) paths.add(p);
      grew = true;
    }
  }
  return [...inSet.values()].sort((a, b) => a.seq - b.seq).map((l) => l.landingId);
}

/** The target plus its transitive `with` chain (no path closure), in `seq` order. `with` ids that name no given landing are ignored. */
export function aloneSet(landings: ReadonlyArray<SetLanding>, target: string): string[] {
  const t = landings.find((l) => l.landingId === target);
  if (!t) throw new CoreError('invalid_input', `unknown landing ${target}`);
  const inSet = new Map([[t.landingId, t]]);
  for (const queue = [t]; queue.length > 0; ) {
    for (const id of queue.shift()?.with ?? []) {
      const l = landings.find((x) => x.landingId === id);
      if (!l || inSet.has(id)) continue;
      inSet.set(id, l);
      queue.push(l);
    }
  }
  return [...inSet.values()].sort((a, b) => a.seq - b.seq).map((l) => l.landingId);
}

/** The landings a promotion goes without when it runs alone: the closure minus the alone set, in `seq` order. */
export function goingWithout(landings: ReadonlyArray<SetLanding>, target: string): string[] {
  const alone = new Set(aloneSet(landings, target));
  return promotionSet(landings, target).filter((id) => !alone.has(id));
}

/** What a clearance is bound to: the set's proposal hashes, in set order. Whether it still covers the set's level is the promotion service's check (ruling P2-1). */
export function clearanceKey(input: { proposalHashes: readonly string[] }): string {
  return sha256HexSync(canonicalJson({ $t: 'cf.clearance/1', proposalHashes: [...input.proposalHashes] }));
}
