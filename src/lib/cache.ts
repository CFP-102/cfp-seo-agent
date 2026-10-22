import { createHash } from "node:crypto";

/** Small in-memory TTL cache for identical upstream requests. Process-local by design (single instance MVP). */
export class TtlCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      // Map preserves insertion order: drop the oldest entry.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Deterministic key: sorted-key JSON, so {a,b} and {b,a} hit the same entry. */
export function cacheKey(serviceId: string, input: unknown): string {
  return createHash("sha256").update(serviceId).update("\0").update(stableStringify(input)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
