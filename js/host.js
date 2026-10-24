// Сторінка ведучого (host.html). Вона ж «сервер» гри:
// перевіряє Twitch-акаунти, веде фази, читає голоси з чату, рахує бали.
import {
  db, waitForUser, signInHost, signOut, auth,
  doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, onSnapshot,
  query, where, orderBy, limit, writeBatch, serverTimestamp, deleteField, increment, arrayUnion,
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
import { VinylWheel, WHEEL_MS } from "./wheel.js";
import { itemById, priceOf, applyQueue, roundPoints, tiebreakOriginality, tiebreakWinners, SHOP_ITEMS } from "./shop.js";
import {
  PHASE, PHASE_LABEL, MODE_LABEL, deckSize, freshThemes, roundsLeft, lateJoinOpen, lateJoinScore, cryptoRandom, shuffle, pickRandom, standings, leadersTie, DEFAULT_THEMES,
} from "./game-logic.js";
import { $, esc, patch, fmtCountdown, sourceLabel, standingsHTML, originalityHTML, tableHTML, flipClass, plural, CARDS, POINTS } from "./ui.js";

const els = {
  auth: $("#auth"), control: $("#control"), stage: $("#stage"), reel: $("#reel"), top: $("#top-stage"), wheel: $("#wheel"),
  player: $("#player"), seats: $("#seats"), log: $("#log"),
};

const S = {
  user: null, gameId: undefined, game: null, players: [], requests: [],
  round: null, moves: [], secret: null, themesPool: null,
  collector: null, chat: "off", logLines: [], siteVotes: [],
  tbSubs: [], shopReqs: [], respins: [],
  // Чернетка форми «Нова гра». Тримаємо значення тут, бо перемальовування
  // панелі (patch) інакше скидає поля до значень за замовчуванням.
  form: {
    rounds: DEFAULT_SETTINGS.rounds, extraCards: DEFAULT_SETTINGS.extraCards,
    discardSeconds: DEFAULT_SETTINGS.discardSeconds, voteSeconds: DEFAULT_SETTINGS.voteSeconds,
    mode: DEFAULT_SETTINGS.mode, custom: "", pool: null,
  },
};
const busy = new Set();
// Оголошено тут, до boot(): boot() викликається одразу після входу, ще до решти модуля.
let scApi = null; // проміс завантаження SoundCloud Widget API
let volume = 50; // гучність треків, 0–100
try { volume = Math.min(100, Math.max(0, Number(localStorage.getItem("mr_volume") ?? 50))); } catch { /* типове 50 */ }
let currentSc = null; // віджет SoundCloud поточного треку
let appliedSiteVotes = new Map(); // голоси гравців із сайту, уже враховані: uid → підпис
let votesDirty = false; // є незбережені голоси
const reel = new Reel(els.reel, { sound: true }); // звук обертання йде лише зі сторінки ведучого
const wheel = new VinylWheel(els.wheel, { sound: true });
let landedWheel = null;  // id обертання платівки, яке вже зупинилось
let landedSpinAt = 0;    // коли (час ведучого) зупинився барабан — для вікна жетона
let landedSpin = null; // id обертання, яке вже зупинилось (до цього тему не показуємо)
let gameSubs = [];
let roundSubs = [];
let roundKey = null;

// Анімувати обертання чи одразу показати результат. Порівнювати час з годинником
// ведучого ненадійно: якщо годинник цього комп'ютера відстає/поспішає на кілька
// секунд, барабан одразу стрибав на результат. Тому: якщо сторінка була відкрита й
// побачила, як обертання почалось, — завжди анімуємо; годинник — лише для тих, хто
// відкрив сторінку вже після старту.
const liveSpins = new Set();
function markLive(prev, next) {
  if (!prev || !next) return; // перший знімок після відкриття сторінки — не «наживо»
  if (next.spin?.id && next.spin.id !== prev.spin?.id) liveSpins.add(next.spin.id);
  if (next.wheel?.id && next.wheel.id !== prev.wheel?.id) liveSpins.add(next.wheel.id);
}
const isFresh = (x) => liveSpins.has(x.id) || Date.now() - (x.at ?? 0) < x.ms + 1500;

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
  loadSoundCloudApi().catch(() => {}); // завантажуємо наперед, щоб встигнути до READY плеєра
}

