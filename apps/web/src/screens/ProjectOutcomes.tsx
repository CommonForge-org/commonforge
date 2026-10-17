import { useEffect, useId, useRef, useState } from 'react';
import { canonicalJson, type ProjectOutcome, type ProjectState } from '@commonforge-org/core';
import { useApp } from '../lib/hooks.js';
import { NativeProject } from './ProjectKnowledge.js';

export function ProjectOutcomes() {
  return <NativeProject>{(state, command, busy) => <Outcomes state={state} command={command} busy={busy} />}</NativeProject>;
}
export function Outcomes({ state, command, busy }: { state: ProjectState; command: (body: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const { me } = useApp();
  const formId=useId();
  const [description, setDescription] = useState('');
  const [criteria, setCriteria] = useState('');
  const [status, setStatus] = useState<ProjectOutcome['state']>('open');
  const [editing, setEditing] = useState<ProjectOutcome | null>(null);
  const [submitted, setSubmitted] = useState<ProjectOutcome | null>(null);
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  const current = state.outcomes.filter(o => !state.outcomes.some(n => n.id === o.id && n.revision > o.revision));
  const stale = editing !== null && current.find(o => o.id === editing.id)?.revision !== editing.revision;
  function clear() { setEditing(null); setDescription(''); setCriteria(''); setStatus('open'); setSubmitted(null); }
  // NativeProject displays action errors. Clear only after the exact submitted immutable record
  // appears in authoritative state; failed/conflicting saves retain the owner's unsaved text.
  useEffect(() => { if (submitted && state.outcomes.some(o => canonicalJson(o) === canonicalJson(submitted))) clear(); }, [state.outcomes, submitted]);
  useEffect(() => { if (editing) descriptionInput.current?.focus(); }, [editing]);
  return <>
    <section className="card"><h2>Outcomes</h2><p>Describe the improvement and how you will know it worked. Acceptance and deployment do not automatically achieve an outcome.</p>
      {current.length === 0 ? <p>No outcomes yet.</p> : current.map(o => <article className="update-card" key={o.id}><div>
        <h3>{o.description}</h3><p>Status: {o.state} · revision {o.revision}</p><ul>{o.successCriteria.map((c,i) => <li key={i}>{c}</li>)}</ul><p>Owner: {o.owner}</p><p>Recorded by {o.author} · {o.createdAt}</p>
        <button className="btn btn-outline" type="button" disabled={busy} onClick={() => { setEditing(o); setSubmitted(null); setDescription(o.description); setCriteria(o.successCriteria.join('\n')); setStatus(o.state); }}>Revise outcome</button>
        {(['open', 'achieved', 'deferred'] as const).filter(s => s !== o.state).map(s => <button className="btn btn-outline" key={s} type="button" disabled={busy} onClick={() => void command({ type: 'upsertOutcome', record: { ...o, revision: o.revision + 1, author: me!.user.userId, createdAt: new Date().toISOString(), state: s } })}>Mark {s}</button>)}
        <details><summary>Outcome revision history</summary>{state.outcomes.filter(r => r.id === o.id).sort((a,b)=>a.revision-b.revision).map(r => <section key={r.revision}><h4>Revision {r.revision} · {r.state}</h4><p>{r.description}</p><ul>{r.successCriteria.map((c,i)=><li key={i}>{c}</li>)}</ul><p>Owner: {r.owner} · recorded by {r.author} · {r.createdAt}</p></section>)}</details>
      </div></article>)}
    </section>
    <form className="card stack" aria-label={editing ? 'Revise outcome' : 'Set an outcome'} onSubmit={e => {
      e.preventDefault();
      if (busy || stale) return;
      const record:ProjectOutcome={schemaVersion:1,organizationId:state.organizationId,projectId:state.projectId,id:editing?.id??crypto.randomUUID(),author:me!.user.userId,createdAt:new Date().toISOString(),revision:(editing?.revision??0)+1,description:description.trim(),owner:editing?.owner??me!.user.userId,successCriteria:criteria.split('\n').map(s=>s.trim()).filter(Boolean),state:status,taskIds:editing?.taskIds??[]};
      setSubmitted(record); void command({type:'upsertOutcome',record});
    }}>
      <h3>{editing ? 'Revise an outcome' : 'Set an outcome'}</h3>
      {editing ? <p>Editing revision {editing.revision}. Saving records a new revision and retains the earlier purpose and criteria in history.</p> : null}
      {stale ? <p role="alert">This outcome changed while you were editing. Cancel this edit and review the latest revision before saving.</p> : null}
      <label className="field"><span id={`${formId}-description-label`}>Desired improvement</span><textarea aria-labelledby={`${formId}-description-label`} ref={descriptionInput} required disabled={busy} value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label className="field"><span id={`${formId}-criteria-label`}>Success criteria (one per line)</span><textarea aria-labelledby={`${formId}-criteria-label`} required disabled={busy} value={criteria} onChange={e => setCriteria(e.target.value)} /></label>
      {editing ? <label className="field"><span id={`${formId}-status-label`}>Outcome status</span><select aria-labelledby={`${formId}-status-label`} disabled={busy} value={status} onChange={e=>setStatus(e.target.value as ProjectOutcome['state'])}><option value="open">Open</option><option value="achieved">Achieved</option><option value="deferred">Deferred</option></select></label> : null}
      <button className="btn btn-primary" type="submit" disabled={busy||stale||!description.trim()||!criteria.split('\n').some(s=>s.trim())}>{editing ? 'Save outcome revision' : 'Create outcome'}</button>
      {editing ? <button className="btn btn-outline" type="button" disabled={busy} onClick={clear}>Cancel outcome edit</button> : null}
    </form>
  </>;
}
