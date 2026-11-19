
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
import { loadLuatools } from "./luatools.js";
import { startTab } from "./ui-prefs.js";
import { clearDirectoryCache } from "./titles-admin.js";
import { refreshTeamNotice, clearTeamNotice } from "./team-notice.js";
import { refreshLockdown, clearLockdown } from "./lockdown.js";
import { clearBackdrop } from "./backdrop.js";
import { refreshPermissions } from "./permissions-refresh.js";

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
  luatools: loadLuatools,
};

const TAB_BODIES = ["#queue-body", "#overview-body", "#board-body", "#titles-body", "#calendar-body", "#messages-body", "#feed-body", "#nyaa-body", "#analytics-body", "#services-body", "#a365-body", "#team-body", "#profile-body", "#reports-body", "#parser-body", "#luatools-body"];

const LAST_TAB_KEY = "project-last-tab";

export const MEMBER_TABS = new Set(["queue", "titles", "messages", "team", "profile", "luatools"]);

export const TAB_PERMS = { a365: ["a365.view", "a365.upload"], feed: "reports.feed", board: "reports.board", overview: "reports.overview", list: "reports.list", calendar: "reports.calendar", analytics: "reports.analytics", parser: "parser.use" };

export function tabAllowed(name) {
  if (MEMBER_TABS.has(name)) return true;
  if (name === "nyaa" && state.nyaaAccess) return true;
  if (TAB_PERMS[name]) return [].concat(TAB_PERMS[name]).some(can);
  return !!state.isAdmin;
}

export function switchTab(name) {
  if (!tabAllowed(name)) name = "messages";
  $all(".pf-page-overlay, .overlay.report-detail-overlay").forEach(o => o.remove());
  state.activeTab = name;
  try { localStorage.setItem(LAST_TAB_KEY, name); } catch (_) { }
  $all(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $all(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === name));
  syncMoreButton(name);
  loadActiveTab(true).catch(e => toast(`Не удалось открыть вкладку: ${e.message}`, "error"));
  document.dispatchEvent(new CustomEvent("project:tab", { detail: name }));
}
$all(".tab-btn").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));

export async function loadActiveTab(force) {
  const name = state.activeTab;
  if (!force && state.loadedTabs.has(name)) return;
  const loader = LOADERS[name];
  if (!loader) return;
  const soft = state.loadedTabs.has(name);
  state.softReload = soft;
  let ok;
  try { ok = await loader(); } finally { state.softReload = false; }
  if (soft) finishEntrance(document.querySelector(`.tab-panel[data-panel="${name}"]`));
  if (ok !== false) state.loadedTabs.add(name);
  else state.loadedTabs.delete(name);
}

function finishEntrance(panel) {
  if (!panel) return;
  for (const a of panel.getAnimations({ subtree: true })) {
    const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : null;
    if (t && t.iterations !== Infinity && a.playState !== "finished" && a.effect.target !== panel) {
      try { a.finish(); } catch (_) { }
    }
  }
}

export function restoreLastTab() {
  refreshTeamNotice();
  refreshLockdown();
  let saved = null;
  try { saved = localStorage.getItem(LAST_TAB_KEY); } catch (_) { }
  const start = startTab();
  if (start !== "last") saved = start;
  if (!saved || !tabAllowed(saved)) saved = "messages";
  if (!saved || !LOADERS[saved]) return;
  state.activeTab = saved;
  $all(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === saved));
  $all(".tab-panel").forEach(p => p.classList.toggle("active", p.dataset.panel === saved));
  syncMoreButton(saved);
}

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
    await refreshPermissions();
    clearDirectoryCache();
    refreshTeamNotice();
    refreshLockdown();
    if (state.isAdmin) await loadUsers();
    await loadActiveTab(true);
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
  } catch (_) { }
}

$("#refresh-btn").addEventListener("click", refreshAll);