function subscribeGame(id) {
  [...gameSubs, ...roundSubs].forEach((off) => off());
  gameSubs = []; roundSubs = []; roundKey = null;
  Object.assign(S, { gameId: id, game: null, players: [], requests: [], round: null, moves: [], secret: null, collector: null });
  render();
  if (!id) return;
  gameSubs.push(
    onSnapshot(gref(), (s) => { const next = s.data() ?? null; markLive(S.game, next); S.game = next; syncRound(); resumeVoting(); onMovesChanged(); applySiteVotes(); render(); }),
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
  S.siteVotes = []; appliedSiteVotes = new Map(); S.tbSubs = []; S.shopReqs = []; S.respins = []; S.doubleReqs = [];
  if (!n) return;
  roundSubs.push(
    onSnapshot(gref("rounds", String(n)), (s) => { S.round = s.data() ?? null; updatePlayer(); render(); }),
    onSnapshot(gcol("rounds", String(n), "moves"), (s) => {
      S.moves = s.docs.map((d) => ({ uid: d.id, ...d.data() }));
      onMovesChanged();
      render(); // стіл і лічильник «Зіграли карту» оновлюються одразу
    }),
    // Голоси гравців із сайту зливаються з голосами чату в один VoteCollector.
    onSnapshot(gcol("rounds", String(n), "votes"), (s) => {
      S.siteVotes = s.docs.map((d) => ({ uid: d.id, ...d.data() }));
      applySiteVotes();
    }),
    // Тай-брейк: нові треки учасників нічиєї.
    onSnapshot(gcol("rounds", String(n), "tb"), (s) => {
      S.tbSubs = s.docs.map((d) => ({ uid: d.id, ...d.data() }));
      onTbSubsChanged();
      render();
    }),
    // Магазин: заявки на покупку, ведучий обробляє по черзі.
    onSnapshot(gcol("rounds", String(n), "shop"), (s) => {
      S.shopReqs = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      processShop();
      render();
    }),
    // Жетони повторного обертання.
    onSnapshot(gcol("rounds", String(n), "respin"), (s) => {
      S.respins = s.docs.map((d) => ({ uid: d.id, ...d.data() }));
      processRespins();
    }),
    // Жетони подвоєння: використати можна, поки не відкрито голосування.
    onSnapshot(gcol("rounds", String(n), "double"), (s) => {
      S.doubleReqs = s.docs.map((d) => ({ uid: d.id, ...d.data() }));
      processDoubles();
    }),
  );
}

/** Враховує нові/змінені голоси з сайту. Порядок надходження = порядок голосів,
 *  тож разом із чатом діє правило «рахується останній». */
function applySiteVotes() {
  if (S.game?.phase !== PHASE.VOTE || !S.collector?.open) return;
  let changed = false;
  for (const v of S.siteVotes ?? []) {
    const sig = `${v.slot}|${v.at?.seconds ?? ""}.${v.at?.nanoseconds ?? ""}`;
    if (appliedSiteVotes.get(v.uid) === sig) continue;
    appliedSiteVotes.set(v.uid, sig);
    const login = S.players.find((p) => p.uid === v.uid)?.login;
    if (S.collector.handleSlot(login, v.slot)) changed = true;
  }
  if (changed) { votesDirty = true; render(); }
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
  const seatedNow = (p) => p.status === "active" || p.status === "pending";
  // Той самий браузер повернувся (перезавантажив сторінку) — місце вже його.
  if (existing && existing.uid === uid && seatedNow(existing)) { await deleteDoc(ref); return; }
  if (existing && existing.uid !== uid && seatedNow(existing)) {
    return reject("Цей Twitch-акаунт уже в грі з іншого браузера", user.login);
  }
  if (accountAgeDays(user.created_at) < MIN_ACCOUNT_AGE_DAYS) {
    return reject(`Акаунту має бути щонайменше ${MIN_ACCOUNT_AGE_DAYS} дні`, user.login);
  }
  const late = S.game?.phase !== PHASE.LOBBY;
  if (late && !lateJoinOpen(S.game, S.players, MAX_PLAYERS)) {
    return reject("Вхід у цю гру вже закрито: лишилось замало раундів або немає місць", user.login);
  }
  // S.players оновлюється із затримкою, тож рахуємо й тих, кого щойно посадили.
  const taken = new Set([...S.players.filter(seatedNow).map((p) => p.uid), ...justSeated]);
  taken.delete(uid);
  if (taken.size >= MAX_PLAYERS) return reject(late ? "Немає вільних місць" : "Лобі заповнене", user.login);

  justSeated.add(uid);
  const base = {
    login: user.login, displayName: user.display_name, avatar: user.profile_image_url,
    score: 0, ready: false, cardCount: 0, joinedRound: S.game.round, joinedAt: serverTimestamp(),
  };
  if (late) {
    // Новачок збирає колоду на раунди, що лишились, і входить на старті наступного раунду.
    const need = roundsLeft(S.game);
    await setDoc(gref("decks", uid), { cards: [] }); // якщо повертається — колода з нуля
    await setDoc(gref("players", uid), { ...base, status: "pending", late: true, need });
    log(`✓ ${user.display_name} приєднується посеред гри (${plural(need, CARDS)})`);
  } else {
    await setDoc(gref("players", uid), { ...base, status: "active" });
    log(`✓ ${user.display_name} приєднався`);
  }
  await deleteDoc(ref);
}

/** На старті раунду садимо за стіл новачків, які зібрали колоду.
 *  Рахунок — найнижчий серед активних. У хардкорі збіг треку новачка з будь-якою
 *  картою гри (у руці чи вже зіграною) спалює обидві карти. */
async function activateLateJoiners(batch) {
  const ready = S.players.filter((p) => p.status === "pending" && p.ready && (p.cardCount ?? 0) >= 1);
  if (!ready.length) return;
  const score = lateJoinScore(S.players);
  const hardcore = S.game.settings.mode === "hardcore";
  const newDecks = new Map();
  for (const p of ready) newDecks.set(p.uid, (await getDoc(gref("decks", p.uid))).data()?.cards ?? []);

  if (hardcore) {
    // Усі треки гри: колоди інших гравців (і зіграні карти) + уже згорілі.
    const owners = new Map(); // key → [{uid, cards}]
    const others = S.players.filter((p) => !newDecks.has(p.uid) && (p.status === "active" || p.status === "out"));
    const otherDecks = new Map();
    for (const p of others) otherDecks.set(p.uid, (await getDoc(gref("decks", p.uid))).data()?.cards ?? []);
    const add = (uid, c) => { if (!owners.has(c.key)) owners.set(c.key, []); owners.get(c.key).push(uid); };
    for (const [uid, cards] of otherDecks) cards.forEach((c) => add(uid, c));
    for (const [uid, cards] of newDecks) cards.forEach((c) => add(uid, c));
    const burned = new Set(S.game.burned ?? []);
    const hits = [];
    for (const [uid, cards] of newDecks) {
      for (const c of cards) {
        if (c.used) continue;
        const shared = (owners.get(c.key) ?? []).some((o) => o !== uid) || burned.has(c.key);
        if (!shared) continue;
        hits.push({ uid, key: c.key, title: c.title });
        burned.add(c.key);
      }
    }
    if (hits.length) {
      const burnKeys = new Set(hits.map((h) => h.key));
      const touch = (decks, uid) => {
        const cards = decks.get(uid);
        let changed = false;
        for (const c of cards) if (burnKeys.has(c.key) && !c.used) { c.used = true; c.burned = true; changed = true; }
        if (!changed) return;
        batch.set(gref("decks", uid), { cards });
        batch.update(gref("players", uid), { cardCount: cards.filter((c) => !c.used).length });
      };
      for (const uid of otherDecks.keys()) touch(otherDecks, uid);
      for (const uid of newDecks.keys()) touch(newDecks, uid);
      batch.update(gref(), { burned: [...burned] });
      hits.forEach((h) => log(`🔥 Неоригінально: «${h.title}» (новачок ${S.players.find((p) => p.uid === h.uid)?.displayName})`));
    }
  }
  for (const p of ready) {
    const cards = newDecks.get(p.uid);
    batch.update(gref("players", p.uid), {
      status: "active", score, ready: false, activatedRound: S.game.round,
      cardCount: cards.filter((c) => !c.used).length,
    });
    log(`${p.displayName} сідає за стіл з ${plural(score, POINTS)}`);
  }
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
    // Теми останніх 3 ігор не кладемо в барабан, поки пулу вистачає.
    let recent = [];
    try {
      const last = await getDocs(query(collection(db, "history"), orderBy("finishedAt", "desc"), limit(3)));
      recent = last.docs.flatMap((d) => (d.data().rounds ?? []).map((r) => r.theme));
    } catch { /* історії ще немає — не страшно */ }
    const pool = freshThemes(S.themesPool ?? DEFAULT_THEMES, recent, settings.rounds);
    const themes = [...new Set([...pool, ...lines(f.custom)])];
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
    await doSpin(S.game.themesLeft ?? []);
  }),

  startRound: () => once("startRound", async () => {
    if (!spunThisRound() || landedSpin !== S.game.spin.id) return;
    const n = S.game.round;
    const batch = writeBatch(db);
    batch.set(gref("rounds", String(n)), { theme: S.game.theme, plays: [], thrown: [], revealed: false });
    if (S.game.tiebreak) {
      // Тай-брейк: учасники нічиєї мають 3 хв на будь-який новий трек.
      batch.update(gref(), { phase: PHASE.TB_SUBMIT, phaseEndsAt: Date.now() + (S.game.settings.tiebreakSeconds ?? 180) * 1000 });
    } else {
      await activateLateJoiners(batch);
      batch.update(gref(), { phase: PHASE.DISCARD, phaseEndsAt: Date.now() + S.game.settings.discardSeconds * 1000 });
    }
    await batch.commit();
  }),

  closeTbSubmit: () => once("closeTbSubmit", closeTbSubmit),

  spinWheel: () => once("spinWheel", async () => {
    const w = S.game.wheel;
    if (!w || w.id) return;
    const players = w.uids.map((uid) => S.players.find((p) => p.uid === uid)).filter(Boolean)
      .map((p) => ({ uid: p.uid, displayName: p.displayName, avatar: p.avatar ?? null }));
    const target = Math.floor(cryptoRandom() * players.length);
    const jitter = (cryptoRandom() - 0.5) * 0.7;
    await updateDoc(gref(), { wheel: { ...w, id: `w-${Date.now()}`, players, target, jitter, ms: WHEEL_MS, at: Date.now() } });
  }),

  wheelToFinal: () => once("wheelToFinal", async () => {
    const w = S.game.wheel;
    if (!w?.id || landedWheel !== w.id) return;
    const winner = w.players[w.target];
    log(`Платівка обрала переможця: ${winner.displayName}`);
    await finalize(winner.uid);
  }),

  closeShop: () => once("closeShop", async () => {
    await updateDoc(gref(), { phase: PHASE.SPIN });
  }),

  closeDiscard: () => once("closeDiscard", closeDiscard),

  play: (slot) => once("play", async () => {
    // playNonce: повторний клік по тому самому треку перезапускає його з таймкоду.
    await updateDoc(gref(), { nowPlaying: Number(slot), playNonce: Date.now(), revealed: arrayUnion(Number(slot)) });
  }),

  openVote: () => once("openVote", async () => {
    await ensureCollector();
    S.collector.open = true;
    appliedSiteVotes = new Map();
    await updateDoc(gref(), { phase: PHASE.VOTE, phaseEndsAt: Date.now() + S.game.settings.voteSeconds * 1000 });
  }),

  closeVote: () => once("closeVote", closeVote),

  nextRound: () => once("nextRound", async () => {
    if (S.game.tiebreak) return resolveTiebreak();
    if (S.game.round >= S.game.settings.rounds) return finish();
    // Між раундами — магазин (з 2-го раунду).
    await updateDoc(gref(), {
      round: S.game.round + 1, phase: PHASE.SHOP, theme: null, nowPlaying: null, revealed: [], phaseEndsAt: null,
      mods: { round: S.game.round + 1, queue: [], double: [] },
    });
  }),

  toSpin: () => once("toSpin", async () => { await updateDoc(gref(), { phase: PHASE.SPIN }); }),

  // Старі ігри з фазою TIEBREAK (до цього оновлення): переводимо на новий тай-брейк.
  randomWinner: () => once("randomWinner", async () => startTiebreak(S.game.tied ?? [], 1)),
};

