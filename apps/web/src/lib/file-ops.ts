/**
 * File operations of the Files tab (spec §8): path rules, the browser's limits, generated change
 * titles, op builders, edit-in-place eligibility, and turning a drop or a file input into
 * `{ file, relPath }` pairs. No React, no I/O beyond reading the dropped entries: unit-tested directly.
 */
import { checkPath, hasAlwaysProtectedSegment } from "@commonforge-org/core";
import type { FileChangeOp, Mount } from "../api/types.js";
import { basename, looksLikeText } from "./model.js";

/** The same numbers as the Worker's `APPLY_FILES_LIMITS`: checked here before anything is sent. */
export const LIMITS = { maxFileBytes: 5_000_000_000, maxOps: 1000, maxChangeBytes: 20_000_000_000, maxEditBytes: 1_048_576 } as const;

/** The Worker's `MAX_PATH_CHARS` (`routes/uploads.ts`). */
const MAX_PATH_CHARS = 1024;

const segments = (p: string) => p.split("/").filter((s) => s !== "" && s !== ".");

/**
 * `dir` + `rel`, normalised: NFC (a name picked on macOS arrives decomposed, and the Worker keeps
 * only the NFC spelling), no leading, trailing or doubled slashes, no `.` segments. `..` is kept,
 * for `checkFilePath` to refuse.
 */
export function joinPath(dir: string, rel: string): string {
  return [...segments(dir), ...segments(rel)].join("/").normalize("NFC");
}

const parentDir = (path: string) => {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
};

const shownDir = (dir: string) => joinPath(dir, "") || "/";

const VIOLATION: Record<string, string> = {
  nul: "contains a NUL character",
  control_char: "contains a control character",
  backslash: "contains a backslash",
  absolute: "starts with /",
  drive_letter: "starts with a drive letter",
  dot_dot: "contains ..",
  empty: "is empty",
  too_long: `is longer than ${MAX_PATH_CHARS} characters`,
};

/**
 * A path a file may be uploaded to, by the Worker's `uploadPath` rules: already normalised,
 * relative, at most 1,024 characters, never under `.git`, `.commonforge` or `.vibecontrol`.
 */
export function checkFilePath(path: string): { ok: true } | { ok: false; reason: string } {
  if (path.length > MAX_PATH_CHARS) return { ok: false, reason: VIOLATION.too_long! };
  const r = checkPath(path);
  if (!r.ok) return { ok: false, reason: VIOLATION[r.violation] ?? "is not a valid file path" };
  if (path !== path.normalize("NFC")) return { ok: false, reason: "is not in Unicode normal form (NFC)" };
  if (r.path !== path) return { ok: false, reason: "has empty or . segments, or a trailing /" };
  if (hasAlwaysProtectedSegment(path)) return { ok: false, reason: "is inside a protected folder (.git, .commonforge or .vibecontrol)" };
  return { ok: true };
}

const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** The Worker's bound on a change's title (`ChangeBody.title`: trimmed, 1 to 200 characters). */
export const TITLE_MAX = 200;

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/**
 * A title the server takes: trimmed, and over 200 characters (UTF-16 units, as the Worker counts)
 * cut in the middle with one "…", so the start ("Edited …") and the file name both stay. A
 * surrogate pair is never split.
 */
export function titleOf(raw: string): string {
  const t = raw.trim();
  if (t.length <= TITLE_MAX) return t;
  let head = Math.ceil((TITLE_MAX - 1) / 2);
  let tail = TITLE_MAX - 1 - head;
  if (isHigh(t.charCodeAt(head - 1))) head--;
  if (isLow(t.charCodeAt(t.length - tail))) tail--;
  return `${t.slice(0, head).trimEnd()}…${t.slice(t.length - tail).trimStart()}`;
}

/** "Uploaded 1 file to /", "Uploaded 30 files to videos/2026". */
export function uploadTitle(n: number, dir: string): string {
  return titleOf(`Uploaded ${files(n)} to ${shownDir(dir)}`);
}

/** One file uploaded over an existing path. */
export function replaceTitle(path: string): string {
  return titleOf(`Replaced ${path}`);
}

/** One move that changes the name: "Renamed a.txt to b.txt"; otherwise "Moved 3 files to media". */
export function moveTitle(moves: Array<{ from: string; to: string }>): string {
  const [first] = moves;
  if (!first) return "Moved 0 files";
  if (moves.length === 1 && basename(first.from) !== basename(first.to)) return titleOf(`Renamed ${first.from} to ${first.to}`);
  return titleOf(`Moved ${files(moves.length)} to ${shownDir(parentDir(first.to))}`);
}

export function deleteTitle(paths: string[]): string {
  return titleOf(paths.length === 1 ? `Deleted ${paths[0]}` : `Deleted ${files(paths.length)}`);
}

