/**
 * Server-owned documents the demo seeder sends: the project policy (checks, contracts, rules,
 * preview and release recipes) and the client edition policy. Pure data, no I/O.
 *
 * Sources (keep in step with them):
 * - checks/contracts/rules: apps/demo-agents/README.md "Live gate prerequisite: the /quote contract policy"
 * - preview recipe: apps/worker/test/api/previews.test.ts PREVIEW_POLICY; apps/worker/API.md "Deploy prerequisites" 7
 * - release recipe: apps/worker/test/release-fixtures.ts; apps/web/e2e/local-stack.spec.ts (seed test)
 * - edition: apps/demo-agents/src/edition.ts websiteEditionPolicy (the demo agents look it up by name)
 * - staging (`--staging`): spec docs/superpowers/specs/2026-10-07-always-on-preview-promotion-design.md §3 and §12;
 *   scripts/ci-live/project.ts demoPolicy imports STAGING_PROMOTION and stagingEnvironment from here
 */

export const GIT_FIXTURES = ['website', 'api', 'requirements'] as const;
export type GitFixture = (typeof GIT_FIXTURES)[number];

export const ASSETS_MOUNT = 'brand-assets';
export const KV_NAME = 'orders';
/** The production D1 of a staging-mode demo (`--staging`): bound as `DB`, migrated by `release.migrations`. */
export const D1_NAME = 'contacts';
/** apps/demo-agents/src/edition.ts DEMO_EDITION_NAME: the demo agents find the edition by this name. */
export const DEMO_EDITION_NAME = 'Website pages (client edition)';

/** Release Workers must be `<COMMONFORGE_DEPLOY_WORKER_PREFIX>-<orgId>-<name>` (default prefix `cfapp`). */
export function releaseWorkerName(orgId: string, name: string): string {
  return `cfapp-${orgId}-${name}`;
}

export interface PolicyInput {
  orgId: string;
  resourceIds: Record<GitFixture, string>;
  /** id of the org's `orders` KV namespace (POST …/deploy-resources) */
  kvId: string;
  /** the deploy account's workers.dev subdomain, for the website's production API URL */
  workersSubdomain: string;
  /**
   * The deployment's release Worker prefix as `GET …/deploy-resources` reports it (`<prefix>-<orgId>-`,
   * `cfapp-…` in production, `cfci-…` on CI); default `releaseWorkerName`.
   */
  workerPrefix?: string;
  /**
   * Staging mode (`--staging`): the production D1 (`POST …/deploy-resources` kind d1). The policy then
   * gets the `staging` section, binds the D1 in production and names the api migrations.
   */
  staging?: { d1Id: string };
}

/**
 * The demo's promotion rules (spec §3): copy and styles are the client's to ship, API code and
 * migrations go to the classifier (Jev, 0.9), build and deploy files to a developer.
 * `api/tests/**` is a classify path (staging Phase 4-1 ruling P4-1).
 */
export const STAGING_PROMOTION = {
  rules: [
    { paths: ['website/index.html', 'website/src/**/*.css', 'website/src/quote-view.ts', 'website/public/**'], level: 'self' },
    { paths: ['api/migrations/**', 'api/src/**', 'api/tests/**'], level: 'classify' },
    { paths: ['**/wrangler.jsonc', '**/package.json', '**/pnpm-lock.yaml', '**/.github/**'], level: 'developer' },
  ],
  classifier: { provider: 'jev', threshold: 0.9 },
};

/** Staging's own api data: platform-created D1 (migrated, seeded) and KV (seeded); never production ids. */
export const stagingEnvironment = () => ({
  api: {
    vars: { APP_VERSION: '1.0.0-staging' },
    kv: [{ binding: 'ORDERS', seed: 'seed/orders.json' }],
    d1: [{ binding: 'DB', migrationsDir: 'migrations', seed: ['seed/contacts.sql'] }],
  },
});

/** Outbound webhooks of the staging api that go to "Sent from staging" instead of the real service. */
export const STAGING_CAPTURE_VARS = ['PAYMENT_WEBHOOK_URL', 'EMAIL_WEBHOOK_URL'];

