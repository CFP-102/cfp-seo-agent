import express, { type RequestHandler, type Router } from "express";
import type { FacilitatorClient } from "@x402/core/server";
import type { Env } from "../config/env.js";
import type { Store } from "../lib/store.js";
import { createFinanceRouter, FINANCE_DIRECTORY } from "./finance.js";
import { createGiftCards, type GiftCards } from "./giftcards.js";
import { guardProvider, MockGiftCardProvider, type GiftCardProvider } from "./provider.js";
import { CommerceStore } from "./store.js";
import { createVault } from "./vault.js";

/**
 * Agent Commerce: gift cards (src/commerce/giftcards.ts) and the finance directory (src/commerce/finance.ts), mounted
 * next to the data API without changing any of its routes. Gift card payments use x402 only on testnet for now:
 * config/env.ts forbids the mock supplier with mainnet, and no real supplier adapter exists yet.
 */
export interface Commerce {
  router: Router;
  cstore: CommerceStore;
  giftcards: GiftCards;
}

export function createCommerce(deps: { env: Env; store: Store; limiter: RequestHandler; facilitator?: FacilitatorClient; provider?: GiftCardProvider }): Commerce {
  const { env, store } = deps;
  // With real payment modes, gift cards must go through x402: never fall back to free (sandbox) orders.
  if (env.GIFTCARDS_MODE !== "off" && env.PAYMENT_MODE !== "off" && !deps.facilitator) throw new Error("gift cards need the x402 facilitator when payments are on");
  const cstore = new CommerceStore(store.db);
  const payments =
    env.GIFTCARDS_MODE !== "off" && deps.facilitator && env.PAYMENT_MODE !== "off"
      ? { mode: env.PAYMENT_MODE, payTo: env.PAY_TO_ADDRESS, publicBaseUrl: env.PUBLIC_BASE_URL, facilitator: deps.facilitator }
      : undefined;
  const giftcards = createGiftCards({
    cfg: {
      mode: env.GIFTCARDS_MODE,
      maxOrderUsd: env.GIFTCARDS_MAX_ORDER_USD,
      dailyLimitUsd: env.GIFTCARDS_DAILY_LIMIT_USD,
      payerDailyOrders: env.GIFTCARDS_PAYER_DAILY_ORDERS,
      quoteTtlSeconds: env.GIFTCARDS_QUOTE_TTL_SECONDS,
      paymentFeeUsd: env.GIFTCARDS_PAYMENT_FEE_USD,
      payments,
    },
    store,
    cstore,
    provider: guardProvider(deps.provider ?? new MockGiftCardProvider()),
    vault: env.GIFTCARDS_ENCRYPTION_KEY ? createVault(env.GIFTCARDS_ENCRYPTION_KEY) : null,
    limiter: deps.limiter,
  });

  const router = express.Router();
  // Free overview for agents: what the commerce modules offer and whether they are switched on.
  router.get("/api/v1/commerce", deps.limiter, (_req, res) => {
    res.json({
      giftcards: { ...giftcards.info(), docs: `${env.PUBLIC_BASE_URL}/giftcards`, endpoints: ["GET /api/v1/giftcards/catalog", "GET /api/v1/giftcards/products", "POST /api/v1/giftcards/quote", "POST /api/v1/giftcards/orders (x402)", "GET /api/v1/giftcards/orders/{id} (order token)"] },
      finance: { enabled: true, kind: "directory", fees: "none", entries: FINANCE_DIRECTORY.length, docs: `${env.PUBLIC_BASE_URL}/finance`, endpoints: ["GET /api/v1/finance/partners", "GET /api/v1/finance/offers"] },
    });
  });
  router.use(giftcards.router);
  router.use(createFinanceRouter(deps.limiter));
  return { router, cstore, giftcards };
}
