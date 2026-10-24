/** Real probe transport control flow with in-memory HTTPS streams; no network or certificates fetched. */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { request } from "node:https";
import { requestPinned } from "../src/lib/webProbe.js";
import { WEBSITE_CHECK_LIMITS } from "../src/config/services.js";

vi.mock("node:https", () => ({ request: vi.fn() }));

function response(body: string, headers: Record<string, string> = {}, status = 200) {
  vi.mocked(request).mockImplementation(((options: unknown, callback: Function) => {
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough() as PassThrough & { statusCode: number; headers: Record<string, string>; socket: unknown };
      res.statusCode = status; res.headers = headers;
      res.socket = { authorized: true, getPeerCertificate: () => ({ valid_to: "Jan 1 00:00:00 2027 GMT" }), getProtocol: () => "TLSv1.3" };
      const destroy = res.destroy.bind(res);
      res.destroy = () => { res.emit("aborted"); return destroy(); };
      callback(res);
      res.end(body);
    });
    return req;
  }) as typeof request);
}

describe("bounded pinned HTTPS transport", () => {
  const url = new URL("https://example.com/sitemap.xml");
  const target = { address: "8.8.8.8", family: 4 };
  it("keeps TLS identity checks enabled and retains only requested diagnostic fields", async () => {
    response("<xml/>", { "content-type": "application/xml" });
    const result = await requestPinned(url, target, "GET", new AbortController().signal);
    expect(result).toMatchObject({ status: 200, outcome: "response", body: "<xml/>", tls: { verified: true, protocol: "TLSv1.3", valid_until: "2027-01-01T00:00:00.000Z" } });
    expect(vi.mocked(request).mock.lastCall?.[0]).toMatchObject({ servername: "example.com", rejectUnauthorized: true, agent: false, method: "GET" });
    expect(JSON.stringify(result)).not.toContain("8.8.8.8");
  });
  it("stops an oversized sitemap and reports the byte limit rather than a successful body", async () => {
    response("x".repeat(WEBSITE_CHECK_LIMITS.sitemapBytes + 1));
    expect(await requestPinned(url, target, "GET", new AbortController().signal)).toMatchObject({ outcome: "body_too_large", body: "" });
  });
  it("does not read HEAD bodies, follow redirects or return unsafe Location targets", async () => {
    vi.mocked(request).mockClear();
    response("never retained", { location: "http://127.0.0.1/private" }, 302);
    expect(await requestPinned(url, target, "HEAD", new AbortController().signal)).toMatchObject({ status: 302, redirect_url: null, body: "" });
    expect(request).toHaveBeenCalledTimes(1);
    response("", { location: "/new-sitemap.xml" }, 301);
    expect(await requestPinned(url, target, "HEAD", new AbortController().signal)).toMatchObject({ status: 301, redirect_url: "https://example.com/new-sitemap.xml" });
  });
});
