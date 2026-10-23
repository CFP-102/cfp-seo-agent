/**
 * Independent uptime from UptimeRobot, fetched by the server (never by the visitor's browser, so no visitor data goes
 * to a third party). Uses a read-only monitor-specific API key (UptimeRobot API v2 getMonitors). Cached; on errors the
 * last good value is kept and the status page simply shows nothing new.
 */
export interface ExternalUptime {
  source: "UptimeRobot";
  status: "up" | "down" | "paused" | "unknown";
  uptime_pct: { last_24h: number | null; last_7d: number | null; last_30d: number | null };
  checked_at: string;
}

const STATUS: Record<number, ExternalUptime["status"]> = { 0: "paused", 1: "unknown", 2: "up", 8: "down", 9: "down" };

export function createExternalUptime(opts: { apiKey: string; fetchImpl?: typeof fetch; ttlMs?: number; now?: () => Date }) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ttl = opts.ttlMs ?? 5 * 60_000;
  const clock = opts.now ?? (() => new Date());
  let cached: ExternalUptime | null = null;
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let running: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    try {
      const res = await fetchImpl("https://api.uptimerobot.com/v2/getMonitors", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cache-control": "no-cache" },
        body: new URLSearchParams({ api_key: opts.apiKey, format: "json", custom_uptime_ratios: "1-7-30" }).toString(),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      const json = (await res.json()) as { stat?: string; monitors?: { status?: number; custom_uptime_ratio?: string }[] };
      const m = json.stat === "ok" ? json.monitors?.[0] : undefined;
      if (!m) return;
      const [d1, d7, d30] = String(m.custom_uptime_ratio ?? "").split("-").map((v) => (v && Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null));
      cached = { source: "UptimeRobot", status: STATUS[m.status ?? 1] ?? "unknown", uptime_pct: { last_24h: d1 ?? null, last_7d: d7 ?? null, last_30d: d30 ?? null }, checked_at: clock().toISOString() };
    } catch {
      // keep the last good value
    } finally {
      fetchedAt = clock().getTime();
    }
  }

  return {
    /** Current value; refreshes in the background when stale, waits only for the very first fetch (max 5 s). */
    async get(): Promise<ExternalUptime | null> {
      if (clock().getTime() - fetchedAt > ttl && !running) {
        running = refresh().finally(() => (running = null));
        if (!cached) await running;
      }
      return cached;
    },
  };
}

export type ExternalUptimeSource = ReturnType<typeof createExternalUptime>;
