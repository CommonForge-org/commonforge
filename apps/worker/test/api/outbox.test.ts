/**
 * Outbox consumer and Artifacts wakeups (Task 17), over the real ledger DO and D1 with the
 * in-memory Artifacts double and the fake runner. Fault tests (plan §G.5, §F):
 * duplicate outbox event → one application; crash between commit and reconcile → replay
 * reconciles while `refs/heads/main` shows `pending`; a failed push with the ref unmoved stays
 * `pending` (never `diverged`); `diverged` is recorded and then repaired; pushed events are
 * wakeups only; dead letters are recorded and the GC backstop re-requests reconciliation.
 */
import type { OutboxEvent } from "@commonforge-org/core";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createServices } from "../../src/context.js";
import { runGc } from "../../src/services/gc.js";
import { canonicalNs, freezeAndPropose, harness, prepareAndIntegrate, provisionedTask, tasksNs, type Harness } from "../helpers.js";

const OUTBOX = "commonforge-outbox";
const EVENTS = "commonforge-artifacts-events";

const ledgerOf = (orgId: string) => env.ORG_LEDGER.get(env.ORG_LEDGER.idFromName(`org:${orgId}`));

/** Task → freeze → prepare → integrate → approve → accept; returns the ledger's reconcile-ref event. */
async function acceptedChange(h: Harness, files: Record<string, string> = { "index.html": "v2" }) {
  const t = await provisionedTask(h);
  const { proposal, sha } = await freezeAndPropose(h, t.o, t.taskId, files);
  await prepareAndIntegrate(h, t.o, proposal.proposalId);
  expect((await h.api("POST", `/api/orgs/${t.o.orgId}/proposals/${proposal.proposalId}/approvals`, { token: t.o.token, body: { proposalHash: proposal.proposalHash } })).status).toBe(201);
  const acc = await h.api("POST", `/api/orgs/${t.o.orgId}/proposals/${proposal.proposalId}/accept`, { token: t.o.token, body: { idempotencyKey: `accept-${crypto.randomUUID()}` } });
  expect(acc.status).toBe(200);
  const ledger = ledgerOf(t.o.orgId);
  const event = (await ledger.listOutbox({ filter: "all" })).map((r) => r.event).find((e) => e.kind === "reconcile-ref" && e.payload.acceptedVersionId === acc.body.acceptedVersionId)!;
  expect(event).toBeTruthy();
  const canonical = () => h.artifacts.repo(canonicalNs(t.o.orgId), t.web.resourceId).refs.get("main");
  const head = async () => (await h.api("GET", `/api/orgs/${t.o.orgId}/resources/${t.web.resourceId}`, { token: t.o.token })).body.head;
  const reconcileJobs = () => t.runner.handled.filter((j) => j.job.kind === "reconcile-ref").length + t.runner.pending.filter((j) => j.job.kind === "reconcile-ref").length;
  const audits = async () => (await ledger.listAudit({ limit: 500 })).filter((a) => a.event.action === "head.reconciliation_changed" && a.event.subject.id === t.web.resourceId);
  return { ...t, proposal, sha, target: `art:${t.web.repoId}:${sha}`, event: event as OutboxEvent, acceptedVersionId: acc.body.acceptedVersionId as string, ledger, canonical, head, reconcileJobs, audits };
}

const projection = async (orgId: string, resourceId: string) =>
  env.DB.prepare("SELECT revision_id, reconciliation FROM resource_heads WHERE org_id = ? AND resource_id = ?").bind(orgId, resourceId).first<{ revision_id: string; reconciliation: string }>();

