/**
 * `cforge export <projectId>` (plan §B.10, AT-24): request an export (`POST …/exports`, a runner
 * job writes git bundles + asset manifests), wait for it, download every receipt item, check the
 * bundles' sha256 against the receipt, and write `manifest.json` (snapshot + receipt) next to them.
 * Reconstruction needs only git: `git clone <bundle>`.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AssetManifestSchema, ExportReceiptSchema, ProjectSnapshotSchema, checkPath, computeAssetManifestIdSync, computeSnapshotIdSync, type ExportItem, type ExportReceipt } from "@commonforge-org/core";
import { sessionClient } from "./api.js";
import { int, parse, positional, str, type CommandContext } from "./command.js";
import { CliError } from "./context.js";
import { gitOk } from "./git.js";
import { orgFor } from "./project.js";

const USAGE = "cforge export <projectId> [--out <dir>] [--export-id <id>] [--no-wait] [--timeout <seconds>] [--org <org>] [--json]";

interface ExportView {
  exportId: string;
  projectId: string;
  state: "queued" | "succeeded" | "failed";
  snapshot: unknown;
  receipt: unknown;
  downloads: string[];
  error?: string;
}

/** Returns whether the directory was created (so a failed export can remove it again). */
async function ensureEmptyDir(dir: string): Promise<boolean> {
  try {
    if ((await readdir(dir)).length > 0) throw new CliError("output_not_empty", `${dir} is not empty`);
    return false;
  } catch (e) {
    if (e instanceof CliError) throw e;
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  }
  await mkdir(dir, { recursive: true });
  return true;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Check one downloaded item against the receipt (bytes are written only after this passes, except bundles, which git reads from disk). */
function checkAssetManifest(item: Extract<ExportItem, { kind: "asset-manifest" }>, bytes: Uint8Array, rel: string): void {
  let m;
  try {
    m = AssetManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new CliError("export_integrity", `${rel}: not a valid asset manifest`);
  }
  const recomputed = computeAssetManifestIdSync({ resourceId: m.resourceId, parentManifestId: m.parentManifestId, entries: m.entries });
  if (m.manifestId !== item.manifestId || recomputed !== item.manifestId || m.resourceId !== item.resourceId || m.entries.length !== item.objects) {
    throw new CliError("export_integrity", `${rel}: manifest does not match the receipt (id ${item.manifestId})`);
  }
}

/** Local path of an item: its key below the export prefix, validated as a safe relative path. */
export function itemPath(r2Key: string, exportId: string): string {
  const i = r2Key.indexOf(`/exports/${exportId}/`);
  const rel = i >= 0 ? r2Key.slice(i + `/exports/${exportId}/`.length) : r2Key.split("/").pop()!;
  const r = checkPath(rel);
  if (!r.ok || r.path !== rel || rel === "manifest.json" || rel.split("/").some((seg) => seg.toLowerCase() === ".git")) throw new CliError("unsafe_path", `refusing export item path ${JSON.stringify(rel)}`);
  return rel;
}

export async function exportCommand(ctx: CommandContext, args: readonly string[]): Promise<void> {
  const p = parse(args, { out: { type: "string" }, "export-id": { type: "string" }, "no-wait": { type: "boolean" }, timeout: { type: "string" } }, USAGE);
  const projectId = positional(p, 0, "projectId", USAGE);
  const { api } = await sessionClient(ctx.io, ctx.store, ctx.global.apiUrl);
  const org = encodeURIComponent(await orgFor(ctx, api));

  let exportId = str(p, "export-id");
  if (!exportId) {
    const r = await api.post<{ exportId: string; snapshotId: string; jobId: string; state: string }>(`/api/orgs/${org}/projects/${encodeURIComponent(projectId)}/exports`);
    exportId = r.exportId;
    ctx.out.info(`Requested export ${exportId} of snapshot ${r.snapshotId}.`);
  }
  if (p.values["no-wait"]) {
    ctx.out.result({ exportId, state: "queued" }, `Export ${exportId} requested. Download it later with: cforge export ${projectId} --export-id ${exportId}`);
    return;
  }

  const deadline = ctx.io.now().getTime() + (int(p, "timeout") ?? 600) * 1000;
  let view: ExportView;
  for (let delay = 1000; ; delay = Math.min(delay * 1.5, 10_000)) {
    view = await api.get<ExportView>(`/api/orgs/${org}/exports/${encodeURIComponent(exportId)}`);
    if (view.projectId !== projectId) throw new CliError("invalid_request", `export ${exportId} belongs to project ${view.projectId}`);
    if (view.state !== "queued") break;
    if (ctx.io.now().getTime() + delay > deadline) throw new CliError("export_timeout", `export ${exportId} is still queued; retry with --export-id ${exportId}`, { exportId });
    await ctx.io.sleep(delay);
  }
  if (view.state === "failed") throw new CliError("export_failed", `export ${exportId} failed: ${view.error ?? "unknown error"}`, { exportId });
  const receipt: ExportReceipt = (() => {
    const r = ExportReceiptSchema.safeParse(view.receipt);
    if (!r.success || r.data.exportId !== exportId) throw new CliError("invalid_response", "the export receipt is invalid");
    return r.data;
  })();

  // the receipt must be for the snapshot the export reports, and that snapshot must hash to its id
  const snap = ProjectSnapshotSchema.safeParse(view.snapshot);
  if (!snap.success || snap.data.snapshotId !== receipt.snapshotId || computeSnapshotIdSync(snap.data) !== receipt.snapshotId) {
    throw new CliError("export_integrity", `export ${exportId}: the receipt's snapshot ${receipt.snapshotId} does not match the export's snapshot`);
  }

  const out = resolve(ctx.io.cwd, str(p, "out") ?? `commonforge-export-${exportId}`);
  const created = await ensureEmptyDir(out);
  const files: Array<{ path: string; kind: string; bytes: number; resourceId?: string; headSha?: string; manifestId?: string }> = [];
  try {
    for (const item of receipt.items) {
      const rel = itemPath(item.r2Key, exportId);
      const res = await api.request("GET", `/api/orgs/${org}/exports/${encodeURIComponent(exportId)}/download?key=${encodeURIComponent(item.r2Key)}`, undefined, { accept: "application/octet-stream" });
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (item.kind === "git-bundle" && sha256(bytes) !== item.sha256) throw new CliError("export_hash_mismatch", `${rel}: sha256 ${sha256(bytes)} != receipt ${item.sha256}`);
      if (item.kind === "asset-manifest") checkAssetManifest(item, bytes, rel);
      const dest = join(out, rel);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, bytes, { flag: "wx" });
      if (item.kind === "git-bundle") {
        const heads = await gitOk(ctx.git, ["bundle", "list-heads", dest], out);
        if (!heads.split("\n").some((l) => l.split(" ")[0] === item.headSha)) throw new CliError("export_integrity", `${rel}: the bundle does not contain the receipt's head ${item.headSha}`);
      }
      files.push({
        path: rel,
        kind: item.kind,
        bytes: bytes.length,
        ...("resourceId" in item ? { resourceId: item.resourceId } : {}),
        ...(item.kind === "git-bundle" ? { headSha: item.headSha } : {}),
        ...(item.kind === "asset-manifest" ? { manifestId: item.manifestId } : {}),
      });
    }
  } catch (e) {
    // never leave a partial export behind
    if (created) await rm(out, { recursive: true, force: true });
    else for (const name of await readdir(out).catch(() => [])) await rm(join(out, name), { recursive: true, force: true });
    throw e;
  }
  const manifest = { $schema: "cf.export/1", exportId, projectId: view.projectId, snapshot: view.snapshot, receipt, files };
  await writeFile(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  ctx.out.result({ exportId, out, files, manifest: join(out, "manifest.json") }, () =>
    [`Export ${exportId} downloaded to ${out}:`, ...files.map((f) => `  ${f.path} (${f.kind}, ${f.bytes} bytes)`), "  manifest.json", "Restore a repository with: git clone <bundle> <dir>"].join("\n"),
  );
}
