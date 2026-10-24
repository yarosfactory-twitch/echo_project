// Сторінка гравця (index.html).
import {
  db, ensureAnonUser, doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc, serverTimestamp,
} from "./firebase.js";
import { startLogin, consumeRedirect } from "./twitch.js";
import { resolveTrack, TrackError, formatTimecode } from "./tracks.js";
import { PHASE, PHASE_LABEL, deckSize } from "./game-logic.js";
import { MAX_PLAYERS } from "./config.js";
import { Reel } from "./reel.js";
import { $, esc, patch, fmtCountdown, sourceLabel, tableHTML, standingsHTML, originalityHTML } from "./ui.js";

const els = { me: $("#me"), status: $("#status"), main: $("#main"), table: $("#table") };

const S = {
  uid: null, gameId: undefined, game: null, players: [], me: null, // undefined = ще не знаємо
  request: undefined, // undefined = ще не знаємо, null = заявки немає
  deck: null, round: null, move: null,
  busy: false, error: "", selected: null,
};

let pendingToken = consumeRedirect();
const reel = new Reel($("#reel")); // гравці бачать обертання, звук іде зі стріму
let landedSpin = null;
let gameSubs = [];
let roundSubs = [];
let roundKey = null;

const gref = (...path) => doc(db, "games", S.gameId, ...path);
const isClassic = () => S.game?.settings?.mode !== "hardcore";

// ── Підписки ────────────────────────────────────────────────
S.uid = (await ensureAnonUser()).uid;

onSnapshot(doc(db, "meta", "active"), (snap) => {
  const id = snap.data()?.gameId ?? null;
  if (id !== S.gameId) subscribeGame(id);
});

function subscribeGame(id) {
  [...gameSubs, ...roundSubs].forEach((off) => off());
  gameSubs = []; roundSubs = []; roundKey = null;
  Object.assign(S, { gameId: id, game: null, players: [], me: null, request: undefined, deck: null, round: null, move: null, selected: null });
  render();
  if (!id) return;

  gameSubs.push(
    onSnapshot(gref(), (s) => { S.game = s.data() ?? null; syncRound(); render(); }),
    onSnapshot(collection(db, "games", id, "players"), (s) => {
      S.players = s.docs.map((d) => ({ uid: d.id, ...d.data() }));
      S.me = S.players.find((p) => p.uid === S.uid) ?? null;
      render();
    }),
    onSnapshot(gref("joinRequests", S.uid),
      (s) => { S.request = s.exists() ? s.data() : null; maybeSendToken(); render(); },
      () => { S.request = null; maybeSendToken(); }),
    onSnapshot(gref("decks", S.uid),
      (s) => { S.deck = s.data()?.cards ?? []; render(); },
      () => { S.deck = []; }),
  );
}

function syncRound() {
  const n = S.game?.round ?? 0;
  const key = `${S.gameId}/${n}`;
  if (key === roundKey) return;
  roundSubs.forEach((off) => off());
  roundSubs = []; roundKey = key; S.round = null; S.move = null; S.selected = null;
  if (!n) return;
  roundSubs.push(
    onSnapshot(gref("rounds", String(n)), (s) => { S.round = s.data() ?? null; render(); }),
    onSnapshot(gref("rounds", String(n), "moves", S.uid),
      (s) => { S.move = s.data() ?? null; render(); },
      () => { S.move = null; }),
  );
}

/** Після повернення з Twitch передаємо токен ведучому на перевірку. */
async function maybeSendToken() {
  if (!pendingToken || !S.gameId || S.request === undefined || S.me) return;
  const token = pendingToken;
  pendingToken = null;
  try {
    if (S.request) await deleteDoc(gref("joinRequests", S.uid));
    await setDoc(gref("joinRequests", S.uid), { token, createdAt: serverTimestamp() });
  } catch (e) {
    S.error = "Не вдалося надіслати заявку: " + e.message;
    render();
  }
}

// ── Дії ─────────────────────────────────────────────────────
const actions = {
  join: () => startLogin(),
  async removeCard(key) {
    const cards = S.deck.filter((c) => c.key !== key);
    if (isClassic()) await deleteDoc(gref("tracks", key)).catch(() => {});
    await setDoc(gref("decks", S.uid), { cards });
    await updateDoc(gref("players", S.uid), { cardCount: cards.length, ready: false });
  },
  async toggleReady() {
    const full = S.deck.length === deckSize(S.game.settings);
    if (!full && !S.me.ready) return;
    await updateDoc(gref("players", S.uid), { ready: !S.me.ready });
  },
  select(key) { S.selected = key; render(); },
  async discard() { await sendMove("discard"); },
  async pass() { await sendMove("pass"); },
  async leave() {
    const inLobby = S.game.phase === PHASE.LOBBY;
    const text = inLobby
      ? "Вийти з лобі? Твоє місце звільниться, а колоду доведеться збирати заново."
      : "Вийти з гри? Ти вибудеш, твої бали лишаться в таблиці, а голосувати в чаті ти зможеш і далі.";
    if (!confirm(text)) return;
    // У лобі ведучий побачить status=out і прибере місце та колоду.
    await updateDoc(gref("players", S.uid), { status: "out", ready: false });
  },
};

