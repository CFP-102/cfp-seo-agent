# CFP SEO Agent (Agent Data API)

[![TDQS](https://tdqs.dev/reports/akhiqdtjjd/badge.svg)](https://tdqs.dev/reports/akhiqdtjjd) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**Pay-per-call data and planning APIs for AI agents.** No account, no API key: an agent pays per call in USDC on Base using the [x402](https://www.x402.org) protocol (v2). 31 services as REST, MCP and OpenAPI: SEO and web data (DataForSEO), open data, and content planning for agencies and video teams.

- Live: https://agent.chiemgaufilms.com (catalog: `/api/v1/services`, OpenAPI: `/openapi.json`, MCP: `/mcp`, agent hints: `/llms.txt`)
- Built with Node.js, TypeScript, Express, SQLite, Docker and Caddy. No LLM, no GPU. B2B only.
- Content services answer in **English or German**: send `"language": "en"` (default `de`).

## How it works

1. Call any service route without payment: you get HTTP `402` with the price and payment details.
2. An x402 client signs a USDC payment (EIP-3009) and repeats the call with the `PAYMENT-SIGNATURE` header.
3. Inputs are validated **before** any price is quoted. Payment is settled **before** the data is fetched, and one paid call triggers at most one upstream call (fixed packages are labelled).
4. You get the result plus a `request_id` and `result_token` to fetch it again for 30 days. A failed upstream call can be retried once for free.

Free (no payment): `list_services`, `preflight`, `find_location`, `wishlist`, `get_result`, `retry_request`, and one **free sample** per service and day for cheap single-call data services (up to 0.05 USDC).

## Services

**Content planning for agencies and video teams** (rule-based, no AI model, nothing is stored or written to a calendar)

| Service | USDC | What you get |
|---|---|---|
| `video-project-plan` | 0.08 | One video job: reel ideas, one shoot day in your time window, call sheet, sun times, post-production to delivery |
| `content-month-plan` | 0.05 | Content month: topics, publish dates, linked production dates, shoot days, .ics |
| `content-plan-shift` | 0.02 | Move one date, linked dates follow |
| `shoot-day-plan` | 0.03 | Up to 12 videos into realistic shoot days with timed schedule and checklist |
| `video-recipes` | 0.01 | 75 video recipes with hook, shot list, questions, equipment (DE/EN) |
| `shoot-location-check` | 0.04 | Package: sun times, DWD weather, Bavarian protected areas for a location and date |

Example job: *"Recruiting reels for a metal workshop in Chieming, shoot on 20 Nov from 08:00 to 17:00, deliver by 23 Dec, 5-10 reel ideas"* is one `video-project-plan` call: ideas fitted to trade and town, a timed shoot day with reserve ideas, a call sheet, sun times, and post-production with feedback rounds, working days and Bavarian holidays.

**SEO, web and open data**

| Service | USDC | What you get |
|---|---|---|
| `keyword-metrics` | 0.12 | Google Ads search volume, CPC, competition, 12-month history, up to 1000 keywords |
| `keyword-ideas` | 0.025 | Up to 25 keyword suggestions for one seed phrase |
| `keyword-difficulty` | 0.04 | Keyword difficulty 0-100, up to 100 keywords |
| `search-intent` | 0.04 | Search intent with probability, up to 10 keywords |
| `ai-keyword-demand` | 0.04 | Modeled AI-search demand, up to 10 keywords |
| `google-trends` | 0.025 | Google Trends over 12 months, up to 5 keywords |
| `google-serp` | 0.025 | Top 10 organic Google results |
| `bing-serp` | 0.02 | Top 10 organic Bing results |
| `news-search` | 0.02 | Top 10 Google News results |
| `image-search` | 0.02 | Up to 20 Google Images results |
| `local-business` | 0.03 | Up to 20 Google Maps businesses for a query |
| `competitors` | 0.04 | Up to 10 organic competitors of a domain |
| `ranked-keywords` | 0.04 | Top 25 keywords a domain ranks for |
| `keywords-for-site` | 0.04 | 25 relevant keywords for a website |
| `keyword-gap` | 0.045 | Keywords a competitor ranks for and you do not |
| `domain-overview` | 0.04 | Keyword count, traffic and ranking distribution of a domain |
| `traffic-estimate` | 0.04 | Estimated traffic for up to 10 domains |
| `domain-technologies` | 0.03 | CMS, analytics and server technologies of a website |
| `page-audit` | 0.02 | Technical SEO quick check of one page |
| `website-content` | 0.02 | Main text, headings and links of one page as JSON |
| `website-changes` | 0.025 | Compare one page with a previous snapshot |
| `website-check` | 0.04 | Package: TLS, status, sitemap and two links of a website |
| `local-market-check` | 0.09 | Package: local Google results + Maps + competitors for one local search |
| `regional-data` | 0.01 | Curated Chiemgau places (Wikidata, CC0) |
| `open-data-search` | 0.01 | Search GovData and open.bydata catalogs |

Prices are set in `src/config/services.ts` only. Location codes: country level for most services, city/region codes in Germany, Austria and Switzerland for the Google SERP family (`GET /api/v1/locations?q=`).

## Quick start

```bash
npm install
cp .env.example .env && chmod 600 .env   # add DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD (or stay in sandbox)
npm test
npm run dev                               # http://localhost:3000
```

```bash
curl -s -X POST http://localhost:3000/api/v1/video-project-plan \
  -H 'content-type: application/json' \
  -d '{"goal":"recruiting","industry":"metal fabrication","town":"Chieming","shoot_date":"2026-11-20","deliver_by":"2026-12-23","reel_count_max":8,"language":"en"}'
# -> HTTP 402 with the price; an x402 client then pays and repeats the call
```

`npm start` runs the MCP server over stdio in sandbox mode (used by directories such as Glama); `npm run start:http` runs the full HTTP server.

## Safety and privacy

Secrets live only in git-ignored env files. No IP addresses are stored, results and inputs are deleted after 30 days, the Caddy log keeps no IP or headers, and website visits are counted anonymously (a number per page group and day). See [docs/SECURITY.md](docs/SECURITY.md) and [public/legal.html](public/legal.html).

## License

MIT, see [LICENSE](LICENSE). Data licenses of DataForSEO and the open data sources, and the service's terms of use, remain unaffected. The full recipe set of the content services is proprietary and not part of this repository (a small sample file is included).

---

# Deutsch

**Pay-per-call-Daten- und Planungs-APIs für KI-Agenten.** Kein Konto, kein API-Schlüssel: Ein Agent bezahlt jeden Aufruf in USDC auf Base per [x402](https://www.x402.org) (v2). 31 Dienste als REST, MCP und OpenAPI: SEO- und Webdaten (DataForSEO), offene Daten und Content-Planung für Agenturen und Videoteams. Die Content-Dienste antworten auf Deutsch (Standard) oder Englisch (`"language": "en"`).

**Ablauf:** Aufruf ohne Zahlung liefert HTTP 402 mit dem Preis. Ein x402-Client zahlt und wiederholt den Aufruf. Eingaben werden vor jeder Preisanfrage geprüft, bezahlt wird vor dem Datenabruf, ein bezahlter Aufruf löst höchstens einen Abruf aus (feste Pakete sind gekennzeichnet). Ergebnisse bleiben 30 Tage abrufbar.

**Beispiel:** „Recruiting-Reels für einen Metallbauer in Chieming, Dreh am 20.11. von 8 bis 17 Uhr, Abgabe 23.12., 5-10 Reel-Ideen“ ist ein Aufruf von `video-project-plan`: Ideen passend zu Branche und Ort, ein Drehtag im Zeitfenster mit Reserve, Rollen-Zeitplan, Sonnenzeiten und Postproduktion bis zur Abgabe (Feedbackrunden, Arbeitstage, Feiertage in Bayern).

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

## Struktur

```
src/
  config/services.ts   zentrale Preise, Limits, Kostendeckel, Cache-TTL, an/aus
  config/env.ts        Umgebungsvariablen (Zod) inkl. Sicherheits-Kombinationsregeln
  dataforseo/client.ts DataForSEO-Client (Sandbox/Live, kein Retry, Timeout, Kosten)
  services/            ein Adapter pro Dienst + Pipeline (prüfen → [Zahlung] → ausführen)
  lib/                 Cache, Kostenschutz, SQLite-Store, Rate-Limit, Logger mit Redaction
  mcp/, discovery/, web/   MCP-Server, OpenAPI-Erzeugung, Website und Statusseite
  admin.ts, adminLive.ts   Betreiberbereich mit Live-Panel (Umsätze, Zugriffe, Feed)
test/                  Vitest (Fixtures sind als Testdaten markiert)
docs/                  Betrieb, Sicherheit, Zahlungen, Rechtliches, Tests
public/                Website (DE/EN), llms.txt, Rechtstexte
```

## Neuen Dienst hinzufügen

1. Eintrag in `src/config/services.ts` (Preis, Limits, Endpoint, Kostendeckel, TTL).
2. Adapter in `src/services/<name>.ts` (Zod-Schema, `estimateCostUsd`, `buildRequest`, `mapResult`), in `src/services/index.ts` registrieren.
3. Fixture und Tests ergänzen (`test/services.test.ts`, `test/payments.test.ts`).

## Betrieb

```bash
./scripts/deploy.sh          # Mac -> Server: hochladen, bauen, starten, HTTPS-Check
```

- Server, Update, Fehlersuche: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · Tägliche Kontrolle, Erstattung, Backups: [docs/OPERATIONS.md](docs/OPERATIONS.md)
- Zahlungen und Mainnet-Checkliste: [docs/PAYMENTS.md](docs/PAYMENTS.md) · Verzeichnisse: [docs/MARKETPLACES.md](docs/MARKETPLACES.md)
- Sicherheit: [docs/SECURITY.md](docs/SECURITY.md) · Rechtlicher Abgleich: [docs/LEGAL-CHECK.md](docs/LEGAL-CHECK.md)
- Content-Planung (Umfang, Preise, Sprachen, Vorlagen): [docs/CONTENT-PLANUNG.md](docs/CONTENT-PLANUNG.md)

## Lizenz

MIT, siehe [LICENSE](LICENSE). Die Datenlizenzen von DataForSEO und der offenen Datenquellen sowie die Nutzungsbedingungen des Dienstes bleiben unberührt. Der vollständige Vorlagensatz der Content-Dienste ist proprietär und nicht Teil des Repositorys (eine kleine Musterdatei liegt bei).
