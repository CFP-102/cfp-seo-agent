// Agency page: try a service for free or buy one call with a browser wallet (x402 v2, EIP-3009 USDC authorization).
// No keys are handled here: the wallet signs; the page only checks the quote and forwards the signature to this server.
(function () {
  "use strict";

  var USDC = { "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e" };
  var CHAIN = { "eip155:8453": 8453, "eip155:84532": 84532 };
  var DE_LANG = { 2276: "de", 2040: "de", 2756: "de" };
  var LANG = typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "de";
  var T = {
    de: {
      pending: "Ein Kauf ist noch ungeklärt. Nicht erneut bezahlen. Bitte den Support kontaktieren und Kaufzeit sowie Wallet-Adresse nennen.",
      storage: "Sicherer Kauf benötigt Browserspeicher und Web Locks. Bitte einen aktuellen Browser verwenden.",
      busy: "Ein Kauf läuft bereits in einem anderen Tab. Bitte warten.",
      another: "Der letzte Kauf ist abgeschlossen. Einen weiteren kostenpflichtigen Abruf starten?",
      format: "Unbekanntes Zahlungsformat.", noScheme: "Keine passende Zahlungsart (USDC auf Base) angeboten.", payTo: "Empfänger stimmt nicht mit dem Betreiber überein. Abbruch.",
      asset: "Unerwartete Währung. Abbruch.", price: "Preis weicht vom Katalog ab. Abbruch.", incomplete: "Zahlungsangaben unvollständig.",
      price_label: " Preis: ", free_yes: " Kostenlose Probe möglich.", free_no: " Keine kostenlose Probe.", buy: "Mit Wallet kaufen", freeTag: " · Probe gratis",
      labels: { keyword: "Suchbegriff", keywords: "Suchbegriffe (einer pro Zeile)", domain: "Domain", competitor: "Domain des Wettbewerbers", domains: "Domains (eine pro Zeile)", url: "Adresse der Seite (URL)" },
      noPlace: "Ohne Ort wird das ganze Land verwendet.", countryOnly: "Dieser Dienst arbeitet mit dem Land.", place: "Ort: ", code: "Code",
      paid: "Bezahlter Abruf", sample: "Kostenlose Probe", service: "Dienst", reqId: "Anfragekennung", sandbox: "Sandbox-Daten", field: "Feld", value: "Wert",
      testing: "Teste …", sampleDone: "Fertig. Kostenlose Probe für diesen Dienst heute verbraucht.", error: "Fehler", conn: "Verbindung fehlgeschlagen.",
      noWallet: "Keine Browser-Wallet gefunden. Installieren Sie z. B. Coinbase Wallet oder MetaMask als Browser-Erweiterung.", checking: "Prüfe Eingabe …", invalid: "Eingabe ungültig.",
      quote: "Hole Preis …", unexpected: "Unerwartete Antwort ({s}). Es wurde nichts bezahlt.", notConnected: "Wallet nicht verbunden.", switchNet: "Bitte in der Wallet auf das Netzwerk Base wechseln und erneut versuchen.",
      confirm: "Genau einen Abruf kaufen: {a} USDC an {t} (Betreiber). Fortfahren?", cancelled: "Abgebrochen. Es wurde nichts bezahlt.", settling: "Zahlung wird abgewickelt …",
      keep: " (bitte aufbewahren)", done: "Bezahlt und geliefert.", aborted: "Abgebrochen.", loadFail: "Dienste konnten nicht geladen werden.", file: "ergebnis",
    },
    en: {
      pending: "A purchase is still unresolved. Do not pay again. Contact support with the purchase time and wallet address.",
      storage: "Safe purchasing requires browser storage and Web Locks. Please use a current browser.",
      busy: "A purchase is already running in another tab. Please wait.",
      another: "The previous purchase is complete. Start another paid call?",
      format: "Unknown payment format.", noScheme: "No matching payment option (USDC on Base) offered.", payTo: "Recipient does not match the operator. Aborted.",
      asset: "Unexpected currency. Aborted.", price: "Price differs from the catalog. Aborted.", incomplete: "Payment details incomplete.",
      price_label: " Price: ", free_yes: " Free sample available.", free_no: " No free sample.", buy: "Buy with wallet", freeTag: " · free sample",
      labels: { keyword: "Search term", keywords: "Search terms (one per line)", domain: "Domain", competitor: "Competitor domain", domains: "Domains (one per line)", url: "Page address (URL)" },
      noPlace: "Without a place the whole country is used.", countryOnly: "This service works per country.", place: "Place: ", code: "code",
      paid: "Paid call", sample: "Free sample", service: "Service", reqId: "Request ID", sandbox: "sandbox data", field: "Field", value: "Value",
      testing: "Testing …", sampleDone: "Done. Today's free sample for this service is used.", error: "Error", conn: "Connection failed.",
      noWallet: "No browser wallet found. Install for example Coinbase Wallet or MetaMask as a browser extension.", checking: "Checking input …", invalid: "Invalid input.",
      quote: "Getting the price …", unexpected: "Unexpected answer ({s}). Nothing was paid.", notConnected: "Wallet not connected.", switchNet: "Please switch your wallet to the Base network and try again.",
      confirm: "Buy exactly one call: {a} USDC to {t} (operator). Continue?", cancelled: "Cancelled. Nothing was paid.", settling: "Settling payment …",
      keep: " (please keep it)", done: "Paid and delivered.", aborted: "Cancelled.", loadFail: "Services could not be loaded.", file: "result",
    },
  }[LANG];

  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function randomNonce(cryptoObj) {
    var b = new Uint8Array(32);
    cryptoObj.getRandomValues(b);
    return "0x" + Array.prototype.map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
  }

  /**
   * Check a 402 quote against what the page expects and build the PAYMENT-SIGNATURE header with the wallet's signature.
   * expect: { payTo, network, priceUsdc }; wallet: { address, signTypedData(typedDataJson) -> Promise<signature> }.
   * confirm(amountUsdc, payTo) is asked after all checks and BEFORE the wallet signs; returning false aborts.
   */
  async function buildPayment(paymentRequiredB64, expect, wallet, nowSeconds, cryptoObj, confirm) {
    var pr = JSON.parse(b64decode(paymentRequiredB64));
    if (pr.x402Version !== 2 || !Array.isArray(pr.accepts)) throw new Error(T.format);
    var req = pr.accepts.filter(function (a) { return a.scheme === "exact" && a.network === expect.network; })[0];
    if (!req) throw new Error(T.noScheme);
    if (String(req.payTo).toLowerCase() !== String(expect.payTo).toLowerCase()) throw new Error(T.payTo);
    if (String(req.asset).toLowerCase() !== USDC[expect.network]) throw new Error(T.asset);
    if (String(req.amount) !== String(Math.round(Number(expect.priceUsdc) * 1e6))) throw new Error(T.price);
    if (!req.extra || !req.extra.name || !req.extra.version) throw new Error(T.incomplete);
    var authorization = {
      from: wallet.address,
      to: req.payTo,
      value: String(req.amount),
      validAfter: "0",
      validBefore: String(nowSeconds + Math.min(Number(req.maxTimeoutSeconds) || 120, 600)),
      nonce: randomNonce(cryptoObj),
    };
    var typed = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      domain: { name: req.extra.name, version: req.extra.version, chainId: CHAIN[expect.network], verifyingContract: req.asset },
      message: authorization,
    };
    if (confirm && !(await confirm(Number(req.amount) / 1e6, req.payTo))) return null;
    var signature = await wallet.signTypedData(JSON.stringify(typed));
    var payload = { x402Version: 2, payload: { authorization: authorization, signature: signature }, extensions: pr.extensions, resource: pr.resource, accepted: req };
    return { header: b64encode(JSON.stringify(payload)), amountUsdc: Number(req.amount) / 1e6, payTo: req.payTo };
  }

  /** Persist a purchase BEFORE signing; never persist a signature or wallet key.
   * Web Locks serializes purchases across tabs. Uncertain outcomes stay blocked until reconciled.
   */
  function createPurchaseSession(storage, locks, send) {
    var key = "agent-data-api.browser-purchase.v1";
    function save(record) { storage.setItem(key, JSON.stringify(record)); }
    return {
      read: function () { return JSON.parse(storage.getItem(key) || "null"); },
      run: async function (authorize, confirmNew) {
        if (!storage || !locks) throw new Error(T.storage);
        return locks.request(key, { ifAvailable: true }, async function (lock) {
          if (!lock) throw new Error(T.busy);
          var record = JSON.parse(storage.getItem(key) || "null");
          if (record && record.state !== "completed") {
            if (!record.request_id || !record.result_token) throw new Error(T.pending + " " + record.started_at);
            // Read-only retrieval: never sign or replay a payment to recover a result.
            var recovered = await send("/api/v1/results/" + encodeURIComponent(record.request_id), {
              headers: { authorization: "Bearer " + record.result_token }, cache: "no-store",
            });
            var body = await recovered.json();
            if (recovered.ok && body.result !== undefined) {
              body.result_token = record.result_token;
              record.state = "completed";
              record.response = body;
              save(record);
              return { ok: true, body: body };
            }
            throw new Error(T.pending + " " + record.started_at + " · " + record.request_id);
          }
          if (record && !(await confirmNew())) return { ok: true, body: record.response };
          record = { state: "pending", started_at: new Date().toISOString() };
          save(record); // Fail closed when storage is disabled or full, before wallet interaction.
          var request;
          try {
            request = await authorize();
          } catch (e) {
            storage.removeItem(key); // No request was submitted; signing/validation failed.
            throw e;
          }
          if (!request) { storage.removeItem(key); return null; }
          record.path = request.path;
          record.input = request.input;
          save(record); // If this fails, keep the earlier pending marker and never submit.
          var response = await send(request.path, {
            method: "POST", headers: { "content-type": "application/json", "payment-signature": request.header },
            body: JSON.stringify(request.input),
          });
          var out = await response.json();
          record.request_id = out.request_id;
          record.result_token = out.result_token;
          record.response = out;
          if (response.ok && out.result !== undefined) record.state = "completed";
          save(record);
          return { ok: response.ok, body: out };
        });
      },
    };
  }

  // Exposed for tests (no effect on the page).
  if (typeof window !== "undefined") window.AgenturPay = { createPurchaseSession: createPurchaseSession, buildPayment: buildPayment, b64encode: b64encode, b64decode: b64decode };
  if (typeof document === "undefined" || !document.getElementById("tester")) return;

  var $ = function (id) { return document.getElementById(id); };
  var payTo = document.body.getAttribute("data-pay-to");
  var network = document.body.getAttribute("data-network");
  var services = [];
  var serpFamily = [];
  var cityCode = null;
  var lastResult = null;

  function msg(text, bad) {
    $("msg").textContent = text;
    $("msg").className = bad ? "fine bad" : "fine";
  }
  function el(tag, text, cls) {
    var e = document.createElement(tag);
    if (text !== undefined && text !== null) e.textContent = String(text);
    if (cls) e.className = cls;
    return e;
  }
  function current() {
    var id = $("svc").value;
    return services.filter(function (s) { return s.id === id; })[0];
  }

  function renderFields() {
    var s = current();
    var box = $("fields");
    box.textContent = "";
    if (!s) return;
    $("svc-info").textContent = s.summary + T.price_label + s.price_usdc + " USDC." + (s.free_sample ? T.free_yes : T.free_no);
    $("btn-free").disabled = !s.free_sample;
    $("btn-buy").textContent = T.buy + " (" + s.price_usdc + " USDC)";
    var ex = s.example_request || {};
    var labels = T.labels;
    Object.keys(ex).forEach(function (k) {
      if (k === "location_code" || k === "language_code") return;
      var label = el("label", null, "field");
      label.appendChild(el("span", labels[k] || k));
      var multi = Array.isArray(ex[k]);
      var input = document.createElement(multi ? "textarea" : "input");
      input.name = k;
      input.setAttribute("data-multi", multi ? "1" : "0");
      input.placeholder = multi ? ex[k].join("\n") : String(ex[k]);
      if (multi) input.rows = 4;
      label.appendChild(input);
      box.appendChild(label);
    });
    var local = serpFamily.indexOf(s.id) !== -1;
    $("loc-q").parentElement.hidden = !local;
    if (!local) cityCode = null;
    $("loc-chosen").textContent = local ? (cityCode ? "" : T.noPlace) : T.countryOnly;
  }

  function body() {
    var s = current();
    var out = {};
    var inputs = $("fields").querySelectorAll("input,textarea");
    for (var i = 0; i < inputs.length; i++) {
      var f = inputs[i];
      var v = f.value.trim();
      if (!v) continue;
      out[f.name] = f.getAttribute("data-multi") === "1" ? v.split(/\n+/).map(function (x) { return x.trim(); }).filter(Boolean) : v;
    }
    var country = Number($("country").value);
    out.location_code = cityCode && serpFamily.indexOf(s.id) !== -1 ? cityCode.code : country;
    out.language_code = DE_LANG[cityCode ? cityCode.country : country] || "en";
    return out;
  }

  function showResult(json, paid) {
    lastResult = json;
    $("ergebnis").hidden = false;
    $("res-meta").textContent = (paid ? T.paid : T.sample) + " · " + T.service + " " + json.service + " · " + T.reqId + " " + json.request_id + (json.data_source === "sandbox" ? " · " + T.sandbox : "");
    var box = $("res-tables");
    box.textContent = "";
    var result = json.result || {};
    var scalars = [];
    Object.keys(result).forEach(function (k) {
      var v = result[k];
      if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] !== null) {
        box.appendChild(el("h3", k));
        box.appendChild(table(v));
      } else if (v === null || typeof v !== "object") {
        scalars.push([k, v]);
      } else if (Array.isArray(v)) {
        scalars.push([k, v.join(", ")]);
      } else {
        scalars.push([k, JSON.stringify(v)]);
      }
    });
    if (scalars.length) {
      box.insertBefore(table(scalars.map(function (p) { var row = {}; row[T.field] = p[0]; row[T.value] = p[1]; return row; })), box.firstChild);
    }
    $("ergebnis").scrollIntoView({ behavior: "smooth" });
  }

  function table(rows) {
    var cols = [];
    rows.forEach(function (r) { Object.keys(r).forEach(function (c) { if (cols.indexOf(c) === -1) cols.push(c); }); });
    var wrap = el("div", null, "tablewrap");
    var t = el("table");
    var tr = el("tr");
    cols.forEach(function (c) { tr.appendChild(el("th", c)); });
    var thead = el("thead");
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = el("tbody");
    rows.forEach(function (r) {
      var row = el("tr");
      cols.forEach(function (c) {
        var v = r[c];
        row.appendChild(el("td", v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : v));
      });
      tb.appendChild(row);
    });
    t.appendChild(tb);
    wrap.appendChild(t);
    return wrap;
  }

  function download(name, type, text) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function csv() {
    var result = (lastResult && lastResult.result) || {};
    var key = Object.keys(result).filter(function (k) { return Array.isArray(result[k]) && result[k].length && typeof result[k][0] === "object"; })[0];
    if (!key) return "";
    var rows = result[key];
    var cols = Object.keys(rows[0]);
    var cell = function (v) {
      var s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return [cols.join(";")].concat(rows.map(function (r) { return cols.map(function (c) { return cell(r[c]); }).join(";"); })).join("\n");
  }

  async function freeTest(ev) {
    ev.preventDefault();
    var s = current();
    if (!s || !s.free_sample) return;
    msg(T.testing);
    try {
      var r = await fetch("/api/v1/free-sample/" + encodeURIComponent(s.id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body()) });
      var j = await r.json();
      if (!r.ok) return msg(j.message || j.error || T.error, true);
      msg(T.sampleDone);
      showResult(j, false);
    } catch (e) {
      msg(T.conn, true);
    }
  }

  async function buy() {
    var s = current();
    if (!s) return;
    var eth = window.ethereum;
    var b = body();
    try {
      var session = createPurchaseSession(window.localStorage, window.navigator.locks, fetch);
      var purchase = await session.run(async function () {
        if (!eth) throw new Error(T.noWallet);
        msg(T.checking);
        var pre = await fetch("/api/v1/preflight/" + encodeURIComponent(s.id), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
        var pj = await pre.json();
        if (!pre.ok) throw new Error(pj.message || pj.error || T.invalid);
        msg(T.quote);
        var quote = await fetch(s.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
        if (quote.status !== 402) throw new Error(T.unexpected.replace("{s}", String(quote.status)));
        var accounts = await eth.request({ method: "eth_requestAccounts" });
        var from = accounts && accounts[0];
        if (!from) throw new Error(T.notConnected);
        try {
          await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + CHAIN[network].toString(16) }] });
        } catch (e) {
          throw new Error(T.switchNet);
        }
        var pay = await buildPayment(quote.headers.get("payment-required"), { payTo: payTo, network: network, priceUsdc: s.price_usdc }, {
          address: from,
          signTypedData: function (json) { return eth.request({ method: "eth_signTypedData_v4", params: [from, json] }); },
        }, Math.floor(Date.now() / 1000), window.crypto, function (amount, to) {
          return window.confirm(T.confirm.replace("{a}", String(amount)).replace("{t}", to));
        });
        if (!pay) return null;
        msg(T.settling);
        return { path: s.path, input: b, header: pay.header };
      }, function () { return window.confirm(T.another); });
      if (!purchase) return msg(T.cancelled);
      var j = purchase.body;
      if (!purchase.ok) {
        showResult(j, true); // Preserve request id and result token in the downloadable JSON.
        return msg((j.message || j.error || T.error) + " " + T.pending, true);
      }
      msg(T.done);
      showResult(j, true);
    } catch (e) {
      var warning = (e && e.message) || T.aborted;
      try {
        var pending = session && session.read();
        if (pending && pending.state !== "completed") warning += " " + T.pending + " " + pending.started_at;
      } catch (_) { /* Keep the purchase blocked if storage cannot be read. */ }
      msg(warning, true);
    }
  }

  var searchTimer = null;
  function searchPlaces() {
    clearTimeout(searchTimer);
    var q = $("loc-q").value.trim();
    var list = $("loc-hits");
    if (q.length < 2) { list.hidden = true; cityCode = null; return; }
    searchTimer = setTimeout(async function () {
      try {
        var r = await fetch("/api/v1/locations?q=" + encodeURIComponent(q));
        var j = await r.json();
        list.textContent = "";
        (j.locations || []).slice(0, 8).forEach(function (l) {
          var li = el("li");
          var btn = el("button", l.name.split(",").slice(0, 3).join(", ") + " (" + l.type + ")", "hit");
          btn.type = "button";
          btn.addEventListener("click", function () {
            cityCode = { code: l.location_code, country: { DE: 2276, AT: 2040, CH: 2756 }[l.country_iso_code] };
            $("country").value = String(cityCode.country);
            $("loc-q").value = l.name.split(",")[0];
            $("loc-chosen").textContent = T.place + l.name + " (" + T.code + " " + l.location_code + ")";
            list.hidden = true;
          });
          li.appendChild(btn);
          list.appendChild(li);
        });
        list.hidden = !list.children.length;
      } catch (e) { list.hidden = true; }
    }, 250);
  }

  (async function init() {
    try {
      var cat = await (await fetch("/api/v1/services")).json();
      services = cat.services.filter(function (s) { return s.enabled; });
      var loc = await (await fetch("/api/v1/locations?q=berlin")).json();
      serpFamily = loc.usable_for || [];
      services.forEach(function (s) {
        var o = el("option", s.name + " – " + s.price_usdc + " USDC" + (s.free_sample ? T.freeTag : ""));
        o.value = s.id;
        $("svc").appendChild(o);
      });
      var pre = new URLSearchParams(location.search).get("dienst") || new URLSearchParams(location.search).get("service");
      if (pre && services.some(function (s) { return s.id === pre; })) $("svc").value = pre;
      renderFields();
      try {
        var previous = createPurchaseSession(window.localStorage, window.navigator.locks, fetch).read();
        if (previous && previous.state === "completed" && previous.response) showResult(previous.response, true);
        else if (previous) msg(T.pending + " " + previous.started_at, true);
      } catch (e) { msg(T.storage, true); }
    } catch (e) {
      msg(T.loadFail, true);
    }
  })();

  $("svc").addEventListener("change", renderFields);
  $("tester").addEventListener("submit", freeTest);
  $("btn-buy").addEventListener("click", buy);
  $("loc-q").addEventListener("input", searchPlaces);
  $("country").addEventListener("change", function () { cityCode = null; $("loc-q").value = ""; renderFields(); });
  $("dl-csv").addEventListener("click", function () { download(T.file + ".csv", "text/csv", csv()); });
  $("dl-json").addEventListener("click", function () { download(T.file + ".json", "application/json", JSON.stringify(lastResult, null, 2)); });
})();
