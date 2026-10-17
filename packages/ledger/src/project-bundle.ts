/** Provider-independent G1 bundles. Archives retain provenance; import never installs authority. */
import { z } from 'zod';
import { canonicalJson, checkPath, computeKnowledgeHead, computeProjectManifestHash, computeProjectProposalHash, createProjectState, currentConfirmed, ProjectError, ProjectStateSchema, sha256HexSync, hashCanonicalSync, type ProjectState } from '@commonforge-org/core';
import { createNativeGenesis } from './project.js';
const Id=z.string().min(1).max(256);
const Digest=z.string().regex(/^[a-f0-9]{64}$/);
export const PROJECT_BUNDLE_LIMITS={maxBytes:16*1024*1024,maxPayloadBytes:8*1024*1024,maxPayloads:1000} as const;
export const ProjectBundlePayloadSchema=z.object({kind:z.enum(['source','attachment','log']),subject:Id,path:z.string().min(1).max(1024),digest:Digest,size:z.number().int().nonnegative().max(PROJECT_BUNDLE_LIMITS.maxPayloadBytes),mediaType:Id,contentBase64:z.string().max(Math.ceil(PROJECT_BUNDLE_LIMITS.maxPayloadBytes/3)*4)}).strict();
export type ProjectBundlePayload=z.infer<typeof ProjectBundlePayloadSchema>;
const CompletenessSchema=z.object({metadata:z.literal('complete'),missingSources:z.array(Id).max(10000),missingAttachments:z.array(Digest).max(10000),completeBackup:z.literal(false),sourceContentValidation:z.literal('not-performed')}).strict();
export const ProjectBundleSchema=z.object({domain:z.literal('cf.project-bundle/1'),schemaVersion:z.literal(1),history:ProjectStateSchema,payloads:z.array(ProjectBundlePayloadSchema).max(PROJECT_BUNDLE_LIMITS.maxPayloads),completeness:CompletenessSchema,digest:Digest}).strict();
export type ProjectBundle=z.infer<typeof ProjectBundleSchema>;
const invalid=(message:string):never=>{throw new ProjectError('bundle_invalid',message);};
/** No coordinates/secrets are added by exporter. Recognizable secrets/local URLs fail closed;
 * arbitrary application prose cannot be guaranteed secret-free and must be reviewed by exporter. */
