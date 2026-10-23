import type { ExternalUptime } from "../lib/externalUptime.js";
import type { Status } from "./status.js";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const T = {
  en: {
    title: "Status and trust",
    kicker: "Transparency",
    lead: "How we handle your payment, your data and failures, and how reliably the service runs.",
    uptime: "Uptime",
    h24: "Last 24 hours",
    d7: "Last 7 days",
    d30: "Last 30 days",
    since: "Measured since",
    nodata: "no data yet",
    days: "Daily uptime, last 30 days",
    services: "Services",
    svc: "Service",
    state: "State",
    success: "Paid calls delivered (30 days)",
    on: "available",
    off: "disabled",
    promises: "What we promise",
    p: [
      ["Pay before delivery, priced up front", "Every call states its price in the HTTP 402 answer before you pay. Invalid inputs are refused before any price is quoted. One payment triggers exactly one data call (packages: their fixed set of calls)."],
      ["Never charged twice", "Re-sending the same payment returns the stored result. Payments are settled on-chain and can be checked on Basescan."],
      ["If delivery fails", "Paid results are stored. You can fetch them again with your result token, and a failed paid call gets one free retry. Contact us if anything stays unclear."],
      ["Data and privacy", "Server in Germany (Hetzner, Falkenstein). No IP addresses are stored. Inputs and results are deleted after 30 days. Data source: DataForSEO. Payments are settled through Coinbase's x402 facilitator."],
      ["Who runs it", "Burcleon Europe Limited, Zweigniederlassung Engelsberg (Chiemgau Films), Germany. See the imprint."],
    ],
    method: "How this is measured",
    contact: "Contact",
    json: "Machine-readable",
    external: "Independent monitoring by UptimeRobot (checks every 5 minutes from outside)",
    extTitle: "Independent check (UptimeRobot)",
    extNow: "Right now",
    extStates: { up: "reachable", down: "not reachable", paused: "paused", unknown: "unknown" },
  },
  de: {
    title: "Status und Vertrauen",
    kicker: "Transparenz",
    lead: "Wie wir mit Zahlung, Daten und Fehlern umgehen und wie zuverlässig der Dienst läuft.",
    uptime: "Verfügbarkeit",
    h24: "Letzte 24 Stunden",
    d7: "Letzte 7 Tage",
    d30: "Letzte 30 Tage",
    since: "Gemessen seit",
    nodata: "noch keine Daten",
    days: "Verfügbarkeit pro Tag, letzte 30 Tage",
    services: "Dienste",
    svc: "Dienst",
    state: "Zustand",
    success: "Bezahlte Abrufe geliefert (30 Tage)",
    on: "verfügbar",
    off: "abgeschaltet",
    promises: "Was wir zusagen",
    p: [
      ["Erst Preis, dann Zahlung, dann Leistung", "Jeder Abruf nennt seinen Preis in der HTTP-402-Antwort, bevor Sie zahlen. Ungültige Eingaben werden abgelehnt, bevor ein Preis genannt wird. Eine Zahlung löst genau einen Datenabruf aus (Pakete: ihre feste Zahl von Abrufen)."],
      ["Nie doppelt bezahlt", "Wird dieselbe Zahlung erneut gesendet, kommt das gespeicherte Ergebnis zurück. Zahlungen sind on-chain abgewickelt und auf Basescan nachprüfbar."],
      ["Wenn etwas schiefgeht", "Bezahlte Ergebnisse werden gespeichert und sind mit dem Ergebnis-Token erneut abrufbar. Ein fehlgeschlagener bezahlter Abruf bekommt eine kostenlose Wiederholung. Bei Unklarheiten schreiben Sie uns."],
      ["Daten und Datenschutz", "Server in Deutschland (Hetzner, Falkenstein). Keine Speicherung von IP-Adressen. Eingaben und Ergebnisse werden nach 30 Tagen gelöscht. Datenquelle: DataForSEO. Zahlungen laufen über den x402-Abwickler von Coinbase."],
      ["Wer dahintersteht", "Burcleon Europe Limited, Zweigniederlassung Engelsberg (Chiemgau Films), Deutschland. Siehe Impressum."],
    ],
    method: "So wird gemessen",
    contact: "Kontakt",
    json: "Maschinenlesbar",
    external: "Unabhängige Messung durch UptimeRobot (prüft alle 5 Minuten von außen)",
    extTitle: "Unabhängige Prüfung (UptimeRobot)",
    extNow: "Gerade jetzt",
    extStates: { up: "erreichbar", down: "nicht erreichbar", paused: "pausiert", unknown: "unbekannt" },
  },
};

export function renderStatusPage(st: Status, lang: "en" | "de", values: { NAME: string; BASE_URL: string; CONTACT_EMAIL: string; PAY_TO_ADDRESS: string; EXTERNAL_STATUS_URL?: string }, ext: ExternalUptime | null = null): string {
  const t = T[lang];
  const pct = (v: number | null) => (v === null ? t.nodata : `${v.toFixed(2)} %`);
  const bars = st.days
    .map((d, i) => {
      const v = d.uptime_pct;
      const cls = v === null ? "none" : v >= 99.5 ? "ok" : v >= 95 ? "warn" : "err";
      return `<rect class="u ${cls}" x="${i * 10}" y="0" width="8" height="28"><title>${esc(d.day)}: ${esc(pct(v))}</title></rect>`;
    })
    .join("");
  const other = lang === "en" ? { href: "/de/status", label: "DE" } : { href: "/status", label: "EN" };
  const home = lang === "en" ? "/" : "/de/";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t.title)} – ${values.NAME}</title>
