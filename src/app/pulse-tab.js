// «Аналитика» = «Пульс студии»: один экран с живой картой студии (pulse.html в iframe — тяжёлая canvas-анимация не делит CSS
// и скрипты с приложением). Сюда сводятся все данные аналитики: метрики и динамика, нагрузка, исполнители, а для владельца
// ещё и выводы алгоритма (сроки, узкие места, кто чем занят, связь). Страница получает их одним сообщением.

import { apiGet, mediaUrl } from "./api.js";
import { esc, isOverdue } from "./utils.js";
import { state } from "./state.js";
import { openReportDetail } from "./report-detail.js";
import { seriesParts } from "./reports.js";

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

// Цвета активной темы приложения (акцент: янтарь, сакура, фиалка, небо, мята…) — страница «Пульса» применяет их у себя.
const THEME_VARS = ["--bg", "--bg-2", "--bg-glow-1", "--bg-glow-2", "--surface", "--surface-2", "--surface-3", "--line", "--ink", "--ink-soft", "--ink-dim",
  "--fire", "--ember", "--gold", "--on-accent", "--fire-rgb", "--gold-rgb", "--glow-rgb"];
function currentTheme() {
  const cs = getComputedStyle(document.documentElement), vars = {};
  for (const name of THEME_VARS) { const v = cs.getPropertyValue(name).trim(); if (v) vars[name] = v; }
  return { vars, light: document.documentElement.dataset.theme === "light" };
}

function deliver() {
  if (!frame || !pending) return;
  const win = frame.contentWindow;
  pending.then(
    data => win.postMessage({ source: "app", type: "pulse-data", data, theme: currentTheme() }, window.location.origin),
    err => win.postMessage({ source: "app", type: "pulse-error", text: `Не удалось загрузить данные: ${(err && err.message) || err}`, theme: currentTheme() }, window.location.origin),
  );
}

async function collect() {
  const [pulse, project, trend, workmap, errors, team] = await Promise.all([
    apiGet("/pulse"),
    apiGet("/analytics/project").catch(() => null),
    apiGet("/trend").catch(() => null),
    state.isOwner ? apiGet("/analytics/work-map", { days: 30 }).catch(() => null) : Promise.resolve(null),
    state.isOwner ? apiGet("/analytics/errors", { days: 1 }).catch(() => null) : Promise.resolve(null),
    apiGet("/team").catch(() => null),
  ]);
  // Фото участников для экрана «Команда»: страница в iframe сама токен для картинок не знает.
  for (const p of (pulse.team && pulse.team.people) || []) p.avatar = p.tg ? mediaUrl(`/avatar/${encodeURIComponent(p.tg)}`) : null;
  return {
    ...pulse,
    analytics: project ? {
      metrics: {
        completed_30d: project.completed_30d, completed_prior_30d: project.completed_prior_30d, avg_turnaround_days: project.avg_turnaround_days,
        overdue_now: project.overdue_now, on_time_rate: project.on_time_rate,
      },
      workload: project.workload || [], performers: team ? (team.users || []).map(u => ({ name: u.name, completed: u.completed_month || 0 })) : project.performers || [], trend,
    } : null,
    workmap,
    errors,
  };
}

// Сводка — главный экран аналитики: простые ответы «что горит, кто перегружен, кто сдаёт». Граф открывается отдельно,
// потому что он тяжёлый и на такие вопросы отвечает хуже.
const VIEW_KEY = "analytics-view";
const seriesName = r => { const p = seriesParts(r); return [p.name, p.ep].filter(Boolean).join(" · "); };
const dayKey = d => d.toISOString().slice(0, 10);

