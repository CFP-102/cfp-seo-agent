// Video project planner page: one concrete job (ideas, one shoot day, call sheet, post-production up to delivery) from a
// form, free preflight, one approved purchase, readable result, calendar file and a printable client report with an
// optional local logo. Payment and shared helpers come from agentur.js and planner.js (window.AgenturPay, window.CfpPlanner).
(function () {
  "use strict";

  var LANG = typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "de";
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var T = {
    de: {
      goals: { recruiting: "Recruiting (Mitarbeiter und Azubis gewinnen)", produkt: "Produkt oder Leistung zeigen", unternehmen: "Unternehmen und Team zeigen" },
      err: {
        date: "Bitte ein gültiges Datum angeben: ", past: "Der Drehtag darf nicht in der Vergangenheit liegen.", deliver: "Die Abgabe muss nach dem Drehtag liegen.", range: "Die Abgabe darf höchstens 180 Tage nach dem Drehtag liegen.",
        time: "Bitte gültige Uhrzeiten angeben; das Zeitfenster muss mindestens 4 Stunden lang sein.", count: "Die Mindestzahl darf nicht größer als die Höchstzahl sein.",
        text: "Unzulässige Zeichen in: ", coords: "Bitte Breiten- und Längengrad gemeinsam und innerhalb Deutschlands angeben (oder beide leer lassen).", ideas: "Zu viele eigene Ideen (höchstens {n}).",
        locations: "Zu viele Bereiche (höchstens {n}).",
      },
      checking: "Prüfe Eingabe kostenlos …", checked: "Eingabe gültig. Bitte Preis, Netzwerk und Empfänger prüfen und den Kauf bestätigen.", bought: "Projektplan bezahlt und geliefert.",
      cancelled: "Abgebrochen. Es wurde nichts bezahlt.", ok: "Plan passt", notes: "Hinweise beachten", notOk: "Plan passt nicht vollständig: Hinweise lesen",
      fits: "Drehtag {s}–{e} Uhr", notFits: "Drehtag braucht bis {e} Uhr (Zeitfenster überschritten)", ready: "fertig zur Abgabe am {d}", buffer: "{n} Arbeitstage Puffer", late: "Abgabe nicht zu halten",
      reel: "Reel", slot: "Zeit", place: "Ort", people: "Personen", minutes: "Min. Aufnahme", shots: "Einstellungen", questions: "Fragen", hook: "Einstieg",
      start: "Start", end: "Ende", step: "Schritt", what: "Was", who: "Wer", times: "Zeiten", owner: "Wer", agency: "Agentur", customer: "Kunde", from: "von", to: "bis",
      sun: "Sonne", sunrise: "Sonnenaufgang", sunset: "Sonnenuntergang", golden: "Goldene Stunde ab", holidays: "Feiertage im Zeitraum",
      reportBasis: "Datengrundlage: regelbasierte Berechnung des Dienstes Video Project Plan. Ideen sind Vorschläge; Dauern sind übliche Werte. Kein Wetter, keine Anfahrt, keine Verfügbarkeit von Personen, keine rechtliche Freigabe.",
      created: "Erstellt am ", reportTitle: "Videoprojekt", file: "videoprojekt", receipt: "kaufbeleg-privat",
      logoLoaded: "Logo übernommen (nur in diesem Browser, nicht hochgeladen).", logoRemoved: "Logo entfernt.",
    },
    en: {
      goals: { recruiting: "Recruiting (win staff and apprentices)", produkt: "Show a product or service", unternehmen: "Show the company and team" },
      err: {
        date: "Please enter a valid date: ", past: "The shoot day must not be in the past.", deliver: "Delivery must be after the shoot day.", range: "Delivery may be at most 180 days after the shoot day.",
        time: "Please enter valid times; the window must be at least 4 hours long.", count: "The minimum must not be larger than the maximum.",
        text: "Characters not allowed in: ", coords: "Please give latitude and longitude together and inside Germany (or leave both empty).", ideas: "Too many own ideas (at most {n}).",
        locations: "Too many areas (at most {n}).",
      },
      checking: "Checking the input for free …", checked: "Input valid. Check price, network and recipient, then approve the purchase.", bought: "Project plan paid and delivered.",
      cancelled: "Cancelled. Nothing was paid.", ok: "Plan fits", notes: "see the notes", notOk: "Plan does not fully fit: read the notes",
      fits: "Shoot day {s}–{e}", notFits: "Shoot day needs until {e} (window exceeded)", ready: "ready for delivery on {d}", buffer: "{n} working days of buffer", late: "delivery date cannot be met",
      reel: "Reel", slot: "Time", place: "Place", people: "People", minutes: "min recording", shots: "Shots", questions: "Questions", hook: "Opening",
      start: "Start", end: "End", step: "Step", what: "What", who: "Who", times: "Times", owner: "Who", agency: "Agency", customer: "Customer", from: "from", to: "to",
      sun: "Sun", sunrise: "Sunrise", sunset: "Sunset", golden: "Golden hour from", holidays: "Holidays in the period",
      reportBasis: "Data basis: rule-based calculation by the Video Project Plan service. Ideas are suggestions; durations are typical values. No weather, travel, people's availability or legal clearance.",
      created: "Created on ", reportTitle: "Video project", file: "video-project", receipt: "purchase-receipt-private",
      logoLoaded: "Logo applied (only in this browser, not uploaded).", logoRemoved: "Logo removed.",
    },
  }[LANG];

  function isDate(s) {
    if (typeof s !== "string" || !DATE_RE.test(s)) return false;
    var d = new Date(s + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function minutes(t) { return Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); }
  function text(v, max, label) {
    var s = String(v || "").trim();
    if (!s) return null;
    if (/[\x00-\x1f\x7f]/.test(s)) throw new Error(T.err.text + label);
    return s.slice(0, max);
  }
  function lines(v) { return String(v || "").split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean); }

  /** Limits and allowed values from the published OpenAPI schema of video-project-plan. */
  function projectInfo(openapi) {
    var p = {};
    try { p = openapi.paths["/api/v1/video-project-plan"].post.requestBody.content["application/json"].schema.properties || {}; } catch (e) { p = {}; }
    var num = function (k, f, d) { return (p[k] && typeof p[k][f] === "number") ? p[k][f] : d; };
    return {
      goals: (p.goal && p.goal.enum || ["recruiting", "produkt", "unternehmen"]).filter(function (g) { return g !== "product" && g !== "company"; }),
      regions: (p.holiday_region && p.holiday_region.enum) || ["none"],
      reelsMax: num("reels", "maxItems", 12), reelCountMax: num("reel_count_max", "maximum", 12),
      locationsMax: num("locations", "maxItems", 6), roundsMax: num("review_rounds", "maximum", 3),
      lat: { min: num("latitude", "minimum", 47.2), max: num("latitude", "maximum", 55.1) }, lon: { min: num("longitude", "minimum", 5.8), max: num("longitude", "maximum", 15.1) },
    };
  }

  /** Form values -> video-project-plan request. Only planning data; the report title and logo never leave the browser. */
  function buildProjectInput(f, info, today) {
    if (!isDate(f.shootDate)) throw new Error(T.err.date + (f.shootDate || "–"));
    if (!isDate(f.deliverBy)) throw new Error(T.err.date + (f.deliverBy || "–"));
    if (f.shootDate < today) throw new Error(T.err.past);
    if (f.deliverBy <= f.shootDate) throw new Error(T.err.deliver);
    if ((Date.parse(f.deliverBy) - Date.parse(f.shootDate)) / 86400000 > 180) throw new Error(T.err.range);
    if (!TIME_RE.test(f.dayStart) || !TIME_RE.test(f.dayEnd) || minutes(f.dayEnd) - minutes(f.dayStart) < 240) throw new Error(T.err.time);
    var min = Math.max(1, Math.min(info.reelCountMax, Math.floor(Number(f.reelMin) || 1)));
    var max = Math.max(1, Math.min(info.reelCountMax, Math.floor(Number(f.reelMax) || min)));
    if (min > max) throw new Error(T.err.count);
    var input = {
      goal: info.goals.indexOf(f.goal) !== -1 ? f.goal : "recruiting",
      shoot_date: f.shootDate, deliver_by: f.deliverBy, day_start: f.dayStart, day_end: f.dayEnd,
      reel_count_min: min, reel_count_max: max, today: today, language: LANG,
      review_rounds: Math.max(0, Math.min(info.roundsMax, Math.floor(Number(f.rounds)))) || 0,
    };
    var industry = text(f.industry, 60, "industry"); if (industry) input.industry = industry;
    var town = text(f.town, 60, "town"); if (town) input.town = town;
    var job = text(f.job, 60, "job"); if (job) input.job_titles = [job];
    var ideas = lines(f.ideas).map(function (t) { return text(t, 120, "ideas"); });
    if (ideas.length > info.reelsMax) throw new Error(T.err.ideas.replace("{n}", String(info.reelsMax)));
    if (ideas.length) input.reels = ideas.map(function (t) { return { title: t }; });
    var locs = String(f.locations || "").split(/[,;\n]/).map(function (x) { return x.trim(); }).filter(Boolean).map(function (t) { return text(t, 80, "locations"); });
    if (locs.length > info.locationsMax) throw new Error(T.err.locations.replace("{n}", String(info.locationsMax)));
    if (locs.length) input.locations = locs;
    if (f.region && info.regions.indexOf(f.region) !== -1) input.holiday_region = f.region;
    var hasLat = String(f.lat || "").trim() !== "", hasLon = String(f.lon || "").trim() !== "";
    if (hasLat || hasLon) {
      var lat = Number(String(f.lat).replace(",", ".")), lon = Number(String(f.lon).replace(",", "."));
      if (!hasLat || !hasLon || !isFinite(lat) || !isFinite(lon) || lat < info.lat.min || lat > info.lat.max || lon < info.lon.min || lon > info.lon.max) throw new Error(T.err.coords);
      input.latitude = Math.round(lat * 1000) / 1000; input.longitude = Math.round(lon * 1000) / 1000;
    }
    return input;
  }

  if (typeof window !== "undefined") window.CfpProject = { buildProjectInput: buildProjectInput, projectInfo: projectInfo };
  if (typeof document === "undefined" || !document.getElementById("project-form")) return;

  /* ---------------- page ---------------- */
  var P = window.CfpPlanner, Pay = window.AgenturPay, ui = P.ui, el = ui.el;
  var $ = function (id) { return document.getElementById(id); };
  var state = { catalog: {}, info: null, result: null, receipt: null, busy: false, logo: null, color: null };
  function msg(id, t, bad) { var m = $(id); m.textContent = t || ""; m.className = bad ? "fine bad" : "fine"; }
  function setBusy(on) { state.busy = on; document.querySelectorAll("[data-busy-lock]").forEach(function (b) { b.disabled = on || b.getAttribute("data-disabled") === "1"; }); }
  function localToday() { var d = new Date(); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function addDays(date, n) { return new Date(Date.parse(date + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10); }

  var buyer = P.createBuyer({
    $: $, pay: Pay, payTo: document.body.getAttribute("data-pay-to"), network: document.body.getAttribute("data-network"),
    service: function (id) { return state.catalog[id]; }, setBusy: setBusy, isBusy: function () { return state.busy; }, msg: msg,
    kinds: { project: { box: "buy-project", out: "project-msg" } },
    onReceipt: function (r) { state.receipt = r; $("dl-receipt").hidden = false; },
  });

  function values() {
    return {
      goal: $("p-goal").value, industry: $("p-industry").value, town: $("p-town").value, job: $("p-job").value,
      shootDate: $("p-shoot").value, dayStart: $("p-start").value, dayEnd: $("p-end").value, deliverBy: $("p-deliver").value,
      reelMin: $("p-min").value, reelMax: $("p-max").value, ideas: $("p-ideas").value, locations: $("p-locations").value,
      region: $("p-region").value, rounds: $("p-rounds").value, lat: $("p-lat").value, lon: $("p-lon").value,
    };
  }

  function list(items) { var ul = el("ul"); items.forEach(function (t) { ul.appendChild(el("li", t)); }); return ul; }
  function render() {
    var r = state.result;
    $("project-view").hidden = !r;
    $("report-setup").hidden = !r;
    if (!r) return;
    var s = r.summary;
    var ok = s.shoot_day.fits_window && s.on_time; // other warnings (e.g. fewer reels than the maximum) are notes, not failures
    $("project-status").textContent = ok ? T.ok + (r.warnings.length ? " · " + T.notes : "") : T.notOk;
    $("project-status").className = "status " + (ok ? "ok" : "bad");
    $("project-meta").textContent = [
      (s.shoot_day.fits_window ? T.fits : T.notFits).replace("{s}", s.shoot_day.start).replace("{e}", s.shoot_day.end),
      s.reels_planned + " " + T.reel + "s",
      T.ready.replace("{d}", s.ready_for_delivery) + (s.on_time ? " · " + T.buffer.replace("{n}", String(s.buffer_working_days)) : " · " + T.late),
    ].join(" · ");
    var w = $("project-warnings"); w.textContent = "";
    w.hidden = !r.warnings.length;
    if (r.warnings.length) w.appendChild(list(r.warnings));

    var reels = $("project-reels"); reels.textContent = "";
    r.reels.forEach(function (reel) {
      var card = el("article", null, "card");
      card.appendChild(el("h3", reel.title));
      card.appendChild(el("p", reel.slot.start + "–" + reel.slot.end + " · " + reel.location + " · " + reel.recording_minutes + " " + T.minutes, "fine"));
      if (reel.hook) card.appendChild(el("p", T.hook + ": " + reel.hook));
      card.appendChild(el("p", T.people + ": " + reel.people, "fine"));
      var d = el("details", null, "script");
      d.appendChild(el("summary", T.shots + " / " + T.questions));
      if (reel.shots.length) { d.appendChild(el("h4", T.shots)); d.appendChild(list(reel.shots)); }
      if (reel.questions.length) { d.appendChild(el("h4", T.questions)); d.appendChild(list(reel.questions)); }
      card.appendChild(d);
      reels.appendChild(card);
    });
    var reserve = $("project-reserve"); reserve.textContent = "";
    if (r.reserve.length) reserve.appendChild(list(r.reserve.map(function (x) { return x.title + " – " + x.why; })));

    $("project-schedule").textContent = "";
    $("project-schedule").appendChild(ui.table([T.start, T.end, T.what, T.who], r.shoot_day.schedule.map(function (row) { return [row.start, row.end, row.label, row.people || ""]; })));
    $("project-callsheet").textContent = "";
    $("project-callsheet").appendChild(ui.table([T.who, T.times], r.shoot_day.call_sheet.map(function (c) { return [c.role, c.times.join(", ")]; })));
    var sun = $("project-sun"); sun.textContent = "";
    var sd = r.shoot_day.sun;
    if (sd) sun.appendChild(el("p", T.sunrise + " " + (sd.sunrise || "–") + " · " + T.golden + " " + (sd.golden_hour_evening_starts || "–") + " · " + T.sunset + " " + (sd.sunset || "–")));

    $("project-post").textContent = "";
    $("project-post").appendChild(ui.table([T.step, T.from, T.to, T.owner], r.post_production.milestones.map(function (m) { return [m.label, m.start, m.end, m.owner === "customer" ? T.customer : T.agency]; })));
    var hol = r.post_production.holidays_in_range || [];
    if (hol.length) $("project-post").appendChild(el("p", T.holidays + ": " + hol.map(function (h) { return h.date + " " + h.name; }).join(", "), "fine"));
    $("project-checklist").textContent = "";
    $("project-checklist").appendChild(list(r.checklist.concat(r.next_steps)));
    $("project-coverage").textContent = r.coverage || "";
  }

  function renderReport() {
    var r = state.result;
    var title = $("r-title").value;
    var rep = $("report"); rep.textContent = "";
    // never leave an older report behind for printing
    if (/[\x00-\x1f\x7f]/.test(title)) { msg("report-msg", P.T.err.title, true); rep.hidden = true; return false; }
    if (state.logo) { var img = document.createElement("img"); img.src = state.logo; img.alt = ""; img.className = "report-logo"; rep.appendChild(img); }
    if (state.color && P.COLOR_RE.test(state.color)) rep.style.setProperty("--report-accent", state.color); else rep.style.removeProperty("--report-accent");
    rep.appendChild(el("h1", title.trim().slice(0, 120) || T.reportTitle));
    rep.appendChild(el("p", $("project-meta").textContent, "fine"));
    if (r.warnings.length) rep.appendChild(list(r.warnings));
    rep.appendChild(el("h2", "Reels"));
    rep.appendChild(ui.table([T.reel, T.slot, T.place, T.hook], r.reels.map(function (x) { return [x.title, x.slot.start + "–" + x.slot.end, x.location, x.hook || ""]; })));
    rep.appendChild(el("h2", LANG === "de" ? "Drehtag " + r.shoot_day.date : "Shoot day " + r.shoot_day.date));
    rep.appendChild(ui.table([T.start, T.end, T.what, T.who], r.shoot_day.schedule.map(function (row) { return [row.start, row.end, row.label, row.people || ""]; })));
    rep.appendChild(el("h2", LANG === "de" ? "Postproduktion" : "Post-production"));
    rep.appendChild(ui.table([T.step, T.from, T.to, T.owner], r.post_production.milestones.map(function (m) { return [m.label, m.start, m.end, m.owner === "customer" ? T.customer : T.agency]; })));
    rep.appendChild(el("h2", LANG === "de" ? "Vorbereitung" : "Preparation"));
    rep.appendChild(list(r.checklist));
    rep.appendChild(el("p", T.reportBasis, "fine"));
    rep.appendChild(el("p", T.created + localToday(), "fine"));
    rep.hidden = false;
    return true;
  }

  async function init() {
    try {
      var cat = await (await fetch("/api/v1/services")).json();
      (cat.services || []).forEach(function (s) { state.catalog[s.id] = s; });
      state.info = projectInfo(await (await fetch("/openapi.json")).json());
    } catch (e) { return msg("project-msg", LANG === "de" ? "Verbindung fehlgeschlagen." : "Connection failed.", true); }
    var s = state.catalog["video-project-plan"];
    $("price-project").textContent = s ? s.price_usdc + " USDC" : "–";
    if (!s || !s.enabled) { msg("project-msg", P.T.err.unavailable, true); $("btn-project-check").setAttribute("data-disabled", "1"); $("btn-project-check").disabled = true; }
    state.info.goals.forEach(function (g) { var o = el("option", T.goals[g] || g); o.value = g; $("p-goal").appendChild(o); });
    state.info.regions.forEach(function (r) { var o = el("option", P.T.regions[r] || r); o.value = r; $("p-region").appendChild(o); });
    $("p-region").value = state.info.regions.indexOf("DE-BY") !== -1 ? "DE-BY" : "none";
    var today = localToday();
    $("p-shoot").value = addDays(today, 14); $("p-shoot").min = today;
    $("p-deliver").value = addDays(today, 42); $("p-deliver").min = addDays(today, 1);
  }

  $("project-form").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    if (state.busy || !state.info) return;
    var input;
    try { input = buildProjectInput(values(), state.info, localToday()); } catch (e) { return msg("project-msg", e.message, true); }
    setBusy(true);
    msg("project-msg", T.checking);
    try { await P.preflight("video-project-plan", input); buyer.offer("project", "video-project-plan", input); msg("project-msg", T.checked); }
    catch (e) { msg("project-msg", (e && e.message) || "Error", true); }
    finally { setBusy(false); }
  });
  $("btn-buy-project").addEventListener("click", async function () {
    var result = await buyer.purchase("project");
    if (!result) return;
    state.result = result;
    msg("project-msg", T.bought);
    render();
    $("project-view").scrollIntoView({ behavior: "smooth" });
  });
  $("btn-cancel-project").addEventListener("click", function () { if (buyer.cancel("project")) msg("project-msg", T.cancelled); });
  // An offer is for exactly the checked input: editing the form withdraws it, so a purchase never pays for older values.
  ["input", "change"].forEach(function (ev) { $("project-form").addEventListener(ev, function () { if (!$("buy-project").hidden && buyer.cancel("project")) msg("project-msg", ""); }); });
  $("dl-ics").addEventListener("click", function () { if (state.result && state.result.calendar_file_ics) ui.download(T.file + ".ics", "text/calendar", state.result.calendar_file_ics); });
  $("dl-receipt").addEventListener("click", function () { if (state.receipt) ui.download(T.receipt + ".json", "application/json", JSON.stringify(state.receipt, null, 2)); });
  $("r-logo").addEventListener("change", function () {
    var file = this.files && this.files[0];
    this.value = "";
    if (!file) return;
    P.logoFromFile(file).then(function (u) { state.logo = u; msg("report-msg", T.logoLoaded); if (!$("report").hidden) renderReport(); })
      .catch(function (e) { state.logo = null; msg("report-msg", (e && e.message) || "Error", true); });
  });
  $("btn-logo-remove").addEventListener("click", function () { state.logo = null; msg("report-msg", T.logoRemoved); if (!$("report").hidden) renderReport(); });
  $("r-color").addEventListener("input", function () { state.color = P.COLOR_RE.test(this.value) ? this.value : null; if (!$("report").hidden && state.result) renderReport(); });
  $("btn-report").addEventListener("click", function () { if (state.result && renderReport()) msg("report-msg", ""); });
  $("btn-print").addEventListener("click", function () { if (state.result && renderReport()) window.print(); });
  window.addEventListener("beforeprint", function () { if (state.result) renderReport(); });
  init();
})();
