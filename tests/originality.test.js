import { test } from "node:test";
import assert from "node:assert/strict";
import { trackSignature, findDuplicateGroups, burnPlan, burnedKeys } from "../js/originality.js";

const sig = trackSignature;

test("Різні завантаження однієї пісні дають однаковий підпис", () => {
  const same = [
    ["Океан Ельзи - Без бою (Official Video)", "Океан Ельзи"],
    ["Без бою", "Океан Ельзи - Topic"],
    ["ОКЕАН ЕЛЬЗИ — БЕЗ БОЮ [HD]", "random channel"],
    ["Без бою - Океан Ельзи (lyrics)", "lyrics hub"],
    ["Океан Ельзи - Без бою | Офіційне відео", "OkeanElzyVEVO"],
  ];
  const s0 = sig(...same[0]);
  assert.ok(s0);
  for (const [t, a] of same) assert.equal(sig(t, a), s0, t);
});

test("feat і шумові дужки прибираються", () => {
  assert.equal(
    sig("Daft Punk - Get Lucky (feat. Pharrell Williams) [Official Audio]", "DaftPunkVEVO"),
    sig("Get Lucky", "Daft Punk - Topic"),
  );
});

test("Кавер, ремікс, live — це інші треки", () => {
  const orig = sig("Imagine Dragons - Believer (Official Music Video)", "ImagineDragonsVEVO");
  for (const t of [
    "Imagine Dragons - Believer (Cover)",
    "Imagine Dragons - Believer (Live at Lollapalooza)",
    "Imagine Dragons - Believer (Slowed + Reverb)",
    "Imagine Dragons - Believer [Remix]",
    "Imagine Dragons - Believer (кавер)",
  ]) assert.notEqual(sig(t, "x"), orig, t);
});

test("Одне слово — без підпису (надто ризиковано)", () => {
  assert.equal(sig("Intro", ""), "");
  assert.equal(sig("Intro (Official Video)", "Topic"), "");
});

const deck = (uid, cards) => ({ uid, displayName: uid.toUpperCase(), cards });
const card = (key, title, author = "", extra = {}) => ({ key, title, author, source: "youtube", url: `u/${key}`, ...extra });

test("Точний збіг між гравцями горить автоматично, у всіх копіях", () => {
  const groups = findDuplicateGroups([
    deck("a", [card("yt_1", "Song One", "Artist"), card("yt_2", "Other Thing", "Band")]),
    deck("b", [card("yt_1", "Song One", "Artist")]),
    deck("c", [card("yt_1", "Song One", "Artist"), card("yt_9", "Unique Track", "Solo")]),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, "exact");
  assert.equal(groups[0].decision, "burn");
  assert.deepEqual(groups[0].cards.map((c) => c.uid).sort(), ["a", "b", "c"]);
  const plan = burnPlan(groups);
  assert.deepEqual([...plan.get("a")], ["yt_1"]);
  assert.deepEqual(burnedKeys(groups), ["yt_1"]);
});

test("Збіг за назвою — підозрілий, без рішення не горить", () => {
  const groups = findDuplicateGroups([
    deck("a", [card("yt_1", "Океан Ельзи - Без бою (Official Video)", "Океан Ельзи")]),
    deck("b", [card("sc_5", "Без бою", "Океан Ельзи - Topic", { source: "soundcloud" })]),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].type, "title");
  assert.equal(groups[0].decision, null);
  assert.equal(burnPlan(groups).size, 0);
  groups[0].decision = "burn";
  assert.deepEqual([...burnPlan(groups).keys()].sort(), ["a", "b"]);
  groups[0].decision = "keep";
  assert.equal(burnPlan(groups).size, 0);
});

test("Не збіг: той самий трек двічі в одного гравця, використані карти, точний збіг без зайвої групи", () => {
  // Дві різні версії однієї пісні в одного гравця — не між гравцями.
  assert.equal(findDuplicateGroups([
    deck("a", [card("yt_1", "Artist - Song", ""), card("yt_2", "Artist - Song (Official Video)", "")]),
    deck("b", [card("yt_3", "Something Else", "Band")]),
  ]).length, 0);
  // Зіграні (used) карти не враховуються.
  assert.equal(findDuplicateGroups([
    deck("a", [card("yt_1", "Song One", "Artist", { used: true })]),
    deck("b", [card("yt_1", "Song One", "Artist")]),
  ]).length, 0);
  // Точний збіг не дублюється підозрілою групою.
  const g = findDuplicateGroups([
    deck("a", [card("yt_1", "Artist - Song", "")]),
    deck("b", [card("yt_1", "Artist - Song", "")]),
  ]);
  assert.deepEqual(g.map((x) => x.type), ["exact"]);
});

test("Точний збіг плюс третя версія за назвою: ведучий вирішує про всіх", () => {
  const g = findDuplicateGroups([
    deck("a", [card("yt_1", "Artist - Song", "")]),
    deck("b", [card("yt_1", "Artist - Song", "")]),
    deck("c", [card("sc_7", "Song", "Artist")]),
  ]);
  assert.deepEqual(g.map((x) => x.type), ["exact", "title"]);
  assert.equal(g[1].cards.length, 3);
});
