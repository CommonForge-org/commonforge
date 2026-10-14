/** Settings → Policy (admin screens spec §7): forms for the everyday parts, JSON for the rest (with help and a valid example), review before saving. */
import { useEffect, useState, type ReactNode } from "react";
import { ApiError, type CommonForgeApi } from "../api/client.js";
import type { PolicyIssue, ProjectPolicy } from "../api/types.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import { formatTime } from "../lib/model.js";
import { changedSections, fromPolicy, issuesAt, POLICY_ROLES, SECTION_LABEL, toPolicy, unclaimedIssues, type PolicyDraft, type PolicyRole, type SectionChange } from "../lib/policy.js";
import { roleLabel } from "../lib/orgs.js";
import { policyExamples, releaseTargetIds, SECTION_HELP, type JsonSection } from "../lib/policy-examples.js";
import { ErrorNote } from "../ui.js";
import { StagingBaselineNote } from "./GettingStarted.js";
import { useProject } from "./project-data.js";

export interface PolicyViewProps {
  editable: boolean;
  mounts: Array<{ mountName: string }>;
  revision: number;
  changed: { at: string; by: string | null } | null | undefined;
  draft: PolicyDraft;
  issues: PolicyIssue[];
  dirty: boolean;
  review: SectionChange[] | null;
  busy: boolean;
  error: unknown;
  /** the newer revision when a save hit 409 policy_changed */
  conflict: number | null;
  /** the server hasn't checked the document as it is now (the check is pending or in flight) */
  checking: boolean;
  /** the server check of the document as it is now failed (the request, not the policy) */
  checkFailed: boolean;
  onRetryCheck: () => void;
  onChange: (d: PolicyDraft) => void;
  onReview: () => void;
  onBack: () => void;
  onSave: () => void;
  onReload: () => void;
  /** a valid example per JSON section (`lib/policy-examples.ts`), once the Worker name prefix is known */
  examples?: Record<JsonSection, string> | undefined;
  /** under the Staging section: why staging is waiting, if it is */
  stagingNote?: ReactNode;
}

function Issues({ issues, path }: { issues: PolicyIssue[]; path: string }) {
  const here = issuesAt(issues, path);
  if (!here.length) return null;
  return (
    <ul className="field-issues" role="alert">
      {here.map((i, n) => (
        <li key={n}>{i.message}</li>
      ))}
    </ul>
  );
}

function RoleSet({ legend, value, hidden = [], disabled, onChange, issues, path }: { legend: string; value: PolicyRole[]; hidden?: string[]; disabled: boolean; onChange: (v: PolicyRole[]) => void; issues: PolicyIssue[]; path: string }) {
  return (
    <fieldset className="policy-section">
      <legend>{legend}</legend>
      {POLICY_ROLES.map((r) => (
        <label key={r} className="check">
          <input type="checkbox" disabled={disabled} checked={value.includes(r)} onChange={(e) => onChange(e.target.checked ? POLICY_ROLES.filter((x) => x === r || value.includes(x)) : value.filter((x) => x !== r))} />
          {roleLabel(r)}
        </label>
      ))}
      {hidden.length ? <p className="small muted">Also allowed (not changeable here): {hidden.map(roleLabel).join(", ")}</p> : null}
      <Issues issues={issues} path={path} />
    </fieldset>
  );
}

const JSON_SECTIONS = ["contracts", "preview", "release", "staging"] as const;

