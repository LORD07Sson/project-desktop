
import { invoke, getVersion } from "./tauri.js";
import { apiGet, apiPost, openSheet, dismissSheet, toast, API_BASE } from "./api.js";
import stareUrl from "../assets/stare-ji.gif";
import { state } from "./state.js";

const KEY = "project-telemetry";
const FLUSH_MS = 30_000;
const MAX_QUEUE = 300;

let queue = [];
let screen = "";
let screenMs = 0;
let visibleSince = 0;
let lastClick = { name: "", at: 0 };
const trail = [];

function step(text) {
  trail.push(text);
  if (trail.length > 6) trail.shift();
}

export function trackingOn() {
  try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; }
}

function push(ev) {
  if (!trackingOn()) return;
  queue.push(ev);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
}

export function track(kind, name, target, durationMs) {
  push({ kind, name: String(name).slice(0, 60), target: target ? String(target).slice(0, 80) : undefined, duration_ms: Math.round(durationMs || 0) });
}

function closeScreen() {
  if (!screen) return;
  if (visibleSince) { screenMs += Date.now() - visibleSince; visibleSince = Date.now(); }
  if (screenMs > 800) track("screen", screen, "", screenMs);
  screenMs = 0;
}

export function trackScreen(name) {
  if (name === screen) return;
  closeScreen();
  screen = name || "";
  if (screen) step(`открыл: ${screen}`);
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
    queue = batch.concat(queue).slice(-MAX_QUEUE);
  }
}

export async function setTracking(on, forget = false) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch (_) { }
  if (!on) { queue = []; savePendingNet([]); }
  if (state.token) await apiPost("/telemetry/consent", { enabled: !!on, forget: !!forget });
  if (on) document.dispatchEvent(new CustomEvent("project:telemetry-on"));
}

document.addEventListener("click", ev => {
  if (!trackingOn()) return;
  const el = ev.target && ev.target.closest ? ev.target.closest("button, a, [role=button], [data-a], [data-act]") : null;
  if (!el) return;
  const raw = el.dataset.a || el.dataset.act || el.dataset.tab || el.id || "";
  if (!raw || /\d{4,}/.test(raw) || /^win-/.test(raw)) return;
  const name = `${screen || "app"}.${raw}`.slice(0, 60);
  const now = Date.now();
  if (name === lastClick.name && now - lastClick.at < 400) return;
  lastClick = { name, at: now };
  step(`нажал: ${name}`);
  track("action", name);
}, true);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (visibleSince) { screenMs += Date.now() - visibleSince; visibleSince = 0; }
    flushTelemetry();
    flushErrors();
  } else {
    visibleSince = Date.now();
  }
});
setInterval(flushTelemetry, FLUSH_MS);

const ERR_FLUSH_MS = 3000;
const OFFLINE_REPEAT_MS = 10 * 60_000;
let errQueue = [];
let errTimer = null;
let lastErr = { key: "", at: 0 };
let lastApi = null;
let appVersion = "";
getVersion().then(v => { appVersion = v; }).catch(() => { });

let lastOffline = 0;

function reportError(kind, message, detail, offline = false) {
  if (!trackingOn() || !message) return;
  const key = `${kind}:${message}`, now = Date.now();
  if (key === lastErr.key && now - lastErr.at < 5000) return;
  if (offline && now - lastOffline < OFFLINE_REPEAT_MS) return;
  if (offline) lastOffline = now;
  lastErr = { key, at: now };
  errQueue.push({ kind, message: String(message).slice(0, 300), detail: detail ? String(detail).slice(0, 600) : undefined, screen, trail: trail.slice(), version: appVersion });
  if (errQueue.length > 40) errQueue = errQueue.slice(-40);
  clearTimeout(errTimer);
  errTimer = setTimeout(flushErrors, ERR_FLUSH_MS); // DevSkim: ignore DS172411
}

async function flushErrors() {
  if (!state.token || !errQueue.length || !trackingOn()) return;
  const batch = errQueue.splice(0, 20);
  try {
    await apiPost("/telemetry/errors", { errors: batch });
  } catch (_) {
    errQueue = batch.concat(errQueue).slice(-40);
  }
}

