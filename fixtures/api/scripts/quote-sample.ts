/**
 * Prints one priced quote as JSON: the producer side of the `/quote` contract the integration
 * runner checks (apps/demo-agents/README.md, "Live gate prerequisite"). The runner validates this
 * output against requirements/contracts/quote.schema.json, read from git, never from the checkout.
 *
 *   node scripts/quote-sample.ts      (Node's built-in TypeScript stripping; no install needed)
 *
 * Same input as the contract test's enterprise case, so a field added to priceQuote() (for example
 * `breakdown`) shows up here exactly as it does in GET /quote.
 */
import { priceQuote } from "../src/pricing.ts";

process.stdout.write(
  `${JSON.stringify(priceQuote({ customer: "Big Co", plan: "enterprise", seats: 300, pricingDate: "2026-10-01" }, "1.0.0"))}\n`,
);
