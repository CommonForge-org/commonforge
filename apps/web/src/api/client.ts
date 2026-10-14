/**
 * The web app's API client. `CommonForgeApi` is the surface the screens use; `HttpApi` speaks to
 * the Worker (same origin, cookie session), `FakeApi` (./fake.ts) backs tests and fixture mode.
 *
 * Browser rules from API.md: the session lives only in the HttpOnly `__Host-cf_session` cookie, so every
 * request is `credentials: "same-origin"`; every write is JSON with `content-type:
 * application/json` and goes to the same origin, so the CSRF guard sees a matching `Origin`.
 */
import type {
  AcceptResult,
  SessionView,
  AccessLevel,
  ApiErrorBody,
  DeployResources,
  ApprovalView,
  Capture,
  CreateTaskInput,
  EditableFile,
  EditionPolicyInput,
  EditionReturn,
  EditionSession,
  EditionView,
  EventPage,
  ExportStarted,
  ExportStatus,
  FileChange,
  FileChangeRequest,
  IntakeConfirmInput,
  IntakeConfirmResult,
  IntakeView,
  InviteResult,
  Me,
  PersonAccess,
  PolicyIssue,
  Project,
  ProjectFolder,
  ProjectPolicy,
  ProjectSnapshot,
  PreviewView,
  ProjectSummary,
  PromoteResult,
  PromotionPreview,
  PromotionState,
  PromotionView,
  Proposal,
  ProposalSummary,
  ReleaseList,
  ReleaseView,
  Resource,
  ResourceDetail,
  RestoreResult,
  Role,
  MemberView,
  StagingView,
  TaskSummary,
  TaskView,
  TreeListing,
  UploadStart,
  UrlIntakeInput,
  User,
  VersionEntry,
} from "./types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface FileQuery {
  mount: string;
  path: string;
  revision?: string;
}

