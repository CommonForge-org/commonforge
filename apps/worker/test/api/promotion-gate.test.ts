/**
 * Staging phase 2, Task 6: the promotion gate. Path levels from the candidates' changed paths, the
 * migration veto read from `main` and the promotion result (every staging `migrationsDir` and every
 * `release.migrations` folder), and the classifier hook, all failing closed.
 */
import type { FrozenCandidate } from "@commonforge-org/core";
import { describe, expect, it } from "vitest";
import { getResource, resourceCoords } from "../../src/services/directory.js";
import { notConfiguredEvidence, runClassifier, type ClassifierEvidence } from "../../src/services/classifier.js";
import { CLASSIFIER_DECLINED_TEXT, GATE_REASON_TEXT, gatePromotion, gateReasonText, type GateInput } from "../../src/services/promotion-gate.js";
import { ReleasePolicySchema, type ReleasePolicy } from "../../src/services/release-policy.js";
import { stagingPolicyOf } from "../../src/services/staging-policy.js";
import { FakeClassifier, SAFE_ANSWERS } from "../fakes/classifier.js";
import { codeResource } from "../helpers.js";
import { STAGING_SECTION, stagingFixture, stagingReleasePolicy } from "../staging-helpers.js";

const GATE_STAGING = {
  ...STAGING_SECTION,
  promotion: {
    rules: [
      { paths: ["website/**"], level: "self" },
      { paths: ["api/src/**"], level: "classify" },
      { paths: ["api/migrations/**", "api/db/**"], level: "classify" },
    ],
    classifier: { provider: "none", threshold: 0.9 },
  },
};

type Changes = Record<string, string | null>;

async function gateFixture() {
  const f = await stagingFixture({ staging: GATE_STAGING });
  const web = await codeResource(f.h, f.o, "website", { "index.html": "<h1>Hi</h1>\n" });
  const m = await f.h.api("POST", `/api/orgs/${f.o.orgId}/projects/${f.pid}/mounts`, { token: f.o.token, body: { mountName: "website", resourceId: web.resourceId } });
  expect(m.status, JSON.stringify(m.body)).toBe(201);
  const both = stagingPolicyOf(await f.project())!;
  const resourceByMount = new Map([
    ["api", f.api.resourceId],
    ["website", web.resourceId],
  ]);
  const ids = { api: f.api.resourceId, website: web.resourceId };

  /** The main head of a resource (its canonical `main`). */
  async function canonical(resourceId: string) {
    const coords = resourceCoords((await getResource(f.svc.db, f.o.orgId, resourceId))!);
    if (!coords || coords.kind !== "artifacts") throw new Error("no canonical repo");
    return { ns: coords.namespace, name: coords.repoName, head: f.h.artifacts.repo(coords.namespace, coords.repoName).refs.get("main")! };
  }

  /** A promotion result on top of main for each changed resource (null deletes a file), and a candidate naming the paths. */
  async function gate(changes: { api?: Changes; website?: Changes }, o: { release?: ReleasePolicy; staging?: typeof both.staging; resourceByMount?: Map<string, string>; classify?: GateInput["classify"]; carried?: GateInput["carried"] } = {}) {
    const heads = new Map<string, string>();
    const results = new Map<string, string>();
    const candidates: FrozenCandidate[] = [];
    for (const [mount, files] of Object.entries(changes) as Array<["api" | "website", Changes]>) {
      const rid = ids[mount];
      const c = await canonical(rid);
      const next: Record<string, string> = { ...f.h.artifacts.files.get(c.head) };
      for (const [p, v] of Object.entries(files)) {
        if (v === null) delete next[p];
        else next[p] = v;
      }
      const sha = f.h.artifacts.makeCommit(next, [c.head]);
      f.h.artifacts.addObject(c.ns, c.name, sha);
      heads.set(rid, c.head);
      results.set(rid, sha);
      candidates.push({ resourceId: rid, changedPaths: Object.keys(files) } as unknown as FrozenCandidate);
    }
    return gatePromotion(f.svc, { project: await f.project(), staging: o.staging ?? both.staging, release: o.release ?? both.release, candidates, resourceByMount: o.resourceByMount ?? resourceByMount, heads, results, classify: o.classify, carried: o.carried });
  }

  /** Commit `files` straight onto api's main (as if accepted earlier). */
  async function onMain(files: Record<string, string>) {
    const c = await canonical(ids.api);
    const sha = f.h.artifacts.makeCommit({ ...f.h.artifacts.files.get(c.head), ...files }, [c.head]);
    f.h.artifacts.push(c.ns, c.name, "main", sha);
  }

  /** `both.staging` with this classifier policy */
  const withClassifier = (provider: string, threshold = 0.9) => ({ ...both.staging, promotion: { ...both.staging.promotion, classifier: { provider, threshold } } }) as typeof both.staging;

  return { f, gate, onMain, both, ids, withClassifier };
}

