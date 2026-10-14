import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  FIXTURE_ACTOR,
  FIXTURE_ORG,
  FIXTURE_TIME,
  acceptFixture,
  applyWrites,
  baseRev,
  mergeSeeds,
  type LedgerWrite,
} from "@commonforge-org/ledger";
import { resourceId as toResourceId, type AcceptedHead, type AcceptedProjectVersion, type OutboxEvent } from "@commonforge-org/core";
import { describe, expect, it } from "vitest";
import { LEDGER_TABLES, MIGRATIONS, migrate } from "../../src/ledger/schema.js";
import { OUTBOX_MAX_ATTEMPTS, outboxBackoffMs, type OrgLedger } from "../../src/ledger/org-ledger.js";
import { LEDGER_RPC_ERROR_STATUS, parseLedgerRpcError, toLedgerRpcError } from "../../src/ledger/errors.js";
import { freshLedger, inLedgerTx, installQueueMock, OrgLedgerTestHarness, waitFor, type LedgerStub } from "./harness.js";

const head = (resourceId: string, versionSeq = 1): AcceptedHead => ({
  resourceId: toResourceId(resourceId),
  revisionId: baseRev(resourceId),
  versionSeq,
  acceptedVersionId: null,
  acceptedAt: FIXTURE_TIME.created as AcceptedHead["acceptedAt"],
  reconciliation: "synced",
});

/** Turn an RPC promise into a native one (expect().rejects probes properties, which pipelines RPC calls). */
const rpc = (p: PromiseLike<unknown>): Promise<unknown> => Promise.resolve(p);

/** RPC operations stamp the real clock, so RPC fixtures are mutated and approved in the past. */
const PAST = { created: "2026-01-01T00:00:00.000Z", updated: "2026-01-02T00:00:00.000Z", prepared: "2026-01-02T12:00:00.000Z", approved: "2026-01-03T00:00:00.000Z", later: "2026-01-04T00:00:00.000Z" };
const rpcFixture = (opts: Parameters<typeof acceptFixture>[0] = {}) => {
  const f = acceptFixture({ updatedAt: PAST.updated, approvedAt: PAST.approved, ...opts });
  f.seed.preparedReceipts = f.seed.preparedReceipts!.map((r) => ({ ...r, preparedAt: PAST.prepared }));
  f.proposal = { ...f.proposal, createdAt: PAST.created as typeof f.proposal.createdAt };
  f.seed.proposals = [f.proposal];
  return f;
};

/** Simulate the backoff elapsing: make every pending outbox row due now. */
const makeDue = (stub: LedgerStub) =>
  runInDurableObject(stub, (_i, state) => {
    state.storage.sql.exec("UPDATE outbox SET next_attempt_at = 0");
  });

async function seeded(seed: Parameters<OrgLedgerTestHarness["seed"]>[0]): Promise<LedgerStub> {
  const h = new OrgLedgerTestHarness(freshLedger());
  await h.seed(seed);
  return h.stub;
}

