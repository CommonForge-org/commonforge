/** One member's access across the organization's projects (admin screens spec §3, §5). */
import { useState } from "react";
import type { AccessLevel, MemberView, PersonAccess, Role } from "../api/types.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import { roleLabel } from "../lib/orgs.js";
import { EmptyState } from "../primitives/index.js";
import { ErrorNote, Loading } from "../ui.js";
import { AccessRow } from "./AccessRow.js";
import { OrgFrame } from "./OrgFrame.js";

export interface PersonProject {
  projectId: string;
  name: string;
  access: PersonAccess;
}

export function PersonView({ viewerRole, member, projects, busyProject, error, onSave }: { viewerRole: Role; member: Pick<MemberView, "userId" | "email" | "role">; projects: PersonProject[]; busyProject: string | null; error: unknown; onSave: (projectId: string, level: AccessLevel, folders: Record<string, AccessLevel>) => void }) {
  return (
    <div className="page person">
      <h1 className="page-title">
        {member.email} <span className="role-chip">{roleLabel(member.role)}</span>
      </h1>
      <ErrorNote error={error} />
      {projects.length === 0 ? (
        <EmptyState compact icon="files" title="No projects to show." />
      ) : (
        <section aria-label="Project access">
          {projects.map((p) => (
            <AccessRow key={`${p.projectId}/${p.access.level}/${p.access.folders.map((f) => f.level).join(",")}`} label={p.name} person={p.access} viewerRole={viewerRole} busy={busyProject === p.projectId} onSave={(level, folders) => onSave(p.projectId, level, folders)} />
          ))}
        </section>
      )}
    </div>
  );
}

export function Person({ org, role, userId, onSignOut }: { org: string; role: Role; userId: string; onSignOut?: () => void }) {
  const { api } = useApp();
  const load = useLoad(async () => {
    const [members, projects] = await Promise.all([api.listMembers(org), api.listProjects(org)]);
    const member = members.find((m) => m.userId === userId) ?? null;
    const rows: PersonProject[] = [];
    for (const p of projects) {
      const access = (await api.getProjectAccess(org, p.projectId)).find((a) => a.userId === userId);
      if (access) rows.push({ projectId: p.projectId, name: p.name, access });
    }
    return { member, rows };
  }, `${org}/members/${userId}`);
  const [busyProject, setBusyProject] = useState<string | null>(null);
  const act = useAction(async (projectId: string, level: AccessLevel, folders: Record<string, AccessLevel>) => {
    setBusyProject(projectId);
    try {
      await api.putProjectAccess(org, projectId, { userId, level, ...(Object.keys(folders).length ? { folders } : {}) });
      load.reload();
    } finally {
      setBusyProject(null);
    }
  });
  let content;
  if (load.error) content = <ErrorNote error={load.error} onRetry={load.reload} />;
  else if (!load.data) content = <Loading what="Loading access" />;
  else if (!load.data.member) content = <EmptyState compact icon="human" title="This person is not a member of this organization." />;
  else content = <PersonView viewerRole={role} member={load.data.member} projects={load.data.rows} busyProject={busyProject} error={act.error} onSave={(p, l, f) => void act.run(p, l, f)} />;
  return (
    <OrgFrame org={org} role={role} active="members" {...(onSignOut ? { onSignOut } : {})}>
      {content}
    </OrgFrame>
  );
}
