/**
 * Project frame (mockups `client-overview` / `developer-change-storyboard`): the app header with
 * breadcrumb, "Viewing as …" and (developers) the inspector toggle; the left section nav with
 * counts; the page header (project name and project actions); and the developer inspector drawer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client.js";
import type { Membership, Project, Role } from "../api/types.js";
import { useApp, useLoad, type Loaded } from "../lib/hooks.js";
import { isDeveloperRole } from "../lib/model.js";
import { orgLabels, rememberOrg } from "../lib/orgs.js";
import { navigate, orgHref, projectHref, settingsHref, type Route } from "../lib/router.js";
import { AppHeader, InspectorDrawer, OrgSwitcher, SideNav, type Crumb, type InspectorSection, type NavItem } from "../primitives/index.js";
import { ErrorNote, Loading } from "../ui.js";
import { ActivityScreen } from "./Activity.js";
import { ChangesScreen } from "./Changes.js";
import { EditionsButton, StartUpdateButton } from "./Editions.js";
import { ExportPanel } from "./ExportPanel.js";
import { FilesScreen } from "./Files.js";
import { IntakeScreen } from "./Intake.js";
import { ProjectKnowledge } from "./ProjectKnowledge.js";
import { ProjectOutcomes } from "./ProjectOutcomes.js";
import { loadNativeProject } from "../api/native.js";
import { NativeOverview, NativeReview } from "./NativeReview.js";
import { OverviewScreen } from "./Overview.js";
import { decisionCount, loadLive, POLL_MS, ProjectContext, updateRegistry, UploadsContext, useProjectUploads, type LiveState } from "./project-data.js";
import { ProjectSettings } from "./ProjectSettings.js";
import { PromotionRoute } from "./PromotionReview.js";
import { ProposalReview } from "./ProposalReview.js";
import { SentFromStaging } from "./SentFromStaging.js";
import { StagingHeader } from "./StagingHeader.js";
import { TasksBoardScreen } from "./TasksBoard.js";
import { VersionsScreen } from "./Versions.js";

type ProjectRoute = Extract<Route, { name: "project" } | { name: "proposal" } | { name: "promotion" } | { name: "intake" } | { name: "settings" }>;
type Section = "overview" | "tasks" | "files" | "changes" | "versions" | "activity" | "settings" | "outcomes" | "knowledge" | "review";

const SECTION_LABEL: Record<Section, string> = { outcomes: "Outcomes", knowledge: "Knowledge", review: "Behavior review", overview: "Overview", tasks: "Tasks", files: "Files", changes: "Changes", versions: "Versions", activity: "Activity", settings: "Settings" };

/** `showTasks`: the Tasks board, staging-mode projects only (staging phase 3). */
export function navItems(org: string, pid: string, decisions: number, showSettings = false, showTasks = false): NavItem[] {
  const decisionLabel = `Needs your decision · ${decisions}`;
  return [
    { id: "overview", label: "Overview", icon: "overview", href: projectHref(org, pid, "overview") },
    ...(showTasks ? [{ id: "tasks", label: "Tasks", icon: "layout", href: projectHref(org, pid, "tasks") } as NavItem] : []),
    ...(showSettings ? [{ id: "outcomes", label: "Outcomes", icon: "overview", href: projectHref(org, pid, "outcomes") }, { id: "knowledge", label: "Knowledge", icon: "files", href: projectHref(org, pid, "knowledge") }, { id: "review", label: "Behavior review", icon: "changes", href: projectHref(org, pid, "review") }] as NavItem[] : []),
    { id: "files", label: "Files", icon: "files", href: projectHref(org, pid, "files") },
    { id: "changes", label: "Changes", icon: "changes", href: projectHref(org, pid, "changes"), count: decisions, countState: "decision", countLabel: decisionLabel },
    { id: "versions", label: "Versions", icon: "versions", href: projectHref(org, pid, "versions") },
    { id: "activity", label: "Activity", icon: "activity", href: projectHref(org, pid, "activity") },
    ...(showSettings ? [{ id: "settings", label: "Settings", icon: "inspector", href: settingsHref(org, pid) } as NavItem] : []),
  ];
}

/** The left section nav; the Changes item counts the decisions waiting on the viewer; the org switcher at the bottom. */
export function ProjectTabs({ org, pid, active, decisions, memberships = [], canCreateOrgs = false, showSettings = false, showTasks = false }: { org: string; pid: string; active: string; decisions: number; memberships?: Membership[]; canCreateOrgs?: boolean; showSettings?: boolean; showTasks?: boolean }) {
  return <SideNav items={navItems(org, pid, decisions, showSettings, showTasks)} active={active} footer={<OrgSwitcher memberships={memberships} current={org} canCreateOrgs={canCreateOrgs} />} />;
}

