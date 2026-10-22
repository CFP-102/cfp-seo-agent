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