/** Гравець натиснув «Вийти» в лобі (status → out): прибираємо його місце й колоду. */
function cleanupLeftLobby() {
  if (!S.game) return;
  // У лобі — усі, хто вийшов; посеред гри — новачки, які вийшли, ще не сівши за стіл.
  const gone = S.players.filter((x) => x.status === "out" && (S.game.phase === PHASE.LOBBY || (x.late && x.activatedRound == null)));
  for (const p of gone) {
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
  const fresh = isFresh(g.spin);
  reel.spin(g.spin, fresh, () => {
    landedSpin = g.spin.id;
    landedSpinAt = fresh ? Date.now() : (g.spin.at ?? 0) + g.spin.ms;
    render();
    processRespins(); // запит на перекручування міг прийти, поки барабан ще крутився
  });
}

/** Платівка з аватарками (повторна нічия в тай-брейку). */
function syncWheel() {
  const g = S.game;
  if (!g || g.phase !== PHASE.WHEEL || !g.wheel) { wheel.hide(); return; }
  if (!g.wheel.id) {
    const players = g.wheel.uids.map((uid) => S.players.find((p) => p.uid === uid)).filter(Boolean);
    wheel.idle(players);
    return;
  }
  const fresh = isFresh(g.wheel);
  wheel.spin(g.wheel, fresh, () => { landedWheel = g.wheel.id; render(); });
}

/** Чи хтось за столом має жетон і вікно після зупинки ще відкрите. */
const tokenHolders = () => activePlayers().filter((p) => (p.tokens ?? 0) > 0);

function canStart() {
  const ps = activePlayers();
  const need = S.game ? deckSize(S.game.settings) : 0;
  return ps.length >= MIN_PLAYERS && ps.every((p) => p.ready && p.cardCount === need);
}

/** Без карт у руці гравець пасує автоматично і лишається за столом. */
const hasCards = (p) => (p.cardCount ?? 0) > 0;

function onMovesChanged() {
  if (S.game?.phase !== PHASE.DISCARD) return;
  // thrown — хто зіграв карту (карта летить у центр), passed — хто пасував.
  const thrown = S.moves.filter((m) => m.type !== "pass").map((m) => m.uid);
  const passed = S.moves.filter((m) => m.type === "pass").map((m) => m.uid);
  if (S.round && ((S.round.thrown ?? []).length !== thrown.length || (S.round.passed ?? []).length !== passed.length)) {
    updateDoc(gref("rounds", String(S.game.round)), { thrown, passed }).catch(() => {});
  }
  const moved = S.moves.map((m) => m.uid);
  const waiting = activePlayers().filter((p) => hasCards(p) && !moved.includes(p.uid));
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
    if (move.type === "pass") continue; // пас: 0 балів, усі карти лишаються в руці
    const card = cards.find((c) => c.key === move.cardKey && !c.used);
    if (!card) continue; // невалідна карта: 0 балів, нічого не згорає
    card.used = true;
    batch.set(deckRef, { cards });
    batch.update(gref("players", p.uid), { cardCount: cards.filter((c) => !c.used).length });
    if (move.type === "discard") plays.push({ p, card });
  }

  // «Черга» з магазину: куплені «першим»/«останнім» стають на початок/у кінець.
  const queue = S.game.mods?.round === n ? S.game.mods.queue ?? [] : [];
  const ordered = applyQueue(shuffle(plays), queue).map((x, i) => ({ ...x, slot: i + 1 }));
  batch.set(gref("rounds", String(n)), {
    plays: ordered.map(({ slot, card }) => ({ slot, source: card.source, id: card.id, embed: card.embed ?? null, url: card.url, title: card.title, start: card.start ?? 0 })),
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
    // Голоси, збережені до перезавантаження сторінки ведучого.
    const saved = (await getDoc(gref("secret", `votes_${S.game.round}`))).data()?.votes;
    if (saved) S.collector.load(saved);
  })().finally(() => { collectorLoading = null; });
  return collectorLoading;
}

