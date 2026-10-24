import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTrackUrl, extractSoundCloudId, embedUrl } from "../js/tracks.js";
import { parseVote, VoteCollector } from "../js/votes.js";
import { standings, leadersTie, lateJoinScore, shopPrice, shuffle, deckSize } from "../js/game-logic.js";

test("YouTube: різні форми посилання дають той самий id", () => {
  const forms = [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s",
    "https://youtu.be/dQw4w9WgXcQ?si=abc",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RD",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "  https://www.youtube.com/embed/dQw4w9WgXcQ  ",
  ];
  for (const f of forms) assert.deepEqual(parseTrackUrl(f), { source: "youtube", id: "dQw4w9WgXcQ" }, f);
});

test("Відкидає не-треки", () => {
  for (const bad of ["", "привіт", "https://youtube.com/", "https://youtube.com/watch?v=short",
    "https://soundcloud.com/artist", "https://soundcloud.com/artist/sets/album", "https://spotify.com/track/x",
    "javascript:alert(1)"]) {
    assert.equal(parseTrackUrl(bad), null, bad);
  }
});

test("SoundCloud: нормалізація адреси і id з html вбудовування", () => {
  assert.deepEqual(parseTrackUrl("https://soundcloud.com/artist/song/?si=1"), { source: "soundcloud", url: "https://soundcloud.com/artist/song" });
  assert.deepEqual(parseTrackUrl("https://on.soundcloud.com/AbC123"), { source: "soundcloud", url: "https://on.soundcloud.com/AbC123" });
  const html = '<iframe src="https://w.soundcloud.com/player/?visual=true&url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F123456&show_artwork=true"></iframe>';
  assert.equal(extractSoundCloudId(html), "123456");
  assert.equal(extractSoundCloudId("api.soundcloud.com/playlists/99"), null);
  assert.match(embedUrl({ source: "soundcloud", id: "123456" }), /tracks%2F123456/);
  assert.equal(embedUrl({ source: "youtube", id: "dQw4w9WgXcQ" }), "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0");
});

test("Голос — лише число в межах кількості треків", () => {
  assert.equal(parseVote("3", 5), 3);
  assert.equal(parseVote("  2 ", 5), 2);
  assert.equal(parseVote("6", 5), null);
  assert.equal(parseVote("0", 5), null);
  assert.equal(parseVote("3 години грав", 5), null);
  assert.equal(parseVote("№3", 5), null);
  assert.equal(parseVote("3.", 5), null);
});

test("Підрахунок: останній голос, без ботів, без голосу за себе", () => {
  const c = new VoteCollector({ trackCount: 3, slotAuthors: { 1: "alice", 2: "bob" }, bots: ["Nightbot"] });
  assert.equal(c.handle("viewer", "1"), false, "закрите голосування");
  c.open = true;
  c.handle("viewer", "1");
  c.handle("viewer", "2");          // передумав → рахується 2
  c.handle("nightbot", "1");        // бот
  c.handle("alice", "1");           // за себе — ігнор
  c.handle("alice", "3");           // за іншого — ок
  c.handle("Bob", "2");             // за себе (регістр не важить) — ігнор
  c.handle("spam", "lol 1");
  c.handle("outplayer", "1");       // вибулий/без треку — вільно
  assert.deepEqual(c.tally(), { 1: 1, 2: 1, 3: 1 });
  assert.equal(c.voterCount, 3);
});

test("Таблиця: дограли вище вибулих, переможець після колеса першим", () => {
  const ps = [
    { uid: "a", status: "active", score: 5, displayName: "A" },
    { uid: "b", status: "active", score: 7, displayName: "B" },
    { uid: "c", status: "out", score: 9, displayName: "C" },
    { uid: "d", status: "active", score: 7, displayName: "D" },
  ];
  assert.deepEqual(leadersTie(ps).map((p) => p.uid), ["b", "d"]);
  assert.deepEqual(standings(ps, "d").map((p) => [p.uid, p.place]), [["d", 1], ["b", 2], ["a", 3], ["c", 4]]);
  assert.equal(lateJoinScore(ps), 5);
  assert.equal(lateJoinScore([]), 0);
});

test("Ціни магазину і розмір колоди", () => {
  assert.equal(shopPrice(0, 25), 1);
  assert.equal(shopPrice(9, 15), 2);
  assert.equal(shopPrice(40, 25), 10);
  assert.equal(deckSize({ rounds: 5, extraCards: 2 }), 7);
  const s = shuffle([1, 2, 3, 4, 5]);
  assert.deepEqual([...s].sort(), [1, 2, 3, 4, 5]);
});

import { landingRow } from "../js/reel.js";
test("Барабан зупиняється на обраному рядку в передостанній копії", () => {
  // 2 рядки «хвоста» зверху + 10 повних копій по 7 тем + індекс цілі
  assert.equal(landingRow(7, 3), 2 + 10 * 7 + 3);
  assert.equal(landingRow(1, 0), 2 + 10);
});
