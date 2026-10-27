// Вкладка «Моя очередь» — личный экран участника: незакрытые серии,
// назначенные на меня, по срочности (/api/me/queue). Открыта всем, не
// только админам: «что мне записать и к какому сроку» нужно каждому.

import { rollText } from "./roll-digits.js";
import { state } from "./state.js";
import { apiGet, apiPost, tabSkeleton, toast } from "./api.js";
import { $, esc } from "./utils.js";
import { imgProxy, titleArt } from "./title-page.js";
import { openReportDetail } from "./report-detail.js";
import { switchTab } from "./tabs.js";
import { setBackdrop } from "./backdrop.js";

const DAY_MS = 86400000;
let skipStatusOpenUntil = 0;

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
const QUEUE_MODE_KEY = "project.queue.view";
let queueMode = localStorage.getItem(QUEUE_MODE_KEY) === "statuses" ? "statuses" : "deadlines";

function viewSwitch() {
  return `<div class="q-view-switch" role="tablist" aria-label="Вид очереди">
    <button type="button" class="qf-chip${queueMode === "deadlines" ? " active" : ""}" data-q-mode="deadlines">По срокам</button>
    <button type="button" class="qf-chip${queueMode === "statuses" ? " active" : ""}" data-q-mode="statuses">Мои статусы</button>
  </div>`;
}

