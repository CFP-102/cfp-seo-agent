/** Free operator catalog read; no credentials, payment, source downloads or DataForSEO. */
import { openDataSearch } from "../src/services/openDataSearch.js";
const [source, ...terms] = process.argv.slice(2);
const input = openDataSearch.inputSchema.safeParse({ source, query: terms.join(" ") });
if (!input.success) {
  console.error("Usage: npx tsx scripts/check-open-data.ts govdata|openbydata SEARCH_WORDS");
  process.exit(1);
}
console.log(JSON.stringify({ operator_diagnostic: true, payment_made: false, dataforseo_calls: 0, result: await openDataSearch.executeRemote!(input.data, "live") }, null, 2));
