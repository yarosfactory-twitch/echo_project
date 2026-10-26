import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeCard, safeHref, embedUrl } from "../js/tracks.js";

test("Посилання: лише https на YouTube/SoundCloud", () => {
  assert.equal(safeHref("javascript:alert(1)"), "#");
  assert.equal(safeHref("JaVaScRiPt:alert(1)"), "#");
  assert.equal(safeHref("data:text/html,<script>alert(1)</script>"), "#");
  assert.equal(safeHref("http://youtube.com/watch?v=x"), "#", "лише https");
  assert.equal(safeHref("https://evil.com/youtube.com"), "#");
  assert.equal(safeHref("https://youtube.com.evil.com/"), "#");
  assert.equal(safeHref("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(safeHref("https://soundcloud.com/a/b#t=1:00"), "https://soundcloud.com/a/b#t=1:00");
});

test("Підроблені карти відкидаються або очищаються", () => {
  assert.equal(sanitizeCard({ source: "soundcloud", id: null, embed: "javascript:parent.x=1//", key: "sc_a" }), null);
  assert.equal(sanitizeCard({ source: "soundcloud", id: null, embed: "https://evil.com/player/?url=https://api.soundcloud.com/tracks/1", key: "sc_a" }), null);
  assert.equal(sanitizeCard({ source: "soundcloud", id: null, embed: "https://w.soundcloud.com/player/?url=https://evil.com/x", key: "sc_a" }), null);
  assert.equal(sanitizeCard({ source: "youtube", id: '"><script>', title: "x" }), null);
  assert.equal(sanitizeCard({ source: "vimeo", id: "1" }), null);
  assert.equal(sanitizeCard(null), null);

  const yt = sanitizeCard({ source: "youtube", id: "dQw4w9WgXcQ", url: "javascript:alert(1)", title: "<b>x</b>", start: "90", key: "evil", extra: "x" });
  assert.equal(yt.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=90s", "адреса перебудована з id");
  assert.equal(yt.key, "yt_dQw4w9WgXcQ", "ключ перебудований");
  assert.equal(yt.start, 90);
  assert.equal(yt.extra, undefined, "зайві поля відкинуто");
  assert.equal(yt.title, "<b>x</b>", "текст лишається текстом — його екранує рендер");

  const sc = sanitizeCard({ source: "soundcloud", id: "123", url: "javascript:x" });
  assert.equal(sc.url, "", "небезпечне посилання прибрано");
  assert.equal(sanitizeCard({ source: "youtube", id: "dQw4w9WgXcQ", start: 1e9 }).start, 86400);
  assert.equal(sanitizeCard({ source: "youtube", id: "dQw4w9WgXcQ", title: "a".repeat(5000) }).title.length, 200);
});

test("Плеєр: лише справжні адреси YouTube/SoundCloud", () => {
  assert.equal(embedUrl({ source: "soundcloud", id: null, embed: "javascript:parent.x=1//", key: "sc_a" }), "");
  const good = embedUrl({ source: "soundcloud", id: null, key: "sc_a_b",
    embed: "https://w.soundcloud.com/player/?visual=true&url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2Fsoundcloud%253Atracks%253A42&show_artwork=true" });
  assert.match(good, /^https:\/\/w\.soundcloud\.com\/player\/\?url=https%3A%2F%2Fapi\.soundcloud\.com/);
  assert.match(good, /&auto_play=true$/);
  assert.match(embedUrl({ source: "youtube", id: "dQw4w9WgXcQ", start: 5 }), /^https:\/\/www\.youtube\.com\/embed\/dQw4w9WgXcQ\?/);
});
