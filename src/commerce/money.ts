/**
 * Exact money arithmetic. Amounts are integers in micro-units (6 decimals, the precision of USDC); rates are integers
 * scaled by 10^8. Nothing here uses floating point, so 100.00 * 1.035 is exactly 103.50.
 */
export const MICRO = 1_000_000n;
export const RATE_SCALE = 100_000_000n;
const CENT = 10_000n;

const decimal = (maxDecimals: number) => new RegExp(`^(0|[1-9]\\d{0,11})(\\.\\d{1,${maxDecimals}})?$`);
const AMOUNT = decimal(6);
const RATE = decimal(8);

function scaled(value: string, re: RegExp, decimals: number): bigint {
  if (!re.test(value)) throw new RangeError(`not a decimal amount: ${JSON.stringify(value).slice(0, 40)}`);
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole! + frac.padEnd(decimals, "0"));
}

/** "103.5" -> 103_500_000n. At most 6 decimals, never negative. */
export const toMicro = (value: string): bigint => scaled(value, AMOUNT, 6);
/** "1.0825" -> 108_250_000n. At most 8 decimals. */
export const toRate = (value: string): bigint => scaled(value, RATE, 8);

export const isAmount = (value: string) => AMOUNT.test(value);
export const isRate = (value: string) => RATE.test(value);

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (a < 0n || b <= 0n) throw new RangeError("ceilDiv expects a >= 0 and b > 0");
  return (a + b - 1n) / b;
}

/** Round up to whole cents: a buyer is never charged less than the computed price. */
export const ceilToCent = (micro: bigint): bigint => ceilDiv(micro, CENT) * CENT;

/** 103_500_000n -> "103.50" (cents) or "103.500000" (digits = 6). Exact; callers round before formatting. */
export function formatMicro(micro: bigint, digits: 2 | 6 = 2): string {
  if (micro < 0n) return `-${formatMicro(-micro, digits)}`;
  const whole = micro / MICRO;
  const frac = (micro % MICRO).toString().padStart(6, "0");
  if (digits === 2 && frac.slice(2) !== "0000") throw new RangeError("amount is not a whole number of cents");
  return `${whole}.${frac.slice(0, digits)}`;
}

/** Converts an amount in another currency to USD micro-units, rounding up (cost is never underestimated). */
export const convertToUsd = (amountMicro: bigint, rateToUsd: bigint): bigint => ceilDiv(amountMicro * rateToUsd, RATE_SCALE);
