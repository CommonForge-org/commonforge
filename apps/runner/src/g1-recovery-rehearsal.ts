/** Post-browser real recovery proof: authoritative state, Git smart HTTP and isolated restored behavior. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, parseRevisionId, ProjectStateSchema } from '@commonforge-org/core';
import { createGit } from './git.js';
import { inspectIsolatedHealth, verifySchedulingCandidate } from './g1-local-verifier.js';

interface OwnerSession { ownerToken: string; organizationId: string; projectId: string }
interface Operator { workerUrl: string; sidecarUrl: string; sidecarKey: string }
interface BrowserEvidence { organizationId: string; projectId: string; historicalManifest: string; acceptedManifest: string; sourceHeads: Array<{ resourceId: string; revisionId: string }>; knowledgeHead: string; scenarioCount: number }
export async function inspectRecoveredSource(ownerFile: string, operatorFile: string, browserFile: string) {
  const owner = JSON.parse(await readFile(ownerFile, 'utf8')) as OwnerSession;
  const operator = JSON.parse(await readFile(operatorFile, 'utf8')) as Operator;
  const browser = JSON.parse(await readFile(browserFile, 'utf8')) as BrowserEvidence;
  if (owner.organizationId !== browser.organizationId || owner.projectId !== browser.projectId) throw new Error('owner/recovery project scope mismatch');
  const api = async (path: string) => {
    const response = await fetch(`${operator.workerUrl}/api${path}`, { headers: { authorization: `Bearer ${owner.ownerToken}` } });
    if (!response.ok) throw new Error(`recovery read HTTP ${response.status}`); return response.json();
  };
  const rpc = async <T>(method: string, args: unknown[]): Promise<T> => {
    const response = await fetch(`${operator.sidecarUrl}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${operator.sidecarKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }) });
    if (!response.ok) throw new Error(`real source operation ${method} HTTP ${response.status}`); return (await response.json() as { result: T }).result;
  };
  const initial = await api(`/orgs/${owner.organizationId}/projects/${owner.projectId}/native`) as { state: unknown };
  const state = ProjectStateSchema.parse(initial.state), accepted = state.manifests.at(-1);
  const target = state.manifests.find(m => m.hash === browser.historicalManifest);
  const proposal = state.proposals.find(p => p.digest === accepted?.envelopeDigest);
  if (!accepted || !target || !proposal || proposal.envelope.recovery?.manifestHash !== target.hash || accepted.hash !== browser.acceptedManifest || accepted.behavior !== 'verified') throw new Error('exact recovery acceptance binding absent');
  if (canonicalJson(state.sourceHeads) !== canonicalJson(target.sourceHeads) || canonicalJson(state.sourceHeads) !== canonicalJson(browser.sourceHeads) || state.knowledgeHead !== browser.knowledgeHead || accepted.knowledgeHead !== state.knowledgeHead) throw new Error('recovery changed current knowledge or source mapping');
  const evidence = accepted.evidenceIds.map(id => state.evidence.find(e => e.id === id));
  if (evidence.length !== browser.scenarioCount || evidence.length !== 9 || evidence.some(e => !e || e.result !== 'pass' || e.provenance !== 'runner-verified' || e.envelopeDigest !== proposal.digest || e.buildDigest !== proposal.envelope.buildDigest || e.runtimeRecipeDigest !== proposal.envelope.runtimeRecipeDigest)) throw new Error('fresh required verified evidence unavailable');
  const root = await mkdtemp(join(tmpdir(), 'g1-recovery-readonly-'));
  const sourceChecks: Array<Record<string, unknown>> = [];
  try {
    for (const head of state.sourceHeads) {
      const parsed = parseRevisionId(head.revisionId); if (parsed.kind !== 'art') throw new Error('real Git Artifacts-compatible revision required');
      let resource: any; const end = Date.now() + 90000;
      do {
        resource = await api(`/orgs/${owner.organizationId}/resources/${head.resourceId}`);
        if (resource.head?.revisionId === head.revisionId && resource.head.reconciliation === 'synced') break;
        await new Promise(resolve => setTimeout(resolve, 250));
      } while (Date.now() < end);
      if (resource.head?.revisionId !== head.revisionId || resource.head.reconciliation !== 'synced') throw new Error('restored Git ref reconciliation did not become synced');
      const token = await rpc<{ id: string; plaintext: string }>('createToken', [resource.coords.namespace, resource.coords.repoName, 'read', 300]);
      let observedSha: string;
      try {
        const git = createGit({ allowHttp: true });
        const refs = await git.ok(['ls-remote', resource.coords.remoteUrl, `refs/heads/${resource.branch ?? 'main'}`], root, { env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${resource.coords.remoteUrl}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}` } });
        observedSha = refs.trim().split(/\s+/)[0]!;
        if (observedSha !== parsed.sha) throw new Error('actual Git smart HTTP canonical ref differs from restored accepted source');
      } finally { await rpc('revokeToken', [resource.coords.namespace, resource.coords.repoName, token.id]); }
      let path = 'worker.mjs';
      let data = await rpc<{ bytes: string } | null>('readFile', [resource.coords.namespace, resource.coords.repoName, parsed.sha, path]);
      if (!data) { path = 'fixtures/scheduling/worker.mjs'; data = await rpc<{ bytes: string } | null>('readFile', [resource.coords.namespace, resource.coords.repoName, parsed.sha, path]); }
      if (!data) throw new Error('restored source module absent');
      const bytes = Buffer.from(data.bytes, 'base64'); await writeFile(join(root, 'worker.mjs'), bytes, { mode: 0o400 });
      const repeated = await verifySchedulingCandidate(root);
      if (repeated.results.length !== 9 || repeated.results.some(r => r.result !== 'pass')) throw new Error('exact restored canonical source fails independent namespace scenarios');
      const health = await inspectIsolatedHealth(root) as { ruleVersion?: number; reviewReady?: boolean };
      if (health.ruleVersion !== 2 || health.reviewReady !== undefined) throw new Error('recovery did not restore corrected historical fixture health exactly');
      sourceChecks.push({ resourceId: head.resourceId, revisionId: head.revisionId, canonicalGitSha: observedSha, actualGitSmartHttp: 'pass', reconciliation: resource.head.reconciliation,
        implementationPath: path, moduleDigest: createHash('sha256').update(bytes).digest('hex'), isolatedHealth: health, repeatedScenarioResults: repeated.results, execution: repeated.execution, network: repeated.network, controlPlaneMounted: repeated.controlPlaneMounted });
    }
    const final = ProjectStateSchema.parse((await api(`/orgs/${owner.organizationId}/projects/${owner.projectId}/native`) as { state: unknown }).state);
    if (final.knowledgeHead !== state.knowledgeHead || canonicalJson(final.knowledge) !== canonicalJson(state.knowledge) || canonicalJson(final.sourceHeads) !== canonicalJson(state.sourceHeads)) throw new Error('project authority changed while observing recovery');
    return { schemaVersion: 1, execution: 'real-browser-acceptance-followed-by-real-Git-and-isolated-HTTP', organizationId: owner.organizationId, projectId: owner.projectId,
      historicalManifest: target.hash, recoveryAcceptedManifest: accepted.hash, recoveryEnvelopeDigest: proposal.digest, acceptedArtifactVersion: sourceChecks.length ? (await api(`/orgs/${owner.organizationId}/resources/${state.sourceHeads[0]!.resourceId}`) as any).head.acceptedVersionId : null,
      knowledgeHead: state.knowledgeHead, knowledgeGeneration: state.knowledgeGeneration, knowledgePreserved: true, exactHistoricalSourceRestored: true,
      evidence: evidence.map(e => ({ id: e!.id, runId: e!.runId, scenarioId: e!.scenarioId, scenarioRevision: e!.scenarioRevision, verifierDigest: e!.verifierDigest, result: e!.result, provenance: e!.provenance, envelopeDigest: e!.envelopeDigest, buildDigest: e!.buildDigest })),
      sourceChecks, gates: { ownerBrowserRecovery: 'pass', freshSignedScenarios: 'pass', exactAcceptedHistoricalRefs: 'pass', realGitReconciliation: 'pass', independentRestoredRuntime: 'pass', currentKnowledgePreserved: 'pass', cloudDeployment: 'not_run' }, releaseClaimed: false, externalEffectsReversed: false };
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1]?.endsWith('g1-recovery-rehearsal.ts') || process.argv[1]?.endsWith('g1-recovery-rehearsal.js')) {
  void inspectRecoveredSource(process.argv[2]!, process.argv[3]!, process.argv[4]!).then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)).catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
}
