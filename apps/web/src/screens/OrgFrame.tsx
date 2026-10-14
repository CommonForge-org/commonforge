/** The organization frame: header, sidebar (Projects, Members for owners and developers, the switcher), content. */
import { useEffect, type ReactNode } from "react";
import type { Role } from "../api/types.js";
import { useApp } from "../lib/hooks.js";
import { isDeveloperRole } from "../lib/model.js";
import { orgLabels, rememberOrg } from "../lib/orgs.js";
import { membersHref, orgHref } from "../lib/router.js";
import { AppHeader, OrgSwitcher, SideNav, type NavItem } from "../primitives/index.js";

export function orgNavItems(org: string, role: Role): NavItem[] {
  const items: NavItem[] = [{ id: "projects", label: "Projects", icon: "files", href: orgHref(org) }];
  if (isDeveloperRole(role)) items.push({ id: "members", label: "Members", icon: "human", href: membersHref(org) });
  return items;
}

export function OrgFrame({ org, role, active, onSignOut, children }: { org: string; role: Role; active: "projects" | "members"; onSignOut?: () => void; children: ReactNode }) {
  const { me } = useApp();
  const memberships = me?.memberships ?? [];
  const label = orgLabels(memberships).get(org) ?? org;
  useEffect(() => rememberOrg(org), [org]);
  const crumbs = active === "members" ? [{ label, href: orgHref(org) }, { label: "Members" }] : [{ label }];
  return (
    <>
      <AppHeader crumbs={crumbs} role={role} user={me?.user.email} onSignOut={onSignOut} />
      <div className="app-body">
        <SideNav label="Organization" items={orgNavItems(org, role)} active={active} footer={<OrgSwitcher memberships={memberships} current={org} canCreateOrgs={me?.canCreateOrgs ?? false} />} />
        <main className="main">{children}</main>
      </div>
    </>
  );
}
