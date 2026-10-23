# Agent Data API (Arbeitstitel)

Pay-per-call SEO-Daten-APIs für KI-Agenten: DataForSEO als Datenquelle, Bezahlung per **x402 v2** in USDC auf Base.
Ein Node.js-Service (Express + TypeScript) hinter Caddy, SQLite für Request-Ledger, kein LLM, keine GPU.

## Projektstatus

| Phase | Inhalt | Status |
|---|---|---|
| 1 | Grundgerüst, DataForSEO-Client, Keyword-Metrics mit Sandbox | ✅ fertig, Sandbox-Abnahme erfolgreich (2026-10-20) |
| 2 | x402 Testnet-Zahlung, Settlement, E2E-Test | ✅ fertig, echte Base-Sepolia-Zahlung erfolgreich (2026-10-20) |
| 3 | Restliche fünf Endpunkte | ✅ fertig, alle sechs per echter Base-Sepolia-Zahlung bestätigt (2026-10-21) |
| 4 | MCP, OpenAPI, Discovery, Landingpage | ✅ fertig, MCP-Zahlung auf Base Sepolia für alle sechs Tools bestätigt (2026-10-21) |
| 5 | Admin, Docker/Caddy, Sicherheitsprüfung, Mainnet-Vorbereitung, Marktplätze | ✅ Server mit HTTPS läuft im Testbetrieb (Testnet + Sandbox); Mainnet wartet auf deine Freigabe |

## Schnellstart (Mac)

```bash
brew install node@24
echo 'export PATH="/opt/homebrew/opt/node@24/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
npm install
cp .env.example .env && chmod 600 .env   # DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD eintragen
npm test
npm run dev                               # http://localhost:3000
npm run smoke:sandbox                     # zweites Terminal
```

## API

| Methode | Pfad | Preis (USDC) | Inhalt |
|---|---|---|---|
| GET | `/health` | frei | Status |
| GET | `/api/v1/services` | frei | Katalog mit Preisen, Limits, Beispiel-Requests |
| POST | `/api/v1/preflight/:serviceId` | frei | Validierung + Kosten-/Budgetprüfung, kein DataForSEO-Call |
| POST | `/api/v1/keyword-metrics` | 0.12 | Suchvolumen, CPC, Wettbewerb, 12 Monate; bis 1000 Keywords |
| POST | `/api/v1/keyword-ideas` | 0.025 | bis 25 Wortvarianten zu einem Startbegriff (Keyword Suggestions) |
| POST | `/api/v1/google-serp` | 0.025 | Top-10 organische Treffer |
| POST | `/api/v1/competitors` | 0.04 | bis 10 Wettbewerber-Domains mit Überschneidung und Kennzahlen |
| POST | `/api/v1/search-intent` | 0.04 | Suchintention + Wahrscheinlichkeit, bis 10 Keywords |
| POST | `/api/v1/ranked-keywords` | 0.04 | Top 25 Keywords, für die eine Domain rankt |
| POST | `/api/v1/keyword-difficulty` | 0.04 | Keyword-Difficulty 0–100, bis 100 Keywords |
| POST | `/api/v1/domain-overview` | 0.04 | Traffic, Keyword-Anzahl und Ranking-Verteilung einer Domain |
| POST | `/api/v1/keyword-gap` | 0.045 | Keywords, für die ein Konkurrent rankt und du nicht (Top 25) |
| POST | `/api/v1/google-trends` | 0.025 | Google-Trends-Verlauf, bis 5 Keywords, 12 Monate |
| POST | `/api/v1/local-business` | 0.03 | Google-Maps-Firmen (20) zu einer Suche: Adresse, Telefon, Bewertung |
| POST | `/api/v1/bing-serp` | 0.02 | Top 10 organische Bing-Ergebnisse |
| POST | `/api/v1/page-audit` | 0.02 | Technischer SEO-Schnellcheck einer Seite (ohne JavaScript) |
| POST | `/api/v1/domain-technologies` | 0.03 | Technologien einer Website (CMS, Analytics, Server …) |
| POST | `/api/v1/keywords-for-site` | 0.04 | Relevante Keywords einer Website (25) |
| POST | `/api/v1/traffic-estimate` | 0.04 | Geschätzter Traffic für bis zu 10 Domains |
| POST | `/api/v1/news-search` | 0.02 | Google-News-Ergebnisse (10) |
| POST | `/api/v1/image-search` | 0.02 | Google-Bilder-Ergebnisse (20) |
| POST | `/api/v1/local-market-check` | 0.1 | **Paket**: Google-Treffer + Maps-Betriebe + Wettbewerber-Domains + Beobachtungen für eine lokale Suche (2 Datenabrufe, keine Gratis-Probe) |
| POST | `/api/v1/wishlist` | gratis | Wunsch für ein neues Werkzeug (nur schreibend) |
| POST | `/api/v1/free-sample/{service-id}` | gratis | 1 Probe pro Dienst und Tag (Dienste bis 0,05 USDC, keine Pakete) |