function bindViewSwitch(root) {
  root.querySelectorAll("[data-q-mode]").forEach(button => button.addEventListener("click", () => {
    queueMode = button.dataset.qMode;
    localStorage.setItem(QUEUE_MODE_KEY, queueMode);
    loadQueue();
  }));
}

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
    <div class="kd-gl kd-qr${hot ? " hot" : ""} q-open" data-q-open="${esc(it.public_id)}" role="button" tabindex="0" aria-label="Открыть отчёт ${esc(it.public_id)}">
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
      <div class="kd-qr-ac"><button class="btn${left !== null && left <= 0 ? " primary" : ""}" type="button">Открыть отчёт</button>${state.isAdmin ? "" : `<span class="kd-qr-bot">сдать работу — в боте</span>`}</div>
    </div>`;
}

let tickTimer = null;

const clockText = () => {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

// Часы «Сейчас» и живой отсчёт у серий со сроком сегодня — цифры прокручиваются (roll-digits.js).
// Один таймер на экран, выровненный по началу секунды: цифра меняется ровно со сменой времени.
function startTicker(root) {
  clearTimeout(tickTimer);
  const tick = () => {
    if (!root.isConnected) return;
    rollText(root.querySelector("[data-q-clock]"), clockText());
    const v = countdown();
    root.querySelectorAll("[data-q-cd]").forEach(el => rollText(el, v));
    tickTimer = setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
  };
  tick();
}

export async function loadQueue() {
  if (queueMode === "statuses") return loadPersonalStatuses();
  const root = $("#queue-body");
  if (!root) return;
  tabSkeleton(root, `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`);
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
        ${state.isAdmin ? "" : `<div class="sub">Отметить, что вы сдали серию, можно во вкладке «Мои статусы».</div>`}
      </div>
      <div class="kd-sum">
        <div class="kd-now"><small>Сейчас</small><b class="q-clock" data-q-clock></b></div>
        <div><small>Активные</small><b>${items.length}</b></div>
        <div><small>Горит</small><b class="${hot ? "hot" : ""}">${hot}</b></div>
        <div><small>${overdue ? "Просрочено" : "Ближайший срок"}</small><b class="${overdue ? "hot" : ""}">${overdue || (nearest === null ? "—" : dueText(nearest))}</b></div>
        <div><small>Сдано за неделю</small><b>${d.completed_week}</b></div>
      </div>
    </div>`;

  if (!items.length) {
    clearTimeout(tickTimer);
    root.innerHTML = head + viewSwitch() + `
      <div class="q-empty">
        <div class="q-empty-ic">☕</div>
        <b>На руках пусто</b>
        <p>Когда вам назначат серию, она появится здесь с обратным отсчётом до срока.</p>
        <button class="btn" data-q-titles>Проголосовать за тайтлы</button>
      </div>`;
    bindViewSwitch(root);
    root.querySelector("[data-q-titles]").addEventListener("click", () => switchTab("titles"));
    startTicker(root);
    return;
  }

  const groups = COLUMNS.map(col => {
    const list = items.filter(it => col.test(daysLeft(it.deadline, today)));
    if (!list.length) return "";
    return `
      <div class="kd-sh"><h2>${col.label}</h2><span class="kd-label">${list.length} · ${col.hint}</span><span class="kd-orn"></span></div>
      <div class="kd-qlist">${list.map(it => rowHtml(it, today)).join("")}</div>`;
  }).join("");
  root.innerHTML = head + viewSwitch() + `<div class="kd-queue">${groups}</div>`;
  bindViewSwitch(root);
  startTicker(root);
  refreshQueueBadge();
  root.querySelectorAll("[data-q-open]").forEach(el => {
    const open = () => openReportDetail(el.dataset.qOpen);
    el.addEventListener("click", e => { if (!e.target.closest("button")) open(); });
    el.addEventListener("keydown", e => { if (e.target.closest("button")) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    el.querySelector("button")?.addEventListener("click", open);
  });
}

async function loadPersonalStatuses() {
  const root = $("#queue-body");
  if (!root) return;
  clearTimeout(tickTimer);
  tabSkeleton(root, `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`);
  try {
    const data = await apiGet("/me/board");
    renderPersonalStatuses(root, data);
  } catch (error) {
    root.innerHTML = `${viewSwitch()}<div class="bento-empty">Не удалось загрузить личные статусы: ${esc(error.message)}</div>`;
    bindViewSwitch(root);
  }
}

function renderPersonalStatuses(root, data) {
  const columns = data.columns || [];
  const items = data.items || [];
  const byColumn = Object.fromEntries(columns.map(column => [column.id, []]));
  items.forEach(item => { if (byColumn[item.column_id]) byColumn[item.column_id].push(item); });
  const done = items.filter(item => item.is_done).length;
  const overdue = items.filter(item => item.is_overdue).length;
  const lead = items.find(item => item.title_id || item.poster_url);
  if (lead) setBackdrop(titleArt(lead.title_id, "banner", 1440), imgProxy(lead.poster_url));
  const now = new Date();
  const head = `<div class="page-header">
    <div><span class="kd-label">Моё · рабочие статусы видны только вам</span><h1>Мои статусы</h1>
      <div class="sub">Отметка «Я сдала» не меняет общий статус серии и убирает её из моих просрочек.</div></div>
    <div class="kd-sum"><div class="kd-now"><small>Сейчас</small><b>${pad2(now.getHours())}:${pad2(now.getMinutes())}</b></div>
      <div><small>Мои серии</small><b>${items.length}</b></div><div><small>Сдано</small><b>${done}</b></div>
      <div><small>Просрочено у меня</small><b class="${overdue ? "hot" : ""}">${overdue}</b></div></div></div>`;
  const columnsHtml = columns.map(column => {
    const cards = byColumn[column.id] || [];
    const cardHtml = cards.map(item => {
      const poster = item.poster_url ? `<img class="my-status-poster" src="${esc(imgProxy(item.poster_url))}" alt="" loading="lazy">` : `<span class="my-status-poster my-status-placeholder"></span>`;
      const title = item.title_name || item.title || "Без названия";
      const episode = item.title_name && item.episode ? ` · ${String(item.episode).toUpperCase()}` : "";
      const due = item.is_done ? "Отмечено сданным" : item.deadline ? `${item.is_overdue ? "Просрочено · " : "Срок · "}${item.deadline.slice(8, 10)}.${item.deadline.slice(5, 7)}` : "Без срока";
      const options = columns.map(target => `<option value="${target.id}"${target.id === column.id ? " selected" : ""}>${esc(target.name)}</option>`).join("");
      return `<article class="kd-gl my-status-card${item.is_overdue ? " overdue" : ""}" data-q-status-open="${esc(item.public_id)}" draggable="true" tabindex="0" role="button">
        ${poster}<small class="my-status-id">${esc(item.public_id + episode)}</small><b class="my-status-name">${esc(title)}</b>
        <span class="my-status-meta">${esc(item.role ? `Моя роль — ${item.role}` : item.global_status || "")}</span><span class="my-status-due">${due}</span>
        <div class="my-status-actions"><select data-q-status-move="${esc(item.public_id)}" aria-label="Переместить в группу">${options}</select>
          ${column.is_done ? "" : `<button type="button" class="btn primary" data-q-status-done="${esc(item.public_id)}">Я сдала</button>`}</div></article>`;
    }).join("") || `<div class="my-status-empty">Пока пусто</div>`;
    return `<section class="my-status-column${column.is_done ? " is-done" : ""}" data-q-status-col="${column.id}">
      <header class="my-status-head"><b>${esc(column.name)}${column.is_done ? " ✓" : ""}</b><span>${cards.length}</span></header>
      <div class="my-status-cards">${cardHtml}</div></section>`;
  }).join("");
  root.innerHTML = `${head}${viewSwitch()}<div class="my-status-toolbar"><span>Три фиксированные группы. Перемещайте карточки списком или перетаскиванием.</span></div>
    ${columns.length ? `<div class="my-status-board">${columnsHtml}</div>` : `<div class="q-empty">Групп пока нет.</div>`}`;
  bindViewSwitch(root);
  root.querySelectorAll("[data-q-status-open]").forEach(card => {
    const open = () => openReportDetail(card.dataset.qStatusOpen);
    card.addEventListener("click", event => {
      if (Date.now() < skipStatusOpenUntil) { skipStatusOpenUntil = 0; return; }
      if (!event.target.closest("button,select")) open();
    });
    card.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && !event.target.closest("button,select")) { event.preventDefault(); open(); } });
    card.addEventListener("dragstart", event => {
      event.dataTransfer.setData("text/plain", card.dataset.qStatusOpen);
      event.dataTransfer.effectAllowed = "move";
    });
  });
  root.querySelectorAll("[data-q-status-move]").forEach(select => select.addEventListener("change", () => moveStatusCard(select.dataset.qStatusMove, select.value)));
  root.querySelectorAll("[data-q-status-done]").forEach(button => button.addEventListener("click", () => {
    const doneColumn = columns.find(column => column.is_done);
    if (!doneColumn) { toast("Сначала отметьте группу «Сдано» в настройках группы.", "error"); return; }
    moveStatusCard(button.dataset.qStatusDone, doneColumn.id);
  }));
  root.querySelectorAll("[data-q-status-col]").forEach(column => {
    column.addEventListener("dragover", event => { event.preventDefault(); column.classList.add("drag-over"); });
    column.addEventListener("dragleave", event => { if (!column.contains(event.relatedTarget)) column.classList.remove("drag-over"); });
    column.addEventListener("drop", event => {
      event.preventDefault(); event.stopPropagation(); column.classList.remove("drag-over");
      skipStatusOpenUntil = Date.now() + 500;
      const publicId = event.dataTransfer.getData("text/plain");
      if (publicId) moveStatusCard(publicId, column.dataset.qStatusCol);
    });
  });
}

async function moveStatusCard(publicId, columnId) {
  try {
    await apiPost(`/me/board/items/${encodeURIComponent(publicId)}/move`, { column_id: Number(columnId) });
    toast("Статус обновлён. Общий статус серии не изменился.", "success");
    await loadQueue();
    refreshQueueBadge();
  } catch (error) { toast(`Не удалось переместить серию: ${error.message}`, "error"); }
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
