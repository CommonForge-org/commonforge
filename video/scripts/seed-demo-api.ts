/**
 * Minimal CommonForge Worker API client for the demo seeder (apps/worker/API.md). Every call sends
 * `Authorization: Bearer <token>` (a `cfs_…` owner session or a `cfl_…` task lease; bearer calls skip
 * the CSRF check). Errors carry the method, path, status and the server's error code and message,
 * never a header or token.
 */

export class SeedApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SeedApiError';
  }
}

export interface Api {
  /** JSON request; `body` undefined sends no body. */
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
  /** Raw bytes upload (asset upload route). */
  bytes<T>(method: string, path: string, data: Uint8Array, contentType: string): Promise<T>;
  /** The same API with another bearer (an agent lease). */
  withToken(token: string): Api;
}

export function createApi(o: { baseUrl: string; token: string; fetch: typeof fetch }): Api {
  const base = o.baseUrl.replace(/\/+$/, '');
  const send = async <T>(method: string, path: string, body: BodyInit | undefined, contentType: string | undefined): Promise<T> => {
    const headers: Record<string, string> = { authorization: `Bearer ${o.token}`, accept: 'application/json' };
    if (contentType) headers['content-type'] = contentType;
    const res = await o.fetch(`${base}${path}`, { method, headers, redirect: 'error', ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = res.statusText;
      try {
        const e = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = e.error?.code ?? code;
        message = e.error?.message ?? message;
      } catch {
        /* not JSON */
      }
      throw new SeedApiError(res.status, code, `${method} ${path.replace(/\?.*$/, '')} → ${res.status} ${code}: ${message}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  };
  return {
    json: (method, path, body) => send(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json'),
    // a Uint8Array body gets its content-length from fetch (the upload route requires one)
    bytes: (method, path, data, contentType) => send(method, path, data as unknown as BodyInit, contentType),
    withToken: (token) => createApi({ ...o, token }),
  };
}
