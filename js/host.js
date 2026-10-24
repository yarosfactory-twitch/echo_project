// Сторінка ведучого (host.html). Вона ж «сервер» гри:
// перевіряє Twitch-акаунти, веде фази, читає голоси з чату, рахує бали.
import {
  db, waitForUser, signInHost, signOut, auth,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, writeBatch, serverTimestamp, deleteField, increment, arrayUnion,
} from "./firebase.js";
import {
  HOST_UID, TWITCH_CLIENT_ID, TWITCH_CHANNEL, MIN_PLAYERS, MAX_PLAYERS,
  MIN_ACCOUNT_AGE_DAYS, CHAT_BOTS, DEFAULT_SETTINGS,
} from "./config.js";
import { validateToken, getTwitchUser, revokeToken, accountAgeDays } from "./twitch.js";
import { embedUrl, formatTimecode } from "./tracks.js";
import { VoteCollector } from "./votes.js";
import { findDuplicateGroups, burnPlan, burnedKeys } from "./originality.js";
import { connectChat } from "./chat.js";
import { Reel, SPIN_MS } from "./reel.js";
import {
  PHASE, PHASE_LABEL, MODE_LABEL, deckSize, shuffle, pickRandom, standings, leadersTie, DEFAULT_THEMES,
} from "./game-logic.js";
import { $, esc, patch, fmtCountdown, sourceLabel, podiumHTML, originalityHTML, plural, CARDS } from "./ui.js";

const els = {
  auth: $("#auth"), control: $("#control"), stage: $("#stage"), reel: $("#reel"), top: $("#top-stage"),
  player: $("#player"), seats: $("#seats"), log: $("#log"),
};

const S = {
  user: null, gameId: undefined, game: null, players: [], requests: [],
  round: null, moves: [], secret: null, themesPool: null,
  collector: null, chat: "off", logLines: [],
  // Чернетка форми «Нова гра». Тримаємо значення тут, бо перемальовування
  // панелі (patch) інакше скидає поля до значень за замовчуванням.
  form: {
    rounds: DEFAULT_SETTINGS.rounds, extraCards: DEFAULT_SETTINGS.extraCards,
    discardSeconds: DEFAULT_SETTINGS.discardSeconds, voteSeconds: DEFAULT_SETTINGS.voteSeconds,
    mode: DEFAULT_SETTINGS.mode, custom: "", pool: null,
  },
};
const busy = new Set();
const reel = new Reel(els.reel, { sound: true }); // звук обертання йде лише зі сторінки ведучого
let landedSpin = null; // id обертання, яке вже зупинилось (до цього тему не показуємо)
let gameSubs = [];
let roundSubs = [];
let roundKey = null;

const gref = (...path) => doc(db, "games", S.gameId, ...path);
const gcol = (...path) => collection(db, "games", S.gameId, ...path);
const activePlayers = () => S.players.filter((p) => p.status === "active");

function log(text) {
  S.logLines.unshift(`${new Date().toLocaleTimeString("uk-UA")} ${text}`);
  S.logLines.length = Math.min(S.logLines.length, 40);
  render();
}

/** Не дає двічі запустити ту саму дію (подвійний клік, таймер + кнопка). */
async function once(name, fn) {
  if (busy.has(name)) return;
  busy.add(name); render();
  try { await fn(); } catch (e) { console.error(e); log(`⚠ ${name}: ${e.message}`); }
  finally { busy.delete(name); render(); }
}

// ── Вхід ведучого ───────────────────────────────────────────
S.user = await waitForUser();
render();
if (isHost()) boot();

function isHost() { return S.user && S.user.uid === HOST_UID; }

function boot() {
  onSnapshot(doc(db, "meta", "active"), (s) => {
    const id = s.data()?.gameId ?? null;
    if (id !== S.gameId) subscribeGame(id);
  });
  onSnapshot(doc(db, "themes", "pool"), (s) => { S.themesPool = s.data()?.list ?? null; render(); });
  connectChat(TWITCH_CHANNEL, onChatMessage, (st) => { S.chat = st; render(); });
}

function subscribeGame(id) {
  [...gameSubs, ...roundSubs].forEach((off) => off());
  gameSubs = []; roundSubs = []; roundKey = null;
  Object.assign(S, { gameId: id, game: null, players: [], requests: [], round: null, moves: [], secret: null, collector: null });
  render();
  if (!id) return;
  gameSubs.push(
    onSnapshot(gref(), (s) => { S.game = s.data() ?? null; syncRound(); resumeVoting(); onMovesChanged(); render(); }),
    onSnapshot(gcol("players"), (s) => {
      S.players = s.docs.map((d) => ({ uid: d.id, ...d.data() }));
      for (const p of S.players) justSeated.delete(p.uid);
      cleanupLeftLobby();
      checkLastStanding();
      render();
    }),
    onSnapshot(gcol("joinRequests"), (s) => {
      S.requests = s.docs.map((d) => ({ uid: d.id, ...d.data() }));
      for (const r of S.requests) if (!r.status) queueVerify(r);
    }),
  );
}