const INSPECTOR_KEY = "cf-inspector-open";

function readFlag(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    globalThis.localStorage?.setItem(key, on ? "1" : "0");
  } catch {
    // a per-viewer convenience only
  }
}

/** Project-level technical detail, under whatever the current screen adds. */
export function projectInspector(org: string, project: Project, role: Role): InspectorSection {
  return {
    title: "Project",
    rows: [
      { label: "Organization", value: org, copy: org },
      { label: "Project", value: project.projectId, copy: project.projectId },
      { label: "Your role", value: role, mono: false },
      ...project.mounts.map((m) => ({ label: `Mount ${m.mountName}`, value: `${m.resourceId} · ${m.provider} · ${m.mode}`, copy: m.resourceId })),
    ],
  };
}

export function ProjectShell({ route, role, onSignOut }: { route: ProjectRoute; role: Role; onSignOut?: () => void }) {
  const { api, me, fixture } = useApp();
  const { org, pid } = route;
  const project = useLoad(() => api.getProject(org, pid), `${org}/${pid}/${role}`);
  // the project (its policy says whether staging is on, for owners and developers) and the previous
  // poll (kept for staging and captures when a read fails) are read at each poll
  const live: Loaded<LiveState> = useLoad(() => loadLive(api, org, pid, role, { project: project.data, previous: live.data }), `${org}/${pid}/${role}`, POLL_MS);
  const dev = isDeveloperRole(role);
  const native = useLoad(() => dev && !fixture ? loadNativeProject(org, pid) : Promise.resolve(null), `${org}/${pid}/${role}/native-mode`, POLL_MS);
  // uploads outlive the Files tab: only leaving the project (this frame) or the page cancels them
  const uploads = useProjectUploads(api, org, pid);
  const [inspectorOpen, setInspectorOpen] = useState(() => readFlag(INSPECTOR_KEY));
  const [registry, setRegistry] = useState<Array<{ id: string; sections: InspectorSection[] }>>([]);
  const setInspector = useCallback((id: string, s: InspectorSection[] | null) => setRegistry((r) => updateRegistry(r, id, s)), []);
  // Sent from staging uses the drawer column; while it is open it takes the inspector's place
  const [sentOpen, setSentOpen] = useState(false);
  const toggleInspector = () => {
    // the inspector hidden behind Sent from staging comes back instead of turning off
    if (showSent) {
      setSentOpen(false);
      if (inspectorOpen) return;
    }
    writeFlag(INSPECTOR_KEY, !inspectorOpen);
    setInspectorOpen(!inspectorOpen);
  };

  const active: Section = route.name === "proposal" ? "changes" : route.name === "promotion" ? "tasks" : route.name === "intake" ? "files" : route.name === "settings" ? "settings" : route.tab;
  useEffect(() => rememberOrg(org), [org]);
  const memberships = me?.memberships ?? [];
  const orgName = orgLabels(memberships).get(org) ?? org;
  const crumbs: Crumb[] = [{ label: orgName, href: orgHref(org) }];
  const staging = live.data?.staging;
  const stagingMode = !!staging?.enabled;
  // clients land on the Tasks board in a staging-mode project
  const clientHome = !dev && stagingMode ? "tasks" : dev ? "files" : "overview";
  if (project.data) crumbs.push({ label: project.data.name, href: projectHref(org, pid, clientHome) });
  if (route.name === "intake") crumbs.push({ label: "Files", href: projectHref(org, pid, "files") }, { label: "Add files" });
  else if (route.name === "promotion") crumbs.push({ label: "Tasks", href: projectHref(org, pid, "tasks") }, { label: "Review" });
  else crumbs.push({ label: route.name === "proposal" ? (dev ? "Change" : "Review") : SECTION_LABEL[active] });

  // the Tasks board is the client's default tab in staging mode: the Overview the project opened on
  // (Home links clients there) turns into the board once the first poll says staging is on; later
  // visits to Overview stay there
  const entry = useRef<string | null>(null);
  const routeKey = route.name === "project" ? `${route.name}/${route.tab}` : route.name;
  if (entry.current === null) entry.current = routeKey;
  useEffect(() => {
    if (entry.current === "done" || !live.data) return;
    if (role === "client" && stagingMode && routeKey === "project/overview" && entry.current === routeKey) navigate(projectHref(org, pid, "tasks"), { replace: true });
    entry.current = "done";
  }, [live.data, role, stagingMode, routeKey, org, pid]);

  const showSent = sentOpen && !!staging?.enabled;
  const header = <AppHeader crumbs={crumbs} role={role} user={me?.user.email} onSignOut={onSignOut} inspector={dev ? { open: inspectorOpen && !showSent, onToggle: toggleInspector } : undefined} />;
  const decisions = decisionCount(live.data, role, project.data?.policy?.approvalRoles);
  const resetStaging = async () => {
    await api.resetStaging(org, pid);
    live.reload();
  };
  const stagingHeader = project.data && staging?.enabled ? <StagingHeader staging={staging} role={role} captures={live.data?.captures} onReset={resetStaging} onOpenSent={() => setSentOpen(!showSent)} sentOpen={showSent} publishHref={projectHref(org, pid, "versions")} /> : null;
  const drawerOpen = showSent || (dev && inspectorOpen);

  let content;
  if (project.error) content = <ErrorNote error={project.error} onRetry={project.reload} />;
  else if (!project.data) content = <Loading what="Opening project" />;
  else
    content = (
      <div className="project">
        {/* the client Overview's hero is the page heading and carries Start an update (UX-2); the
            developer Change storyboard's title is its heading, as in the mockup (UX-4) */}
        {(!dev && route.name === "project" && route.tab === "overview") || (dev && route.name === "proposal") || route.name === "promotion" ? null : (
          <header className="project-head">
            <h1>{project.data.name}</h1>
            <div className="project-actions">
              {/* staging-mode projects have no client editions: clients work in tasks (P42-2) */}
              {dev && !stagingMode && !native.data ? <EditionsButton /> : null}
              {dev ? <ExportPanel /> : null}
              {/* the client's action; developers do not start client edition sessions (review m-2) */}
              {role === "client" && !stagingMode ? <StartUpdateButton quiet /> : null}
            </div>
          </header>
        )}
        {live.error ? <ErrorNote error={live.error} onRetry={live.reload} /> : null}
        {route.name === "proposal" ? (
          <ProposalReview proposalId={route.proposalId} />
        ) : route.name === "promotion" ? (
          <PromotionRoute promotionId={route.promotionId} role={role} />
        ) : route.name === "intake" ? (
          <IntakeScreen intakeId={route.intakeId} />
        ) : route.name === "settings" ? (
          dev ? (
            <ProjectSettings section={route.section} />
          ) : (
            <ErrorNote error={new ApiError(404, "not_found", "This page does not exist or you do not have access.")} />
          )
        ) : route.tab === "knowledge" ? (
          <ProjectKnowledge />
        ) : route.tab === "outcomes" ? (
          <ProjectOutcomes />
        ) : route.tab === "review" ? (
          <NativeReview />
        ) : route.tab === "overview" ? (
          native.data ? <NativeOverview state={native.data} /> : <OverviewScreen />
        ) : route.tab === "tasks" ? (
          stagingMode ? (
            <TasksBoardScreen />
          ) : live.data ? (
            <ErrorNote error={new ApiError(404, "not_found", "This project has no staging, so it has no Tasks board.")} />
          ) : (
            <Loading what="Loading tasks" />
          )
        ) : route.tab === "files" ? (
          <FilesScreen mount={route.mount} path={route.path} edit={route.edit} isNew={route.new} />
        ) : route.tab === "changes" ? (
          <ChangesScreen />
        ) : route.tab === "activity" ? (
          <ActivityScreen />
        ) : (
          <VersionsScreen mount={route.mount} version={route.version} />
        )}
      </div>
    );

  const body = (
    <div className={`app-body ${drawerOpen ? "has-inspector" : ""}`.trim()}>
      <ProjectTabs org={org} pid={pid} active={active} decisions={decisions} showSettings={dev} showTasks={stagingMode} memberships={memberships} canCreateOrgs={me?.canCreateOrgs ?? false} />
      <main className="main">{content}</main>
      {staging?.enabled ? <SentFromStaging open={showSent} captures={live.data?.captures} onClose={() => setSentOpen(false)} /> : null}
      {!showSent && dev && project.data ? <InspectorDrawer open={inspectorOpen} onClose={() => toggleInspector()} sections={[...registry.flatMap((r) => r.sections), projectInspector(org, project.data, role)]} /> : null}
    </div>
  );

  // always the same root element, so the header and body do not remount once the project loads
  return (
    <ProjectContext.Provider value={project.data ? { org, pid, role, project: project.data, live: live.data, reloadLive: live.reload, reloadProject: project.reload, setInspector } : null}>
      <UploadsContext.Provider value={uploads}>
        {header}
        {stagingHeader}
        {body}
      </UploadsContext.Provider>
    </ProjectContext.Provider>
  );
}
