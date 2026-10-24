import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { FACILITATOR_FEE_USD, SERVICE_CONFIG } from "./config/services.js";
import { createDataForSeoClient } from "./dataforseo/client.js";
import { CostGuard } from "./lib/costGuard.js";
import { createAlerts, smtpSender } from "./lib/alerts.js";
import { log, setLogLevel } from "./lib/log.js";
import { Store } from "./lib/store.js";
import { SERVICES } from "./services/index.js";
import { Pipeline } from "./services/pipeline.js";
import { createChainReader, createReconciler } from "./payments/reconcile.js";
import { createFacilitator, createPayments } from "./payments/x402.js";

const env = loadEnv();
setLogLevel(env.LOG_LEVEL);

const disabled = (process.env.DISABLED_SERVICES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Margin check: refuse to sell live data below the worst-case upstream cost.
for (const s of SERVICES) {
  const worst = SERVICE_CONFIG[s.id]!.worstCaseUsd;
  if (Number(s.priceUsdc) <= worst + FACILITATOR_FEE_USD) {
    const msg = `${s.id}: price ${s.priceUsdc} USDC does not cover worst-case upstream cost $${worst} + facilitator fee`;
    if (env.DATAFORSEO_MODE === "live") {
      log.error(`${msg} — service disabled until the price or the data source is changed`);
      disabled.push(s.id);
    } else {
      log.warn(`${msg} — tolerated in sandbox mode, would be disabled in live mode`);
    }
  }
}

const store = new Store(env.DB_PATH);
const recovered = store.recoverAfterRestart();
if (recovered.settled || recovered.unsettled) log.warn("recovered interrupted requests", recovered);
const purge = () => {
  const n = store.purgeOldPayloads(env.RETENTION_DAYS);
  if (n) log.info("retention: deleted request contents", { rows: n, retention_days: env.RETENTION_DAYS });
};
purge();
setInterval(purge, 6 * 3600_000).unref();
// Uptime heartbeat for the public status page (one row per minute, no request data).
store.beat();
setInterval(() => store.beat(), 60_000).unref();
const dfs = createDataForSeoClient({
  mode: env.DATAFORSEO_MODE,
  login: env.DATAFORSEO_LOGIN,
  password: env.DATAFORSEO_PASSWORD,
  timeoutMs: env.DATAFORSEO_TIMEOUT_MS,
});
const guard = new CostGuard(store, {
  dailyUsd: env.DATAFORSEO_DAILY_LIMIT_USD,
  monthlyUsd: env.DATAFORSEO_MONTHLY_LIMIT_USD,
  countSpend: env.DATAFORSEO_MODE === "live",
});
const pipeline = new Pipeline({ dfs, store, guard, services: SERVICES, disabledServices: disabled });
const payments =
  env.PAYMENT_MODE === "off"
    ? undefined
    : createPayments(
        { mode: env.PAYMENT_MODE, payTo: env.PAY_TO_ADDRESS, publicBaseUrl: env.PUBLIC_BASE_URL, facilitator: createFacilitator(env) },
        { store, pipeline, services: SERVICES },
      );
if (env.PAYMENT_MODE !== "off") {
  const reconcile = createReconciler(store, env.PAYMENT_MODE, createChainReader(env.PAYMENT_MODE));
  setInterval(() => { void reconcile(); }, 60_000).unref();
}
const app = createApp({ env, store, pipeline, payments });

// E-mail alerts (budget, payments needing attention, daily summary). Off unless configured.
const send = smtpSender(env);
if (send) {
  const alerts = createAlerts({ env, store, pipeline, send });
  setInterval(() => void alerts.check(), 5 * 60_000).unref();
  log.info("e-mail alerts on", { to: env.ALERT_EMAIL_TO });
}

const server = app.listen(env.PORT, () => {
  log.info("listening", {
    port: env.PORT,
    data_source: env.DATAFORSEO_MODE,
    payments: env.PAYMENT_MODE,
    network: payments?.network,
    pay_to: env.PAY_TO_ADDRESS || undefined,
    services: SERVICES.map((s) => s.id),
    disabled,
  });
  if (!env.DATAFORSEO_LOGIN) log.warn("DATAFORSEO_LOGIN is empty: upstream calls will fail with no_credentials");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close(() => {
      app.locals.pageViews?.stop(); // write buffered page views before the database closes
      store.close();
      process.exit(0);
    });
  });
}