const apiLine = a => `${a.method} ${a.path} · ${a.status || "нет связи"}`;
document.addEventListener("project:api-fail", ev => {
  const d = ev.detail || {};
  if (String(d.path).startsWith("/telemetry")) return;
  if (lastApi) clearTimeout(lastApi.timer);
  lastApi = { ...d, at: Date.now(), timer: null };
  if (!d.status || d.status >= 500) {
    const a = lastApi;
    a.timer = setTimeout(() => reportError("api", a.message, apiLine(a), !a.status), 2500); // DevSkim: ignore DS172411
  }
});
document.addEventListener("project:error-shown", ev => {
  const recent = lastApi && Date.now() - lastApi.at < 3000 ? lastApi : null;
  if (recent) clearTimeout(recent.timer);
  reportError("toast", (ev.detail || {}).text, recent ? apiLine(recent) : "");
});
window.addEventListener("error", ev => {
  if (!ev.message || /ResizeObserver loop/.test(ev.message)) return;
  reportError("crash", ev.message, ev.filename ? `${String(ev.filename).split("/").pop()}:${ev.lineno}:${ev.colno}` : "");
});
window.addEventListener("unhandledrejection", ev => {
  const r = ev.reason;
  reportError("crash", (r && r.message) || String(r), r && r.stack ? String(r.stack).split(/\r?\n/).slice(0, 3).join(" | ") : "");
});

const NET_EVERY_MS = 20 * 60 * 1000;
const NET_PENDING_KEY = "project-net-pending";
let lastNet = 0;

function pendingNet() {
  try { return JSON.parse(localStorage.getItem(NET_PENDING_KEY) || "[]"); } catch (_) { return []; }
}
function savePendingNet(list) {
  try { localStorage.setItem(NET_PENDING_KEY, JSON.stringify(list.slice(-20))); } catch (_) { }
}

let netBusy = false;
let lastNetOk = true;
// Замер реального скачивания с сервера: только передача байтов, без ожидания, пока сервер достанет файл.
export function reportDownload({ bytes, ms, ok, error }) {
  if (!trackingOn()) return;
  if (ok && (bytes < 1048576 || ms < 300)) return;
  apiPost("/telemetry/net", { at: Date.now(), server_ok: true, dl_bytes: Math.round(bytes || 0), dl_ms: Math.max(1, Math.round(ms || 0)), dl_ok: !!ok, dl_error: ok ? "" : String(error || "").slice(0, 120) }).catch(() => { });
}

export async function runNetCheck() {
  if (!trackingOn() || !state.token) return;
  if (netBusy || Date.now() - lastNet < 30_000) return;
  netBusy = true;
  try { await netCheckOnce(); } finally { netBusy = false; }
}

async function netCheckOnce() {
  lastNet = Date.now();
  const result = { at: Date.now(), server_ok: false, server_ms: null, server_error: "", dns_ok: null, dns_ms: null, dns_provider: "", dns_servers: [] };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  const t0 = window.performance.now();
  try {
    await fetch(`${API_BASE}/whoami`, { headers: { "X-Init-Data": state.token || "" }, signal: ctl.signal });
    result.server_ok = true;
    result.server_ms = Math.round(window.performance.now() - t0);
  } catch (e) {
    result.server_error = e && e.name === "AbortError" ? "таймаут 8 с" : String((e && e.message) || e).slice(0, 100);
  } finally { clearTimeout(timer); }
  lastNetOk = result.server_ok;
  try {
    const d = await invoke("net_diagnose");
    result.dns_ok = !!d.dns_ok; result.dns_ms = d.dns_ms; result.dns_provider = d.dns_provider; result.dns_servers = d.dns_servers;
  } catch (_) { }
  const queue = pendingNet();
  if (!result.server_ok) {
    const last = queue[queue.length - 1];
    if (!last || result.at - (last.at || 0) >= 60_000) { queue.push(result); savePendingNet(queue); }
    return;
  }
  const all = queue.concat([result]);
  for (let i = 0; i < all.length; i++) {
    try { await apiPost("/telemetry/net", all[i]); } catch (_) { savePendingNet(all.slice(i)); return; }
  }
  savePendingNet([]);
}

let netScheduled = false;
function scheduleNetChecks() {
  if (netScheduled) return;
  netScheduled = true;
  runNetCheck();
  setInterval(() => { if (Date.now() - lastNet >= (lastNetOk ? NET_EVERY_MS : 60_000)) runNetCheck(); }, 60_000);
  window.addEventListener("online", () => runNetCheck());
}

