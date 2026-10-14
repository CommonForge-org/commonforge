/**
 * DRY-RUN agent: deterministic scripted edits that stand in for the agent CLI (for CI and
 * rehearsal). It makes the same edits the prompts ask for, so the downstream protocol (submit,
 * freeze, contract gate, conflict probe, events) is exercised for real; only the model is
 * replaced. Evidence from a dry run is labelled `mode: "dry-run"` and is never live throughput
 * evidence (PRD §14.4).
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BRAND_COLOR_NEW, BRAND_COLOR_OLD, CONFLICT_ANCHOR, type PhaseSpec } from "./prompts.js";
import { bareEnv, runProc, sleep, tail } from "./proc.js";
import type { AgentRun, AgentRunner } from "./agent-cli.js";

async function edit(root: string, path: string, fn: (text: string) => string): Promise<void> {
  const file = join(root, path);
  const before = await readFile(file, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`dry-run: edit of ${path} changed nothing (fixture drifted?)`);
  await writeFile(file, after);
}

function replaceOnce(text: string, find: string, replacement: string, what: string): string {
  const i = text.indexOf(find);
  if (i < 0) throw new Error(`dry-run: anchor for ${what} not found`);
  return text.slice(0, i) + replacement + text.slice(i + find.length);
}

/** Insert `block` directly below the anchor comment (which continues over following `//` lines). */
function belowAnchor(text: string, block: string): string {
  const i = text.indexOf(CONFLICT_ANCHOR);
  if (i < 0) throw new Error("dry-run: conflict anchor not found in quote-view.test.ts");
  let eol = text.indexOf("\n", i);
  while (/^\s*\/\//.test(text.slice(eol + 1, text.indexOf("\n", eol + 1)))) eol = text.indexOf("\n", eol + 1);
  return `${text.slice(0, eol + 1)}${block}${text.slice(eol + 1)}`;
}

const EDITS: Record<string, (root: string, spec: PhaseSpec) => Promise<void>> = {
  "agent-1:feature": async (root) => {
    await edit(root, "api/src/pricing.ts", (t) => {
      t = replaceOnce(t, "  total: number;\n  validUntil: string;", "  total: number;\n  breakdown: { gross: number; discount: number };\n  validUntil: string;", "Quote.breakdown");
      return replaceOnce(t, "    total,\n    validUntil:", "    total,\n    breakdown: { gross: roundCents(gross), discount: roundCents(gross - total) },\n    validUntil:", "priceQuote breakdown");
    });
    await edit(root, "api/tests/api.test.ts", (t) =>
      `${t.trimEnd()}\n\ndescribe("quote breakdown", () => {\n  it("splits 300 enterprise seats into gross and discount", () => {\n    const q = priceQuote({ customer: "Big Co", plan: "enterprise", seats: 300, pricingDate: "2026-10-01" }, "1.0.0");\n    expect(q.breakdown).toEqual({ gross: 17700, discount: 3540 });\n  });\n});\n`,
    );
    await edit(root, "website/src/quote.ts", (t) => replaceOnce(t, "  total: number;\n", "  total: number;\n  breakdown?: { gross: number; discount: number };\n", "website Quote.breakdown"));
    await edit(root, "website/src/quote-view.ts", (t) =>
      replaceOnce(
        t,
        '    `<dt>Total / month</dt><dd class="total">${formatMoney(quote.total, quote.currency)}</dd>`,\n',
        '    `<dt>Total / month</dt><dd class="total">${formatMoney(quote.total, quote.currency)}</dd>`,\n' +
          '    ...(quote.breakdown\n' +
          '      ? [\n' +
          '          `<dt>Before discount</dt><dd class="gross">${formatMoney(quote.breakdown.gross, quote.currency)}</dd>`,\n' +
          '          `<dt>Volume discount</dt><dd class="discount">-${formatMoney(quote.breakdown.discount, quote.currency)}</dd>`,\n' +
          "        ]\n" +
          "      : []),\n",
        "renderQuote total row",
      ),
    );
    await edit(root, "website/tests/quote-view.test.ts", (t) =>
      belowAnchor(
        t,
        '  it("shows the breakdown before and after the volume discount", () => {\n' +
          "    const html = renderQuote({ ...QUOTE, breakdown: { gross: 17700, discount: 3540 } });\n" +
          '    expect(html).toContain(\'<dd class="gross">$17,700.00</dd>\');\n' +
          '    expect(html).toContain(\'<dd class="discount">-$3,540.00</dd>\');\n' +
          "  });\n",
      ),
    );
  },
  "agent-1:fix-contract": async (root) => {
    await edit(root, "requirements/contracts/quote.schema.json", (t) => {
      const schema = JSON.parse(t) as { properties: Record<string, unknown> };
      const props: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(schema.properties)) {
        props[k] = v;
        if (k === "total") {
          props.breakdown = {
            type: "object",
            additionalProperties: false,
            required: ["gross", "discount"],
            properties: { gross: { type: "number", minimum: 0 }, discount: { type: "number", minimum: 0 } },
          };
        }
      }
      return `${JSON.stringify({ ...schema, properties: props }, null, 2)}\n`;
    });
    await edit(root, "requirements/requirements.md", (t) =>
      replaceOnce(t, "- R1.4 Volume discount: 10% off the total from 50 seats, 20% off from 250 seats.\n", "- R1.4 Volume discount: 10% off the total from 50 seats, 20% off from 250 seats.\n- R1.5 The quote shows a breakdown: the amount before discount and the volume\n  discount (`breakdown.gross`, `breakdown.discount`).\n", "R1.4"),
    );
  },
  "agent-2:client-edit": async (root) => {
    await edit(root, "website/src/quote-view.ts", (t) =>
      replaceOnce(t, '    "</dl>",\n', '    "</dl>",\n    `<p class="quote-note">Prices are per month and exclude taxes. Cancel anytime.</p>`,\n', "renderQuote </dl>"),
    );
    await edit(root, "website/src/styles.css", (t) => `${t.trimEnd()}\n.quote-note { margin: 12px 0 0; color: var(--muted); font-size: 0.9rem; }\n`);
    await edit(root, "website/tests/quote-view.test.ts", (t) =>
      belowAnchor(t, '  it("tells the customer what the price covers", () => {\n    expect(renderQuote(QUOTE)).toContain(\'<p class="quote-note">\');\n  });\n'),
    );
  },
  "agent-3:brand": async (root, spec) => {
    const r = await runProc("sh", ["-c", spec.allowedCommand!], { cwd: root, env: bareEnv(), timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`dry-run: logo generator failed: ${tail(r.stderr)}`);
    await edit(root, "website/src/styles.css", (t) => t.replaceAll(BRAND_COLOR_OLD, BRAND_COLOR_NEW));
    await edit(root, "requirements/requirements.md", (t) => t.replace(/- R4\.2 .*\n/, `- R4.2 The brand colour is violet (\`${BRAND_COLOR_NEW}\`) on a light background.\n`));
  },
};

/** The scripted agent. `workMs` models think time so overlapping sessions overlap measurably. */
export function dryRunAgent(workMs = 0): AgentRunner {
  return async (spec, root): Promise<AgentRun> => {
    const started = Date.now();
    const fn = EDITS[`${spec.agentId}:${spec.phase}`];
    if (!fn) throw new Error(`dry-run: no scripted edit for ${spec.agentId}:${spec.phase}`);
    if (workMs > 0) await sleep(workMs);
    await fn(root, spec);
    return { cli: "dry-run", command: ["dry-run", `${spec.agentId}:${spec.phase}`], exitCode: 0, durationMs: Date.now() - started, summary: `scripted edits for ${spec.agentId}:${spec.phase}` };
  };
}
