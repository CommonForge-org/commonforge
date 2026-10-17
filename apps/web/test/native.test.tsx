import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createProjectState, type ProjectManifest, type KnowledgeRevision, type ProjectProposal } from '@commonforge-org/core';
import { FakeApi } from '../src/api/fake.js';
import { AppContext } from '../src/lib/hooks.js';
import { parseRoute } from '../src/lib/router.js';
import { KnowledgeEditor } from '../src/screens/ProjectKnowledge.js';
import { AgentHandoff, nativeAgentPrompt } from '../src/screens/AgentHandoff.js';
import { canPrepareRecovery, previewMatchesProjectSource, Review } from '../src/screens/NativeReview.js';

const T = '2026-10-17T12:00:00Z';
const D = 'a'.repeat(64);
const state = createProjectState('org', 'project');
const meta = { schemaVersion: 1 as const, organizationId: 'org', projectId: 'project', author: 'owner', createdAt: T };
const corrected: KnowledgeRevision = { ...meta, id: 'override', revision: 2, predecessor: 1, kind: 'rule', text: 'Managers may override only with a retained reason.', rationale: 'Preserve accountable exceptions.', sources: [{ kind: 'text', ref: 'Owner correction', digest: null }], confirmation: { actor: 'owner', confirmedAt: T, authorityRevision: 1, decisionId: 'decision' }, archived: false };
const proposal: ProjectProposal = { ...meta, id: 'candidate', digest: D, envelope: { schemaVersion: 1, organizationId: 'org', projectId: 'project', domain: 'cf.project-proposal/1', outcome: null, attemptId: null, mandateId: null, mandateRevision: null, contextDigest: null, innerProposalId: 'inner', innerProposalHash: D, sourceHeads: [], runtimeRecipeDigest: D, buildDigest: D, expectedParent: null, expectedKnowledgeHead: D, policyRevision: 0, proposedKnowledge: [], proposedScenarios: [], requiredScenarios: [{ id: 'override-example', revision: 1, verifierDigest: D, method: 'automated' }], recovery: null, effects: [] } };
async function render(view: React.ReactNode) {
  const api = new FakeApi();
  const me = await api.me();
  return renderToString(<AppContext.Provider value={{ api, fixture: null, me, refreshMe: async () => {} }}>{view}</AppContext.Provider>).replace(/<!-- -->/g, '');
}
describe('project understanding owner views', () => {
  it('keeps corrections, provenance and draft confirmation distinct', async () => {
    const html = await render(<KnowledgeEditor state={{ ...state, knowledge: [corrected, { ...corrected, id: 'new', revision: 1, predecessor: null, confirmation: null }] }} command={async () => {}} busy={false} />);
    expect(html).toContain(corrected.text);
    expect(html).toContain('Owner correction');
    expect(html).toContain('Confirmed');
    expect(html).toContain('Draft');
    expect(html).toContain('Confirm rule');
    expect(html).toContain('Revision history');
  });
  it('distinguishes archived scenarios from current requirements and keeps their history',async()=>{
    const scenario={...meta,id:'retired',revision:3,predecessor:2,title:'Retired example',given:'Input',when:'Requested',then:'Observed',ruleRefs:[],required:true,method:'manual' as const,verifierDigest:D,confirmation:{actor:'owner',confirmedAt:T,authorityRevision:1,decisionId:'archive'},archived:true};
    const html=await render(<KnowledgeEditor state={{...state,scenarios:[scenario]}} command={async()=>{}} busy={false}/>);
    expect(html).toContain('Retired example · revision 3 · Archived');
    expect(html).toContain('Scenario history');
    expect(html).not.toContain('>Archive scenario<');
    expect(html).not.toContain('>Confirm scenario<');
  });
  it('shows stale requirements and missing evidence without a verified claim', async () => {
    const html = await render(<Review state={{ ...state, proposals: [proposal] }} command={async () => {}} busy={false} />);
    expect(html).toContain('Requirements changed: refresh and verify this change again.');
    expect(html).toContain('Not run: evidence missing');
    expect(html).toContain('Health unknown');
    expect(html).not.toContain('Accepted with applicable behavioral evidence');
    expect(html).toContain('No ready preview');
  });
  it('uses scoped authority for native task handoffs without a broad login prompt', () => {
    const html = renderToString(<AgentHandoff task={{ taskId: 'task', title: 'Native change', request: 'Preserve correction', write: [], read: [], ...{ projectProtocolVersion: 1 } }} ctx={{ role: 'owner', staging: false, apiUrl: 'http://localhost:8787', email: 'owner@example.test' }} onDone={() => {}} />);
    expect(html).toContain('Task-scoped agent handoff');
    expect(html).toContain('Agent or client identity');
    expect(html).not.toContain('sign-in lasts a week');
    expect(html).not.toContain('cforge login');
  });
  it('does not label a preview of a different integration output as the reviewed source', () => {
    const sha = '1'.repeat(40); const other = '2'.repeat(40);
    const preview = { previewId: 'preview', proposalId: 'inner', proposalHash: D, state: 'ready' as const, createdAt: T, updatedAt: T, expiresAt: null, url: 'http://localhost:8900/p/preview', error: null, sources: { source: sha } };
    expect(previewMatchesProjectSource(preview, [{ resourceId: 'source', revisionId: `art:repo:${sha}` }])).toBe(true);
    expect(previewMatchesProjectSource(preview, [{ resourceId: 'source', revisionId: `art:repo:${other}` }])).toBe(false);
    const withoutSources = { ...preview, sources: undefined };
    expect(previewMatchesProjectSource(withoutSources, [{ resourceId: 'source', revisionId: `art:repo:${sha}` }])).toBe(false);
  });
  it('offers recovery only for a complete changed historical source set and keeps its evidence review distinct', async()=>{
    const oldHead={resourceId:'source',revisionId:`art:repo:${'1'.repeat(40)}`};
    const currentHead={resourceId:'source',revisionId:`art:repo:${'2'.repeat(40)}`};
    const manifest:ProjectManifest={...meta,id:'historic',sequence:1,parent:null,hash:D,sourceHeads:[oldHead],knowledgeHead:state.knowledgeHead,knowledgeGeneration:0,envelopeDigest:null,decisionId:null,evidenceIds:[],behavior:'historical-unverified'};
    const current={...state,sourceHeads:[currentHead],manifests:[manifest]};
    expect(canPrepareRecovery(current,manifest)).toBe(true);
    expect(canPrepareRecovery({...current,sourceHeads:[oldHead]},manifest)).toBe(false);
    expect(canPrepareRecovery({...current,sourceHeads:[currentHead,{resourceId:'new-source',revisionId:currentHead.revisionId}]},manifest)).toBe(false);
    const recovery={...proposal,envelope:{...proposal.envelope,innerProposalId:null,innerProposalHash:null,recovery:{manifestHash:D,planDigest:D},expectedKnowledgeHead:state.knowledgeHead,expectedParent:D}};
    const html=await render(<Review state={{...current,proposals:[recovery]}} command={async()=>{}} busy={false}/>);
    expect(html).toContain('Historical source recovery');
    expect(html).toContain('Review recovery to project version 1');
    expect(html).toContain('does not restore old knowledge, deploy, or reverse database or external effects');
    expect(html).toContain('Run required automated scenarios');
    expect(html).not.toContain('Knowledge-only proposal');
  });
  it('uses a fresh scoped renewal checkout for replacement prompts while initial handoff stays unchanged', () => {
    const task={taskId:'task-1',title:'Correct rescheduling',request:'Preserve owner correction',write:[],read:[]};
    const ctx={role:'owner' as const,staging:false,apiUrl:'http://localhost:8787',email:'synthetic@example.test'};
    const initial=nativeAgentPrompt(task,ctx,'org.project.cfh_oneuse123456','nonce-one');
    expect(initial).toContain('cforge handoff');expect(initial).toContain('cforge checkout');expect(initial).not.toContain('cforge renew');
    const lease={holder:'owner',expiresAt:'2050-01-01T00:00:00Z',generation:1};
    const a=nativeAgentPrompt({...task,lease},ctx,'org.project.cfh_replacement123456','nonce-one');
    const b=nativeAgentPrompt({...task,lease},ctx,'org.project.cfh_replacement123456','nonce-two');
    expect(a).toContain('cforge renew --api-url http://localhost:8787 --code org.project.cfh_replacement123456 --out');
    expect(a).toContain('-renewed-nonce-one');expect(b).toContain('-renewed-nonce-two');expect(a).not.toContain('cforge checkout');expect(a).not.toContain('cforge login');expect(a).toContain('Previous mandate stays revoked');
  });
  it('routes the owner views without changing legacy routes', () => {
    for (const tab of ['outcomes', 'knowledge', 'review']) expect(parseRoute(`/o/org/p/project/${tab}`, '')).toEqual({ name: 'project', org: 'org', pid: 'project', tab });
    expect(parseRoute('/o/org/p/project/changes/legacy', '')).toEqual({ name: 'proposal', org: 'org', pid: 'project', proposalId: 'legacy' });
  });
});