describe("outbox consumer: reconcile-ref", () => {
  it("crash between commit and reconcile: the ref shows pending meanwhile, replay reconciles, duplicates apply once (G.5, AT-13/14)", async () => {
    const h = harness();
    const c = await acceptedChange(h);
    // committed in the ledger, canonical branch not yet moved: the head says so
    expect((await c.head()).revisionId).toBe(c.target);
    expect((await c.head()).reconciliation).toBe("pending");
    expect(c.canonical()).toBe(c.web.sha);

    // the consumer gives up waiting (a crash/timeout): the message is retried, nothing recorded
    c.runner.opts.manual = true;
    h.deps.runnerWait = { pollMs: 5, timeoutMs: 30 };
    let r = await h.deliver(OUTBOX, [c.event]);
    expect(r.retried).toHaveLength(1);
    // a redelivery joins the same open runner job instead of issuing a second one
    r = await h.deliver(OUTBOX, [c.event], 2);
    expect(r.retried).toHaveLength(1);
    expect(c.runner.pending.map((j) => j.job.kind)).toEqual(["reconcile-ref"]);
    expect((c.runner.pending[0]!.job as { ref: string }).ref).toBe("refs/heads/main");

    // the runner moves the branch, but the ledger still shows pending until the consumer records it
    await c.runner.runPending();
    expect(c.canonical()).toBe(c.sha);
    expect((await c.head()).reconciliation).toBe("pending");

    // replay reconciles
    r = await h.deliver(OUTBOX, [c.event], 3);
    expect(r.acked).toHaveLength(1);
    expect((await c.head()).reconciliation).toBe("synced");
    expect(await projection(c.o.orgId, c.web.resourceId)).toEqual({ revision_id: c.target, reconciliation: "synced" });

    // duplicate deliveries (same batch and later): one application only
    r = await h.deliver(OUTBOX, [c.event, { ...c.event, attempts: 7 }], 4);
    expect(r.acked).toHaveLength(2);
    expect(c.reconcileJobs()).toBe(1);
    expect((await c.audits()).map((a) => JSON.parse(a.detailJson!).to)).toEqual(["synced"]);
    expect((await c.ledger.getConsumedEvent(c.o.orgId, c.event.dedupeKey))?.outcome).toBe("synced");
    expect(c.runner.errors).toEqual([]);

    // a stale duplicate arriving after the branch moved again is still not re-applied (no new job,
    // no provider call): divergence is the pushed-wakeup path's business, not a replayed event's
    const other = h.artifacts.makeCommit({ "index.html": "later" }, [c.sha]);
    h.artifacts.push(canonicalNs(c.o.orgId), c.web.resourceId, "main", other);
    const calls = h.artifacts.calls.length;
    r = await h.deliver(OUTBOX, [c.event], 5);
    expect(r.acked).toHaveLength(1);
    expect(h.artifacts.calls.length).toBe(calls);
    expect(c.reconcileJobs()).toBe(1);
    expect(c.canonical()).toBe(other);
  });

  it("restore back and forth: every event gets its own reconcile job (a finished job is never reused for a later event)", async () => {
    const h = harness();
    const c = await acceptedChange(h);
    const ns = canonicalNs(c.o.orgId);
    expect((await h.deliver(OUTBOX, [c.event])).acked).toHaveLength(1);
    expect(c.canonical()).toBe(c.sha);
    const restore = async (expectedHead: string, targetRevision: string, key: string) => {
      const r = await h.api("POST", `/api/orgs/${c.o.orgId}/resources/${c.web.resourceId}/restore`, { token: c.o.token, body: { expectedHead, targetRevision, idempotencyKey: key } });
      expect(r.status).toBe(200);
      const ev = (await c.ledger.listOutbox({ filter: "all" })).map((x) => x.event).find((e) => e.kind === "reconcile-ref" && e.payload.acceptedVersionId === r.body.acceptedVersionId)!;
      expect((await h.deliver(OUTBOX, [ev])).acked).toHaveLength(1);
    };
    await restore(c.target, c.web.revisionId, "restore-bf-1");
    expect(h.artifacts.repo(ns, c.web.resourceId).refs.get("main")).toBe(c.web.sha);
    // same (expected current, target) pair as the first reconcile job: must push again
    await restore(c.web.revisionId, c.target, "restore-bf-2");
    expect(h.artifacts.repo(ns, c.web.resourceId).refs.get("main")).toBe(c.sha);
    expect((await c.head()).reconciliation).toBe("synced");
    expect(c.reconcileJobs()).toBe(3);
  });

  it("a duplicate event in one batch is applied once (one runner job, one state change)", async () => {
    const h = harness();
    const c = await acceptedChange(h);
    const r = await h.deliver(OUTBOX, [c.event, c.event, { ...c.event, attempts: 3, deliveredAt: null }]);
    expect(r.acked).toHaveLength(3);
    expect(c.canonical()).toBe(c.sha);
    expect((await c.head()).reconciliation).toBe("synced");
    expect(c.reconcileJobs()).toBe(1);
    expect(await c.audits()).toHaveLength(1);
  });

  it("provider_unavailable (push failed, ref unmoved) stays pending and is retried; never diverged", async () => {
    const h = harness();
    const c = await acceptedChange(h);
    c.runner.opts.fail = { "reconcile-ref": { code: "provider_unavailable", detail: "reconcile push failed with refs/heads/main unmoved" } };
    let r = await h.deliver(OUTBOX, [c.event]);
    expect(r.retried).toHaveLength(1);
    expect((await c.head()).reconciliation).toBe("pending");
    expect(c.canonical()).toBe(c.web.sha);
    expect(await c.audits()).toEqual([]);
    expect(await c.ledger.getConsumedEvent(c.o.orgId, c.event.dedupeKey)).toBeNull();

    // provider back: the retry issues a new job (the failed one is never reused) and syncs
    c.runner.opts.fail = {};
    r = await h.deliver(OUTBOX, [c.event], 2);
    expect(r.acked).toHaveLength(1);
    expect((await c.head()).reconciliation).toBe("synced");
    expect(c.canonical()).toBe(c.sha);
    expect(c.reconcileJobs()).toBe(2);
  });

  it("diverged is recorded (event kept), then the next attempt leases on the observed sha and re-syncs", async () => {
    const h = harness();
    const c = await acceptedChange(h);
    c.runner.opts.manual = true;
    h.deps.runnerWait = { pollMs: 5, timeoutMs: 30 };
    expect((await h.deliver(OUTBOX, [c.event])).retried).toHaveLength(1);
    const job = c.runner.pending.shift()!;
    const other = h.artifacts.makeCommit({ "index.html": "someone else" }, [c.web.sha]);
    const j = job.job as { ref: string; targetSha: string; resourceId: string };
    const posted = await c.runner.post(job, {
      jobId: job.jobId,
      ok: true,
      receipt: { jobId: job.jobId, resourceId: j.resourceId, ref: j.ref, targetSha: j.targetSha, observedSha: other, status: "diverged", reconciledAt: new Date().toISOString() },
    });
    expect(posted.status).toBe(201);
    let r = await h.deliver(OUTBOX, [c.event], 2);
    expect(r.retried).toHaveLength(1);
    expect((await c.head()).reconciliation).toBe("diverged");
    expect((await projection(c.o.orgId, c.web.resourceId))?.reconciliation).toBe("diverged");
    expect(await c.ledger.getConsumedEvent(c.o.orgId, c.event.dedupeKey)).toBeNull();

    // the concurrent writer's sha is what the branch now holds; the ledger head still wins
    h.artifacts.push(canonicalNs(c.o.orgId), c.web.resourceId, "main", other);
    c.runner.opts.manual = false;
    h.deps.runnerWait = { pollMs: 5, timeoutMs: 3000 };
    r = await h.deliver(OUTBOX, [c.event], 3);
    expect(r.acked).toHaveLength(1);
    expect(c.canonical()).toBe(c.sha);
    expect((await c.head()).reconciliation).toBe("synced");
    const leased = c.runner.handled.filter((x) => x.job.kind === "reconcile-ref").map((x) => (x.job as { expectedCurrentSha: string }).expectedCurrentSha);
    expect(leased).toEqual([other]);
    expect((await c.audits()).map((a) => JSON.parse(a.detailJson!).to)).toEqual(["diverged", "synced"]);
  });

  it("an event whose target is no longer the head is consumed as superseded (no runner job)", async () => {
    const h = harness();
    const c = await acceptedChange(h);
    const restored = await h.api("POST", `/api/orgs/${c.o.orgId}/resources/${c.web.resourceId}/restore`, {
      token: c.o.token,
      body: { expectedHead: c.target, targetRevision: c.web.revisionId, idempotencyKey: "restore-ob-1" },
    });
    expect(restored.status).toBe(200);
    expect((await h.deliver(OUTBOX, [c.event])).acked).toHaveLength(1);
    expect((await c.ledger.getConsumedEvent(c.o.orgId, c.event.dedupeKey))?.outcome).toBe("superseded");
    expect(c.reconcileJobs()).toBe(0);
    // the restore's own event: canonical main never moved, so it is already in sync
    const restoreEvent = (await c.ledger.listOutbox({ filter: "all" })).map((x) => x.event).find((e) => e.kind === "reconcile-ref" && e.payload.acceptedVersionId === restored.body.acceptedVersionId)!;
    expect((await h.deliver(OUTBOX, [restoreEvent])).acked).toHaveLength(1);
    expect((await c.head()).reconciliation).toBe("synced");
    expect(c.reconcileJobs()).toBe(0);
  });

  describe("review I-1: an older reconcile never leaves a newer head wrongly synced", () => {
    const restoreToBase = async (h: Harness, c: Awaited<ReturnType<typeof acceptedChange>>, key: string) => {
      const r = await h.api("POST", `/api/orgs/${c.o.orgId}/resources/${c.web.resourceId}/restore`, { token: c.o.token, body: { expectedHead: c.target, targetRevision: c.web.revisionId, idempotencyKey: key } });
      expect(r.status).toBe(200);
      return (await c.ledger.listOutbox({ filter: "all" })).map((x) => x.event).find((e) => e.kind === "reconcile-ref" && e.payload.acceptedVersionId === r.body.acceptedVersionId)!;
    };
    const settled = async (h: Harness, c: Awaited<ReturnType<typeof acceptedChange>>) => {
      expect((await c.head()).revisionId).toBe(c.web.revisionId);
      expect((await c.head()).reconciliation).toBe("synced");
      expect(c.canonical()).toBe(c.web.sha);
      const report = await runGc(createServices(env, h.deps), { orgs: [c.o.orgId], reconcileStaleSeconds: 0 });
      expect(report.reconcileRequests).toBe(0);
    };

    it("reviewer probe: a newer head syncs while the older job is being submitted → the newer head goes back to pending and is re-reconciled", async () => {
      const h = harness();
      const c = await acceptedChange(h);
      const ns = canonicalNs(c.o.orgId);
      const getRepo = h.artifacts.getRepo.bind(h.artifacts);
      let fired = false;
      h.artifacts.getRepo = async (n: string, name: string) => {
        if (!fired && n === ns && name === c.web.resourceId) {
          fired = true;
          const ev = await restoreToBase(h, c, "restore-i1-a");
          expect((await h.deliver(OUTBOX, [ev])).acked).toHaveLength(1); // synced without a push
        }
        return getRepo(n, name);
      };
      expect((await h.deliver(OUTBOX, [c.event])).acked).toHaveLength(1);
      expect(fired).toBe(true);
      // the old job landed after the restore synced: the head is NOT left `synced`
      expect(c.canonical()).toBe(c.sha);
      expect((await c.head()).reconciliation).toBe("pending");
      expect((await c.ledger.getConsumedEvent(c.o.orgId, c.event.dedupeKey))?.outcome).toBe("superseded_after_push:synced");
      expect(h.outbox).toHaveLength(1);
      expect((await h.deliver(OUTBOX, h.outbox.splice(0))).acked).toHaveLength(1);
      await settled(h, c);
    });

    it("a newer head that syncs between the head read and the branch read is never overwritten (no job)", async () => {
      const h = harness();
      const c = await acceptedChange(h);
      const ns = canonicalNs(c.o.orgId);
      const log = h.artifacts.log.bind(h.artifacts);
      let fired = false;
      h.artifacts.log = async (n: string, name: string, opts: { ref: string; limit?: number }) => {
        if (!fired && n === ns && name === c.web.resourceId) {
          fired = true;
          const ev = await restoreToBase(h, c, "restore-i1-b");
          expect((await h.deliver(OUTBOX, [ev])).acked).toHaveLength(1);
        }
        return log(n, name, opts);
      };
      expect((await h.deliver(OUTBOX, [c.event])).acked).toHaveLength(1);
      expect(fired).toBe(true);
      expect((await c.ledger.getConsumedEvent(c.o.orgId, c.event.dedupeKey))?.outcome).toBe("superseded");
      expect(c.reconcileJobs()).toBe(0);
      expect(h.outbox).toHaveLength(0);
      await settled(h, c);
    });

    it("a superseded event verifies the current synced head and repairs a branch moved under it", async () => {
      const h = harness();
      const c = await acceptedChange(h);
      const ev = await restoreToBase(h, c, "restore-i1-c");
      expect((await h.deliver(OUTBOX, [ev])).acked).toHaveLength(1); // no job open: settles synced
      expect((await c.head()).reconciliation).toBe("synced");
      // something moved the branch to A after that (e.g. a job that outlived every check)
      h.artifacts.push(canonicalNs(c.o.orgId), c.web.resourceId, "main", c.sha);
      expect((await h.deliver(OUTBOX, [c.event])).acked).toHaveLength(1); // superseded → verify
      expect((await c.head()).reconciliation).toBe("diverged"); // no longer wrongly synced
      expect(h.outbox).toHaveLength(1);
      expect((await h.deliver(OUTBOX, h.outbox.splice(0))).acked).toHaveLength(1);
      await settled(h, c);
    });

    const restoreTo = async (h: Harness, c: Awaited<ReturnType<typeof acceptedChange>>, expectedHead: string, targetRevision: string, key: string) => {
      const r = await h.api("POST", `/api/orgs/${c.o.orgId}/resources/${c.web.resourceId}/restore`, { token: c.o.token, body: { expectedHead, targetRevision, idempotencyKey: key } });
      expect(r.status).toBe(200);
      return (await c.ledger.listOutbox({ filter: "all" })).map((x) => x.event).find((e) => e.kind === "reconcile-ref" && e.payload.acceptedVersionId === r.body.acceptedVersionId)!;
    };
    /** Deliver until every message is acked (follow-up requests included), running the runner in between. */
    const drainAll = async (h: Harness, c: Awaited<ReturnType<typeof acceptedChange>>, events: unknown[]) => {
      let queue = [...events];
      for (let round = 1; queue.length > 0 && round < 30; round++) {
        await c.runner.runPending();
        const r = await h.deliver(OUTBOX, queue, round + 1);
        queue = [...r.retried.map((x) => x.body), ...h.outbox.splice(0)];
      }
      expect(queue).toEqual([]);
    };

    it("re-review N-1 (P1): a restore makes the old lease valid again; a queued job for the superseded accept cannot leave the restored head wrongly synced", async () => {
      const h = harness();
      const c = await acceptedChange(h);
      c.runner.opts.manual = true;
      h.deps.runnerWait = { pollMs: 5, timeoutMs: 30 };
      expect((await h.deliver(OUTBOX, [c.event])).retried).toHaveLength(1); // A's job queued, lease B0
      const ev = await restoreTo(h, c, c.target, c.web.revisionId, "probe-p1-01");
      // the restore must not settle `synced` while A's job could still push
      expect((await h.deliver(OUTBOX, [ev])).retried).toHaveLength(1);
      expect((await c.head()).reconciliation).toBe("pending");
      // A's event is superseded, but its job is still open: not consumed yet
      expect((await h.deliver(OUTBOX, [c.event], 2)).retried).toHaveLength(1);
      expect(await c.ledger.getConsumedEvent(c.o.orgId, c.event.dedupeKey)).toBeNull();
      await c.runner.runPending(); // the old job lands: canonical = A
      expect(c.canonical()).toBe(c.sha);
      expect((await c.head()).reconciliation).not.toBe("synced");
      await drainAll(h, c, [c.event, ev]);
      expect(c.canonical()).toBe(c.web.sha);
      expect((await c.head()).revisionId).toBe(c.web.revisionId);
      expect((await c.head()).reconciliation).toBe("synced");
      expect((await runGc(createServices(env, h.deps), { orgs: [c.o.orgId], reconcileStaleSeconds: 0 })).reconcileRequests).toBe(0);
    });

    it("re-review N-1 (P2): A → B0 → A → B0 with both A jobs queued ends at B0 synced", async () => {
      const h = harness();
      const c = await acceptedChange(h);
      c.runner.opts.manual = true;
      h.deps.runnerWait = { pollMs: 5, timeoutMs: 30 };
      const events: unknown[] = [c.event];
      expect((await h.deliver(OUTBOX, [c.event])).retried).toHaveLength(1);
      const r1 = await restoreTo(h, c, c.target, c.web.revisionId, "probe-p2-01");
      events.push(r1);
      await h.deliver(OUTBOX, [r1]);
      const r2 = await restoreTo(h, c, c.web.revisionId, c.target, "probe-p2-02");
      events.push(r2);
      await h.deliver(OUTBOX, [r2]); // second A job queued (its own event, own salted key)
      const r3 = await restoreTo(h, c, c.target, c.web.revisionId, "probe-p2-03");
      events.push(r3);
      await h.deliver(OUTBOX, [r3]);
      await h.deliver(OUTBOX, events, 2);
      expect((await c.head()).reconciliation).not.toBe("synced");
      await drainAll(h, c, events);
      expect(c.canonical()).toBe(c.web.sha);
      expect((await c.head()).revisionId).toBe(c.web.revisionId);
      expect((await c.head()).reconciliation).toBe("synced");
      expect((await runGc(createServices(env, h.deps), { orgs: [c.o.orgId], reconcileStaleSeconds: 0 })).reconcileRequests).toBe(0);
    });

    it("a branch value nobody vouched for is recorded as diverged first and overridden on the next attempt", async () => {
      const h = harness();
      const c = await acceptedChange(h);
      const rogue = h.artifacts.makeCommit({ "index.html": "rogue" }, [c.web.sha]);
      h.artifacts.push(canonicalNs(c.o.orgId), c.web.resourceId, "main", rogue);
      expect((await h.deliver(OUTBOX, [c.event])).retried).toHaveLength(1);
      expect(c.reconcileJobs()).toBe(0);
      expect((await c.head()).reconciliation).toBe("diverged");
      expect(await c.ledger.getRefState(c.web.resourceId)).toMatchObject({ revisionId: c.target, state: "diverged", observedSha: rogue });
      expect((await h.deliver(OUTBOX, [c.event], 2)).acked).toHaveLength(1);
      expect(c.canonical()).toBe(c.sha);
      expect((await c.head()).reconciliation).toBe("synced");
    });
  });

  it("drops malformed messages and handles projection-refresh events once", async () => {
    const h = harness();
    const c = await acceptedChange(h);
    expect((await h.deliver(OUTBOX, [{ kind: "nonsense" }])).acked).toHaveLength(1);
    const refresh = { ...c.event, eventId: "ob-refresh-1", dedupeKey: "projection-refresh:1", kind: "projection-refresh", payload: { resourceIds: [c.web.resourceId] } };
    expect((await h.deliver(OUTBOX, [refresh, refresh])).acked).toHaveLength(2);
    expect(await projection(c.o.orgId, c.web.resourceId)).toEqual({ revision_id: c.target, reconciliation: "pending" });
    expect((await c.ledger.getConsumedEvent(c.o.orgId, "projection-refresh:1"))?.outcome).toBe("refreshed");
  });

  it("dead letters are recorded; the GC backstop re-requests reconciliation of a head left pending", async () => {
    const h = harness();
    const c = await acceptedChange(h);
    expect((await h.deliver("commonforge-outbox-dlq", [c.event], 11)).acked).toHaveLength(1);
    const ev = await env.DB.prepare("SELECT detail_json FROM events WHERE org_id = ? AND action = 'outbox.dead_lettered'").bind(c.o.orgId).first<{ detail_json: string }>();
    expect(JSON.parse(ev!.detail_json)).toMatchObject({ dedupeKey: c.event.dedupeKey, kind: "reconcile-ref" });
    expect((await c.head()).reconciliation).toBe("pending");

    const report = await runGc(createServices(env, h.deps), { orgs: [c.o.orgId], reconcileStaleSeconds: 0 });
    expect(report.errors).toEqual([]);
    expect(report.reconcileRequests).toBe(1);
    expect(h.outbox).toHaveLength(1);
    expect((await h.deliver(OUTBOX, h.outbox.splice(0))).acked).toHaveLength(1);
    expect((await c.head()).reconciliation).toBe("synced");
    expect(c.canonical()).toBe(c.sha);
    // synced heads are not re-requested
    await runGc(createServices(env, h.deps), { orgs: [c.o.orgId], reconcileStaleSeconds: 0 });
    expect(h.outbox).toHaveLength(0);
  });
});

