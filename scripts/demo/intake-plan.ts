/**
 * Recording aid for DEMO-SCRIPT 0:00–0:45 ("Add files" → intake dry-run inventory). The web app has
 * no intake screen and cforge no intake command yet, so this uploads a folder as a ZIP with the
 * owner's cforge session (`POST /api/orgs/:org/intake/zip`), waits for the runner's inventory, and
 * prints the placement plan: nested repos, excluded paths (node_modules, .git, build output),
 * blocked credential-looking files (name only), and large media routed to an R2 collection.
 * It does NOT confirm the intake (nothing is created).
 *
 *   node scripts/demo/intake-plan.ts --api-url <url> --org <orgId> --config-dir <owner cforge dir> <folder>
 *   node scripts/demo/intake-plan.ts … --make-mess <dir>   build the demo "mess" folder first (fixtures
 *       website + api as nested git repos, node_modules, a fake .env, brand-assets with a large video)
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile, cp, stat } from "node:fs/promises";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { writeZip } from "../../apps/demo-agents/dist/edition-zip.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pexec = promisify(execFile);
const a = process.argv.slice(2);
const opt = (n: string) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
const api = new URL(opt("--api-url") ?? "").origin;
const org = opt("--org");
const configDir = opt("--config-dir");
const mess = opt("--make-mess");
const folder = mess ?? a.filter((x, i) => !x.startsWith("--") && !a[i - 1]?.startsWith("--")).pop();
if (!org || !configDir || !folder) {
  console.error("usage: see the header of scripts/demo/intake-plan.ts");
  process.exit(2);
}

async function makeMess(dir: string, videoMb: number): Promise<void> {
  const env = { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
  for (const name of ["website", "api"]) {
    const files = (await pexec("git", ["ls-files", `fixtures/${name}`], { cwd: REPO })).stdout.split("\n").filter(Boolean);
    for (const f of files) {
      const to = join(dir, `${name}-repo`, f.slice(`fixtures/${name}/`.length));
      await mkdir(dirname(to), { recursive: true });
      await cp(join(REPO, f), to);
    }
    const g = (...x: string[]) => pexec("git", ["-c", "user.name=Client", "-c", "user.email=client@example.invalid", "-c", "commit.gpgsign=false", ...x], { cwd: join(dir, `${name}-repo`), env });
    await g("init", "-q", "-b", "main");
    await g("add", "-A");
    await g("commit", "-q", "-m", "prototype");
    await mkdir(join(dir, `${name}-repo`, "node_modules", "left-pad"), { recursive: true });
    await writeFile(join(dir, `${name}-repo`, "node_modules", "left-pad", "index.js"), "module.exports = (s) => s;\n");
  }
  await writeFile(join(dir, "api-repo", ".env"), "STRIPE_SECRET_KEY=sk_test_not_a_real_key_0000000000\n");
  await mkdir(join(dir, "brand"), { recursive: true });
  await cp(join(REPO, "fixtures/brand-assets/logo.png"), join(dir, "brand", "logo.png"));
  // a large media file (default 40 MiB: over the 32 MiB Artifacts blob limit, inside the 100 MiB upload cap)
  const video = Buffer.alloc(videoMb * 1024 * 1024);
  for (let i = 0; i < video.length; i += 4096) video.writeUInt32LE((i * 2654435761) >>> 0, i);
  await writeFile(join(dir, "brand", "brand-video.mp4"), video);
}

async function walk(root: string, dir = root, out = new Map<string, Uint8Array>()): Promise<Map<string, Uint8Array>> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(root, p, out);
    else if (e.isFile()) out.set(relative(root, p).split("\\").join("/"), new Uint8Array(await readFile(p)));
  }
  return out;
}

if (mess) {
  await mkdir(mess, { recursive: true });
  if ((await readdir(mess)).length === 0) await makeMess(mess, Number(opt("--video-mb") ?? 40));
}
const token = (JSON.parse(await readFile(join(configDir, "session.json"), "utf8")) as { sessionToken: string }).sessionToken;
const files = await walk(folder);
const zip = writeZip(files);
const O = `/api/orgs/${encodeURIComponent(org)}`;
const h = { authorization: `Bearer ${token}`, accept: "application/json" };
console.log(`Uploading ${files.size} files (${(zip.byteLength / 1048576).toFixed(1)} MiB) from ${folder} …`);
const up = await fetch(`${api}${O}/intake/zip?name=${encodeURIComponent(`${folder.split("/").pop()}.zip`)}`, { method: "POST", headers: { ...h, "content-type": "application/zip", "content-length": String(zip.byteLength) }, body: zip });
if (up.status !== 202) throw new Error(`intake upload → ${up.status} ${await up.text()}`);
const { intakeId } = (await up.json()) as { intakeId: string };
let v: any;
for (let i = 0; i < 180; i++) {
  v = await (await fetch(`${api}${O}/intake/${intakeId}`, { headers: h })).json();
  if (v.plan || v.state === "failed") break;
  await new Promise((r) => setTimeout(r, 2000));
}
if (!v.plan) throw new Error(`intake ${intakeId}: ${v.state} ${JSON.stringify(v.error ?? "")}`);
console.log(`\nIntake ${intakeId}: dry-run plan (nothing created until you confirm)\n`);
for (const p of v.plan.placements) console.log(`  → ${p.provider === "r2-assets" ? "R2 collection" : "Git resource"}  ${p.resourceName.padEnd(16)} ${String(p.files).padStart(4)} files  ${(p.bytes / 1048576).toFixed(1).padStart(6)} MiB   ${p.reason ?? ""}`);
console.log("");
for (const x of v.plan.excluded) console.log(`  ✗ ${x.path.padEnd(40)} ${x.reason}`);
if (process.env.INTAKE_PLAN_JSON) await writeFile(process.env.INTAKE_PLAN_JSON, JSON.stringify(v, null, 2));
void stat;
