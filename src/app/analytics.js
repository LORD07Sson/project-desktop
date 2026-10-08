// Вкладка «Аналитика» — оборачиваемость студии за 30 дней (сколько
// закрывается, за сколько в среднем, попадаем ли в сроки) плюс
// загрузка по колонкам доски и топ исполнителей. Тот же /api/analytics/project,
// что и клетка «Загрузка по статусам»/«Топ исполнителей» — один запрос
// на весь экран, без похода за board/team по отдельности.

import { apiGet } from "./api.js";
import { $, esc } from "./utils.js";
import { loadAvatars } from "./profile.js";

const WORKLOAD_COLOR_VAR = { draft: "--s-draft", working: "--s-work", review: "--s-review", completed: "--s-done" };
// Сервер отдаёт подписи колонок по-английски (Pending/In Progress/...,
// см. _PROJECT_BOARD_GROUPS в server.py) — тот же смысл, что и у
// референса, но остальной интерфейс студии целиком на русском (та же
// подмена, что уже сделана для превью-канбана на Обзоре).
const WORKLOAD_LABELS = { draft: "Черновики", working: "В работе", review: "Озвучка", completed: "Завершено" };

function periodDeltaPct(current, prior) {
  if (!prior) return current > 0 ? null : 0;
  return Math.round(((current - prior) / prior) * 100);
}

function trendLine(text, good) {
  return `<div class="an-trend" style="color:var(${good ? "--s-done" : "--s-stop"});">${esc(text)}</div>`;
}


// Плавная кривая через точки (Catmull-Rom → кубические Безье).
function smoothPath(P) {
  let d = `M${P[0][0]},${P[0][1]}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0]},${p2[1]}`;
  }
  return d;
}

// Завершено по дням — площадная кривая с отметкой на последней точке.
function trendChartHtml(days) {
  if (!days || days.length < 2) return `<div class="no-assignee">Данных для графика пока нет</div>`;
  const vals = days.map(x => x.completed || 0);
  const max = Math.max(3, ...vals);
  const W = 600, H = 200;
  const P = vals.map((v, i) => [+(i / (vals.length - 1) * W).toFixed(1), +(H - 10 - (v / max) * (H - 30)).toFixed(1)]);
  const line = smoothPath(P);
  const last = P[P.length - 1];
  const total = vals.reduce((a, b) => a + b, 0);
  const pk = Math.max(...vals);
  const lbl = i => { const dt = String(days[i].date || "").slice(5).split("-").reverse().join("."); return dt; };
  return `
    <div class="an-chart">
      ${[0, 1, 2, 3].map(i => `<div class="an-gl" style="top:${(i / 4) * 100 * (H - 6) / H}%"></div>`).join("")}
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="an-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--fire)" stop-opacity=".38"/><stop offset="1" stop-color="var(--fire)" stop-opacity="0"/></linearGradient>
          <linearGradient id="an-stroke" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="var(--fire)"/><stop offset="1" stop-color="var(--gold)"/></linearGradient>
        </defs>
        <path d="${line} L${W},${H} L0,${H} Z" fill="url(#an-fill)"/>
        <path d="${line}" fill="none" stroke="url(#an-stroke)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
      </svg>
      <span class="an-mk" style="left:100%;top:${(last[1] / H) * 100}%"></span>
      <div class="an-tip" style="top:${(last[1] / H) * 100}%"><b>${vals[vals.length - 1]} ${vals[vals.length - 1] === 1 ? "серия" : "серий"}</b><span>за последний день · всего ${total}, пик ${pk}</span></div>
      <div class="an-xl"><span>${lbl(0)}</span><span>${lbl(Math.floor(days.length / 2))}</span><span>${lbl(days.length - 1)}</span></div>
    </div>`;
}

