// Анонімне читання Twitch-чату через tmi.js (без токена і бота).
// tmi.js підключається звичайним <script> у host.html → глобальна змінна tmi.

export function connectChat(channel, onMessage, onStatus = () => {}) {
  if (!window.tmi) {
    console.error("tmi.js не завантажився: перевір <script> у host.html або блокувальник реклами");
    onStatus("error");
    return null;
  }
  onStatus("connecting");
  const client = new window.tmi.Client({
    connection: { reconnect: true, secure: true },
    channels: [channel],
  });
  client.on("message", (_channel, tags, message, self) => {
    if (!self) onMessage(tags.username, message, tags);
  });
  client.on("connected", () => onStatus("connected"));
  client.on("disconnected", () => onStatus("disconnected"));
  client.connect().catch(() => onStatus("error"));
  return client;
}
