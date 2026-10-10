// Расширенные возможности Steam: тонкие обёртки над командами Rust (src-tauri/src/steam_session.rs).
// Токены Steam остаются на стороне Rust и в хранилище ОС — сюда приходят только статус и ответы методов чтения.

import { invoke } from "./tauri.js";

export const sessionStatus = () => invoke("steam_session_status");
export const beginQr = () => invoke("steam_qr_begin");
export const pollQr = (clientId, requestId) => invoke("steam_qr_poll", { clientId, requestId });
export const signOutSteam = () => invoke("steam_sign_out");

/** Разрешённый метод чтения Steam Web API от имени вошедшего игрока. Возвращает { status, body }. */
export async function steamApi(interfaceName, method, params = {}) {
  return JSON.parse(await invoke("steam_api", { interface: interfaceName, method, params: JSON.stringify(params) }));
}
