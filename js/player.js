// Сторінка гравця (index.html).
import {
  db, ensureAnonUser, doc, collection, onSnapshot, setDoc, updateDoc, deleteDoc, serverTimestamp,
  addDoc, query, where,
} from "./firebase.js";
import { startLogin, consumeRedirect } from "./twitch.js";
import { resolveTrack, TrackError, formatTimecode } from "./tracks.js";
import { PHASE, PHASE_LABEL, deckSize, lateJoinOpen } from "./game-logic.js";
import { MAX_PLAYERS } from "./config.js";
import { Reel } from "./reel.js";
import { VinylWheel } from "./wheel.js";
import { SHOP_ITEMS, priceOf } from "./shop.js";
import { $, esc, patch, fmtCountdown, sourceLabel, tableHTML, standingsHTML, originalityHTML, flipClass, plural, POINTS } from "./ui.js";

const els = { me: $("#me"), status: $("#status"), main: $("#main"), table: $("#table") };

const S = {
  uid: null, gameId: undefined, game: null, players: [], me: null, // undefined = ще не знаємо
  request: undefined, // undefined = ще не знаємо, null = заявки немає
  deck: null, round: null, move: null, myVote: null,
  busy: false, error: "", selected: null,
  myShop: [], tbSub: null, respinSent: null, doubleSent: null,
  // Чернетки полів (patch() перемальовує розмітку й інакше губить введене).
  draft: { swapKey: "", swapUrl: "", extraUrl: "", tbUrl: "" },
};

let pendingToken = consumeRedirect();
const reel = new Reel($("#reel")); // гравці бачать обертання, звук іде зі стріму
const wheel = new VinylWheel($("#wheel"));
let landedSpin = null;
let landedSpinAt = 0;
let landedWheel = null;
let gameSubs = [];
let roundSubs = [];
let roundKey = null;

