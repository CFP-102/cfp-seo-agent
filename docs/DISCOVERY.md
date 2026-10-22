# Auffindbarkeit (Discovery)

Stand der Recherche: **2026-10-21**. Quellen stehen jeweils dabei. Was wir tatsächlich ausliefern, ist im Abschnitt „Umgesetzt“ festgehalten.

## Umgesetzt

| Datei / Funktion | Zweck | Status |
|---|---|---|
| `GET /openapi.json` (OpenAPI 3.1) | **Hauptweg** für x402scan: Preise in `x-payment-info`, `402`-Antwort, Request-Schemas, Beispiele, `info.contact`, `x-guidance` | gegen das offizielle OAS-3.1-Schema getestet |
| `extensions.bazaar` in jeder 402-Antwort | Coinbase Bazaar: Beispiel-Eingabe, Eingabe-Schema, Beispiel-Ausgabe | getestet (REST **und** MCP-Tools) |
| `POST /mcp` (Streamable HTTP) | MCP-Server, 4 kostenlose + 6 Bezahl-Tools | mit echtem MCP-Client und echtem `@x402/mcp`-Client getestet |
| `GET /llms.txt` | Kurzbeschreibung für Sprachmodelle: Links, Preise, Ablauf | getestet |
| `GET /.well-known/x402` | **nur Kompatibilitätsdatei** (`{version:1, resources:[…]}`) | vorhanden, aber nicht entscheidend (siehe unten) |
| `/robots.txt`, Landingpage, `/legal.html` | Website | getestet |

Nicht umgesetzt: `/.well-known/agent-card.json` (A2A). Siehe „A2A“.

## x402scan (Merit Systems)

- Liest **nur `/openapi.json`**. Das eigene Entdeckungspaket (`@agentcash/discovery` 1.7.5) parst `/.well-known/x402` laut Spezifikation **nicht mehr**;
  die Doku im Repository (`docs/DISCOVERY.md`) nennt die Datei noch als „Compatibility“, ist aber veraltet. (Quellen: github.com/Merit-Systems/x402scan,
  npm `@agentcash/discovery`.) *Selbst gegen x402scan.com getestet: nein.*
- Pflicht für die Aufnahme: mindestens eine bezahlte Ressource, die eine **Live-Probe** besteht (402 mit lesbarem x402-v2-Challenge, nicht leere `accepts`, Eingabe-Schema).
  Die Beträge in der 402-Antwort müssen in Atom-Einheiten stehen (0.12 USDC = `"120000"`) – das liefert das SDK.
  **Die Probe kommt ohne gültigen Body.** Deshalb beantwortet unser Server eine *leere* Anfrage ohne Zahlung mit 402; nicht leere, aber fehlerhafte Anfragen bekommen weiter sofort 400.
  Eine Zahlung zu einer ungültigen Anfrage wird nie abgewickelt.
- Freie Endpunkte (`security: []`) werden nur zusammen mit mindestens einem bezahlten Endpunkt gelistet.
- Eigentumsnachweis (optional, nur für „verified“): Die **Herkunfts-URL** (z. B. `https://agent.chiemgaufilms.com`) wird mit dem Schlüssel der `PAY_TO`-Wallet signiert
  (EIP-191 `personal_sign`). Die Signatur kommt in `OWNERSHIP_PROOFS` (`.env`) und erscheint dann als `x-discovery.ownershipProofs` in OpenAPI.
  Der Server hält keinen privaten Schlüssel, die Signatur erzeugst du manuell mit deiner Wallet. Anleitung in `docs/MARKETPLACES.md` (Phase 5).
- Selbsttest nach dem Deployment: `npx -y @agentcash/discovery agent.chiemgaufilms.com -v`
- Registrierung: Weboberfläche „Add Server“ (x402scan.com/resources/register) mit der Origin-URL. *Manueller Schritt.*

## Coinbase Bazaar

- **Keine Registrierung.** Ein Endpunkt wird nach einer **erfolgreich abgewickelten Zahlung über den CDP-Facilitator** indexiert (laut Doku bis ca. 15 Minuten danach).
  Quellen: docs.cdp.coinbase.com/x402/seller/get-discovered, docs.x402.org/extensions/bazaar.
- Voraussetzung: `extensions.bazaar` in der Route (umgesetzt) und der Facilitator muss Bazaar unterstützen. Der öffentliche Test-Facilitator `x402.org` tut das **nicht**
  (`/discovery/resources` lieferte 404). Bazaar-Listing ist deshalb erst mit **Mainnet + CDP-Facilitator** möglich (Phase 5).
- Optionaler kostenloser Test: `POST https://api.cdp.coinbase.com/platform/v2/x402/validate` mit `{"resource":"<url>","method":"POST"}`.
- Kuratierung/Hervorhebung verlangt laut Doku echte Mainnet-Zahlungen, hohe Verfügbarkeit und vollständige Metadaten.

## 402index.io

- Registrierung per `POST https://402index.io/api/v1/register` mit `url`, `name`, `protocol: "x402"`; Eintrag wird geprüft (pending). Limit: 10 Anfragen pro Stunde und IP.
- Domain-Nachweis über eine Datei `/.well-known/402index-verify.txt` (Token von `POST /api/v1/claim`). *Manueller Schritt, Phase 5.*

## `/.well-known/x402` – warum nur als Zusatz

Im x402-Repository gibt es **keine** Spezifikation dafür. Es kursieren zwei unterschiedliche Formate:
1. x402scan-Kompatibilitätsformat `{ "version": 1, "resources": ["https://…"] }` (das liefern wir aus), aber vom aktuellen Crawler nicht mehr gelesen.
2. Ein individueller IETF-Entwurf (`draft-hawkins-x402-dns-discovery-03`) mit anderer Struktur (`x402Version`, `kind`, `resources` als Objekte). Nicht autoritativ; **nicht** umgesetzt.

## A2A (`/.well-known/agent-card.json`)

Bewusst **nicht** veröffentlicht: Es gibt keinen echten A2A-Endpunkt, und eine Agent-Card würde einen Dienst vortäuschen.
Keines der Verzeichnisse (x402scan, Bazaar, 402index) nutzt sie. Vorbereitung für später: A2A-JSON-RPC-Endpunkt `message/send`, der die sechs Services
als Skills abbildet, Zahlung über die x402-Erweiterung für A2A; erst dann Agent-Card veröffentlichen.

## ConnSkill als Vorbild

`agent.connskill.com` war während der Recherche nicht erreichbar (Timeouts/Verbindung verweigert), seine Dateien konnten nicht verglichen werden.