function syncRound() {
  const n = S.game?.round ?? 0;
  const key = `${S.gameId}/${n}`;
  if (key === roundKey) return;
  roundSubs.forEach((off) => off());
  roundSubs = []; roundKey = key; S.round = null; S.moves = []; S.secret = null; S.collector = null;
  if (!n) return;
  roundSubs.push(
    onSnapshot(gref("rounds", String(n)), (s) => { S.round = s.data() ?? null; updatePlayer(); render(); }),
    onSnapshot(gcol("rounds", String(n), "moves"), (s) => {
      S.moves = s.docs.map((d) => ({ uid: d.id, ...d.data() }));
      onMovesChanged();
    }),
  );
}

// ── Перевірка заявок (замість Cloud Function) ───────────────
// Запити до Twitch для різних гравців ідуть паралельно. Послідовно (через
// seatLock) робиться лише сам вхід за стіл, щоб не перевищити 8 місць.
const verifying = new Set();
let seatLock = Promise.resolve();
const justSeated = new Set();

function queueVerify(req) {
  if (verifying.has(req.uid)) return;
  verifying.add(req.uid);
  verify(req)
    .catch((e) => log(`⚠ перевірка: ${e.message}`))
    .finally(() => verifying.delete(req.uid));
}

/** Крок для кільця прогресу в гравця. Не критично, тож помилки ігноруємо. */
const setStep = (ref, step) => updateDoc(ref, { step }).catch(() => {});

async function verify({ uid, token }) {
  const ref = gref("joinRequests", uid);
  const reject = async (reason, who = "?") => {
    await updateDoc(ref, { status: "rejected", reason, token: deleteField() });
    log(`✗ ${who}: ${reason}`);
  };
  setStep(ref, "token");
  const info = token ? await validateToken(token) : null;
  if (!info || info.client_id !== TWITCH_CLIENT_ID) return reject("Вхід Twitch недійсний, спробуй ще раз");
  setStep(ref, "profile");
  const user = await getTwitchUser(token, info.user_id);
  revokeToken(token);
  if (!user) return reject("Не вдалося отримати дані акаунту Twitch", info.login);
  setStep(ref, "seat");

  const run = seatLock.then(() => seat(uid, ref, user, reject));
  seatLock = run.catch(() => {});
  return run;
}

async function seat(uid, ref, user, reject) {
  const existing = S.players.find((p) => p.login === user.login);
  // Той самий браузер повернувся (перезавантажив сторінку) — місце вже його.
  if (existing && existing.uid === uid && existing.status === "active") { await deleteDoc(ref); return; }
  if (existing && existing.uid !== uid && existing.status === "active") {
    return reject("Цей Twitch-акаунт уже в грі з іншого браузера", user.login);
  }
  if (accountAgeDays(user.created_at) < MIN_ACCOUNT_AGE_DAYS) {
    return reject(`Акаунту має бути щонайменше ${MIN_ACCOUNT_AGE_DAYS} дні`, user.login);
  }
  if (S.game?.phase !== PHASE.LOBBY) return reject("Гра вже почалась", user.login); // TODO: вхід посеред гри
  // S.players оновлюється із затримкою, тож рахуємо й тих, кого щойно посадили.
  const taken = new Set([...activePlayers().map((p) => p.uid), ...justSeated]);
  taken.delete(uid);
  if (taken.size >= MAX_PLAYERS) return reject("Лобі заповнене", user.login);

  justSeated.add(uid);
  await setDoc(gref("players", uid), {
    login: user.login, displayName: user.display_name, avatar: user.profile_image_url,
    score: 0, status: "active", ready: false, cardCount: 0, joinedRound: S.game.round, joinedAt: serverTimestamp(),
  });
  await deleteDoc(ref);
  log(`✓ ${user.display_name} приєднався`);
}