export function editTitle(path: string, isNew: boolean): string {
  return titleOf(`${isNew ? "Created" : "Edited"} ${path}`);
}

/**
 * Moves each path into `targetDir`, keeping its name. Paths already there are left out. Throws
 * when a folder would move into itself, or two paths would land on the same name.
 */
export function moveOps(paths: string[], targetDir: string): FileChangeOp[] {
  const target = joinPath(targetDir, "");
  const seen = new Set<string>();
  const ops: FileChangeOp[] = [];
  for (const from of paths) {
    if (target === from || target.startsWith(`${from}/`)) throw new Error(`cannot move ${from} into itself`);
    const to = joinPath(target, basename(from));
    if (seen.has(to)) throw new Error(`two of the items have the same name: ${basename(from)}`);
    seen.add(to);
    if (to !== from) ops.push({ move: from, to });
  }
  return ops;
}

export function renameOp(from: string, to: string): FileChangeOp {
  return { move: from, to };
}

export function deleteOps(paths: string[]): FileChangeOp[] {
  return paths.map((p) => ({ delete: p }));
}

const GB = (n: number) => `${n / 1_000_000_000} GB`;

/** The browser's check of a batch of uploads against the limits, before anything is sent. */
export function checkBatch(
  batch: Array<{ size: number }>,
): { ok: true } | { ok: false; code: "file_too_large" | "too_many_operations" | "change_too_large"; message: string } {
  if (batch.some((f) => f.size > LIMITS.maxFileBytes)) return { ok: false, code: "file_too_large", message: `Files are limited to ${GB(LIMITS.maxFileBytes)} each` };
  if (batch.length > LIMITS.maxOps) return { ok: false, code: "too_many_operations", message: `One change holds at most ${LIMITS.maxOps.toLocaleString("en-US")} files` };
  const total = batch.reduce((s, f) => s + f.size, 0);
  if (total > LIMITS.maxChangeBytes) return { ok: false, code: "change_too_large", message: `One change holds at most ${GB(LIMITS.maxChangeBytes)}` };
  return { ok: true };
}

/** Edit in place (spec §8): a writable git folder's file, not in LFS, under 1 MiB, with a text-like (or no telling) name. */
export function canEditInPlace(m: Mount, e: { size?: number; lfs?: boolean; path: string }): boolean {
  if (m.provider !== "artifacts" || m.canWrite !== true) return false;
  if (e.lfs) return false;
  if (e.size !== undefined && e.size >= LIMITS.maxEditBytes) return false;
  return looksLikeText(e.path);
}

// ------------------------------------------------------------------------------ picking files

export interface PickedFile {
  file: File;
  relPath: string;
}

/** The parts of the File and Directory Entries API a drop walk uses. */
interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface FileEntry extends Entry {
  file(ok: (f: File) => void, err?: (e: unknown) => void): void;
}
interface DirEntry extends Entry {
  createReader(): { readEntries(ok: (es: Entry[]) => void, err?: (e: unknown) => void): void };
}

const readFile = (e: FileEntry) => new Promise<File>((ok, err) => e.file(ok, err));

/** Every entry of a folder: `readEntries` answers in pages, and an empty page means the end. */
async function readAll(dir: DirEntry): Promise<Entry[]> {
  const reader = dir.createReader();
  const out: Entry[] = [];
  for (;;) {
    const page = await new Promise<Entry[]>((ok, err) => reader.readEntries(ok, err));
    if (page.length === 0) return out;
    out.push(...page);
  }
}

async function walk(entry: Entry, prefix: string, out: PickedFile[]): Promise<void> {
  const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) out.push({ file: await readFile(entry as FileEntry), relPath });
  else if (entry.isDirectory) for (const child of await readAll(entry as DirEntry)) await walk(child, relPath, out);
}

/** The files of a drop, folders walked: each with its path relative to the drop. */
export async function filesFromDrop(items: DataTransferItemList): Promise<PickedFile[]> {
  // the list is only readable during the drop event: take every entry before the first await
  const roots: Array<{ entry: Entry } | { file: File }> = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    const entry = (item.webkitGetAsEntry?.() ?? null) as Entry | null;
    if (entry) roots.push({ entry });
    else {
      const file = item.getAsFile();
      if (file) roots.push({ file });
    }
  }
  const out: PickedFile[] = [];
  for (const r of roots) {
    if ("file" in r) out.push({ file: r.file, relPath: r.file.name });
    else await walk(r.entry, "", out);
  }
  return out;
}

/** The files of an `<input type=file>`; a folder pick (`webkitdirectory`) keeps each file's relative path. */
export function filesFromInput(list: FileList): PickedFile[] {
  return Array.from(list, (file) => ({ file, relPath: file.webkitRelativePath || file.name }));
}
