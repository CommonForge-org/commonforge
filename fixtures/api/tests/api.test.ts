import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { discountRate, priceQuote } from "../src/pricing.js";

const app = createApp();

describe("GET /version", () => {
  it("returns service name and version", async () => {
    const res = await app.request("/version", {}, { APP_VERSION: "1.2.3" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "commonforge-demo-api", version: "1.2.3", release: null });
  });

  it("falls back to the default version without bindings", async () => {
    const res = await app.request("/version");
    expect(await res.json()).toEqual({ name: "commonforge-demo-api", version: "1.0.0", release: null });
  });
});

describe("GET /quote", () => {
  it("prices a team quote deterministically", async () => {
    const res = await app.request("/quote?plan=team&seats=12&customer=Acme&date=2026-10-01");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      customer: "Acme",
      plan: "team",
      seats: 12,
      currency: "USD",
      unitPrice: 29,
      total: 348,
      validUntil: "2026-10-31",
      apiVersion: "1.0.0",
    });
    expect(body.quoteId).toMatch(/^q-team-12-[0-9a-f]{8}$/);
    const again = await app.request("/quote?plan=team&seats=12&customer=Acme&date=2026-10-01");
    expect(((await again.json()) as Record<string, unknown>).quoteId).toBe(body.quoteId);
  });

  it("applies volume discounts", () => {
    expect(discountRate(49)).toBe(0);
    expect(discountRate(50)).toBe(0.1);
    expect(discountRate(250)).toBe(0.2);
    const q = priceQuote(
      { customer: "Big Co", plan: "enterprise", seats: 300, pricingDate: "2026-10-01" },
      "1.0.0",
    );
    expect(q.total).toBe(14160);
  });

  it.each([
    ["/quote?plan=gold", "invalid_plan"],
    ["/quote?seats=0", "invalid_seats"],
    ["/quote?seats=1.5", "invalid_seats"],
    ["/quote?seats=10001", "invalid_seats"],
    ["/quote?customer=%20", "invalid_customer"],
    ["/quote?date=yesterday", "invalid_date"],
  ])("rejects %s", async (path, error) => {
    const res = await app.request(path);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  it("allows cross-origin GETs from the website", async () => {
    const res = await app.request("/quote", { headers: { Origin: "https://portal.example" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("POST /orders (side effects, AT-31)", () => {
  const memoryStore = () => {
    const data = new Map<string, string>();
    return {
      data,
      async put(key: string, value: string) {
        data.set(key, value);
      },
      async list({ prefix }: { prefix: string }) {
        return { keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
      },
    };
  };

  it("is disabled without an order store", async () => {
    const res = await app.request("/orders", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
  });

  it("writes to the configured store and counts it", async () => {
    const ORDERS = memoryStore();
    const res = await app.request(
      "/orders",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "team", seats: 3, customer: "Acme" }) },
      { ORDERS },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ total: 87, currency: "USD", charged: false });
    const count = await app.request("/orders/count", {}, { ORDERS });
    expect(await count.json()).toEqual({ count: 1, complete: true });
  });

  it("reports the release id on /version", async () => {
    const res = await app.request("/version", {}, { COMMONFORGE_RELEASE_ID: "rel-123" });
    expect(await res.json()).toMatchObject({ release: "rel-123" });
  });
});

function memoryD1() {
  const rows: Array<{ id: number; name: string; email: string }> = [];
  return {
    rows,
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => ({
          async all() {
            return { results: sql.startsWith("SELECT") ? [...rows] : [] };
          },
          async run() {
            if (sql.startsWith("INSERT")) rows.push({ id: rows.length + 1, name: String(args[0]), email: String(args[1]) });
            return { success: true };
          },
        }),
      };
    },
  };
}

describe("/contacts", () => {
  it("lists and adds contacts when a database is bound, 503 without one", async () => {
    const DB = memoryD1();
    const add = await app.request(
      "/contacts",
      { method: "POST", body: JSON.stringify({ name: "Ada", email: "ada@example.com" }), headers: { "content-type": "application/json" } },
      { DB },
    );
    expect(add.status).toBe(201);
    const list = await app.request("/contacts", {}, { DB });
    expect(await list.json()).toEqual({ contacts: [{ id: 1, name: "Ada", email: "ada@example.com" }] });
    const none = await app.request("/contacts", {}, {});
    expect(none.status).toBe(503);
    expect(await none.json()).toEqual({ error: "no database" });
    const bad = await app.request("/contacts", { method: "POST", body: JSON.stringify({ name: "x" }), headers: { "content-type": "application/json" } }, { DB });
    expect(bad.status).toBe(400);
  });
});
