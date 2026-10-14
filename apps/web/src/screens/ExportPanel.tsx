/** Project action: export (git bundles + asset manifests). The client's "Start an update" is in Editions.tsx. */
import { useEffect, useState } from "react";
import type { ExportStatus } from "../api/types.js";
import { useAction, useApp } from "../lib/hooks.js";
import { basename } from "../lib/model.js";
import { ErrorNote, Popover } from "../ui.js";
import { useProject } from "./project-data.js";

export function isExportDone(s: ExportStatus): boolean {
  return (s.receipt !== null && s.downloads.length > 0) || s.state === "succeeded" || s.state === "complete";
}

export function isExportFailed(s: ExportStatus): boolean {
  return s.state === "failed" || !!s.error;
}

export function downloadName(url: string): string {
  const q = url.indexOf("key=");
  return q >= 0 ? basename(decodeURIComponent(url.slice(q + 4))) : basename(url);
}

export function ExportStatusView({ status }: { status: ExportStatus | null }) {
  if (!status) return <p className="small">Starting export…</p>;
  if (isExportFailed(status))
    return (
      <div className="note note-bad" role="alert">
        <span>The export did not finish, and nothing in the project changed. Start the export again.</span>
        {status.error ? (
          <details className="small">
            <summary>Technical detail</summary>
            <code>{status.error}</code>
          </details>
        ) : null}
      </div>
    );
  if (!isExportDone(status))
    return (
      <p className="small" role="status">
        <span className="pulse" aria-hidden="true" /> Writing git bundles and asset manifests for the current accepted version…
      </p>
    );
  return (
    <>
      <p className="small">{status.downloads.length ? "Ready. One file per resource: git bundles for code, manifests for assets." : "Finished, but the export has no files to download."}</p>
      <ul className="downloads">
        {status.downloads.map((d, i) => {
          // downloads are listed in receipt order; name each by its receipt key
          const key = status.receipt?.items[i]?.r2Key;
          const name = key ? basename(key) : downloadName(d);
          return (
            <li key={d}>
              <a href={d} download={name}>
                {name}
              </a>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function ExportPanel() {
  const { api } = useApp();
  const { org, pid } = useProject();
  const [exportId, setExportId] = useState<string | null>(null);
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const start = useAction(async () => {
    setStatus(null);
    const r = await api.startExport(org, pid);
    setExportId(r.exportId);
  });
  useEffect(() => {
    if (!exportId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const s = await api.getExport(org, exportId);
        if (!live) return;
        setStatus(s);
        if (!isExportDone(s) && !isExportFailed(s)) timer = setTimeout(() => void poll(), 1500);
      } catch {
        if (live) timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, org, exportId]);

  return (
    <Popover label="Export">
      {(close) => (
        <div className="popover" role="dialog" aria-label="Export project">
          <h3>Export this project</h3>
          <p className="small">Download everything at its accepted version: you own it and can take it anywhere.</p>
          {exportId ? <ExportStatusView status={status} /> : null}
          <ErrorNote error={start.error} />
          <div className="popover-actions">
            <button type="button" className="btn btn-primary btn-small" disabled={start.busy || (!!exportId && !!status && !isExportDone(status) && !isExportFailed(status))} onClick={() => void start.run()}>
              {exportId ? "Export again" : "Start export"}
            </button>
            <button type="button" className="btn btn-quiet btn-small" onClick={close}>
              Close
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}