// ── Фази гри ────────────────────────────────────────────────
const A = {
  signIn: async () => { S.user = await signInHost(); render(); if (isHost()) boot(); },
  signOut: async () => { await signOut(auth); location.reload(); },

  savePool: () => once("savePool", async () => {
    const list = lines(S.form.pool ?? (S.themesPool ?? DEFAULT_THEMES).join("\n"));
    await setDoc(doc(db, "themes", "pool"), { list });
    log(`Пул тем збережено: ${list.length}`);
  }),

  createGame: () => once("createGame", async () => {
    const f = S.form;
    const num = (v, min, max) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min; };
    const settings = {
      ...DEFAULT_SETTINGS,
      rounds: num(f.rounds, 1, 20),
      extraCards: num(f.extraCards, 0, 10),
      discardSeconds: num(f.discardSeconds, 15, 600),
      voteSeconds: num(f.voteSeconds, 10, 600),
      mode: f.mode === "hardcore" ? "hardcore" : "classic",
    };
    const themes = [...new Set([...(S.themesPool ?? DEFAULT_THEMES), ...lines(f.custom)])];
    const gameRef = doc(collection(db, "games"));
    await setDoc(gameRef, {
      phase: PHASE.LOBBY, round: 0, settings, themesLeft: themes, theme: null,
      phaseEndsAt: null, nowPlaying: null, revealed: [], final: null,
      originality: null, burned: [], createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, "meta", "active"), { gameId: gameRef.id });
    log(`Лобі відкрито: ${settings.rounds} раундів, ${deckSize(settings)} карт, ${MODE_LABEL[settings.mode]}`);
  }),

  closeGame: () => once("closeGame", async () => {
    if (S.game?.phase !== PHASE.FINAL && !confirm("Закрити гру без завершення?")) return;
    await setDoc(doc(db, "meta", "active"), { gameId: null });
  }),

  kick: (uid) => once(`kick-${uid}`, async () => {
    const p = S.players.find((x) => x.uid === uid);
    if (!p || !confirm(`Кікнути ${p.displayName}?`)) return;
    if (S.game.phase === PHASE.LOBBY) {
      const batch = writeBatch(db);
      const tracks = await getDocs(query(gcol("tracks"), where("uid", "==", uid)));
      tracks.forEach((t) => batch.delete(t.ref));
      batch.delete(gref("decks", uid));
      batch.delete(gref("players", uid));
      await batch.commit();
    } else {
      await updateDoc(gref("players", uid), { status: "out" });
    }
    log(`Кікнуто: ${p.displayName}`);
  }),

  startGame: () => once("startGame", async () => {
    if (!canStart()) return;
    if (S.game.settings.mode !== "hardcore") {
      // Класичний режим: дублікати не пускає вже лобі, перевірка не потрібна.
      await updateDoc(gref(), { phase: PHASE.SPIN, round: 1, theme: null, originality: null });
      log("Гра почалась");
      return;
    }
    const decks = await Promise.all(activePlayers().map(async (p) => ({
      uid: p.uid, displayName: p.displayName,
      cards: (await getDoc(gref("decks", p.uid))).data()?.cards ?? [],
    })));
    const groups = findDuplicateGroups(decks);
    if (!groups.length) {
      await updateDoc(gref(), { phase: PHASE.SPIN, round: 1, theme: null, originality: null });
      log("Гра почалась: усі треки оригінальні");
      return;
    }
    await updateDoc(gref(), { phase: PHASE.ORIGINALITY, originality: { groups } });
    const exact = groups.filter((g) => g.type === "exact").length;
    log(`Неоригінальні: ${exact} точних збігів, ${groups.length - exact} підозрілих`);
  }),

  /** arg = "<id групи>|burn" або "<id групи>|keep" */
  decide: (arg) => once("decide", async () => {
    const cut = arg.lastIndexOf("|");
    const id = arg.slice(0, cut);
    const decision = arg.slice(cut + 1);
    const groups = (S.game.originality?.groups ?? []).map((g) =>
      g.id === id && g.type === "title" ? { ...g, decision } : g);
    await updateDoc(gref(), { originality: { groups } });
  }),

  applyOriginality: () => once("applyOriginality", async () => {
    const groups = S.game.originality?.groups ?? [];
    if (groups.some((g) => g.decision === null)) return;
    const plan = burnPlan(groups);
    const batch = writeBatch(db);
    for (const [uid, keys] of plan) {
      const deckRef = gref("decks", uid);
      const cards = (await getDoc(deckRef)).data()?.cards ?? [];
      for (const c of cards) if (keys.has(c.key)) { c.used = true; c.burned = true; }
      batch.set(deckRef, { cards });
      batch.update(gref("players", uid), { cardCount: cards.filter((c) => !c.used).length });
    }
    batch.update(gref(), {
      phase: PHASE.SPIN, round: 1, theme: null,
      burned: [...new Set([...(S.game.burned ?? []), ...burnedKeys(groups)])],
    });
    await batch.commit();
    const total = [...plan.values()].reduce((n, k) => n + k.size, 0);
    log(`Згоріло карт: ${total}. Гра почалась`);
  }),

  // Барабан: результат обирається тут, клієнти лише анімують до нього.
  // TODO: жетон «Повторне обертання» (10 секунд після зупинки) — новий spin з тим самим раундом.
  spin: () => once("spin", async () => {
    if (spunThisRound()) return;
    const left = S.game.themesLeft ?? [];
    if (!left.length) { log("⚠ Теми закінчились, додай нові в пул"); return; }
    const theme = pickRandom(left);
    const list = shuffle(left);
    const n = S.game.round;
    await updateDoc(gref(), {
      theme, themesLeft: left.filter((t) => t !== theme),
      spin: { id: `${n}-${Date.now()}`, round: n, list, target: list.indexOf(theme), ms: SPIN_MS, at: Date.now() },
      nowPlaying: null, revealed: [],
    });
  }),

  startRound: () => once("startRound", async () => {
    if (!spunThisRound() || landedSpin !== S.game.spin.id) return;
    const n = S.game.round;
    await setDoc(gref("rounds", String(n)), { theme: S.game.theme, plays: [], thrown: [], revealed: false });
    await updateDoc(gref(), {
      phase: PHASE.DISCARD, phaseEndsAt: Date.now() + S.game.settings.discardSeconds * 1000,
    });
  }),

  closeDiscard: () => once("closeDiscard", closeDiscard),

  play: (slot) => once("play", async () => {
    // playNonce: повторний клік по тому самому треку перезапускає його з таймкоду.
    await updateDoc(gref(), { nowPlaying: Number(slot), playNonce: Date.now(), revealed: arrayUnion(Number(slot)) });
  }),

  openVote: () => once("openVote", async () => {
    await ensureCollector();
    S.collector.open = true;
    await updateDoc(gref(), { phase: PHASE.VOTE, phaseEndsAt: Date.now() + S.game.settings.voteSeconds * 1000 });
  }),

  closeVote: () => once("closeVote", closeVote),

  nextRound: () => once("nextRound", async () => {
    if (S.game.round >= S.game.settings.rounds) return finish();
    // TODO: магазин. Поки фаза SHOP — лише пауза перед колесом.
    await updateDoc(gref(), { round: S.game.round + 1, phase: PHASE.SHOP, theme: null, nowPlaying: null, revealed: [], phaseEndsAt: null });
  }),

  toSpin: () => once("toSpin", async () => { await updateDoc(gref(), { phase: PHASE.SPIN }); }),

  // TODO: справжній тай-брейк (тема заздалегідь, 3 хв на новий трек). Поки одразу колесо з ніками.
  randomWinner: () => once("randomWinner", async () => {
    const tied = activePlayers().filter((p) => (S.game.tied ?? []).includes(p.uid));
    const winner = pickRandom(tied);
    log(`Випадковий переможець: ${winner.displayName}`);
    await finalize(winner.uid);
  }),
};

