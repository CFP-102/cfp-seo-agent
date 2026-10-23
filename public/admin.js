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
    free_samples: "Free samples", quotes: "Price quotes (402)", mcp_calls: "MCP calls", wishes: "Wishes",
  };
  var CHARTS = [["paid_calls", "Paid calls / day"], ["revenue_usdc", "Revenue USDC / day"], ["free_samples", "Free samples / day"], ["quotes", "Price quotes (402) / day"], ["new_buyers", "New buyers / day"], ["probes", "Crawler probes / day"]];

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
