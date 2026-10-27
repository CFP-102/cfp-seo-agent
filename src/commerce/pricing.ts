import { MAX_MARKUP_BPS } from "../config/commerce.js";
import { ceilDiv, ceilToCent, convertToUsd, formatMicro, toMicro, toRate } from "./money.js";

/**
 * Central price engine for gift cards.
 *
 *   cost       = provider cost converted to USD (rounded up) + provider fee
 *   markup     = cost x markup (rounded up to the micro-unit)
 *   sale price = cost + markup + payment fee, rounded UP to whole cents
 *   contribution = sale price - cost - payment fee   (what is actually left for us)
 *
 * Example: cost 100.00 USD, markup 3.5 %, no fees -> markup 3.50, sale price 103.50, contribution 3.50.
 * Tax: gift cards are usually multi-purpose vouchers (no VAT on the sale); how the markup is taxed is open and must be
 * confirmed by a tax advisor before real sales (docs/COMMERCE.md). The engine therefore adds no tax.
 */
export interface PriceInput {
  /** Provider purchase cost in `costCurrency`, decimal string. */
  cost: string;
  costCurrency: string;
  /** Units of USD per unit of `costCurrency` (1 for USD), decimal string with up to 8 decimals. */
  rateToUsd: string;
  /** Fixed provider fee per order in USD. */
  providerFeeUsd: string;
  /** Network / facilitator fee per order in USD that we pay. */
  paymentFeeUsd: string;
  markupBps: number;
}

export interface Price {
  cost_micro: bigint;
  markup_micro: bigint;
  payment_fee_micro: bigint;
  sale_micro: bigint;
  contribution_micro: bigint;
  markup_bps: number;
}

export function priceOf(input: PriceInput): Price {
  if (!Number.isInteger(input.markupBps) || input.markupBps < 0 || input.markupBps > MAX_MARKUP_BPS) throw new RangeError("markup out of range");
  if (input.costCurrency === "USD" && input.rateToUsd !== "1") throw new RangeError("USD cost needs rate 1");
  const rate = toRate(input.rateToUsd);
  if (rate === 0n) throw new RangeError("exchange rate must be positive");
  const cost = convertToUsd(toMicro(input.cost), rate) + toMicro(input.providerFeeUsd);
  if (cost === 0n) throw new RangeError("cost must be positive");
  const markup = ceilDiv(cost * BigInt(input.markupBps), 10_000n);
  const paymentFee = toMicro(input.paymentFeeUsd);
  const sale = ceilToCent(cost + markup + paymentFee);
  return { cost_micro: cost, markup_micro: markup, payment_fee_micro: paymentFee, sale_micro: sale, contribution_micro: sale - cost - paymentFee, markup_bps: input.markupBps };
}

/** The part a buyer sees: price and the markup rate, not our purchase cost. */
export function publicPrice(p: Price) {
  return { amount_usdc: formatMicro(p.sale_micro), currency: "USDC", service_fee_percent: formatBps(p.markup_bps), rounding: "rounded up to whole cents" };
}

/** 350 -> "3.5", 1000 -> "10". */
export const formatBps = (bps: number) => (bps / 100).toFixed(2).replace(/\.?0+$/, "");
