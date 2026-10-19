// «Аналитика» = «Пульс студии»: один экран с живой картой студии (pulse.html в iframe — тяжёлая canvas-анимация не делит CSS
// и скрипты с приложением). Сюда сводятся все данные аналитики: метрики и динамика, нагрузка, исполнители, а для владельца
// ещё и выводы алгоритма (сроки, узкие места, кто чем занят, связь). Страница получает их одним сообщением.

import { apiGet } from "./api.js";
import { esc } from "./utils.js";
import { state } from "./state.js";
import { openReportDetail } from "./report-detail.js";

let frame = null;
let listening = false;
let pending = null;   // промис с данными, пока страница не сказала «готова»

function onMessage(ev) {
  if (!frame || ev.source !== frame.contentWindow || ev.origin !== window.location.origin) return;
  const msg = ev.data;
  if (!msg || msg.source !== "pulse") return;
  if (msg.type === "ready") deliver();
  else if (msg.type === "open-report" && /^[\w-]{1,40}$/.test(String(msg.public_id || ""))) openReportDetail(String(msg.public_id));
}

function deliver() {
  if (!frame || !pending) return;
  const win = frame.contentWindow;
  pending.then(
    data => win.postMessage({ source: "app", type: "pulse-data", data }, window.location.origin),
    err => win.postMessage({ source: "app", type: "pulse-error", text: `Не удалось загрузить данные: ${(err && err.message) || err}` }, window.location.origin),
  );
}

async function collect() {
  const [pulse, project, trend, workmap] = await Promise.all([
    apiGet("/pulse"),
    apiGet("/analytics/project").catch(() => null),
    apiGet("/trend").catch(() => null),
    state.isOwner ? apiGet("/analytics/work-map", { days: 30 }).catch(() => null) : Promise.resolve(null),
  ]);
  return {
    ...pulse,
    analytics: project ? {
      metrics: {
        completed_30d: project.completed_30d, completed_prior_30d: project.completed_prior_30d, avg_turnaround_days: project.avg_turnaround_days,
        overdue_now: project.overdue_now, on_time_rate: project.on_time_rate,
      },
      workload: project.workload || [], performers: project.performers || [], trend,
    } : null,
    workmap,
  };
}

export function mountPulse(root) {
  if (!root) return;
  if (!listening) { window.addEventListener("message", onMessage); listening = true; }
  // Каждый заход — свежая страница и свежие данные (вступление играется не чаще раза в день).
  root.innerHTML = `<iframe class="pulse-frame" title="${esc("Аналитика — пульс студии")}" src="pulse.html"></iframe>`;
  frame = root.querySelector("iframe");
  pending = collect();
  pending.catch(() => { /* ошибку покажет сама страница */ });
}