describe("Artifacts pushed events (wakeups, never authority)", () => {
  const pushed = (ns: string, repo: string, ref: string, after: string, before = "0".repeat(40)) => ({
    type: "cf.artifacts.repo.pushed",
    source: { namespace: ns, repoName: repo, type: "artifacts.repo" },
    metadata: { eventSchemaVersion: 1, eventTimestamp: new Date().toISOString() },
    payload: { ref, before, after, commits: [], totalCommitsCount: 0, commitsTruncated: false },
  });

  it("a push that moves the canonical branch off the ledger head marks it diverged and requests a reconcile (deduped by repo+ref+after)", async () => {
    const h = harness();
    const c = await acceptedChange(h);
    await h.deliver(OUTBOX, [c.event]);
    expect((await c.head()).reconciliation).toBe("synced");

    const ns = canonicalNs(c.o.orgId);
    const other = h.artifacts.makeCommit({ "index.html": "rogue" }, [c.sha]);
    h.artifacts.push(ns, c.web.resourceId, "main", other);
    const ev = pushed(ns, c.web.resourceId, "refs/heads/main", other);
    expect((await h.deliver(EVENTS, [ev, ev])).acked).toHaveLength(2);
    expect((await c.head()).reconciliation).toBe("diverged");
    expect((await c.head()).revisionId).toBe(c.target); // the head never moves on an event
    expect(h.outbox).toHaveLength(1);
    expect((await h.deliver(EVENTS, [ev], 2)).acked).toHaveLength(1);
    expect(h.outbox).toHaveLength(1);

    expect((await h.deliver(OUTBOX, h.outbox.splice(0))).acked).toHaveLength(1);
    expect(c.canonical()).toBe(c.sha);
    expect((await c.head()).reconciliation).toBe("synced");

    // M-1: the rogue sha comes back later (a new push, different `before`): a new wakeup, not a duplicate
    h.artifacts.push(ns, c.web.resourceId, "main", other);
    expect((await h.deliver(EVENTS, [pushed(ns, c.web.resourceId, "refs/heads/main", other, c.sha)])).acked).toHaveLength(1);
    expect((await c.head()).reconciliation).toBe("diverged");
    expect(h.outbox).toHaveLength(1);
    expect((await h.deliver(OUTBOX, h.outbox.splice(0))).acked).toHaveLength(1);
    expect(c.canonical()).toBe(c.sha);
  });

  it("the event's `after` is never trusted: the branch is read; other refs and task repos are ignored", async () => {
    const h = harness();
    const c = await acceptedChange(h);
    const ns = canonicalNs(c.o.orgId);
    // forged: claims the branch is at the head's sha while it still is at the base
    expect((await h.deliver(EVENTS, [pushed(ns, c.web.resourceId, "refs/heads/main", c.sha)])).acked).toHaveLength(1);
    expect((await c.head()).reconciliation).toBe("pending");
    expect(h.outbox).toHaveLength(0);
    // the reconcile job's own push is observed: the wakeup records synced
    h.artifacts.push(ns, c.web.resourceId, "main", c.sha);
    expect((await h.deliver(EVENTS, [pushed(ns, c.web.resourceId, "refs/heads/main", `${c.sha.slice(0, 39)}${c.sha.endsWith("0") ? "1" : "0"}`)])).acked).toHaveLength(1);
    expect((await c.head()).reconciliation).toBe("synced");
    // ignored: retention refs, task repos, other environments, other event types
    const before = (await c.audits()).length;
    await h.deliver(EVENTS, [
      pushed(ns, c.web.resourceId, "refs/commonforge/candidates/x", "a".repeat(40)),
      pushed(tasksNs(c.o.orgId), "ws-whatever", "refs/heads/main", "b".repeat(40)),
      pushed(`commonforge-prod-${c.o.orgId}-canonical`, c.web.resourceId, "refs/heads/main", "c".repeat(40)),
      { type: "cf.artifacts.repo.created", source: { namespace: ns, repoName: "x" } },
    ]);
    expect((await c.audits()).length).toBe(before);
    expect(h.outbox).toHaveLength(0);
  });
});
