/** Dedicated G1 live CI rehearsal. Phased operator execution; importing/planning never contacts cloud. */
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { configDigest } from '@commonforge-org/runner-protocol';
import { canonicalJson, ProjectStateSchema, type BuildRecipe, type ProjectState } from '@commonforge-org/core';
import { createCloudflareSchedulingAdapter } from './g1-cloudflare-source.js';
import type { CloudflareReleaseEnvironment } from './g1-cloudflare-verifier.js';
import { cases } from './g1-scheduling-harness.js';
import { createGit, RUNNER_IDENTITY_ENV, type Git } from './git.js';

export const G1CloudRehearsalConfigSchema = z.object({
  schemaVersion: z.literal(1), runId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  apiUrl: z.string().url(), accountId: z.string().regex(/^[a-f0-9]{32}$/), organizationId: z.string().regex(/^o-[a-f0-9]{12}$/),
  ownerSessionFile: z.string().min(1), stateDirectory: z.string().min(1),
  controlWorker: z.literal('commonforge-ci-worker'), targetPrefix: z.literal('cfci'),
  mutationsApproved: z.boolean().default(false), deploymentApproved: z.boolean().default(false),
  trustedSupervisorUrl: z.string().url().optional(), supervisorPort: z.number().int().min(1024).max(65535).default(8971),
  pin: z.object({ binary: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(), schema: z.string().min(1),
}).strict().superRefine((c, context) => {
  const url = new URL(c.apiUrl);
  if (url.protocol !== 'https:' || !url.hostname.startsWith('commonforge-ci-worker.') || !url.hostname.endsWith('.workers.dev') || url.pathname !== '/' || url.search || url.hash || url.username || url.password) context.addIssue({ code: 'custom', message: 'API must be the exact HTTPS commonforge-ci-worker workers.dev origin' });
  if (c.trustedSupervisorUrl) { const supervisor = new URL(c.trustedSupervisorUrl); if (supervisor.protocol !== 'https:' || supervisor.username || supervisor.password || supervisor.search || supervisor.hash || supervisor.pathname !== '/') context.addIssue({ code: 'custom', message: 'supervisor must be an operator-pinned HTTPS origin' }); }
});
export type G1CloudRehearsalConfig = z.infer<typeof G1CloudRehearsalConfigSchema>;
export function cloudRehearsalContracts(raw: G1CloudRehearsalConfig) {
  const config = G1CloudRehearsalConfigSchema.parse(raw);
  const workerName = `cfci-${config.organizationId}-g1-${config.runId}`;
  if (workerName.length > 63) throw new Error('CI release Worker name exceeds provider bound');
  const recipe: BuildRecipe = { recipeId: 'g1-cloud-scheduling', revision: 1, steps: [{ stepId: 'build', mountName: 'api', command: 'node build.mjs' }] };
  const targets = [{ targetId: 'api', kind: 'worker' as const, mountName: 'api', outputPath: 'dist', main: 'worker.mjs', workerName }];
  const targetEnvironment = { api: { vars: { APP_VERSION: 'g1-synthetic-scheduling' }, kvNamespaces: [] } };
  const healthCheck = { targetId: 'api', path: '/version' };
  const environment: CloudflareReleaseEnvironment = { targets, environment: targetEnvironment, healthCheck, accountId: config.accountId };
  const policy = { checks: [], contracts: [], rules: [], approvalRoles: ['owner'], publishRoles: ['owner'], release: { recipe, targets, environment: targetEnvironment, healthCheck, migrations: [] } };
  return { config, workerName, recipe, environment, policy };
}
export function cloudRehearsalPlan(config: G1CloudRehearsalConfig) {
  const c = cloudRehearsalContracts(config);
  return { schemaVersion: 1, execution: 'planned-not-executed', controlWorker: c.config.controlWorker, apiUrl: c.config.apiUrl,
    releaseWorker: c.workerName, scope: 'existing owner-approved isolated commonforge-ci infrastructure',
    phases: ['setup: create fresh native project and dedicated source folder; configure vars-only recipe; emit supervisor registration',
      'run: confirm corrected rule and nine pinned scenarios; scoped real Git change; actual integration/verification/acceptance; explicit release build/publish/deploy and healthy observation',
      'expiry: read the actual first release after freshUntil; require unknown (no clock override)',
      'recover: accept and deploy a second source variant; recover exact first manifest under current knowledge; fresh nine-scenario verification; explicit third release and actual health',
      'inspect: read authoritative accepted/release/observation state and write sanitized results'],
    persistentBindings: [], migrations: [], outboundFixtureEffects: [],
    prerequisite: 'parent must authorize exact isolated CI target before enabling mutation/deployment flags; owner session and supervisor credentials remain private',
    noProvisioning: true, noProductionTarget: true, noCloudClaimFromLocalTests: true };
}
export function requireFreshCloudProjectName(projects: Array<{name: string}>, name: string): void {
  if (projects.some(project => project.name === name)) throw new Error('matching project exists without this run checkpoint; refuse name-only adoption and require operator inspection');
}
export interface CloudSourcePushCheckpoint { workspace?: string; intendedSha?: string; expectedRemoteSha?: string; sha?: string }
/** Persist immutable commit intent BEFORE a possibly ambiguous push. Retry observes the exact remote ref. */
export async function pushResumableCloudSource(options: {
  cycle: CloudSourcePushCheckpoint; remoteUrl: string; credentialSecret: string; files: Record<string,string>; label: string;
  checkpointDirectory: string; persist(): Promise<void>; git?: Git;
}): Promise<string> {
  const { cycle, files } = options, git = options.git ?? createGit();
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${options.remoteUrl}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${options.credentialSecret}` };
  const validSha = (sha: string | undefined): sha is string => !!sha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha);
  const remoteHead = async () => {
    const refs = await git.ok(['ls-remote', options.remoteUrl, 'refs/heads/main'], options.checkpointDirectory, { env });
    const sha = refs.trim().split(/\s+/)[0]; if (!validSha(sha)) throw new Error('task source remote main is absent or malformed'); return sha;
  };
  let remote = await remoteHead();
  // Legacy complete checkpoints are also rechecked rather than silently trusting a push label.
  if (!cycle.intendedSha && cycle.sha) cycle.intendedSha = cycle.sha;
  if (cycle.intendedSha && !validSha(cycle.intendedSha)) throw new Error('saved source intent is not an immutable full Git SHA');
  if (cycle.intendedSha && remote === cycle.intendedSha) { cycle.sha = cycle.intendedSha; await options.persist(); return cycle.sha; }
  if (cycle.expectedRemoteSha && remote !== cycle.expectedRemoteSha) throw new Error('task remote moved from checkpointed base; refuse to overwrite another change');
  if (!cycle.workspace) {
    const root = await mkdtemp(join(tmpdir(), 'commonforge-g1-cloud-source-')); cycle.workspace = join(root, 'candidate');
    cycle.expectedRemoteSha = remote; await options.persist();
  }
  const exists = await access(join(cycle.workspace, '.git')).then(() => true, () => false);
  if (!exists) {
    if (cycle.intendedSha) throw new Error('intended source commit is not pushed and its checkpointed workspace is unavailable');
    // A partial failed clone is left as task-owned evidence; retry gets a new private workspace.
    if (await access(cycle.workspace).then(() => true, () => false)) {
      const root = await mkdtemp(join(tmpdir(), 'commonforge-g1-cloud-source-')); cycle.workspace = join(root, 'candidate'); await options.persist();
    }
    await git.ok(['clone', '-q', options.remoteUrl, cycle.workspace], dirname(cycle.workspace), { env });
  }
  if (!cycle.expectedRemoteSha) { cycle.expectedRemoteSha = remote; await options.persist(); }
  const work = cycle.workspace;
  if (!cycle.intendedSha) {
    for (const [path, value] of Object.entries(files)) await writeFile(join(work, path), value);
    await git.ok(['add', '--', ...Object.keys(files)], work);
    const staged = await git.run(['diff', '--cached', '--quiet'], work);
    const head = (await git.ok(['rev-parse', 'HEAD'], work)).trim();
    if (staged.code === 1) await git.ok(['commit', '-q', '-m', `G1 isolated live fixture ${options.label}`], work, { env: RUNNER_IDENTITY_ENV(new Date().toISOString()) });
    else if (staged.code !== 0 || head === cycle.expectedRemoteSha) throw new Error('no distinct intended source change; refuse an unrecorded no-op commit');
    cycle.intendedSha = (await git.ok(['rev-parse', 'HEAD'], work)).trim();
    if (!validSha(cycle.intendedSha)) throw new Error('prepared source commit is malformed');
    await options.persist();
  }
  await git.ok(['cat-file', '-e', `${cycle.intendedSha}^{commit}`], work);
  for (const [path, expected] of Object.entries(files)) if (await git.ok(['show', `${cycle.intendedSha}:${path}`], work) !== expected) throw new Error('checkpointed intended source differs from the exact rehearsal variant');
  remote = await remoteHead();
  if (remote !== cycle.intendedSha) {
    if (remote !== cycle.expectedRemoteSha) throw new Error('task remote moved before push; refuse to overwrite another change');
    await git.ok(['push', '-q', `--force-with-lease=refs/heads/main:${cycle.expectedRemoteSha}`, options.remoteUrl, `${cycle.intendedSha}:refs/heads/main`], work, { env });
  }
  if (await remoteHead() !== cycle.intendedSha) throw new Error('actual remote ref does not match checkpointed intended source');
  cycle.sha = cycle.intendedSha; await options.persist(); return cycle.sha;
}
interface Checkpoint { schemaVersion: 1; runId: string; configDigestInput: string; projectId?: string; resourceId?: string; setupComplete?: boolean; knowledgeComplete?: boolean; registration?: unknown; verifierDigest?: string; runtimeRecipeDigest?: string; cycles: Record<string, any>; releases: Record<string, any>; expiry?: unknown; recovery?: any; steps: Array<{ phase: string; operation: string; at: string; status: number }> }
const rememberedSecrets: string[] = [];
export class G1CloudRehearsal {
  private livePoll?: (label: string, read: () => Promise<any>, ready: (data: any) => boolean, timeout: number, interval: number) => Promise<any>;
  readonly contracts; checkpoint!: Checkpoint; private token = ''; private author = ''; phase = '';
  constructor(readonly config: G1CloudRehearsalConfig) { this.contracts = cloudRehearsalContracts(config); }
  private get directory() { return resolve(this.config.stateDirectory); }
  private get root() { if (!this.checkpoint.projectId) throw new Error('setup phase required'); return `/orgs/${this.config.organizationId}/projects/${this.checkpoint.projectId}`; }
  private get native() { return `${this.root}/native`; }
  async open() {
    if (!this.config.mutationsApproved) throw new Error('operator has not enabled this reviewed isolated CI rehearsal');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const configDigestInput = canonicalJson({ runId: this.config.runId, apiUrl: this.config.apiUrl, organizationId: this.config.organizationId, accountId: this.config.accountId, workerName: this.contracts.workerName, recipe: this.contracts.recipe, environment: this.contracts.environment });
    this.checkpoint = await readFile(join(this.directory, 'checkpoint.json'), 'utf8').then(s => JSON.parse(s) as Checkpoint, () => ({ schemaVersion: 1, runId: this.config.runId, configDigestInput, cycles: {}, releases: {}, steps: [] }));
    if (this.checkpoint.configDigestInput !== configDigestInput) throw new Error('checkpoint belongs to a different exact CI scope/runtime');
    process.env.CI_API_URL = this.config.apiUrl.replace(/\/$/, '');
    const helpers = await import(new URL('../../../scripts/ci-live/lib.ts', import.meta.url).href);
    helpers.requireCiTarget('G1 isolated cloud rehearsal'); this.livePoll = helpers.poll;
    const session = JSON.parse(await readFile(resolve(this.config.ownerSessionFile), 'utf8'));
    this.token = session.ownerToken ?? session.sessionToken;
    if (typeof this.token !== 'string' || !this.token.startsWith('cfs_')) throw new Error('private owner session is missing'); rememberedSecrets.push(this.token); helpers.secret(this.token);
    const me = await this.api('GET', '/me'); this.author = me.user.userId;
    const org = await this.api('GET', `/orgs/${this.config.organizationId}`); if (org.role !== 'owner') throw new Error('owner role required');
  }
  private async save() { const temp = join(this.directory, `checkpoint-${randomUUID()}.tmp`); await writeFile(temp, JSON.stringify(this.checkpoint, null, 2), { mode: 0o600 }); await rename(temp, join(this.directory, 'checkpoint.json')); }
  private async api(method: string, path: string, body?: unknown, token = this.token): Promise<any> {
    const response = await fetch(`${this.config.apiUrl.replace(/\/$/, '')}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual', signal: AbortSignal.timeout(130000) });
    const data: any = await response.json().catch(() => null);
    this.checkpoint.steps.push({ phase: this.phase, operation: `${method} ${path}`, at: new Date().toISOString(), status: response.status }); await this.save();
    if (!response.ok) throw new Error(`CI API ${method} ${path}: HTTP ${response.status} ${data?.error?.code ?? 'unclassified_error'}`); return data;
  }
  private async waitFor(read: () => Promise<any>, predicate: (data: any) => boolean, label: string, milliseconds = 600000) {
    if (!this.livePoll) throw new Error('existing CI polling helpers not initialized');
    return this.livePoll(label, read, data => {
      if (predicate(data)) return true;
      if (data?.state === 'failed' || data?.buildState === 'failed' || data?.state === 'recovery_required') throw new Error(`${label} failed: ${data?.error?.code ?? data.state}`);
      return false;
    }, milliseconds, 1500);
  }
  private state(): Promise<ProjectState> { return this.api('GET', this.native).then(r => ProjectStateSchema.parse(r.state)); }
  private base(id: string) { return { schemaVersion: 1, organizationId: this.config.organizationId, projectId: this.checkpoint.projectId!, id, author: this.author, createdAt: new Date().toISOString() }; }
  private async command(command: Record<string, unknown>, key: string) { const state = await this.state(); return this.api('POST', `${this.native}/commands`, { ...command, expectedGeneration: state.generation, idempotencyKey: key }); }
  async setup() {
    this.phase = 'setup';
    if (this.checkpoint.setupComplete) return this.checkpoint.registration;
    const name = `G1 isolated cloud rehearsal ${this.config.runId}`;
    if (!this.checkpoint.projectId) {
      const projects = await this.api('GET', `/orgs/${this.config.organizationId}/projects`);
      requireFreshCloudProjectName(projects.projects, name);
      this.checkpoint.projectId = (await this.api('POST', `/orgs/${this.config.organizationId}/projects`, { name, mode: 'agent-native' })).projectId; await this.save();
    }
    if (!this.checkpoint.resourceId) {
      const folders = await this.api('GET', `${this.root}/folders`);
      const existing = folders.folders.find((f: any) => f.mountName === 'api');
      this.checkpoint.resourceId = existing?.resourceId ?? (await this.api('POST', `${this.root}/folders`, { name: 'api', kind: 'code' })).resourceId; await this.save();
    }
    const resource = await this.waitFor(() => this.api('GET', `/orgs/${this.config.organizationId}/resources/${this.checkpoint.resourceId}`), r => r.state === 'active' && !!r.head, 'real Sandbox folder initialization');
    await this.api('PUT', `${this.root}/policy`, this.contracts.policy);
    const runtime = await createCloudflareSchedulingAdapter({ pin: this.config.pin, schema: this.config.schema, recipe: this.contracts.recipe, environment: this.contracts.environment });
    this.checkpoint.verifierDigest = runtime.verifierDigest; this.checkpoint.runtimeRecipeDigest = runtime.runtimeRecipeDigest;
    const registration = { port: this.config.supervisorPort, accountId: this.config.accountId, pin: this.config.pin, schema: this.config.schema, recipe: this.contracts.recipe, environment: this.contracts.environment,
      resources: [{ organizationId: this.config.organizationId, projectId: this.checkpoint.projectId, resourceId: this.checkpoint.resourceId, namespace: resource.coords.namespace, repoName: resource.coords.repoName, repoId: resource.coords.repoId, pathPrefix: '' }] };
    this.checkpoint.registration = registration; this.checkpoint.setupComplete = true; await this.save();
    await writeFile(join(this.directory, 'supervisor-registration.json'), JSON.stringify(registration, null, 2), { mode: 0o600 });
    return { projectId: this.checkpoint.projectId, resourceId: this.checkpoint.resourceId, releaseWorker: this.contracts.workerName, verifierDigest: runtime.verifierDigest, runtimeRecipeDigest: runtime.runtimeRecipeDigest, registrationFile: join(this.directory, 'supervisor-registration.json'), next: 'Parent starts trusted supervisor with this registration, configures exact HTTPS verifier origin, then authorizes run.' };
  }
  private async verifySupervisor() {
    if (!this.config.trustedSupervisorUrl) throw new Error('trusted HTTPS supervisor origin is not configured');
    const response = await fetch(`${this.config.trustedSupervisorUrl.replace(/\/$/, '')}/capabilities`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('trusted supervisor capabilities unavailable'); const cap = await response.json() as any;
    if (cap.verifierDigest !== this.checkpoint.verifierDigest || cap.runtimeRecipeDigest !== this.checkpoint.runtimeRecipeDigest || canonicalJson([...cap.scenarioIds].sort()) !== canonicalJson(cases.map(c => c[0]).sort())) throw new Error('supervisor runtime/verifier/scenario set differs from approved full release environment');
  }
  private async knowledge() {
    if (this.checkpoint.knowledgeComplete) return;
    const ruleId = 'cloud-scheduling-rule'; let s = await this.state();
    if (!s.knowledge.some(k => k.id === ruleId)) await this.command({ type: 'draftKnowledge', record: { ...this.base(ruleId), revision: 1, predecessor: null, kind: 'rule', text: 'Customers may reschedule at least 24 hours before an appointment. Travel blocks everybody. Managers may override the cutoff only with a retained nonempty reason.', rationale: 'Synthetic corrected owner requirement for exact cloud release verification', sources: [{ kind: 'text', ref: 'G1 synthetic owner-confirmed scheduling requirement', digest: null }], confirmation: null, archived: false } }, 'live-rule-draft');
    s = await this.state(); if (!s.knowledge.some(k => k.id === ruleId && k.confirmation)) await this.command({ type: 'confirmKnowledge', id: ruleId, revision: 1, decisionId: 'confirm-cloud-rule', explanation: 'Confirm explicit boundary, authority, travel and reason requirements' }, 'live-rule-confirm');
    for (const [id] of cases) {
      s = await this.state();
      if (!s.scenarios.some(q => q.id === id)) await this.command({ type: 'draftScenario', record: { ...this.base(id), revision: 1, predecessor: null, title: id, given: 'Synthetic UTC scheduling input', when: 'Rescheduling is requested', then: 'The independently pinned exact scenario expectation is observed', ruleRefs: [{ id: ruleId, revision: 2 }], required: true, method: 'automated', verifierDigest: this.checkpoint.verifierDigest, confirmation: null, archived: false } }, `live-scenario-draft-${id}`);
      s = await this.state(); if (!s.scenarios.some(q => q.id === id && q.confirmation)) await this.command({ type: 'confirmScenario', id, revision: 1, decisionId: `confirm-${id}`, explanation: 'Confirm independently executable synthetic scheduling example' }, `live-scenario-confirm-${id}`);
    }
    this.checkpoint.knowledgeComplete = true; await this.save();
  }
  async sourceCycle(label: 'initial' | 'later') {
    if (this.checkpoint.cycles[label]?.acceptedManifest) return this.checkpoint.cycles[label];
    const cycle = this.checkpoint.cycles[label] ??= {}; await this.save();
    if (!cycle.taskId) { cycle.taskId = (await this.api('POST', `${this.root}/tasks`, { title: `G1 live ${label} source`, request: `Publish synthetic fixture variant ${label} while preserving all confirmed rules.`, writeMounts: ['api'] })).taskId; await this.save(); }
    if (!cycle.leaseToken) {
      await this.waitFor(() => this.api('GET', `/tasks/${cycle.taskId}`), t => t.state === 'ready', 'actual cloud source task');
      const handoff = await this.api('POST', `/tasks/${cycle.taskId}/native/handoff`, { agentId: `g1-cloud-rehearsal-${label}` });
      const agent = await this.api('POST', '/auth/task/verify', { code: handoff.code });
      cycle.leaseToken = agent.leaseToken; cycle.contextDigest = agent.context.digest; rememberedSecrets.push(agent.leaseToken); await this.save();
    }
    if (!cycle.candidateId) {
      const credential = await this.api('POST', `/tasks/${cycle.taskId}/credential`, { mountName: 'api', access: 'write' }, cycle.leaseToken); rememberedSecrets.push(credential.secret);
      await pushResumableCloudSource({ cycle, remoteUrl: credential.remoteUrl, credentialSecret: credential.secret,
        files: await cloudFixtureFiles(label), label, checkpointDirectory: this.directory, persist: () => this.save() });
    }
    if (!cycle.candidateId) {
      const task = await this.api('GET', `/tasks/${cycle.taskId}`), workspace = task.workspaces.find((w: any) => w.mountName === 'api');
      const candidate = await this.api('POST', `/tasks/${cycle.taskId}/workspaces/${workspace.taskWorkspaceId}/freeze`, { expectedSha: cycle.sha, tool: 'g1-authorized-cloud-rehearsal' }, cycle.leaseToken); cycle.candidateId = candidate.candidateId; await this.save();
    }
    if (!cycle.innerProposalId) { cycle.innerProposalId = (await this.api('POST', `/orgs/${this.config.organizationId}/proposals`, { taskId: cycle.taskId, candidateIds: [cycle.candidateId] })).proposalId; await this.save(); }
    const innerPath = `/orgs/${this.config.organizationId}/proposals/${cycle.innerProposalId}`;
    const inner = await this.waitFor(() => this.api('GET', innerPath), p => p.state === 'prepared' || !!p.integration, 'cloud candidate preparation');
    if (!inner.integration) { await this.api('POST', `${innerPath}/integrate`, {}); await this.waitFor(() => this.api('GET', innerPath), p => !!p.integration, 'real Sandbox integration'); }
    if (!cycle.proposalId) { const s = await this.state(); const prepared = await this.api('POST', `/tasks/${cycle.taskId}/native/proposals`, { innerProposalId: cycle.innerProposalId, expectedGeneration: s.generation, idempotencyKey: `live-outer-${label}` }, cycle.leaseToken); cycle.proposalId = prepared.proposal.id; await this.save(); }
    const accepted = await this.verifyAccept(cycle.proposalId, `source-${label}`); Object.assign(cycle, accepted); await this.save(); return cycle;
  }
  private async verifyAccept(proposalId: string, label: string) {
    let state = await this.state(); const proposal = state.proposals.find(p => p.id === proposalId); if (!proposal) throw new Error('prepared exact proposal missing');
    if (proposal.envelope.runtimeRecipeDigest !== this.checkpoint.runtimeRecipeDigest || proposal.envelope.requiredScenarios.length !== 9 || proposal.envelope.requiredScenarios.some(s => s.verifierDigest !== this.checkpoint.verifierDigest || s.method !== 'automated')) throw new Error('project review envelope differs from pinned nine-scenario cloud runtime');
    const already = state.manifests.find(m => m.envelopeDigest === proposal.digest); if (already) return { acceptedManifest: already.hash, sourceHeads: already.sourceHeads, envelopeDigest: proposal.digest, knowledgeHead: already.knowledgeHead };
    const checked = await this.api('POST', `${this.native}/proposals/${encodeURIComponent(proposalId)}/verify`, { idempotencyKey: `live-verify-${label}` });
    if (checked.evidence.length !== 9 || checked.evidence.some((e: any) => e.result !== 'pass' || e.provenance !== 'runner-verified' || e.envelopeDigest !== proposal.digest)) throw new Error('nine exact trusted remote-source scenario passes required');
    state = ProjectStateSchema.parse(checked.state); const decisionId = `live-decision-${label}`;
    if (!state.decisions.some(d => d.id === decisionId)) await this.command({ type: 'recordDecision', record: { ...this.base(decisionId), envelopeDigest: proposal.digest, innerProposalHash: proposal.envelope.innerProposalHash, action: 'approve', explanation: 'Synthetic owner approves exact isolated CI source after real independently pinned workerd checks; deploy approval remains separate.', authorityRevision: state.authorities.find(a => a.principalId === this.author)!.revision } }, `record-${decisionId}`);
    await this.command({ type: 'accept', proposalId, decisionId }, `accept-${decisionId}`);
    state = await this.state(); const accepted = state.manifests.at(-1)!;
    return { acceptedManifest: accepted.hash, sourceHeads: accepted.sourceHeads, envelopeDigest: proposal.digest, knowledgeHead: state.knowledgeHead, evidence: checked.evidence };
  }
  async release(label: string, expectedManifest: string) {
    if (!this.config.deploymentApproved) throw new Error(`deployment of exact isolated target ${this.contracts.workerName} is not enabled by operator`);
    if (this.checkpoint.releases[label]?.healthState === 'healthy') return this.checkpoint.releases[label];
    const checkpoint = this.checkpoint.releases[label] ??= {};
    if (!checkpoint.releaseId) { const release = await this.api('POST', `${this.root}/releases`, {}); if (release.manifestHash !== expectedManifest) throw new Error('release prepared a different accepted manifest'); checkpoint.releaseId = release.releaseId; await this.save(); }
    const path = `/orgs/${this.config.organizationId}/releases/${checkpoint.releaseId}`;
    const built = await this.waitFor(() => this.api('GET', path), r => r.buildState === 'ready' || !!r.outputDigest, 'real cloud release build');
    if (built.envDigest !== configDigest(this.contracts.environment) || built.manifestHash !== expectedManifest || built.targets.length !== 1 || built.targets[0].workerName !== this.contracts.workerName || built.targets[0].config.kvNamespaces.length || built.targets[0].config.d1Databases?.length) throw new Error('release build escaped exact manifest/vars-only CI target');
    if (!built.publishApproved) await this.api('POST', `${path}/publish-approvals`, { outputDigest: built.outputDigest });
    let current = await this.api('GET', path);
    if (!current.live && !['deploying', 'health_verification'].includes(current.state)) await this.api('POST', `${path}/deploy`, { idempotencyKey: `live-deploy-${this.config.runId}-${label}` });
    current = await this.waitFor(() => this.api('GET', path), r => r.live && r.healthState === 'healthy', 'actual deployed release observation');
    const deployment = current.deployments[0]; if (!deployment || deployment.workerName !== this.contracts.workerName) throw new Error('deployed target mismatch');
    const deploymentUrl = new URL(deployment.url); if (deploymentUrl.protocol !== 'https:' || !deploymentUrl.hostname.startsWith(`${this.contracts.workerName}.`) || !deploymentUrl.hostname.endsWith('.workers.dev')) throw new Error('release receipt URL escapes exact isolated CI Worker');
    const response = await fetch(`${deployment.url.replace(/\/$/, '')}/version`, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const observed = await response.json() as { release?: string; variant?: string }; if (!response.ok || observed.release !== current.releaseId) throw new Error('live target does not identify the exact release');
    const deployedScenarios = [];
    for (const [scenarioId, input, expected] of cases) {
      const live = await fetch(`${deployment.url.replace(/\/$/, '')}/reschedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: '2026-10-17T12:00:00.000Z', ...input }), redirect: 'manual', signal: AbortSignal.timeout(15000) });
      const actual = await live.json(); if (!live.ok || canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`actual deployed scheduling scenario failed: ${scenarioId}`);
      deployedScenarios.push({ scenarioId, result: 'pass', execution: 'actual Cloudflare HTTPS Worker', releaseId: current.releaseId, outputDigest: current.outputDigest });
    }
    const recorded = (await this.state()).observations.find(o => o.releaseId === current.releaseId && o.manifestHash === expectedManifest && o.buildDigest === current.outputDigest && o.result === 'healthy');
    if (!recorded) throw new Error('actual release observation is not durably bound to exact accepted manifest and output');
    Object.assign(checkpoint, current, { liveVersionObservation: observed, deployedScenarios, recordedObservationId: recorded.id }); await this.save(); return checkpoint;
  }
  async run() { this.phase = 'run'; if (!this.checkpoint.setupComplete) throw new Error('setup registration required'); await this.verifySupervisor(); await this.knowledge(); const source = await this.sourceCycle('initial'); return this.release('initial', source.acceptedManifest); }
  async expiry() {
    this.phase = 'expiry'; const initial = this.checkpoint.releases.initial; if (!initial?.freshUntil) throw new Error('initial observed release required');
    const current = await this.api('GET', `/orgs/${this.config.organizationId}/releases/${initial.releaseId}`);
    if (Date.now() <= Date.parse(initial.freshUntil)) return { status: 'not_run', reason: 'actual freshness deadline not reached', waitUntil: initial.freshUntil };
    if (current.healthState !== 'unknown') throw new Error('expired release observation remains falsely healthy');
    this.checkpoint.expiry = { releaseId: current.releaseId, observedAt: new Date().toISOString(), freshUntil: initial.freshUntil, healthState: current.healthState, actualClock: true }; await this.save(); return this.checkpoint.expiry;
  }
  async recover() {
    this.phase = 'recover'; if (!this.checkpoint.expiry) throw new Error('observe actual first-release expiry before recovery phase'); await this.verifySupervisor();
    const later = await this.sourceCycle('later'); await this.release('later', later.acceptedManifest);
    const before = await this.state(); const initial = this.checkpoint.cycles.initial;
    if (!this.checkpoint.recovery?.proposalId) { const prepared = await this.api('POST', `${this.native}/recoveries`, { manifestHash: initial.acceptedManifest, expectedGeneration: before.generation, idempotencyKey: 'live-historical-recovery' }); this.checkpoint.recovery = { proposalId: prepared.proposal.id, beforeKnowledgeHead: before.knowledgeHead, beforeKnowledge: before.knowledge }; await this.save(); }
    const recovery = await this.verifyAccept(this.checkpoint.recovery.proposalId, 'historical-recovery'); const state = await this.state();
    if (state.knowledgeHead !== this.checkpoint.recovery.beforeKnowledgeHead || canonicalJson(state.knowledge) !== canonicalJson(this.checkpoint.recovery.beforeKnowledge) || canonicalJson(recovery.sourceHeads) !== canonicalJson(initial.sourceHeads)) throw new Error('historical source recovery changed current knowledge or exact artifacts');
    Object.assign(this.checkpoint.recovery, recovery); await this.save();
    const released = await this.release('recovery', recovery.acceptedManifest); if (released.liveVersionObservation.variant !== 'initial') throw new Error('recovery deployment did not run historical variant'); return this.inspect();
  }
  async inspect() {
    this.phase = 'inspect'; const state = await this.state();
    const releases = await this.api('GET', `${this.root}/releases`);
    const report = { schemaVersion: 1, mode: 'actual-isolated-cloud-api', controlWorker: this.config.controlWorker, releaseWorker: this.contracts.workerName,
      organizationId: this.config.organizationId, projectId: this.checkpoint.projectId, resourceId: this.checkpoint.resourceId,
      cycles: Object.fromEntries(Object.entries(this.checkpoint.cycles).map(([label, c]) => [label, { acceptedManifest: c.acceptedManifest ?? null, sourceHeads: c.sourceHeads ?? null, envelopeDigest: c.envelopeDigest ?? null, knowledgeHead: c.knowledgeHead ?? null, contextDigest: c.contextDigest ?? null, scenarioCount: c.evidence?.length ?? 0 }])),
      releases: Object.fromEntries(Object.entries(this.checkpoint.releases).map(([label, r]) => [label, { releaseId: r.releaseId, manifestHash: r.manifestHash, acceptedVersionId: r.acceptedVersionId, outputDigest: r.outputDigest, envDigest: r.envDigest, healthStateAtObservation: r.healthState, freshUntil: r.freshUntil, liveVersionObservation: r.liveVersionObservation, deployedScenarios: r.deployedScenarios, recordedObservationId: r.recordedObservationId }])),
      expiry: this.checkpoint.expiry ?? { result: 'not_run' }, recovery: this.checkpoint.recovery ? { proposalId: this.checkpoint.recovery.proposalId, acceptedManifest: this.checkpoint.recovery.acceptedManifest ?? null, sourceHeads: this.checkpoint.recovery.sourceHeads ?? null, knowledgePreserved: state.knowledgeHead === this.checkpoint.recovery.beforeKnowledgeHead } : null,
      currentManifest: state.manifests.at(-1)?.hash, currentKnowledgeHead: state.knowledgeHead, verifierDigest: this.checkpoint.verifierDigest, runtimeRecipeDigest: this.checkpoint.runtimeRecipeDigest, observations: state.observations,
      liveReleaseId: releases.live?.releaseId ?? null,
      gates: { actualInitialCloudRelease: this.checkpoint.releases.initial?.healthState === 'healthy' ? 'pass' : 'not_run', actualFreshnessExpiry: this.checkpoint.expiry ? 'pass' : 'not_run', actualRecoveryCloudRelease: this.checkpoint.releases.recovery?.healthState === 'healthy' ? 'pass' : 'not_run' },
      noProductionTarget: true, newPersistentInfrastructureProvisioned: false, noExternalEffectsReversed: true };
    await writeFile(join(this.directory, 'public-report.json'), JSON.stringify(report, null, 2)); return report;
  }
}
export async function cloudFixtureFiles(variant: 'initial' | 'later') {
  let worker = await readFile(new URL('../../../fixtures/scheduling/worker.mjs', import.meta.url), 'utf8');
  worker = `export const LIVE_VARIANT = '${variant}';\n` + worker.replace('async fetch(request)', 'async fetch(request, env)');
  worker = worker.replace("if (url.pathname === '/health')", "if (url.pathname === '/version') return Response.json({ release: env.COMMONFORGE_RELEASE_ID ?? null, version: env.APP_VERSION, variant: LIVE_VARIANT });\n    if (url.pathname === '/health')");
  const build = "import{mkdir,readFile,writeFile}from'node:fs/promises';await mkdir('dist',{recursive:true});const source=await readFile('worker.mjs','utf8');await writeFile('dist/worker.mjs',source.replaceAll('export const ','const ').replaceAll('export function ','function '));\n";
  return { 'worker.mjs': worker, 'build.mjs': build, 'wrangler.json': JSON.stringify({ main: 'worker.mjs', compatibility_date: '2026-10-01', vars: {} }) };
}
async function main() {
  const phase = process.argv[2], path = process.argv[3];
  if (!phase || !path || !['plan', 'setup', 'run', 'expiry', 'recover', 'inspect'].includes(phase)) throw new Error('usage: g1-cloud-rehearsal.ts plan|setup|run|expiry|recover|inspect <private-config.json>');
  const config = G1CloudRehearsalConfigSchema.parse(JSON.parse(await readFile(resolve(path), 'utf8')));
  if (phase === 'plan') { process.stdout.write(JSON.stringify(cloudRehearsalPlan(config), null, 2) + '\n'); return; }
  const rehearsal = new G1CloudRehearsal(config); await rehearsal.open();
  const result = await (rehearsal[phase as 'setup' | 'run' | 'expiry' | 'recover' | 'inspect'])();
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(error => { let message = error instanceof Error ? error.message : String(error); for (const secret of rememberedSecrets) message = message.replaceAll(secret, '<redacted>'); process.stderr.write(message + '\n'); process.exitCode = 1; });
