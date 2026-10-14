/**
 * @commonforge-org/conformance — reusable vitest suites for engine adapters.
 *
 * - `.` (this entry, Worker-safe): `describeLedgerConformance(storeFactory)`.
 * - `./provider` (Node only: real git, temp dirs): `describeProviderConformance(...)`, git/temp-repo
 *   helpers and the reference `RunnerSubmit`.
 *
 * vitest is a peer dependency: the suites call `describe`/`it` from the consumer's vitest.
 */
export const PACKAGE_NAME = '@commonforge-org/conformance';

export * from './ledger-suite.js';