/** Install from the fixture's committed lockfile, no scripts (fixtures/README.md, review m-5). */
const install = (mountName: string, stepId: string) => ({ stepId, mountName, command: 'pnpm install --frozen-lockfile --ignore-scripts' });
/** After the install, `pnpm exec`/`pnpm run` must not try to re-install (apps/runner/README.md). */
const NO_REINSTALL = { PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false' };

/**
 * The whole project policy. `PUT …/policy` replaces the policy as one document, so every field the
 * demo needs is here; `approvalRoles` and `publishRoles` stay at their defaults (owner, developer,
 * client approve; owner publishes).
 */
export function projectPolicy(p: PolicyInput) {
  const worker = (name: string) => (p.workerPrefix ? `${p.workerPrefix}${name}` : releaseWorkerName(p.orgId, name));
  const workerUrl = (name: string) => `https://${worker(name)}.${p.workersSubdomain}.workers.dev`;
  const apiUrl = workerUrl('api');
  const releaseSteps = (quoteApiUrl: string) => [
    install('api', 'api-install'),
    { stepId: 'api-bundle', mountName: 'api', command: 'pnpm run build', env: NO_REINSTALL },
    install('website', 'site-install'),
    { stepId: 'site-build', mountName: 'website', command: 'pnpm exec vite build', env: { ...NO_REINSTALL, VITE_QUOTE_API_URL: quoteApiUrl } },
  ];
  const d1 = p.staging?.d1Id;
  return {
    checks: [{ checkId: 'quote-contract', mountName: 'website', command: 'pnpm exec vitest run tests/quote-contract.test.ts', timeoutSeconds: 300 }],
    contracts: [
      {
        contractId: 'quote',
        version: '1',
        producerResource: p.resourceIds.api,
        consumerResource: p.resourceIds.website,
        schema: { resourceId: p.resourceIds.requirements, path: 'contracts/quote.schema.json' },
        producerOutput: { mountName: 'api', command: 'node scripts/quote-sample.ts' },
      },
    ],
    rules: ['GET /quote responses must match requirements/contracts/quote.schema.json', 'Money is integer cents.'],
    preview: {
      recipe: {
        recipeId: 'demo-preview',
        revision: 1,
        steps: [
          install('api', 'api-install'),
          { stepId: 'api-bundle', mountName: 'api', command: 'pnpm run build', env: NO_REINSTALL },
          install('website', 'site-install'),
          { stepId: 'site-build', mountName: 'website', command: 'pnpm exec vite build --base ./', env: { ...NO_REINSTALL, VITE_QUOTE_API_URL: './api' } },
        ],
        output: { mountName: 'website', path: 'dist' },
      },
      bundles: [{ name: 'api', mountName: 'api', path: 'dist' }],
      hostVars: { APP_VERSION: 'preview' },
      ttlSeconds: 86_400,
    },
    release: {
      recipe: { recipeId: 'demo-release', revision: 1, steps: releaseSteps(apiUrl) },
      targets: [
        { targetId: 'api', kind: 'worker', mountName: 'api', outputPath: 'dist', main: 'index.js', workerName: worker('api') },
        { targetId: 'website', kind: 'assets', mountName: 'website', outputPath: 'dist', workerName: worker('website') },
      ],
      environment: { api: { vars: { APP_VERSION: '1.0.0' }, kvNamespaces: [{ binding: 'ORDERS', id: p.kvId }], ...(d1 ? { d1Databases: [{ binding: 'DB', id: d1 }] } : {}) } },
      healthCheck: { targetId: 'api', path: '/version' },
      // a promotion applies new api migrations to the production D1 before the code goes live
      ...(d1 ? { migrations: [{ targetId: 'api', binding: 'DB', dir: 'migrations' }] } : {}),
    },
    ...(d1
      ? {
          // staging builds the same website against the staging api Worker (`<api worker>-staging`)
          staging: {
            recipe: { recipeId: 'demo-staging', revision: 1, steps: releaseSteps(workerUrl('api-staging')) },
            environment: stagingEnvironment(),
            captureVars: STAGING_CAPTURE_VARS,
            promotion: STAGING_PROMOTION,
          },
        }
      : {}),
  };
}

/** fixtures/README.md "Website edition policy (client edition, Task 21)", as the demo agents send it. */
export function websiteEditionPolicy(mountName: string) {
  return {
    name: DEMO_EDITION_NAME,
    sources: [
      {
        mountName,
        include: ['index.html', 'src/**', 'public/**', 'tests/quote-view.test.ts', 'tests/json-schema.test.ts', 'package.json', 'vite.config.ts', 'tsconfig.json'],
        write: ['index.html', 'src', 'public', 'tests'],
      },
    ],
    protectedPaths: ['package.json', 'vite.config.ts', 'tsconfig.json', 'wrangler.jsonc', 'tests/quote-contract.test.ts'],
  };
}
