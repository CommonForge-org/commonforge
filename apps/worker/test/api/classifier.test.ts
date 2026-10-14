/**
 * Staging phase 3, Task 2: the risk classifier port. Both real adapters (Jev through TypeSafe's API,
 * OpenAI Decisions) translate wire formats into `RiskAnswers`, parse strictly, and every failure
 * (missing key, HTTP error, refusal, malformed answer, timeout) becomes evidence with
 * `cleared: false` and an error code; `runClassifier` never throws.
 */
import { RISK_QUESTION_IDS, RISK_QUESTIONS, RiskEvidenceSchema, sha256Hex, type RiskQuestionId } from "@commonforge-org/core";
import { describe, expect, it } from "vitest";
import {
  ClassifierError,
  defaultClassifier,
  jevClassifier,
  noneClassifier,
  openAiDecisionsClassifier,
  runClassifier,
  type FetchLike,
} from "../../src/services/classifier.js";
import { FakeClassifier, SAFE_ANSWERS } from "../fakes/classifier.js";
import { harness } from "../helpers.js";

const KEY = "sk-test-secret-key-0123456789"; // gitleaks:allow (fake test key)
const STATE = "## Tasks\n### Change the headline\nMake it friendlier\n";
const INPUT = { state: STATE, truncated: false };

/** Safe option probabilities per question: the first safe option gets `p`, the rest share 1 - p. */
function probs(id: RiskQuestionId, p = 0.95): Record<string, number> {
  const q = RISK_QUESTIONS[id];
  const safe = q.safe[0] as string;
  const others = (q.options as readonly string[]).filter((o) => o !== safe);
  return Object.fromEntries([[safe, p], ...others.map((o) => [o, (1 - p) / others.length])]);
}

interface Recorded {
  url: string;
  init: RequestInit;
}

/** A recorded transport: answers with `respond(body)` and records every request. */
function transport(respond: (body: any) => Response | Promise<Response>): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return respond(JSON.parse(String(init?.body ?? "{}")));
    },
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const never: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  });

function jevResponse(over: Partial<Record<RiskQuestionId, unknown>> = {}, drop: RiskQuestionId[] = []) {
  const answers: Record<string, unknown> = {};
  for (const id of RISK_QUESTION_IDS) {
    if (drop.includes(id)) continue;
    const p = probs(id);
    answers[id] = over[id] ?? { type: "choice", choice: RISK_QUESTIONS[id].safe[0], confidence: 0.78, probabilities: p };
  }
  return { model: "jev-1.13.0", answers, usage: { input_tokens: 100, output_tokens: 0 } };
}

function openAiResponse(over: Partial<Record<RiskQuestionId, unknown>> = {}, drop: RiskQuestionId[] = []) {
  const answers: unknown[] = [];
  for (const id of RISK_QUESTION_IDS) {
    if (drop.includes(id)) continue;
    const p = probs(id);
    answers.push(over[id] ?? { type: "choice", name: id, choice: RISK_QUESTIONS[id].safe[0], confidence: 0.8, probabilities: Object.entries(p).map(([value, probability]) => ({ value, probability })) });
  }
  return { answers };
}

