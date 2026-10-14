/**
 * "Getting started" (usability push): the steps from a new organization to the first client task
 * live, each read from real API state (no client-side progress flags). Pure, for tests; the
 * screens in `screens/GettingStarted.tsx` load the data and render it.
 *
 * Each step's prerequisites, as the Worker enforces them:
 * - code: a git folder with a first version (`GET …/folders` `state: "active"`). A ZIP intake
 *   creates its folders empty (`pendingPopulation`), so only a Git import brings code in.
 * - release target: `policy.release` (`409 release_not_configured` without it); Worker names
 *   `<prefix>-<org>-<name>`; production KV/D1 come only from `POST …/deploy-resources` (API only).
 * - first publish: prepare → publish approval (`publishRoles`, owner by default) → deploy, which
 *   needs the deployment's deploy account and token (`503 config_missing` otherwise).
 * - staging: a `staging` and a `release` section; it waits (`awaiting_baseline`) until the owner's
 *   first production publish (API.md "Baseline").
 */
import type { PersonAccess, Project, ProjectFolder, PromotionView, ProposalSummary, ReleaseList, StagingView, TaskSummary } from "../api/types.js";
import { intakeHref, membersHref, projectHref, settingsHref } from "./router.js";

/** Where the longer explanations live (API.md in the repository). */
export const DOCS_URL = "https://github.com/CommonForge-org/commonforge/blob/main/apps/worker/API.md";
export const RELEASE_DOCS_URL = `${DOCS_URL}#releases-task-22`;

export type StepId = "org" | "project" | "code" | "release" | "publish" | "staging" | "client" | "clientAccess" | "task" | "live";

export interface ChecklistStep {
  id: StepId;
  title: string;
  /** one line: why this step matters */
  why: string;
  done: boolean;
  /** the screen that does it (absent: nothing to open, e.g. done by definition or not reachable yet) */
  href?: string;
  action?: string;
  /** a limit or prerequisite, said plainly */
  note?: string;
  /** a link to the docs for what the app cannot do yet */
  docs?: { label: string; href: string };
  /** not needed to finish (the checklist is complete without it) */
  optional?: boolean;
}

export interface ProjectChecklistInput {
  org: string;
  pid: string;
  project: Pick<Project, "mounts" | "policy">;
  /** `GET …/folders` (owners and developers); undefined while loading or unreadable */
  folders?: ProjectFolder[] | undefined;
  /** `GET …/access`; undefined while loading or unreadable */
  access?: PersonAccess[] | undefined;
  releases?: ReleaseList | undefined;
  staging?: StagingView | undefined;
  tasks: readonly TaskSummary[];
  promotions?: readonly PromotionView[] | undefined;
  proposals: readonly ProposalSummary[];
}

/** A folder with its first version in a git folder: code agents and releases can work from. */
function hasCode(i: Pick<ProjectChecklistInput, "folders" | "project">): boolean {
  if (i.folders) return i.folders.some((f) => f.provider === "artifacts" && f.state === "active");
  return i.project.mounts.some((m) => m.provider === "artifacts");
}

/**
 * Something a task changed is live in production: a promotion went live (staging mode), or an
 * accepted proposal of a task's Change was followed by a live production release. Proposals with
 * no task (an edition sent back, a file change) do not count.
 */
function firstTaskLive(i: ProjectChecklistInput): boolean {
  if (i.promotions?.some((p) => p.state === "live")) return true;
  const since = i.releases?.live?.since;
  if (!since) return false;
  const taskChanges = new Set(i.tasks.map((t) => t.changeId));
  return i.proposals.some((p) => p.state === "accepted" && !p.kind && taskChanges.has(p.changeId) && p.updatedAt <= since);
}

const ORG_STEP: ChecklistStep = { id: "org", title: "Create the organization", why: "One organization per client: its people, projects and releases stay together.", done: true };