export interface CommonForgeApi {
  // auth
  requestMagicLink(email: string): Promise<void>;
  verify(token: string): Promise<{ user: User; expiresAt: string }>;
  logout(): Promise<void>;
  /** a one-time `cforge login` code for the signed-in person (single use, 15 minutes) */
  cliCode(): Promise<{ code: string; expiresAt: string }>;
  /** the signed-in person's sessions (Account page) */
  listSessions(): Promise<SessionView[]>;
  /** end one of your sessions, or every one but this one; how many ended */
  revokeSessions(which: { sessionId: string } | { others: true }): Promise<number>;
  me(): Promise<Me>;
  // projects
  listProjects(org: string): Promise<ProjectSummary[]>;
  getProject(org: string, pid: string): Promise<Project>;
  getSnapshot(org: string, pid: string): Promise<ProjectSnapshot>;
  listTree(org: string, pid: string, q: FileQuery): Promise<TreeListing>;
  readFile(org: string, pid: string, q: FileQuery): Promise<Blob>;
  fileUrl(org: string, pid: string, q: FileQuery): string;
  // resources
  getResource(org: string, rid: string): Promise<ResourceDetail>;
  listVersions(org: string, rid: string): Promise<VersionEntry[]>;
  restore(org: string, rid: string, body: { expectedHead: string; targetRevision: string; idempotencyKey: string }): Promise<RestoreResult>;
  // tasks, proposals
  /** owners and developers: every task; clients (staging-mode projects): the tasks they created */
  listTasks(org: string, pid: string): Promise<TaskSummary[]>;
  /** owners, developers; clients in staging-mode projects (only folders the owner opened for writing) */
  createTask(org: string, pid: string, body: CreateTaskInput): Promise<TaskView>;
  /** a task the viewer can see (clients: the tasks they created, staging-mode projects) */
  getTask(taskId: string): Promise<TaskView>;
  /** owners and developers with write on what it changes; not in staging-mode projects (`409 staging_proposal`) */
  createProposal(org: string, taskId: string): Promise<Proposal>;
  listProposals(org: string, pid: string): Promise<ProposalSummary[]>;
  getProposal(org: string, id: string): Promise<Proposal>;
  integrate(org: string, id: string): Promise<{ proposalId: string; jobId: string; state: string }>;
  approve(org: string, id: string, proposalHash: string): Promise<ApprovalView>;
  accept(org: string, id: string, idempotencyKey: string): Promise<AcceptResult>;
  // previews and releases (Task 22)
  listPreviews(org: string, proposalId: string): Promise<PreviewView[]>;
  requestPreview(org: string, proposalId: string): Promise<PreviewView>;
  listReleases(org: string, pid: string): Promise<ReleaseList>;
  /** `acceptedVersionId`: publish exactly this version (409 `accepted_version_stale` if a newer one touches the release sources) */
  prepareRelease(org: string, pid: string, acceptedVersionId?: string): Promise<ReleaseView>;
  approvePublish(org: string, releaseId: string, outputDigest: string): Promise<{ approvalId: string }>;
  deployRelease(org: string, releaseId: string, idempotencyKey: string): Promise<{ releaseId: string; attempt: number; replayed: boolean }>;
  /** owner: production was checked by hand; the release stops blocking the project (review R-1) */
  recoverRelease(org: string, releaseId: string, note: string): Promise<ReleaseView>;
  // export, events
  startExport(org: string, pid: string): Promise<ExportStarted>;
  getExport(org: string, id: string): Promise<ExportStatus>;
  listEvents(org: string, q: { projectId?: string; after?: number; limit?: number }): Promise<EventPage>;
  validatePolicy(org: string, pid: string, policy: ProjectPolicy): Promise<{ ok: boolean; issues: PolicyIssue[] }>;
  putPolicy(org: string, pid: string, policy: ProjectPolicy, expectedRevision?: number): Promise<{ policyRevision: number; policy: ProjectPolicy }>;
  // client editions (Task 21)
  listEditions(org: string, pid: string): Promise<EditionView[]>;
  getEdition(org: string, eid: string): Promise<EditionView>;
  createEdition(org: string, pid: string, policy: EditionPolicyInput): Promise<EditionView>;
  updateEditionPolicy(org: string, eid: string, policy: EditionPolicyInput): Promise<EditionView>;
  buildEdition(org: string, eid: string): Promise<{ buildId: string; state: string }>;
  grantEdition(org: string, eid: string, userId: string): Promise<void>;
  listMembers(org: string): Promise<MemberView[]>;
  /** `GET …/deploy-resources` (owners and developers): the org's release Worker name prefix and its KV/D1 */
  getDeployResources(org: string): Promise<DeployResources>;
  createOrg(name: string): Promise<{ orgId: string; name: string; role: Role }>;
  inviteMember(org: string, body: { email: string; role: Role }): Promise<InviteResult>;
  getProjectAccess(org: string, pid: string): Promise<PersonAccess[]>;
  putProjectAccess(org: string, pid: string, body: { userId: string; level: AccessLevel; folders?: Record<string, AccessLevel> }): Promise<PersonAccess>;
  createProject(org: string, name: string): Promise<{ projectId: string; name: string }>;
  listResources(org: string): Promise<Resource[]>;
  listFolders(org: string, pid: string): Promise<ProjectFolder[]>;
  /** A new folder (a git folder; there is no kind to choose): `201` before its first version exists, listed as `settingUp` until then. */
  createFolder(org: string, pid: string, body: { name: string }): Promise<{ mountName: string; resourceId: string }>;
  /** Try a failed folder setup again (owners, developers with write on the folder): `409 setup_not_failed` unless it failed. */
  retryFolderSetup(org: string, pid: string, mount: string): Promise<{ state: "empty"; settingUp: true }>;
  attachFolder(org: string, pid: string, body: { mountName: string; resourceId: string }): Promise<void>;
  detachFolder(org: string, pid: string, mountName: string): Promise<{ changed: string[] }>;
  /** whether a folder may be changed in this project (owners); `changed`: clients whose Can change on it ended */
  setFolderWritable(org: string, pid: string, mountName: string, writable: boolean): Promise<{ changed: string[] }>;
  resendInvite(org: string, userId: string): Promise<void>;
  updateMemberRole(org: string, userId: string, role: Role): Promise<void>;
  removeMember(org: string, userId: string): Promise<void>;
  startUpdate(org: string, eid: string, body: { title: string; request?: string }): Promise<EditionSession>;
  listUpdates(org: string, eid: string): Promise<EditionSession[]>;
  getUpdate(org: string, sid: string): Promise<EditionSession>;
  sendBack(org: string, sid: string, zip: Blob, opts: { mode: "partial" | "full"; deletions?: string[] }): Promise<EditionReturn>;
  // intake ("Add files"): owners and developers
  startZipIntake(org: string, zip: Blob, filename: string): Promise<{ intakeId: string; state: string }>;
  startUrlIntake(org: string, body: UrlIntakeInput): Promise<{ intakeId: string; resourceId: string; state: string }>;
  getIntake(org: string, intakeId: string): Promise<IntakeView>;
  confirmIntake(org: string, intakeId: string, body: IntakeConfirmInput): Promise<IntakeConfirmResult>;
  // uploads and file changes (Folders): owners, and developers with write on the folder
  startUpload(org: string, pid: string, mount: string, body: { path: string; size: number; mime: string }): Promise<UploadStart>;
  /** One raw part; `onProgress` gets the bytes of this part sent so far; `signal` aborts it (an `AbortError`). */
  putUploadPart(org: string, uploadId: string, n: number, bytes: Blob, opts: { signal: AbortSignal; onProgress?: (sent: number) => void }): Promise<{ etag: string }>;
  completeUpload(org: string, uploadId: string, parts: Array<{ n: number; etag: string }>): Promise<{ stagingId: string; size: number }>;
  /** aborts an unfinished upload (callers treat it as best effort) */
  cancelUpload(org: string, uploadId: string): Promise<void>;
  createFileChange(org: string, pid: string, mount: string, body: FileChangeRequest): Promise<FileChange>;
  getFileChange(org: string, changeId: string): Promise<FileChange>;
  /** a project's open changes and its recent ones, newest first */
  listFileChanges(org: string, pid: string, q?: { mount?: string; limit?: number }): Promise<FileChange[]>;
  /** A small text file of a git folder, to edit in place: `409 not_editable` for LFS, binary, non-UTF-8 or >= 1 MiB files. */
  readFileForEdit(org: string, pid: string, q: FileQuery): Promise<EditableFile>;
  // staging (staging-mode projects; `enabled: false` otherwise)
  getStaging(org: string, pid: string): Promise<StagingView>;
  /** staging's D1/KV back to the demo data (owner, developer, client) */
  resetStaging(org: string, pid: string): Promise<{ buildId: string | null }>;
  /** what staging sent to the capture sink, newest first */
  listCaptures(org: string, pid: string): Promise<Capture[]>;
  /** take a task out of staging (its creator, owners, developers) */
  rollbackTask(taskId: string): Promise<{ buildId: string | null }>;
  // promotions
  /** owners/developers: all (developer view); clients: those with a landing they created (client view); newest first */
  listPromotions(org: string, pid: string, states?: PromotionState[]): Promise<PromotionView[]>;
  getPromotion(org: string, id: string): Promise<PromotionView>;
  /** the dry run: the tasks that would go to production together (nothing written) */
  previewPromotion(taskId: string): Promise<PromotionPreview>;
  promoteTask(taskId: string): Promise<PromoteResult>;
  approvePromotion(org: string, id: string): Promise<PromotionView>;
  /** `note` (1-2000 characters) is shown to the client verbatim */
  sendBackPromotion(org: string, id: string, note: string): Promise<PromotionView>;
  withdrawPromotion(org: string, id: string): Promise<PromotionView>;
  retryPromotionRelease(org: string, id: string): Promise<PromotionView>;
}

