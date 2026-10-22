import { describe, expect, it } from "vitest";
import { clientKey, FailureThrottle, rateLimit } from "../src/lib/rateLimit.js";

const call = (h: ReturnType<typeof rateLimit>, ip: string) => {
  let status = 200;
  const res = { setHeader() {}, status(s: number) { status = s; return this; }, json() {} };
  h({ ip } as never, res as never, () => {});
  return status;
};

describe("clientKey", () => {
  it("keeps IPv4, unwraps IPv4-mapped IPv6 and reduces IPv6 to the /64", () => {
    expect(clientKey("203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(clientKey("2001:db8:1:2::1")).toBe("2001:0db8:0001:0002::/64");
    expect(clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001:0002::/64");
    expect(clientKey("2001:db8:1:2::ffff")).toBe(clientKey("2001:db8:1:2:1:2:3:4"));
    expect(clientKey("2001:db8:1:3::1")).not.toBe(clientKey("2001:db8:1:2::1"));
    expect(clientKey("::1")).toBe("0000:0000:0000:0000::/64");
    expect(clientKey(undefined)).toBe("unknown");
  });
});

describe("rateLimit", () => {
  it("one IPv6 /64 shares one budget (rotating addresses does not help)", () => {
    const h = rateLimit({ perMinute: 3, sweepEveryMs: 0 });
    const codes = Array.from({ length: 6 }, (_, i) => call(h, `2001:db8:1:2::${i + 1}`));
    expect(codes).toEqual([200, 200, 200, 429, 429, 429]);
  });

  it("memory stays bounded and flooding with unique clients is fast", () => {
    const h = rateLimit({ perMinute: 10, maxKeys: 1000, sweepEveryMs: 0 });
    const t0 = performance.now();
    for (let i = 0; i < 100_000; i++) call(h, `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    expect(h.size()).toBeLessThanOrEqual(1000);
    expect(performance.now() - t0).toBeLessThan(2000); // was 16 s for 100k entries with the quadratic cleanup
  });

  it("windows reset and the sweep drops expired entries", () => {
    let now = 0;
    const h = rateLimit({ perMinute: 1, now: () => now, sweepEveryMs: 0 });
    expect(call(h, "1.1.1.1")).toBe(200);
    expect(call(h, "1.1.1.1")).toBe(429);
    now = 61_000;
    h.sweep();
    expect(h.size()).toBe(0);
    expect(call(h, "1.1.1.1")).toBe(200);
  });
});

describe("FailureThrottle", () => {
  it("blocks only after the maximum number of failures and recovers after the window", () => {
    let now = 0;
    const t = new FailureThrottle(3, 60_000, () => now, 100, 0);
    for (let i = 0; i < 2; i++) t.fail("9.9.9.9");
    expect(t.blocked("9.9.9.9")).toBe(false);
    t.fail("9.9.9.9");
    expect(t.blocked("9.9.9.9")).toBe(true);
    expect(t.blocked("8.8.8.8")).toBe(false);
    now = 61_000;
    expect(t.blocked("9.9.9.9")).toBe(false);
  });
});