/** Сторінку перезавантажили посеред голосування: продовжуємо збирати голоси. */
function resumeVoting() {
  if (S.game?.phase !== PHASE.VOTE || S.collector?.open) return;
  ensureCollector().then(() => {
    if (S.game?.phase === PHASE.VOTE) { S.collector.open = true; appliedSiteVotes = new Map(); applySiteVotes(); render(); }
  });
}

function onChatMessage(login, message) {
  if (S.collector?.handle(login, message)) { votesDirty = true; render(); }
}

// Кожні 2 с зберігаємо голоси в базу, щоб перезавантаження сторінки їх не стерло.
setInterval(() => {
  if (!votesDirty || S.game?.phase !== PHASE.VOTE || !S.collector) return;
  votesDirty = false;
  setDoc(gref("secret", `votes_${S.game.round}`), { votes: S.collector.toJSON() }).catch(() => { votesDirty = true; });
}, 2000);

async function closeVote() {
  if (S.game.phase !== PHASE.VOTE) return;
  await ensureCollector(); // після перезавантаження голоси відновлюються з бази
  S.collector.open = false;
  const counts = S.collector.tally();
  const batch = writeBatch(db);
  // «Подвійний раунд» з магазину множить бали за цей раунд на 2.
  const doubled = new Set(S.game.mods?.round === S.game.round ? S.game.mods.double ?? [] : []);
  for (const s of S.secret.slots) {
    batch.update(gref("players", s.uid), { score: increment(roundPoints(counts[s.slot], doubled.has(s.uid))) });
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
  if (tied.length > 1) return startTiebreak(tied.map((p) => p.uid), 1);
  await finalize(tied[0]?.uid ?? null);
}

/** Вибір теми барабаном. Якщо теми закінчились (тай-брейк), беремо весь пул. */
async function doSpin(left, extra = {}) {
  const pool = left.length ? left : (S.themesPool ?? DEFAULT_THEMES);
  if (!pool.length) { log("⚠ Теми закінчились, додай нові в пул"); return; }
  const theme = pickRandom(pool);
  const list = shuffle(pool);
  const n = S.game.round;
  await updateDoc(gref(), {
    theme, themesLeft: pool.filter((t) => t !== theme),
    spin: { id: `${n}-${Date.now()}`, round: n, list, target: list.indexOf(theme), ms: SPIN_MS, at: Date.now() },
    nowPlaying: null, revealed: [], ...extra,
  });
}

// ── Тай-брейк ───────────────────────────────────────────────
/** Новий раунд тай-брейку для гравців tied: барабан тем → 3 хв на новий трек → голосування. */
async function startTiebreak(tied, k, notice = null) {
  const names = tied.map((uid) => S.players.find((p) => p.uid === uid)?.displayName ?? "?");
  log(`Тай-брейк ${k}: ${names.join(", ")}`);
  await updateDoc(gref(), {
    tiebreak: { tied, k }, tbNotice: notice,
    round: S.game.settings.rounds + k, phase: PHASE.SPIN, theme: null,
    nowPlaying: null, revealed: [], phaseEndsAt: null, wheel: null,
  });
}

/** Усі треки гри (у колодах, зіграні, згорілі) — у тай-брейку потрібен новий трек. */
async function allGameKeys() {
  const keys = new Set(S.game.burned ?? []);
  for (const p of S.players) {
    for (const c of (await getDoc(gref("decks", p.uid))).data()?.cards ?? []) keys.add(c.key);
  }
  return keys;
}

let tbKeysCache = null; // ключі треків гри на час збору треків тай-брейку
/** Класичний режим: трек, що вже є в грі або в іншого учасника, одразу відхиляємо. */
async function onTbSubsChanged() {
  const g = S.game;
  if (g?.phase !== PHASE.TB_SUBMIT) return;
  tbKeysCache ??= await allGameKeys();
  for (const sub of S.tbSubs) {
    if (sub.rejected || !sub.key) continue;
    const takenByOther = S.tbSubs.some((o) => o.uid !== sub.uid && o.key === sub.key && !o.rejected && (o.at?.seconds ?? 0) <= (sub.at?.seconds ?? 0));
    let reason = null;
    if (tbKeysCache.has(sub.key)) reason = "Цей трек уже був у цій грі — потрібен новий";
    else if (g.settings.mode !== "hardcore" && takenByOther) reason = "Цей трек уже взяв інший учасник, обери інший";
    if (reason) await updateDoc(gref("rounds", String(g.round), "tb", sub.uid), { rejected: reason }).catch(() => {});
  }
  // Усі учасники вставили прийнятий трек — закриваємо достроково.
  const ok = S.tbSubs.filter((x) => x.key && !x.rejected);
  if (g.tiebreak && g.tiebreak.tied.every((uid) => ok.some((x) => x.uid === uid))) A.closeTbSubmit();
}

async function closeTbSubmit() {
  const g = S.game;
  if (g.phase !== PHASE.TB_SUBMIT) return;
  tbKeysCache = null;
  const n = g.round;
  const subs = (await getDocs(gcol("rounds", String(n), "tb"))).docs.map((d) => ({ uid: d.id, ...d.data() }))
    .filter((x) => x.key && !x.rejected && g.tiebreak.tied.includes(x.uid));
  const byUid = (uid) => S.players.find((p) => p.uid === uid);
  const missing = g.tiebreak.tied.filter((uid) => !subs.some((x) => x.uid === uid));
  missing.forEach((uid) => log(`${byUid(uid)?.displayName} не встиг вставити трек і вибуває з тай-брейку`));

  if (!subs.length) {
    // Ніхто не вставив трек — вирішує платівка серед усіх учасників нічиєї.
    return updateDoc(gref(), { phase: PHASE.WHEEL, phaseEndsAt: null, wheel: { uids: g.tiebreak.tied } });
  }
  let { originals, unoriginal } = g.settings.mode === "hardcore"
    ? tiebreakOriginality(subs)
    : { originals: subs.map((x) => x.uid), unoriginal: [] };
  const burned = [...new Set([...(g.burned ?? []), ...subs.filter((x) => unoriginal.includes(x.uid)).map((x) => x.key)])];
  const unNames = unoriginal.map((uid) => byUid(uid)?.displayName).join(", ");
  if (unoriginal.length) log(`🔥 Неоригінально в тай-брейку: ${unNames}`);

  if (originals.length === 1) {
    await updateDoc(gref(), { burned, tbNotice: unoriginal.length ? { text: `Неоригінально: ${unNames}` } : null });
    log(`Оригінальним лишився лише ${byUid(originals[0])?.displayName} — перемога`);
    return finalize(originals[0]);
  }
  if (originals.length === 0) {
    // Усі принесли однакові треки — новий тай-брейк з новою темою.
    await updateDoc(gref(), { burned });
    return startTiebreak(unoriginal, g.tiebreak.k + 1, { text: `Неоригінально: ${unNames}. Ще один раунд з новою темою!` });
  }
  // 2+ оригінальних — звичайне прослуховування і голосування між ними.
  const plays = shuffle(subs.filter((x) => originals.includes(x.uid))).map((x, i) => ({ ...x, slot: i + 1 }));
  const batch = writeBatch(db);
  batch.set(gref("rounds", String(n)), {
    theme: g.theme, thrown: [], revealed: false,
    plays: plays.map((x) => ({ slot: x.slot, source: x.source, id: x.id ?? null, embed: x.embed ?? null, url: x.url, title: x.title, start: x.start ?? 0 })),
  }, { merge: true });
  batch.set(gref("secret", `round_${n}`), {
    slots: plays.map((x) => ({ slot: x.slot, uid: x.uid, login: byUid(x.uid)?.login ?? "", displayName: byUid(x.uid)?.displayName ?? "?" })),
  });
  batch.update(gref(), {
    burned, phase: PHASE.LISTEN, phaseEndsAt: null, nowPlaying: null, revealed: [],
    tbNotice: unoriginal.length ? { text: `Неоригінально: ${unNames} — вибувають з тай-брейку` } : null,
  });
  await batch.commit();
}

/** Після голосування тай-брейку: один лідер — переможець, кілька — платівка. */
async function resolveTiebreak() {
  const g = S.game;
  const plays = S.round?.plays ?? [];
  const votes = Object.fromEntries(plays.filter((p) => p.uid).map((p) => [p.uid, p.votes ?? 0]));
  const winners = tiebreakWinners(votes);
  if (winners.length === 1) return finalize(winners[0]);
  const uids = winners.length ? winners : g.tiebreak.tied;
  log(`Знову нічия — вирішує платівка: ${uids.map((u) => S.players.find((p) => p.uid === u)?.displayName).join(", ")}`);
  await updateDoc(gref(), { phase: PHASE.WHEEL, phaseEndsAt: null, wheel: { uids } });
}

// ── Магазин ─────────────────────────────────────────────────
const shopDone = new Set(); // id заявок, які вже обробляємо (захист від подвійної обробки)
let boughtCache = null;     // { round, queue:Set, double:Set } — що вже куплено в раунді

function boughtThisRound(n) {
  if (boughtCache?.round !== n) {
    const m = S.game.mods?.round === n ? S.game.mods : {};
    boughtCache = { round: n, queue: new Set((m.queue ?? []).map((q) => q.uid)), double: new Set(m.double ?? []) };
  }
  return boughtCache;
}

/** Обробляє заявки по черзі за часом. Ціну рахуємо тут, з актуальних балів. */
async function processShop() {
  const g = S.game;
  if (!g || g.phase !== PHASE.SHOP) return;
  const pending = S.shopReqs.filter((r) => !r.status && !shopDone.has(r.id))
    .sort((a, b) => (a.at?.seconds ?? 0) - (b.at?.seconds ?? 0) || (a.at?.nanoseconds ?? 0) - (b.at?.nanoseconds ?? 0));
  for (const req of pending) {
    shopDone.add(req.id);
    try {
      await handlePurchase(req);
    } catch (e) {
      log(`⚠ магазин: ${e.message}`);
      // Гравець не має вічно бачити «обробляється…».
      await updateDoc(gref("rounds", String(S.game.round), "shop", req.id), { status: "rejected", reason: "Не вдалося провести покупку, спробуй ще раз" }).catch(() => {});
    }
  }
}

async function handlePurchase(req) {
  const g = S.game;
  const n = g.round;
  const reqRef = gref("rounds", String(n), "shop", req.id);
  const p = S.players.find((x) => x.uid === req.uid);
  const item = itemById(req.item);
  const reject = (reason) => updateDoc(reqRef, { status: "rejected", reason });
  if (!p || p.status !== "active") return reject("Купувати можуть лише гравці за столом");
  if (!item) return reject("Невідома плюшка");
  // Актуальний рахунок: з бази, бо кілька покупок поспіль змінюють бали.
  const fresh = (await getDoc(gref("players", p.uid))).data() ?? p;
  const price = priceOf(fresh.score ?? 0, g.settings.prices?.[item.pct] ?? 0);
  if ((fresh.score ?? 0) < price) return reject(`Не вистачає балів: потрібно ${price}`);

  // Покупки обробляються одна за одною швидше, ніж приходить знімок гри, тож
  // дописуємо в масиви через arrayUnion, а не переписуємо весь mods.
  const bought = boughtThisRound(n);
  const batch = writeBatch(db);
  const deckRef = gref("decks", p.uid);
  let registryKey = null;
  if (item.id === "queue") {
    if (bought.queue.has(p.uid)) return reject("Черга вже куплена в цьому раунді");
    bought.queue.add(p.uid);
    batch.update(gref(), { "mods.round": n, "mods.queue": arrayUnion({ uid: p.uid, pos: req.arg === "last" ? "last" : "first", at: Date.now() }) });
  } else if (item.id === "double") {
    // Жетон подвоєння: гравець сам вирішує, у якому раунді його використати.
    batch.update(gref("players", p.uid), { doubleTokens: increment(1) });
  } else if (item.id === "respin") {
    batch.update(gref("players", p.uid), { tokens: increment(1) });
  } else if (item.id === "swap" || item.id === "extraCard") {
    const card = req.card;
    if (!card?.key) return reject("Немає треку");
    // Трек, що збігається з будь-якою картою гри, купити не можна.
    const keys = await allGameKeys();
    if (keys.has(card.key)) return reject("Цей трек уже є в грі — обери інший");
    const cards = (await getDoc(deckRef)).data()?.cards ?? [];
    const clean = { key: card.key, source: card.source, id: card.id ?? null, embed: card.embed ?? null, url: card.url, title: card.title, author: card.author ?? "", start: card.start ?? 0, used: false };
    if (item.id === "swap") {
      const i = cards.findIndex((c) => c.key === req.arg && !c.used);
      if (i < 0) return reject("Цієї карти вже немає в руці");
      cards[i] = clean;
    } else {
      cards.push(clean);
    }
    batch.set(deckRef, { cards });
    batch.update(gref("players", p.uid), { cardCount: cards.filter((c) => !c.used).length });
    registryKey = g.settings.mode !== "hardcore" ? card.key : null;
  }
  batch.update(gref("players", p.uid), { score: increment(-price) });
  batch.update(reqRef, { status: "ok", price });
  await batch.commit();
  // Класичний режим: трек у реєстр дублікатів. Окремо від покупки, щоб навіть
  // за старих правил бази (без дозволу ведучому) покупка не відкочувалась.
  if (registryKey) await setDoc(gref("tracks", registryKey), { uid: p.uid }).catch(() => {});
  log(`🛒 ${p.displayName}: ${item.title} за ${plural(price, POINTS)}`);
}

// ── Жетон повторного обертання ──────────────────────────────
const respinUsed = new Set(); // `${spinId}|${uid}`

// ── Жетон подвоєння ─────────────────────────────────────────
const DOUBLE_PHASES = [PHASE.SHOP, PHASE.SPIN, PHASE.DISCARD, PHASE.LISTEN];
const doubleUsed = new Set(); // `${round}|${uid}`

async function processDoubles() {
  const g = S.game;
  if (!g || g.tiebreak || !DOUBLE_PHASES.includes(g.phase)) return;
  const n = g.round;
  for (const r of S.doubleReqs ?? []) {
    const key = `${n}|${r.uid}`;
    if (doubleUsed.has(key)) continue;
    doubleUsed.add(key);
    const p = S.players.find((x) => x.uid === r.uid);
    const fresh = (await getDoc(gref("players", r.uid))).data();
    const already = g.mods?.round === n && (g.mods.double ?? []).includes(r.uid);
    if (!p || p.status !== "active" || already || !(fresh?.doubleTokens > 0)) continue;
    const batch = writeBatch(db);
    batch.update(gref("players", r.uid), { doubleTokens: increment(-1) });
    batch.update(gref(), { "mods.round": n, "mods.double": arrayUnion(r.uid) });
    await batch.commit();
    log(`✖2 ${p.displayName} подвоює бали за цей раунд`);
  }
}

async function processRespins() {
  const g = S.game;
  // Жетон діє після зупинки барабана, поки ведучий не почав раунд.
  if (!g || g.phase !== PHASE.SPIN || !g.spin || landedSpin !== g.spin.id) return;
  for (const r of S.respins) {
    if (r.spinId !== g.spin.id) continue;
    const key = `${r.spinId}|${r.uid}`;
    if (respinUsed.has(key)) continue;
    respinUsed.add(key);
    const p = S.players.find((x) => x.uid === r.uid);
    const fresh = (await getDoc(gref("players", r.uid))).data();
    if (!p || p.status !== "active" || !(fresh?.tokens > 0)) continue;
    log(`🔄 ${p.displayName} використовує жетон — перекручуємо барабан`);
    await updateDoc(gref("players", r.uid), { tokens: increment(-1) });
    // Стара тема повертається в барабан.
    await doSpin([...(g.themesLeft ?? []), g.theme], { respinBy: p.displayName });
    return; // одне перекручування за раз
  }
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
  if (S.game.phase === PHASE.TB_SUBMIT) A.closeTbSubmit();
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
  const iframe = els.player.querySelector("iframe");
  if (!iframe) return;
  if (card.source === "soundcloud") setupSoundCloud(iframe, card.start ?? 0);
  else setupYouTube(iframe);
}

// ── Гучність ────────────────────────────────────────────────
// Один повзунок для обох плеєрів. Значення — лише зручність цього браузера,
// тож localStorage (з try/catch: у приватному вікні він може кидати помилку).

function applyVolume() {
  const iframe = els.player.querySelector("iframe");
  if (!iframe) return;
  if (currentSc) currentSc.setVolume(volume);
  else ytCommand(iframe, "setVolume", [volume]);
}

function ytCommand(iframe, func, args = []) {
  iframe.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
}

/** YouTube приймає команди після готовності плеєра, тож повторюємо кілька разів. */
function setupYouTube(iframe) {
  currentSc = null;
  const send = () => ytCommand(iframe, "setVolume", [volume]);
  iframe.addEventListener("load", () => { [300, 1000, 2500, 5000].forEach((ms) => setTimeout(send, ms)); }, { once: true });
}

$("#volume-range")?.addEventListener("input", (e) => {
  volume = Number(e.target.value);
  $("#volume-value").textContent = `${volume}%`;
  try { localStorage.setItem("mr_volume", String(volume)); } catch { /* не критично */ }
  applyVolume();
});
if ($("#volume-range")) { $("#volume-range").value = volume; $("#volume-value").textContent = `${volume}%`; }

// SoundCloud не приймає час старту в адресі плеєра, тож перемотуємо через Widget API.
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

/** SoundCloud: гучність і перемотка на таймкод. Подія READY могла вже пройти,
 *  поки вантажився api.js, тому діємо також на першому PLAY і ще раз
 *  перевіряємо через пару секунд. */
async function setupSoundCloud(iframe, startSec) {
  currentSc = null;
  try {
    const SC = await loadSoundCloudApi();
    const widget = SC.Widget(iframe);
    currentSc = widget;
    const target = startSec * 1000;
    let done = false;
    const fix = () => {
      widget.setVolume(volume);
      if (!target) { done = true; return; }
      widget.getPosition((pos) => {
        if (pos < target - 1500) widget.seekTo(target);
        done = true;
      });
    };
    widget.bind(SC.Widget.Events.READY, () => {
      widget.setVolume(volume);
      if (target) widget.seekTo(target);
      widget.play();
    });
    widget.bind(SC.Widget.Events.PLAY, () => { if (!done) fix(); });
    setTimeout(fix, 2500);
  } catch (e) {
    log(`⚠ ${e.message}: гучність і таймкод SoundCloud не застосуються`);
  }
}

// ── Рендер ──────────────────────────────────────────────────
function render() {
  patch(els.auth, viewAuth());
  if (!isHost()) { ["control", "stage", "seats", "log"].forEach((k) => patch(els[k], "")); reel.hide(); wheel.hide(); return; }
  syncReel();
  syncWheel();
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
    case PHASE.SHOP: {
      const done = S.shopReqs.filter((r) => r.status === "ok").length;
      body = `<p class="muted">Гравці купують плюшки. Покупок: ${done}. Коли всі готові — до барабана.</p>${b("closeShop", "Закрити магазин і до барабана", { primary: true })}`;
      break;
    }
    case PHASE.SPIN: {
      const spun = spunThisRound();
      const landed = spun && landedSpin === g.spin.id;
      const holders = landed ? tokenHolders() : [];
      const left = (g.themesLeft ?? []).length || (g.tiebreak ? (S.themesPool ?? DEFAULT_THEMES).length : 0);
      const tb = g.tiebreak ? `<p class="hint">Тай-брейк: ${esc(tiedNames())}. Після теми в них буде ${Math.round((g.settings.tiebreakSeconds ?? 180) / 60)} хв на новий трек.</p>` : "";
      body = tb + (!spun
        ? `<p class="muted">Тем у барабані: ${left}</p>${b("spin", "Крутити барабан", { primary: true, disabled: !left })}`
        : !landed
          ? `<p class="muted">Барабан крутиться…</p>${b("startRound", "Почати раунд", { disabled: true })}`
          : `${holders.length ? `<p class="muted small">🔄 Жетон є в: ${esc(holders.map((p) => p.displayName).join(", "))} — можуть перекрутити, поки ти не почав раунд</p>` : ""}<p class="muted">Тема обрана. Прокоментуй і запускай ${g.tiebreak ? "тай-брейк" : "раунд"}.</p>${b("startRound", g.tiebreak ? "Почати тай-брейк" : "Почати раунд", { primary: true })}`);
      break;
    }
    case PHASE.TB_SUBMIT: {
      const ok = S.tbSubs.filter((x) => x.key && !x.rejected).length;
      body = `<p class="muted">Учасники вставили трек: ${ok} / ${g.tiebreak?.tied.length ?? 0}</p>${b("closeTbSubmit", "Завершити зараз")}`;
      break;
    }
    case PHASE.WHEEL: {
      const w = g.wheel;
      body = !w?.id
        ? `<p class="muted">Знову нічия. Переможця обере платівка.</p>${b("spinWheel", "Крутити платівку", { primary: true })}`
        : landedWheel === w.id
          ? `<p class="muted">Голка обрала: <b>${esc(w.players[w.target]?.displayName)}</b>.</p>${b("wheelToFinal", "До фіналу", { primary: true })}`
          : `<p class="muted">Платівка крутиться…</p>`;
      break;
    }
    case PHASE.DISCARD:
      body = `<p class="muted">Зробили хід: ${S.moves.length} / ${activePlayers().filter(hasCards).length}</p>${b("closeDiscard", "Завершити скидання зараз")}`;
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
      body = `<p class="muted">Нічия (гра почалась до оновлення).</p>${b("randomWinner", "Почати тай-брейк", { primary: true })}`;
      break;
    case PHASE.FINAL:
      body = "";
      break;
  }
  return `<section class="panel"><h2>${esc(PHASE_LABEL[g.phase])}${g.tiebreak ? " · тай-брейк" : g.round ? ` · раунд ${g.round}/${g.settings.rounds}` : ""}</h2>
    ${body}<div class="row end">${b("closeGame", g.phase === PHASE.FINAL ? "Закрити гру" : "Скасувати гру")}</div></section>`;
}