/** Edits stay under the LFS threshold (`COMMONFORGE_LFS_THRESHOLD_BYTES`, 1 MiB). */
export const EDIT_MAX_BYTES = 1_048_576;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const enc = encodeURIComponent;

function query(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

async function toError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    /* not JSON */
  }
  const e = body?.error;
  return new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? res.statusText ?? "request failed", e?.details);
}

function xhrError(x: XMLHttpRequest): ApiError {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = JSON.parse(x.responseText) as Partial<ApiErrorBody>;
  } catch {
    /* not JSON */
  }
  const e = body?.error;
  return new ApiError(x.status, e?.code ?? `http_${x.status}`, e?.message ?? (x.statusText || "request failed"), e?.details);
}

const abortError = () => new DOMException("the upload was canceled", "AbortError");

const notEditable = (why: string) => new ApiError(409, "not_editable", why);

/** The body's bytes, or null (the rest canceled) once it reaches `limit` bytes. */
async function readAtMost(res: Response, limit: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    return all.length >= limit ? null : all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total >= limit) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export interface HttpApiOptions {
  /** "" for same-origin (the default and the only supported browser setup) */
  base?: string;
  fetchImpl?: FetchLike;
  /** upload parts use XMLHttpRequest for its upload progress (P3-8); tests inject a fake */
  xhrFactory?: () => XMLHttpRequest;
  /** a part with no progress for this long is aborted as a retryable `stalled` error (default 60 s) */
  stallMs?: number;
}

