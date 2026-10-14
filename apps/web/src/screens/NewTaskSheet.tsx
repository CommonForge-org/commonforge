/**
 * New task (staging phase 3, ruling P3-9): on the Tasks board, for clients, developers and owners
 * (never viewers). A title and what the agent should do; nothing else to choose. The folders come
 * from the project's access settings: the Worker gives the agent every folder the person may start
 * a task in to change, and the others they can read to read (`createTask` with no `writeMounts`).
 * Owners and developers may narrow it under "Choose folders"; clients never choose folders. One
 * request per submit: the button stays disabled until the reply. Then the agent hand-off
 * (AgentHandoff.tsx): one prompt to paste into a coding agent.
 */
import { useRef, useState, type FormEvent } from "react";
import { ApiError } from "../api/client.js";
import type { CreateTaskInput, Mount, TaskView } from "../api/types.js";
import { errorMessage } from "../ui.js";
import { AgentHandoff, handoffTask, type HandoffContext } from "./AgentHandoff.js";

export const TITLE_MAX = 200;
export const REQUEST_MAX = 16_000;
/** Worker `readMounts` at most 32 */
export const READ_MAX = 32;

export interface NewTaskValues {
  title: string;
  request: string;
  /** the folders the agent may change; none: as the Worker decides (every folder the person may start a task in) */
  write: string[];
  /** the other folders it is shown; null: as the Worker decides (every other folder you can read) */
  read: string[] | null;
}

export type NewTaskField = "title" | "request" | "write" | "read";
export type NewTaskErrors = Partial<Record<NewTaskField, string>>;

/** The other folders shown by default: every folder that is not a write folder (the Worker: every other folder you can read). */
function defaultRead(v: Pick<NewTaskValues, "write">, mounts: readonly Pick<Mount, "mountName">[]): string[] {
  return mounts.map((m) => m.mountName).filter((m) => !v.write.includes(m));
}

/**
 * The read folders to send: none (the Worker's default) when the person kept the default or chose
 * exactly it again; else their choice without the write folders.
 */
export function readMountsToSend(v: NewTaskValues, mounts: readonly Pick<Mount, "mountName">[]): string[] | undefined {
  if (v.read === null || v.write.length === 0) return undefined;
  const read = [...new Set(v.read.filter((m) => !v.write.includes(m)))];
  const def = defaultRead(v, mounts);
  if (read.length === def.length && def.every((m) => read.includes(m))) return undefined;
  return read;
}

/** The Worker's rules for a new task (routes/tasks.ts), checked before sending; the texts are the form's. */
export function validateNewTask(v: NewTaskValues, mounts: readonly Pick<Mount, "mountName">[] = []): NewTaskErrors {
  const out: NewTaskErrors = {};
  const title = v.title.trim();
  if (!title) out.title = "Give the task a title.";
  else if (title.length > TITLE_MAX) out.title = `Keep the title to ${TITLE_MAX} characters or fewer.`;
  if (v.request.length > REQUEST_MAX) out.request = "Keep the request to 16,000 characters or fewer.";
  if ((readMountsToSend(v, mounts)?.length ?? 0) > READ_MAX) out.read = `Choose at most ${READ_MAX} folders to show.`;
  return out;
}

/**
 * What `createTask` is sent: folders only when a developer chose them (`writeMounts`, and
 * `readMounts` when they changed that default too; never more than {@link READ_MAX}: validated first).
 */
export function newTaskInput(v: NewTaskValues, mounts: readonly Pick<Mount, "mountName">[] = []): CreateTaskInput {
  const input: CreateTaskInput = { title: v.title.trim() };
  if (v.write.length) input.writeMounts = [...v.write];
  if (v.request.trim()) input.request = v.request;
  const read = readMountsToSend(v, mounts);
  if (read) input.readMounts = read;
  return input;
}

