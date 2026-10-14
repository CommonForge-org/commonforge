import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itemPath } from "../src/export.js";
import { ORG, PROJECT, git } from "./fake-commonforge.js";
import { harness, loginAs, type Harness } from "./helpers.js";

let h: Harness;
let apiRes: string;
beforeEach(async () => {
  h = harness();
  apiRes = h.world.addResource("api", { "src/quote.ts": "export const quote = 1;\n" }).resourceId;
  h.world.addResource("website", { "index.html": "<h1>hi</h1>\n" });
  h.world.addAssetResource("brand", { "logo.png": "PNG" });
  await loginAs(h);
});
afterEach(() => h.world.close());

describe("cforge export", () => {
  it("requests, waits, downloads the bundles + manifest, and the bundles clone", async () => {
    const r = await h.cli(["export", PROJECT, "--out", "exp", "--json"]);
    expect(r.code).toBe(0);
    const out = r.json();
    const dir = join(h.home, "exp");
    expect(out.out).toBe(dir);
    // the runner's layout: <resourceId>/<headSha>.bundle and <resourceId>/manifest-<manifestId>.json
    const expected = [...h.world.resources.values()].map((r) => (r.provider === "r2-assets" ? `${r.resourceId}/manifest-${r.manifest!.manifestId}.json` : `${r.resourceId}/${h.world.canonicalHead(r.resourceId)}.bundle`));
    expect(out.files.map((f: { path: string }) => f.path).sort()).toEqual([...expected, "project.json"].sort());
    expect(readdirSync(dir).sort()).toEqual([...[...h.world.resources.keys()], "manifest.json", "project.json"].sort());
    expect(out.files.find((f: { kind: string }) => f.kind === "asset-manifest")).toMatchObject({ manifestId: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ exportId: out.exportId, projectId: PROJECT, receipt: { exportId: out.exportId } });
    // at least one poll saw "queued" before "succeeded"
    expect(h.world.calls.filter((c) => c.path === `/api/orgs/${ORG}/exports/${out.exportId}`).length).toBe(2);
    const clone = join(h.home, "restored");
    git(["clone", "-q", join(dir, apiRes, `${h.world.canonicalHead(apiRes)}.bundle`), clone], h.home);
    expect(readFileSync(join(clone, "src/quote.ts"), "utf8")).toBe("export const quote = 1;\n");
    expect(git(["rev-parse", "HEAD"], clone)).toBe(h.world.canonicalHead(apiRes));
  });

  it("refuses a bundle whose sha256 does not match the receipt", async () => {
    const r1 = await h.cli(["export", PROJECT, "--no-wait", "--json"]);
    const exportId = r1.json().exportId;
    const x = h.world.exports.get(exportId)!;
    const key = [...x.blobs.keys()].find((k) => k.endsWith(".bundle"))!;
    x.blobs.set(key, new TextEncoder().encode("tampered"));
    const r = await h.cli(["export", PROJECT, "--export-id", exportId, "--out", "bad", "--json"]);
    expect(r.code).toBe(1);
    expect(r.json().error.code).toBe("export_hash_mismatch");
  });

  it("reports a failed export and refuses unsafe item paths", async () => {
    h.world.overrides.set("GET /api/orgs/[^/]+/exports/[^/]+", () => ({ status: 200, body: { exportId: "exp-1", projectId: PROJECT, state: "failed", snapshot: {}, receipt: null, downloads: [], error: "runner_failed: boom" } }));
    const r = await h.cli(["export", PROJECT, "--export-id", "exp-1", "--json"]);
    expect(r.json().error).toMatchObject({ code: "export_failed" });
    expect(() => itemPath("org/o/exports/exp-1/../../etc/passwd", "exp-1")).toThrow(/unsafe|refusing/);
    expect(() => itemPath("org/o/exports/exp-1/.git/config", "exp-1")).toThrow(/refusing/);
    expect(() => itemPath("org/o/exports/exp-1/res-1/.GIT/hooks/x", "exp-1")).toThrow(/refusing/);
    expect(itemPath("org/o/exports/exp-1/res-1/abc.bundle", "exp-1")).toBe("res-1/abc.bundle");
    expect(itemPath("org/o/exports/exp-1/res-1.bundle", "exp-1")).toBe("res-1.bundle");
  });

  async function exportWith(mutate: (x: NonNullable<ReturnType<typeof h.world.exports.get>>) => void) {
    const exportId = (await h.cli(["export", PROJECT, "--no-wait", "--json"])).json().exportId;
    mutate(h.world.exports.get(exportId)!);
    return h.cli(["export", PROJECT, "--export-id", exportId, "--out", "x", "--json"]);
  }

  it("refuses a bundle that does not contain the receipt's head, and leaves nothing behind", async () => {
    const r = await exportWith((x) => {
      const item = (x.receipt as { items: Array<{ kind: string; headSha?: string }> }).items.find((i) => i.kind === "git-bundle")!;
      item.headSha = "f".repeat(40);
    });
    expect(r.json().error.code).toBe("export_integrity");
    expect(existsSync(join(h.home, "x"))).toBe(false);
  });

  it("refuses an asset manifest that does not hash to its id", async () => {
    const r = await exportWith((x) => {
      const key = [...x.blobs.keys()].find((k) => k.includes("/manifest-"))!;
      const m = JSON.parse(new TextDecoder().decode(x.blobs.get(key)!));
      m.entries[0].size = 999;
      x.blobs.set(key, new TextEncoder().encode(JSON.stringify(m)));
    });
    expect(r.json().error.code).toBe("export_integrity");
  });

  it("refuses a receipt for another snapshot", async () => {
    const r = await exportWith((x) => {
      (x.receipt as { snapshotId: string }).snapshotId = "0".repeat(64);
    });
    expect(r.json().error.code).toBe("export_integrity");
  });
});
