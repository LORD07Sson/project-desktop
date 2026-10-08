// Spotify: чистые функции — PKCE, адрес входа, разбор ответов Web API.
// Без DOM и Tauri, чтобы проверять node-тестом.

export const REDIRECT_URI = "http://127.0.0.1:8898/callback";
export const SCOPES = [
  "user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing",
  "playlist-read-private", "playlist-read-collaborative", "user-library-read", "user-library-modify",
];

const b64url = bytes => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function randomString(len = 64) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return b64url(bytes).slice(0, len);
}

/** PKCE: verifier (43–128 символов) и его SHA-256 challenge. */
export async function pkcePair() {
  const verifier = randomString(64);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export function authUrl({ clientId, challenge, state }) {
  const q = new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256", code_challenge: challenge, state, scope: SCOPES.join(" "),
  });
  return `https://accounts.spotify.com/authorize?${q}`;
}

export const looksLikeClientId = v => /^[a-f0-9]{32}$/i.test(String(v || "").trim());

export function fmtMs(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Ответ GET /me/player → то, что нужно окну; null, если ничего не играет. */
export function parsePlayer(j) {
  if (!j || !j.item) return j && j.device ? { idle: true, device: j.device } : null;
  const it = j.item;
  const images = (it.album && it.album.images) || [];
  return {
    idle: false,
    playing: !!j.is_playing,
    title: it.name || "",
    artist: (it.artists || []).map(a => a.name).join(", "),
    album: (it.album && it.album.name) || "",
    art: (images[1] || images[0] || {}).url || "",
    progressMs: j.progress_ms || 0,
    durationMs: it.duration_ms || 0,
    shuffle: !!j.shuffle_state,
    device: j.device || null,
  };
}

/** Понятные русские тексты ошибок Web API. */
export function spotifyError(status, body) {
  let reason = "";
  try { reason = JSON.parse(body).error.reason || ""; } catch (_) { /* не JSON */ }
  if (reason === "NO_ACTIVE_DEVICE") return "Нет активного устройства: откройте Spotify на телефоне или компьютере и запустите любой трек.";
  if (reason === "PREMIUM_REQUIRED" || status === 403) return "Управление воспроизведением доступно только с Spotify Premium (и аккаунт должен быть в списке пользователей приложения).";
  if (status === 401) return "Сессия Spotify закончилась — подключитесь заново.";
  if (status === 429) return "Spotify просит подождать — слишком много запросов.";
  return `Spotify ответил ошибкой ${status}.`;
}
