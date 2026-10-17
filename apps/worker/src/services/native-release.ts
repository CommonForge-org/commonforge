/** Native releases bind accepted requirements and sources; deployed byte identity stays in the
 * existing outputDigest. Source scenario execution is not deployment-byte verification. */
import { canonicalJson, hashCanonicalSync, observationHealth, ProjectStateSchema, type ProjectState, type ReleaseObservation } from '@commonforge-org/core';
import { scenarioBuildDigest } from '@commonforge-org/runner-protocol';
import type { Services } from '../context.js';
import { conflict } from '../lib/http.js';
import type { ReleaseRow } from './releases.js';
export interface NativeReleaseBinding {manifestHash:string;envelopeDigest:string;verifiedSourceDigest:string;runtimeRecipeDigest:string;sources:Record<string,string>}
export function nativeRuntimeRecipeDigest(recipe:unknown,environment:unknown):string {return hashCanonicalSync({domain:'cf.project-runtime/1',recipe,environment});}
const sorted=(sources:Record<string,string>)=>Object.fromEntries(Object.entries(sources).sort(([a],[b])=>a.localeCompare(b)));
export function nativeReleaseSubject(state:ProjectState,sources:Record<string,string>,recipe:unknown,environment:unknown):NativeReleaseBinding {
 const s=ProjectStateSchema.parse(state);const m=s.manifests.at(-1);
 if(!m || m.behavior!=='verified' || m.knowledgeHead!==s.knowledgeHead || m.envelopeDigest===null) throw conflict('scenario_evidence_missing','release requires a verified accepted source manifest under current knowledge');
 const p=s.proposals.find(p=>p.digest===m.envelopeDigest);
 if(!p || p.envelope.innerProposalId===null&&p.envelope.recovery===null || p.envelope.policyRevision!==s.policyRevision) throw conflict('review_subject_changed','accepted source proposal or policy is unavailable');
 const manifestHeads=Object.fromEntries(m.sourceHeads.map(h=>[h.resourceId,h.revisionId]));
 if(canonicalJson(sorted(manifestHeads))!==canonicalJson(sorted(Object.fromEntries(s.sourceHeads.map(h=>[h.resourceId,h.revisionId])))) || Object.entries(sources).some(([id,ref])=>manifestHeads[id]!==ref) || !Object.keys(sources).length) throw conflict('review_subject_changed','release sources do not match the accepted project manifest');
 const runtime=nativeRuntimeRecipeDigest(recipe,environment);
 if(p.envelope.runtimeRecipeDigest!==runtime || p.envelope.buildDigest!==scenarioBuildDigest(m.sourceHeads)) throw conflict('review_subject_changed','release runtime or source digest differs from verified proposal');
 return {manifestHash:m.hash,envelopeDigest:p.digest,verifiedSourceDigest:p.envelope.buildDigest,runtimeRecipeDigest:runtime,sources:sorted(sources)};
}
export async function nativeReleaseState(svc:Services,orgId:string,pid:string):Promise<ProjectState|null> {const raw=await svc.ledger(orgId).getNativeProject(pid);return raw?ProjectStateSchema.parse(JSON.parse(raw)):null;}
export async function prepareNativeReleaseBinding(svc:Services,orgId:string,pid:string,sources:Record<string,string>,recipe:unknown,environment:unknown):Promise<NativeReleaseBinding|null> {const s=await nativeReleaseState(svc,orgId,pid);return s?nativeReleaseSubject(s,sources,recipe,environment):null;}
export function nativeBindingStatement(svc:Services,releaseId:string,orgId:string,pid:string,b:NativeReleaseBinding):D1PreparedStatement {return svc.db.prepare('INSERT INTO native_release_bindings (release_id,org_id,project_id,manifest_hash,envelope_digest,verified_source_digest,runtime_recipe_digest,sources_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(releaseId,orgId,pid,b.manifestHash,b.envelopeDigest,b.verifiedSourceDigest,b.runtimeRecipeDigest,canonicalJson(b.sources),svc.nowIso());}
export async function readNativeReleaseBinding(svc:Services,rel:Pick<ReleaseRow,'release_id'|'org_id'|'project_id'>):Promise<NativeReleaseBinding|null> {
 const row=await svc.db.prepare('SELECT * FROM native_release_bindings WHERE release_id = ? AND org_id = ? AND project_id = ?').bind(rel.release_id,rel.org_id,rel.project_id).first<{manifest_hash:string;envelope_digest:string;verified_source_digest:string;runtime_recipe_digest:string;sources_json:string}>();
 return row?{manifestHash:row.manifest_hash,envelopeDigest:row.envelope_digest,verifiedSourceDigest:row.verified_source_digest,runtimeRecipeDigest:row.runtime_recipe_digest,sources:JSON.parse(row.sources_json)}:null;
}
/** Rechecked at publish AND deploy; releases prepared before native enablement fail closed. */
export async function assertNativeRelease(svc:Services,rel:ReleaseRow):Promise<NativeReleaseBinding|null> {
 const s=await nativeReleaseState(svc,rel.org_id,rel.project_id);if(!s)return null;
 if(rel.channel!=='production')throw conflict('project_mode_unsupported','agent-native projects use direct production release, not shared staging');
 const recorded=await readNativeReleaseBinding(svc,rel);if(!recorded)throw conflict('project_mode_unsupported','this release predates project envelope acceptance; prepare a native release');
 const current=nativeReleaseSubject(s,JSON.parse(rel.sources_json),JSON.parse(rel.recipe_json),JSON.parse(rel.environment_json));
 if(canonicalJson(current)!==canonicalJson(recorded) || rel.policy_revision!==s.policyRevision)throw conflict('review_subject_changed','project acceptance changed after this release was prepared');
 return recorded;
}
/** Existing release health observes the deployed runtime, with a bounded freshness window. */
export function nativeReleaseObservation(rel:ReleaseRow,binding:NativeReleaseBinding,health:{ok:boolean;checkedAt:string;targets?:Array<{targetId?:string;ok?:boolean}>},now:string):ReleaseObservation {
 return {schemaVersion:1,organizationId:rel.org_id,projectId:rel.project_id,id:'release-observation:'+hashCanonicalSync({release:rel.release_id,attempt:rel.deploy_attempts,health}),author:'service:release-health',createdAt:now,releaseId:rel.release_id,manifestHash:binding.manifestHash,buildDigest:rel.output_digest??binding.verifiedSourceDigest,environment:'production',target:(health.targets??[]).map(t=>t.targetId??'unknown').join(',')||'unknown',checkDigest:hashCanonicalSync({domain:'cf.release-health/1',environment:JSON.parse(rel.environment_json),outputDigest:rel.output_digest}),result:health.ok?'healthy':'unhealthy',observedAt:health.checkedAt,freshUntil:new Date(Date.parse(health.checkedAt)+300000).toISOString(),summary:'Deployment identity and configured release health observation; source scenario evidence is separate.'};
}
export async function presentNativeRelease(svc:Services,rel:ReleaseRow):Promise<{manifestHash:string|null;healthState:'healthy'|'unhealthy'|'unknown';freshUntil:string|null;verificationSubject:'accepted-source-and-runtime'|null}> {
 const b=await readNativeReleaseBinding(svc,rel);if(!b)return {manifestHash:null,healthState:'unknown',freshUntil:null,verificationSubject:null};
 const health=rel.health_json?JSON.parse(rel.health_json) as {ok?:boolean;checkedAt?:string;targets?:Array<{targetId?:string;ok?:boolean}>}:null;
 const observation=health && typeof health.ok==='boolean' && health.checkedAt?nativeReleaseObservation(rel,b,{...health,ok:health.ok,checkedAt:health.checkedAt},svc.nowIso()):undefined;
 return {manifestHash:b.manifestHash,healthState:observationHealth(observation,svc.nowIso()),freshUntil:observation?.freshUntil??null,verificationSubject:'accepted-source-and-runtime'};
}
/** Called only by platform health code after actual observation; no public evidence write route. */
export async function recordNativeReleaseHealth(svc:Services,rel:ReleaseRow,health:{ok:boolean;checkedAt:string;targets?:Array<{targetId?:string;ok?:boolean}>}):Promise<void> {
 const binding=await readNativeReleaseBinding(svc,rel);if(!binding)return;
 const observation=nativeReleaseObservation(rel,binding,health,svc.nowIso());
 await svc.ledger(rel.org_id).recordNativeObservation(rel.org_id,rel.project_id,observation);
}