const gref = (...path) => doc(db, "games", S.gameId, ...path);
const isClassic = () => S.game?.settings?.mode !== "hardcore";
/** Розмір колоди: у лобі — для всієї гри, у новачка посеред гри — на раунди, що лишились. */
const myDeckSize = () => (S.me?.status === "pending" ? S.me.need : deckSize(S.game.settings));
const isPending = () => S.me?.status === "pending";

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
  roundSubs = []; roundKey = key; S.round = null; S.move = null; S.selected = null; S.myVote = null;
  S.myShop = []; S.tbSub = null;
  if (!n) return;
  roundSubs.push(
    onSnapshot(gref("rounds", String(n)), (s) => { S.round = s.data() ?? null; render(); }),
    onSnapshot(gref("rounds", String(n), "moves", S.uid),
      (s) => { S.move = s.data() ?? null; render(); },
      () => { S.move = null; }),
    onSnapshot(gref("rounds", String(n), "votes", S.uid),
      (s) => { S.myVote = s.data()?.slot ?? null; render(); },
      () => { S.myVote = null; }),
    onSnapshot(query(collection(db, "games", S.gameId, "rounds", String(n), "shop"), where("uid", "==", S.uid)),
      (s) => { S.myShop = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
      () => { S.myShop = []; }),
    onSnapshot(gref("rounds", String(n), "tb", S.uid),
      (s) => { S.tbSub = s.data() ?? null; render(); },
      () => { S.tbSub = null; }),
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
    const full = S.deck.length >= myDeckSize();
    if (!full && !S.me.ready) return;
    await updateDoc(gref("players", S.uid), { ready: !S.me.ready });
  },
  select(key) { S.selected = key; render(); },
  async discard() { await sendMove("discard"); },
  async buy(arg) {
    const [item, extra] = String(arg).split(":");
    if (S.game.phase !== PHASE.SHOP || S.me?.status !== "active" || S.busy) return;
    const data = { uid: S.uid, item, arg: extra ?? null, card: null, at: serverTimestamp() };
    S.error = "";
    if (item === "swap" || item === "extraCard") {
      const url = item === "swap" ? S.draft.swapUrl : S.draft.extraUrl;
      if (item === "swap" && !S.draft.swapKey) { S.error = "Обери карту, яку замінити"; render(); return; }
      if (!url) { S.error = "Встав посилання на новий трек"; render(); return; }
      S.busy = true; render();
      try {
        const track = await resolveTrack(url);
        if ((S.deck ?? []).some((c) => c.key === track.key)) throw new TrackError("Цей трек уже є у твоїй колоді");
        data.card = { key: track.key, source: track.source, id: track.id ?? null, embed: track.embed ?? null, url: track.url, title: track.title, author: track.author ?? "", start: track.start ?? 0 };
        if (item === "swap") data.arg = S.draft.swapKey;
      } catch (e) {
        S.error = e instanceof TrackError ? e.message : "Не вдалося перевірити трек: " + e.message;
        S.busy = false; render(); return;
      }
      S.busy = false;
    }
    await addDoc(collection(db, "games", S.gameId, "rounds", String(S.game.round), "shop"), data);
    if (item === "swap") { S.draft.swapUrl = ""; S.draft.swapKey = ""; }
    if (item === "extraCard") S.draft.extraUrl = "";
    render();
  },
  async useDouble() {
    if (!canDouble()) return;
    S.doubleSent = S.game.round; render();
    await setDoc(gref("rounds", String(S.game.round), "double", S.uid), { at: serverTimestamp() });
  },
  async respin() {
    const g = S.game;
    if (!canRespin()) return;
    S.respinSent = g.spin.id; render();
    await setDoc(gref("rounds", String(g.round), "respin", S.uid), { spinId: g.spin.id, at: serverTimestamp() });
  },
  async submitTb() {
    if (S.game.phase !== PHASE.TB_SUBMIT || !isTied() || S.busy) return;
    const url = S.draft.tbUrl.trim();
    if (!url) return;
    S.busy = true; S.error = ""; render();
    try {
      const t = await resolveTrack(url);
      if ((S.deck ?? []).some((c) => c.key === t.key)) throw new TrackError("Цей трек уже був у твоїй колоді — потрібен новий");
      await setDoc(gref("rounds", String(S.game.round), "tb", S.uid), {
        key: t.key, source: t.source, id: t.id ?? null, embed: t.embed ?? null, url: t.url, title: t.title,
        author: t.author ?? "", start: t.start ?? 0, at: serverTimestamp(),
      });
      S.draft.tbUrl = "";
    } catch (e) {
      S.error = e instanceof TrackError ? e.message : "Не вдалося надіслати трек: " + e.message;
    } finally { S.busy = false; render(); }
  },
  async vote(slot) {
    const n = Number(slot);
    if (S.game.phase !== PHASE.VOTE || !S.me || isMine(playBySlot(n))) return;
    S.myVote = n; render(); // одразу показуємо вибір, не чекаючи бази
    await setDoc(gref("rounds", String(S.game.round), "votes", S.uid), { slot: n, at: serverTimestamp() });
  },
  async pass() { await sendMove("pass"); },
  async leave() {
    const inLobby = S.game.phase === PHASE.LOBBY || isPending();
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
  const need = myDeckSize();
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
document.addEventListener("input", (e) => {
  const f = e.target.dataset?.draft;
  if (f && f in S.draft) {
    S.draft[f] = e.target.value;
    if (f === "swapKey") render();
  }
});

document.addEventListener("submit", (e) => {
  if (e.target.id !== "add-form") return;
  e.preventDefault();
  addCard($("#track-url").value.trim());
});

// ── Рендер ──────────────────────────────────────────────────
function render() {
  const canLeave = (S.me?.status === "active" || S.me?.status === "pending") && S.game && S.game.phase !== PHASE.FINAL;
  patch(els.me, S.me ? `<span class="chip">${esc(S.me.displayName)} · ${S.me.score ?? 0} б.</span>
    ${canLeave ? `<button class="btn ghost small" data-action="leave">${S.game.phase === PHASE.LOBBY ? "Вийти з лобі" : "Вийти з гри"}</button>` : ""}` : "");
  syncReel();
  syncWheel();
  patch(els.status, viewStatus());
  patch(els.main, viewMain());
  patch(els.table, viewTable());
  applyJoinProgress();
  tick();
}

function viewStatus() {
  if (!S.game) return "";
  const g = S.game;
  const round = g.tiebreak ? ` · тай-брейк` : g.round ? ` · раунд ${g.round} з ${g.settings.rounds}` : "";
  const showTheme = g.theme && (g.phase !== PHASE.SPIN || landedSpin === g.spin?.id);
  const theme = showTheme ? `<div class="theme">${esc(g.theme)}</div>` : "";
  const notice = g.tiebreak && g.tbNotice?.text ? `<div class="notice">🔥 ${esc(g.tbNotice.text)}</div>` : "";
  return `${notice}<div class="phase">${esc(PHASE_LABEL[g.phase] ?? g.phase)}${round}</div>${theme}<div id="countdown" class="countdown"></div>`;
}

// Фази, у яких гравцеві за столом показуємо його руку (у лобі — збір колоди, при виборі — вибір карти).
const SHOW_HAND = new Set([PHASE.ORIGINALITY, PHASE.SHOP, PHASE.SPIN, PHASE.LISTEN, PHASE.VOTE, PHASE.RESULTS, PHASE.TB_SUBMIT, PHASE.WHEEL]);

function viewMain() {
  const main = viewDoubleBar() + viewMainInner();
  return S.me?.status === "active" && S.game && SHOW_HAND.has(S.game.phase) ? main + viewMyHand() : main;
}

// Жетон подвоєння: використати в поточному раунді, поки не відкрито голосування.
const DOUBLE_PHASES = new Set([PHASE.SHOP, PHASE.SPIN, PHASE.DISCARD, PHASE.LISTEN]);
const doubledNow = () => S.game?.mods?.round === S.game?.round && (S.game.mods.double ?? []).includes(S.uid);
function canDouble() {
  const g = S.game;
  return !!g && !g.tiebreak && DOUBLE_PHASES.has(g.phase) && S.me?.status === "active"
    && (S.me.doubleTokens ?? 0) > 0 && !doubledNow() && S.doubleSent !== g.round;
}
function viewDoubleBar() {
  if (!S.game || S.me?.status !== "active" || S.game.tiebreak) return "";
  if (doubledNow()) return `<div class="double-bar on">✖2 Бали за цей раунд подвоєні</div>`;
  if (canDouble()) {
    return `<div class="double-bar"><span>У тебе ${S.me.doubleTokens === 1 ? "є жетон" : `${S.me.doubleTokens} жетони`} подвоєння</span>
      <button class="btn primary" data-action="useDouble">✖2 Подвоїти бали за цей раунд</button>
      <span class="muted small">до початку голосування</span></div>`;
  }
  if (S.doubleSent === S.game.round && DOUBLE_PHASES.has(S.game.phase)) return `<div class="double-bar">Подвоєння надіслано…</div>`;
  return "";
}

/** Мої карти: що ще в руці, а що вже зіграно чи згоріло. */
function viewMyHand() {
  const deck = S.deck ?? [];
  if (!deck.length) return "";
  const hand = deck.filter((c) => !c.used);
  const gone = deck.filter((c) => c.used);
  const card = (c, cls = "") => `<li class="sleeve face ${cls}"><span class="src">${sourceLabel(c.source)}${startBadge(c)}</span><span class="title">${esc(c.title)}</span>
      ${c.burned ? `<span class="vote-badge mine">згоріла</span>` : c.used ? `<span class="vote-badge mine">зіграна</span>` : ""}</li>`;
  return `<section class="panel my-hand">
    <h2>Твої карти <span class="muted">${hand.length ? `у руці ${hand.length}` : "у руці порожньо"}</span></h2>
    ${hand.length ? `<ul class="deck compact-hand">${hand.map((c) => card(c)).join("")}</ul>` : `<p class="muted">Карт не лишилось: у наступних раундах автоматичний пас. Можна докупити в магазині.</p>`}
    ${gone.length ? `<details><summary>Зіграні та згорілі (${gone.length})</summary><ul class="deck compact-hand">${gone.map((c) => card(c, "gone")).join("")}</ul></details>` : ""}
  </section>`;
}

function viewMainInner() {
  if (S.gameId === null) return `<section class="panel center"><h2>Зараз гри немає</h2><p class="muted">Заходь, коли ведучий відкриє лобі на стрімі.</p></section>`;
  if (!S.game) return `<p class="muted">Завантаження…</p>`;
  if (!S.me) return viewJoin();
  if (isPending() && S.game.phase !== PHASE.FINAL) return viewDeckBuilder() + viewRound();
  if (S.me.status === "out") {
    if (S.game.phase === PHASE.FINAL) return viewFinal();
    if (S.game.phase === PHASE.TB_SUBMIT) return viewTbSubmit();
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
    case PHASE.SHOP: return viewShop();
    case PHASE.TB_SUBMIT: return viewTbSubmit();
    case PHASE.WHEEL: return `<section class="panel center"><h2>Знову нічия!</h2><p class="muted">Переможця обере голка на платівці.</p></section>`;
    case PHASE.SPIN: {
      const spun = S.game.spin?.round === S.game.round;
      const tb = S.game.tiebreak ? `<h2>Нічия! Тай-брейк</h2><p>${esc(tiedNames())}</p>` : "";
      const text = !spun ? "Зараз ведучий крутитиме барабан тем" : landedSpin === S.game.spin.id ? "Тема обрана. Чекаємо, поки ведучий почне раунд" : "Барабан крутиться…";
      const respin = canRespin()
        ? `<p><button class="btn primary" data-action="respin">🔄 Перекрутити (жетон: ${S.me.tokens})</button></p><p class="muted small">Не подобається тема? Можна перекрутити, поки ведучий не почав раунд</p>`
        : S.respinSent === S.game.spin?.id ? `<p class="muted small">Жетон надіслано…</p>` : "";
      return `<section class="panel center">${tb}<p class="muted">${text}</p>${respin}</section>`;
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
    if (!lateJoinOpen(S.game, S.players, MAX_PLAYERS)) {
      return `<section class="panel center"><h2>Гра вже йде</h2><p class="muted">Вхід у цю гру закрито. Голосуй у чаті номером треку.</p></section>${viewRound()}`;
    }
    return `<section class="panel center"><h2>Гра вже йде, але ще можна приєднатися</h2>
      <p class="muted">Збереш колоду на раунди, що лишились, і сядеш за стіл з наступного раунду з найнижчим рахунком.</p>
      ${S.error ? `<p class="error">${esc(S.error)}</p>` : ""}
      <button class="btn primary" data-action="join">Увійти через Twitch</button></section>${viewRound()}`;
  }
  if (seats >= MAX_PLAYERS) return `<section class="panel center"><h2>Лобі заповнене</h2><p class="muted">Голосуй у чаті, коли почнеться раунд.</p></section>`;
  return `<section class="panel center"><h2>Приєднатися до гри</h2>
    <p class="muted">Місць: ${seats} з ${MAX_PLAYERS}. Потрібен Twitch-акаунт, старший за 3 дні.</p>
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ""}
    <button class="btn primary" data-action="join">Увійти через Twitch</button></section>`;
}

function viewDeckBuilder() {
  const need = myDeckSize();
  const deck = S.deck ?? [];
  const slots = [];
  for (let i = 0; i < need; i++) {
    const c = deck[i];
    slots.push(c
      ? `<li class="sleeve face"><span class="src">${sourceLabel(c.source)}${startBadge(c)}</span><span class="title">${esc(c.title)}</span>
          <button class="x" data-action="removeCard" data-arg="${esc(c.key)}" title="Прибрати">×</button></li>`
      : `<li class="sleeve empty">порожня карта</li>`);
  }
  const full = deck.length >= need;
  return `<section class="panel">
    <h2>Твоя колода <span class="muted">${deck.length} / ${need}</span></h2>
    ${isPending() ? `<p class="hint">Гра вже йде: збери ${need} карт і натисни «Готовий». Ти сядеш за стіл на старті наступного раунду з найнижчим рахунком серед гравців.</p>` : ""}
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
    ${isPending() && S.me.ready ? `<p class="muted small">Чекаємо старту наступного раунду…</p>` : ""}
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

const playBySlot = (slot) => (S.round?.plays ?? []).find((p) => p.slot === slot);

/** Чи це мій трек: та сама зіграна карта з моєї колоди. Автори приховані до кінця
 *  голосування, але свою карту гравець і так знає. */
function isMine(play) {
  if (!play) return false;
  return (S.deck ?? []).some((c) => c.used && !c.burned && (c.url === play.url || (c.id && c.id === play.id && c.source === play.source)));
}

function viewRound() {
  const plays = S.round?.plays ?? [];
  if (!plays.length) return "";
  const revealed = new Set(S.game.revealed ?? []);
  const voting = S.game.phase === PHASE.VOTE && !!S.me; // голосувати на сайті можуть гравці (і вибулі)
  const items = plays.map((p) => {
    const open = revealed.has(p.slot) || S.round.revealed;
    const playing = S.game.nowPlaying === p.slot ? " playing" : "";
    const author = S.round.revealed ? `<span class="author">${esc(p.displayName)} · ${p.votes ?? 0} гол.</span>` : "";
    const mine = voting && isMine(p);
    const chosen = voting && S.myVote === p.slot;
    const click = voting && !mine ? ` data-action="vote" data-arg="${p.slot}" title="Проголосувати за №${p.slot}"` : "";
    const badge = mine ? `<span class="vote-badge mine">твій трек</span>` : chosen ? `<span class="vote-badge">твій голос</span>` : "";
    const flip = open ? flipClass(`${S.gameId}-${S.game.round}-${p.slot}`) : "";
    return `<li class="sleeve ${open ? "face" : "back"}${flip}${playing}${click ? " votable" : ""}${chosen ? " voted" : ""}${mine ? " mine" : ""}"${click}><span class="num">${p.slot}</span>
      ${open ? `<span class="title">${esc(p.title)}</span>` : ""}${author}${badge}</li>`;
  }).join("");
  const hint = S.game.phase !== PHASE.VOTE ? ""
    : voting
      ? `<p class="hint">Натисни на трек, який сподобався найбільше. Можна передумати: рахується останній голос, тут або в чаті</p>`
      : `<p class="hint">Пиши в чат номер треку, який сподобався найбільше</p>`;
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


const tiedNames = () => (S.game?.tiebreak?.tied ?? []).map((uid) => S.players.find((p) => p.uid === uid)?.displayName ?? "?").join(" · ");
const isTied = () => (S.game?.tiebreak?.tied ?? []).includes(S.uid);

/** Жетон повторного обертання: після зупинки барабана, поки ведучий не почав раунд. */
function canRespin() {
  const g = S.game;
  return g?.phase === PHASE.SPIN && S.me?.status === "active" && (S.me.tokens ?? 0) > 0
    && g.spin?.round === g.round && landedSpin === g.spin.id && S.respinSent !== g.spin.id;
}

const ITEM_ICON = { queue: "⏭", swap: "🔁", extraCard: "➕", double: "✖2", respin: "🔄" };

function viewShop() {
  const me = S.me;
  if (me.status !== "active") return `<section class="panel center"><h2>Магазин</h2><p class="muted">Купувати можуть гравці за столом.</p></section>`;
  const prices = S.game.settings.prices ?? {};
  const score = me.score ?? 0;
  const mine = S.myShop.slice().sort((a, b) => (b.at?.seconds ?? 0) - (a.at?.seconds ?? 0));
  const hasQueue = mine.some((r) => r.item === "queue" && r.status === "ok");
  const hand = (S.deck ?? []).filter((c) => !c.used);
  const d = S.draft;
  const cards = SHOP_ITEMS.map((item) => {
    const price = priceOf(score, prices[item.pct]);
    const poor = score < price;
    const off = poor || S.busy;
    let action = "";
    if (item.id === "queue") {
      action = hasQueue ? `<span class="muted small">куплено</span>`
        : `<button class="btn" data-action="buy" data-arg="queue:first" ${off ? "disabled" : ""}>Першим</button>
           <button class="btn" data-action="buy" data-arg="queue:last" ${off ? "disabled" : ""}>Останнім</button>`;
    } else if (item.id === "double") {
      action = `<button class="btn" data-action="buy" data-arg="double" ${off ? "disabled" : ""}>Купити</button>${me.doubleTokens ? `<span class="muted small">у тебе: ${me.doubleTokens}</span>` : ""}`;
    } else if (item.id === "respin") {
      action = `<button class="btn" data-action="buy" data-arg="respin" ${off ? "disabled" : ""}>Купити</button>${me.tokens ? `<span class="muted small">у тебе: ${me.tokens}</span>` : ""}`;
    } else if (item.id === "swap") {
      const opts = hand.map((c) => `<option value="${esc(c.key)}" ${d.swapKey === c.key ? "selected" : ""}>${esc(c.title)}</option>`).join("");
      action = `<select data-draft="swapKey"><option value="">— яку карту замінити —</option>${opts}</select>
        <input data-draft="swapUrl" type="url" placeholder="Посилання на новий трек" value="${esc(d.swapUrl)}">
        <button class="btn" data-action="buy" data-arg="swap" ${off || !hand.length ? "disabled" : ""}>Замінити</button>`;
    } else if (item.id === "extraCard") {
      action = `<input data-draft="extraUrl" type="url" placeholder="Посилання на новий трек" value="${esc(d.extraUrl)}">
        <button class="btn" data-action="buy" data-arg="extraCard" ${off ? "disabled" : ""}>Додати</button>`;
    }
    return `<li class="shop-item ${poor ? "poor" : ""}">
      <div class="shop-head"><span class="icon">${ITEM_ICON[item.id]}</span><b>${item.title}</b><span class="price">${plural(price, POINTS)}</span></div>
      <p class="muted small">${item.text}</p><div class="shop-act">${action}</div></li>`;
  }).join("");
  const log = mine.map((r) => {
    const item = SHOP_ITEMS.find((i) => i.id === r.item);
    const st = r.status === "ok" ? `✓ −${plural(r.price ?? 0, POINTS)}` : r.status === "rejected" ? `✗ ${esc(r.reason)}` : "обробляється…";
    return `<li><span>${esc(item?.title ?? r.item)}</span><span class="${r.status === "rejected" ? "error" : "muted"}">${st}</span></li>`;
  }).join("");
  return `<section class="panel">
    <h2>Магазин <span class="muted">у тебе ${plural(score, POINTS)}</span></h2>
    <p class="muted small">Бали — це і рахунок, і гроші. Ціна — відсоток від твоїх балів (мінімум 1). Купувати можна, поки ведучий не закрив магазин.</p>
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ""}
    <ul class="shop">${cards}</ul>
    ${log ? `<h3>Твої покупки</h3><ul class="shop-mine">${log}</ul>` : ""}
  </section>`;
}

function viewTbSubmit() {
  if (!isTied()) {
    return `<section class="panel center"><h2>Тай-брейк</h2><p class="muted">${esc(tiedNames())} обирають новий трек на тему. Скоро слухаємо!</p></section>`;
  }
  const sub = S.tbSub;
  const status = sub?.rejected
    ? `<p class="error">${esc(sub.rejected)}</p>`
    : sub?.key ? `<p class="hint">✓ Твій трек: ${esc(sub.title)}. Можеш замінити, поки не вийшов час.</p>` : "";
  return `<section class="panel">
    <h2>Тай-брейк: твій новий трек</h2>
    <p class="muted">Встав будь-який трек на тему, якого ще не було в цій грі. ${isClassic() ? "" : "Якщо принесеш те саме, що й суперник, — неоригінально!"}</p>
    ${status}
    ${S.error ? `<p class="error">${esc(S.error)}</p>` : ""}
    <div class="add">
      <input data-draft="tbUrl" type="url" placeholder="Посилання на трек" value="${esc(S.draft.tbUrl)}" ${S.busy ? "disabled" : ""}>
      <button class="btn primary" data-action="submitTb" ${S.busy ? "disabled" : ""}>${S.busy ? "Перевіряю…" : sub?.key ? "Замінити" : "Надіслати"}</button>
    </div>
  </section>`;
}

function syncWheel() {
  const g = S.game;
  if (!g || g.phase !== PHASE.WHEEL || !g.wheel) { wheel.hide(); return; }
  if (!g.wheel.id) {
    wheel.idle(g.wheel.uids.map((uid) => S.players.find((p) => p.uid === uid)).filter(Boolean));
    return;
  }
  const fresh = Date.now() - (g.wheel.at ?? 0) < g.wheel.ms + 1500;
  wheel.spin(g.wheel, fresh, () => { landedWheel = g.wheel.id; render(); });
}

function syncReel() {
  const g = S.game;
  if (!g || g.phase !== PHASE.SPIN) { reel.hide(); return; }
  if (g.spin?.round !== g.round) { reel.idle(g.themesLeft ?? []); return; }
  // Сторінку відкрили вже після обертання — одразу показуємо результат.
  const fresh = Date.now() - (g.spin.at ?? 0) < g.spin.ms + 1500;
  reel.spin(g.spin, fresh, () => {
    landedSpin = g.spin.id;
    landedSpinAt = fresh ? Date.now() : (g.spin.at ?? 0) + g.spin.ms;
    render();
  });
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