function inspectText(text:string) {
 if(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+\/-]{16,}|\b(?:gh[pousr]_|github_pat_|cf[sm]_)[A-Za-z0-9_\-]{16,}|\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,}\]"']+/i.test(text)) invalid('credential-like content cannot be exported or imported');
 if(/file:\/\/|https?:\/\/[^\s"/@]+:[^\s"/@]+@|https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?=[:/"\s])|(?:^|[\s"'])\/(?:home|Users|tmp|var|root)\//i.test(text)) invalid('sensitive local coordinates cannot be bundled');
}
function bytes(payload:ProjectBundlePayload):Uint8Array {
 if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.contentBase64)) return invalid('payload is not canonical base64');
 let decoded:string;try{decoded=atob(payload.contentBase64);}catch{return invalid('payload base64 is malformed');}
 if(btoa(decoded)!==payload.contentBase64) invalid('payload base64 is not canonical');
 return Uint8Array.from(decoded,x=>x.charCodeAt(0));
}
function allSources(s:ProjectState) {return [...new Set([...s.sourceHeads,...s.manifests.flatMap(m=>m.sourceHeads),...s.proposals.flatMap(p=>p.envelope.sourceHeads)].map(h=>h.revisionId))].sort();}
function allAttachments(s:ProjectState) {return [...new Set(s.evidence.flatMap(e=>e.attachments.map(a=>a.digest)))].sort();}
function completeness(s:ProjectState,p:ProjectBundlePayload[]):ProjectBundle['completeness'] {return {metadata:'complete',missingSources:allSources(s).filter(ref=>!p.some(p=>p.kind==='source'&&p.subject===ref)),missingAttachments:allAttachments(s).filter(d=>!p.some(p=>p.kind==='attachment'&&p.digest===d&&p.subject===d)),completeBackup:false,sourceContentValidation:'not-performed'};}
function checkHistory(s:ProjectState) {
 const collections=[s.outcomes,s.knowledge,s.scenarios,s.mandates,s.attempts,s.proposals,s.decisions,s.evidence,s.manifests,s.observations];
 for(const list of collections) {
  const seen=new Set<string>();
  for(const record of list) {
   if(record.organizationId!==s.organizationId || record.projectId!==s.projectId) invalid('historical record belongs to another project');
   const key=record.id+('revision' in record?'@'+record.revision:'');if(seen.has(key)) invalid('duplicate historical record identity');seen.add(key);
  }
 }
 if(new Set(s.sourceHeads.map(h=>h.resourceId)).size!==s.sourceHeads.length) invalid('duplicate source head');
 if(computeKnowledgeHead(s.organizationId,s.projectId,s.knowledgeGeneration,s.knowledge,s.scenarios)!==s.knowledgeHead) invalid('knowledge head integrity failed');
 for(const p of s.proposals) {
  if(p.envelope.organizationId!==s.organizationId || p.envelope.projectId!==s.projectId || computeProjectProposalHash(p.envelope)!==p.digest) invalid('proposal integrity failed');
 }
 for(let i=0;i<s.manifests.length;i++) {
  const m=s.manifests[i]!; const {hash,...content}=m;
  if(hash!==computeProjectManifestHash(content) || m.sequence!==i || m.parent!==(s.manifests[i-1]?.hash??null)) invalid('manifest history integrity failed');
  if(m.evidenceIds.some(id=>!s.evidence.some(e=>e.id===id)) || m.decisionId!==null&&!s.decisions.some(d=>d.id===m.decisionId)) invalid('manifest references missing history');
 }
 for(const e of s.evidence) if(!s.proposals.some(p=>p.digest===e.envelopeDigest)) invalid('evidence references a missing proposal');
}
function checkPayloads(s:ProjectState,payloads:ProjectBundlePayload[]) {
 const paths=new Set<string>();const subjects=new Set<string>();
 for(const p of payloads) {
  const checked=checkPath(p.path,{maxLength:1024});
  if(!checked.ok || checked.path!==p.path || p.path!==`payloads/${p.digest}` || paths.has(p.path)) invalid('unsafe or duplicate payload archive path');paths.add(p.path);
  const key=p.kind+':'+p.subject;if(subjects.has(key)) invalid('duplicate payload subject');subjects.add(key);
  const data=bytes(p);
  if(data.byteLength!==p.size || sha256HexSync(data)!==p.digest) invalid('payload size or digest failed');
  inspectText(new TextDecoder().decode(data));
  if(p.kind==='source'&&!allSources(s).includes(p.subject)) invalid('source payload is outside archived history');
  if(p.kind==='attachment') {
   const attachment=s.evidence.flatMap(e=>e.attachments).find(a=>a.digest===p.subject);
   if(!attachment || p.subject!==p.digest || attachment.size!==p.size || attachment.mediaType!==p.mediaType) invalid('attachment payload does not match its evidence');
  }
 }
}
/** Caller must authorize the entire exported history and retrieve payloads through scoped storage. */
export function exportProjectBundle(input:ProjectState,payloads:ProjectBundlePayload[]=[]):ProjectBundle {
 const history=ProjectStateSchema.parse(input);
 const parsed=payloads.map(p=>ProjectBundlePayloadSchema.parse(p)).sort((a,b)=>a.path.localeCompare(b.path));
 const content={domain:'cf.project-bundle/1' as const,schemaVersion:1 as const,history,payloads:parsed,completeness:completeness(history,parsed)};
 return validateProjectBundle({...content,digest:hashCanonicalSync(content)});
}
/** Validates before any filesystem/storage writes. It is JSON, not an automatically extracted ZIP. */
export function validateProjectBundle(raw:unknown):ProjectBundle {
 let encoded:string;try{encoded=canonicalJson(raw);}catch{return invalid('bundle is not canonical JSON data');}
 if(new TextEncoder().encode(encoded).byteLength>PROJECT_BUNDLE_LIMITS.maxBytes) invalid('bundle exceeds byte limit');
 const parsed=ProjectBundleSchema.safeParse(raw);if(!parsed.success) return invalid('unsupported or malformed project bundle');
 const bundle=parsed.data; const {digest,...content}=bundle;
 if(hashCanonicalSync(content)!==digest) invalid('bundle digest failed');
 inspectText(canonicalJson(bundle.history));checkHistory(bundle.history);checkPayloads(bundle.history,bundle.payloads);
 if(!sameCompleteness(bundle.completeness,completeness(bundle.history,bundle.payloads))) invalid('bundle completeness claims do not match payloads');
 return bundle;
}
function sameCompleteness(a:unknown,b:unknown) {return canonicalJson(a)===canonicalJson(b);}
const ImportTargetSchema=z.object({organizationId:Id,projectId:Id,ownerId:Id,now:z.string().datetime({offset:true})}).strict();
export type ProjectBundleImportTarget=z.infer<typeof ImportTargetSchema>;
export interface ImportedProjectBundle {
 state:ProjectState;
 /** Historical hashes/provenance remain exact and cannot be passed as local authoritative state. */
 history:ProjectBundle;
 identityMap:{kind:'principal'|'resource'|'record';original:string;local:string}[];
 requiresLocalConfirmation:true;
 sourceMaterialization:'not-performed';
}
/** Import creates fresh untrusted drafts; original signed subjects remain in the historical archive.
 * No imported agent, mandate, approval, evidence, manifest, release or live pointer is activated. */