/** Гравець натиснув «Вийти» в лобі (status → out): прибираємо його місце й колоду. */
function cleanupLeftLobby() {
  if (S.game?.phase !== PHASE.LOBBY) return;
  for (const p of S.players.filter((x) => x.status === "out")) {
    once(`leave-${p.uid}`, async () => {
      const batch = writeBatch(db);
      const tracks = await getDocs(query(gcol("tracks"), where("uid", "==", p.uid)));
      tracks.forEach((t) => batch.delete(t.ref));
      batch.delete(gref("decks", p.uid));
      batch.delete(gref("players", p.uid));
      await batch.commit();
      log(`${p.displayName} вийшов з лобі`);
    });
  }
}

const spunThisRound = () => S.game?.spin?.round === S.game?.round;

/** Барабан видно лише у фазі колеса. До обертання — спокійний список тем. */
function syncReel() {
  const g = S.game;
  if (!g || g.phase !== PHASE.SPIN) { reel.hide(); return; }
  if (!spunThisRound()) { reel.idle(g.themesLeft ?? []); return; }
  const fresh = Date.now() - (g.spin.at ?? 0) < g.spin.ms + 1500;
  reel.spin(g.spin, fresh, () => { landedSpin = g.spin.id; render(); });
}

function canStart() {
  const ps = activePlayers();
  const need = S.game ? deckSize(S.game.settings) : 0;
  return ps.length >= MIN_PLAYERS && ps.every((p) => p.ready && p.cardCount === need);
}

/** Без карт у руці гравець пасує автоматично і лишається за столом. */
const hasCards = (p) => (p.cardCount ?? 0) > 0;

function onMovesChanged() {
  if (S.game?.phase !== PHASE.DISCARD) return;
  const thrown = S.moves.map((m) => m.uid);
  if (S.round && (S.round.thrown ?? []).length !== thrown.length) {
    updateDoc(gref("rounds", String(S.game.round)), { thrown }).catch(() => {});
  }
  const waiting = activePlayers().filter((p) => hasCards(p) && !thrown.includes(p.uid));
  if (!waiting.length && activePlayers().length) A.closeDiscard();
}

