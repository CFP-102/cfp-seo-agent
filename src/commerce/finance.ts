import express, { type RequestHandler, type Router } from "express";
import { z } from "zod";

/**
 * Agent Finance Gateway, information only: a directory of third-party financial services that agents can pay via x402.
 * Operator decision 2026-10-27: no referral tracking, no fee, no claimed partnership. We do not process, hold or forward
 * money for these services; agents contact them directly. Entries record where the facts come from and when they were
 * checked. Adding a fee or referral tracking needs a contract with the provider and legal advice first (docs/COMMERCE.md).
 */
export interface FinanceEntry {
  id: string;
  name: string;
  category: string;
  summary: string;
  products: { id: string; name: string; pricing: string; regions: string[] }[];
  payment: { protocol: "x402"; assets: string[]; networks: string[] };
  website: string;
  docs: string[];
  regulatory_note: string;
  relationship: "none";
  last_checked: string;
}

export const FINANCE_DIRECTORY: FinanceEntry[] = [
  {
    id: "laso-finance",
    name: "Laso Finance",
    category: "prepaid-cards",
    summary: "Prepaid cards for AI agents, ordered through a payment-gated API.",
    products: [{ id: "laso-prepaid-card", name: "Prepaid card", pricing: "Card amounts from 5 to 1,000 USD according to the provider; lookups and balance checks are free.", regions: ["US"] }],
    payment: { protocol: "x402", assets: ["USDC"], networks: ["Base", "Solana"] },
    website: "https://laso.finance",
    docs: ["https://docs.paywithlocus.com/features/laso.md", "https://partners.circle.com/partner/laso-finance"],
    regulatory_note: "Described by public sources as a FinCEN-registered Money Services Business (USA). Card ordering is reported as US-only.",
    relationship: "none",
    last_checked: "2026-10-27",
  },
];

const DISCLAIMER =
  "Information only. Listed services are independent third parties; there is no partnership, referral fee or endorsement. We do not process, hold or forward money for them. Check the provider's own terms before use.";

const OfferQuery = z.object({ category: z.string().max(40).optional(), region: z.string().regex(/^[A-Za-z]{2}$/).optional() }).strict();

export function createFinanceRouter(limiter: RequestHandler): Router {
  const router = express.Router();
  router.get("/api/v1/finance/partners", limiter, (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({
      disclaimer: DISCLAIMER,
      partners: FINANCE_DIRECTORY.map(({ products: _p, ...e }) => e),
    });
  });
  router.get("/api/v1/finance/offers", limiter, (req, res) => {
    const q = OfferQuery.safeParse(req.query);
    if (!q.success) return void res.status(400).json({ error: "invalid_input", message: "Optional filters: ?category=...&region=US" });
    res.setHeader("Cache-Control", "public, max-age=3600");
    const offers = FINANCE_DIRECTORY.filter((e) => !q.data.category || e.category === q.data.category.toLowerCase()).flatMap((e) =>
      e.products
        .filter((p) => !q.data.region || p.regions.includes(q.data.region.toUpperCase()))
        .map((p) => ({ ...p, provider_id: e.id, provider: e.name, payment: e.payment, website: e.website, last_checked: e.last_checked })),
    );
    res.json({ disclaimer: DISCLAIMER, offers });
  });
  return router;
}
