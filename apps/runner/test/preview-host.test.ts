/**
 * AT-31 (preview data isolation), runner side: the preview host gives a bundle fixture bindings
 * only. Database writes, a payment-like call and an email-like call made in preview land in
 * fixtures; production stores and production endpoints are never reached, and their counters do
 * not move.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { createPreviewHost, serve, type WorkerModule } from '../src/preview-host.js';

/** "Production": a store and a payment provider with side-effect counters. */
const production = { orders: new Map<string, string>(), payments: 0, emails: 0 };
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Shaped like the demo api's POST /orders: KV write + payment webhook + email, plus a hard-coded production call. */
const worker: WorkerModule = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/env') return Response.json({ keys: Object.keys(env).sort(), cookie: request.headers.get('cookie'), auth: request.headers.get('authorization') });
    if (url.pathname === '/orders' && request.method === 'POST') {
      const orders = env.ORDERS as { put(k: string, v: string): Promise<void> };
      await orders.put(`order:${crypto.randomUUID()}`, await request.text());
      const pay = await fetch(String(env.PAYMENT_WEBHOOK_URL), { method: 'POST', body: '{}' });
      const mail = await fetch(String(env.EMAIL_WEBHOOK_URL), { method: 'POST', body: '{}' });
      let prodReached = true;
      try {
        await fetch('https://payments.production.example/charge', { method: 'POST' });
      } catch {
        prodReached = false;
      }
      return Response.json({ charged: pay.ok, emailed: mail.ok, prodReached }, { status: 201 });
    }
    return new Response('not found', { status: 404 });
  },
};

describe('preview host (AT-31)', () => {
  const host = createPreviewHost({ worker, vars: { APP_VERSION: '1.0.0' } });

  it('exposes fixture bindings and non-secret vars only; drops cookies and authorization', async () => {
    const r = await host.handle(new Request('http://preview/env', { headers: { cookie: 'cf_session=abc', authorization: 'Bearer cfs_x' } }));
    expect(await r.json()).toEqual({ keys: ['APP_VERSION', 'COMMONFORGE_PREVIEW', 'EMAIL_WEBHOOK_URL', 'ORDERS', 'PAYMENT_WEBHOOK_URL'], cookie: null, auth: null });
  });

  it('writes, payments and emails go to fixtures; production counters stay unchanged', async () => {
    const before = { orders: production.orders.size, payments: production.payments, emails: production.emails };
    for (let i = 0; i < 3; i++) {
      const r = await host.handle(new Request('http://preview/orders', { method: 'POST', body: JSON.stringify({ plan: 'team', seats: i + 1 }) }));
      expect(r.status).toBe(201);
      expect(await r.json()).toEqual({ charged: true, emailed: true, prodReached: false });
    }
    const fx = (await (await host.handle(new Request('http://preview/__fixtures'))).json()) as { counters: Record<string, unknown> };
    expect(fx.counters).toMatchObject({ ordersWritten: 3, payments: 3, emails: 3, blockedOutbound: 3, blockedDestinations: ['https://payments.production.example', 'https://payments.production.example', 'https://payments.production.example'] });
    expect({ orders: production.orders.size, payments: production.payments, emails: production.emails }).toEqual(before);
  });

  it('serves over HTTP and never forwards Set-Cookie', async () => {
    const h = createPreviewHost({
      worker: { fetch: () => new Response('hi', { headers: { 'set-cookie': 'x=1', 'x-ok': '1' } }) },
    });
    globalThis.fetch = realFetch; // the host replaced fetch; the test client needs the real one
    const server = serve(h, 0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await realFetch(`http://127.0.0.1:${port}/x`);
    expect(await res.text()).toBe('hi');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-ok')).toBe('1');
    server.close();
  });
});
