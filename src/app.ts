import express, { type Request, type RequestHandler, type Response } from "express";
import type { Env } from "./config/env.js";
import { rateLimit } from "./lib/rateLimit.js";
import type { Store } from "./lib/store.js";
import { log } from "./lib/log.js";
import { buildCatalog } from "./catalog.js";
import { createMcpHandler } from "./mcp/server.js";
import type { McpCall } from "./payments/x402.js";
import { createAdminRouter } from "./admin.js";
import { createWishlist } from "./wishlist.js";
import { createFreeSample } from "./freeSample.js";
import { createSiteRouter } from "./web/site.js";
import { findService } from "./services/index.js";
import type { Pipeline, Prepared } from "./services/pipeline.js";
import type { ServiceDefinition } from "./services/types.js";

/** The x402 gate (src/payments/x402.ts). Absent = sandbox development mode, enforced by config/env.ts. */
export interface PaymentGate {
  claimPayment: RequestHandler;
  x402: RequestHandler;
  network: string;
  mcp: { callPaidTool: McpCall };
}

export interface AppDeps {
  env: Env;
  store: Store;
  pipeline: Pipeline;
  payments?: PaymentGate;
}

type Locals = { prepared?: Prepared; service?: ServiceDefinition; requestId?: string; resultToken?: string; executed?: boolean };

const isEmptyBody = (body: unknown) => body === undefined || body === null || (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0);

