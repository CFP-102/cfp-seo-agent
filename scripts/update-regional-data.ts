/** Free public Wikidata GET only. No credentials, payment or DataForSEO requests. */
import { writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { CHIEMGAU_PLACES } from "../src/config/regionalSources.js";
import { regionalDatasetSchema } from "../src/services/regionalSchema.js";
import { obj, arr, str, num } from "../src/services/common.js";

const url = new URL("https://www.wikidata.org/w/api.php");
url.search = new URLSearchParams({ action: "wbgetentities", ids: CHIEMGAU_PLACES.map(p => p.id).join("|"), props: "labels|descriptions|claims|info", languages: "de", format: "json" }).toString();
const response = await fetch(url, { headers: { "User-Agent": "CFP-AgentData/0.1 (https://agent.chiemgaufilms.com; regional places snapshot)" }, signal: AbortSignal.timeout(30000), redirect: "error" });
if (!response.ok) throw new Error(`Wikidata HTTP ${response.status}; existing dataset was not changed`);
const entities = obj(obj(await response.json()).entities);
const now = new Date().toISOString();
const records = CHIEMGAU_PLACES.map(p => {
  const entity = obj(entities[p.id]);
  const statement = arr(obj(entity.claims).P625).map(obj).find(s => s.rank !== "deprecated" && obj(obj(s.mainsnak).datavalue).value);
  const coordinate = obj(obj(obj(statement?.mainsnak).datavalue).value);
  if (coordinate.globe !== "http://www.wikidata.org/entity/Q2") throw new Error(`Missing Earth coordinate: ${p.id}`);
  return { id: p.id, region: "chiemgau", category: p.category,
    name: str(obj(obj(entity.labels).de).value), description: str(obj(obj(entity.descriptions).de).value) ?? "",
    latitude: num(coordinate.latitude), longitude: num(coordinate.longitude),
    source_url: `https://www.wikidata.org/wiki/${p.id}`, source_revision: num(entity.lastrevid),
    license: "CC0-1.0", retrieved_at: now };
});
const dataset = regionalDatasetSchema.parse({ dataset: "chiemgau-wikidata", updated_at: now, records });
const destination = new URL("../src/config/regional-data.json", import.meta.url);
const temporary = new URL(`../src/config/regional-data.${randomUUID()}.tmp`, import.meta.url);
try {
  await writeFile(temporary, JSON.stringify(dataset, null, 2) + "\n", { flag: "wx" });
  await rename(temporary, destination);
} finally { await unlink(temporary).catch(() => {}); }
console.log(`Saved ${dataset.records.length} verified Wikidata records. Rebuild/restart to use the new snapshot.`);
