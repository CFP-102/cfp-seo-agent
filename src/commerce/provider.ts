import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CIRCUIT_FAILURES, CIRCUIT_OPEN_MS, PROVIDER_TIMEOUT_MS } from "../config/commerce.js";
import { isAmount, isRate, toMicro } from "./money.js";

/**
 * Gift card supplier abstraction. A real supplier (Bitrefill, Reloadly, Tillo, ...) gets its own adapter once a reseller
 * contract exists; until then only the mock provider below is implemented (docs/COMMERCE.md).
 */
export interface GiftCardProduct {
  id: string;
  brand: string;
  /** ISO 3166-1 alpha-2 country where the card can be redeemed. */
  country: string;
  /** ISO 4217 currency of the face value. */
  currency: string;
  category: string;
  description: string;
  /** Allowed face values: a fixed list or a range (decimal strings in `currency`). */
  denominations: { type: "fixed"; values: string[] } | { type: "range"; min: string; max: string };
}

export interface ProviderQuote {
  available: boolean;
  /** What the supplier charges us for one card. */
  cost: string;
  cost_currency: string;
  /** USD per unit of cost_currency. */
  rate_to_usd: string;
  fee_usd: string;
}

export interface ProviderOrder {
  provider_order_id: string;
  code: string;
  pin: string | null;
  expires_at: string | null;
}

export interface GiftCardProvider {
  readonly id: string;
  /** False for the mock: its codes are worthless test values. */
  readonly live: boolean;
  products(signal: AbortSignal): Promise<GiftCardProduct[]>;
  quote(productId: string, faceValue: string, signal: AbortSignal): Promise<ProviderQuote>;
  /** Must be idempotent on `idempotencyKey`: the same key never buys a second card. */
  order(req: { idempotencyKey: string; productId: string; faceValue: string }, signal: AbortSignal): Promise<ProviderOrder>;
}

const dec = z.string().refine(isAmount, "decimal amount");
const ProductSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,60}$/),
  brand: z.string().min(1).max(80),
  country: z.string().regex(/^[A-Z]{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  category: z.string().min(1).max(40),
  description: z.string().max(300),
  denominations: z.discriminatedUnion("type", [
    z.object({ type: z.literal("fixed"), values: z.array(dec).min(1).max(50) }),
    z.object({ type: z.literal("range"), min: dec, max: dec }),
  ]),
});
const QuoteSchema = z.object({
  available: z.boolean(),
  cost: dec,
  cost_currency: z.string().regex(/^[A-Z]{3}$/),
  rate_to_usd: z.string().refine(isRate, "rate"),
  fee_usd: dec,
});
const OrderSchema = z.object({
  provider_order_id: z.string().min(1).max(120),
  code: z.string().min(4).max(200),
  pin: z.string().max(60).nullable(),
  expires_at: z.string().max(40).nullable(),
});

export class ProviderError extends Error {
  constructor(readonly code: "provider_unavailable" | "provider_timeout" | "provider_invalid_response" | "provider_rejected", message: string = code) {
    super(message);
  }
}

/**
 * Wraps a provider with the safety rules every adapter gets: a timeout per call, validation of every response, and a
 * circuit breaker (after CIRCUIT_FAILURES failures in a row, calls fail fast for CIRCUIT_OPEN_MS).
 */