async function sendMove(type) {
  if (!S.selected || S.move) return;
  await setDoc(gref("rounds", String(S.game.round), "moves", S.uid), { type, cardKey: S.selected, at: serverTimestamp() });
}

async function addCard(url) {
  const need = deckSize(S.game.settings);
  if (!url || S.busy || S.deck.length >= need) return;
  S.busy = true; S.error = ""; render();
  try {
    const track = await resolveTrack(url);
    if (S.deck.some((c) => c.key === track.key)) throw new TrackError("Цей трек уже є у твоїй колоді");
    if (isClassic()) {
      // Класичний режим: реєстр tracks/{key} можна лише створити. Якщо трек
      // уже взяв інший гравець, правила відмовлять, і ми просимо інший.
      try {
        await setDoc(gref("tracks", track.key), { uid: S.uid });
      } catch {
        throw new TrackError("Цей трек уже взяв інший гравець, обери інший");
      }
    } else if ((S.game.burned ?? []).includes(track.key)) {
      // Хардкор: про збіги дізнаються на старті. Згорілий трек повторно не додати.
      throw new TrackError("Цей трек уже згорів у цій грі як неоригінальний");
    }
    const cards = [...S.deck, { ...track, used: false }];
    await setDoc(gref("decks", S.uid), { cards });
    await updateDoc(gref("players", S.uid), { cardCount: cards.length, ready: false });
    $("#track-url") && ($("#track-url").value = "");
  } catch (e) {
    S.error = e instanceof TrackError ? e.message : "Щось пішло не так: " + e.message;
  } finally {
    S.busy = false; render();
  }
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.disabled) return;
  actions[btn.dataset.action]?.(btn.dataset.arg);
});
document.addEventListener("submit", (e) => {
  if (e.target.id !== "add-form") return;
  e.preventDefault();
  addCard($("#track-url").value.trim());
});

// ── Рендер ──────────────────────────────────────────────────
function render() {
  const canLeave = S.me?.status === "active" && S.game && S.game.phase !== PHASE.FINAL;
  patch(els.me, S.me ? `<span class="chip">${esc(S.me.displayName)} · ${S.me.score ?? 0} б.</span>
    ${canLeave ? `<button class="btn ghost small" data-action="leave">${S.game.phase === PHASE.LOBBY ? "Вийти з лобі" : "Вийти з гри"}</button>` : ""}` : "");
  syncReel();
  patch(els.status, viewStatus());
  patch(els.main, viewMain());
  patch(els.table, viewTable());
  applyJoinProgress();
  tick();
}

function viewStatus() {
  if (!S.game) return "";
  const g = S.game;
  const round = g.round ? ` · раунд ${g.round} з ${g.settings.rounds}` : "";
  const showTheme = g.theme && (g.phase !== PHASE.SPIN || landedSpin === g.spin?.id);
  const theme = showTheme ? `<div class="theme">${esc(g.theme)}</div>` : "";
  return `<div class="phase">${esc(PHASE_LABEL[g.phase] ?? g.phase)}${round}</div>${theme}<div id="countdown" class="countdown"></div>`;
}

function viewMain() {
  if (S.gameId === null) return `<section class="panel center"><h2>Зараз гри немає</h2><p class="muted">Заходь, коли ведучий відкриє лобі на стрімі.</p></section>`;
  if (!S.game) return `<p class="muted">Завантаження…</p>`;
  if (!S.me) return viewJoin();
  if (S.me.status === "out") {
    if (S.game.phase === PHASE.FINAL) return viewFinal();
    if (S.game.phase === PHASE.LOBBY) return `<section class="panel center"><h2>Виходимо з лобі…</h2></section>`;
    return `<section class="panel center"><h2>Ти вибув з гри</h2><p class="muted">Тепер можеш голосувати в чаті за будь-який трек.</p></section>${viewRound()}`;
  }
  switch (S.game.phase) {
    case PHASE.LOBBY: return viewDeckBuilder();
    case PHASE.ORIGINALITY: return `<section class="panel">${originalityHTML(S.game.originality?.groups)}</section>`;
    case PHASE.DISCARD: return viewHand();
    case PHASE.LISTEN: case PHASE.VOTE: case PHASE.RESULTS: return viewRound();
    case PHASE.FINAL: return viewFinal();
    case PHASE.TIEBREAK: return `<section class="panel center"><h2>Нічия!</h2><p class="muted">Ведучий визначає переможця.</p></section>`;
    case PHASE.SPIN: {
      const spun = S.game.spin?.round === S.game.round;
      const text = !spun ? "Зараз ведучий крутитиме барабан тем" : landedSpin === S.game.spin.id ? "Тема обрана. Чекаємо, поки ведучий почне раунд" : "Барабан крутиться…";
      return `<section class="panel center"><p class="muted">${text}</p></section>`;
    }
    default: return `<section class="panel center"><p class="muted">Ведучий готує наступний раунд…</p></section>`;
  }
}

