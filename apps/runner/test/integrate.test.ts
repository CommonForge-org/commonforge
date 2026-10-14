import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  candidateRetentionRef,
  computeSnapshotIdSync,
  localRevisionId,
  r2mRevisionId,
  sha256HexSync,
  type CheckSpec,
  type ContractSpec,
  type FrozenCandidate,
  type RevisionId,
  type SnapshotEntry,
} from '@commonforge-org/core';
import { jobIntegrationRef, verifyEvidence, type IntegrationJobInput } from '@commonforge-org/runner-protocol';
import { KEY, World, type CanonicalRepo } from './helpers.js';

let w: World;

beforeAll(async () => {
  w = await World.create();
});
afterAll(() => w?.close());

let seq = 0;

/** Prepare candidates through the runner itself (integrate reads them from canonical only). */
async function prepare(c: CanonicalRepo, candidate: FrozenCandidate): Promise<void> {
  const r = await w.runner().execute(await w.delivery({ kind: 'prepare-candidate', candidate, canonical: c.coords, retentionRef: candidateRetentionRef(candidate.candidateId) }));
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

interface Target {
  repo: CanonicalRepo;
  mount: string;
  expectedHead?: RevisionId;
  snapshotHead?: RevisionId;
}

function integrateJob(opts: {
  targets: Target[];
  candidates: FrozenCandidate[];
  references?: Array<{ repo: CanonicalRepo; mount: string }>;
  checks?: Array<Partial<CheckSpec> & Pick<CheckSpec, 'checkId' | 'mountName' | 'command'>>;
  contracts?: ContractSpec[];
  /** assets-only proposals: the R2 manifest changes (their mount is in the snapshot, never in git) */
  assetChanges?: Array<{ resourceId: string; mount: string; baseManifestId: string; newManifestId: string }>;
  /** promotion builds: candidateId -> explicit merge base sha */
  mergeBases?: Record<string, string>;
}): { job: IntegrationJobInput; jobId: string } {
  const jobId = `job-int-${++seq}`;
  const proposalId = `prop-${seq}`;
  const entries: SnapshotEntry[] = [
    ...opts.targets.map((t) => ({ resourceId: t.repo.resource.resourceId, revisionId: t.snapshotHead ?? t.expectedHead ?? t.repo.revision, mode: 'must-match-accepted' as const, mountName: t.mount, operations: ['read' as const, 'write' as const] })),
    ...(opts.references ?? []).map((r) => ({ resourceId: r.repo.resource.resourceId, revisionId: r.repo.revision, mode: 'pinned-reference' as const, mountName: r.mount, operations: ['read' as const] })),
    ...(opts.assetChanges ?? []).map((a) => ({ resourceId: a.resourceId as SnapshotEntry['resourceId'], revisionId: r2mRevisionId(a.baseManifestId as never), mode: 'must-match-accepted' as const, mountName: a.mount, operations: ['read' as const, 'write' as const] })),
  ];
  const snap = { projectId: 'proj-1', organizationId: 'org1', membershipRevision: 1, policyRevision: 1, entries };
  return {
    jobId,
    job: {
      kind: 'integrate',
      proposalId,
      proposalHash: sha256HexSync(`proposal:${proposalId}`),
      baseSnapshot: { ...snap, snapshotId: computeSnapshotIdSync(snap), createdAt: new Date().toISOString() },
      candidateSnapshotId: sha256HexSync(`candidate-snapshot:${proposalId}`),
      candidates: opts.candidates,
      targets: opts.targets.map((t) => ({ resourceId: t.repo.resource.resourceId, canonical: t.repo.coords, expectedHead: t.expectedHead ?? t.repo.revision })),
      ...(opts.references ? { references: opts.references.map((r) => ({ resourceId: r.repo.resource.resourceId, coords: r.repo.coords })) } : {}),
      ...(opts.assetChanges ? { assetChanges: opts.assetChanges.map(({ mount: _m, ...a }) => a) } : {}),
      ...(opts.mergeBases ? { mergeBases: opts.mergeBases } : {}),
      integrationRef: jobIntegrationRef(proposalId, jobId),
      checks: (opts.checks ?? []).map((c) => ({ timeoutSeconds: 60, required: true, ...c })),
      contracts: opts.contracts ?? [],
    } as IntegrationJobInput,
  };
}

describe('integrate: merge, stale base, conflicts', () => {
  // The heaviest test here: two canonicals, three candidates, three prepares and a two-target integrate
  // spawn ~140 git processes. That is 3.5-5 s even when idle, and more on CI, where `turbo run test` runs
  // every package's suite at once (it hit vitest's 5 s default on most CI runs). No timers or polling.
  it('merges candidates of two resources onto the ledger head while refs/heads/main lags; pushes per-job refs; signed evidence', { timeout: 30_000 }, async () => {
    const site = await w.canonical('res-site-a', { 'index.html': '<h1>v1</h1>\n', 'about.html': 'about\n' });
    const api = await w.canonical('res-api-a', { 'src/app.ts': 'export const v = 1;\n' });
    const s1 = (await w.candidate(site, { 'index.html': '<h1>v2</h1>\n' }, 'ia-s1')).candidate;
    const s2 = (await w.candidate(site, { 'about.html': 'about v2\n' }, 'ia-s2')).candidate;
    const a1 = (await w.candidate(api, { 'src/app.ts': 'export const v = 2;\n' }, 'ia-a1')).candidate;
    for (const [repo, c] of [[site, s1], [site, s2], [api, a1]] as const) await prepare(repo, c);

    // the ledger accepted a new head for site; canonical main still lags (pending reconcile)
    const { job, jobId } = integrateJob({ targets: [{ repo: site, mount: 'website' }, { repo: api, mount: 'api' }], candidates: [s1, s2, a1] });
    const runner = w.runner({ currentHeads: async () => ({ [site.resource.resourceId]: site.revision, [api.resource.resourceId]: api.revision }) });
    const d = await w.delivery(job, { jobId });
    const r = await runner.execute(d);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const receipt = r.receipt as { results: Array<{ resourceId: string; sha: string; integrationRef: string }>; evidence: unknown };
    expect(receipt.results.map((x) => x.integrationRef)).toEqual([`refs/commonforge/integrations/${(job as { proposalId: string }).proposalId}/${jobId}`, `refs/commonforge/integrations/${(job as { proposalId: string }).proposalId}/${jobId}`]);
    const siteSha = receipt.results[0]!.sha;
    expect(await w.remoteSha(site.coords, receipt.results[0]!.integrationRef)).toBe(siteSha);
    expect(await w.remoteSha(api.coords, receipt.results[1]!.integrationRef)).toBe(receipt.results[1]!.sha);
    expect(await w.remoteSha(site.coords, 'refs/heads/main')).toBe(site.sha);
    // the merged tree holds both site changes
    const show = await w.git.ok(['--git-dir', decodeURIComponent(new URL(site.coords.remoteUrl).pathname), 'show', `${siteSha}:index.html`, `${siteSha}:about.html`], w.root);
    expect(show).toBe('<h1>v2</h1>\nabout v2\n');
    const v = await verifyEvidence(receipt.evidence, [KEY], { jobId });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.evidence.mergeOutcome).toEqual([{ resourceId: 'res-site-a', result: 'clean' }, { resourceId: 'res-api-a', result: 'clean' }]);
    // evidence is bound to the proposal's candidate snapshot, not the base snapshot (C-1)
    if (v.ok) expect(v.evidence.snapshotId).toBe((job as { candidateSnapshotId: string }).candidateSnapshotId);
    // deterministic: a retry of the same job id would produce the same sha (commit dates come from issuedAt)
    w.assertTokensHygiene(JSON.stringify(r));
  });

  it('stale_base when the ledger head or the must-match snapshot entry differs from expectedHead — never because of refs/heads/main', async () => {
    const site = await w.canonical('res-site-b', { 'index.html': 'v1\n' });
    const c = (await w.candidate(site, { 'index.html': 'v2\n' }, 'ib')).candidate;
    await prepare(site, c);
    // canonical main moved (a projection), ledger head unchanged → integrates fine
    await w.advanceCanonical(site, { 'other.txt': 'x\n' });
    const ok = integrateJob({ targets: [{ repo: site, mount: 'website' }], candidates: [c] });
    expect((await w.runner({ currentHeads: async () => ({ 'res-site-b': site.revision }) }).execute(await w.delivery(ok.job, { jobId: ok.jobId }))).ok).toBe(true);

    const moved = localRevisionId(site.coords.repoId, 'a'.repeat(40));
    const viaLedger = integrateJob({ targets: [{ repo: site, mount: 'website' }], candidates: [c] });
    const r1 = await w.runner({ currentHeads: async () => ({ 'res-site-b': moved }) }).execute(await w.delivery(viaLedger.job, { jobId: viaLedger.jobId }));
    expect(r1).toMatchObject({ ok: false, code: 'stale_base' });
    if (!r1.ok) expect((await verifyEvidence(r1.evidence, [KEY], { jobId: viaLedger.jobId })).ok).toBe(true);

    const viaSnapshot = integrateJob({ targets: [{ repo: site, mount: 'website', snapshotHead: moved }], candidates: [c] });
    const r2 = await w.runner().execute(await w.delivery(viaSnapshot.job, { jobId: viaSnapshot.jobId }));
    expect(r2).toMatchObject({ ok: false, code: 'stale_base' });
    const refs = Object.keys(await w.remoteRefs(site.coords)).filter((k) => k.includes(viaLedger.jobId) || k.includes(viaSnapshot.jobId));
    expect(refs).toEqual([]);
  });

  it('textual_conflict lists the conflicting paths and pushes nothing', async () => {
    const site = await w.canonical('res-site-c', { 'tests/quote-view.test.ts': '// cases\n// Quote view cases end here.\n', 'a.txt': 'a\n' });
    const c1 = (await w.candidate(site, { 'tests/quote-view.test.ts': '// cases\nit("one")\n// Quote view cases end here.\n' }, 'ic1')).candidate;
    const c2 = (await w.candidate(site, { 'tests/quote-view.test.ts': '// cases\nit("two")\n// Quote view cases end here.\n', 'a.txt': 'b\n' }, 'ic2')).candidate;
    await prepare(site, c1);
    await prepare(site, c2);
    const { job, jobId } = integrateJob({ targets: [{ repo: site, mount: 'website' }], candidates: [c1, c2] });
    const r = await w.runner().execute(await w.delivery(job, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'textual_conflict' });
    if (r.ok) return;
    expect(r.detail).toContain('tests/quote-view.test.ts');
    expect(r.detail).not.toContain('a.txt');
    const ev = await verifyEvidence(r.evidence, [KEY], { jobId });
    expect(ev.ok && ev.evidence.mergeOutcome).toEqual([{ resourceId: 'res-site-c', result: 'textual-conflict', conflictPaths: ['tests/quote-view.test.ts'] }]);
    expect(Object.keys(await w.remoteRefs(site.coords)).some((k) => k.includes(jobId))).toBe(false);
  });

  it('refuses unprepared candidates (never reads task forks)', async () => {
    const site = await w.canonical('res-site-d', { 'index.html': 'v1\n' });
    const c = (await w.candidate(site, { 'index.html': 'v2\n' }, 'id')).candidate;
    const { job, jobId } = integrateJob({ targets: [{ repo: site, mount: 'website' }], candidates: [c] });
    expect(await w.runner().execute(await w.delivery(job, { jobId }))).toMatchObject({ ok: false, code: 'provider_unavailable' });
  });

  it('multi-target partial push failure reports the refs already pushed', async () => {
    const site = await w.canonical('res-site-e', { 'index.html': 'v1\n' });
    const c = (await w.candidate(site, { 'index.html': 'v2\n' }, 'ie')).candidate;
    await prepare(site, c);
    // a second canonical that refuses every push (non-busy failure)
    const work = await w.workRepo({ 'x.txt': 'x\n' });
    const brokenCoords = await w.bareRepo('canonical', 'res-broken');
    const brokenPath = decodeURIComponent(new URL(brokenCoords.remoteUrl).pathname);
    await w.git.ok(['push', '-q', brokenCoords.remoteUrl, 'HEAD:refs/heads/main'], work.path);
    const { writeFile, chmod } = await import('node:fs/promises');
    await writeFile(`${brokenPath}/hooks/pre-receive`, '#!/bin/sh\necho "denied by test" >&2\nexit 1\n');
    await chmod(`${brokenPath}/hooks/pre-receive`, 0o755);
    const broken: CanonicalRepo = {
      resource: { ...site.resource, resourceId: 'res-broken' as never, coords: brokenCoords },
      coords: brokenCoords,
      sha: work.sha,
      revision: localRevisionId(brokenCoords.repoId, work.sha),
    };
    const { job, jobId } = integrateJob({ targets: [{ repo: site, mount: 'website' }, { repo: broken, mount: 'broken' }], candidates: [c] });
    const r = await w.runner().execute(await w.delivery(job, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'provider_unavailable' });
    if (!r.ok) expect(r.detail).toMatch(/partial: already pushed .* to res-site-e/);
  });
});

