/**
 * Edition return logic (plan §B.13; PRD AT-29): diff a client return against the server-side
 * inventory, then map allowed changes onto canonical resource paths.
 */
import { CoreError } from './errors.js';
import type { ResourceId, RevisionId } from './ids.js';
import {
  caseFoldKey,
  checkPath,
  hasAlwaysProtectedSegment,
  isWithinPrefix,
  matchesPathPattern,
} from './path-policy.js';
import type {
  BlockedChange,
  EditionBlockReason,
  EditionChange,
  EditionDelta,
  EditionManifestServerSide,
  MappedChange,
} from './schemas.js';

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Normalized form when valid; otherwise the raw string (it will be blocked as path_escape later). */
function key(path: string): string {
  const r = checkPath(path);
  return r.ok ? r.path : path;
}

/**
 * Compute the delta between the edition inventory and what the client returned.
 *
 * - `full`: the upload is the complete edition; inventory paths not returned are deleted.
 * - `partial`: only returned paths are considered; inventory paths not returned are `omitted`
 *   (left untouched), and only paths in `deletions` are deleted.
 *
 * In both modes explicit `deletions` apply; a deletion of a path absent from the inventory is
 * reported in `unknownDeletions` and otherwise ignored. A returned path whose content equals the
 * inventory is `unchanged`. A deleted and an added path with identical content form a `renamed`
 * change when the pairing is unambiguous (exactly one of each for that sha256).
 *
 * Throws `CoreError('invalid_edition_return')` for duplicate returned paths (after normalization)
 * or a path that is both returned and deleted.
 */
export function diffAgainstInventory(
  inv: readonly { readonly editionPath: string; readonly sha256: string }[],
  returned: readonly { readonly path: string; readonly sha256: string }[],
  mode: 'full' | 'partial',
  deletions: readonly string[],
): EditionDelta {
  const inventory = new Map<string, string>();
  for (const e of inv) inventory.set(key(e.editionPath), e.sha256);

  const ret = new Map<string, string>();
  for (const r of returned) {
    const k = key(r.path);
    if (ret.has(k)) throw new CoreError('invalid_edition_return', `duplicate returned path ${JSON.stringify(k)}`);
    ret.set(k, r.sha256);
  }
  const del = new Set(deletions.map(key));
  for (const d of del) {
    if (ret.has(d)) throw new CoreError('invalid_edition_return', `path both returned and deleted ${JSON.stringify(d)}`);
  }

  const added: EditionChange[] = [];
  const modified: EditionChange[] = [];
  const deleted: EditionChange[] = [];
  const unchanged: string[] = [];
  const omitted: string[] = [];
  const unknownDeletions: string[] = [];

  for (const [path, sha256] of ret) {
    const prev = inventory.get(path);
    if (prev === undefined) added.push({ path, kind: 'added', sha256 });
    else if (prev === sha256) unchanged.push(path);
    else modified.push({ path, kind: 'modified', sha256, previousSha256: prev });
  }
  for (const path of del) {
    const prev = inventory.get(path);
    if (prev === undefined) unknownDeletions.push(path);
    else deleted.push({ path, kind: 'deleted', previousSha256: prev });
  }
  for (const [path, prev] of inventory) {
    if (ret.has(path) || del.has(path)) continue;
    if (mode === 'full') deleted.push({ path, kind: 'deleted', previousSha256: prev });
    else omitted.push(path);
  }

  // Rename detection: unambiguous 1:1 pairing of deleted/added by content hash.
  const addedBySha = groupBy(added, (c) => c.sha256!);
  const deletedBySha = groupBy(deleted, (c) => c.previousSha256!);
  const renamed: EditionChange[] = [];
  const paired = new Set<EditionChange>();
  for (const [sha, adds] of addedBySha) {
    const dels = deletedBySha.get(sha);
    if (adds.length === 1 && dels?.length === 1) {
      const a = adds[0]!;
      const d = dels[0]!;
      renamed.push({ path: a.path, kind: 'renamed', oldPath: d.path, sha256: sha, previousSha256: sha });
      paired.add(a).add(d);
    }
  }

  const changes = [...added, ...modified, ...deleted, ...renamed]
    .filter((c) => !paired.has(c))
    .sort((a, b) => cmp(a.path, b.path) || cmp(a.kind, b.kind));

  return {
    mode,
    changes,
    unchanged: unchanged.sort(cmp),
    omitted: omitted.sort(cmp),
    unknownDeletions: unknownDeletions.sort(cmp),
  };
}

