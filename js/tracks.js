// Розбір і перевірка посилань на треки (YouTube, SoundCloud).
// Ключ треку (key) однаковий для різних форм одного посилання:
// youtu.be/X, youtube.com/watch?v=X&t=30, music.youtube.com/... → yt_X.

export class TrackError extends Error {}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/** Таймкод у форматах 83, 83s, 1m23s, 1h2m3s, 1:23, 1:02:03 → секунди (або 0). */
export function parseTimecode(raw) {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return 0;
  if (/^\d+(\.\d+)?s?$/.test(t)) return Math.floor(parseFloat(t));
  const hms = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (hms && (hms[1] || hms[2] || hms[3])) return (+hms[1] || 0) * 3600 + (+hms[2] || 0) * 60 + (+hms[3] || 0);
  const colon = t.match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (colon) return colon[3] != null ? +colon[1] * 3600 + +colon[2] * 60 + +colon[3] : +colon[1] * 60 + +colon[2];
  return 0;
}

/** Час старту з посилання: YouTube ?t= / &start= / #t=, SoundCloud #t=. */
export function parseStartTime(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return 0; }
  const fromQuery = u.searchParams.get("t") ?? u.searchParams.get("start");
  if (fromQuery) return parseTimecode(fromQuery);
  const hash = new URLSearchParams(u.hash.replace(/^#/, ""));
  return parseTimecode(hash.get("t") ?? "");
}

/** 83 → "1:23", 3723 → "1:02:03". */
export function formatTimecode(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

/** Чистий розбір без мережі. → {source:'youtube', id} | {source:'soundcloud', url} | null */
export function parseTrackUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, "");

  if (host === "youtu.be") {
    const id = u.pathname.slice(1).split("/")[0];
    return YT_ID.test(id) ? { source: "youtube", id } : null;
  }
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    let id = u.searchParams.get("v");
    if (!id) id = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)?.[1];
    return id && YT_ID.test(id) ? { source: "youtube", id } : null;
  }
  if (host === "soundcloud.com" || host === "on.soundcloud.com") {
    const path = u.pathname.replace(/\/+$/, "");
    const parts = path.split("/").filter(Boolean);
    if (host === "soundcloud.com" && (parts.length < 2 || parts[1] === "sets")) return null;
    if (host === "on.soundcloud.com" && parts.length < 1) return null;
    return { source: "soundcloud", url: `https://${host}${path}` };
  }
  return null;
}

/** ID треку з html-коду вбудовування SoundCloud. Плейлисти → null. */
export function extractSoundCloudId(html = "") {
  // SoundCloud кодує адресу по-різному: tracks/123, tracks%2F123, а новіші
  // вбудовування — двічі: tracks%2Fsoundcloud%253Atracks%253A123. Розкодовуємо,
  // поки є що розкодовувати, і шукаємо обидва формати.
  let text = String(html);
  for (let i = 0; i < 4; i++) {
    let next;
    try { next = decodeURIComponent(text); } catch { break; }
    if (next === text) break;
    text = next;
  }
  if (/playlists[/:]\d+|soundcloud:playlists:\d+/.test(text) && !/tracks[/:]\d+|soundcloud:tracks:\d+/.test(text)) return null;
  const m = text.match(/soundcloud:tracks:(\d+)/) ?? text.match(/\btracks[/:](\d+)/);
  return m ? m[1] : null;
}

/** Перевіряє, що трек існує і його можна вбудувати.
 *  → { key, source, id, url, title, author } або кидає TrackError. */
export const SHORT_LINK_HINT =
  "SoundCloud не розпізнав коротке посилання. Відкрий його в браузері й скопіюй повну адресу з рядка (soundcloud.com/виконавець/трек)";

export async function resolveTrack(raw) {
  const parsed = parseTrackUrl(raw);
  if (!parsed) throw new TrackError("Це не схоже на посилання на трек YouTube або SoundCloud");
  const track = parsed.source === "youtube" ? await resolveYouTube(parsed.id) : await resolveSoundCloud(parsed.url);
  const start = parseStartTime(raw);
  // Посилання «Відкрити в новій вкладці» теж відкриває з таймкоду.
  if (start) track.url = track.source === "youtube" ? `${track.url}&t=${start}s` : `${track.url}#t=${formatTimecode(start)}`;
  return { ...track, start };
}

async function resolveYouTube(id) {
  const watch = `https://www.youtube.com/watch?v=${id}`;
  let data;
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watch)}`);
    if (res.status === 401 || res.status === 403) {
      throw new TrackError("Автор заборонив вбудовування цього відео, обери інше");
    }
    if (!res.ok) throw new TrackError("Відео не знайдено: воно видалене або приватне");
    data = await res.json();
  } catch (e) {
    if (e instanceof TrackError) throw e;
    data = await viaNoembed(watch); // запасний шлях, якщо YouTube не віддав CORS
  }
  // Обмеження за віком oEmbed не показує: такі відео відловимо вже в грі.
  return { key: `yt_${id}`, source: "youtube", id, url: watch, title: data.title || "Без назви", author: data.author_name || "" };
}

async function viaNoembed(url) {
  let data;
  try {
    data = await (await fetch(`https://noembed.com/embed?url=${encodeURIComponent(url)}`)).json();
  } catch {
    throw new TrackError("Не вдалося перевірити трек, спробуй ще раз");
  }
  if (data.error) throw new TrackError("Відео недоступне для вбудовування");
  return data;
}