Weitere Seiten: `/de/` (deutsche Startseite), `/status` und `/de/status` (Verfügbarkeit, Zusagen), `/status.json`, `/.well-known/agent.json`, `/.well-known/mcp/server-card.json`.
| POST | `/api/v1/ai-keyword-demand` | 0.04 | **geschätzte** AI-Search-Nachfrage, bis 10 Keywords |
| POST | `/mcp` | frei/bezahlt | MCP (Streamable HTTP): 4 kostenlose + 6 Bezahl-Tools (x402-fähiger Client nötig) |
| GET | `/openapi.json` | frei | OpenAPI 3.1 inkl. x402-Preisangaben |
| GET | `/`, `/llms.txt`, `/legal.html`, `/.well-known/x402` | frei | Website, Kurzbeschreibung für LLMs, Impressum-Platzhalter, Kompatibilitätsdatei |
| GET | `/api/v1/results/:requestId` | frei | Ergebnis/Status mit `Authorization: Bearer <result_token>` |
| POST | `/api/v1/results/:requestId/retry` | frei | ein kostenloser Wiederholungsversuch nach Upstream-Fehler (bezahlte Anfragen) |

`location_code` = Länder-Code von DataForSEO (Standard 2840 = USA; 2276 Deutschland; 2826 Großbritannien),
`language_code` z. B. `en`/`de` (Standard je nach Land). Nicht unterstützte Kombinationen werden **vor** der Zahlung mit 422 abgelehnt.
Bezahlt wird per x402 (USDC); ohne `PAYMENT-SIGNATURE` antwortet jede Service-Route mit HTTP 402 und dem Preis.

Beispiel:

```bash
curl -s -X POST http://localhost:3000/api/v1/keyword-metrics \
  -H 'content-type: application/json' \
  -d '{"keywords":["seo tools","keyword research"],"location_code":2276,"language_code":"de"}'
```

Antwort (Struktur):

```json
{
  "request_id": "…uuid…",
  "service": "keyword-metrics",
  "data_source": "sandbox",
  "cached": false,
  "result": { "location_code": 2276, "language_code": "de",
    "keywords": [{ "keyword": "seo tools", "search_volume": 0, "competition": "…", "competition_index": 0,
                   "cpc": 0, "low_top_of_page_bid": 0, "high_top_of_page_bid": 0,
                   "monthly_searches": [{ "year": 2026, "month": 9, "search_volume": 0 }] }] },
  "result_token": "…"
}
```

`data_source: "sandbox"` kennzeichnet Dummy-Daten der DataForSEO-Sandbox.

## Struktur

```
src/
  config/env.ts        Umgebungsvariablen (Zod) inkl. Sicherheits-Kombinationsregeln
  config/services.ts   zentrale Preise, Limits, Kostendeckel, Cache-TTL, an/aus
  dataforseo/client.ts DataForSEO-Client (Sandbox/Live, kein Retry, Timeout, Kosten)
  services/            ein Adapter pro Service + Pipeline (prepare → [Zahlung] → execute)
  lib/                 Cache, Kostenschutz, SQLite-Store, Rate-Limit, Logger mit Redaction
test/                  Vitest (Fixtures sind als Testdaten markiert)
docs/                  DATAFORSEO.md, PAYMENTS.md, AGENTS.md, DISCOVERY.md, TESTING.md (weitere folgen in Phase 5)
public/                Website (Vorlagen mit {{Platzhaltern}}), llms.txt, Impressum-Platzhalter
src/mcp/, src/discovery/, src/web/   MCP-Server, OpenAPI-Erzeugung, Website-Auslieferung
```

## Service hinzufügen

1. Eintrag in `src/config/services.ts` (Preis, Limits, Endpoint, Kostendeckel, TTL).
2. Adapter `src/services/<name>.ts` nach Vorbild `keywordMetrics.ts` (Zod-Schema, `estimateCostUsd`, `buildRequest`, `mapResult`).
3. In `src/services/index.ts` registrieren, Fixture + Tests ergänzen.

## Betrieb und Deployment

```bash
./scripts/deploy.sh          # Mac -> Server: hochladen, bauen, starten, HTTPS-Check
```

- Server, Befehle, Update und Fehlersuche: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- Tägliche Kontrolle (`/admin`), Erstattung, Backups, Notfälle: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- Mainnet-Umstieg: Checkliste in [docs/PAYMENTS.md](docs/PAYMENTS.md)
- Eintrag in Verzeichnisse (alles manuelle Schritte): [docs/MARKETPLACES.md](docs/MARKETPLACES.md)
- Sicherheit, Prüfung, Restrisiken: [docs/SECURITY.md](docs/SECURITY.md)
- Rechtlicher Abgleich (Datenschutz, Nutzungsbedingungen, offene Punkte): [docs/LEGAL-CHECK.md](docs/LEGAL-CHECK.md)

## Lizenz
MIT, siehe [LICENSE](LICENSE). Die Datenlizenz von DataForSEO und die Nutzungsbedingungen des Dienstes (`public/legal.html`) bleiben davon unberührt.
