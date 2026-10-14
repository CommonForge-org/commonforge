/** Client for the api fixture's GET /quote. */

export type Plan = "starter" | "team" | "enterprise";

/** Mirrors requirements/contracts/quote.schema.json (the contract test enforces it). */
export interface Quote {
  quoteId: string;
  customer: string;
  plan: Plan;
  seats: number;
  currency: "USD";
  unitPrice: number;
  total: number;
  validUntil: string;
  apiVersion: string;
}

export interface QuoteRequest {
  customer: string;
  plan: Plan;
  seats: number;
}

/** Builds the /quote URL. An empty base means same origin (Vite dev proxy). */
export function buildQuoteUrl(apiBase: string, req: QuoteRequest): string {
  const params = new URLSearchParams({
    plan: req.plan,
    seats: String(req.seats),
    customer: req.customer,
  });
  return `${apiBase.replace(/\/$/, "")}/quote?${params.toString()}`;
}

export async function fetchQuote(
  apiBase: string,
  req: QuoteRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<Quote> {
  const res = await fetchImpl(buildQuoteUrl(apiBase, req));
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `quote_failed_${res.status}`);
  }
  return (await res.json()) as Quote;
}
