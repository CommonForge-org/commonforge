/**
 * Agent 2 through a client Workspace Edition (Task 21 API, apps/worker/API.md "Editions"):
 *
 * 1. As the owner: find or create the website-only edition (fixtures/README.md "Website edition
 *    policy"), publish a fresh build of the current accepted website, grant it to the client.
 * 2. As the client: "Start an update" (edit session), download the edition ZIP and unpack it into
 *    `<dir>/ws/<website mount>/` — no git, no canonical access, no api source.
 * 3. The agent edits the folder (same prompt and dry-run edits as the task stand-in).
 * 4. As the client: send back a partial ZIP of the changed files (deletions as explicit intents);
 *    the server maps it, the runner makes a candidate in a fresh task workspace, and a proposal
 *    opens. The owner then reads the return's developer view for the task id.
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readZip, writeZip } from "./edition-zip.js";
import { ApiError, type OwnerApi } from "./owner-api.js";
import { sleep } from "./proc.js";

export const DEMO_EDITION_NAME = "Website pages (client edition)";

/** fixtures/README.md "Website edition policy (client edition, Task 21)". */
export function websiteEditionPolicy(mountName: string) {
  return {
    name: DEMO_EDITION_NAME,
    sources: [
      {
        mountName,
        include: ["index.html", "src/**", "public/**", "tests/quote-view.test.ts", "tests/json-schema.test.ts", "package.json", "vite.config.ts", "tsconfig.json"],
        write: ["index.html", "src", "public", "tests"],
      },
    ],
    protectedPaths: ["package.json", "vite.config.ts", "tsconfig.json", "wrangler.jsonc", "tests/quote-contract.test.ts"],
  };
}

interface EditionView {
  editionId: string;
  name: string;
  state: string;
  ready: boolean;
  builds?: Array<{ buildId: string; state: string; error?: string }>;
}

export interface ReturnView {
  returnId: string;
  state: string;
  changes: Array<{ path: string; kind: string; oldPath?: string }>;
  blocked: Array<{ path: string; reason: string }>;
  proposalId: string | null;
  error?: { code: string; message: string };
  taskId?: string;
}

export interface EditionPrep {
  editionId: string;
  sessionId: string;
  /** the user who edits: the client, or the owner when no client session is configured */
  actor: "client" | "owner";
  workspaceRoot: string;
  mountDir: string;
  original: Map<string, Uint8Array>;
}

export interface EditionOptions {
  owner: OwnerApi;
  client?: OwnerApi;
  orgId: string;
  projectId: string;
  mountName: string;
  /** agent 2's run directory; the edition is unpacked into `<dir>/ws/<mountName>/` */
  dir: string;
  title: string;
  request: string;
  pollMs?: number;
  timeoutMs?: number;
  log: (line: string) => void;
}

const enc = encodeURIComponent;
const TERMINAL = new Set(["proposed", "no_changes", "stale", "conflict", "refused", "failed"]);

async function poll<T>(what: string, fn: () => Promise<T>, done: (v: T) => boolean, o: EditionOptions): Promise<T> {
  const deadline = Date.now() + (o.timeoutMs ?? 10 * 60_000);
  for (;;) {
    const v = await fn();
    if (done(v)) return v;
    if (Date.now() > deadline) throw new Error(`${what}: timed out`);
    await sleep(o.pollMs ?? 1000);
  }
}

