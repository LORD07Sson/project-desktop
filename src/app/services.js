
import { apiGet, tabSkeleton } from "./api.js";
import { $, esc, relTime } from "./utils.js";

const STATUS_META = {
  operational: { label: "Работает", colorVar: "--s-done", dot: "🟢" },
  degraded: { label: "Есть проблемы", colorVar: "--s-work", dot: "🟡" },
  down: { label: "Не отвечает", colorVar: "--s-stop", dot: "🔴" },
  no_data: { label: "Нет данных", colorVar: "--ink-dim", dot: "⚪" },
};

function formatUptime(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  if (seconds < 60) return "меньше минуты";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} м`;
  return `${minutes} м`;
}

const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
function fmtDay(iso) {
  const [, m, d] = String(iso).split("-").map(Number);
  return m && d ? `${d} ${MONTHS[m - 1]}` : String(iso);
}

function fmtMs(ms) {
  if (ms == null) return "—";
  return ms < 1 ? "<1 мс" : `${Math.round(ms)} мс`;
}

const SERVICE_NAME = { bot_api: "Bot API", disk: "Диск", database: "База данных", db: "База данных" };

function serviceRowHtml(s) {
  const meta = STATUS_META[s.status] || STATUS_META.down;
  let detail;
  if (s.key === "database") {
    detail = fmtBytes(s.size_bytes);
  } else if (s.key === "disk") {
    detail = s.used_pct != null ? `занято ${s.used_pct}%` : "—";
  } else {
    detail = s.uptime_seconds != null ? `без перезапуска ${formatUptime(s.uptime_seconds)}` : "—";
  }
  return `
    <div class="svc-row">
      <span class="svc-dot" style="background:var(${meta.colorVar}); box-shadow:0 0 0 3px color-mix(in srgb, var(${meta.colorVar}) 18%, transparent);"></span>
      <div class="svc-row-main">
        <div class="svc-row-name">${esc(SERVICE_NAME[s.key] || s.name)}</div>
        <div class="svc-row-desc">${esc(SERVICE_DESC[s.key] || s.desc)}</div>
      </div>
      ${s.status === "operational" ? "" : `<span class="svc-pill" style="background:color-mix(in srgb, var(${meta.colorVar}) 16%, var(--surface)); color:var(${meta.colorVar});">${meta.label}</span>`}
      <div class="svc-row-latency">${s.latency_ms != null ? fmtMs(s.latency_ms) : ""}</div>
      <div class="svc-row-detail">${detail}</div>
    </div>
  `;
}

// Сколько минут за день сервисы лежали — по инцидентам (дата берётся по началу).
function downMinutesByDay(incidents) {
  const out = {};
  for (const inc of incidents || []) {
    if (!inc.started_at) continue;
    const day = String(inc.started_at).slice(0, 10);
    const end = inc.ongoing || !inc.ended_at ? Date.now() : parseSqliteTimestamp(inc.ended_at);
    out[day] = (out[day] || 0) + Math.max(1, Math.round((end - parseSqliteTimestamp(inc.started_at)) / 60000));
  }
  return out;
}

function historyStripHtml(history, incidents) {
  const downMin = downMinutesByDay(incidents);
  const bars = (history || []).map(d => {
    let meta = STATUS_META[d.status] || STATUS_META.no_data;
    let label = meta.label;
    // День, где сбой длился минуты, не красим целиком в «не отвечает» — это короткий сбой.
    const mins = downMin[d.date];
    if (d.status === "down" && mins != null && mins < 60 && STATUS_META.degraded) {
      meta = STATUS_META.degraded;
      label = `короткий сбой, ~${mins} мин`;
    }
    return `<span class="svc-history-bar" style="background:var(${meta.colorVar});" title="${esc(d.date)}: ${esc(label)}"></span>`;
  }).join("");
  return `
    <div class="svc-history-strip">${bars}</div>
    <div class="svc-history-axis"><span>${history?.length ? esc(fmtDay(history[0].date)) : ""}</span><span>сегодня</span></div>
    <div class="svc-history-legend">${["operational", "degraded", "down", "no_data"].map(k => { const m = STATUS_META[k]; return m ? `<span><i style="background:var(${m.colorVar});"></i>${esc(m.label.toLowerCase())}</span>` : ""; }).join("")}</div>
  `;
}

function parseSqliteTimestamp(ts) {
  return Date.parse(`${ts.replace(" ", "T")}Z`);
}

function incidentRowHtml(inc) {
  const meta = STATUS_META[inc.status] || STATUS_META.down;
  const started = relTime(inc.started_at);
  const durationMin = Math.round((parseSqliteTimestamp(inc.ended_at) - parseSqliteTimestamp(inc.started_at)) / 60000);
  const durationLabel = inc.ongoing ? "ещё не закончилось" : durationMin > 0 ? `${durationMin} мин` : "меньше 5 мин";
  const what = inc.status === "degraded" ? "работал с перебоями" : "не отвечал";
  const when = new Date(parseSqliteTimestamp(inc.started_at));
  const at = Number.isNaN(when.getTime()) ? "" : `${when.getDate()} ${MONTHS[when.getMonth()]}, ${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  const dotVar = inc.ongoing ? meta.colorVar : "--ink-dim";
  return `
    <div class="mini-row" style="align-items:flex-start;">
      <span style="width:7px; height:7px; border-radius:50%; background:var(${dotVar}); margin-top:5px; flex:none;"></span>
      <div style="min-width:0;">
        <div style="font-size:12px; font-weight:600;">${esc(SERVICE_NAME[inc.service_key] || inc.service_name)} ${inc.ongoing ? "— " + esc(meta.label).toLowerCase() : what}</div>
        <div style="font-size:10.5px; color:var(--ink-dim); margin-top:2px;">${esc(at || started)} · ${inc.ongoing ? esc(durationLabel) : esc(durationLabel)}</div>
      </div>
    </div>
  `;
}