async function closeDiscard() {
  if (S.game.phase !== PHASE.DISCARD) return;
  const n = S.game.round;
  const moves = new Map((await getDocs(gcol("rounds", String(n), "moves"))).docs.map((d) => [d.id, d.data()]));
  const batch = writeBatch(db);
  const plays = [];
  let stillIn = 0;

  for (const p of activePlayers()) {
    const move = moves.get(p.uid);
    const deckRef = gref("decks", p.uid);
    const cards = (await getDoc(deckRef)).data()?.cards ?? [];
    if (!move) {
      if (!cards.some((c) => !c.used)) { stillIn++; log(`${p.displayName}: карт немає, автоматичний пас`); continue; }
      batch.update(gref("players", p.uid), { status: "out" });
      log(`${p.displayName} не встиг і вибуває`);
      continue;
    }
    stillIn++;
    const card = cards.find((c) => c.key === move.cardKey && !c.used);
    if (!card) continue; // невалідна карта: 0 балів, нічого не згорає
    card.used = true;
    batch.set(deckRef, { cards });
    batch.update(gref("players", p.uid), { cardCount: cards.filter((c) => !c.used).length });
    if (move.type === "discard") plays.push({ p, card });
  }

  // TODO: плюшка «Черга» (перший/останній) змінює порядок після перемішування.
  const ordered = shuffle(plays).map((x, i) => ({ ...x, slot: i + 1 }));
  batch.set(gref("rounds", String(n)), {
    plays: ordered.map(({ slot, card }) => ({ slot, source: card.source, id: card.id, url: card.url, title: card.title, start: card.start ?? 0 })),
    revealed: false,
  }, { merge: true });
  batch.set(gref("secret", `round_${n}`), {
    slots: ordered.map(({ slot, p }) => ({ slot, uid: p.uid, login: p.login, displayName: p.displayName })),
  });
  batch.update(gref(), { phase: ordered.length ? PHASE.LISTEN : PHASE.RESULTS, phaseEndsAt: null, nowPlaying: null, revealed: [] });
  await batch.commit();
  if (stillIn <= 1) await finish();
}

let collectorLoading = null;
function ensureCollector() {
  if (S.collector) return Promise.resolve();
  collectorLoading ??= (async () => {
    const secret = (await getDoc(gref("secret", `round_${S.game.round}`))).data() ?? { slots: [] };
    S.secret = secret;
    S.collector = new VoteCollector({
      trackCount: secret.slots.length,
      slotAuthors: Object.fromEntries(secret.slots.map((s) => [s.slot, s.login])),
      bots: CHAT_BOTS,
    });
  })().finally(() => { collectorLoading = null; });
  return collectorLoading;
}

/** Сторінку перезавантажили посеред голосування: продовжуємо збирати голоси. */
function resumeVoting() {
  if (S.game?.phase !== PHASE.VOTE || S.collector?.open) return;
  ensureCollector().then(() => {
    if (S.game?.phase === PHASE.VOTE) { S.collector.open = true; render(); }
  });
}

function onChatMessage(login, message) {
  if (S.collector?.handle(login, message)) render();
}

async function closeVote() {
  if (S.game.phase !== PHASE.VOTE) return;
  await ensureCollector(); // після перезавантаження голоси до нього втрачені
  S.collector.open = false;
  const counts = S.collector.tally();
  const batch = writeBatch(db);
  // TODO: «Подвійний раунд» множить votes на 2 для власника жетона.
  for (const s of S.secret.slots) {
    batch.update(gref("players", s.uid), { score: increment(counts[s.slot] ?? 0) });
  }
  const plays = (S.round?.plays ?? []).map((p) => {
    const s = S.secret.slots.find((x) => x.slot === p.slot);
    return { ...p, uid: s?.uid ?? null, login: s?.login ?? "", displayName: s?.displayName ?? "?", votes: counts[p.slot] ?? 0 };
  });
  batch.update(gref("rounds", String(S.game.round)), { plays, revealed: true, voters: S.collector.voterCount });
  batch.update(gref(), { phase: PHASE.RESULTS, phaseEndsAt: null });
  await batch.commit();
  log(`Голосування закрито: ${S.collector.voterCount} голосів`);
}

async function finish() {
  const tied = leadersTie(S.players);
  if (tied.length > 1) {
    await updateDoc(gref(), { phase: PHASE.TIEBREAK, tied: tied.map((p) => p.uid), phaseEndsAt: null });
    log(`Нічия: ${tied.map((p) => p.displayName).join(", ")}`);
    return;
  }
  await finalize(tied[0]?.uid ?? null);
}

let finalizing = false;
async function finalize(winnerUid) {
  if (finalizing || S.game?.phase === PHASE.FINAL) return;
  finalizing = true;
  try { await writeFinal(winnerUid); } finally { finalizing = false; }
}

async function writeFinal(winnerUid) {
  const final = standings(S.players, winnerUid);
  const rounds = (await getDocs(gcol("rounds"))).docs
    .map((d) => ({ n: Number(d.id), ...d.data() }))
    .filter((r) => r.revealed)
    .sort((a, b) => a.n - b.n)
    .map((r) => ({ n: r.n, theme: r.theme, plays: r.plays.map(({ slot, source, url, title, displayName, login, votes }) => ({ slot, source, url, title, displayName, login, votes })) }));
  await setDoc(doc(db, "history", S.gameId), { finishedAt: serverTimestamp(), players: final, rounds });
  await updateDoc(gref(), { phase: PHASE.FINAL, final, phaseEndsAt: null, nowPlaying: null });
  log("Гру завершено");
}

