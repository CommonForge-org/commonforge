/** Actual browser + real Worker API. No intercepted requests or fixture provider results. */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const OWNER = process.env.COMMONFORGE_NATIVE_OWNER ?? 'owner@agency.e2e.test';
const LOG = process.env.COMMONFORGE_NATIVE_LOG ?? '/tmp/g1-real-worker.log';
async function signedIn(page: Page) {
  if (process.env.COMMONFORGE_NATIVE_SESSION_FILE) {
    const session = JSON.parse(readFileSync(process.env.COMMONFORGE_NATIVE_SESSION_FILE, 'utf8')) as { ownerToken: string };
    await page.setExtraHTTPHeaders({ authorization: `Bearer ${session.ownerToken}` });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    return;
  }
  const start = readFileSync(LOG, 'utf8').length;
  await page.goto('/signin');
  await page.getByLabel('Work email').fill(OWNER);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');
  let link: string | undefined;
  await expect.poll(() => {
    const lines = readFileSync(LOG, 'utf8').slice(start).split('\n');
    link = lines.filter(line => line.includes(`magic link for ${OWNER}: `)).at(-1)?.match(/https?:\/\/[^\s]+/)?.[0];
    return !!link;
  }).toBe(true);
  // Secret link is intentionally neither logged nor persisted in a test artifact.
  await page.goto(link!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
}
async function api(page: Page, path: string, body: unknown) {
  return page.evaluate(async ({ path, body }) => {
    const r = await fetch('/api' + path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(`API ${r.status}: ${data.error?.message ?? 'operation failed'}`);
    return data;
  }, { path, body });
}

test('owner preserves a correction and sees honest outcomes and review gaps using the real API', async ({ page }, info) => {
  await signedIn(page);
  const org = await api(page, '/orgs', { name: `Native browser rehearsal ${Date.now()}` });
  const project = await api(page, `/orgs/${org.orgId}/projects`, { name: 'Durable understanding browser rehearsal' });
  const root = `/o/${org.orgId}/p/${project.projectId}`;
  await page.goto(root + '/knowledge');
  await page.getByRole('button', { name: 'Enable project understanding' }).click();
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
  const initial = 'Customers may reschedule until 24 hours before their appointment.';
  const correction = 'Managers may override the 24-hour cutoff only with a retained reason.';
  await page.getByLabel('Requirement or understanding').fill(initial);
  await page.getByRole('textbox', { name: 'Rationale', exact: true }).fill('Predictable dispatch with recorded owner intent.');
  await page.getByLabel('Source or provenance').fill('Synthetic owner requirement in the real API browser rehearsal.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm rule' })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm rule' }).click();
  await expect(page.getByText('rule · revision 2 · Confirmed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Correct this record' }).click();
  await page.getByLabel('Requirement or understanding').fill(correction);
  await page.getByRole('textbox', { name: 'Rationale', exact: true }).fill('Manager exception must survive subsequent agent sessions.');
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm rule' }).click();
  await expect(page.getByText('rule · revision 4 · Confirmed', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(correction, { exact: true }).first()).toBeVisible();
  await page.getByLabel('Title', { exact: true }).fill('Manager override retains its reason');
  await page.getByLabel('Given', { exact: true }).fill('An appointment is less than 24 hours away and a manager is authorized');
  await page.getByLabel('When', { exact: true }).fill('The manager overrides the cutoff with a reason');
  await page.getByLabel('Then', { exact: true }).fill('The request succeeds and retains the reason');
  await page.getByRole('button', { name: 'Save scenario draft' }).click();
  await page.getByRole('button', { name: 'Confirm scenario' }).click();
  await expect(page.getByRole('heading', { name: 'Manager override retains its reason · revision 2 · Confirmed' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('knowledge-confirmed-correction.png'), fullPage: true });
  await page.goto(root + '/outcomes');
  await page.getByLabel('Desired improvement').fill('A fresh agent preserves the manager exception');
  await page.getByLabel('Success criteria (one per line)').fill('The manager reason remains mandatory\nUnauthorized overrides remain denied');
  await page.getByRole('button', { name: 'Create outcome' }).click();
  await expect(page.getByRole('heading', { name: 'A fresh agent preserves the manager exception' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('outcome-open.png'), fullPage: true });
  await page.goto(root + '/review');
  await expect(page.getByText('No proposals submitted.', { exact: false })).toBeVisible();
  await expect(page.getByText('Health unknown.', { exact: false })).toBeVisible();
  await expect(page.getByText('Requirements recorded; implementation verification outstanding')).toHaveCount(3);
  await page.screenshot({ path: info.outputPath('review-outstanding-unknown.png'), fullPage: true });
  await info.attach('real-api-journey', { contentType: 'application/json', body: JSON.stringify({ execution: 'real-browser-real-worker-api', orgId: org.orgId, projectId: project.projectId, correction, screenshots: ['knowledge-confirmed-correction.png', 'outcome-open.png', 'review-outstanding-unknown.png'], limitations: 'No source proposal or release is claimed by this UI correction test.' }) });
});

test('owner reviews real runner evidence and accepts the exact source proposal', async ({ page }, info) => {
  test.skip(!process.env.COMMONFORGE_NATIVE_REVIEW_REPORT, 'Requires an actual unaccepted verified source proposal prepared through the real-local workflow.');
  const report = JSON.parse(readFileSync(process.env.COMMONFORGE_NATIVE_REVIEW_REPORT!, 'utf8')) as { organizationId: string; projectId: string; proposalId: string; envelopeDigest: string; scenarioCount: number };
  await signedIn(page);
  await page.goto(`/o/${report.organizationId}/p/${report.projectId}/review`);
  const proposal = page.locator(`article[data-proposal-id="${report.proposalId}"]`);
  await expect(proposal).toBeVisible();
  await expect(proposal.getByText('Verified runner execution', { exact: false })).toHaveCount(report.scenarioCount);
  await expect(proposal.getByText('pass · Verified runner execution', { exact: false })).toHaveCount(report.scenarioCount);
  if (process.env.COMMONFORGE_NATIVE_REQUIRE_PREVIEW === '1') {
    await proposal.getByRole('button', { name: 'Create exact-source preview' }).click();
    const link = proposal.getByRole('link', { name: 'Open reviewed preview' }).first();
    await expect(link).toBeVisible({ timeout: 60000 });
    const opened = page.waitForEvent('popup');
    await link.click();
    const preview = await opened;
    await expect(preview.getByRole('heading', { name: 'Synthetic scheduling' })).toBeVisible();
    await preview.screenshot({ path: info.outputPath('real-reviewed-preview.png') });
    // Preview URLs contain short-lived capability tokens and are never included in reports.
    const health = await preview.request.get(preview.url() + 'api/health');
    expect(health.ok()).toBe(true); expect((await health.json()).ruleVersion).toBe(2);
    const manager = await preview.request.post(preview.url() + 'api/reschedule', {data:{actor:'manager',appointment:'2026-10-17T13:00:00.000Z',reason:'Owner preview observation'}});
    expect(manager.ok()).toBe(true); expect((await manager.json()).override.reason).toBe('Owner preview observation');
    await preview.close();
  }
  const alreadyAccepted = await proposal.getByText('Accepted', { exact: true }).isVisible();
  if (!alreadyAccepted) {
  await expect(proposal.getByRole('button', { name: 'Approve exact change' })).toBeDisabled();
  await proposal.getByLabel('Review explanation').fill('Owner reviewed the exact self-development change and real independently pinned runner evidence; the manager exception retains its reason.');
  await page.screenshot({ path: info.outputPath('source-review-real-evidence.png'), fullPage: true });
  await proposal.getByRole('button', { name: 'Approve exact change' }).click();
  await expect(proposal.getByRole('button', { name: 'Accept project version' })).toBeVisible();
  await proposal.getByRole('button', { name: 'Accept project version' }).click();
  }
  await expect(proposal.getByText('Accepted', { exact: true })).toBeVisible();
  await expect(page.getByText('Accepted with applicable behavioral evidence', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('source-accepted-real-evidence.png'), fullPage: true });
  writeFileSync(info.outputPath('source-acceptance.json'), JSON.stringify({ execution:'real-browser-real-worker-real-git-real-runner', organizationId:report.organizationId, projectId:report.projectId, proposalId:report.proposalId, envelopeDigest:report.envelopeDigest, scenarioCount:report.scenarioCount, acceptedInBrowser:!alreadyAccepted, inspectedExistingAcceptance:alreadyAccepted,releaseClaimed:false },null,2));
  await info.attach('real-source-acceptance', { contentType: 'application/json', body: JSON.stringify({ execution: 'real-browser-real-worker-real-git-real-runner', ...report, acceptedInBrowser: !alreadyAccepted, inspectedExistingAcceptance: alreadyAccepted, releaseClaimed: false }) });
});
