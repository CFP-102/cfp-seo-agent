/** Manual, read-only OSM import. Saves a separate ODbL snapshot, never merges CC0 data. */
import { mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { fetchOsmTransport, normalizeOsmTransport } from "../src/services/osmImport.js";

if (process.argv.length > 2) {
  console.error("Usage: npx tsx scripts/import-osm-transport.ts (fixed Chiemsee pilot area)");
  process.exit(1);
}
const dataset = normalizeOsmTransport(await fetchOsmTransport(), new Date().toISOString());
const directory = new URL("../data/osm/", import.meta.url);
await mkdir(directory, { recursive: true });
const temporary = new URL(`chiemsee-transport.${randomUUID()}.tmp`, directory);
const destination = new URL("chiemsee-transport.geojson", directory);
try {
  await writeFile(temporary, JSON.stringify(dataset, null, 2) + "\n", { flag: "wx" });
  await rename(temporary, destination);
} finally { await unlink(temporary).catch(() => {}); }
const counts: Record<string, number> = {};
for (const f of dataset.features) counts[f.properties.kind] = (counts[f.properties.kind] ?? 0) + 1;
console.log(JSON.stringify({ region: dataset.metadata.region, objects: dataset.features.length, counts, source_data_at: dataset.metadata.source_data_at, license: dataset.metadata.license, output: fileURLToPath(destination) }, null, 2));
