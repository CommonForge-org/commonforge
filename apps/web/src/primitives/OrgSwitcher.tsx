/**
 * The organization switcher at the bottom of the left sidebar. Shown to people in two or
 * more organizations, and to instance admins (who also get "New organization"); each entry opens that organization's home with the viewer's role there.
 */
import { useEffect, useRef } from "react";
import type { Membership } from "../api/types.js";
import { orgLabels, roleLabel } from "../lib/orgs.js";
import { NEW_ORG_HREF, orgHref } from "../lib/router.js";
import { Link } from "../ui.js";
import { Icon } from "./icons.js";

export function OrgSwitcher({ memberships, current, canCreateOrgs = false }: { memberships: Membership[]; current: string; canCreateOrgs?: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);

  // a disclosure that closes on Escape or a click elsewhere, like a menu
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  if (memberships.length < 2 && !canCreateOrgs) return null;
  const labels = orgLabels(memberships);
  const here = memberships.find((m) => m.orgId === current);
  return (
    <details className="org-switcher" ref={ref}>
      <summary className="org-switcher-button" aria-label={`Switch organization (current: ${labels.get(current) ?? current})`}>
        <Icon name="org" />
        <span className="org-switcher-current">
          <span className="org-switcher-name">{labels.get(current) ?? current}</span>
          {here ? <span className="org-switcher-role">{roleLabel(here.role)}</span> : null}
        </span>
        <Icon name="switch" size={16} />
      </summary>
      {/* close after a choice, also when it is the organization already open */}
      <div className="org-switcher-menu" onClick={() => ref.current?.removeAttribute("open")}>
        <p className="org-switcher-heading">Organizations</p>
        <ul>
          {memberships.map((m) => (
            <li key={m.orgId}>
              <Link href={orgHref(m.orgId)} className={`org-switcher-item ${m.orgId === current ? "is-current" : ""}`.trim()} {...(m.orgId === current ? { ariaCurrent: "true" as const } : {})}>
                <span className="org-switcher-name">{labels.get(m.orgId)}</span>
                <span className="role-chip">{roleLabel(m.role)}</span>
              </Link>
            </li>
          ))}
        </ul>
        {canCreateOrgs ? (
          <Link href={NEW_ORG_HREF} className="org-switcher-item org-switcher-new">
            <span className="org-switcher-name">New organization</span>
            <Icon name="plus" size={16} />
          </Link>
        ) : null}
      </div>
    </details>
  );
}
