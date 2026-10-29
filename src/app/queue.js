// Вкладка «Моя очередь» — личный экран участника: незакрытые серии,
// назначенные на меня, по срочности (/api/me/queue). Открыта всем, не
// только админам: «что мне записать и к какому сроку» нужно каждому.

import { rollText } from "./roll-digits.js";
import { state } from "./state.js";
import { apiGet, apiPost, tabSkeleton, toast, openSheet, dismissSheet } from "./api.js";
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
let queueMode = "deadlines";
try { if (localStorage.getItem(QUEUE_MODE_KEY) === "statuses") queueMode = "statuses"; } catch (_) { /* без хранилища — вид по умолчанию */ }

function viewSwitch() {
  return `<div class="q-view-switch" role="tablist" aria-label="Вид очереди">
    <button type="button" class="qf-chip${queueMode === "deadlines" ? " active" : ""}" data-q-mode="deadlines">По срокам</button>
    <button type="button" class="qf-chip${queueMode === "statuses" ? " active" : ""}" data-q-mode="statuses">Мои статусы</button>
  </div>`;
}

function bindViewSwitch(root) {
  root.querySelectorAll("[data-q-mode]").forEach(button => button.addEventListener("click", () => {
    queueMode = button.dataset.qMode;
    try { localStorage.setItem(QUEUE_MODE_KEY, queueMode); } catch (_) { /* не критично */ }
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

// Колонки личной доски: цвет, подпись и пустое состояние — по смыслу колонки (их три и они фиксированные).
const STATUS_LOOK = {
  "Очередь": { tone: "queue", hint: "ещё не начато", empty: "Назначенные вам серии появятся здесь сами", next: "В работе", nextLabel: "→ В работу" },
  "В работе": { tone: "work", hint: "делаю сейчас", empty: "Перетащите сюда серию, за которую взялись", next: "Сдано", nextLabel: "✓ Сдано" },
  "Сдано": { tone: "done", hint: "отмечено сданным", empty: "Сданные серии — здесь. Общий статус серии это не меняет" },
};

// Срок по-человечески: «просрочено 2 дн», «сегодня», «завтра», «через 5 дн», «12.11».
function dueChip(item) {
  if (item.is_done) return `<span class="psb-due done">сдано</span>`;
  if (!item.deadline) return `<span class="psb-due">без срока</span>`;
  const [y, m, d] = item.deadline.slice(0, 10).split("-").map(Number);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(y, m - 1, d) - today) / DAY_MS);
  const date = `${pad2(d)}.${pad2(m)}`;
  if (days < 0) return `<span class="psb-due hot" title="Срок ${date}">просрочено ${-days} дн</span>`;
  if (days === 0) return `<span class="psb-due hot" title="Срок ${date}">сегодня</span>`;
  if (days === 1) return `<span class="psb-due warn" title="Срок ${date}">завтра</span>`;
  if (days <= 7) return `<span class="psb-due warn" title="Срок ${date}">через ${days} дн</span>`;
  return `<span class="psb-due">до ${date}</span>`;
}

function renderPersonalStatuses(root, data) {
  const columns = data.columns || [];
  const items = data.items || [];
  const byColumn = Object.fromEntries(columns.map(column => [column.id, []]));
  items.forEach(item => { if (byColumn[item.column_id]) byColumn[item.column_id].push(item); });
  const done = items.filter(item => item.is_done).length;
  const overdue = items.filter(item => item.is_overdue).length;
  const working = columns.filter(c => (STATUS_LOOK[c.name] || {}).tone === "work").reduce((n, c) => n + (byColumn[c.id] || []).length, 0);
  const pct = items.length ? Math.round(done * 100 / items.length) : 0;
  const lead = items.find(item => item.title_id || item.poster_url);
  if (lead) setBackdrop(titleArt(lead.title_id, "banner", 1440), imgProxy(lead.poster_url));
  const columnByName = Object.fromEntries(columns.map(c => [c.name, c]));
  const head = `<div class="page-header psb-head">
    <div><span class="kd-label">Моё · видно только вам</span><h1>Мои статусы</h1>
      <div class="sub">Отмечайте, что взяли и что сдали. Общий статус серии в студии от этого не меняется.</div></div>
    <div class="kd-sum">
      <div><small>Мои серии</small><b>${items.length}</b></div>
      <div><small>В работе</small><b>${working}</b></div>
      <div><small>Сдано</small><b>${done}</b><i class="psb-sum-bar"><em style="width:${pct}%"></em></i></div>
      <div><small>Просрочено</small><b class="${overdue ? "hot" : ""}">${overdue}</b></div></div></div>`;
  const columnsHtml = columns.map(column => {
    const look = STATUS_LOOK[column.name] || { tone: column.is_done ? "done" : "queue", hint: "", empty: "Пока пусто" };
    const cards = byColumn[column.id] || [];
    const next = look.next && columnByName[look.next];
    const cardHtml = cards.map(item => {
      const poster = item.poster_url ? `<img class="psb-poster" src="${esc(imgProxy(item.poster_url))}" alt="" loading="lazy">` : `<span class="psb-poster psb-poster-empty">${esc(String(item.title_name || item.title || "?").slice(0, 1).toUpperCase())}</span>`;
      const title = item.title_name || item.title || "Без названия";
      const episode = item.title_name && item.episode ? String(item.episode) : "";
      return `<article class="psb-card${item.is_overdue ? " overdue" : ""}" data-q-status-open="${esc(item.public_id)}" draggable="true" tabindex="0" role="button" title="Открыть ${esc(item.public_id)}">
        ${poster}
        <div class="psb-body">
          <b class="psb-name">${esc(title)}</b>
          <span class="psb-sub">${esc([episode, item.role].filter(Boolean).join(" · ") || item.global_status || "")}</span>
          <div class="psb-foot">${dueChip(item)}<small class="psb-id">${esc(item.public_id)}</small></div>
        </div>
        <div class="psb-actions">
          ${next ? `<button type="button" class="psb-act primary" data-q-status-move="${esc(item.public_id)}" data-to="${next.id}">${esc(look.nextLabel)}</button>` : ""}
          ${look.tone === "work" && columnByName["Очередь"] ? `<button type="button" class="psb-act" data-q-status-move="${esc(item.public_id)}" data-to="${columnByName["Очередь"].id}" title="Вернуть в очередь">↩ В очередь</button>` : ""}
          ${look.tone === "done" && columnByName["В работе"] ? `<button type="button" class="psb-act" data-q-status-move="${esc(item.public_id)}" data-to="${columnByName["В работе"].id}" title="Снять отметку о сдаче">↩ Вернуть в работу</button>` : ""}
          ${item.is_manual ? `<button type="button" class="psb-act ghost" data-q-status-remove="${esc(item.public_id)}" title="Убрать только с моей доски">Убрать</button>` : ""}
        </div></article>`;
    }).join("");
    const empty = `<div class="psb-empty"><span>${esc(look.empty)}</span>${look.tone === "queue" ? `<button type="button" class="psb-act" data-q-status-add>+ Добавить серию</button>` : ""}</div>`;
    return `<section class="psb-col tone-${look.tone}" data-q-status-col="${column.id}">
      <header class="psb-col-head"><i class="psb-dot"></i><b>${esc(column.name)}</b><span class="psb-count">${cards.length}</span><small>${esc(look.hint)}</small></header>
      <div class="psb-cards">${cardHtml || empty}</div></section>`;
  }).join("");
  root.innerHTML = `${head}<div class="psb-toolbar">${viewSwitch()}<span class="psb-tip">Перетаскивайте карточки между колонками или жмите кнопки на них</span>
      <button type="button" class="btn primary" data-q-status-add>+ Добавить серию</button></div>
    ${columns.length ? `<div class="psb-board">${columnsHtml}</div>` : `<div class="q-empty">Групп пока нет.</div>`}`;
  bindViewSwitch(root);
  root.querySelectorAll("[data-q-status-add]").forEach(button => button.addEventListener("click", openAvailableReports));
  root.querySelectorAll("[data-q-status-open]").forEach(card => {
    const open = () => openReportDetail(card.dataset.qStatusOpen);
    card.addEventListener("click", event => {
      if (Date.now() < skipStatusOpenUntil) { skipStatusOpenUntil = 0; return; }
      if (!event.target.closest("button")) open();
    });
    card.addEventListener("keydown", event => { if ((event.key === "Enter" || event.key === " ") && !event.target.closest("button")) { event.preventDefault(); open(); } });
    card.addEventListener("dragstart", event => {
      card.classList.add("dragging");
      event.dataTransfer.setData("text/plain", card.dataset.qStatusOpen);
      event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  root.querySelectorAll("[data-q-status-move]").forEach(button => button.addEventListener("click", event => {
    event.stopPropagation();
    button.disabled = true;
    moveStatusCard(button.dataset.qStatusMove, button.dataset.to);
  }));
  root.querySelectorAll("[data-q-status-remove]").forEach(button => button.addEventListener("click", async event => {
    event.stopPropagation();
    try {
      await apiPost(`/me/board/items/${encodeURIComponent(button.dataset.qStatusRemove)}/remove`, {});
      toast("Карточка убрана с вашей доски.", "success");
      await loadQueue();
    } catch (error) { toast(`Не удалось убрать карточку: ${error.message}`, "error"); }
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

async function openAvailableReports() {
  const overlay = openSheet(`<h2>Добавить серию</h2><p class="my-status-picker-hint">Серия появится в «Очереди» только на вашей доске. Общий статус и назначения не изменятся.</p><input class="my-status-picker-search" type="search" placeholder="Название или номер серии" aria-label="Поиск серии"><div class="my-status-picker-list"><div class="my-status-empty">Загружаю серии…</div></div>`, "wide");
  const input = overlay.querySelector(".my-status-picker-search");
  const list = overlay.querySelector(".my-status-picker-list");
  let timer;
  let request = 0;
  const render = async () => {
    const current = ++request;
    list.innerHTML = `<div class="my-status-empty">Загружаю серии…</div>`;
    try {
      const data = await apiGet(`/me/board/available?q=${encodeURIComponent(input.value.trim())}`);
      if (current !== request || !overlay.isConnected) return;
      const items = data.items || [];
      if (!items.length) {
        list.innerHTML = `<div class="my-status-empty">Нет доступных серий для добавления.</div>`;
        return;
      }
      list.innerHTML = items.map(item => {
        const poster = item.poster_url ? `<img src="${esc(imgProxy(item.poster_url))}" alt="" loading="lazy">` : `<span class="my-status-picker-poster"></span>`;
        return `<button type="button" class="my-status-picker-item" data-q-status-add-item="${esc(item.public_id)}">${poster}<span><small>${esc(item.public_id)}${item.deadline ? ` · срок ${esc(item.deadline.slice(8, 10))}.${esc(item.deadline.slice(5, 7))}` : " · без срока"}</small><b>${esc(item.title_name || item.title || "Без названия")}</b><span>${esc(item.title)}</span></span><strong>Добавить</strong></button>`;
      }).join("");
      list.querySelectorAll("[data-q-status-add-item]").forEach(button => button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await apiPost(`/me/board/items/${encodeURIComponent(button.dataset.qStatusAddItem)}/add`, {});
          dismissSheet(overlay);
          toast("Серия добавлена в «Очередь».", "success");
          await loadQueue();
        } catch (error) {
          button.disabled = false;
          toast(`Не удалось добавить серию: ${error.message}`, "error");
        }
      }));
    } catch (error) {
      if (current === request) list.innerHTML = `<div class="my-status-empty">Не удалось загрузить серии: ${esc(error.message)}</div>`;
    }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 180); });
  render();
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
