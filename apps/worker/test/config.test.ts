/**
 * Review M-4: the queue names and retry budget the code dispatches on must match wrangler.jsonc
 * (the test entry hides the deployed `queue()` dispatch, so a drift would go unnoticed otherwise).
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error -- Vite `?raw` import (the file's text); TypeScript cannot type a relative `?raw` specifier
import wranglerRaw from "../wrangler.jsonc?raw";
import { STEPS_QUEUE } from "../src/app.js";
import { ARTIFACT_EVENTS_QUEUE } from "../src/services/artifact-events.js";
import { GC_SWEEP_INTERVAL_SECONDS } from "../src/services/gc.js";
import { OUTBOX_DLQ, OUTBOX_MAX_RETRIES, OUTBOX_QUEUE } from "../src/services/outbox-consumer.js";

const wranglerText = wranglerRaw as string;

/** JSONC → JSON: drop whole-line `//` comments (no value in the file contains a line comment). */
const config = JSON.parse(
  wranglerText
    .split("\n")
    .filter((l: string) => !/^\s*\/\//.test(l))
    .join("\n"),
) as {
  queues: { producers: Array<{ binding: string; queue: string }>; consumers: Array<{ queue: string; max_retries?: number; dead_letter_queue?: string; max_batch_size?: number }> };
  triggers: { crons: string[] };
};

describe("wrangler.jsonc matches the code", () => {
  it("queue consumers, DLQ, retries, producer and cron", () => {
    const consumers = new Map(config.queues.consumers.map((c) => [c.queue, c]));
    expect([...consumers.keys()].sort()).toEqual([ARTIFACT_EVENTS_QUEUE, OUTBOX_DLQ, OUTBOX_QUEUE, STEPS_QUEUE].sort());
    expect(consumers.get(OUTBOX_QUEUE)).toMatchObject({ max_retries: OUTBOX_MAX_RETRIES, dead_letter_queue: OUTBOX_DLQ });
    expect(consumers.get(OUTBOX_QUEUE)!.max_batch_size).toBeLessThanOrEqual(4);
    expect(config.queues.producers.find((p) => p.binding === "OUTBOX")?.queue).toBe(OUTBOX_QUEUE);
    expect(config.triggers.crons).toEqual([`*/${GC_SWEEP_INTERVAL_SECONDS / 60} * * * *`]);
  });
});
