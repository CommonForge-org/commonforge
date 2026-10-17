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
  await page.getByRole('button',{name:'Archive scenario',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Manager override retains its reason · revision 3 · Archived'})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Manager override retains its reason · revision 3 · Archived'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Archive scenario',exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath('scenario-archived.png'),fullPage:true});
  await page.goto(root + '/outcomes');
  await page.getByLabel('Desired improvement').fill('A fresh agent preserves the manager exception');
  await page.getByLabel('Success criteria (one per line)').fill('The manager reason remains mandatory\nUnauthorized overrides remain denied');
  await page.getByRole('button', { name: 'Create outcome' }).click();
  await expect(page.getByRole('heading', { name: 'A fresh agent preserves the manager exception' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('outcome-open.png'), fullPage: true });
  await page.goto(root + '/review');
  await expect(page.getByText('No proposals submitted.', { exact: false })).toBeVisible();
  await expect(page.getByText('Health unknown.', { exact: false })).toBeVisible();
  await expect(page.getByText('Requirements recorded; implementation verification outstanding')).toHaveCount(4);
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
  await expect(proposal.getByText('pass (current result) · Verified runner execution', { exact: false })).toHaveCount(report.scenarioCount);
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

test('new project onboarding defaults to native knowledge and initializes a dedicated source folder', async ({ page }, info) => {
  await signedIn(page);
  const organization = await api(page, '/orgs', { name:'Native onboarding reference' });
  await page.goto(`/o/${organization.orgId}`);
  await page.getByRole('button', {name:'New project',exact:true}).click();
  await expect(page.getByLabel('Project workflow')).toHaveValue('agent-native');
  await page.getByLabel('Project name').fill('Public reference');
  await page.getByRole('button', {name:'Create project',exact:true}).click();
  await expect(page.getByRole('region', {name:'Folders'})).toBeVisible();
  await expect(page.getByRole('form', {name:'Attach an existing folder'})).toHaveCount(0);
  const projectId = /\/p\/([^/]+)/.exec(new URL(page.url()).pathname)![1]!;
  const folder = page.getByRole('form', {name:'New folder'});
  await folder.getByLabel('New folder', {exact:true}).fill('source');
  await folder.getByRole('button', {name:'Add folder',exact:true}).click();
  await expect(page.locator('.folder-row', {hasText:'source'})).toContainText('Ready', {timeout:60_000});
  await expect(page.getByRole('button', {name:'Detach source',exact:true})).toHaveCount(0);
  await page.getByRole('navigation', {name:'Project sections'}).getByRole('link', {name:'Knowledge',exact:true}).click();
  await expect(page.getByRole('heading', {name:'Knowledge',exact:true,level:2})).toBeVisible();
  await expect(page.getByRole('button', {name:'Enable project understanding'})).toHaveCount(0);
  const state = await page.evaluate(async ({org,pid}) => {
    const response=await fetch(`/api/orgs/${org}/projects/${pid}/native`,{credentials:'same-origin'});
    if(!response.ok) throw new Error('native onboarding state unavailable');
    return (await response.json()).state;
  },{org:organization.orgId,pid:projectId});
  expect(state.sourceHeads).toHaveLength(1);
  expect(state.manifests.at(-1).sourceHeads).toEqual(state.sourceHeads);
  expect(state.manifests.at(-1).behavior).toBe('historical-unverified');
  await page.screenshot({path:info.outputPath('native-onboarding.png'),fullPage:true});
});

test('owner verifies and accepts historical source recovery under current requirements', async ({page},info)=>{
  test.skip(!process.env.COMMONFORGE_NATIVE_REVIEW_REPORT,'Requires the actual corrected source workflow and accepted later browser proposal.');
  const report=JSON.parse(readFileSync(process.env.COMMONFORGE_NATIVE_REVIEW_REPORT!,'utf8')) as {organizationId:string;projectId:string;scenarioCount:number};
  await signedIn(page);
  await page.goto(`/o/${report.organizationId}/p/${report.projectId}/review`);
  const before=await page.evaluate(async ({org,pid})=>(await (await fetch(`/api/orgs/${org}/projects/${pid}/native`,{credentials:'same-origin'})).json()).state,{org:report.organizationId,pid:report.projectId});
  const target=[...before.manifests].reverse().find((m:any)=>m.behavior==='verified'&&m.knowledgeHead===before.knowledgeHead&&m.sourceHeads.length===before.sourceHeads.length&&m.sourceHeads.some((head:any)=>before.sourceHeads.some((current:any)=>current.resourceId===head.resourceId&&current.revisionId!==head.revisionId)));
  expect(target,'rehearsal must include a prior corrected implementation and later accepted source').toBeTruthy();
  await page.getByRole('button',{name:`Review recovery to project version ${target.sequence}`,exact:true}).click();
  const recovery=page.locator('article[data-proposal-id]').filter({has:page.getByRole('heading',{name:'Historical source recovery',exact:true})}).first();
  await expect(recovery).toBeVisible();
  await expect(recovery.getByText('Restores exact historical source under current requirements',{exact:false})).toBeVisible();
  await recovery.getByRole('button',{name:'Run required automated scenarios',exact:true}).click();
  await expect(recovery.getByText('pass (current result) · Verified runner execution',{exact:false})).toHaveCount(report.scenarioCount,{timeout:120000});
  await recovery.getByLabel('Review explanation').fill('Reviewed exact historical source with fresh execution under the current corrected rule. This does not restore knowledge, deploy, or reverse external effects.');
  await recovery.getByRole('button',{name:'Approve exact change',exact:true}).click();
  await expect(recovery.getByRole('button',{name:'Accept project version',exact:true})).toBeVisible();
  await recovery.getByRole('button',{name:'Accept project version',exact:true}).click();
  await expect(recovery.getByText('Accepted',{exact:true})).toBeVisible();
  const after=await page.evaluate(async ({org,pid})=>(await (await fetch(`/api/orgs/${org}/projects/${pid}/native`,{credentials:'same-origin'})).json()).state,{org:report.organizationId,pid:report.projectId});
  expect(after.sourceHeads).toEqual(target.sourceHeads);
  expect(after.knowledgeHead).toBe(before.knowledgeHead);
  expect(after.knowledge).toEqual(before.knowledge);
  expect(after.manifests.at(-1).behavior).toBe('verified');
  // Acceptance schedules durable ref reconciliation; keep the real stack alive until it finishes.
  for(const head of target.sourceHeads)await expect.poll(()=>page.evaluate(async ({org,head})=>{
    const response=await fetch(`/api/orgs/${org}/resources/${head.resourceId}`,{credentials:'same-origin'});
    if(!response.ok)return false;
    const resource=await response.json();return resource.head?.revisionId===head.revisionId&&resource.head?.reconciliation==='synced';
  },{org:report.organizationId,head}),{timeout:90000}).toBe(true);
  await page.screenshot({path:info.outputPath('recovery-accepted.png'),fullPage:true});
  writeFileSync(info.outputPath('recovery-acceptance.json'),JSON.stringify({execution:'real-browser-real-worker-real-git-real-runner',organizationId:report.organizationId,projectId:report.projectId,historicalManifest:target.hash,acceptedManifest:after.manifests.at(-1).hash,sourceHeads:after.sourceHeads,knowledgeHead:after.knowledgeHead,scenarioCount:report.scenarioCount,releaseClaimed:false,externalEffectsReversed:false},null,2));
});
