// ─────────────────────────────────────────────────────────────
// Налаштування echo_project. Заповни три заглушки (див. README).
// ─────────────────────────────────────────────────────────────

// Firebase Console → Project settings → Your apps → Web app → firebaseConfig
export const firebaseConfig = {
  apiKey: "PASTE_API_KEY",
  authDomain: "PASTE_PROJECT_ID.firebaseapp.com",
  projectId: "PASTE_PROJECT_ID",
  storageBucket: "PASTE_PROJECT_ID.appspot.com",
  messagingSenderId: "PASTE_SENDER_ID",
  appId: "PASTE_APP_ID",
};

// dev.twitch.tv/console → Applications → твій застосунок → Client ID
export const TWITCH_CLIENT_ID = "PASTE_TWITCH_CLIENT_ID";

// UID ведучого у Firebase. Сторінка host.html покаже його після першого входу.
// Той самий UID треба вписати у firestore.rules.
export const HOST_UID = "PASTE_HOST_UID";

export const TWITCH_CHANNEL = "yarosfactory";

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MIN_ACCOUNT_AGE_DAYS = 3;

// Повідомлення цих акаунтів не рахуються як голоси (нижній регістр).
export const CHAT_BOTS = [
  "nightbot", "streamelements", "streamlabs", "moobot", "fossabot",
  "wizebot", "soundalerts", "sery_bot", "commanderroot",
];

// Значення за замовчуванням у формі створення гри.
export const DEFAULT_SETTINGS = {
  rounds: 5,
  extraCards: 2,
  discardSeconds: 90,
  voteSeconds: 60,
  tiebreakSeconds: 180,
  // Ціни магазину у % від балів гравця (мінімум 1 бал).
  prices: { queue: 10, swap: 15, extraCard: 20, double: 25, respin: 25 },
};