function viewStage() {
  if (!S.game) return `<div class="stage-empty"><img class="logo-big" src="img/logo.png" alt="Music Roulette"></div>`;
  const g = S.game;
  if (g.phase === PHASE.FINAL) return `<div class="stage-final"><h1 class="final-title">Фінал</h1>${standingsHTML(g.final)}</div>`;
  if (g.phase === PHASE.ORIGINALITY) return originalityHTML(g.originality?.groups);
  if (g.phase === PHASE.SHOP) return shopStageHTML();
  if (g.phase === PHASE.TB_SUBMIT) return tbStageHTML();
  if (g.phase === PHASE.WHEEL) return `<h1 class="final-title">Знову нічия!</h1><p class="hint">Голка обере переможця</p>`;
  if (g.phase === PHASE.SPIN && g.tiebreak) return `${noticeHTML()}<h1 class="final-title">Нічия! Тай-брейк</h1><p class="hint">${esc(tiedNames())}</p>`;
  // Поки гравці обирають карти — показуємо стіл, як у гравців.
  if (g.phase === PHASE.DISCARD) {
    return `<div class="stage-table">${tableHTML({
      players: S.players, phase: g.phase, round: `${S.gameId}-${g.round}`,
      thrown: new Set(S.moves.filter((m) => m.type !== "pass").map((m) => m.uid)),
      passed: new Set(S.moves.filter((m) => m.type === "pass").map((m) => m.uid)),
    })}</div>`;
  }
  const plays = S.round?.plays ?? [];
  const revealed = new Set(g.revealed ?? []);
  // Клік по картці вмикає трек (те саме, що кнопки №1, №2… на панелі).
  const clickable = [PHASE.LISTEN, PHASE.VOTE, PHASE.RESULTS].includes(g.phase);
  const cards = plays.map((p) => {
    const open = revealed.has(p.slot) || S.round.revealed;
    const author = S.round.revealed ? `<span class="author">${esc(p.displayName)} · ${p.votes} гол.</span>` : "";
    const click = clickable ? ` data-action="play" data-arg="${p.slot}" title="Увімкнути трек №${p.slot}"` : "";
    const flip = open ? flipClass(`${S.gameId}-${g.round}-${p.slot}`) : "";
    return `<li class="sleeve ${open ? "face" : "back"}${flip}${g.nowPlaying === p.slot ? " playing" : ""}${clickable ? " clickable" : ""}"${click}><span class="num">${p.slot}</span>
      ${open ? `<span class="src">${sourceLabel(p.source)}</span><span class="title">${esc(p.title)}</span>` : ""}${author}</li>`;
  }).join("");
  const notice = g.tiebreak ? noticeHTML() : "";
  const voteInfo = g.phase === PHASE.VOTE
    ? `<p class="hint">Пиши в чат номер треку або голосуй на сайті · голосів: ${S.collector?.voterCount ?? 0}</p>` : "";
  return `${notice}${voteInfo}${plays.length ? `<ul class="deck plays compact">${cards}</ul>` : ""}`;
}