function viewJoin() {
  const r = S.request;
  if (r?.status === "rejected") {
    return `<section class="panel center"><h2>Не вдалося приєднатися</h2><p class="error">${esc(r.reason)}</p>
      <button class="btn" data-action="join">Спробувати ще раз</button></section>`;
  }
  if (r || pendingToken) return JOIN_WAIT_HTML;
  const seats = S.players.filter((p) => p.status === "active").length;
  if (S.game.phase !== PHASE.LOBBY) {
    // TODO: вхід посеред гри (місця, N карт на решту раундів, найнижчий рахунок).
    return `<section class="panel center"><h2>Гра вже йде</h2><p class="muted">Голосуй у чаті номером треку.</p></section>${viewRound()}`;
  }
  if (seats >= MAX_PLAYERS) return `<section class="panel center"><h2>Лобі заповнене</h2><p class="muted">Голосуй у чаті, коли почнеться раунд.</p></section>`;
  return `<section class="panel center"><h2>Приєднатися до гри</h2>
    <p class="muted">Місць: ${seats} з ${MAX_PLAYERS}. Потрібен Twitch-акаунт, старший за 3 дні.</p>
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ""}
    <button class="btn primary" data-action="join">Увійти через Twitch</button></section>`;
}

function viewDeckBuilder() {
  const need = deckSize(S.game.settings);
  const deck = S.deck ?? [];
  const slots = [];
  for (let i = 0; i < need; i++) {
    const c = deck[i];
    slots.push(c
      ? `<li class="sleeve face"><span class="src">${sourceLabel(c.source)}${startBadge(c)}</span><span class="title">${esc(c.title)}</span>
          <button class="x" data-action="removeCard" data-arg="${esc(c.key)}" title="Прибрати">×</button></li>`
      : `<li class="sleeve empty">порожня карта</li>`);
  }
  const full = deck.length === need;
  return `<section class="panel">
    <h2>Твоя колода <span class="muted">${deck.length} / ${need}</span></h2>
    <p class="muted">Теми невідомі заздалегідь, тож бери різні треки. YouTube або SoundCloud.</p>
    <p class="muted small">Хочеш, щоб трек грав з певного моменту? Встав посилання з таймкодом: на YouTube «Поділитися → Почати з», на SoundCloud «Share → At».</p>
    <p class="muted small">${isClassic()
      ? "Класичний режим: якщо трек уже взяв інший гравець, сайт попросить обрати інший."
      : "Хардкор: якщо такий самий трек принесе ще хтось, на старті гри він згорить в обох. Ризикуєш, коли береш очевидні хіти."}</p>
    <form id="add-form" class="add">
      <input id="track-url" type="url" placeholder="Посилання на трек" ${full || S.busy ? "disabled" : ""} autocomplete="off">
      <button class="btn" ${full || S.busy ? "disabled" : ""}>${S.busy ? "Перевіряю…" : "Додати"}</button>
    </form>
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ""}
    <ul class="deck">${slots.join("")}</ul>
    <button class="btn ${S.me.ready ? "" : "primary"}" data-action="toggleReady" ${!full && !S.me.ready ? "disabled" : ""}>
      ${S.me.ready ? "Я не готовий" : "Готовий"}</button>
  </section>`;
}

