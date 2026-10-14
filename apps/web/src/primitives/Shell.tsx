/**
 * The app frame from the approved mockups (docs/design/mockups/): header (logo, breadcrumb,
 * "Viewing as …" chip, inspector toggle for developers, avatar) and the left section nav.
 */
import type { ReactNode } from "react";
import type { Role } from "../api/types.js";
import { isDeveloperRole } from "../lib/model.js";
import { Link } from "../ui.js";
import { CountBadge } from "./Badge.js";
import { Icon, type IconName } from "./icons.js";
import { InspectorToggle } from "./InspectorDrawer.js";
import { initials, type StateKind } from "./state.js";

/** Served from `public/brand/` (copied unchanged from `brand/`, see brand/README.md). */
export const BRAND = {
  headerLogoDark: "/brand/commonforge-headerlogo-dark.png",
  icon: "/brand/commonforge-icon-512.png",
} as const;

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  if (!crumbs.length) return null;
  return (
    <nav className="crumbbar" aria-label="Breadcrumb">
      <ol>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${i}-${c.label}`}>
              {i > 0 ? (
                <span className="crumb-sep" aria-hidden="true">
                  /
                </span>
              ) : null}
              {c.href && !last ? (
                <Link href={c.href}>{c.label}</Link>
              ) : (
                <span className={last ? "crumb-current" : ""} {...(last ? { "aria-current": "page" as const } : {})}>
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function viewingAs(role: Role): string {
  return isDeveloperRole(role) ? "developer" : role;
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size }} title={name}>
      <span aria-hidden="true">{initials(name)}</span>
      <span className="sr-only">Signed in as {name}</span>
    </span>
  );
}

export function AppHeader({ crumbs = [], role, user, onSignOut, inspector }: { crumbs?: Crumb[]; role?: Role | undefined; user?: string | undefined; onSignOut?: (() => void) | undefined; inspector?: { open: boolean; onToggle: () => void } | undefined }) {
  return (
    <header className="app-header">
      <Link href="/" className="brand" title="CommonForge home">
        <img className="brand-logo" src={BRAND.headerLogoDark} alt="CommonForge" width={164} height={30} />
      </Link>
      <Breadcrumb crumbs={crumbs} />
      <div className="app-header-spacer" />
      <div className="app-header-tools">
        {role ? <span className="viewing-chip">Viewing as {viewingAs(role)}</span> : null}
        {inspector ? <InspectorToggle open={inspector.open} onToggle={inspector.onToggle} /> : null}
        {user ? (
          <Link href="/account" className="avatar-link" title="Your account and sessions">
            <Avatar name={user} />
          </Link>
        ) : null}
        {onSignOut ? (
          <button type="button" className="btn btn-quiet btn-small" onClick={onSignOut}>
            Sign out
          </button>
        ) : null}
      </div>
    </header>
  );
}

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  href: string;
  count?: number;
  countState?: StateKind;
  /** screen-reader text for the count (e.g. "Needs your decision · 2") */
  countLabel?: string;
  extra?: ReactNode;
}

/** `footer` sits at the bottom of the sidebar (the organization switcher). */
export function SideNav({ items, active, label = "Project sections", footer }: { items: NavItem[]; active: string; label?: string; footer?: ReactNode }) {
  return (
    <nav className="sidenav" aria-label={label}>
      {items.map((it) => (
        <Link key={it.id} href={it.href} className={`nav-item ${active === it.id ? "nav-item-active tab-active" : ""}`.trim()} {...(active === it.id ? { ariaCurrent: "page" as const } : {})}>
          <span className="nav-item-main">
            <Icon name={it.icon} />
            {it.label}
          </span>
          {it.extra}
          {it.count ? <CountBadge count={it.count} {...(it.countState ? { state: it.countState } : {})} {...(it.countLabel ? { label: it.countLabel } : {})} /> : null}
        </Link>
      ))}
      {footer ? <div className="sidenav-footer">{footer}</div> : null}
    </nav>
  );
}