/** A server refusal on one field (`400 invalid_request` "title: …") or for the whole form. */
export function newTaskServerError(e: unknown, developer = false): { field?: NewTaskField; text: string } {
  if (e instanceof ApiError) {
    if (e.code === "invalid_request") {
      if (e.message.startsWith("title")) return { field: "title", text: `Give the task a title of 1 to ${TITLE_MAX} characters.` };
      if (e.message.startsWith("request")) return { field: "request", text: "Keep the request to 16,000 characters or fewer." };
      if (e.message.startsWith("writeMounts")) return { field: "write", text: "Choose 1 to 16 folders the agent may change." };
      if (e.message.startsWith("readMounts")) return { field: "read", text: `Choose at most ${READ_MAX} folders to show.` };
    }
    if (e.code === "too_many_folders") return { field: "write", text: developer ? "This project has more than 16 folders you can change. Choose the task's folders under Choose folders." : "This project has too many folders for one task. Ask your developer to start it." };
    if (e.code === "resource_not_ready") return { field: "write", text: "One of these folders isn't ready yet. Try again in a few minutes." };
    if (e.code === "mount_read_only") return { field: "write", text: "One of these folders is read-only in this project. Choose another folder." };
    if (e.code === "no_write_grant") return { field: "write", text: "There is no folder you can start a task in here. Ask your developer to open one for changes." };
    if (e.code === "no_accepted_head") return { field: "write", text: "One of these folders has no first version yet. Ask your developer to add one." };
    if (e.code === "not_found") return { text: "A folder you chose is no longer in this project. Reload the page and try again." };
  }
  return { text: errorMessage(e, developer) };
}

/** The checkout command and folder now live with the rest of the hand-off (lib/handoff.ts). */
export { checkoutCommand, checkoutDir } from "../lib/handoff.js";

