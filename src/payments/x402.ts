import { createHash } from "node:crypto";
import { verifyTypedData } from "viem";
import type { RequestHandler } from "express";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from "@x402/core/server";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { createPaymentWrapper, extractPaymentFromMeta } from "@x402/mcp";
import { createFacilitatorConfig } from "@coinbase/x402";
import { TtlCache } from "../lib/cache.js";
import { stableStringify } from "../lib/cache.js";
import { clientKey } from "../lib/rateLimit.js";
import { log } from "../lib/log.js";
import type { Store } from "../lib/store.js";
import type { ServiceDefinition } from "../services/types.js";
import { inputJsonSchema, toolNameOf } from "../services/common.js";
import { hashToken, newToken, requestState, type Pipeline, type Prepared } from "../services/pipeline.js";

/**
 * x402 v2 payment gate (USDC, exact scheme, Base / Base Sepolia) for the REST routes AND the MCP tools.
 *
 * Both transports run the same chain:
 *   prepare (free checks) -> beginPaidCall (claim) -> x402 verify + settle UPFRONT -> run (one upstream call)
 *
 * - The SDK's "upfront" payment flow settles on-chain BEFORE our handler runs, so DataForSEO is
 *   never called for a payment that did not settle.
 * - beginPaidCall inserts a row keyed by the payment's (network, payer, EIP-3009 nonce) before settling.
 *   A second request with the same payment cannot claim again: it gets the stored result (idempotent
 *   retry after a lost response) or 409 — never a second upstream call.
 * - Budget reservations are released at completion. Once settlement was attempted, unconfirmed claims
 *   remain durable for reconciliation; they must never be deleted or settled a second time.
 */

export const NETWORKS = {
  testnet: "eip155:84532", // Base Sepolia
  mainnet: "eip155:8453", // Base
} as const;

export const TESTNET_FACILITATOR_URL = "https://x402.org/facilitator";

export interface PaymentsConfig {
  mode: "testnet" | "mainnet";
  payTo: string;
  publicBaseUrl: string;
  facilitator: FacilitatorClient;
}

/** Facilitator calls: settle can take a few seconds on-chain; a timeout is an indeterminate outcome (see docs/PAYMENTS.md). */
export const FACILITATOR_TIMEOUT_MS = 30_000;

export function createFacilitator(env: { PAYMENT_MODE: string; FACILITATOR_URL: string; CDP_API_KEY_ID?: string; CDP_API_KEY_SECRET?: string }): FacilitatorClient {
  const custom = env.FACILITATOR_URL;
  if (env.PAYMENT_MODE === "mainnet" && custom.startsWith(TESTNET_FACILITATOR_URL)) {
    throw new Error("x402.org/facilitator is testnet-only; configure a mainnet facilitator");
  }
  // Coinbase (CDP) facilitator: the default for mainnet, or any coinbase.com URL. It needs signed API credentials.
  const wantsCdp = custom ? /(^|\.)coinbase\.com$/i.test(new URL(custom).hostname) : env.PAYMENT_MODE === "mainnet";
  if (wantsCdp) {
    if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) throw new Error("CDP_API_KEY_ID and CDP_API_KEY_SECRET are required for the Coinbase facilitator");
    const cdp = createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET);
    return new HTTPFacilitatorClient({ ...cdp, ...(custom ? { url: custom } : {}), timeoutMs: FACILITATOR_TIMEOUT_MS });
  }
  return new HTTPFacilitatorClient({ url: custom || TESTNET_FACILITATOR_URL, timeoutMs: FACILITATOR_TIMEOUT_MS });
}

/** Stable identity of one payment authorization, independent of header encoding. */
export function paymentKeyOf(p: PaymentPayload): { key: string; payer: string | null } {
  const inner = (p.payload ?? {}) as { authorization?: { from?: unknown; nonce?: unknown } };
  const network = String(p.accepted?.network ?? "");
  const auth = inner.authorization;
  const from = typeof auth?.from === "string" ? auth.from.toLowerCase() : null;
  const nonce = typeof auth?.nonce === "string" ? auth.nonce.toLowerCase() : null;
  const material = from && nonce ? `${network}|${from}|${nonce}` : `${network}|${stableStringify(p.payload)}`;
  return { key: createHash("sha256").update(material).digest("hex"), payer: from };
}

