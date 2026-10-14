/**
 * Wire types of the CommonForge Worker API, written by hand from `apps/worker/API.md`.
 * Record shapes that the Worker returns verbatim reuse the `@commonforge-org/core` types.
 */
import type {
  AssetManifestChange as CoreAssetManifestChange,
  MergeOutcome as CoreMergeOutcome,
  ProjectSnapshot as CoreProjectSnapshot,
  ResourceChange as CoreResourceChange,
} from "@commonforge-org/core";

/*
 * JSON on the wire carries plain strings, so these mirror core's records without its id brands.
 * The `Assignable` checks below fail to compile if core's shapes drift away from them.
 */
export interface ResourceChange {
  resourceId: string;
  baseRevision: string;
  candidateId: string;
  candidateRevision: string;
}

export interface AssetManifestChange {
  resourceId: string;
  baseManifestId: string | null;
  newManifestId: string;
}

export interface MergeOutcome {
  resourceId: string;
  result: "clean" | "textual-conflict" | "stale-base" | "asset-conflict";
  conflictPaths?: string[];
}

export interface SnapshotEntry {
  resourceId: string;
  revisionId: string;
  mode: "pinned-reference" | "must-match-accepted";
  mountName: string;
  operations: Array<"read" | "write">;
}

export interface ProjectSnapshot {
  snapshotId: string;
  projectId: string;
  organizationId: string;
  membershipRevision: number;
  policyRevision: number;
  entries: SnapshotEntry[];
  createdAt: string;
}

type Assignable<To, From extends To> = From;
export type _CoreCompat = [
  Assignable<ResourceChange, CoreResourceChange>,
  Assignable<AssetManifestChange, CoreAssetManifestChange>,
  Assignable<MergeOutcome, CoreMergeOutcome>,
  Assignable<ProjectSnapshot, CoreProjectSnapshot>,
];

export type Role = "owner" | "developer" | "client" | "viewer";
export type Provider = "artifacts" | "r2-assets";
export type Operation = "read" | "write";

/** `{ error: { code, message, details? } }` on every non-2xx answer. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

// ---------------------------------------------------------------------------------- auth / orgs

export interface User {
  userId: string;
  email: string;
}

export interface Membership {
  orgId: string;
  name: string;
  role: Role;
}

export interface Me {
  user: User;
  memberships: Membership[];
  /** instance admin: may create organizations (COMMONFORGE_ADMIN_EMAILS) */
  canCreateOrgs: boolean;
}

// ---------------------------------------------------------------------- projects and resources

export interface ProjectSummary {
  projectId: string;
  name: string;
  createdAt: string;
}

export interface Mount {
  mountName: string;
  resourceId: string;
  provider: Provider;
  resourceName: string;
  mode: "pinned-reference" | "must-match-accepted";
  operations: Operation[];
  /** the viewer may upload and change files here (owners; developers with write); absent from older servers: false */
  canWrite?: boolean;
  /**
   * the viewer may start a task that writes here (the New task form; Worker `writeMountIssue`):
   * owners and developers with write on a folder opened for writing, clients in a staging-mode
   * project for git folders opened for writing; absent from older servers: false
   */
  canStartTask?: boolean;
}

export interface Project {
  projectId: string;
  name: string;
  membershipRevision: number;
  policyRevision: number;
  mounts: Mount[];
  /** developers and owners only */
  policy?: ProjectPolicy;
  /** developers and owners only; absent until the policy has been changed */
  policyChanged?: { at: string; by: string | null };
}

export interface CheckSpec {
  checkId: string;
  mountName: string;
  command: string;
  timeoutSeconds?: number;
  required?: boolean;
  /** staging alone-first (B8): this required check builds or tests its mount's code */
  gatesAlone?: boolean;
}

export interface ProjectPolicy {
  checks: CheckSpec[];
  contracts: unknown[];
  rules: string[];
  approvalRoles?: Role[];
  publishRoles?: Array<"owner" | "developer" | "client">;
  preview?: unknown;
  release?: unknown;
  staging?: unknown;
}

