/** REST E2E. Defaults to testnet/sandbox; see docs/PAYMENTS.md for explicit mainnet opt-in. */
import { createPublicClient, decodeEventLog, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { atomic, parseOptions, PaymentGuard, readHealth, safeFailure, selectServices } from "./e2e-common.js";

async function main() {
  const options = parseOptions(process.argv.slice(2));
  await readHealth(options);
  const catalogResponse = await fetch(`${options.baseUrl}/api/v1/services`, { redirect: "error" });
  if (!catalogResponse.ok) throw new Error("Catalog unavailable");
  const services = selectServices(await catalogResponse.json(), options);
  const key = process.env.BUYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Buyer key missing or invalid");
  const account = privateKeyToAccount(key as `0x${string}`);
  const chain = createPublicClient({ chain: options.chain, transport: http() });
  const balance = () => chain.readContract({ address: options.asset, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const before = await balance();
  const expected = services.reduce((sum, s) => sum + atomic(s.price_usdc), 0n);
  if (before < expected) throw new Error("Insufficient USDC");
  console.log(`Network: ${options.mode}; data: ${options.source}; planned: ${formatUnits(expected, 6)} USDC; hard total cap: 0.50 USDC`);
  const client = new x402Client().register(options.network, new ExactEvmScheme(account));
  client.setSpendControls({ maxAmountPerPayment: "$0.50" });
  const guard = new PaymentGuard(options);
  guard.attach(client);
  let signature: string | null = null;
  const recording = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (new URL(req.url).origin !== options.baseUrl) throw new Error("Unexpected request origin");
    signature = req.headers.get("payment-signature") ?? signature;
    return fetch(req, { redirect: "error" });
  }) as typeof fetch;
  const pay = wrapFetchWithPayment(recording, client);
  let first: { path: string; body: string; signature: string; requestId: string } | undefined;
  for (const s of services) {
    guard.begin(s);
    signature = null;
    const body = JSON.stringify(s.example_request);
    const res = await pay(`${options.baseUrl}${s.path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const json = await res.json();
    const header = res.headers.get("payment-response");
    const receipt = header ? decodePaymentResponseHeader(header) : null;
    if (res.status !== 200 || receipt?.success !== true || receipt.network !== options.network || json.data_source !== (s.data_source === "local" ? "local" : options.source) || typeof json.request_id !== "string" || !signature) throw new Error("Paid call failed or uncertain");
    const rc = await chain.waitForTransactionReceipt({ hash: receipt.transaction as `0x${string}` });
    const valid = rc.status === "success" && rc.logs.some((log) => {
      if (log.address.toLowerCase() !== options.asset.toLowerCase()) return false;
      try {
        const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        return ev.eventName === "Transfer" && ev.args.from.toLowerCase() === account.address.toLowerCase() && ev.args.to.toLowerCase() === options.payTo.toLowerCase() && ev.args.value === atomic(s.price_usdc);
      } catch { return false; }
    });
    if (!valid) throw new Error("Settlement transfer mismatch");
    console.log(`OK ${s.id}: ${options.explorer}/tx/${receipt.transaction}`);
    first ??= { path: s.path, body, signature, requestId: json.request_id };
  }
  if (first) {
    const res = await fetch(`${options.baseUrl}${first.path}`, { method: "POST", redirect: "error", headers: { "content-type": "application/json", "payment-signature": first.signature }, body: first.body });
    const replay = await res.json();
    if (res.status !== 200 || replay.replayed !== true || replay.request_id !== first.requestId) throw new Error("Replay failed");
    console.log("OK replay: same request, no new authorization");
  }
  // Public RPC nodes lag behind the settlement receipt: re-read the balance for up to ~20 s before calling it a mismatch.
  let after = await balance();
  for (let i = 0; i < 10 && before - after !== expected; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    after = await balance();
  }
  if (before - after !== expected) throw new Error("Balance mismatch");
  console.log(`ALL CHECKS PASSED; spent ${formatUnits(before - after, 6)} USDC`);
}
await main().catch(safeFailure);
