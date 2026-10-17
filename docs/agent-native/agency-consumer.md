# Synthetic agency consumer contract

G1 retains the usable public reference product and existing agency workflows. A private agency
product may consume the public API/contracts without patching ledger invariants. No private
repository, client data, billing service, or private deployment configuration is required by the
public build. This document describes a synthetic consumer, not a completed private migration.

The contract test in `packages/ledger/src/project-bundle.test.ts` maps fictional “Synthetic Service
Studio / Cedar Demo” wording to public commands and proves that customized workflow still records
confirmed revisions and outstanding behavior through the shared reducer.

| Consumer concept | Public capability |
|---|---|
| Case lead confirms a service rule | Authorized owner/developer `draftKnowledge` then `confirmKnowledge` |
| Implementation partner proposes a correction | Agent `knowledge:propose` mandate; draft only |
| Client request and success criteria | Versioned outcome and task |
| Contractual review | Exact envelope/inner proposal decision by authorized reviewer |
| Agency release judgment | Separate publish approval; acceptance alone does not deploy |
| Client continuity packet | Scoped task context, confirmed rules and labeled assumptions |
| Portable engagement history | Versioned project bundle and completeness report |

Branding, navigation labels, onboarding, service packaging and stricter private review workflows
belong to the consuming app. It must not redefine confirmation authority, sign arbitrary runner
results, weaken scenario requirements, or write resource heads directly. A more restrictive
consumer may require additional approval before invoking public acceptance. Private billing and
client account systems remain separate integrations.

## Bundle contract implemented in G1

`exportProjectBundle(state, payloads?, lineage?, version?)` preserves the strict
`cf.project-bundle/1` archive and its original hashes. Version 2 (`cf.project-bundle/2`) additionally
binds exact imported archives in `lineage`, including their retained payloads and original digests.
An A → B → C export/import chain therefore preserves A's history without activating its trust.
The API advertises `bundleVersions: [1, 2]` and defaults to version 2; `bundleVersion=1` remains
available for projects without imported archives and refuses an export that would discard lineage.
The separate `importedHistory` response remains for older readers, but is no longer needed to
carry ancestry separately from the portable bundle. `includePayloads=1` adds available local
payloads; already retained historical payloads stay inside their exact ancestor archive.

Both versions retain exact historical state, manifest/knowledge/proposal integrity checks, optional
content-addressed payloads, and a digest. Across the entire portable bundle, limits are 16 MiB of
canonical JSON, 8 MiB of decoded payloads, 1,000 payload entries, 32 ancestor archives, and eight
lineage levels. Oversized exports/imports refuse explicitly; history is never silently truncated.
The iterative lineage depth/count guard runs before recursive schema parsing or canonicalization. `validateProjectBundle` checks version, sizes, digests, scope, paths, duplicate
identities, manifest chains and completeness claims before storage writes. Payloads use canonical
base64, SHA-256 and the sole allowed path `payloads/<digest>`; the helper extracts no archive.

Bundles add no provider coordinates or credentials. Recognizable credential material, embedded
URL credentials, local URLs and common local filesystem coordinates are refused in metadata and
payload bytes. This is a bounded scanner, not a claim to recognize every secret in arbitrary
application content. The caller authorizes the entire history and every payload before export.
Payloads cannot be treated as trusted files or execution input merely because their digest passes.

Completeness lists missing source revisions and attachments. Source bytes may be included as opaque
content-addressed payloads. The helper does not verify that a Git bundle represents its declared
revision, import a provider repository, restore external services, or label an archive a complete
backup: `sourceContentValidation` is `not-performed` and `completeBackup` is always false.
Use the existing Git export/bootstrap procedure for disaster recovery until a provider restore
adapter verifies source contents and all external payloads.

`importProjectBundle(bundle, {organizationId, projectId, ownerId, now})` requires a freshly authorized
local owner supplied by the trusted adapter. It returns a new local genesis state plus the exact
historical archive and identity map. Latest confirmed rules/scenarios become unconfirmed local
drafts with remapped IDs. Historical principals receive no authority; evidence, decisions,
mandates, releases and source heads are not activated. Original evidence provenance remains
inspectable only in the historical archive. Rules require fresh local confirmation. Scenarios
must be revised to reference the resulting local confirmed rule revisions before confirmation.
Source materialization and observation of imported releases remain explicitly unperformed.

`projectRetentionRoots(state)` enumerates all accepted source/manifest references, accepted evidence,
pending proposal evidence/attachments/builds, and active attempts. It authorizes no deletion.
The native evidence attachment API stores digest-verified bytes under the separate
`native-evidence/<org>/<project>/<digest>` R2 prefix, which existing GC does not scan. A registry
inside OrgLedger must be active with matching size/type before evidence may reference it. DELETE
atomically rejects every historical evidence reference and permanently tombstones unused digests
before removing bytes. This conservatively retains accepted and pending history without a GC
window between attachment validation and deletion. Storage GC must continue retaining existing
source/R2/task roots as well.

## Evidence payload lifecycle

Human owner/developer APIs at `.../native/attachments/:sha256` accept PUT/GET/DELETE. PUT is
content-addressed and idempotent for identical bytes and media type, capped at 1 MiB; GET rechecks
project access and stored digest and serves as an attachment. R2 bytes are prepared before ledger
registration; a storage failure cannot install an accepted reference. Registration failure can
leave an unreferenced orphan. Evidence ingestion and deletion serialize in the same OrgLedger
transaction: a retained reference prevents deletion; a deletion tombstone prevents subsequent
reference or reupload. Tombstones intentionally do not expire or resurrect in G1.

To remove a known unregistered orphan, an authorized operator uses the same DELETE endpoint:
it inserts a tombstone even when registration is absent, then deletes R2 bytes. This safely
excludes a concurrent first registration. A failed R2 delete is retried by repeating DELETE.
There is no automatic orphan sweep or historical evidence expiry. Never delete this prefix with
a bucket lifecycle rule or an external bulk sweep; that would bypass retention.

Bundle export can request scoped payload inclusion. Available bytes are checked against their
registered digest/size/type and included; missing bytes remain listed in `missingAttachments`.
Corrupt bytes fail export. Imported archived bytes remain historical and do not automatically
register local evidence or grant source/runner authority.
