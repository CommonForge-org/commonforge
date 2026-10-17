/** Bind supplemental health observation to the immutable accepted integration revision. */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRevisionId } from '@commonforge-org/core';
import { inspectIsolatedHealth } from './g1-local-verifier.js';
const resultPath = process.argv[2]!, result = JSON.parse(await readFile(resultPath,'utf8'));
const operator = JSON.parse(await readFile(process.argv[3]!,'utf8'));
const owner = JSON.parse(await readFile(process.argv[4]!,'utf8'));
const head = result.acceptedSourceHeads[0], revision = parseRevisionId(head.revisionId);
if (revision.kind !== 'art') throw new Error('expected real Artifacts-compatible Git source');
const resourceResponse = await fetch(`${operator.workerUrl}/api/orgs/${result.input.organizationId}/resources/${head.resourceId}`, {headers:{authorization:`Bearer ${owner.ownerToken}`}});
if(!resourceResponse.ok)throw new Error('accepted resource unavailable');const resource=await resourceResponse.json() as {coords:{namespace:string;repoName:string}};
const response = await fetch(`${operator.sidecarUrl}/rpc`,{method:'POST',headers:{authorization:`Bearer ${operator.sidecarKey}`,'content-type':'application/json'},body:JSON.stringify({method:'readFile',args:[resource.coords.namespace,resource.coords.repoName,revision.sha,'fixtures/scheduling/worker.mjs']})});
if(!response.ok)throw new Error('accepted integration source unavailable');const data=await response.json() as {result:{bytes:string}};
const bytes=Buffer.from(data.result.bytes,'base64'),fileDigest=createHash('sha256').update(bytes).digest('hex');
const root=await mkdtemp(join(tmpdir(),'g1-accepted-health-'));
try{
 await writeFile(join(root,'worker.mjs'),bytes,{mode:0o400});
 const health=await inspectIsolatedHealth(root) as {supportContact?:string;ruleVersion?:number};
 if(health.supportContact!=='support@example.test'||health.ruleVersion!==2||fileDigest!==result.implementationAfterDigest)throw new Error('accepted integration changed the observed fresh behavior');
 result.supplementalAcceptedIntegration={revisionId:head.revisionId,implementationPath:'fixtures/scheduling/worker.mjs',fileDigest,equalsCandidateFileDigest:true,observedHealth:health,execution:'bubblewrap-linux-http',network:'none',controlPlaneMounted:false};
 await writeFile(resultPath,JSON.stringify(result,null,2));
 process.stdout.write(`${JSON.stringify(result.supplementalAcceptedIntegration,null,2)}\n`);
}finally{await rm(root,{recursive:true,force:true});}
