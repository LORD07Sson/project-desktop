// Системные уведомления Windows — общий выключатель из «Настроек» и одно
// правило: пока окно приложения в фокусе, всплывашку не показываем —
// человек и так видит колокольчик. Свёрнуто, в трее, за другим окном —
// показываем.

import { sendNotification } from "./tauri.js";

const KEY = "project_desktop_notify";

export function desktopNotifyEnabled() {
  try { return localStorage.getItem(KEY) !== "0"; } catch (_) { return true; }
}

export function setDesktopNotifyEnabled(on) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (_) { /* приватный режим — останется включено */ }
}

// Какие события показывать (Настройки → Уведомления). Ключи — те же
// kind, что у колокольчика (inbox.js), плюс assign — новое назначение.
export const NOTIFY_KINDS = {
  assign: ["Назначили на серию", "новая серия на вас — в том числе у взятых тайтлов"],
  work: ["Действия по моим сериям", "статус, файлы, заметки коллег"],
  at: ["Упоминания @вас", "в чатах и заметках"],
  chat: ["Личные сообщения", ""],
  due: ["Сроки", "завтра, сегодня и просрочка"],
  team: ["Дни рождения", "коллег по студии"],
};
const KINDS_KEY = "project_notify_kinds";
const QUIET_KEY = "project_notify_quiet";

export function notifyKinds() {
  let off = [];
  try { off = JSON.parse(localStorage.getItem(KINDS_KEY) || "[]"); } catch (_) { off = []; }
  return Object.fromEntries(Object.keys(NOTIFY_KINDS).map(k => [k, !off.includes(k)]));
}
export function setNotifyKind(kind, on) {
  const cur = notifyKinds();
  cur[kind] = on;
  try { localStorage.setItem(KINDS_KEY, JSON.stringify(Object.keys(cur).filter(k => !cur[k]))); } catch (_) { /* не критично */ }
}

// Тихие часы: {on, from: "23:00", to: "09:00"} — в это время всплывашки
// не показываются (колокольчик всё равно собирает всё).
export function quietHours() {
  try { return { on: false, from: "23:00", to: "09:00", ...JSON.parse(localStorage.getItem(QUIET_KEY) || "{}") }; } catch (_) { return { on: false, from: "23:00", to: "09:00" }; }
}
export function setQuietHours(q) {
  try { localStorage.setItem(QUIET_KEY, JSON.stringify(q)); } catch (_) { /* не критично */ }
}
function inQuietHours(now = new Date()) {
  const q = quietHours();
  if (!q.on) return false;
  const mins = t => { const [h, m] = String(t).split(":").map(Number); return (h || 0) * 60 + (m || 0); };
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = mins(q.from), to = mins(q.to);
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

export function notifyDesktop(title, body, kind) {
  if (!desktopNotifyEnabled() || document.hasFocus()) return;
  if (kind && notifyKinds()[kind] === false) return;
  if (inQuietHours()) return;
  // sendNotification сама трогает window.Notification и в окружениях без
  // него бросает синхронно (см. qc.js) — уведомление не повод ронять опрос.
  try { sendNotification({ title, body }); } catch (_) { /* нет уведомлений — молчим */ }
}
