/** Free operator diagnostic: direct HTTPS only, no payment, credentials or DataForSEO. */
import { websiteCheck } from "../src/services/websiteCheck.js";

const [url, first, second, ...extra] = process.argv.slice(2);
if (!url || !first || !second || extra.length) {
  console.error("Usage: npx tsx scripts/check-website.ts HTTPS_PAGE HTTPS_LINK_1 HTTPS_LINK_2");
  process.exit(1);
}
const input = websiteCheck.inputSchema.safeParse({ url, link_urls: [first, second] });
if (!input.success) {
  console.error("Invalid input: provide one public HTTPS page and two distinct HTTPS links on the same origin.");
  process.exit(1);
}
const result = await websiteCheck.executeRemote!(input.data, "live");
console.log(JSON.stringify({ checked_at: new Date().toISOString(), operator_diagnostic: true, payment_made: false, dataforseo_calls: 0, result }, null, 2));
