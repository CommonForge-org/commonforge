/**
 * A project's folders for Settings → Folders (admin screens spec §6): kind, state, whether it is
 * still being set up (folders phase 4: its first version not bound yet) or its setup failed, and where else each is attached.
 */
import type { Services } from "../context.js";
import { canReadProject, canReadResource, type OrgActor } from "../middleware/authz.js";
import { listMounts } from "./directory.js";

export interface ProjectFolder {
  mountName: string;
  resourceId: string;
  resourceName: string;
  provider: "artifacts" | "r2-assets";
  state: "empty" | "importing" | "active" | "failed";
  error?: string;
  /** the folder may be changed in this project (the mount's operations include `write`) */
  writable: boolean;
  /** a new folder whose first version is being made (`folder_inits` pending); `state` is `empty` meanwhile */
  settingUp: boolean;
  /** its setup failed (`folder_inits` failed): Try again (`POST …/folders/:mount/setup/retry`) can work only then */
  setupFailed: boolean;
  alsoIn: Array<{ projectId: string; name: string }>;
}

export async function projectFolders(svc: Services, actor: OrgActor, projectId: string): Promise<ProjectFolder[]> {
  const out: ProjectFolder[] = [];
  for (const m of await listMounts(svc.db, actor.orgId, projectId)) {
    if (actor.role !== "owner" && !(await canReadResource(svc, actor, m.resource_id))) continue;
    const r = await svc.db
      .prepare(
        "SELECT r.name, r.provider, r.state, r.error, (SELECT f.state FROM folder_inits f WHERE f.org_id = r.org_id AND f.resource_id = r.resource_id) AS init_state FROM resources r WHERE r.org_id = ? AND r.resource_id = ?",
      )
      .bind(actor.orgId, m.resource_id)
      .first<{ name: string; provider: ProjectFolder["provider"]; state: ProjectFolder["state"]; error: string | null; init_state: "pending" | "done" | "failed" | null }>();
    if (!r) continue;
    const others = await svc.db
      .prepare("SELECT DISTINCT p.project_id, p.name FROM mounts mt JOIN projects p ON p.org_id = mt.org_id AND p.project_id = mt.project_id WHERE mt.org_id = ? AND mt.resource_id = ? AND mt.project_id <> ? ORDER BY p.name, p.project_id")
      .bind(actor.orgId, m.resource_id, projectId)
      .all<{ project_id: string; name: string }>();
    const alsoIn: ProjectFolder["alsoIn"] = [];
    for (const p of others.results) if (await canReadProject(svc, actor, p.project_id)) alsoIn.push({ projectId: p.project_id, name: p.name });
    const writable = (JSON.parse(m.operations_json) as string[]).includes("write");
    out.push({ mountName: m.mount_name, resourceId: m.resource_id, resourceName: r.name, provider: r.provider, state: r.state, writable, ...(r.error ? { error: r.error } : {}), settingUp: r.init_state === "pending", setupFailed: r.init_state === "failed", alsoIn });
  }
  return out;
}
