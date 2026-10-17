/** One organization's projects (`/o/:org`), and `/`, which opens the organization used last. */
import { useEffect, useState } from "react";
import type { Membership, ProjectSummary, Role } from "../api/types.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import { formatTime, isDeveloperRole } from "../lib/model.js";
import { orgChecklist } from "../lib/onboarding.js";
import { orgLabels, pickOrg, readLastOrg, roleLabel } from "../lib/orgs.js";
import { NEW_ORG_HREF, navigate, orgHref, projectHref, settingsHref } from "../lib/router.js";
import { BRAND, EmptyState } from "../primitives/index.js";
import { ErrorNote, Link, Loading } from "../ui.js";
import { GettingStartedView } from "./GettingStarted.js";
import { OrgFrame } from "./OrgFrame.js";

export function NoOrgsView({ canCreateOrgs }: { canCreateOrgs: boolean }) {
  return (
    <div className="page">
      <EmptyState icon="human" title="No organizations yet">
        {canCreateOrgs ? (
          <>
            Create the first organization for a client. <Link href={NEW_ORG_HREF}>New organization</Link>
          </>
        ) : (
          "Ask an organization owner to add you. Projects you are granted will appear here."
        )}
      </EmptyState>
    </div>
  );
}

/** `/`: opens the remembered organization, else the first one. */
export function HomeRedirect() {
  const { me } = useApp();
  const memberships = me?.memberships ?? [];
  const target = pickOrg(memberships, readLastOrg());
  useEffect(() => {
    if (target) navigate(orgHref(target), { replace: true });
  }, [target]);
  return target ? <Loading what="Opening your organization" /> : <NoOrgsView canCreateOrgs={me?.canCreateOrgs ?? false} />;
}

type NewProjectProps = { busy: boolean; error: unknown; onCreate: (name: string, mode: "legacy" | "agent-native") => void; onCancel?: () => void; startOpen?: boolean };

function NewProjectForm({ busy, error, onCreate, onCancel, startOpen = false }: NewProjectProps) {
  const [open, setOpen] = useState(startOpen);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"legacy" | "agent-native">("agent-native");
  if (!open)
    return (
      <button type="button" className="btn btn-primary btn-small" onClick={() => setOpen(true)}>
        New project
      </button>
    );
  return (
    <form
      className="invite-form"
      aria-label="New project"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onCreate(name.trim(), mode);
      }}
    >
      <label className="field">
        Project name
        <input type="text" required maxLength={128} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Project workflow
        <select value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as "legacy" | "agent-native")}>
          <option value="agent-native">Project knowledge and verified changes</option>
          <option value="legacy">Legacy agency and staging</option>
        </select>
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
        Create project
      </button>
      <button
        type="button"
        className="btn btn-quiet"
        disabled={busy}
        onClick={() => {
          // a later New project starts empty, without the last attempt's error
          setName("");
          setMode("agent-native");
          setOpen(false);
          onCancel?.();
        }}
      >
        Cancel
      </button>
      <ErrorNote error={error} />
    </form>
  );
}

export function OrgHomeView({ membership: m, projects, label, newProject }: { membership: Membership; projects: ProjectSummary[]; label?: string; newProject?: NewProjectProps }) {
  // the checklist's New project opens the form (again, after a Cancel)
  const [opened, setOpened] = useState(0);
  const first = projects.length === 0 && !!newProject;
  return (
    <div className="page">
      <h1 className="page-title">
        {label ?? m.name} <span className="role-chip">{roleLabel(m.role)}</span>
      </h1>
      {first ? <GettingStartedView steps={orgChecklist()} onAction={{ project: () => setOpened((n) => n + 1) }} /> : null}
      {/* with no projects the checklist's New project is the page's one primary: the form shows once it is asked for */}
      {newProject && (!first || opened > 0 || newProject.startOpen) ? (
        <NewProjectForm
          key={opened}
          {...newProject}
          startOpen={newProject.startOpen || opened > 0}
          onCancel={() => {
            newProject.onCancel?.();
            if (first) setOpened(0);
          }}
        />
      ) : null}
      {projects.length === 0 ? (
        first ? null : (
          <EmptyState compact icon="files" title="No projects you can see in this organization.">
            {isDeveloperRole(m.role) ? "Ask an owner to give you access to a project." : "Your developer gives you access to your project. It will appear here."}
          </EmptyState>
        )
      ) : (
        <div className="project-grid">
          {projects.map((p) => (
            <Link key={p.projectId} href={projectHref(m.orgId, p.projectId, m.role === "owner" || m.role === "developer" ? "files" : "overview")} className="project-card">
              <span className="project-card-icon" aria-hidden="true">
                <img src={BRAND.icon} alt="" width={28} height={28} />
              </span>
              <strong>{p.name}</strong>
              <span className="muted small" title={p.createdAt}>
                Created {formatTime(p.createdAt)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** One organization's projects, inside the organization frame. */
export function OrgHome({ org, role, onSignOut }: { org: string; role: Role; onSignOut?: () => void }) {
  const { api, me } = useApp();
  const memberships = me?.memberships ?? [];
  const membership = memberships.find((m) => m.orgId === org) ?? { orgId: org, name: org, role };
  const label = orgLabels(memberships).get(org) ?? membership.name;
  const load = useLoad(() => api.listProjects(org), org);
  const act = useAction(async (name: string, mode: "legacy" | "agent-native") => {
    const p = await api.createProject(org, name, mode);
    navigate(settingsHref(org, p.projectId, "folders"));
  });

  let content;
  if (load.error) content = <ErrorNote error={load.error} onRetry={load.reload} />;
  else if (!load.data) content = <Loading what="Loading projects" />;
  else content = <OrgHomeView membership={membership} projects={load.data} label={label} {...(isDeveloperRole(role) ? { newProject: { busy: act.busy, error: act.error, onCreate: (n: string, mode: "legacy" | "agent-native") => void act.run(n, mode), onCancel: act.clearError } } : {})} />;
  return (
    <OrgFrame org={org} role={role} active="projects" {...(onSignOut ? { onSignOut } : {})}>
      {content}
    </OrgFrame>
  );
}