async function resolveSoundCloud(url) {
  let res;
  try {
    res = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`);
  } catch {
    throw new TrackError("Не вдалося перевірити трек SoundCloud, спробуй ще раз");
  }
  if (!res.ok) {
    throw new TrackError(url.includes("on.soundcloud.com") ? SHORT_LINK_HINT : "Трек SoundCloud не знайдено або він приватний");
  }
  const data = await res.json();
  const html = String(data.html ?? "");
  let decoded = html;
  for (let i = 0; i < 4; i++) { try { const n = decodeURIComponent(decoded); if (n === decoded) break; decoded = n; } catch { break; } }
  if (/playlists|\/sets\//.test(decoded) && !/tracks/.test(decoded)) {
    throw new TrackError("Це плейлист SoundCloud, а треба окремий трек");
  }
  const meta = { source: "soundcloud", url, title: data.title || "Без назви", author: data.author_name || "" };
  const id = extractSoundCloudId(html);
  if (id) return { key: `sc_${id}`, id, ...meta };
  // Запасний шлях: невідомий формат — беремо готовий плеєр з відповіді SoundCloud.
  const embed = html.match(/src="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
  // Плеєр SoundCloud не приймає короткі посилання on.soundcloud.com
  // («You have not provided a valid SoundCloud URL»), тож такий плеєр не годиться.
  const embedTarget = embed ? new URL(embed).searchParams.get("url") ?? "" : "";
  if (!embed || /on\.soundcloud\.com/.test(embedTarget)) {
    throw new TrackError(SHORT_LINK_HINT);
  }
  return { key: `sc_${new URL(url).pathname.replace(/\W+/g, "_")}`, id: null, embed, ...meta };
}

// ── Безпека: дані карт приходять від гравців ────────────────
// Гравець може записати в свою колоду в базі будь-що, оминаючи сайт. Тому перед тим, як
// вставити адресу в плеєр (iframe) чи посилання, карту перевіряємо й перебудовуємо з
// перевірених частин. Інакше, наприклад, embed = "javascript:…" виконався б на сторінці
// ведучого з його правами.

const SC_PLAYER = "https://w.soundcloud.com/player/";
const LINK_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be",
  "soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com",
]);

/** Посилання лише https на YouTube/SoundCloud, інакше "#". */
export function safeHref(raw) {
  try {
    const u = new URL(String(raw));
    return u.protocol === "https:" && LINK_HOSTS.has(u.hostname.toLowerCase()) ? u.toString() : "#";
  } catch { return "#"; }
}

/** Готовий плеєр SoundCloud з відповіді oEmbed: лише w.soundcloud.com/player/ з треком api.soundcloud.com. */
function safeScEmbed(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "https:" || u.hostname !== "w.soundcloud.com" || u.pathname !== "/player/") return null;
    const inner = new URL(u.searchParams.get("url") ?? "");
    if (inner.protocol !== "https:" || !["api.soundcloud.com", "soundcloud.com"].includes(inner.hostname)) return null;
    return `${SC_PLAYER}?url=${encodeURIComponent(inner.toString())}&visual=true`;
  } catch { return null; }
}

/**
 * Перевірена копія карти або null, якщо вона підроблена.
 * Залишає лише відомі поля з перевіреними значеннями.
 */
export function sanitizeCard(card) {
  if (!card || typeof card !== "object") return null;
  const start = Math.min(86400, Math.max(0, Math.floor(Number(card.start) || 0)));
  const text = (v, n) => String(v ?? "").slice(0, n);
  const base = { title: text(card.title, 200) || "Без назви", author: text(card.author, 100), start, used: !!card.used };
  if (card.burned) base.burned = true;
  if (card.source === "youtube") {
    const id = String(card.id ?? "");
    if (!YT_ID.test(id)) return null;
    const url = `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}s` : ""}`;
    return { ...base, key: `yt_${id}`, source: "youtube", id, embed: null, url };
  }
  if (card.source === "soundcloud") {
    const href = safeHref(card.url);
    const link = href === "#" ? "" : href;
    const id = String(card.id ?? "");
    if (/^\d{1,20}$/.test(id)) return { ...base, key: `sc_${id}`, source: "soundcloud", id, embed: null, url: link };
    const embed = safeScEmbed(card.embed);
    if (!embed) return null;
    const key = /^sc_[A-Za-z0-9_]{1,200}$/.test(String(card.key)) ? String(card.key) : null;
    return key ? { ...base, key, source: "soundcloud", id: null, embed, url: link } : null;
  }
  return null;
}

/** Адреса плеєра для iframe на сторінці ведучого. Порожньо, якщо карта підозріла.
 *  YouTube стартує з card.start; SoundCloud перемотує ведучий через Widget API (host.js). */
export function embedUrl(raw) {
  const card = sanitizeCard(raw);
  if (!card) return "";
  if (card.source === "youtube") {
    const start = card.start ? `&start=${card.start}` : "";
    // enablejsapi=1: щоб ведучий міг керувати гучністю через postMessage.
    return `https://www.youtube.com/embed/${card.id}?autoplay=1&rel=0&enablejsapi=1${start}`;
  }
  if (card.embed) return `${card.embed}&auto_play=true`;
  const api = `https://api.soundcloud.com/tracks/${card.id}`;
  return `${SC_PLAYER}?url=${encodeURIComponent(api)}&auto_play=true&visual=true`;
}
