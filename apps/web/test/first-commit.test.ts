import { describe, expect, it } from "vitest";
import { DEFAULT_LFS_PATTERNS, defaultGitattributes, firstCommitFiles, lfsEndpointUrl } from "../src/lib/first-commit.js";
// the source of truth (the web app does not depend on runner-protocol; this file has no imports)
import * as protocol from "../../../packages/runner-protocol/src/apply-files.js";

describe("a new folder's first commit (mirrors the Worker's firstCommitFiles)", () => {
  it("the pattern list is the runner-protocol DEFAULT_LFS_PATTERNS, in order", () => {
    expect(DEFAULT_LFS_PATTERNS).toEqual([
      ...["mp4", "mov", "webm", "mkv", "avi", "m4v"],
      ...["mp3", "wav", "ogg", "flac", "m4a", "aac"],
      ...["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "tif", "tiff", "psd", "ai", "ico"],
      ...["zip", "gz", "tgz", "tar", "7z", "rar"],
      ...["woff", "woff2", "ttf", "otf"],
      ...["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "key", "pages", "numbers"],
    ]);
    expect(DEFAULT_LFS_PATTERNS).not.toContain("svg");
  });

  it("is byte for byte the runner-protocol's: the pattern list and the .gitattributes text", () => {
    expect(DEFAULT_LFS_PATTERNS.map((x) => `*.${x}`)).toEqual(protocol.DEFAULT_LFS_PATTERNS);
    expect(defaultGitattributes()).toBe(protocol.defaultGitattributes());
  });

  it(".gitattributes: one header comment, then one LFS line per pattern", () => {
    const lines = defaultGitattributes().split("\n");
    expect(lines[0]).toMatch(/^# /);
    expect(lines.at(-1)).toBe("");
    expect(lines.slice(1, -1)).toEqual(DEFAULT_LFS_PATTERNS.map((x) => `*.${x} filter=lfs diff=lfs merge=lfs -text`));
  });

  it("the LFS URL drops trailing slashes from the public URL", () => {
    expect(lfsEndpointUrl("https://cf.example//", "o1", "r1")).toBe("https://cf.example/api/lfs/o1/r1/info/lfs");
  });

  it("the three files, in path order", () => {
    const files = firstCommitFiles("media", "https://cf.example/api/lfs/o1/r1/info/lfs");
    expect(files.map((f) => f.path)).toEqual([".gitattributes", ".lfsconfig", "README.md"]);
    expect(files[0]!.content).toBe(defaultGitattributes());
    expect(files[1]!.content).toBe("[lfs]\n\turl = https://cf.example/api/lfs/o1/r1/info/lfs\n");
    expect(files[2]!.content).toBe("# media\n");
  });
});