function analyticsHtml(d, trend) {
  const workload = (d.workload || []).map(w => ({
    label: WORKLOAD_LABELS[w.key] || w.label, count: w.total, colorVar: WORKLOAD_COLOR_VAR[w.key] || "--s-draft",
  }));
  const maxCount = Math.max(1, ...workload.map(w => w.count));
  const completedDelta = periodDeltaPct(d.completed_30d, d.completed_prior_30d);
  const performers = d.performers || [];
  const maxCompleted = Math.max(1, ...performers.map(p => p.completed));

  const metrics = [
    {
      label: "Завершено за 30 дней",
      value: d.completed_30d ?? 0,
      trend: completedDelta !== null
        ? trendLine(`${completedDelta >= 0 ? "+" : ""}${completedDelta}% к прошлым 30 дням`, completedDelta >= 0)
        : `<div class="an-trend">против ${d.completed_prior_30d ?? 0} за прошлые 30 дней</div>`,
    },
    {
      label: "Среднее время выполнения",
      value: d.avg_turnaround_days !== null && d.avg_turnaround_days !== undefined ? `${d.avg_turnaround_days}д` : "—",
      trend: `<div class="an-trend">создан → завершён</div>`,
    },
    {
      label: "Просрочено сейчас",
      value: d.overdue_now ?? 0,
      trend: d.overdue_now > 0 ? trendLine("срок уже прошёл", false) : trendLine("всё в срок", true),
    },
    {
      label: "Вовремя",
      value: d.on_time_rate !== null && d.on_time_rate !== undefined ? `${d.on_time_rate}%` : "—",
      trend: d.on_time_rate !== null && d.on_time_rate !== undefined
        ? trendLine("закрыто не позже дедлайна", d.on_time_rate >= 80)
        : `<div class="an-trend">нет отчётов со сроком</div>`,
    },
  ];

  const metricCards = metrics.map((m, i) => `
    <div class="bcell kpi-cell" style="animation-delay:${i * 40}ms;">
      <h3>${esc(m.label)}</h3>
      <div class="big-num">${esc(String(m.value))}</div>
      ${m.trend}
    </div>
  `).join("");

  const workloadBars = workload.map(w => `
    <div class="an-bar-col">
      <div class="an-bar-count">${w.count}</div>
      <div class="an-bar" style="height:${Math.round((w.count / maxCount) * 130)}px; background:var(${w.colorVar});"></div>
      <div class="an-bar-label">${esc(w.label)}</div>
    </div>
  `).join("");

  const performerRows = performers.map((p, i) => `
    <div class="an-perf${i === 0 ? " r1" : ""}">
      <span class="an-rk">${String(i + 1).padStart(2, "0")}</span>
      <span class="avatar sm" data-avatar-for="${p.telegram_id || ""}">${esc((p.name || "?").charAt(0).toUpperCase())}</span>
      <span class="an-pn">${esc(p.name)}</span>
      <span class="kd-track"><i style="width:${Math.round((p.completed / maxCompleted) * 100)}%"></i></span>
      <b>${p.completed}</b>
    </div>
  `).join("");

  return `
    <div class="page-header">
      <div>
        <span class="kd-label">Команда · последние 30 дней</span>
        <h1>Аналитика</h1>
      </div>
    </div>
    <div class="an-metrics">${metricCards}</div>
    <div class="an-two">
      <div class="bcell" style="animation-delay:160ms;">
        <div class="kd-ch"><h3>Завершено по дням</h3><span class="kd-label">${(trend && trend.days ? trend.days.length : 0)} дней</span></div>
        ${trendChartHtml(trend && trend.days)}
      </div>
      <div class="bcell" style="animation-delay:200ms;">
        <div class="kd-ch"><h3>Загрузка доски</h3><span class="kd-label">сейчас</span></div>
        <div class="an-bars">${workloadBars || `<div class="no-assignee">Нет данных</div>`}</div>
      </div>
    </div>
    <div class="bcell" style="animation-delay:240ms; margin-top:16px;">
      <div class="kd-ch"><h3>Топ исполнителей</h3><span class="kd-label">завершённые за 30 дней</span></div>
      <div class="an-perf-list">
        ${performerRows || `<div class="no-assignee">Пока нет закрытых отчётов за этот период</div>`}
      </div>
    </div>
  `;
}

export async function loadAnalytics() {
  const root = $("#analytics-body");
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let d, trend;
  try {
    [d, trend] = await Promise.all([apiGet("/analytics/project"), apiGet("/trend").catch(() => null)]);
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить аналитику: ${esc(e.message)}</div>`;
    return false;
  }
  root.innerHTML = analyticsHtml(d, trend);
  loadAvatars(root);
}
