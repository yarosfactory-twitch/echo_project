// Сторінка «Історія ігор» (history.html). Лише зіграні карти.
import { db, collection, getDocs, query, orderBy, limit } from "./firebase.js";
import { $, esc, sourceLabel, standingsHTML } from "./ui.js";
import { safeHref } from "./tracks.js";

const list = $("#history");

const snap = await getDocs(query(collection(db, "history"), orderBy("finishedAt", "desc"), limit(50)));
const games = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

list.innerHTML = games.length
  ? games.map(gameHTML).join("")
  : `<section class="panel center"><p class="muted">Ще не зіграно жодної гри.</p></section>`;

function gameHTML(g) {
  const date = g.finishedAt?.toDate?.().toLocaleDateString("uk-UA", { day: "numeric", month: "long", year: "numeric" }) ?? "";
  const rounds = (g.rounds ?? []).map((r) => {
    const plays = [...r.plays].sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0)).map((p, i) => `<li class="${i === 0 ? "top" : ""}">
        <a href="${esc(safeHref(p.url))}" target="_blank" rel="noopener">${esc(p.title)}</a>
        <span class="muted small">${sourceLabel(p.source)} · ${esc(p.displayName)}</span>
        <span class="score">${p.votes ?? 0}</span></li>`).join("");
    return `<div class="round"><h4>Раунд ${r.n}: ${esc(r.theme)}</h4><ol class="plays-list">${plays}</ol></div>`;
  }).join("");
  return `<article class="panel game">
    <header><h2>${esc(date)}</h2><span class="muted">${g.players?.length ?? 0} гравців</span></header>
    ${standingsHTML(g.players)}
    <details><summary>Треки по раундах</summary>${rounds}</details>
  </article>`;
}
