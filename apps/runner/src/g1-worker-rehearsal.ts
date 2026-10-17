/** Concrete public API + real Git rehearsal against scripts/dev-real-worker.sh. No fixture API. */
import { copyFile, lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGit, RUNNER_IDENTITY_ENV } from './git.js';
import { inspectIsolatedHealth } from './g1-local-verifier.js';
import { cases } from './g1-scheduling-harness.js';
interface Operator { sidecarUrl: string; sidecarKey: string; bridgeUrl: string; workerUrl: string; namespacePrefix: string }
export async function rehearseWorker(operatorFile: string, logFile: string, options: { selfDevelopment?: boolean; ownerSessionFile?: string; preview?: boolean } = {}) {
  const operator = JSON.parse(await readFile(operatorFile, 'utf8')) as Operator;
  const root = await mkdtemp(join(tmpdir(), 'commonforge-g1-worker-rehearsal-'));
  process.stderr.write(`real Worker rehearsal artifacts: ${root}\n`);
  const events: Array<{ operation: string; status: number }> = [];
  let ownerToken = '';
  async function api(method: string, path: string, body?: unknown, token = ownerToken): Promise<any> {
    const res = await fetch(`${operator.workerUrl}/api${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    events.push({ operation: `${method} ${path}`, status: res.status });
    const result = await res.json(); if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(result)}`); return result;
  }
  async function waitFor<T>(operation: () => Promise<T>, accepted: (v: T) => boolean, label: string, timeout = 60000): Promise<T> {
    const end = Date.now() + timeout; let last: T | undefined;
    while (Date.now() < end) { last = await operation(); if (accepted(last)) return last; await new Promise(r => setTimeout(r, 250)); }
    throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
  }
  let login: any;
  if (options.ownerSessionFile) {
    ownerToken = JSON.parse(await readFile(options.ownerSessionFile, 'utf8')).ownerToken;
    login = await api('GET', '/me');
  } else {
    await api('POST', '/auth/magic-link', { email: 'owner@agency.e2e.test', client: 'cli' }, '');
    const code = await waitFor(async () => (await readFile(logFile, 'utf8')).match(/magic link for owner@agency\.e2e\.test: .*?[?&](?:code|token)=(cfm_[A-Za-z0-9_-]+)/g)?.at(-1)?.match(/(cfm_[A-Za-z0-9_-]+)/)?.[1], v => !!v, 'local magic link');
    login = await api('POST', '/auth/cli/verify', { code }, ''); ownerToken = login.sessionToken;
  }
  const org = await api('POST', '/orgs', { name: 'G1 real-source rehearsal' }), orgId = org.orgId;
  const project = await api('POST', `/orgs/${orgId}/projects`, { name: options.selfDevelopment ? 'CommonForge own development' : 'Synthetic scheduling' }), projectId = project.projectId;
  const resource = await api('POST', `/orgs/${orgId}/resources`, { name: 'Scheduling fixture', provider: 'artifacts' });
  let sourceSnapshot: { commit: string; fileCount: number; exclusions: string[] } | null = null;
  if (options.selfDevelopment) {
    const publicRepo = fileURLToPath(new URL('../../../', import.meta.url));
    const seed = join(root, 'public-source-snapshot'); await mkdir(seed);
    const git = createGit({ allowHttp: true });
    const paths = (await git.ok(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], publicRepo)).split('\0').filter(Boolean);
    let fileCount = 0; const exclusions: string[] = [];
    for (const path of paths) {
      if (/(?:^|\/)(?:\.env(?:$|\.)|\.dev\.vars|credentials|node_modules|\.wrangler|\.g1-artifacts)(?:\/|$)/.test(path) || path.startsWith('.git/')) { exclusions.push(path); continue; }
      const source = join(publicRepo, path), stat = await lstat(source).catch(() => null);
      if (!stat?.isFile()) { exclusions.push(path); continue; }
      await mkdir(dirname(join(seed, path)), { recursive: true }); await copyFile(source, join(seed, path)); fileCount++;
    }
    await git.ok(['init', '-q', '-b', 'main'], seed); await git.ok(['add', '.'], seed);
    await git.ok(['commit', '-q', '-m', 'Isolated public CommonForge source snapshot for G1 self-development'], seed, { env: RUNNER_IDENTITY_ENV(new Date().toISOString()) });
    const tokenResponse = await fetch(`${operator.sidecarUrl}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${operator.sidecarKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'createToken', args: [resource.coords.namespace, resource.coords.repoName, 'write', 300] }) });
    if (!tokenResponse.ok) throw new Error('real source bootstrap credential refused');
    const token = (await tokenResponse.json() as { result: { plaintext: string; id: string } }).result;
    await git.ok(['push', '-q', resource.coords.remoteUrl, 'HEAD:refs/heads/main'], seed, { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${resource.coords.remoteUrl}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}` } });
    await fetch(`${operator.sidecarUrl}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${operator.sidecarKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'revokeToken', args: [resource.coords.namespace, resource.coords.repoName, token.id] }) });
    sourceSnapshot = { commit: (await git.ok(['rev-parse', 'HEAD'], seed)).trim(), fileCount, exclusions };
  } else {
    const rpc = await fetch(`${operator.sidecarUrl}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${operator.sidecarKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'seedScheduling', args: [resource.coords.namespace, resource.coords.repoName] }) });
    if (!rpc.ok) throw new Error('real Git fixture bootstrap failed');
  }
  await api('POST', `/orgs/${orgId}/resources/${resource.resourceId}/adopt-head`, {});
  await api('POST', `/orgs/${orgId}/projects/${projectId}/mounts`, { mountName: 'app', resourceId: resource.resourceId, operations: ['read', 'write'] });
  if (options.preview) await api('PUT', `/orgs/${orgId}/projects/${projectId}/policy`, { preview: { recipe: { recipeId: 'scheduling-preview', revision: 1, steps: [{ stepId: 'build', mountName: 'app', command: 'node build.mjs' }], output: { mountName: 'app', path: 'dist' } }, bundles: [{ name: 'api', mountName: 'app', path: 'dist' }], hostVars: {}, ttlSeconds: 3600 } });
  const native = `/orgs/${orgId}/projects/${projectId}/native`;
  let state = (await api('POST', `${native}/enable`, { idempotencyKey: 'enable' })).state;
  await writeFile(join(root, 'owner-session.json'), JSON.stringify({ ownerToken, organizationId: orgId, projectId, resourceId: resource.resourceId }), { mode: 0o600 });
  const author = login.user.userId;
  const base = (id: string) => ({ schemaVersion: 1, organizationId: orgId, projectId, id, author, createdAt: new Date().toISOString() });
  async function command(command: Record<string, unknown>): Promise<any> { const result = await api('POST', `${native}/commands`, { ...command, expectedGeneration: state.generation, idempotencyKey: `cmd-${state.generation}` }); state = result.state; return result; }
  await command({ type: 'draftKnowledge', record: { ...base('reschedule-rule'), revision: 1, predecessor: null, kind: 'rule', text: 'Customers may reschedule at least 24 hours before an appointment, before travel begins.', rationale: 'Owner requested deterministic scheduling rules', sources: [{ kind: 'text', ref: 'Synthetic owner request', digest: null }], confirmation: null, archived: false } });
  await command({ type: 'confirmKnowledge', id: 'reschedule-rule', revision: 1, decisionId: 'confirm-initial-rule', explanation: 'Confirmed explicit cutoff and travel boundary' });
  const capability = await (await fetch(`${operator.bridgeUrl}/capabilities`)).json() as { verifierDigest: string };
  for (const [id] of cases.slice(0, 4)) {
    await command({ type: 'draftScenario', record: { ...base(id), revision: 1, predecessor: null, title: id, given: 'Synthetic UTC clock and appointment', when: 'A customer requests rescheduling', then: 'Enforce the cutoff and travel rule', ruleRefs: [{ id: 'reschedule-rule', revision: 2 }], required: true, method: 'automated', verifierDigest: capability.verifierDigest, confirmation: null, archived: false } });
    await command({ type: 'confirmScenario', id, revision: 1, decisionId: `confirm-${id}`, explanation: 'Confirmed synthetic behavioral example' });
  }
  await command({ type: 'upsertOutcome', record: { ...base('health-metadata-outcome'), revision: 1, description: 'Expose the scheduling rule version in fixture health while preserving the owner correction.', owner: author, successCriteria: ['Health reports the implementation rule version', 'All confirmed scheduling scenarios still pass'], state: 'open', taskIds: [] } });
  async function cycle(label: string, edit: (source: string) => string) {
    const task = await api('POST', `/orgs/${orgId}/projects/${projectId}/tasks`, { title: label, request: label, writeMounts: ['app'] });
    const ready = await waitFor(() => api('GET', `/tasks/${task.taskId}`), t => t.state === 'ready', 'real task seeding');
    const handoff = await api('POST', `/tasks/${task.taskId}/native/handoff`, { agentId: `rehearsal-${label}` });
    const agent = await api('POST', '/auth/task/verify', { code: handoff.code }, '');
    const context = await api('GET', `/tasks/${task.taskId}/native/context`, undefined, agent.leaseToken);
    const credential = await api('POST', `/tasks/${task.taskId}/credential`, { mountName: 'app', access: 'write' }, agent.leaseToken);
    const work = join(root, `work-${label}`), git = createGit({ allowHttp: true });
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${credential.remoteUrl}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.secret}` };
    await git.ok(['clone', '-q', credential.remoteUrl, work], root, { env });
    const workerPath = join(work, options.selfDevelopment ? 'fixtures/scheduling/worker.mjs' : 'worker.mjs');
    await writeFile(workerPath, edit(await readFile(workerPath, 'utf8')));
    await git.ok(['add', '.'], work); await git.ok(['commit', '-q', '-m', label], work, { env: RUNNER_IDENTITY_ENV(new Date().toISOString()) });
    const sha = (await git.ok(['rev-parse', 'HEAD'], work)).trim(); await git.ok(['push', '-q', 'origin', 'HEAD:refs/heads/main'], work, { env });
    const ws = ready.workspaces.find((w: any) => w.mountName === 'app');
    const candidate = await api('POST', `/tasks/${task.taskId}/workspaces/${ws.taskWorkspaceId}/freeze`, { expectedSha: sha, tool: 'g1-real-api-rehearsal' }, agent.leaseToken);
    const inner = await api('POST', `/orgs/${orgId}/proposals`, { taskId: task.taskId, candidateIds: [candidate.candidateId] });
    await waitFor(() => api('GET', `/orgs/${orgId}/proposals/${inner.proposalId}`), p => p.state === 'prepared', 'candidate preparation');
    await api('POST', `/orgs/${orgId}/proposals/${inner.proposalId}/integrate`, {});
    await waitFor(() => api('GET', `/orgs/${orgId}/proposals/${inner.proposalId}`), p => !!p.integration, 'real Node integration');
    state = (await api('GET', native)).state;
    const outer = await api('POST', `/tasks/${task.taskId}/native/proposals`, { innerProposalId: inner.proposalId, expectedGeneration: state.generation, idempotencyKey: `outer-${label}` }, agent.leaseToken);
    state = outer.state;
    const verified = await api('POST', `${native}/proposals/${encodeURIComponent(outer.proposal.id)}/verify`, { idempotencyKey: `verify-${label}` }); state = verified.state;
    if (!verified.evidence.every((e: any) => e.result === 'pass')) throw new Error('trusted scenarios did not pass');
    const health = await inspectIsolatedHealth(dirname(workerPath)) as { ruleVersion?: number };
    if (health.ruleVersion !== (label === 'initial' ? 1 : 2)) throw new Error('independent health metadata observation failed');
    const proposal = outer.proposal;
    await command({ type: 'recordDecision', record: { ...base(`approve-${label}`), envelopeDigest: proposal.digest, innerProposalHash: proposal.envelope.innerProposalHash, action: 'approve', explanation: 'Reviewed exact real runner behavior', authorityRevision: state.authorities.find((a: any) => a.principalId === author).revision } });
    await command({ type: 'accept', proposalId: proposal.id, decisionId: `approve-${label}` });
    return { taskId: task.taskId, innerProposalId: inner.proposalId, proposalId: proposal.id, contextDigest: agent.context.digest, contextRuleRevisions: context.context.packet.rules.map((r: any) => ({ id: r.id, revision: r.revision })), sourceRevision: sha, supplementalObservedHealth: health, scenarioCount: verified.evidence.length, acceptedManifest: state.manifests.at(-1).hash };
  }
  const initial = await cycle('initial', source => source.replace('fixture: true, clock: CLOCK', 'fixture: true, ruleVersion: 1, clock: CLOCK'));
  await command({ type: 'draftKnowledge', record: { ...base('reschedule-rule'), revision: 3, predecessor: 2, kind: 'rule', text: 'Managers may override the 24-hour cutoff only with a retained nonempty reason. Travel still blocks everybody.', rationale: 'Owner correction persists beyond the original attempt', sources: [{ kind: 'text', ref: 'Synthetic owner correction', digest: null }], confirmation: null, archived: false } });
  await command({ type: 'confirmKnowledge', id: 'reschedule-rule', revision: 3, decisionId: 'confirm-manager-correction', explanation: 'Require manager exception and retain reason' });
  for (const [id] of cases.slice(4)) {
    await command({ type: 'draftScenario', record: { ...base(id), revision: 1, predecessor: null, title: id, given: 'Synthetic manager/customer and appointment', when: 'Rescheduling is requested', then: 'Preserve authorization, reason, and travel restriction', ruleRefs: [{ id: 'reschedule-rule', revision: 4 }], required: true, method: 'automated', verifierDigest: capability.verifierDigest, confirmation: null, archived: false } });
    await command({ type: 'confirmScenario', id, revision: 1, decisionId: `confirm-${id}`, explanation: 'Confirmed corrected behavioral example' });
  }
  const corrected = await cycle('corrected', source => source.replace('ruleVersion: 1', 'ruleVersion: 2'));
  let previewEvidence: unknown = null;
  if (options.preview) {
    const queued = await api('POST', `/orgs/${orgId}/proposals/${corrected.innerProposalId}/previews`, {});
    const ready = await waitFor(() => api('GET', `/orgs/${orgId}/previews/${queued.previewId}`), p => p.state === 'ready', 'real control-plane preview');
    const staticResponse = await fetch(ready.url);
    if (!staticResponse.ok || !(await staticResponse.text()).includes('Synthetic scheduling')) throw new Error('real R2 static preview failed');
    const healthResponse = await fetch(`${ready.url}api/health`);
    const health = await healthResponse.json() as { ruleVersion?: number };
    if (!healthResponse.ok || health.ruleVersion !== 2) throw new Error('real isolated API preview health failed');
    const managerResponse = await fetch(`${ready.url}api/reschedule`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actor: 'manager', appointment: '2026-10-17T13:00:00.000Z', reason: 'Preview override' }) });
    const manager = await managerResponse.json() as { allowed?: boolean; override?: {reason?:string} };
    if (!managerResponse.ok || !manager.allowed || manager.override?.reason !== 'Preview override') throw new Error('real isolated API preview manager rule failed');
    previewEvidence = { previewId: queued.previewId, sourceBinding: ready.integrationSha ?? null, separateOrigin: new URL(ready.url).origin !== new URL(operator.workerUrl).origin, staticHttpStatus: staticResponse.status, apiHealth: health, managerResponse: manager, execution: 'real Worker preview authorization + local R2 + isolated Node HTTP module', privateLinkExcluded: true };
  }
  const report = { mode: 'real-local-worker-api', root, ownDevelopmentProject: !!options.selfDevelopment, sourceSnapshot, previewEvidence, workerUrl: operator.workerUrl, organizationId: orgId, projectId, resourceId: resource.resourceId, initial, corrected,
    gates: { realSourceApiWorkflow: 'pass', independentlyVerifiedBehavior: 'pass', persistedCorrectionInLaterContext: 'pass', atomicAcceptance: 'pass', freshAgent: 'not_run', cloudRelease: 'not_run', browserOwnerJourney: 'not_run' }, events };
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2));
  // Local-only bootstrap for browser review; never exported as project context or committed.
  await writeFile(join(root, 'owner-session.json'), JSON.stringify({ ownerToken, organizationId: orgId, projectId }), { mode: 0o600 });
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void rehearseWorker(process.argv[2]!, process.argv[3]!, { selfDevelopment: process.argv.includes('--self-development'), ownerSessionFile: process.env.G1_OWNER_SESSION_FILE, preview: process.argv.includes('--preview') }).then(r => process.stdout.write(`${JSON.stringify(r, null, 2)}\n`)).catch(e => { process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`); process.exitCode = 1; });