/** Фаза, тема й таймер у верхній смузі — так сцені лишається більше місця під відео. */
function viewTop() {
  const g = S.game;
  if (!isHost() || !g || g.phase === PHASE.FINAL) return "";
  const showTheme = g.theme && (g.phase !== PHASE.SPIN || landedSpin === g.spin?.id);
  const round = g.tiebreak ? ` · тай-брейк${g.tiebreak.k > 1 ? ` ${g.tiebreak.k}` : ""}` : g.round ? ` · раунд ${g.round}/${g.settings.rounds}` : "";
  return `<div class="phase">${esc(PHASE_LABEL[g.phase])}${round}</div>
    ${showTheme ? `<div class="theme">${esc(g.theme)}</div>` : ""}`;
}

const tiedNames = () => (S.game?.tiebreak?.tied ?? []).map((uid) => S.players.find((p) => p.uid === uid)?.displayName ?? "?").join(" · ");

const noticeHTML = () => (S.game?.tbNotice?.text ? `<div class="notice">🔥 ${esc(S.game.tbNotice.text)}</div>` : "");

/** Сцена магазину: хто що купив (без деталей треків). */
function shopStageHTML() {
  const ok = S.shopReqs.filter((r) => r.status === "ok").sort((a, b) => (a.at?.seconds ?? 0) - (b.at?.seconds ?? 0));
  const rows = ok.map((r) => {
    const p = S.players.find((x) => x.uid === r.uid);
    const item = itemById(r.item);
    const extra = r.item === "queue" ? (r.arg === "last" ? " (останнім)" : " (першим)") : "";
    return `<li><span class="who">${esc(p?.displayName ?? "?")}</span><span>${esc(item?.title ?? r.item)}${extra}</span><span class="pts">−${plural(r.price ?? 0, POINTS)}</span></li>`;
  }).join("");
  return `<h1 class="final-title">Магазин</h1>
    <p class="hint">Бали — це і рахунок, і гроші. Купуй на сайті до обертання барабана</p>
    <ul class="shop-log">${rows || `<li class="muted">Поки ніхто нічого не купив</li>`}</ul>`;
}

