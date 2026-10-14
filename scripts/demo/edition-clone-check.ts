/**
 * Recording aid for DEMO-SCRIPT 0:45–1:30 ("canonical clone denied, edition clone works"), with no
 * token on screen. Uses the client's own cforge session (read token on the edition repo only) and
 * the owner's session only to look up the canonical remote URL (clients never see it).
 *
 *   node scripts/demo/edition-clone-check.ts --api-url <url> --org <orgId> --session <edition session id> \
 *     --mount website --client-config-dir <dir> --owner-config-dir <dir> [--project <projectId>] [--out <dir>]
 *
 * Prints, for the camera:
 *   canonical website: git clone … DENIED (http 403/404)
 *   edition:           git clone … ok, N commit(s) (one, fresh history)
 * Tokens are passed to git through GIT_ASKPASS, never in argv or output.
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const a = process.argv.slice(2);
const opt = (n: string, d?: string) => (a.includes(n) ? a[a.indexOf(n) + 1]! : d);
const api = new URL(opt("--api-url") ?? "").origin;
const org = opt("--org")!;
const sid = opt("--session")!;
const mount = opt("--mount", "website")!;
if (!org || !sid || !opt("--client-config-dir") || !opt("--owner-config-dir")) {
  console.error("usage: see the header of scripts/demo/edition-clone-check.ts");
  process.exit(2);
}
const session = async (dir: string) => (JSON.parse(await readFile(join(dir, "session.json"), "utf8")) as { sessionToken: string }).sessionToken;
const call = async (bearer: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}`);
  return r.json() as Promise<any>;
};

const clientTok = await session(opt("--client-config-dir")!);
const ownerTok = await session(opt("--owner-config-dir")!);
const O = `/api/orgs/${encodeURIComponent(org)}`;
const sess = await call(clientTok, "GET", `${O}/edition-sessions/${encodeURIComponent(sid)}`);
const pid = opt("--project", sess.projectId)!;
const project = await call(ownerTok, "GET", `${O}/projects/${encodeURIComponent(pid)}`);
const rid = project.mounts.find((m: any) => m.mountName === mount)?.resourceId;
const canonical = (await call(ownerTok, "GET", `${O}/resources/${encodeURIComponent(rid)}`)).coords.remoteUrl as string;
const cred = await call(clientTok, "POST", `${O}/edition-sessions/${encodeURIComponent(sid)}/credential`, {});

const work = await mkdtemp(join(tmpdir(), "cf-clone-check-"));
const askpass = join(work, "askpass.sh");
await writeFile(askpass, '#!/bin/sh\ncase "$1" in Username*) echo x-token ;; *) printf %s "$CF_EDITION_TOKEN" ;; esac\n');
await chmod(askpass, 0o700);
const env = { PATH: process.env.PATH ?? "", HOME: work, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpass, CF_EDITION_TOKEN: cred.secret };
const git = (args: string[], cwd = work) => pexec("git", ["-c", "credential.helper=", ...args], { cwd, env });
const user = (u: string) => {
  const x = new URL(u);
  x.username = "x-token";
  return x.toString();
};

try {
  try {
    await git(["clone", "-q", user(canonical), join(work, "canonical")]);
    console.log(`canonical ${mount}: git clone … ALLOWED (unexpected!)`);
    process.exitCode = 1;
  } catch (e: any) {
    const m = /(\b40[134]\b|not found|denied|Authentication failed)/i.exec(String(e.stderr ?? ""));
    console.log(`canonical ${mount}: git clone with the client's token … DENIED${m ? ` (${m[1]})` : ""}`);
  }
  const out = opt("--out", join(work, "edition"))!;
  await git(["clone", "-q", user(cred.remoteUrl), out]);
  const log = (await git(["log", "--oneline"], out)).stdout.trim().split("\n");
  console.log(`edition:  git clone with the same token … ok, ${log.length} commit(s): ${log.join(" | ")}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
