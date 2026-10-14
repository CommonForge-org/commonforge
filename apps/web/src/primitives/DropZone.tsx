/**
 * A drop zone for one file (a ZIP of the edited working copy, an intake archive). The real
 * `<input type="file">` stays in the zone and keeps its accessible name (`inputLabel`), so
 * keyboard users, screen readers and tests (`getByLabel`) use it as before; drag and drop is
 * an addition.
 */
import { useId, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { Icon } from "./icons.js";

export function DropZone({ inputLabel, accept, file, onFile, title = "Drop your file here", hint, disabled }: { inputLabel: string; accept?: string; file: File | null; onFile: (f: File | null) => void; title?: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  const id = useId();
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    if (disabled) return;
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };
  return (
    <label
      htmlFor={id}
      className={`dropzone ${over ? "dropzone-over" : ""} ${file ? "dropzone-has-file" : ""} ${disabled ? "dropzone-disabled" : ""}`.replace(/\s+/g, " ").trim()}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <span className="dropzone-icon" aria-hidden="true">
        <Icon name={file ? "check" : "upload"} size={22} />
      </span>
      <span className="dropzone-text">
        <span className="dropzone-title">{file ? file.name : title}</span>
        <span className="dropzone-hint">{file ? "Ready to send. Choose another file to replace it." : (hint ?? "or click to choose a file")}</span>
      </span>
      <input id={id} className="dropzone-input" type="file" accept={accept} aria-label={inputLabel} disabled={disabled} onChange={(e: ChangeEvent<HTMLInputElement>) => onFile(e.target.files?.[0] ?? null)} />
    </label>
  );
}