export interface PolicyIssue {
  path: string;
  message: string;
}

export interface TreeEntry {
  path: string;
  type: "file" | "dir" | "symlink" | "submodule" | string;
  size?: number;
  /** a git folder's file stored in LFS: `size` is the real object's; never edited in place */
  lfs?: boolean;
}

export interface TreeListing {
  mountName: string;
  resourceId: string;
  provider: Provider;
  revisionId: string;
  path: string;
  entries: TreeEntry[];
}

export interface AcceptedHeadView {
  resourceId: string;
  revisionId: string;
  versionSeq: number;
  acceptedVersionId: string | null;
  acceptedAt: string;
  reconciliation: string;
}

export interface Resource {
  resourceId: string;
  name: string;
  provider: Provider;
  state: "empty" | "importing" | "active" | "failed";
  branch: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** owners and developers only */
  coords?: Record<string, unknown>;
  /** owners and developers only */
  source?: unknown;
}

export interface ResourceDetail extends Resource {
  head: AcceptedHeadView | null;
  operations: Operation[];
}

export interface VersionEntry {
  acceptedVersionId: string;
  sequence: number;
  /** `bind`: the genesis bind of an imported resource (ledger DO migration 3) */
  kind: "accept" | "restore" | "bind";
  proposalId: string | null;
  proposalHash: string | null;
  acceptedAt: string;
  head: { resourceId: string; revisionId: string } | undefined;
  /** developers only */
  actor?: { kind: string; id: string };
}

// ---------------------------------------------------------------- uploads, file changes (Folders)

/** `staged`: in a staging-mode project, on staging until its task is promoted (then `added`). */
export type FileChangeState = "applying" | "checking" | "waiting_approval" | "staged" | "added" | "failed";

/** One operation of a file change (API.md "File changes"); paths are relative to the folder. */
export type FileChangeOp = { put: string; stagingId: string } | { edit: string; content: string; baseBlob: string } | { delete: string } | { move: string; to: string };
/**
 * The body of POST …/folders/:mount/changes. `idempotencyKey` (1 to 128 of [A-Za-z0-9_-]): one per
 * change meant, the same on every retry of it; a repeat answers the change it made.
 */
export interface FileChangeRequest {
  ops: FileChangeOp[];
  title?: string;
  idempotencyKey?: string;
}

export interface FileChange {
  changeId: string;
  projectId: string;
  mountName: string;
  title: string;
  state: FileChangeState;
  attempt: number;
  proposalId: string | null;
  /** the change's task once it was applied (staging-mode projects: the task to promote from staging) */
  taskId?: string | null;
  /** `failed` only */
  error?: { code: string; message: string };
  /** `added` without a proposal: the operations changed nothing */
  note?: "no_changes";
  /** once applied */
  changedPaths?: Array<{ path: string; change: string; lfs: boolean; class: "code" | "content" }>;
  createdAt: string;
  updatedAt: string;
}

/** `POST …/folders/:mount/uploads`: every part but the last is exactly `partSize` bytes. */
export interface UploadStart {
  uploadId: string;
  partSize: number;
  parts: number;
  expiresAt: string;
}

/** A small text file opened for editing; `baseBlob` is its git blob id, sent back with the edit. */
export interface EditableFile {
  text: string;
  baseBlob: string;
  revisionId: string;
  size: number;
}

// --------------------------------------------------------------------------------------- tasks

export type TaskState = "provisioning" | "ready" | "running" | "submitted" | "failed" | "canceled";

export interface TaskSummary {
  taskId: string;
  title: string;
  state: TaskState;
  changeId: string;
  createdAt: string;
  /** the last lease taken or released, or state change (a push does not move it); older servers leave it out */
  updatedAt?: string;
  /** the current lease's expiry; null with no lease (never checked out, or released); older servers leave it out */
  leaseExpiresAt?: string | null;
}

/** `POST …/projects/:pid/tasks` body (Worker `routes/tasks.ts`): title 1-200 (trimmed), request at most 16,000, 1-16 write folders. */
export interface CreateTaskInput {
  title: string;
  request?: string;
  /** the folders the agent may change (default: every folder the creator may start a task in) */
  writeMounts?: string[];
  /** read-only folders in the workspace (default: every other folder the creator can read) */
  readMounts?: string[];
}