describe("Jev adapter (TypeSafe API)", () => {
  it("sends the five choice questions with the state and the key in the header, and normalises the answers", async () => {
    const t = transport(() => json(jevResponse()));
    const ev = await runClassifier(jevClassifier({ apiKey: KEY, fetch: t.fetch }), INPUT, 0.9);
    expect(ev.error).toBeNull();
    expect(ev.cleared).toBe(true);
    expect(ev.failed).toBeNull();
    expect(ev.provider).toBe("jev");
    expect(ev.model).toBe("jev-1.13.0");
    expect(ev.answers?.risk).toEqual({ choice: "low", probabilities: probs("risk"), confidence: 0.78 });
    expect(ev.safeProbability?.migration).toBeCloseTo(0.975);
    expect(() => RiskEvidenceSchema.parse(ev)).not.toThrow();

    expect(t.calls).toHaveLength(1);
    const { url, init } = t.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("jev-latest");
    expect(body.state).toBe(STATE);
    expect(Object.keys(body.questions)).toEqual(RISK_QUESTION_IDS);
    expect(body.questions.migration.type).toBe("choice");
    expect(Object.keys(body.questions.migration.criteria)).toEqual(["none", "additive", "destructive"]);
    expect(body.questions.risk.instructions).toContain(RISK_QUESTIONS.risk.question);
    // the change content goes only in the state; the key never in the body
    expect(String(init.body)).not.toContain(KEY);
    expect(JSON.stringify(body.questions)).not.toContain("Change the headline");
  });

  it("accepts a null model and null confidences (evidence keeps no confidence)", async () => {
    const body = jevResponse();
    (body as any).model = null;
    for (const a of Object.values(body.answers) as any[]) a.confidence = null;
    const ev = await runClassifier(jevClassifier({ apiKey: KEY, fetch: transport(() => json(body)).fetch }), INPUT, 0.9);
    expect(ev).toMatchObject({ cleared: true, error: null, model: "jev-latest" });
    expect(ev.answers!.risk).not.toHaveProperty("confidence");
  });

  it("accepts a probability a rounding step above 1 as 1, and refuses one clearly above", async () => {
    const ok = jevResponse({ authOrPayments: { type: "choice", choice: "no", probabilities: { yes: 0, no: 1.0000004 } } });
    const ev = await runClassifier(jevClassifier({ apiKey: KEY, fetch: transport(() => json(ok)).fetch }), INPUT, 0.9);
    expect(ev).toMatchObject({ cleared: true, error: null });
    expect(ev.answers!.authOrPayments.probabilities.no).toBe(1);
    const bad = jevResponse({ authOrPayments: { type: "choice", choice: "no", probabilities: { yes: 0, no: 1.001 } } });
    expect((await runClassifier(jevClassifier({ apiKey: KEY, fetch: transport(() => json(bad)).fetch }), INPUT, 0.9)).error).toBe("malformed");
  });

  it("falls back to jev-latest when the response has no model", async () => {
    const { model: _m, ...rest } = jevResponse();
    const ev = await runClassifier(jevClassifier({ apiKey: KEY, fetch: transport(() => json(rest)).fetch }), INPUT, 0.9);
    expect(ev.error).toBeNull();
    expect(ev.model).toBe("jev-latest");
  });

  it("does not clear when an answer is confident but unsafe (no error)", async () => {
    const ev = await runClassifier(jevClassifier({ apiKey: KEY, fetch: transport(() => json(jevResponse({ risk: { type: "choice", choice: "medium", confidence: 0.7, probabilities: { low: 0.2, medium: 0.7, high: 0.1 } } }))).fetch }), INPUT, 0.9);
    expect(ev.error).toBeNull();
    expect(ev.cleared).toBe(false);
    expect(ev.failed).toBe("risk");
    expect(ev.answers?.risk.choice).toBe("medium");
  });

  const malformed: Array<[string, unknown]> = [
    ["a missing question", jevResponse({}, ["addressedToReviewer"])],
    ["a wrong option name", jevResponse({ migration: { type: "choice", choice: "none", probabilities: { none: 0.9, additive: 0.05, drop: 0.05 } } })],
    ["a missing option", jevResponse({ risk: { type: "choice", choice: "low", probabilities: { low: 0.95, medium: 0.05 } } })],
    ["a choice that is not an option", jevResponse({ risk: { type: "choice", choice: "tiny", probabilities: probs("risk") } })],
    ["a probability that is not a number", jevResponse({ risk: { type: "choice", choice: "low", probabilities: { low: "0.9", medium: 0.05, high: 0.05 } } })],
    ["a probability above 1", jevResponse({ risk: { type: "choice", choice: "low", probabilities: { low: 1.5, medium: 0, high: 0 } } })],
    ["an unknown question", { ...jevResponse(), answers: { ...jevResponse().answers, extra: { type: "choice", choice: "yes", probabilities: { yes: 1 } } } }],
    ["no answers", { model: "jev-1.13.0" }],
    ["a non-JSON body", "not json"],
  ];
  for (const [what, body] of malformed) {
    it(`fails closed as malformed on ${what}`, async () => {
      const t = transport(() => (typeof body === "string" ? new Response(body, { status: 200 }) : json(body)));
      const ev = await runClassifier(jevClassifier({ apiKey: KEY, fetch: t.fetch }), INPUT, 0.9);
      expect(ev.cleared).toBe(false);
      expect(ev.error).toBe("malformed");
      expect(ev.answers).toBeNull();
    });
  }

  it("treats a non-choice answer as refused", async () => {
    const ev = await runClassifier(jevClassifier({ apiKey: KEY, fetch: transport(() => json(jevResponse({ risk: { type: "refusal", refusal: "no" } }))).fetch }), INPUT, 0.9);
    expect(ev.cleared).toBe(false);
    expect(ev.error).toBe("refused");
  });

  for (const status of [401, 500]) {
    it(`fails closed as http_error on ${status} without keeping the body or the key`, async () => {
      const t = transport(() => new Response(`upstream says: bad key ${KEY}`, { status }));
      const ev = await runClassifier(jevClassifier({ apiKey: KEY, fetch: t.fetch }), INPUT, 0.9);
      expect(ev.cleared).toBe(false);
      expect(ev.error).toBe("http_error");
      expect(JSON.stringify(ev)).not.toContain(KEY);
      expect(JSON.stringify(ev)).not.toContain("upstream says");
    });
  }

  it("fails closed as http_error when the transport throws (no response)", async () => {
    const ev = await runClassifier(jevClassifier({ apiKey: KEY, fetch: async () => { throw new TypeError(`network down ${KEY}`); } }), INPUT, 0.9);
    expect(ev.error).toBe("http_error");
    expect(JSON.stringify(ev)).not.toContain(KEY);
  });

  it("fails closed as timeout when the response never comes", async () => {
    const ev = await runClassifier(jevClassifier({ apiKey: KEY, fetch: never }), INPUT, 0.9, 20);
    expect(ev.cleared).toBe(false);
    expect(ev.error).toBe("timeout");
  });

  it("fails closed as not_configured without a key, and never calls out", async () => {
    const t = transport(() => json(jevResponse()));
    const ev = await runClassifier(jevClassifier({ apiKey: undefined, fetch: t.fetch }), INPUT, 0.9);
    expect(ev.error).toBe("not_configured");
    expect(ev.cleared).toBe(false);
    expect(t.calls).toHaveLength(0);
  });
});

