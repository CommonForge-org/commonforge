/** Operator-owned Artifacts -> isolated build/workerd supervisor. Serve loopback behind TLS. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BuildRecipeSchema, parseRevisionId } from '@commonforge-org/core';
import { RestArtifactsTransport, type ArtifactsTransport } from '@commonforge-org/provider-cloudflare';
import type { ScenarioVerificationRequest } from '@commonforge-org/runner-protocol';
import { createCloudflareSchedulingAdapter } from './g1-cloudflare-source.js';
import type { CloudflareReleaseEnvironment } from './g1-cloudflare-verifier.js';
import { startLocalScenarioBridge } from './g1-local-bridge.js';

export const CloudflareScenarioRegistrationSchema = z.object({
  organizationId:z.string().min(1),projectId:z.string().min(1),resourceId:z.string().min(1),
  namespace:z.string().min(1),repoName:z.string().min(1),repoId:z.string().min(1),
  pathPrefix:z.string().regex(/^(?:[A-Za-z0-9_-]+\/)*$/).default(''),
}).strict();
export type CloudflareScenarioRegistration=z.infer<typeof CloudflareScenarioRegistrationSchema>;
/** Paths, namespaces and repositories come only from operator registrations. */
export function registeredArtifactsSource(transport:ArtifactsTransport,resources:CloudflareScenarioRegistration[]) {
  return async (request:ScenarioVerificationRequest,paths:string[]):Promise<Record<string,Uint8Array>>=>{
    if(request.sourceHeads.length!==1)throw new Error('one registered source required');
    const head=request.sourceHeads[0]!,revision=parseRevisionId(head.revisionId);
    const r=resources.find(r=>r.organizationId===request.organizationId&&r.projectId===request.projectId&&r.resourceId===head.resourceId);
    if(!r||revision.kind!=='art'||revision.repoId!==r.repoId)throw new Error('registered source scope mismatch');
    const repo=await transport.getRepo(r.namespace,r.repoName);
    if(!repo||repo.id!==r.repoId)throw new Error('registered repository identity changed');
    const files:Record<string,Uint8Array>={};
    for(const path of paths){
      if(!['worker.mjs','build.mjs','wrangler.json'].includes(path))throw new Error('unsupported verifier source path');
      const bytes=await transport.readFile(r.namespace,r.repoName,revision.sha,r.pathPrefix+path);
      if(!bytes||bytes.length>1048576)throw new Error('registered source missing or oversized');
      files[path]=bytes;
    }
    return files;
  };
}
export async function main():Promise<void> {
  const configPath=process.argv[2];if(!configPath)throw new Error('usage: tsx src/g1-cloudflare-server.ts <operator-config.json>');
  const config=z.object({port:z.number().int().min(1024).max(65535),accountId:z.string().regex(/^[a-f0-9]{32}$/),
    pin:z.object({binary:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),schema:z.string().min(1),
    recipe:BuildRecipeSchema,environment:z.record(z.string(),z.unknown()),resources:z.array(CloudflareScenarioRegistrationSchema).min(1).max(100),
  }).strict().parse(JSON.parse(await readFile(configPath,'utf8')));
  const apiToken=process.env.CF_API_TOKEN,secret=process.env.COMMONFORGE_RUNNER_JOB_KEY;
  if(!apiToken||!secret||secret.length<32)throw new Error('CF_API_TOKEN and COMMONFORGE_RUNNER_JOB_KEY required in supervisor environment');
  const runtime=await createCloudflareSchedulingAdapter({...config,environment:config.environment as unknown as CloudflareReleaseEnvironment});
  const transport=new RestArtifactsTransport({accountId:config.accountId,apiToken});
  const bridge=await startLocalScenarioBridge({port:config.port,resources:[],runtime,jobKey:{kid:'k1',secret},readCandidateFiles:registeredArtifactsSource(transport,config.resources)});
  process.stdout.write(JSON.stringify({url:bridge.url,runtimeRecipeDigest:runtime.runtimeRecipeDigest,verifierDigest:runtime.verifierDigest,cloudDeployment:false})+'\n');
  for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void bridge.close();});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))void main().catch(()=>{process.stderr.write('Cloudflare scenario supervisor refused startup; validate private operator configuration and toolchain.\n');process.exit(1);});
