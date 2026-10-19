// Статистика использования для «Карты работы» (см. voice_report_bot/work_map.py): какие экраны открывают, какие кнопки жмут,
// что и сколько смотрят. Только названия (экран, id кнопки, название тайтла) и длительность — никакого введённого текста,
// содержимого сообщений или файлов. Человек может выключить сбор в Настройки → Поведение и стереть уже собранное.

import { apiGet, apiPost, openSheet, dismissSheet, toast } from "./api.js";
import { esc } from "./utils.js";
import { state } from "./state.js";

const KEY = "project-telemetry";          // "1" — разрешил; "0" или пусто — не собираем (пока человек явно не согласится)
const FLUSH_MS = 30_000;
const MAX_QUEUE = 300;

let queue = [];
let screen = "";
let screenMs = 0;       // накопленное ВИДИМОЕ время на текущем экране
let visibleSince = 0;
let lastClick = { name: "", at: 0 };

export function trackingOn() {
  try { return localStorage.getItem(KEY) === "1"; } catch (_) { return false; }
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

// Окно согласия: пока человек не выбрал, ничего не собирается.
const CONSENT_HTML = `
  <h2>Помогите нам развивать проект!</h2>
  <div class="tm-text">
    <p>Включая сбор статистики использования, вы вносите свой вклад в развитие нашего проекта. Для нас это действительно важно!</p>
    <p>Система аналитики помогает нам лучше понимать, как пользователи взаимодействуют с программой: какие функции используют, на какие элементы нажимают, какие действия выполняют и с какими трудностями сталкиваются.</p>
    <p>На основе этих данных можем улучшать существующие возможности, оптимизировать работу программы, исправлять неудобства и внедрять новые функции, которые сделают её ещё полезнее.</p>
    <p>Разработчик стремится не просто развивать программу, а создавать уникальные решения, реализовывать новые идеи и делать то, чего раньше не было в нашем проекте. Например, запихнуть туда тик-ток, чтобы вы смотрели. Можно созвон тут, позвать ребят, чтобы вместе все смотрели сериал, и много амбициозных решений. Как иронично, правда?</p>
    <p>Я уважаю ваше право на конфиденциальность. Если вы не хотите делиться статистикой использования или считаете такой сбор данных ненужным, это исключительно ваш выбор. Я не собираюсь навязывать вам своё решение.</p>
    <p>Чтобы у вас не возникало лишних вопросов, вы можете заранее ознакомиться с тем, какие именно данные собираются и для каких целей они используются.</p>
    <details class="tm-details"><summary>Какие данные собираются</summary>
      <ul>
        <li><b>Собирается:</b> какие экраны вы открываете и сколько на них находитесь; какие кнопки нажимаете (по названию кнопки); что и сколько смотрите (название тайтла и озвучки); скачивания, сборки, публикации постов и архивирование.</li>
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
  overlay.addEventListener("sheet-dismissed", () => { asking = false; });   // закрыл крестиком/Escape — спросим при следующем запуске
}

// После входа: подхватываем выбор, сделанный на другом устройстве; если человек ещё не выбирал — спрашиваем.
document.addEventListener("project:tab", ev => { trackScreen(ev.detail); });
let started = false;
document.addEventListener("media-token-ready", async () => {
  if (started) return;
  started = true;
  trackScreen(state.activeTab || "");
  try {
    const { enabled, decided } = await apiGet("/telemetry/consent");
    try { localStorage.setItem(KEY, enabled ? "1" : "0"); } catch (_) { /* не критично */ }
    if (!decided) askConsent();
  } catch (_) { /* не критично */ }
});