export class HttpApi implements CommonForgeApi {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly xhrFactory: () => XMLHttpRequest;
  private readonly stallMs: number;

  /** `base` is "" for same-origin (the default and the only supported browser setup). */
  constructor(baseOrOptions: string | HttpApiOptions = "", fetchImpl?: FetchLike) {
    const o: HttpApiOptions = typeof baseOrOptions === "string" ? { base: baseOrOptions, fetchImpl } : baseOrOptions;
    this.base = o.base ?? "";
    this.fetchImpl = o.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.xhrFactory = o.xhrFactory ?? (() => new XMLHttpRequest());
    this.stallMs = o.stallMs ?? 60_000;
  }

  private async send(method: string, path: string, body?: unknown, extra: RequestInit = {}): Promise<Response> {
    const init: RequestInit = { ...extra, method, credentials: "same-origin", headers: { accept: "application/json" } };
    if (body !== undefined) {
      init.headers = { accept: "application/json", "content-type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.base}/api${path}`, init);
    if (!res.ok) throw await toError(res);
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    return (await res.json()) as T;
  }

  async requestMagicLink(email: string) {
    await this.send("POST", "/auth/magic-link", { email, client: "web" });
  }
  verify(token: string) {
    return this.json<{ user: User; expiresAt: string }>("POST", "/auth/verify", { token });
  }
  async logout() {
    await this.send("POST", "/auth/logout", {});
  }
  cliCode() {
    return this.json<{ code: string; expiresAt: string }>("POST", "/auth/cli/code", {});
  }
  async listSessions() {
    return (await this.json<{ sessions: SessionView[] }>("GET", "/auth/sessions")).sessions;
  }
  async revokeSessions(which: { sessionId: string } | { others: true }) {
    return (await this.json<{ ended: number }>("POST", "/auth/sessions/revoke", which)).ended;
  }
  me() {
    return this.json<Me>("GET", "/me");
  }

  async listProjects(org: string) {
    return (await this.json<{ projects: ProjectSummary[] }>("GET", `/orgs/${enc(org)}/projects`)).projects;
  }
  getProject(org: string, pid: string) {
    return this.json<Project>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}`);
  }
  getSnapshot(org: string, pid: string) {
    return this.json<ProjectSnapshot>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}/snapshot`);
  }
  listTree(org: string, pid: string, q: FileQuery) {
    return this.json<TreeListing>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}/tree${query({ mount: q.mount, path: q.path, revision: q.revision })}`);
  }
  fileUrl(org: string, pid: string, q: FileQuery) {
    return `${this.base}/api/orgs/${enc(org)}/projects/${enc(pid)}/file${query({ mount: q.mount, path: q.path, revision: q.revision })}`;
  }
  async readFile(org: string, pid: string, q: FileQuery) {
    const res = await this.fetchImpl(this.fileUrl(org, pid, q), { credentials: "same-origin" });
    if (!res.ok) throw await toError(res);
    return res.blob();
  }

  getResource(org: string, rid: string) {
    return this.json<ResourceDetail>("GET", `/orgs/${enc(org)}/resources/${enc(rid)}`);
  }
  async listVersions(org: string, rid: string) {
    return (await this.json<{ versions: VersionEntry[] }>("GET", `/orgs/${enc(org)}/resources/${enc(rid)}/versions`)).versions;
  }
  restore(org: string, rid: string, body: { expectedHead: string; targetRevision: string; idempotencyKey: string }) {
    return this.json<RestoreResult>("POST", `/orgs/${enc(org)}/resources/${enc(rid)}/restore`, body);
  }

  async listTasks(org: string, pid: string) {
    return (await this.json<{ tasks: TaskSummary[] }>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}/tasks`)).tasks;
  }
  createTask(org: string, pid: string, body: CreateTaskInput) {
    return this.json<TaskView>("POST", `/orgs/${enc(org)}/projects/${enc(pid)}/tasks`, body);
  }
  getTask(taskId: string) {
    return this.json<TaskView>("GET", `/tasks/${enc(taskId)}`);
  }
  createProposal(org: string, taskId: string) {
    return this.json<Proposal>("POST", `/orgs/${enc(org)}/proposals`, { taskId });
  }
  async listProposals(org: string, pid: string) {
    return (await this.json<{ proposals: ProposalSummary[] }>("GET", `/orgs/${enc(org)}/proposals${query({ projectId: pid })}`)).proposals;
  }
  getProposal(org: string, id: string) {
    return this.json<Proposal>("GET", `/orgs/${enc(org)}/proposals/${enc(id)}`);
  }
  integrate(org: string, id: string) {
    return this.json<{ proposalId: string; jobId: string; state: string }>("POST", `/orgs/${enc(org)}/proposals/${enc(id)}/integrate`, {});
  }
  approve(org: string, id: string, proposalHash: string) {
    return this.json<ApprovalView>("POST", `/orgs/${enc(org)}/proposals/${enc(id)}/approvals`, { proposalHash });
  }
  accept(org: string, id: string, idempotencyKey: string) {
    return this.json<AcceptResult>("POST", `/orgs/${enc(org)}/proposals/${enc(id)}/accept`, { idempotencyKey });
  }

  async listPreviews(org: string, proposalId: string) {
    return (await this.json<{ previews: PreviewView[] }>("GET", `/orgs/${enc(org)}/proposals/${enc(proposalId)}/previews`)).previews;
  }
  requestPreview(org: string, proposalId: string) {
    return this.json<PreviewView>("POST", `/orgs/${enc(org)}/proposals/${enc(proposalId)}/previews`, {});
  }
  listReleases(org: string, pid: string) {
    return this.json<ReleaseList>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}/releases`);
  }
  prepareRelease(org: string, pid: string, acceptedVersionId?: string) {
    return this.json<ReleaseView>("POST", `/orgs/${enc(org)}/projects/${enc(pid)}/releases`, acceptedVersionId ? { acceptedVersionId } : {});
  }
  approvePublish(org: string, releaseId: string, outputDigest: string) {
    return this.json<{ approvalId: string }>("POST", `/orgs/${enc(org)}/releases/${enc(releaseId)}/publish-approvals`, { outputDigest });
  }
  deployRelease(org: string, releaseId: string, idempotencyKey: string) {
    return this.json<{ releaseId: string; attempt: number; replayed: boolean }>("POST", `/orgs/${enc(org)}/releases/${enc(releaseId)}/deploy`, { idempotencyKey });
  }

  recoverRelease(org: string, releaseId: string, note: string) {
    return this.json<ReleaseView>("POST", `/orgs/${enc(org)}/releases/${enc(releaseId)}/recover`, { note });
  }

  startExport(org: string, pid: string) {
    return this.json<ExportStarted>("POST", `/orgs/${enc(org)}/projects/${enc(pid)}/exports`, {});
  }
  getExport(org: string, id: string) {
    return this.json<ExportStatus>("GET", `/orgs/${enc(org)}/exports/${enc(id)}`);
  }
  validatePolicy(org: string, pid: string, policy: ProjectPolicy) {
    return this.json<{ ok: boolean; issues: PolicyIssue[] }>("POST", `/orgs/${enc(org)}/projects/${enc(pid)}/policy/validate`, policy);
  }
  putPolicy(org: string, pid: string, policy: ProjectPolicy, expectedRevision?: number) {
    return this.json<{ policyRevision: number; policy: ProjectPolicy }>("PUT", `/orgs/${enc(org)}/projects/${enc(pid)}/policy`, { ...policy, ...(expectedRevision !== undefined ? { expectedRevision } : {}) });
  }
  async listEditions(org: string, pid: string) {
    return (await this.json<{ editions: EditionView[] }>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}/editions`)).editions;
  }
  getEdition(org: string, eid: string) {
    return this.json<EditionView>("GET", `/orgs/${enc(org)}/editions/${enc(eid)}`);
  }
  createEdition(org: string, pid: string, policy: EditionPolicyInput) {
    return this.json<EditionView>("POST", `/orgs/${enc(org)}/projects/${enc(pid)}/editions`, policy);
  }
  updateEditionPolicy(org: string, eid: string, policy: EditionPolicyInput) {
    return this.json<EditionView>("PUT", `/orgs/${enc(org)}/editions/${enc(eid)}/policy`, policy);
  }
  buildEdition(org: string, eid: string) {
    return this.json<{ buildId: string; state: string }>("POST", `/orgs/${enc(org)}/editions/${enc(eid)}/builds`, {});
  }
  async grantEdition(org: string, eid: string, userId: string) {
    await this.send("PUT", `/orgs/${enc(org)}/editions/${enc(eid)}/grants`, { userId });
  }
  async listMembers(org: string) {
    return (await this.json<{ members: MemberView[] }>("GET", `/orgs/${enc(org)}/members`)).members;
  }
  getDeployResources(org: string) {
    return this.json<DeployResources>("GET", `/orgs/${enc(org)}/deploy-resources`);
  }
  createOrg(name: string) {
    return this.json<{ orgId: string; name: string; role: Role }>("POST", "/orgs", { name });
  }
  inviteMember(org: string, body: { email: string; role: Role }) {
    return this.json<InviteResult>("POST", `/orgs/${enc(org)}/members`, body);
  }
  async getProjectAccess(org: string, pid: string) {
    return (await this.json<{ people: PersonAccess[] }>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}/access`)).people;
  }
  putProjectAccess(org: string, pid: string, body: { userId: string; level: AccessLevel; folders?: Record<string, AccessLevel> }) {
    return this.json<PersonAccess>("PUT", `/orgs/${enc(org)}/projects/${enc(pid)}/access`, body);
  }
  createProject(org: string, name: string) {
    return this.json<{ projectId: string; name: string }>("POST", `/orgs/${enc(org)}/projects`, { name });
  }
  async listResources(org: string) {
    return (await this.json<{ resources: Resource[] }>("GET", `/orgs/${enc(org)}/resources`)).resources;
  }
  async listFolders(org: string, pid: string) {
    return (await this.json<{ folders: ProjectFolder[] }>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}/folders`)).folders;
  }
  createFolder(org: string, pid: string, body: { name: string }) {
    return this.json<{ mountName: string; resourceId: string }>("POST", `/orgs/${enc(org)}/projects/${enc(pid)}/folders`, { name: body.name });
  }
  retryFolderSetup(org: string, pid: string, mount: string) {
    return this.json<{ state: "empty"; settingUp: true }>("POST", `/orgs/${enc(org)}/projects/${enc(pid)}/folders/${enc(mount)}/setup/retry`, {});
  }
  async attachFolder(org: string, pid: string, body: { mountName: string; resourceId: string }) {
    await this.send("POST", `/orgs/${enc(org)}/projects/${enc(pid)}/mounts`, body);
  }
  async detachFolder(org: string, pid: string, mountName: string) {
    const r = await this.json<{ ok: true; changed: string[] }>("DELETE", `/orgs/${enc(org)}/projects/${enc(pid)}/mounts/${enc(mountName)}`);
    return { changed: r.changed };
  }
  async setFolderWritable(org: string, pid: string, mountName: string, writable: boolean) {
    const r = await this.json<{ changed: string[] }>("PATCH", `/orgs/${enc(org)}/projects/${enc(pid)}/mounts/${enc(mountName)}`, { writable });
    return { changed: r.changed };
  }
  async resendInvite(org: string, userId: string) {
    await this.send("POST", `/orgs/${enc(org)}/members/${enc(userId)}/invite`, {});
  }
  async updateMemberRole(org: string, userId: string, role: Role) {
    await this.send("PATCH", `/orgs/${enc(org)}/members/${enc(userId)}`, { role });
  }
  async removeMember(org: string, userId: string) {
    await this.send("DELETE", `/orgs/${enc(org)}/members/${enc(userId)}`);
  }
  startUpdate(org: string, eid: string, body: { title: string; request?: string }) {
    return this.json<EditionSession>("POST", `/orgs/${enc(org)}/editions/${enc(eid)}/sessions`, body);
  }
  async listUpdates(org: string, eid: string) {
    return (await this.json<{ sessions: EditionSession[] }>("GET", `/orgs/${enc(org)}/editions/${enc(eid)}/sessions`)).sessions;
  }
  getUpdate(org: string, sid: string) {
    return this.json<EditionSession>("GET", `/orgs/${enc(org)}/edition-sessions/${enc(sid)}`);
  }
  /** The edited working copy as a raw ZIP body (the only non-JSON write; same origin, so CSRF-safe). */
  async sendBack(org: string, sid: string, zip: Blob, opts: { mode: "partial" | "full"; deletions?: string[] }) {
    const q = new URLSearchParams({ mode: opts.mode });
    for (const d of opts.deletions ?? []) q.append("delete", d);
    const res = await this.fetchImpl(`${this.base}/api/orgs/${enc(org)}/edition-sessions/${enc(sid)}/returns?${q}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/zip" },
      body: zip,
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as EditionReturn;
  }

  /** The archive as a raw ZIP body (same origin, so CSRF-safe; the browser sets content-length). */
  async startZipIntake(org: string, zip: Blob, filename: string) {
    const res = await this.fetchImpl(`${this.base}/api/orgs/${enc(org)}/intake/zip${query({ name: filename })}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/zip" },
      body: zip,
    });
    if (!res.ok) throw await toError(res);
    return (await res.json()) as { intakeId: string; state: string };
  }
  startUrlIntake(org: string, body: UrlIntakeInput) {
    return this.json<{ intakeId: string; resourceId: string; state: string }>("POST", `/orgs/${enc(org)}/intake/url`, body);
  }
  getIntake(org: string, intakeId: string) {
    return this.json<IntakeView>("GET", `/orgs/${enc(org)}/intake/${enc(intakeId)}`);
  }
  confirmIntake(org: string, intakeId: string, body: IntakeConfirmInput) {
    return this.json<IntakeConfirmResult>("POST", `/orgs/${enc(org)}/intake/${enc(intakeId)}/confirm`, body);
  }

  startUpload(org: string, pid: string, mount: string, body: { path: string; size: number; mime: string }) {
    return this.json<UploadStart>("POST", `/orgs/${enc(org)}/projects/${enc(pid)}/folders/${enc(mount)}/uploads`, body);
  }
  /** The raw part over XMLHttpRequest (same origin, with the cookie; the browser sets content-length). */
  putUploadPart(org: string, uploadId: string, n: number, bytes: Blob, opts: { signal: AbortSignal; onProgress?: (sent: number) => void }) {
    return new Promise<{ etag: string }>((resolve, reject) => {
      if (opts.signal.aborted) return reject(abortError());
      const x = this.xhrFactory();
      const onAbort = () => x.abort();
      // the stall watch: no progress for `stallMs` aborts the request as a retryable failure
      let stalled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watch = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          stalled = true;
          x.abort();
        }, this.stallMs);
      };
      const settle = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        opts.signal.removeEventListener("abort", onAbort);
      };
      x.open("PUT", `${this.base}/api/orgs/${enc(org)}/uploads/${enc(uploadId)}/parts/${n}`);
      x.withCredentials = true;
      x.setRequestHeader("accept", "application/json");
      x.setRequestHeader("content-type", "application/octet-stream");
      const report = opts.onProgress;
      x.upload.onprogress = (e) => {
        watch();
        report?.(e.loaded);
      };
      x.onload = () => {
        settle();
        if (x.status < 200 || x.status >= 300) return reject(xhrError(x));
        try {
          resolve(JSON.parse(x.responseText) as { etag: string });
        } catch {
          reject(new ApiError(x.status, "invalid_response", "the server's answer was not JSON"));
        }
      };
      x.onerror = () => {
        settle();
        reject(new ApiError(0, "network_error", "the connection failed while sending the file"));
      };
      x.onabort = () => {
        settle();
        reject(stalled ? new ApiError(0, "stalled", "the connection stalled while sending the file") : abortError());
      };
      opts.signal.addEventListener("abort", onAbort);
      watch();
      x.send(bytes);
    });
  }
  completeUpload(org: string, uploadId: string, parts: Array<{ n: number; etag: string }>) {
    return this.json<{ stagingId: string; size: number }>("POST", `/orgs/${enc(org)}/uploads/${enc(uploadId)}/complete`, { parts });
  }
  /** `keepalive`: sent on leaving the page too (pagehide), so the upload is freed rather than left to expire */
  async cancelUpload(org: string, uploadId: string) {
    await this.send("DELETE", `/orgs/${enc(org)}/uploads/${enc(uploadId)}`, undefined, { keepalive: true });
  }
  createFileChange(org: string, pid: string, mount: string, body: FileChangeRequest) {
    return this.json<FileChange>("POST", `/orgs/${enc(org)}/projects/${enc(pid)}/folders/${enc(mount)}/changes`, body);
  }
  getFileChange(org: string, changeId: string) {
    return this.json<FileChange>("GET", `/orgs/${enc(org)}/file-changes/${enc(changeId)}`);
  }
  async listFileChanges(org: string, pid: string, q: { mount?: string; limit?: number } = {}) {
    return (await this.json<{ changes: FileChange[] }>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}/file-changes${query({ mount: q.mount, limit: q.limit })}`)).changes;
  }
  async readFileForEdit(org: string, pid: string, q: FileQuery): Promise<EditableFile> {
    const res = await this.fetchImpl(this.fileUrl(org, pid, q), { credentials: "same-origin" });
    if (!res.ok) throw await toError(res);
    // every refusal before the body is read cancels it: an LFS file may be gigabytes
    const refuse = (why: string) => {
      void res.body?.cancel().catch(() => undefined);
      return notEditable(why);
    };
    const tooLarge = "files of 1 MiB or more cannot be edited in place";
    if (res.headers.get("x-commonforge-lfs")) throw refuse("this file is stored in LFS; replace it with an upload instead");
    const baseBlob = res.headers.get("x-commonforge-blob");
    if (!baseBlob) throw refuse("only files of git folders can be edited in place");
    const length = Number(res.headers.get("content-length") ?? NaN);
    if (length >= EDIT_MAX_BYTES) throw refuse(tooLarge);
    const bytes = await readAtMost(res, EDIT_MAX_BYTES);
    if (!bytes) throw notEditable(tooLarge);
    if (bytes.includes(0)) throw notEditable("this file is not text");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw notEditable("this file is not UTF-8 text");
    }
    return { text, baseBlob, revisionId: res.headers.get("x-commonforge-revision") ?? "", size: bytes.length };
  }

  getStaging(org: string, pid: string) {
    return this.json<StagingView>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}/staging`);
  }
  resetStaging(org: string, pid: string) {
    return this.json<{ buildId: string | null }>("POST", `/orgs/${enc(org)}/projects/${enc(pid)}/staging/reset`, {});
  }
  async listCaptures(org: string, pid: string) {
    return (await this.json<{ captures: Capture[] }>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}/staging/sent`)).captures;
  }
  rollbackTask(taskId: string) {
    return this.json<{ buildId: string | null }>("POST", `/tasks/${enc(taskId)}/rollback`, {});
  }
  async listPromotions(org: string, pid: string, states?: PromotionState[]) {
    return (await this.json<{ promotions: PromotionView[] }>("GET", `/orgs/${enc(org)}/projects/${enc(pid)}/promotions${query({ state: states?.join(",") })}`)).promotions;
  }
  getPromotion(org: string, id: string) {
    return this.json<PromotionView>("GET", `/orgs/${enc(org)}/promotions/${enc(id)}`);
  }
  previewPromotion(taskId: string) {
    return this.json<PromotionPreview>("GET", `/tasks/${enc(taskId)}/promote`);
  }
  promoteTask(taskId: string) {
    return this.json<PromoteResult>("POST", `/tasks/${enc(taskId)}/promote`, {});
  }
  approvePromotion(org: string, id: string) {
    return this.json<PromotionView>("POST", `/orgs/${enc(org)}/promotions/${enc(id)}/approve`, {});
  }
  sendBackPromotion(org: string, id: string, note: string) {
    return this.json<PromotionView>("POST", `/orgs/${enc(org)}/promotions/${enc(id)}/send-back`, { note });
  }
  withdrawPromotion(org: string, id: string) {
    return this.json<PromotionView>("POST", `/orgs/${enc(org)}/promotions/${enc(id)}/withdraw`, {});
  }
  retryPromotionRelease(org: string, id: string) {
    return this.json<PromotionView>("POST", `/orgs/${enc(org)}/promotions/${enc(id)}/retry-release`, {});
  }

  listEvents(org: string, q: { projectId?: string; after?: number; limit?: number }) {
    return this.json<EventPage>("GET", `/orgs/${enc(org)}/events${query({ projectId: q.projectId, after: q.after, limit: q.limit })}`);
  }
}
