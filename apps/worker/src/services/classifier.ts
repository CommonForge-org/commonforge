/**
 * The risk classifier port (staging spec §8 "Risk classifier port", plan rulings P3-1 to P3-3).
 * Adapters only translate wire formats: they send the fixed question set from core with the
 * untrusted change text as the `state` / `input` (never as instructions) and parse the answers
 * strictly into `RiskAnswers`. The decision is core's `riskClears`.
 *
 * Fail closed: `runClassifier` never throws. A missing key, an HTTP error, a refusal, any answer
 * that does not parse, or the 5 s timeout becomes evidence with `cleared: false` and an error code.
 * Evidence never holds the provider's raw body or a key.
 */
import {
  RISK_QUESTION_IDS,
  RISK_QUESTIONS,
  riskClears,
  sha256Hex,
  type RiskAnswer,
  type RiskAnswers,
  type RiskEvidence,
  type RiskIncompleteReason,
  type RiskQuestionId,
} from "@commonforge-org/core";
import { z } from "zod";
import type { Env } from "../env.js";

export type ClassifierProvider = "jev" | "openai-decisions" | "none";
export type ClassifierErrorCode = "not_configured" | "timeout" | "http_error" | "refused" | "malformed" | "input_too_large" | "input_incomplete";

/** `RiskEvidence` (core) with the Worker's error codes. */
export type ClassifierEvidence = RiskEvidence & { error: ClassifierErrorCode | null };

