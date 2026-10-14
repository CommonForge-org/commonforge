/**
 * Branded identity types (plan §A.5) with Zod schemas, constructors and parsers.
 *
 * Brands are output-only (Zod default): parsing a plain string through a schema or a constructor
 * yields the branded type; plain strings are never implicitly assignable to a branded id.
 */
import { z } from 'zod';
import { CoreError } from './errors.js';

/**
 * Opaque id segment: starts alphanumeric, then `[A-Za-z0-9._-]`, max 128 chars. UUIDs qualify.
 * No `:` or `/`, and git-ref-safe: no `..`, no trailing `.`, no `.lock` suffix — so an id can be
 * embedded as a ref component (`refs/commonforge/candidates/<ws>/<sha>`).
 */
export const ID_SEGMENT = '[A-Za-z0-9](?:[A-Za-z0-9_-]|\\.(?=[A-Za-z0-9_-])){0,127}(?<!\\.lock)';
const ID_SEGMENT_RE = new RegExp(`^${ID_SEGMENT}$`);

/** Full git object id: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase. Abbreviated shas are never identities. */
export const GIT_SHA = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
export const GIT_SHA_RE = new RegExp(`^${GIT_SHA}$`);
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export const GitShaSchema = z.string().regex(GIT_SHA_RE, 'expected full lowercase git sha (40 or 64 hex)');
export const Sha256HexSchema = z.string().regex(SHA256_HEX_RE, 'expected lowercase sha256 hex');
export const IdSegmentSchema = z
  .string()
  .regex(ID_SEGMENT_RE, 'expected id segment [A-Za-z0-9][A-Za-z0-9._-]{0,127} (no "..", trailing ".", or ".lock" suffix)');

const REF_FORBIDDEN_RE = /[\u0000-\u0020\u007f~^:?*[\\]/;

/**
 * Git ref name validity, mirroring `git check-ref-format` (without --allow-onelevel / --refspec-pattern):
 * at least two `/`-separated components; no empty component; no component starting with `.` or ending
 * with `.lock`; no `..`, `@{`, control chars, space, `~ ^ : ? * [ \`; not ending with `.`; not `@`.
 */
export function isValidGitRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 1024) return false;
  if (ref === '@' || REF_FORBIDDEN_RE.test(ref) || ref.includes('..') || ref.includes('@{') || ref.endsWith('.')) return false;
  const parts = ref.split('/');
  if (parts.length < 2) return false;
  return parts.every((c) => c.length > 0 && !c.startsWith('.') && !c.endsWith('.lock'));
}

function assertRef(ref: string): string {
  if (!isValidGitRef(ref)) throw new CoreError('invalid_id', `invalid git ref ${JSON.stringify(ref)}`);
  return ref;
}

// ---------------------------------------------------------------------------------------------
// Opaque ids
// ---------------------------------------------------------------------------------------------

export const ResourceIdSchema = IdSegmentSchema.brand<'ResourceId'>();
export type ResourceId = z.infer<typeof ResourceIdSchema>;

export const ChangeIdSchema = IdSegmentSchema.brand<'ChangeId'>();
export type ChangeId = z.infer<typeof ChangeIdSchema>;

export const TaskWorkspaceIdSchema = IdSegmentSchema.brand<'TaskWorkspaceId'>();
export type TaskWorkspaceId = z.infer<typeof TaskWorkspaceIdSchema>;

export const ProposalIdSchema = IdSegmentSchema.brand<'ProposalId'>();
export type ProposalId = z.infer<typeof ProposalIdSchema>;

export const AcceptedVersionIdSchema = IdSegmentSchema.brand<'AcceptedVersionId'>();
export type AcceptedVersionId = z.infer<typeof AcceptedVersionIdSchema>;

export const ReleaseIdSchema = IdSegmentSchema.brand<'ReleaseId'>();
export type ReleaseId = z.infer<typeof ReleaseIdSchema>;

/** sha256 over canonical snapshot JSON (see `computeSnapshotId`). */
export const SnapshotIdSchema = Sha256HexSchema.brand<'SnapshotId'>();
export type SnapshotId = z.infer<typeof SnapshotIdSchema>;

/** sha256 over canonical proposal JSON (see `computeProposalHash`). */
export const ProposalHashSchema = Sha256HexSchema.brand<'ProposalHash'>();
export type ProposalHash = z.infer<typeof ProposalHashSchema>;

/** sha256 over canonical asset manifest JSON (see `computeAssetManifestId`). */
export const ManifestIdSchema = Sha256HexSchema.brand<'ManifestId'>();
export type ManifestId = z.infer<typeof ManifestIdSchema>;

