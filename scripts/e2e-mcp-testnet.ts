/** MCP E2E. No automatic second payment, including after an uncertain settlement. */
import { createPublicClient, decodeEventLog, erc20Abi, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createx402MCPClient } from "@x402/mcp";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { atomic, parseOptions, PaymentGuard, readHealth, safeFailure, selectServices } from "./e2e-common.js";

async function main() {
  const options = parseOptions(process.argv.slice(2));
  await readHealth(options);
  const key = process.env.BUYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Buyer key missing or invalid");
  const account = privateKeyToAccount(key as `0x${string}`);
  const chain = createPublicClient({ chain: options.chain, transport: http() });
  const balance = () => chain.readContract({ address: options.asset, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const client = createx402MCPClient({
    name: "e2e-mcp-test", version: "1.0.0",
    schemes: [{ network: options.network, client: new ExactEvmScheme(account) }],
    spendControls: { maxAmountPerPayment: "$0.50" }, autoPayment: true,
  });
  const guard = new PaymentGuard(options);
  guard.attach(client.paymentClient);
  const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${options.baseUrl}/mcp`), { requestInit: { redirect: "error" } }));
    const services = selectServices(text(await client.client.callTool({ name: "list_services", arguments: {} })), options, true);
    const expected = services.reduce((sum, s) => sum + atomic(s.price_usdc), 0n);
    const before = await balance();
    if (before < expected) throw new Error("Insufficient USDC");
    console.log(`Network: ${options.mode}; data: ${options.source}; planned: ${formatUnits(expected, 6)} USDC; hard total cap: 0.50 USDC`);
    for (const s of services) {
      guard.begin(s);
      const out = await client.callTool(s.mcp_tool, s.example_request);
      const body = text(out);
      const receipt = out.paymentResponse;
      if (out.isError || !out.paymentMade || receipt?.success !== true || receipt.network !== options.network || body.data_source !== options.source || typeof body.request_id !== "string") throw new Error("Paid tool failed or uncertain");
      const rc = await chain.waitForTransactionReceipt({ hash: receipt.transaction as `0x${string}` });
      const valid = rc.status === "success" && rc.logs.some((log) => {
        if (log.address.toLowerCase() !== options.asset.toLowerCase()) return false;
        try {
          const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
          return ev.eventName === "Transfer" && ev.args.from.toLowerCase() === account.address.toLowerCase() && ev.args.to.toLowerCase() === options.payTo.toLowerCase() && ev.args.value === atomic(s.price_usdc);
        } catch { return false; }
      });
      if (!valid) throw new Error("Settlement transfer mismatch");
      console.log(`OK ${s.mcp_tool}: ${options.explorer}/tx/${receipt.transaction}`);
      const denied = await client.client.callTool({ name: "get_result", arguments: { request_id: body.request_id, result_token: "wrong-token" } });
      if (!denied.isError) throw new Error("Invalid result token accepted");
    }
    const after = await balance();
    if (before - after !== expected) throw new Error("Balance mismatch");
    console.log(`ALL CHECKS PASSED; spent ${formatUnits(before - after, 6)} USDC`);
  } finally { await client.close(); }
}
await main().catch(safeFailure);
