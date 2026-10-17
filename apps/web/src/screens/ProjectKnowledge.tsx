import { useState, type ReactNode } from 'react';
import { currentConfirmed, hashCanonicalSync, type KnowledgeRevision, type ProjectState, type ScenarioRevision } from '@commonforge-org/core';
import { enableNativeProject, loadNativeProject, nativeCommand } from '../api/native.js';
import { ApiError } from '../api/client.js';
import { useAction, useApp, useLoad } from '../lib/hooks.js';
import { ErrorNote, Loading } from '../ui.js';
import { useProject } from './project-data.js';

export function NativeProject({ children }: { children: (state: ProjectState, command: (body: Record<string, unknown>) => Promise<void>, busy: boolean) => ReactNode }) {
  const { org, pid, role } = useProject();
  const { fixture } = useApp();
  const load = useLoad(() => fixture ? Promise.reject(new ApiError(409, 'fixture_unavailable', 'Project knowledge uses the real API. This fixture does not execute project operations.')) : loadNativeProject(org, pid), `${org}/${pid}/native`, 15000);
  const action = useAction(async (body?: Record<string, unknown>) => {
    if (body && load.data) await nativeCommand(org, pid, load.data.generation, body);
    else await enableNativeProject(org, pid);
    load.reload();
  });
  if (role !== 'owner' && role !== 'developer') return <p role="alert">Project understanding requires owner or developer access to all project folders.</p>;
  if (load.error) return <ErrorNote error={load.error} onRetry={load.reload} />;
  if (load.data === undefined) return <Loading what="Loading project understanding" />;
  return <div className="stack" style={{ minWidth: 0, overflowWrap: 'anywhere' }}><ErrorNote error={action.error} />{load.data === null ? <section className="card"><h2>Start durable project understanding</h2><p>Record domain rules, confirm examples, and review changes against those exact requirements. Enabling this workflow is permanent; existing source history is retained without retroactive behavior verification.</p>{role === 'owner' ? <button className="btn btn-outline" type="button" disabled={action.busy} onClick={() => void action.run()}>Enable project understanding</button> : <p>An owner can enable this workflow.</p>}</section> : children(load.data, async body => { await action.run(body); }, action.busy)}</div>;
}

