/** Free operator read of the two public sources behind shoot-location-check; no payment, credentials or DataForSEO. */
import { shootLocationCheck } from "../src/services/shootLocationCheck.js";
const [latitude, longitude, date] = process.argv.slice(2);
const input = shootLocationCheck.inputSchema.safeParse({ latitude: Number(latitude), longitude: Number(longitude), date });
if (!input.success) {
  console.error("Usage: npx tsx scripts/check-shoot-location.ts LATITUDE LONGITUDE YYYY-MM-DD   (Germany only)");
  process.exit(1);
}
console.log(JSON.stringify({ operator_diagnostic: true, payment_made: false, dataforseo_calls: 0, result: await shootLocationCheck.executeRemote!(input.data, "live") }, null, 2));
