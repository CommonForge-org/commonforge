import type { ProjectState } from '@commonforge-org/core';
import type { Services } from '../context.js';
import { conflict } from '../lib/http.js';
import { getProject, projectPolicy } from './directory.js';
/** Stateless/code-only recovery cannot claim to reverse configured or previously applied data work. */
export async function assertNativeRecoveryEffects(svc:Services,state:ProjectState):Promise<void>{
 const project=await getProject(svc.db,state.organizationId,state.projectId);
 if(!project || projectPolicy(project).release?.migrations?.length)throw conflict('recovery_unsupported','data migrations require a recovery contract; code recovery cannot undo them');
 const policy=projectPolicy(project);
 if(policy.checks?.some(check=>check.required!==false) || policy.contracts?.length)throw conflict('recovery_unsupported','current artifact checks or contracts require exact historical-artifact verification before recovery');
 for(const h of state.sourceHeads){
  const applied=await svc.db.prepare('SELECT 1 AS found FROM production_migrations WHERE org_id=? AND resource_id=? LIMIT 1').bind(state.organizationId,h.resourceId).first();
  if(applied)throw conflict('recovery_unsupported','recorded production data effects require an explicit recovery contract');
 }
}