export interface TaskWorkspaceView {
  taskWorkspaceId: string;
  mountName: string;
  resourceId: string;
  provider: Provider;
  access: "read" | "write";
  baseRevision: string;
  state: "provisioning" | "writable" | "freezing" | "frozen" | "failed" | "abandoned" | "collected";
  assetManifestId?: string;
  /** owners and developers: the raw error; clients: `workspace_failed` */
  error?: string;
}

/** A task as `POST …/tasks`, `POST /tasks/:id/revise` and `GET /tasks/:id` return it (Worker `presentTask`). */
export interface TaskView {
  taskId: string;
  orgId: string;
  projectId: string;
  changeId: string;
  title: string;
  request: string;
  state: TaskState;
  snapshot: unknown;
  lease: { generation: number; expiresAt: string; holder: string | null } | null;
  workspaces: TaskWorkspaceView[];
  revisesTaskId?: string;
  createdAt: string;
  updatedAt: string;
}

// ------------------------------------------------------------------------ staging (phase 1-3)

/** Worker `services/staging.ts` `LandingState`. */
export type LandingState = "checking" | "landed" | "failed" | "rolling_back" | "rolled_back" | "promoting" | "promoted";

/** One landing of `GET …/staging` (Worker `stagingView`). */
export interface StagingLanding {
  landingId: string;
  taskId: string;
  title: string;
  state: LandingState;
  /** only for the landing's creator, owners and developers (else null); platform text */
  reasonCode: string | null;
  reason: string | null;
  /** owners and developers only: raw text */
  detail?: string | null;
  /** the landing's newest promotion */
  promotion: { promotionId: string; state: PromotionState } | null;
  /** for those who see the landing's reasons: the task and its revisions */
  parts?: Array<{ part: number; taskId: string }>;
  /** owners and developers only: the landings this one travels with (B9) */
  travelsWith?: string[];
  createdBy: string;
  createdAt: string;
}

/** `GET /api/orgs/:org/projects/:pid/staging` (Worker `stagingView`): `enabled: false` carries nothing else. */
export type StagingView =
  | { enabled: false; url: null; current: null; building: false; landings: [] }
  | {
      enabled: true;
      state: "active" | "awaiting_baseline";
      /** `awaiting_baseline` only: "Waiting for the owner's first production publish." */
      stateText: string | null;
      /** `releaseId` for owners and developers */
      baseline: { releaseId?: string; since: string } | null;
      url: string | null;
      current: { buildId: string; since: string } | null;
      building: boolean;
      /** newest 100 first */
      landings: StagingLanding[];
    };

/** One request staging sent to the capture sink (`GET …/staging/sent`, Worker `services/sink.ts`); credential headers are never stored. */
export interface Capture {
  captureId: string;
  receivedAt: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  /** the body was clipped at 16 KiB */
  truncated: boolean;
}

// ------------------------------------------------------------------------------- promotions

/** Worker `services/promotions.ts` `PromotionState`. */
export type PromotionState = "requested" | "building" | "gating" | "pending_approval" | "cleared" | "accepting" | "releasing" | "live" | "failed" | "release_failed" | "sent_back" | "superseded" | "withdrawn";
export type PromotionLevel = "self" | "classify" | "developer";
export type PromotionMode = "alone" | "closure";
export type ClearanceKind = "self" | "classifier" | "developer";
/**
 * Worker `promotion-gate.ts` `GateReasonCode` (phase 3 adds `classifier_declined` and `classifier`,
 * cleared by the classifier, also for a carried `classifier` clearance; `carried`: a `developer`
 * clearance from an earlier build carried over a `classify` level, the classifier not asked).
 */
export type GateReasonCode = "self" | "classifier" | "carried" | "developer_paths" | "migration_destructive" | "classifier_unavailable" | "classifier_declined" | "gate_error";

