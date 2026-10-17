/** Actual browser + Worker API; creates task-owned synthetic records with no mocked responses. */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('owner revises outcome intent, sees concurrent-edit refusal, and retains exact history after reload',async({page},info)=>{
  const sessionPath=process.env.COMMONFORGE_NATIVE_SESSION_FILE;
  if(!sessionPath)throw Error('Outcome owner journey requires the real-local task-owned owner session.');
  const session=JSON.parse(readFileSync(sessionPath,'utf8')) as {ownerToken:string};
  await page.setExtraHTTPHeaders({authorization:`Bearer ${session.ownerToken}`});
  await page.goto('/');
  const coordinates=await page.evaluate(async()=>{
    async function post(path:string,body:unknown){const response=await fetch('/api'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!response.ok)throw Error('Synthetic outcome project creation failed');return response.json();}
    const org=await post('/orgs',{name:`Outcome revision rehearsal ${Date.now()}`});
    const project=await post(`/orgs/${org.orgId}/projects`,{name:'Outcome revision history',mode:'agent-native'});
    return {orgId:org.orgId,projectId:project.projectId};
  });
  await page.goto(`/o/${coordinates.orgId}/p/${coordinates.projectId}/outcomes`);
  await page.getByLabel('Desired improvement',{exact:true}).fill('Preserve the confirmed manager exception');
  await page.getByLabel('Success criteria (one per line)',{exact:true}).fill('A fresh agent retains the reason requirement');
  await page.getByRole('button',{name:'Create outcome',exact:true}).click();
  const article=page.locator('article.update-card').filter({has:page.getByRole('heading',{name:'Preserve the confirmed manager exception',exact:true})});
  await expect(article).toContainText('Status: open · revision 1');
  await article.getByRole('button',{name:'Revise outcome',exact:true}).click();
  await expect(page.getByLabel('Desired improvement',{exact:true})).toBeFocused();
  await page.getByLabel('Desired improvement',{exact:true}).fill('Unsaved text must be discarded only on cancel');
  await page.getByRole('button',{name:'Cancel outcome edit',exact:true}).click();
  await expect(page.getByLabel('Desired improvement',{exact:true})).toHaveValue('');
  await expect(article).toContainText('Status: open · revision 1');
  await article.getByRole('button',{name:'Revise outcome',exact:true}).click();
  await page.getByLabel('Desired improvement',{exact:true}).fill('Retain the manager exception and its audit reason');
  // A separate status action advances the same authoritative record while the form is open.
  await article.getByRole('button',{name:'Mark achieved',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('This outcome changed while you were editing');
  await expect(page.getByRole('button',{name:'Save outcome revision',exact:true})).toBeDisabled();
  await expect(page.getByLabel('Desired improvement',{exact:true})).toHaveValue('Retain the manager exception and its audit reason');
  await page.getByRole('button',{name:'Cancel outcome edit',exact:true}).click();
  await article.getByRole('button',{name:'Revise outcome',exact:true}).click();
  await page.getByLabel('Desired improvement',{exact:true}).fill('Retain the manager exception and its audit reason');
  await page.getByLabel('Success criteria (one per line)',{exact:true}).fill('A fresh agent retains the reason requirement\nUnauthorized overrides stay denied');
  await page.getByLabel('Outcome status',{exact:true}).selectOption('deferred');
  await page.getByRole('button',{name:'Save outcome revision',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Retain the manager exception and its audit reason',exact:true})).toBeVisible();
  await expect(page.getByLabel('Desired improvement',{exact:true})).toHaveValue('');
  await page.reload();
  await expect(page.locator('article.update-card')).toContainText('Status: deferred · revision 3');
  await page.locator('article.update-card summary').filter({hasText:'Outcome revision history'}).click();
  for(const text of ['Revision 1 · open','Revision 2 · achieved','Revision 3 · deferred','A fresh agent retains the reason requirement','Unauthorized overrides stay denied'])await expect(page.getByText(text,{exact:true}).first()).toBeVisible();
  await expect(page.locator('article.update-card details')).toContainText('Preserve the confirmed manager exception');
  await expect(page.locator('article.update-card details')).toContainText('recorded by');
  await page.screenshot({path:info.outputPath('outcome-revision-history.png'),fullPage:true});
});