export function createApp(deps: AppDeps) {
  const { env, store, pipeline } = deps;
  const services = pipeline.services;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.TRUST_PROXY);

  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    next();
  });
  // 1000 keywords x 80 chars ~ 90 KB; anything larger is rejected before parsing.
  app.use(express.json({ limit: "128kb", strict: true }));

  const limiter = rateLimit({ perMinute: env.RATE_LIMIT_PER_MINUTE });
  const bearer = (req: Request) => {
    const auth = req.get("authorization") ?? "";
    return auth.startsWith("Bearer ") ? auth.slice(7).trim() : undefined;
  };

  // Responses of the API and MCP are per-caller data: never cache them anywhere.
  app.use(["/api", "/mcp"], (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, data_source: pipeline.dataSource, payments: env.PAYMENT_MODE });
  });

  // Free catalog: what we sell, for how much, with which limits.
  app.get("/api/v1/services", limiter, (_req, res) => {
    res.json(buildCatalog({ env, pipeline, network: deps.payments?.network, freeSample: freeSample.enabled() ? freeSample.info() : undefined, wishlist: wishlist.info() }));
  });

  // Free sample: one keyword per client per day, hard daily cap (see src/freeSample.ts). Off unless FREE_SAMPLE_DAILY_LIMIT > 0.
  const freeSample = createFreeSample({ pipeline, store, dailyLimit: env.FREE_SAMPLE_DAILY_LIMIT });
  app.post("/api/v1/free-sample", limiter, async (req, res) => {
    const out = await freeSample.run(req.ip, req.body);
    res.status(out.status).json(out.body);
  });
  app.post("/api/v1/free-sample/:serviceId", limiter, async (req, res) => {
    const out = await freeSample.runService(req.ip, String(req.params.serviceId), req.body);
    res.status(out.status).json(out.body);
  });

  // Wishlist: visitors tell us which tool they would pay for (free, write-only, see src/wishlist.ts).
  const wishlist = createWishlist({ store });
  app.post("/api/v1/wishlist", limiter, (req, res) => {
    const out = wishlist.run(req.ip, req.body);
    res.status(out.status).json(out.body);
  });

  // Free preflight: validates input and checks budget/limits without paying or calling DataForSEO.
  app.post("/api/v1/preflight/:serviceId", limiter, (req, res) => {
    const service = findService(String(req.params.serviceId));
    if (!service) return void res.status(404).json({ error: "unknown_service" });
    store.bump(service.id, "preflight");
    const prep = pipeline.prepare(service, req.body);
    if (!prep.ok) return void res.status(prep.httpStatus).json({ ok: false, ...prep.body });
    res.json({
      ok: true,
      service: service.id,
      price_usdc: service.priceUsdc,
      normalized_input: prep.prepared.input,
      message: "Input is valid and the request can be served. Send the same body to the service route to buy it.",
    });
  });

  // Re-fetch a paid result (or its status). Requires the result token returned with the original response.
  app.get("/api/v1/results/:requestId", limiter, (req, res) => {
    const out = pipeline.lookup(String(req.params.requestId), bearer(req));
    res.status(out.status).json(out.body);
  });

  // One free, explicit re-run of a paid request whose upstream call failed after settlement.
  app.post("/api/v1/results/:requestId/retry", limiter, async (req, res) => {
    const out = await pipeline.retry(String(req.params.requestId), bearer(req));
    res.status(out.status).json(out.body);
  });

  function prepareStep(service: ServiceDefinition): RequestHandler {
    return (req, res, next) => {
      store.bump(service.id, "request");
      const locals = res.locals as Locals;
      locals.service = service;
      const prep = pipeline.prepare(service, req.body);
      if (!prep.ok) {
        // Directory crawlers probe a paid route with an EMPTY body and expect the price (402) first.
        // Nothing can be charged by answering: a payment attached to an invalid request is refused
        // right here (400) and never settled, because this branch needs "no payment header + empty body".
        const noPayment = !req.get("payment-signature") && !req.get("x-payment");
        if (deps.payments && noPayment && prep.body.error === "invalid_input" && isEmptyBody(req.body)) {
          store.bump(service.id, "probe");
          return next();
        }
        store.bump(service.id, `refused_${prep.body.error}`);
        // Refused BEFORE any 402 challenge: a client can never pay for something we would not serve.
        return void res.status(prep.httpStatus).json(prep.body);
      }
      locals.prepared = prep.prepared;
      next();
    };
  }

  /** Development without payments: sandbox data only (config/env.ts forbids anything else). */
  const sandboxOnly: RequestHandler = (_req, res, next) => {
    if (env.PAYMENT_MODE !== "off" || pipeline.dataSource !== "sandbox") {
      return void res.status(503).json({ error: "payments_unavailable", message: "Payment processing is not configured." });
    }
    next();
  };

  const sandboxClaim: RequestHandler = (_req, res, next) => {
    const locals = res.locals as Locals;
    const claim = pipeline.claim(locals.prepared!, null)!;
    locals.requestId = claim.requestId;
    locals.resultToken = claim.resultToken;
    next();
  };

  /** Reached only after successful settlement (paid) or in sandbox mode. Exactly one upstream call. */
  const executeStep: RequestHandler = async (_req, res) => {
    const locals = res.locals as Locals;
    const prepared = locals.prepared;
    if (!prepared) return void res.status(400).json({ error: "invalid_input", message: "Request body failed validation. Nothing was charged." });
    locals.executed = true;
    const requestId = locals.requestId!;
    const reservation = deps.payments ? null : pipeline.reserve(prepared);
    if (reservation && "refusal" in reservation) {
      store.release(requestId);
      return void res.status(reservation.refusal.httpStatus).json({ error: reservation.refusal.code, message: reservation.refusal.message });
    }
    res.setHeader("X-Request-Id", requestId);
    try {
      const out = await pipeline.runClaimed(prepared, requestId, locals.resultToken!, { paid: Boolean(deps.payments), via: "rest" });
      res.status(out.status).json(out.body);
    } finally {
      if (reservation && "release" in reservation) reservation.release();
    }
  };

  for (const service of services) {
    const chain: RequestHandler[] = [limiter, prepareStep(service)];
    if (deps.payments) chain.push(deps.payments.claimPayment, deps.payments.x402);
    else chain.push(sandboxOnly, sandboxClaim);
    chain.push(executeStep);
    app.post(service.route, ...chain);
  }

  // Wrong method on a service route: say so instead of a generic 404.
  for (const service of services) {
    app.all(service.route, (_req, res) => {
      res.setHeader("Allow", "POST");
      res.status(405).json({ error: "method_not_allowed", message: "Use POST." });
    });
  }

  // MCP over Streamable HTTP (stateless). Free tools need no payment; paid tools use x402 in the call's _meta.
  app.all("/mcp", limiter, createMcpHandler({ env, store, pipeline, payments: deps.payments, freeSample, wishlist }));

  // Internal monitoring (HTTP Basic auth; 404 unless ADMIN_PASSWORD is set).
  app.use("/admin", createAdminRouter({ env, store, pipeline }));

  // Website, llms.txt, /openapi.json, /.well-known/x402 (compat) and static assets.
  app.use(createSiteRouter({ env, pipeline, network: deps.payments?.network, freeSample: freeSample.enabled(), freeSampleEligible: freeSample.enabled() ? (freeSample.info().per_service_eligible as string[]) : [], store }));

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err: Error & { status?: number; statusCode?: number; type?: string }, _req: Request, res: Response, _next: express.NextFunction) => {
    if (err.type === "entity.parse.failed") return void res.status(400).json({ error: "invalid_json" });
    if (err.type === "entity.too.large") return void res.status(413).json({ error: "body_too_large" });
    // Client mistakes raised by Express/body-parser (bad URL encoding, unsupported Content-Encoding, ...) are 4xx, not server errors.
    const status = err.status ?? err.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) return void res.status(status).json({ error: "bad_request" });
    log.error("unhandled error", { err });
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