/** The risk questions (core `RISK_QUESTIONS`, ruling P3-2/P3-3), in the order they are checked. */
export type RiskQuestionId = "risk" | "migration" | "apiChange" | "authOrPayments" | "addressedToReviewer";
export const RISK_QUESTION_IDS: readonly RiskQuestionId[] = ["risk", "migration", "apiChange", "authOrPayments", "addressedToReviewer"];
export interface RiskAnswer {
  choice: string;
  /** option → probability */
  probabilities: Record<string, number>;
  /** the provider's own confidence (stored as evidence, not used) */
  confidence?: number;
}
/** The providers the Worker's classifier port knows (core keeps `provider` a free string). */
export type ClassifierProvider = "jev" | "openai-decisions" | "none";
/**
 * Worker `services/classifier.ts` `ClassifierErrorCode` (`input_incomplete`: the Worker could not
 * read everything the input needs, so it never asked).
 */
export type ClassifierErrorCode = "not_configured" | "timeout" | "http_error" | "refused" | "malformed" | "input_too_large" | "input_incomplete";
/** Core `RiskIncompleteReason` (P3-11): why the classifier did not see the complete change (with error `input_incomplete`). */
export type RiskIncompleteReason = "diff_truncated" | "files_omitted" | "file_not_read" | "binary_file" | "too_many_files" | "file_too_large" | "read_limit";
/**
 * What the classifier answered, stored on the promotion: exactly core `RiskEvidenceSchema`
 * (packages/core/src/risk.ts) with the Worker's error codes. A classifier that could not answer
 * (`error` set) leaves `model`, `inputDigest`, `latencyMs`, `answers` and `safeProbability` null
 * where it never got that far.
 */
export interface RiskEvidence {
  /** one of {@link ClassifierProvider} from this Worker; core allows any 1-64 character name */
  provider: string;
  model: string | null;
  threshold: number;
  /** sha256 (hex) of the exact input sent; null when nothing was sent */
  inputDigest: string | null;
  truncated: boolean;
  /** changed files left out of the diff because it reached its limit */
  omittedFiles: number;
  /** UTF-8 bytes of the input (sent or refused as too large) */
  inputBytes: number;
  latencyMs: number | null;
  answers: Record<RiskQuestionId, RiskAnswer> | null;
  /** question → the sum of its safe options' probabilities */
  safeProbability: Record<string, number> | null;
  cleared: boolean;
  /** the first question that did not clear */
  failed: RiskQuestionId | null;
  error: ClassifierErrorCode | null;
  /** with error `input_incomplete` (P3-11): why the input was not the complete change; absent otherwise */
  incomplete?: RiskIncompleteReason[];
}

/**
 * Worker `promotion-gate.ts` `GateClassifierReason`. `carried`: a rebuilt promotion kept the
 * clearance it already had, without asking again: a carried `classifier` clearance is
 * `{ asked: false, cleared: true, reason: "carried", evidence }` (the evidence it was first cleared
 * on), a carried `developer` clearance `{ asked: false, cleared: false, reason: "carried" }`.
 */
export type GateClassifierReason = "not_needed" | "not_configured" | "carried" | "cleared" | "declined" | "error";
export interface GateClassifier {
  /** the classifier was asked in this gating */
  asked: boolean;
  /** the evidence clears (asked now, or carried) */
  cleared: boolean;
  reason: GateClassifierReason;
  /** what the classifier answered (or why it could not); absent when it was never asked */
  evidence?: RiskEvidence;
}

/** The gate's record (owners and developers only): `gate` of the promotion view. */
export interface PromotionGate {
  pathLevel: PromotionLevel;
  /** `path` is `<mountName>/<path>`; `rule` is the index of the first matching promotion rule (null: none, so `developer`) */
  perPath: Array<{ path: string; level: PromotionLevel; rule: number | null }>;
  veto: { kind: "additive" | "destructive" | "none"; offending: Array<{ file: string; statement: string }> };
  classifier: GateClassifier;
  reasonCode: GateReasonCode;
}

export interface NamedLanding {
  landingId: string;
  taskId: string;
  title: string;
}