describe('integrate: checks and contracts', () => {
  let api: CanonicalRepo;
  let reqs: CanonicalRepo;
  let breakdown: FrozenCandidate;

  beforeAll(async () => {
    const pricing = await readFile(new URL('../../../fixtures/api/src/pricing.ts', import.meta.url), 'utf8');
    const schema = await readFile(new URL('../../../fixtures/requirements/contracts/quote.schema.json', import.meta.url), 'utf8');
    api = await w.canonical('res-api', {
      'src/pricing.ts': pricing,
      'scripts/quote-sample.ts': "import { priceQuote } from '../src/pricing.ts';\nprocess.stdout.write(JSON.stringify(priceQuote({ customer: 'Acme', plan: 'team', seats: 60, pricingDate: '2026-10-06' }, '1.0.0')));\n",
      'scripts/env-check.mjs': "let parent = '';\ntry { parent = (await import('node:fs')).readFileSync(`/proc/${process.ppid}/environ`, 'latin1'); } catch {}\nconsole.error(JSON.stringify({ keys: Object.keys(process.env).sort(), ci: process.env.CI, parentHasToken: /art_v2_|COMMONFORGE_TOKEN=|GIT_CONFIG_VALUE/.test(parent) }));\nprocess.exit(1);\n",
      'scripts/ok.mjs': "console.log('ok');\n",
      'scripts/tamper.mjs': "import { readdirSync, writeFileSync } from 'node:fs';\nwriteFileSync('src/pricing.ts', 'export const hacked = true;\\n');\nconsole.log(readdirSync('..').join(','));\n",
    });
    reqs = await w.canonical('res-requirements', { 'contracts/quote.schema.json': schema, 'requirements.md': '# R\n' });
    breakdown = (
      await w.candidate(
        api,
        { 'src/pricing.ts': pricing.replace('    apiVersion,\n  };', '    apiVersion,\n    breakdown: { gross, discount: roundCents(gross - total) },\n  };') },
        'breakdown',
      )
    ).candidate;
    await prepare(api, breakdown);
  });

  const quoteContract: ContractSpec = {
    contractId: 'quote',
    version: '1',
    producerResource: 'res-api' as never,
    consumerResource: 'res-website' as never,
    schema: { resourceId: 'res-requirements' as never, path: 'contracts/quote.schema.json' },
    producerOutput: { mountName: 'api', command: 'node scripts/quote-sample.ts' },
  };

  it('contract_failed: the api adds `breakdown` without updating the quote contract (clean merge)', async () => {
    const { job, jobId } = integrateJob({ targets: [{ repo: api, mount: 'api' }], references: [{ repo: reqs, mount: 'requirements' }], candidates: [breakdown], contracts: [quoteContract] });
    const r = await w.runner().execute(await w.delivery(job, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'contract_failed' });
    if (r.ok) return;
    expect(r.detail).toContain('$.breakdown: is not declared in the contract');
    const ev = await verifyEvidence(r.evidence, [KEY], { jobId });
    expect(ev.ok).toBe(true);
    if (ev.ok) {
      expect(ev.evidence.mergeOutcome).toEqual([{ resourceId: 'res-api', result: 'clean' }]);
      expect(ev.evidence.contractChecks).toMatchObject([{ contractId: 'quote', result: 'fail' }]);
    }
    expect(Object.keys(await w.remoteRefs(api.coords)).some((k) => k.includes(jobId))).toBe(false);
  });

  it('passes once the contract declares `breakdown` (schema change in the same proposal)', async () => {
    const schema = JSON.parse(await readFile(new URL('../../../fixtures/requirements/contracts/quote.schema.json', import.meta.url), 'utf8'));
    schema.properties.breakdown = { type: 'object', additionalProperties: false, required: ['gross', 'discount'], properties: { gross: { type: 'number' }, discount: { type: 'number' } } };
    const reqChange = (await w.candidate(reqs, { 'contracts/quote.schema.json': JSON.stringify(schema, null, 2) }, 'schema')).candidate;
    await prepare(reqs, reqChange);
    const { job, jobId } = integrateJob({
      targets: [{ repo: api, mount: 'api' }, { repo: reqs, mount: 'requirements' }],
      candidates: [breakdown, reqChange],
      contracts: [quoteContract],
      checks: [{ checkId: 'ok', mountName: 'api', command: 'node scripts/ok.mjs' }],
    });
    const r = await w.runner().execute(await w.delivery(job, { jobId }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const ev = await verifyEvidence((r.receipt as { evidence: unknown }).evidence, [KEY], { jobId });
    expect(ev.ok && ev.evidence.contractChecks).toMatchObject([{ contractId: 'quote', result: 'pass' }]);
    expect(ev.ok && ev.evidence.checks).toMatchObject([{ checkId: 'ok', result: 'pass', command: 'node scripts/ok.mjs' }]);
  });

  it('check_failed: a required check fails (its environment holds no credential); optional failures are recorded only', async () => {
    const { job, jobId } = integrateJob({ targets: [{ repo: api, mount: 'api' }], candidates: [breakdown], checks: [{ checkId: 'env', mountName: 'api', command: 'node scripts/env-check.mjs' }] });
    const r = await w.runner().execute(await w.delivery(job, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'check_failed' });
    if (r.ok) return;
    expect(r.detail).toContain('check env');
    expect(r.detail).toContain('"ci":"1"');
    // the runner's own environment never holds a token either (tokens live only in git child envs)
    expect(r.detail).toContain('"parentHasToken":false');
    // on macOS the check's own node process sets __CF_USER_TEXT_ENCODING at startup (CoreFoundation),
    // after the runner handed it the allowlisted environment, so it is not the runner's to strip
    const detail = process.platform === 'darwin' ? r.detail.replace(',"__CF_USER_TEXT_ENCODING"]', ']') : r.detail;
    expect(detail).toContain('"keys":["CI","COMMONFORGE_CHECK_RUN","GIT_CONFIG_GLOBAL","GIT_CONFIG_NOSYSTEM","GIT_TERMINAL_PROMPT","HOME","LANG","NO_COLOR","PATH","TMPDIR"]');
    for (const bad of ['COMMONFORGE_TOKEN', 'GIT_CONFIG_KEY', 'extraHeader', 'art_v2_']) expect(r.detail).not.toContain(bad);
    w.assertTokensHygiene(JSON.stringify(r));
    const ev = await verifyEvidence(r.evidence, [KEY], { jobId });
    expect(ev.ok && ev.evidence.checks).toMatchObject([{ checkId: 'env', result: 'fail', required: true }]);

    const opt = integrateJob({ targets: [{ repo: api, mount: 'api' }], candidates: [breakdown], checks: [{ checkId: 'env', mountName: 'api', command: 'node scripts/env-check.mjs', required: false }] });
    const r2 = await w.runner().execute(await w.delivery(opt.job, { jobId: opt.jobId }));
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    // the evidence carries each check's `required` flag from the job's CheckSpec
    if (r2.ok) expect((r2.receipt as { evidence: { checks: unknown[] } }).evidence.checks).toMatchObject([{ checkId: 'env', result: 'fail', required: false }]);
  });

  it('checks run in a separate checkout: a check that rewrites files cannot change what is pushed', async () => {
    const { job, jobId } = integrateJob({ targets: [{ repo: api, mount: 'api' }], candidates: [breakdown], checks: [{ checkId: 'tamper', mountName: 'api', command: 'node scripts/tamper.mjs' }] });
    const r = await w.runner().execute(await w.delivery(job, { jobId }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const sha = (r.receipt as { results: Array<{ sha: string }> }).results[0]!.sha;
    const pricing = await w.git.ok(['--git-dir', decodeURIComponent(new URL(api.coords.remoteUrl).pathname), 'show', `${sha}:src/pricing.ts`], w.root);
    expect(pricing).toContain('breakdown');
  });

  // follow-up Task 23: an assets-only proposal (a logo) has no git targets; the policy checks and
  // contracts run against the snapshot's git mounts, all of them references, and nothing is pushed
  const logo = { resourceId: 'res-brand', mount: 'brand', baseManifestId: sha256HexSync('manifest:base'), newManifestId: sha256HexSync('manifest:logo-v2') };

  it('assets-only: no targets — checks and contracts run on the references, nothing is pushed, evidence has an empty merge outcome', async () => {
    const apiRefs = await w.remoteRefs(api.coords);
    const reqRefs = await w.remoteRefs(reqs.coords);
    const { job, jobId } = integrateJob({
      targets: [],
      candidates: [],
      references: [{ repo: api, mount: 'api' }, { repo: reqs, mount: 'requirements' }],
      assetChanges: [logo],
      contracts: [quoteContract],
      checks: [{ checkId: 'ok', mountName: 'api', command: 'node scripts/ok.mjs' }],
    });
    const r = await w.runner().execute(await w.delivery(job, { jobId }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const receipt = r.receipt as { results: unknown[]; evidence: unknown };
    expect(receipt.results).toEqual([]);
    const ev = await verifyEvidence(receipt.evidence, [KEY], { jobId });
    expect(ev.ok).toBe(true);
    if (ev.ok) {
      expect(ev.evidence.mergeOutcome).toEqual([]);
      expect(ev.evidence.checks).toMatchObject([{ checkId: 'ok', result: 'pass', required: true }]);
      // the base api (no `breakdown`) satisfies the quote contract
      expect(ev.evidence.contractChecks).toMatchObject([{ contractId: 'quote', result: 'pass' }]);
      expect(ev.evidence.proposalHash).toBe((job as { proposalHash: string }).proposalHash);
      expect(ev.evidence.snapshotId).toBe((job as { candidateSnapshotId: string }).candidateSnapshotId);
    }
    // no ref moved anywhere: an assets-only job has no allowed push
    expect(await w.remoteRefs(api.coords)).toEqual(apiRefs);
    expect(await w.remoteRefs(reqs.coords)).toEqual(reqRefs);
    w.assertTokensHygiene(JSON.stringify(r));
  });

  it('assets-only: a failing required check refuses with check_failed and signed evidence', async () => {
    const { job, jobId } = integrateJob({
      targets: [],
      candidates: [],
      references: [{ repo: api, mount: 'api' }],
      assetChanges: [logo],
      checks: [{ checkId: 'env', mountName: 'api', command: 'node scripts/env-check.mjs' }],
    });
    const r = await w.runner().execute(await w.delivery(job, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'check_failed' });
    if (r.ok) return;
    const ev = await verifyEvidence(r.evidence, [KEY], { jobId });
    expect(ev.ok && ev.evidence.checks).toMatchObject([{ checkId: 'env', result: 'fail', required: true }]);
    expect(ev.ok && ev.evidence.mergeOutcome).toEqual([]);
  });

  it('scope_violation: a check command that is not allowlisted never runs', async () => {
    const { job, jobId } = integrateJob({ targets: [{ repo: api, mount: 'api' }], candidates: [breakdown], checks: [{ checkId: 'sh', mountName: 'api', command: 'bash -c id' }] });
    const r = await w.runner().execute(await w.delivery(job, { jobId }));
    expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
  });
});

void pathToFileURL;

describe('integrate with explicit merge bases (promotion)', () => {
  it('applies only each candidate\'s own edits from its staging base, single-parent, and never skips by ancestry', { timeout: 30_000 }, async () => {
    const site = await w.canonical('res-site-pro', { 'a.txt': 'a1\n', 'b.txt': 'b1\n', 'c.txt': 'c1\n' });
    // landing A edits a.txt; staging commit S = main + A, kept under a staging-builds ref
    const aCand = (await w.candidate(site, { 'a.txt': 'a2\n' }, 'pro-a')).candidate;
    await prepare(site, aCand);
    const S = await w.mergeOnto(site, site.sha, aCand.sha, 'refs/commonforge/staging-builds/b-1');
    // landing B was seeded from S and edits b.txt
    const bCand = (await w.candidate(site, { 'b.txt': 'b2\n' }, 'pro-b', w.revisionFor(site.coords, S))).candidate;
    await prepare(site, bCand);
    // promote B alone onto main: A must NOT come along
    const first = integrateJob({ targets: [{ repo: site, mount: 'website' }], candidates: [bCand], mergeBases: { [bCand.candidateId]: S } });
    const r = await w.runner({ currentHeads: async () => ({ [site.resource.resourceId]: site.revision }) }).execute(await w.delivery(first.job, { jobId: first.jobId }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const sha = (r as { receipt: { results: Array<{ sha: string }> } }).receipt.results[0]!.sha;
    expect(await w.showFile(site.coords, sha, 'a.txt')).toBe('a1\n');
    expect(await w.showFile(site.coords, sha, 'b.txt')).toBe('b2\n');
    expect(await w.parents(site.coords, sha)).toEqual([site.sha]);
    // later, promoting A onto the new main still applies A (no "already contained" skip)
    const head = w.revisionFor(site.coords, sha);
    const second = integrateJob({ targets: [{ repo: site, mount: 'website', expectedHead: head }], candidates: [aCand], mergeBases: { [aCand.candidateId]: site.sha } });
    const r2 = await w.runner({ currentHeads: async () => ({ [site.resource.resourceId]: head }) }).execute(await w.delivery(second.job, { jobId: second.jobId }));
    expect(r2.ok, JSON.stringify(r2)).toBe(true);
    const sha2 = (r2 as { receipt: { results: Array<{ sha: string }> } }).receipt.results[0]!.sha;
    expect(await w.showFile(site.coords, sha2, 'a.txt')).toBe('a2\n');
    expect(await w.showFile(site.coords, sha2, 'b.txt')).toBe('b2\n');
    expect(await w.parents(site.coords, sha2)).toEqual([sha]);
  });

  it('refuses a merge base that is not an ancestor of the candidate', { timeout: 30_000 }, async () => {
    const site = await w.canonical('res-site-pro-anc', { 'a.txt': 'a1\n' });
    const cand = (await w.candidate(site, { 'a.txt': 'a2\n' }, 'pro-anc')).candidate;
    await prepare(site, cand);
    // an unrelated commit in canonical (a sibling of the candidate's real base's descendants)
    const unrelated = await w.advanceCanonical(site, { 'z.txt': 'z\n' });
    const forged = { ...cand, baseRevision: w.revisionFor(site.coords, unrelated) } as FrozenCandidate;
    const j = integrateJob({ targets: [{ repo: site, mount: 'website', expectedHead: w.revisionFor(site.coords, unrelated) }], candidates: [forged], mergeBases: { [cand.candidateId]: unrelated } });
    const r = await w.runner({ currentHeads: async () => ({ [site.resource.resourceId]: w.revisionFor(site.coords, unrelated) }) }).execute(await w.delivery(j.job, { jobId: j.jobId }));
    expect(r).toMatchObject({ ok: false, code: 'scope_violation' });
    expect((r as { detail: string }).detail).toMatch(/does not descend from its merge base/);
  });
});
