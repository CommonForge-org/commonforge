/** Project Settings (admin screens spec §3). Folders, Access and Policy. */
import { useState } from "react";
import type { AccessLevel, PersonAccess, Role } from "../api/types.js";
import { useAction, useApp, useLoad } from "../lib/hooks.js";
import { settingsHref } from "../lib/router.js";
import { ErrorNote, Link, Loading } from "../ui.js";
import { AccessRow } from "./AccessRow.js";
import { FoldersTab } from "./FoldersTab.js";
import { PolicyTab } from "./PolicyTab.js";
import { useProject } from "./project-data.js";

export function AccessView({ viewerRole, people, busyUser, error, onSave }: { viewerRole: Role; people: PersonAccess[]; busyUser: string | null; error: unknown; onSave: (userId: string, level: AccessLevel, folders: Record<string, AccessLevel>) => void }) {
  return (
    <section className="access" aria-label="Access">
      <p className="muted small">Who can see this project. Folders follow the project level unless you set a lower one. Folders added later are given to everyone who has the project.</p>
      <ErrorNote error={error} />
      {people.map((p) => (
        <AccessRow key={`${p.userId}/${p.level}/${p.folders.map((f) => f.level).join(",")}`} label={p.email} person={p} viewerRole={viewerRole} busy={busyUser === p.userId} onSave={(level, folders) => onSave(p.userId, level, folders)} />
      ))}
    </section>
  );
}

/** The access data loads only while the Access tab is showing. */
function AccessSection() {
  const { api } = useApp();
  const { org, pid, role } = useProject();
  const load = useLoad(() => api.getProjectAccess(org, pid), `${org}/${pid}/access`);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const act = useAction(async (userId: string, level: AccessLevel, folders: Record<string, AccessLevel>) => {
    setBusyUser(userId);
    try {
      await api.putProjectAccess(org, pid, { userId, level, ...(Object.keys(folders).length ? { folders } : {}) });
      load.reload();
    } finally {
      setBusyUser(null);
    }
  });
  if (load.error) return <ErrorNote error={load.error} onRetry={load.reload} />;
  if (!load.data) return <Loading what="Loading access" />;
  return <AccessView viewerRole={role} people={load.data} busyUser={busyUser} error={act.error} onSave={(u, l, f) => void act.run(u, l, f)} />;
}

export function ProjectSettings({ section }: { section: "access" | "folders" | "policy" }) {
  const { org, pid } = useProject();
  return (
    <div className="settings">
      <nav className="settings-tabs" aria-label="Settings sections">
        {(["folders", "access", "policy"] as const).map((s) => (
          <Link key={s} href={settingsHref(org, pid, s)} className={`seg ${section === s ? "seg-active" : ""}`.trim()} {...(section === s ? { ariaCurrent: "page" as const } : {})}>
            {s === "folders" ? "Folders" : s === "access" ? "Access" : "Policy"}
          </Link>
        ))}
      </nav>
      {section === "folders" ? <FoldersTab /> : section === "policy" ? <PolicyTab /> : <AccessSection />}
    </div>
  );
}