/** A landing of a promotion's set. Owners and developers also get the task request and its parts (revisions). */
export interface PromotionLanding extends NamedLanding {
  state: LandingState;
  /** owners and developers only */
  request?: string;
  /** owners and developers only */
  parts?: Array<{ part: number; taskId: string; title: string }>;
}

/**
 * `GET /api/orgs/:org/promotions/:id` (Worker `promotionView`). Clients and viewers get the base
 * fields (reasonCode/reason only when they requested it or own a landing of the set); owners, and
 * developers with read on every resource the promotion changes, get everything (the optional
 * fields). A developer without that read gets the client view. `resources` and `checks` come only
 * from `getPromotion` and the approve, send-back, withdraw and retry responses, never in
 * `listPromotions` rows.
 */
export interface PromotionView {
  promotionId: string;
  state: PromotionState;
  landings: PromotionLanding[];
  /** once gated */
  level: PromotionLevel | null;
  reasonCode: string | null;
  reason: string | null;
  /** cleared, waiting while another promotion accepts or releases */
  waitingForProduction: boolean;
  mode: PromotionMode;
  goingWithout: Array<NamedLanding & { text: string }>;
  needs: NamedLanding[];
  // owners and developers only
  targetLandingId?: string;
  proposalId?: string | null;
  proposalHash?: string | null;
  gate?: PromotionGate | null;
  detail?: string | null;
  clearance?: { kind: ClearanceKind; clearedBy: string; clearedAt: string } | null;
  acceptedVersionId?: string | null;
  releaseId?: string | null;
  requestedBy?: string;
  createdAt?: string;
  updatedAt?: string;
  /**
   * per resource of the promotion's latest integration receipt for the current hash (`[]` before it
   * exists; absent in list rows): the `main` head and the promotion result, as revision ids the file route reads
   */
  resources?: Array<{ resourceId: string; mountName: string | null; head: string; result: string }>;
  /** the latest integration receipt's checks (null before it exists; absent in list rows) */
  checks?: { checks: Array<{ checkId: string; result: string }>; contractChecks: Array<{ contractId: string; result: string }>; mergeOutcome: MergeOutcome[] } | null;
}

/** `GET /api/tasks/:id/promote`: the dry run of a promotion (P3-7), nothing written. */
export interface PromotionPreview {
  landings: NamedLanding[];
  mode: PromotionMode;
  goingWithout: Array<NamedLanding & { text: string }>;
}

/** `POST /api/tasks/:id/promote` → 202. */
export interface PromoteResult {
  promotionId: string;
  landings: Array<{ landingId: string; taskId: string }>;
  mode: PromotionMode;
  goingWithout: Array<NamedLanding & { text: string }>;
}

// ----------------------------------------------------------------------------------- proposals

export type ProposalState = "open" | "prepared" | "accepted" | "rejected" | "superseded" | "withdrawn";

export interface ProposalSummary {
  proposalId: string;
  proposalHash: string;
  projectId: string;
  changeId: string;
  state: ProposalState;
  /** `staging`: a landing proposal (never integrated or accepted directly); `promotion`: built by a promotion; null: an ordinary proposal (absent from older servers) */
  kind?: ProposalKind | null;
  /** creation order decides which proposal of a Change is the latest (Task 20 review n-3) */
  createdAt?: string;
  updatedAt: string;
}

export type ProposalKind = "staging" | "promotion";

export interface CandidateView {
  candidateId: string;
  taskWorkspaceId: string;
  resourceId: string;
  baseRevision: string;
  sha: string;
  treeId: string;
  frozenAt: string;
  submitter: { kind: string; id?: string };
  tool?: string;
  changedPaths: string[];
  state: string;
  preparedReceiptId: string | null;
}

export interface ApprovalView {
  approvalId: string;
  role: string;
  approvedAt: string;
  proposalHash: string;
  approver: { kind: string; id?: string };
}