export function PolicyView(p: PolicyViewProps) {
  const d = p.draft;
  const ro = !p.editable;
  const set = (patch: Partial<PolicyDraft>) => p.onChange({ ...d, ...patch });
  const other = unclaimedIssues(p.issues, d);
  const header = (
    <p className="muted small">
      Revision {p.revision}
      {p.changed ? (
        <>
          , changed by {p.changed.by ?? "someone"}, {formatTime(p.changed.at)}
        </>
      ) : null}
    </p>
  );

  if (p.review)
    return (
      <section className="policy" aria-label="Policy">
        {header}
        <h2>Review changes</h2>
        {p.conflict !== null ? (
          <div className="note note-bad" role="alert">
            Someone else saved the policy (revision {p.conflict}) while you were editing.{" "}
            <button type="button" className="btn btn-quiet btn-small" onClick={p.onReload}>
              Load the newer version
            </button>
          </div>
        ) : null}
        {p.review.map((c) => (
          <div key={c.section} className="policy-change">
            <h3>{c.label}</h3>
            <div className="policy-diff">
              <pre aria-label={`Before: ${c.label}`}>{c.before}</pre>
              <pre aria-label={`After: ${c.label}`}>{c.after}</pre>
            </div>
          </div>
        ))}
        <p className="small">Changes checked or released after this save use the new policy.</p>
        <ErrorNote error={p.error} />
        <div className="policy-actions">
          <button type="button" className="btn btn-primary" disabled={p.busy || p.conflict !== null} onClick={p.onSave}>
            Save
          </button>
          <button type="button" className="btn btn-quiet" disabled={p.busy} onClick={p.onBack}>
            Back to editing
          </button>
        </div>
      </section>
    );

  return (
    <section className="policy" aria-label="Policy">
      {header}
      {ro ? <p className="small muted">Only owners can change the policy.</p> : null}
      <RoleSet legend={SECTION_LABEL.approvalRoles} value={d.approvalRoles} hidden={d.otherApprovalRoles} disabled={ro} onChange={(v) => set({ approvalRoles: v })} issues={p.issues} path="approvalRoles" />
      <RoleSet legend={SECTION_LABEL.publishRoles} value={d.publishRoles} disabled={ro} onChange={(v) => set({ publishRoles: v })} issues={p.issues} path="publishRoles" />

      <fieldset className="policy-section">
        <legend>Checks</legend>
        <p className="small muted">Commands run on every change. A failing optional check is recorded but doesn't block.</p>
        {d.checks.map((c, i) => {
          const n = i + 1;
          const upd = (patch: Partial<typeof c>) => set({ checks: d.checks.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
          return (
            <div key={i} className="policy-check">
              <input aria-label={`Name of check ${n}`} disabled={ro} value={c.checkId} onChange={(e) => upd({ checkId: e.target.value })} placeholder="build" />
              <select aria-label={`Folder of check ${n}`} disabled={ro} value={c.mountName} onChange={(e) => upd({ mountName: e.target.value })}>
                {p.mounts.some((m) => m.mountName === c.mountName) ? null : <option value={c.mountName}>{c.mountName || "Choose a folder"}</option>}
                {p.mounts.map((m) => (
                  <option key={m.mountName} value={m.mountName}>
                    {m.mountName}
                  </option>
                ))}
              </select>
              <input aria-label={`Command of check ${n}`} disabled={ro} value={c.command} onChange={(e) => upd({ command: e.target.value })} placeholder="pnpm test" className="mono" />
              <input aria-label={`Timeout of check ${n} in seconds`} disabled={ro} type="number" min={1} max={3600} value={c.timeoutSeconds} onChange={(e) => upd({ timeoutSeconds: e.target.value })} />
              <label className="check">
                <input type="checkbox" aria-label={`Check ${n} is required`} disabled={ro} checked={c.required} onChange={(e) => upd({ required: e.target.checked })} /> Required
              </label>
              {ro ? null : (
                <button type="button" className="btn btn-quiet btn-small" aria-label={`Remove check ${n}`} onClick={() => set({ checks: d.checks.filter((_, j) => j !== i) })}>
                  Remove
                </button>
              )}
              <Issues issues={p.issues} path={`checks.${i}`} />
            </div>
          );
        })}
        {ro ? null : (
          <button type="button" className="btn btn-quiet btn-small" onClick={() => set({ checks: [...d.checks, { checkId: "", mountName: p.mounts[0]?.mountName ?? "", command: "", timeoutSeconds: "600", required: true }] })}>
            Add check
          </button>
        )}
        <Issues issues={p.issues.filter((x) => x.path === "checks")} path="checks" />
      </fieldset>

      <fieldset className="policy-section">
        <legend>Rules</legend>
        <p className="small muted">Plain-text rules. Given to agents with every task.</p>
        {d.rules.map((r, i) => (
          <div key={i} className="policy-rule">
            <textarea aria-label={`Rule ${i + 1}`} disabled={ro} value={r} rows={2} onChange={(e) => set({ rules: d.rules.map((x, j) => (j === i ? e.target.value : x)) })} />
            {ro ? null : (
              <button type="button" className="btn btn-quiet btn-small" aria-label={`Remove rule ${i + 1}`} onClick={() => set({ rules: d.rules.filter((_, j) => j !== i) })}>
                Remove
              </button>
            )}
            <Issues issues={p.issues} path={`rules.${i}`} />
          </div>
        ))}
        {ro ? null : (
          <button type="button" className="btn btn-quiet btn-small" onClick={() => set({ rules: [...d.rules, ""] })}>
            Add rule
          </button>
        )}
        <Issues issues={p.issues.filter((x) => x.path === "rules")} path="rules" />
      </fieldset>

      {JSON_SECTIONS.map((k) => {
        const example = p.examples?.[k];
        // an empty section (contracts: an empty list) can start from the example
        const blank = k === "contracts" ? /^\s*\[\s*\]\s*$/.test(d[k]) : d[k].trim() === "";
        return (
          <div key={k} className="policy-section" data-testid={`policy-json-${k}`}>
            <label className="field">
              {SECTION_LABEL[k]} (JSON)
              <span className="small muted">
                {SECTION_HELP[k]} Edit as JSON{k === "contracts" ? "" : "; leave empty for none"}.
              </span>
              <textarea className="mono" rows={k === "contracts" ? 6 : 10} disabled={ro} value={d[k]} onChange={(e) => set({ [k]: e.target.value } as Partial<PolicyDraft>)} />
            </label>
            {k === "staging" ? p.stagingNote : null}
            <Issues issues={p.issues} path={k} />
            {example ? (
              <details className="small">
                <summary>Show example</summary>
                <pre className="mono policy-example" aria-label={`Example: ${SECTION_LABEL[k]}`}>{example}</pre>
                {!ro && blank ? (
                  <button type="button" className="btn btn-quiet btn-small" onClick={() => set({ [k]: example } as Partial<PolicyDraft>)}>
                    Use this example
                  </button>
                ) : null}
              </details>
            ) : null}
          </div>
        );
      })}

      {other.length ? (
        <div className="policy-section">
          <h3>Other problems</h3>
          <ul className="field-issues" role="alert">
            {other.map((i, n) => (
              <li key={n}>
                {i.path ? <span className="mono">{i.path}</span> : null}
                {i.path ? ": " : ""}
                {i.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <ErrorNote error={p.error} />
      {ro ? null : p.checkFailed ? (
        <div className="note note-bad" role="alert">
          Couldn't check the policy. Try again.{" "}
          <button type="button" className="btn btn-quiet btn-small" onClick={p.onRetryCheck}>
            Retry
          </button>
        </div>
      ) : p.checking && p.dirty ? (
        <p className="small muted" role="status">
          Checking…
        </p>
      ) : null}
      {ro ? null : (
        <div className="policy-actions">
          <button type="button" className="btn btn-primary" disabled={p.busy || !p.dirty || p.issues.length > 0 || p.checking || p.checkFailed} onClick={p.onReview}>
            Review changes
          </button>
        </div>
      )}
    </section>
  );
}

/** Save the whole document under the revision the editor opened. A 409 `policy_changed` is a conflict, not an error. */
export async function savePolicy(api: CommonForgeApi, org: string, pid: string, policy: ProjectPolicy, revision: number): Promise<{ saved: { policyRevision: number } } | { conflict: number }> {
  try {
    const saved = await api.putPolicy(org, pid, policy, revision);
    return { saved: { policyRevision: saved.policyRevision } };
  } catch (e) {
    if (e instanceof ApiError && e.code === "policy_changed") return { conflict: Number(e.details?.policyRevision) || revision + 1 };
    throw e;
  }
}

export function PolicyTab() {
  const { api } = useApp();
  const { org, pid, role, project, reloadProject, live } = useProject();
  // the Worker name prefix makes the Release example valid as shown; without it, no examples
  const deploy = useLoad(() => api.getDeployResources(org).catch(() => null), `${org}/deploy-resources`);
  const examples = deploy.data ? policyExamples({ workerPrefix: deploy.data.workerPrefix, folders: project.mounts, releaseTargets: releaseTargetIds(project.policy?.release) }) : undefined;
  const saved = project.policy as ProjectPolicy | undefined;
  const [draft, setDraft] = useState<PolicyDraft>(() => fromPolicy(saved));
  // a new saved revision (ours, or loaded after a conflict) resets the draft
  useEffect(() => setDraft(fromPolicy(saved)), [project.policyRevision]);
  // the server's answer for one exact document (`key`): shown, and trusted for Review, only while
  // the draft is still that document
  const [validated, setValidated] = useState<{ key: string; issues: PolicyIssue[]; failed: boolean } | null>(null);
  const [retries, setRetries] = useState(0);
  const [review, setReview] = useState<SectionChange[] | null>(null);
  const [conflict, setConflict] = useState<number | null>(null);
  const editable = role === "owner";
  const local = toPolicy(draft);
  const docKey = local.policy ? JSON.stringify(local.policy) : "";
  useEffect(() => {
    if (!editable || !local.policy) return;
    const key = docKey;
    const doc = local.policy;
    let alive = true;
    const t = setTimeout(() => {
      api.validatePolicy(org, pid, doc).then(
        (r) => alive && setValidated({ key, issues: r.issues, failed: false }),
        () => alive && setValidated({ key, issues: [], failed: true }),
      );
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [docKey, editable, retries]);
  const current = local.policy && validated?.key === docKey ? validated : null;
  const checking = editable && !!local.policy && current === null;
  const issues = [...local.issues, ...(current?.issues ?? [])];
  const changes = local.policy ? changedSections(saved, local.policy) : null;
  const act = useAction(async () => {
    const r = await savePolicy(api, org, pid, local.policy!, project.policyRevision);
    if ("conflict" in r) {
      setConflict(r.conflict);
      return;
    }
    setReview(null);
    reloadProject?.();
  });
  return (
    <PolicyView
      editable={editable}
      mounts={project.mounts.map((m) => ({ mountName: m.mountName }))}
      revision={project.policyRevision}
      changed={project.policyChanged}
      draft={draft}
      issues={issues}
      dirty={changes === null || changes.length > 0}
      review={review}
      busy={act.busy}
      error={act.error}
      conflict={conflict}
      checking={checking}
      checkFailed={!!current?.failed}
      onRetryCheck={() => {
        setValidated(null);
        setRetries((n) => n + 1);
      }}
      onChange={setDraft}
      onReview={() => changes && current && !current.failed && issues.length === 0 && setReview(changes)}
      onBack={() => {
        act.clearError();
        setReview(null);
      }}
      examples={examples}
      stagingNote={<StagingBaselineNote staging={live?.staging} role={role} org={org} pid={pid} />}
      onSave={() => void act.run()}
      onReload={() => {
        setConflict(null);
        setReview(null);
        reloadProject?.();
      }}
    />
  );
}
