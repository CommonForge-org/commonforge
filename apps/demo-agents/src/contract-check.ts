/**
 * The `/quote` cross-resource contract (fixtures/README.md, plan §C.1 row 7), checked on a tree laid
 * out as sibling mounts: `api/src/pricing.ts` produces quotes, `requirements/contracts/quote.schema.json`
 * declares the contract and `website/src/json-schema.ts` is the website's validator. The same three
 * sample requests as `website/tests/quote-contract.test.ts` are priced and validated.
 *
 * It runs in a child `node` (native TypeScript type stripping) with a PATH-only environment and a
 * throwaway HOME, because it executes code an agent wrote. It is the *local* gate for rehearsal and
 * for the fake stack in tests; in a live run the trusted integration runner is the gate.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bareEnv, runProc, tail } from "./proc.js";

export interface ContractResult {
  contractId: "quote";
  result: "pass" | "fail";
  detail: string;
}

const SCRIPT = `
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [root] = process.argv.slice(1);
const { priceQuote } = await import(pathToFileURL(root + "/api/src/pricing.ts").href);
const { validate } = await import(pathToFileURL(root + "/website/src/json-schema.ts").href);
const schema = JSON.parse(readFileSync(root + "/requirements/contracts/quote.schema.json", "utf8"));
const samples = [
  { customer: "Solo", plan: "starter", seats: 1, pricingDate: "2026-10-01" },
  { customer: "Acme", plan: "team", seats: 12, pricingDate: "2026-10-01" },
  { customer: "Big Co", plan: "enterprise", seats: 300, pricingDate: "2026-10-01" },
];
const failures = [];
for (const s of samples) {
  const errors = validate(schema, priceQuote(s, "1.0.0"));
  for (const e of errors) failures.push(s.plan + "/" + s.seats + ": " + e.path + " " + e.message);
}
process.stdout.write(JSON.stringify({ failures }));
`;

export async function checkQuoteContract(root: string): Promise<ContractResult> {
  const home = await mkdtemp(join(tmpdir(), "cf-contract-"));
  try {
    const r = await runProc(process.execPath, ["--no-warnings", "--input-type=module", "-e", SCRIPT, root], { cwd: root, env: bareEnv({ HOME: home }), timeoutMs: 60_000 });
    if (r.code !== 0) return { contractId: "quote", result: "fail", detail: `contract check could not run: ${tail(r.stderr || r.stdout, 600)}` };
    const { failures } = JSON.parse(r.stdout) as { failures: string[] };
    return failures.length === 0
      ? { contractId: "quote", result: "pass", detail: "3 sample quotes match requirements/contracts/quote.schema.json" }
      : { contractId: "quote", result: "fail", detail: [...new Set(failures)].join("; ") };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
