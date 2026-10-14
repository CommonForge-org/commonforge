import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { CommonForgeApi } from "../api/client.js";
import type { FakeApi } from "../api/fake.js";
import type { Me } from "../api/types.js";

export interface AppServices {
  api: CommonForgeApi;
  /** set in fixture mode only: the fake, so the banner can switch roles */
  fixture: FakeApi | null;
  me: Me | null;
  refreshMe: () => Promise<void>;
}

export const AppContext = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const v = useContext(AppContext);
  if (!v) throw new Error("AppContext missing");
  return v;
}

export interface Loaded<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Load `fn()` when `key` changes; optionally poll every `pollMs` while the tab is visible.
 * Requests are serialized (review I-2, m-7): a poll tick is skipped while a request is in flight,
 * and a `reload()` during one runs once right after it, so a slow request is never discarded by
 * the next tick and results arrive in order. Polling keeps the previous data on screen.
 */
export function useLoad<T>(fn: () => Promise<T>, key: string, pollMs?: number): Loaded<T> {
  const [state, setState] = useState<{ key: string; data: T | undefined; error: unknown; loading: boolean }>({ key, data: undefined, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useRef<{ key: string; inflight: boolean; again: boolean; alive: boolean }>({ key, inflight: false, again: false, alive: true });

  const start = useCallback((forKey: string) => {
    const r = run.current;
    if (r.inflight) {
      r.again = true;
      return;
    }
    r.inflight = true;
    setState((s) => (s.key === forKey ? { ...s, loading: true } : { key: forKey, data: undefined, error: null, loading: true }));
    fnRef
      .current()
      .then(
        (data) => r.alive && r.key === forKey && setState({ key: forKey, data, error: null, loading: false }),
        (error: unknown) => r.alive && r.key === forKey && setState((s) => ({ ...s, key: forKey, error, loading: false })),
      )
      .finally(() => {
        r.inflight = false;
        if (r.alive && r.again) {
          r.again = false;
          start(r.key);
        }
      });
  }, []);

  useEffect(() => {
    const r = run.current;
    r.alive = true;
    r.key = key;
    r.again = false;
    start(key);
    return () => {
      r.alive = false;
    };
  }, [key, start]);

  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => {
      const visible = typeof document === "undefined" || document.visibilityState === "visible";
      if (visible && !run.current.inflight) start(run.current.key);
    }, pollMs);
    return () => clearInterval(id);
  }, [key, pollMs, start]);

  const reload = useCallback(() => start(run.current.key), [start]);
  const current = state.key === key ? state : { data: undefined, error: null, loading: true };
  return { data: current.data, error: current.error, loading: current.loading, reload };
}

/** Run an action with a busy flag and an error slot. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (e) {
        setError(e);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [fn],
  );
  return { run, busy, error, clearError: () => setError(null) };
}
