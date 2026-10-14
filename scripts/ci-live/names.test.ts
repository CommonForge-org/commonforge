// node --test scripts/ci-live/names.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { isOrgResource, isSweepable, listAllPages, orgPrefix, orgWorkers } from "./names.ts";

const ORG = "o-0123456789ab";

test("org prefix: release workers, staging workers, org D1, staging D1/KV", () => {
  assert.equal(orgPrefix("cfci", ORG), "cfci-o-0123456789ab-");
  assert.deepEqual(orgWorkers("cfci", ORG), [
    "cfci-o-0123456789ab-api",
    "cfci-o-0123456789ab-website",
    "cfci-o-0123456789ab-api-staging",
    "cfci-o-0123456789ab-website-staging",
  ]);
  assert.deepEqual(orgWorkers("cfapp", ORG).slice(2), ["cfapp-o-0123456789ab-api-staging", "cfapp-o-0123456789ab-website-staging"]);
  for (const n of [
    "cfci-o-0123456789ab-contacts",
    "cfci-o-0123456789ab-orders",
    "cfci-o-0123456789ab-stg-0123456789abcdef-db-1-a1b2",
    "cfci-o-0123456789ab-stg-0123456789abcdef-orders-2-ffff",
    "cfci-o-0123456789ab-stg-0123456789abcdef-3-0000",
  ]) assert.ok(isOrgResource(n, "cfci", ORG), n);
});

test("org prefix never matches another org, another prefix or the platform", () => {
  for (const n of [
    "cfci-o-0123456789abc-contacts", // longer org id sharing the start
    "cfci-o-0123456789a-contacts",
    "cfci-o-fedcba987654-contacts",
    "cfapp-o-0123456789ab-contacts",
    "commonforge-ci-o-0123456789ab-canonical",
    "commonforge-ci-worker",
    "commonforge-ci",
    "cfci-o-0123456789ab", // no trailing resource name
    "xcfci-o-0123456789ab-contacts",
  ]) assert.equal(isOrgResource(n, "cfci", ORG), false, n);
  assert.equal(isOrgResource("cfci-o-0123456789ab-contacts", "cfapp", ORG), false);
});

test("org prefix refuses malformed org ids and unknown prefixes (no match-everything prefix)", () => {
  for (const bad of ["", "o-", "o-abc", "o-0123456789ab-x", "o-0123456789AB", "*"]) assert.throws(() => orgPrefix("cfci", bad), bad);
  for (const bad of ["", "commonforge-ci", "cf", "cfci-"]) assert.throws(() => orgPrefix(bad, ORG), bad);
});

test("sweep filter: any cfci-o-* run resource, never the platform or production", () => {
  for (const n of ["cfci-o-0123456789ab-api", "cfci-o-0123456789ab-api-staging", "cfci-o-0123456789ab-contacts", "cfci-o-0123456789ab-stg-0123456789abcdef-db-1-a1b2"])
    assert.ok(isSweepable(n, "cfci"), n);
  for (const n of ["commonforge-ci-worker", "commonforge-ci-runner", "commonforge-ci", "commonforge-ci-o-0123456789ab-tasks", "cfapp-o-0123456789ab-api", "cfapp-o-0123456789ab-contacts", "cfci-probe-abcd", "cfci", "cfci-", "cfcio-x"])
    assert.equal(isSweepable(n, "cfci"), false, n);
  assert.throws(() => isSweepable("cfci-o-x", "commonforge-ci"));
});

test("listAllPages follows pages until a short one", async () => {
  const all = Array.from({ length: 250 }, (_, i) => i);
  const asked: number[] = [];
  const got = await listAllPages(async (page, per) => {
    asked.push(page);
    return all.slice((page - 1) * per, page * per);
  }, 100);
  assert.deepEqual(got, all);
  assert.deepEqual(asked, [1, 2, 3]);
  assert.deepEqual(await listAllPages(async () => null), []);
  // an exact multiple asks one more (empty) page
  const asked2: number[] = [];
  assert.equal((await listAllPages(async (p) => (asked2.push(p), p === 1 ? [1, 2] : []), 2)).length, 2);
  assert.deepEqual(asked2, [1, 2]);
  await assert.rejects(listAllPages(async () => [1], 1, 3));
});