/** Якщо всі інші вибули, той, хто лишився, перемагає. */
function checkLastStanding() {
  const phase = S.game?.phase;
  if (!phase || [PHASE.LOBBY, PHASE.FINAL, PHASE.TIEBREAK].includes(phase)) return;
  const active = activePlayers();
  if (active.length <= 1) once("lastStanding", () => finalize(active[0]?.uid ?? null));
}

// Таймери фаз.
setInterval(() => {
  const el = $("#countdown");
  if (el) el.textContent = fmtCountdown(S.game?.phaseEndsAt);
  const ends = S.game?.phaseEndsAt;
  if (!ends || Date.now() < ends) return;
  if (S.game.phase === PHASE.DISCARD) A.closeDiscard();
  if (S.game.phase === PHASE.VOTE) A.closeVote();
}, 250);

const lines = (text) => text.split("\n").map((t) => t.trim()).filter(Boolean);

// Поля форми пишуть у S.form одразу при введенні.
document.addEventListener("input", (e) => {
  const field = e.target.dataset?.field;
  if (!field || !(field in S.form)) return;
  S.form[field] = e.target.value;
  if (field === "mode") render(); // радіо: фокус втратити не страшно
  if (field === "rounds" || field === "extraCards") {
    // Не перемальовуємо, щоб не збити фокус у полі, що редагується.
    const el = $("#deck-count");
    if (el) el.textContent = deckSize({ rounds: Number(S.form.rounds) || 0, extraCards: Number(S.form.extraCards) || 0 });
  }
});

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.disabled) return;
  A[btn.dataset.action]?.(btn.dataset.arg);
});

// ── Плеєр ───────────────────────────────────────────────────
// iframe живе окремо від patch(), щоб трек не перезапускався при кожному рендері.
function updatePlayer() {
  const slot = S.game?.nowPlaying;
  const card = (S.round?.plays ?? []).find((p) => p.slot === slot);
  const src = card ? embedUrl(card) : "";
  const key = src ? `${src}#${S.game?.playNonce ?? 0}` : "";
  if (els.player.dataset.key === key) return;
  els.player.dataset.key = key;
  const from = card?.start ? ` · старт з ${formatTimecode(card.start)}` : "";
  els.player.innerHTML = src
    ? `<iframe src="${esc(src)}" allow="autoplay; encrypted-media" allowfullscreen></iframe>
       <a class="link small" href="${esc(card.url)}" target="_blank" rel="noopener">Не грає? Відкрити в новій вкладці</a><span class="muted small">${from}</span>`
    : "";
  if (card?.source === "soundcloud" && card.start) seekSoundCloud(els.player.querySelector("iframe"), card.start);
}

// SoundCloud не приймає час старту в адресі плеєра, тож перемотуємо через Widget API.
let scApi = null;
function loadSoundCloudApi() {
  scApi ??= new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "https://w.soundcloud.com/player/api.js";
    el.onload = () => resolve(window.SC);
    el.onerror = () => { scApi = null; reject(new Error("SoundCloud API не завантажився")); };
    document.head.append(el);
  });
  return scApi;
}

async function seekSoundCloud(iframe, startSec) {
  try {
    const SC = await loadSoundCloudApi();
    const widget = SC.Widget(iframe);
    widget.bind(SC.Widget.Events.READY, () => {
      widget.seekTo(startSec * 1000);
      widget.play();
    });
  } catch (e) {
    log(`⚠ ${e.message}: трек грає з початку`);
  }
}

// ── Рендер ──────────────────────────────────────────────────
function render() {
  patch(els.auth, viewAuth());
  if (!isHost()) { ["control", "stage", "seats", "log"].forEach((k) => patch(els[k], "")); reel.hide(); return; }
  syncReel();
  patch(els.control, viewControl());
  patch(els.stage, viewStage());
  patch(els.top, viewTop());
  patch(els.seats, viewSeats());
  patch(els.log, S.logLines.map((l) => `<li>${esc(l)}</li>`).join(""));
  updatePlayer();
}

function viewAuth() {
  if (!S.user || S.user.isAnonymous) {
    return `<button class="btn primary" data-action="signIn">Увійти як ведучий (Google)</button>`;
  }
  if (!isHost()) {
    return `<div class="panel"><p>Твій UID: <code>${esc(S.user.uid)}</code></p>
      <p class="muted small">Впиши його в <code>js/config.js</code> (HOST_UID) і у <code>firestore.rules</code>, опублікуй правила й онови сторінку.</p>
      <button class="btn ghost" data-action="signOut">Вийти</button></div>`;
  }
  const chat = { connected: "чат підключено", connecting: "підключаю чат…", disconnected: "чат відключено", error: "помилка чату (F12 → Console)", off: "чат…" }[S.chat];
  return `<span class="chip">${esc(S.user.displayName ?? "ведучий")}</span><span class="chip ${S.chat === "connected" ? "ok" : "warn"}">${chat}</span>`;
}

