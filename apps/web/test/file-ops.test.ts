import { describe, expect, it } from "vitest";
import type { Mount } from "../src/api/types.js";
import {
  LIMITS,
  canEditInPlace,
  checkBatch,
  checkFilePath,
  deleteOps,
  deleteTitle,
  editTitle,
  filesFromDrop,
  filesFromInput,
  joinPath,
  moveOps,
  moveTitle,
  renameOp,
  replaceTitle,
  TITLE_MAX,
  titleOf,
  uploadTitle,
} from "../src/lib/file-ops.js";

describe("joinPath", () => {
  it("joins a folder and a relative path without a leading slash", () => {
    expect(joinPath("", "a.txt")).toBe("a.txt");
    expect(joinPath("/", "a.txt")).toBe("a.txt");
    expect(joinPath("videos/2026", "clip.mp4")).toBe("videos/2026/clip.mp4");
    expect(joinPath("/videos/", "/raw//clip.mp4")).toBe("videos/raw/clip.mp4");
    expect(joinPath("a/./b", "./c")).toBe("a/b/c");
  });
  it("NFC-normalises, so a decomposed name (macOS) is the name the server keeps", () => {
    const decomposed = "Cafe\u0301/re\u0301sume\u0301.txt";
    const joined = joinPath("", decomposed);
    expect(joined).toBe("Caf\u00e9/r\u00e9sum\u00e9.txt");
    expect(checkFilePath(joined)).toEqual({ ok: true });
    expect(joinPath("Cafe\u0301", "a.txt")).toBe("Caf\u00e9/a.txt");
    expect(checkFilePath(decomposed).ok).toBe(false);
  });
  it("keeps `..` so that checkFilePath refuses it", () => {
    expect(joinPath("a", "../b")).toBe("a/../b");
    expect(checkFilePath(joinPath("a", "../b")).ok).toBe(false);
  });
});

describe("checkFilePath: the Worker's uploadPath rules", () => {
  it("accepts normalised relative paths", () => {
    expect(checkFilePath("a.txt")).toEqual({ ok: true });
    expect(checkFilePath("videos/2026/clip one.mp4")).toEqual({ ok: true });
    expect(checkFilePath(".github/workflows/ci.yml")).toEqual({ ok: true });
  });
  it("refuses what the Worker refuses", () => {
    for (const p of ["", "/a.txt", "a/../b", "a//b", "a/./b", "a/", "a\\b", "C:/x", "a\0b", "a\u0001b", ".git/config", "src/.GIT/x", ".commonforge/x", "x".repeat(1025)]) {
      const r = checkFilePath(p);
      expect(r.ok, p).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
    }
  });
  it("allows exactly 1,024 characters", () => {
    expect(checkFilePath("x".repeat(1024)).ok).toBe(true);
  });
});

describe("generated titles", () => {
  it("uploads", () => {
    expect(uploadTitle(1, "")).toBe("Uploaded 1 file to /");
    expect(uploadTitle(1, "/")).toBe("Uploaded 1 file to /");
    expect(uploadTitle(30, "videos/2026")).toBe("Uploaded 30 files to videos/2026");
    expect(uploadTitle(2, "/videos/")).toBe("Uploaded 2 files to videos");
  });
  it("moves and renames", () => {
    expect(moveTitle([{ from: "a.txt", to: "b.txt" }])).toBe("Renamed a.txt to b.txt");
    expect(moveTitle([{ from: "docs/a.txt", to: "docs/b.txt" }])).toBe("Renamed docs/a.txt to docs/b.txt");
    expect(moveTitle([{ from: "a.txt", to: "media/a.txt" }])).toBe("Moved 1 file to media");
    expect(moveTitle([{ from: "media/a.txt", to: "a.txt" }])).toBe("Moved 1 file to /");
    expect(moveTitle([{ from: "a", to: "media/a" }, { from: "b", to: "media/b" }, { from: "c", to: "media/c" }])).toBe("Moved 3 files to media");
  });
  it("deletes", () => {
    expect(deleteTitle(["a.txt"])).toBe("Deleted a.txt");
    expect(deleteTitle(["a.txt", "b/c.txt"])).toBe("Deleted 2 files");
  });
  it("edits and new files", () => {
    expect(editTitle("README.md", false)).toBe("Edited README.md");
    expect(editTitle("notes/todo.md", true)).toBe("Created notes/todo.md");
  });
});

