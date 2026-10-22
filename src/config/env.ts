import { isAddress } from "viem";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

// Mixed-case addresses must carry a valid EIP-55 checksum (a typo would otherwise send money to nowhere); all-lowercase is accepted.
const evmAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "must be a 0x-prefixed EVM address")
  .refine((a) => isAddress(a, { strict: true }), "invalid address checksum (copy the address again from your wallet)");

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_BASE_URL: z.string().url().default("http://localhost:3000"),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    DB_PATH: z.string().default("./data/app.db"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    // DataForSEO
    DATAFORSEO_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
    DATAFORSEO_LOGIN: z.string().default(""),
    DATAFORSEO_PASSWORD: z.string().default(""),
    DATAFORSEO_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(45_000),
    DATAFORSEO_DAILY_LIMIT_USD: z.coerce.number().min(0).default(5),
    DATAFORSEO_MONTHLY_LIMIT_USD: z.coerce.number().min(0).default(100),

    // Payments (x402)
    PAYMENT_MODE: z.enum(["off", "testnet", "mainnet"]).default("off"),
    PAY_TO_ADDRESS: z.union([evmAddress, z.literal("")]).default(""),
    FACILITATOR_URL: z.union([z.string().url(), z.literal("")]).default(""),
    CDP_API_KEY_ID: z.string().default(""),
    CDP_API_KEY_SECRET: z.string().default(""),
    // Testnet money is free, live DataForSEO calls are not. Require an explicit opt-in.
    ALLOW_LIVE_DATA_ON_TESTNET: bool.default(false),

    // Admin
    ADMIN_USER: z.string().default("admin"),
    ADMIN_PASSWORD: z.string().default(""),

    // Public site / discovery
    SITE_NAME: z.preprocess((v) => (v === "" ? undefined : v), z.string().trim().min(1).max(60).default("Agent Data API")),
    CONTACT_EMAIL: z.union([z.string().email(), z.literal("")]).default(""),
    /** EIP-191 signatures of the origin by the PAY_TO wallet (optional, comma separated), see docs/MARKETPLACES.md. */
    OWNERSHIP_PROOFS: z.string().default(""),
    /** Verification files that directories ask you to host under /.well-known/ (empty = not served). See docs/MARKETPLACES.md. */
    WELLKNOWN_402INDEX: z.string().max(4096).default(""),
    WELLKNOWN_MCP_REGISTRY_AUTH: z.string().max(4096).default(""),
    WELLKNOWN_GLAMA: z.string().max(4096).default(""),

    // Data minimization: request inputs and results are deleted after this many days (payment records are kept for bookkeeping).
    RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    // Free sample (1 keyword, no payment). 0 = off. Real upstream calls per UTC day in total; 1 per client per day.
    FREE_SAMPLE_DAILY_LIMIT: z.coerce.number().int().min(0).max(1000).default(0),

    // Abuse protection
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(60),
  })
  .superRefine((env, ctx) => {
    if (env.PAYMENT_MODE === "off" && env.DATAFORSEO_MODE === "live") {
      ctx.addIssue({
        code: "custom",
        path: ["PAYMENT_MODE"],
        message: "PAYMENT_MODE=off is only allowed with DATAFORSEO_MODE=sandbox (would give away paid data)",
      });
    }
    if (env.PAYMENT_MODE === "off" && env.NODE_ENV === "production") {
      ctx.addIssue({ code: "custom", path: ["PAYMENT_MODE"], message: "PAYMENT_MODE=off is not allowed in production" });
    }
    if (env.PAYMENT_MODE !== "off" && (!env.DATAFORSEO_LOGIN || !env.DATAFORSEO_PASSWORD)) {
      // Otherwise we would accept money for calls that are guaranteed to fail.
      ctx.addIssue({ code: "custom", path: ["DATAFORSEO_LOGIN"], message: "DataForSEO credentials are required when payments are enabled" });
    }
    if (env.PAYMENT_MODE !== "off" && !env.PAY_TO_ADDRESS) {
      ctx.addIssue({ code: "custom", path: ["PAY_TO_ADDRESS"], message: "required when payments are enabled" });
    }
    if (env.PAYMENT_MODE === "testnet" && env.DATAFORSEO_MODE === "live" && !env.ALLOW_LIVE_DATA_ON_TESTNET) {
      ctx.addIssue({
        code: "custom",
        path: ["ALLOW_LIVE_DATA_ON_TESTNET"],
        message: "testnet payments + live DataForSEO means real costs for fake money; set ALLOW_LIVE_DATA_ON_TESTNET=true to confirm",
      });
    }
    if (env.PAYMENT_MODE === "mainnet" && env.DATAFORSEO_MODE !== "live") {
      ctx.addIssue({ code: "custom", path: ["DATAFORSEO_MODE"], message: "mainnet payments must serve live data, not sandbox data" });
    }
    if (env.PAYMENT_MODE === "mainnet" && env.NODE_ENV !== "production") {
      ctx.addIssue({ code: "custom", path: ["NODE_ENV"], message: "mainnet payments require NODE_ENV=production" });
    }
    if (env.PAYMENT_MODE === "mainnet") {
      let host = "";
      if (env.FACILITATOR_URL) {
        try {
          const url = new URL(env.FACILITATOR_URL);
          host = url.hostname.toLowerCase();
          // The facilitator confirms that money moved: a tampered link could fake "settled". HTTPS only.
          if (url.protocol !== "https:") ctx.addIssue({ code: "custom", path: ["FACILITATOR_URL"], message: "must be an https:// URL on mainnet" });
        } catch {
          ctx.addIssue({ code: "custom", path: ["FACILITATOR_URL"], message: "is not a valid URL" });
        }
      }
      const coinbase = /(^|\.)coinbase\.com$/.test(host);
      // The signed credentials are bound to Coinbase's own API host, so no other coinbase.com URL can work.
      if (coinbase && host !== "api.cdp.coinbase.com") {
        ctx.addIssue({ code: "custom", path: ["FACILITATOR_URL"], message: "the Coinbase facilitator must be https://api.cdp.coinbase.com/platform/v2/x402 (or leave empty)" });
      }
      if ((!env.FACILITATOR_URL || coinbase) && (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET)) {
        ctx.addIssue({ code: "custom", path: ["CDP_API_KEY_ID"], message: "the Coinbase facilitator needs CDP_API_KEY_ID and CDP_API_KEY_SECRET" });
      }
      if (/^0x0{40}$/i.test(env.PAY_TO_ADDRESS)) {
        ctx.addIssue({ code: "custom", path: ["PAY_TO_ADDRESS"], message: "the zero address would burn all payments" });
      }
      if (env.TRUST_PROXY < 1) {
        ctx.addIssue({ code: "custom", path: ["TRUST_PROXY"], message: "mainnet must run behind the reverse proxy: set TRUST_PROXY=1 (otherwise all clients share one rate limit)" });
      }
    }
    if ((env.NODE_ENV === "production" || env.PAYMENT_MODE === "mainnet") && !env.PUBLIC_BASE_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_BASE_URL"], message: "must be an https:// URL in production" });
    }
    if (env.NODE_ENV === "production" && env.ADMIN_PASSWORD.length < 16) {
      ctx.addIssue({ code: "custom", path: ["ADMIN_PASSWORD"], message: "set a strong ADMIN_PASSWORD (>= 16 chars) in production" });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Never echo values: they may be secrets.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}
