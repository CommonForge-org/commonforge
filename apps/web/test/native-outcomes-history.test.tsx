import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import { createProjectState, type ProjectOutcome } from '@commonforge-org/core';
import { FakeApi } from '../src/api/fake.js';
import { AppContext } from '../src/lib/hooks.js';
import { Outcomes } from '../src/screens/ProjectOutcomes.js';
it('shows current purpose and complete immutable outcome history with status and provenance',async()=>{
 const api=new FakeApi(),me=await api.me(),state=createProjectState('org','project');
 const initial:ProjectOutcome={schemaVersion:1,organizationId:'org',projectId:'project',id:'outcome',author:'first-expert',createdAt:'2026-10-17T12:00:00Z',revision:1,description:'Initial purpose',owner:'expert-owner',successCriteria:['Initial criterion'],state:'open',taskIds:['task']};
 state.outcomes=[initial,{...initial,revision:2,author:'second-expert',createdAt:'2026-10-17T13:00:00Z',description:'Corrected purpose',successCriteria:['Corrected criterion'],state:'deferred'}];
 const html=renderToString(<AppContext.Provider value={{api,fixture:null,me,refreshMe:async()=>{}}}><Outcomes state={state} command={async()=>{}} busy={false}/></AppContext.Provider>).replace(/<!-- -->/g,'');
 expect(html).toContain('<h3>Corrected purpose</h3>');expect(html).not.toContain('<h3>Initial purpose</h3>');
 for(const text of ['Outcome revision history','Revision 1 · open','Revision 2 · deferred','Initial purpose','Initial criterion','Corrected criterion','first-expert','second-expert','2026-10-17T12:00:00Z','2026-10-17T13:00:00Z','Revise outcome','Mark achieved','Create outcome'])expect(html).toContain(text);
});