function latest<T extends { id: string; revision: number }>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  for (const r of rows) if (!byId.has(r.id) || byId.get(r.id)!.revision < r.revision) byId.set(r.id, r);
  return [...byId.values()];
}
export function ProjectKnowledge() {
  return <NativeProject>{(state, command, busy) => <KnowledgeEditor state={state} command={command} busy={busy} />}</NativeProject>;
}
export function KnowledgeEditor({ state, command, busy }: { state: ProjectState; command: (body: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const { me } = useApp();
  const [text, setText] = useState('');
  const [rationale, setRationale] = useState('');
  const [source, setSource] = useState('');
  const [kind, setKind] = useState<KnowledgeRevision['kind']>('rule');
  const [editing, setEditing] = useState<KnowledgeRevision | null>(null);
  const [given, setGiven] = useState(''); const [when, setWhen] = useState(''); const [then, setThen] = useState('');
  const [scenarioTitle, setScenarioTitle] = useState('');
  const [editingScenario, setEditingScenario] = useState<ScenarioRevision | null>(null);
  const [ruleId, setRuleId] = useState('');
  const common = () => ({ schemaVersion: 1 as const, organizationId: state.organizationId, projectId: state.projectId, author: me!.user.userId, createdAt: new Date().toISOString() });
  const confirmed = currentConfirmed(state.knowledge);
  return <>
    <section className="card"><h2>Knowledge</h2><p>Confirmed rules survive agent handoffs. Corrections create new revisions and make earlier verification stale.</p><p className="muted">Knowledge generation {state.knowledgeGeneration} · {confirmed.length} current confirmed records</p>
      {state.knowledge.length === 0 ? <p>No knowledge recorded yet.</p> : latest(state.knowledge).map(r => <article key={r.id} className="update-card"><div className="stack"><h3>{r.kind} · revision {r.revision} · {r.archived ? 'Archived' : r.confirmation ? 'Confirmed' : 'Draft'}</h3><p>{r.text}</p><p>Why: {r.rationale}</p>{r.sources.map((s, i) => <p key={i}>Source: {s.ref}</p>)}<p className="muted">By {r.author} · {r.createdAt}</p>{r.confirmation ? <p>Confirmed by {r.confirmation.actor} · {r.confirmation.confirmedAt}</p> : <button className="btn btn-outline" type="button" disabled={busy} onClick={() => void command({ type: 'confirmKnowledge', id: r.id, revision: r.revision, decisionId: crypto.randomUUID(), explanation: 'Owner confirmed this requirement.' })}>Confirm {r.kind}</button>}<button className="btn btn-outline" type="button" disabled={busy || r.archived} onClick={() => { setEditing(r); setText(r.text); setKind(r.kind); setRationale(r.rationale); setSource(r.sources[0]?.ref ?? ''); }}>Correct this record</button>{r.confirmation && !r.archived ? <button className="btn btn-outline" type="button" disabled={busy} onClick={() => void command({ type: 'archiveKnowledge', id: r.id, revision: r.revision, decisionId: crypto.randomUUID(), explanation: 'Owner archived this record; history is retained.' })}>Archive record</button> : null}<details><summary>Revision history</summary>{state.knowledge.filter(k => k.id === r.id).map(k => <p key={k.revision}>Revision {k.revision}: {k.text} ({k.confirmation ? 'confirmed' : 'draft'})</p>)}</details></div></article>)}
    </section>
    <form className="card stack" onSubmit={e => { e.preventDefault(); void command({ type: 'draftKnowledge', record: { ...common(), id: editing?.id ?? crypto.randomUUID(), revision: (editing?.revision ?? 0) + 1, predecessor: editing?.revision ?? null, kind, text, rationale, sources: source ? [{ kind: 'text', ref: source, digest: null }] : [], confirmation: null, archived: false } }); }}><h3>{editing ? 'Draft a correction' : 'Record project knowledge'}</h3><label className="field">Kind <select value={kind} onChange={e => setKind(e.target.value as KnowledgeRevision['kind'])}><option value="rule">Rule</option><option value="assumption">Assumption</option><option value="decision">Decision</option></select></label><label className="field">Requirement or understanding <textarea required value={text} onChange={e => setText(e.target.value)} /></label><label className="field">Rationale <textarea required value={rationale} onChange={e => setRationale(e.target.value)} /></label><label className="field">Source or provenance <input type="text" value={source} onChange={e => setSource(e.target.value)} /></label><button className="btn btn-primary" disabled={busy} type="submit">Save draft</button>{editing ? <button className="btn btn-outline" type="button" onClick={() => { setEditing(null); setText(''); setRationale(''); setSource(''); }}>Cancel correction</button> : null}<p className="muted">Saving a draft does not confirm it or claim that the application satisfies it.</p></form>
    <section className="card"><h2>Behavioral scenarios</h2><p>Manual observations and automated runner checks have separate provenance.</p>{latest(state.scenarios).map(s => <article className="update-card" key={s.id}><div><h3>{s.title} · revision {s.revision} · {s.confirmation ? 'Confirmed' : 'Draft'}</h3><p>Given {s.given}</p><p>When {s.when}</p><p>Then {s.then}</p><p>{s.method} · {s.required ? 'Required for acceptance' : 'Supplementary'}</p>{!s.confirmation ? <button className="btn btn-outline" type="button" disabled={busy} onClick={() => void command({ type: 'confirmScenario', id: s.id, revision: s.revision, decisionId: crypto.randomUUID(), explanation: 'Owner confirmed this behavioral example.' })}>Confirm scenario</button> : null}<button className="btn btn-outline" type="button" disabled={busy} onClick={() => { setEditingScenario(s); setScenarioTitle(s.title); setGiven(s.given); setWhen(s.when); setThen(s.then); setRuleId(s.ruleRefs[0]?.id ?? ''); }}>Correct scenario</button><details><summary>Scenario history</summary>{state.scenarios.filter(r => r.id === s.id).map(r => <p key={r.revision}>Revision {r.revision}: Given {r.given}; when {r.when}; then {r.then}</p>)}</details></div></article>)}</section>
    <form className="card stack" onSubmit={e => { e.preventDefault(); const rule = confirmed.find(r => r.id === ruleId); const record: ScenarioRevision = { ...common(), id: editingScenario?.id ?? crypto.randomUUID(), revision: (editingScenario?.revision ?? 0) + 1, predecessor: editingScenario?.revision ?? null, title: scenarioTitle, given, when, then, ruleRefs: rule ? [{ id: rule.id, revision: rule.revision }] : [], required: true, method: 'manual', verifierDigest: hashCanonicalSync({ domain: 'cf.manual-scenario/1', given, when, then }), confirmation: null, archived: false }; void command({ type: 'draftScenario', record }); }}><h3>{editingScenario ? 'Correct a behavioral example' : 'Add a manual behavioral example'}</h3><label className="field">Title <input type="text" required value={scenarioTitle} onChange={e => setScenarioTitle(e.target.value)} /></label><label className="field">Related confirmed rule <select value={ruleId} onChange={e => setRuleId(e.target.value)}><option value="">Select a rule (optional)</option>{confirmed.map(r => <option key={r.id} value={r.id}>{r.text}</option>)}</select></label><label className="field">Given <textarea required value={given} onChange={e => setGiven(e.target.value)} /></label><label className="field">When <textarea required value={when} onChange={e => setWhen(e.target.value)} /></label><label className="field">Then <textarea required value={then} onChange={e => setThen(e.target.value)} /></label><button className="btn btn-primary" type="submit" disabled={busy}>Save scenario draft</button>{editingScenario ? <button className="btn btn-outline" type="button" onClick={() => { setEditingScenario(null); setScenarioTitle(''); setGiven(''); setWhen(''); setThen(''); }}>Cancel scenario correction</button> : null}<p>Automated verifiers are independently pinned through the trusted runner workflow. This form creates a manual scenario requiring a human observation.</p></form>
  </>;
}
