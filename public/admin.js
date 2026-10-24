// Admin helpers: search across tables, sortable columns, expand/collapse, remembered panel state. Loaded with CSP script-src 'self'.
(function () {
  "use strict";
  var panels = Array.prototype.slice.call(document.querySelectorAll("details.panel"));
  var q = document.getElementById("q");
  var count = document.getElementById("qcount");
  var KEY = "admin-panels";

  function title(p) { var t = p.querySelector(".ptitle"); return t ? t.textContent : ""; }
  function saved() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } }
  function save() {
    try {
      var s = {};
      panels.forEach(function (p) { s[title(p)] = p.open; });
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) { /* storage may be blocked: the page works without it */ }
  }
  var state = saved();
  panels.forEach(function (p) {
    if (Object.prototype.hasOwnProperty.call(state, title(p))) p.open = !!state[title(p)];
    p.addEventListener("toggle", function () { if (!q || !q.value) save(); });
  });

  document.getElementById("expand").addEventListener("click", function () { panels.forEach(function (p) { p.open = true; }); save(); });
  document.getElementById("collapse").addEventListener("click", function () { panels.forEach(function (p) { p.open = false; }); save(); });

  // Search: hide rows that do not match; open panels with matches while a query is active.
  if (q) {
    q.addEventListener("input", function () {
      var term = q.value.trim().toLowerCase();
      var shown = 0;
      var total = 0;
      panels.forEach(function (p) {
        var rows = p.querySelectorAll("tbody tr");
        var hits = 0;
        rows.forEach(function (r) {
          var ok = !term || (r.getAttribute("data-search") || "").indexOf(term) !== -1;
          r.hidden = !ok;
          total += 1;
          if (ok) { hits += 1; shown += 1; }
        });
        if (term && rows.length) p.open = hits > 0;
      });
      count.textContent = term ? shown + " of " + total + " rows" : "";
      if (!term) { var s = saved(); panels.forEach(function (p) { if (Object.prototype.hasOwnProperty.call(s, title(p))) p.open = !!s[title(p)]; }); }
    });
  }

  // Sortable columns (click a header). Numeric columns sort numerically.
  document.querySelectorAll("table.sortable").forEach(function (t) {
    var heads = t.querySelectorAll("th");
    heads.forEach(function (th, idx) {
      var firstRow = t.querySelector("tbody tr");
      if (firstRow && firstRow.children[idx] && firstRow.children[idx].classList.contains("num")) th.classList.add("numh");
      th.addEventListener("click", function () {
        var dir = th.classList.contains("asc") ? "desc" : "asc";
        heads.forEach(function (h) { h.classList.remove("asc", "desc"); });
        th.classList.add(dir);
        var body = t.querySelector("tbody");
        var rows = Array.prototype.slice.call(body.querySelectorAll("tr"));
        var num = function (s) { var n = parseFloat(String(s).replace(/[^0-9.\-]/g, "")); return isNaN(n) ? null : n; };
        rows.sort(function (a, b) {
          var x = a.children[idx].textContent, y = b.children[idx].textContent;
          var nx = num(x), ny = num(y);
          var c = nx !== null && ny !== null ? nx - ny : String(x).localeCompare(String(y));
          return dir === "asc" ? c : -c;
        });
        rows.forEach(function (r) { body.appendChild(r); });
      });
    });
  });
})();

