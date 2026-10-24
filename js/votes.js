// Підрахунок голосів з чату. Чиста логіка, без мережі (є тести).
//
// Правила:
//  - голос = повідомлення, що складається лише з числа 1..N;
//  - один голос на акаунт, рахується останній;
//  - боти не голосують;
//  - автор треку не може голосувати за свій трек (такий голос ігнорується,
//    попередній голос цієї людини лишається);
//  - вибулі й ті, хто пасував, треку в раунді не мають, тож голосують вільно.

export function parseVote(message, trackCount) {
  const text = String(message).trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= trackCount ? n : null;
}

export class VoteCollector {
  /**
   * @param {object} o
   * @param {number} o.trackCount
   * @param {Record<number,string>} o.slotAuthors  номер треку → login автора (нижній регістр)
   * @param {string[]} o.bots
   */
  constructor({ trackCount, slotAuthors = {}, bots = [] }) {
    this.trackCount = trackCount;
    this.slotAuthors = slotAuthors;
    this.bots = new Set(bots.map((b) => b.toLowerCase()));
    this.votes = new Map(); // login → slot
    this.open = false;
  }

  /** @returns {boolean} чи зарахувано повідомлення як голос */
  handle(login, message) {
    if (!this.open || !login) return false;
    const who = login.toLowerCase();
    if (this.bots.has(who)) return false;
    const slot = parseVote(message, this.trackCount);
    if (slot === null) return false;
    if (this.slotAuthors[slot] === who) return false;
    this.votes.set(who, slot);
    return true;
  }

  /** Голос із сайту (гравець натиснув на трек). Ті самі правила, що й для чату:
   *  останній голос перемагає, за свій трек не можна. */
  handleSlot(login, slot) {
    if (!this.open || !login) return false;
    const who = login.toLowerCase();
    const n = Number(slot);
    if (!Number.isInteger(n) || n < 1 || n > this.trackCount) return false;
    if (this.slotAuthors[n] === who) return false;
    this.votes.set(who, n);
    return true;
  }

  get voterCount() { return this.votes.size; }

  /** → { [slot]: кількість голосів } для всіх треків, включно з нулями */
  tally() {
    const result = {};
    for (let s = 1; s <= this.trackCount; s++) result[s] = 0;
    for (const slot of this.votes.values()) result[slot] += 1;
    return result;
  }
}
