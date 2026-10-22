import { isIPv6 } from "node:net";
import type { RequestHandler } from "express";

/**
 * Identity used for per-client limits. IPv4 as is; IPv4-mapped IPv6 reduced to IPv4;
 * IPv6 reduced to its /64 prefix (one customer typically owns a whole /64, so per-address keys
 * would make the limit meaningless).
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1]!;
  if (!isIPv6(ip)) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const hasGap = ip.includes("::");
  const fill = hasGap ? Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0") : [];
  const all = [...headGroups, ...fill, ...tailGroups];
  // IPv4-mapped in hex form (::ffff:0102:0304) is the same client as 1.2.3.4
  if (all.length === 8 && all.slice(0, 5).every((g) => /^0+$/.test(g)) && /^0*ffff$/.test(all[5]!)) {
    const hi = parseInt(all[6]!, 16);
    const lo = parseInt(all[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const groups = all.slice(0, 4).map((g) => g.padStart(4, "0"));
  return `${groups.join(":")}::/64`;
}

/** Fixed-window counters per client with a hard size cap and a periodic sweep (no per-request full scans). */
class Windows {
  private map = new Map<string, { start: number; n: number }>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly windowMs: number,
    private readonly maxKeys: number,
    private readonly now: () => number,
    sweepEveryMs: number,
  ) {
    if (sweepEveryMs > 0) {
      this.timer = setInterval(() => this.sweep(), sweepEveryMs);
      this.timer.unref();
    }
  }

  /** Increment and return the window for key. */
  hit(key: string): { start: number; n: number } {
    const t = this.now();
    let w = this.map.get(key);
    if (!w || t - w.start >= this.windowMs) {
      w = { start: t, n: 0 };
      this.map.delete(key);
      if (this.map.size >= this.maxKeys) {
        // Hard cap: forget the oldest entry (Map keeps insertion order). Bounded memory beats perfect accounting.
        const oldest = this.map.keys().next().value;
        if (oldest !== undefined) this.map.delete(oldest);
      }
      this.map.set(key, w);
    }
    w.n++;
    return w;
  }

  peek(key: string): { start: number; n: number } | undefined {
    const w = this.map.get(key);
    return w && this.now() - w.start < this.windowMs ? w : undefined;
  }

  sweep(): void {
    const t = this.now();
    for (const [k, v] of this.map) if (t - v.start >= this.windowMs) this.map.delete(k);
  }

  get size(): number {
    return this.map.size;
  }
}

export interface LimiterOptions {
  perMinute: number;
  now?: () => number;
  maxKeys?: number;
  /** 0 disables the background sweep (tests). */
  sweepEveryMs?: number;
}

/** Fixed-window rate limit per client, in memory only (client identifiers are never persisted). */
export function rateLimit(opts: LimiterOptions): RequestHandler & { size: () => number; sweep: () => void } {
  const windows = new Windows(60_000, opts.maxKeys ?? 50_000, opts.now ?? Date.now, opts.sweepEveryMs ?? 60_000);
  const now = opts.now ?? Date.now;
  const handler: RequestHandler = (req, res, next) => {
    const w = windows.hit(clientKey(req.ip));
    res.setHeader("RateLimit-Limit", String(opts.perMinute));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, opts.perMinute - w.n)));
    if (w.n > opts.perMinute) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((w.start + 60_000 - now()) / 1000))));
      res.status(429).json({ error: "rate_limited", message: "Too many requests, slow down." });
      return;
    }
    next();
  };
  return Object.assign(handler, { size: () => windows.size, sweep: () => windows.sweep() });
}

/**
 * Counts only FAILED attempts (wrong password). Successful logins never count, so an attacker
 * cannot lock the owner out by hammering with the right credentials of someone else; the owner
 * is only blocked if their own client address collects `maxFailures` failures within the window.
 */
export class FailureThrottle {
  private readonly windows: Windows;
  constructor(
    private readonly maxFailures: number,
    windowMs = 60_000,
    now: () => number = Date.now,
    maxKeys = 10_000,
    sweepEveryMs = 60_000,
  ) {
    this.windows = new Windows(windowMs, maxKeys, now, sweepEveryMs);
  }
  blocked(ip: string | undefined): boolean {
    const w = this.windows.peek(clientKey(ip));
    return Boolean(w && w.n >= this.maxFailures);
  }
  fail(ip: string | undefined): void {
    this.windows.hit(clientKey(ip));
  }
}