// Live insights panel: fetches /admin/insights.json every 60 s and draws small SVG trend charts (no inline styles).
(function () {
  "use strict";
  var kpiBox = document.getElementById("ins-kpis");
  if (!kpiBox) return;
  var NS = "http://www.w3.org/2000/svg";
  var LABELS = {
    paid_calls: "Paid calls", revenue_usdc: "Revenue USDC", buyers: "Buyers (sum of daily)", new_buyers: "New buyers",
    free_samples: "Free samples", quotes: "Price quotes (402)", mcp_calls: "MCP calls", site_views_human: "Website visits", wishes: "Wishes",
  };
  var CHARTS = [["revenue_usdc", "Revenue USDC / day"], ["paid_calls", "Paid calls / day"], ["site_views_human", "Website visits / day"], ["site_views_bot", "Bot visits / day"], ["quotes", "Price quotes (402) / day"], ["free_samples", "Free samples / day"], ["mcp_calls", "MCP calls / day"], ["new_buyers", "New buyers / day"], ["probes", "Crawler probes / day"]];

  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  }
  function fmt(v) { return Math.abs(v) < 1 && v !== 0 ? Number(v).toFixed(3) : String(Math.round(v * 100) / 100); }

  function spark(series, key, title) {
    var box = el("div", null, "ins-chart");
    var values = series.map(function (d) { return Number(d[key]) || 0; });
    var max = Math.max.apply(null, values.concat([1]));
    var total = values.reduce(function (a, b) { return a + b; }, 0);
    box.appendChild(el("span", title, "klabel"));
    box.appendChild(el("span", fmt(total) + " in 30 days · today " + fmt(values[values.length - 1]), "ksub"));
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 300 60");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "spark");
    var step = 300 / values.length;
    values.forEach(function (v, i) {
      var h = Math.max(v > 0 ? 2 : 0.5, (v / max) * 56);
      var r = document.createElementNS(NS, "rect");
      r.setAttribute("x", String(i * step + 1));
      r.setAttribute("y", String(60 - h));
      r.setAttribute("width", String(Math.max(1, step - 2)));
      r.setAttribute("height", String(h));
      r.setAttribute("class", v > 0 ? "sp" : "sp zero");
      var t = document.createElementNS(NS, "title");
      t.textContent = series[i].day + ": " + fmt(v);
      r.appendChild(t);
      svg.appendChild(r);
    });
    box.appendChild(svg);
    return box;
  }

  function table(head, rows) {
    var wrap = el("div", null, "tablewrap");
    var t = el("table");
    var tr = el("tr");
    head.forEach(function (h) { tr.appendChild(el("th", h)); });
    var thead = el("thead"); thead.appendChild(tr); t.appendChild(thead);
    var tb = el("tbody");
    rows.forEach(function (r) {
      var row = el("tr");
      r.forEach(function (v) { var td = el("td", v === null || v === undefined ? "–" : v); if (typeof v === "number") td.className = "num"; row.appendChild(td); });
      tb.appendChild(row);
    });
    t.appendChild(tb); wrap.appendChild(t);
    return wrap;
  }

  function render(d) {
    kpiBox.textContent = "";
    d.kpis.forEach(function (k) {
      var tile = el("div", null, "kpi");
      tile.appendChild(el("span", (LABELS[k.key] || k.key) + " · 7 days", "klabel"));
      tile.appendChild(el("span", fmt(k.last_7d), "kvalue"));
      var ch = k.change_pct;
      var sub = el("span", ch === null ? (k.last_7d ? "new (no data the week before)" : "no data yet") : (ch >= 0 ? "▲ " : "▼ ") + Math.abs(ch) + " % vs. previous 7 days", "ksub " + (ch === null ? "" : ch >= 0 ? "up" : "down"));
      tile.appendChild(sub);
      kpiBox.appendChild(tile);
    });
    var charts = document.getElementById("ins-charts");
    charts.textContent = "";
    CHARTS.forEach(function (c) { charts.appendChild(spark(d.series, c[0], c[1])); });
    var sv = document.getElementById("ins-services");
    sv.textContent = "";
    sv.appendChild(table(["service", "price", "402 quotes", "free samples", "paid", "revenue USDC", "quote → paid %"], d.services.map(function (s) { return [s.id, s.price_usdc, s.quotes_7d, s.free_samples_7d, s.paid_7d, s.revenue_7d, s.quote_to_paid_pct]; })));
    var lc = document.getElementById("ins-locations");
    lc.textContent = "";
    lc.appendChild(d.locations.length ? table(["location", "code", "calls"], d.locations.map(function (l) { return [l.name, l.location_code, l.calls]; })) : el("p", "No data yet.", "empty"));
    document.getElementById("ins-updated").textContent = "Last update: " + new Date(d.generated_at).toLocaleTimeString();
  }

  function load() {
    fetch("/admin/insights.json", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) render(d); })
      .catch(function () { /* keep the last view */ });
  }
  load();
  setInterval(load, 60000);
})();

