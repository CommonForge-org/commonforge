import { useState } from 'react';
import type { ProjectState } from '@commonforge-org/core';
import { useApp } from '../lib/hooks.js';
import { NativeProject } from './ProjectKnowledge.js';

export function ProjectOutcomes() {
  return <NativeProject>{(state, command, busy) => <Outcomes state={state} command={command} busy={busy} />}</NativeProject>;
}
export function Outcomes({ state, command, busy }: { state: ProjectState; command: (body: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const { me } = useApp();
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const current = state.outcomes.filter(o => !state.outcomes.some(n => n.id === o.id && n.revision > o.revision));
  return <><section className="card"><h2>Outcomes</h2><p>Describe the improvement and how you will know it worked. Acceptance and deployment do not automatically achieve an outcome.</p>{current.length === 0 ? <p>No outcomes yet.</p> : current.map(o => <article className="update-card" key={o.id}><div><h3>{o.description}</h3><p>Status: {o.state} · revision {o.revision}</p><ul>{o.successCriteria.map((c,i) => <li key={i}>{c}</li>)}</ul><p>Owner: {o.owner}</p>{(['open', 'achieved', 'deferred'] as const).filter(s => s !== o.state).map(s => <button className="btn btn-outline" key={s} type="button" disabled={busy} onClick={() => void command({ type: 'upsertOutcome', record: { ...o, revision: o.revision + 1, author: me!.user.userId, createdAt: new Date().toISOString(), state: s } })}>Mark {s}</button>)}</div></article>)}</section><form className="card stack" onSubmit={e => { e.preventDefault(); void command({ type: 'upsertOutcome', record: { schemaVersion: 1, organizationId: state.organizationId, projectId: state.projectId, id: crypto.randomUUID(), author: me!.user.userId, createdAt: new Date().toISOString(), revision: 1, description, owner: me!.user.userId, successCriteria: criteria.split('\n').filter(x => x.trim()), state: 'open', taskIds: [] } }); }}><h3>Set an outcome</h3><label className="field">Desired improvement <textarea required value={description} onChange={e => setDescription(e.target.value)} /></label><label className="field">Success criteria (one per line) <textarea required value={criteria} onChange={e => setCriteria(e.target.value)} /></label><button className="btn btn-primary" type="submit" disabled={busy}>Create outcome</button></form></>;
}