type Locals = {
  prepared?: Prepared;
  service?: ServiceDefinition;
  requestId?: string;
  resultToken?: string;
  executed?: boolean;
  finish?: (executed: boolean) => void;
};

/** What to do with a paid call: answer right away (refusal / replay / conflict) or proceed to settle + run. */
export type PaidCallStart =
  | { kind: "answer"; status: number; body: Record<string, unknown>; headers?: Record<string, string> }
  | { kind: "proceed"; requestId: string; resultToken: string; finish: (executed: boolean) => void };

export type McpCall = (
  prepared: Prepared,
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  clientId: string,
) => Promise<CallToolResult>;

/** Text-only tool result (the shape the x402 MCP wrapper accepts; also a valid CallToolResult). */
export interface TextToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const toolResult = (body: Record<string, unknown>, isError = false): TextToolResult => ({
  content: [{ type: "text", text: JSON.stringify(body) }],
  structuredContent: body,
  ...(isError ? { isError: true } : {}),
});

/** EIP-3009 asset parameters of the network's USDC (what the buyer's signature is bound to). */
export const USDC = {
  testnet: { chainId: 84532, asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC", version: "2" },
  mainnet: { chainId: 8453, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2" },
} as const;

/** After this long a replayed payment no longer returns data (use the result token instead). */
export const REPLAY_WINDOW_MS = 15 * 60_000;
/** Unsettled payments being processed at the same time: per client address and in total. */
export const MAX_INFLIGHT_PER_CLIENT = 8;
export const MAX_INFLIGHT_TOTAL = 64;
/**
 * Signatures longer than 65 bytes (smart-contract wallets: ERC-1271/6492) cannot be verified offline, so they get a much
 * tighter budget: an invalid one reaches the facilitator, but only a handful can be in flight at the same time.
 */
export const MAX_INFLIGHT_UNVERIFIED_PER_CLIENT = 1;
export const MAX_INFLIGHT_UNVERIFIED_TOTAL = 8;

/** USDC has 6 decimals: "0.025" -> "25000". Pure string math, no float rounding. */
export function toAtomic(priceUsdc: string): string {
  const [whole = "0", frac = ""] = priceUsdc.split(".");
  return BigInt(whole + frac.padEnd(6, "0").slice(0, 6)).toString();
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^\d{1,30}$/;
const NONCE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Cheap local checks BEFORE anything is reserved or the facilitator is called. In the upfront flow the SDK skips
 * `verify`, so without this every garbage payment would cost a reservation and a facilitator round trip.
 * Returns an error text, or null if the payment is plausible and correctly signed (EOA signatures are verified offline).
 */
export async function checkPayment(p: PaymentPayload, expect: { mode: "testnet" | "mainnet"; amount: string; payTo: string }): Promise<string | null> {
  const asset = USDC[expect.mode];
  const network = NETWORKS[expect.mode];
  const a = p?.accepted as unknown as Record<string, unknown> | undefined;
  if (p?.x402Version !== 2) return "unsupported x402 version";
  if (!a || a.scheme !== "exact" || a.network !== network || String(a.amount) !== expect.amount || String(a.asset).toLowerCase() !== asset.asset.toLowerCase() || String(a.payTo).toLowerCase() !== expect.payTo.toLowerCase()) {
    return "payment does not match the quoted requirements";
  }
  const inner = (p.payload ?? {}) as { authorization?: Record<string, unknown>; signature?: unknown };
  const auth = inner.authorization;
  const sig = inner.signature;
  if (!auth || typeof auth !== "object") return "payment authorization is missing";
  const { from, to, value, validAfter, validBefore, nonce } = auth as Record<string, unknown>;
  if (typeof from !== "string" || !ADDRESS.test(from) || typeof to !== "string" || to.toLowerCase() !== expect.payTo.toLowerCase()) return "payment authorization has wrong parties";
  if (typeof value !== "string" || value !== expect.amount) return "payment amount does not match the price";
  if (typeof validAfter !== "string" || typeof validBefore !== "string" || !UINT.test(validAfter) || !UINT.test(validBefore)) return "payment validity window is malformed";
  const now = Math.floor(Date.now() / 1000);
  if (Number(validAfter) > now || Number(validBefore) <= now || Number(validBefore) > now + 300) return "payment authorization is not valid right now";
  if (typeof nonce !== "string" || !NONCE.test(nonce)) return "payment nonce is malformed";
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{128,8192}$/.test(sig)) return "payment signature is malformed";
  if (sig.length === 132 || sig.length === 130) {
    const full = sig.length === 130 ? expandCompactSignature(sig) : sig;
    // Plain 65-byte or compact 64-byte (EIP-2098) EOA signature: verify it offline. Longer ones are smart-contract wallets
    // (see MAX_INFLIGHT_UNVERIFIED_*) and are verified by the facilitator.
    try {
      const ok = await verifyTypedData({
        address: from as `0x${string}`,
        domain: { name: asset.name, version: asset.version, chainId: asset.chainId, verifyingContract: asset.asset },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: { from: from as `0x${string}`, to: to as `0x${string}`, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce: nonce as `0x${string}` },
        signature: full as `0x${string}`,
      });
      if (!ok) return "payment signature does not match the payer";
    } catch {
      return "payment signature is invalid";
    }
  }
  return null;
}

/** EIP-2098 compact signature (64 bytes: r + yParity<<255|s) -> the usual 65-byte r+s+v form that viem verifies. */
export function expandCompactSignature(sig: string): string {
  const r = sig.slice(2, 66);
  const yParityAndS = BigInt("0x" + sig.slice(66, 130));
  const yParity = Number(yParityAndS >> 255n);
  const sValue = yParityAndS & ((1n << 255n) - 1n);
  return `0x${r}${sValue.toString(16).padStart(64, "0")}${(27 + yParity).toString(16)}`;
}

/** True for signatures that cannot be checked offline (longer than a plain/compact EOA signature). */
export function hasUnverifiableSignature(p: PaymentPayload): boolean {
  const sig = (p?.payload as { signature?: unknown } | undefined)?.signature;
  return typeof sig === "string" && sig.length > 132;
}

export function createPayments(cfg: PaymentsConfig, deps: { store: Store; pipeline: Pipeline; services: ServiceDefinition[] }) {
  const network = NETWORKS[cfg.mode];
  const { store, pipeline } = deps;

  const resourceServer = new x402ResourceServer(cfg.facilitator)
    .register(network, new ExactEvmScheme())
    .onBeforeSettle(async ({ paymentPayload }) => {
      try {
        const { key } = paymentKeyOf(paymentPayload as PaymentPayload);
        if (store.startSettlement(key)) return;
      } catch { /* Abort explicitly: the SDK swallows thrown hook errors. */ }
      return { abort: true, reason: "payment_ledger_unavailable" };
    })
    .onAfterSettle(async ({ paymentPayload, result, phase }) => {
      const { key, payer } = paymentKeyOf(paymentPayload as PaymentPayload);
      const row = store.getByPaymentKey(key);
      if (row && result.success && result.transaction) {
        store.setSettled(row.id, result.transaction, result.payer?.toLowerCase() ?? null);
        log.info("payment settled", { requestId: row.id, service: row.service_id, network: result.network, tx: result.transaction, phase });
      } else if (!row && result.success) {
        // Must never happen (the claim is only released when settlement did not happen). If it does, leave a trail for a manual refund.
        log.error("settled payment without ledger row", { tx: result.transaction, payer: result.payer ?? payer, network: result.network });
      }
    })
    .onSettleFailure(async ({ paymentPayload }) => {
      // A failed or timed-out settlement can still have happened on-chain (indeterminate outcome). Leave a trail (all public data)
      // so a payer who reports a charge without a result can be checked and refunded; see docs/OPERATIONS.md.
      let trail: Record<string, unknown> = {};
      try {
        const { key, payer } = paymentKeyOf(paymentPayload as PaymentPayload);
        const auth = ((paymentPayload as PaymentPayload).payload as { authorization?: { nonce?: unknown; value?: unknown } }).authorization;
        trail = { payer, nonce: auth?.nonce, value: auth?.value, payment_key: key, network };
      } catch {
        /* payload unreadable: nothing more to record */
      }
      // Raw SDK errors can contain payment material. Keep only public correlation data.
      log.warn("payment settlement failed", { reason: "settlement_not_confirmed", ...trail });
    });

  // Payments being processed right now (claimed, not yet finished): bounds what a flood of invalid payments can hold.
  const inflightByClient = new Map<string, number>();
  let inflightTotal = 0;
  const inflightByPayer = new Set<string>();
  const failedPayers = new TtlCache<boolean>(10_000);
  const unverifiedByClient = new Map<string, number>();
  let unverifiedTotal = 0;

  const expectedFor = (s: ServiceDefinition) => ({ mode: cfg.mode, amount: toAtomic(s.priceUsdc), payTo: cfg.payTo });

  /** Shared by REST and MCP: validate, claim the payment, or say why we answer without settling. */
  async function beginPaidCall(prepared: Prepared, payload: PaymentPayload, clientId: string): Promise<PaidCallStart> {
    const bad = await checkPayment(payload, expectedFor(prepared.service));
    if (bad) return { kind: "answer", status: 400, body: { error: "invalid_payment", message: `${bad}. Nothing was charged.` } };

    let key: string;
    let payer: string | null;
    try {
      ({ key, payer } = paymentKeyOf(payload));
    } catch {
      return { kind: "answer", status: 400, body: { error: "invalid_payment", message: "payment could not be read. Nothing was charged." } };
    }

    const existing = store.getByPaymentKey(key);
    if (existing) return replay(existing.id, prepared, store, pipeline);

    const unverified = hasUnverifiableSignature(payload);
    // An unverified smart-wallet signature must not be able to lock a claimed victim payer.
    if (!unverified && payer && (failedPayers.get(payer) || inflightByPayer.has(payer))) {
      store.bump(prepared.service.id, "payer_cooldown");
      return { kind: "answer", status: 429, headers: { "Retry-After": "60" }, body: { error: "payer_busy", message: "This payer has a payment in progress or a recent failed settlement. Check its status before trying again." } };
    }
    const client = clientKey(clientId);
    if (
      inflightTotal >= MAX_INFLIGHT_TOTAL ||
      (inflightByClient.get(client) ?? 0) >= MAX_INFLIGHT_PER_CLIENT ||
      (unverified && (unverifiedTotal >= MAX_INFLIGHT_UNVERIFIED_TOTAL || (unverifiedByClient.get(client) ?? 0) >= MAX_INFLIGHT_UNVERIFIED_PER_CLIENT))
    ) {
      return { kind: "answer", status: 429, headers: { "Retry-After": "2" }, body: { error: "busy", message: "Too many payments are being processed right now. Retry shortly. Nothing was charged." } };
    }

    const reservation = pipeline.reserve(prepared);
    if ("refusal" in reservation) {
      return { kind: "answer", status: reservation.refusal.httpStatus, body: { error: reservation.refusal.code, message: `${reservation.refusal.message} Nothing was charged.` } };
    }
    const claim = pipeline.claim(prepared, { key, network, payer, priceUsdc: Number(prepared.service.priceUsdc) });
    if (!claim) {
      reservation.release();
      reservation.refundSlot();
      const row = store.getByPaymentKey(key);
      return row ? replay(row.id, prepared, store, pipeline) : { kind: "answer", status: 409, body: { error: "payment_in_use" } };
    }

    const auth = (payload.payload as { authorization: { nonce: string; validBefore: string } }).authorization;
    try {
      store.recordAuthorization(claim.requestId, { nonce: auth.nonce.toLowerCase(), asset: USDC[cfg.mode].asset, to: cfg.payTo.toLowerCase(), amount: toAtomic(prepared.service.priceUsdc), validBefore: auth.validBefore });
    } catch {
      reservation.release();
      reservation.refundSlot();
      store.release(claim.requestId);
      return { kind: "answer", status: 503, body: { error: "payment_unavailable", message: "Payment ledger unavailable. Nothing was charged." } };
    }
    inflightTotal++;
    if (!unverified && payer) inflightByPayer.add(payer);
    inflightByClient.set(client, (inflightByClient.get(client) ?? 0) + 1);
    if (unverified) {
      unverifiedTotal++;
      unverifiedByClient.set(client, (unverifiedByClient.get(client) ?? 0) + 1);
    }
    let cleaned = false;
    /**
     * Called when ALL server-side work for this call is over (never when the client merely disconnects: the settlement and the
     * data fetch continue server-side, and a settled payment must never lose its ledger row).
     */
    const finish = (executed: boolean) => {
      if (cleaned) return;
      cleaned = true;
      inflightTotal--;
      if (!unverified && payer) inflightByPayer.delete(payer);
      const left = (inflightByClient.get(client) ?? 1) - 1;
      if (left <= 0) inflightByClient.delete(client);
      else inflightByClient.set(client, left);
      if (unverified) {
        unverifiedTotal--;
        const uleft = (unverifiedByClient.get(client) ?? 1) - 1;
        if (uleft <= 0) unverifiedByClient.delete(client);
        else unverifiedByClient.set(client, uleft);
      }
      reservation.release();
      if (!executed) {
        // Preserve attempted payments even without a tx hash; only unattempted claims may be removed.
        const row = store.get(claim.requestId);
        if (row && !row.tx_hash) {
          if (row.settlement_started) {
            store.fail(claim.requestId, "settlement_uncertain");
            store.bump(prepared.service.id, "settlement_uncertain");
            if (!unverified && payer) failedPayers.set(payer, true, 60);
          } else {
            store.release(claim.requestId);
          }
        } else if (row?.status === "processing") {
          store.fail(claim.requestId, "settled_not_delivered");
        }
        reservation.refundSlot();
      }
    };
    return { kind: "proceed", requestId: claim.requestId, resultToken: claim.resultToken, finish };
  }

  // ---------------------------------------------------------------------------------------------
  // REST
  // ---------------------------------------------------------------------------------------------
  const routes: RoutesConfig = {};
  for (const s of deps.services) {
    routes[`POST ${s.route}`] = {
      accepts: [{ scheme: "exact", price: `$${s.priceUsdc}`, network, payTo: cfg.payTo, maxTimeoutSeconds: 120, extra: { paymentFlow: "upfront" } }],
      // Canonical URL from config, never from the Host header.
      resource: `${cfg.publicBaseUrl}${s.route}`,
      description: s.summary,
      mimeType: "application/json",
      serviceName: s.name,
      // Coinbase Bazaar discovery metadata: how to call this endpoint and what it returns.
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: "json",
          input: s.example as Record<string, unknown>,
          inputSchema: inputJsonSchema(s.inputSchema),
          output: { example: s.outputExample },
        }),
      },
    };
  }

  const x402Middleware: RequestHandler = paymentMiddleware(routes, resourceServer);

  /**
   * The SDK middleware runs verify/settle -> our handler -> (buffered response). Its promise resolves only when the whole
   * exchange is over, so cleanup happens here and not on socket events: an aborted client cannot delete a settled payment.
   */
  const x402: RequestHandler = async (req, res, next) => {
    const locals = res.locals as Locals;
    try {
      await (x402Middleware(req, res, next) as unknown as Promise<unknown>);
    } finally {
      locals.finish?.(Boolean(locals.executed));
    }
  };

  /** Runs after prepare(), before the x402 middleware. Only acts if a payment is attached. */
  const claimPayment: RequestHandler = async (req, res, next) => {
    const header = req.get("payment-signature") ?? req.get("x-payment");
    const locals = res.locals as Locals;
    if (!header) {
      // No payment attached (possibly a crawler probe with an empty body): the x402 middleware answers 402.
      const svc = locals.prepared?.service ?? locals.service;
      if (svc) store.bump(svc.id, "payment_required");
      return next();
    }
    const prepared = locals.prepared;
    if (!prepared) return void res.status(400).json({ error: "invalid_input", message: "Request body failed validation. Nothing was charged." });
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header);
    } catch {
      return next(); // malformed: let the SDK produce the standard 402 error
    }
    const start = await beginPaidCall(prepared, payload, req.ip ?? "unknown");
    if (start.kind === "answer") {
      for (const [k, v] of Object.entries(start.headers ?? {})) res.setHeader(k, v);
      return void res.status(start.status).json(start.body);
    }
    res.setHeader("X-Request-Id", start.requestId);
    locals.requestId = start.requestId;
    locals.resultToken = start.resultToken;
    locals.finish = start.finish;
    next();
  };

  // ---------------------------------------------------------------------------------------------
  // MCP (paid tools)
  // ---------------------------------------------------------------------------------------------
  let initialized: Promise<void> | null = null;
  const ensureInitialized = () => {
    initialized ??= resourceServer.initialize().catch((err) => {
      initialized = null; // retry on the next call (e.g. facilitator briefly unreachable)
      throw err;
    });
    return initialized;
  };

  const acceptsCache = new Map<string, PaymentRequirements[]>();
  async function acceptsFor(s: ServiceDefinition): Promise<PaymentRequirements[]> {
    await ensureInitialized();
    let accepts = acceptsCache.get(s.id);
    if (!accepts) {
      accepts = await resourceServer.buildPaymentRequirements({
        scheme: "exact",
        network,
        payTo: cfg.payTo,
        price: `$${s.priceUsdc}`,
        maxTimeoutSeconds: 120,
        extra: { paymentFlow: "upfront" },
      });
      acceptsCache.set(s.id, accepts);
    }
    return accepts;
  }

  /**
   * Call a paid MCP tool. Without a payment in `_meta["x402/payment"]` the SDK returns the standard
   * "payment required" result (isError + PaymentRequired in structuredContent). A client that cannot
   * pay (no x402 support) simply sees that result; nothing is charged and nothing is claimed to be paid.
   */
  const callPaidTool: McpCall = async (prepared, args, meta, clientId) => {
    const s = prepared.service;
    const toolName = toolNameOf(s.id);
    const payload = extractPaymentFromMeta({ name: toolName, arguments: args, _meta: meta });
    let start: PaidCallStart | null = null;
    if (payload) {
      start = await beginPaidCall(prepared, payload, clientId);
      if (start.kind === "answer") return toolResult(start.body, start.status >= 400);
    } else {
      store.bump(s.id, "payment_required");
    }

    let executed = false;
    try {
      const accepts = await acceptsFor(s);
      const wrapped = createPaymentWrapper(resourceServer, {
        accepts,
        resource: { url: `mcp://tool/${toolName}`, description: s.summary, mimeType: "application/json", serviceName: s.name },
        extensions: {
          ...declareDiscoveryExtension({
            toolName,
            description: s.summary,
            transport: "streamable-http",
            inputSchema: inputJsonSchema(s.inputSchema),
            example: s.example as Record<string, unknown>,
            output: { example: s.outputExample },
          }),
        },
      })(async () => {
        executed = true;
        const proceed = start as Extract<PaidCallStart, { kind: "proceed" }>;
        const out = await pipeline.runClaimed(prepared, proceed.requestId, proceed.resultToken, { paid: true, via: "mcp" });
        return toolResult(out.body as Record<string, unknown>, out.status >= 400);
      });
      return await wrapped(args, { _meta: meta } as never);
    } catch (err) {
      log.warn("mcp paid call failed", { service: s.id, reason: "payment_processing_unavailable" });
      return toolResult({ error: "payment_unavailable", message: "Payment processing is unavailable. If a payment was submitted, its outcome may still be pending. Do not send a new payment before checking.", ...(start?.kind === "proceed" ? { request_id: start.requestId, result_token: start.resultToken } : {}) }, true);
    } finally {
      if (start?.kind === "proceed") start.finish(executed);
    }
  };

  return { claimPayment, x402, network, routes, mcp: { callPaidTool }, resourceServer };
}

