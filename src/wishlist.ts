import { z } from "zod";
import { clientKey } from "./lib/rateLimit.js";
import type { Store } from "./lib/store.js";

/**
 * Wishlist: agents (or their owners) can tell us which data tool they would pay for. Free, write-only (nothing is ever shown publicly).
 * Limits, all small on purpose:
 *  - text only, 10 to 300 characters, no control characters, strict input
 *  - 3 wishes per client per UTC day (client address kept only in memory until the day ends; IPv6 clients keyed by /64)
 *  - a global cap per UTC day so the table cannot be flooded
 *  - stored wishes are deleted after RETENTION_DAYS together with the other request data
 */
export const WishInput = z.strictObject({
  text: z
    .string()
    .trim()
    .min(10, "describe the tool in at least 10 characters")
    .max(300, "at most 300 characters")
    // eslint-disable-next-line no-control-regex
    .refine((t) => !/[\u0000-\u001f\u007f]/.test(t), "text contains control characters")
    .describe("Which data tool would you pay for, and roughly what for? No personal data, 10 to 300 characters."),
});

export interface WishlistDeps {
  store: Store;
  dailyCap?: number;
  perClientPerDay?: number;
  now?: () => Date;
}

export function createWishlist(deps: WishlistDeps) {
  const { store } = deps;
  const dailyCap = deps.dailyCap ?? 100;
  const perClient = deps.perClientPerDay ?? 3;
  const clock = deps.now ?? (() => new Date());
  let day = "";
  let perClientCount = new Map<string, number>();
  let total = 0;
  const roll = () => {
    const d = clock().toISOString().slice(0, 10);
    if (d !== day) {
      day = d;
      perClientCount = new Map();
      total = 0;
    }
  };

  return {
    info: () => ({ path: "/api/v1/wishlist", per_client_per_day: perClient, max_chars: 300 }),
    run(ip: string | undefined, body: unknown): { status: number; body: Record<string, unknown> } {
      const parsed = WishInput.safeParse(body ?? {});
      if (!parsed.success) {
        return { status: 400, body: { error: "invalid_input", message: "Send {\"text\": \"...\"} with 10 to 300 characters.", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } };
      }
      roll();
      const client = clientKey(ip);
      if ((perClientCount.get(client) ?? 0) >= perClient) return { status: 429, body: { error: "wishlist_limit", message: `At most ${perClient} wishes per day per client.` } };
      if (total >= dailyCap) return { status: 429, body: { error: "wishlist_full", message: "Today's wishlist is full. Try again tomorrow (UTC)." } };
      store.addWish(parsed.data.text, clock());
      perClientCount.set(client, (perClientCount.get(client) ?? 0) + 1);
      total++;
      store.bump("wishlist", "wish");
      return { status: 200, body: { ok: true, message: "Thank you. We read every wish; nothing is published and no reply is sent." } };
    },
  };
}

export type Wishlist = ReturnType<typeof createWishlist>;
