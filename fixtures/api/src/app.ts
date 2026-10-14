import { Hono } from "hono";
import { cors } from "hono/cors";
import { MAX_SEATS, isPlan, priceQuote } from "./pricing.js";

/** The subset of a KV namespace the orders endpoint uses (real KV in production, a fixture in preview). */
export interface OrderStore {
  put(key: string, value: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: Array<{ name: string }>; list_complete?: boolean }>;
}

/** The subset of a D1 database the contacts endpoints use (real D1 in staging; absent in production and previews). */
export interface D1Like {
  prepare(sql: string): {
    bind(...args: unknown[]): { all(): Promise<{ results: unknown[] }>; run(): Promise<unknown> };
  };
}

export interface Env {
  APP_VERSION?: string;
  /** set by the CommonForge release service; the publish health check reads it back from /version */
  COMMONFORGE_RELEASE_ID?: string;
  /** order records (production: a KV namespace; private preview: an in-memory fixture) */
  ORDERS?: OrderStore;
  /** contacts table (staging: a D1 database; production and previews: unbound, /contacts answers 503) */
  DB?: D1Like;
  /** payment-like side effect: an order is POSTed here when set (preview: a fixture sink) */
  PAYMENT_WEBHOOK_URL?: string;
}

export const SERVICE_NAME = "commonforge-demo-api";
const DEFAULT_VERSION = "1.0.0";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function createApp() {
  const app = new Hono<{ Bindings: Env }>();

  // The website is served from a different origin in preview and production.
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST"] }));

  app.get("/version", (c) =>
    c.json({
      name: SERVICE_NAME,
      version: c.env?.APP_VERSION ?? DEFAULT_VERSION,
      release: c.env?.COMMONFORGE_RELEASE_ID ?? null,
    }),
  );

  /**
   * POST /orders {plan, seats, customer}: a database write (ORDERS) plus a payment-like call
   * (PAYMENT_WEBHOOK_URL). Used by the preview data-isolation test (AT-31): in a private preview
   * both go to fixtures, never to production.
   */
  app.post("/orders", async (c) => {
    const store = c.env?.ORDERS;
    if (!store) return c.json({ error: "orders_not_configured" }, 503);
    let body: { plan?: unknown; seats?: unknown; customer?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const plan = typeof body.plan === "string" ? body.plan : "starter";
    const seats = typeof body.seats === "number" && Number.isInteger(body.seats) ? body.seats : 1;
    const customer = typeof body.customer === "string" ? body.customer.trim() : "Demo Client";
    if (!isPlan(plan)) return c.json({ error: "invalid_plan" }, 400);
    if (seats < 1 || seats > MAX_SEATS) return c.json({ error: "invalid_seats" }, 400);
    if (customer.length === 0 || customer.length > 120) return c.json({ error: "invalid_customer" }, 400);
    const quote = priceQuote({ customer, plan, seats, pricingDate: today() }, c.env?.APP_VERSION ?? DEFAULT_VERSION);
    const orderId = `ord-${quote.quoteId}-${Date.now().toString(36)}`;
    await store.put(`order:${orderId}`, JSON.stringify({ orderId, quote }));
    let charged = false;
    if (c.env?.PAYMENT_WEBHOOK_URL) {
      const res = await fetch(c.env.PAYMENT_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId, amount: quote.total, currency: quote.currency }),
      });
      charged = res.ok;
    }
    return c.json({ orderId, total: quote.total, currency: quote.currency, charged }, 201);
  });

  /** GET /orders/count: how many orders the configured store holds (side-effect counter). */
  app.get("/orders/count", async (c) => {
    const store = c.env?.ORDERS;
    if (!store) return c.json({ error: "orders_not_configured" }, 503);
    let count = 0;
    const page = await store.list({ prefix: "order:" });
    count += page.keys.length;
    return c.json({ count, complete: page.list_complete ?? true });
  });

  /** GET /contacts: the contacts table, when a D1 database is bound. */
  app.get("/contacts", async (c) => {
    const db = c.env?.DB;
    if (!db) return c.json({ error: "no database" }, 503);
    const { results } = await db.prepare("SELECT id, name, email FROM contacts ORDER BY id").bind().all();
    return c.json({ contacts: results });
  });

  /** POST /contacts {name, email}: add a contact, when a D1 database is bound. */
  app.post("/contacts", async (c) => {
    const db = c.env?.DB;
    if (!db) return c.json({ error: "no database" }, 503);
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; email?: unknown } | null;
    if (typeof body?.name !== "string" || typeof body?.email !== "string") return c.json({ error: "name and email are required" }, 400);
    await db.prepare("INSERT INTO contacts (name, email) VALUES (?, ?)").bind(body.name, body.email).run();
    return c.json({ ok: true }, 201);
  });

  /**
   * GET /quote?plan=team&seats=12&customer=Acme[&date=YYYY-MM-DD]
   * Response shape: requirements/contracts/quote.schema.json.
   */
  app.get("/quote", (c) => {
    const plan = c.req.query("plan") ?? "starter";
    const seatsRaw = c.req.query("seats") ?? "1";
    const customer = (c.req.query("customer") ?? "Demo Client").trim();
    const pricingDate = c.req.query("date") ?? today();

    if (!isPlan(plan)) return c.json({ error: "invalid_plan" }, 400);
    if (!/^\d+$/.test(seatsRaw)) return c.json({ error: "invalid_seats" }, 400);
    const seats = Number(seatsRaw);
    if (seats < 1 || seats > MAX_SEATS) return c.json({ error: "invalid_seats" }, 400);
    if (customer.length === 0 || customer.length > 120) {
      return c.json({ error: "invalid_customer" }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pricingDate) || Number.isNaN(Date.parse(pricingDate))) {
      return c.json({ error: "invalid_date" }, 400);
    }

    const version = c.env?.APP_VERSION ?? DEFAULT_VERSION;
    return c.json(priceQuote({ customer, plan, seats, pricingDate }, version));
  });

  return app;
}