export class ClassifierError extends Error {
  constructor(
    readonly code: ClassifierErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClassifierError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RiskClassifier {
  readonly provider: ClassifierProvider;
  /** the configured model; the answer's `model` (when the provider reports one) wins in evidence */
  readonly model: string;
  classify(state: string, signal: AbortSignal): Promise<{ answers: RiskAnswers; model?: string }>;
}

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const OPENAI_DECISIONS_URL = "https://api.openai.com/v1/decisions";
export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";
export const CLASSIFIER_TIMEOUT_MS = 5000;

/** The provider's instructions for one question: the question, then its fixed guidance (platform text only). */
function instructionsFor(id: RiskQuestionId): string {
  const q = RISK_QUESTIONS[id];
  return `${q.question} ${q.instructions}`;
}
const optionsOf = (id: RiskQuestionId) => RISK_QUESTIONS[id].options as readonly string[];
const descriptionsOf = (id: RiskQuestionId) => RISK_QUESTIONS[id].descriptions as Record<string, string>;

/** Float rounding slack above 1 that a provider's probability may carry; such a value counts as exactly 1. */
const PROBABILITY_SLACK = 1e-6;
const Probability = z
  .number()
  .min(0)
  .max(1 + PROBABILITY_SLACK)
  .transform((p) => Math.min(p, 1));
/** Evidence only; a provider may send it as null. */
const Confidence = z.number().min(0).max(1).nullish();
/** Exactly the question's options, each a probability in [0, 1]. */
const probabilitiesSchema = (id: RiskQuestionId) => z.strictObject(Object.fromEntries(optionsOf(id).map((o) => [o, Probability])) as Record<string, typeof Probability>);
const choiceSchema = (id: RiskQuestionId) => z.enum(optionsOf(id) as [string, ...string[]]);

const malformed = (provider: string, detail: string) => new ClassifierError("malformed", `${provider}: malformed answer (${detail})`);

/** POST JSON with the key in the header only; maps transport failures to codes without keeping bodies. */
async function postJson(fetchImpl: FetchLike, url: string, apiKey: string, body: unknown, signal: AbortSignal, provider: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    if (signal.aborted) throw new ClassifierError("timeout", `${provider}: timed out`);
    throw new ClassifierError("http_error", `${provider}: no response`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new ClassifierError("http_error", `${provider}: HTTP ${res.status}`);
  }
  try {
    return await res.json();
  } catch {
    if (signal.aborted) throw new ClassifierError("timeout", `${provider}: timed out`);
    throw malformed(provider, "body is not JSON");
  }
}

const isRefusal = (a: unknown) => typeof a === "object" && a !== null && (a as { type?: unknown }).type === "refusal";

// ---------------------------------------------------------------------------------------------
// Jev through TypeSafe's API (P3-1)
// ---------------------------------------------------------------------------------------------

const jevAnswerSchema = (id: RiskQuestionId) =>
  z.object({ type: z.literal("choice"), choice: choiceSchema(id), confidence: Confidence, probabilities: probabilitiesSchema(id) });
const JevResponseSchema = z.object({
  model: z.string().min(1).max(128).nullish(),
  answers: z.strictObject(Object.fromEntries(RISK_QUESTION_IDS.map((id) => [id, jevAnswerSchema(id)])) as Record<RiskQuestionId, ReturnType<typeof jevAnswerSchema>>),
});

export function jevClassifier(o: { apiKey: string | undefined; fetch: FetchLike }): RiskClassifier {
  return {
    provider: "jev",
    model: JEV_MODEL,
    async classify(state, signal) {
      if (!o.apiKey) throw new ClassifierError("not_configured", "jev: JEV_API_KEY is not configured");
      const questions = Object.fromEntries(
        RISK_QUESTION_IDS.map((id) => [id, { type: "choice", instructions: instructionsFor(id), criteria: Object.fromEntries(optionsOf(id).map((opt) => [opt, descriptionsOf(id)[opt]])) }]),
      );
      const raw = await postJson(o.fetch, JEV_URL, o.apiKey, { model: JEV_MODEL, state, questions }, signal, "jev");
      const answers = (raw as { answers?: unknown } | null)?.answers;
      if (answers && typeof answers === "object" && Object.values(answers).some(isRefusal)) throw new ClassifierError("refused", "jev: refused");
      const parsed = JevResponseSchema.safeParse(raw);
      if (!parsed.success) throw malformed("jev", parsed.error.issues[0]?.path.join(".") ?? "shape");
      const out = {} as RiskAnswers;
      for (const id of RISK_QUESTION_IDS) out[id] = normalise(parsed.data.answers[id]);
      return { answers: out, model: parsed.data.model ?? JEV_MODEL };
    },
  };
}

function normalise(a: { choice: string; probabilities: Record<string, number>; confidence?: number | null | undefined }): RiskAnswer {
  return { choice: a.choice, probabilities: { ...a.probabilities }, ...(a.confidence !== undefined && a.confidence !== null ? { confidence: a.confidence } : {}) };
}

// ---------------------------------------------------------------------------------------------
// OpenAI Decisions
// ---------------------------------------------------------------------------------------------

const OpenAiChoiceSchema = z.object({
  type: z.literal("choice"),
  name: z.string(),
  choice: z.string(),
  confidence: Confidence,
  probabilities: z.array(z.object({ value: z.string(), probability: Probability })),
});
const OpenAiResponseSchema = z.object({ answers: z.array(OpenAiChoiceSchema) });

export function openAiDecisionsClassifier(o: { apiKey: string | undefined; model: string; fetch: FetchLike }): RiskClassifier {
  return {
    provider: "openai-decisions",
    model: o.model,
    async classify(state, signal) {
      if (!o.apiKey) throw new ClassifierError("not_configured", "openai-decisions: OPENAI_API_KEY is not configured");
      const questions = RISK_QUESTION_IDS.map((id) => ({
        type: "choice",
        name: id,
        instructions: instructionsFor(id),
        choices: optionsOf(id).map((value) => ({ value, description: descriptionsOf(id)[value] })),
      }));
      const raw = await postJson(o.fetch, OPENAI_DECISIONS_URL, o.apiKey, { model: o.model, input: state, questions }, signal, "openai-decisions");
      const list = (raw as { answers?: unknown } | null)?.answers;
      if (Array.isArray(list) && list.some(isRefusal)) throw new ClassifierError("refused", "openai-decisions: refused");
      const parsed = OpenAiResponseSchema.safeParse(raw);
      if (!parsed.success) throw malformed("openai-decisions", parsed.error.issues[0]?.path.join(".") ?? "shape");
      const byName = new Map<string, z.infer<typeof OpenAiChoiceSchema>>();
      for (const a of parsed.data.answers) {
        if (!(RISK_QUESTION_IDS as string[]).includes(a.name)) throw malformed("openai-decisions", "unknown question");
        if (byName.has(a.name)) throw malformed("openai-decisions", "duplicate question");
        byName.set(a.name, a);
      }
      const out = {} as RiskAnswers;
      for (const id of RISK_QUESTION_IDS) {
        const a = byName.get(id);
        if (!a) throw malformed("openai-decisions", `missing ${id}`);
        const probabilities: Record<string, number> = {};
        for (const p of a.probabilities) {
          if (Object.hasOwn(probabilities, p.value)) throw malformed("openai-decisions", `duplicate option in ${id}`);
          probabilities[p.value] = p.probability;
        }
        const checked = z.object({ choice: choiceSchema(id), probabilities: probabilitiesSchema(id) }).safeParse({ choice: a.choice, probabilities });
        if (!checked.success) throw malformed("openai-decisions", `options of ${id}`);
        out[id] = normalise({ choice: a.choice, probabilities, confidence: a.confidence });
      }
      return { answers: out };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// none, factory, runner
// ---------------------------------------------------------------------------------------------

export const noneClassifier: RiskClassifier = {
  provider: "none",
  model: "none",
  async classify() {
    throw new ClassifierError("not_configured", "no classifier provider is configured");
  },
};

/** Production wiring (`deps.classifier`): the provider's adapter with its secret from the env. */
export function defaultClassifier(env: Env, provider: ClassifierProvider, fetchImpl: FetchLike = (url, init) => fetch(url, init)): RiskClassifier {
  switch (provider) {
    case "jev":
      return jevClassifier({ apiKey: env.JEV_API_KEY, fetch: fetchImpl });
    case "openai-decisions":
      return openAiDecisionsClassifier({ apiKey: env.OPENAI_API_KEY, model: env.COMMONFORGE_OPENAI_DECISIONS_MODEL || OPENAI_DECISIONS_MODEL, fetch: fetchImpl });
    default:
      return noneClassifier;
  }
}

const encoder = new TextEncoder();
/** Evidence keeps at most this many characters of a model name (`RiskEvidenceSchema`). */
const MODEL_MAX_CHARS = 128;
const clampModel = (m: string | null) => (m === null ? null : m.slice(0, MODEL_MAX_CHARS));

/** Evidence for a promotion whose provider is `none`: nothing was built, read or sent. */
export function notConfiguredEvidence(threshold: number): ClassifierEvidence {
  return { provider: "none", model: null, threshold, inputDigest: null, truncated: false, omittedFiles: 0, inputBytes: 0, latencyMs: null, answers: null, safeProbability: null, cleared: false, failed: null, error: "not_configured" };
}

/**
 * Asks `c` about `input.state` within `timeoutMs` and decides with `riskClears`. Never throws:
 * every failure (also a synchronous throw from `classify` or from hashing the state) is evidence
 * with `cleared: false` and an error code. Neither an `incomplete` input (P3-11: the classifier may
 * clear only a complete view of the change; `input_incomplete`, with the reasons) nor a `tooLarge`
 * one (`input_too_large`) is sent.
 */
export async function runClassifier(
  c: RiskClassifier,
  input: { state: string; truncated: boolean; omittedFiles?: number; bytes?: number; tooLarge?: boolean; incomplete?: RiskIncompleteReason[] },
  threshold: number,
  timeoutMs = CLASSIFIER_TIMEOUT_MS,
): Promise<ClassifierEvidence> {
  const base = {
    provider: c.provider,
    model: clampModel(c.model as string | null),
    threshold,
    inputDigest: null as string | null,
    truncated: input.truncated,
    omittedFiles: input.omittedFiles ?? 0,
    inputBytes: input.bytes ?? encoder.encode(input.state).length,
  };
  const failed = (error: ClassifierErrorCode, latencyMs: number | null): ClassifierEvidence => ({ ...base, latencyMs, answers: null, safeProbability: null, cleared: false, failed: null, error });
  const started = Date.now();
  let signal: AbortSignal | null = null;
  try {
    base.inputDigest = await sha256Hex(input.state);
    if (input.incomplete?.length) return { ...failed("input_incomplete", null), incomplete: [...new Set(input.incomplete)] };
    if (input.tooLarge) return failed("input_too_large", null);
    const s = AbortSignal.timeout(timeoutMs);
    signal = s;
    const timedOut = new Promise<never>((_, reject) => {
      if (s.aborted) reject(new ClassifierError("timeout", "timed out"));
      s.addEventListener("abort", () => reject(new ClassifierError("timeout", "timed out")), { once: true });
    });
    // handled even when `classify` throws before the race subscribes to it
    timedOut.catch(() => {});
    const r = await Promise.race([c.classify(input.state, s), timedOut]);
    const decision = riskClears(r.answers, threshold);
    return { ...base, model: clampModel(r.model ?? c.model), latencyMs: Date.now() - started, answers: r.answers, safeProbability: decision.safeProbability, cleared: decision.cleared, failed: decision.failed, error: null };
  } catch (e) {
    const code: ClassifierErrorCode = e instanceof ClassifierError ? e.code : signal?.aborted ? "timeout" : "http_error";
    return failed(code, Date.now() - started);
  }
}
