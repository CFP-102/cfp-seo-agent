# Deployment (Mac → Hetzner-Server)

Der Server `agent-server` (Ubuntu, Docker, Firewall) ist bereits eingerichtet. Die Domain `agent.chiemgaufilms.com` zeigt per DNS auf ihn.
Alles läuft in **zwei Docker-Containern**: `app` (unser Dienst, von außen nicht erreichbar) und `caddy` (HTTPS, einziger öffentlicher Eingang).

## Einmalig: Server vorbereiten (schon erledigt)

```bash
# vom Mac aus
ssh agent-server 'bash -s' < scripts/server-harden.sh   # Firewall (22/80/443), nur SSH-Schlüssel, fail2ban, Auto-Updates
ssh agent-server 'bash -s' < scripts/server-docker.sh   # Docker + Compose
```

SSH funktioniert ohne Passwort über den Kurznamen `agent-server` (Schlüssel `~/.ssh/agent_server_ed25519`, Eintrag in `~/.ssh/config`).
Verlierst du den Mac, verlierst du den Zugang: Lege den Schlüssel zusätzlich in einem Passwort-Manager ab oder erzeuge in der Hetzner-Konsole bei Bedarf einen neuen.

## Konfiguration

| Datei | Wo | Inhalt |
|---|---|---|
| `.env` | Mac, Projektordner | Entwicklung (Port 3000, Sandbox, ohne Zahlung oder Testnet) |
| `.env.production` | Mac, Projektordner (nicht in Git) | Server-Werte inkl. Admin-Passwort und DataForSEO-Zugang |
| `/opt/agent-api/.env` | Server (Rechte 600, nur root) | wird vom Deploy-Skript aus `.env.production` erzeugt |

Wichtige Einstellungen: `PAYMENT_MODE` (`testnet` | `mainnet`), `DATAFORSEO_MODE` (`sandbox` | `live`), `PAY_TO_ADDRESS`, `ADMIN_PASSWORD`, `DOMAIN`, `PUBLIC_BASE_URL`.
Der Dienst startet **nicht**, wenn eine gefährliche Kombination eingestellt ist (z. B. Mainnet mit Sandbox-Daten, Live-Daten ohne Zahlung, schwaches Admin-Passwort).

## Befehle auf deinem Mac

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
npm install
npm test                      # alle Tests
npm run typecheck
./scripts/deploy.sh           # Dateien hochladen, Image bauen, starten, Gesundheitscheck über HTTPS
./scripts/deploy.sh build     # nur hochladen und bauen, nicht starten
```

## Befehle auf dem Server (per SSH)

```bash
ssh agent-server
cd /opt/agent-api
docker compose ps                         # läuft alles? (app: healthy)
docker compose logs --tail 100 app        # Dienst-Protokoll
docker compose logs --tail 100 caddy      # Proxy-Protokoll (ohne IP-Adressen)
docker compose restart app                # Dienst neu starten
docker compose down && docker compose up -d   # alles neu starten
./scripts/backup.sh                       # Datenbank sichern (siehe OPERATIONS.md)
```

## Update einspielen

1. Auf dem Mac ändern, `npm test` ausführen.
2. `./scripts/deploy.sh`. Die Datenbank bleibt erhalten (Docker-Volume `app-data`), Zertifikate ebenfalls (`caddy-data`).
3. Prüfen: `curl https://agent.chiemgaufilms.com/health` und im Browser `/admin`.

**Zurückrollen:** vorherigen Stand lokal wiederherstellen und erneut `./scripts/deploy.sh`.

## HTTPS

Caddy holt und erneuert das Zertifikat (Let's Encrypt) automatisch. Voraussetzungen: DNS-Einträge `A` und `AAAA` für `agent` zeigen auf den Server, Ports 80 und 443 sind offen.
Beim ersten Start dauert es etwa eine halbe Minute. Fehler siehe `docker compose logs caddy`.

## Umstieg auf Mainnet (echtes Geld)

**Erst nach** bestandenen Testnet-Tests **und** deiner ausdrücklichen Freigabe. Checkliste in `docs/PAYMENTS.md` (Abschnitt „Mainnet-Checkliste“).

## Fehlersuche

| Problem | Ursache / Lösung |
|---|---|
| Dienst startet nicht, `Invalid configuration` im Log | `.env`-Wert fehlt oder unzulässige Kombination; Meldung nennt das Feld (nie den Wert) |
| `502` von Caddy | `app` nicht gesund: `docker compose logs app` |
| Kein Zertifikat | DNS zeigt nicht auf den Server oder Port 80/443 blockiert: `dig +short agent.chiemgaufilms.com` |
| 503 `daily_budget` | Tageslimit für DataForSEO erreicht (`DATAFORSEO_DAILY_LIMIT_USD`) |
| Admin zeigt 404 | `ADMIN_PASSWORD` ist leer: Admin ist dann bewusst abgeschaltet |
