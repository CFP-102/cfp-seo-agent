/**
 * Manual, read-only refresh of the DWD MOSMIX station list used by shoot-location-check.
 * Reads the official all-stations forecast file once (about 84 MB download, 1.8 GB unpacked, streamed) and keeps only
 * id, name, coordinates and height of stations in and around Germany. No forecast values are stored.
 *
 *   npx tsx scripts/update-mosmix-stations.ts [path/to/MOSMIX_L_LATEST.kmz]
 *
 * Without an argument the file is downloaded from opendata.dwd.de into a temporary directory.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";
import { fileURLToPath } from "node:url";

const SOURCE = "https://opendata.dwd.de/weather/local_forecasts/mos/MOSMIX_L/all_stations/kml/MOSMIX_L_LATEST.kmz";
const BOX = { south: 47.0, north: 55.3, west: 5.5, east: 15.4 };
const arg = process.argv[2];
if (process.argv.length > 3) { console.error("Usage: npx tsx scripts/update-mosmix-stations.ts [MOSMIX_L_LATEST.kmz]"); process.exit(1); }

const work = await mkdtemp(join(tmpdir(), "mosmix-"));
try {
  let file = arg;
  if (!file) {
    file = join(work, "all.kmz");
    const response = await fetch(SOURCE, { redirect: "error", credentials: "omit", headers: { "User-Agent": "CFP-AgentData/0.1 (+https://agent.chiemgaufilms.com; manual station list refresh)" } });
    if (!response.ok || !response.body) throw new Error(`DWD HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file));
  }
  // KMZ = zip with one deflated entry: skip the local file header, then inflate the raw stream.
  const handle = await open(file, "r");
  const header = Buffer.alloc(30);
  await handle.read(header, 0, 30, 0); await handle.close();
  if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(8) !== 8) throw new Error("Unexpected archive layout");
  const start = 30 + header.readUInt16LE(26) + header.readUInt16LE(28);

  const stations: { id: string; name: string; latitude: number; longitude: number; elevation_m: number }[] = [];
  const tag = /<kml:name>([^<]*)<\/kml:name>|<kml:description>([^<]*)<\/kml:description>|<kml:coordinates>([^<]*)<\/kml:coordinates>/g;
  let carry = ""; let id: string | null = null; let name = ""; let total = 0;
  const scan = new TextDecoder("iso-8859-1");
  const inflate = createInflateRaw();
  createReadStream(file, { start }).pipe(inflate);
  for await (const chunk of inflate) {
    const text = carry + scan.decode(chunk as Buffer, { stream: true });
    let last = 0; tag.lastIndex = 0;
    for (let m = tag.exec(text); m; m = tag.exec(text)) {
      last = tag.lastIndex;
      if (m[1] !== undefined) id = m[1].trim();
      else if (m[2] !== undefined) name = m[2].trim();
      else if (m[3] !== undefined && id) {
        total++;
        const [lon, lat, elev] = m[3].split(",").map(Number) as [number, number, number];
        if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= BOX.south && lat <= BOX.north && lon >= BOX.west && lon <= BOX.east) {
          stations.push({ id, name, latitude: lat, longitude: lon, elevation_m: Number.isFinite(elev) ? Math.round(elev) : 0 });
        }
        id = null;
      }
    }
    carry = text.slice(Math.max(last, text.length - 300));
  }
  if (stations.length < 500) throw new Error(`Only ${stations.length} stations found; refusing to overwrite the list`);
  const output = {
    dataset: "dwd-mosmix-l-stations", retrieved_at: new Date().toISOString(), source: SOURCE,
    license: "CC BY 4.0, source: Deutscher Wetterdienst (DWD). Only station id, name and position are kept.",
    bounding_box: BOX, stations,
  };
  const destination = new URL("../src/config/mosmix-stations.json", import.meta.url);
  const temporary = fileURLToPath(destination) + ".tmp";
  await writeFile(temporary, JSON.stringify(output) + "\n");
  await rename(temporary, destination);
  console.log(JSON.stringify({ placemarks_in_file: total, stations_kept: stations.length, output: fileURLToPath(destination) }, null, 2));
} finally { await rm(work, { recursive: true, force: true }); }