function makeParser<S extends z.ZodType>(schema: S, code: 'invalid_id' | 'invalid_revision_id' | 'invalid_candidate_id', label: string) {
  return (value: string): z.infer<S> => {
    const r = schema.safeParse(value);
    if (!r.success) throw new CoreError(code, `${label}: ${JSON.stringify(value)}`);
    return r.data;
  };
}

export const resourceId = makeParser(ResourceIdSchema, 'invalid_id', 'ResourceId');
export const changeId = makeParser(ChangeIdSchema, 'invalid_id', 'ChangeId');
export const taskWorkspaceId = makeParser(TaskWorkspaceIdSchema, 'invalid_id', 'TaskWorkspaceId');
export const proposalId = makeParser(ProposalIdSchema, 'invalid_id', 'ProposalId');
export const acceptedVersionId = makeParser(AcceptedVersionIdSchema, 'invalid_id', 'AcceptedVersionId');
export const releaseId = makeParser(ReleaseIdSchema, 'invalid_id', 'ReleaseId');
export const snapshotId = makeParser(SnapshotIdSchema, 'invalid_id', 'SnapshotId');
export const proposalHash = makeParser(ProposalHashSchema, 'invalid_id', 'ProposalHash');
export const manifestId = makeParser(ManifestIdSchema, 'invalid_id', 'ManifestId');

// ---------------------------------------------------------------------------------------------
// RevisionId
// ---------------------------------------------------------------------------------------------

/**
 * Parsed form of a {@link RevisionId}.
 * - `art:<repoId>:<commitSha>`        Artifacts-managed git repository
 * - `gh:<owner>/<repo>:<commitSha>`  connected GitHub repository
 * - `r2m:<manifestSha256>`           R2 asset manifest
 * - `legacy:<projectId>:<version>`   untouched VibeControl storage folder
 * - `local:<repoId>:<commitSha>`     LocalGitProvider (tests/dev); never mixed with `art:`
 */
export type ParsedRevisionId =
  | { kind: 'art'; repoId: string; sha: string }
  | { kind: 'gh'; owner: string; repo: string; sha: string }
  | { kind: 'r2m'; manifestId: ManifestId }
  | { kind: 'legacy'; projectId: string; version: string }
  | { kind: 'local'; repoId: string; sha: string };

export type RevisionKind = ParsedRevisionId['kind'];

const ART_RE = new RegExp(`^art:(${ID_SEGMENT}):(${GIT_SHA})$`);
const LOCAL_RE = new RegExp(`^local:(${ID_SEGMENT}):(${GIT_SHA})$`);
// GitHub owner: 1-39 alnum or single hyphens; repo: [A-Za-z0-9._-]{1,100} (not "." or "..").
const GH_OWNER = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})';
const GH_REPO = '[A-Za-z0-9._-]{1,100}';
const GH_RE = new RegExp(`^gh:(${GH_OWNER})/(${GH_REPO}):(${GIT_SHA})$`);
const R2M_RE = /^r2m:([0-9a-f]{64})$/;
const LEGACY_RE = new RegExp(`^legacy:(${ID_SEGMENT}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})$`);

function matchRevision(value: string): ParsedRevisionId | null {
  let m: RegExpExecArray | null;
  if ((m = ART_RE.exec(value))) return { kind: 'art', repoId: m[1]!, sha: m[2]! };
  if ((m = GH_RE.exec(value))) {
    const repo = m[2]!;
    if (repo === '.' || repo === '..') return null;
    return { kind: 'gh', owner: m[1]!, repo, sha: m[3]! };
  }
  if ((m = R2M_RE.exec(value))) return { kind: 'r2m', manifestId: m[1]! as ManifestId };
  if ((m = LEGACY_RE.exec(value))) return { kind: 'legacy', projectId: m[1]!, version: m[2]! };
  if ((m = LOCAL_RE.exec(value))) return { kind: 'local', repoId: m[1]!, sha: m[2]! };
  return null;
}

export const RevisionIdSchema = z
  .string()
  .refine((v) => matchRevision(v) !== null, 'expected RevisionId art:|gh:|r2m:|legacy:|local:')
  .brand<'RevisionId'>();
export type RevisionId = z.infer<typeof RevisionIdSchema>;

export const revisionId = makeParser(RevisionIdSchema, 'invalid_revision_id', 'RevisionId');

export function isRevisionId(value: unknown): value is RevisionId {
  return typeof value === 'string' && matchRevision(value) !== null;
}

/** Parse a RevisionId string into its components; throws `CoreError('invalid_revision_id')`. */
export function parseRevisionId(value: string): ParsedRevisionId {
  const parsed = matchRevision(value);
  if (!parsed) throw new CoreError('invalid_revision_id', `RevisionId: ${JSON.stringify(value)}`);
  return parsed;
}