/**
 * The same payment presented again. The signed authorization is public on-chain once settled, so presenting it proves nothing
 * about who is asking. Therefore: data only for an identical request, only for a limited time, never a result token, and no
 * token rotation (the original payer's token stays valid).
 */
async function replay(requestId: string, prepared: Prepared, store: Store, pipeline: Pipeline): Promise<PaidCallStart> {
  const row = store.get(requestId)!;
  const used: PaidCallStart = {
    kind: "answer",
    status: 409,
    body: { error: "payment_already_used", message: "This payment was already used. Fetch the result with GET /api/v1/results/{request_id} and your result token." },
  };
  if (!row.tx_hash && row.status === "failed") {
    return { kind: "answer", status: 409, body: { error: "payment_pending", request_id: row.id, message: "Payment outcome is not confirmed. Do not send a new payment; contact support with this request id." } };
  }
  const expired = Date.now() - Date.parse(row.created_at) > REPLAY_WINDOW_MS;
  if (expired || row.input_hash !== prepared.inputHash || row.service_id !== prepared.service.id) return used;
  if (row.status === "processing") {
    return {
      kind: "answer",
      status: 409,
      headers: { "Retry-After": "5" },
      body: { error: "payment_in_progress", message: "This payment is being processed. Retry shortly with the same payment to get the result." },
    };
  }
  const headers = { "X-Request-Id": row.id };
  if (row.status === "completed") {
    return { kind: "answer", status: 200, headers, body: { ...JSON.parse(row.result_json ?? "{}"), replayed: true } };
  }
  // Failed after settlement: the replay itself triggers the one free retry (bounded, and only ever delivers what was paid for).
  const retried = await pipeline.retryRow(row);
  return { kind: "answer", status: retried.status, headers, body: { ...(retried.body as Record<string, unknown>), replayed: true } };
}
