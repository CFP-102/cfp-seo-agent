import { z } from "zod";
import { OSM_IMPORT as cfg } from "../config/services.js";
import { readBounded } from "./common.js";

const coordinate = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const element = z.object({
  type: z.enum(["node", "way", "relation"]), id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  lat: z.number().min(-90).max(90).optional(), lon: z.number().min(-180).max(180).optional(),
  center: coordinate.optional(), tags: z.record(z.string(), z.string()).default({}),
});
const responseSchema = z.object({
  osm3s: z.object({ timestamp_osm_base: z.iso.datetime() }),
  remark: z.string().optional(), elements: z.array(element).max(cfg.elements),
});
export function buildOsmQuery(): string {
  const bbox = cfg.bbox.join(",");
  return `[out:json][timeout:${cfg.queryTimeoutSeconds}][maxsize:${cfg.queryMemoryBytes}];(nwr["amenity"~"^(parking|parking_entrance|ferry_terminal)$"](${bbox});nwr["highway"="bus_stop"](${bbox});nwr["public_transport"~"^(platform|station|stop_position)$"](${bbox});nwr["railway"~"^(station|halt|tram_stop)$"](${bbox}););out body center;`;
}
export function normalizeOsmTransport(payload: unknown, importedAt: string) {
  const parsed = responseSchema.parse(payload);
  if (parsed.remark) throw new Error("Overpass reported an incomplete or failed query; previous data must remain unchanged");
  const seen = new Set<string>(); let skipped = 0;
  const features = parsed.elements.flatMap(e => {
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const c = e.type === "node" ? (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : undefined) : e.center;
    if (!c) { skipped++; return []; }
    const t = e.tags;
    const kind = t.amenity === "parking" ? "parking" : t.amenity === "parking_entrance" ? "parking_entrance" : t.amenity === "ferry_terminal" ? "ferry_terminal" :
      t.highway === "bus_stop" || ["platform", "station", "stop_position"].includes(t.public_transport ?? "") || ["station", "halt", "tram_stop"].includes(t.railway ?? "") ? "transit_stop" : null;
    if (!kind) { skipped++; return []; }
    const value = (key: string) => t[key]?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, cfg.tagChars) || null;
    return [{ type: "Feature" as const, id, geometry: { type: "Point" as const, coordinates: [c.lon, c.lat] }, properties: {
      osm_type: e.type, osm_id: e.id, source_url: `https://www.openstreetmap.org/${id}`,
      kind, coordinate_type: e.type === "node" ? "osm_node" : "bounding_box_center",
      name: value("name"), access: value("access"), fee: value("fee"), capacity: value("capacity"),
      wheelchair: value("wheelchair"), opening_hours: value("opening_hours"), parking: value("parking"),
      public_transport: value("public_transport"), highway: value("highway"), railway: value("railway"),
      bus: value("bus"), train: value("train"), tram: value("tram"), ferry: value("ferry"),
      operator: value("operator"), network: value("network"), ref: value("ref"),
    } }];
  });
  if (!features.length) throw new Error("No usable OSM features; previous data must remain unchanged");
  return {
    type: "FeatureCollection" as const,
    metadata: { region: cfg.region, selection_bbox_south_west_north_east: cfg.bbox,
      imported_at: z.iso.datetime().parse(importedAt), source_data_at: parsed.osm3s.timestamp_osm_base,
      source: "OpenStreetMap via Overpass API", source_endpoint: cfg.endpoint, query: buildOsmQuery(),
      license: "ODbL-1.0", license_url: "https://opendatacommons.org/licenses/odbl/1-0/",
      attribution: "© OpenStreetMap contributors", attribution_url: "https://www.openstreetmap.org/copyright",
      features_count: features.length, skipped_elements: skipped,
      coverage: "Bounded Chiemsee pilot, not the whole Chiemgau. Separate OSM objects may describe one physical stop. Ways/relations use bounding-box centers, not entrances. Unknown access, fee or wheelchair tags are not permissions. No live parking occupancy, timetable, route or accessibility guarantee.",
    }, features,
  };
}

/** One bounded read-only Overpass query. No login, retries or fallback hosts. */
export async function fetchOsmTransport(fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImpl(cfg.endpoint, { method: "POST", redirect: "error", credentials: "omit",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": "CFP-AgentData/0.1 (+https://agent.chiemgaufilms.com; manual Chiemsee pilot import)" },
    body: new URLSearchParams({ data: buildOsmQuery() }).toString(), signal: AbortSignal.timeout(cfg.timeoutMs) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Overpass HTTP ${response.status}; no retry performed`); }
  return JSON.parse((await readBounded(response, cfg.responseBytes)).toString("utf8"));
}
