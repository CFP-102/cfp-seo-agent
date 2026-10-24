/**
 * The example response of a service travels inside the 402 payment header (Bazaar discovery), and many HTTP clients and
 * proxies cap a header at 8-16 KB. This keeps the structure (every key, nested shapes) but shortens lists and long texts.
 */
export function compactExample<T>(value: T, maxItems = 2, maxChars = 70): T {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.slice(0, maxItems).map(walk);
    if (typeof v === "string") return v.length > maxChars ? `${v.slice(0, maxChars - 1)}…` : v;
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
