import type { Quote } from "./quote.js";

const PLAN_LABEL: Record<Quote["plan"], string> = {
  starter: "Starter",
  team: "Team",
  enterprise: "Enterprise",
};

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatMoney(amount: number, currency: Quote["currency"]): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

/** Renders a quote as an HTML string (kept DOM-free so it is unit-testable). */
export function renderQuote(quote: Quote): string {
  return [
    `<article class="quote-card" data-quote-id="${escapeHtml(quote.quoteId)}">`,
    `<h2>Quote for ${escapeHtml(quote.customer)}</h2>`,
    "<dl>",
    `<dt>Plan</dt><dd>${PLAN_LABEL[quote.plan]}</dd>`,
    `<dt>Seats</dt><dd>${quote.seats}</dd>`,
    `<dt>Per seat / month</dt><dd>${formatMoney(quote.unitPrice, quote.currency)}</dd>`,
    `<dt>Total / month</dt><dd class="total">${formatMoney(quote.total, quote.currency)}</dd>`,
    `<dt>Valid until</dt><dd>${escapeHtml(quote.validUntil)}</dd>`,
    "</dl>",
    "</article>",
  ].join("");
}

export function renderError(message: string): string {
  return `<p class="quote-error" role="alert">Could not get a quote: ${escapeHtml(message)}</p>`;
}
