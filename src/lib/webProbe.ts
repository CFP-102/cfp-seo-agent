import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request, type RequestOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import { WEBSITE_CHECK_LIMITS as limits } from "../config/services.js";
import { pageUrl } from "../services/pageUrl.js";

const blocked = new BlockList();
for (const [ip, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(ip, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [ip, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) blocked.addSubnet(ip, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}
export type ResolvedAddress = { address: string; family: number };
export type ResolveHost = (host: string) => Promise<ResolvedAddress[]>;
export interface ProbeResult {
  url: string;
  status: number | null;
  outcome: "response" | "blocked_target" | "dns_error" | "timeout" | "tls_error" | "network_error" | "body_too_large";
  redirect_url: string | null;
  content_type: string | null;
  tls: { verified: boolean; valid_until: string | null; protocol: string | null } | null;
  body: string;
}
export type Probe = (url: string, method: "HEAD" | "GET") => Promise<ProbeResult>;

/** Pin the approved DNS address while retaining the original host for certificate/SNI checks. */
export function pinnedOptions(url: URL, target: ResolvedAddress, method: "HEAD" | "GET", signal: AbortSignal): RequestOptions {
  if (url.protocol !== "https:" || (!isPublicAddress(target.address) || isIP(target.address) !== target.family)) throw new Error("blocked_target");
  return {
    protocol: "https:", hostname: url.hostname, port: 443, path: url.pathname + url.search,
    method, servername: url.hostname, rejectUnauthorized: true, agent: false, signal,
    maxHeaderSize: limits.headerBytes,
    headers: { "User-Agent": "CFP-WebsiteCheck/0.1 (+https://agent.chiemgaufilms.com)", Accept: method === "GET" ? "application/xml,text/xml;q=0.9,*/*;q=0.1" : "*/*", "Accept-Encoding": "identity" },
    lookup: ((_host: string, opts: { all?: boolean }, callback: (...args: any[]) => void) => {
      if (opts.all) callback(null, [{ address: target.address, family: target.family }]);
      else callback(null, target.address, target.family);
    }) as RequestOptions["lookup"],
  };
}

/** One HTTPS request, no redirects, retries, cookies, authentication or content decompression. */
export async function requestPinned(url: URL, target: ResolvedAddress, method: "HEAD" | "GET", signal: AbortSignal): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const req = request(pinnedOptions(url, target, method, signal), res => {
      const socket = res.socket as TLSSocket;
      const cert = socket.getPeerCertificate();
      const validUntil = cert.valid_to ? new Date(cert.valid_to) : null;
      let redirect: string | null = null;
      if (res.headers.location) {
        try { const parsed = pageUrl.safeParse(new URL(res.headers.location, url).toString()); if (parsed.success) redirect = parsed.data; } catch { /* Ignore invalid third-party headers. */ }
      }
      const result: ProbeResult = { url: url.toString(), status: res.statusCode ?? null, outcome: "response", redirect_url: redirect,
        content_type: res.headers["content-type"]?.slice(0, limits.headerValueChars) ?? null,
        tls: { verified: socket.authorized === true, valid_until: validUntil && Number.isFinite(validUntil.getTime()) ? validUntil.toISOString() : null, protocol: socket.getProtocol() }, body: "" };
      if (method === "HEAD") { resolve(result); res.destroy(); return; }
      let bytes = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limits.sitemapBytes) { resolve({ ...result, outcome: "body_too_large" }); res.destroy(); }
        else chunks.push(chunk);
      });
      res.on("end", () => resolve({ ...result, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("network_error")));
    });
    req.on("error", reject);
    req.end();
  });
}

export function createPublicProbe(deps: { resolve?: ResolveHost; send?: typeof requestPinned } = {}): Probe {
  const resolveHost = deps.resolve ?? (host => lookup(host, { all: true, verbatim: true }));
  const send = deps.send ?? requestPinned;
  return async (value, method) => {
    const failure = (outcome: ProbeResult["outcome"]): ProbeResult => ({ url: value, status: null, outcome, redirect_url: null, content_type: null, tls: null, body: "" });
    const parsed = pageUrl.safeParse(value);
    if (!parsed.success || new URL(parsed.data).protocol !== "https:") return failure("blocked_target");
    const url = new URL(parsed.data);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, limits.timeoutMs);
    });
    let phase: "dns" | "request" = "dns";
    try {
      return await Promise.race([(async () => {
        const addresses = await resolveHost(url.hostname);
        if (controller.signal.aborted) throw new Error("timeout");
        // Mixed public/private DNS answers are rejected, not selectively trusted.
        if (!addresses.length || addresses.some(a => !isPublicAddress(a.address) || isIP(a.address) !== a.family)) return failure("blocked_target");
        phase = "request";
        return send(url, addresses[0]!, method, controller.signal);
      })(), deadline]);
    } catch (e) {
      const error = e as { code?: string; message?: string };
      if (controller.signal.aborted || error.message === "timeout") return failure("timeout");
      if (phase === "dns") return failure("dns_error");
      const tls = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(error.code ?? "");
      return { ...failure(tls ? "tls_error" : "network_error"), ...(tls ? { tls: { verified: false, valid_until: null, protocol: null } } : {}) };
    } finally { clearTimeout(timer); }
  };
}