// Live panel: polls /admin/live.json every 5 s, animates numbers (count-up), new feed rows and hourly bars. Pauses while the tab is hidden.
(function () {
  "use strict";
  var root = document.getElementById("live");
  if (!root) return;
  var INTERVAL = 5000;
  var NS = "http://www.w3.org/2000/svg";
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var lastOk = Date.now();
  var timer = null;
  var seen = {};
  document.querySelectorAll("#lfeed li[data-id]").forEach(function (li) { seen[li.getAttribute("data-id")] = true; });

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; }
  function fmt(v, dec) { return dec ? Number(v).toFixed(3) : String(Math.round(v)); }

  // Count-up from the shown value to the new one; flashes the element when it changed.
  function countTo(node, to, dec) {
    var from = parseFloat(node.getAttribute("data-v"));
    if (isNaN(from)) from = 0;
    node.setAttribute("data-v", String(to));
    if (from === to) return;
    node.classList.remove("flash-up", "flash-down");
    void node.offsetWidth;
    node.classList.add(to > from ? "flash-up" : "flash-down");
    if (reduce) { node.textContent = fmt(to, dec); return; }
    var start = performance.now(), dur = 900;
    function frame(now) {
      var t = Math.min(1, (now - start) / dur);
      var e = 1 - Math.pow(1 - t, 3);
      node.textContent = fmt(from + (to - from) * e, dec);
      if (t < 1) requestAnimationFrame(frame); else node.textContent = fmt(to, dec);
    }
    requestAnimationFrame(frame);
  }

  function delta(sub, now, yest, dec, good) {
    var d = now - yest;
    var cls = "lsub";
    var txt = "yesterday " + fmt(yest, dec);
    if (d !== 0) {
      var up = d > 0;
      var positive = good === "down" ? !up : up;
      txt = (up ? "▲ " : "▼ ") + fmt(Math.abs(d), dec) + " vs. yesterday (" + fmt(yest, dec) + ")";
      cls += positive ? " up" : " down";
    }
    sub.className = cls;
    sub.textContent = txt;
  }

  function hourly(d) {
    var svg = document.getElementById("lhourly");
    if (!svg) return;
    var peak = 0.0001;
    d.hourly.forEach(function (h) { if (h.revenue_usdc > peak) peak = h.revenue_usdc; });
    var groups = svg.querySelectorAll("g.hr");
    var nowHour = new Date(d.generated_at).getUTCHours();
    d.hourly.forEach(function (h, i) {
      var g = groups[i];
      if (!g) return;
      var rp = g.querySelector(".hp"), rq = g.querySelector(".hq");
      var hp = (h.revenue_usdc / peak) * 56, hq = Math.min(56, h.requests * 4);
      rp.setAttribute("y", String(60 - hp)); rp.setAttribute("height", String(hp));
      rq.setAttribute("y", String(60 - hq)); rq.setAttribute("height", String(hq));
      g.classList.toggle("now", i === nowHour);
      var t = g.querySelector("title");
      if (t) t.textContent = ("0" + i).slice(-2) + ":00 UTC: " + h.revenue_usdc.toFixed(4) + " USDC, " + h.paid + " paid, " + h.requests + " requests";
    });
  }

  function feed(d) {
    var ul = document.getElementById("lfeed");
    var fresh = [];
    d.recent.forEach(function (r) { if (!seen[r.id]) fresh.push(r); });
    var firstLoad = !ul.querySelector("li[data-id]");
    ul.textContent = "";
    if (!d.recent.length) { ul.appendChild(el("li", "empty", "No requests yet.")); return; }
    d.recent.forEach(function (r) {
      var kind = r.paid ? (r.real ? "paid" : "test") : r.price_usdc === 0 ? "free" : "other";
      var li = el("li", "fi " + kind + (r.status === "failed" ? " fail" : "") + (!firstLoad && !seen[r.id] ? " fresh" : ""));
      li.setAttribute("data-id", r.id);
      li.appendChild(el("span", "ft", r.time.slice(11, 19)));
      li.appendChild(el("span", "fs", r.service));
      li.appendChild(el("span", "fp", kind === "paid" ? r.price_usdc.toFixed(4) + " USDC" : kind === "test" ? "testnet" : "free"));
      li.appendChild(el("span", "fw", r.payer || ""));
      li.appendChild(el("span", "fst", r.status + (r.cached ? " · cache" : "") + (r.error ? " · " + r.error : "")));
      ul.appendChild(li);
    });
    d.recent.forEach(function (r) { seen[r.id] = true; });
    if (fresh.length && !firstLoad) root.classList.add("pulse"), setTimeout(function () { root.classList.remove("pulse"); }, 1200);
  }

  function services(d) {
    var box = document.getElementById("lservices");
    box.textContent = "";
    if (!d.by_service.length) { box.appendChild(el("p", "empty", "Nothing yet today.")); return; }
    var max = 1;
    d.by_service.forEach(function (s) { max = Math.max(max, s.quotes + s.paid + s.free_samples); });
    d.by_service.forEach(function (s) {
      var row = el("div", "srow");
      row.appendChild(el("span", "sname", s.id));
      var svg = document.createElementNS(NS, "svg");
      svg.setAttribute("viewBox", "0 0 100 6"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("class", "sbar");
      [["sb-q", s.quotes + s.paid + s.free_samples], ["sb-p", s.paid]].forEach(function (p) {
        var r = document.createElementNS(NS, "rect");
        r.setAttribute("class", p[0]); r.setAttribute("width", String((p[1] / max) * 100)); r.setAttribute("height", "6");
        svg.appendChild(r);
      });
      row.appendChild(svg);
      row.appendChild(el("span", "snum", s.paid + " paid · " + s.quotes + " quotes · " + s.free_samples + " free · " + s.revenue_usdc.toFixed(4)));
      box.appendChild(row);
    });
  }

  function pages(d) {
    var box = document.getElementById("lpages");
    box.textContent = "";
    var rows = d.pages.filter(function (p) { return p.human || p.bot; });
    if (!rows.length) { box.appendChild(el("p", "empty", "No page views counted yet today.")); return; }
    var wrap = el("div", "tablewrap"), t = el("table"), thead = el("thead"), hr = el("tr");
    ["page", "visitors", "bots"].forEach(function (h) { hr.appendChild(el("th", null, h)); });
    thead.appendChild(hr); t.appendChild(thead);
    var tb = el("tbody");
    rows.forEach(function (p) { var tr = el("tr"); tr.appendChild(el("td", null, p.page)); tr.appendChild(el("td", "num", p.human)); tr.appendChild(el("td", "num", p.bot)); tb.appendChild(tr); });
    t.appendChild(tb); wrap.appendChild(t); box.appendChild(wrap);
  }

  function render(d) {
    lastOk = Date.now();
    root.classList.remove("offline");
    countTo(document.getElementById("lbigval"), d.today.revenue_usdc, true);
    document.getElementById("lbigsub").textContent = "this month " + d.month.revenue_usdc.toFixed(3) + " USDC · " + d.month.paid_calls + " paid calls";
    document.querySelectorAll("#ltiles .ltile").forEach(function (tile) {
      var key = tile.getAttribute("data-key");
      var val = tile.querySelector(".lval"), sub = tile.querySelector(".lsub");
      var dec = val.classList.contains("dec");
      countTo(val, Number(d.today[key]), dec);
      delta(sub, Number(d.today[key]), Number(d.yesterday[key]), dec, sub.getAttribute("data-good"));
    });
    hourly(d); feed(d); services(d); pages(d);
    var att = document.getElementById("lattention");
    att.textContent = d.needs_attention ? d.needs_attention + " need attention" : "all clear";
    att.classList.toggle("alert", d.needs_attention > 0);
    document.getElementById("luptime").textContent = "uptime today " + d.uptime_today_pct + " %";
  }

  function tick() {
    var age = Math.round((Date.now() - lastOk) / 1000);
    document.getElementById("lclock").textContent = new Date().toISOString().slice(11, 19) + " UTC";
    document.getElementById("lupdated").textContent = age < 2 ? "updated just now" : "updated " + age + " s ago";
    var ring = document.getElementById("lring");
    var frac = Math.min(1, (Date.now() - lastOk) / INTERVAL);
    ring.setAttribute("stroke-dashoffset", String(50.3 * frac));
    if (age > 20) root.classList.add("offline");
  }

  function load() {
    if (document.hidden) return;
    fetch("/admin/live.json", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d) render(d); })
      .catch(function () { /* keep the last view, the strip shows when it is stale */ });
  }
  var r0 = document.getElementById("lring");
  r0.setAttribute("stroke-dasharray", "50.3");
  r0.setAttribute("stroke-dashoffset", "0");
  timer = setInterval(load, INTERVAL);
  setInterval(tick, 500);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
  tick();
  window.addEventListener("beforeunload", function () { clearInterval(timer); });
})();
