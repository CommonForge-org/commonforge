/** New organization (instance admins): name it, become its owner, then invite people. */
import { useState, type FormEvent } from "react";
import { useAction, useApp } from "../lib/hooks.js";
import { membersHref, navigate } from "../lib/router.js";
import { ErrorNote } from "../ui.js";

export function NewOrgView({ busy, error, onCreate }: { busy: boolean; error: unknown; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onCreate(name.trim());
  };
  return (
    <div className="page">
      <h1 className="page-title">New organization</h1>
      <p className="muted">One organization per client. You become its owner; invite people next.</p>
      <form className="invite-form" onSubmit={submit}>
        <label className="field">
          Organization name
          <input type="text" required maxLength={128} value={name} onChange={(e) => setName(e.target.value)} placeholder="Client name" />
        </label>
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          Create organization
        </button>
      </form>
      <ErrorNote error={error} />
    </div>
  );
}

export function NewOrg() {
  const { api, refreshMe } = useApp();
  const act = useAction(async (name: string) => {
    const o = await api.createOrg(name);
    await refreshMe();
    navigate(membersHref(o.orgId));
  });
  return <NewOrgView busy={act.busy} error={act.error} onCreate={(n) => void act.run(n)} />;
}