/** Сцена тай-брейку: хто з учасників уже вставив трек. */
function tbStageHTML() {
  const tied = S.game.tiebreak?.tied ?? [];
  const rows = tied.map((uid) => {
    const p = S.players.find((x) => x.uid === uid);
    const sub = S.tbSubs.find((x) => x.uid === uid && x.key && !x.rejected);
    return `<li class="${sub ? "ready" : ""}">${p?.avatar ? `<img class="avatar" src="${esc(p.avatar)}" alt="">` : ""}<span class="who">${esc(p?.displayName ?? "?")}</span><span>${sub ? "✓ трек обрано" : "обирає…"}</span></li>`;
  }).join("");
  return `${noticeHTML()}<h1 class="final-title">Тай-брейк</h1><p class="hint">Будь-який новий трек на тему — гадаймо разом із чатом, хто що принесе</p><ul class="shop-log tb">${rows}</ul>`;
}

function viewSeats() {
  if (!S.game) return "";
  const thrown = new Set(S.moves.filter((m) => m.type !== "pass").map((m) => m.uid));
  const passed = new Set(S.moves.filter((m) => m.type === "pass").map((m) => m.uid));
  const rows = S.players.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((p) => `<li class="${p.status}">
      ${p.avatar ? `<img src="${esc(p.avatar)}" alt="">` : ""}
      <span class="name">${esc(p.displayName)}</span>
      <span class="muted small">${S.game.phase === PHASE.LOBBY ? `${p.cardCount}/${deckSize(S.game.settings)} ${p.ready ? "✓ готовий" : ""}` : p.status === "pending" ? `новачок · ${p.cardCount ?? 0}/${p.need} ${p.ready ? "✓ сяде з наступного раунду" : ""}` : p.status === "out" ? "вибув" : S.game.phase === PHASE.DISCARD && thrown.has(p.uid) ? `${plural(Math.max(0, (p.cardCount ?? 0) - 1), CARDS)} · зіграв` : S.game.phase === PHASE.DISCARD && passed.has(p.uid) ? `${plural(p.cardCount ?? 0, CARDS)} · пас` : plural(p.cardCount ?? 0, CARDS)}</span>
      ${(p.tokens ?? 0) > 0 ? `<span class="muted small" title="Жетони повторного обертання">🔄${p.tokens}</span>` : ""}
      ${(p.doubleTokens ?? 0) > 0 ? `<span class="muted small" title="Жетони подвоєння">✖2·${p.doubleTokens}</span>` : ""}
      ${S.game.mods?.round === S.game.round && (S.game.mods.double ?? []).includes(p.uid) ? `<span class="small" title="Бали за цей раунд ×2" style="color:var(--ok)">×2</span>` : ""}
      <span class="score">${p.score ?? 0}</span>
      ${p.status === "active" || p.status === "pending" ? `<button class="x" data-action="kick" data-arg="${esc(p.uid)}" title="Кікнути">×</button>` : ""}
    </li>`).join("");
  return `<h3>Гравці</h3><ul class="seats">${rows}</ul>`;
}
