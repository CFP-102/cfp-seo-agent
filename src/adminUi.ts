/** Shared HTML helpers of the admin pages (escaped output only, no inline scripts or styles). */
export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type CellObj = { t: string | number | null | undefined; c?: string; title?: string };
export type Cell = string | number | null | undefined | CellObj;
const norm = (c: Cell): CellObj => (c !== null && typeof c === "object" ? c : { t: c });

const looksNumeric = (v: unknown) => /^-?\$?\d[\d.,]*%?$/.test(String(v ?? ""));
const short = (v: string | null | undefined) => (v && v.length > 18 ? `${v.slice(0, 8)}…${v.slice(-6)}` : v);
/** Wallet address / hash / id cell: shortened, full value on hover and in search. */
export const mono = (v: string | null | undefined): Cell => ({ t: short(v) ?? "", c: "mono", title: v ?? "" });
export const tag = (v: string, c: string): Cell => (v ? { t: v, c: `tag ${c}` } : "");

export function table(head: string[], rows: Cell[][]): string {
  if (!rows.length) return '<p class="empty">No data yet.</p>';
  const cell = (c: Cell) => {
    const o = norm(c);
    const cls = [o.c ?? "", looksNumeric(o.t) ? "num" : ""].filter(Boolean).join(" ");
    return `<td${cls ? ` class="${esc(cls)}"` : ""}${o.title ? ` title="${esc(o.title)}"` : ""}>${esc(o.t)}</td>`;
  };
  return `<div class="tablewrap"><table class="sortable"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr data-search="${esc(r.map((c) => { const o = norm(c); return `${o.t ?? ""} ${o.title ?? ""}`; }).join(" ").toLowerCase())}">${r.map(cell).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

/** Collapsible panel (native <details>, works without scripts). */
export function panel(title: string, body: string, opts: { open?: boolean; badge?: string; tone?: "bad" | "warn" | "" } = {}): string {
  const badge = opts.badge ? `<span class="badge ${opts.tone ?? ""}">${esc(opts.badge)}</span>` : "";
  return `<details class="panel"${opts.open === false ? "" : " open"}><summary><span class="chev"></span><span class="ptitle">${esc(title)}</span>${badge}</summary><div class="pbody">${body}</div></details>`;
}

export function kpi(label: string, value: string, sub = "", tone = ""): string {
  return `<div class="kpi ${tone}"><span class="klabel">${esc(label)}</span><span class="kvalue">${esc(value)}</span><span class="ksub">${esc(sub)}</span></div>`;
}

