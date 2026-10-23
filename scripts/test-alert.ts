/** Sends one test e-mail with the SMTP settings from the given env file. Usage: npx tsx --env-file=.env.production scripts/test-alert.ts */
import { loadEnv } from "../src/config/env.js";
import { smtpSender } from "../src/lib/alerts.js";

const send = smtpSender(loadEnv());
if (!send) {
  console.error("E-mail alerts are not configured (ALERT_EMAIL_TO, SMTP_HOST, SMTP_USER, SMTP_PASSWORD).");
  process.exit(1);
}
await send("Test-Alarm", `Die E-Mail-Benachrichtigung funktioniert (${new Date().toISOString()}).`);
console.log("sent");