export interface IntegrationView {
  jobId: string;
  forCurrentHash: boolean;
  integratedAt: string;
  checks: Array<{ checkId: string; result: "pass" | "fail" | "skipped" }>;
  contractChecks: Array<{ contractId: string; result: "pass" | "fail" }>;
  mergeOutcome: MergeOutcome[];
  /** owners and developers only */
  results?: Array<{ resourceId: string; integrationRef: string; sha: string; revisionId: string; expectedHead: string }>;
}

/** The latest integrate run, whatever its outcome (`Proposal.lastAttempt`, API.md). */
export interface IntegrationAttempt {
  /** `applying`: the runner reported success; the ledger has not recorded it yet (treated as running) */
  state: "queued" | "applying" | "succeeded" | "failed";
  expired: boolean;
  forCurrentHash: boolean;
  requestedAt: string;
  completedAt: string | null;
  /** runner failure code: contract_failed, check_failed, textual_conflict, stale_base, … */
  code: string | null;
  checks: Array<{ checkId: string; result: string }>;
  contractChecks: Array<{ contractId: string; result: string; producerResource: string; consumerResource: string }>;
  mergeOutcome: MergeOutcome[];
  conflictPaths: string[];
  signedEvidence: boolean;
  /** owners and developers only */
  jobId?: string;
  /** owners and developers only: the runner's redacted text */
  detail?: string;
  evidenceId?: string;
}

export type ReadDependencyView =
  | { resourceId: string; revisionId: string; mode: string }
  | { redacted: true; mode: string };

export interface Proposal {
  proposalId: string;
  proposalHash: string;
  projectId: string;
  changeId: string;
  state: ProposalState;
  baseSnapshotId: string;
  candidateSnapshotId: string;
  resourceChanges: ResourceChange[];
  assetManifestChanges: AssetManifestChange[];
  readDependencies: ReadDependencyView[];
  policyRevision: number;
  preparedReceipts: Array<{ resourceId: string; receiptId: string }>;
  createdAt: string;
  updatedAt: string;
  stale: string[];
  approvals: ApprovalView[];
  integration: IntegrationView | null;
  candidates: CandidateView[];
  lastAttempt: IntegrationAttempt | null;
}

export interface AcceptResult {
  proposalId: string;
  acceptedVersionId: string;
  replayed: boolean;
}

export interface RestoreResult {
  resourceId: string;
  acceptedVersionId: string;
  replayed: boolean;
  headRevisionId: string;
}

// ------------------------------------------------------------------------------ export, events

export interface ExportStarted {
  exportId: string;
  snapshotId: string;
  jobId: string;
  state: string;
}

export interface ExportStatus {
  exportId: string;
  projectId: string;
  state: string;
  snapshot: unknown;
  receipt: { items: Array<{ r2Key: string; [k: string]: unknown }> } | null;
  /** same-origin download paths, `/api/orgs/<org>/exports/<id>/download?key=…` */
  downloads: string[];
  error?: string;
}

export interface EventView {
  seq: number;
  at: string;
  projectId: string | null;
  action: string;
  subject: { kind: string; id: string };
  actor: { kind: string; id?: string };
  detail?: Record<string, unknown>;
}

export interface EventPage {
  events: EventView[];
  next: number;
}

// ------------------------------------------------------------------------- editions (Task 21)

export interface EditionSourcePolicy {
  mountName: string;
  /** read allowlist: canonical globs */
  include: string[];
  /** write allowlist: path prefixes */
  write: string[];
  editionPathPrefix?: string;
}

export interface EditionPolicyInput {
  name: string;
  sources: EditionSourcePolicy[];
  exclude?: string[];
  protectedPaths: string[];
}

export interface EditionBuild {
  buildId: string;
  state: "queued" | "ready" | "failed";
  policyRevision: number;
  /** AT-30: the live release the build came from; null until releases are recorded */
  sourceReleaseId: string | null;
  canonicalBases: Array<{ resourceId: string; revisionId: string }>;
  files: number;
  error?: string;
  createdAt: string;
}

