// Переключение вкладок + первичная/повторная загрузка данных активной.

import { state, can } from "./state.js";
import { apiGet, toast } from "./api.js";
import { $, $all } from "./utils.js";
import { loadOverview } from "./Overview.jsx";
import { loadReports } from "./reports.js";
import { loadBoard } from "./board.js";
import { loadTitlesTab } from "./titles.js";
import { loadCalendar } from "./calendar.js";
import { loadMessages } from "./messages.js";
import { loadFeed } from "./feed.js";
import { loadNyaa } from "./nyaa.js";
import { loadProfile } from "./profile.js";
import { loadAnalytics } from "./analytics.js";
import { loadServices } from "./services.js";
import { loadUploads } from "./kodik.js";
import { loadTeam } from "./team.js";
import { loadQueue } from "./queue.js";
import { loadParser } from "./parser.js";
import { loadRoadmap } from "./roadmap.js";
import { startTab } from "./ui-prefs.js";
import { clearDirectoryCache } from "./titles-admin.js";
import { refreshTeamNotice, clearTeamNotice } from "./team-notice.js";
import { refreshLockdown, clearLockdown } from "./lockdown.js";
import { clearBackdrop } from "./backdrop.js";
import { refreshPermissions } from "./permissions-refresh.js";

// Загрузчики возвращают false, если данные взять не удалось (сеть/сервер)
// — см. loadActiveTab ниже.
const LOADERS = {
  queue: loadQueue,
  overview: loadOverview,
  list: loadReports,
  board: loadBoard,
  titles: loadTitlesTab,
  calendar: loadCalendar,
  messages: loadMessages,
  feed: loadFeed,
  nyaa: loadNyaa,
  analytics: loadAnalytics,
  services: loadServices,
  a365: loadUploads,
  team: loadTeam,
  profile: loadProfile,
  parser: loadParser,
  roadmap: loadRoadmap,
};

// Контейнеры вкладок — чистятся при выходе из аккаунта, чтобы данные
// предыдущего пользователя не остались висеть в DOM.
const TAB_BODIES = ["#queue-body", "#overview-body", "#board-body", "#titles-body", "#calendar-body", "#messages-body", "#feed-body", "#nyaa-body", "#analytics-body", "#services-body", "#a365-body", "#team-body", "#profile-body", "#reports-body", "#parser-body", "#roadmap-body"];

// Последняя открытая вкладка переживает не только смену пользователя
// (см. комментарий у state.activeTab в state.js — это настройка
// интерфейса, а не сессии), но и полный перезапуск приложения: студия
// целыми днями держит одну и ту же вкладку (обычно «Доску»), и
// открывать заново «Обзор» после каждого закрытия окна — лишний клик,
// который набегает десятки раз в день.
const LAST_TAB_KEY = "project-last-tab";

// Вкладки, которые видит рядовой участник студии.
export const MEMBER_TABS = new Set(["queue", "titles", "messages", "team", "profile"]);

// Какое право открывает админскую вкладку; остальные (Сервисы, Anime 365, Релизы) — только для админа.
const TAB_PERMS = { a365: ["a365.view", "a365.upload"], feed: "reports.feed", board: "reports.board", overview: "reports.overview", list: "reports.list", calendar: "reports.calendar", analytics: "reports.analytics", parser: "parser.use" };

export function tabAllowed(name) {
  if (MEMBER_TABS.has(name)) return true;
  if (name === "nyaa" && state.nyaaAccess) return true;
  if (TAB_PERMS[name]) return [].concat(TAB_PERMS[name]).some(can);
  return !!state.isAdmin;
}