describe("generated titles stay within the server's 200 characters", () => {
  const long = `${"deep/".repeat(60)}name.txt`; // 308 characters
  it("titleOf keeps short titles, and cuts long ones in the middle with an ellipsis", () => {
    expect(TITLE_MAX).toBe(200);
    expect(titleOf("Edited a.txt")).toBe("Edited a.txt");
    const t = titleOf(`Edited ${long}`);
    expect(t.length).toBe(200);
    expect(t.startsWith("Edited deep/")).toBe(true);
    expect(t.endsWith("/name.txt")).toBe(true);
    expect(t).toContain("…");
    expect(titleOf("x".repeat(200))).toBe("x".repeat(200));
    expect(titleOf("x".repeat(201)).length).toBe(200);
  });
  it("never splits a surrogate pair", () => {
    for (let n = 195; n < 205; n++) {
      const t = titleOf("😀".repeat(n));
      expect(t.length).toBeLessThanOrEqual(200);
      expect(t).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });
  it("every builder clamps", () => {
    for (const t of [
      uploadTitle(3, long),
      moveTitle([{ from: long, to: `${long}2` }]),
      moveTitle([{ from: "a", to: `${long}/a` }, { from: "b", to: `${long}/b` }]),
      deleteTitle([long]),
      editTitle(long, false),
      editTitle(long, true),
      replaceTitle(long),
    ]) {
      expect(t.length).toBeLessThanOrEqual(200);
      expect(t.trim().length).toBeGreaterThan(0);
    }
    expect(replaceTitle("a.txt")).toBe("Replaced a.txt");
  });
});

describe("op builders", () => {
  it("moveOps keeps basenames", () => {
    expect(moveOps(["a.txt", "docs/b.md", "img"], "media")).toEqual([
      { move: "a.txt", to: "media/a.txt" },
      { move: "docs/b.md", to: "media/b.md" },
      { move: "img", to: "media/img" },
    ]);
    expect(moveOps(["docs/b.md"], "")).toEqual([{ move: "docs/b.md", to: "b.md" }]);
  });
  it("moveOps leaves out files already in the target folder", () => {
    expect(moveOps(["media/a.txt", "b.txt"], "media")).toEqual([{ move: "b.txt", to: "media/b.txt" }]);
  });
  it("moveOps refuses moving a folder into itself", () => {
    expect(() => moveOps(["media"], "media")).toThrow(/into itself/);
    expect(() => moveOps(["media"], "media/2026")).toThrow(/into itself/);
    expect(moveOps(["media"], "media-old")).toEqual([{ move: "media", to: "media-old/media" }]);
  });
  it("moveOps refuses two items with the same name", () => {
    expect(() => moveOps(["a/x.txt", "b/x.txt"], "c")).toThrow(/same name/);
  });
  it("renameOp and deleteOps", () => {
    expect(renameOp("a.txt", "b.txt")).toEqual({ move: "a.txt", to: "b.txt" });
    expect(deleteOps(["a.txt", "dir"])).toEqual([{ delete: "a.txt" }, { delete: "dir" }]);
  });
});

describe("checkBatch: the browser's limits", () => {
  it("accepts a batch within the limits", () => {
    expect(checkBatch([{ size: 1 }, { size: LIMITS.maxFileBytes }])).toEqual({ ok: true });
    expect(checkBatch(Array.from({ length: LIMITS.maxOps }, () => ({ size: 1 })))).toEqual({ ok: true });
  });
  it("refuses a file over 5 GB", () => {
    const r = checkBatch([{ size: 10 }, { size: LIMITS.maxFileBytes + 1 }]);
    expect(r).toMatchObject({ ok: false, code: "file_too_large" });
  });
  it("refuses more than 1,000 files", () => {
    expect(checkBatch(Array.from({ length: LIMITS.maxOps + 1 }, () => ({ size: 1 })))).toMatchObject({ ok: false, code: "too_many_operations" });
  });
  it("refuses more than 20 GB in all", () => {
    expect(checkBatch(Array.from({ length: 5 }, () => ({ size: 4_500_000_000 })))).toMatchObject({ ok: false, code: "change_too_large" });
  });
});

describe("canEditInPlace", () => {
  const git: Mount = { mountName: "site", resourceId: "res-1", provider: "artifacts", resourceName: "site", mode: "must-match-accepted", operations: [], canWrite: true };
  it("a small text file in a writable git folder", () => {
    expect(canEditInPlace(git, { path: "README.md", size: 120 })).toBe(true);
    expect(canEditInPlace(git, { path: "Makefile" })).toBe(true);
  });
  it("not without write", () => {
    expect(canEditInPlace({ ...git, canWrite: false }, { path: "README.md", size: 1 })).toBe(false);
    const { canWrite: _, ...old } = git;
    expect(canEditInPlace(old, { path: "README.md", size: 1 })).toBe(false);
  });
  it("not in a file collection", () => {
    expect(canEditInPlace({ ...git, provider: "r2-assets" }, { path: "README.md", size: 1 })).toBe(false);
  });
  it("not an LFS file", () => {
    expect(canEditInPlace(git, { path: "notes.txt", size: 10, lfs: true })).toBe(false);
  });
  it("only under 1 MiB", () => {
    expect(canEditInPlace(git, { path: "big.txt", size: LIMITS.maxEditBytes - 1 })).toBe(true);
    expect(canEditInPlace(git, { path: "big.txt", size: LIMITS.maxEditBytes })).toBe(false);
  });
  it("not a binary-looking name", () => {
    expect(canEditInPlace(git, { path: "logo.png", size: 10 })).toBe(false);
    expect(canEditInPlace(git, { path: "clip.mp4", size: 10 })).toBe(false);
  });
});

// ------------------------------------------------------------------------------ picking files

type FakeEntry =
  | { isFile: true; isDirectory: false; name: string; file: (ok: (f: File) => void, err?: (e: unknown) => void) => void }
  | { isFile: false; isDirectory: true; name: string; createReader: () => { readEntries: (ok: (es: FakeEntry[]) => void, err?: (e: unknown) => void) => void } };

function fileEntry(name: string, body = name): FakeEntry {
  return { isFile: true, isDirectory: false, name, file: (ok) => setTimeout(() => ok(new File([body], name)), 0) };
}

/** A directory whose reader answers in pages of `page` entries, then an empty page, as browsers do. */
function dirEntry(name: string, children: FakeEntry[], page = 2, reads?: { n: number }): FakeEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (ok) => {
          if (reads) reads.n++;
          const out = children.slice(at, at + page);
          at += out.length;
          setTimeout(() => ok(out), 0);
        },
      };
    },
  };
}

