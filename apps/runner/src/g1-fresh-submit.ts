/** Supervisor submission AFTER an actual external fresh agent edited its allowed source file. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createGit, RUNNER_IDENTITY_ENV } from './git.js';
import { inspectIsolatedHealth } from './g1-local-verifier.js';
const controlFile = process.argv[2]!, control = JSON.parse(await readFile(controlFile,'utf8'));
const owner = JSON.parse(await readFile(control.ownerSessionFile,'utf8'));
const agentIdentity = process.argv[3];
if (!agentIdentity || !/^\/[A-Za-z0-9_/-]+$/.test(agentIdentity)) throw new Error('record the actual independently invoked collaboration agent identity');
async function api(method:string,path:string,body?:unknown,token=owner.ownerToken):Promise<any>{
  const response=await fetch(`${control.workerUrl}/api${path}`,{method,headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();if(!response.ok)throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);return data;
}
async function waitFor(path:string,ready:(x:any)=>boolean){const end=Date.now()+60000;while(Date.now()<end){const result=await api('GET',path);if(ready(result))return result;await new Promise(r=>setTimeout(r,250));}throw new Error('real integration timed out');}
const git=createGit({allowHttp:true}),source=join(control.workspace,control.allowedImplementationPath);
for(const [path,digest]of Object.entries(control.inputDigests))if(createHash('sha256').update(await readFile(join(control.workspace,path))).digest('hex')!==digest)throw new Error('fresh agent altered pinned task/context inputs');
const afterDigest=createHash('sha256').update(await readFile(source)).digest('hex');if(afterDigest===control.implementationBeforeDigest)throw new Error('fresh source was not changed');
const changed=(await git.ok(['diff','--name-only'],control.workspace)).trim().split('\n').filter(Boolean);if(JSON.stringify(changed)!==JSON.stringify([control.allowedImplementationPath]))throw new Error('fresh agent changed source outside permitted file');
const diff=await git.ok(['diff','--',control.allowedImplementationPath],control.workspace);
const health=await inspectIsolatedHealth(dirname(source)) as {supportContact?:string;ruleVersion?:number};
if(health.supportContact!=='support@example.test'||health.ruleVersion!==2)throw new Error('fresh implementation health behavior did not match fixed task');
await git.ok(['add','--',control.allowedImplementationPath],control.workspace);await git.ok(['commit','-q','-m','Fresh scoped agent adds support contact while preserving confirmed rules'],control.workspace,{env:RUNNER_IDENTITY_ENV(new Date().toISOString())});
const sha=(await git.ok(['rev-parse','HEAD'],control.workspace)).trim(),cred=control.credential;
await git.ok(['push','-q','origin','HEAD:refs/heads/main'],control.workspace,{env:{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`http.${cred.remoteUrl}.extraHeader`,GIT_CONFIG_VALUE_0:`Authorization: Bearer ${cred.secret}`}});
const candidate=await api('POST',`/tasks/${control.taskId}/workspaces/${control.workspaceId}/freeze`,{expectedSha:sha,tool:'actual-fresh-codex-session'},control.agent.leaseToken);
const inner=await api('POST',`/orgs/${control.organizationId}/proposals`,{taskId:control.taskId,candidateIds:[candidate.candidateId]});
const innerPath=`/orgs/${control.organizationId}/proposals/${inner.proposalId}`;await waitFor(innerPath,p=>p.state==='prepared');await api('POST',`${innerPath}/integrate`,{});const integrated=await waitFor(innerPath,p=>!!p.integration);
const native=`/orgs/${control.organizationId}/projects/${control.projectId}/native`;
let state=(await api('GET',native)).state;
const outer=await api('POST',`/tasks/${control.taskId}/native/proposals`,{innerProposalId:inner.proposalId,expectedGeneration:state.generation,idempotencyKey:`fresh-outer-${control.taskId}`},control.agent.leaseToken);
const verification=await api('POST',`${native}/proposals/${encodeURIComponent(outer.proposal.id)}/verify`,{idempotencyKey:`fresh-verify-${control.taskId}`});state=verification.state;
if(verification.evidence.length!==9||!verification.evidence.every((e:any)=>e.result==='pass'&&e.provenance==='runner-verified'))throw new Error('fresh source did not preserve every trusted scenario');
const me=await api('GET','/me'),decisionId=`fresh-decision-${Date.now()}`;
const decision={schemaVersion:1,organizationId:control.organizationId,projectId:control.projectId,id:decisionId,author:me.user.userId,createdAt:new Date().toISOString(),envelopeDigest:outer.proposal.digest,innerProposalHash:outer.proposal.envelope.innerProposalHash,action:'approve',explanation:'Synthetic owner API decision after inspecting exact fresh source diff, independently executed scheduling evidence and isolated supportContact response.',authorityRevision:state.authorities.find((a:any)=>a.principalId===me.user.userId).revision};
state=(await api('POST',`${native}/commands`,{type:'recordDecision',record:decision,expectedGeneration:state.generation,idempotencyKey:decisionId})).state;
state=(await api('POST',`${native}/commands`,{type:'accept',proposalId:outer.proposal.id,decisionId,expectedGeneration:state.generation,idempotencyKey:`accept-${decisionId}`})).state;
const report={mode:'actual-fresh-agent-real-local-api',agent:{canonicalIdentity:agentIdentity,facility:'Codex collaboration.spawn_agent',fork_turns:'none',model:'inherited default; independent model identifier not exposed by collaboration API',crossVendorClaim:false,originalConversationProvided:false,humanCorrectionRestated:false},
  input:JSON.parse(await readFile(join(control.root,'report.json'),'utf8')),implementationAfterDigest:afterDigest,sourceRevision:sha,proposalId:outer.proposal.id,envelopeDigest:outer.proposal.digest,acceptedManifest:state.manifests.at(-1).hash,acceptedSourceHeads:state.sourceHeads,
  supplementalIsolatedHealth:health,scenarioEvidence:verification.evidence,artifactIntegration:integrated.integration,decision:{id:decisionId,actor:'synthetic owner role through API; not an observed human usability session'},
  gates:{freshAgentExecution:'pass',correctedRulePreserved:'pass',realGit:'pass',signedRunnerIntegration:'pass',independentScenarios:'pass',supplementalHealthBehavior:'pass',atomicAcceptance:'pass',cloudRelease:'not_run'}};
await writeFile(join(control.root,'implementation.diff'),diff);await writeFile(join(control.root,'result.json'),JSON.stringify(report,null,2));
process.stdout.write(`${JSON.stringify({reportFile:join(control.root,'result.json'),diffFile:join(control.root,'implementation.diff'),sourceRevision:sha,contextDigest:control.contextDigest,acceptedManifest:report.acceptedManifest,gates:report.gates},null,2)}\n`);
