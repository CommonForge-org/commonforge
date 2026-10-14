/**
 * Fails the preview unit fast when the preview build fails. The UI wait for "Open preview" has no
 * way to know the build died, so without this the unit waits out the whole long timeout (30 min)
 * for a preview that will never appear. The watcher polls `GET /api/orgs/:o/proposals/:id/previews`
 * alongside the UI wait: a failed preview for the current proposal hash aborts the unit at once,
 * naming the build's error; a ready one just stops the watcher and leaves the UI wait to finish.
 */

/** The fields of the previews API (`PreviewView` in apps/web/src/api/types.ts) the watcher reads. */
export interface PreviewEntry {
  previewId: string;
  state: string;
  createdAt?: string;
  /** false: the preview was built for an older proposal hash. Absent counts as current. */
  forCurrentHash?: boolean;
  error?: { code: string; detail?: string } | null;
}

export type ListPreviews = () => Promise<PreviewEntry[]>;

/** The failure message: the build's error code and the first 300 characters of its detail. */
export function previewFailureMessage(preview: PreviewEntry): string {
  const code = preview.error?.code ?? 'unknown';
  const detail = (preview.error?.detail ?? '').slice(0, 300);
  return `the preview build failed (${code})${detail ? `: ${detail}` : ''}`;
}

/** The newest preview for the current proposal hash, or undefined when there is none yet. */
export function newestCurrentPreview(previews: PreviewEntry[], ignore: ReadonlySet<string> = new Set()): PreviewEntry | undefined {
  const at = (p: PreviewEntry) => (p.createdAt ? Date.parse(p.createdAt) : 0);
  return previews
    .filter((p) => p.forCurrentHash !== false && !ignore.has(p.previewId))
    .reduce<PreviewEntry | undefined>((newest, p) => (!newest || at(p) >= at(newest) ? p : newest), undefined);
}

export interface WatchOptions {
  intervalMs: number;
  /** Stops the watcher (it then resolves 'stopped'). */
  signal?: AbortSignal;
  /** Previews to disregard, e.g. a failed build from before this run asked for a new one. */
  ignore?: ReadonlySet<string>;
}

/**
 * Polls until the newest current preview is `ready` (resolves 'ready'), is `failed` (rejects with
 * its error code and the start of its detail) or the signal aborts (resolves 'stopped'). A poll
 * that errors is skipped: the UI wait still covers the case where the API stays unreachable.
 */
export async function watchPreview(list: ListPreviews, opts: WatchOptions): Promise<'ready' | 'stopped'> {
  const { signal, intervalMs, ignore } = opts;
  while (!signal?.aborted) {
    const newest = await list().then(
      (previews) => newestCurrentPreview(previews, ignore),
      () => undefined,
    );
    if (signal?.aborted) break;
    if (newest?.state === 'failed') throw new Error(previewFailureMessage(newest));
    if (newest?.state === 'ready') return 'ready';
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  return 'stopped';
}

/**
 * Waits for `uiWait` while watching the previews API: a failed preview rejects immediately; a
 * ready one (or no news) leaves the outcome to `uiWait`.
 */
export async function withPreviewWatch<T>(uiWait: Promise<T>, list: ListPreviews, opts: Omit<WatchOptions, 'signal'>): Promise<T> {
  const stop = new AbortController();
  // the UI wait is handled by the race below; keep a late rejection from also being unhandled
  uiWait.catch(() => undefined);
  const watch = watchPreview(list, { ...opts, signal: stop.signal });
  try {
    return await Promise.race([uiWait, watch.then(() => uiWait)]);
  } finally {
    stop.abort();
    watch.catch(() => undefined);
  }
}

export interface EnsurePreviewDeps {
  list: ListPreviews;
  /** Tries the UI's Build preview button; may throw when the control is missing or disabled. */
  clickBuild: () => Promise<void>;
  /** Requests the build through the API (`POST .../previews`, empty JSON body); throws on a non-2xx answer. */
  requestApi: () => Promise<void>;
  log: (line: string) => void;
  /** Poll interval while waiting for the preview to become ready. */
  intervalMs: number;
  /** How long to wait for the UI click to show up as a new preview before using the API. */
  settleMs: number;
  /** Upper bound for the preview to become ready. */
  timeoutMs: number;
}

/**
 * Gets a ready preview of the current proposal hash without relying on any UI element to appear.
 * The Change storyboard (developer view) has no "Open preview" link, so this goes by the previews
 * API: a ready preview is used as is; one still building is awaited; otherwise the UI button is
 * tried and, when no new preview shows up within `settleMs`, the API is asked directly. A preview
 * that failed before this run is ignored, a failure of the new one aborts at once.
 * Resolves how the preview came about: 'existing' (nothing requested), 'ui' or 'api'.
 */
export async function ensurePreviewReady(deps: EnsurePreviewDeps): Promise<'existing' | 'ui' | 'api'> {
  const { list, intervalMs, settleMs, timeoutMs, log } = deps;
  const before = await list().catch(() => [] as PreviewEntry[]);
  const knownIds = new Set(before.map((p) => p.previewId));
  const failedBefore = new Set(before.filter((p) => p.state === 'failed').map((p) => p.previewId));
  const current = newestCurrentPreview(before, failedBefore);

  let how: 'existing' | 'ui' | 'api' = 'existing';
  if (!current) {
    const sawNew = async (): Promise<boolean> => (await list().catch(() => [] as PreviewEntry[])).some((p) => !knownIds.has(p.previewId));
    await deps.clickBuild().catch((err: unknown) => log(`  Build preview button not usable (${(err as Error).message.split('\n')[0]})`));
    const deadline = Date.now() + settleMs;
    let appeared = false;
    while (!(appeared = await sawNew()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
    }
    if (appeared) {
      how = 'ui';
      log('  preview requested via UI');
    } else {
      await deps.requestApi();
      how = 'api';
      log('  preview requested via API');
    }
  }

  const stop = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop.abort();
  }, timeoutMs);
  try {
    const outcome = await watchPreview(list, { intervalMs, signal: stop.signal, ignore: failedBefore });
    if (outcome === 'stopped' && timedOut) throw new Error(`the preview did not become ready within ${Math.round(timeoutMs / 1000)} s`);
  } finally {
    clearTimeout(timer);
  }
  return how;
}
