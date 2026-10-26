// Титули у фіналі: чиста логіка без мережі (є тести).
//
// Вхід — звичайні раунди гри (без тай-брейку), як вони лежать у rounds/{n}:
//   { n, plays: [{ uid, votes, chatVotes, points }], scoresBefore: {uid: бали}, scoresAfter: {uid: бали} }
// Нічия в титулі — титул отримують усі, хто поділив максимум.

export const TITLES = [
  { id: "chatFavorite", icon: "💬", title: "Улюбленець чату", unit: "голосів чату" },
  { id: "darkHorse", icon: "🐎", title: "Темна конячка", unit: "місць угору за раунд" },
  { id: "roundRecord", icon: "🚀", title: "Рекорд раунду", unit: "балів за раунд" },
  { id: "silent", icon: "🤫", title: "Тихий хід", unit: "треків без жодного голосу" },
];

/** Місце в таблиці: 1 + скільки гравців мають строго більше балів. */
export function rankOf(scores, uid, among = Object.keys(scores)) {
  const mine = scores[uid] ?? 0;
  return 1 + among.filter((u) => u !== uid && (scores[u] ?? 0) > mine).length;
}

/** Хто з map {uid: значення} має найбільше (лише якщо > 0). */
function leaders(map) {
  const entries = Object.entries(map).filter(([, v]) => v > 0);
  if (!entries.length) return [];
  const top = Math.max(...entries.map(([, v]) => v));
  return entries.filter(([, v]) => v === top).map(([uid, value]) => ({ uid, value }));
}

const add = (map, uid, v) => { map[uid] = (map[uid] ?? 0) + v; };

/**
 * @param {object[]} rounds  звичайні раунди
 * @returns {{id:string, winners:{uid:string, value:number, round?:number}[]}[]}  лише титули, що мають власника
 */
export function computeTitles(rounds = []) {
  const chat = {}, silent = {}, record = {}, recordRound = {}, jump = {}, jumpRound = {};
  for (const r of rounds) {
    for (const p of r.plays ?? []) {
      if (!p.uid) continue;
      add(chat, p.uid, p.chatVotes ?? 0);
      if ((p.votes ?? 0) === 0) add(silent, p.uid, 1);
      const pts = p.points ?? p.votes ?? 0;
      if (pts > (record[p.uid] ?? 0)) { record[p.uid] = pts; recordRound[p.uid] = r.n; }
    }
    // Темна конячка: на скільки місць гравець піднявся за цей раунд.
    const before = r.scoresBefore, after = r.scoresAfter;
    if (before && after) {
      const among = Object.keys(after).filter((u) => u in before);
      for (const uid of among) {
        const up = rankOf(before, uid, among) - rankOf(after, uid, among);
        if (up > (jump[uid] ?? 0)) { jump[uid] = up; jumpRound[uid] = r.n; }
      }
    }
  }
  const withRound = (list, rounds) => list.map((w) => ({ ...w, round: rounds[w.uid] }));
  const result = [
    { id: "chatFavorite", winners: leaders(chat) },
    { id: "darkHorse", winners: withRound(leaders(jump), jumpRound) },
    { id: "roundRecord", winners: withRound(leaders(record), recordRound) },
    { id: "silent", winners: leaders(silent) },
  ];
  return result.filter((t) => t.winners.length);
}

/**
 * Камбек: хто зараз на останньому місці серед гравців за столом і ще не отримував бонус.
 * Якщо всі мають однаково балів — останнього немає.
 * @param {{uid:string, score?:number, status:string, comebackGot?:boolean}[]} players
 */
export function comebackPlayers(players) {
  const active = players.filter((p) => p.status === "active");
  if (active.length < 2) return [];
  const scores = active.map((p) => p.score ?? 0);
  const min = Math.min(...scores);
  if (scores.every((s) => s === min)) return [];
  return active.filter((p) => (p.score ?? 0) === min && !p.comebackGot);
}
