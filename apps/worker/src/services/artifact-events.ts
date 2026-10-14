/**
 * Artifacts event consumer (`commonforge-artifacts-events`, plan §0.3 A6).
 *
 * `pushed` events are **wakeups, never authority**: an event says only "something was pushed to
 * this ref". It is deduped by (repo, ref, before, after) in the org's ledger (with `before`, a
 * later push that moves the ref back to an already seen sha is still a new wakeup, review M-1); then the consumer reads the
 * canonical branch itself and compares it with the ledger head:
 * - the branch is at the head's sha → record `synced` (e.g. the reconcile job's own push);
 * - the head is still `pending` → nothing (its outbox event is on the way);
 * - otherwise something moved the branch off the ledger head → record `diverged` and request a
 *   `reconcile-ref` through the outbox queue (the ledger head wins).
 * Pushes to task repos, retention/integration refs and other branches are ignored. `repo.forked` /
 * `repo.imported` never arrive (A6), so nothing here depends on them; the GC sweep is the backstop.
 */
import { parseRevisionId } from "@commonforge-org/core";
import { parseNamespace } from "@commonforge-org/provider-cloudflare";
import { z } from "zod";
import type { Services } from "../context.js";
import { getResource, resourceCoords } from "./directory.js";
import { openReconcileJob, reconcileRequest, refreshHeadProjections, retryDelaySeconds } from "./outbox-consumer.js";

export const ARTIFACT_EVENTS_QUEUE = "commonforge-artifacts-events";

const ShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const PushedEventSchema = z.object({
  type: z.literal("cf.artifacts.repo.pushed"),
  source: z.object({ namespace: z.string().min(1), repoName: z.string().min(1) }),
  payload: z.object({ ref: z.string().min(1).max(400), before: ShaSchema.optional(), after: ShaSchema }),
});
export type PushedEvent = z.infer<typeof PushedEventSchema>;

export async function handleArtifactEventsBatch(svc: Services, batch: MessageBatch): Promise<void> {
  for (const m of batch.messages) {
    const parsed = PushedEventSchema.safeParse(m.body);
    if (!parsed.success) {
      // repo.created / repo.deleted and anything else: not used (never authority)
      m.ack();
      continue;
    }
    try {
      await handlePushed(svc, parsed.data);
      m.ack();
    } catch (e) {
      console.error(`artifacts event: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
      m.retry({ delaySeconds: retryDelaySeconds(m.attempts) });
    }
  }
}

/** What a `pushed` wakeup led to (for tests and logs). */
export type PushedOutcome = "ignored" | "duplicate" | "no_head" | "synced" | "pending" | "in_sync" | "diverged";

export async function handlePushed(svc: Services, ev: PushedEvent): Promise<PushedOutcome> {
  const ns = parseNamespace(svc.env.COMMONFORGE_NAMESPACE_PREFIX, ev.source.namespace);
  if (!ns || ns.kind !== "canonical") return "ignored";
  const org = ns.organizationId;
  const resource = await getResource(svc.db, org, ev.source.repoName);
  const coords = resource ? resourceCoords(resource) : null;
  if (!resource || resource.provider !== "artifacts" || !coords || coords.kind !== "artifacts" || coords.namespace !== ev.source.namespace) return "ignored";
  const branch = resource.branch ?? "main";
  if (ev.payload.ref !== `refs/heads/${branch}`) return "ignored";

  const ledger = svc.ledger(org);
  const consume = (outcome: string) => ({ dedupeKey: `pushed:${ev.source.namespace}/${ev.source.repoName}:${ev.payload.ref}:${ev.payload.before ?? "none"}..${ev.payload.after}`, eventId: null, kind: "pushed", outcome });
  if (await ledger.getConsumedEvent(org, consume("").dedupeKey)) return "duplicate";
  const head = await ledger.getHead(resource.resource_id);
  const rev = head ? parseRevisionId(head.revisionId) : null;
  if (!head || !rev || rev.kind !== "art") {
    await ledger.consumeEvent(org, consume("no_head"));
    return "no_head";
  }
  // Never trust the event's `after`: read the branch.
  const [commit] = await svc.transport.log(coords.namespace, coords.repoName, { ref: branch, limit: 1 });
  const actual = commit?.hash ?? null;
  let outcome: PushedOutcome;
  if (actual === rev.sha && (await openReconcileJob(svc, org, head.resourceId, rev.sha))) {
    // N-1: an older job could still push over it; leave the head as it is (the outbox / GC settle it)
    await ledger.consumeEvent(org, consume("open_job"));
    outcome = "pending";
  } else if (actual === rev.sha) {
    const r = await ledger.recordReconciliation(org, { resourceId: head.resourceId, revisionId: head.revisionId, state: "synced", observedSha: actual, consume: consume("synced") });
    outcome = r.changed ? "synced" : "in_sync";
  } else if (head.reconciliation === "pending") {
    await ledger.consumeEvent(org, consume("pending"));
    outcome = "pending";
  } else {
    await ledger.recordReconciliation(org, { resourceId: head.resourceId, revisionId: head.revisionId, state: "diverged", observedSha: actual });
    // enqueue before consuming: a crash in between redelivers the wakeup, and the request dedupes
    const req = reconcileRequest(org, head, `pushed:${ev.payload.before ?? "none"}..${ev.payload.after}`, svc.now());
    if (req) await svc.deps.outboxQueue(svc.env).send(req);
    await ledger.consumeEvent(org, consume("diverged"));
    outcome = "diverged";
  }
  await refreshHeadProjections(svc, org, [head.resourceId]);
  return outcome;
}
