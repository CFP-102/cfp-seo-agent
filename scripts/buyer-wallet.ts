import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/** Exclusive creation prevents overwriting wallets, including dangling symlinks. */
export function createBuyerWallet(file: string, network: "testnet" | "mainnet") {
  if (!/^\.env\.buyer(?:\.[a-zA-Z0-9_-]+)?$/.test(basename(file))) throw new Error("Use a git-ignored .env.buyer[.suffix] filename");
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  writeFileSync(file, `# Buyer wallet: ${network === "mainnet" ? "Base Mainnet. Real funds require explicit approval." : "Base Sepolia TESTNET ONLY. Never fund with real money."}\nBUYER_PRIVATE_KEY=${key}\nBUYER_ADDRESS=${address}\n`, { flag: "wx", mode: 0o600 });
  return address;
}