const CONSENT_HTML = `
  <div class="tm-head">
    <img class="tm-stare-img" src="${stareUrl}" alt="じ―― Пристально смотрю…" draggable="false">
    <div><h2>Помогите нам развивать проект!</h2><p class="tm-sub">Включите статистику использования — это правда важно для нас.</p></div>
  </div>
  <div class="tm-text">
    <p>Включая сбор статистики использования, вы вносите свой вклад в развитие нашего проекта. Для нас это действительно важно!</p>
    <p>Система аналитики помогает нам лучше понимать, как пользователи взаимодействуют с программой: какие функции используют, на какие элементы нажимают, какие действия выполняют и с какими трудностями сталкиваются.</p>
    <p>На основе этих данных можем улучшать существующие возможности, оптимизировать работу программы, исправлять неудобства и внедрять новые функции, которые сделают её ещё полезнее.</p>
    <p>Разработчик стремится не просто развивать программу, а создавать уникальные решения, реализовывать новые идеи и делать то, чего раньше не было в нашем проекте. Например, запихнуть туда тик-ток, чтобы вы смотрели. Можно созвон тут, позвать ребят, чтобы вместе все смотрели сериал, и много амбициозных решений. Как иронично, правда?</p>
    <p>Я уважаю ваше право на конфиденциальность. Если вы не хотите делиться статистикой использования или считаете такой сбор данных ненужным, это исключительно ваш выбор. Я не собираюсь навязывать вам своё решение.</p>
    <p>Чтобы у вас не возникало лишних вопросов, вы можете заранее ознакомиться с тем, какие именно данные собираются и для каких целей они используются.</p>
    <details class="tm-details"><summary>Какие данные собираются</summary>
      <ul>
        <li><b>Собирается:</b> какие экраны вы открываете и сколько на них находитесь; какие кнопки нажимаете (по названию кнопки); что и сколько смотрите (название тайтла и озвучки); скачивания, сборки, публикации постов и архивирование; состояние связи: ваш IP-адрес (половина скрыта, например 84.54.•.•) и страна, удаётся ли соединиться с нашим сервером, работает ли DNS и какой у него провайдер.</li>
        <li><b>Не собирается:</b> введённый вами текст, сообщения в чате, содержимое файлов, пароли и токены.</li>
        <li><b>Зачем:</b> строить карту работы команды (кто что делает, где серии стоят, когда примерно выйдут) и улучшать программу.</li>
        <li><b>Кто видит:</b> только владелец проекта. Данные хранятся 120 дней.</li>
        <li><b>Ваш выбор:</b> передумать можно в любой момент в Настройки → Поведение: выключить сбор или удалить уже собранное.</li>
      </ul>
    </details>
    <p class="tm-thanks">Спасибо каждому, кто помогает нам становиться лучше!</p>
  </div>
  <div class="sheet-actions"><button type="button" class="btn" data-tm="no">Не нужно</button><button type="button" class="btn primary" data-tm="yes">Помогу, включить</button></div>`;

let asking = false;
function askConsent() {
  if (asking) return;
  asking = true;
  const overlay = openSheet(CONSENT_HTML);
  overlay.querySelector(".sheet")?.classList.add("tm-sheet");
  const choose = async on => {
    try {
      await setTracking(on);
      toast(on ? "Спасибо! Статистика включена — выключить можно в Настройки → Поведение." : "Хорошо, ничего собираться не будет.", on ? "success" : "info");
    } catch (e) { toast(`Не удалось сохранить выбор: ${e.message}`, "error"); }
    dismissSheet(overlay);
  };
  overlay.querySelector('[data-tm="yes"]').addEventListener("click", () => choose(true));
  overlay.querySelector('[data-tm="no"]').addEventListener("click", () => choose(false));
  overlay.addEventListener("sheet-dismissed", () => { asking = false; });
}

document.addEventListener("project:tab", ev => { trackScreen(ev.detail); });
let started = false;
document.addEventListener("media-token-ready", async () => {
  if (started) return;
  started = true;
  trackScreen(state.activeTab || "");
  try {
    const { enabled, decided } = await apiGet("/telemetry/consent");
    try { localStorage.setItem(KEY, enabled ? "1" : "0"); } catch (_) { }
    if (decided === false) askConsent();
  } catch (_) { }
  if (trackingOn()) scheduleNetChecks();
});
document.addEventListener("project:telemetry-on", () => { if (trackingOn()) scheduleNetChecks(); });
