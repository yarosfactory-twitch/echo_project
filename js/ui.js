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

/** Підсумок гри: зверху ті, хто дійшов до кінця, нижче вибулі.
 *  Обидва списки за балами (standings() уже сортує; переможець тай-брейку перший). */
export function standingsHTML(final) {
  if (!final?.length) return "";
  const byScore = (a, b) => (b.score ?? 0) - (a.score ?? 0);
  const finished = final.filter((p) => p.status !== "out");
  const out = final.filter((p) => p.status === "out").sort(byScore);
  const avatar = (p) => p.avatar
    ? `<img class="avatar" src="${esc(p.avatar)}" alt="" loading="lazy">`
    : `<span class="avatar empty">${esc((p.displayName || "?").slice(0, 1).toUpperCase())}</span>`;
  const row = (p, place) => `<li class="${place === 1 ? "winner" : ""}">
      ${place ? `<span class="place">${place}</span>` : ""}${avatar(p)}
      <span class="who">${esc(p.displayName)}</span>
      <span class="pts">${plural(p.score ?? 0, POINTS)}</span></li>`;
  return `<div class="standings">
    ${finished.length ? `<ol class="standings-list">${finished.map((p, i) => row(p, i + 1)).join("")}</ol>` : ""}
    ${out.length ? `<h3 class="standings-title">Вибули з гри</h3><ul class="standings-list out">${out.map((p) => row(p, 0)).join("")}</ul>` : ""}
  </div>`;
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

/** Українська множина: plural(1, ["карта","карти","карт"]) → "1 карта". */
export function plural(n, [one, few, many]) {
  const m10 = n % 10, m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${word}`;
}
export const CARDS = ["карта", "карти", "карт"];
export const POINTS = ["бал", "бали", "балів"];