<link rel="canonical" href="${values.BASE_URL}${lang === "en" ? "/status" : "/de/status"}">
<link rel="alternate" hreflang="en" href="${values.BASE_URL}/status">
<link rel="alternate" hreflang="de" href="${values.BASE_URL}/de/status">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="color-scheme" content="dark">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header class="top"><div class="wrap bar"><a class="brand" href="${home}"><img src="/logo-white.png" alt="Chiemgau Films" width="62" height="30"><span class="brandname">${values.NAME}</span></a><div class="navgroup"><nav aria-label="Main"><a href="${home}#services">${lang === "en" ? "Services" : "Dienste"}</a><a href="${home}#docs">${lang === "en" ? "Docs" : "Entwickler"}</a><a href="#uptime" aria-current="page">Status</a></nav><a class="lang" href="${other.href}" hreflang="${other.label.toLowerCase()}">${other.label}</a></div></div></header>
<main>
<section class="hero wrap">
  <p class="eyebrow">${esc(t.kicker)}</p>
  <h1>${esc(t.title)}</h1>
  <p class="lead">${esc(t.lead)}</p>
</section>
<section id="uptime" class="wrap">
  <h2>${esc(t.uptime)}</h2>
  <div class="grid">
    <article class="card"><span class="price">${esc(t.h24)}</span><h3>${esc(pct(st.uptime_pct.last_24h))}</h3></article>
    <article class="card"><span class="price">${esc(t.d7)}</span><h3>${esc(pct(st.uptime_pct.last_7d))}</h3></article>
    <article class="card"><span class="price">${esc(t.d30)}</span><h3>${esc(pct(st.uptime_pct.last_30d))}</h3></article>
  </div>
  <h3>${esc(t.days)}</h3>
  <svg class="uptime" viewBox="0 0 300 28" preserveAspectRatio="none" role="img" aria-label="${esc(t.days)}">${bars}</svg>
  <p class="fine">${esc(t.since)}: ${esc(st.monitoring_since ?? t.nodata)} · ${esc(t.json)}: <a href="/status.json">/status.json</a> · <a href="/health">/health</a></p>
  ${
    ext
      ? `<h3>${esc(t.extTitle)}</h3>
  <div class="grid">
    <article class="card"><span class="price">${esc(t.extNow)}</span><h3><span class="status"><span class="dot ${ext.status === "up" ? "ok" : ext.status === "down" ? "err" : "warn"}"></span>${esc(t.extStates[ext.status])}</span></h3></article>
    <article class="card"><span class="price">${esc(t.h24)}</span><h3>${esc(pct(ext.uptime_pct.last_24h))}</h3></article>
    <article class="card"><span class="price">${esc(t.d7)}</span><h3>${esc(pct(ext.uptime_pct.last_7d))}</h3></article>
    <article class="card"><span class="price">${esc(t.d30)}</span><h3>${esc(pct(ext.uptime_pct.last_30d))}</h3></article>
  </div>`
      : ""
  }
  ${values.EXTERNAL_STATUS_URL ? `<p><a class="btn" href="${esc(values.EXTERNAL_STATUS_URL)}" rel="noopener" target="_blank">${esc(t.external)}</a></p>` : ""}
</section>
<section class="wrap">
  <h2>${esc(t.services)}</h2>
  <div class="tablewrap"><table><thead><tr><th>${esc(t.svc)}</th><th>${esc(t.state)}</th><th>${esc(t.success)}</th></tr></thead><tbody>
  ${st.services.map((s) => `<tr><td>${esc(s.name)}</td><td><span class="status"><span class="dot ${s.enabled ? "ok" : "err"}"></span>${esc(s.enabled ? t.on : t.off)}</span></td><td>${esc(s.paid_delivery_success_pct_30d === null ? t.nodata : `${s.paid_delivery_success_pct_30d} %`)}</td></tr>`).join("\n  ")}
  </tbody></table></div>
</section>
<section class="wrap">
  <h2>${esc(t.promises)}</h2>
  <ol class="steps">
    ${t.p.map(([h, p]) => `<li><strong>${esc(h)}</strong> ${esc(p)}</li>`).join("\n    ")}
  </ol>
  <p class="fine"><a href="https://basescan.org/address/${values.PAY_TO_ADDRESS}" rel="noopener">Basescan</a> · <a href="/legal.html#impressum">Impressum</a> · <a href="/legal.html#datenschutz">Datenschutz / Privacy</a> · ${esc(t.contact)}: <a href="mailto:${values.CONTACT_EMAIL}">${values.CONTACT_EMAIL}</a></p>
  <h3>${esc(t.method)}</h3>
  <p class="fine">${esc(st.method)}</p>
</section>
</main>
<footer><div class="wrap foot"><div><strong>${values.NAME}</strong></div><div class="fine"><a href="/legal.html#impressum">Impressum</a> · <a href="/legal.html#datenschutz">Datenschutz / Privacy</a> · <a href="/legal.html#terms">Terms of use</a></div></div></footer>
</body>
</html>`;
}