describe("promotion gate", { timeout: 60_000 }, () => {
  it("(a) website paths only: self", async () => {
    const { gate } = await gateFixture();
    const g = await gate({ website: { "index.html": "<h1>Hello</h1>\n", "about.html": "<p>About</p>\n" } });
    expect(g).toMatchObject({ level: "self", pathLevel: "self", reasonCode: "self", veto: { kind: "none", offending: [] }, classifier: { asked: false, cleared: false, reason: "not_needed" } });
    expect(g.perPath).toEqual([
      { path: "website/index.html", level: "self", rule: 0 },
      { path: "website/about.html", level: "self", rule: 0 },
    ]);
  });

  it("(b) an api/src path needs the classifier, which is not configured: developer", async () => {
    const { gate } = await gateFixture();
    const g = await gate({ website: { "index.html": "x\n" }, api: { "src/index.ts": "export default {};\n" } });
    expect(g).toMatchObject({ level: "developer", pathLevel: "classify", reasonCode: "classifier_unavailable", veto: { kind: "none" }, classifier: { asked: true, cleared: false, reason: "not_configured" } });
  });

  it("(b2) the classifier is asked once with the gate's per-path levels: cleared keeps the level classify, declined and failures need a developer", async () => {
    const { gate: gateWith, withClassifier } = await gateFixture();
    const jev = withClassifier("jev");
    const gate: typeof gateWith = (c, o = {}) => gateWith(c, { staging: jev, ...o });
    const changes = { website: { "index.html": "x\n" }, api: { "src/index.ts": "export default {};\n" } };
    const fake = new FakeClassifier();
    const seen: unknown[] = [];
    const ask = (): GateInput["classify"] => async (g) => {
      seen.push(g.perPath);
      return runClassifier(fake.forProvider("jev"), { state: "s", truncated: false }, 0.9);
    };
    const cleared = await gate(changes, { classify: ask() });
    expect(cleared).toMatchObject({ level: "classify", pathLevel: "classify", reasonCode: "classifier", classifier: { asked: true, cleared: true, reason: "cleared", evidence: { provider: "jev", cleared: true, error: null } } });
    expect(seen).toEqual([cleared.perPath]);
    expect(fake.calls).toHaveLength(1);

    fake.script.push({ answers: { ...SAFE_ANSWERS, apiChange: { choice: "breaking", probabilities: { none: 0.1, backward_compatible: 0.1, breaking: 0.8 } } } });
    const declined = await gate(changes, { classify: ask() });
    expect(declined).toMatchObject({ level: "developer", reasonCode: "classifier_declined", classifier: { asked: true, cleared: false, reason: "declined", evidence: { failed: "apiChange" } } });
    expect(gateReasonText("classifier_declined", declined.classifier)).toBe("May change how the API works for existing callers.");

    fake.script.push({ error: "refused" });
    expect(await gate(changes, { classify: ask() })).toMatchObject({ level: "developer", reasonCode: "classifier_unavailable", classifier: { reason: "error", evidence: { error: "refused" } } });
    expect(await gate(changes, { classify: async () => notConfiguredEvidence(0.9) })).toMatchObject({ level: "developer", reasonCode: "classifier_unavailable", classifier: { reason: "not_configured", evidence: { provider: "none" } } });
    // a throw is classifier_unavailable without evidence, never gate_error
    const thrown = await gate(changes, { classify: async () => { throw new Error("boom"); } });
    expect(thrown).toMatchObject({ level: "developer", reasonCode: "classifier_unavailable", veto: { kind: "none" } });
    expect(thrown.classifier).toEqual({ asked: true, cleared: false, reason: "error" });
    // evidence that does not validate, or claims to clear with a failed question, never clears
    const ok = await runClassifier(new FakeClassifier().forProvider("jev"), { state: "s", truncated: false }, 0.9);
    expect(await gate(changes, { classify: async () => ({ ...ok, inputDigest: "not-a-digest" }) as ClassifierEvidence })).toMatchObject({ level: "developer", reasonCode: "classifier_unavailable", classifier: { reason: "error" } });
    expect(await gate(changes, { classify: async () => ({ ...ok, failed: "risk" }) })).toMatchObject({ level: "developer", reasonCode: "classifier_declined" });
    // a carried classifier clearance with evidence that still clears: not asked, the level stays classify, the evidence kept
    let asked = 0;
    const counting = async () => { asked++; return ok; };
    const carried = await gate(changes, { carried: { kind: "classifier", evidence: ok }, classify: counting });
    expect(carried).toMatchObject({ level: "classify", reasonCode: "classifier", classifier: { asked: false, cleared: true, reason: "carried", evidence: ok } });
    // a carried developer clearance: not asked either (reasonCode carried)
    expect(await gate(changes, { carried: { kind: "developer" }, classify: counting })).toMatchObject({ level: "classify", reasonCode: "carried", classifier: { asked: false, cleared: false, reason: "carried" } });
    expect(asked).toBe(0);
    // a carried classifier clearance whose evidence is missing or no longer clears under the policy: asked again
    for (const evidence of [null, { ...ok, threshold: 0.8 }, { ...ok, provider: "openai-decisions" }]) await gate(changes, { carried: { kind: "classifier", evidence }, classify: counting });
    expect(asked).toBe(3);
  });

  it("(b2b) evidence is re-checked against the policy before it clears: provider, threshold, the answers at the policy threshold, a complete input", async () => {
    const { gate, withClassifier } = await gateFixture();
    const changes = { api: { "src/index.ts": "export default {};\n" } };
    const ok = await runClassifier(new FakeClassifier().forProvider("jev"), { state: "s", truncated: false }, 0.9);
    const jev = withClassifier("jev");
    expect(await gate(changes, { staging: jev, classify: async () => ok })).toMatchObject({ level: "classify", reasonCode: "classifier" });
    // another provider than the policy names, or another threshold: not cleared
    expect(await gate(changes, { staging: withClassifier("openai-decisions"), classify: async () => ok })).toMatchObject({ level: "developer", reasonCode: "classifier_unavailable", classifier: { cleared: false, reason: "error" } });
    expect(await gate(changes, { staging: withClassifier("jev", 0.95), classify: async () => ok })).toMatchObject({ level: "developer", reasonCode: "classifier_unavailable", classifier: { cleared: false } });
    // evidence that claims to clear with answers that do not clear at the threshold: declined
    const weak = { ...ok, answers: { ...ok.answers!, risk: { choice: "low", probabilities: { low: 0.5, medium: 0.3, high: 0.2 } } } };
    expect(await gate(changes, { staging: jev, classify: async () => weak })).toMatchObject({ level: "developer", reasonCode: "classifier_declined", classifier: { cleared: false, reason: "declined" } });
    // evidence from an incomplete input (omitted files, or incomplete reasons) never clears
    expect(await gate(changes, { staging: jev, classify: async () => ({ ...ok, omittedFiles: 2 }) })).toMatchObject({ level: "developer", classifier: { cleared: false } });
    expect(await gate(changes, { staging: jev, classify: async () => ({ ...ok, incomplete: ["file_not_read"] }) })).toMatchObject({ level: "developer", classifier: { cleared: false } });
  });

  it("(b3) a self-only or developer path set never asks the classifier", async () => {
    const { gate } = await gateFixture();
    let asked = 0;
    const classify = async () => {
      asked++;
      return notConfiguredEvidence(0.9);
    };
    expect(await gate({ website: { "index.html": "x\n" } }, { classify })).toMatchObject({ level: "self", classifier: { asked: false, reason: "not_needed" } });
    expect(await gate({ api: { "src/a.ts": "x\n", "wrangler.jsonc": "{}\n" } }, { classify })).toMatchObject({ level: "developer", reasonCode: "developer_paths" });
    expect(await gate({ api: { "migrations/0002_drop.sql": "DROP TABLE contacts;\n" } }, { classify })).toMatchObject({ reasonCode: "migration_destructive" });
    expect(asked).toBe(0);
  });

  it("(c) an additive migration: the veto passes, still developer (classify)", async () => {
    const { gate } = await gateFixture();
    const g = await gate({ api: { "migrations/0002_phone.sql": "ALTER TABLE contacts ADD COLUMN phone TEXT;\nCREATE INDEX contacts_name ON contacts (name);\n" } });
    expect(g).toMatchObject({ level: "developer", pathLevel: "classify", reasonCode: "classifier_unavailable", veto: { kind: "additive", offending: [] }, classifier: { asked: true } });
  });

  it("(d) a DROP migration: developer, migration_destructive, offending names the statement", async () => {
    const { gate } = await gateFixture();
    const g = await gate({ api: { "migrations/0002_drop.sql": "CREATE TABLE t (id INTEGER);\nDROP TABLE contacts;\n" } });
    expect(g).toMatchObject({ level: "developer", pathLevel: "classify", reasonCode: "migration_destructive", classifier: { asked: false, reason: "not_needed" } });
    expect(g.veto).toEqual({ kind: "destructive", offending: [{ file: "api/migrations/0002_drop.sql", statement: "DROP TABLE contacts" }] });
  });

  it("(d2) a destructive migration vetoes even a self path level", async () => {
    const { gate, both } = await gateFixture();
    const staging = { ...both.staging, promotion: { ...both.staging.promotion, rules: [{ paths: ["**"], level: "self" as const }] } };
    const g = await gate({ api: { "migrations/0002_drop.sql": "DROP TABLE contacts;\n" } }, { staging });
    expect(g).toMatchObject({ level: "developer", pathLevel: "self", reasonCode: "migration_destructive", veto: { kind: "destructive" } });
  });

  it("(e) an unmatched path: developer_paths", async () => {
    const { gate } = await gateFixture();
    const g = await gate({ api: { "wrangler.jsonc": "{}\n" } });
    expect(g).toMatchObject({ level: "developer", pathLevel: "developer", reasonCode: "developer_paths", classifier: { asked: false } });
    expect(g.perPath).toEqual([{ path: "api/wrangler.jsonc", level: "developer", rule: null }]);
  });

  it("(f) a read error while gating: developer, gate_error", async () => {
    const { f, gate } = await gateFixture();
    f.h.artifacts.readFile = async () => {
      throw new Error("artifacts unavailable");
    };
    const g = await gate({ api: { "migrations/0002_phone.sql": "ALTER TABLE contacts ADD COLUMN phone TEXT;\n" } });
    expect(g).toMatchObject({ level: "developer", pathLevel: "classify", reasonCode: "gate_error", veto: { kind: "destructive" } });
  });

  it("lints a migration in a release.migrations folder the staging section does not name", async () => {
    const { gate, f } = await gateFixture();
    const release = ReleasePolicySchema.parse({
      ...stagingReleasePolicy(f.o.orgId),
      environment: { api: { vars: {}, kvNamespaces: [], d1Databases: [{ binding: "PROD", id: "0123abcd-0000-4000-8000-000000000000" }] } },
      migrations: [{ targetId: "api", binding: "PROD", dir: "db/prod" }],
    });
    const additive = await gate({ api: { "db/prod/0001_init.sql": "CREATE TABLE orders (id INTEGER PRIMARY KEY);\n" } }, { release });
    expect(additive).toMatchObject({ reasonCode: "classifier_unavailable", veto: { kind: "additive" } });
    const destructive = await gate({ api: { "db/prod/0001_init.sql": "DELETE FROM contacts;\n" } }, { release });
    expect(destructive).toMatchObject({ level: "developer", reasonCode: "migration_destructive" });
    expect(destructive.veto.offending).toEqual([{ file: "api/db/prod/0001_init.sql", statement: "DELETE FROM contacts" }]);
  });

  it("an edited or removed existing migration is destructive", async () => {
    const { gate } = await gateFixture();
    const edited = await gate({ api: { "migrations/0001_init.sql": "CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT, x TEXT);\n" } });
    expect(edited).toMatchObject({ reasonCode: "migration_destructive", veto: { offending: [{ file: "api/migrations/0001_init.sql", statement: "(existing migration changed)" }] } });
    const removed = await gate({ api: { "migrations/0001_init.sql": null } });
    expect(removed).toMatchObject({ reasonCode: "migration_destructive", veto: { offending: [{ file: "api/migrations/0001_init.sql", statement: "(existing migration removed)" }] } });
  });

  it("a migration that is not UTF-8 is destructive", async () => {
    const { f, gate } = await gateFixture();
    const read = f.h.artifacts.readFile.bind(f.h.artifacts);
    f.h.artifacts.readFile = async (ns, repo, ref, path) => (path.endsWith("0002_bin.sql") ? new Uint8Array([0x43, 0x52, 0xff, 0xfe, 0x3b]) : read(ns, repo, ref, path));
    const g = await gate({ api: { "migrations/0002_bin.sql": "placeholder" } });
    expect(g).toMatchObject({ level: "developer", reasonCode: "migration_destructive" });
    expect(g.veto.offending).toEqual([{ file: "api/migrations/0002_bin.sql", statement: "(not UTF-8 text)" }]);
  });

  it("a migration folder over the caps is destructive", async () => {
    const { gate } = await gateFixture();
    const many: Changes = {};
    for (let i = 2; i <= 51; i++) many[`migrations/${String(i).padStart(4, "0")}_t${i}.sql`] = `CREATE TABLE t${i} (id INTEGER);\n`;
    const tooMany = await gate({ api: many });
    expect(tooMany).toMatchObject({ reasonCode: "migration_destructive", veto: { kind: "destructive", offending: [{ file: "api/migrations", statement: "(migration folder too large to check)" }] } });
    const big = await gate({ api: { "migrations/0002_big.sql": `CREATE TABLE big (id INTEGER);\n-- ${"x".repeat(256 * 1024)}\n` } });
    expect(big).toMatchObject({ reasonCode: "migration_destructive", veto: { offending: [{ file: "api/migrations", statement: "(migration folder too large to check)" }] } });
  });

  it("keeps a migration whose name is an Object.prototype key (null-prototype inputs)", async () => {
    const { gate, onMain } = await gateFixture();
    await onMain({ "migrations/__proto__.sql": "CREATE TABLE p (id INTEGER);\n" });
    const removed = await gate({ api: { "migrations/__proto__.sql": null } });
    expect(removed).toMatchObject({ reasonCode: "migration_destructive", veto: { offending: [{ file: "api/migrations/__proto__.sql", statement: "(existing migration removed)" }] } });
    const added = await gate({ api: { "migrations/toString.sql": "DROP TABLE p;\n" } });
    expect(added.veto.offending).toEqual([{ file: "api/migrations/toString.sql", statement: "DROP TABLE p" }]);
  });

  it("ignores files that are not .sql directly in the folder", async () => {
    const { gate } = await gateFixture();
    const g = await gate({ api: { "migrations/README.md": "DROP TABLE contacts;\n", "migrations/old/0001.sql": "DROP TABLE contacts;\n" } });
    expect(g).toMatchObject({ reasonCode: "classifier_unavailable", veto: { kind: "additive", offending: [] } });
  });

  it("gates every mount name of a resource mounted twice: the strictest wins", async () => {
    const { gate, ids } = await gateFixture();
    const resourceByMount = new Map([
      ["api", ids.api],
      ["website", ids.website],
      ["mirror", ids.website],
    ]);
    const g = await gate({ website: { "index.html": "<h1>Hello</h1>\n" } }, { resourceByMount });
    expect(g).toMatchObject({ level: "developer", pathLevel: "developer", reasonCode: "developer_paths" });
    expect(g.perPath).toEqual([
      { path: "website/index.html", level: "self", rule: 0 },
      { path: "mirror/index.html", level: "developer", rule: null },
    ]);
  });

  it("fails closed when a release target's mount is not a project mount (never skips its migrations)", async () => {
    const { gate, ids, both } = await gateFixture();
    // the api resource mounted as "backend" while the release target builds mount "api"
    const resourceByMount = new Map([
      ["backend", ids.api],
      ["website", ids.website],
    ]);
    const staging = { ...both.staging, promotion: { ...both.staging.promotion, rules: [{ paths: ["backend/**", "website/**"], level: "self" as const }] } };
    const drop = await gate({ api: { "migrations/0002_drop.sql": "DROP TABLE contacts;\n" } }, { staging, resourceByMount });
    expect(drop).toMatchObject({ level: "developer", pathLevel: "self", reasonCode: "gate_error" });
    const web = await gate({ website: { "index.html": "x\n" } }, { staging, resourceByMount });
    expect(web).toMatchObject({ level: "developer", reasonCode: "gate_error" });
  });

  it("a .sql entry that is not a regular file (by type or by git mode) is destructive", async () => {
    const { f, gate } = await gateFixture();
    const readTree = f.h.artifacts.readTree.bind(f.h.artifacts);
    f.h.artifacts.readTree = async (ns, repo, s) => (await readTree(ns, repo, s))?.map((i) => (i.name === "0002_link.sql" ? { ...i, mode: "120000" } : i.name === "0003_sub.sql" ? { ...i, type: "gitlink" as const, mode: "160000" } : i)) ?? null;
    const g = await gate({ api: { "migrations/0002_link.sql": "CREATE TABLE l (id INTEGER);\n", "migrations/0003_sub.sql": "CREATE TABLE s (id INTEGER);\n" } });
    expect(g).toMatchObject({ level: "developer", reasonCode: "migration_destructive" });
    expect(g.veto.offending).toEqual([
      { file: "api/migrations/0002_link.sql", statement: "(not a regular file: 120000)" },
      { file: "api/migrations/0003_sub.sql", statement: "(not a regular file: submodule)" },
    ]);
  });

  it("has a client text for every reason that needs a developer", () => {
    expect(GATE_REASON_TEXT).toEqual({
      developer_paths: "Changes files that need a developer's review.",
      migration_destructive: "Changes the database structure in a way that needs a developer.",
      classifier_declined: "Needs a developer's review.",
      classifier_unavailable: "Needs a developer's review.",
      gate_error: "Needs a developer's review.",
    });
    expect(CLASSIFIER_DECLINED_TEXT).toEqual({
      risk: "The automatic review could not confirm this change is low risk.",
      migration: "Changes the database structure in a way that needs a developer.",
      apiChange: "May change how the API works for existing callers.",
      authOrPayments: "Touches sign-in or payments.",
      addressedToReviewer: "Needs a developer's review.",
    });
    expect(gateReasonText("classifier_declined")).toBe("Needs a developer's review.");
    expect(gateReasonText("classifier_unavailable", { asked: true, cleared: false, reason: "error" })).toBe("Needs a developer's review.");
  });
});
