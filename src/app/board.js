
import { apiGet, apiPost, toast, dialogSkeletonHtml, openSheet, tabSkeleton } from "./api.js";
import { pipelinePct } from "./utils.js";
import { invoke, pickInputFile } from "./tauri.js";
import { $, esc, initials, STATUS_DOT_CLASS, STATUS_COLOR_VAR, PRIORITY_LABELS } from "./utils.js";
import { timelineHtml, playTimelineIntro } from "./charts.js";
import { assigneesHtml, seriesParts, posterSrc } from "./reports.js";
import { openReportDetail } from "./report-detail.js";
import { state, can } from "./state.js";
import { ATTACH_EXTENSIONS } from "./file-drop.js";
import { loadAvatars } from "./profile.js";
import { doomState, doomPosterHtml, doomCardStyle, deadFxHtml, shatterHtml } from "./Crack.jsx";
import { enhanceSelects } from "./fancy-select.js";

function collapsedKey() { return `project_board_collapsed_${state.telegramId || "anon"}`; }
function readCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem(collapsedKey()) || "[]")); } catch (_) { return new Set(); }
}
function writeCollapsed(set) {
  try { localStorage.setItem(collapsedKey(), JSON.stringify([...set])); } catch (_) { }
}
function expandedKey() { return `project_board_expanded_${state.telegramId || "anon"}`; }
function readExpanded() {
  try { return new Set(JSON.parse(localStorage.getItem(expandedKey()) || "[]")); } catch (_) { return new Set(); }
}
function writeExpanded(set) {
  try { localStorage.setItem(expandedKey(), JSON.stringify([...set])); } catch (_) { }
}
function foldedKey() { return `project_board_folded_${state.telegramId || "anon"}`; }
function readFolded() {
  try { return new Set(JSON.parse(localStorage.getItem(foldedKey()) || "[]")); } catch (_) { return new Set(); }
}
function writeFolded(set) {
  try { localStorage.setItem(foldedKey(), JSON.stringify([...set])); } catch (_) { }
}
const autoCollapsed = col => (col.status === "cancelled" || !col.total) && !boardView.query;
function isCollapsed(col, collapsed, expanded) {
  return collapsed.has(col.status) || (autoCollapsed(col) && !expanded.has(col.status));
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const STATUS_PROGRESS = { working: 40, review: 70, revision: 55, completed: 100 };
const DRAG_THRESHOLD_PX = 6;

const lastDragEndAt = new WeakMap();

const SORTS = [
  ["smart", "🔥 По срочности"],
  ["deadline", "📅 По сроку"],
  ["priority", "⚡ По приоритету"],
  ["age", "🕸 По давности"],
  ["none", "↕ Как на сервере"],
];
const WIP_LIMITS = { working: 8, review: 15, revision: 6 };
const STALE_AFTER_DAYS = 7;

function boardMode() { try { return localStorage.getItem("project_board_mode") === "timeline" ? "timeline" : "cols"; } catch (_) { return "cols"; } }
function setBoardMode(v) { try { localStorage.setItem("project_board_mode", v); } catch (_) { } }

function sortKey() { return `project_board_sort_${state.telegramId || "anon"}`; }
function readSort() {
  try { return localStorage.getItem(sortKey()) || "smart"; } catch (_) { return "smart"; }
}
function writeSort(value) {
  try { localStorage.setItem(sortKey(), value); } catch (_) { }
}

const boardView = { sort: readSort(), query: "", seasonId: 0, titleId: 0, month: "" };
let lastBoardData = null;
let lastLayout = null;

let seasonsList = null;
const titlesBySeasonCache = new Map();

async function ensureSeasonsLoaded() {
  if (seasonsList) return seasonsList;
  try {
    const d = await apiGet("/public/seasons");
    seasonsList = d.seasons || [];
  } catch (_) {
    seasonsList = [];
  }
  return seasonsList;
}

async function ensureTitlesLoaded(seasonId) {
  if (!seasonId) return [];
  if (titlesBySeasonCache.has(seasonId)) return titlesBySeasonCache.get(seasonId);
  let titles = [];
  try {
    const d = await apiGet(`/public/seasons/${seasonId}/titles`);
    titles = d.titles || [];
  } catch (_) { }
  titlesBySeasonCache.set(seasonId, titles);
  return titles;
}

function todayLocal() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function layoutRequest(columns) {
  return invoke("board_layout", {
    columns,
    view: {
      sort: boardView.sort,
      query: boardView.query,
      today: todayLocal(),
      wipLimits: WIP_LIMITS,
      staleAfterDays: STALE_AFTER_DAYS,
    },
  });
}

function deadlineLabel(c) {
  if (c.deadline == null) return "без срока";
  if (c.daysLeft == null) return `до ${prettyDate(c.deadline)}`;
  if (c.daysLeft < -1) return `просрочено на ${-c.daysLeft} дн.`;
  if (c.daysLeft === -1) return "просрочено вчера";
  if (c.daysLeft === 0) return "сегодня";
  if (c.daysLeft === 1) return "завтра";
  if (c.daysLeft <= 14) return `через ${c.daysLeft} дн.`;
  return `до ${prettyDate(c.deadline)}`;
}

function prettyDate(iso) {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("ru-RU", opts).replace(/\s*г\.$/, "");
}

const doomCardClass = st => ` doom${st.level >= 0.5 ? " dread" : ""}${st.gloom > 0.9 ? " flicker" : ""}${st.level >= 1 ? " dead" : ""}`;

function tickDoom() {
  if (document.hidden) return;
  for (const el of document.querySelectorAll(".kc-doom[data-doom]")) {
    const st = doomState(el.dataset.doom);
    const card = el.closest(".board-card");
    if (!st || !card || st.key === el.dataset.doomKey) continue;
    el.dataset.doomKey = st.key;
    el.innerHTML = doomPosterHtml(card.dataset.id, el.dataset.doomSrc, st);
    card.classList.remove("dread", "flicker", "dead");
    card.className += doomCardClass(st).replace(" doom", "");
    if (st.level >= 1 && !card.querySelector(".kc-dead-fx")) card.insertAdjacentHTML("afterbegin", deadFxHtml(card.dataset.id));
    for (const kv of doomCardStyle(st).split(";")) {
      const [k, v] = kv.split(":");
      card.style.setProperty(k, v);
    }
  }
}
setInterval(tickDoom, 20000);

let seriesById = new Map();
function rememberSeries(statuses) {
  seriesById = new Map();
  for (const col of statuses || []) for (const r of col.reports || []) seriesById.set(r.public_id, r);
}
const cleanLabel = s => String(s || "").replace(/^[^\p{L}\p{N}]+/u, "");

export function boardCardHtml(c, status) {
  const r = seriesById.get(c.publicId) || {};
  const parts = seriesParts({ ...r, title: c.title, public_id: c.publicId });
  const poster = posterSrc(r.poster_url);
  const roles = r.pipeline_roles || [];
  const stage = roles.length && r.pipeline_stage != null ? roles[Math.min(r.pipeline_stage, roles.length - 1)] : cleanLabel(r.status_label) || "";
  const closed = status === "completed" || status === "cancelled";
  const pct = status === "completed" ? 100
    : pipelinePct(r) ?? STATUS_PROGRESS[status] ?? 6;
  const pipeDone = status === "completed" ? roles.length : Math.min(r.pipeline_done ?? 0, roles.length);
  const waiting = (r.pipeline_waiting || []).join(", ");
  const pipe = roles.length && !closed
    ? `<span class="kc-pipe" title="${esc(`Пайплайн: ${roles.join(" → ")}${waiting ? `\nЖдём: ${waiting}` : ""}`)}">
        <span class="kc-pipe-seg">${roles.map((_, i) => `<i${i < pipeDone ? ` class="on"` : ""}></i>`).join("")}</span>
        <small><b>${pipeDone}/${roles.length}</b> сдали${waiting ? ` · ждём: ${esc(waiting)}` : ""}</small>
      </span>`
    : "";
  const overdue = c.overdue && !closed;
  const abandoned = overdue && Number.isFinite(c.daysLeft) && c.daysLeft <= -3;
  const hotDue = !closed && (overdue || c.daysLeft === 0 || c.daysLeft === 1);
  const doom = poster && !closed && c.deadline ? doomState(c.deadline) : null;
  const posterHtml = doom
    ? `<span class="kc-pc kc-doom" data-doom="${esc(c.deadline)}" data-doom-key="${doom.key}" data-doom-src="${esc(poster)}">${doomPosterHtml(c.publicId, poster, doom)}</span>`
    : poster ? `<img class="kc-pc" src="${poster}" alt="" loading="lazy">` : `<span class="kc-pc kc-pc-ph">${esc(initials(parts.name))}</span>`;
  return `
    <div class="board-card${overdue ? " is-overdue" : ""}${c.stale ? " is-stale" : ""}${(c.heat || 0) >= .7 ? " is-hot" : ""}${doom ? doomCardClass(doom) : ""}${abandoned ? " is-abandoned" : ""}"
         data-open="${esc(c.publicId)}" data-id="${esc(c.publicId)}" data-status="${esc(status)}"
         style="--accent-dot: var(${STATUS_COLOR_VAR[status] || "--s-draft"});${doom ? doomCardStyle(doom) : ""}">
      ${doom && doom.level >= 1 && !abandoned ? deadFxHtml(c.publicId) : ""}
      ${abandoned ? shatterHtml(c.publicId) : ""}
      ${c.priority === "urgent" && !closed ? `<i class="kc-flag" title="Срочно"></i>` : ""}
      ${posterHtml}
      <span class="kc-id">${esc(c.publicId)}${parts.ep ? ` · ${esc(parts.ep.replace("серия ", "EP "))}` : ""}</span>
      <b class="ttl">${esc(parts.name)}</b>
      <span class="kc-sg">${closed ? (status === "completed" ? "Завершена" : "Отменена") : `${stage ? `${esc(stage)} · ` : ""}<span class="${hotDue ? "hot" : ""}">${esc(deadlineLabel(c))}</span>`}${c.stale ? ` · без движения ${c.ageDays} дн.` : ""}</span>
      <span class="kc-ft">
        ${pipe || `<span class="board-card-progress-track" title="Готовность ${pct}%"><i data-target-width="${pct}"></i></span>`}
        ${c.unassigned ? `<span class="kc-none">не назначено</span>` : assigneesHtml(c.assignees)}
      </span>
    </div>`;
}


const LONG_PRESS_MS = 350;

function wireCardDrag(card) {
  card.addEventListener("pointerdown", downEvent => {
    if (downEvent.button !== 0) return;
    const startX = downEvent.clientX;
    const startY = downEvent.clientY;
    const boardEl = card.closest(".board");
    const byTouch = downEvent.pointerType !== "mouse";
    let mode = byTouch ? "pending" : "card";
    let dragging = false;
    let panned = false;
    let ghost = null;
    let overCol = null;
    let holdTimer = null;
    const startScroll = boardEl ? boardEl.scrollLeft : 0;

    card.setPointerCapture(downEvent.pointerId);

    function moveGhost(x, y) {
      ghost.style.left = `${x + 14}px`;
      ghost.style.top = `${y + 14}px`;
      const under = document.elementFromPoint(x, y);
      const col = under && under.closest(".board-col");
      if (col !== overCol) {
        if (overCol) overCol.classList.remove("drag-over");
        overCol = col;
        if (overCol) overCol.classList.add("drag-over");
      }
    }

    function beginCardDrag(x, y) {
      dragging = true;
      card.classList.add("dragging");
      const rect = card.getBoundingClientRect();
      ghost = card.cloneNode(true);
      ghost.classList.add("board-card-ghost");
      ghost.style.width = `${rect.width}px`;
      document.body.appendChild(ghost);
      document.body.style.cursor = "grabbing";
      moveGhost(x, y);
    }

    if (byTouch) {
      holdTimer = setTimeout(() => { // DevSkim: ignore DS172411
        holdTimer = null;
        if (mode !== "pending") return;
        mode = "card";
        card.style.touchAction = "none";
        beginCardDrag(startX, startY);
      }, LONG_PRESS_MS);
    }

    function endPanVisuals() {
      if (!boardEl) return;
      boardEl.classList.remove("panning");
      boardEl.style.scrollBehavior = "smooth";
    }

    function onMove(e) {
      if (e.pointerId !== downEvent.pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (mode === "pending") {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        clearTimeout(holdTimer);
        holdTimer = null;
        mode = "pan";
        if (boardEl) {
          boardEl.classList.add("panning");
          boardEl.style.scrollBehavior = "auto";
        }
      }

      if (mode === "pan") {
        if (!boardEl) return;
        panned = true;
        boardEl.scrollLeft = startScroll - dx;
        return;
      }

      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        beginCardDrag(e.clientX, e.clientY);
        return;
      }
      moveGhost(e.clientX, e.clientY);
    }

    async function onUp(e) {
      if (e.pointerId !== downEvent.pointerId) return;
      card.removeEventListener("pointermove", onMove);
      card.removeEventListener("pointerup", onUp);
      card.removeEventListener("pointercancel", onUp);
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (card.hasPointerCapture(downEvent.pointerId)) card.releasePointerCapture(downEvent.pointerId);
      card.style.touchAction = "";

      if (mode === "pan") {
        endPanVisuals();
        if (panned) lastDragEndAt.set(card, Date.now());
        return;
      }
      if (!dragging) return;
      lastDragEndAt.set(card, Date.now());
      card.classList.remove("dragging");
      document.body.style.cursor = "";
      if (ghost) ghost.remove();
      if (overCol) overCol.classList.remove("drag-over");

      const targetStatus = overCol && overCol.dataset.status;
      if (!targetStatus || targetStatus === card.dataset.status) return;
      try {
        const res = await apiPost(`/report/${encodeURIComponent(card.dataset.id)}/status`, { status: targetStatus });
        if (res.changed) { toast("Статус изменён."); await loadBoard(); }
        else if (res.detail) toast(res.detail, "error");
      } catch (e) {
        toast(`Не удалось перенести карточку: ${e.message}`, "error");
      }
    }

    card.addEventListener("pointermove", onMove);
    card.addEventListener("pointerup", onUp);
    card.addEventListener("pointercancel", onUp);
  });
}

function canScrollVertically(from, dy) {
  for (let el = from; el && el !== document.documentElement; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) {
      if (dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
    }
  }
  const page = document.scrollingElement;
  return !!page && (dy > 0 ? page.scrollTop + page.clientHeight < page.scrollHeight - 1 : page.scrollTop > 0);
}

function wireBoardScroll(boardEl) {
  if (!boardEl) return;
  boardEl.addEventListener("wheel", e => {
    if (e.deltaY === 0) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if (boardEl.scrollWidth <= boardEl.clientWidth + 1) return;
    if (canScrollVertically(e.target, e.deltaY)) return;
    e.preventDefault();
    boardEl.scrollLeft += e.deltaY;
  }, { passive: false });

  let panning = false;
  let panPointerId = null;
  let startX = 0;
  let startScroll = 0;
  boardEl.addEventListener("pointerdown", e => {
    if (e.button !== 0 || e.target.closest(".board-card, .board-col-head, button")) return;
    panning = true;
    panPointerId = e.pointerId;
    startX = e.clientX;
    startScroll = boardEl.scrollLeft;
    boardEl.classList.add("panning");
    boardEl.style.scrollBehavior = "auto";
    boardEl.setPointerCapture(e.pointerId);
  });
  boardEl.addEventListener("pointermove", e => {
    if (!panning || e.pointerId !== panPointerId) return;
    boardEl.scrollLeft = startScroll - (e.clientX - startX);
  });
  function endPan(e) {
    if (e.pointerId !== panPointerId) return;
    panning = false;
    boardEl.classList.remove("panning");
    boardEl.style.scrollBehavior = "smooth";
    if (boardEl.hasPointerCapture(panPointerId)) boardEl.releasePointerCapture(panPointerId);
  }
  boardEl.addEventListener("pointerup", endPan);
  boardEl.addEventListener("pointercancel", endPan);
}

function wireBoardCards(root) {
  root.querySelectorAll(".board-card[data-open]:not([data-wired])").forEach(el => {
    el.dataset.wired = "1";
    el.addEventListener("click", () => {
      if (Date.now() - lastDragEndAt.get(el) < 50) return;
      openReportDetail(el.dataset.open);
    });
    wireCardDrag(el);
  });
}

function boardToolbarHtml() {
  const seasons = seasonsList || [];
  const titles = boardView.seasonId ? (titlesBySeasonCache.get(boardView.seasonId) || []) : [];
  return `
    <div class="board-toolbar">
      <label class="board-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></svg>
        <input type="search" id="board-search" placeholder="Номер или название" value="${esc(boardView.query)}" autocomplete="off">
      </label>
      <select id="board-season" class="board-sort" title="Фильтр по сезону">
        <option value="0" ${boardView.seasonId ? "" : "selected"}>Все сезоны</option>
        ${seasons.map(s => `<option value="${s.id}" ${s.id === boardView.seasonId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}
      </select>
      <select id="board-title" class="board-sort" title="Фильтр по тайтлу" ${boardView.seasonId ? "" : "disabled"}>
        <option value="0" ${boardView.titleId ? "" : "selected"}>Все тайтлы</option>
        ${titles.map(t => `<option value="${t.id}" ${t.id === boardView.titleId ? "selected" : ""}>${esc(t.name)}</option>`).join("")}
      </select>
      <select id="board-month" class="board-sort" title="Показать серии со сроком в этом месяце">${monthOptionsHtml(boardView.month)}</select>
      <select id="board-sort" class="board-sort" title="Порядок карточек в колонках">
        ${SORTS.map(([v, l]) => `<option value="${v}" ${v === boardView.sort ? "selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
    </div>`;
}

function columnHtml(col, collapsed, expanded, folded) {
  const colorVar = STATUS_COLOR_VAR[col.status] || "--s-draft";
  const wide = col.cards.length >= 4 && col.status !== "completed" && col.status !== "cancelled";
  const isFolded = folded.has(col.status);
  return `
    <div class="board-col ${isCollapsed(col, collapsed, expanded) ? "collapsed" : ""}${col.overWip ? " over-wip" : ""}${wide ? " wide" : ""}${isFolded ? " folded" : ""}"
         data-status="${esc(col.status)}" style="--col-accent: var(${colorVar});">
      <div class="board-col-head" data-fold="${esc(col.status)}" role="button" tabindex="0" aria-expanded="${isFolded ? "false" : "true"}" title="${isFolded ? "Показать карточки" : "Скрыть карточки"}">
        <svg class="board-col-fold" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
        <span class="lb" title="${esc(cleanLabel(col.label))}"><span class="dot ${STATUS_DOT_CLASS[col.status] || "draft"}"></span>${esc(cleanLabel(col.label).split("/")[0])}</span>
        <span class="cnt${col.overWip ? " over" : ""}" title="${col.overWip ? `Серий в этом статусе больше, чем ${col.wipLimit} — команда может не успевать` : "Всего в статусе"}">${col.total}${col.overWip ? ` · лимит ${col.wipLimit}` : ""}</span>
        <button class="board-col-collapse" data-collapse="${esc(col.status)}" title="Свернуть/развернуть колонку" aria-label="Свернуть/развернуть колонку"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button>
      </div>
      <div class="board-cards" data-count="${col.cards.length}">
        ${col.cards.length ? col.cards.map(c => boardCardHtml(c, col.status)).join("") : `<div class="board-col-empty">${boardView.query ? "ничего не нашлось" : "пусто"}</div>`}
      </div>
      ${col.hasMore ? `<button class="btn ghost board-col-more" data-loadmore="${esc(col.status)}">Показать ещё (${col.total - col.cards.length})</button>` : ""}
    </div>`;
}

const BOARD_STAT_GROUPS = [
  { key: "draft", label: "Черновики", statuses: ["draft"], icon: "📁" },
  { key: "review", label: "Озвучка", statuses: ["review", "revision"], icon: "🎙" },
  { key: "working", label: "В работе", statuses: ["working"], icon: "⏳" },
  { key: "completed", label: "Завершено", statuses: ["completed"], icon: "✅" },
];

function boardStats(layout) {
  const totals = {};
  for (const col of layout.columns) totals[col.status] = col.total || 0;
  return BOARD_STAT_GROUPS.map(g => ({
    ...g,
    count: g.statuses.reduce((sum, st) => sum + (totals[st] || 0), 0),
  }));
}

function performanceHtml(stats) {
  const total = stats.reduce((sum, s) => sum + s.count, 0);
  const peak = Math.max(1, ...stats.map(s => s.count));
  const colorOf = s => `var(${STATUS_COLOR_VAR[s.statuses[0]] || "--s-draft"})`;
  return `
    <div class="bcell board-performance-cell">
      <h3>Производительность</h3>
      <div class="big-num" style="font-size:30px;">${total}</div>
      <div class="sub" style="margin:2px 0 14px;">серий на доске</div>
      <div class="board-perf-bars">
        ${stats.map(s => `
          <div class="board-perf-col" title="${esc(s.label)}: ${s.count}">
            <div class="an-bar" style="height:${Math.max(4, Math.round((s.count / peak) * 96))}px; background:${colorOf(s)};"></div>
            <div class="an-bar-label">${s.count}</div>
          </div>`).join("")}
      </div>
      <div class="dash-legend" style="margin:12px 0 0; flex-wrap:wrap;">
        ${stats.map(s => `<span><i style="background:${colorOf(s)};"></i>${esc(s.label)}</span>`).join("")}
      </div>
    </div>`;
}

const TERMINAL_STATUSES = new Set(["completed", "cancelled"]);
const TIMELINE_MAX_ROWS = 8;

function timelineSectionHtml(layout) {
  const rows = [];
  for (const col of layout.columns) {
    if (TERMINAL_STATUSES.has(col.status)) continue;
    for (const c of col.cards) {
      if (!c.createdAt || !c.deadline) continue;
      const startMs = Date.parse(c.createdAt);
      const endMs = Date.parse(c.deadline);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
      rows.push({
        label: c.publicId,
        title: (() => { const p = seriesParts({ ...(seriesById.get(c.publicId) || {}), title: c.title, public_id: c.publicId }); return [p.name, p.ep].filter(Boolean).join(" · "); })(),
        colorVar: STATUS_COLOR_VAR[col.status] || "--s-draft",
        startMs, endMs, heat: c.heat || 0,
      });
    }
  }
  if (!rows.length) return "";
  rows.sort((a, b) => b.heat - a.heat);
  const shown = rows.slice(0, TIMELINE_MAX_ROWS);
  const now = Date.now();
  const rangeStart = Math.min(...shown.map(r => r.startMs));
  const rangeEnd = Math.max(now, ...shown.map(r => r.endMs));
  return `
    <div class="bcell board-timeline-cell">
      <h3>Таймлайн активных серий</h3>
      ${timelineHtml(shown, rangeStart, rangeEnd, now)}
    </div>`;
}

function monthOptionsHtml(selected) {
  if (!/^\d{4}-\d{2}$/.test(selected || "")) selected = "";
  const now = new Date();
  const opts = [`<option value="">Все сроки</option>`];
  const values = [];
  for (let i = -1; i <= 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    values.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  }
  if (selected && !values.includes(selected)) values.push(selected);
  for (const v of values) {
    const [y, m] = v.split("-").map(Number);
    const label = new Date(y, m - 1, 1).toLocaleDateString("ru-RU", { month: "long", year: "numeric" }).replace(" г.", "");
    opts.push(`<option value="${esc(v)}"${v === selected ? " selected" : ""}>Срок: ${esc(label)}</option>`);
  }
  return opts.join("");
}

async function renderBoard(root) {
  if (!lastBoardData) return;
  let layout;
  try {
    layout = await layoutRequest(lastBoardData.statuses);
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось разложить доску: ${esc(e.message || e)}</div>`;
    return;
  }
  if (!layout || !Array.isArray(layout.columns)) {
    root.innerHTML = `<div class="bento-empty">Доска вернулась в непонятном виде — попробуйте обновить.</div>`;
    return;
  }
  const collapsed = readCollapsed();
  const expanded = readExpanded();
  const folded = readFolded();
  rememberSeries(lastBoardData.statuses);
  const stats = boardStats(layout);
  const active = layout.columns.filter(c => c.status !== "completed" && c.status !== "cancelled").reduce((n, c) => n + (c.total || 0), 0);
  const canCreateReport = can("reports.create");
  const timeline = boardMode() === "timeline";
  lastLayout = layout;
  root.innerHTML = `
    <div class="page-header">
      <div>
        <span class="kd-label">Основное · ${active} ${plural(active, "активная серия", "активные серии", "активных серий")}</span>
        <h1>Доска</h1>
      </div>
      <div class="page-header-actions">
        <div class="kd-seg" role="tablist">
          <button type="button" data-board-mode="cols" class="${timeline ? "" : "on"}">Колонки</button>
          <button type="button" data-board-mode="timeline" class="${timeline ? "on" : ""}">Таймлайн</button>
        </div>
        ${canCreateReport ? `<button class="btn" id="board-import-btn">Импорт</button>
        <button class="btn primary" id="board-add-btn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Новый проект</button>` : ""}
      </div>
    </div>
    ${boardToolbarHtml()}
    ${timeline ? topRowHtml(layout, stats) : ""}
    <div class="board">${layout.columns.map(col => columnHtml(col, collapsed, expanded, folded)).join("")}</div>
  `;
  root.querySelectorAll("[data-board-mode]").forEach(b => b.addEventListener("click", () => switchBoardMode(root, b.dataset.boardMode)));
  wireBoardCards(root);
  loadAvatars(root);
  wireBoardScroll(root.querySelector(".board"));
  wireBoardToolbar(root);
  wireColumnButtons(root);
  wireBoardHeaderActions(root);
  playTimelineIntro(root);
  playBoardCardsIntro(root);
}

function topRowHtml(layout, stats) {
  const timelineCell = timelineSectionHtml(layout);
  return `<div class="board-top-row${timelineCell ? "" : " single"}">${timelineCell}${performanceHtml(stats)}</div>`;
}

function switchBoardMode(root, mode) {
  setBoardMode(mode);
  root.querySelectorAll("[data-board-mode]").forEach(b => b.classList.toggle("on", b.dataset.boardMode === mode));
  root.querySelector(".board-top-row")?.remove();
  if (mode !== "timeline" || !lastLayout) return;
  root.querySelector(".board")?.insertAdjacentHTML("beforebegin", topRowHtml(lastLayout, boardStats(lastLayout)));
  playTimelineIntro(root);
}

function playBoardCardsIntro(root) {
  const bars = root.querySelectorAll(".board-card-progress-track i");
  bars.forEach(el => { el.style.background = "var(--accent-dot)"; });
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      bars.forEach(el => { el.style.width = `${el.dataset.targetWidth}%`; });
    });
  });
}

function wireBoardToolbar(root) {
  enhanceSelects(root);
  const search = root.querySelector("#board-search");
  const sort = root.querySelector("#board-sort");
  const season = root.querySelector("#board-season");
  const title = root.querySelector("#board-title");
  const month = root.querySelector("#board-month");
  if (month) month.addEventListener("change", async () => {
    boardView.month = /^\d{4}-\d{2}$/.test(month.value) ? month.value : "";
    await loadBoard();
  });
  if (sort) sort.addEventListener("change", () => {
    boardView.sort = sort.value;
    writeSort(boardView.sort);
    renderBoard(root);
  });
  if (season) season.addEventListener("change", async () => {
    boardView.seasonId = parseInt(season.value, 10) || 0;
    boardView.titleId = 0;
    if (boardView.seasonId) await ensureTitlesLoaded(boardView.seasonId);
    await loadBoard();
  });
  if (title) title.addEventListener("change", async () => {
    boardView.titleId = parseInt(title.value, 10) || 0;
    await loadBoard();
  });
  if (search) {
    let timer = null;
    search.addEventListener("input", () => {
      clearTimeout(timer); // DevSkim: ignore DS172411
      timer = setTimeout(async () => { // DevSkim: ignore DS172411
        boardView.query = search.value;
        await renderBoard(root);
        const again = root.querySelector("#board-search");
        if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      }, 180);
    });
  }
}

function wireColumnButtons(root) {
  root.querySelectorAll("[data-fold]").forEach(head => {
    const toggle = () => {
      const colEl = head.closest(".board-col");
      if (colEl.classList.contains("collapsed")) return;
      const set = readFolded();
      const now = colEl.classList.toggle("folded");
      if (now) set.add(head.dataset.fold); else set.delete(head.dataset.fold);
      writeFolded(set);
      head.setAttribute("aria-expanded", now ? "false" : "true");
      head.title = now ? "Показать карточки" : "Скрыть карточки";
    };
    head.addEventListener("click", e => { if (!e.target.closest("button")) toggle(); });
    head.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target === head) { e.preventDefault(); toggle(); } });
  });
  root.querySelectorAll("[data-collapse]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const status = btn.dataset.collapse;
      const colEl = root.querySelector(`.board-col[data-status="${status}"]`);
      const set = readCollapsed(), open = readExpanded();
      const now = colEl.classList.toggle("collapsed");
      if (now) { set.add(status); open.delete(status); } else { set.delete(status); open.add(status); }
      writeCollapsed(set);
      writeExpanded(open);
    });
  });
  root.querySelectorAll("[data-loadmore]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const status = btn.dataset.loadmore;
      const column = lastBoardData.statuses.find(c => c.status === status);
      const offset = column ? column.reports.length : 0;
      btn.disabled = true;
      btn.textContent = "Загрузка…";
      try {
        const res = await apiGet(`/board/column/${status}`, {
          offset, limit: 60,
          season_id: boardView.seasonId || undefined,
          title_id: boardView.titleId || undefined,
          month: boardView.month || undefined,
        });
        if (column) {
          column.reports = column.reports.concat(res.reports);
          column.has_more = res.has_more;
          column.total = res.total ?? column.total;
        }
        await renderBoard(root);
      } catch (e) {
        toast(`Не удалось догрузить колонку: ${e.message}`, "error");
        btn.disabled = false;
        btn.textContent = "Показать ещё";
      }
    });
  });
}

function reportCreateFormHtml(filePicked) {
  const seasons = seasonsList || [];
  const fileName = filePicked ? filePicked.split(/[\\/]/).pop() : "";
  const guessedTitle = fileName ? fileName.replace(/\.[^.]+$/, "") : "";
  return `
    <h2>${filePicked ? "📥 Импорт файла" : "＋ Новый проект"}</h2>
    ${filePicked ? `<div class="sub" style="margin:-8px 0 12px;">Файл: ${esc(fileName)}</div>` : ""}
    <label class="field-label">Название</label>
    <input type="text" id="rc-title" class="input" placeholder="Название серии" value="${esc(guessedTitle)}" maxlength="200">
    <label class="field-label">Сезон</label>
    <select id="rc-season" class="input">
      <option value="0">Без сезона</option>
      ${seasons.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}
    </select>
    <label class="field-label">Тайтл</label>
    <select id="rc-title-id" class="input" disabled>
      <option value="0">Сначала выберите сезон</option>
    </select>
    <label class="field-label">Приоритет</label>
    <select id="rc-priority" class="input">
      ${Object.entries(PRIORITY_LABELS).map(([v, l]) => `<option value="${v}" ${v === "normal" ? "selected" : ""}>${esc(l)}</option>`).join("")}
    </select>
    <label class="field-label">Срок (необязательно)</label>
    <input type="date" id="rc-deadline" class="input">
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="rc-submit">Создать</button>
    </div>`;
}

async function openCreateProjectDialog(filePicked) {
  await ensureSeasonsLoaded();
  const overlay = openSheet(reportCreateFormHtml(filePicked));
  const sheet = overlay.querySelector(".sheet");
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());

  const seasonSel = sheet.querySelector("#rc-season");
  const titleSel = sheet.querySelector("#rc-title-id");
  seasonSel.addEventListener("change", async () => {
    const seasonId = parseInt(seasonSel.value, 10) || 0;
    if (!seasonId) {
      titleSel.innerHTML = `<option value="0">Сначала выберите сезон</option>`;
      titleSel.disabled = true;
      return;
    }
    titleSel.disabled = true;
    titleSel.innerHTML = `<option value="0">Загрузка…</option>`;
    const titles = await ensureTitlesLoaded(seasonId);
    titleSel.innerHTML = `<option value="0">Без привязки к тайтлу</option>${titles.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}`;
    titleSel.disabled = false;
  });

  sheet.querySelector("#rc-submit").addEventListener("click", async () => {
    const title = sheet.querySelector("#rc-title").value.trim();
    if (!title) { toast("Название обязательно.", "error"); return; }
    const btn = sheet.querySelector("#rc-submit");
    btn.disabled = true;
    btn.textContent = "Создаю…";
    try {
      const res = await apiPost("/reports", {
        title,
        title_id: parseInt(titleSel.value, 10) || undefined,
        priority: sheet.querySelector("#rc-priority").value,
        deadline: sheet.querySelector("#rc-deadline").value || undefined,
      });
      if (filePicked) {
        try {
          await invoke("upload_report_file", { reportId: res.public_id, filePath: filePicked, initData: state.token || "" });
        } catch (e) {
          toast(`Проект создан (${res.public_id}), но файл не прикрепился: ${e}`, "error");
        }
      }
      toast(`Проект создан: ${res.public_id}`);
      overlay.remove();
      await loadBoard();
    } catch (e) {
      toast(`Не удалось создать проект: ${e.message}`, "error");
      btn.disabled = false;
      btn.textContent = "Создать";
    }
  });
}

function wireBoardHeaderActions(root) {
  const addBtn = root.querySelector("#board-add-btn");
  const importBtn = root.querySelector("#board-import-btn");
  if (addBtn) addBtn.addEventListener("click", () => openCreateProjectDialog(null));
  if (importBtn) importBtn.addEventListener("click", async () => {
    const filters = [{ name: "Медиа и документы", extensions: ATTACH_EXTENSIONS }];
    const picked = await pickInputFile(filters);
    if (picked) openCreateProjectDialog(picked);
  });
}

export async function loadBoard() {
  const root = $("#board-body");
  tabSkeleton(root, dialogSkeletonHtml(5, "cards"));
  await ensureSeasonsLoaded();
  try {
    lastBoardData = await apiGet("/board", {
      season_id: boardView.seasonId || undefined,
      title_id: boardView.titleId || undefined,
      month: boardView.month || undefined,
    });
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить доску: ${esc(e.message)}</div>`;
    return false;
  }
  await renderBoard(root);
}