function groupBy<T>(items: T[], k: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const key = k(it);
    const list = m.get(key);
    if (list) list.push(it);
    else m.set(key, [it]);
  }
  return m;
}

/** The parts of the server-side manifest that mapping depends on. */
export type EditionMappingPolicy = Pick<EditionManifestServerSide, 'mappings' | 'canonicalBases'> & {
  readonly protectedPaths?: readonly string[];
  /** published files: an added/renamed-to path may not differ from one of them only by case */
  readonly inventory?: ReadonlyArray<{ readonly editionPath: string }>;
};

/**
 * Protected-path match, case-insensitively as well (review I-2): on a case-insensitive checkout
 * `Tests/Quote-Contract.test.ts` *is* `tests/quote-contract.test.ts`.
 */
export function matchesProtected(path: string, patterns: readonly string[]): boolean {
  const fold = caseFoldKey(path);
  return patterns.some((pat) => matchesPathPattern(path, pat) || matchesPathPattern(fold, caseFoldKey(pat)));
}

type PathMapping =
  | { ok: true; editionPath: string; resourceId: ResourceId; canonicalPath: string; baseRevision: RevisionId }
  | { ok: false; reason: EditionBlockReason };

/**
 * Map one edition path to a canonical path. Checks, in order:
 * `path_escape` (path fails normalization or the mapped path leaves the canonical prefix) →
 * `not_mapped` (no mapping prefix contains it, ambiguous longest match, or no canonical base) →
 * `read_only` (mapping not writable) → `protected` (`.git`/`.commonforge`/`.vibecontrol` segment, or
 * canonical path matches a `protectedPaths` pattern, also case-insensitively).
 */