/** Steps 1–2: edition published and granted, session started, working copy unpacked. */
export async function prepareClientEdition(o: EditionOptions): Promise<EditionPrep> {
  const base = `/api/orgs/${enc(o.orgId)}`;
  const list = await o.owner.request<{ editions: EditionView[] }>("GET", `${base}/projects/${enc(o.projectId)}/editions`);
  let ed = list.editions.find((e) => e.name === DEMO_EDITION_NAME);
  if (!ed) ed = await o.owner.request<EditionView>("POST", `${base}/projects/${enc(o.projectId)}/editions`, websiteEditionPolicy(o.mountName));
  // publish the current accepted website (a fresh, single-commit edition)
  const build = await o.owner.request<{ buildId: string }>("POST", `${base}/editions/${enc(ed.editionId)}/builds`, {});
  const built = await poll(
    "edition build",
    () => o.owner.request<EditionView>("GET", `${base}/editions/${enc(ed!.editionId)}`),
    (v) => (v.builds ?? []).some((b) => b.buildId === build.buildId && b.state !== "queued"),
    o,
  );
  const b = built.builds!.find((x) => x.buildId === build.buildId)!;
  if (b.state !== "ready") throw new Error(`edition build failed: ${b.error ?? b.state}`);
  o.log(`agent-2: edition ${ed.editionId} published (build ${build.buildId})`);

  const user = o.client ?? o.owner;
  if (o.client) {
    const me = await o.client.request<{ user: { userId: string } }>("GET", "/api/me");
    await o.owner.request("PUT", `${base}/editions/${enc(ed.editionId)}/grants`, { userId: me.user.userId });
  }
  const session = await user.request<{ sessionId: string; downloadUrl: string }>("POST", `${base}/editions/${enc(ed.editionId)}/sessions`, { title: o.title, request: o.request });
  const zip = await user.download(session.downloadUrl);
  const original = readZip(zip);
  const workspaceRoot = join(o.dir, "ws");
  const mountDir = join(workspaceRoot, o.mountName);
  await unpack(mountDir, original);
  o.log(`agent-2: started update ${session.sessionId}; working copy has ${original.size} file(s), no git and no api source`);
  return { editionId: ed.editionId, sessionId: session.sessionId, actor: o.client ? "client" : "owner", workspaceRoot, mountDir, original };
}

async function unpack(dir: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  for (const [path, data] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), data);
  }
}

/** Put the working copy back as downloaded (before an agent retry). */
export async function resetEditionCopy(prep: EditionPrep): Promise<void> {
  await unpack(prep.mountDir, prep.original);
}

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** The files the agent changed or added, and the published files it deleted. */
export async function editionDelta(prep: EditionPrep): Promise<{ changed: Map<string, Uint8Array>; deleted: string[] }> {
  const changed = new Map<string, Uint8Array>();
  const present = new Set(await walk(prep.mountDir));
  for (const path of present) {
    const now = new Uint8Array(await readFile(join(prep.mountDir, path)));
    const before = prep.original.get(path);
    if (!before || Buffer.compare(Buffer.from(before), Buffer.from(now)) !== 0) changed.set(path, now);
  }
  const deleted = [...prep.original.keys()].filter((p) => !present.has(p)).sort();
  return { changed, deleted };
}

/** Steps 4: send back a partial ZIP and wait for the proposal. */
export async function returnClientEdition(o: EditionOptions, prep: EditionPrep, tool: string): Promise<ReturnView> {
  const user = o.client ?? o.owner;
  const { changed, deleted } = await editionDelta(prep);
  if (changed.size === 0 && deleted.length === 0) throw new Error("the agent changed nothing in the edition");
  const q = new URLSearchParams({ mode: "partial", tool });
  for (const d of deleted) q.append("delete", d);
  const base = `/api/orgs/${enc(o.orgId)}`;
  let ret: ReturnView;
  try {
    ret = await user.upload<ReturnView>(`${base}/edition-sessions/${enc(prep.sessionId)}/returns?${q}`, writeZip(changed), "application/zip");
  } catch (e) {
    if (e instanceof ApiError && e.details?.blocked) throw new Error(`${e.message} (blocked: ${JSON.stringify(e.details.blocked)})`);
    throw e;
  }
  o.log(`agent-2: sent back ${changed.size} changed and ${deleted.length} deleted file(s): ${ret.changes.map((c) => `${c.kind} ${c.path}`).join(", ")}${ret.blocked.length ? `; blocked: ${ret.blocked.map((b) => `${b.path} (${b.reason})`).join(", ")}` : ""}`);
  const settled = await poll("edition return", () => user.request<ReturnView>("GET", `${base}/edition-returns/${enc(ret.returnId)}`), (v) => TERMINAL.has(v.state), o);
  if (settled.state !== "proposed") throw new Error(`edition return ${settled.state}: ${settled.error?.message ?? "no proposal"}`);
  // the developer view names the task the server created for the return
  const dev = await o.owner.request<ReturnView>("GET", `${base}/edition-returns/${enc(ret.returnId)}`);
  return { ...settled, ...(dev.taskId ? { taskId: dev.taskId } : {}) };
}
