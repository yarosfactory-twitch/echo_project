import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTitles, rankOf, comebackPlayers } from "../js/titles.js";

const byId = (list, id) => list.find((t) => t.id === id);

test("Місце в таблиці з нічиями", () => {
  const s = { a: 5, b: 5, c: 2 };
  assert.equal(rankOf(s, "a"), 1);
  assert.equal(rankOf(s, "b"), 1);
  assert.equal(rankOf(s, "c"), 3);
});

test("Титули: чат, рекорд, тихий хід, темна конячка", () => {
  const rounds = [
    { n: 1, plays: [
        { uid: "a", votes: 4, chatVotes: 3, points: 4 },
        { uid: "b", votes: 1, chatVotes: 1, points: 1 },
        { uid: "c", votes: 0, chatVotes: 0, points: 0 }],
      scoresBefore: { a: 0, b: 0, c: 0 }, scoresAfter: { a: 4, b: 1, c: 0 } },
    { n: 2, plays: [
        { uid: "a", votes: 0, chatVotes: 0, points: 0 },
        { uid: "c", votes: 5, chatVotes: 5, points: 10 }], // подвоєння
      scoresBefore: { a: 4, b: 1, c: 0 }, scoresAfter: { a: 4, b: 1, c: 10 } },
  ];
  const t = computeTitles(rounds);
  assert.deepEqual(byId(t, "chatFavorite").winners.map((w) => w.uid), ["c"]);
  assert.deepEqual(byId(t, "roundRecord").winners, [{ uid: "c", value: 10, round: 2 }]);
  assert.deepEqual(byId(t, "darkHorse").winners, [{ uid: "c", value: 2, round: 2 }]);
  // a і c мають по одному треку без голосів — обидва отримують титул
  assert.deepEqual(byId(t, "silent").winners.map((w) => w.uid).sort(), ["a", "c"]);
});

test("Титули без даних не роздаються", () => {
  assert.deepEqual(computeTitles([]), []);
  const t = computeTitles([{ n: 1, plays: [{ uid: "a", votes: 2 }] }]); // стара гра без chatVotes
  assert.equal(byId(t, "chatFavorite"), undefined);
  assert.equal(byId(t, "darkHorse"), undefined);
  assert.equal(byId(t, "roundRecord").winners[0].value, 2);
});

test("Камбек: усі на останньому місці, раз на гру, без нічиєї всіх", () => {
  const ps = [
    { uid: "a", score: 5, status: "active" },
    { uid: "b", score: 1, status: "active" },
    { uid: "c", score: 1, status: "active" },
    { uid: "d", score: 0, status: "out" },
  ];
  assert.deepEqual(comebackPlayers(ps).map((p) => p.uid), ["b", "c"]);
  ps[1].comebackGot = true;
  assert.deepEqual(comebackPlayers(ps).map((p) => p.uid), ["c"]);
  assert.deepEqual(comebackPlayers([{ uid: "a", score: 2, status: "active" }, { uid: "b", score: 2, status: "active" }]), []);
});
