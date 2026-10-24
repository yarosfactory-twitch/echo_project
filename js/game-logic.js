// Спільні правила гри. Чиста логіка, без Firebase (є тести).

export const PHASE = {
  LOBBY: "lobby",       // збір колод
  ORIGINALITY: "originality", // перевірка на оригінальність перед 1-м раундом
  SHOP: "shop",         // магазин перед колесом (з 2-го раунду)
  SPIN: "spin",         // колесо обирає тему
  DISCARD: "discard",   // гравці скидають карту або пасують
  LISTEN: "listen",     // ведучий програє треки
  VOTE: "vote",         // чат голосує
  RESULTS: "results",   // підсумки раунду, автори розкриті
  TIEBREAK: "tiebreak", // нічия у фіналі
  FINAL: "final",       // п'єдестал
};

export const PHASE_LABEL = {
  lobby: "Лобі: збираємо колоди",
  originality: "Перевірка на оригінальність",
  shop: "Магазин",
  spin: "Барабан тем",
  discard: "Скидаємо карти",
  listen: "Слухаємо треки",
  vote: "Голосування",
  results: "Підсумки раунду",
  tiebreak: "Тай-брейк",
  final: "Фінал",
};

export const MODE_LABEL = { classic: "класичний", hardcore: "хардкор" };

export const deckSize = (settings) => settings.rounds + settings.extraCards;

/** Криптографічний генератор у [0, 1): рівномірніший за Math.random. */
export function cryptoRandom() {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 2 ** 32;
}

export function shuffle(items, rnd = cryptoRandom) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const pickRandom = (items, rnd = cryptoRandom) => items[Math.floor(rnd() * items.length)];

const byScore = (a, b) => (b.score ?? 0) - (a.score ?? 0);

/** Таблиця для п'єдесталу: спершу ті, хто дограв, потім вибулі.
 *  winnerUid (після тай-брейку чи колеса з ніками) стає першим. */
export function standings(players, winnerUid = null) {
  const pool = players.filter((p) => p.status === "active" || p.status === "out");
  const active = pool.filter((p) => p.status === "active").sort(byScore);
  const out = pool.filter((p) => p.status === "out").sort(byScore);
  if (winnerUid) {
    const i = active.findIndex((p) => p.uid === winnerUid);
    if (i > 0) active.unshift(active.splice(i, 1)[0]);
  }
  return [...active, ...out].map((p, i) => ({
    uid: p.uid, login: p.login, displayName: p.displayName,
    avatar: p.avatar ?? null, score: p.score ?? 0, status: p.status, place: i + 1,
  }));
}

/** Активні гравці з найвищим рахунком. Довжина > 1 означає нічию. */
export function leadersTie(players) {
  const active = players.filter((p) => p.status === "active");
  if (!active.length) return [];
  const top = Math.max(...active.map((p) => p.score ?? 0));
  return active.filter((p) => (p.score ?? 0) === top);
}

/** Новачок посеред гри стартує з найнижчим рахунком серед активних. */
export function lateJoinScore(players) {
  const active = players.filter((p) => p.status === "active");
  return active.length ? Math.min(...active.map((p) => p.score ?? 0)) : 0;
}

/** Ціна плюшки: відсоток від балів, вгору, мінімум 1. */
export const shopPrice = (score, percent) => Math.max(1, Math.ceil((score * percent) / 100));

export const DEFAULT_THEMES = [
  "Пісня для нічної дороги",
  "Саундтрек до бійки з босом",
  "Трек, який соромно любити",
  "Музика з дитинства",
  "Пісня про кохання",
  "Кавер, кращий за оригінал",
  "Українська класика",
  "Під це прибирати квартиру",
  "Пісня з фільму чи серіалу",
  "Музика з гри",
  "Музика для дощу",
  "Найдивніший кліп",
  "Пісня не англійською і не українською",
  "Трек, старший за тебе",
  "Качає в спортзалі",
  "Для повільного танцю",
  "Трек, після якого хочеться плакати",
  "Інструментал без слів",
  "Пісня про місто",
  "Літній хіт",
  "Виживання в дикій природі",
  "Похмуре фентезі",
];