function itemList(entries: Array<FakeEntry | null>, plain: File[] = []): DataTransferItemList {
  const items = entries.map((e, i) => ({ kind: "file", webkitGetAsEntry: () => e, getAsFile: () => plain[i] ?? null }));
  return Object.assign(items, { add: () => null, clear: () => undefined, remove: () => undefined }) as unknown as DataTransferItemList;
}

describe("filesFromDrop", () => {
  it("walks nested folders, reading each folder until its reader answers empty", async () => {
    const reads = { n: 0 };
    const tree = dirEntry("photos", [fileEntry("a.jpg"), fileEntry("b.jpg"), dirEntry("2026", [fileEntry("c.jpg"), dirEntry("empty", [])]), fileEntry("d.jpg"), fileEntry("e.jpg")], 2, reads);
    const got = await filesFromDrop(itemList([fileEntry("top.txt"), tree]));
    expect(got.map((g) => g.relPath).sort()).toEqual(["photos/2026/c.jpg", "photos/a.jpg", "photos/b.jpg", "photos/d.jpg", "photos/e.jpg", "top.txt"]);
    expect(reads.n).toBe(4); // three pages of 2, 2 and 1, then the empty answer
    const top = got.find((g) => g.relPath === "top.txt")!;
    expect(top.file).toBeInstanceOf(File);
    expect(await top.file.text()).toBe("top.txt");
  });
  it("falls back to getAsFile when an item has no entry", async () => {
    const f = new File(["x"], "plain.txt");
    const got = await filesFromDrop(itemList([null], [f]));
    expect(got).toEqual([{ file: f, relPath: "plain.txt" }]);
  });
  it("skips items that are not files", async () => {
    const list = Object.assign([{ kind: "string", webkitGetAsEntry: () => null, getAsFile: () => null }], {}) as unknown as DataTransferItemList;
    expect(await filesFromDrop(list)).toEqual([]);
  });
});

describe("filesFromInput", () => {
  it("uses webkitRelativePath when the input picked a folder", () => {
    const a = Object.assign(new File(["a"], "a.txt"), { webkitRelativePath: "docs/a.txt" });
    const b = new File(["b"], "b.txt");
    const list = Object.assign([a, b], { item: (i: number) => [a, b][i] ?? null }) as unknown as FileList;
    expect(filesFromInput(list)).toEqual([
      { file: a, relPath: "docs/a.txt" },
      { file: b, relPath: "b.txt" },
    ]);
  });
});