describe("OpenAI Decisions adapter", () => {
  it("sends the questions as a list with the key only in the header, and normalises the answers", async () => {
    const t = transport(() => json(openAiResponse()));
    const ev = await runClassifier(openAiDecisionsClassifier({ apiKey: KEY, model: "gpt-6-luna", fetch: t.fetch }), INPUT, 0.9);
    expect(ev.error).toBeNull();
    expect(ev.cleared).toBe(true);
    expect(ev.provider).toBe("openai-decisions");
    expect(ev.model).toBe("gpt-6-luna");
    expect(ev.answers?.apiChange).toEqual({ choice: "none", probabilities: probs("apiChange"), confidence: 0.8 });

    const { url, init } = t.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/decisions");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(String(init.body)).not.toContain(KEY);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-6-luna");
    expect(body.input).toBe(STATE);
    expect(body.questions.map((q: any) => q.name)).toEqual(RISK_QUESTION_IDS);
    expect(body.questions[0]).toMatchObject({ type: "choice", name: "risk" });
    expect(body.questions[0].choices.map((c: any) => c.value)).toEqual(["low", "medium", "high"]);
    expect(body.questions[0].choices[0].description).toBe(RISK_QUESTIONS.risk.descriptions.low);
    expect(JSON.stringify(body.questions)).not.toContain("Change the headline");
  });

  it("accepts null confidences and a probability a rounding step above 1", async () => {
    const body = openAiResponse({ risk: { type: "choice", name: "risk", choice: "low", confidence: null, probabilities: [{ value: "low", probability: 1.0000005 }, { value: "medium", probability: 0 }, { value: "high", probability: 0 }] } });
    const ev = await runClassifier(openAiDecisionsClassifier({ apiKey: KEY, model: "gpt-6-luna", fetch: transport(() => json(body)).fetch }), INPUT, 0.9);
    expect(ev).toMatchObject({ cleared: true, error: null });
    expect(ev.answers!.risk).toEqual({ choice: "low", probabilities: { low: 1, medium: 0, high: 0 } });
  });

  it("uses the model from the env, defaulting to gpt-6-luna", async () => {
    const t = transport(() => json(openAiResponse()));
    const c1 = defaultClassifier({ OPENAI_API_KEY: KEY } as any, "openai-decisions", t.fetch);
    expect(c1.model).toBe("gpt-6-luna");
    const c2 = defaultClassifier({ OPENAI_API_KEY: KEY, COMMONFORGE_OPENAI_DECISIONS_MODEL: "gpt-6-luna-mini" } as any, "openai-decisions", t.fetch);
    await runClassifier(c2, INPUT, 0.9);
    expect(JSON.parse(String(t.calls[0]!.init.body)).model).toBe("gpt-6-luna-mini");
  });

  it("treats a refusal as refused", async () => {
    const ev = await runClassifier(openAiDecisionsClassifier({ apiKey: KEY, model: "gpt-6-luna", fetch: transport(() => json(openAiResponse({ authOrPayments: { type: "refusal", name: "authOrPayments", refusal: "I can't help" } }))).fetch }), INPUT, 0.9);
    expect(ev.cleared).toBe(false);
    expect(ev.error).toBe("refused");
    expect(JSON.stringify(ev)).not.toContain("I can't help");
  });

  const malformed: Array<[string, unknown]> = [
    ["a missing question", openAiResponse({}, ["migration"])],
    ["a duplicated question", { answers: [...openAiResponse().answers, openAiResponse().answers[0]] }],
    ["a wrong option name", openAiResponse({ authOrPayments: { type: "choice", name: "authOrPayments", choice: "no", probabilities: [{ value: "no", probability: 0.9 }, { value: "maybe", probability: 0.1 }] } })],
    ["a duplicated option", openAiResponse({ authOrPayments: { type: "choice", name: "authOrPayments", choice: "no", probabilities: [{ value: "no", probability: 0.5 }, { value: "no", probability: 0.5 }] } })],
    ["an unknown answer type", openAiResponse({ risk: { type: "score", name: "risk", score: 0.1 } })],
    ["no answers array", { answers: {} }],
  ];
  for (const [what, body] of malformed) {
    it(`fails closed as malformed on ${what}`, async () => {
      const ev = await runClassifier(openAiDecisionsClassifier({ apiKey: KEY, model: "gpt-6-luna", fetch: transport(() => json(body)).fetch }), INPUT, 0.9);
      expect(ev.cleared).toBe(false);
      expect(ev.error).toBe("malformed");
    });
  }

  for (const status of [401, 429, 500]) {
    it(`fails closed as http_error on ${status}`, async () => {
      const ev = await runClassifier(openAiDecisionsClassifier({ apiKey: KEY, model: "gpt-6-luna", fetch: transport(() => json({ error: { message: `Incorrect API key ${KEY}` } }, status)).fetch }), INPUT, 0.9);
      expect(ev.error).toBe("http_error");
      expect(JSON.stringify(ev)).not.toContain(KEY);
    });
  }

  it("fails closed as timeout when the response never comes", async () => {
    const ev = await runClassifier(openAiDecisionsClassifier({ apiKey: KEY, model: "gpt-6-luna", fetch: never }), INPUT, 0.9, 20);
    expect(ev.error).toBe("timeout");
    expect(ev.cleared).toBe(false);
  });

  it("fails closed as not_configured without a key", async () => {
    const t = transport(() => json(openAiResponse()));
    const ev = await runClassifier(defaultClassifier({} as any, "openai-decisions", t.fetch), INPUT, 0.9);
    expect(ev.error).toBe("not_configured");
    expect(t.calls).toHaveLength(0);
  });
});

