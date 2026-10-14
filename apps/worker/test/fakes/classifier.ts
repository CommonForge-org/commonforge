/**
 * Scriptable risk classifier (staging phase 3). Each `classify` call takes the next `script` step
 * (answers, an error code, a delay, or `"hang"` until the caller's signal aborts) and falls back to
 * `fallback` (all safe by default) when the script is empty. Every call is recorded with its
 * provider and the exact state, so tests can assert what the gate sent.
 */
import { RISK_QUESTION_IDS, RISK_QUESTIONS, type RiskAnswers } from "@commonforge-org/core";
import { ClassifierError, type ClassifierErrorCode, type ClassifierProvider, type RiskClassifier } from "../../src/services/classifier.js";

/** Every question answered with its first safe option at 0.97 (clears any threshold up to 0.97). */
export const SAFE_ANSWERS: RiskAnswers = Object.fromEntries(
  RISK_QUESTION_IDS.map((id) => {
    const q = RISK_QUESTIONS[id];
    const safe = q.safe[0] as string;
    const others = (q.options as readonly string[]).filter((o) => o !== safe);
    return [id, { choice: safe, probabilities: Object.fromEntries([[safe, 0.97], ...others.map((o) => [o, 0.03 / others.length])]) }];
  }),
) as RiskAnswers;

export type FakeClassifierStep = { answers: RiskAnswers; model?: string; delayMs?: number } | { error: ClassifierErrorCode; delayMs?: number } | "hang";

export class FakeClassifier {
  /** consumed front to back, one step per call */
  readonly script: FakeClassifierStep[] = [];
  /** used when the script is empty */
  fallback: FakeClassifierStep = { answers: SAFE_ANSWERS };
  model = "fake-model";
  readonly calls: Array<{ provider: ClassifierProvider; state: string }> = [];

  /** The adapter `deps.classifier(env, provider)` returns. */
  forProvider(provider: ClassifierProvider): RiskClassifier {
    return {
      provider,
      model: this.model,
      classify: (state, signal) => this.classify(provider, state, signal),
    };
  }

  private async classify(provider: ClassifierProvider, state: string, signal: AbortSignal): Promise<{ answers: RiskAnswers; model?: string }> {
    this.calls.push({ provider, state });
    const step = this.script.length ? this.script.shift()! : this.fallback;
    if (step === "hang") {
      await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new ClassifierError("timeout", "timed out")), { once: true }));
      throw new Error("unreachable");
    }
    if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
    if ("error" in step) throw new ClassifierError(step.error, `fake: ${step.error}`);
    return { answers: structuredClone(step.answers), ...(step.model ? { model: step.model } : {}) };
  }
}