function viewControl() {
  const b = (action, label, opts = {}) =>
    `<button class="btn ${opts.primary ? "primary" : ""}" data-action="${action}" ${opts.arg != null ? `data-arg="${esc(opts.arg)}"` : ""} ${opts.disabled || busy.has(action) ? "disabled" : ""}>${label}</button>`;

  if (S.gameId === null) {
    const f = S.form;
    const pool = f.pool ?? (S.themesPool ?? DEFAULT_THEMES).join("\n");
    const radio = (value, title, hint) => `<label class="mode ${f.mode === value ? "on" : ""}">
        <input type="radio" name="mode" data-field="mode" value="${value}" ${f.mode === value ? "checked" : ""}>
        <span><b>${title}</b><span class="muted small">${hint}</span></span></label>`;
    return `<section class="panel"><h2>Нова гра</h2>
      <div class="grid">
        <label>Раундів <input data-field="rounds" type="number" value="${esc(f.rounds)}" min="1" max="20"></label>
        <label>Додаткових карт <input data-field="extraCards" type="number" value="${esc(f.extraCards)}" min="0" max="10"></label>
        <label>Скидання, с <input data-field="discardSeconds" type="number" value="${esc(f.discardSeconds)}" min="15"></label>
        <label>Голосування, с <input data-field="voteSeconds" type="number" value="${esc(f.voteSeconds)}" min="10"></label>
      </div>
      <p class="muted small">Карт у колоді: <b id="deck-count">${deckSize({ rounds: Number(f.rounds) || 0, extraCards: Number(f.extraCards) || 0 })}</b></p>
      <fieldset class="modes"><legend>Однакові треки</legend>
        ${radio("classic", "Класичний", "Сайт одразу каже, що трек уже взяв інший гравець, і просить інший")}
        ${radio("hardcore", "Хардкор", "Ніхто не знає про збіги, на старті однакові треки згоряють у всіх")}
      </fieldset>
      <label>Свої теми на цю гру (по одній у рядку)<textarea data-field="custom" rows="3">${esc(f.custom)}</textarea></label>
      ${b("createGame", "Відкрити лобі", { primary: true })}
      <details><summary>Постійний пул тем (${(S.themesPool ?? DEFAULT_THEMES).length})</summary>
        <textarea data-field="pool" rows="10">${esc(pool)}</textarea>${b("savePool", "Зберегти пул")}</details>
    </section>`;
  }
  if (!S.game) return "";
  const g = S.game;
  const plays = S.round?.plays ?? [];
  let body = "";
  switch (g.phase) {
    case PHASE.LOBBY: {
      const ps = activePlayers();
      body = `<p class="muted">Гравців: ${ps.length} / ${MAX_PLAYERS} · готові: ${ps.filter((p) => p.ready).length}</p>
        <p class="muted small">${g.settings.rounds} раундів · ${deckSize(g.settings)} карт · режим: ${MODE_LABEL[g.settings.mode === "hardcore" ? "hardcore" : "classic"]}</p>
        ${b("startGame", "Почати гру", { primary: true, disabled: !canStart() })}`;
      break;
    }
    case PHASE.ORIGINALITY: {
      const groups = g.originality?.groups ?? [];
      const pending = groups.filter((x) => x.decision === null).length;
      const rows = groups.filter((x) => x.type === "title").map((x) => `<div class="decide">
          <div class="small">${x.cards.map((c) => `<div>${esc(c.displayName)}: <a class="link" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a></div>`).join("")}</div>
          <div class="row">
            <button class="btn ${x.decision === "burn" ? "primary" : ""}" data-action="decide" data-arg="${esc(x.id)}|burn">Однакові, палимо</button>
            <button class="btn ${x.decision === "keep" ? "primary" : ""}" data-action="decide" data-arg="${esc(x.id)}|keep">Різні</button>
          </div></div>`).join("");
      body = `<p class="muted">Точні збіги горять автоматично.${rows ? " Схожі назви вирішуєш ти:" : ""}</p>${rows}
        ${b("applyOriginality", pending ? `Ще ${pending} на рішення` : "Спалити і почати гру", { primary: true, disabled: pending > 0 })}`;
      break;
    }
    case PHASE.SHOP:
      body = `<p class="muted">Магазин ще в розробці.</p>${b("toSpin", "До колеса", { primary: true })}`;
      break;
    case PHASE.SPIN: {
      const spun = spunThisRound();
      const landed = spun && landedSpin === g.spin.id;
      body = !spun
        ? `<p class="muted">Тем у барабані: ${(g.themesLeft ?? []).length}</p>${b("spin", "Крутити барабан", { primary: true, disabled: !(g.themesLeft ?? []).length })}`
        : landed
          ? `<p class="muted">Тема обрана. Прокоментуй і запускай раунд.</p>${b("startRound", "Почати раунд", { primary: true })}`
          : `<p class="muted">Барабан крутиться…</p>${b("startRound", "Почати раунд", { disabled: true })}`;
      break;
    }
    case PHASE.DISCARD:
      body = `<p class="muted">Скинули: ${S.moves.length} / ${activePlayers().filter(hasCards).length}</p>${b("closeDiscard", "Завершити скидання зараз")}`;
      break;
    case PHASE.LISTEN:
      body = `<div class="row">${plays.map((p) => b("play", `№${p.slot}`, { arg: p.slot, primary: g.nowPlaying === p.slot })).join("")}</div>
        ${b("openVote", "Відкрити голосування", { primary: true })}`;
      break;
    case PHASE.VOTE:
      body = `<div class="row">${plays.map((p) => b("play", `№${p.slot}`, { arg: p.slot })).join("")}</div>
        ${b("closeVote", "Закрити голосування зараз")}`;
      break;
    case PHASE.RESULTS:
      body = b("nextRound", g.round >= g.settings.rounds ? "До фіналу" : "Наступний раунд", { primary: true });
      break;
    case PHASE.TIEBREAK:
      body = `<p class="muted">Тай-брейк ще в розробці. Поки переможця обирає випадок.</p>${b("randomWinner", "Випадковий переможець", { primary: true })}`;
      break;
    case PHASE.FINAL:
      body = "";
      break;
  }
  return `<section class="panel"><h2>${esc(PHASE_LABEL[g.phase])}${g.round ? ` · раунд ${g.round}/${g.settings.rounds}` : ""}</h2>
    ${body}<div class="row end">${b("closeGame", g.phase === PHASE.FINAL ? "Закрити гру" : "Скасувати гру")}</div></section>`;
}