describe("runClassifier", () => {
  it("records the sha256 of the exact state, the truncation flags, the threshold and the latency", async () => {
    const ev = await runClassifier(new FakeClassifier().forProvider("jev"), { state: STATE, truncated: true, omittedFiles: 2, bytes: 1234 }, 0.85);
    expect(ev.inputDigest).toBe(await sha256Hex(STATE));
    expect(ev.truncated).toBe(true);
    expect(ev.omittedFiles).toBe(2);
    expect(ev.inputBytes).toBe(1234);
    expect(ev.threshold).toBe(0.85);
    expect(ev.latencyMs).toBeGreaterThanOrEqual(0);
    expect(ev.cleared).toBe(true);
    expect(() => RiskEvidenceSchema.parse(ev)).not.toThrow();
  });

  it("computes inputBytes from the state when not given", async () => {
    const ev = await runClassifier(new FakeClassifier().forProvider("jev"), { state: "é", truncated: false }, 0.9);
    expect(ev.inputBytes).toBe(2);
    expect(ev.omittedFiles).toBe(0);
  });

  it("none → not_configured", async () => {
    const ev = await runClassifier(noneClassifier, INPUT, 0.9);
    expect(ev).toMatchObject({ provider: "none", cleared: false, error: "not_configured", answers: null });
    expect(defaultClassifier({} as any, "none").provider).toBe("none");
  });

  it("an input that is too large is not sent", async () => {
    const fake = new FakeClassifier();
    const ev = await runClassifier(fake.forProvider("jev"), { ...INPUT, tooLarge: true }, 0.9);
    expect(ev.error).toBe("input_too_large");
    expect(ev.cleared).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it("an incomplete input is not sent (P3-11): input_incomplete with its reasons and the digest, also when it is too large too", async () => {
    const fake = new FakeClassifier();
    const ev = await runClassifier(fake.forProvider("jev"), { ...INPUT, incomplete: ["diff_truncated", "file_not_read"], tooLarge: true }, 0.9);
    expect(ev).toMatchObject({ error: "input_incomplete", incomplete: ["diff_truncated", "file_not_read"], cleared: false, answers: null, inputDigest: await sha256Hex(STATE) });
    expect(RiskEvidenceSchema.safeParse(ev).success).toBe(true);
    expect(fake.calls).toHaveLength(0);
    // a complete input carries no `incomplete` field
    expect("incomplete" in (await runClassifier(fake.forProvider("jev"), { ...INPUT, incomplete: [] }, 0.9))).toBe(false);
  });

  it("never throws, whatever the classifier throws", async () => {
    const boom = { provider: "jev" as const, model: "x", classify: async () => { throw new Error("unexpected"); } };
    const ev = await runClassifier(boom, INPUT, 0.9);
    expect(ev.cleared).toBe(false);
    expect(ev.error).toBe("http_error");
    const coded = { provider: "jev" as const, model: "x", classify: async () => { throw new ClassifierError("refused", "nope"); } };
    expect((await runClassifier(coded, INPUT, 0.9)).error).toBe("refused");
  });

  it("never throws when a non-async classify throws synchronously", async () => {
    const sync = {
      provider: "jev" as const,
      model: "x",
      classify: (): Promise<never> => {
        throw new ClassifierError("refused", "sync");
      },
    };
    const ev = await runClassifier(sync, INPUT, 0.9, 20);
    expect(ev).toMatchObject({ cleared: false, error: "refused" });
    const plain = { provider: "jev" as const, model: "x", classify: (): Promise<never> => { throw new Error("sync"); } };
    expect((await runClassifier(plain, INPUT, 0.9, 20)).error).toBe("http_error");
    // the timeout still fires later without an unhandled rejection
    await new Promise((r) => setTimeout(r, 40));
  });

  it("times out when a 200 response's body never finishes", async () => {
    const stalled: FetchLike = async () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-type": "application/json" } });
    const started = Date.now();
    const ev = await runClassifier(jevClassifier({ apiKey: KEY, fetch: stalled }), INPUT, 0.9, 30);
    expect(ev).toMatchObject({ cleared: false, error: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("clamps a model name longer than evidence keeps", async () => {
    const fake = new FakeClassifier();
    fake.model = "m".repeat(300);
    const ev = await runClassifier(fake.forProvider("jev"), INPUT, 0.9);
    expect(ev.model).toBe("m".repeat(128));
    expect(() => RiskEvidenceSchema.parse(ev)).not.toThrow();
    fake.script.push({ answers: SAFE_ANSWERS, model: "n".repeat(200) });
    expect((await runClassifier(fake.forProvider("jev"), INPUT, 0.9)).model).toBe("n".repeat(128));
  });

  it("an invalid threshold never clears", async () => {
    for (const t of [0, -1, 1.5, Number.NaN]) expect((await runClassifier(new FakeClassifier().forProvider("jev"), INPUT, t)).cleared).toBe(false);
  });
});

describe("FakeClassifier", () => {
  it("answers safely by default, follows its script and records every input", async () => {
    const fake = new FakeClassifier();
    fake.script.push({ error: "http_error" }, { answers: { ...SAFE_ANSWERS, risk: { choice: "high", probabilities: { low: 0, medium: 0, high: 1 } } } }, "hang");
    const c = fake.forProvider("openai-decisions");
    expect((await runClassifier(c, INPUT, 0.9)).error).toBe("http_error");
    const declined = await runClassifier(c, INPUT, 0.9);
    expect(declined).toMatchObject({ cleared: false, failed: "risk", error: null });
    expect((await runClassifier(c, INPUT, 0.9, 20)).error).toBe("timeout");
    expect((await runClassifier(c, INPUT, 0.9)).cleared).toBe(true);
    expect(fake.calls).toEqual(Array.from({ length: 4 }, () => ({ provider: "openai-decisions", state: STATE })));
  });

  it("is the harness default, reached through deps.classifier", async () => {
    const h = harness();
    const c = h.deps.classifier(h.env() as any, "jev");
    expect(c.provider).toBe("jev");
    await runClassifier(c, INPUT, 0.9);
    expect(h.classifier.calls).toEqual([{ provider: "jev", state: STATE }]);
  });
});
