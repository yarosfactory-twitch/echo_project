// Магазин і тай-брейк: чиста логіка без мережі (є тести).

/** Плюшки магазину. pct — ключ у settings.prices (відсоток від балів гравця). */
export const SHOP_ITEMS = [
  { id: "queue", pct: "queue", title: "Черга", text: "Твій трек грає першим або останнім" },
  { id: "swap", pct: "swap", title: "Заміна карти", text: "Одну карту з руки замінити на новий трек" },
  { id: "extraCard", pct: "extraCard", title: "+1 карта", text: "Додати новий трек у руку" },
  { id: "double", pct: "double", title: "Подвійний раунд", text: "Бали за цей раунд ×2" },
  { id: "respin", pct: "respin", title: "Повторне обертання", text: "Жетон: перекрутити тему протягом 10 с після зупинки барабана" },
];
export const itemById = (id) => SHOP_ITEMS.find((i) => i.id === id);

/** Ціна: відсоток від балів, з округленням угору, мінімум 1 бал. */
export const priceOf = (score, percent) => Math.max(1, Math.ceil(((score ?? 0) * (percent ?? 0)) / 100));

/** Скільки секунд після зупинки барабана діє жетон повторного обертання. */
export const RESPIN_WINDOW_MS = 10_000;

/**
 * Порядок треків з урахуванням «Черги». Спершу випадкове перемішування (shuffled),
 * потім ті, хто купив «першим», — на початок у порядку покупки; «останнім» —
 * у кінець так, що найраніший покупець грає найостаннішим.
 * @param {{p:{uid:string}}[]} shuffled
 * @param {{uid:string, pos:"first"|"last", at:number}[]} queue
 */
export function applyQueue(shuffled, queue = []) {
  const byTime = [...queue].sort((a, b) => a.at - b.at);
  const firstUids = [];
  const lastUids = [];
  for (const q of byTime) {
    if (firstUids.includes(q.uid) || lastUids.includes(q.uid)) continue; // одна черга на гравця
    (q.pos === "first" ? firstUids : lastUids).push(q.uid);
  }
  const pick = (uid) => shuffled.find((x) => x.p.uid === uid);
  const head = firstUids.map(pick).filter(Boolean);
  const tail = lastUids.map(pick).filter(Boolean).reverse(); // найраніший — у самому кінці
  const used = new Set([...head, ...tail]);
  return [...head, ...shuffled.filter((x) => !used.has(x)), ...tail];
}

/** Бали з урахуванням «Подвійного раунду». */
export const roundPoints = (votes, doubled) => (votes ?? 0) * (doubled ? 2 : 1);

/**
 * Тай-брейк, хардкор: однакові треки (той самий key) у кількох учасників — неоригінальні.
 * @param {{uid:string, key:string}[]} subs
 * @returns {{originals:string[], unoriginal:string[]}}
 */
export function tiebreakOriginality(subs) {
  const count = new Map();
  for (const s of subs) count.set(s.key, (count.get(s.key) ?? 0) + 1);
  const originals = subs.filter((s) => count.get(s.key) === 1).map((s) => s.uid);
  const unoriginal = subs.filter((s) => count.get(s.key) > 1).map((s) => s.uid);
  return { originals, unoriginal };
}

/** Переможці тай-брейку за голосами: усі з максимумом (довжина > 1 — знову нічия). */
export function tiebreakWinners(votesByUid) {
  const entries = Object.entries(votesByUid);
  if (!entries.length) return [];
  const top = Math.max(...entries.map(([, v]) => v));
  return entries.filter(([, v]) => v === top).map(([uid]) => uid);
}

/**
 * Кут повороту платівки, щоб сектор target опинився під голкою (зверху).
 * Сектор i займає [i*slice, (i+1)*slice), його центр — i*slice + slice/2.
 * jitter ∈ [-0.35, 0.35] зсуває точку зупинки в межах сектора.
 */
export function wheelRotation(count, target, turns = 6, jitter = 0) {
  const slice = 360 / count;
  const center = target * slice + slice / 2 + jitter * slice;
  return turns * 360 + (360 - center);
}
