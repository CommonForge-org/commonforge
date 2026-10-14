/**
 * Candidate preparation (plan §A.6 "Prepared"): a queue step submits the runner
 * `prepare-candidate` job through `ArtifactsVersionProvider.prepareForAcceptance` (objects copied
 * into canonical under `refs/commonforge/candidates/<ws>/<sha>`), records the receipt in the ledger
 * and attaches it to the open proposals that contain the candidate.
 */
import type { Services } from "../context.js";
import { recordEvent } from "./events.js";
import { failChange, type FileChangeRow } from "./file-changes.js";
import { attachReceipt } from "./proposals.js";
import { runnerSubmit } from "./runner-jobs.js";
import { enqueueStep, onStep, onStepFailed } from "./steps.js";
import { ArtifactsProviderError } from "@commonforge-org/provider-cloudflare";
import { ChaosCrash, chaos } from "../chaos.js";

onStep("candidate.prepare", async (svc: Services, msg, attempt) => {
  const ledger = svc.ledger(msg.orgId);
  const rec = await ledger.getCandidate(msg.candidateId);
  if (!rec || rec.state !== "frozen") return { done: true };
  const idx = await svc.db.prepare("SELECT task_id FROM task_candidates WHERE candidate_id = ?").bind(msg.candidateId).first<{ task_id: string }>();
  // chaos (G.5, AT-12): the provider fails (5xx) on the first delivery; nothing is prepared
  if (attempt <= 1 && chaos(svc.env, "provider_5xx_during_prepare", msg.candidateId)) throw new ArtifactsProviderError("provider_unavailable", "chaos: provider 5xx during prepare");
  const receipt = await svc.provider().prepareForAcceptance(rec.candidate, runnerSubmit(svc, msg.orgId, `candidate:${msg.candidateId}`));
  await ledger.recordPreparedReceipt(msg.orgId, receipt);
  // chaos (G.5): crash after the receipt, before the candidate/proposal records; the retry reuses it
  if (attempt <= 1 && chaos(svc.env, "after_prepare_before_commit", msg.candidateId)) throw new ChaosCrash("after_prepare_before_commit");
  await ledger.putCandidate(msg.orgId, { ...rec, state: "prepared", preparedReceiptId: receipt.receiptId, updatedAt: svc.nowIso() });
  if (idx) {
    await attachReceipt(svc, msg.orgId, idx.task_id, msg.candidateId, rec.candidate.resourceId, receipt.receiptId);
    // a file change's candidate: its proposal is prepared now, it lands on its own (services/file-changes.ts)
    const fc = await svc.db.prepare("SELECT change_id FROM file_changes WHERE task_id = ? AND state = 'applying'").bind(idx.task_id).first<{ change_id: string }>();
    if (fc) await enqueueStep(svc, { type: "files.land", orgId: msg.orgId, changeId: fc.change_id });
  }
  await recordEvent(svc, {
    orgId: msg.orgId,
    actor: { kind: "runner", id: "integration-runner" } as never,
    action: "candidate.prepared",
    subjectKind: "candidate",
    subjectId: msg.candidateId,
    resourceIds: [rec.candidate.resourceId],
    detail: { receiptId: receipt.receiptId, canonicalRef: receipt.canonicalRef },
  });
  return { done: true };
});

onStepFailed("candidate.prepare", async (svc, msg, reason) => {
  // a file change waiting for this candidate can never land; a staged one (staging-mode projects)
  // fails now and its landing leaves staging (failChange, P3-6) instead of waiting for staging's
  // prepare deadline
  const fc = await svc.db
    .prepare("SELECT f.* FROM file_changes f JOIN task_candidates c ON c.task_id = f.task_id WHERE c.candidate_id = ? AND f.state IN ('applying', 'staged')")
    .bind(msg.candidateId)
    .first<FileChangeRow>();
  if (fc) await failChange(svc, fc, "prepare_failed", reason);
  await recordEvent(svc, { orgId: msg.orgId, actor: { kind: "service", id: "worker" } as never, action: "candidate.prepare_failed", subjectKind: "candidate", subjectId: msg.candidateId, detail: { reason } });
});
