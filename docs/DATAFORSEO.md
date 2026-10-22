# DataForSEO – Anbindung, Kosten, Grenzen

Stand der geprüften Dokumentation: **2026-10-20** (docs.dataforseo.com/v3, dataforseo.com/pricing).
Preise und Parameter vor jeder Änderung an Limits erneut prüfen.

## Grundlagen

| Thema | Umsetzung |
|---|---|
| Auth | HTTP Basic mit **API-Login + API-Passwort** (Dashboard → API Access), nicht dem Konto-Passwort |
| Body | JSON-Array mit **genau einem** Task (Live-Endpunkte erlauben nur 1 Task pro Call) |
| Fehlerprüfung | Top-Level `status_code` **und** `tasks[0].status_code` müssen `20000` sein |
| Kosten | `cost` aus der Antwort wird pro Request in SQLite gespeichert (auch bei Fehlern) |
| Retries | **keine** – jeder Retry könnte doppelt kosten |
| Timeout | `DATAFORSEO_TIMEOUT_MS` (Default 45 s), danach Abbruch, kein Retry |
| Sandbox | `https://sandbox.dataforseo.com` – kostenlos, Dummy-Daten mit identischer Struktur, gleiche Rate-Limits |
| Live | `https://api.dataforseo.com` |

Umschalten über `DATAFORSEO_MODE=sandbox|live`. Jede Antwort enthält `data_source: "sandbox" | "live"`,
damit Dummy-Daten nie als echte Daten durchgehen.

## Die sechs Endpunkte (geprüft)

| Service | DataForSEO-Pfad | Listenpreis Live | Unsere Kappung |
|---|---|---|---|
| keyword-metrics | `/v3/keywords_data/google_ads/search_volume/live` | $0.09 / Task (unabhängig von Keyword-Anzahl) | 1000 Keywords (DataForSEO-Maximum pro Task) |
| keyword-ideas | `/v3/dataforseo_labs/google/keyword_suggestions/live` | $0.012 / Task + $0.00012 / Item | ein Startbegriff, `limit: 25` |
| google-serp | `/v3/serp/google/organic/live/advanced` | $0.002 / SERP-Seite (10 Ergebnisse), x5 bei Operatoren wie `site:` | `depth: 10`, Operatoren werden abgelehnt (Phase 3) |
| competitors | `/v3/dataforseo_labs/google/competitors_domain/live` | $0.012 / Task + $0.00012 / Item | `limit: 10` |
| search-intent | `/v3/dataforseo_labs/google/search_intent/live` | $0.012 / Task + $0.00012 / Keyword | 10 Keywords |
| ranked-keywords | `/v3/dataforseo_labs/google/ranked_keywords/live` | $0.012 / Task + $0.00012 / Zeile (Allgemeintarif, nicht pro Endpoint gelistet; mit `tasks[0].cost` bestätigen) | 25 Zeilen |
| keyword-difficulty | `/v3/dataforseo_labs/google/bulk_keyword_difficulty/live` | wie oben, pro Keyword | 100 Keywords |
| domain-overview | `/v3/dataforseo_labs/google/domain_rank_overview/live` | wie oben, 1 Zeile | 1 Domain |
| keyword-gap | `/v3/dataforseo_labs/google/domain_intersection/live` | wie oben, pro Zeile (ohne Clickstream, sonst doppelt) | 25 Zeilen |
| google-trends | `/v3/keywords_data/google_trends/explore/live` | $0.011 / Task | 5 Keywords |
| local-business | `/v3/serp/google/maps/live/advanced` | $0.002 je 100 Ergebnisse (Tiefe wird aufgerundet) | Tiefe 20 |
| bing-serp | `/v3/serp/bing/organic/live/advanced` | $0.002 je 10 Ergebnisse | Tiefe 10 |
| page-audit | `/v3/on_page/instant_pages` | $0.00015 / Seite; Zusätze (JS, Ressourcen, Browser) werden nie angefordert | 1 URL |
| domain-technologies | `/v3/domain_analytics/technologies/domain_technologies/live` | $0.012 / Task | 1 Domain |

Preise der fünf letzten Zeilen laut Preisseiten am 2026-10-22 gelesen, noch nicht gegen echte `tasks[0].cost` bestätigt.
| ai-keyword-demand | `/v3/ai_optimization/ai_keyword_data/keywords_search_volume/live` | $0.01 / Task + $0.0001 / Keyword | 10 Keywords |

Implementiert in Phase 1: **keyword-metrics**. Die übrigen fünf folgen in Phase 3 über denselben Adapter.

## Preise (unter ConnSkill, über eigenen Kosten)

Feste Preise pro Call in `src/config/services.ts`, jeweils knapp **unter** dem vergleichbaren ConnSkill-Endpoint
(agent.connskill.com `/.well-known/x402`, geprüft 2026-10-20) und **über** Worst-Case-Einkauf + Facilitator-Fee.
Beides wird von Tests geprüft; im Live-Modus deaktiviert der Server beim Start jeden Service, dessen Preis die Kosten nicht deckt.

Facilitator (CDP, Mainnet): erste 1.000 Settlements/Monat frei, danach **$0.001** pro erfolgreichem Settlement, Gas inklusive.