export function switchTab(name) {
  if (!tabAllowed(name)) name = "messages";
  // Профиль коллеги и карточка серии лежат поверх вкладок: переход по меню должен их закрыть, иначе вкладку не видно.
  // Карточка серии сама снимает подписки при удалении из DOM (MutationObserver в report-detail.js).
  // Окно, открепленное в отдельное окно программы, — не оверлей, его это не касается.
  $all(".pf-page-overlay, .overlay.report-detail-overlay").forEach(o => o.remove());
  state.activeTab = name;
  try { localStorage.setItem(LAST_TAB_KEY, name); } catch (_) { /* не критично */ }
  $all(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $all(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === name));
  syncMoreButton(name);
  // Цена — один лишний запрос на каждый клик по уже открытой вкладке,
  // для дашборд-вкладок студии (Обзор/Доска/Тайтлы/
  // Аналитика/Сервисы/Команда) это то, чего и просили: не кэш, а
  // текущее состояние.
  loadActiveTab(true).catch(e => toast(`Не удалось открыть вкладку: ${e.message}`, "error"));
  // Подсказка «Впервые в разделе?» (tour.js) слушает это событие.
  document.dispatchEvent(new CustomEvent("project:tab", { detail: name }));
}
$all(".tab-btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

//
export async function loadActiveTab(force) {
  const name = state.activeTab;
  if (!force && state.loadedTabs.has(name)) return;
  const loader = LOADERS[name];
  if (!loader) return;
  // Вкладка уже показывалась — грузим «мягко»: прошлое содержимое остаётся до прихода
  // свежих данных (см. keepOnReload в api.js), а входные анимации новой разметки сразу
  // доводятся до конца, чтобы знакомые карточки не «впрыгивали» на каждом клике.
  const soft = state.loadedTabs.has(name);
  state.softReload = soft;
  let ok;
  try { ok = await loader(); } finally { state.softReload = false; }
  if (soft) finishEntrance(document.querySelector(`.tab-panel[data-panel="${name}"]`));
  if (ok !== false) state.loadedTabs.add(name);
  else state.loadedTabs.delete(name);
}

// Входные (конечные) анимации внутри панели — сразу в конечный кадр. Бесконечные
// (индикатор «в сети», пульс сроков) не трогаем.
function finishEntrance(panel) {
  if (!panel) return;
  for (const a of panel.getAnimations({ subtree: true })) {
    const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
    if (t && t.iterations !== Infinity && a.playState !== "finished" && a.effect.target !== panel) {
      try { a.finish(); } catch (_) { /* анимация без конца — пропускаем */ }
    }
  }
}

// Вызывается один раз при старте, до первой загрузки данных — иначе
// пришлось бы дважды бить по сети (сначала «Обзор» по умолчанию из
// разметки, потом настоящая последняя вкладка). Просто переключает DOM
// и state.activeTab, саму загрузку данных всё ещё делает
// loadActiveTab()/refreshAll() ниже по цепочке вызовов в auth.js.
export function restoreLastTab() {
  refreshTeamNotice();
  refreshLockdown();
  let saved = null;
  try { saved = localStorage.getItem(LAST_TAB_KEY); } catch (_) { /* не критично */ }
  // Настройки → Поведение → «Стартовый раздел».
  const start = startTab();
  if (start !== "last") saved = start;
  if (!saved || !tabAllowed(saved)) saved = "messages";
  if (!saved || !LOADERS[saved]) return;
  state.activeTab = saved;
  $all(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === saved));
  $all(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === saved));
  syncMoreButton(saved);
}

// Редкие разделы (лента, аналитика, сервисы, команда, профиль) живут в
// меню «Ещё» шапки. Когда открыт один из них, кнопка «Ещё» подсвечена, а подпись не меняется:
// название раздела есть в заголовке страницы, а меню не сдвигается при переходах.
function syncMoreButton(name) {
  const btn = $("#more-btn");
  if (!btn) return;
  const item = $(`#more-menu .tab-btn[data-tab="${name}"]`);
  btn.classList.toggle("active", !!item);
}

export function clearTabDom() {
  clearBackdrop();
  clearTeamNotice();
  clearLockdown();
  for (const sel of TAB_BODIES) {
    const el = $(sel);
    if (el) el.innerHTML = "";
  }
  const bulk = $("#bulk-bar");
  if (bulk) bulk.hidden = true;
  const statusbar = $("#statusbar");
  if (statusbar) statusbar.textContent = "";
  // Фильтры списка и сохранённые пресеты — личные: следующий вошедший на
  // общей машине не должен начинать с выборки предыдущего.
  for (const sel of ["#search-input", "#status-filter", "#priority-filter", "#assignee-filter", "#season-filter", "#title-filter"]) {
    const el = $(sel);
    if (el) el.value = "";
  }
  const presets = $("#preset-chips");
  if (presets) presets.innerHTML = "";
  const more = $("#list-more");
  if (more) more.hidden = true;
}

let refreshInFlight = false;

export async function refreshAll() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  const btn = $("#refresh-btn");
  const label = btn.querySelector(".btn-lbl") || btn;
  btn.disabled = true;
  const originalText = label.textContent;
  label.textContent = "Обновляю…";
  try {
    // Матрица могла измениться после входа; F5/«Обновить» должны
    // перечитать права и сразу показать новые вкладки.
    await refreshPermissions();
    clearDirectoryCache();
    refreshTeamNotice();
    refreshLockdown();
    if (state.isAdmin) await loadUsers();
    await loadActiveTab(true);
    // Открытые окна (карточка отчёта, Автоматизация) тоже перечитывают свои данные.
    document.dispatchEvent(new CustomEvent("app:refresh"));
  } finally {
    refreshInFlight = false;
    btn.disabled = false;
    label.textContent = originalText;
  }
}

export async function loadUsers() {
  try {
    const r = await apiGet("/assignable-users");
    state.users = r.users || [];
  } catch (_) { /* не критично для списка */ }
}

$("#refresh-btn").addEventListener("click", refreshAll);
