/**
 * Data the client flow (UX-2) reads besides the live proposal state: one numbered project history
 * across resources, what is live (the release service), and the client's own edition updates.
 * Every source is optional: a read the caller may not make (a resource without a grant, releases
 * without read on every source) leaves that part empty instead of failing the screen.
 */
import type { CommonForgeApi } from "../api/client.js";
import type { EditionReturn, EditionSession, EditionView, Project, ReleaseList, VersionEntry } from "../api/types.js";
import { useApp, useLoad } from "../lib/hooks.js";
import { projectVersions, type ProjectVersion } from "../lib/client-flow.js";
import { useProject } from "./project-data.js";

export interface ProjectHistory {
  versions: ProjectVersion[];
  perResource: Array<{ resourceId: string; name: string; versions: VersionEntry[] }>;
  /** undefined: the release service is not readable for this viewer */
  releases: ReleaseList | undefined;
}

export async function loadHistory(api: CommonForgeApi, org: string, pid: string, project: Project): Promise<ProjectHistory> {
  const [perResource, releases] = await Promise.all([
    Promise.all(project.mounts.map(async (m) => ({ resourceId: m.resourceId, name: m.resourceName, versions: await api.listVersions(org, m.resourceId).catch(() => [] as VersionEntry[]) }))),
    api.listReleases(org, pid).catch(() => undefined),
  ]);
  return { versions: projectVersions(perResource), perResource, releases };
}

/** `enabled: false` makes no requests (e.g. developer review pages, which know their version already). */
export function useProjectHistory(key = "", pollMs?: number, enabled = true) {
  const { api } = useApp();
  const { org, pid, project } = useProject();
  return useLoad(() => (enabled ? loadHistory(api, org, pid, project) : Promise.resolve(undefined)), `${org}/${pid}/history/${key}/${enabled ? "on" : "off"}`, enabled ? pollMs : undefined);
}

export interface ClientUpdates {
  editions: EditionView[];
  sessions: EditionSession[];
  /** proposal id → the session and return that opened it */
  byProposal: Map<string, { session: EditionSession; ret: EditionReturn }>;
}

export async function loadClientUpdates(api: CommonForgeApi, org: string, pid: string): Promise<ClientUpdates> {
  const editions = await api.listEditions(org, pid).catch(() => [] as EditionView[]);
  const sessions = (await Promise.all(editions.map((e) => api.listUpdates(org, e.editionId).catch(() => [] as EditionSession[])))).flat();
  const byProposal = new Map<string, { session: EditionSession; ret: EditionReturn }>();
  for (const s of sessions) for (const r of s.returns) if (r.proposalId) byProposal.set(r.proposalId, { session: s, ret: r });
  return { editions, sessions, byProposal };
}

export function useClientUpdates(pollMs?: number) {
  const { api } = useApp();
  const { org, pid } = useProject();
  return useLoad(() => loadClientUpdates(api, org, pid), `${org}/${pid}/client-updates`, pollMs);
}