const tableCount = (stub: LedgerStub, table: string) =>
  runInDurableObject(stub, (_i, state) => state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM ${table}`).one().n);

describe("schema migrations", () => {
  it("creates every ledger table and is idempotent", async () => {
    const stub = freshLedger();
    const names = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((r) => r.name),
    );
    for (const t of LEDGER_TABLES) expect(names).toContain(t);
    const rerun = await runInDurableObject(stub, (_i, state) => migrate(state.storage));
    expect(rerun).toEqual([]);
    expect(await tableCount(stub, "ledger_migrations")).toBe(MIGRATIONS.length);
  });

  it("migration 3 turns legacy genesis versions (accept, no proposal) and their idempotency records into bind", async () => {
    const stub = freshLedger();
    const bind = { organizationId: FIXTURE_ORG, resourceId: "r9", revisionId: baseRev("r9"), idempotencyKey: "b-1", actor: FIXTURE_ACTOR };
    const { acceptedVersionId } = (await stub.bindHead(bind)) as { acceptedVersionId: string };
    expect(await stub.getAcceptedVersion(acceptedVersionId)).toMatchObject({ kind: "bind", proposalId: null });
    // rewind to the pre-bind shape a DO written before this follow-up holds, plus a real accept
    await runInDurableObject(stub, (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("UPDATE accepted_versions SET kind = 'accept', json = json_set(json, '$.kind', 'accept')");
      sql.exec("UPDATE idempotency SET scope = 'accept'");
      sql.exec("DELETE FROM ledger_migrations WHERE id = 3");
    });
    const accept = { ...(await stub.getAcceptedVersion(acceptedVersionId))!, acceptedVersionId: "av-000000000002", sequence: 2, kind: "accept", proposalId: "prop-1" } as unknown as AcceptedProjectVersion;
    await inLedgerTx(stub, (tx) => tx.putAcceptedVersion(accept));
    await inLedgerTx(stub, (tx) => tx.putIdempotency(FIXTURE_ORG, { key: "a-1", scope: "accept", requestHash: "0".repeat(64), acceptedVersionId: accept.acceptedVersionId, createdAt: FIXTURE_TIME.now } as never));
    expect(await stub.getAcceptedVersion(acceptedVersionId)).toMatchObject({ kind: "accept" });

    expect(await runInDurableObject(stub, (_i, state) => migrate(state.storage))).toEqual([3]);
    expect(await stub.getAcceptedVersion(acceptedVersionId)).toMatchObject({ kind: "bind", proposalId: null });
    expect(await stub.getAcceptedVersion("av-000000000002")).toMatchObject({ kind: "accept", proposalId: "prop-1" });
    const scopes = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec<{ key: string; scope: string }>("SELECT key, scope FROM idempotency ORDER BY key").toArray().map((r) => [r.key, r.scope]),
    );
    expect(scopes).toEqual([["a-1", "accept"], ["b-1", "bind"]]);
    const kinds = await runInDurableObject(stub, (_i, state) =>
      state.storage.sql.exec<{ kind: string }>("SELECT kind FROM accepted_versions ORDER BY sequence").toArray().map((r) => r.kind),
    );
    expect(kinds).toEqual(["bind", "accept"]);
    // the bind still replays by its key
    expect(await stub.bindHead(bind)).toEqual({ ok: true, replayed: true, acceptedVersionId });
  });

  it("a bind recorded before migration 3 (scope accept) still replays", async () => {
    const stub = freshLedger();
    const bind = { organizationId: FIXTURE_ORG, resourceId: "r9", revisionId: baseRev("r9"), idempotencyKey: "b-1", actor: FIXTURE_ACTOR };
    const first = (await stub.bindHead(bind)) as { acceptedVersionId: string };
    await runInDurableObject(stub, (_i, state) => state.storage.sql.exec("UPDATE idempotency SET scope = 'accept'"));
    expect(await stub.bindHead(bind)).toEqual({ ok: true, replayed: true, acceptedVersionId: first.acceptedVersionId });
  });
});

describe("transactions", () => {
  it("a thrown error leaves no partial writes", async () => {
    const stub = freshLedger();
    await expect(
      inLedgerTx(stub, (tx) => {
        tx.bindResource(toResourceId("r1"), FIXTURE_ORG);
        tx.setHead(head("r1"));
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await inLedgerTx(stub, (tx) => [tx.getHead(toResourceId("r1")), tx.getResourceOrganization(toResourceId("r1"))])).toEqual([null, null]);
    expect(await tableCount(stub, "head_history")).toBe(0);
  });

  it("a constraint violation late in applyWrites rolls back the earlier writes", async () => {
    const stub = freshLedger();
    const idem = { key: "k", scope: "accept", requestHash: "a".repeat(64), acceptedVersionId: "av-000000000001", createdAt: FIXTURE_TIME.now } as const;
    const writes = [
      { op: "bindResource", resourceId: "r1", organizationId: FIXTURE_ORG },
      { op: "setHead", head: head("r1") },
      { op: "putIdempotency", organizationId: FIXTURE_ORG, record: idem },
      { op: "putIdempotency", organizationId: FIXTURE_ORG, record: idem },
    ] as unknown as LedgerWrite[];
    await expect(inLedgerTx(stub, (tx) => applyWrites(tx, writes))).rejects.toThrow(/UNIQUE/);
    expect(await inLedgerTx(stub, (tx) => [tx.getHead(toResourceId("r1")), tx.getIdempotency(FIXTURE_ORG, "k")])).toEqual([null, null]);
    expect(await tableCount(stub, "resource_orgs")).toBe(0);
  });

  it("an async callback is refused and rolled back", async () => {
    const stub = freshLedger();
    await expect(
      inLedgerTx(stub, (tx) => {
        tx.setHead(head("r1"));
        return Promise.resolve(1);
      }),
    ).rejects.toThrow(/synchronous/);
    expect(await tableCount(stub, "heads")).toBe(0);
  });

  it("a schema-invalid write throws before touching storage", async () => {
    const stub = freshLedger();
    await expect(inLedgerTx(stub, (tx) => tx.setHead({ ...head("r1"), versionSeq: 0 }))).rejects.toThrow();
    expect(await tableCount(stub, "heads")).toBe(0);
  });
});

describe("constraint mirrors", () => {
  it("resource → organization binding is write-once", async () => {
    const stub = freshLedger();
    await inLedgerTx(stub, (tx) => tx.bindResource(toResourceId("r1"), FIXTURE_ORG));
    // same organization again is a no-op
    await inLedgerTx(stub, (tx) => tx.bindResource(toResourceId("r1"), FIXTURE_ORG));
    await expect(inLedgerTx(stub, (tx) => tx.bindResource(toResourceId("r1"), "org-2"))).rejects.toThrow(/already bound/);
    // the SQL triggers refuse even raw rewrites
    await expect(
      runInDurableObject(stub, (_i, state) => state.storage.sql.exec("UPDATE resource_orgs SET organization_id = 'org-2'")),
    ).rejects.toThrow(/write-once/);
    await expect(runInDurableObject(stub, (_i, state) => state.storage.sql.exec("DELETE FROM resource_orgs"))).rejects.toThrow(/write-once/);
    expect(await inLedgerTx(stub, (tx) => tx.getResourceOrganization(toResourceId("r1")))).toBe(FIXTURE_ORG);
  });

  it("idempotency keys are unique per organization, not globally", async () => {
    const stub = freshLedger();
    const rec = { key: "k", scope: "accept", requestHash: "b".repeat(64), acceptedVersionId: "av-000000000001", createdAt: FIXTURE_TIME.now } as never;
    await inLedgerTx(stub, (tx) => tx.putIdempotency(FIXTURE_ORG, rec));
    await inLedgerTx(stub, (tx) => tx.putIdempotency("org-2", rec));
    await expect(inLedgerTx(stub, (tx) => tx.putIdempotency(FIXTURE_ORG, rec))).rejects.toThrow(/UNIQUE/);
    expect(await tableCount(stub, "idempotency")).toBe(2);
  });

  it("accepted version id and sequence are unique per organization", async () => {
    const stub = freshLedger();
    const v = {
      acceptedVersionId: "av-000000000001",
      organizationId: FIXTURE_ORG,
      sequence: 1,
      kind: "accept",
      proposalId: null,
      proposalHash: null,
      heads: [],
      actor: FIXTURE_ACTOR,
      acceptedAt: FIXTURE_TIME.now,
    } as never as AcceptedProjectVersion;
    await inLedgerTx(stub, (tx) => tx.putAcceptedVersion(v));
    await expect(inLedgerTx(stub, (tx) => tx.putAcceptedVersion({ ...v, acceptedVersionId: "av-x" as never }))).rejects.toThrow(/UNIQUE/);
    await expect(inLedgerTx(stub, (tx) => tx.putAcceptedVersion({ ...v, sequence: 2 }))).rejects.toThrow(/UNIQUE/);
    await inLedgerTx(stub, (tx) => tx.putAcceptedVersion({ ...v, organizationId: "org-2" }));
  });

  it("outbox dedupeKey and audit id are unique", async () => {
    const stub = freshLedger();
    const ev = {
      eventId: "ob-1",
      organizationId: FIXTURE_ORG,
      kind: "projection-refresh",
      dedupeKey: "d-1",
      createdAt: FIXTURE_TIME.now,
      attempts: 0,
      deliveredAt: null,
      payload: { resourceIds: [] },
    } as never as OutboxEvent;
    await inLedgerTx(stub, (tx) => tx.appendOutbox(ev));
    await expect(inLedgerTx(stub, (tx) => tx.appendOutbox({ ...ev, eventId: "ob-2" }))).rejects.toThrow(/UNIQUE/);
    await expect(inLedgerTx(stub, (tx) => tx.appendOutbox({ ...ev, dedupeKey: "d-2" }))).rejects.toThrow(/UNIQUE/);
    const au = { auditId: "au-1", organizationId: FIXTURE_ORG, at: FIXTURE_TIME.now, actor: FIXTURE_ACTOR, action: "x.y", subject: { kind: "resource", id: "r1" } } as never;
    await inLedgerTx(stub, (tx) => tx.appendAudit(au));
    await expect(inLedgerTx(stub, (tx) => tx.appendAudit(au))).rejects.toThrow(/UNIQUE/);
  });

  it("prepared receipts and approvals are write-once; policy revision never decreases", async () => {
    const f = rpcFixture();
    const stub = await seeded(f.seed);
    const receipt = f.seed.preparedReceipts![0]!;
    await stub.recordPreparedReceipt(FIXTURE_ORG, receipt); // identical: no-op
    await expect(rpc(stub.recordPreparedReceipt(FIXTURE_ORG, { ...receipt, jobId: "job-other" }))).rejects.toThrow(/^ledger_conflict: .*write-once/);
    const approval = f.input.approvals[0]!;
    await stub.putApproval(FIXTURE_ORG, approval);
    await stub.putApproval(FIXTURE_ORG, approval);
    await expect(rpc(stub.putApproval(FIXTURE_ORG, { ...approval, role: "client" }))).rejects.toThrow(/^ledger_conflict: .*write-once/);
    expect(await stub.listApprovals(f.input.proposalId)).toHaveLength(1);
    await expect(rpc(stub.putApproval(FIXTURE_ORG, { ...approval, approvalId: "appr-x", proposalId: "prop-unknown" }))).rejects.toThrow(/^ledger_not_found: unknown proposal/);
    await expect(rpc(stub.putApproval(FIXTURE_ORG, { ...approval, approvalId: "appr-f", approvedAt: "2099-01-01T00:00:00.000Z" }))).rejects.toThrow(/^ledger_invalid_input: approvedAt/);
    await stub.setPolicyRevision(FIXTURE_ORG, "proj-1", 3);
    await expect(rpc(stub.setPolicyRevision(FIXTURE_ORG, "proj-1", 2))).rejects.toThrow(/^ledger_conflict: .*cannot decrease/);
    await expect(rpc(stub.setPolicyRevision("org-2", "proj-1", 4))).rejects.toThrow(/^ledger_wrong_organization:/);
  });
});

describe("RPC", () => {
  it("accept commits once and replays by idempotency key; writes are readable", async () => {
    const f = rpcFixture();
    const stub = await seeded(f.seed);
    await installQueueMock(stub);
    const d = await stub.accept(f.input);
    expect(d).toEqual({ ok: true, replayed: false, acceptedVersionId: "av-000000000001" });
    expect(await stub.accept(f.input)).toEqual({ ok: true, replayed: true, acceptedVersionId: "av-000000000001" });

    const h = await stub.getHead("r1");
    expect(h).toMatchObject({ revisionId: f.candidate.r1, versionSeq: 2, acceptedVersionId: "av-000000000001", reconciliation: "pending" });
    expect((await stub.getProposal(f.input.proposalId))?.state).toBe("accepted");
    const versions = await stub.listAcceptedVersions();
    expect(versions.map((v) => v.acceptedVersionId)).toEqual(["av-000000000001"]);
    const outbox = await stub.listOutbox();
    expect(outbox.map((r) => r.event.kind)).toEqual(["reconcile-ref"]);
    const audit = await stub.listAudit();
    const actions: string[] = audit.map((r) => r.event.action);
    expect(actions).toContain("proposal.accepted");
    expect(JSON.parse(audit[0]!.detailJson!)).toMatchObject({ acceptedVersionId: "av-000000000001" });
    expect(await stub.getOrganization()).toBe(FIXTURE_ORG); // a successful accept pins the proposal's organization
  });

  it("accept refusals are returned, invalid input throws", async () => {
    const f = rpcFixture();
    const stub = await seeded(mergeSeeds(f.seed, { policyRevisions: [{ projectId: "proj-1", policyRevision: 2 }] }));
    expect(await stub.accept(f.input)).toMatchObject({ ok: false, code: "policy_revision_stale" });
    await expect(rpc(stub.accept({ ...f.input, proposalHash: "nope" }))).rejects.toThrow(/^ledger_invalid_input:/);
    expect(await stub.getOrganization()).toBe(null); // refusals pin nothing
    expect(await tableCount(stub, "accepted_versions")).toBe(0);
  });

  it("bindHead creates the genesis head and pins the ledger to one organization", async () => {
    const stub = freshLedger();
    const bind = { organizationId: FIXTURE_ORG, resourceId: "r9", revisionId: baseRev("r9"), idempotencyKey: "b-1", actor: FIXTURE_ACTOR };
    expect(await stub.bindHead(bind)).toEqual({ ok: true, replayed: false, acceptedVersionId: "av-000000000001" });
    expect(await stub.getResourceOrganization("r9")).toBe(FIXTURE_ORG);
    expect(await stub.getOrganization()).toBe(FIXTURE_ORG);
    await expect(rpc(stub.bindHead({ ...bind, organizationId: "org-2", resourceId: "r10", idempotencyKey: "b-2" }))).rejects.toThrow(/^ledger_wrong_organization: .*serves organization/);
    expect(await stub.bindHead({ ...bind, idempotencyKey: "b-3" })).toMatchObject({ ok: false, code: "expected_head_stale" });
  });

  it("restore runs through the DO with organization pinning", async () => {
    const f = rpcFixture();
    const stub = await seeded(f.seed);
    await installQueueMock(stub);
    await stub.accept(f.input);
    const r = { organizationId: FIXTURE_ORG, actor: FIXTURE_ACTOR, resourceId: "r1", expectedHead: f.candidate.r1!, targetRevision: baseRev("r1"), idempotencyKey: "rs-1" };
    expect(await stub.restore(r)).toEqual({ ok: true, replayed: false, acceptedVersionId: "av-000000000002" });
    expect(await stub.getHead("r1")).toMatchObject({ revisionId: baseRev("r1"), versionSeq: 3 });
    await expect(rpc(stub.restore({ ...r, organizationId: "org-2", idempotencyKey: "rs-2" }))).rejects.toThrow(/serves organization/);
  });

  it("putProposal cannot mark a proposal accepted nor rewrite an accepted one", async () => {
    const f = rpcFixture();
    const stub = freshLedger();
    await stub.putProposal({ ...f.proposal, state: "open" });
    expect((await stub.getProposal(f.proposal.proposalId))?.state).toBe("open");
    await expect(rpc(stub.putProposal({ ...f.proposal, state: "accepted" }))).rejects.toThrow(/set only by accept/);
    await stub.putProposal(f.proposal);
    for (const r of f.seed.preparedReceipts!) await stub.recordPreparedReceipt(FIXTURE_ORG, r);
    await stub.setPolicyRevision(FIXTURE_ORG, "proj-1", 1);
    await new OrgLedgerTestHarness(stub).seed({ heads: f.seed.heads! });
    await installQueueMock(stub);
    expect(await stub.accept(f.input)).toMatchObject({ ok: true });
    await expect(rpc(stub.putProposal(f.proposal))).rejects.toThrow(/^ledger_conflict: .*accepted and final/);
    await expect(rpc(stub.putProposal({ ...f.proposal, organizationId: "org-2", proposalId: "prop-x" }))).rejects.toThrow(/serves organization/);
    expect((await stub.listProposals("proj-1")).map((p) => p.proposalId)).toEqual([f.proposal.proposalId]);
  });

  it("stores candidates and workspaces", async () => {
    const stub = freshLedger();
    const candidate = {
      candidateId: "cand:ws-1:" + "c".repeat(40),
      taskWorkspaceId: "ws-1",
      fork: { kind: "artifacts", namespace: "commonforge-org-1-tasks", repoName: "ws-1", repoId: "ws-1", remoteUrl: "https://acct.artifacts.cloudflare.net/git/commonforge-org-1-tasks/ws-1.git" },
      resourceId: "r1",
      baseRevision: baseRev("r1"),
      sha: "c".repeat(40),
      treeId: "d".repeat(40),
      frozenAt: FIXTURE_TIME.prepared,
      submitter: FIXTURE_ACTOR,
      changedPaths: ["src/a.ts"],
    };
    await stub.putCandidate(FIXTURE_ORG, { candidate, state: "frozen", preparedReceiptId: null, updatedAt: FIXTURE_TIME.prepared });
    await stub.putCandidate(FIXTURE_ORG, { candidate, state: "prepared", preparedReceiptId: "prep-1", updatedAt: FIXTURE_TIME.approved });
    expect(await stub.getCandidate(candidate.candidateId)).toMatchObject({ state: "prepared", preparedReceiptId: "prep-1" });
    expect(await stub.listCandidates("r1")).toHaveLength(1);
    const ws = { taskWorkspaceId: "ws-1", resourceId: "r1", baseRevision: baseRev("r1"), provider: "artifacts", coords: candidate.fork, state: "writable" };
    await stub.putWorkspace(FIXTURE_ORG, ws);
    await stub.putWorkspace(FIXTURE_ORG, { ...ws, state: "frozen" });
    expect((await stub.getWorkspace("ws-1"))?.state).toBe("frozen");
    await expect(rpc(stub.putCandidate(FIXTURE_ORG, { candidate: { ...candidate, sha: "nope" }, state: "frozen", preparedReceiptId: null, updatedAt: FIXTURE_TIME.prepared }))).rejects.toThrow(/^ledger_invalid_input:/);

    // M-3: identity is immutable on re-put; states follow core's machines
    await expect(rpc(stub.putCandidate(FIXTURE_ORG, { candidate: { ...candidate, resourceId: "r2" }, state: "prepared", preparedReceiptId: "prep-1", updatedAt: FIXTURE_TIME.later }))).rejects.toThrow(/^ledger_conflict: .*immutable/);
    expect(await stub.listCandidates("r2")).toEqual([]);
    await expect(rpc(stub.putCandidate(FIXTURE_ORG, { candidate, state: "frozen", preparedReceiptId: null, updatedAt: FIXTURE_TIME.later }))).rejects.toThrow(/^ledger_conflict: .*prepared -> frozen/);
    await expect(rpc(stub.putWorkspace(FIXTURE_ORG, { ...ws, resourceId: "r2", state: "frozen" }))).rejects.toThrow(/^ledger_conflict: .*immutable/);
    await expect(rpc(stub.putWorkspace(FIXTURE_ORG, { ...ws, state: "writable" }))).rejects.toThrow(/^ledger_conflict: .*frozen -> writable/);
  });
});

describe("outbox alarm", () => {
  async function outboxRows(stub: LedgerStub) {
    return stub.listOutbox();
  }

  it("drains each unsent row exactly once, in order", async () => {
    const fs = ["r1", "r2", "r3"].map((r, i) => rpcFixture({ proposalId: `prop-${i}`, resources: [r] }));
    const stub = await seeded(mergeSeeds(...fs.map((f) => f.seed)));
    const q = await installQueueMock(stub);
    for (const f of fs) expect(await stub.accept(f.input)).toMatchObject({ ok: true });
    await runDurableObjectAlarm(stub);
    await waitFor(async () => (await outboxRows(stub)).every((r) => r.event.deliveredAt !== null));
    const rows = await outboxRows(stub);
    expect(q.sent).toEqual(rows.map((r) => ({ ...r.event, attempts: 0, deliveredAt: null })));
    expect(rows.map((r) => r.event.attempts)).toEqual([1, 1, 1]);

    // nothing left: further alarms / drains send nothing
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(await stub.drainOutbox()).toMatchObject({ sent: 0, failed: false, remaining: false });
    expect(q.sent).toHaveLength(3);
  });

  it("keeps a failed row unsent, retries it with backoff, and never sends later rows ahead of it", async () => {
    const fs = ["r1", "r2"].map((r, i) => rpcFixture({ proposalId: `prop-${i}`, resources: [r] }));
    const stub = await seeded(mergeSeeds(...fs.map((f) => f.seed)));
    const q = await installQueueMock(stub);
    q.failNext = Number.POSITIVE_INFINITY; // queue down until we say otherwise
    const before = Date.now();
    for (const f of fs) await stub.accept(f.input);
    await runDurableObjectAlarm(stub); // the alarm may also already have fired on its own
    await waitFor(async () => (await outboxRows(stub))[0]!.event.attempts >= 1);

    let rows = await outboxRows(stub);
    expect(q.sent).toEqual([]);
    expect(rows.map((r) => r.event.deliveredAt)).toEqual([null, null]);
    expect(rows[0]!.lastError).toMatch(/queue unavailable/);
    expect(rows[1]!.event.attempts).toBe(0); // head-of-line row blocks later rows
    const alarm = await runInDurableObject(stub, (_i, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThanOrEqual(before + outboxBackoffMs(1) - 50);
    const failedAttempts = rows[0]!.event.attempts;

    // before the backoff elapses the row is not retried, even if the alarm runs early
    expect(await stub.drainOutbox()).toMatchObject({ sent: 0, waiting: true });
    expect(q.calls).toBe(failedAttempts);

    q.failNext = 0; // queue back
    await makeDue(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    rows = await outboxRows(stub);
    expect(rows.every((r) => r.event.deliveredAt !== null)).toBe(true);
    expect(rows.map((r) => r.event.attempts)).toEqual([failedAttempts + 1, 1]);
    expect(q.sent.map((e) => (e as OutboxEvent).dedupeKey)).toEqual(rows.map((r) => r.event.dedupeKey));
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(await stub.drainOutbox()).toMatchObject({ sent: 0 });
    expect(q.sent).toHaveLength(2);
  });

  it("backoff grows exponentially and is capped", () => {
    expect([1, 2, 3].map(outboxBackoffMs)).toEqual([2000, 4000, 8000]);
    expect(outboxBackoffMs(100)).toBe(5 * 60_000);
  });
});

describe("durability", () => {
  it("state survives a DO restart (evicted instance, new stub, same id)", async () => {
    const f = rpcFixture();
    const name = `restart-${crypto.randomUUID()}`;
    const id = env.ORG_LEDGER.idFromName(name);
    const stub = env.ORG_LEDGER.get(id);
    await new OrgLedgerTestHarness(stub).seed(f.seed);
    const q = await installQueueMock(stub);
    q.failNext = 1_000; // keep the outbox row unsent across the restart
    const first = await stub.accept(f.input);
    expect(first).toMatchObject({ ok: true, replayed: false });

    await evictDurableObject(stub);
    const again = env.ORG_LEDGER.get(env.ORG_LEDGER.idFromName(name));
    expect(await again.getHead("r1")).toMatchObject({ revisionId: f.candidate.r1, versionSeq: 2 });
    expect(await again.accept(f.input)).toEqual({ ok: true, replayed: true, acceptedVersionId: first.ok ? first.acceptedVersionId : "" });
    expect(await tableCount(again, "ledger_migrations")).toBe(MIGRATIONS.length);
    const rows = await again.listOutbox();
    expect(rows).toHaveLength(1);
    // the restarted instance delivers the row that was pending before the restart
    const q2 = await installQueueMock(again);
    await makeDue(again);
    await again.drainOutbox();
    expect(q2.sent).toHaveLength(1);
    expect(await again.listOutbox({ filter: "pending" })).toEqual([]);
  });
});

/** A ledger set up through RPC the way the Worker API will: proposal, receipts, policy, then heads. */
async function viaRpc(f: ReturnType<typeof rpcFixture>, state: "open" | "prepared" | "withdrawn" | "rejected" | "superseded" = "prepared") {
  const stub = freshLedger();
  await stub.putProposal({ ...f.proposal, state });
  for (const r of f.seed.preparedReceipts!) await stub.recordPreparedReceipt(FIXTURE_ORG, r);
  await stub.setPolicyRevision(FIXTURE_ORG, "proj-1", 1);
  await new OrgLedgerTestHarness(stub).seed({ heads: f.seed.heads! });
  await installQueueMock(stub);
  return stub;
}

describe("review I-1: putProposal cannot reopen, back-date or re-home a proposal", () => {
  for (const terminal of ["withdrawn", "rejected", "superseded"] as const) {
    it(`A: a ${terminal} proposal stays dead`, async () => {
      const f = rpcFixture();
      const stub = await viaRpc(f, terminal);
      expect(await stub.accept(f.input)).toMatchObject({ ok: false, code: "proposal_not_prepared" });
      await expect(rpc(stub.putProposal(f.proposal))).rejects.toThrow(new RegExp(`^ledger_conflict: .*${terminal} and final`));
      expect(await stub.accept({ ...f.input, idempotencyKey: "k2" })).toMatchObject({ ok: false, code: "proposal_not_prepared" });
      // an identical re-put of the terminal record is an idempotent no-op
      await stub.putProposal({ ...f.proposal, state: terminal });
    });
  }

  it("B: updatedAt never goes back, so stale approvals stay stale", async () => {
    const f = rpcFixture();
    const stub = await viaRpc(f);
    await stub.putProposal({ ...f.proposal, updatedAt: "2026-01-05T00:00:00.000Z" });
    expect(await stub.accept(f.input)).toMatchObject({ ok: false, code: "approval_invalid" });
    await expect(rpc(stub.putProposal({ ...f.proposal, updatedAt: "2026-01-01T00:00:00.000Z" }))).rejects.toThrow(/^ledger_conflict: .*updatedAt cannot decrease/);
    expect(await stub.accept({ ...f.input, idempotencyKey: "k2" })).toMatchObject({ ok: false, code: "approval_invalid" });
  });

  it("B': changing hashed content requires a strictly newer updatedAt", async () => {
    const f = rpcFixture();
    const stub = await viaRpc(f);
    await expect(rpc(stub.putProposal({ ...f.proposal, policyRevision: 2 }))).rejects.toThrow(/^ledger_conflict: .*without advancing updatedAt/);
    // non-hashed bookkeeping (state, prepared receipts) may change at the same updatedAt
    await stub.putProposal({ ...f.proposal, state: "open" });
    await stub.putProposal(f.proposal);
  });

  it("C: projectId (and the other identity fields) are immutable", async () => {
    const f = rpcFixture();
    const stub = await viaRpc(f);
    await stub.setPolicyRevision(FIXTURE_ORG, "proj-1", 2);
    expect(await stub.accept(f.input)).toMatchObject({ ok: false, code: "policy_revision_stale" });
    await stub.setPolicyRevision(FIXTURE_ORG, "proj-other", 1);
    for (const patch of [{ projectId: "proj-other" }, { changeId: "chg-other" }, { createdAt: "2025-12-31T00:00:00.000Z" }]) {
      await expect(rpc(stub.putProposal({ ...f.proposal, ...patch }))).rejects.toThrow(/^ledger_conflict: .*is immutable/);
    }
    expect(await stub.accept({ ...f.input, idempotencyKey: "k2" })).toMatchObject({ ok: false, code: "policy_revision_stale" });
  });

  it("D: future-dated updatedAt / createdAt are refused (accept stays possible)", async () => {
    const f = rpcFixture();
    const stub = await viaRpc(f);
    await expect(rpc(stub.putProposal({ ...f.proposal, updatedAt: "2099-01-01T00:00:00.000Z" }))).rejects.toThrow(/^ledger_invalid_input: updatedAt/);
    await expect(rpc(stub.putProposal({ ...f.proposal, proposalId: "prop-new", createdAt: "2099-01-01T00:00:00.000Z", updatedAt: "2099-01-01T00:00:00.000Z" }))).rejects.toThrow(/^ledger_invalid_input: createdAt/);
    expect(await stub.accept(f.input)).toMatchObject({ ok: true });
  });
});

describe("review M-1: only successful operations pin the organization", () => {
  it("E: a refused restore or bind pins nothing", async () => {
    const stub = freshLedger();
    const r = { organizationId: "org-evil", actor: FIXTURE_ACTOR, resourceId: "r1", expectedHead: baseRev("r1"), targetRevision: baseRev("r1"), idempotencyKey: "rs-1" };
    expect(await stub.restore(r)).toMatchObject({ ok: false, code: "expected_head_stale" });
    expect(await stub.getOrganization()).toBe(null);
    const bind = { organizationId: FIXTURE_ORG, resourceId: "r9", revisionId: baseRev("r9"), idempotencyKey: "b", actor: FIXTURE_ACTOR };
    expect(await stub.bindHead(bind)).toMatchObject({ ok: true });
    expect(await stub.getOrganization()).toBe(FIXTURE_ORG);
  });

  it("a record-keeping write that throws pins nothing", async () => {
    const stub = freshLedger();
    await expect(rpc(stub.putApproval("org-evil", { ...rpcFixture().input.approvals[0]! }))).rejects.toThrow(/^ledger_not_found/);
    expect(await stub.getOrganization()).toBe(null);
  });
});

describe("review M-2: integration receipts", () => {
  const receiptFor = (f: ReturnType<typeof rpcFixture>, jobId: string, integratedAt: string) => ({
    jobId,
    proposalId: f.input.proposalId,
    results: [
      { resourceId: "r1", integrationRef: "refs/commonforge/integrations/prop-1", sha: "e".repeat(40), revisionId: baseRev("r1"), expectedHead: baseRev("r1") },
    ],
    evidence: f.input.evidence[0]!,
    integratedAt,
  });

  it("are write-once per (proposal, job), ordered, and frozen once the proposal is accepted", async () => {
    const f = rpcFixture();
    const stub = await viaRpc(f);
    const a = receiptFor(f, "job-a", PAST.prepared);
    await stub.recordIntegrationReceipt(FIXTURE_ORG, a);
    await stub.recordIntegrationReceipt(FIXTURE_ORG, a); // identical: no-op
    await expect(rpc(stub.recordIntegrationReceipt(FIXTURE_ORG, { ...a, integratedAt: PAST.approved }))).rejects.toThrow(/^ledger_conflict: .*write-once/);
    await expect(rpc(stub.recordIntegrationReceipt(FIXTURE_ORG, receiptFor(f, "job-old", PAST.updated)))).rejects.toThrow(/^ledger_conflict: .*older/);
    await stub.recordIntegrationReceipt(FIXTURE_ORG, receiptFor(f, "job-b", PAST.approved));
    expect(await inLedgerTx(stub, (tx) => tx.getIntegrationReceipt(f.input.proposalId)?.jobId)).toBe("job-b");
    expect(await tableCount(stub, "integration_receipts")).toBe(2);
    await expect(rpc(stub.recordIntegrationReceipt(FIXTURE_ORG, { ...a, proposalId: "prop-unknown" }))).rejects.toThrow(/^ledger_not_found/);
    await expect(rpc(stub.recordIntegrationReceipt("org-2", receiptFor(f, "job-c", PAST.later)))).rejects.toThrow(/^ledger_wrong_organization/);

    expect(await stub.accept(f.input)).toMatchObject({ ok: true });
    await expect(rpc(stub.recordIntegrationReceipt(FIXTURE_ORG, receiptFor(f, "job-c", PAST.later)))).rejects.toThrow(/^ledger_conflict: .*accepted/);
  });
});

describe("review M-4/M-5: outbox scheduling and dead letters", () => {
  it("the alarm is armed by the commit itself", async () => {
    const f = rpcFixture();
    const stub = await seeded(f.seed);
    const q = await installQueueMock(stub);
    q.failNext = Number.POSITIVE_INFINITY;
    const armed = await runInDurableObject(stub, async (instance: OrgLedger, state) => {
      await instance.accept(f.input);
      return state.storage.getAlarm();
    });
    expect(armed).not.toBeNull();
  });

  it(`a row failing ${OUTBOX_MAX_ATTEMPTS} times is dead-lettered, audited, and stops blocking later rows`, async () => {
    const fs = ["r1", "r2"].map((r, i) => rpcFixture({ proposalId: `prop-${i}`, resources: [r] }));
    const stub = await seeded(mergeSeeds(...fs.map((f) => f.seed)));
    const q = await installQueueMock(stub);
    q.failNext = OUTBOX_MAX_ATTEMPTS;
    for (const f of fs) await stub.accept(f.input);
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 5 && q.sent.length === 0; i++) {
      await makeDue(stub);
      await stub.drainOutbox();
    }
    const [dead, ok] = await stub.listOutbox();
    expect(dead!.deadAt).not.toBeNull();
    expect(dead!.event.deliveredAt).toBeNull();
    expect(dead!.event.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(ok!.event.deliveredAt).not.toBeNull();
    expect(q.sent.map((e) => (e as OutboxEvent).eventId)).toEqual([ok!.event.eventId]);
    expect((await stub.listDeadLetters()).map((r) => r.seq)).toEqual([dead!.seq]);
    expect(await stub.listOutbox({ filter: "pending" })).toEqual([]);
    const audit = (await stub.listAudit()).filter((r) => r.event.action === "outbox.dead_lettered");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detailJson!)).toMatchObject({ eventId: dead!.event.eventId, attempts: OUTBOX_MAX_ATTEMPTS });
    // dead rows are never retried
    await makeDue(stub);
    expect(await stub.drainOutbox()).toMatchObject({ sent: 0, remaining: false });
  });
});

describe("review M-6: coded RPC errors", () => {
  it("maps codes to HTTP statuses", () => {
    expect(parseLedgerRpcError(new Error("ledger_invalid_input: bad"))).toMatchObject({ code: "ledger_invalid_input", status: 400 });
    expect(parseLedgerRpcError(new Error("ledger_not_found: x")).status).toBe(404);
    expect(parseLedgerRpcError(new Error("ledger_wrong_organization: x")).status).toBe(403);
    expect(parseLedgerRpcError(new Error("ledger_conflict: x")).status).toBe(409);
    expect(parseLedgerRpcError(new Error("boom"))).toMatchObject({ code: "ledger_internal", status: 500 });
    expect(Object.keys(LEDGER_RPC_ERROR_STATUS)).toHaveLength(5);
  });

  it("classifies raw errors raised inside the DO", () => {
    expect(toLedgerRpcError(new Error("UNIQUE constraint failed: idempotency.key")).code).toBe("ledger_conflict");
    expect(toLedgerRpcError(Object.assign(new Error("invalid_ledger_input: now"), { code: "invalid_ledger_input" })).code).toBe("ledger_invalid_input");
    expect(toLedgerRpcError(new Error("ledger_conflict: already")).message).toBe("ledger_conflict: already");
  });
});

describe("consumer RPCs (Task 17)", () => {
  it("recordReconciliation changes only the matching head, audits each change, and consumes atomically once", async () => {
    const f = rpcFixture();
    const stub = await seeded(f.seed);
    await installQueueMock(stub);
    await stub.accept(f.input);
    const target = f.candidate.r1!;
    const consume = { dedupeKey: "reconcile-ref:av-000000000001:r1", eventId: "ob-1", kind: "reconcile-ref", outcome: "synced" };

    // a stale observation for an older revision never touches the head
    const stale = await stub.recordReconciliation(FIXTURE_ORG, { resourceId: "r1", revisionId: baseRev("r1"), state: "diverged" });
    expect(stale).toEqual({ headMatches: false, changed: false, consumed: false, alreadyConsumed: false });
    expect((await stub.getHead("r1"))?.reconciliation).toBe("pending");

    const first = await stub.recordReconciliation(FIXTURE_ORG, { resourceId: "r1", revisionId: target, state: "synced", observedSha: "a".repeat(40), consume });
    expect(first).toEqual({ headMatches: true, changed: true, consumed: true, alreadyConsumed: false });
    const again = await stub.recordReconciliation(FIXTURE_ORG, { resourceId: "r1", revisionId: target, state: "diverged", consume });
    expect(again).toEqual({ headMatches: false, changed: false, consumed: false, alreadyConsumed: true });
    expect((await stub.getHead("r1"))?.reconciliation).toBe("synced");
    expect(await stub.getConsumedEvent(FIXTURE_ORG, consume.dedupeKey)).toMatchObject({ outcome: "synced", eventId: "ob-1", kind: "reconcile-ref" });
    const audit = (await stub.listAudit()).filter((a) => a.event.action === "head.reconciliation_changed");
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detailJson!)).toMatchObject({ from: "pending", to: "synced", revisionId: target, dedupeKey: consume.dedupeKey });

    expect(await stub.consumeEvent(FIXTURE_ORG, { dedupeKey: "pushed:x", kind: "pushed", outcome: "ignored" })).toBe(true);
    expect(await stub.consumeEvent(FIXTURE_ORG, { dedupeKey: "pushed:x", kind: "pushed", outcome: "other" })).toBe(false);
    expect((await stub.getConsumedEvent(FIXTURE_ORG, "pushed:x"))?.outcome).toBe("ignored");
    await expect(rpc(stub.consumeEvent("org-2", { dedupeKey: "k", kind: "pushed", outcome: "x" }))).rejects.toThrow(/^ledger_wrong_organization:/);
    await expect(rpc(stub.recordReconciliation(FIXTURE_ORG, { resourceId: "r1", revisionId: target, state: "bogus" as never }))).rejects.toThrow(/^ledger_invalid_input:/);
  });
});