| Service | Worst Case DataForSEO | Unser Preis USDC | ConnSkill | Marge/Call (nach $0.001) |
|---|---|---|---|---|
| keyword-metrics (Google Ads Live, bis 1000 Keywords) | $0.0900 | **0.12** | 0.15 (bis 1000 Keywords) | $0.029 |
| keyword-ideas (25 Ideen) | $0.0150 | **0.025** | 0.03 | $0.009 |
| google-serp (Top 10) | $0.0020 | **0.025** | 0.03 (Top 20) | $0.022 |
| competitors (10 Domains) | $0.0132 | **0.04** | 0.05 | $0.026 |
| search-intent (10 Keywords) | $0.0132 | **0.04** | – (keyword-difficulty 0.05) | $0.026 |
| ai-keyword-demand (10 Keywords) | $0.0110 | **0.04** | 0.05 | $0.028 |

Labs-Kosten fallen pro **zurückgeliefertem** Item an; bei weniger Treffern ist der reale Einkauf niedriger als der Worst Case.

## Land/Sprache und Eingaben – Prüfung vor der Zahlung

- `src/config/locales.json` enthält die von DataForSEO unterstützten Kombinationen (Stand 2026-10-21, erzeugt mit
  `npx tsx --env-file=.env scripts/update-locales.ts`; die verwendeten Referenz-Endpunkte sind kostenlos, Kosten 0).
- **Nur Länder-Codes** (94 Länder aus der Labs-Liste), keine Städte/Regionen. Grund: Die Sandbox liefert für Google Ads und SERP
  nur eine auf Großbritannien gekürzte Ortsliste; Städte ließen sich daher nicht prüfen.
- Labs (Keyword Ideas, Competitors) und AI Keyword Demand: exakte Länder/Sprache-Paare (z. B. Deutschland nur `de`, Schweiz `de/fr/it`).
  Bei falscher Sprache nennt die Fehlermeldung die verfügbaren Sprachen. Google Ads und SERP: Land + Sprache jeweils gegen ihre Liste.
- Ohne `language_code` wird `en` gewählt, wenn für das Land verfügbar, sonst die erste verfügbare Sprache (Deutschland → `de`).
- Search Intent nimmt nur Keywords (laut aktueller Doku keine Land-/Sprachparameter); die Sprachabdeckung bestimmt DataForSEO.
- SERP: keine Suchoperatoren (`site:`, `intitle:`, Anführungszeichen, `-wort`), weil DataForSEO sie 5-fach berechnet.
- Competitors: Eingabe darf eine URL sein (Schema, `www.`, Pfad werden entfernt); IPs, Ports und Hosts ohne TLD werden abgelehnt.
- Alle Eingaben sind strikt: unbekannte Felder werden abgelehnt, Keywords werden getrimmt, kleingeschrieben und dedupliziert.

### Rate-Limits

- Allgemein 2000 Calls/min, Labs/AI Optimization max. 30 gleichzeitige Requests.
- **Google Ads Live: 12 Requests/min pro Konto.** Wir erlauben uns 10/min (`upstreamPerMinute`). Ist das Kontingent
  der laufenden Minute erschöpft, antwortet der Server **vor** der Zahlung mit `503 upstream_busy`.

### Relevante Fehlercodes

| Code | Bedeutung | Unser Verhalten |
|---|---|---|
| 20000 | OK | Ergebnis ausliefern |
| 40100 | nicht autorisiert | 502 `upstream_error` (Konfiguration prüfen) |
| 40102 | keine Ergebnisse | 404 `no_results` |
| 40200 / 40210 | Zahlung nötig / Guthaben zu niedrig | 502 `upstream_error` – **Guthaben aufladen** |
| 40202 / 40209 | Rate-Limit / zu viele parallele Requests | 502 `upstream_error` |
| 40203 | Kostenlimit überschritten | 502 `upstream_error` |
| 40501 / 40503 / 40506 | ungültiges / unbekanntes Feld | 422 `unsupported_parameters` |
| 50000 / 50301 | interner Fehler / Drittanbieter nicht erreichbar | 502 `upstream_error` |

Upstream-Fehlermeldungen werden nicht an Käufer weitergereicht (nur der Code wird intern geloggt).

## Kostenschutz (implementiert)

Reihenfolge pro Request, bevor überhaupt eine Zahlung angenommen wird:
1. Zod-Validierung (strikt, unbekannte Felder werden abgelehnt, Keywords normalisiert und dedupliziert).
2. Worst-Case-Kostenschätzung aus der Preisliste ≤ `maxUpstreamCostUsd` des Service.
3. Tagesbudget (`DATAFORSEO_DAILY_LIMIT_USD`, Default 5) und Monatsbudget – inkl. Reservierungen laufender Requests.
4. Upstream-Rate pro Endpoint.
5. Cache-Treffer (identische, normalisierte Eingabe) kosten nichts upstream.
6. Gleichzeitige identische Requests werden zu **einem** Upstream-Call zusammengefasst.

Gezählt wird nur Live-Verbrauch; Sandbox-Calls zählen nicht gegen das Budget.

## Zugangsdaten einrichten

1. Konto bei https://app.dataforseo.com/register anlegen (manuell, durch dich).
2. Unter **API Access** Login und API-Passwort kopieren.
3. In `.env` eintragen: `DATAFORSEO_LOGIN=…`, `DATAFORSEO_PASSWORD=…`, `DATAFORSEO_MODE=sandbox`.
4. Sandbox-Test: `npm run dev` und in zweitem Terminal `npm run smoke:sandbox`.
5. Live erst nach Freigabe und Guthaben-Aufladung (Minimum laut Preisseite $50; neue Konten erhalten $1 Testguthaben).
