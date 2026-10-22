import { createPublicClient, decodeEventLog, erc20Abi, http, parseAbiItem, type Hex } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { Store, RequestRow } from "../lib/store.js";
import { log } from "../lib/log.js";
import { NETWORKS, USDC } from "./x402.js";

// Circle EIP3009.sol: AuthorizationUsed immediately precedes the matching Transfer.
// The public Base Sepolia RPC rejects eth_getLogs ranges larger than 200 blocks.
export const RECONCILIATION_BLOCK_RANGE = 200n;
export const AUTHORIZATION_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
export interface ChainLog {
  address: string;
  data: Hex;
  topics: readonly Hex[];
  logIndex: number | null;
  transactionHash: Hex | null;
  blockHash: Hex | null;
}
export interface ChainReader {
  head(): Promise<{ number: bigint; timestamp: bigint }>;
  block(number: bigint): Promise<{ timestamp: bigint }>;
  authorizations(from: bigint, to: bigint, payer: Hex, nonce: Hex): Promise<readonly ChainLog[]>;
  receipt(hash: Hex): Promise<{ status: string; blockHash: Hex; logs: readonly ChainLog[] }>;
}

/** Fixed public chain endpoints: no wallet, signer, facilitator or DataForSEO client. */
export function createChainReader(mode: "testnet" | "mainnet"): ChainReader {
  const chain = mode === "mainnet" ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(undefined, { timeout: 10_000, retryCount: 0 }) });
  return {
    async head() {
      if (await client.getChainId() !== chain.id) throw new Error("RPC network mismatch");
      const block = await client.getBlock({ blockTag: "finalized" });
      return { number: block.number, timestamp: block.timestamp };
    },
    block: (number) => client.getBlock({ blockNumber: number }),
    authorizations: (from, to, payer, nonce) => client.getLogs({ address: USDC[mode].asset, event: AUTHORIZATION_USED, args: { authorizer: payer, nonce }, fromBlock: from, toBlock: to, strict: true }),
    receipt: (hash) => client.getTransactionReceipt({ hash }),
  };
}

/** Find a conservative start block by timestamp (binary search, at most 64 reads). */
async function firstBlock(reader: ChainReader, end: bigint, timestamp: bigint) {
  let low = 0n;
  let high = end;
  for (let i = 0; low < high && i < 64; i++) {
    const mid = (low + high) / 2n;
    if ((await reader.block(mid)).timestamp < timestamp) low = mid + 1n;
    else high = mid;
  }
  if (low !== high) throw new Error("Block search exceeded bound");
  return low;
}

/** Match the nonce and its immediately following USDC transfer in the same finalized receipt. */
export function confirmsPayment(row: RequestRow, logs: readonly ChainLog[]): boolean {
  for (let i = 0; i < logs.length - 1; i++) {
    const used = logs[i]!;
    const transfer = logs[i + 1]!;
    if (used.address.toLowerCase() !== row.payment_asset?.toLowerCase() || transfer.address.toLowerCase() !== row.payment_asset?.toLowerCase() || used.logIndex === null || transfer.logIndex !== used.logIndex + 1) continue;
    try {
      const auth = decodeEventLog({ abi: [AUTHORIZATION_USED], data: used.data, topics: used.topics as [Hex, ...Hex[]] });
      const event = decodeEventLog({ abi: erc20Abi, data: transfer.data, topics: transfer.topics as [Hex, ...Hex[]] });
      if (auth.args.authorizer.toLowerCase() === row.payer?.toLowerCase() && auth.args.nonce.toLowerCase() === row.payment_nonce?.toLowerCase() && event.eventName === "Transfer" && event.args.from.toLowerCase() === row.payer?.toLowerCase() && event.args.to.toLowerCase() === row.payment_to?.toLowerCase() && event.args.value.toString() === row.payment_amount) return true;
    } catch { /* Unrelated or malformed logs never prove payment. */ }
  }
  return false;
}

/** Bounded background reconciliation; overlapping ticks and retries cannot execute an upstream call. */
export function createReconciler(store: Store, mode: "testnet" | "mainnet", reader: ChainReader) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      const candidates = store.reconciliationCandidates(NETWORKS[mode]);
      if (!candidates.length) return; // No RPC traffic during normal operation.
      const head = await reader.head();
      for (const row of candidates) {
        store.touchReconciliation(row.id);
        try {
          if (!row.payer || !/^0x[\da-f]{40}$/i.test(row.payer) || !/^0x[\da-f]{64}$/i.test(row.payment_nonce ?? "") || row.payment_asset?.toLowerCase() !== USDC[mode].asset.toLowerCase()) continue;
          // Five-minute lookback also tolerates small server/chain clock differences.
          const since = BigInt(Math.max(0, Math.floor(Date.parse(row.created_at) / 1000) - 300));
          if (head.timestamp < since) continue;
          const from = row.reconciliation_cursor ? BigInt(row.reconciliation_cursor) : await firstBlock(reader, head.number, since);
          if (from > head.number) continue;
          const end = from + RECONCILIATION_BLOCK_RANGE - 1n;
          const to = end < head.number ? end : head.number;
          const events = await reader.authorizations(from, to, row.payer as Hex, row.payment_nonce as Hex);
          let settled = false;
          for (const event of events) {
            if (!event.transactionHash || event.blockHash === null) continue;
            const receipt = await reader.receipt(event.transactionHash);
            if (receipt.status === "success" && receipt.blockHash === event.blockHash && confirmsPayment(row, receipt.logs)) {
              if (store.reconcileSettled(row.id, event.transactionHash)) log.info("late payment confirmed", { requestId: row.id, tx: event.transactionHash, network: row.network });
              settled = true;
              break;
            }
          }
          if (!settled) {
            store.setReconciliationCursor(row.id, to + 1n);
            // Only finalized history past authorization expiry can establish absence.
            if (to === head.number && row.payment_valid_before && head.timestamp > BigInt(row.payment_valid_before) + 300n) store.fail(row.id, "settlement_not_found");
          }
        } catch {
          log.warn("payment reconciliation deferred", { requestId: row.id });
        }
      }
    } catch {
      log.warn("payment reconciliation unavailable");
    } finally { running = false; }
  };
}