function viewHand() {
  if (S.move) {
    const text = S.move.type === "pass" ? "Ти пасуєш у цьому раунді." : "Карту кинуто на стіл.";
    return `<section class="panel center"><h2>${text}</h2><p class="muted">Чекаємо на інших гравців.</p></section>`;
  }
  const hand = (S.deck ?? []).filter((c) => !c.used);
  if (!hand.length) {
    return `<section class="panel center"><h2>Карт не лишилось</h2>
      <p class="muted">Ти автоматично пасуєш у цьому раунді й лишаєшся за столом.</p></section>`;
  }
  const cards = hand.map((c) => `<li class="sleeve face pick ${S.selected === c.key ? "selected" : ""}" data-action="select" data-arg="${esc(c.key)}">
      <span class="src">${sourceLabel(c.source)}${startBadge(c)}</span><span class="title">${esc(c.title)}</span></li>`).join("");
  return `<section class="panel">
    <h2>Обери карту під тему</h2>
    <ul class="deck hand">${cards}</ul>
    <div class="row">
      <button class="btn primary" data-action="discard" ${S.selected ? "" : "disabled"}>Зіграти карту</button>
      <button class="btn" data-action="pass" ${S.selected ? "" : "disabled"} title="Обрана карта згорить, 0 балів за раунд">Пас</button>
    </div>
    <p class="muted small">Не встигнеш ні зіграти карту, ні пасувати — вибуваєш.</p>
  </section>`;
}

function viewRound() {
  const plays = S.round?.plays ?? [];
  if (!plays.length) return "";
  const revealed = new Set(S.game.revealed ?? []);
  const items = plays.map((p) => {
    const open = revealed.has(p.slot) || S.round.revealed;
    const playing = S.game.nowPlaying === p.slot ? " playing" : "";
    const author = S.round.revealed ? `<span class="author">${esc(p.displayName)} · ${p.votes ?? 0} гол.</span>` : "";
    return `<li class="sleeve ${open ? "face" : "back"}${playing}"><span class="num">${p.slot}</span>
      ${open ? `<span class="title">${esc(p.title)}</span>` : ""}${author}</li>`;
  }).join("");
  const hint = S.game.phase === PHASE.VOTE ? `<p class="hint">Пиши в чат номер треку, який сподобався найбільше</p>` : "";
  return `<section class="panel"><h2>Треки раунду</h2>${hint}<ul class="deck plays">${items}</ul></section>`;
}

function viewFinal() {
  return `<section class="panel center"><h2>Фінал</h2>${standingsHTML(S.game.final)}
    <p><a class="link" href="history.html">Історія ігор</a></p></section>`;
}

function viewTable() {
  if (!S.game || S.game.phase === PHASE.FINAL) return "";
  return tableHTML({ players: S.players, phase: S.game.phase, thrown: new Set(S.round?.thrown ?? []), meUid: S.uid });
}

const startBadge = (c) => (c.start ? ` · <span class="start">▶ з ${formatTimecode(c.start)}</span>` : "");


function syncReel() {
  const g = S.game;
  if (!g || g.phase !== PHASE.SPIN) { reel.hide(); return; }
  if (g.spin?.round !== g.round) { reel.idle(g.themesLeft ?? []); return; }
  // Сторінку відкрили вже після обертання — одразу показуємо результат.
  const fresh = Date.now() - (g.spin.at ?? 0) < g.spin.ms + 1500;
  reel.spin(g.spin, fresh, () => { landedSpin = g.spin.id; render(); });
}

// ── Очікування входу: кільце прогресу навколо платівки ──────
// Розмітка завжди однакова, тож patch() її не перестворює, і кільце
// плавно заповнюється (CSS transition). Крок і відсоток ставить applyJoinProgress().
const JOIN_WAIT_HTML = `<section class="panel center join-wait">
  <div class="ring-vinyl">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle class="ring-track" cx="60" cy="60" r="56"/>
      <circle id="join-ring" class="ring-bar" cx="60" cy="60" r="56" pathLength="100"/>
    </svg>
    <div class="vinyl"></div>
  </div>
  <h2 id="join-step">Надсилаю заявку…</h2>
  <p class="muted small">Сторінка ведучого перевіряє твій Twitch-акаунт.</p>
</section>`;

const JOIN_STEPS = {
  sending: [12, "Надсилаю заявку…"],
  queued: [30, "Чекаю на ведучого…"],
  token: [50, "Перевіряю вхід Twitch…"],
  profile: [70, "Дивлюсь акаунт…"],
  seat: [90, "Саджу за стіл…"],
};

function applyJoinProgress() {
  const ring = $("#join-ring");
  if (!ring) return;
  const key = S.request ? (S.request.step ?? "queued") : "sending";
  const [pct, label] = JOIN_STEPS[key] ?? JOIN_STEPS.queued;
  ring.style.strokeDashoffset = String(100 - pct);
  const el = $("#join-step");
  if (el && el.textContent !== label) el.textContent = label;
}

function tick() {
  const el = $("#countdown");
  if (el) el.textContent = fmtCountdown(S.game?.phaseEndsAt);
}
setInterval(tick, 250);
render();