async function paintSummary(box) {
  box.innerHTML = `<div class="an-quiet">Загружаем…</div>`;
  const [project, reports, team] = await Promise.all([
    apiGet("/analytics/project").catch(() => null),
    apiGet("/reports", { page_size: 100 }).catch(() => null),
    apiGet("/team").catch(() => null),
  ]);
  if (!box.isConnected) return;
  const open = ((reports && reports.reports) || []).filter(r => r.status !== "completed" && r.status !== "cancelled");
  const late = open.filter(isOverdue).sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
  const soonEnd = dayKey(new Date(Date.now() + 3 * 86400000));
  const soon = open.filter(r => r.deadline && !isOverdue(r) && String(r.deadline).slice(0, 10) <= soonEnd).sort((a, b) => String(a.deadline).localeCompare(String(b.deadline)));
  const users = (team && team.users) || [];
  const busy = users.filter(u => u.assigned > 0).sort((a, b) => b.assigned - a.assigned).slice(0, 6);
  const maxBusy = Math.max(1, ...busy.map(u => u.assigned));
  const done = users.filter(u => u.completed_month > 0).sort((a, b) => b.completed_month - a.completed_month).slice(0, 6);
  const free = users.filter(u => !u.assigned && !u.paused_until).map(u => u.name);
  const row = r => `<button type="button" class="an-row" data-an-open="${esc(r.public_id)}"><b>${esc(seriesName(r))}</b><span>${esc(String(r.deadline).slice(8, 10))}.${esc(String(r.deadline).slice(5, 7))}</span></button>`;
  const m = project || {};
  const kpi = (label, value) => `<div class="an-kpi"><span>${label}</span><b>${esc(String(value))}</b></div>`;
  box.innerHTML = `
    <div class="an-kpis">${kpi("В работе", open.length)}${kpi("Просрочено", late.length)}${kpi("Завершено за 30 дней", m.completed_30d ?? "—")}${kpi("Вовремя", m.on_time_rate != null ? `${Math.round(m.on_time_rate)}%` : "—")}${kpi("Среднее время серии", m.avg_turnaround_days != null ? `${m.avg_turnaround_days} дн.` : "—")}</div>
    <div class="an-grid">
      <section class="an-card"><h3>Что горит</h3>${late.map(row).join("") || `<div class="an-quiet">Просрочек нет</div>`}</section>
      <section class="an-card"><h3>Срок в ближайшие 3 дня</h3>${soon.map(row).join("") || `<div class="an-quiet">Ближайших сроков нет</div>`}</section>
      <section class="an-card"><h3>Кто сильнее загружен</h3>${busy.map(u => `<div class="an-load"><span>${esc(u.name)}</span><i><em style="width:${Math.round(u.assigned / maxBusy * 100)}%"></em></i><b>${u.assigned}</b></div>`).join("") || `<div class="an-quiet">Нет данных</div>`}${free.length ? `<div class="an-quiet">Свободны: ${esc(free.join(", "))}</div>` : ""}</section>
      <section class="an-card"><h3>Кто сдавал за месяц</h3>${done.map(u => `<div class="an-load"><span>${esc(u.name)}</span><b>${u.completed_month}</b></div>`).join("") || `<div class="an-quiet">Пока никто</div>`}</section>
    </div>`;
  box.querySelectorAll("[data-an-open]").forEach(b => b.addEventListener("click", () => openReportDetail(b.dataset.anOpen)));
}

export function mountPulse(root) {
  if (!root) return;
  let view = "summary";
  try { if (localStorage.getItem(VIEW_KEY) === "graph") view = "graph"; } catch (_) { /* не критично */ }
  root.innerHTML = `<div class="page-header an-head"><div><span class="kd-label">Команда · аналитика</span><h1>Аналитика</h1></div>
    <div class="an-switch"><button type="button" data-an-view="summary">Сводка</button><button type="button" data-an-view="graph">Граф студии</button></div></div><div id="an-view"></div>`;
  const host = root.querySelector("#an-view");
  const show = v => {
    try { localStorage.setItem(VIEW_KEY, v); } catch (_) { /* не критично */ }
    root.querySelectorAll("[data-an-view]").forEach(b => b.classList.toggle("on", b.dataset.anView === v));
    root.classList.toggle("an-graph", v === "graph");
    if (v === "graph") mountGraph(host);
    else { frame = null; pending = null; paintSummary(host); }
  };
  root.querySelectorAll("[data-an-view]").forEach(b => b.addEventListener("click", () => show(b.dataset.anView)));
  show(view);
}

function mountGraph(root) {
  if (!listening) { window.addEventListener("message", onMessage); listening = true; }
  // Каждый заход — свежая страница и свежие данные (вступление играется не чаще раза в день).
  root.innerHTML = `<iframe class="pulse-frame" title="${esc("Аналитика — пульс студии")}" src="pulse.html"></iframe>`;
  frame = root.querySelector("iframe");
  pending = collect();
  pending.catch(() => { /* ошибку покажет сама страница */ });
}
