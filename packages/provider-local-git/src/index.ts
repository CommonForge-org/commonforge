/** @commonforge-org/provider-local-git — `VersionProvider` over local bare git repositories. */
export const PACKAGE_NAME = '@commonforge-org/provider-local-git';

export * from './provider.js';
export * from './errors.js';
export * from './export-store.js';
export { TOKEN_PREFIX } from './hooks.js';
export { ISOLATED_GIT_ENV } from './git.js';
