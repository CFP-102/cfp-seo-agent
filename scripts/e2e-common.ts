/** Shared offline safety checks for REST and MCP payment tests. */
import { z } from "zod";
import { isAddress, parseUnits } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { PaymentRequirements } from "@x402/core/types";
import type { x402Client } from "@x402/core/client";
import { SERVICE_CONFIG } from "../src/config/services.js";

export const NETWORKS = {
  testnet: { chain: baseSepolia, network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", explorer: "https://sepolia.basescan.org", source: "sandbox" },
  mainnet: { chain: base, network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", explorer: "https://basescan.org", source: "live" },
} as const;
export const RUN_LIMIT = 500_000n; // Hard total authorization cap: 0.50 USDC, including failed attempts.
const address = z.string().refine((v) => isAddress(v), "Invalid recipient address");

export function parseOptions(args: string[]) {
  const positional: string[] = [];
  const flags: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    if (!["--network", "--pay-to", "--confirm-mainnet"].includes(arg) || arg in flags) throw new Error("Unknown or duplicate option");
    if (arg !== "--confirm-mainnet" && (!args[i + 1] || args[i + 1]!.startsWith("--"))) throw new Error("Missing option value");
    flags[arg] = arg === "--confirm-mainnet" ? true : args[++i];
  }
  if (positional.length > 2) throw new Error("Too many positional arguments");
  const mode = z.enum(["testnet", "mainnet"]).parse(flags["--network"] ?? "testnet");
  if (mode === "mainnet" && (flags["--confirm-mainnet"] !== true || !flags["--pay-to"])) {
    throw new Error("Mainnet requires explicit approval: --confirm-mainnet and --pay-to ADDRESS");
  }
  if (mode === "testnet" && flags["--confirm-mainnet"]) throw new Error("Mainnet approval requires --network mainnet");
  const url = new URL(positional[0] ?? "http://localhost:3000");
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use a plain server origin without credentials");
  if (url.protocol !== "https:" && !(mode === "testnet" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("HTTPS required (except local testnet)");
  const payTo = address.parse(flags["--pay-to"] ?? "0x88c4de5f40C7B290D3D59a77718141082FE672d0");
  if (/^0x0{40}$/i.test(payTo)) throw new Error("Zero recipient forbidden");
  return { mode, ...NETWORKS[mode], baseUrl: url.origin, only: positional[1] ?? (mode === "mainnet" ? "keyword-ideas" : "all"), payTo };
}
export type Options = ReturnType<typeof parseOptions>;
export const serviceSchema = z.object({
  id: z.string(), path: z.string(), mcp_tool: z.string(), price_usdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  enabled: z.boolean(), example_request: z.record(z.string(), z.unknown()),
  /** "local" for services that calculate on our server; otherwise the server-wide data source. */
  data_source: z.enum(["live", "sandbox", "local"]),
});
export type Service = z.infer<typeof serviceSchema>;

export function assertMode(value: unknown, options: Options) {
  const status = z.object({ payments: z.literal(options.mode), data_source: z.literal(options.source) }).safeParse(value);
  if (!status.success) throw new Error("Server payment/data mode mismatch — refusing to pay");
}
export async function readHealth(options: Options) {
  const res = await fetch(`${options.baseUrl}/health`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error("Health check failed");
  assertMode(await res.json(), options);
}
export function selectServices(value: unknown, options: Options, mcp = false): Service[] {
  assertMode(value, options);
  const catalog = z.object({ network: z.literal(options.network), services: z.array(serviceSchema) }).parse(value);
  const selector = mcp ? options.only.replaceAll("-", "_") : options.only;
  const selected = catalog.services.filter((s) => s.enabled && (selector === "all" || (mcp ? s.mcp_tool : s.id) === selector));
  if (!selected.length) throw new Error("No matching enabled service");
  const seen = new Set<string>();
  for (const s of selected) {
    const local = SERVICE_CONFIG[s.id];
    if (!local || seen.has(s.id) || s.path !== local.route || s.mcp_tool !== s.id.replaceAll("-", "_") || atomic(s.price_usdc) !== atomic(local.priceUsdc)) throw new Error("Catalog differs from local service configuration");
    seen.add(s.id);
  }
  if (selected.reduce((sum, s) => sum + atomic(s.price_usdc), 0n) > RUN_LIMIT) throw new Error("Planned total exceeds 0.50 USDC");
  return selected;
}
export const atomic = (price: string) => parseUnits(price, 6);

export class PaymentGuard {
  private authorized = 0n;
  private active?: Service;
  private used = false;
  constructor(private options: Options) {}
  begin(service: Service) { this.active = service; this.used = false; }
  authorize(req: PaymentRequirements) {
    const s = this.active;
    if (!s || this.used || req.scheme !== "exact" || req.network !== this.options.network || req.asset.toLowerCase() !== this.options.asset.toLowerCase() || req.payTo.toLowerCase() !== this.options.payTo.toLowerCase() || req.amount !== atomic(s.price_usdc).toString()) throw new Error("Unexpected payment requirements or repeated authorization");
    const amount = BigInt(req.amount);
    if (amount <= 0n || this.authorized + amount > RUN_LIMIT) throw new Error("Total authorization exceeds 0.50 USDC");
    this.authorized += amount; // Never release reservations after uncertain/failed payments.
    this.used = true;
  }
  attach(client: x402Client) {
    client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
      await readHealth(this.options);
      this.authorize(selectedRequirements);
    });
  }
}

/** Suppress SDK/RPC errors: these may contain signatures, keys or result tokens. */
export function safeFailure() { console.error("E2E aborted. No automatic retry; check payment status before running again."); process.exitCode = 1; }
