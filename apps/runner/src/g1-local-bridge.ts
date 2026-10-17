/** Local-only, signed G1 verifier bridge over real LocalGitProvider revisions. */
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashCanonicalSync, type RevisionId, type ScenarioEvidence } from '@commonforge-org/core';
import { LocalGitProvider } from '@commonforge-org/provider-local-git';
import { signScenarioResult, verifyScenarioRequest, type JobSigningKey } from '@commonforge-org/runner-protocol';
import { schedulingVerifierDigest, verifySchedulingCandidate, type LocalScenarioResult } from './g1-local-verifier.js';
import { cases } from './g1-scheduling-harness.js';

export const SCHEDULING_RUNTIME_RECIPE_DIGEST = hashCanonicalSync({ domain: 'cf.local-scheduling-runtime/1', runtime: 'node-http', nodeVersion: process.versions.node, architecture: process.arch, isolation: 'bubblewrap-linux', clock: '2026-10-17T12:00:00.000Z', timezone: 'UTC' });
export interface ScenarioRuntimeAdapter {
  actor?: string; runtimeRecipeDigest: string; verifierDigest: string; scenarioIds: string[]; sourceFiles: string[];
  verify(files: Record<string, Uint8Array>): Promise<{verifierDigest?:string;runtimeRecipeDigest?:string;results:LocalScenarioResult[];execution:'bubblewrap-linux-http';network:'none';controlPlaneMounted:false}>;
}
export interface LocalBridgeOptions {
  provider?: LocalGitProvider; jobKey: JobSigningKey; port?: number;
  /** Operator config, not caller-selected local paths. */
  readCandidate?: (request: import('@commonforge-org/runner-protocol').ScenarioVerificationRequest) => Promise<Uint8Array>;
  /** Pinned operator runtime, never populated from an incoming request. */
  runtime?: ScenarioRuntimeAdapter;
  readCandidateFiles?: (request: import('@commonforge-org/runner-protocol').ScenarioVerificationRequest, paths: string[]) => Promise<Record<string,Uint8Array>>;
  resources: Array<{ organizationId: string; projectId: string; resourceId: string; workerPath?: string }>;
}
export async function startLocalScenarioBridge(options: LocalBridgeOptions): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const verifierDigest = options.runtime?.verifierDigest ?? await schedulingVerifierDigest();
  const runtimeRecipeDigest=options.runtime?.runtimeRecipeDigest??SCHEDULING_RUNTIME_RECIPE_DIGEST;
  const scenarioIds=options.runtime?.scenarioIds??cases.map(c=>c[0]);
  const runs = new Map<string, { digest: string; result: Promise<unknown> }>();
  const server = createServer((req, res) => {
    const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    void (async () => {
      if (req.headers.origin) return send(403, { error: 'browser requests refused' });
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/capabilities')) return send(200, {
        mode: 'real-local', protocolVersion: 1, verifierDigest, runtimeRecipeDigest,
        scenarioIds, isolation: 'bubblewrap-linux-http', cloudRelease: false,
      });
      if (req.method !== 'POST' || req.url !== '/verify') return send(404, { error: 'not_found' });
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += (chunk as Buffer).length; if (bytes > 262144) return send(413, { error: 'body_too_large' }); chunks.push(chunk as Buffer); }
      const request = await verifyScenarioRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')), options.jobKey);
      if (request.runtimeRecipeDigest !== runtimeRecipeDigest || request.sourceHeads.length !== 1 || request.requiredScenarios.some(s => s.method !== 'automated' || s.verifierDigest !== verifierDigest || !scenarioIds.includes(s.id))) return send(422, { error: 'unsupported_pinned_verifier' });
      const head = request.sourceHeads[0]!;
      const registration = options.resources.find(r => r.organizationId === request.organizationId && r.projectId === request.projectId && r.resourceId === head.resourceId);
      if ((!registration || !options.provider) && !options.readCandidate && !options.readCandidateFiles) return send(403, { error: 'resource_scope_denied' });
      const digest = hashCanonicalSync(request);
      const previous = runs.get(request.runId);
      if (previous && previous.digest !== digest) return send(409, { error: 'run_id_conflict' });
      if (!previous && runs.size >= 1000) return send(503, { error: 'run_limit_reached_restart_or_rotate_bridge' });
      const execute = async () => {
        const paths=options.runtime?.sourceFiles??[registration?.workerPath??'worker.mjs'];
        const files=options.readCandidateFiles ? await options.readCandidateFiles(request,paths) : options.readCandidate ? (()=>{if(options.runtime)throw new Error('runtime requires complete exact source files');return null;})() : null;
        const sourceFiles=files??await (async()=>{
          if(options.readCandidate)return {[paths[0]!]:await options.readCandidate(request)};
          const resource=await options.provider!.openCanonicalResource(registration!.organizationId,registration!.resourceId);
          if(!resource)throw new Error('registered resource missing');
          return Object.fromEntries(await Promise.all(paths.map(async path=>[path,await options.provider!.readFile(resource,head.revisionId as RevisionId,path)])));
        })();
        if(Object.keys(sourceFiles).length!==paths.length || paths.some(path=>!sourceFiles[path]||sourceFiles[path]!.length>1048576))throw new Error('candidate source absent or oversized');
        const candidate = await mkdtemp(join(tmpdir(), 'commonforge-g1-bridge-'));
        const startedAt = new Date().toISOString();
        try {
          if(!options.runtime)await writeFile(join(candidate, 'worker.mjs'), sourceFiles[paths[0]!]!, { mode: 0o400 });
          const verified = options.runtime ? await options.runtime.verify(sourceFiles as Record<string,Uint8Array>) : await verifySchedulingCandidate(candidate);
          if(verified.verifierDigest!==undefined&&verified.verifierDigest!==verifierDigest || 'runtimeRecipeDigest' in verified&&verified.runtimeRecipeDigest!==undefined&&verified.runtimeRecipeDigest!==runtimeRecipeDigest)throw new Error('runtime adapter subject changed');
          const actor=options.runtime?.actor??'local-node-runner';
          const completedAt = new Date().toISOString();
          if (Date.parse(completedAt) > Date.parse(request.expiresAt)) throw new Error('verification expired');
          const evidence: ScenarioEvidence[] = request.requiredScenarios.map(s => {
            const result = verified.results.find(r => r.scenarioId === s.id)!;
            return { schemaVersion: 1, organizationId: request.organizationId, projectId: request.projectId,
              id: `ev-${request.runId}-${s.id}`, author: actor, createdAt: completedAt,
              envelopeDigest: request.envelopeDigest, buildDigest: request.buildDigest, runtimeRecipeDigest: request.runtimeRecipeDigest,
              scenarioId: s.id, scenarioRevision: s.revision, verifierDigest: s.verifierDigest, method: 'automated', result: result.result,
              runId: request.runId, actor, startedAt, completedAt, provenance: 'runner-verified', supersedes: null,
              attachments: [], summary: result.detail,
            };
          });
          return signScenarioResult({ protocolVersion: 1, requestDigest: digest, runId: request.runId, evidence, completedAt, execution: verified.execution, network: verified.network, controlPlaneMounted: false }, options.jobKey);
        } finally { await rm(candidate, { recursive: true, force: true }); }
      };
      const running = previous?.result ?? execute();
      if (!previous) runs.set(request.runId, { digest, result: running });
      return send(200, await running);
    })().catch(() => send(400, { error: 'local_verification_refused', detail: 'request signature, source, runtime, or isolation check failed' }));
  });
  server.requestTimeout = 15000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}
