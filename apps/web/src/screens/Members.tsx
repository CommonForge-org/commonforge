/** Members of one organization (admin screens spec §4): owners invite, change roles and remove; developers read. */
import { useState, type FormEvent } from "react";
import type { InviteResult, MemberView, ProjectSummary, Role } from "../api/types.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import { formatTime } from "../lib/model.js";
import { memberHref, navigate, orgHref } from "../lib/router.js";
import { roleLabel } from "../lib/orgs.js";
import { ConfirmSheet, EmptyState } from "../primitives/index.js";
import { ErrorNote, Link, Loading } from "../ui.js";
import { OrgFrame } from "./OrgFrame.js";

const ROLES: Role[] = ["owner", "developer", "client", "viewer"];

/** What an invite row reports: the add's outcome, or "resent" after a successful Resend. */
export type NoticeKind = InviteResult["invite"] | "resent";

export type PendingAction = { kind: "role"; userId: string; role: Role } | { kind: "remove"; userId: string } | null;

export interface MembersViewProps {
  org: string;
  viewerRole: Role;
  viewerId: string;
  members: MemberView[];
  /** the projects an invite can give access to */
  projects: ProjectSummary[];
  pending: PendingAction;
  busy: boolean;
  error: unknown;
  /** the outcome of the last invite or resend, for its row */
  notice: { userId: string; invite: NoticeKind; /** names of projects whose access grant failed after the invite */ accessFailed?: string[] } | null;
  /** changes after each successful invite, which empties the invite form */
  formKey?: number;
  onInvite: (email: string, role: Role, projectIds: string[]) => void;
  onAskRole: (userId: string, role: Role) => void;
  onAskRemove: (userId: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onResend: (userId: string) => void;
}

/** What a role change does, in the API's terms (PATCH …/members/:user). */
export function roleChangeEffect(from: Role, to: Role): string {
  const writer = (r: Role) => r === "owner" || r === "developer";
  if (writer(from) && !writer(to)) return "This removes their write access and ends any agent tasks they are running.";
  if (to === "owner") return "Owners can manage members, access and policy.";
  return `They will have the ${roleLabel(to).toLowerCase()} role's rights in every project they can see.`;
}

const NOTICE: Record<NoticeKind, string> = {
  resent: "Invite sent again.",
  sent: "Added. We emailed them an invite.",
  failed: "Added, but the invite email didn't send.",
  rate_limited: "Added. Too many invites were sent recently, so no email went; resend later.",
};

/** Owns the typed email, role and chosen projects; a new `key` (after a successful invite) empties it. */
/** The invite's project checklist; owners see every project, so it is disabled for them (the hint stays). */
export function InviteProjects({ role, projects, selected, onToggle }: { role: Role; projects: ProjectSummary[]; selected: string[]; onToggle: (projectId: string, on: boolean) => void }) {
  if (!projects.length) return null;
  return (
    <fieldset className="invite-projects" disabled={role === "owner"}>
      <legend>Give access to projects</legend>
      {projects.map((pr) => (
        <label key={pr.projectId} className="check">
          <input type="checkbox" checked={selected.includes(pr.projectId)} onChange={(e) => onToggle(pr.projectId, e.target.checked)} />
          {pr.name}
        </label>
      ))}
      <span className="muted small">{role === "developer" ? "Developers get read + write." : role === "owner" ? "Owners already see every project." : "Read access."}</span>
    </fieldset>
  );
}

function InviteForm({ busy, projects, onInvite }: { busy: boolean; projects: ProjectSummary[]; onInvite: MembersViewProps["onInvite"] }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("client");
  const [selected, setSelected] = useState<string[]>([]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim()) onInvite(email.trim(), role, role === "owner" ? [] : selected);
  };
  return (
    <form className="invite-form" onSubmit={submit} aria-label="Invite a member">
      <label className="field">
        Email
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
      </label>
      <label className="field">
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
      </label>
      <InviteProjects role={role} projects={projects} selected={selected} onToggle={(pid, on) => setSelected((s) => (on ? [...s, pid] : s.filter((x) => x !== pid)))} />
      <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
        Invite
      </button>
    </form>
  );
}

