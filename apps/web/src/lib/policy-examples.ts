/**
 * Settings → Policy: a short help text and a valid example for each section that is still edited
 * as JSON (Contracts, Preview, Release, Staging). The examples are built from the project's own
 * folders and the organization's Worker name prefix (`GET …/deploy-resources` `workerPrefix`), so
 * they pass `POST …/policy/validate` as they are: apps/worker/test/api/policy-examples.test.ts
 * checks exactly that against the Worker's schemas. No imports: that test loads this file too.
 */

export type JsonSection = "contracts" | "preview" | "release" | "staging";

export interface ExampleFolder {
  mountName: string;
  resourceId: string;
  provider: string;
}

export interface PolicyExampleInput {
  /** `<prefix>-<orgId>-`: every release Worker of the organization is named with it */
  workerPrefix: string;
  folders: readonly ExampleFolder[];
  /** the saved release's target ids: the Staging example configures the first (default: the Release example's `site`) */
  releaseTargets?: readonly string[];
}

/** What each JSON section is for, in one or two plain sentences. */
export const SECTION_HELP: Record<JsonSection, string> = {
  release:
    "How production is built and which Cloudflare Workers it runs on. Commands run in the runner (pnpm, npm, npx or node only). Worker names must start with the organization's prefix, and the health-check Worker must answer GET /version with JSON whose release field is its COMMONFORGE_RELEASE_ID var. Production KV and D1 databases are created through the API (POST …/deploy-resources), not here.",
  staging:
    "Turns on always-on staging (it needs a Release section): every release target is also deployed as <workerName>-staging with its own demo data, and clients ask for changes as tasks. Staging starts after the first production publish. Promotion rules decide which changed paths a client may send to production without a developer (unmatched paths need a developer).",
  preview: "Private preview links for a change before it is accepted, built with this recipe. Not used in staging mode: staging replaces previews.",
  contracts: "Checks that one folder's output still matches a JSON Schema another folder owns, on every change. The command's output (in the producer folder) is validated against the schema file.",
};

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function gitFolders(folders: readonly ExampleFolder[]): ExampleFolder[] {
  return folders.filter((f) => f.provider === "artifacts");
}

/** The target ids of a saved `release` section (none when it is absent or malformed). */
export function releaseTargetIds(release: unknown): string[] {
  const targets = (release as { targets?: unknown } | undefined)?.targets;
  return Array.isArray(targets) ? targets.map((t) => (t as { targetId?: unknown })?.targetId).filter((x): x is string => typeof x === "string") : [];
}

/** One valid example per JSON section, as the editor's text. */
export function policyExamples({ workerPrefix, folders, releaseTargets = [] }: PolicyExampleInput): Record<JsonSection, string> {
  const git = gitFolders(folders);
  const site = git[0] ?? { mountName: "website", resourceId: "res-website", provider: "artifacts" };
  const other = git[1] ?? site;
  const recipe = (recipeId: string) => ({ recipeId, revision: 1, steps: [{ stepId: "build", mountName: site.mountName, command: "pnpm run build" }] });
  return {
    release: pretty({
      recipe: recipe("production"),
      targets: [{ targetId: "site", kind: "worker", mountName: site.mountName, outputPath: "dist", main: "index.js", workerName: `${workerPrefix}site` }],
      environment: { site: { vars: { APP_ENV: "production" } } },
      healthCheck: { targetId: "site", path: "/version" },
    }),
    staging: pretty({
      // keyed by a release target: the saved release's first, else the Release example's
      environment: { [releaseTargets[0] ?? "site"]: { vars: { APP_ENV: "staging" } } },
      promotion: {
        rules: [{ paths: [`${site.mountName}/content/**`], level: "self" }],
        classifier: { provider: "none", threshold: 0.9 },
      },
    }),
    preview: pretty({
      recipe: { ...recipe("preview"), output: { mountName: site.mountName, path: "dist" } },
      ttlSeconds: 86_400,
    }),
    contracts: pretty([
      {
        contractId: "api-response",
        version: "1",
        producerResource: other.resourceId,
        consumerResource: site.resourceId,
        schema: { resourceId: site.resourceId, path: "contracts/response.schema.json" },
        producerOutput: { mountName: other.mountName, command: "node scripts/sample-response.js" },
      },
    ]),
  };
}
