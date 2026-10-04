// Вкладка «Моя очередь» — личный экран участника: незакрытые серии,
// назначенные на меня, по срочности (/api/me/queue). Открыта всем, не
// только админам: «что мне записать и к какому сроку» нужно каждому.

import { state } from "./state.js";
import { apiGet } from "./api.js";
import { $, esc } from "./utils.js";
import { imgProxy, titleArt } from "./title-page.js";
import { openReportDetail } from "./report-detail.js";
import { switchTab } from "./tabs.js";
import { setBackdrop } from "./backdrop.js";

const DAY_MS = 86400000;

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function daysLeft(deadline, today) {
  if (!deadline) return null;
  return Math.round((Date.parse(deadline.slice(0, 10)) - Date.parse(today)) / DAY_MS);
}

function dueText(left) {
  if (left === null) return "без срока";
  if (left < 0) return `просрочено на ${-left} ${plural(-left, "день", "дня", "дней")}`;
  if (left === 0) return "сегодня";
  if (left === 1) return "завтра";
  return `через ${left} ${plural(left, "день", "дня", "дней")}`;
}

const COLUMNS = [
  { key: "hot", label: "Горит", hint: "просрочено, сегодня и завтра", test: l => l !== null && l <= 1 },
  { key: "week", label: "На неделе", hint: "2–7 дней", test: l => l !== null && l > 1 && l <= 7 },
  { key: "later", label: "Позже", hint: "дальше недели и без срока", test: l => l === null || l > 7 },
];

// Готовность по статусу: у серии в очереди нет цепочки этапов, только
// статус — шкала показывает, как далеко серия по пути статусов.
const STATUS_PCT = { draft: 6, working: 45, revision: 60, review: 75, completed: 100 };
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const pad2 = n => String(n).padStart(2, "0");
const cleanLabel = s => String(s || "").replace(/^[^\p{L}\p{N}]+/u, "");

// Сколько осталось до конца дня срока — для серий «сегодня».
function countdown() {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 0);
  const sec = Math.max(0, Math.floor((end - now) / 1000));
  return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
}

function rowHtml(it, today) {
  const left = daysLeft(it.deadline, today);
  const src = it.poster_url ? imgProxy(it.poster_url) : null;
  const head = it.title_name || it.title;
  const ep = it.title_name ? it.episode : "";
  const pct = STATUS_PCT[it.status] ?? 0;
  const hot = left !== null && left <= 1;
  return `
    <div class="kd-gl kd-qr${hot ? " hot" : ""}${state.isAdmin ? " q-open" : ""}" data-q-open="${esc(it.public_id)}">
      ${src ? `<img class="kd-qr-pc" src="${src}" alt="" loading="lazy">` : `<span class="kd-qr-pc kd-qr-ph"></span>`}
      <div class="kd-qr-t">
        <small>${esc(it.public_id)}${ep ? ` · ${esc(String(ep).toUpperCase())}` : ""}</small>
        <b>${esc(head)}</b>
        <span>${it.role ? `Моя роль — ${esc(it.role)}` : esc(cleanLabel(it.status_label))}</span>
      </div>
      <div class="kd-qr-pr"><small><span>Готовность</span><span>${pct}%</span></small><span class="kd-track"><i style="width:${pct}%"></i></span></div>
      <div class="kd-qr-cd">
        <small>${left === 0 ? "Осталось" : "Срок"}</small>
        <b ${left === 0 ? "data-q-cd" : ""}>${left === 0 ? countdown() : dueText(left)}</b>
      </div>
      <div class="kd-qr-ac">${state.isAdmin
        ? `<button class="btn${left !== null && left <= 0 ? " primary" : ""}" type="button">Открыть</button>`
        : `<span class="kd-qr-bot">сдать — в боте</span>`}</div>
    </div>`;
}

let tickTimer = null;

export async function loadQueue() {
  const root = $("#queue-body");
  if (!root) return;
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let d;
  try {
    d = await apiGet("/me/queue");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить очередь: ${esc(e.message)}</div>`;
    return false;
  }
  const today = d.today;
  const items = d.items || [];
  // Фон окна — обложка первой (самой срочной) серии на руках.
  const lead = items.find(it => it.title_id || it.poster_url);
  if (lead) setBackdrop(titleArt(lead.title_id, "banner", 1440), imgProxy(lead.poster_url));
  const lefts = items.map(it => daysLeft(it.deadline, today)).filter(l => l !== null);
  const nearest = lefts.length ? Math.min(...lefts) : null;
  const overdue = lefts.filter(l => l < 0).length;

  const hot = lefts.filter(l => l <= 1).length;
  const now = new Date();
  const head = `
    <div class="page-header">
      <div>
        <span class="kd-label">Моё · ${WEEKDAYS[now.getDay()]}, ${now.getDate()} ${MONTHS[now.getMonth()]}</span>
        <h1>Моя очередь</h1>
        ${state.isAdmin ? "" : `<div class="sub">Сдать работу — в боте: «📋 Мои задачи».</div>`}
      </div>
      <div class="kd-sum">
        <div><small>Активные</small><b>${items.length}</b></div>
        <div><small>Горит</small><b class="${hot ? "hot" : ""}">${hot}</b></div>
        <div><small>${overdue ? "Просрочено" : "Ближайший срок"}</small><b class="${overdue ? "hot" : ""}">${overdue || (nearest === null ? "—" : dueText(nearest))}</b></div>
        <div><small>Сдано за неделю</small><b>${d.completed_week}</b></div>
      </div>
    </div>`;

  if (!items.length) {
    root.innerHTML = head + `
      <div class="q-empty">
        <div class="q-empty-ic">☕</div>
        <b>На руках пусто</b>
        <p>Когда вам назначат серию, она появится здесь с обратным отсчётом до срока.</p>
        <button class="btn" data-q-titles>Проголосовать за тайтлы</button>
      </div>`;
    root.querySelector("[data-q-titles]").addEventListener("click", () => switchTab("titles"));
    return;
  }

  const groups = COLUMNS.map(col => {
    const list = items.filter(it => col.test(daysLeft(it.deadline, today)));
    if (!list.length) return "";
    return `
      <div class="kd-sh"><h2>${col.label}</h2><span class="kd-label">${list.length} · ${col.hint}</span><span class="kd-orn"></span></div>
      <div class="kd-qlist">${list.map(it => rowHtml(it, today)).join("")}</div>`;
  }).join("");
  root.innerHTML = head + `<div class="kd-queue">${groups}</div>`;
  // Живой отсчёт у серий со сроком сегодня; таймер один на экран.
  clearInterval(tickTimer);
  if (root.querySelector("[data-q-cd]")) {
    tickTimer = setInterval(() => {
      const els = root.querySelectorAll("[data-q-cd]");
      if (!els.length || !root.isConnected) { clearInterval(tickTimer); return; }
      const v = countdown();
      els.forEach(el => { el.textContent = v; });
    }, 1000);
  }
  refreshQueueBadge();
  if (state.isAdmin) {
    root.querySelectorAll("[data-q-open]").forEach(el => el.addEventListener("click", () => openReportDetail(el.dataset.qOpen)));
  }
}

// Счётчик на пункте меню — сколько серий горит (просрочено, сегодня, завтра).
export async function refreshQueueBadge() {
  const el = $("#queue-badge");
  if (!el) return;
  try {
    const d = await apiGet("/me/queue");
    const hot = (d.items || []).filter(it => { const l = daysLeft(it.deadline, d.today); return l !== null && l <= 1; }).length;
    el.textContent = String(hot);
    el.hidden = !hot;
  } catch (_) { el.hidden = true; }
}