/** The steps for one project, in order. */
export function projectChecklist(i: ProjectChecklistInput): ChecklistStep[] {
  const policy = i.project.policy;
  const stagingOn = !!i.staging?.enabled;
  const release = policy?.release !== undefined || (i.releases?.releases.length ?? 0) > 0;
  const published = !!i.releases?.live || (i.staging?.enabled === true && i.staging.baseline !== null);
  const clientMembers = (i.access ?? []).filter((p) => p.role === "client");
  const client = clientMembers.some((p) => p.level !== "none");
  const canChange = clientMembers.some((p) => p.level === "write" || p.folders.some((f) => f.level === "write"));
  const zipFolders = (i.folders ?? []).filter((f) => f.provider === "artifacts" && f.state === "empty" && !f.settingUp);
  const code = hasCode(i);
  const policyHref = settingsHref(i.org, i.pid, "policy");
  const taskHref = stagingOn ? projectHref(i.org, i.pid, "tasks") : projectHref(i.org, i.pid, "changes");
  return [
    ORG_STEP,
    { id: "project", title: "Create a project", why: "A project is one client site: its folders, people and releases.", done: true },
    {
      id: "code",
      title: "Bring in your code",
      why: "Import the site's Git repository. Agents, staging and releases all work from it.",
      done: code,
      href: intakeHref(i.org, i.pid),
      action: "Import from Git",
      note: zipFolders.length
        ? `${zipFolders.map((f) => f.mountName).join(", ")} ${zipFolders.length === 1 ? "is" : "are"} still empty: a ZIP creates its folders empty for now. Import the code from Git instead.`
        : "Public Git repositories only. A ZIP creates its folders empty for now.",
    },
    {
      id: "release",
      title: "Set up a release target",
      why: "Tells CommonForge how to build the site and which Cloudflare Worker production runs on.",
      done: release,
      href: policyHref,
      action: "Open Policy",
      note: "Fill in the Release section (Show example). Production KV and D1 databases are created through the API only, not in the app yet.",
      docs: { label: "Release docs", href: RELEASE_DOCS_URL },
    },
    {
      id: "publish",
      title: "Publish to production once",
      why: "Staging starts from what production runs, so the first publish comes before staging.",
      done: published,
      href: projectHref(i.org, i.pid, "versions"),
      action: "Open Versions",
      note: release ? "Publish the current version: prepare, approve publishing, then publish. Publishing needs the deployment's deploy token, set up by whoever runs CommonForge." : "Needs the release target first.",
    },
    {
      id: "staging",
      title: "Turn on staging",
      why: "Clients then ask for changes as tasks, and each one lands on a shared staging site before production.",
      done: stagingOn,
      href: policyHref,
      action: "Open Policy",
      note: stagingOn && !published ? "Staging is on. It starts after your first production publish." : "Add a Staging section next to Release. Without staging, clients edit an edition copy and send it back.",
      optional: true,
    },
    {
      id: "client",
      title: "Invite your client",
      why: "They sign in with an emailed link and see only the projects you give them.",
      done: client,
      ...(clientMembers.length && !client
        ? { href: settingsHref(i.org, i.pid, "access"), action: "Open Access", note: `${clientMembers.map((p) => p.email).join(", ")} can't see this project yet: give access here.` }
        : { href: membersHref(i.org), action: "Open Members", note: "Invite them as Client and tick this project." }),
    },
    {
      id: "clientAccess",
      title: "Choose what your client can change",
      why: "Per folder: Can change (their agent changes it, and the change goes to staging for review), Read only, or No access. A client never chooses this.",
      done: canChange,
      ...(client ? { href: settingsHref(i.org, i.pid, "access"), action: "Open Access" } : {}),
      note: !client ? "Invite your client first." : stagingOn ? "A new client can read only, until you choose." : "It takes effect once staging is on: without staging, clients send changes back from an edition copy.",
      optional: !stagingOn,
    },
    {
      id: "task",
      title: "Create the first task",
      why: stagingOn ? "Your client (or you) describes a change on the Tasks board, and an agent works on it." : "A task is a change for an agent to work on. Clients send changes back from an edition copy.",
      done: i.tasks.length > 0,
      href: taskHref,
      action: stagingOn ? "Open Tasks" : "Open Changes",
      note: stagingOn ? "New task, then Give to agent: it shows the cforge commands and a prompt for your coding agent." : "New task on Changes, then Give to agent: it shows the cforge commands and a prompt for your coding agent.",
    },
    {
      id: "live",
      title: "Get the first task live",
      why: stagingOn ? "Review it on staging, then promote it: production gets it once it is approved and published." : "Review the change, accept it, then publish it to production.",
      done: firstTaskLive(i),
      href: taskHref,
      action: stagingOn ? "Open Tasks" : "Open Changes",
    },
  ];
}

/** An organization with no projects yet: the organization is done, the project is next, the rest follows in the project. */
export function orgChecklist(): ChecklistStep[] {
  const later = "Opens once the project exists.";
  return [
    ORG_STEP,
    { id: "project", title: "Create a project", why: "A project is one client site: its folders, people and releases.", done: false, action: "New project" },
    { id: "code", title: "Bring in your code", why: "Import the site's Git repository. Agents, staging and releases all work from it.", done: false, note: later },
    { id: "release", title: "Set up a release target and publish once", why: "Production comes first: staging starts after the first production publish.", done: false, note: later },
    { id: "client", title: "Invite your client", why: "They sign in with an emailed link and see only the projects you give them.", done: false, note: later },
    { id: "task", title: "Get the first client task live", why: "The client asks for a change, an agent works on it, you review it and publish it.", done: false, note: later },
  ];
}

/** Every required step is done (optional ones may stay open). */
export function checklistComplete(steps: readonly ChecklistStep[]): boolean {
  return steps.every((s) => s.done || s.optional);
}

// ------------------------------------------------------------------------------ dismissal

const DISMISS_PREFIX = "cf-getting-started-dismissed:";

/** Dismissed for this project in this browser (a per-viewer convenience; storage may be unavailable). */
export function readDismissed(org: string, pid: string): boolean {
  try {
    return globalThis.localStorage?.getItem(`${DISMISS_PREFIX}${org}/${pid}`) === "1";
  } catch {
    return false;
  }
}

export function writeDismissed(org: string, pid: string, dismissed: boolean): void {
  try {
    if (dismissed) globalThis.localStorage?.setItem(`${DISMISS_PREFIX}${org}/${pid}`, "1");
    else globalThis.localStorage?.removeItem(`${DISMISS_PREFIX}${org}/${pid}`);
  } catch {
    // a per-viewer convenience only
  }
}