export function formatRevisionId(p: ParsedRevisionId): RevisionId {
  switch (p.kind) {
    case 'art':
      return revisionId(`art:${p.repoId}:${p.sha}`);
    case 'local':
      return revisionId(`local:${p.repoId}:${p.sha}`);
    case 'gh':
      return revisionId(`gh:${p.owner}/${p.repo}:${p.sha}`);
    case 'r2m':
      return revisionId(`r2m:${p.manifestId}`);
    case 'legacy':
      return revisionId(`legacy:${p.projectId}:${p.version}`);
  }
}

export const artRevisionId = (repoId: string, sha: string): RevisionId => formatRevisionId({ kind: 'art', repoId, sha });
export const localRevisionId = (repoId: string, sha: string): RevisionId => formatRevisionId({ kind: 'local', repoId, sha });
export const ghRevisionId = (owner: string, repo: string, sha: string): RevisionId =>
  formatRevisionId({ kind: 'gh', owner, repo, sha });
export const r2mRevisionId = (manifestSha256: string): RevisionId =>
  formatRevisionId({ kind: 'r2m', manifestId: manifestId(manifestSha256) });
export const legacyRevisionId = (projectId: string, version: string | number): RevisionId =>
  formatRevisionId({ kind: 'legacy', projectId, version: String(version) });

/** The git commit sha of a git-backed revision (`art:`, `gh:`, `local:`), else `null`. */
export function revisionCommitSha(id: RevisionId): string | null {
  const p = parseRevisionId(id);
  return p.kind === 'art' || p.kind === 'gh' || p.kind === 'local' ? p.sha : null;
}

// ---------------------------------------------------------------------------------------------
// CandidateId
// ---------------------------------------------------------------------------------------------

const CAND_RE = new RegExp(`^cand:(${ID_SEGMENT}):(${GIT_SHA})$`);

export const CandidateIdSchema = z
  .string()
  .regex(CAND_RE, 'expected CandidateId cand:<taskWorkspaceId>:<commitSha>')
  .brand<'CandidateId'>();
export type CandidateId = z.infer<typeof CandidateIdSchema>;

export const candidateIdFromString = makeParser(CandidateIdSchema, 'invalid_candidate_id', 'CandidateId');

/** Build `cand:<taskWorkspaceId>:<commitSha>`. */
export function candidateId(workspace: string, sha: string): CandidateId {
  return candidateIdFromString(`cand:${workspace}:${sha}`);
}

export function parseCandidateId(value: string): { taskWorkspaceId: TaskWorkspaceId; sha: string } {
  const m = CAND_RE.exec(value);
  if (!m) throw new CoreError('invalid_candidate_id', `CandidateId: ${JSON.stringify(value)}`);
  return { taskWorkspaceId: m[1]! as TaskWorkspaceId, sha: m[2]! };
}

/** Service-managed ref in the canonical repo that retains a prepared candidate (plan §A.6). */
export function candidateRetentionRef(id: CandidateId): string {
  const { taskWorkspaceId: ws, sha } = parseCandidateId(id);
  return assertRef(`refs/commonforge/candidates/${ws}/${sha}`);
}

/**
 * Bare per-proposal integration ref (plan §B.8 text).
 *
 * @deprecated Use {@link integrationJobRef}. Integration results are pushed to a ref unique per
 * job (`refs/commonforge/integrations/<proposalId>/<jobId>`): concurrent pushes to the same new ref
 * are refused by Artifacts, and git cannot hold both `…/<proposalId>` and `…/<proposalId>/<jobId>`,
 * so nothing may push this ref.
 */
export function integrationRef(id: ProposalId): string {
  return assertRef(`refs/commonforge/integrations/${id}`);
}

/**
 * Ref an `integrate` job pushes its result to: `refs/commonforge/integrations/<proposalId>/<jobId>`,
 * unique per job. Both ids must be single ref components (no `/`). Throws `CoreError('invalid_id')`.
 */
export function integrationJobRef(proposalId: string, jobId: string): string {
  if (!proposalId || !jobId || proposalId.includes('/') || jobId.includes('/')) {
    throw new CoreError('invalid_id', `integration ref components must be non-empty and contain no "/": ${JSON.stringify([proposalId, jobId])}`);
  }
  return assertRef(`refs/commonforge/integrations/${proposalId}/${jobId}`);
}

/** Ref for a non-frozen checkpoint on a task fork (plan §A.8, §B.5). */
export function checkpointRef(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new CoreError('invalid_id', `checkpoint number ${n}`);
  return assertRef(`refs/commonforge/checkpoints/${n}`);
}
