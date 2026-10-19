// «Пульс студии» внутри Аналитики: живая карта студии (pulse.html в iframe — тяжёлая canvas-анимация не делит CSS и скрипты
// с приложением). Её наполняет алгоритм «Карты работы»: сроки, узкие места, кто чем занят, связь.
// Данные берём у сервера (/pulse) и отдаём странице через postMessage; её «Открыть серию» приходит сюда и открывает карточку отчёта.

import { apiGet } from "./api.js";
import { esc } from "./utils.js";
import { openReportDetail } from "./report-detail.js";

let frame = null;
let listening = false;

function onMessage(ev) {
  if (!frame || ev.source !== frame.contentWindow || ev.origin !== window.location.origin) return;
  const msg = ev.data;
  if (!msg || msg.source !== "pulse") return;
  if (msg.type === "ready") deliver();
  else if (msg.type === "open-report" && /^[\w-]{1,40}$/.test(String(msg.public_id || ""))) openReportDetail(String(msg.public_id));
}

let pending = null;   // промис данных, пока страница не сказала «готова»

function deliver() {
  if (!frame || !pending) return;
  const win = frame.contentWindow;
  pending.then(
    data => win.postMessage({ source: "app", type: "pulse-data", data }, window.location.origin),
    err => win.postMessage({ source: "app", type: "pulse-error", text: `Не удалось загрузить данные: ${(err && err.message) || err}` }, window.location.origin),
  );
}

export function mountPulse(root) {
  if (!root) return;
  if (!listening) { window.addEventListener("message", onMessage); listening = true; }
  // Каждый заход — свежая страница и свежие данные (вступление играется не чаще раза в день).
  root.innerHTML = `<iframe class="pulse-frame" title="${esc("Пульс студии")}" src="pulse.html"></iframe>`;
  frame = root.querySelector("iframe");
  pending = apiGet("/pulse");
  pending.catch(() => { /* ошибку покажет сама страница */ });
}
