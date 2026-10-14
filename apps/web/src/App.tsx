import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError, type CommonForgeApi } from "./api/client.js";
import type { FakeApi } from "./api/fake.js";
import type { Me, Role } from "./api/types.js";
import { AppContext } from "./lib/hooks.js";
import { isDeveloperRole } from "./lib/model.js";
import { navigate, useRoute } from "./lib/router.js";
import { HomeRedirect, OrgHome } from "./screens/Home.js";
import { Members } from "./screens/Members.js";
import { Person } from "./screens/Person.js";
import { Account } from "./screens/Account.js";
import { NewOrg } from "./screens/NewOrg.js";
import { ProjectShell } from "./screens/ProjectShell.js";
import { CliCodeView, SignIn, Verify } from "./screens/SignIn.js";
import { AppHeader } from "./primitives/index.js";
import { ErrorNote, Link, Loading } from "./ui.js";

export function FixtureBanner({ fixture, role, onRole }: { fixture: FakeApi; role: Role; onRole: (r: Role) => void }) {
  return (
    <div className="fixture-banner" role="note">
      <strong>Fixture mode</strong>
      <span>Sample data for testing and rehearsal. Not a live run.</span>
      <span className="fixture-controls">
        View as
        {(["owner", "client"] as const).map((r) => (
          <button key={r} type="button" className={`seg ${role === r ? "seg-active" : ""}`} onClick={() => onRole(r)}>
            {r === "owner" ? "Developer" : "Client"}
          </button>
        ))}
        <button type="button" className="seg" onClick={() => fixture.checkOutReadyTasks()}>
          Agent checks out
        </button>
        <button type="button" className="seg" onClick={() => fixture.completeRunningTasks()}>
          Finish running agent
        </button>
      </span>
    </div>
  );
}

/** The header outside a project: logo, the signed-in user and Sign out. */
export function TopBar({ me, onSignOut }: { me: Me | null; onSignOut: () => void }) {
  return <AppHeader user={me?.user.email} onSignOut={me ? onSignOut : undefined} />;
}

export function App({ api, fixture = null, serverLocation }: { api: CommonForgeApi; fixture?: FakeApi | null; serverLocation?: string }) {
  const route = useRoute(serverLocation);
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);
  const [viewKey, setViewKey] = useState(0);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.me());
      setMeError(null);
    } catch (e) {
      setMe(null);
      setMeError(e);
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  const signOut = async () => {
    try {
      await api.logout();
    } finally {
      setMe(null);
      navigate("/signin");
    }
  };

  const unauthenticated = meError instanceof ApiError && meError.status === 401;
  let body;
  let shell: ReactNode = null;
  if (route.name === "signin") body = <SignIn />;
  else if (route.name === "verify") body = <Verify token={route.token} />;
  else if (route.name === "cli") body = <CliCodeView code={route.code} />;
  else if (!loaded) body = <Loading what="Starting" />;
  else if (unauthenticated) body = <SignIn />;
  else if (!me) body = <ErrorNote error={meError} onRetry={() => void refreshMe()} />;
  else if (route.name === "home") body = <HomeRedirect />;
  else if (route.name === "account") body = <Account />;
  else if (route.name === "new-org") body = me.canCreateOrgs ? <NewOrg /> : <ErrorNote error={new ApiError(403, "org_create_forbidden", "only instance admins create organizations")} />;
  else if (route.name === "org") {
    const role = me.memberships.find((m) => m.orgId === route.org)?.role;
    if (role) shell = <OrgHome key={`${route.org}/${viewKey}`} org={route.org} role={role} onSignOut={() => void signOut()} />;
    else body = <ErrorNote error={new ApiError(404, "not_found", "This organization does not exist or you do not have access.")} />;
  }
  else if (route.name === "members") {
    const role = me.memberships.find((m) => m.orgId === route.org)?.role;
    if (role && isDeveloperRole(role)) shell = <Members key={`${route.org}/${viewKey}`} org={route.org} role={role} onSignOut={() => void signOut()} />;
    else body = <ErrorNote error={new ApiError(404, "not_found", "This page does not exist or you do not have access.")} />;
  }
  else if (route.name === "member") {
    const role = me.memberships.find((m) => m.orgId === route.org)?.role;
    if (role && isDeveloperRole(role)) shell = <Person key={`${route.org}/${route.userId}/${viewKey}`} org={route.org} role={role} userId={route.userId} onSignOut={() => void signOut()} />;
    else body = <ErrorNote error={new ApiError(404, "not_found", "This page does not exist or you do not have access.")} />;
  }
  else if (route.name === "project" || route.name === "proposal" || route.name === "promotion" || route.name === "intake" || route.name === "settings") {
    const role = me.memberships.find((m) => m.orgId === route.org)?.role;
    if (role) shell = <ProjectShell key={`${route.org}/${route.pid}/${viewKey}`} route={route} role={role} onSignOut={() => void signOut()} />;
    else body = <ErrorNote error={new ApiError(404, "not_found", "This project does not exist or you do not have access.")} />;
  } else
    body = (
      <div className="page">
        <p>Page not found.</p>
        <Link href="/">Go to projects</Link>
      </div>
    );

  const fixtureRole = fixture?.role ?? "owner";
  return (
    <AppContext.Provider value={{ api, fixture, me, refreshMe }}>
      {fixture ? (
        <FixtureBanner
          fixture={fixture}
          role={fixtureRole}
          onRole={(r) => {
            fixture.role = r;
            setViewKey((k) => k + 1);
            void refreshMe();
          }}
        />
      ) : null}
      {shell ?? (
        <>
          <TopBar me={me} onSignOut={() => void signOut()} />
          <div className="app-body app-body-plain">
            <main className="main">{body}</main>
          </div>
        </>
      )}
    </AppContext.Provider>
  );
}
