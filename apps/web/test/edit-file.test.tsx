/**
 * Edit in place and New file (plan phase 3 Task 10), by server rendering the pure views: the
 * editor's line-number gutter and its refusals, the review's diff and Save, the "changed since
 * you opened it" view, and the small helpers behind them.
 */
import { createElement } from "react";
import { renderToString as render } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangedSinceView, checkEditText, checkNewFilePath, copyText, EditorView, gutterText, LeaveSheetView, MyTextPanel, ReviewView } from "../src/screens/EditFile.js";

const noop = () => {};

function renderToString(el: Parameters<typeof render>[0]): string {
  return render(el).replace(/<!-- -->/g, "");
}

const decode = (html: string) => html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The gutter's numbers, as rendered. */
function gutterOf(html: string): string[] {
  const m = /<pre[^>]*class="editor-gutter"[^>]*>([\s\S]*?)<\/pre>/.exec(html);
  if (!m) throw new Error("no gutter");
  return m[1]!.split("\n").filter(Boolean);
}

/** The opening tag of the button with this text. */
function button(html: string, text: string): string {
  const re = new RegExp(`<button[^>]*>(?:(?!</button>)[\\s\\S])*${text}(?:(?!</button>)[\\s\\S])*</button>`);
  const m = re.exec(html);
  if (!m) throw new Error(`no button ${text}`);
  return m[0].slice(0, m[0].indexOf(">") + 1);
}

const editor = (text: string, extra: Partial<Parameters<typeof EditorView>[0]> = {}) => renderToString(createElement(EditorView, { path: "docs/guide.md", text, onChange: noop, onCancel: noop, onReview: noop, isNew: false, ...extra }));

describe("EditorView", () => {
  it("the gutter line count follows the text", () => {
    expect(gutterOf(editor(""))).toEqual(["1"]);
    expect(gutterOf(editor("one"))).toEqual(["1"]);
    expect(gutterOf(editor("a\nb\nc"))).toEqual(["1", "2", "3"]);
    expect(gutterOf(editor("a\nb\n"))).toEqual(["1", "2", "3"]);
    expect(gutterOf(editor("x\n".repeat(1200)))).toHaveLength(1201);
    expect(gutterText("a\r\nb")).toBe("1\n2");
  });

  it("is a monospace textarea named File contents, with the gutter hidden from assistive tech", () => {
    const html = editor("hello");
    expect(html).toContain('aria-label="File contents"');
    expect(html).toMatch(/<pre[^>]*aria-hidden="true"[^>]*class="editor-gutter"|<pre[^>]*class="editor-gutter"[^>]*aria-hidden="true"/);
    expect(html).toContain("docs/guide.md");
    expect(html).toContain("5 B");
  });

  it("refuses review at or over 1 MiB, and on NUL", () => {
    expect(checkEditText("hello")).toEqual({ ok: true, bytes: 5 });
    expect(checkEditText("é")).toEqual({ ok: true, bytes: 2 });
    expect(checkEditText("a".repeat(1_048_575)).ok).toBe(true);
    const big = checkEditText("a".repeat(1_048_576));
    expect(big.ok).toBe(false);
    expect(checkEditText("a\0b").ok).toBe(false);

    expect(button(editor("hello"), "Review changes")).not.toContain("disabled");
    const over = editor("a".repeat(1_048_576));
    expect(button(over, "Review changes")).toContain("disabled");
    expect(over).toContain("1 MiB");
    const nul = editor("a\0b");
    expect(button(nul, "Review changes")).toContain("disabled");
    expect(decode(nul)).toMatch(/NUL/);
  });

  it("a new file has a path input relative to the folder, and its refusal blocks review", () => {
    const ok = editor("x", { isNew: true, path: "docs/new.md", nameInput: { dir: "docs", value: "new.md", onChange: noop } });
    expect(ok).toContain('aria-label="New file path"');
    expect(ok).toContain("docs/");
    expect(button(ok, "Review changes")).not.toContain("disabled");
    const taken = editor("x", { isNew: true, path: "docs/guide.md", nameInput: { dir: "docs", value: "guide.md", onChange: noop, error: "docs/guide.md exists already" } });
    expect(button(taken, "Review changes")).toContain("disabled");
    expect(taken).toContain("docs/guide.md exists already");
    // an existing file has no path input
    expect(editor("x")).not.toContain("New file path");
  });

  it("checkNewFilePath: joins to the folder, refuses bad paths and ones in the listing", () => {
    const listing = [{ path: "docs/guide.md", type: "file" }, { path: "docs/img", type: "dir" }];
    expect(checkNewFilePath("docs", "new.md", listing)).toEqual({ ok: true, path: "docs/new.md" });
    expect(checkNewFilePath("", "README.md", [])).toEqual({ ok: true, path: "README.md" });
    expect(checkNewFilePath("docs", "sub/new.md", listing)).toEqual({ ok: true, path: "docs/sub/new.md" });
    expect(checkNewFilePath("docs", "guide.md", listing).ok).toBe(false);
    expect(checkNewFilePath("docs", "img", listing).ok).toBe(false);
    // a file in place of a folder
    expect(checkNewFilePath("docs", "guide.md/x.md", listing).ok).toBe(false);
    expect(checkNewFilePath("docs", "", listing).ok).toBe(false);
    expect(checkNewFilePath("docs", "../x.md", listing).ok).toBe(false);
    expect(checkNewFilePath("", ".git/config", []).ok).toBe(false);
  });
});

