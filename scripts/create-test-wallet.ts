/** Generate a buyer wallet without printing its private key or overwriting any file. */
import { parseArgs } from "node:util";
import { z } from "zod";
import { createBuyerWallet } from "./buyer-wallet.js";

try {
  const { values } = parseArgs({ options: { network: { type: "string", default: "testnet" }, output: { type: "string" } } });
  const network = z.enum(["testnet", "mainnet"]).parse(values.network);
  const file = values.output ?? (network === "mainnet" ? ".env.buyer.mainnet" : ".env.buyer");
  if (network === "mainnet" && file === ".env.buyer") throw new Error("Separate mainnet wallet required");
  const address = createBuyerWallet(file, network);
  console.log(`Buyer wallet created (${network}): ${address}`);
  console.log("Private key saved with mode 600. Never paste it into chat.");
  if (network === "testnet") console.log("Test USDC faucet: https://faucet.circle.com (Base Sepolia)");
  else console.log("Wallet only created. Funding and mainnet payments require explicit approval.");
} catch {
  console.error("Wallet creation refused. Check options and use a new .env.buyer[.suffix] file; existing files are never overwritten.");
  process.exitCode = 1;
}