function servicesHtml(d) {
  const services = d.services || [];
  const overallMeta = STATUS_META[d.overall] || STATUS_META.down;
  const counts = services.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});

  const rows = services.map(serviceRowHtml).join("");
  const incidents = d.incidents || [];
  const knownDays = (d.history || []).filter(x => x.status !== "no_data").length;

  const problems = (counts.degraded || 0) + (counts.down || 0);
  const okDays = (d.history || []).filter(x => x.status === "operational").length;
  const availability = knownDays ? `${Math.round((okDays / knownDays) * 1000) / 10}% дней без сбоев` : "";

  return `
    <div class="page-header">
      <div>
        <span class="kd-label">Система · состояние серверов</span>
        <h1>Сервисы</h1>
      </div>
    </div>
    <section class="kd-gl svc-hero" style="--c:var(${overallMeta.colorVar});">
      <span class="svc-dot" style="width:12px; height:12px; background:var(${overallMeta.colorVar});"></span>
      <div><h2>${d.overall === "operational" ? "Все сервисы работают" : `${problems} из ${services.length} с проблемами`}</h2>
        <p>${[availability, incidents.length ? `сбоев за 30 дней: ${incidents.length}` : "сбоев за 30 дней не было"].filter(Boolean).join(" · ")}</p></div>
    </section>
    <div class="svc-bottom-row">
      <div class="bcell svc-list-cell" style="animation-delay:160ms;">
        <h3>Статус сервисов</h3>
        <div class="svc-list">${rows || `<div class="bento-empty">Не удалось получить статус.</div>`}</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:14px; min-height:0;">
        <div class="bcell" style="animation-delay:200ms;">
          <h3 style="margin-bottom:4px;">Аптайм за 30 дней</h3>
          <div class="an-caption">${knownDays ? `собрано ${knownDays} из 30 дней` : "мониторинг только что включён"}</div>
          ${historyStripHtml(d.history, d.incidents || incidents)}
        </div>
        <div class="bcell" style="flex-grow:1; animation-delay:240ms;">
          <h3>Последние сбои</h3>
          <div class="mini-list">
            ${incidents.map(incidentRowHtml).join("") || `<div class="no-assignee">За последние 30 дней ничего не было</div>`}
          </div>
        </div>
      </div>
    </div>
  `;
}