export interface EditionView {
  editionId: string;
  projectId: string;
  name: string;
  state: "draft" | "building" | "ready" | "failed";
  ready: boolean;
  policyRevision: number;
  files: number;
  editable: string[];
  protected: string[];
  readOnly: boolean;
  builtAt: string | null;
  canStartUpdate: boolean;
  // developers only
  policy?: EditionPolicyInput & { exclude: string[] };
  canManage?: boolean;
  builds?: EditionBuild[];
}

export interface EditionReturn {
  returnId: string;
  sessionId: string;
  state: "queued" | "running" | "freezing" | "proposed" | "no_changes" | "stale" | "conflict" | "refused" | "failed";
  mode: "full" | "partial";
  changes: Array<{ path: string; kind: "added" | "modified" | "deleted" | "renamed"; oldPath?: string }>;
  blocked: Array<{ path: string; reason: "not_mapped" | "read_only" | "protected" | "path_escape" | string }>;
  keptAsIs: number;
  ignored: string[];
  strippedFolder: string | null;
  proposalId: string | null;
  error?: { code: string; message: string };
  createdAt: string;
}

export interface EditionSession {
  sessionId: string;
  editionId: string;
  editionName: string;
  title: string;
  request: string;
  files: number;
  stale: boolean;
  policyChanged: boolean;
  /** the folder the ZIP unpacks to (a returned ZIP wrapped in it is unwrapped) */
  downloadRoot?: string;
  /** same-origin ZIP download of this working copy */
  downloadUrl: string;
  returns: EditionReturn[];
  createdAt: string;
}

export interface MemberView {
  userId: string;
  email: string;
  role: Role;
  /** membership start (GET …/members) */
  since?: string;
}

/** `POST …/members`: the member is added whatever the invite email's outcome */
export type InviteResult = MemberView & { invite: "sent" | "failed" | "rate_limited" };

export type AccessLevel = "none" | "read" | "write";

export interface FolderAccess {
  mountName: string;
  resourceId: string;
  level: AccessLevel;
  /** the folder is read-only in this project: nobody changes it here (a client's Can change does not apply) */
  readOnly?: true;
  /** the floor: what the person's other projects that attach this folder give (never above what they hold); this project can't go lower */
  min?: AccessLevel;
  /** the floor is above this project's level: held there by another project (fixed here) */
  shared?: true;
  /** with `shared`: that other project's name, when the caller can see it */
  via?: string;
}

/** One member's access to one project (GET/PUT …/projects/:pid/access); owners are "write" (implicit) */
export interface PersonAccess {
  userId: string;
  email: string;
  role: Role;
  level: AccessLevel;
  folders: FolderAccess[];
}

/** GET …/projects/:pid/folders: a project's folders with state and the other projects they are in */
export interface ProjectFolder {
  mountName: string;
  resourceId: string;
  resourceName: string;
  provider: Provider;
  state: Resource["state"];
  /** the folder may be changed in this project (Settings → Folders; owners switch it) */
  writable: boolean;
  /** the folder's first version is being made (phase 4: a pending setup); `state` is `empty` meanwhile */
  settingUp: boolean;
  /** this folder's own setup failed (then `state` is `failed` too); a folder failed otherwise (an import) is false: only this one can be tried again */
  setupFailed: boolean;
  error?: string;
  alsoIn: Array<{ projectId: string; name: string }>;
}

// ------------------------------------------------------------------- Task 22: previews, releases

export type PreviewState = "queued" | "building" | "ready" | "failed" | "expired" | "revoked";

/** A private preview of a proposal's integration (server: GET …/proposals/:id/previews). */
export interface PreviewView {
  previewId: string;
  proposalId: string;
  proposalHash: string;
  forCurrentHash?: boolean;
  state: PreviewState;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  /** the token-gated link on the preview origin (only while ready) */
  url: string | null;
  error: { code: string; detail?: string } | null;
}

export type ReleaseState = "not_requested" | "prepared" | "publish_approved" | "deploying" | "health_verification" | "live" | "failed" | "partial" | "recovery_required";

