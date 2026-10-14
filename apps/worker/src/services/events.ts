/** Application activity log (D1). Ledger audit (accept/restore/bind) stays in OrgLedger. */
import type { PrincipalRef } from "@commonforge-org/core";
import type { Services } from "../context.js";

export interface AppEvent {
  orgId: string;
  projectId?: string | null;
  actor: PrincipalRef;
  action: string;
  subjectKind: string;
  subjectId: string;
  detail?: Record<string, unknown>;
  /** resources the event is about; a caller sees the event only with read on every one of them */
  resourceIds?: string[];
  /** shown to client/viewer roles (they get `clientDetail`, never `detail`) */
  clientVisible?: boolean;
  /** what clients/viewers see (codes and paths only; never raw runner output or coordinates) */
  clientDetail?: Record<string, unknown>;
}

export async function recordEvent(svc: Services, e: AppEvent): Promise<void> {
  await svc.db
    .prepare(
      "INSERT INTO events (org_id, project_id, at, actor_json, action, subject_kind, subject_id, detail_json, resource_ids, client_visible, client_detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      e.orgId,
      e.projectId ?? null,
      svc.nowIso(),
      JSON.stringify(e.actor),
      e.action,
      e.subjectKind,
      e.subjectId,
      e.detail ? JSON.stringify(e.detail) : null,
      JSON.stringify([...new Set(e.resourceIds ?? [])]),
      e.clientVisible ? 1 : 0,
      e.clientDetail ? JSON.stringify(e.clientDetail) : null,
    )
    .run();
}

export const userRef = (userId: string): PrincipalRef => ({ kind: "user", id: userId }) as PrincipalRef;
export const agentRef = (taskId: string, userId: string): PrincipalRef => ({ kind: "agent", id: taskId, onBehalfOf: { kind: "user", id: userId } }) as PrincipalRef;
