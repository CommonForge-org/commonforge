/**
 * Worker-internal queue steps (`commonforge-steps`): slow provider work that must not run inside a
 * request (A2: create/fork take seconds; A6: import up to ~70 s; runner round trips).
 *
 * Each step is idempotent: it re-reads its record, does the next missing thing, and either finishes
 * or asks to be retried (runner still working, gate busy, lock held). Retries join the same open
 * runner job instead of issuing a new one.
 */
import { z } from "zod";
import type { Services } from "../context.js";
import type { StepOutcome } from "./intake.js";
import { GateBusyError } from "./ops-gate.js";
import { RunnerPendingError } from "./runner-jobs.js";

export const StepMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("workspace.create"), orgId: z.string(), taskWorkspaceId: z.string() }),
  z.object({ type: z.literal("intake.import"), orgId: z.string(), intakeId: z.string() }),
  z.object({ type: z.literal("candidate.prepare"), orgId: z.string(), candidateId: z.string() }),
  // client editions (Task 21, services/editions.ts)
  z.object({ type: z.literal("edition.build"), orgId: z.string(), buildId: z.string() }),
  z.object({ type: z.literal("edition.return"), orgId: z.string(), returnId: z.string() }),
  z.object({ type: z.literal("edition.candidate"), orgId: z.string(), returnId: z.string() }),
  // Task 22: post-deploy `/version` check of a release (services/releases.ts)
  z.object({ type: z.literal("release.health"), orgId: z.string(), releaseId: z.string(), rollback: z.boolean().optional() }),
  // folders and uploads (phase 2): hash a finished upload; apply / freeze / land / accept a file change
  z.object({ type: z.literal("lfs.hash"), orgId: z.string(), stagingId: z.string() }),
  z.object({ type: z.literal("files.apply"), orgId: z.string(), changeId: z.string() }),
  z.object({ type: z.literal("files.candidate"), orgId: z.string(), changeId: z.string() }),
  z.object({ type: z.literal("files.land"), orgId: z.string(), changeId: z.string() }),
  // file collections (plan phase 3, Task 5, services/asset-changes.ts): copy one upload to its content key; write the manifest and propose
  z.object({ type: z.literal("files.assets.copy"), orgId: z.string(), changeId: z.string(), stagingId: z.string() }),
  z.object({ type: z.literal("files.assets.manifest"), orgId: z.string(), changeId: z.string(), copied: z.string().optional() }),
  z.object({ type: z.literal("files.accept"), orgId: z.string(), changeId: z.string(), integrationOk: z.boolean(), code: z.string().optional(), detail: z.string().optional() }),
  // always-on staging (spec 2026-10-07, services/staging.ts)
  z.object({ type: z.literal("staging.land"), orgId: z.string(), taskId: z.string() }),
  z.object({ type: z.literal("staging.advance"), orgId: z.string(), buildId: z.string() }),
  // promotion to production (staging phase 2, services/promotions.ts)
  z.object({ type: z.literal("promotion.advance"), orgId: z.string(), promotionId: z.string() }),
  // folders phase 4 (services/folder-init.ts): a new folder's first commit (runner `init-folder`)
  z.object({ type: z.literal("folders.init"), orgId: z.string(), resourceId: z.string() }),
]);
export type StepMessage = z.infer<typeof StepMessageSchema>;

/** After this many deliveries a step is marked failed (its own record says why). */
export const MAX_STEP_ATTEMPTS = 10;

type Handler = (svc: Services, msg: StepMessage, attempt: number) => Promise<StepOutcome>;
const handlers = new Map<StepMessage["type"], Handler>();

export function onStep<T extends StepMessage["type"]>(type: T, fn: (svc: Services, msg: Extract<StepMessage, { type: T }>, attempt: number) => Promise<StepOutcome>): void {
  handlers.set(type, fn as Handler);
}

/** Called when a step exhausted its attempts. */
const giveUp = new Map<StepMessage["type"], (svc: Services, msg: StepMessage, reason: string) => Promise<void>>();
export function onStepFailed<T extends StepMessage["type"]>(type: T, fn: (svc: Services, msg: Extract<StepMessage, { type: T }>, reason: string) => Promise<void>): void {
  giveUp.set(type, fn as (svc: Services, msg: StepMessage, reason: string) => Promise<void>);
}

export async function enqueueStep(svc: Services, msg: StepMessage): Promise<void> {
  await svc.deps.stepQueue(svc.env).send(msg);
}

function transient(e: unknown): string | null {
  if (e instanceof RunnerPendingError || e instanceof GateBusyError) return e.message;
  const code = (e as { code?: unknown })?.code;
  if (code === "provider_unavailable" || code === "runner_pending" || code === "chaos_crash") return e instanceof Error ? e.message : String(code);
  // B6 (Task 23 review fixes): a runner job that failed because the provider was unavailable (e.g.
  // Artifacts answering git with "expected flush after ref listing") is retried with a fresh job
  if (code === "runner_failed" && (e as { details?: { code?: unknown } }).details?.code === "provider_unavailable") return e instanceof Error ? e.message : String(code);
  return null;
}

/** Queue consumer for `commonforge-steps`. */
export async function handleStepBatch(svc: Services, batch: MessageBatch): Promise<void> {
  for (const m of batch.messages) {
    const parsed = StepMessageSchema.safeParse(m.body);
    if (!parsed.success) {
      console.error("dropping malformed step message");
      m.ack();
      continue;
    }
    const msg = parsed.data;
    const handler = handlers.get(msg.type);
    if (!handler) {
      m.ack();
      continue;
    }
    try {
      const out = await handler(svc, msg, m.attempts);
      if ("done" in out) m.ack();
      else if (m.attempts >= MAX_STEP_ATTEMPTS) {
        await giveUp.get(msg.type)?.(svc, msg, out.reason);
        m.ack();
      } else m.retry({ delaySeconds: out.delaySeconds });
    } catch (e) {
      const why = transient(e);
      if (why && m.attempts < MAX_STEP_ATTEMPTS) {
        m.retry({ delaySeconds: Math.min(60, 2 ** m.attempts) });
        continue;
      }
      const reason = e instanceof Error ? e.message.slice(0, 500) : String(e);
      console.error(`step ${msg.type} failed: ${reason}`);
      await giveUp.get(msg.type)?.(svc, msg, reason);
      m.ack();
    }
  }
}
