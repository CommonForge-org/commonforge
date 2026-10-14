/**
 * The fixed prompts of the three demo agents (PRD §14.4, plan §C.1 rows 5–9, fixtures/README.md
 * "Work the Task 19 demo agents do"). They are deliberately explicit: the demo depends on
 * *where* the agents edit (the shared anchor in `website/tests/quote-view.test.ts` for the AT-07
 * textual conflict, the strict `/quote` contract for the row-7 failure, both logo copies).
 */

/** Anchor both website agents insert their view test under (fixtures/README.md). */
export const CONFLICT_ANCHOR = "// Quote view cases end here.";
export const BRAND_COLOR_OLD = "#0f766e";
export const BRAND_COLOR_NEW = "#7c3aed";

export type AgentId = "agent-1" | "agent-2" | "agent-3";

export interface PhaseSpec {
  agentId: AgentId;
  phase: string;
  prompt: string;
  /** mounts the agent may edit in this phase (the harness submits exactly these) */
  writable: string[];
  /** the single shell command the agent may run, if any: matched exactly, no wildcard */
  allowedCommand?: string;
}

function preamble(writable: string[], readOnly: string[]): string {
  return [
    "You are a coding agent working in a CommonForge task workspace. Your current working directory is the workspace root.",
    `Writable mounts in this step: ${writable.map((m) => `${m}/`).join(", ")}.`,
    readOnly.length ? `Read-only mounts (look, do not edit): ${readOnly.map((m) => `${m}/`).join(", ")}.` : "There are no other mounts.",
    "",
    "Rules:",
    "- Edit files only inside the writable mounts above. Never edit `.commonforge/` or anything inside a `.git/` directory.",
    "- Do not run git, do not commit or push, do not install packages and do not use the network. The harness commits and submits your work with `cforge submit` when you finish.",
    "- Keep the change small and focused. Match the existing style: TypeScript ESM, 2-space indent, double quotes, `.js` import suffixes.",
    "- When you are done, reply with a short summary of the files you changed.",
    "",
  ].join("\n");
}

/** Agent 1, step 1: the developer agent spans api + website (one Change, several candidates). */
export function agent1FeaturePrompt(): PhaseSpec {
  const writable = ["api", "website"];
  return {
    agentId: "agent-1",
    phase: "feature",
    writable,
    prompt: `${preamble(writable, ["requirements", "brand-assets"])}Task: add a price breakdown to the Customer Portal quote, end to end across the api and the website.

1. api/src/pricing.ts: add \`breakdown: { gross: number; discount: number }\` to the \`Quote\` interface and fill it in \`priceQuote\`. \`gross\` is unitPrice × seats before the volume discount; \`discount\` is gross − total. Round both to cents like \`total\`.
2. api/tests/api.test.ts: add one test asserting that 300 enterprise seats give \`breakdown: { gross: 17700, discount: 3540 }\`.
3. website/src/quote.ts: add the optional field \`breakdown?: { gross: number; discount: number }\` to the website's \`Quote\` interface.
4. website/src/quote-view.ts: in \`renderQuote\`, when \`quote.breakdown\` is present, render two more rows directly after the total row: \`<dt>Before discount</dt><dd class="gross">…</dd>\` and \`<dt>Volume discount</dt><dd class="discount">-…</dd>\`, formatting both amounts with \`formatMoney\`.
5. website/tests/quote-view.test.ts: add exactly one new \`it(...)\` case for the breakdown rows. Put it directly below the anchor comment \`${CONFLICT_ANCHOR}\` inside the \`renderQuote\` describe block. Keep the anchor comment unchanged.

Do not edit requirements/ in this step: the contract there is owned and reviewed separately. Do not edit website/tests/quote-contract.test.ts.`,
  };
}

/** Agent 1, step 2: after trusted integration rejected the change, repair the contract. */
export function agent1FixPrompt(failure: string): PhaseSpec {
  const writable = ["requirements"];
  return {
    agentId: "agent-1",
    phase: "fix-contract",
    writable,
    prompt: `${preamble(writable, ["api", "website", "brand-assets"])}The trusted integration run of your previous step failed the cross-resource \`/quote\` contract check:

${failure}

The api now returns \`breakdown\`, but requirements/contracts/quote.schema.json is strict (\`additionalProperties: false\`) and does not declare it. Fix the contract, not the api. api/ and website/ are already submitted: do not change them.

1. requirements/contracts/quote.schema.json: add a \`breakdown\` property: \`{ "type": "object", "additionalProperties": false, "required": ["gross", "discount"], "properties": { "gross": { "type": "number", "minimum": 0 }, "discount": { "type": "number", "minimum": 0 } } }\`. Keep \`breakdown\` optional: do not add it to the top-level \`required\` list. Use only these JSON Schema keywords: type, enum, const, required, properties, additionalProperties, items, minimum, maximum, minLength, maxLength, pattern (the website's validator rejects any other keyword).
2. requirements/requirements.md: add a requirement R1.5 under "R1. Instant quote" saying that the quote shows a breakdown of the amount before discount and the volume discount.`,
  };
}

/** Agent 2: the client-edition agent (website only; never the api source or requirements). */
export function agent2ClientPrompt(): PhaseSpec {
  const writable = ["website"];
  return {
    agentId: "agent-2",
    phase: "client-edit",
    writable,
    prompt: `${preamble(writable, [])}You are improving the quote interface of the Customer Portal on behalf of the client. You work in a client edition: only the website is available; the api and the requirements are not part of it.

Task: tell the customer what the quoted price covers.
1. website/src/quote-view.ts: in \`renderQuote\`, add one paragraph right after the closing \`</dl>\` and before \`</article>\`: \`<p class="quote-note">Prices are per month and exclude taxes. Cancel anytime.</p>\`.
2. website/src/styles.css: add one rule at the end of the file: \`.quote-note { margin: 12px 0 0; color: var(--muted); font-size: 0.9rem; }\`.
3. website/tests/quote-view.test.ts: add exactly one new \`it(...)\` case asserting that \`renderQuote(QUOTE)\` contains the note. Put it directly below the anchor comment \`${CONFLICT_ANCHOR}\` inside the \`renderQuote\` describe block. Keep the anchor comment unchanged.

Do not edit package.json, vite.config.ts, tsconfig.json, wrangler.jsonc or tests/quote-contract.test.ts (they are write-protected in the edition).`,
  };
}

/** Agent 3: brand + requirements text; the logo changes in Git (website) and in R2 (brand-assets). */
export function agent3BrandPrompt(logoTool: string): PhaseSpec {
  const writable = ["website", "requirements"];
  const command = `${logoTool} --color=${BRAND_COLOR_NEW}`;
  return {
    agentId: "agent-3",
    phase: "brand",
    writable,
    allowedCommand: command,
    prompt: `${preamble(writable, ["brand-assets"])}Task: change the Demo Client brand colour from teal (\`${BRAND_COLOR_OLD}\`) to violet (\`${BRAND_COLOR_NEW}\`).

1. Regenerate the website's logo by running exactly this command from the workspace root. It is the only command you may run, and it always writes website/public/logo.png; do not edit the PNG any other way:
   ${command}
   brand-assets/ holds the R2 copy of the logo as checked out (read-only here); the harness uploads the regenerated file to it through the task's asset workspace, so both copies of the logo change together.
2. website/src/styles.css: replace the brand colour \`${BRAND_COLOR_OLD}\` with \`${BRAND_COLOR_NEW}\`.
3. requirements/requirements.md: change R4.2 so it says the brand colour is violet (\`${BRAND_COLOR_NEW}\`) on a light background.

Edit nothing else.`,
  };
}
