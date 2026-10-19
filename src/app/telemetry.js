// Статистика использования для «Карты работы» (см. voice_report_bot/work_map.py): какие экраны открывают, какие кнопки жмут,
// что и сколько смотрят. Только названия (экран, id кнопки, название тайтла) и длительность — никакого введённого текста,
// содержимого сообщений или файлов. Человек может выключить сбор в Настройки → Поведение и стереть уже собранное.

import { apiGet, apiPost, toast } from "./api.js";
import { state } from "./state.js";

const KEY = "project-telemetry";          // "0" — выключено
const SEEN_KEY = "project-telemetry-seen";
const FLUSH_MS = 30_000;
const MAX_QUEUE = 300;

let queue = [];
let screen = "";
let screenMs = 0;       // накопленное ВИДИМОЕ время на текущем экране
let visibleSince = 0;
let lastClick = { name: "", at: 0 };

export function trackingOn() {
  try { return localStorage.getItem(KEY) !== "0"; } catch (_) { return true; }
}

function push(ev) {
  if (!trackingOn()) return;
  queue.push(ev);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
}

/** Действие или просмотр. kind: "action" | "watch" | "screen". */
export function track(kind, name, target, durationMs) {
  push({ kind, name: String(name).slice(0, 60), target: target ? String(target).slice(0, 80) : undefined, duration_ms: Math.round(durationMs || 0) });
}

function closeScreen() {
  if (!screen) return;
  if (visibleSince) { screenMs += Date.now() - visibleSince; visibleSince = Date.now(); }
  if (screenMs > 800) track("screen", screen, "", screenMs);
  screenMs = 0;
}

/** Открыт другой экран (вкладка). */
export function trackScreen(name) {
  if (name === screen) return;
  closeScreen();
  screen = name || "";
  screenMs = 0;
  visibleSince = document.visibilityState === "visible" ? Date.now() : 0;
}

export async function flushTelemetry() {
  if (!state.token || !queue.length || !trackingOn()) return;
  closeScreen();
  const batch = queue.splice(0, 60);
  try {
    await apiPost("/telemetry", { events: batch });
  } catch (_) {
    queue = batch.concat(queue).slice(-MAX_QUEUE); // сеть подвела — отправим в следующий раз
  }
}

/** Включить/выключить сбор. Сервер тоже узнаёт о выборе (и при желании стирает уже собранное). */
export async function setTracking(on, forget = false) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (_) { /* не критично */ }
  if (!on) queue = [];
  if (state.token) await apiPost("/telemetry/consent", { enabled: !!on, forget: !!forget });
}

// Нажатия: имя берётся только из id / data-атрибутов кнопки — текст кнопок и полей не читается.
document.addEventListener("click", ev => {
  if (!trackingOn()) return;
  const el = ev.target && ev.target.closest ? ev.target.closest("button, a, [role=button], [data-a], [data-act]") : null;
  if (!el) return;
  const raw = el.dataset.a || el.dataset.act || el.dataset.tab || el.id || "";
  if (!raw || /\d{4,}/.test(raw)) return;            // пустое или «динамическое» (с номерами) не берём
  const name = `${screen || "app"}.${raw}`.slice(0, 60);
  const now = Date.now();
  if (name === lastClick.name && now - lastClick.at < 400) return;
  lastClick = { name, at: now };
  track("action", name);
}, true);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (visibleSince) { screenMs += Date.now() - visibleSince; visibleSince = 0; }
    flushTelemetry();
  } else {
    visibleSince = Date.now();
  }
});
setInterval(flushTelemetry, FLUSH_MS);

// После входа: подхватываем выбор, сделанный на другом устройстве, и один раз честно говорим, что именно собирается.
document.addEventListener("project:tab", ev => { trackScreen(ev.detail); });
let started = false;
document.addEventListener("media-token-ready", async () => {
  if (started) return;
  started = true;
  trackScreen(state.activeTab || "");
  try {
    const { enabled } = await apiGet("/telemetry/consent");
    try { localStorage.setItem(KEY, enabled ? "1" : "0"); } catch (_) { /* не критично */ }
  } catch (_) { /* не критично */ }
  try {
    if (trackingOn() && !localStorage.getItem(SEEN_KEY)) {
      localStorage.setItem(SEEN_KEY, "1");
      toast("Приложение запоминает, какие экраны и кнопки вы используете и сколько смотрите (без текста и файлов), чтобы строить карту работы команды. Выключить: Настройки → Поведение.", "info");
    }
  } catch (_) { /* не критично */ }
});
