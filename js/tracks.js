// Розбір і перевірка посилань на треки (YouTube, SoundCloud).
// Ключ треку (key) однаковий для різних форм одного посилання:
// youtu.be/X, youtube.com/watch?v=X&t=30, music.youtube.com/... → yt_X.

export class TrackError extends Error {}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

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
  let text = html;
  try { text = decodeURIComponent(html); } catch { /* залишаємо як є */ }
  const m = text.match(/\b(tracks|playlists)[/:](\d+)/);
  return m && m[1] === "tracks" ? m[2] : null;
}

/** Перевіряє, що трек існує і його можна вбудувати.
 *  → { key, source, id, url, title, author } або кидає TrackError. */
export async function resolveTrack(raw) {
  const parsed = parseTrackUrl(raw);
  if (!parsed) throw new TrackError("Це не схоже на посилання на трек YouTube або SoundCloud");
  return parsed.source === "youtube" ? resolveYouTube(parsed.id) : resolveSoundCloud(parsed.url);
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
  if (!res.ok) throw new TrackError("Трек SoundCloud не знайдено або він приватний");
  const data = await res.json();
  const id = extractSoundCloudId(data.html);
  if (!id) throw new TrackError("Це не окремий трек SoundCloud (плейлист чи профіль?)");
  return { key: `sc_${id}`, source: "soundcloud", id, url, title: data.title || "Без назви", author: data.author_name || "" };
}

/** Адреса плеєра для iframe на сторінці ведучого. Трек грає з початку. */
export function embedUrl(card) {
  if (card.source === "youtube") {
    return `https://www.youtube.com/embed/${card.id}?autoplay=1&rel=0`;
  }
  const api = `https://api.soundcloud.com/tracks/${card.id}`;
  return `https://w.soundcloud.com/player/?url=${encodeURIComponent(api)}&auto_play=true&visual=true`;
}