export function mapEditionPath(path: string, policy: EditionMappingPolicy): PathMapping {
  const norm = checkPath(path);
  if (!norm.ok) return { ok: false, reason: 'path_escape' };
  const p = norm.path;

  let best: EditionMappingPolicy['mappings'][number] | undefined;
  let ambiguous = false;
  for (const m of policy.mappings) {
    if (!isWithinPrefix(p, m.editionPathPrefix)) continue;
    if (!best || m.editionPathPrefix.length > best.editionPathPrefix.length) {
      best = m;
      ambiguous = false;
    } else if (m.editionPathPrefix.length === best.editionPathPrefix.length) {
      ambiguous = true;
    }
  }
  if (!best || ambiguous) return { ok: false, reason: 'not_mapped' };

  const rest = best.editionPathPrefix === '' ? p : p.slice(best.editionPathPrefix.length).replace(/^\//, '');
  const joined = [best.canonicalPathPrefix, rest].filter((s) => s !== '').join('/');
  const canon = checkPath(joined);
  if (!canon.ok || !isWithinPrefix(canon.path, best.canonicalPathPrefix)) return { ok: false, reason: 'path_escape' };

  const base = policy.canonicalBases.find((b) => b.resourceId === best.resourceId);
  if (!base) return { ok: false, reason: 'not_mapped' };

  if (!best.writable) return { ok: false, reason: 'read_only' };

  if (
    hasAlwaysProtectedSegment(p) ||
    hasAlwaysProtectedSegment(canon.path) ||
    matchesProtected(canon.path, policy.protectedPaths ?? [])
  ) {
    return { ok: false, reason: 'protected' };
  }

  return { ok: true, editionPath: p, resourceId: best.resourceId, canonicalPath: canon.path, baseRevision: base.revisionId };
}

/**
 * Split a delta into allowed canonical changes and blocked changes with reasons.
 * Every change lands in exactly one of the two lists — nothing is silently dropped.
 * A rename whose two sides are both allowed in the same resource stays a rename; otherwise
 * (either side blocked, or the sides map to different resources) it is decomposed into
 * `deleted(oldPath)` + `added(path)` and each side is mapped independently, giving exactly the
 * result the unpaired diff would have produced.
 */
export function mapEditionDelta(
  delta: EditionDelta,
  manifest: EditionMappingPolicy,
): { allowed: MappedChange[]; blocked: BlockedChange[] } {
  const allowed: MappedChange[] = [];
  const blocked: BlockedChange[] = [];
  // published paths by case-fold key: a new path that only differs by case from one is refused
  const folded = new Map<string, string>();
  for (const i of manifest.inventory ?? []) folded.set(caseFoldKey(key(i.editionPath)), key(i.editionPath));
  const collides = (path: string): boolean => {
    const k = key(path);
    const other = folded.get(caseFoldKey(k));
    return other !== undefined && other !== k;
  };
  // file/folder conflicts (re-review R-1): published files and every new path of this delta
  const files = new Set<string>(folded.keys());
  for (const c of delta.changes) if (c.kind === 'added' || c.kind === 'renamed') files.add(caseFoldKey(key(c.path)));
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  // published folders as spelled, to catch a new folder that differs from one only by case
  const folderFolds = new Set<string>();
  const exactDirs = new Set<string>();
  for (const i of manifest.inventory ?? []) {
    const parts = key(i.editionPath).split('/');
    for (let n = 1; n < parts.length; n++) {
      exactDirs.add(parts.slice(0, n).join('/'));
      folderFolds.add(caseFoldKey(parts.slice(0, n).join('/')));
    }
  }
  const fileFolderConflict = (path: string): boolean => {
    const k = key(path);
    const f = caseFoldKey(k);
    if (dirs.has(f)) return true;
    const parts = f.split('/');
    const exact = k.split('/');
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join('/');
      if (files.has(anc)) return true;
      // `Tests/x` next to a published `tests/` folder (one folder on a case-insensitive checkout)
      if (folderFolds.has(anc) && !exactDirs.has(exact.slice(0, i).join('/'))) return true;
    }
    return false;
  };

  const mapSimple = (c: EditionChange): void => {
    if ((c.kind === 'added' || c.kind === 'renamed') && collides(c.path)) {
      blocked.push({ path: c.path, reason: 'case_collision' });
      return;
    }
    if ((c.kind === 'added' || c.kind === 'renamed') && fileFolderConflict(c.path)) {
      blocked.push({ path: c.path, reason: 'path_conflict' });
      return;
    }
    const to = mapEditionPath(c.path, manifest);
    if (!to.ok) {
      blocked.push({ path: c.path, reason: to.reason });
      return;
    }
    allowed.push(
      stripUndefined({
        resourceId: to.resourceId,
        baseRevision: to.baseRevision,
        kind: c.kind,
        editionPath: to.editionPath,
        canonicalPath: to.canonicalPath,
        sha256: c.sha256,
        previousSha256: c.previousSha256,
      }),
    );
  };

  for (const c of delta.changes) {
    if (c.kind !== 'renamed') {
      mapSimple(c);
      continue;
    }
    const oldPath = c.oldPath ?? '';
    if (collides(c.path) || fileFolderConflict(c.path)) {
      // a (case-only) rename onto a published path's spelling, or onto a file/folder conflict: neither side is applied
      const reason = collides(c.path) ? 'case_collision' : 'path_conflict';
      blocked.push({ path: oldPath, reason }, { path: c.path, reason });
      continue;
    }
    const from = mapEditionPath(oldPath, manifest);
    const to = mapEditionPath(c.path, manifest);
    if (from.ok && to.ok && from.resourceId === to.resourceId) {
      allowed.push({
        resourceId: to.resourceId,
        baseRevision: to.baseRevision,
        kind: 'renamed',
        editionPath: to.editionPath,
        canonicalPath: to.canonicalPath,
        oldEditionPath: from.editionPath,
        oldCanonicalPath: from.canonicalPath,
        sha256: c.sha256!,
        previousSha256: c.previousSha256!,
      });
      continue;
    }
    mapSimple(stripUndefined({ path: oldPath, kind: 'deleted', previousSha256: c.previousSha256 }));
    mapSimple(stripUndefined({ path: c.path, kind: 'added', sha256: c.sha256 }));
  }

  // never delete the published file whose case-variant replacement was refused (no half-applied rename)
  const refused = new Set(blocked.filter((b) => b.reason === 'case_collision' || b.reason === 'path_conflict').map((b) => caseFoldKey(key(b.path))));
  for (let i = allowed.length - 1; i >= 0; i--) {
    const a = allowed[i]!;
    if (a.kind === 'deleted' && refused.has(caseFoldKey(a.editionPath))) {
      allowed.splice(i, 1);
      blocked.push({ path: a.editionPath, reason: 'case_collision' });
    }
  }
  allowed.sort((a, b) => cmp(a.resourceId, b.resourceId) || cmp(a.canonicalPath, b.canonicalPath));
  blocked.sort((a, b) => cmp(a.path, b.path));
  return { allowed, blocked };
}

function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