export async function loadServices() {
  const root = $("#services-body");
  tabSkeleton(root, `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`);
  let d;
  try {
    d = await apiGet("/services/status");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить статус сервисов: ${esc(e.message)}</div>`;
    return false;
  }
  root.innerHTML = servicesHtml(d) + `<div id="bot-status-slot"></div>`;
  fillBotStatus(root);
}

function fmtBytes(n) {
  if (n == null) return "—";
  const u = ["Б", "КБ", "МБ", "ГБ"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
}

async function fillBotStatus(root) {
  const slot = root.querySelector("#bot-status-slot");
  if (!slot) return;
  let b;
  try { b = await apiGet("/admin/bot-status"); } catch (_) { slot.remove(); return; }
  if (!slot.isConnected) return;
  const c = b.counts || {};
  const cell = (label, value, sub, tone) => `
    <div class="bs-cell"><span>${esc(label)}</span><b class="${tone || ""}">${esc(String(value))}</b>${sub ? `<em>${esc(sub)}</em>` : ""}</div>`;
  const svc = b.services.filter(x => !x.active).map(x => cell(x.name, x.active ? (x.uptime_seconds != null ? formatUptime(x.uptime_seconds) : "работает") : "остановлен",
    x.active ? "без перезапуска" : (x.state || ""), x.active ? "" : "danger")).join("");
  const errors = b.errors || [];
  slot.innerHTML = `
    <div class="bcell bs-card" style="animation-delay:120ms;">
      <div class="dash-cell-head">
        <span class="dash-cell-title">Бот изнутри</span>
        <span class="dash-cell-hint">версия ${esc(b.version)}</span>
      </div>
      <div class="bs-grid">
        ${svc}
        ${cell("Отклик Telegram", b.telegram_ping_ms != null ? fmtMs(b.telegram_ping_ms) : "нет ответа", b.telegram_error || "getMe", b.telegram_ping_ms == null ? "danger" : (b.telegram_ping_ms > 1500 ? "warn" : ""))}
        ${cell("Миграции базы", `${b.schema.version}/${b.schema.total}`, b.schema.ok ? "все применены" : "есть неприменённые", b.schema.ok ? "" : "warn")}
        ${cell("База", fmtBytes(b.db_size_bytes), `лог ${fmtBytes(b.log_size_bytes)}`)}
        ${cell("Люди", c.users ?? "—", c.paused ? `${c.paused} на паузе` : "никто не на паузе")}
        ${cell("Отчёты", c.reports ?? "—", `${c.active ?? 0} активных`)}
        ${cell("Тикеты", c.tickets ?? "—", "открыто")}
      </div>
      <div class="bs-errors-head">Последние ошибки и предупреждения из лога${errors.length ? ` · ${errors.length}` : ""}</div>
      ${errors.length ? `<div class="bs-errors">${errors.slice().reverse().map(e => {
        const warn = / WARNING /.test(e);
        return `<div class="bs-err ${warn ? "warn" : "err"}">${esc(e)}</div>`;
      }).join("")}</div>` : `<div class="no-assignee">Чисто — ошибок в логе нет</div>`}
    </div>`;
}

const SERVICE_DESC = { telegram_bot: "Основной процесс бота", bot_api: "Локальный сервер Telegram Bot API", dashboard_api: "Мини-апп и REST API", edge: "Обратный прокси и TLS", disk: "Корневой раздел сервера", database: "bot.db (SQLite)", db: "bot.db (SQLite)" };