function viewStage() {
  if (!S.game) return `<div class="stage-empty"><img class="logo-big" src="img/logo.png" alt="Music Roulette"></div>`;
  const g = S.game;
  if (g.phase === PHASE.FINAL) return `<div class="stage-final">${podiumHTML(g.final)}</div>`;
  if (g.phase === PHASE.ORIGINALITY) return originalityHTML(g.originality?.groups);
  const plays = S.round?.plays ?? [];
  const revealed = new Set(g.revealed ?? []);
  // Клік по картці вмикає трек (те саме, що кнопки №1, №2… на панелі).
  const clickable = [PHASE.LISTEN, PHASE.VOTE, PHASE.RESULTS].includes(g.phase);
  const cards = plays.map((p) => {
    const open = revealed.has(p.slot) || S.round.revealed;
    const author = S.round.revealed ? `<span class="author">${esc(p.displayName)} · ${p.votes} гол.</span>` : "";
    const click = clickable ? ` data-action="play" data-arg="${p.slot}" title="Увімкнути трек №${p.slot}"` : "";
    return `<li class="sleeve ${open ? "face" : "back"}${g.nowPlaying === p.slot ? " playing" : ""}${clickable ? " clickable" : ""}"${click}><span class="num">${p.slot}</span>
      ${open ? `<span class="src">${sourceLabel(p.source)}</span><span class="title">${esc(p.title)}</span>` : ""}${author}</li>`;
  }).join("");
  const voteInfo = g.phase === PHASE.VOTE
    ? `<p class="hint">Пиши в чат номер треку · голосів: ${S.collector?.voterCount ?? 0}</p>` : "";
  return `${voteInfo}${plays.length ? `<ul class="deck plays compact">${cards}</ul>` : ""}`;
}

/** Фаза, тема й таймер у верхній смузі — так сцені лишається більше місця під відео. */
function viewTop() {
  const g = S.game;
  if (!isHost() || !g || g.phase === PHASE.FINAL) return "";
  const showTheme = g.theme && (g.phase !== PHASE.SPIN || landedSpin === g.spin?.id);
  const round = g.round ? ` · раунд ${g.round}/${g.settings.rounds}` : "";
  return `<div class="phase">${esc(PHASE_LABEL[g.phase])}${round}</div>
    ${showTheme ? `<div class="theme">${esc(g.theme)}</div>` : ""}`;
}

function viewSeats() {
  if (!S.game) return "";
  const thrown = new Set(S.moves.map((m) => m.uid));
  const rows = S.players.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((p) => `<li class="${p.status}">
      ${p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : ""}
      <span class="name">${esc(p.displayName)}</span>
      <span class="muted small">${S.game.phase === PHASE.LOBBY ? `${p.cardCount}/${deckSize(S.game.settings)} ${p.ready ? "✓ готовий" : ""}` : p.status === "out" ? "вибув" : S.game.phase === PHASE.DISCARD && thrown.has(p.uid) ? `${plural(Math.max(0, (p.cardCount ?? 0) - 1), CARDS)} · кинув` : plural(p.cardCount ?? 0, CARDS)}</span>
      <span class="score">${p.score ?? 0}</span>
      ${p.status === "active" ? `<button class="x" data-action="kick" data-arg="${esc(p.uid)}" title="Кікнути">×</button>` : ""}
    </li>`).join("");
  return `<h3>Гравці</h3><ul class="seats">${rows}</ul>`;
}
