# Preise und Deckungsbeitrag

Stand: 2026-10-22. Werte aus der zentralen Konfiguration in `src/config/services.ts`; hier nur eine abgeleitete Übersicht, keine zweite Preisquelle. Verkaufspreise unverändert.

Alle Angaben pro bezahltem Aufruf: Verkauf in USDC, Einkauf und Gebühren in USD. Kalkulation vereinfacht mit 1 USDC = 1 USD. Maximale konfigurierte Eingabe-/Ergebnismengen, kein Cache-Treffer.

| Dienst | Max. Eingaben | Max. Ergebnisse | Verkauf | Datenkosten bis | Zahlungsgebühr kalkuliert | Deckungsbeitrag | Anteil am Verkauf |
|---|---:|---:|---:|---:|---:|---:|---:|
| Keyword Metrics | 1000 | 1000 | 0.120 | 0.0900 | 0.001 | 0.0290 | 24.2 % |
| Keyword Ideas (Suggestions) | 1 | 25 | 0.025 | 0.0150 | 0.001 | 0.0090 | 36.0 % |
| Google SERP | 1 | 10 | 0.025 | 0.0020 | 0.001 | 0.0220 | 88.0 % |
| Competitor Discovery | 1 | 10 | 0.040 | 0.0132 | 0.001 | 0.0258 | 64.5 % |
| Search Intent | 10 | 10 | 0.040 | 0.0132 | 0.001 | 0.0258 | 64.5 % |
| AI Keyword Demand | 10 | 10 | 0.040 | 0.0110 | 0.001 | 0.0280 | 70.0 % |

Deckungsbeitrag = Verkauf minus Datenanbieter-Kosten minus kalkulierte Zahlungsgebühr. Das ist kein Nettogewinn: Server, sonstige Betriebskosten, Steuern, Wechselkurs-/Auszahlungsgebühren, Erstattungen und Arbeitszeit sind nicht abgezogen. Die steuerliche Einordnung ist nicht Bestandteil dieser Kalkulation. Ein Kauf durch die eigene Testwallet ist kein zusätzlicher Kundenerlös.

Die ersten 1.000 Onchain-Abwicklungen pro Monat sind bei Coinbase CDP kostenlos; danach 0,001 USD pro Transaktion. Wir kalkulieren vorsichtig mit 0,001 USD bei jedem Abruf. Innerhalb der Freimenge ist der Deckungsbeitrag entsprechend um 0,001 USD höher.

Bei 1.000 Keyword-Ideas-Aufrufen: 25 USD Verkauf, bis zu 15 USD Datenkosten und vorsichtig 1 USD Zahlungsgebühren ergeben 9 USD Deckungsbeitrag vor Fixkosten/Steuern. Bei weniger gelieferten Ergebnissen oder Cache-Treffern kann der Datenaufwand niedriger sein. Aus der Aufnahme in Verzeichnisse folgt keine Umsatzgarantie.

Die Datenkosten sind die Listenpreiskalkulation innerhalb unserer Eingabegrenzen. Die technischen Abbruchgrenzen `maxUpstreamCostUsd` sind gesonderte Sicherheitsschwellen und keine Einkaufspreise. Tageslimit DataForSEO 5 USD, Monatslimit laut Konfiguration prüfen.

Am 2026-10-22 anhand offizieller Quellen geprüft:

- [Google Ads Live: 0,09 USD pro Task](https://dataforseo.com/pricing/keywords-data/google-ads)
- [Labs Google: 0,012 USD pro Task plus 0,00012 USD pro Ergebnis bzw. Keyword](https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api)
- [Google Organic SERP Live: 0,002 USD für die erste Ergebnisseite](https://dataforseo.com/pricing/google-serp/google-organic-serp-api)
- [AI Keyword Search Volume: 0,01 USD plus 0,0001 USD pro Keyword](https://dataforseo.com/pricing/ai-optimization/ai-keyword-search-volume)
- [Coinbase-CDP-Gebühren](https://docs.cdp.coinbase.com/x402/seller/facilitator)
