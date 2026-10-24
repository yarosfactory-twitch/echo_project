// Дрібні помічники для рендеру.

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/** Оновлює innerHTML лише коли розмітка змінилась, щоб не збивати фокус у полях. */
export function patch(el, html) {
  if (el && el.__html !== html) {
    el.innerHTML = html;
    el.__html = html;
  }
}

export function fmtCountdown(endsAt, now = Date.now()) {
  if (!endsAt) return "";
  const s = Math.max(0, Math.ceil((endsAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const sourceLabel = (source) => (source === "youtube" ? "YouTube" : "SoundCloud");

/** Віяло карт сорочкою догори. */
export function fanHTML(count, max = 10) {
  const n = Math.min(count, max);
  let out = "";
  for (let i = 0; i < n; i++) {
    const angle = n > 1 ? -18 + (36 * i) / (n - 1) : 0;
    out += `<span class="sleeve back" style="--r:${angle.toFixed(1)}deg"></span>`;
  }
  return `<div class="fan">${out}</div>`;
}

export function podiumHTML(final) {
  if (!final?.length) return "";
  const [first, second, third] = final;
  const step = (p, cls) => p
    ? `<div class="step ${cls}"><div class="who">${esc(p.displayName)}</div><div class="pts">${p.score} б.</div><div class="block">${p.place}</div></div>`
    : `<div class="step ${cls} empty"></div>`;
  const rest = final.slice(3).map((p) =>
    `<li><span>${p.place}. ${esc(p.displayName)}${p.status === "out" ? " · вибув" : ""}</span><span>${p.score} б.</span></li>`).join("");
  return `<div class="podium">${step(second, "second")}${step(first, "first")}${step(third, "third")}</div>
    ${rest ? `<ol class="rest">${rest}</ol>` : ""}`;
}

/** Подія «Неоригінально!»: групи однакових треків і що з ними сталося. */
export function originalityHTML(groups = []) {
  if (!groups.length) return "";
  const block = (g) => {
    const state = g.decision === "burn" ? "burning" : g.decision === "keep" ? "kept" : "pending";
    const label = g.type === "exact"
      ? "Той самий трек"
      : g.decision === "burn" ? "Ведучий: однакові" : g.decision === "keep" ? "Ведучий: різні, лишаються" : "Схожі назви · ведучий вирішує";
    const cards = g.cards.map((c, i) => `<li class="sleeve face ${state}" style="--d:${i * 0.25}s">
        <span class="src">${sourceLabel(c.source)}</span><span class="title">${esc(c.title)}</span>
        <span class="author">${esc(c.displayName)}</span>
        ${state === "burning" ? `<span class="stamp">неоригінально</span>` : ""}</li>`).join("");
    return `<div class="dup-group ${g.type}"><div class="dup-label">${label}</div><ul class="deck dup-cards">${cards}</ul></div>`;
  };
  return `<div class="originality"><h2 class="dup-title">Неоригінально!</h2>
    <p class="muted center">Однакові треки згоряють у всіх, у кого вони є</p>${groups.map(block).join("")}</div>`;
}