describe("ReviewView", () => {
  const review = (before: string, after: string, extra: Partial<Parameters<typeof ReviewView>[0]> = {}) =>
    renderToString(createElement(ReviewView, { path: "docs/guide.md", before, after, title: "", onTitle: noop, onBack: noop, onSave: noop, saving: false, error: null, ...extra }));

  it("the diff rows show added and deleted lines", () => {
    const html = review("a\nb\nc", "a\nB\nc\nd");
    expect(html).toMatch(/class="diff-line diff-del"[\s\S]*?<span class="diff-text">b<\/span>/);
    expect(html).toMatch(/class="diff-line diff-add"[\s\S]*?<span class="diff-text">B<\/span>/);
    expect(html).toMatch(/class="diff-line diff-add"[\s\S]*?<span class="diff-text">d<\/span>/);
    expect(html).toMatch(/class="diff-line diff-same"[\s\S]*?<span class="diff-text">a<\/span>/);
  });

  it("collapses long unchanged runs to 3 lines of context", () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 20", "line twenty");
    const html = review(before, after);
    expect(html).toContain("diff-skip");
    expect(html).not.toContain(">line 5<");
    expect(html).toContain(">line 17<");
  });

  it("Save is disabled with no change, enabled with one; the generated title is the placeholder", () => {
    expect(button(review("same", "same"), "Save")).toContain("disabled");
    expect(review("same", "same")).toContain("No changes");
    expect(button(review("a", "b"), "Save")).not.toContain("disabled");
    expect(review("a", "b")).toContain('placeholder="Edited docs/guide.md"');
    expect(review("", "", { isNew: true })).toContain('placeholder="Created docs/guide.md"');
    // a new (even empty) file is a change
    expect(button(review("", "", { isNew: true }), "Save")).not.toContain("disabled");
    expect(button(review("a", "b", { saving: true }), "Saving")).toContain("disabled");
  });
});

describe("ChangedSinceView", () => {
  it("renders the notice and both actions", () => {
    const html = renderToString(createElement(ChangedSinceView, { onViewNewer: noop, onCopy: noop }));
    expect(html).toContain("This file changed since you opened it");
    expect(html).toContain("View the newer version");
    expect(html).toContain("Copy my text");
  });

  it("says when the copy worked or did not", () => {
    expect(renderToString(createElement(ChangedSinceView, { onViewNewer: noop, onCopy: noop, copied: true }))).toContain("Copied");
    expect(renderToString(createElement(ChangedSinceView, { onViewNewer: noop, onCopy: noop, copied: false }))).toMatch(/could not copy/i);
  });

  it("the side panel keeps the user's text as text", () => {
    const html = renderToString(createElement(MyTextPanel, { text: "<b>mine</b>", onCopy: noop }));
    expect(html).toContain("Your text");
    expect(html).toContain("&lt;b&gt;mine&lt;/b&gt;");
    expect(html).toContain("Copy my text");
  });
});

describe("LeaveSheetView", () => {
  it("asks before discarding unsaved changes", () => {
    const html = renderToString(createElement(LeaveSheetView, { onLeave: noop, onStay: noop }));
    expect(html).toContain("Discard");
    expect(html).toMatch(/unsaved/i);
  });
});

describe("copyText", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is false without a clipboard, or when it refuses; true when it writes", async () => {
    vi.stubGlobal("navigator", {});
    await expect(copyText("x")).resolves.toBe(false);
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new Error("denied")) } });
    await expect(copyText("x")).resolves.toBe(false);
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: () => {
          throw new Error("sync throw");
        },
      },
    });
    await expect(copyText("x")).resolves.toBe(false);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("mine")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("mine");
  });
});
