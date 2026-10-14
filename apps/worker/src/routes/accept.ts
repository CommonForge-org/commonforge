/**
 * Acceptance (plan §B.9, FR-11): only the trusted service path advances heads, through
 * `OrgLedger.accept` (planCommit inside one DO transaction). Every condition is rechecked at commit
 * time: expected heads (stale → refused), proposal hash, approvals (current authorization), policy
 * revision, prepared receipts, signed evidence. The idempotency key makes a retried request return
 * the original accepted version (AT-14).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { ApiError, errorBody, forbidden, readJson } from "../lib/http.js";
import { canReadResource, canWriteResource, orgActor } from "../middleware/authz.js";
import { userRef } from "../services/events.js";
import { FILE_CHANGE_RESTART_CODES, restartStaleFileChange } from "../services/file-changes.js";
import { acceptInputFor, afterProposalAccepted, integrationPending } from "../services/proposals.js";
import { assertUserAcceptable } from "../services/integration.js";
import { visibleProposal } from "./proposals.js";
import { chaos } from "../chaos.js";

export const acceptRoutes = new Hono<AppEnv>();

const IdempotencyKeySchema = z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/);

acceptRoutes.post("/orgs/:org/proposals/:id/accept", async (c) => {
  const actor = await orgActor(c, c.req.param("org"), ["owner", "developer"]);
  const body = await readJson(c, z.object({ idempotencyKey: IdempotencyKeySchema }));
  const svc = c.get("svc");
  const { p, idx } = await visibleProposal(c, actor, c.req.param("id"));
  assertUserAcceptable(idx);
  for (const r of [...p.resourceChanges.map((x) => x.resourceId), ...p.assetManifestChanges.map((x) => x.resourceId)]) {
    if (!(await canWriteResource(svc, actor, r))) throw forbidden("no_write_grant", `no write grant on ${r}`);
  }
  const ledger = svc.ledger(actor.orgId);
  // The same request (same key, same proposal content, same approvals/evidence) replays the
  // original acceptedVersionId; a request for a proposal that is already accepted under another key
  // is refused by the ledger (proposal_not_prepared).
  // review I1: the runner reported success but the receipt is not in the ledger yet. Only while the
  // proposal is still prepared (re-review R3): a retry of an accept that already committed replays.
  const pending = p.state === "prepared" ? await integrationPending(svc, actor.orgId, p.proposalId) : null;
  if (pending === "applying") {
    return c.json(errorBody("integration_applying", "the validation result is still being recorded; retry in a few seconds"), 409, { "retry-after": "2" });
  }
  if (pending === "not_recorded") {
    throw new ApiError(409, "receipt_not_recorded", "the validation result was never recorded; validate again");
  }
  const decision = await ledger.accept(await acceptInputFor(svc, p, `${actor.orgId}:${body.idempotencyKey}`, userRef(actor.userId)));
  if (!decision.ok) {
    // a file change landing through this proposal re-applies on the new head (spec §7) or under the new policy (R8)
    if (FILE_CHANGE_RESTART_CODES.includes(decision.code)) {
      // best effort: the caller gets the 409 either way (the read sweep catches what this misses)
      await restartStaleFileChange(svc, actor.orgId, p.proposalId, decision.code).catch((e) => console.warn(`file change restart after a stale accept failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    // Name the resource only to callers who can read it (a stale policy reference may be one they cannot).
    const rid = decision.resourceId && (await canReadResource(svc, actor, decision.resourceId)) ? decision.resourceId : undefined;
    const detail = rid || !decision.resourceId ? (decision.detail ?? decision.code) : decision.code;
    throw new ApiError(409, decision.code, detail, rid ? { resourceId: rid } : undefined);
  }
  await afterProposalAccepted(svc, { orgId: actor.orgId, p, projectId: idx.project_id, userId: actor.userId, acceptedVersionId: decision.acceptedVersionId, replayed: decision.replayed });
  // chaos (G.5, AT-14): committed, but the client never sees the answer; a retry with the same key replays it
  if (!decision.replayed && chaos(c.env, "lost_accept_response", p.proposalId)) return c.json(errorBody("chaos_response_lost", "injected fault: the accept response was lost"), 503);
  return c.json({ proposalId: p.proposalId, acceptedVersionId: decision.acceptedVersionId, replayed: decision.replayed });
});
