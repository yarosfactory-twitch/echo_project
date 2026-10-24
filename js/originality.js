// Перевірка на оригінальність. Чиста логіка, без мережі (є тести).
//
// Два рівні збігу між колодами РІЗНИХ гравців:
//  - "exact": той самий трек (однаковий key, тобто те саме відео YouTube
//    чи трек SoundCloud). Згоряє автоматично.
//  - "title": різні завантаження з однаковою «очищеною» назвою.
//    Підозрілий збіг, ведучий вирішує: палимо чи лишаємо.
//
// Кавери, ремікси, live-версії тощо НЕ зливаються з оригіналом: слова
// cover/remix/live/… лишаються в підписі, тож підписи відрізняються.

// Шум, який прибираємо з дужок і з назви загалом.
const NOISE_WORDS = [
  "official", "officially", "video", "videoclip", "audio", "lyric", "lyrics", "visualizer", "visualiser",
  "hd", "hq", "4k", "1080p", "720p", "mv", "m/v", "clip", "music", "full", "version", "remastered", "remaster",
  "explicit", "clean", "premiere", "new", "topic", "vevo", "оф", "офіційне", "офіційний", "офіційна", "офіційно",
  "відео", "відеокліп", "кліп", "аудіо", "текст", "прем'єра", "премʼєра", "прем’єра", "официальный", "клип",
  "and", "the", "x", "і", "та", "й",
];
const NOISE = new Set(NOISE_WORDS);

// Слова, які РОБЛЯТЬ версію іншою. Якщо в дужках є хоч одне з них, дужки лишаються.
const VARIANT = /(remix|rmx|cover|кавер|ремікс|ремикс|live|наживо|acoustic|акустик|unplugged|slowed|reverb|sped|speed|nightcore|instrumental|інструментал|karaoke|караоке|mashup|edit|bootleg|demo|orchestral|piano|8-?bit|lofi|lo-fi|phonk|version\s+\d)/i;

const SEP = /\s+[-–—|:]\s+/;

function clean(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’`ʼ]/g, "'")
    // дужки без «варіантних» слів — це шум: (Official Video), [HD], 【MV】
    .replace(/[([{【「]([^)\]}】」]*)[)\]}】」]/g, (m, inner) => (VARIANT.test(inner) ? ` ${inner} ` : " "))
    // feat./ft./prod. до кінця фрагмента
    .replace(/\b(feat|ft|featuring|prod)\b\.?[^-–—|()[\]]*/g, " ")
    .replace(/#\S+/g, " ");
}

function tokens(text) {
  return clean(text)
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .split(" ")
    .map((t) => t.replace(/^'+|'+$/g, ""))
    .filter((t) => t && !NOISE.has(t));
}

/** Підпис треку: «виконавець + назва» як відсортований набір слів.
 *  Порядок «Пісня - Виконавець» чи «Виконавець - Пісня» не важить. */
export function trackSignature(title, author = "") {
  const t = clean(title);
  // «Виконавець - Пісня» у назві: виконавця беремо звідти, канал не потрібен.
  const parts = t.split(SEP);
  const words = parts.length > 1 ? tokens(t) : [...tokens(author), ...tokens(t)];
  const uniq = [...new Set(words)].sort();
  return uniq.length >= 2 ? uniq.join(" ") : ""; // одне слово — надто ризиковано
}

/**
 * @param {{uid:string, displayName:string, cards:{key:string,title:string,author?:string,source:string,url?:string,used?:boolean}[]}[]} decks
 * @param {{burnedKeys?:string[]}} [opts]
 * @returns {{id:string, type:'exact'|'title', title:string, decision:'burn'|null,
 *            cards:{uid:string, displayName:string, cardKey:string, title:string, source:string, url:string}[]}[]}
 */
export function findDuplicateGroups(decks) {
  const entries = [];
  for (const d of decks) {
    for (const c of d.cards ?? []) {
      if (c.used) continue;
      entries.push({
        uid: d.uid, displayName: d.displayName, cardKey: c.key, title: c.title,
        source: c.source, url: c.url ?? "", sig: trackSignature(c.title, c.author),
      });
    }
  }
  const strip = ({ sig, ...rest }) => rest;
  const groups = [];
  const inExact = new Set(); // "uid|key"

  // 1. Той самий трек у різних гравців.
  const byKey = groupBy(entries, (e) => e.cardKey);
  for (const [key, list] of byKey) {
    if (new Set(list.map((e) => e.uid)).size < 2) continue;
    list.forEach((e) => inExact.add(`${e.uid}|${e.cardKey}`));
    groups.push({ id: `exact:${key}`, type: "exact", title: list[0].title, decision: "burn", cards: list.map(strip) });
  }

  // 2. Різні завантаження з однаковим підписом.
  const bySig = groupBy(entries.filter((e) => e.sig), (e) => e.sig);
  for (const [sig, list] of bySig) {
    const keys = new Set(list.map((e) => e.cardKey));
    const uids = new Set(list.map((e) => e.uid));
    if (keys.size < 2 || uids.size < 2) continue;
    // Якщо всі збіги вже покриті точним збігом, окрема група не потрібна.
    if (list.every((e) => inExact.has(`${e.uid}|${e.cardKey}`))) continue;
    // Різні треки одного гравця між собою — не збіг; потрібен хоча б один
    // інший гравець з ІНШИМ ключем.
    const crossPlayer = list.some((a) => list.some((b) => a.uid !== b.uid && a.cardKey !== b.cardKey));
    if (!crossPlayer) continue;
    groups.push({ id: `title:${sig}`, type: "title", title: list[0].title, decision: null, cards: list.map(strip) });
  }
  return groups;
}

/** Які карти згоряють: Map uid → Set(cardKey). Групи без рішення не горять. */
export function burnPlan(groups) {
  const plan = new Map();
  for (const g of groups) {
    if (g.decision !== "burn") continue;
    for (const c of g.cards) {
      if (!plan.has(c.uid)) plan.set(c.uid, new Set());
      plan.get(c.uid).add(c.cardKey);
    }
  }
  return plan;
}

/** Ключі треків, які вже були в грі як неоригінальні (повторно додати не можна). */
export function burnedKeys(groups) {
  return [...new Set(groups.filter((g) => g.decision === "burn").flatMap((g) => g.cards.map((c) => c.cardKey)))];
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}
