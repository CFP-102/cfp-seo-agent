// Live status only; the page is fully readable without JavaScript.
(async () => {
  const dot = document.getElementById("dot");
  const text = document.getElementById("status-text");
  try {
    const [health, catalog] = await Promise.all([
      fetch("/health", { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/v1/services", { cache: "no-store" }).then((r) => r.json()),
    ]);
    const enabled = new Map(catalog.services.map((s) => [s.id, s.enabled]));
    document.querySelectorAll(".card[data-id]").forEach((card) => {
      const on = enabled.get(card.dataset.id) !== false;
      card.dataset.enabled = String(on);
      const state = card.querySelector(".state");
      if (state) state.textContent = on ? "available" : "temporarily disabled";
    });
    const down = catalog.services.filter((s) => !s.enabled).length;
    dot.className = "dot ok";
    text.textContent = down === 0 ? "All services operational" : `${catalog.services.length - down} of ${catalog.services.length} services available`;
    if (health.data_source === "sandbox") text.textContent += " (sandbox data)";
  } catch {
    dot.className = "dot bad";
    text.textContent = "Status unavailable";
  }
})();