export interface NewTaskFormProps {
  mounts: readonly Mount[];
  values: NewTaskValues;
  errors: NewTaskErrors;
  /** a refusal for the whole form */
  formError: string | null;
  busy: boolean;
  /** owners and developers may narrow the folders; clients never choose them */
  chooseFolders?: boolean;
  onChange: (v: NewTaskValues) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** The form, a pure view of its values and errors. */
export function NewTaskForm({ mounts, values, errors, formError, busy, chooseFolders = false, onChange, onSubmit, onCancel }: NewTaskFormProps) {
  const startable = mounts.filter((m) => m.canStartTask);
  const others = mounts.filter((m) => !values.write.includes(m.mountName));
  const readShown = values.read ?? others.map((m) => m.mountName);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };
  const toggleWrite = (name: string, on: boolean) => {
    const write = on ? [...values.write, name] : values.write.filter((m) => m !== name);
    // a chosen list stays consistent: a folder it may change leaves the list; one it may no longer
    // change stays shown to it (it saw that folder already)
    const read = write.length === 0 ? null : values.read === null ? null : [...values.read.filter((m) => !write.includes(m)), ...(on || values.read.includes(name) ? [] : [name])];
    onChange({ ...values, write, read });
  };
  const toggleRead = (name: string, on: boolean) => {
    const read = on ? [...readShown, name] : readShown.filter((m) => m !== name);
    onChange({ ...values, read });
  };
  const label = (m: Mount) => m.resourceName || m.mountName;
  return (
    <form className="new-task" onSubmit={submit} noValidate data-testid="new-task" aria-label="New task">
      <h3 className="new-task-title">New task</h3>
      <label className="field">
        Title
        <input type="text" name="title" value={values.title} maxLength={TITLE_MAX + 50} onChange={(e) => onChange({ ...values, title: e.target.value })} aria-invalid={errors.title ? true : undefined} aria-describedby={errors.title ? "new-task-title-error" : undefined} placeholder="Show opening hours on the contact page" />
        {errors.title ? (
          <span className="field-error small" id="new-task-title-error">
            {errors.title}
          </span>
        ) : null}
      </label>
      <label className="field">
        What should the agent do?
        <textarea name="request" rows={5} value={values.request} onChange={(e) => onChange({ ...values, request: e.target.value })} aria-invalid={errors.request ? true : undefined} aria-describedby={errors.request ? "new-task-request-error" : undefined} placeholder="Describe the change in your own words." />
        {errors.request ? (
          <span className="field-error small" id="new-task-request-error">
            {errors.request}
          </span>
        ) : null}
      </label>
      {startable.length === 0 ? (
        <p className="note small" data-testid="new-task-no-folders">
          There is no folder you can start a task in here. Ask your developer to open one for changes.
        </p>
      ) : chooseFolders ? (
        <details className="new-task-folders-choice" data-testid="new-task-folders" {...(errors.write || errors.read || values.write.length ? { open: true } : {})}>
          <summary>Choose folders</summary>
          <p className="muted small">
            {values.write.length === 0 ? "Left as is, the agent may change every folder you can start a task in, and reads the others you can see. " : null}
            The project's access settings decide what anyone else's agent gets.
          </p>
          <fieldset className="field new-task-folders" aria-invalid={errors.write ? true : undefined} aria-describedby={errors.write ? "new-task-write-error" : undefined}>
            <legend>Folders it may change</legend>
            {startable.map((m) => (
              <label key={m.mountName} className="check">
                <input type="checkbox" name="write" value={m.mountName} checked={values.write.includes(m.mountName)} onChange={(e) => toggleWrite(m.mountName, e.target.checked)} />
                {label(m)}
                {m.resourceName && m.resourceName !== m.mountName ? <span className="muted small"> ({m.mountName})</span> : null}
              </label>
            ))}
            {errors.write ? (
              <span className="field-error small" id="new-task-write-error">
                {errors.write}
              </span>
            ) : null}
          </fieldset>
          {values.write.length && others.length ? (
            <fieldset className="field new-task-read">
              <legend>Also show it</legend>
              <p className="muted small">Folders the agent can read but not change. {values.read === null ? "By default it sees every other folder you can read." : null}</p>
              {others.map((m) => (
                <label key={m.mountName} className="check">
                  <input type="checkbox" name="read" value={m.mountName} checked={readShown.includes(m.mountName)} onChange={(e) => toggleRead(m.mountName, e.target.checked)} />
                  {label(m)}
                </label>
              ))}
              {errors.read ? (
                <span className="field-error small" id="new-task-read-error" role="alert">
                  {errors.read}
                </span>
              ) : null}
            </fieldset>
          ) : null}
        </details>
      ) : null}
      {errors.write && !chooseFolders ? (
        <p className="note note-bad small" role="alert">
          {errors.write}
        </p>
      ) : null}
      {formError ? (
        <p className="note note-bad small" role="alert">
          {formError}
        </p>
      ) : null}
      <div className="confirm-actions">
        <button type="submit" className="btn btn-primary btn-small" disabled={busy || startable.length === 0} data-testid="new-task-submit">
          {busy ? "Creating…" : "Create task"}
        </button>
        <button type="button" className="btn btn-quiet btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export const EMPTY_TASK: NewTaskValues = { title: "", request: "", write: [], read: null };

/**
 * The sheet: the form until the task is created (one request at a time, field errors in plain
 * words), then the hand-off. `onCreated` runs once the Worker answered (the board reloads).
 */
export function NewTaskSheet({ mounts, onCreate, onCreated, onClose, developer = false, initial = EMPTY_TASK, handoff }: { mounts: readonly Mount[]; onCreate: (input: CreateTaskInput) => Promise<TaskView>; onCreated?: (task: TaskView) => void; onClose: () => void; developer?: boolean; initial?: NewTaskValues; /** who is looking and where, for the hand-off's commands */ handoff: HandoffContext }) {
  const [values, setValues] = useState<NewTaskValues>(initial);
  const [errors, setErrors] = useState<NewTaskErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<TaskView | null>(null);
  // a second submit before React re-renders the disabled button never sends a second request
  const sending = useRef(false);
  if (created) return <AgentHandoff task={handoffTask(created)} ctx={handoff} onDone={onClose} intro={`${created.title} is created.`} />;
  const submit = () => {
    if (sending.current) return;
    const found = validateNewTask(values, mounts);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length) return;
    sending.current = true;
    setBusy(true);
    onCreate(newTaskInput(values, mounts)).then(
      (task) => {
        sending.current = false;
        setBusy(false);
        setCreated(task);
        onCreated?.(task);
      },
      (e: unknown) => {
        sending.current = false;
        setBusy(false);
        const err = newTaskServerError(e, developer);
        if (err.field) setErrors({ [err.field]: err.text });
        else setFormError(err.text);
      },
    );
  };
  return <NewTaskForm mounts={mounts} values={values} errors={errors} formError={formError} busy={busy} chooseFolders={developer} onChange={setValues} onSubmit={submit} onCancel={onClose} />;
}
