import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Runs src/stdio.ts through tsx and speaks MCP over stdin/stdout. */
function run(env: Record<string, string>, messages: object[], waitMs = 4000): Promise<{ lines: any[]; code: number | null }> {
  return new Promise((resolve) => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", "src/stdio.ts"], { cwd: root, env: { PATH: process.env.PATH ?? "", ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
    const t = setTimeout(() => child.kill(), waitMs);
    child.on("exit", (code) => {
      clearTimeout(t);
      resolve({ lines: out.split("\n").filter(Boolean).map((l) => JSON.parse(l)), code });
    });
  });
}

describe("MCP over stdio (sandbox only)", () => {
  it("answers initialize and tools/list with only JSON-RPC on stdout", async () => {
    const { lines } = await run({}, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);
    expect(lines.every((l) => l.jsonrpc === "2.0")).toBe(true);
    expect(lines.find((l) => l.id === 1).result.serverInfo.name).toBe("agent-data-api");
    expect(lines.find((l) => l.id === 2).result.tools.length).toBeGreaterThan(20);
  }, 20000);

  it("refuses to run with payments or live data", async () => {
    const { code } = await run({ PAYMENT_MODE: "testnet", PAY_TO_ADDRESS: "0x88c4de5f40C7B290D3D59a77718141082FE672d0", DATAFORSEO_LOGIN: "x", DATAFORSEO_PASSWORD: "y" }, [], 8000);
    expect(code).toBe(1);
  }, 20000);
});
