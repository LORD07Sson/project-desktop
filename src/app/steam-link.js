// Привязка Steam-аккаунта: сервер выдаёт адрес входа Steam (OpenID — пароль Steam в Project не вводится),
// мы открываем его в браузере и ждём, пока в /games/me не появится новый аккаунт.
import { apiGet, apiPost } from "./api.js";
import { openExternal } from "./tauri.js";

const sleep = ms => new Promise(r => setTimeout(r, ms)); // DevSkim: ignore DS172411 — функция, не строка
let busy = null;

/** Открывает вход Steam и ждёт до 3 минут. Возвращает свежий /games/me или бросает ошибку. */
export function linkSteam() {
  if (busy) return busy;
  busy = (async () => {
    const before = ((await apiGet("/games/me")).accounts || []).map(a => a.steamid);
    const { url } = await apiPost("/games/steam/start");
    await openExternal(url);
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const m = await apiGet("/games/me");
      const now = (m.accounts || []).map(a => a.steamid);
      if (now.length > before.length || now.some(id => !before.includes(id)) || (now.length && m.steamid && !before.includes(m.steamid))) return m;
    }
    throw new Error("Не дождались подтверждения от Steam. Откройте вход ещё раз.");
  })().finally(() => { busy = null; });
  return busy;
}

export const isLinking = () => !!busy;
