// Вхід через Twitch (Implicit grant, без сервера і без scope).
// Гравець отримує токен у браузері й передає його ведучому через
// joinRequests. Сторінка ведучого сама перевіряє токен у Twitch API,
// дивиться вік акаунту і відкликає токен. Підробити нік так не вийде:
// токен видає лише Twitch і лише власнику акаунту.
import { TWITCH_CLIENT_ID } from "./config.js";

const STATE_KEY = "echo_twitch_state";

/** Адреса повернення без index.html, щоб збігалась із зареєстрованою. */
export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

export function startLogin() {
  const state = crypto.randomUUID();
  sessionStorage.setItem(STATE_KEY, state);
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.search = new URLSearchParams({
    response_type: "token",
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: redirectUri(),
    scope: "",
    state,
  }).toString();
  location.assign(url.toString());
}

/** Забирає токен з #hash після повернення з Twitch. Повертає null, якщо його немає. */
export function consumeRedirect() {
  const hash = location.hash.slice(1);
  if (!hash.includes("access_token") && !hash.includes("error")) return null;
  const params = new URLSearchParams(hash);
  history.replaceState(null, "", location.pathname + location.search);
  const expected = sessionStorage.getItem(STATE_KEY);
  sessionStorage.removeItem(STATE_KEY);
  if (!expected || params.get("state") !== expected) return null;
  return params.get("access_token");
}

/** { client_id, login, user_id, expires_in } або null. */
export async function validateToken(token) {
  const res = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: `OAuth ${token}` },
  });
  return res.ok ? res.json() : null;
}

/** { id, login, display_name, profile_image_url, created_at } або null. */
export async function getTwitchUser(token, userId) {
  const res = await fetch(`https://api.twitch.tv/helix/users?id=${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${token}`, "Client-Id": TWITCH_CLIENT_ID },
  });
  if (!res.ok) return null;
  return (await res.json()).data?.[0] ?? null;
}

/** Після перевірки токен більше не потрібен. */
export async function revokeToken(token) {
  try {
    await fetch("https://id.twitch.tv/oauth2/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: TWITCH_CLIENT_ID, token }).toString(),
    });
  } catch { /* не критично */ }
}

export function accountAgeDays(createdAt, now = Date.now()) {
  return (now - new Date(createdAt).getTime()) / 86_400_000;
}
