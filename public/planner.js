// Content planner for agencies: form -> free preflight -> one approved purchase -> plan view -> file export/import ->
// separately approved date move -> confirmation -> printable client report. Runs only in the browser.
// Payment reuses window.AgenturPay from agentur.js (quote checks, EIP-3009 signing by the wallet, cross-tab purchase lock).
// Nothing here stores keys; the plan file never contains request ids, result tokens or payment data.
(function () {
  "use strict";

  var FORMAT = "cfp-content-plan";
  var VERSION = 1;
  var MAX_FILE_BYTES = 262144;
  var STEPS = ["concept", "shoot", "edit", "review", "publish"];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
  var CONTROL_RE = /[\x00-\x1f\x7f]/;
  var RECIPE_RE = /^tpl-[a-z0-9-]{1,60}$/;
  var REGION_RE = /^(none|DE-(BW|BY|BE|BB|HB|HH|HE|MV|NI|NW|RP|SL|SN|ST|SH|TH)|AT|CH)$/;
  var LIMITS = { posts: 60, shootDays: 40, conflicts: 200, schedule: 40, text: 200, title: 120, ics: 200000, history: 50 };
  var LANG = typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "de";

  var T = {
    de: {
      steps: { concept: "Konzept", shoot: "Dreh", edit: "Schnitt", review: "Freigabe", publish: "Veröffentlichung" },
      categories: { produkt: "Produkt & Leistung", mitarbeiter: "Mitarbeiter & Team", bts: "Hinter den Kulissen", wissen: "Tipps & Wissen", kunde: "Kunden & Referenzen", unternehmen: "Unternehmen & Events", recruiting: "Ausbildung & Recruiting" },
      weekdays: { mon: "Mo", tue: "Di", wed: "Mi", thu: "Do", fri: "Fr", sat: "Sa", sun: "So" },
      err: {
        date: "Bitte ein gültiges Datum angeben: ", order: "Das Ende des Zeitraums liegt vor dem Anfang.", past: "Der Zeitraum muss in der Zukunft liegen.",
        weekdays: "Bitte mindestens einen Veröffentlichungs- und einen Produktionstag wählen.", categories: "Bitte mindestens ein Thema wählen.",
        mix: "Der Themenmix braucht mindestens einen Beitrag.", lines: "Ungültiges Datum in der Liste: ", tooMany: "Zu viele Einträge in der Liste (höchstens {n}).",
        file: "Die Datei ist kein gültiger Plan.", fileSize: "Die Datei ist zu groß.", fileVersion: "Unbekanntes Planformat oder unbekannte Version.",
        noPlan: "Noch kein Plan vorhanden.", move: "Bitte Beitrag, Schritt und neues Datum wählen.", unavailable: "Dieser Dienst ist derzeit nicht verfügbar. Kein Kauf möglich.",
        approval: "Bitte den Kauf ausdrücklich bestätigen.", priceChanged: "Der Preis hat sich seit der Prüfung geändert. Bitte erneut prüfen.",
        title: "Der Titel enthält unzulässige Zeichen.", conn: "Verbindung fehlgeschlagen.",
        logoSize: "Das Logo ist zu groß (höchstens 1 MB).", logoType: "Nur PNG-, JPG- oder WebP-Bilder sind als Logo erlaubt.", noRecipe: "Für diesen Beitrag gibt es keine Vorlage.",
      },
      checking: "Prüfe Eingabe kostenlos …", checked: "Eingabe gültig. Bitte Preis, Netzwerk und Empfänger prüfen und den Kauf bestätigen.",
      buying: "Kauf läuft. Bitte die Wallet beachten …", bought: "Plan bezahlt und geliefert.", cancelled: "Abgebrochen. Es wurde nichts bezahlt.",
      shiftChecked: "Verschiebung gültig. Bitte den Kauf gesondert bestätigen.", shiftBought: "Verschiebung berechnet. Bitte Änderungen prüfen und erst dann übernehmen.",
      applied: "Änderungen in den Plan übernommen. Der vorherige Stand bleibt als Ausgangsplan erhalten.", discarded: "Verschiebung verworfen. Der Plan ist unverändert.",
      restored: "Ausgangsplan wiederhergestellt.", loaded: "Plan geladen.", saved: "Plan als Datei gespeichert.",
      usable: "Plan ohne Fehler", needsChanges: "Plan enthält Fehler: so nicht verwenden",
      priceLine: "Genau ein Kauf: {p} USDC an {to} auf {net}.", approveLabel: "Ich gebe genau diesen einen Kauf über {p} USDC frei.",
      none: "Keine.", dayPrefix: "Drehtag", noTimes: "Uhrzeiten nach der Verschiebung nicht neu berechnet",
      decisions: { error: "Fehler klären: ", book: "Drehtag {d} buchen ({date}, {posts} Beiträge)", upcoming: "{step} für „{title}“ am {date}", warnings: "{n} Hinweise prüfen", ok: "Keine offenen Fehler." },
      reportBasis: "Datengrundlage: regelbasierte Berechnung des Dienstes Content Month Plan{shift}. Keine KI, keine Prüfung von Feiertagen, Urlaub, Personen oder Kapazitäten. Themen sind Vorschläge.",
      reportShift: " und {n} Terminverschiebung(en) mit Content Plan Re-Schedule",
      changed: "geändert", created: "neu", blocked: "blockiert (erledigt)", confirmNeeded: "Bestätigung nötig: Bitte die Änderungen genau prüfen.",
      shiftNote: "Die Verschiebung prüft keine Wochenenden, Feiertage oder Kapazitäten.", receipt: "kaufbeleg-privat", planFile: "content-plan",
      fileTitle: "Content-Plan", counts: "{p} Beiträge · {d} Drehtage", moves: "{n} Verschiebung(en)", from: "vorher", to: "nachher", post: "Beitrag", step: "Schritt", date: "Datum", group: "Drehgruppe",
      level: { error: "Fehler", warn: "Hinweis" }, original: "aus dem Ausgangsplan", lastShift: "aus der letzten Verschiebung",
      regions: { none: "Keine Feiertage berücksichtigen", "DE-BW": "Baden-Württemberg", "DE-BY": "Bayern", "DE-BE": "Berlin", "DE-BB": "Brandenburg", "DE-HB": "Bremen", "DE-HH": "Hamburg", "DE-HE": "Hessen", "DE-MV": "Mecklenburg-Vorpommern", "DE-NI": "Niedersachsen", "DE-NW": "Nordrhein-Westfalen", "DE-RP": "Rheinland-Pfalz", "DE-SL": "Saarland", "DE-SN": "Sachsen", "DE-ST": "Sachsen-Anhalt", "DE-SH": "Schleswig-Holstein", "DE-TH": "Thüringen", AT: "Österreich", CH: "Schweiz" },
      holiday: "Feiertag", holidaysTitle: "Feiertage im Zeitraum", region: "Feiertage: ",
      script: "Drehbuch-Infos", scriptBuy: "Drehbuch-Infos kaufen", scriptChecked: "Vorlage gefunden. Bitte den Kauf bestätigen.", scriptBought: "Drehbuch-Infos geladen.",
      scriptParts: { hook: "Einstieg (Hook)", alts: "Alternative Einstiege", shots: "Einstellungen", questions: "Fragen", equipment: "Ausrüstung", tips: "Tipps", people: "Personen", place: "Ort", length: "Länge" },
      logoLoaded: "Logo übernommen (nur in diesem Browser, nicht hochgeladen).", logoRemoved: "Logo entfernt.",
    },
    en: {
      steps: { concept: "Concept", shoot: "Shoot", edit: "Edit", review: "Review", publish: "Publish" },
      categories: { produkt: "Products & services", mitarbeiter: "People & team", bts: "Behind the scenes", wissen: "Tips & know-how", kunde: "Customers & references", unternehmen: "Company & events", recruiting: "Apprenticeships & recruiting" },
      weekdays: { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" },
      err: {
        date: "Please enter a valid date: ", order: "The end of the period is before the start.", past: "The period must lie in the future.",
        weekdays: "Please choose at least one publishing and one production day.", categories: "Please choose at least one topic.",
        mix: "The topic mix needs at least one post.", lines: "Invalid date in the list: ", tooMany: "Too many entries in the list (at most {n}).",
        file: "The file is not a valid plan.", fileSize: "The file is too large.", fileVersion: "Unknown plan format or version.",
        noPlan: "No plan yet.", move: "Please choose a post, a step and a new date.", unavailable: "This service is currently unavailable. No purchase possible.",
        approval: "Please approve the purchase explicitly.", priceChanged: "The price changed since the check. Please check again.",
        title: "The title contains characters that are not allowed.", conn: "Connection failed.",
        logoSize: "The logo is too large (at most 1 MB).", logoType: "Only PNG, JPG or WebP images are allowed as a logo.", noRecipe: "There is no recipe for this post.",
      },
      checking: "Checking the input for free …", checked: "Input valid. Check price, network and recipient, then approve the purchase.",
      buying: "Purchase running. Please check your wallet …", bought: "Plan paid and delivered.", cancelled: "Cancelled. Nothing was paid.",
      shiftChecked: "Move is valid. Please approve this purchase separately.", shiftBought: "Move calculated. Review the changes before you apply them.",
      applied: "Changes applied to the plan. The previous state is kept as the original plan.", discarded: "Move discarded. The plan is unchanged.",
      restored: "Original plan restored.", loaded: "Plan loaded.", saved: "Plan saved as a file.",
      usable: "Plan without errors", needsChanges: "Plan contains errors: do not use it as is",
      priceLine: "Exactly one purchase: {p} USDC to {to} on {net}.", approveLabel: "I approve exactly this one purchase of {p} USDC.",
      none: "None.", dayPrefix: "Shoot day", noTimes: "times not recalculated after the move",
      decisions: { error: "Resolve error: ", book: "Book shoot day {d} ({date}, {posts} posts)", upcoming: "{step} for \"{title}\" on {date}", warnings: "Review {n} notes", ok: "No open errors." },
      reportBasis: "Data basis: rule-based calculation by the Content Month Plan service{shift}. No AI, no check of holidays, vacations, people or capacity. Topics are suggestions.",
      reportShift: " and {n} date move(s) with Content Plan Re-Schedule",
      changed: "changed", created: "new", blocked: "blocked (done)", confirmNeeded: "Confirmation needed: review the changes carefully.",
      shiftNote: "The move does not check weekends, holidays or capacity.", receipt: "purchase-receipt-private", planFile: "content-plan",
      fileTitle: "Content plan", counts: "{p} posts · {d} shoot days", moves: "{n} move(s)", from: "before", to: "after", post: "Post", step: "Step", date: "Date", group: "Shoot group",
      level: { error: "Error", warn: "Note" }, original: "from the original plan", lastShift: "from the last move",
      regions: { none: "Do not consider public holidays", "DE-BW": "Baden-Württemberg", "DE-BY": "Bavaria", "DE-BE": "Berlin", "DE-BB": "Brandenburg", "DE-HB": "Bremen", "DE-HH": "Hamburg", "DE-HE": "Hesse", "DE-MV": "Mecklenburg-Western Pomerania", "DE-NI": "Lower Saxony", "DE-NW": "North Rhine-Westphalia", "DE-RP": "Rhineland-Palatinate", "DE-SL": "Saarland", "DE-SN": "Saxony", "DE-ST": "Saxony-Anhalt", "DE-SH": "Schleswig-Holstein", "DE-TH": "Thuringia", AT: "Austria", CH: "Switzerland" },
      holiday: "Holiday", holidaysTitle: "Holidays in the period", region: "Holidays: ",
      script: "Script infos", scriptBuy: "Buy script infos", scriptChecked: "Recipe found. Please approve the purchase.", scriptBought: "Script infos loaded.",
      scriptParts: { hook: "Opening (hook)", alts: "Alternative openings", shots: "Shots", questions: "Questions", equipment: "Equipment", tips: "Tips", people: "People", place: "Place", length: "Length" },
      logoLoaded: "Logo applied (only in this browser, not uploaded).", logoRemoved: "Logo removed.",
    },
  }[LANG];

  /* ---------------- pure helpers (tested in Node without a DOM) ---------------- */

  function isDate(s) {
    if (typeof s !== "string" || !DATE_RE.test(s)) return false;
    var d = new Date(s + "T00:00:00Z");
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }
  function addDays(date, n) { return new Date(Date.parse(date + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10); }
  function weekday(date) { return (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7; } // 0 = Monday
  function localToday(now) {
    var d = now || new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  /** Sensible future defaults: start on the Monday at least a week ahead, four weeks long. */
  function defaultPeriod(today) {
    var from = addDays(today, 7);
    while (weekday(from) !== 0) from = addDays(from, 1);
    return { from: from, to: addDays(from, 25) };
  }
  function cleanText(v, max) {
    if (typeof v !== "string") return null;
    var s = v.replace(/[\x00-\x1f\x7f]/g, " ").trim();
    return s.length ? s.slice(0, max) : null;
  }
  function dateLines(text, max) {
    var lines = String(text || "").split(/[\s,;]+/).map(function (x) { return x.trim(); }).filter(Boolean);
    var bad = lines.filter(function (x) { return !isDate(x); });
    if (bad.length) throw new Error(T.err.lines + bad[0]);
    if (max !== undefined && lines.length > max) throw new Error(T.err.tooMany.replace("{n}", String(max)));
    return lines.filter(function (x, i) { return lines.indexOf(x) === i; }).sort();
  }

  /** Read limits and allowed values from the published OpenAPI schema (no duplicated numbers in the page). */
  function schemaInfo(openapi) {
    var body = function (path) {
      try { return openapi.paths[path].post.requestBody.content["application/json"].schema; } catch (e) { return null; }
    };
    var month = body("/api/v1/content-month-plan") || { properties: {} };
    var shift = body("/api/v1/content-plan-shift") || { properties: {} };
    var p = month.properties || {};
    var mixProps = (p.mix_counts && p.mix_counts.properties) || {};
    var firstMix = mixProps[Object.keys(mixProps)[0]] || {};
    return {
      categories: (p.categories && p.categories.items && p.categories.items.enum) || [],
      weekdays: (p.publish_weekdays && p.publish_weekdays.items && p.publish_weekdays.items.enum) || ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      postsPerWeek: { min: (p.posts_per_week && p.posts_per_week.minimum) || 1, max: (p.posts_per_week && p.posts_per_week.maximum) || 7 },
      mixMax: firstMix.maximum || 30,
      existingMax: (p.existing_publish_dates && p.existing_publish_dates.maxItems) || 60,
      shiftPostsMax: (shift.properties && shift.properties.posts && shift.properties.posts.maxItems) || 40,
      regions: (p.holiday_region && p.holiday_region.enum) || ["none"],
      titleMax: LIMITS.title,
    };
  }

  /**
   * Turn the form values into a content-month-plan request. Only fields the schema knows are sent; nothing
   * about the client or project leaves the browser. Throws a readable error for invalid input.
   */
  function buildMonthInput(f, info, today) {
    if (!isDate(f.from)) throw new Error(T.err.date + (f.from || "–"));
    if (!isDate(f.to)) throw new Error(T.err.date + (f.to || "–"));
    if (f.to < f.from) throw new Error(T.err.order);
    if (f.from <= today) throw new Error(T.err.past);
    if (!f.publishDays.length || !f.productionDays.length) throw new Error(T.err.weekdays);
    var input = {
      from: f.from, to: f.to, today: today, language: LANG,
      publish_weekdays: f.publishDays.slice(), production_weekdays: f.productionDays.slice(),
      avoid_weekends: !!f.avoidWeekends,
      existing_publish_dates: dateLines(f.existingPublish, info.existingMax),
      existing_shoot_dates: dateLines(f.existingShoot, info.existingMax),
    };
    if (f.mode === "mix") {
      var mix = {};
      var total = 0;
      Object.keys(f.mix || {}).forEach(function (k) {
        var n = Math.floor(Number(f.mix[k]) || 0);
        if (n > 0 && info.categories.indexOf(k) !== -1) { mix[k] = Math.min(n, info.mixMax); total += mix[k]; }
      });
      if (!total) throw new Error(T.err.mix);
      input.mix_counts = mix;
    } else {
      var cats = (f.categories || []).filter(function (c) { return info.categories.indexOf(c) !== -1; });
      if (!cats.length) throw new Error(T.err.categories);
      input.categories = cats;
      input.posts_per_week = Math.max(info.postsPerWeek.min, Math.min(info.postsPerWeek.max, Math.floor(Number(f.postsPerWeek) || 0)));
    }
    if (f.startTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(f.startTime)) input.start_time = f.startTime;
    if (f.region && f.region !== "none" && (info.regions || []).indexOf(f.region) !== -1) input.holiday_region = f.region;
    return input;
  }

  function countsLine(plan) {
    return (plan.period.from || "") + " – " + (plan.period.to || "") + " · " + T.counts.replace("{p}", String(plan.posts.length)).replace("{d}", String(plan.shoot_days.length)) + (plan.shifts ? " · " + T.moves.replace("{n}", String(plan.shifts)) : "");
  }
  function cleanConflict(c, source) {
    var level = c && (c.level === "error" || c.level === "warn") ? c.level : null;
    var message = cleanText(c && c.message, LIMITS.text * 2);
    if (!level || !message) return null;
    var steps = Array.isArray(c.steps) ? c.steps.filter(function (s) { return STEPS.indexOf(s) !== -1; }) : [];
    var key = c.post_key && KEY_RE.test(c.post_key) ? c.post_key : null;
    return { level: level, post_key: key, steps: steps, message: message, source: source === "shift" ? "shift" : "plan" };
  }
  function cleanPost(p) {
    if (!p || !KEY_RE.test(String(p.key)) || !isDate(p.publish)) return null;
    var out = { key: String(p.key), title: cleanText(p.title, LIMITS.title) || String(p.key), category: cleanText(p.category, 40), media_type: cleanText(p.media_type, 20), location: cleanText(p.location, 80) };
    STEPS.forEach(function (s) { out[s] = isDate(p[s]) ? p[s] : null; });
    var group = p.shoot_group || p.shoot_day;
    out.shoot_group = typeof group === "string" && group.length <= 40 && !CONTROL_RE.test(group) ? group : null;
    out.recipe_id = typeof p.recipe_id === "string" && RECIPE_RE.test(p.recipe_id) ? p.recipe_id : null;
    out.done = Array.isArray(p.done) ? p.done.filter(function (s, i) { return STEPS.indexOf(s) !== -1 && s !== "publish" && p.done.indexOf(s) === i; }) : [];
    return out;
  }
  function cleanDay(d) {
    if (!d || typeof d.key !== "string" || d.key.length > 40 || CONTROL_RE.test(d.key)) return null;
    var hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
    return {
      key: d.key, date: isDate(d.date) ? d.date : null,
      start: hhmm.test(d.start) ? d.start : null, end: hhmm.test(d.end) ? d.end : null,
      schedule: (Array.isArray(d.schedule) ? d.schedule : []).slice(0, LIMITS.schedule).map(function (r) {
        return r && hhmm.test(r.start) && hhmm.test(r.end) ? { start: r.start, end: r.end, label: cleanText(r.label, LIMITS.text) || "", kind: cleanText(r.kind, 20) || "" } : null;
      }).filter(Boolean),
      times_valid: d.times_valid !== false,
    };
  }

  function cleanList(v, maxItems, maxChars) { return (Array.isArray(v) ? v : []).slice(0, maxItems).map(function (x) { return cleanText(x, maxChars); }).filter(Boolean); }
  /** A bought recipe reduced to plain, bounded text fields (it is stored with the post and shown via textContent only). */
  function cleanScript(r) {
    if (!r || typeof r !== "object" || !RECIPE_RE.test(String(r.id || r.recipe_id))) return null;
    return {
      recipe_id: String(r.id || r.recipe_id), title: cleanText(r.title, LIMITS.title) || "", length: cleanText(r.length, 40),
      hook: cleanText(r.hook, 300), alts: cleanList(r.hookAlternatives || r.alts, 4, 300), shots: cleanList(r.shots, 15, 300),
      questions: cleanList(r.questions, 10, 300), equipment: cleanList(r.equipment, 10, 80), tips: cleanList(r.tips, 6, 300),
      people: cleanText(r.peopleHint || r.people, 120), place: cleanText(r.locationHint || r.place, 80),
    };
  }
  function cleanScripts(map, posts) {
    var out = {};
    if (!map || typeof map !== "object" || Array.isArray(map)) return out;
    posts.forEach(function (p) { var s = cleanScript(map[p.key]); if (s) out[p.key] = s; });
    return out;
  }
  function cleanHolidays(list) {
    return (Array.isArray(list) ? list : []).slice(0, 40).map(function (h) { return h && isDate(h.date) ? { date: h.date, name: cleanText(h.name, 60) || "" } : null; }).filter(Boolean);
  }

  /** Normalize a content-month-plan result into the local plan state (only fields the server delivered). */
  function planFromResult(result) {
    if (!result || !Array.isArray(result.posts)) throw new Error(T.err.file);
    var shootDayOf = {};
    (result.posts || []).forEach(function (p) { if (p && p.shoot_day) shootDayOf[p.key] = p.shoot_day; });
    var posts = result.posts.slice(0, LIMITS.posts).map(function (p) { return cleanPost(Object.assign({}, p, { shoot_group: shootDayOf[p.key] || null })); }).filter(Boolean);
    return {
      plan_id: cleanText(result.plan_id, 40),
      language: result.language === "en" ? "en" : "de",
      period: { from: isDate(result.period && result.period.from) ? result.period.from : null, to: isDate(result.period && result.period.to) ? result.period.to : null },
      today: isDate(result.today) ? result.today : null,
      posts: posts,
      shoot_days: (result.shoot_days || []).slice(0, LIMITS.shootDays).map(cleanDay).filter(Boolean),
      conflicts: (result.conflicts || []).slice(0, LIMITS.conflicts).map(function (c) { return cleanConflict(c, "plan"); }).filter(Boolean),
      warnings: (result.warnings || []).slice(0, LIMITS.conflicts).map(function (w) { return cleanText(w, LIMITS.text * 2); }).filter(Boolean),
      coverage: cleanText(result.coverage, 800),
      holiday_region: REGION_RE.test(String(result.holiday_region)) ? result.holiday_region : "none",
      holidays: cleanHolidays(result.holidays),
      scripts: {},
      ics: typeof result.calendar_file_ics === "string" && result.calendar_file_ics.indexOf("BEGIN:VCALENDAR") === 0 && result.calendar_file_ics.length <= LIMITS.ics ? result.calendar_file_ics : null,
      shifts: 0,
    };
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  /** The shareable plan file: plan data plus a local project title. Never request ids, tokens or payment data. */
  function exportPlan(state, title, now) {
    return {
      format: FORMAT, version: VERSION, saved_at: (now || new Date()).toISOString(),
      project_title: cleanText(title, LIMITS.title),
      plan: clone(state.plan),
      original: clone(state.original || state.plan),
    };
  }

  function validPlan(p) {
    if (!p || typeof p !== "object" || !Array.isArray(p.posts) || p.posts.length > LIMITS.posts) throw new Error(T.err.file);
    if (!Array.isArray(p.shoot_days) || p.shoot_days.length > LIMITS.shootDays) throw new Error(T.err.file);
    if (!Array.isArray(p.conflicts) || p.conflicts.length > LIMITS.conflicts || !Array.isArray(p.warnings) || p.warnings.length > LIMITS.conflicts) throw new Error(T.err.file);
    var posts = p.posts.map(cleanPost);
    if (posts.some(function (x) { return !x; })) throw new Error(T.err.file);
    var keys = posts.map(function (x) { return x.key; });
    if (keys.some(function (k, i) { return keys.indexOf(k) !== i; })) throw new Error(T.err.file);
    var days = p.shoot_days.map(cleanDay);
    if (days.some(function (x) { return !x; })) throw new Error(T.err.file);
    return {
      plan_id: cleanText(p.plan_id, 40),
      language: p.language === "en" ? "en" : "de",
      period: { from: isDate(p.period && p.period.from) ? p.period.from : null, to: isDate(p.period && p.period.to) ? p.period.to : null },
      today: isDate(p.today) ? p.today : null,
      posts: posts,
      shoot_days: days,
      conflicts: p.conflicts.map(function (c) { return cleanConflict(c, c && c.source); }).filter(Boolean),
      warnings: p.warnings.map(function (w) { return cleanText(w, LIMITS.text * 2); }).filter(Boolean),
      coverage: cleanText(p.coverage, 800),
      holiday_region: REGION_RE.test(String(p.holiday_region)) ? p.holiday_region : "none",
      holidays: cleanHolidays(p.holidays),
      scripts: cleanScripts(p.scripts, posts),
      ics: null, // never pass on calendar text from a file: it is rebuilt from the checked dates (no injected events or links)
      shifts: Math.max(0, Math.min(LIMITS.history, Math.floor(Number(p.shifts) || 0))),
    };
  }

  /** Strictly validate an imported plan file. Imported text stays data: every string is re-cleaned and later set via textContent. */
  function importPlan(text) {
    if (typeof text !== "string") throw new Error(T.err.file);
    if (text.length > MAX_FILE_BYTES) throw new Error(T.err.fileSize);
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(T.err.file); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(T.err.file);
    if (data.format !== FORMAT || data.version !== VERSION) throw new Error(T.err.fileVersion);
    var plan = validPlan(data.plan);
    var original = data.original ? validPlan(data.original) : clone(plan);
    var title = data.project_title === null || data.project_title === undefined ? null : cleanText(data.project_title, LIMITS.title);
    return { plan: plan, original: original, title: title };
  }

  /** Request for content-plan-shift from the current plan: posts_for_reschedule shape plus done steps and shoot groups. */
  function shiftInput(plan, move, info) {
    if (!move || !move.post_key || STEPS.indexOf(move.step) === -1 || !isDate(move.new_date)) throw new Error(T.err.move);
    var max = (info && info.shiftPostsMax) || 40;
    var posts = plan.posts.slice(0, max).map(function (p) {
      var o = { key: p.key, title: p.title.slice(0, LIMITS.title), publish: p.publish };
      ["concept", "shoot", "edit", "review"].forEach(function (s) { if (p[s]) o[s] = p[s]; });
      if (p.done && p.done.length) o.done = p.done.slice();
      if (p.shoot_group) o.shoot_group = p.shoot_group;
      return o;
    });
    if (!posts.some(function (p) { return p.key === move.post_key; })) throw new Error(T.err.move);
    var input = { posts: posts, move: { post_key: move.post_key, step: move.step, new_date: move.new_date }, language: LANG };
    if (plan.holiday_region && plan.holiday_region !== "none") input.holiday_region = plan.holiday_region;
    if (move.step === "publish" && move.publish_mode) input.move.publish_mode = move.publish_mode;
    if (move.step === "shoot" && move.shoot_mode) input.move.shoot_mode = move.shoot_mode;
    return input;
  }

  /** Apply a confirmed content-plan-shift result to a COPY of the plan; the caller keeps the original. */
  function applyShift(plan, result) {
    if (!result || !Array.isArray(result.posts)) throw new Error(T.err.file);
    var next = clone(plan);
    var byKey = {};
    result.posts.forEach(function (p) { if (p && KEY_RE.test(String(p.key))) byKey[p.key] = p; });
    var changedKeys = {};
    (result.changes || []).forEach(function (c) { if (c && c.post_key) changedKeys[c.post_key] = true; });
    next.posts = next.posts.map(function (p) {
      var r = byKey[p.key];
      if (!r) return p;
      var merged = Object.assign({}, p);
      STEPS.forEach(function (s) { merged[s] = isDate(r[s]) ? r[s] : p[s]; });
      merged.shoot_group = typeof r.shoot_group === "string" && r.shoot_group.length <= 40 ? r.shoot_group : null;
      return merged;
    });
    // Shoot days: keep server times only where the shared date did not change.
    var groups = {};
    next.posts.forEach(function (p) { if (p.shoot_group) (groups[p.shoot_group] = groups[p.shoot_group] || []).push(p); });
    var known = {};
    next.shoot_days.forEach(function (d) { known[d.key] = d; });
    next.shoot_days = Object.keys(groups).sort().map(function (key) {
      var members = groups[key];
      var dates = members.map(function (p) { return p.shoot; }).filter(Boolean);
      var date = dates.length && dates.every(function (d) { return d === dates[0]; }) ? dates[0] : null;
      var prev = known[key];
      var same = prev && prev.date === date;
      return { key: key, date: date, start: same ? prev.start : null, end: same ? prev.end : null, schedule: same ? prev.schedule : [], times_valid: !!same };
    });
    next.conflicts = next.conflicts.filter(function (c) { return c.source === "plan" && !changedKeys[c.post_key]; })
      .concat((result.conflicts || []).map(function (c) { return cleanConflict(c, "shift"); }).filter(Boolean));
    next.ics = null; // the server calendar file describes the old dates
    next.shifts = (plan.shifts || 0) + 1;
    return next;
  }

  /** Rows for the change review: before/after per changed date. */
  function changeRows(plan, result) {
    var titles = {};
    plan.posts.forEach(function (p) { titles[p.key] = p.title; });
    return (result.changes || []).map(function (c) {
      return { post: titles[c.post_key] || c.post_key, step: T.steps[c.step] || c.step, from: c.from || "–", to: c.to, kind: c.created ? T.created : T.changed };
    }).concat((result.blocked || []).map(function (b) {
      return { post: titles[b.post_key] || b.post_key, step: T.steps[b.step] || b.step, from: "", to: "", kind: T.blocked };
    }));
  }

  function hasErrors(plan) {
    return plan.conflicts.some(function (c) { return c.level === "error"; }) || plan.posts.some(function (p) { return !p.shoot; });
  }

  /** Calendar entries for the current plan, sorted by date. */
  function events(plan) {
    var out = [];
    plan.posts.forEach(function (p) {
      STEPS.forEach(function (s) { if (p[s]) out.push({ date: p[s], step: s, key: p.key, title: p.title, done: p.done.indexOf(s) !== -1, group: s === "shoot" ? p.shoot_group : null }); });
    });
    return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : STEPS.indexOf(a.step) - STEPS.indexOf(b.step); });
  }

  /** Month grids (weeks starting Monday) covering all plan dates. */
  function months(plan) {
    var ev = events(plan);
    if (!ev.length) return [];
    var first = ev[0].date.slice(0, 7), last = ev[ev.length - 1].date.slice(0, 7);
    var out = [];
    var m = first;
    for (var guard = 0; m <= last && guard < 12; guard++) {
      var start = m + "-01";
      var cur = start;
      while (weekday(cur) !== 0) cur = addDays(cur, -1);
      var weeks = [];
      while (true) {
        var week = [];
        for (var i = 0; i < 7; i++) { week.push({ date: cur, inMonth: cur.slice(0, 7) === m, events: ev.filter(function (e) { return e.date === cur; }) }); cur = addDays(cur, 1); }
        weeks.push(week);
        if (cur.slice(0, 7) > m) break;
      }
      out.push({ month: m, weeks: weeks });
      var y = Number(m.slice(0, 4)), mo = Number(m.slice(5, 7));
      m = mo === 12 ? (y + 1) + "-01" : y + "-" + ("0" + (mo + 1)).slice(-2);
    }
    return out;
  }

  /** Next decisions for the client report: errors first, then shoot days to book, then the next open steps. */
  function nextDecisions(plan, today) {
    var out = [];
    plan.conflicts.filter(function (c) { return c.level === "error"; }).forEach(function (c) { out.push(T.decisions.error + c.message); });
    plan.shoot_days.filter(function (d) { return d.date && d.date >= today; }).forEach(function (d) {
      var n = plan.posts.filter(function (p) { return p.shoot_group === d.key; }).length;
      out.push(T.decisions.book.replace("{d}", d.key).replace("{date}", d.date).replace("{posts}", String(n)));
    });
    events(plan).filter(function (e) { return e.date >= today && !e.done && e.step !== "shoot"; }).slice(0, 5).forEach(function (e) {
      out.push(T.decisions.upcoming.replace("{step}", T.steps[e.step]).replace("{title}", e.title).replace("{date}", e.date));
    });
    var warns = plan.conflicts.filter(function (c) { return c.level === "warn"; }).length + plan.warnings.length;
    if (warns) out.push(T.decisions.warnings.replace("{n}", String(warns)));
    if (!plan.conflicts.some(function (c) { return c.level === "error"; })) out.push(T.decisions.ok);
    return out;
  }

  /** RFC 5545 line folding: at most 75 octets per line, continuation lines start with a space. */
  function icsFold(line) {
    var enc = new TextEncoder(), parts = [], cur = "", bytes = 0;
    for (var ch of line) {
      var b = enc.encode(ch).length;
      if (bytes + b > (parts.length ? 74 : 75)) { parts.push(cur); cur = ""; bytes = 0; }
      cur += ch; bytes += b;
    }
    parts.push(cur);
    return parts.join("\r\n ");
  }
  function icsEscape(s) { return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
  /** Calendar text for the current dates (used after a move, when the server file is out of date): all-day entries. */
  function icsFromPlan(plan, stamp) {
    var day = function (d) { return d.replace(/-/g, ""); };
    var lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Agent Data API//Content Planner//" + LANG.toUpperCase(), "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
    var id = (plan.plan_id || "plan").replace(/[^A-Za-z0-9-]/g, "");
    events(plan).forEach(function (e) {
      lines.push("BEGIN:VEVENT", "UID:" + id + "-" + e.key + "-" + e.step + "-" + plan.shifts + "@planner", "DTSTAMP:" + stamp,
        "DTSTART;VALUE=DATE:" + day(e.date), "DTEND;VALUE=DATE:" + day(addDays(e.date, 1)), "SUMMARY:" + icsEscape(T.steps[e.step] + " · " + e.title), "END:VEVENT");
    });
    lines.push("END:VCALENDAR");
    return lines.map(icsFold).join("\r\n") + "\r\n";
  }


  /* ---------------- shared browser helpers (also used by the project planner page) ---------------- */

  var NETWORK_LABEL = { "eip155:8453": "Base (USDC)", "eip155:84532": "Base Sepolia (test USDC)" };
  var CHAIN_HEX = { "eip155:8453": "0x2105", "eip155:84532": "0x14a34" };

  async function preflight(id, input) {
    var r = await fetch("/api/v1/preflight/" + encodeURIComponent(id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    var j = await r.json();
    if (!r.ok) throw new Error(j.message || j.error || T.err.file);
    return j;
  }

  /**
   * One buyer per page. offer() shows price, network and recipient and resets the approval box; purchase() runs exactly
   * one approved purchase through agentur.js (quote checks, wallet signature, cross-tab lock, unresolved purchases blocked).
   */
  function createBuyer(env) {
    var pending = null;
    function payable() { return /^0x[0-9a-fA-F]{40}$/.test(env.payTo || "") && !!NETWORK_LABEL[env.network]; }
    function offer(kind, id, input) {
      var s = env.service(id);
      if (!s || !s.enabled || !payable()) throw new Error(T.err.unavailable);
      pending = { kind: kind, id: id, input: input, price: s.price_usdc };
      var box = env.$(env.kinds[kind].box);
      box.hidden = false;
      box.querySelector("[data-price]").textContent = T.priceLine.replace("{p}", s.price_usdc).replace("{to}", env.payTo).replace("{net}", NETWORK_LABEL[env.network]);
      box.querySelector("input[type=checkbox]").checked = false;
      box.querySelector("[data-approve-label]").textContent = T.approveLabel.replace("{p}", s.price_usdc);
      var expert = box.querySelector("[data-expert]");
      if (expert) expert.textContent = JSON.stringify(input, null, 2);
    }
    // No cancel while a purchase runs: the wallet prompt may still be signed, so "nothing was paid" would be wrong.
    function cancel(kind) {
      if (env.isBusy()) return false;
      if (pending && pending.kind === kind) pending = null;
      env.$(env.kinds[kind].box).hidden = true;
      return true;
    }
    async function purchase(kind) {
      var p = pending;
      var box = env.$(env.kinds[kind].box);
      var out = env.kinds[kind].out;
      if (!p || p.kind !== kind || env.isBusy()) return null;
      if (!box.querySelector("input[type=checkbox]").checked) { env.msg(out, T.err.approval, true); return null; }
      var s = env.service(p.id);
      if (!s || !s.enabled || !payable()) { env.msg(out, T.err.unavailable, true); return null; }
      if (s.price_usdc !== p.price) { env.msg(out, T.err.priceChanged, true); return null; }
      env.setBusy(true);
      env.msg(out, T.buying);
      try {
        var eth = window.ethereum;
        var session = env.pay.createPurchaseSession(window.localStorage, window.navigator.locks, fetch);
        var result = await session.run(async function () {
          if (!eth) throw new Error(LANG === "de" ? "Keine Browser-Wallet gefunden." : "No browser wallet found.");
          await preflight(p.id, p.input);
          var quote = await fetch(s.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(p.input) });
          if (quote.status !== 402) throw new Error("HTTP " + quote.status);
          var accounts = await eth.request({ method: "eth_requestAccounts" });
          var from = accounts && accounts[0];
          if (!from) throw new Error(LANG === "de" ? "Wallet nicht verbunden." : "Wallet not connected.");
          await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_HEX[env.network] }] });
          var signed = await env.pay.buildPayment(quote.headers.get("payment-required"), { payTo: env.payTo, network: env.network, priceUsdc: p.price }, {
            address: from,
            signTypedData: function (json) { return eth.request({ method: "eth_signTypedData_v4", params: [from, json] }); },
          }, Math.floor(Date.now() / 1000), window.crypto, function (amount) { return Math.round(amount * 1e6) === Math.round(Number(p.price) * 1e6); });
          if (!signed) return null;
          return { path: s.path, input: p.input, header: signed.header };
        }, function () { return true; }); // the page approval above covers exactly this new purchase
        if (!result) { env.msg(out, T.cancelled); return null; }
        var body = result.body;
        // Keep the private receipt even when delivery failed: it is the key for retrieval or the free retry.
        if (body && body.request_id && body.result_token) env.onReceipt({ service: body.service, request_id: body.request_id, result_token: body.result_token, saved_at: new Date().toISOString() });
        if (!result.ok || !body || body.result === undefined) { env.msg(out, (body && (body.message || body.error)) || "Error", true); return null; }
        // The shared purchase lock may hand back an earlier, recovered purchase of another service: never treat it as this one.
        if (body.service !== p.id) {
          env.msg(out, LANG === "de" ? "Ein früherer Kauf (" + body.service + ") wurde abgeschlossen und ist auf der Agenturseite abrufbar. Bitte diesen Kauf erneut starten." : "An earlier purchase (" + body.service + ") was completed and can be retrieved on the agency page. Please start this purchase again.", true);
          return null;
        }
        box.hidden = true;
        pending = null;
        return body.result;
      } catch (e) {
        var warning = (e && e.message) || T.cancelled;
        try {
          var rec = env.pay.createPurchaseSession(window.localStorage, window.navigator.locks, fetch).read();
          // agentur.js already explains a blocked purchase (it names the start time); add a hint only for a fresh failure.
          if (rec && rec.state !== "completed" && warning.indexOf(rec.started_at) === -1) {
            warning += " " + (rec.request_id
              ? (LANG === "de" ? "Ein Kauf ist noch ungeklärt: nicht erneut bezahlen; der nächste Versuch ruft nur das vorhandene Ergebnis ab." : "A purchase is still unresolved: do not pay again; the next attempt only retrieves the existing result.")
              : (LANG === "de" ? "Ein Kauf ist ungeklärt (" + rec.started_at + "): nicht erneut bezahlen, bitte den Support mit Kaufzeit und Wallet-Adresse kontaktieren." : "A purchase is unresolved (" + rec.started_at + "): do not pay again; contact support with the purchase time and wallet address."));
          }
        } catch (_) { /* storage blocked */ }
        env.msg(out, warning, true);
        return null;
      } finally { env.setBusy(false); }
    }
    return { payable: payable, offer: offer, cancel: cancel, purchase: purchase, preflight: preflight };
  }

  /**
   * Report logo: read ONLY in the browser, never uploaded or saved in the plan file. Accepted are PNG, JPEG and WebP,
   * recognized by their file signature (not the name or the browser's type guess); SVG and everything else is refused
   * because it can carry scripts. The picture is decoded and redrawn on a canvas, so only plain pixels remain.
   */
  var LOGO_MAX_BYTES = 1048576, LOGO_MAX_SIDE = 6000, LOGO_OUT = { w: 600, h: 200 };
  function imageKind(bytes) {
    var b = bytes;
    if (!b || b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
    return null;
  }
  async function logoFromFile(file) {
    if (!file || file.size > LOGO_MAX_BYTES) throw new Error(T.err.logoSize);
    var bytes = new Uint8Array(await file.arrayBuffer());
    var kind = imageKind(bytes);
    if (!kind) throw new Error(T.err.logoType);
    var bitmap;
    try { bitmap = await createImageBitmap(new Blob([bytes], { type: kind })); } catch (e) { throw new Error(T.err.logoType); }
    if (!bitmap.width || !bitmap.height || bitmap.width > LOGO_MAX_SIDE || bitmap.height > LOGO_MAX_SIDE) { bitmap.close(); throw new Error(T.err.logoType); }
    var scale = Math.min(1, LOGO_OUT.w / bitmap.width, LOGO_OUT.h / bitmap.height);
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/png"); // a fresh PNG: no metadata, no embedded content from the original file
  }
  var COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  /* small DOM helpers (text only, never HTML) */
  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  }
  function download(name, type, text) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function table(head, rows) {
    var wrap = el("div", null, "tablewrap");
    var t = el("table");
    var tr = el("tr");
    head.forEach(function (h) { tr.appendChild(el("th", h)); });
    var th = el("thead"); th.appendChild(tr); t.appendChild(th);
    var tb = el("tbody");
    rows.forEach(function (r) { var row = el("tr"); r.forEach(function (c) { row.appendChild(c && c.nodeType ? (function () { var td = el("td"); td.appendChild(c); return td; })() : el("td", c === null || c === undefined ? "" : c)); }); tb.appendChild(row); });
    t.appendChild(tb); wrap.appendChild(t);
    return wrap;
  }

  var api = {
    isDate: isDate, addDays: addDays, defaultPeriod: defaultPeriod, schemaInfo: schemaInfo, buildMonthInput: buildMonthInput, planFromResult: planFromResult,
    exportPlan: exportPlan, importPlan: importPlan, shiftInput: shiftInput, applyShift: applyShift, changeRows: changeRows, hasErrors: hasErrors,
    events: events, months: months, nextDecisions: nextDecisions, icsFromPlan: icsFromPlan, dateLines: dateLines, LIMITS: LIMITS, MAX_FILE_BYTES: MAX_FILE_BYTES,
    imageKind: imageKind, logoFromFile: logoFromFile, cleanScript: cleanScript, ui: { el: el, table: table, download: download }, preflight: preflight, createBuyer: createBuyer, COLOR_RE: COLOR_RE, T: T, LANG: LANG,
  };
  if (typeof window !== "undefined") window.CfpPlanner = api;
  if (typeof document === "undefined" || !document.getElementById("planner")) return;

  /* ---------------- page ---------------- */

  var $ = function (id) { return document.getElementById(id); };
  var Pay = window.AgenturPay;
  var payTo = document.body.getAttribute("data-pay-to");
  var network = document.body.getAttribute("data-network");
  var state = { plan: null, original: null, catalog: {}, info: null, shiftResult: null, receipt: null, busy: false, logo: null, color: null };

  function msg(id, text, bad) { var m = $(id); m.textContent = text || ""; m.className = bad ? "fine bad" : "fine"; }
  function setBusy(on) {
    state.busy = on;
    document.querySelectorAll("[data-busy-lock]").forEach(function (b) { b.disabled = on || b.getAttribute("data-disabled") === "1"; });
  }
  function service(id) { return state.catalog[id]; }

  /* form */
  function checks(boxId, name, values, labels, selected) {
    var box = $(boxId);
    box.textContent = "";
    values.forEach(function (v) {
      var l = el("label", null, "check");
      var i = document.createElement("input");
      i.type = "checkbox"; i.name = name; i.value = v; i.checked = selected.indexOf(v) !== -1;
      l.appendChild(i); l.appendChild(el("span", labels[v] || v));
      box.appendChild(l);
    });
  }
  function checked(name) { return Array.prototype.slice.call(document.querySelectorAll("input[name=" + name + "]:checked")).map(function (i) { return i.value; }); }
  function renderForm() {
    var info = state.info;
    var today = localToday();
    var period = defaultPeriod(today);
    $("f-from").value = period.from; $("f-from").min = addDays(today, 1);
    $("f-to").value = period.to; $("f-to").min = addDays(today, 1);
    $("f-ppw").min = String(info.postsPerWeek.min); $("f-ppw").max = String(info.postsPerWeek.max);
    checks("f-cats", "cat", info.categories, T.categories, info.categories.slice(0, 3));
    checks("f-pub", "pub", info.weekdays, T.weekdays, ["mon", "wed", "fri"]);
    checks("f-prod", "prod", info.weekdays, T.weekdays, ["tue", "thu"]);
    var mixBox = $("f-mix");
    mixBox.textContent = "";
    info.categories.forEach(function (c) {
      var l = el("label", null, "field small");
      l.appendChild(el("span", T.categories[c] || c));
      var i = document.createElement("input");
      i.type = "number"; i.min = "0"; i.max = String(info.mixMax); i.value = "0"; i.name = "mix"; i.setAttribute("data-cat", c);
      l.appendChild(i); mixBox.appendChild(l);
    });
    $("f-existing-max").textContent = String(info.existingMax);
    var region = $("f-region");
    region.textContent = "";
    info.regions.forEach(function (r) { var o = el("option", T.regions[r] || r); o.value = r; region.appendChild(o); });
    region.value = info.regions.indexOf("DE-BY") !== -1 ? "DE-BY" : "none";
    toggleMode();
  }
  function toggleMode() {
    var mix = $("f-mode-mix").checked;
    $("f-mix-box").hidden = !mix;
    $("f-ppw-box").hidden = mix;
  }
  function formValues() {
    var mix = {};
    document.querySelectorAll("input[name=mix]").forEach(function (i) { mix[i.getAttribute("data-cat")] = i.value; });
    return {
      from: $("f-from").value, to: $("f-to").value, mode: $("f-mode-mix").checked ? "mix" : "weekly",
      postsPerWeek: $("f-ppw").value, categories: checked("cat"), mix: mix,
      publishDays: checked("pub"), productionDays: checked("prod"),
      existingPublish: $("f-ex-pub").value, existingShoot: $("f-ex-shoot").value,
      avoidWeekends: $("f-weekends").checked, startTime: $("f-start").value, region: $("f-region").value,
    };
  }

  /* purchases: plan, move and script infos share one buyer (one approval per purchase) */
  var buyer = createBuyer({
    $: $, pay: Pay, payTo: payTo, network: network, service: service, setBusy: setBusy, isBusy: function () { return state.busy; }, msg: msg,
    kinds: { plan: { box: "buy-plan", out: "plan-msg" }, shift: { box: "buy-shift", out: "shift-msg" }, script: { box: "buy-script", out: "script-msg" } },
    onReceipt: function (receipt) { state.receipt = receipt; $("dl-receipt").hidden = false; },
  });

  /* plan view */
  function renderPlan() {
    var plan = state.plan;
    $("plan-view").hidden = !plan;
    $("shift").hidden = !plan;
    $("report-setup").hidden = !plan;
    if (!plan) return;
    var bad = hasErrors(plan);
    var badge = $("plan-status");
    badge.textContent = bad ? T.needsChanges : T.usable;
    badge.className = "status " + (bad ? "bad" : "ok");
    $("plan-meta").textContent = countsLine(plan);
    $("btn-restore").hidden = !plan.shifts;

    // list
    var list = $("plan-list");
    list.textContent = "";
    var rows = plan.posts.map(function (p) {
      var steps = el("div", null, "chain");
      STEPS.forEach(function (s) {
        var cell = el("span", null, "step" + (p.done.indexOf(s) !== -1 ? " done" : ""));
        cell.appendChild(el("b", T.steps[s]));
        cell.appendChild(el("span", p[s] || "–"));
        if (s !== "publish" && p[s]) {
          var cb = document.createElement("input");
          cb.type = "checkbox"; cb.checked = p.done.indexOf(s) !== -1; cb.title = LANG === "de" ? "erledigt" : "done";
          cb.addEventListener("change", function () {
            var i = p.done.indexOf(s);
            if (cb.checked && i === -1) p.done.push(s); else if (!cb.checked && i !== -1) p.done.splice(i, 1);
            renderPlan();
          });
          cell.appendChild(cb);
        }
        steps.appendChild(cell);
      });
      var titleCell = el("div");
      titleCell.appendChild(el("span", p.title));
      var script = plan.scripts[p.key];
      if (script) titleCell.appendChild(scriptDetails(script));
      else if (p.recipe_id) {
        var sb = el("button", T.scriptBuy, "btn small");
        sb.type = "button";
        sb.setAttribute("data-busy-lock", "");
        sb.addEventListener("click", function () { checkScript(p); });
        titleCell.appendChild(sb);
      }
      return [titleCell, T.categories[p.category] || p.category || "", p.shoot_group || "–", steps];
    });
    list.appendChild(table([T.post, LANG === "de" ? "Thema" : "Topic", T.group, LANG === "de" ? "Terminkette" : "Date chain"], rows));

    // shoot days
    var days = $("plan-days");
    days.textContent = "";
    plan.shoot_days.forEach(function (d) {
      var card = el("article", null, "card");
      card.appendChild(el("h3", T.dayPrefix + " " + d.key + " · " + (d.date || "–")));
      var members = plan.posts.filter(function (p) { return p.shoot_group === d.key; }).map(function (p) { return p.title; });
      card.appendChild(el("p", members.join(" · ") || T.none));
      if (d.times_valid && d.schedule.length) {
        var ul = el("ul", null, "schedule");
        d.schedule.forEach(function (r) { ul.appendChild(el("li", r.start + "–" + r.end + " " + r.label)); });
        card.appendChild(ul);
      } else card.appendChild(el("p", T.noTimes, "fine"));
      days.appendChild(card);
    });

    // calendar
    var cal = $("plan-calendar");
    cal.textContent = "";
    months(plan).forEach(function (m) {
      cal.appendChild(el("h3", m.month));
      var grid = el("div", null, "calgrid");
      ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].forEach(function (w) { grid.appendChild(el("div", T.weekdays[w], "calhead")); });
      m.weeks.forEach(function (week) {
        week.forEach(function (c) {
          var hol = holidayName(plan, c.date);
          var cell = el("div", null, "calcell" + (c.inMonth ? "" : " out") + (hol ? " hol" : ""));
          cell.appendChild(el("span", c.date.slice(8) + (hol ? " · " + hol : ""), "calday"));
          c.events.forEach(function (e) { cell.appendChild(el("span", T.steps[e.step] + ": " + e.title, "ev ev-" + e.step + (e.done ? " done" : ""))); });
          grid.appendChild(cell);
        });
      });
      cal.appendChild(grid);
    });

    // conflicts
    var cf = $("plan-conflicts");
    cf.textContent = "";
    var all = plan.conflicts.map(function (c) { return [T.level[c.level], c.message, c.source === "shift" ? T.lastShift : T.original]; })
      .concat(plan.warnings.map(function (w) { return [T.level.warn, w, T.original]; }));
    cf.appendChild(all.length ? table([LANG === "de" ? "Art" : "Type", LANG === "de" ? "Erklärung" : "Explanation", LANG === "de" ? "Quelle" : "Source"], all) : el("p", T.none));
    if (plan.holidays.length) {
      cf.appendChild(el("h3", T.holidaysTitle + " (" + (T.regions[plan.holiday_region] || plan.holiday_region) + ")"));
      cf.appendChild(table([T.date, T.holiday], plan.holidays.map(function (h) { return [h.date, h.name]; })));
    }
    if (plan.coverage) cf.appendChild(el("p", plan.coverage, "fine"));

    // move form options
    var sel = $("s-post");
    var chosen = sel.value;
    sel.textContent = "";
    plan.posts.forEach(function (p) { var o = el("option", p.title + " (" + p.key + ")"); o.value = p.key; sel.appendChild(o); });
    if (plan.posts.some(function (p) { return p.key === chosen; })) sel.value = chosen;
    var step = $("s-step");
    if (!step.options.length) STEPS.forEach(function (s) { var o = el("option", T.steps[s]); o.value = s; step.appendChild(o); });
    moveModes();
  }
  function holidayName(plan, date) {
    for (var i = 0; i < plan.holidays.length; i++) if (plan.holidays[i].date === date) return plan.holidays[i].name;
    return null;
  }
  function scriptDetails(s) {
    var d = el("details", null, "script");
    d.appendChild(el("summary", T.script + (s.length ? " · " + s.length : "")));
    var add = function (label, value) {
      if (!value || (Array.isArray(value) && !value.length)) return;
      d.appendChild(el("h4", label));
      if (Array.isArray(value)) { var ul = el("ul"); value.forEach(function (v) { ul.appendChild(el("li", v)); }); d.appendChild(ul); }
      else d.appendChild(el("p", value));
    };
    add(T.scriptParts.hook, s.hook); add(T.scriptParts.alts, s.alts); add(T.scriptParts.shots, s.shots); add(T.scriptParts.questions, s.questions);
    add(T.scriptParts.equipment, s.equipment); add(T.scriptParts.people, s.people); add(T.scriptParts.place, s.place); add(T.scriptParts.tips, s.tips);
    return d;
  }
  async function checkScript(post) {
    if (state.busy) return;
    if (!post.recipe_id) return msg("script-msg", T.err.noRecipe, true);
    var input = { recipe_id: post.recipe_id, language: LANG };
    setBusy(true);
    msg("script-msg", T.checking);
    try {
      await preflight("video-recipes", input);
      buyer.offer("script", "video-recipes", input);
      state.scriptFor = post.key;
      msg("script-msg", T.scriptChecked + " · " + post.title);
      $("buy-script").scrollIntoView({ behavior: "smooth", block: "center" });
    } catch (e) { msg("script-msg", (e && e.message) || T.err.conn, true); }
    finally { setBusy(false); }
  }
  function moveModes() {
    $("s-publish-mode-box").hidden = $("s-step").value !== "publish";
    $("s-shoot-mode-box").hidden = $("s-step").value !== "shoot";
  }

  /* move review */
  function renderShiftReview(result) {
    var box = $("shift-review");
    box.hidden = false;
    var rows = changeRows(state.plan, result).map(function (r) { return [r.post, r.step, r.from, r.to, r.kind]; });
    var list = $("shift-changes");
    list.textContent = "";
    list.appendChild(rows.length ? table([T.post, T.step, T.from, T.to, ""], rows) : el("p", T.none));
    var cf = (result.conflicts || []).map(function (c) { return [T.level[c.level] || c.level, String(c.message || "")]; });
    $("shift-conflicts").textContent = "";
    $("shift-conflicts").appendChild(cf.length ? table([LANG === "de" ? "Art" : "Type", LANG === "de" ? "Erklärung" : "Explanation"], cf) : el("p", T.none));
    $("shift-confirm-note").textContent = result.needs_confirmation ? T.confirmNeeded : "";
    $("shift-note").textContent = T.shiftNote;
  }

  /* report */
  function renderReport() {
    var plan = state.plan;
    var title = $("r-title").value;
    // never leave an older report behind for printing
    if (title && CONTROL_RE.test(title)) { msg("report-msg", T.err.title, true); $("report").textContent = ""; $("report").hidden = true; return false; }
    var r = $("report");
    r.textContent = "";
    if (state.logo) {
      var img = document.createElement("img");
      img.src = state.logo; // a PNG data URL produced locally by logoFromFile (redrawn pixels only)
      img.alt = ""; img.className = "report-logo";
      r.appendChild(img);
    }
    if (state.color && COLOR_RE.test(state.color)) r.style.setProperty("--report-accent", state.color); else r.style.removeProperty("--report-accent");
    r.appendChild(el("h1", cleanText(title, LIMITS.title) || T.fileTitle));
    r.appendChild(el("p", countsLine(plan), "fine"));
    r.appendChild(el("p", hasErrors(plan) ? T.needsChanges : T.usable, "status " + (hasErrors(plan) ? "bad" : "ok")));
    r.appendChild(el("h2", LANG === "de" ? "Nächste Entscheidungen" : "Next decisions"));
    var ul = el("ul");
    nextDecisions(plan, localToday()).forEach(function (d) { ul.appendChild(el("li", d)); });
    r.appendChild(ul);
    r.appendChild(el("h2", LANG === "de" ? "Beiträge und Termine" : "Posts and dates"));
    r.appendChild(table([T.post].concat(STEPS.map(function (s) { return T.steps[s]; })).concat([T.group]), plan.posts.map(function (p) {
      return [p.title].concat(STEPS.map(function (s) { return (p[s] || "–") + (p.done.indexOf(s) !== -1 ? " ✓" : ""); })).concat([p.shoot_group || "–"]);
    })));
    r.appendChild(el("h2", LANG === "de" ? "Drehtage" : "Shoot days"));
    r.appendChild(table([T.group, T.date, LANG === "de" ? "Zeit" : "Time", T.post], plan.shoot_days.map(function (d) {
      return [d.key, d.date || "–", d.times_valid && d.start ? d.start + "–" + d.end : T.noTimes, plan.posts.filter(function (p) { return p.shoot_group === d.key; }).map(function (p) { return p.title; }).join(", ")];
    })));
    r.appendChild(el("h2", LANG === "de" ? "Konflikte und Hinweise" : "Conflicts and notes"));
    var notes = plan.conflicts.map(function (c) { return [T.level[c.level], c.message]; }).concat(plan.warnings.map(function (w) { return [T.level.warn, w]; }));
    r.appendChild(notes.length ? table([LANG === "de" ? "Art" : "Type", LANG === "de" ? "Erklärung" : "Explanation"], notes) : el("p", T.none));
    var scripted = plan.posts.filter(function (p) { return plan.scripts[p.key]; });
    if (scripted.length) {
      r.appendChild(el("h2", T.script));
      scripted.forEach(function (p) {
        r.appendChild(el("h3", p.title));
        var d = scriptDetails(plan.scripts[p.key]);
        d.open = true;
        r.appendChild(d);
      });
    }
    if (plan.holidays.length) r.appendChild(el("p", T.region + (T.regions[plan.holiday_region] || plan.holiday_region) + ": " + plan.holidays.map(function (h) { return h.date + " " + h.name; }).join(", "), "fine"));
    r.appendChild(el("p", T.reportBasis.replace("{shift}", plan.shifts ? T.reportShift.replace("{n}", String(plan.shifts)) : ""), "fine"));
    r.appendChild(el("p", (LANG === "de" ? "Erstellt am " : "Created on ") + localToday(), "fine"));
    r.hidden = false;
    return true;
  }

  /* wiring */
  async function init() {
    try {
      var cat = await (await fetch("/api/v1/services")).json();
      (cat.services || []).forEach(function (s) { state.catalog[s.id] = s; });
      state.info = schemaInfo(await (await fetch("/openapi.json")).json());
    } catch (e) { msg("plan-msg", T.err.conn, true); return; }
    ["content-month-plan", "content-plan-shift"].forEach(function (id) {
      var s = service(id);
      var price = $(id === "content-month-plan" ? "price-plan" : "price-shift");
      price.textContent = s ? s.price_usdc + " USDC" : "–";
      if (!s || !s.enabled) {
        msg(id === "content-month-plan" ? "plan-msg" : "shift-msg", T.err.unavailable, true);
        var btn = $(id === "content-month-plan" ? "btn-check" : "btn-shift-check");
        btn.setAttribute("data-disabled", "1"); btn.disabled = true;
      }
    });
    renderForm();
  }

  $("f-mode-mix").addEventListener("change", toggleMode);
  $("f-mode-weekly").addEventListener("change", toggleMode);
  $("planner").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    if (state.busy) return;
    var input;
    try { input = buildMonthInput(formValues(), state.info, localToday()); } catch (e) { return msg("plan-msg", e.message, true); }
    setBusy(true);
    msg("plan-msg", T.checking);
    try {
      await preflight("content-month-plan", input);
      buyer.offer("plan", "content-month-plan", input); msg("plan-msg", T.checked);
    }
    catch (e) { msg("plan-msg", (e && e.message) || T.err.conn, true); }
    finally { setBusy(false); }
  });
  $("btn-buy-plan").addEventListener("click", async function () {
    var result = await buyer.purchase("plan");
    if (!result) return;
    state.plan = planFromResult(result);
    state.original = clone(state.plan);
    msg("plan-msg", T.bought);
    renderPlan();
    $("plan-view").scrollIntoView({ behavior: "smooth" });
  });
  $("btn-cancel-plan").addEventListener("click", function () { if (buyer.cancel("plan")) msg("plan-msg", T.cancelled); });
  // An offer is for exactly the checked input: editing the form withdraws it, so a purchase never pays for older values.
  ["input", "change"].forEach(function (ev) {
    $("planner").addEventListener(ev, function (e) { if (e.target.id !== "f-load" && !$("buy-plan").hidden && buyer.cancel("plan")) msg("plan-msg", ""); });
    $("shift-form").addEventListener(ev, function () { if (!$("buy-shift").hidden && buyer.cancel("shift")) msg("shift-msg", ""); });
  });
  $("s-step").addEventListener("change", moveModes);
  $("shift-form").addEventListener("submit", async function (ev) {
    ev.preventDefault();
    if (state.busy || !state.plan) return;
    var input;
    try {
      input = shiftInput(state.plan, { post_key: $("s-post").value, step: $("s-step").value, new_date: $("s-date").value, publish_mode: $("s-publish-mode").value, shoot_mode: $("s-shoot-mode").value }, state.info);
    } catch (e) { return msg("shift-msg", e.message, true); }
    setBusy(true);
    msg("shift-msg", T.checking);
    try {
      await preflight("content-plan-shift", input);
      buyer.offer("shift", "content-plan-shift", input); msg("shift-msg", T.shiftChecked);
    }
    catch (e) { msg("shift-msg", (e && e.message) || T.err.conn, true); }
    finally { setBusy(false); }
  });
  $("btn-buy-shift").addEventListener("click", async function () {
    var result = await buyer.purchase("shift");
    if (!result) return;
    state.shiftResult = result;
    renderShiftReview(result);
    msg("shift-msg", T.shiftBought);
  });
  $("btn-cancel-shift").addEventListener("click", function () { if (buyer.cancel("shift")) msg("shift-msg", T.cancelled); });
  $("btn-apply-shift").addEventListener("click", function () {
    if (!state.shiftResult) return;
    state.plan = applyShift(state.plan, state.shiftResult);
    state.shiftResult = null;
    $("shift-review").hidden = true;
    msg("shift-msg", T.applied);
    renderPlan();
  });
  $("btn-discard-shift").addEventListener("click", function () { state.shiftResult = null; $("shift-review").hidden = true; msg("shift-msg", T.discarded); });
  $("btn-restore").addEventListener("click", function () { state.plan = clone(state.original); msg("plan-msg", T.restored); renderPlan(); });
  $("dl-ics").addEventListener("click", function () {
    if (!state.plan) return;
    var stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    download(T.planFile + ".ics", "text/calendar", state.plan.ics || icsFromPlan(state.plan, stamp));
  });
  $("dl-plan").addEventListener("click", function () {
    if (!state.plan) return;
    download(T.planFile + ".json", "application/json", JSON.stringify(exportPlan(state, $("r-title").value), null, 2));
    msg("plan-msg", T.saved);
  });
  $("dl-receipt").addEventListener("click", function () {
    if (state.receipt) download(T.receipt + ".json", "application/json", JSON.stringify(state.receipt, null, 2));
  });
  $("f-load").addEventListener("change", function () {
    var file = this.files && this.files[0];
    this.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return msg("plan-msg", T.err.fileSize, true);
    file.text().then(function (text) {
      var loaded = importPlan(text);
      state.plan = loaded.plan;
      state.original = loaded.original;
      $("r-title").value = loaded.title || "";
      msg("plan-msg", T.loaded);
      renderPlan();
    }).catch(function (e) { msg("plan-msg", (e && e.message) || T.err.file, true); });
  });
  $("btn-buy-script").addEventListener("click", async function () {
    var key = state.scriptFor;
    var result = await buyer.purchase("script");
    if (!result || !state.plan) return;
    var script = cleanScript(result.recipes && result.recipes[0]);
    if (!script) return msg("script-msg", T.err.noRecipe, true);
    if (state.plan.posts.some(function (p) { return p.key === key; })) state.plan.scripts[key] = script;
    msg("script-msg", T.scriptBought);
    renderPlan();
  });
  $("btn-cancel-script").addEventListener("click", function () { if (buyer.cancel("script")) msg("script-msg", T.cancelled); });
  $("r-logo").addEventListener("change", function () {
    var file = this.files && this.files[0];
    this.value = ""; // nothing is kept in the file input
    if (!file) return;
    logoFromFile(file).then(function (dataUrl) { state.logo = dataUrl; msg("report-msg", T.logoLoaded); if (!$("report").hidden) renderReport(); })
      .catch(function (e) { state.logo = null; msg("report-msg", (e && e.message) || T.err.logoType, true); });
  });
  $("btn-logo-remove").addEventListener("click", function () { state.logo = null; msg("report-msg", T.logoRemoved); if (!$("report").hidden) renderReport(); });
  $("r-color").addEventListener("input", function () { state.color = COLOR_RE.test(this.value) ? this.value : null; if (!$("report").hidden) renderReport(); });
  $("btn-report").addEventListener("click", function () { if (state.plan && renderReport()) msg("report-msg", ""); });
  $("btn-print").addEventListener("click", function () { if (state.plan && renderReport()) window.print(); });
  // Printing via the browser menu (Ctrl/Cmd+P) also gets the current report instead of an almost empty page.
  window.addEventListener("beforeprint", function () { if (state.plan) renderReport(); });
  init();
})();
