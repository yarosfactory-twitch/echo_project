import { test } from "node:test";
import assert from "node:assert/strict";
import { priceOf, applyQueue, roundPoints, tiebreakOriginality, tiebreakWinners, wheelRotation } from "../js/shop.js";

test("Ціна: відсоток від балів, вгору, мінімум 1", () => {
  assert.equal(priceOf(0, 25), 1);
  assert.equal(priceOf(7, 15), 2);
  assert.equal(priceOf(40, 10), 4);
  assert.equal(priceOf(41, 10), 5);
});

test("Черга: «першим» на початок, «останнім» у кінець, пріоритет у того, хто купив раніше", () => {
  const sh = ["a", "b", "c", "d", "e"].map((uid) => ({ p: { uid } }));
  const order = (q) => applyQueue(sh, q).map((x) => x.p.uid).join("");
  assert.equal(order([]), "abcde");
  assert.equal(order([{ uid: "d", pos: "first", at: 2 }, { uid: "c", pos: "first", at: 1 }]), "cdabe");
  assert.equal(order([{ uid: "a", pos: "last", at: 1 }, { uid: "b", pos: "last", at: 2 }]), "cdeba");
  assert.equal(order([{ uid: "x", pos: "first", at: 1 }]), "abcde", "не зіграв карту — черга нічого не змінює");
  assert.equal(order([{ uid: "e", pos: "first", at: 1 }, { uid: "e", pos: "last", at: 2 }]), "eabcd", "одна черга на гравця");
});

test("Подвійний раунд", () => {
  assert.equal(roundPoints(3, false), 3);
  assert.equal(roundPoints(3, true), 6);
  assert.equal(roundPoints(0, true), 0);
});

test("Тай-брейк: неоригінальні та переможці", () => {
  assert.deepEqual(tiebreakOriginality([{ uid: "a", key: "1" }, { uid: "b", key: "1" }, { uid: "c", key: "2" }]),
    { originals: ["c"], unoriginal: ["a", "b"] });
  assert.deepEqual(tiebreakWinners({ a: 3, b: 5, c: 5 }), ["b", "c"]);
  assert.deepEqual(tiebreakWinners({ a: 3 }), ["a"]);
});

test("Платівка зупиняє обраного гравця під голкою", () => {
  for (const n of [2, 3, 5, 8]) {
    for (let t = 0; t < n; t++) {
      const rot = wheelRotation(n, t, 5, 0.2);
      // Після повороту центр сектора t має бути біля 0° (зверху), у межах сектора.
      const slice = 360 / n;
      const angle = ((t * slice + slice / 2 + rot) % 360 + 360) % 360;
      const dist = Math.min(angle, 360 - angle);
      assert.ok(dist < slice / 2, `n=${n} t=${t} angle=${angle}`);
    }
  }
});