export function importProjectBundle(raw:unknown,target:ProjectBundleImportTarget):ImportedProjectBundle {
 const history=validateProjectBundle(raw);const t=ImportTargetSchema.parse(target);
 const s=createProjectState(t.organizationId,t.projectId);
 s.authorities=[{principalId:t.ownerId,role:'owner',revision:1,active:true}];
 const prefix='imported:'+history.digest.slice(0,16)+':';
 const identityMap:ImportedProjectBundle['identityMap']=[];
 const principalIds=new Set<string>([...history.history.authorities.map(a=>a.principalId),...history.history.knowledge.map(k=>k.author),...history.history.decisions.map(d=>d.author),...history.history.evidence.map(e=>e.actor)]);
 for(const id of [...principalIds].sort()) identityMap.push({kind:'principal',original:id,local:prefix+sha256HexSync(id).slice(0,16)});
 for(const id of [...new Set(history.history.manifests.flatMap(m=>m.sourceHeads.map(h=>h.resourceId)))].sort()) identityMap.push({kind:'resource',original:id,local:prefix+sha256HexSync(id).slice(0,16)});
 const idFor=(id:string)=>prefix+sha256HexSync(id).slice(0,24);
 for(const k of currentConfirmed(history.history.knowledge)) {
  const id=idFor(k.id);identityMap.push({kind:'record',original:k.id,local:id});
  s.knowledge.push({...k,organizationId:t.organizationId,projectId:t.projectId,id,revision:1,predecessor:null,author:t.ownerId,createdAt:t.now,confirmation:null,archived:false,sources:[{kind:'text',ref:`Imported historical knowledge ${history.digest}:${k.id}@${k.revision}`,digest:history.digest}]});
 }
 for(const scenario of currentConfirmed(history.history.scenarios)) {
  const id=idFor(scenario.id);identityMap.push({kind:'record',original:scenario.id,local:id});
  // Keep scenario as a draft, with mapped draft references. Confirm rules first and revise ruleRefs
  // to their newly confirmed local revisions before confirming this scenario.
  s.scenarios.push({...scenario,organizationId:t.organizationId,projectId:t.projectId,id,revision:1,predecessor:null,author:t.ownerId,createdAt:t.now,confirmation:null,archived:false,ruleRefs:scenario.ruleRefs.map(r=>({id:idFor(r.id),revision:1}))});
 }
 // Genesis allows only empty histories. Create it before installing the inert imported drafts.
 const fresh=createProjectState(t.organizationId,t.projectId);fresh.authorities=s.authorities;
 const state=createNativeGenesis(fresh,{actorId:t.ownerId,now:t.now});state.knowledge=s.knowledge;state.scenarios=s.scenarios;
 return {state:ProjectStateSchema.parse(state),history,identityMap,requiresLocalConfirmation:true,sourceMaterialization:'not-performed'};
}
export interface ProjectRetentionRoots {sourceRevisions:string[];manifestHashes:string[];evidenceIds:string[];attachmentDigests:string[];buildDigests:string[];activeAttemptIds:string[];canDeleteReferencedPayloads:false}
/** Conservative GC roots: accepted history and ALL pending proposals/evidence remain pinned.
 * This helper authorizes no deletion; storage adapters must union these with their legacy roots. */
export function projectRetentionRoots(input:ProjectState):ProjectRetentionRoots {
 const s=ProjectStateSchema.parse(input);
 const accepted=new Set(s.manifests.flatMap(m=>m.evidenceIds));
 const active=s.attempts.filter(a=>a.status==='active'||a.status==='submitted');
 const activeProposalIds=new Set(active.flatMap(a=>a.proposalIds));
 const pending=s.proposals.filter(p=>!s.manifests.some(m=>m.envelopeDigest===p.digest)||activeProposalIds.has(p.id));
 const retained=s.evidence.filter(e=>accepted.has(e.id)||pending.some(p=>p.digest===e.envelopeDigest));
 return {sourceRevisions:[...new Set([...allSources(s),...pending.flatMap(p=>p.envelope.sourceHeads.map(h=>h.revisionId))])].sort(),manifestHashes:s.manifests.map(m=>m.hash),evidenceIds:retained.map(e=>e.id).sort(),attachmentDigests:[...new Set(retained.flatMap(e=>e.attachments.map(a=>a.digest)))].sort(),buildDigests:[...new Set([...pending.map(p=>p.envelope.buildDigest),...retained.map(e=>e.buildDigest)])].sort(),activeAttemptIds:active.map(a=>a.id).sort(),canDeleteReferencedPayloads:false};
}
