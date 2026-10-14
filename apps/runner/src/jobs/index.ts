import type { IntegrationJobKind, JobReceiptByKind } from '@commonforge-org/runner-protocol';
import type { JobContext } from '../context.js';
import { applyFiles } from './apply-files.js';
import { buildEdition } from './build-edition.js';
import { editionReturn } from './edition-return.js';
import { exportJob } from './export.js';
import { initFolder } from './init-folder.js';
import { integrate } from './integrate.js';
import { inventory } from './inventory.js';
import { prepareCandidate } from './prepare-candidate.js';
import { previewBuild } from './preview-build.js';
import { reconcileRef } from './reconcile-ref.js';
import { releaseBuild } from './release-build.js';
import { releaseDeploy } from './release-deploy.js';
import { seedWorkspace } from './seed-workspace.js';
import { stagingBuild } from './staging-build.js';

export type JobHandler<K extends IntegrationJobKind> = (ctx: JobContext<K>) => Promise<JobReceiptByKind[K]>;

export const JOB_HANDLERS: { [K in IntegrationJobKind]: JobHandler<K> } = {
  'seed-workspace': seedWorkspace,
  'prepare-candidate': prepareCandidate,
  integrate,
  'reconcile-ref': reconcileRef,
  'preview-build': previewBuild,
  export: exportJob,
  'build-edition': buildEdition,
  'edition-return': editionReturn,
  inventory,
  'release-build': releaseBuild,
  'release-deploy': releaseDeploy,
  'apply-files': applyFiles,
  'staging-build': stagingBuild,
  'init-folder': initFolder,
};
