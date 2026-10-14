import { describe, expect, it } from "vitest";
import { FakeRunner } from "../fakes/runner.js";
import { member } from "../helpers.js";
import { DeployApiError } from "../../src/services/deploy-api.js";
import { getLive } from "../../src/services/releases.js";
import type { Services } from "../../src/context.js";
import { land, REASONS, rollbackTask } from "../../src/services/staging.js";
import { getTask, setTaskState } from "../../src/services/tasks.js";
import { stagingFixture, type StagingFixture } from "../staging-helpers.js";

const view = async (f: StagingFixture, token: string) => {
  const r = await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging`, { token });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const landingOf = (s: { landings: Array<{ taskId: string; state: string; reason: string | null; reasonCode: string | null; detail?: string | null }> }, taskId: string) => s.landings.find((l) => l.taskId === taskId);

/**
 * `svc` whose `INSERT … staging_landings` runs `before` first and `after` once it ran (to interleave
 * with `land`), alone or in a batch (the landing and its first part commit together).
 */
function interleaved(svc: Services, hooks: { before?: () => Promise<void>; after?: () => Promise<void> }): Services {
  const REAL = Symbol("real statement");
  const around = async <T,>(run: () => Promise<T>): Promise<T> => {
    await hooks.before?.();
    const r = await run();
    await hooks.after?.();
    return r;
  };
  const db = new Proxy(svc.db, {
    get(t, k) {
      if (k === "batch") {
        return (stmts: Array<D1PreparedStatement & { [REAL]?: D1PreparedStatement }>) => {
          const real = stmts.map((st) => st[REAL] ?? st);
          return stmts.some((st) => st[REAL]) ? around(() => t.batch(real)) : t.batch(real);
        };
      }
      if (k !== "prepare") {
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      }
      return (sql: string) => {
        const stmt = t.prepare(sql);
        if (!sql.startsWith("INSERT OR IGNORE INTO staging_landings")) return stmt;
        return {
          bind: (...args: unknown[]) => {
            const bound = stmt.bind(...args);
            return { [REAL]: bound, run: () => around(() => bound.run()) };
          },
        };
      };
    },
  });
  return { ...svc, db };
}

/** Submit a task and hold its `staging.land` step (everything else runs). */
async function submittedHeld(f: StagingFixture, token: string, title: string, files: Record<string, string>) {
  const taskId = await f.submitTask(token, title, files);
  const held = () => {
    for (let i = f.h.steps.length - 1; i >= 0; i--) if ((f.h.steps[i] as { type: string }).type === "staging.land") f.h.steps.splice(i, 1);
  };
  held();
  await f.h.drainSteps();
  held();
  return taskId;
}

const landingRows = (f: StagingFixture, taskId: string) =>
  f.svc.db.prepare("SELECT landing_id, state FROM staging_landings WHERE org_id = ? AND task_id = ? ORDER BY seq").bind(f.o.orgId, taskId).all<{ landing_id: string; state: string }>();

describe("staging: a task that fails while it is being landed (P3-6 race)", { timeout: 30_000 }, () => {
  it("failed between land's state read and its insert: the new landing is rolled back and never goes live", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const taskId = await submittedHeld(f, client.token, "Doomed", { "src/footer.ts": "export const footer = 'doomed';\n" });
    // what failChange does meanwhile: the task fails, and it sees no landing to roll back
    const svc = interleaved(f.svc, { before: async () => setTaskState(f.svc, taskId, "failed") });
    expect(await land(svc, f.o.orgId, taskId)).toEqual({ done: true });
    expect((await getTask(f.svc, taskId))!.state).toBe("failed");
    const rows = (await landingRows(f, taskId)).results;
    expect(rows).toHaveLength(1);
    expect(["rolling_back", "rolled_back"]).toContain(rows[0]!.state);
    await f.until(async () => (await landingRows(f, taskId)).results[0]!.state === "rolled_back", 15_000);
    const busy = () => f.svc.db.prepare("SELECT 1 FROM staging_builds WHERE org_id = ? AND project_id = ? AND state IN ('queued', 'merging', 'building', 'deploying')").bind(f.o.orgId, f.pid).first();
    await f.until(async () => !(await busy()), 15_000);
    expect((await landingRows(f, taskId)).results.map((r) => r.state)).toEqual(["rolled_back"]);
    expect(runner.errors).toEqual([]);
  });

  it("failed and rolled back right after the insert (before land re-reads): land does not fail or roll back twice", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const taskId = await submittedHeld(f, client.token, "Doomed too", { "src/footer.ts": "export const footer = 'doomed 2';\n" });
    const svc = interleaved(f.svc, {
      after: async () => {
        await setTaskState(f.svc, taskId, "failed");
        await rollbackTask(f.svc, f.o.orgId, taskId, client.userId);
      },
    });
    expect(await land(svc, f.o.orgId, taskId)).toEqual({ done: true });
    const rows = (await landingRows(f, taskId)).results;
    expect(rows.map((r) => r.state)).toEqual(["rolling_back"]);
    const ev = await f.svc.db.prepare("SELECT count(*) AS n FROM events WHERE action = 'staging.rolling_back' AND subject_id = ?").bind(taskId).first<{ n: number }>();
    expect(ev!.n).toBe(1);
  });

  it("a land step that died after the insert, redelivered once the task failed, rolls the unbuilt landing back", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const taskId = await submittedHeld(f, client.token, "Died", { "src/footer.ts": "export const footer = 'died';\n" });
    const svc = interleaved(f.svc, {
      after: async () => {
        await setTaskState(f.svc, taskId, "failed");
        throw new Error("the step died");
      },
    });
    await expect(land(svc, f.o.orgId, taskId)).rejects.toThrow("the step died");
    expect((await landingRows(f, taskId)).results.map((r) => r.state)).toEqual(["checking"]);
    expect(await land(f.svc, f.o.orgId, taskId)).toEqual({ done: true });
    expect((await landingRows(f, taskId)).results.map((r) => r.state)).toEqual(["rolling_back"]);
    // and again: nothing more
    expect(await land(f.svc, f.o.orgId, taskId)).toEqual({ done: true });
    expect((await landingRows(f, taskId)).results.map((r) => r.state)).toEqual(["rolling_back"]);
  });

  it("still submitted after the insert: the landing stays checking (no rollback)", async () => {
    const f = await stagingFixture();
    new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const taskId = await submittedHeld(f, client.token, "Fine", { "src/footer.ts": "export const footer = 'fine';\n" });
    expect(await land(f.svc, f.o.orgId, taskId)).toEqual({ done: true });
    expect((await landingRows(f, taskId)).results.map((r) => r.state)).toEqual(["checking"]);
  });
});

describe("staging flow", { timeout: 30_000 }, () => {
  it("a submitted client task lands: merged, built, data applied, deployed, live; GET staging shows it", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const taskId = await f.submitTask(client.token, "Update the footer", { "src/footer.ts": "export const footer = 'new';\n" });
    await f.until(async () => (await view(f, client.token)).landings[0]?.state === "landed", 15_000);
    await f.untilLanded(1);
    const s = await view(f, client.token);
    expect(s).toMatchObject({ enabled: true, building: false, landings: [{ taskId, title: "Update the footer", state: "landed" }] });
    expect(s.url).toMatch(/^https:\/\/cfapp-.*-api-staging\./);
    expect(s.current).toMatchObject({ buildId: expect.any(String), since: expect.any(String) });
    expect(runner.handled.map((j) => j.job.kind)).toEqual(expect.arrayContaining(["prepare-candidate", "staging-build", "release-build", "release-deploy"]));
    // the staging build merged the task onto main: the release built the merged tree
    const stagingJob = runner.handled.find((j) => j.job.kind === "staging-build")!.job as { targets: Array<{ landings: Array<{ landingId: string }> }> };
    expect(stagingJob.targets[0]!.landings).toHaveLength(1);
    expect(f.h.deployApi.queries.length).toBeGreaterThan(0); // migrations + seed ran before the deploy
    expect(f.h.deployApi.queries.map((q) => q.sql)).toEqual(expect.arrayContaining([expect.stringContaining("CREATE TABLE contacts"), expect.stringContaining("INSERT INTO contacts")]));
    expect(runner.errors).toEqual([]);
  });

  it("a conflicting landing fails with a plain reason; staging stays on the previous build", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    await f.submitTask(client.token, "First", { "src/a.ts": "1" });
    await f.untilLanded(1);
    const before = (await view(f, client.token)).current.buildId;
    // hold the staging merge so the conflict is armed before it runs
    runner.opts.hold = ["staging-build"];
    const second = await f.submitTask(client.token, "Second", { "src/a.ts": "2" });
    runner.opts.stagingConflict = { landingId: await f.landingIdOf(second), paths: ["src/a.ts"] };
    await f.until(async () => runner.pending.some((j) => j.job.kind === "staging-build"), 15_000);
    runner.opts.hold = [];
    await runner.runPending();
    await f.until(async () => landingOf(await view(f, client.token), second)?.state === "failed", 15_000);
    const s = await view(f, client.token);
    expect(s.current.buildId).toBe(before);
    expect(landingOf(s, second)!.reason).toBe(REASONS.conflict("src/a.ts"));
    expect(landingOf(s, second)!.reasonCode).toBe("textual_conflict");
    expect(s.landings.filter((l: { state: string }) => l.state === "landed")).toHaveLength(1);
    expect(runner.errors).toEqual([]);
  });

  it("a failed migration, release build, deploy or health check fails only the new landing; the previous staging stays live", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const first = await f.submitTask(client.token, "First", { "src/a.ts": "1" });
    await f.untilLanded(1);
    const before = (await view(f, client.token)).current.buildId;
    const liveRelease = (await getLive(f.svc, f.o.orgId, f.pid, "staging"))!.release_id;
    const failed = async (taskId: string) => {
      await f.until(async () => landingOf(await view(f, client.token), taskId)?.state === "failed", 15_000);
      await f.until(async () => !(await view(f, client.token)).building, 15_000);
      const s = await view(f, client.token);
      expect(s.current.buildId).toBe(before);
      expect(landingOf(s, first)!.state).toBe("landed");
      expect((await getLive(f.svc, f.o.orgId, f.pid, "staging"))!.release_id).toBe(liveRelease);
      return landingOf(s, taskId)!;
    };

    // a migration the staging database refuses
    const api = f.h.deps.deployApi;
    f.h.deps.deployApi = (env) => ({ ...api(env), async d1Query(accountId: string, id: string, sql: string) {
      if (sql.includes("BROKEN")) throw new Error(`D1 refused the query in commonforge-dev-${f.o.orgId}-canonical`);
      return api(env).d1Query(accountId, id, sql);
    } });
    const data = await f.submitTask(client.token, "Data", { "migrations/0002_more.sql": "BROKEN;\n" });
    expect(await failed(data)).toMatchObject({ reasonCode: "staging_data_failed", reason: REASONS.data });
    f.h.deps.deployApi = api;

    // the release build fails
    runner.opts.fail = { "release-build": { code: "check_failed", detail: "wrangler: build error" } };
    const built = await f.submitTask(client.token, "Build", { "src/b.ts": "1" });
    expect(await failed(built)).toMatchObject({ reason: REASONS.build });

    // the deploy fails before changing anything
    runner.opts.fail = { "release-deploy": { code: "provider_unavailable", detail: "wrangler deploy failed" } };
    const deploy = await f.submitTask(client.token, "Deploy", { "src/c.ts": "1" });
    expect(await failed(deploy)).toMatchObject({ reason: REASONS.deploy(true) });
    runner.opts.fail = {};

    // deployed, but the health check fails: staging is rolled back to the previous staging release
    const health = f.h.deps.healthFetch;
    f.h.deps.healthFetch = async (url: string) => {
      const r = await health(url);
      const body = (await r.clone().json().catch(() => null)) as { release?: string } | null;
      return body?.release && body.release !== liveRelease ? new Response("broken", { status: 503 }) : r;
    };
    const unhealthy = await f.submitTask(client.token, "Health", { "src/d.ts": "1" });
    expect(await failed(unhealthy)).toMatchObject({ reasonCode: "health_check_failed", reason: REASONS.deploy(true) });
    f.h.deps.healthFetch = health;
    const rolledBack = await f.svc.db.prepare("SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND action = 'release.rolled_back'").bind(f.o.orgId).first<{ n: number }>();
    expect(rolledBack!.n).toBe(1);

    // staging works again afterwards
    const after = await f.submitTask(client.token, "After", { "src/e.ts": "1" });
    await f.until(async () => landingOf(await view(f, client.token), after)?.state === "landed", 15_000);
    expect(runner.errors).toEqual([]);
  });

  it("a transient Cloudflare error (503) while applying staging data is retried and the landing lands; a 400 fails with the data reason", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const api = f.h.deps.deployApi;
    let refused = 0;
    f.h.deps.deployApi = (env) => ({ ...api(env), async d1Query(accountId: string, id: string, sql: string) {
      if (refused === 0) {
        refused++;
        throw new DeployApiError(503, "Cloudflare API POST /accounts/…/d1/database/x/query: HTTP 503 Service Unavailable");
      }
      return api(env).d1Query(accountId, id, sql);
    } });
    const ok = await f.submitTask(client.token, "Transient", { "src/a.ts": "1" });
    await f.until(async () => ["landed", "failed"].includes(landingOf(await view(f, client.token), ok)?.state ?? ""), 15_000);
    expect(landingOf(await view(f, client.token), ok)).toMatchObject({ state: "landed" });
    expect(refused).toBe(1);
    await f.untilLanded(1);

    f.h.deps.deployApi = (env) => ({ ...api(env), async d1Query(accountId: string, id: string, sql: string) {
      if (sql.includes("BROKEN")) throw new DeployApiError(400, "Cloudflare API POST /accounts/…/d1/database/x/query: HTTP 400 near \"BROKEN\": syntax error");
      return api(env).d1Query(accountId, id, sql);
    } });
    const bad = await f.submitTask(client.token, "Refused", { "migrations/0002_more.sql": "BROKEN;\n" });
    await f.until(async () => landingOf(await view(f, client.token), bad)?.state === "failed", 15_000);
    expect(landingOf(await view(f, client.token), bad)).toMatchObject({ reasonCode: "staging_data_failed", reason: REASONS.data });
    f.h.deps.deployApi = api;
    expect(runner.errors).toEqual([]);
  });

  it("a step that dies while a deploy turns live never leaves a live build with checking landings", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    // the landing update fails (the step dies there): the build must not already be live
    await f.svc.db.prepare("CREATE TRIGGER test_no_landed BEFORE UPDATE OF state ON staging_landings WHEN NEW.state = 'landed' BEGIN SELECT RAISE(ABORT, 'injected: the step died'); END").run();
    const taskId = await f.submitTask(client.token, "Crash", { "src/a.ts": "1" });
    const buildState = async () => (await f.svc.db.prepare("SELECT state FROM staging_builds WHERE org_id = ? AND project_id = ? ORDER BY seq DESC LIMIT 1").bind(f.o.orgId, f.pid).first<{ state: string }>())?.state;
    await f.until(async () => !["queued", "merging", "building", "deploying", undefined].includes(await buildState()), 15_000);
    await f.svc.db.prepare("DROP TRIGGER test_no_landed").run();
    const landing = landingOf(await view(f, client.token), taskId)!;
    expect([await buildState(), landing.state]).not.toEqual(["live", "checking"]);
    expect(landing.state).not.toBe("checking");
    expect(runner.errors).toEqual([]);
  });

  it("a failed merge shows clients only the platform's own text; developers see the runner detail", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const raw = `push to commonforge-dev-${f.o.orgId}-canonical/api and commonforge-dev-${f.o.orgId}-tasks/x refused`;
    runner.opts.fail = { "staging-build": { code: "provider_unavailable", detail: raw } };
    const client = await f.clientWithAccess();
    const taskId = await f.submitTask(client.token, "Footer", { "src/a.ts": "1" });
    await f.until(async () => landingOf(await view(f, client.token), taskId)?.state === "failed", 15_000);
    const leak = new RegExp(`-${f.o.orgId}-(tasks|canonical)|commonforge-dev-`);
    const mine = await view(f, client.token);
    expect(JSON.stringify(mine)).not.toMatch(leak);
    expect(landingOf(mine, taskId)).toMatchObject({ state: "failed", reasonCode: "provider_unavailable", reason: REASONS.merge });
    expect(landingOf(mine, taskId)!.detail).toBeUndefined();
    const events = await f.h.api("GET", `/api/orgs/${f.o.orgId}/events?projectId=${f.pid}`, { token: client.token });
    expect(events.status).toBe(200);
    expect(events.body.events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["staging.landing_checking", "staging.landing_failed"]));
    expect(JSON.stringify(events.body)).not.toMatch(leak);
    // the owner sees the runner's own words
    const owner = await view(f, f.o.token);
    expect(landingOf(owner, taskId)!.detail).toContain(raw);
    expect(owner.current).toBeNull();
  });

  it("rollback removes a task from staging; reset rebuilds with fresh data; another client cannot roll back", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const taskId = await f.submitTask(client.token, "Footer", { "src/a.ts": "1" });
    await f.untilLanded(1);
    const landedBuild = (await view(f, client.token)).current.buildId;
    const other = await f.clientWithAccess();
    expect((await f.h.api("POST", `/api/tasks/${taskId}/rollback`, { token: other.token })).status).toBe(404);
    const rb = await f.h.api("POST", `/api/tasks/${taskId}/rollback`, { token: client.token });
    expect(rb.status, JSON.stringify(rb.body)).toBe(202);
    expect(rb.body.buildId).toEqual(expect.any(String));
    await f.until(async () => (await view(f, client.token)).landings[0]?.state === "rolled_back", 15_000);
    const afterRollback = await view(f, client.token);
    expect(afterRollback.current.buildId).toBe(rb.body.buildId);
    expect(afterRollback.current.buildId).not.toBe(landedBuild);
    // rolling back twice: nothing left to roll back
    expect((await f.h.api("POST", `/api/tasks/${taskId}/rollback`, { token: client.token })).status).toBe(409);
    const created = f.h.deployApi.created.length;
    const reset = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/reset`, { token: client.token });
    expect(reset.status, JSON.stringify(reset.body)).toBe(202);
    await f.until(async () => f.h.deployApi.deleted.length >= 2, 15_000);
    expect(f.h.deployApi.created.length).toBe(created + 2);
    await f.until(async () => (await view(f, client.token)).current?.buildId === reset.body.buildId, 15_000);
    expect(runner.errors).toEqual([]);
  });

  it("a landing that rewrites applied migrations rebuilds staging on fresh data", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    await f.submitTask(client.token, "First", { "src/a.ts": "1" });
    await f.untilLanded(1);
    const created = f.h.deployApi.created.length;
    const deleted = f.h.deployApi.deleted.length;
    const queries = f.h.deployApi.queries.length;
    const second = await f.submitTask(client.token, "Earlier migration", { "migrations/0000_pre.sql": "CREATE TABLE pre (id INTEGER);\n" });
    await f.until(async () => landingOf(await view(f, client.token), second)?.state === "landed", 15_000);
    expect(f.h.deployApi.created.length).toBe(created + 2); // a fresh D1 and KV
    expect(f.h.deployApi.deleted.length).toBe(deleted + 2); // the old ones, once the new staging is live
    const fresh = f.h.deployApi.created.slice(created).find((c) => c.kind === "d1")!.id;
    expect(f.h.deployApi.queries.slice(queries).filter((q) => q.id === fresh).map((q) => q.sql)).toEqual([expect.stringContaining("CREATE TABLE pre"), expect.stringContaining("CREATE TABLE contacts"), expect.stringContaining("INSERT INTO contacts")]);
    const events = await f.svc.db.prepare("SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND action = 'staging.reset'").bind(f.o.orgId).first<{ n: number }>();
    expect(events!.n).toBe(1);
    expect(runner.errors).toEqual([]);
  });

  it("a reset asked for while a build runs is carried into the build that supersedes it", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    await f.submitTask(client.token, "First", { "src/a.ts": "1" });
    await f.untilLanded(1);
    const created = f.h.deployApi.created.length;
    runner.opts.hold = ["staging-build"];
    const second = await f.submitTask(client.token, "Second", { "src/b.ts": "1" });
    await f.until(async () => runner.pending.some((j) => j.job.kind === "staging-build"), 15_000);
    const reset = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/reset`, { token: client.token });
    expect(reset.status).toBe(202);
    await f.h.drainSteps(); // the reset build waits on the running one
    const third = await f.submitTask(client.token, "Third", { "src/c.ts": "1" });
    await f.h.drainSteps(); // the third task's build supersedes the reset build
    expect((await f.svc.db.prepare("SELECT state FROM staging_builds WHERE build_id = ?").bind(reset.body.buildId).first<{ state: string }>())!.state).toBe("superseded");
    runner.opts.hold = [];
    await runner.runPending();
    await f.until(async () => {
      const s = await view(f, client.token);
      return !s.building && [second, third].every((t) => landingOf(s, t)?.state === "landed");
    }, 15_000);
    expect(f.h.deployApi.created.length).toBe(created + 2); // fresh D1 and KV
    const events = await f.svc.db.prepare("SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND action = 'staging.reset'").bind(f.o.orgId).first<{ n: number }>();
    expect(events!.n).toBe(1);
    expect(runner.errors).toEqual([]);
  });

  it("a merge result stored without its applier running still reaches live", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    runner.opts.hold = ["staging-build"];
    const taskId = await f.submitTask(client.token, "Footer", { "src/a.ts": "1" });
    await f.until(async () => runner.pending.some((j) => j.job.kind === "staging-build"), 15_000);
    // the result is stored (as acceptRunnerResult does) but the applier never runs (it threw, or the step saw it first)
    const sj = runner.pending.splice(0).find((j) => j.job.kind === "staging-build")!;
    const job = sj.job as { buildId: string; targets: Array<{ resourceId: string; mainSha: string; canonical: { repoId: string } }> };
    const result = { jobId: sj.jobId, ok: true, receipt: { jobId: sj.jobId, buildId: job.buildId, results: job.targets.map((t) => ({ resourceId: t.resourceId, sha: t.mainSha, revisionId: `art:${t.canonical.repoId}:${t.mainSha}` })), builtAt: new Date().toISOString() } };
    await f.svc.db.prepare("UPDATE runner_jobs SET status = 'succeeded', result_json = ?, result_hash = 'test', completed_at = ? WHERE job_id = ?").bind(JSON.stringify(result), Date.now(), sj.jobId).run();
    await f.until(async () => landingOf(await view(f, client.token), taskId)?.state === "landed", 15_000);
    expect((await view(f, client.token)).current.buildId).toBe(job.buildId);
    expect(runner.errors).toEqual([]);
  });

  it("the follow-up of a reset build that failed on a conflict still resets", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    await f.submitTask(client.token, "First", { "src/a.ts": "1" });
    await f.untilLanded(1);
    const created = f.h.deployApi.created.length;
    runner.opts.hold = ["staging-build"];
    const a = await f.submitTask(client.token, "A", { "src/b.ts": "1" });
    await f.until(async () => runner.pending.some((j) => j.job.kind === "staging-build"), 15_000);
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/reset`, { token: client.token })).status).toBe(202);
    const b = await f.submitTask(client.token, "B", { "src/c.ts": "1" });
    const c = await f.submitTask(client.token, "C", { "src/d.ts": "1" });
    runner.opts.stagingConflict = { landingId: await f.landingIdOf(b), paths: ["src/c.ts"] };
    await f.landingIdOf(c);
    runner.opts.hold = [];
    await runner.runPending();
    await f.until(async () => {
      const s = await view(f, client.token);
      return !s.building && landingOf(s, c)?.state === "landed";
    }, 15_000);
    const s = await view(f, client.token);
    expect([landingOf(s, a)!.state, landingOf(s, b)!.state, landingOf(s, c)!.state]).toEqual(["landed", "failed", "landed"]);
    expect(f.h.deployApi.created.length).toBe(created + 2); // the follow-up build reset staging data
    const events = await f.svc.db.prepare("SELECT COUNT(*) AS n FROM events WHERE org_id = ? AND action = 'staging.reset'").bind(f.o.orgId).first<{ n: number }>();
    expect(events!.n).toBe(1);
    expect(runner.errors).toEqual([]);
  });

  it("a task lands while another step holds the project's staging lock", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    const held = await f.svc.gate.withLock("staging", `${f.o.orgId}:${f.pid}`, 60_000, async () => {
      const taskId = await f.submitTask(client.token, "Footer", { "src/a.ts": "1" });
      // more deliveries than a step's attempts
      for (let i = 0; i < 2; i++) await f.h.drainSteps(12);
      return f.landingIdOf(taskId);
    });
    expect(held.locked).toBe(false);
    expect(held.locked ? null : held.value).toMatch(/^lnd-/);
    await f.untilLanded(1);
    expect(runner.errors).toEqual([]);
  });

  it("a task rolled back before it was ever live does not come back when the rollback build fails", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const client = await f.clientWithAccess();
    runner.opts.hold = ["staging-build"];
    const taskId = await f.submitTask(client.token, "Footer", { "src/a.ts": "1" });
    await f.until(async () => runner.pending.some((j) => j.job.kind === "staging-build"), 15_000);
    expect((await f.h.api("POST", `/api/tasks/${taskId}/rollback`, { token: client.token })).status).toBe(202);
    runner.opts.fail = { "staging-build": { code: "provider_unavailable", detail: "push refused" } };
    runner.opts.hold = [];
    await runner.runPending();
    await f.until(async () => !(await view(f, client.token)).building, 15_000);
    const s = await view(f, client.token);
    expect(s.current).toBeNull();
    expect(landingOf(s, taskId)!.state).toBe("rolled_back");
    expect(runner.errors).toEqual([]);
  });

  it("viewers read staging but cannot reset or roll back; nothing here moves main or the production pointer", async () => {
    const f = await stagingFixture();
    const runner = new FakeRunner(f.h);
    const viewer = await member(f.h, f.o, "viewer");
    await f.h.api("PUT", `/api/orgs/${f.o.orgId}/projects/${f.pid}/access`, { token: f.o.token, body: { userId: viewer.userId, level: "read" } });
    const client = await f.clientWithAccess();
    const taskId = await f.submitTask(client.token, "Footer", { "src/a.ts": "1" });
    await f.untilLanded(1);
    const seen = await view(f, viewer.token);
    expect(seen.landings[0]).toMatchObject({ taskId, state: "landed" });
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/reset`, { token: viewer.token })).status).toBe(403);
    expect((await f.h.api("POST", `/api/tasks/${taskId}/rollback`, { token: viewer.token })).status).toBe(404);
    expect(await f.headSha()).toBe(f.initialHeadSha);
    const releases = (await f.h.api("GET", `/api/orgs/${f.o.orgId}/projects/${f.pid}/releases`, { token: f.o.token })).body;
    expect(releases.releases).toEqual([]);
    expect(releases.live).toBeNull();
    const prodLive = await f.svc.db.prepare("SELECT COUNT(*) AS n FROM release_live WHERE org_id = ? AND channel = 'production'").bind(f.o.orgId).first<{ n: number }>();
    expect(prodLive!.n).toBe(0);
    expect(runner.errors).toEqual([]);
  });

  it("without staging mode a submitted task does not land, and the staging view says staging is off", async () => {
    const f = await stagingFixture({ staging: false });
    const runner = new FakeRunner(f.h);
    const taskId = await f.submitTask(f.o.token, "Footer", { "src/a.ts": "1" });
    await f.h.drainSteps();
    expect(await f.svc.db.prepare("SELECT COUNT(*) AS n FROM staging_landings WHERE task_id = ?").bind(taskId).first<{ n: number }>()).toEqual({ n: 0 });
    expect(await view(f, f.o.token)).toEqual({ enabled: false, url: null, current: null, building: false, landings: [] });
    expect((await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/staging/reset`, { token: f.o.token })).status).toBe(404);
    expect(runner.errors).toEqual([]);
  });
});
