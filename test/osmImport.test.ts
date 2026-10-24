import { describe, expect, it } from "vitest";
import { buildOsmQuery, normalizeOsmTransport, fetchOsmTransport } from "../src/services/osmImport.js";
import { OSM_IMPORT } from "../src/config/services.js";

const time = "2026-10-24T10:00:00.000Z";
const sample = () => ({ osm3s: { timestamp_osm_base: time }, elements: [
  { type: "node", id: 1, lat: 47.8, lon: 12.4, tags: { amenity: "parking", name: "Private parking", access: "private", fee: "yes" } },
  { type: "way", id: 2, center: { lat: 47.81, lon: 12.41 }, tags: { public_transport: "platform", name: "Example stop" } },
] });
describe("OSM transport pilot import", () => {
  it("retains source identities, licensing and dates in a separate GeoJSON collection", () => {
    const result = normalizeOsmTransport(sample(), time);
    expect(result.type).toBe("FeatureCollection");
    expect(result.metadata).toMatchObject({ license: "ODbL-1.0", attribution: "© OpenStreetMap contributors", features_count: 2, source_data_at: time });
    expect(result.features[0]).toMatchObject({ id: "node/1", geometry: { coordinates: [12.4, 47.8] }, properties: { source_url: "https://www.openstreetmap.org/node/1", kind: "parking", access: "private", fee: "yes", wheelchair: null } });
    expect(result.features[1]?.properties.coordinate_type).toBe("bounding_box_center");
  });
  it("deduplicates OSM identities, skips unavailable coordinates and rejects incomplete results", () => {
    const data = sample(); data.elements.push(data.elements[0]!);
    expect(normalizeOsmTransport(data, time).features).toHaveLength(2);
    const missing = { osm3s: { timestamp_osm_base: time }, elements: [{ type: "node", id: 3, tags: { amenity: "parking" } }] };
    expect(() => normalizeOsmTransport(missing, time)).toThrow("No usable");
    expect(() => normalizeOsmTransport({ ...sample(), remark: "runtime error: query timed out" }, time)).toThrow("incomplete");
    expect(() => normalizeOsmTransport({ ...sample(), osm3s: {} }, time)).toThrow();
  });
  it("sends one fixed read-only query and never uses a login or follows redirects", async () => {
    let calls = 0;
    const data = await fetchOsmTransport((async (url, init) => {
      calls++; expect(url).toBe(OSM_IMPORT.endpoint);
      expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
      expect(new URLSearchParams(String(init?.body)).get("data")).toBe(buildOsmQuery());
      expect(buildOsmQuery()).toContain("47.75,12.3,47.95,12.6");
      expect(buildOsmQuery()).toContain("out body center");
      return new Response(JSON.stringify(sample()));
    }) as typeof fetch);
    expect(calls).toBe(1); expect(normalizeOsmTransport(data, time).features).toHaveLength(2);
    await expect(fetchOsmTransport((async () => new Response("busy", { status: 429 })) as typeof fetch)).rejects.toThrow("no retry");
  });
});
