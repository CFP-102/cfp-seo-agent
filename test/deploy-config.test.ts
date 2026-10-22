import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const compose = read("docker-compose.yml");
const caddy = read("Caddyfile");
const docker = read("Dockerfile");
const dockerignore = read(".dockerignore");
const gitignore = read(".gitignore");

/** Text of one top-level service block of docker-compose.yml. */
const service = (name: string) => {
  const m = compose.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z]+:\\n|^networks:|^volumes:)`, "m"));
  expect(m, `service ${name}`).toBeTruthy();
  return m![1]!;
};

describe("docker compose / Caddy hardening", () => {
  it("the app is never published on the host; only Caddy exposes 80/443", () => {
    const app = service("app");
    expect(app).not.toMatch(/^\s+ports:/m);
    expect(app).toMatch(/expose:\s*\n\s+- "3000"/);
    const proxy = service("caddy");
    const published = [...proxy.matchAll(/- "(\d+):(\d+)(\/udp)?"/g)].map((m) => `${m[1]}${m[3] ?? ""}`).sort();
    expect(published).toEqual(["443", "443/udp", "80"]);
  });

  it("containers are locked down: read-only fs, no capabilities, no-new-privileges, limits", () => {
    for (const name of ["app", "caddy"]) {
      const s = service(name);
      expect(s, name).toMatch(/read_only: true/);
      expect(s, name).toMatch(/cap_drop: \[ALL\]/);
      expect(s, name).toMatch(/no-new-privileges:true/);
      expect(s, name).toMatch(/mem_limit:/);
      expect(s, name).toMatch(/pids_limit:/);
      expect(s, name).toMatch(/restart: unless-stopped/);
    }
    expect(service("caddy")).toMatch(/cap_add: \[NET_BIND_SERVICE\]/);
    expect(service("app")).not.toMatch(/privileged|network_mode: host|docker\.sock/);
  });

  it("the app trusts exactly one proxy and runs in production mode with a persistent volume", () => {
    const app = service("app");
    expect(app).toMatch(/NODE_ENV: production/);
    expect(app).toMatch(/TRUST_PROXY: "1"/);
    expect(app).toMatch(/app-data:\/data/);
  });

  it("the Caddy access log drops IP addresses and all headers, and the proxy sets security headers", () => {
    expect(caddy).toMatch(/request>remote_ip delete/);
    expect(caddy).toMatch(/request>client_ip delete/);
    expect(caddy).toMatch(/request>headers delete/);
    for (const h of ["Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy"]) expect(caddy).toContain(h);
    expect(caddy).toMatch(/max_size 256KB/);
    expect(caddy).toMatch(/reverse_proxy app:3000/);
    expect(caddy).not.toMatch(/tls internal|auto_https off|admin off\b.*\n.*0\.0\.0\.0/); // real certificates, default admin API stays local
  });

  it("the image runs as the unprivileged user, installs without scripts and carries no secrets", () => {
    expect(docker).toMatch(/^USER node$/m);
    expect((docker.match(/npm ci/g) ?? []).length).toBe(2);
    expect(docker).not.toMatch(/npm ci(?!.*--ignore-scripts)/);
    expect(docker).toMatch(/--omit=dev/);
    expect(docker).not.toMatch(/COPY \.\s/); // no blanket copy of the project directory
    for (const pattern of [".env", ".env.*", "node_modules", ".git", "data"]) expect(dockerignore.split("\n")).toContain(pattern);
  });

  it("secret files are git-ignored", () => {
    const lines = gitignore.split("\n");
    for (const f of [".env", ".env.*", "data/*"]) expect(lines).toContain(f);
    expect(lines).toContain("!.env.example");
  });

  it("the deploy script never uploads secret files except the explicit env file, and does not start without a domain", () => {
    const deploy = read("scripts/deploy.sh");
    expect(deploy).toMatch(/--exclude '\.env\*'/);
    expect(deploy).toMatch(/umask 077/);
    expect(deploy).toMatch(/DOMAIN missing/);
  });
});
