/** Pricing rules from requirements R1.3 and R1.4. Pure and Worker-safe. */

export const PLANS = ["starter", "team", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

export const UNIT_PRICE_USD: Record<Plan, number> = {
  starter: 12,
  team: 29,
  enterprise: 59,
};

export const MAX_SEATS = 10_000;
export const VALIDITY_DAYS = 30;

export interface QuoteInput {
  customer: string;
  plan: Plan;
  seats: number;
  /** Pricing date as YYYY-MM-DD (UTC). */
  pricingDate: string;
}

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

export function isPlan(value: string): value is Plan {
  return (PLANS as readonly string[]).includes(value);
}

/** Volume discount rate (R1.4). */
export function discountRate(seats: number): number {
  if (seats >= 250) return 0.2;
  if (seats >= 50) return 0.1;
  return 0;
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 32-bit FNV-1a, hex. Deterministic quote ids without WebCrypto's async API. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function priceQuote(input: QuoteInput, apiVersion: string): Quote {
  const unitPrice = UNIT_PRICE_USD[input.plan];
  const gross = unitPrice * input.seats;
  const total = roundCents(gross * (1 - discountRate(input.seats)));
  const key = `${input.customer}|${input.plan}|${input.seats}|${input.pricingDate}`;
  return {
    quoteId: `q-${input.plan}-${input.seats}-${fnv1a(key)}`,
    customer: input.customer,
    plan: input.plan,
    seats: input.seats,
    currency: "USD",
    unitPrice,
    total,
    validUntil: addDays(input.pricingDate, VALIDITY_DAYS),
    apiVersion,
  };
}
