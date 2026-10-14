/**
 * A new folder's first commit (phase 4, P4-5/P4-6), as the Worker builds it (`firstCommitFiles` in
 * `apps/worker/src/services/folder-init.ts`). The fake uses it to give a new folder the same three
 * files the live Worker writes, so the fixture shows what a real folder starts with.
 */

/**
 * File types a new folder stores in Git LFS: video, audio, images (not svg: it is text), archives,
 * fonts, PDF and Office. Keep in step with `DEFAULT_LFS_PATTERNS` in
 * `packages/runner-protocol/src/apply-files.ts` (the last group is its `CONTENT_EXTENSIONS`).
 */
export const DEFAULT_LFS_PATTERNS: readonly string[] = [
  ...["mp4", "mov", "webm", "mkv", "avi", "m4v"],
  ...["mp3", "wav", "ogg", "flac", "m4a", "aac"],
  ...["png", "jpg", "jpeg", "gif", "webp", "avif", "heic", "tif", "tiff", "psd", "ai", "ico"],
  ...["zip", "gz", "tgz", "tar", "7z", "rar"],
  ...["woff", "woff2", "ttf", "otf"],
  ...["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "key", "pages", "numbers"],
];

/** `.gitattributes`: one header comment line, then one LFS line per pattern, in order. */
export function defaultGitattributes(): string {
  return ["# Stored in Git LFS: media, archives, fonts, PDF and Office files", ...DEFAULT_LFS_PATTERNS.map((x) => `*.${x} filter=lfs diff=lfs merge=lfs -text`), ""].join("\n");
}

/** The folder's LFS endpoint (Worker `lfsEndpointUrl`): the public URL without trailing slashes. */
export function lfsEndpointUrl(publicUrl: string, org: string, resourceId: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/api/lfs/${org}/${resourceId}/info/lfs`;
}

/** The three files of a new folder's first commit, in path order. */
export function firstCommitFiles(name: string, lfsUrl: string): Array<{ path: string; content: string }> {
  return [
    { path: ".gitattributes", content: defaultGitattributes() },
    { path: ".lfsconfig", content: `[lfs]\n\turl = ${lfsUrl}\n` },
    { path: "README.md", content: `# ${name}\n` },
  ];
}
