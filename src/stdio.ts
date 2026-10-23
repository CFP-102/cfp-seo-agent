/**
 * MCP over stdio (for local use and automated checkers such as Glama): `node dist/stdio.js`.
 * Runs only in sandbox mode without payments (PAYMENT_MODE=off, DATAFORSEO_MODE=sandbox): tools return DataForSEO
 * sandbox dummy data. Paid use goes through the hosted HTTP server with x402 payments.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "./config/env.js";
import { createDataForSeoClient } from "./dataforseo/client.js";
import { createFreeSample } from "./freeSample.js";
import { CostGuard } from "./lib/costGuard.js";
import { log, logToStderr, setLogLevel } from "./lib/log.js";
import { Store } from "./lib/store.js";
import { createMcpServer } from "./mcp/server.js";
import { SERVICES } from "./services/index.js";
import { Pipeline } from "./services/pipeline.js";
import { createWishlist } from "./wishlist.js";

logToStderr();
const env = loadEnv({ PAYMENT_MODE: "off", DATAFORSEO_MODE: "sandbox", DB_PATH: ":memory:", ...process.env });
if (env.PAYMENT_MODE !== "off" || env.DATAFORSEO_MODE !== "sandbox") {
  log.error("stdio mode runs only with PAYMENT_MODE=off and DATAFORSEO_MODE=sandbox; use the HTTP server for paid use");
  process.exit(1);
}
setLogLevel(env.LOG_LEVEL);

const store = new Store(env.DB_PATH);
const dfs = createDataForSeoClient({ mode: "sandbox", login: env.DATAFORSEO_LOGIN, password: env.DATAFORSEO_PASSWORD, timeoutMs: env.DATAFORSEO_TIMEOUT_MS });
const guard = new CostGuard(store, { dailyUsd: env.DATAFORSEO_DAILY_LIMIT_USD, monthlyUsd: env.DATAFORSEO_MONTHLY_LIMIT_USD, countSpend: false });
const pipeline = new Pipeline({ dfs, store, guard, services: SERVICES, disabledServices: [] });
const freeSample = createFreeSample({ pipeline, store, dailyLimit: env.FREE_SAMPLE_DAILY_LIMIT });
const wishlist = createWishlist({ store });

const server = createMcpServer({ env, store, pipeline, freeSample, wishlist }, "stdio");
await server.connect(new StdioServerTransport());
log.info("mcp stdio server ready (sandbox)");
