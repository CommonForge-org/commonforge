/**
 * One file's line diff between two revisions, built in the browser from two reads of the file route
 * (`GET …/file?mount=&path=&revision=`, owners and developers only). Shared by the proposal review
 * and the promotion review (staging phase 3, P3-10).
 */
import { useEffect, useState } from "react";
import { ApiError } from "../api/client.js";
import { useApp } from "../lib/hooks.js";
import { collapseDiff, lineDiff, looksLikeText } from "../lib/model.js";
import { ErrorNote, Loading } from "../ui.js";
import { useProject } from "./project-data.js";

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Text the diff should not show line by line: a NUL byte (binary) or a Git LFS pointer. */
export function unshownContent(text: string): string | null {
  if (text.includes("\0")) return "Binary file; its contents are not shown.";
  if (text.startsWith("version https://git-lfs.github.com/spec/v1")) return "Stored in LFS; its contents are not shown.";
  return null;
}

/** Why a path gets no line diff (binary or LFS by its name), or null when it is diffed. */
export function noDiffReason(path: string): string | null {
  return looksLikeText(path) ? null : "Binary file; its contents are not shown.";
}

/** Files larger than this are not diffed line by line (a line diff of two large files is slow and unreadable). */
export const DIFF_MAX_BYTES = 1024 * 1024;
const TOO_LARGE = "Too large to show line by line (over 1 MiB).";
const TOO_LARGE_MARK: unique symbol = Symbol("too large");

export function FileDiff({ mount, path, base, candidate }: { mount: string; path: string; base: string; candidate: string }) {
  const { api } = useApp();
  const { org, pid } = useProject();
  const [state, setState] = useState<{ ops?: ReturnType<typeof collapseDiff>; note?: string; error?: unknown }>({});
  useEffect(() => {
    let live = true;
    const read = (revision: string) =>
      api
        .readFile(org, pid, { mount, path, revision })
        // the size is known before the text is decoded: a large file is not read into a string
        .then((b): Promise<string | typeof TOO_LARGE_MARK> | typeof TOO_LARGE_MARK => (b.size > DIFF_MAX_BYTES ? TOO_LARGE_MARK : b.text()))
        .catch((e: unknown) => {
          if (e instanceof ApiError && e.status === 404) return null;
          throw e;
        });
    Promise.all([read(base), read(candidate)])
      .then(([a, b]) => {
        if (!live) return;
        if (a === TOO_LARGE_MARK || b === TOO_LARGE_MARK) return setState({ ops: [], note: TOO_LARGE });
        const unshown = unshownContent(a ?? "") ?? unshownContent(b ?? "");
        if (unshown) return setState({ ops: [], note: unshown });
        const note = a === null ? "New file" : b === null ? "Deleted" : undefined;
        setState({ ops: collapseDiff(lineDiff(a ?? "", b ?? "")), ...(note ? { note } : {}) });
      })
      .catch((error: unknown) => live && setState({ error }));
    return () => {
      live = false;
    };
  }, [api, org, pid, mount, path, base, candidate]);
  if (state.error) return <ErrorNote error={state.error} />;
  if (!state.ops) return <Loading what="Loading diff" />;
  return (
    <div className="diff" role="table" aria-label={`Changes to ${path}`}>
      {state.note ? <div className="diff-note">{state.note}</div> : null}
      {state.ops.map((o, i) =>
        o.op === "skip" ? (
          <div key={i} className="diff-skip">
            ⋯ {plural(o.count, "unchanged line")}
          </div>
        ) : (
          <div key={i} className={`diff-line diff-${o.op}`}>
            <span className="diff-sign" aria-hidden="true">
              {o.op === "add" ? "+" : o.op === "del" ? "−" : " "}
            </span>
            <span className="diff-text">{o.text || " "}</span>
          </div>
        ),
      )}
    </div>
  );
}