export function guardProvider(p: GiftCardProvider, opts: { timeoutMs?: number; now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  let failures = 0;
  let openUntil = 0;
  async function call<T>(schema: z.ZodType<T>, run: (signal: AbortSignal) => Promise<unknown>): Promise<T> {
    if (now() < openUntil) throw new ProviderError("provider_unavailable", "supplier temporarily unavailable");
    const signal = AbortSignal.timeout(opts.timeoutMs ?? PROVIDER_TIMEOUT_MS);
    try {
      const raw = await run(signal);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new ProviderError("provider_invalid_response");
      failures = 0;
      return parsed.data;
    } catch (err) {
      // A refused request (e.g. unknown product) says nothing about the supplier's health.
      const rejected = err instanceof ProviderError && err.code === "provider_rejected";
      if (!rejected && ++failures >= CIRCUIT_FAILURES) openUntil = now() + CIRCUIT_OPEN_MS;
      if (err instanceof ProviderError) throw err;
      if (signal.aborted) throw new ProviderError("provider_timeout");
      throw new ProviderError("provider_unavailable");
    }
  }
  return {
    id: p.id,
    live: p.live,
    open: () => now() < openUntil,
    products: () => call(z.array(ProductSchema).max(500), (s) => p.products(s)),
    quote: (productId: string, faceValue: string) => call(QuoteSchema, (s) => p.quote(productId, faceValue, s)),
    order: (req: { idempotencyKey: string; productId: string; faceValue: string }) => call(OrderSchema, (s) => p.order(req, s)),
  };
}

export type GuardedProvider = ReturnType<typeof guardProvider>;

/** True if `faceValue` is one of the product's allowed denominations. */
export function denominationAllowed(product: GiftCardProduct, faceValue: string): boolean {
  if (!isAmount(faceValue)) return false;
  const v = toMicro(faceValue);
  const d = product.denominations;
  if (d.type === "fixed") return d.values.some((x) => toMicro(x) === v);
  return v >= toMicro(d.min) && v <= toMicro(d.max) && v % 10_000n === 0n;
}

/** Fictional demo brands, so nothing on the site suggests a partnership with a real brand. */
const MOCK_PRODUCTS: GiftCardProduct[] = [
  { id: "demo-books-de", brand: "Demo Books", country: "DE", currency: "EUR", category: "books", description: "Fictional test product. The code has no value.", denominations: { type: "fixed", values: ["10.00", "25.00", "50.00"] } },
  { id: "demo-games-us", brand: "Demo Games", country: "US", currency: "USD", category: "gaming", description: "Fictional test product. The code has no value.", denominations: { type: "fixed", values: ["10.00", "20.00", "50.00", "100.00"] } },
  { id: "demo-travel-de", brand: "Demo Travel", country: "DE", currency: "EUR", category: "travel", description: "Fictional test product. The code has no value.", denominations: { type: "range", min: "5.00", max: "90.00" } },
  { id: "demo-music-at", brand: "Demo Music", country: "AT", currency: "EUR", category: "entertainment", description: "Fictional test product. The code has no value.", denominations: { type: "fixed", values: ["15.00", "30.00"] } },
];

/** Mock exchange rates (fixed, for tests only). */
const MOCK_RATES: Record<string, string> = { USD: "1", EUR: "1.08" };

/**
 * Development supplier: fixed catalog, cost = face value, test codes. Idempotent like a real supplier must be.
 * `failOrders` makes the next n orders fail (tests of the refund path); `unavailable` marks every product out of stock.
 */
export class MockGiftCardProvider implements GiftCardProvider {
  readonly id = "mock";
  readonly live = false;
  readonly orders = new Map<string, ProviderOrder>();
  failOrders = 0;
  unavailable = false;
  orderCalls = 0;

  async products() {
    return MOCK_PRODUCTS;
  }

  async quote(productId: string, faceValue: string) {
    const product = MOCK_PRODUCTS.find((p) => p.id === productId);
    if (!product) throw new ProviderError("provider_rejected", "unknown product");
    return { available: !this.unavailable, cost: faceValue, cost_currency: product.currency, rate_to_usd: MOCK_RATES[product.currency]!, fee_usd: "0" };
  }

  async order(req: { idempotencyKey: string; productId: string; faceValue: string }) {
    this.orderCalls++;
    const seen = this.orders.get(req.idempotencyKey);
    if (seen) return seen;
    if (this.failOrders > 0) {
      this.failOrders--;
      throw new Error("mock supplier failure");
    }
    const part = () => randomBytes(3).toString("hex").toUpperCase();
    const out = { provider_order_id: `mock-${part()}${part()}`, code: `DEMO-${part()}-${part()}-${part()}`, pin: String(randomBytes(2).readUInt16BE() % 10000).padStart(4, "0"), expires_at: null };
    this.orders.set(req.idempotencyKey, out);
    return out;
  }
}
