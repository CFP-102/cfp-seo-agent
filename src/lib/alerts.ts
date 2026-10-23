import nodemailer from "nodemailer";
import type { Env } from "../config/env.js";
import type { Pipeline } from "../services/pipeline.js";
import { buildStatus } from "../web/status.js";
import { log } from "./log.js";
import type { Store } from "./store.js";

/**
 * E-mail alerts for the operator. Off unless ALERT_EMAIL_TO and the SMTP settings are configured.
 * Checked every few minutes by the running server:
 *  - DataForSEO budget at 80 % / 100 % (daily and monthly, once per period and level)
 *  - new paid requests that need attention (failed delivery or unclear payment)
 *  - a daily summary at about 07:00 UTC (paid calls, revenue, cost, failures, wishes, uptime)
 * The server cannot e-mail while it is down: use an external uptime monitor for that (see docs/OPERATIONS.md).
 */
export type Send = (subject: string, text: string) => Promise<void>;

export function smtpSender(env: Env): Send | null {
  if (!env.ALERT_EMAIL_TO || !env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD) return null;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  });
  return async (subject, text) => {
    await transport.sendMail({ from: env.SMTP_FROM || env.SMTP_USER, to: env.ALERT_EMAIL_TO, subject: `[${env.SITE_NAME}] ${subject}`, text });
  };
}

export function createAlerts(deps: { env: Env; store: Store; pipeline: Pipeline; send: Send; now?: () => Date }) {
  const { env, store, pipeline, send } = deps;
  const clock = deps.now ?? (() => new Date());
  const sent = new Set<string>();
  let seenAttention = new Set(store.needsAttention(100).map((r) => String(r.id)));
  let summaryDay = "";

  /** Sends at most once per key; returns false (and allows a retry next round) if sending failed. */
  const once = async (key: string, subject: string, text: string): Promise<boolean> => {
    if (sent.has(key)) return true;
    sent.add(key);
    try {
      await send(subject, text);
      return true;
    } catch (e) {
      sent.delete(key);
      log.warn("alert e-mail failed", { subject, error: (e as Error).message });
      return false;
    }
  };

  async function check(): Promise<void> {
    const now = clock();
    const day = now.toISOString().slice(0, 10);
    const month = day.slice(0, 7);

    const budgets: [string, number, number, string][] = [
      ["daily", store.upstreamSpendSince(day), env.DATAFORSEO_DAILY_LIMIT_USD, day],
      ["monthly", store.upstreamSpendSince(`${month}-01`), env.DATAFORSEO_MONTHLY_LIMIT_USD, month],
    ];
    for (const [kind, spent, limit, period] of budgets) {
      if (limit <= 0) continue;
      const pct = (spent / limit) * 100;
      for (const level of [100, 80]) {
        if (pct >= level) {
          await once(
            `budget:${kind}:${period}:${level}`,
            `DataForSEO ${kind === "daily" ? "Tages" : "Monats"}budget bei ${Math.round(pct)} %`,
            `Verbraucht: $${spent.toFixed(4)} von $${limit} (${kind === "daily" ? "heute" : "diesen Monat"}).\n` +
              (level === 100 ? "Das Limit ist erreicht: weitere Abrufe werden vor der Zahlung abgelehnt, bis das Limit wieder frei ist.\n" : "Bei 100 % werden Abrufe vor der Zahlung abgelehnt.\n") +
              `Limit ändern: DATAFORSEO_${kind === "daily" ? "DAILY" : "MONTHLY"}_LIMIT_USD in .env.production, dann deployen.`,
          );
          break;
        }
      }
    }

    const attention = store.needsAttention(100);
    const fresh = attention.filter((r) => !seenAttention.has(String(r.id)));
    seenAttention = new Set(attention.map((r) => String(r.id)));
    if (fresh.length) {
      await once(
        `attention:${fresh.map((r) => r.id).join(",")}`,
        `${fresh.length} bezahlte Anfrage(n) brauchen Aufmerksamkeit`,
        fresh
          .map((r) => `- ${r.created_at} · ${r.service_id} · ${r.status} · Fehler ${r.error_code ?? "-"} · ${r.price_usdc} USDC · Zahler ${r.payer ?? "-"} · Tx ${r.tx_hash ?? "-"} · ID ${r.id}`)
          .join("\n") + "\n\nDetails im Admin unter „Needs attention“. Bei Bedarf manuell erstatten.",
      );
    }

    if (now.getUTCHours() >= 7 && summaryDay !== day) {
      const y = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
      const rows = store.history(2, now)[0];
      const st = buildStatus(store, pipeline, now);
      const wishes = store.recentWishes(100).filter((w) => w.created_at.startsWith(y)).length;
      const ok = await once(
        `summary:${day}`,
        `Tagesbericht ${y}`,
        [
          `Bezahlte Abrufe (echtes Geld): ${rows?.paid ?? 0}`,
          `Umsatz: ${(rows?.revenue_usdc ?? 0).toFixed(4)} USDC`,
          `DataForSEO-Kosten: $${(rows?.cost_usd ?? 0).toFixed(4)}`,
          `Fehlgeschlagen: ${rows?.failed ?? 0}`,
          `Neue Wünsche: ${wishes}`,
          `Verfügbarkeit 24 h: ${st.uptime_pct.last_24h} %`,
          `Offene Fälle (Needs attention): ${attention.length}`,
          "",
          `Admin: ${env.PUBLIC_BASE_URL}/admin`,
        ].join("\n"),
      );
      if (ok) summaryDay = day;
    }
  }

  return { check, test: () => send("Test-Alarm", `Die E-Mail-Benachrichtigung funktioniert (${clock().toISOString()}).`) };
}

