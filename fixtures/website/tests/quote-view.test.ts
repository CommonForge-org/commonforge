import { describe, expect, it } from "vitest";
import type { Quote } from "../src/quote.js";
import { buildQuoteUrl, fetchQuote } from "../src/quote.js";
import { escapeHtml, formatMoney, renderError, renderQuote } from "../src/quote-view.js";

const QUOTE: Quote = {
  quoteId: "q-team-12-0badc0de",
  customer: "Acme",
  plan: "team",
  seats: 12,
  currency: "USD",
  unitPrice: 29,
  total: 348,
  validUntil: "2026-10-31",
  apiVersion: "1.0.0",
};

describe("buildQuoteUrl", () => {
  it("encodes the request and trims a trailing slash on the base", () => {
    expect(buildQuoteUrl("https://api.example/", { customer: "A&B Co", plan: "team", seats: 3 })).toBe(
      "https://api.example/quote?plan=team&seats=3&customer=A%26B+Co",
    );
    expect(buildQuoteUrl("", { customer: "X", plan: "starter", seats: 1 })).toBe(
      "/quote?plan=starter&seats=1&customer=X",
    );
  });
});

describe("fetchQuote", () => {
  it("returns the parsed quote", async () => {
    const fake = (async () => Response.json(QUOTE)) as typeof fetch;
    await expect(fetchQuote("", { customer: "Acme", plan: "team", seats: 12 }, fake)).resolves.toEqual(QUOTE);
  });

  it("surfaces the api error code", async () => {
    const fake = (async () => Response.json({ error: "invalid_seats" }, { status: 400 })) as typeof fetch;
    await expect(fetchQuote("", { customer: "Acme", plan: "team", seats: 0 }, fake)).rejects.toThrow(
      "invalid_seats",
    );
  });
});

describe("renderQuote", () => {
  it("shows plan, seats, prices and validity", () => {
    const html = renderQuote(QUOTE);
    expect(html).toContain('data-quote-id="q-team-12-0badc0de"');
    expect(html).toContain("<h2>Quote for Acme</h2>");
    expect(html).toContain("<dd>Team</dd>");
    expect(html).toContain("<dd>12</dd>");
    expect(html).toContain("$29.00");
    expect(html).toContain('<dd class="total">$348.00</dd>');
    expect(html).toContain("<dd>2026-10-31</dd>");
  });

  it("escapes customer-provided text", () => {
    const html = renderQuote({ ...QUOTE, customer: '<script>"x"</script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
  });

  // Quote view cases end here. New presentation cases (for example a
  // per-seat breakdown or a redesigned total) are added directly below.
});

describe("helpers", () => {
  it("formats USD", () => {
    expect(formatMoney(14160, "USD")).toBe("$14,160.00");
  });

  it("escapes all HTML-special characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("renders errors as an alert", () => {
    expect(renderError("invalid_plan")).toContain('role="alert"');
  });
});