export interface ReleaseView {
  releaseId: string;
  projectId: string;
  acceptedVersionId: string;
  recipeRevision: number;
  envDigest: string;
  outputDigest: string | null;
  state: ReleaseState;
  buildState: "building" | "built" | "failed";
  /** the server's label, e.g. "Approved, not live" */
  status: string;
  live: boolean;
  publishApproved: boolean;
  deployAttempts: number;
  createdAt: string;
  updatedAt: string;
  error: { code: string; detail?: string } | null;
  deployments: Array<{ targetId: string; workerName: string; url: string | null; versionId?: string | null }>;
  health: { ok: boolean; checkedAt: string; targets?: Array<{ targetId: string; ok: boolean }> } | null;
  /** set while/after production was rolled back to the previous release (review I-4) */
  rollback?: { state: "running" | "verifying" | "done" | "failed"; toReleaseId?: string | null } | null;
  /** developers: the full deploy config the output digest covers (review m-7) */
  targets?: Array<{ targetId: string; workerName: string | null; kind: string | null; digest: string; files: number; config: { compatibilityDate: string; compatibilityFlags: string[]; vars: Record<string, string>; kvNamespaces: Array<{ binding: string; id: string }>; notFoundHandling?: string } }>;
}

/** `GET …/deploy-resources`: release Workers of the org are named `<workerPrefix><name>` (`<prefix>-<orgId>-`). */
export interface DeployResources {
  workerPrefix: string;
  resources: Array<{ kind: "kv" | "d1"; name: string; id: string; createdAt: string }>;
}

export interface ReleaseList {
  releases: ReleaseView[];
  live: { releaseId: string; acceptedVersionId: string; outputDigest: string; since: string } | null;
}

// -------------------------------------------------------------------------------------- intake

/** One planned resource of a ZIP intake (Worker `placementPlan`). */
export interface IntakePlacement {
  resourceName: string;
  provider: Provider;
  /** archive prefix this resource is built from ("" = root) */
  pathPrefix: string;
  files: number;
  bytes: number;
  reason: string;
}

export interface IntakePlan {
  placements: IntakePlacement[];
  excluded: Array<{ path: string; reason: string }>;
  /** set at confirm: blocked-by-name files the owner inspected and included anyway, and where each goes */
  includedAnyway?: Array<{ path: string; resourceName: string }>;
}

/** Confirm body: `include` (owners only) names blocked-by-name files the owner inspected and keeps. */
export interface IntakeConfirmInput {
  projectId?: string;
  skip?: string[];
  include?: string[];
}

/** ZIP: inventorying → inventoried → confirming → confirmed | failed. URL: queued → importing → completed | failed. */
export type IntakeState = "inventorying" | "inventoried" | "confirming" | "confirmed" | "queued" | "importing" | "completed" | "failed";

export interface IntakeConfirmResult {
  resources: Array<{ resourceId: string; name: string; provider: Provider; mountName?: string }>;
  excluded: number;
  /** blocked-by-name files the owner included anyway (recorded for when population lands) */
  includedAnyway?: string[];
  /** the resources exist; copying the archive's content into them needs a runner step that does not exist yet */
  pendingPopulation: boolean;
  note: string;
}

export interface IntakeView {
  intakeId: string;
  kind: "zip" | "url";
  state: IntakeState;
  /** ZIP: { filename, size, sha256 }; URL: { resourceId, url, branch, depth?, projectId?, mountName? } */
  request: Record<string, unknown>;
  plan?: IntakePlan;
  inventory?: { files: number };
  /** ZIP: IntakeConfirmResult once confirmed; URL: { resourceId, revisionId, branch } once completed */
  result?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UrlIntakeInput {
  url: string;
  branch: string;
  name: string;
  depth?: number;
  projectId?: string;
  mountName?: string;
}

/** One of the signed-in person's sessions (GET /api/auth/sessions); never the token. */
export interface SessionView {
  sessionId: string;
  /** web: a browser; cli: cforge login with an emailed code; handoff: cforge login with a hand-off prompt's code (lasts 7 days) */
  client: "web" | "cli" | "handoff" | "unknown";
  createdAt: string;
  expiresAt: string;
  /** the session this page is using */
  current: boolean;
}
