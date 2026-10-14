/** Project snapshots: mounts × accepted heads (plan §B.3). */
import {
  ProjectSnapshotSchema,
  computeSnapshotId,
  parseRevisionId,
  toIsoUtc,
  type AcceptedHead,
  type Operation,
  type ProjectSnapshot,
  type SnapshotEntry,
} from "@commonforge-org/core";
import type { Services } from "../context.js";
import { listMounts, mountOperations, type ProjectRow } from "./directory.js";

export interface SnapshotOptions {
  /** mounts the task writes: their entries get ['read','write']; every other entry ['read'] */
  writeMounts?: ReadonlySet<string>;
  /** only these mounts (others are left out of the snapshot) */
  onlyMounts?: ReadonlySet<string>;
  /** resourceId → revision to pin instead of the accepted head (staging mode: the live staging build) */
  baseRevisions?: ReadonlyMap<string, string>;
}

/** `base` when it is a commit of the head's own repository (same kind and repo), else the head. */
function baseRevision(head: AcceptedHead, base: string | undefined): AcceptedHead["revisionId"] {
  if (!base) return head.revisionId;
  try {
    const h = parseRevisionId(head.revisionId);
    const b = parseRevisionId(base);
    const same = (h.kind === "art" && b.kind === "art" && b.repoId === h.repoId) || (h.kind === "local" && b.kind === "local" && b.repoId === h.repoId);
    return same ? (base as AcceptedHead["revisionId"]) : head.revisionId;
  } catch {
    return head.revisionId;
  }
}

/** Snapshot of the project's mounts at their accepted heads; mounts without a head are skipped. */
export async function projectSnapshot(svc: Services, project: ProjectRow, opts: SnapshotOptions = {}): Promise<ProjectSnapshot> {
  const mounts = await listMounts(svc.db, project.org_id, project.project_id);
  const heads = new Map<string, AcceptedHead>();
  for (const h of await svc.ledger(project.org_id).listHeads()) heads.set(h.resourceId, h);
  const entries: SnapshotEntry[] = [];
  for (const m of mounts) {
    if (opts.onlyMounts && !opts.onlyMounts.has(m.mount_name)) continue;
    const head = heads.get(m.resource_id);
    if (!head) continue;
    const ops: Operation[] = opts.writeMounts ? (opts.writeMounts.has(m.mount_name) ? ["read", "write"] : ["read"]) : mountOperations(m);
    entries.push({ resourceId: head.resourceId, revisionId: baseRevision(head, opts.baseRevisions?.get(head.resourceId)), mode: m.mode, mountName: m.mount_name as SnapshotEntry["mountName"], operations: ops });
  }
  const body = {
    projectId: project.project_id,
    organizationId: project.org_id,
    membershipRevision: project.membership_revision,
    policyRevision: project.policy_revision,
    entries,
  };
  const snapshotId = await computeSnapshotId(body);
  return ProjectSnapshotSchema.parse({ ...body, snapshotId, createdAt: toIsoUtc(svc.now()) });
}

/** Snapshot entries a non-developer may see (readable resources only, never coordinates). */
export function presentSnapshot(s: ProjectSnapshot, readable: ReadonlySet<string> | null) {
  return { ...s, entries: readable ? s.entries.filter((e) => readable.has(e.resourceId)) : s.entries };
}