export function MembersView(p: MembersViewProps) {
  const owner = p.viewerRole === "owner";
  const owners = p.members.filter((m) => m.role === "owner").length;
  const who = (id: string) => p.members.find((m) => m.userId === id);
  // a failed confirmed action is shown inside its open sheet; otherwise (invite, resend) above the table
  const sheetOpen = p.pending !== null && who(p.pending.userId) !== undefined;
  return (
    <div className="page members">
      <h1 className="page-title">Members</h1>
      {owner ? (
        <InviteForm key={p.formKey ?? 0} busy={p.busy} projects={p.projects} onInvite={p.onInvite} />
      ) : null}
      {sheetOpen ? null : <ErrorNote error={p.error} />}
      {owner && p.members.length > 0 && p.members.every((m) => m.role === "owner") ? (
        <EmptyState compact icon="human" title="Only owners so far.">
          {p.projects.length ? (
            "Invite your client above: choose Client and tick their project. They get an email with a sign-in link and see only that project."
          ) : (
            <>
              <Link href={orgHref(p.org)}>Create a project</Link> first, then invite your client with access to it.
            </>
          )}
        </EmptyState>
      ) : null}
      {p.members.length === 0 ? (
        <EmptyState compact icon="human" title="No members yet." />
      ) : (
        <table className="members-table">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Member since</th>
              {owner ? (
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {p.members.map((m) => {
              const lastOwner = m.role === "owner" && owners <= 1;
              return (
                <tr key={m.userId}>
                  <td>
                    <Link href={memberHref(p.org, m.userId)}>{m.email}</Link>
                    {m.userId === p.viewerId ? <span className="muted small"> (you)</span> : null}
                    {p.notice?.userId === m.userId ? (
                      <div className={`small ${(p.notice.invite === "sent" || p.notice.invite === "resent") && !p.notice.accessFailed?.length ? "muted" : "note-inline-bad"}`} role="status">
                        {NOTICE[p.notice.invite]}{" "}
                        {p.notice.accessFailed?.length ? <span>Couldn't give access to {p.notice.accessFailed.join(", ")}. </span> : null}
                        {p.notice.invite === "failed" || p.notice.invite === "rate_limited" ? (
                          <button type="button" className="btn btn-quiet btn-small" disabled={p.busy} onClick={() => p.onResend(m.userId)}>
                            Resend invite
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {owner ? (
                      <select aria-label={`Role of ${m.email}`} value={m.role} disabled={p.busy || lastOwner} title={lastOwner ? "The only owner can't change role" : undefined} onChange={(e) => p.onAskRole(m.userId, e.target.value as Role)}>
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      roleLabel(m.role)
                    )}
                    {owner && lastOwner ? <div className="muted small">The only owner</div> : null}
                  </td>
                  <td className="muted small">{m.since ? formatTime(m.since) : ""}</td>
                  {owner ? (
                    <td>
                      <button type="button" className="btn btn-quiet btn-small" aria-label={`Remove ${m.email}`} disabled={p.busy || lastOwner} onClick={() => p.onAskRemove(m.userId)}>
                        Remove
                      </button>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {p.pending?.kind === "role" && who(p.pending.userId) ? (
        <ConfirmSheet
          title={`Make ${who(p.pending.userId)!.email} ${p.pending.role === "owner" ? "an owner" : `a ${p.pending.role}`}?`}
          does={roleChangeEffect(who(p.pending.userId)!.role, p.pending.role)}
          confirmLabel="Change role"
          busy={p.busy}
          onConfirm={p.onConfirm}
          onCancel={p.onCancel}
        >
          <ErrorNote error={p.error} />
        </ConfirmSheet>
      ) : null}
      {p.pending?.kind === "remove" && who(p.pending.userId) ? (
        <ConfirmSheet
          title={`Remove ${who(p.pending.userId)!.email} from this organization?`}
          does="Their access to every project ends, and any agent tasks they are running stop."
          doesNot="Nothing they made is deleted."
          confirmLabel="Remove"
          tone="blocked"
          busy={p.busy}
          onConfirm={p.onConfirm}
          onCancel={p.onCancel}
        >
          <ErrorNote error={p.error} />
        </ConfirmSheet>
      ) : null}
    </div>
  );
}

export function Members({ org, role, onSignOut }: { org: string; role: Role; onSignOut?: () => void }) {
  const { api, me, refreshMe } = useApp();
  const load = useLoad(() => api.listMembers(org), `${org}/members`);
  const projects = useLoad(() => api.listProjects(org), `${org}/projects`);
  const [pending, setPending] = useState<PendingAction>(null);
  const [notice, setNotice] = useState<MembersViewProps["notice"]>(null);
  const [formKey, setFormKey] = useState(0);
  const act = useAction(async (fn: () => Promise<"gone" | void>) => {
    // after the viewer removes themself this organization is gone: nothing to reload
    if ((await fn()) !== "gone") load.reload();
  });
  let content;
  if (load.error) content = <ErrorNote error={load.error} onRetry={load.reload} />;
  else if (!load.data) content = <Loading what="Loading members" />;
  else
    content = (
      <MembersView
        org={org}
        viewerRole={role}
        viewerId={me?.user.userId ?? ""}
        members={load.data}
        projects={projects.data ?? []}
        pending={pending}
        busy={act.busy}
        error={act.error}
        notice={notice}
        formKey={formKey}
        onInvite={(email, r, projectIds) =>
          void act.run(async () => {
            const res = await api.inviteMember(org, { email, role: r });
            const failed: string[] = [];
            for (const pid of projectIds) {
              try {
                await api.putProjectAccess(org, pid, { userId: res.userId, level: r === "developer" ? "write" : "read" });
              } catch {
                failed.push((projects.data ?? []).find((x) => x.projectId === pid)?.name ?? pid);
              }
            }
            setNotice({ userId: res.userId, invite: res.invite, ...(failed.length ? { accessFailed: failed } : {}) });
            setFormKey((k) => k + 1);
          })
        }
        onAskRole={(userId, r) => {
          act.clearError();
          setPending({ kind: "role", userId, role: r });
        }}
        onAskRemove={(userId) => {
          act.clearError();
          setPending({ kind: "remove", userId });
        }}
        onCancel={() => {
          act.clearError();
          setPending(null);
        }}
        onConfirm={() => {
          const p = pending;
          if (!p) return;
          void act.run(async () => {
            if (p.kind === "role") await api.updateMemberRole(org, p.userId, p.role);
            else await api.removeMember(org, p.userId);
            setPending(null);
            // the viewer changed their own membership: reread /api/me, and leave an organization they left
            if (p.userId === me?.user.userId) {
              await refreshMe();
              if (p.kind === "remove") {
                navigate("/");
                return "gone";
              }
            }
          });
        }}
        onResend={(userId) =>
          void act.run(async () => {
            await api.resendInvite(org, userId);
            setNotice({ userId, invite: "resent" });
          })
        }
      />
    );
  return (
    <OrgFrame org={org} role={role} active="members" {...(onSignOut ? { onSignOut } : {})}>
      {content}
    </OrgFrame>
  );
}
