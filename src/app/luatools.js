// LuaTools — полная интеграция.
// Главная, Добавить, Управление, Инструменты, Режим, Фиксы, Плагин, Загрузки, Настройки.

import { invoke, listen } from "./tauri.js";
import { $ } from "./utils.js";
import { toast } from "./api.js";
import {
  ltSearchSteam, ltFeatured, ltCheckSources, ltGameDetails,
  ltIsLoggedIn, ltSession, ltLoginUrl, ltSaveSession, ltClearSession,
  ltManifestDownloadUrl, ltUsage, ltDlcGenerateUrl, ltDenuvoListings, ltDenuvoFixes,
  ltSetApiConfig, ltSetSessionPersist, ltOnSessionChange, ltFetchUser,
} from "./luatools-api.js";
import { setLuatoolsDropHandler } from "./file-drop.js";
import { parseLua, setDepotLocked, setDepotEnabled } from "./luatools-parser.js";

// Ошибки из invoke() приходят строкой, из fetch — Error: показываем оба вида.
const errMsg = e => (e && typeof e === "object" && e.message) ? e.message : String(e ?? "Ошибка");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Minimal markdown → HTML (as Markdig does for fix descriptions): headings, bold, italic, code, links, lists.
function md(src) {
  if (!src) return "";
  let html = esc(src)
    .replace(/^### (.+)$/gm, "<h4>$1</h4>")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/^# (.+)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/(<li>.+<\/li>\n?)+/g, m => "<ul>" + m.replace(/\n/g, "") + "</ul>")
    .replace(/\n\n+/g, "</p><p>")
    .replace(/(<\/h[34]>|<\/ul>)\n/g, "$1")
    .replace(/\n/g, "<br>");
  return "<p>" + html + "</p>";
}
const fmtSize = b => b > 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : (b / 1024).toFixed(1) + " KB";
const fmtDate = ts => ts ? new Date(ts * 1000).toLocaleDateString() : "—";

let loaded = false;
let steamInfo = null;
let installedList = [];
let pluginStatus = null;
let currentPage = "home";
let onboardingDone = false;
let hardwareAppIds = new Set();
let ltConfig = {};
let gameNames = {}; // AppID → Name cache from Steam applist

// ── Download queue (in-memory) ─────────────────────────────────────
const DL_HISTORY_KEY = "lt_dl_history";
const dlQueue = { items: [], history: loadDlHistory() };
let dlIdCounter = 0;
const retryFns = new Map(); // id → () => Promise (только в этой сессии)
const inflight = new Set();  // "appId:source" — защита от двойного клика

function loadDlHistory() {
  try { return JSON.parse(localStorage.getItem(DL_HISTORY_KEY) || "[]").slice(0, 20); } catch { return []; }
}
function saveDlHistory() {
  try {
    const slim = dlQueue.history.slice(0, 20).map(({ id, label, appId, status, error, startTime }) => ({ id, label, appId, status, error, startTime }));
    localStorage.setItem(DL_HISTORY_KEY, JSON.stringify(slim));
  } catch { /* noop */ }
}

function queueAdd(label, appId) {
  const item = { id: ++dlIdCounter, label, appId, status: "pending", progress: 0, error: null, startTime: Date.now() };
  dlQueue.items.push(item);
  return item;
}
function queueDone(item, ok, err) {
  item.status = ok ? "done" : "error";
  item.error = err || null;
  item.progress = 100;
  dlQueue.items = dlQueue.items.filter(i => i.id !== item.id);
  dlQueue.history.unshift(item);
  dlQueue.history.length = Math.min(dlQueue.history.length, 20);
  saveDlHistory();
  if (currentPage === "downloads") renderPage("downloads");
}
function queueStatus(item, status, progress) {
  item.status = status;
  if (progress != null) item.progress = progress;
  if (currentPage === "downloads") renderPage("downloads");
}

// Блокирует кнопку на время операции (двойной клик = двойной invoke).
async function withBusy(btn, fn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try { return await fn(); } finally { if (btn.isConnected) btn.disabled = false; }
}

// ── Game name cache ────────────────────────────────────────────────

let _namesLoading = null;
function gameName(appId) { return gameNames[appId] || String(appId); }

async function loadGameNames() {
  if (Object.keys(gameNames).length) return;
  if (_namesLoading) return _namesLoading;
  _namesLoading = (async () => {
    try {
      const raw = await invoke("lt_applist_mirror");
      const data = JSON.parse(raw);
      const apps = data?.applist?.apps || data?.apps || [];
      for (const a of apps) if (a.appid && a.name) gameNames[a.appid] = a.name;
    } catch { /* cache miss — names stay as AppIDs */ }
    _namesLoading = null;
  })();
  return _namesLoading;
}

// ── Entry ──────────────────────────────────────────────────────────

export function openDetailFromDeepLink(appId, kind) {
  if (kind === "game" || kind === "install") openDetail(appId);
}

export async function loadLuatools() {
  const body = $("#luatools-body");
  if (!body) return;
  if (!loaded) {
    body.innerHTML = shell();
    attachGlobal(body);
    loaded = true;
  }
  await refreshAll(body);
}

function shell() {
  return `<div class="lt-shell">
  <nav class="lt-sidebar">
    <div class="lt-sidebar-top">
      <button class="lt-nav active" data-page="home"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1h-2z"/></svg> Главная</button>
      <button class="lt-nav" data-page="builds"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M14 10l-2 1m0 0l-2-1m2 1v2.5M20 7l-2 1m2-1l-2-1m2 1v2.5M14 4l-2-1-2 1M4 7l2-1M4 7l2 1M4 7v2.5M12 21l-2-1m2 1l2-1m-2 1v-2.5M6 18l-2-1v-2.5M18 18l2-1v-2.5"/></svg> Сборки</button>
      <button class="lt-nav" data-page="add"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"/></svg> Добавить</button>
      <button class="lt-nav" data-page="manage"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg> Управление</button>
      <button class="lt-nav" data-page="tools"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066z"/><circle cx="12" cy="12" r="3"/></svg> Инструменты</button>
      <button class="lt-nav" data-page="mode"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16m-7 6h7"/></svg> Режим</button>
      <button class="lt-nav" data-page="fixes"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Фиксы</button>
      <button class="lt-nav" data-page="plugin"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg> Плагин</button>
    </div>
    <div class="lt-sidebar-bottom">
      <button class="lt-nav lt-nav-action" id="lt-restart-steam"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Перезапуск</button>
      <button class="lt-nav" data-page="downloads"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg> Загрузки</button>
      <button class="lt-nav" data-page="settings"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"/></svg> Настройки</button>
    </div>
    <div class="lt-sidebar-ver" id="lt-sidebar-ver"></div>
  </nav>
  <main class="lt-main"><div class="lt-page-content" id="lt-page-content"></div></main>
</div>`;
}

function attachDropZone(body) {
  const validExt = /\.(lua|manifest|zip)$/i;
  body.addEventListener("dragover", e => {
    if (e.target.closest(".lt-drop-zone")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }
  });
  body.addEventListener("dragenter", e => {
    const zone = e.target.closest(".lt-drop-zone");
    if (zone) zone.classList.add("lt-drop-active");
  });
  body.addEventListener("dragleave", e => {
    const zone = e.target.closest(".lt-drop-zone");
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("lt-drop-active");
  });
  body.addEventListener("drop", async e => {
    const zone = e.target.closest(".lt-drop-zone");
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove("lt-drop-active");

    const text = e.dataTransfer.getData("text/plain");
    if (text) {
      const m = text.match(/(?:store\.steampowered\.com\/app|steamdb\.info\/app)\/(\d+)/);
      if (m) { openDetail(parseInt(m[1], 10)); return; }
    }

    // Файлы сюда не доходят: WebView2 отдаёт drop нативному обработчику Tauri
    // (file-drop.js → installDroppedPaths), у File в вебвью нет пути на диске.
  });

  setLuatoolsDropHandler(async paths => {
    const files = paths.filter(p => validExt.test(p));
    if (!files.length) { toast("Неподдерживаемый формат файла (нужен .lua, .manifest или .zip)", "warn"); return; }
    for (const path of files) {
      const name = path.split(/[\\/]/).pop();
      const appIdMatch = name.match(/^(\d+)[._]/);
      const appId = appIdMatch ? parseInt(appIdMatch[1], 10) : 0;
      try {
        await invoke("lt_install_file", { path, appId, autoUpdate: false });
        toast(`Установлено: ${name}`, "ok");
      } catch (err) { toast(`${name}: ${errMsg(err)}`, "error"); }
    }
    refreshAll(body);
  });
}

function attachGlobal(body) {
  attachDropZone(body);
  listen("lt-download-progress", ev => {
    const { url, percent } = ev.payload || {};
    const active = dlQueue.items.find(i => i._url === url);
    if (active) { active.progress = percent; if (currentPage === "downloads") renderPage("downloads"); }
  });
  body.addEventListener("click", e => {
    const nav = e.target.closest(".lt-nav[data-page]");
    if (nav) { switchPage(nav.dataset.page); return; }
    if (e.target.closest("#lt-restart-steam")) { doRestartSteam(); return; }
    if (e.target.closest("#lt-back-btn")) { switchPage("home"); return; }
    if (e.target.closest("#lt-login-btn")) { doLogin(); return; }
    if (e.target.closest("#lt-logout-btn")) {
      ltClearSession();
      invoke("lt_config_set", { key: "session_enc", value: null }).catch(() => {});
      updateAuthUI();
      return;
    }

    const retry = e.target.closest("[data-dl-retry]");
    if (retry) {
      const fn = retryFns.get(parseInt(retry.dataset.dlRetry, 10));
      if (fn) { retry.disabled = true; fn(); }
      return;
    }

    const dl = e.target.closest("[data-dl-source]");
    if (dl) { doDownload(parseInt(dl.dataset.appid, 10), dl.dataset.dlSource, dl.dataset.gameName || ""); return; }

    const alt = e.target.closest("[data-dl-alt]");
    if (alt) { doAltDownload(parseInt(alt.dataset.appid, 10), alt.dataset.dlAlt, alt.dataset.gameName || ""); return; }

    const rm = e.target.closest("[data-remove-appid]");
    if (rm) { e.stopPropagation(); doRemove(parseInt(rm.dataset.removeAppid, 10)); return; }

    const lockBtn = e.target.closest("[data-lock-depot]");
    if (lockBtn) { doToggleLock(parseInt(lockBtn.dataset.lockAppid, 10), parseInt(lockBtn.dataset.lockDepot, 10), lockBtn.dataset.lockAction === "lock"); return; }

    const enableBtn = e.target.closest("[data-enable-depot]");
    if (enableBtn) { doToggleEnable(parseInt(enableBtn.dataset.enableAppid, 10), parseInt(enableBtn.dataset.enableDepot, 10), enableBtn.dataset.enableAction === "enable"); return; }

    const card = e.target.closest("[data-appid]:not([data-dl-source]):not([data-remove-appid])");
    if (card) openDetail(parseInt(card.dataset.appid, 10));
  });
}

function switchPage(page) {
  currentPage = page;
  const body = $("#luatools-body");
  if (!body) return;
  body.querySelectorAll(".lt-nav[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  renderPage(page);
}

async function renderPage(page) {
  const el = $("#lt-page-content");
  if (!el) return;
  const renderers = { home: renderHome, builds: renderBuilds, add: renderAdd, manage: renderManage, tools: renderTools, mode: renderMode, fixes: renderFixes, plugin: renderPlugin, downloads: renderDownloads, settings: renderSettings };
  const fn = renderers[page];
  if (fn) await fn(el);
}

async function refreshAll(body) {
  try { steamInfo = await invoke("lt_steam_info"); } catch { steamInfo = null; }
  try { pluginStatus = await invoke("lt_plugin_status"); } catch { pluginStatus = null; }
  try { installedList = await invoke("lt_list_installed"); } catch { installedList = []; }
  try { ltConfig = await invoke("lt_config_get") || {}; } catch { ltConfig = {}; }
  if (ltConfig.api_base) ltSetApiConfig({ api_base: ltConfig.api_base, manifest_backend_url: ltConfig.manifest_backend_url });
  await restoreEncryptedSession();
  if (ltConfig.filter_hardware !== false) {
    invoke("lt_hardware_appids").then(ids => { hardwareAppIds = new Set(ids); }).catch(() => {});
  }
  loadGameNames();
  const ver = body.querySelector("#lt-sidebar-ver");
  if (ver) ver.textContent = pluginStatus?.installed ? `v${pluginStatus.version || "?"}` : "";

  try { onboardingDone = !!localStorage.getItem("lt_onboarded"); } catch { onboardingDone = true; }
  if (!onboardingDone && !steamInfo?.path) {
    renderOnboarding($("#lt-page-content"));
    return;
  }
  renderPage(currentPage);
}

function updateAuthUI() {
  for (const el of document.querySelectorAll(".lt-auth-area")) {
    if (ltIsLoggedIn()) {
      const u = ltSession()?.user;
      el.innerHTML = `<span class="lt-user">👤 ${esc(u?.user_metadata?.full_name || u?.email || "logged in")}</span> <button id="lt-logout-btn" class="lt-btn lt-btn-sm">Выйти</button>`;
    } else {
      el.innerHTML = `<button id="lt-login-btn" class="lt-btn lt-btn-primary lt-btn-sm">Войти</button>`;
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// ONBOARDING
// ══════════════════════════════════════════════════════════════════

function renderOnboarding(el) {
  el.innerHTML = `<div class="lt-onboarding">
    <h2>Добро пожаловать в LuaTools</h2>
    <p>Для работы необходим установленный Steam и плагин (BetterSteamTools или stplug-in).</p>
    <div class="lt-onboard-steps">
      <div class="lt-onboard-step ${steamInfo?.path ? 'lt-ok' : 'lt-error'}">
        ${steamInfo?.path ? '✅' : '❌'} Steam ${steamInfo?.path ? 'обнаружен' : 'не найден'}
      </div>
      <div class="lt-onboard-step ${pluginStatus?.installed ? 'lt-ok' : 'lt-warn'}">
        ${pluginStatus?.installed ? '✅' : '⚠'} Плагин ${pluginStatus?.installed ? `(${pluginStatus.mode})` : 'не установлен'}
      </div>
    </div>
    ${!pluginStatus?.installed ? '<p>Перейдите в раздел <strong>Режим</strong> чтобы установить плагин автоматически.</p>' : ''}
    <div style="margin-top:20px;display:flex;gap:8px">
      ${!pluginStatus?.installed ? '<button class="lt-btn lt-btn-primary" data-page="mode">Установить плагин</button>' : ''}
      <button class="lt-btn" id="lt-onboard-skip">Продолжить</button>
    </div>
  </div>`;
  el.querySelector("#lt-onboard-skip")?.addEventListener("click", () => {
    try { localStorage.setItem("lt_onboarded", "1"); } catch {}
    onboardingDone = true;
    switchPage("home");
  });
}

// ══════════════════════════════════════════════════════════════════
// BUILDS
// ══════════════════════════════════════════════════════════════════

const BUILDS_PER_PAGE = 24;

async function renderBuilds(el) {
  el.innerHTML = '<div class="lt-skeleton-row"><span class="lt-skeleton lt-skeleton-h24 lt-skeleton-w40"></span><span class="lt-skeleton lt-skeleton-card"></span><span class="lt-skeleton lt-skeleton-card"></span></div>';
  try { installedList = await invoke("lt_list_installed"); } catch { installedList = []; }
  await loadGameNames();

  if (!installedList.length) {
    el.innerHTML = '<h2 class="lt-page-title">Сборки</h2><div class="lt-empty">Нет установленных lua-файлов. Добавьте игру через «Добавить».</div>';
    return;
  }

  let filter = "";
  let page = 0;

  const render = () => {
    const q = filter.toLowerCase();
    const filtered = q
      ? installedList.filter(i => String(i.app_id).includes(q) || gameName(i.app_id).toLowerCase().includes(q))
      : installedList;
    const totalPages = Math.max(1, Math.ceil(filtered.length / BUILDS_PER_PAGE));
    if (page >= totalPages) page = totalPages - 1;
    const slice = filtered.slice(page * BUILDS_PER_PAGE, (page + 1) * BUILDS_PER_PAGE);

    el.innerHTML = `<div class="lt-builds-header">
        <h2 class="lt-page-title">Сборки</h2>
        <div class="lt-builds-bar">
          <input type="text" class="lt-input" id="lt-builds-search" placeholder="Поиск по названию или AppID…" value="${esc(filter)}">
          <span class="lt-muted">${filtered.length} игр</span>
        </div>
      </div>
      <div class="lt-builds-grid" id="lt-builds-grid">
        ${slice.map(i => `<div class="lt-build-tile" data-appid="${i.app_id}">
          <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${i.app_id}/header.jpg" alt="" loading="lazy" onerror="this.onerror=null;this.src='https://cdn.cloudflare.steamstatic.com/steam/apps/${i.app_id}/capsule_sm_120.jpg'">
          <div class="lt-build-info">
            <span class="lt-build-name">${esc(gameName(i.app_id))}</span>
            <span class="lt-build-meta">${i.app_id} · ${fmtDate(i.modified)}</span>
          </div>
        </div>`).join("")}
      </div>
      ${totalPages > 1 ? `<div class="lt-builds-pager">
        <button class="lt-btn lt-btn-sm" id="lt-builds-prev" ${page === 0 ? "disabled" : ""}>← Назад</button>
        <span class="lt-muted">${page + 1} / ${totalPages}</span>
        <button class="lt-btn lt-btn-sm" id="lt-builds-next" ${page >= totalPages - 1 ? "disabled" : ""}>Далее →</button>
      </div>` : ""}`;

    el.querySelector("#lt-builds-search")?.addEventListener("input", e => { filter = e.target.value.trim(); page = 0; render(); });
    el.querySelector("#lt-builds-prev")?.addEventListener("click", () => { page--; render(); });
    el.querySelector("#lt-builds-next")?.addEventListener("click", () => { page++; render(); });
  };
  render();
}

// ══════════════════════════════════════════════════════════════════
// HOME
// ══════════════════════════════════════════════════════════════════

async function renderHome(el) {
  el.innerHTML = `
    <h2 class="lt-page-title">Добро пожаловать в LuaTools</h2>
    <div class="lt-home-stats">
      <div class="lt-stat-card"><span class="lt-stat-num">${installedList.length}</span><span class="lt-stat-label">Lua на борту</span></div>
      <div class="lt-stat-card"><span class="lt-stat-label">Статус плагина</span><span class="${pluginStatus?.installed ? 'lt-ok' : 'lt-error'}">${pluginStatus?.installed ? 'Установлено' : 'Не установлен'}${pluginStatus?.version ? ` · v${esc(pluginStatus.version)}` : ''}</span></div>
    </div>
    <div class="lt-home-info">
      <div class="lt-info-row">${steamInfo?.path ? `<span class="lt-ok">✅ Steam обнаружен · ${esc(steamInfo.path)}</span>` : '<span class="lt-error">❌ Steam не найден</span>'}</div>
      <div class="lt-info-row lt-auth-area"></div>
      ${pluginStatus?.mode ? `<div class="lt-info-row">⚙ Режим · ${esc(pluginStatus.mode)}</div>` : ''}
      ${steamInfo?.running ? '<div class="lt-info-row"><span class="lt-warn">⚠ Steam запущен</span></div>' : ''}
    </div>
    <div class="lt-drop-zone" id="lt-drop-home">
      <div class="lt-drop-inner"><span class="lt-drop-icon">📥</span><div>Перетащите сюда файлы .lua, .manifest или .zip</div>
      <div class="lt-muted">…или ссылку SteamDB / магазина Steam</div></div>
    </div>
    <section class="lt-section"><h3>Недавно добавленные</h3><div class="lt-grid" id="lt-recent-grid"></div></section>
    <section class="lt-section"><h3>Популярное</h3><div class="lt-grid lt-grid-featured" id="lt-featured-grid"><div class="lt-loading">Загружаю…</div></div></section>`;
  updateAuthUI();
  renderRecentCards();
  loadFeaturedStrip();
}

function renderRecentCards() {
  const grid = $("#lt-recent-grid");
  if (!grid) return;
  if (!installedList.length) { grid.innerHTML = '<div class="lt-empty">Пока ничего не установлено</div>'; return; }
  grid.innerHTML = installedList.slice(0, 8).map(i => `
    <button class="lt-card" data-appid="${i.app_id}">
      <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${i.app_id}/header.jpg" alt="" loading="lazy">
      <div class="lt-card-info"><span class="lt-card-name">${esc(gameName(i.app_id))}</span><span class="lt-card-date">${i.app_id} · ${fmtDate(i.modified)}</span></div>
    </button>`).join("");
}

async function loadFeaturedStrip() {
  const grid = $("#lt-featured-grid");
  if (!grid) return;
  try {
    const { topSellers } = await ltFeatured();
    if (!topSellers.length) { grid.innerHTML = '<div class="lt-empty">—</div>'; return; }
    grid.innerHTML = topSellers.slice(0, 8).map(i => `
      <button class="lt-card lt-card-featured" data-appid="${i.appId}">
        <img src="${esc(i.image)}" alt="" loading="lazy">
        <div class="lt-card-info"><span class="lt-card-name">${esc(i.name)}</span>${i.discount ? `<span class="lt-discount">-${i.discount}%</span>` : ""}</div>
      </button>`).join("");
  } catch { grid.innerHTML = ''; }
}

// ══════════════════════════════════════════════════════════════════
// ADD
// ══════════════════════════════════════════════════════════════════

function renderAdd(el) {
  el.innerHTML = `
    <h2 class="lt-page-title">Добавить</h2>
    <div class="lt-search-bar"><input type="text" id="lt-search" class="lt-input" placeholder="Поиск по названию или AppID…"><button id="lt-search-btn" class="lt-btn lt-btn-primary">Найти</button></div>
    <div id="lt-results" class="lt-results"></div>
    <div id="lt-detail" class="lt-detail" hidden></div>
    <div class="lt-drop-zone" style="margin-top:20px"><div class="lt-drop-inner"><span class="lt-drop-icon">📥</span><div>Перетащите файлы .lua, .manifest или .zip</div></div></div>`;
  const input = el.querySelector("#lt-search"), btn = el.querySelector("#lt-search-btn");
  const doSearch = async () => {
    const q = input.value.trim(); if (!q) return;
    const r = el.querySelector("#lt-results");
    r.innerHTML = '<div class="lt-loading">Ищу…</div>';
    try {
      let items = /^\d+$/.test(q) ? [await ltGameDetails(q)].filter(Boolean).map(d => ({ appId: parseInt(q), name: d.name, icon: d.header_image })) : await ltSearchSteam(q);
      if (ltConfig.filter_hardware !== false && hardwareAppIds.size) items = items.filter(i => !hardwareAppIds.has(i.appId));
      if (!items.length) { r.innerHTML = '<div class="lt-empty">Ничего не нашлось</div>'; return; }
      r.innerHTML = items.map(i => `<button class="lt-card lt-card-search" data-appid="${i.appId}"><img src="${esc(i.icon)}" alt="" loading="lazy"><div class="lt-card-info"><span class="lt-card-name">${esc(i.name)}</span><span class="lt-card-id">${i.appId}</span></div></button>`).join("");
    } catch (e) { r.innerHTML = `<div class="lt-error">${esc(errMsg(e))}</div>`; }
  };
  btn.addEventListener("click", doSearch);
  input.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
}

// ══════════════════════════════════════════════════════════════════
// MANAGE
// ══════════════════════════════════════════════════════════════════

async function renderManage(el) {
  el.innerHTML = '<div class="lt-loading">Загружаю…</div>';
  try { installedList = await invoke("lt_list_installed"); } catch { installedList = []; }
  if (!installedList.length) { el.innerHTML = '<h2 class="lt-page-title">Управление</h2><div class="lt-empty">Нет установленных lua-файлов</div>'; return; }

  el.innerHTML = `<h2 class="lt-page-title">Управление</h2>
    <div class="lt-search-bar"><input type="text" id="lt-manage-search" class="lt-input" placeholder="Фильтр по названию или AppID…"></div>
    <p class="lt-muted">${installedList.length} файлов</p>
    <div class="lt-manage-list" id="lt-manage-list"></div>`;

  const renderList = (filter) => {
    const q = (filter || "").toLowerCase();
    const list = q ? installedList.filter(i => String(i.app_id).includes(q) || gameName(i.app_id).toLowerCase().includes(q)) : installedList;
    const c = el.querySelector("#lt-manage-list");
    c.innerHTML = list.map(i => `
      <div class="lt-manage-item" data-appid="${i.app_id}">
        <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${i.app_id}/capsule_sm_120.jpg" alt="" loading="lazy">
        <div class="lt-manage-info"><span class="lt-card-name">${esc(gameName(i.app_id))}</span><span class="lt-card-sub">${i.app_id} · ${fmtDate(i.modified)}</span></div>
        <div class="lt-manage-actions">
          <button class="lt-btn lt-btn-sm" data-appid="${i.app_id}">Депо</button>
          <button class="lt-btn lt-btn-danger lt-btn-sm" data-remove-appid="${i.app_id}">✕</button>
        </div>
      </div>`).join("");
  };
  renderList();
  el.querySelector("#lt-manage-search").addEventListener("input", e => renderList(e.target.value.trim()));
}

// ══════════════════════════════════════════════════════════════════
// TOOLS
// ══════════════════════════════════════════════════════════════════

async function renderTools(el) {
  el.innerHTML = `<h2 class="lt-page-title">Инструменты</h2>
    <div class="lt-tools-grid">
      <div class="lt-tool-card"><h3>🎮 DLC Генератор</h3><p class="lt-muted">Генерация DLC-записей</p>
        <div class="lt-tool-form"><input type="text" class="lt-input" id="lt-dlc-appid" placeholder="AppID"><button class="lt-btn lt-btn-primary" id="lt-dlc-gen">Сгенерировать</button></div>
        <div id="lt-dlc-result"></div>
      </div>
      <div class="lt-tool-card"><h3>📊 Лимиты API</h3><p class="lt-muted">Использование за сегодня</p><div id="lt-usage-info" class="lt-loading">Загружаю…</div></div>
      <div class="lt-tool-card"><h3>📦 Варианты / Пресеты</h3><p class="lt-muted">Сохранённые lua-конфигурации</p>
        <div class="lt-tool-form"><input type="text" class="lt-input" id="lt-var-appid" placeholder="AppID"><button class="lt-btn" id="lt-var-list">Показать</button></div>
        <div id="lt-var-result"></div>
      </div>
      <div class="lt-tool-card"><h3>⬇ DepotDownloaderMod</h3><p class="lt-muted">Прямая скачка депо без Steam</p>
        <div id="lt-ddm-info" class="lt-loading">Проверяю…</div>
        <div class="lt-tool-form" style="margin-top:8px">
          <input type="text" class="lt-input" id="lt-ddm-appid" placeholder="AppID"><input type="text" class="lt-input" id="lt-ddm-depot" placeholder="DepotID">
        </div>
        <div class="lt-tool-form"><button class="lt-btn" id="lt-ddm-install">Установить/Обновить</button><button class="lt-btn lt-btn-primary" id="lt-ddm-run">Скачать</button></div>
        <pre id="lt-ddm-out" class="lt-muted" style="font-size:.75rem;max-height:200px;overflow:auto;margin-top:8px"></pre>
      </div>
      <div class="lt-tool-card"><h3>🔑 Hubcap</h3><p class="lt-muted">Альтернативный источник манифестов</p>
        <div class="lt-tool-form"><input type="text" class="lt-input" id="lt-hubcap-key" placeholder="API-ключ"><button class="lt-btn" id="lt-hubcap-save">Сохранить</button></div>
        <div id="lt-hubcap-status"></div>
      </div>
      <div class="lt-tool-card"><h3>🌐 DNS-over-HTTPS</h3><p class="lt-muted">Обход блокировок через 1.1.1.1</p>
        <div class="lt-tool-form"><input type="text" class="lt-input" id="lt-doh-host" value="lua.tools"><button class="lt-btn" id="lt-doh-resolve">Resolve</button></div>
        <div id="lt-doh-result"></div>
      </div>
      <div class="lt-tool-card"><h3>🔓 Steamless</h3><p class="lt-muted">Снятие SteamStub DRM с exe</p>
        <div id="lt-steamless-status" class="lt-loading">Проверяю…</div>
        <div class="lt-tool-form" style="margin-top:8px">
          <input type="text" class="lt-input" id="lt-steamless-exe" placeholder="Путь к .exe игры">
        </div>
        <div class="lt-tool-form">
          <button class="lt-btn" id="lt-steamless-install-btn">Установить / Обновить</button>
          <button class="lt-btn lt-btn-primary" id="lt-steamless-run-btn">Снять DRM</button>
        </div>
        <pre id="lt-steamless-out" class="lt-muted" style="font-size:.75rem;max-height:200px;overflow:auto;margin-top:8px"></pre>
      </div>
    </div>`;

  el.querySelector("#lt-dlc-gen").addEventListener("click", async () => {
    const appId = el.querySelector("#lt-dlc-appid").value.trim();
    const aid = parseInt(appId, 10);
    const r = el.querySelector("#lt-dlc-result");
    if (!/^\d+$/.test(appId) || !aid) { r.innerHTML = '<span class="lt-warn">Введите числовой AppID</span>'; return; }
    if (!ltIsLoggedIn()) { r.innerHTML = '<span class="lt-warn">Войдите в lua.tools</span>'; return; }
    r.innerHTML = '<div class="lt-loading">Генерирую…</div>';
    try {
      const url = ltDlcGenerateUrl(appId, appId, "");
      const filePath = await invoke("lt_download", { url, token: ltSession()?.access_token, destDir: await getTmpDir() });
      await invoke("lt_install_file", { path: filePath, appId: aid, autoUpdate: false });
      r.innerHTML = '<span class="lt-ok">✅ DLC установлены</span>';
    } catch (e) { r.innerHTML = `<span class="lt-error">${esc(errMsg(e))}</span>`; }
  });

  el.querySelector("#lt-var-list").addEventListener("click", async () => {
    const rawId = el.querySelector("#lt-var-appid").value.trim(); if (!rawId) return;
    const aid = parseInt(rawId, 10); if (!Number.isFinite(aid)) return;
    const r = el.querySelector("#lt-var-result");
    try {
      const variants = await invoke("lt_list_variants", { appId: aid });
      if (!variants.length) { r.innerHTML = '<div class="lt-empty">Нет сохранённых вариантов</div>'; return; }
      r.replaceChildren();
      for (const v of variants) {
        const row = document.createElement("div");
        row.className = "lt-var-row";
        row.innerHTML = `<span><strong></strong> · ${v.depot_count} депо, ${v.dlc_count} DLC${v.is_pinned ? ' 📌' : ''}</span><span class="lt-muted"></span><button class="lt-btn lt-btn-sm lt-var-load">Загрузить</button><button class="lt-btn lt-btn-sm lt-btn-danger lt-var-del">✕</button>`;
        row.querySelector("strong").textContent = v.name;
        row.querySelector(".lt-muted").textContent = v.hash;
        row.querySelector(".lt-var-load").addEventListener("click", e => withBusy(e.currentTarget, async () => {
          try { await invoke("lt_load_variant", { appId: aid, name: v.name }); toast(`Вариант «${v.name}» загружен`, "ok"); }
          catch (err) { toast(errMsg(err), "error"); }
        }));
        row.querySelector(".lt-var-del").addEventListener("click", e => withBusy(e.currentTarget, async () => {
          if (!await confirmAction(`Удалить вариант «${v.name}»?`)) return;
          try { await invoke("lt_delete_variant", { appId: aid, name: v.name }); toast("Удалён", "ok"); el.querySelector("#lt-var-list").click(); }
          catch (err) { toast(errMsg(err), "error"); }
        }));
        r.appendChild(row);
      }
    } catch (e) { r.innerHTML = `<span class="lt-error">${esc(errMsg(e))}</span>`; }
  });

  if (ltIsLoggedIn()) {
    const usage = await ltUsage();
    const u = el.querySelector("#lt-usage-info");
    if (usage) { u.innerHTML = `<div class="lt-usage-bar"><div class="lt-usage-fill" style="width:${Math.min(100, usage.used / usage.limit * 100)}%"></div></div><span>${usage.used} / ${usage.limit}</span>`; }
    else { u.innerHTML = '<span class="lt-muted">Нет данных</span>'; }
  } else { el.querySelector("#lt-usage-info").innerHTML = '<span class="lt-warn">Войдите</span>'; }

  // DepotDownloaderMod
  invoke("lt_depot_downloader_info").then(info => {
    const e = el.querySelector("#lt-ddm-info"); if (!e) return;
    e.innerHTML = info.installed ? `<span class="lt-ok">Установлен</span> · <span class="lt-muted">${esc(info.exe_path || '')}</span>` : '<span class="lt-warn">Не установлен</span>';
    if (info.latest_tag) e.innerHTML += ` · Последняя: <strong>${esc(info.latest_tag)}</strong>`;
  }).catch(e => { const r = el.querySelector("#lt-ddm-info"); if (r) r.innerHTML = `<span class="lt-error">${esc(errMsg(e))}</span>`; });
  el.querySelector("#lt-ddm-install")?.addEventListener("click", async () => {
    try { toast("Скачиваю DepotDownloaderMod…", "info"); const path = await invoke("lt_depot_downloader_install"); toast("Установлено: " + path, "ok"); renderTools(el); }
    catch (e) { toast(errMsg(e), "error"); }
  });
  el.querySelector("#lt-ddm-run")?.addEventListener("click", async () => {
    const appId = el.querySelector("#lt-ddm-appid").value.trim();
    const depot = el.querySelector("#lt-ddm-depot").value.trim();
    if (!/^\d+$/.test(appId) || !/^\d+$/.test(depot)) { toast("Укажите числовые AppID и DepotID", "warn"); return; }
    const out = el.querySelector("#lt-ddm-out"); out.textContent = "Скачиваю… (может занять долго)";
    await withBusy(el.querySelector("#lt-ddm-run"), async () => {
      try {
        out.textContent = await invoke("lt_depot_downloader_run", { appId: Number(appId), depotId: Number(depot) });
      } catch (e) { out.textContent = errMsg(e); }
    });
  });

  // Hubcap
  invoke("lt_config_get").then(cfg => {
    const existing = cfg?.hubcap_key; if (existing) el.querySelector("#lt-hubcap-key").value = existing;
  }).catch(() => {});
  el.querySelector("#lt-hubcap-save")?.addEventListener("click", e => withBusy(e.currentTarget, async () => {
    const key = el.querySelector("#lt-hubcap-key").value.trim();
    const s = el.querySelector("#lt-hubcap-status"); s.innerHTML = '<div class="lt-loading">Проверяю ключ…</div>';
    try {
      const res = await invoke("lt_hubcap_validate", { apiKey: key });
      await invoke("lt_config_set", { key: "hubcap_key", value: key });
      ltConfig.hubcap_key = key;
      // Формат /user/stats не документирован — показываем то, что узнаём.
      const used = res?.daily_usage ?? res?.usage ?? res?.used;
      const limit = res?.daily_limit ?? res?.limit;
      const exp = res?.expires_at ?? res?.expiry ?? res?.expires;
      const extra = [
        used != null && limit ? `сегодня ${esc(used)} / ${esc(limit)}` : "",
        exp ? `до ${esc(exp)}` : "",
      ].filter(Boolean).join(" · ");
      s.innerHTML = `<span class="lt-ok">✅ Ключ принят${extra ? ` · ${extra}` : ""}</span>`;
    } catch (err) { s.innerHTML = `<span class="lt-error">${esc(errMsg(err))}</span>`; }
  }));

  // DoH
  el.querySelector("#lt-doh-resolve")?.addEventListener("click", async () => {
    const host = el.querySelector("#lt-doh-host").value.trim(); if (!host) return;
    const r = el.querySelector("#lt-doh-result"); r.innerHTML = '<div class="lt-loading">…</div>';
    try { const ips = await invoke("lt_doh_resolve", { host }); r.innerHTML = ips.length ? ips.map(ip => `<code>${esc(ip)}</code>`).join(" ") : '<span class="lt-muted">Нет ответа</span>'; }
    catch (e) { r.innerHTML = `<span class="lt-error">${esc(errMsg(e))}</span>`; }
  });

  // Steamless
  invoke("lt_steamless_info").then(info => {
    const s = el.querySelector("#lt-steamless-status");
    if (s) s.innerHTML = info.installed ? `<span class="lt-ok">Установлено${info.version ? ` · ${esc(info.version)}` : ''}</span>` : '<span class="lt-muted">Не установлено</span>';
  }).catch(() => { const s = el.querySelector("#lt-steamless-status"); if (s) s.textContent = "—"; });

  el.querySelector("#lt-steamless-install-btn")?.addEventListener("click", async () => {
    const s = el.querySelector("#lt-steamless-status"); s.innerHTML = '<div class="lt-loading">Скачиваю…</div>';
    try { const v = await invoke("lt_steamless_install"); s.innerHTML = `<span class="lt-ok">Установлено · ${esc(v)}</span>`; toast("Steamless установлен", "ok"); }
    catch (e) { s.innerHTML = `<span class="lt-error">${esc(errMsg(e))}</span>`; }
  });

  el.querySelector("#lt-steamless-run-btn")?.addEventListener("click", async () => {
    const exe = el.querySelector("#lt-steamless-exe").value.trim();
    if (!exe) { toast("Укажите путь к exe", "warn"); return; }
    const out = el.querySelector("#lt-steamless-out"); out.textContent = "Обрабатываю…";
    try { const r = await invoke("lt_steamless_run", { exePath: exe }); out.textContent = r; toast("DRM снят", "ok"); }
    catch (e) { out.textContent = String(e); toast("Ошибка Steamless", "error"); }
  });
}

// ══════════════════════════════════════════════════════════════════
// MODE
// ══════════════════════════════════════════════════════════════════

async function renderMode(el) {
  const current = pluginStatus?.mode || null;
  el.innerHTML = `<h2 class="lt-page-title">Режим</h2>
    ${current ? `<div class="lt-mode-current">Текущий: <strong class="lt-ok">${esc(current)}</strong></div>` : '<div class="lt-mode-current"><span class="lt-error">Плагин не установлен</span></div>'}
    <div class="lt-mode-list" id="lt-mode-list">
      <div class="lt-mode-option ${current === 'BetterSteamTools' ? 'lt-mode-active' : ''}">
        <div class="lt-mode-head"><h3>BetterSteamTools</h3><span class="lt-badge lt-badge-ok">Рекомендуется</span></div>
        <p class="lt-muted">Наш форк OpenSteamTools. Автозагрузка манифестов, DLC, DLL-инъекция, Family Sharing, CloudRedirect.</p>
        <div class="lt-mode-ver" id="lt-bst-ver"><span class="lt-loading">Проверяю…</span></div>
        <button class="lt-btn lt-btn-primary" id="lt-install-bst">${current === 'BetterSteamTools' ? 'Переустановить' : 'Установить'}</button>
      </div>
      <div class="lt-mode-option ${current === 'stplug-in' ? 'lt-mode-active' : ''}">
        <div class="lt-mode-head"><h3>OpenSteamTool (Nightly)</h3><span class="lt-badge lt-badge-warn">Экспериментальный</span></div>
        <p class="lt-muted">Nightly-билды upstream OpenSteamTool. Может быть нестабильным.</p>
        <div class="lt-mode-ver" id="lt-ost-ver"><span class="lt-loading">Проверяю…</span></div>
        <button class="lt-btn" id="lt-install-ost">${current === 'stplug-in' ? 'Переустановить' : 'Установить'}</button>
      </div>
      <div class="lt-mode-option">
        <div class="lt-mode-head"><h3>LTSP</h3><span class="lt-badge lt-badge-warn">Альтернатива</span></div>
        <p class="lt-muted">Третий анлокер (madoiscool/LTSP). Используйте, если BST/OST не работают.</p>
        <div class="lt-mode-ver" id="lt-ltsp-ver"><span class="lt-loading">Проверяю…</span></div>
        <button class="lt-btn" id="lt-install-ltsp">Установить</button>
      </div>
      <div class="lt-mode-option">
        <h3>Удалить</h3>
        <p class="lt-muted">Полностью удалить плагин (по манифесту установки).</p>
        <button class="lt-btn lt-btn-danger" id="lt-mode-uninstall">Удалить плагин</button>
      </div>
    </div>
    <div class="lt-section" id="lt-cr-section"></div>`;

  const installHandler = (btnId, mode) => {
    el.querySelector(btnId)?.addEventListener("click", async () => {
      if (!await confirmAction("Установка перезапустит Steam. Продолжить?")) return;
      const btn = el.querySelector(btnId);
      btn.disabled = true; btn.textContent = "Устанавливаю…";
      try {
        const msg = await invoke("lt_install_mode", { mode });
        toast(msg, "ok");
        pluginStatus = await invoke("lt_plugin_status");
        renderMode(el);
      } catch (e) { toast(errMsg(e), "error"); btn.disabled = false; btn.textContent = "Повторить"; }
    });
  };
  installHandler("#lt-install-bst", "bst");
  installHandler("#lt-install-ost", "ost");
  installHandler("#lt-install-ltsp", "ltsp");
  el.querySelector("#lt-mode-uninstall")?.addEventListener("click", async () => {
    if (!await confirmAction("Удалить плагин? Steam будет перезапущен, DLL плагина удалены.")) return;
    try { await invoke("lt_uninstall_mode"); pluginStatus = await invoke("lt_plugin_status"); toast("Удалено", "ok"); renderMode(el); }
    catch (e) { toast(errMsg(e), "error"); }
  });

  // Check versions
  invoke("lt_check_mode_update", { mode: "bst" }).then(v => {
    const e = el.querySelector("#lt-bst-ver");
    if (e && v.latest_tag) e.innerHTML = `Последняя: <strong>${esc(v.latest_tag)}</strong>`;
  }).catch(() => {});
  invoke("lt_check_mode_update", { mode: "ost" }).then(v => {
    const e = el.querySelector("#lt-ost-ver");
    if (e && v.latest_tag) e.innerHTML = `Последняя: <strong>${esc(v.latest_tag)}</strong>`;
  }).catch(() => {});
  invoke("lt_check_mode_update", { mode: "ltsp" }).then(v => {
    const e = el.querySelector("#lt-ltsp-ver");
    if (e && v.latest_tag) e.innerHTML = `Последняя: <strong>${esc(v.latest_tag)}</strong>`;
  }).catch(() => {});

  // CloudRedirect
  try {
    const cr = await invoke("lt_cloud_redirect_state");
    const s = el.querySelector("#lt-cr-section");
    if (cr.supported) {
      s.innerHTML = `<h3>☁ CloudRedirect</h3>
        <p class="lt-muted">Steam Cloud revival — работает с BST и OST.</p>
        <div class="lt-info-row">Статус: ${cr.enabled ? '<span class="lt-ok">Включён</span>' : '<span class="lt-muted">Выключен</span>'} ${cr.installed ? '' : '<span class="lt-warn">(DLL не найдена)</span>'}</div>
        <button class="lt-btn ${cr.enabled ? 'lt-btn-danger' : 'lt-btn-primary'}" id="lt-cr-toggle">${cr.enabled ? 'Выключить' : 'Включить'}</button>`;
      el.querySelector("#lt-cr-toggle")?.addEventListener("click", e => withBusy(e.currentTarget, async () => {
        try {
          await invoke("lt_cloud_redirect_toggle", { enable: !cr.enabled });
          toast(cr.enabled ? "CloudRedirect выключен" : "CloudRedirect включён", "ok");
          renderMode(el);
        } catch (err) { toast(errMsg(err), "error"); }
      }));
    }
  } catch {}
}

// ══════════════════════════════════════════════════════════════════
// FIXES
// ══════════════════════════════════════════════════════════════════

let fixesCache = null;
let fixSelectedTag = null;
let fixMyGamesOnly = false;
let fixSearchText = "";
let fixPage = 0;
const FIX_PAGE_SIZE = 12;

async function renderFixes(el) {
  el.innerHTML = `<h2 class="lt-page-title">Фиксы</h2>
    <div class="lt-search-bar">
      <input type="text" id="lt-fix-search" class="lt-input" placeholder="Поиск…" value="${esc(fixSearchText)}">
      <label class="lt-btn lt-btn-sm"><input type="checkbox" id="lt-fix-mygames" ${fixMyGamesOnly ? 'checked' : ''}> Мои игры</label>
    </div>
    <div class="lt-fix-tags" id="lt-fix-tags"></div>
    <div id="lt-fixes-list" class="lt-loading">Загружаю…</div>
    <div class="lt-pagination" id="lt-fix-pages"></div>`;

  if (!fixesCache) {
    try { fixesCache = await ltDenuvoListings(); } catch { fixesCache = []; }
  }

  const renderFixGrid = () => {
    let items = fixesCache || [];
    if (fixSearchText) items = items.filter(g => (g.name || g.game || "").toLowerCase().includes(fixSearchText.toLowerCase()) || String(g.appid || g.appId || "").includes(fixSearchText));
    if (fixMyGamesOnly) {
      const ids = new Set(installedList.map(i => i.app_id));
      items = items.filter(g => ids.has(g.appid || g.appId));
    }
    if (fixSelectedTag) items = items.filter(g => (g.tags || []).some(t => (t.id || t) === fixSelectedTag));

    const total = items.length;
    const pages = Math.ceil(total / FIX_PAGE_SIZE);
    if (fixPage >= pages) fixPage = Math.max(0, pages - 1);
    const slice = items.slice(fixPage * FIX_PAGE_SIZE, (fixPage + 1) * FIX_PAGE_SIZE);

    const c = el.querySelector("#lt-fixes-list");
    if (!slice.length) { c.innerHTML = '<div class="lt-empty">Нет фиксов</div>'; }
    else {
      c.innerHTML = `<div class="lt-grid">${slice.map(g => {
        const aid = g.appid || g.appId || 0;
        return `<button class="lt-card lt-fix-card" data-fixappid="${aid}">
          <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${aid}/capsule_sm_120.jpg" alt="" loading="lazy">
          <div class="lt-card-info"><span class="lt-card-name">${esc(g.name || g.game || `App ${aid}`)}</span>
          <span class="lt-card-id">${aid} · ${g.fixCount || g.fix_count || '?'} фиксов</span></div>
        </button>`;
      }).join("")}</div>`;
      c.querySelectorAll("[data-fixappid]").forEach(b => b.addEventListener("click", () => openFixDetail(parseInt(b.dataset.fixappid, 10))));
    }

    const pEl = el.querySelector("#lt-fix-pages");
    if (pages > 1) {
      pEl.innerHTML = Array.from({ length: pages }, (_, i) => `<button class="lt-btn lt-btn-sm ${i === fixPage ? 'lt-btn-primary' : ''}" data-fpage="${i}">${i + 1}</button>`).join(" ");
      pEl.querySelectorAll("[data-fpage]").forEach(b => b.addEventListener("click", () => { fixPage = parseInt(b.dataset.fpage); renderFixGrid(); }));
    } else { pEl.innerHTML = ""; }
  };

  // Tags
  const allTags = new Map();
  (fixesCache || []).forEach(g => (g.tags || []).forEach(t => { const id = t.id || t; const nm = t.name || t; allTags.set(id, nm); }));
  const tagEl = el.querySelector("#lt-fix-tags");
  tagEl.innerHTML = `<button class="lt-tag ${!fixSelectedTag ? 'lt-tag-active' : ''}" data-tagid="">Все</button>` +
    [...allTags.entries()].map(([id, nm]) => `<button class="lt-tag ${fixSelectedTag === id ? 'lt-tag-active' : ''}" data-tagid="${esc(id)}">${esc(nm)}</button>`).join("");
  tagEl.querySelectorAll("[data-tagid]").forEach(b => b.addEventListener("click", () => { fixSelectedTag = b.dataset.tagid || null; fixPage = 0; renderFixGrid(); tagEl.querySelectorAll(".lt-tag").forEach(t => t.classList.toggle("lt-tag-active", (t.dataset.tagid || null) === fixSelectedTag)); }));

  el.querySelector("#lt-fix-search").addEventListener("input", e => { fixSearchText = e.target.value; fixPage = 0; renderFixGrid(); });
  el.querySelector("#lt-fix-mygames").addEventListener("change", e => { fixMyGamesOnly = e.target.checked; fixPage = 0; renderFixGrid(); });

  renderFixGrid();
}

async function openFixDetail(appId) {
  const el = $("#lt-page-content");
  el.innerHTML = '<div class="lt-loading">Загружаю фиксы…</div>';
  try {
    const fixes = await ltDenuvoFixes(String(appId));
    const hasBackup = await invoke("lt_has_fix_backup", { appId });
    const gameInfo = await invoke("lt_game_install_path", { appId });
    const game = fixesCache?.find(g => Number(g.appid || g.appId) === appId);
    const name = game?.name || game?.game || `App ${appId}`;

    el.innerHTML = `<button class="lt-btn lt-btn-sm" id="lt-back-fix">← Назад к фиксам</button>
      <div class="lt-detail" style="margin-top:12px">
        <div class="lt-detail-header">
          <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg" class="lt-detail-img" alt="">
          <div class="lt-detail-meta">
            <h3>${esc(name)}</h3><span class="lt-card-id">AppID: ${appId}</span>
            <div style="margin-top:8px">${gameInfo.installed ? `<span class="lt-ok">Установлена: ${esc(gameInfo.path)}</span>` : '<span class="lt-warn">Игра не установлена на диск</span>'}</div>
            ${hasBackup ? '<div style="margin-top:6px"><span class="lt-warn">⚠ Есть применённый фикс</span> <button class="lt-btn lt-btn-sm lt-btn-danger" id="lt-revert-fix">Откатить</button></div>' : ''}
          </div>
        </div>
        <h4 style="margin-top:16px">Доступные фиксы (${fixes?.length || 0})</h4>
        <div class="lt-fix-list" id="lt-fix-items">${!fixes?.length ? '<div class="lt-empty">Нет фиксов</div>' : fixes.map(f => `
          <div class="lt-fix-item">
            <div class="lt-fix-item-head"><strong>${esc(f.title || f.name || 'Fix')}</strong><span class="lt-muted">${esc(f.created_at ? new Date(f.created_at).toLocaleDateString() : '')}</span></div>
            ${f.description ? `<div class="lt-md lt-muted">${md(f.description)}</div>` : ''}
            <div class="lt-fix-item-tags">${(f.tags || []).map(t => `<span class="lt-tag lt-tag-sm">${esc(t.name || t)}</span>`).join("")}</div>
            <div class="lt-fix-item-actions">
              ${f.has_manifest || f.manifest_filename ? `<button class="lt-btn lt-btn-sm lt-btn-primary" data-fix-manifest="${esc(f.id || '')}" data-fix-appid="${appId}">📥 Манифест</button>` : ''}
              ${(f.has_fix || f.fix_filename) && gameInfo.installed ? `<button class="lt-btn lt-btn-sm" data-fix-apply="${esc(f.id || '')}" data-fix-appid="${appId}">🔧 Применить фикс</button>` : ''}
              ${(f.has_fix || f.fix_filename) && !gameInfo.installed ? '<span class="lt-muted lt-btn-sm">Игра не установлена</span>' : ''}
            </div>
          </div>`).join("")}
        </div>
      </div>`;

    el.querySelector("#lt-back-fix")?.addEventListener("click", () => { currentPage = "fixes"; renderFixes(el); });
    el.querySelector("#lt-revert-fix")?.addEventListener("click", async e => {
      const btn = e.currentTarget;
      if (!await confirmAction("Откатить фикс? Оригинальные файлы будут восстановлены.")) return;
      btn.disabled = true;
      try {
        const n = await invoke("lt_revert_fix", { appId });
        toast(`Откачено ${n} файлов`, "ok");
        openFixDetail(appId);
      } catch (e) { toast(errMsg(e), "error"); btn.disabled = false; }
    });

    el.querySelectorAll("[data-fix-manifest]").forEach(b => b.addEventListener("click", () => withBusy(b, async () => {
      if (!ltIsLoggedIn()) { toast("Войдите", "warn"); return; }
      const fixId = b.dataset.fixManifest;
      toast("Скачиваю манифест…", "info");
      try {
        const url = `https://lua.tools/api/denuvo/fixes/${fixId}/manifest`;
        const filePath = await invoke("lt_download", { url, token: ltSession()?.access_token, destDir: await getTmpDir() });
        await invoke("lt_install_file", { path: filePath, appId, autoUpdate: true });
        toast("Манифест установлен", "ok");
      } catch (e) { toast(errMsg(e), "error"); }
    })));

    el.querySelectorAll("[data-fix-apply]").forEach(b => b.addEventListener("click", () => withBusy(b, async () => {
      if (!ltIsLoggedIn()) { toast("Войдите", "warn"); return; }
      if (!await confirmAction("Применить фикс? Оригинальные файлы будут забэкаплены.")) return;
      const fixId = b.dataset.fixApply;
      toast("Скачиваю фикс…", "info");
      try {
        const url = `https://lua.tools/api/denuvo/fixes/${fixId}/fix`;
        const zipPath = await invoke("lt_download", { url, token: ltSession()?.access_token, destDir: await getTmpDir() });
        const result = await invoke("lt_apply_fix", { appId, zipPath });
        toast(`Фикс применён: ${result.files_extracted} файлов${result.backup_created ? ' (бэкап создан)' : ''}`, "ok");
        openFixDetail(appId);
      } catch (e) { toast(errMsg(e), "error"); }
    })));
  } catch (e) { el.innerHTML = `<button class="lt-btn lt-btn-sm" id="lt-back-fix">← Назад</button><div class="lt-error" style="margin-top:12px">${esc(errMsg(e))}</div>`; el.querySelector("#lt-back-fix")?.addEventListener("click", () => { currentPage = "fixes"; renderFixes(el); }); }
}

// ══════════════════════════════════════════════════════════════════
// PLUGIN
// ══════════════════════════════════════════════════════════════════

function renderPlugin(el) {
  const ps = pluginStatus;
  el.innerHTML = `<h2 class="lt-page-title">Плагин</h2>
    <div class="lt-plugin-info">
      <div class="lt-info-row"><strong>Статус:</strong> ${ps?.installed ? '<span class="lt-ok">Установлен</span>' : '<span class="lt-error">Не установлен</span>'}</div>
      ${ps?.mode ? `<div class="lt-info-row"><strong>Тип:</strong> ${esc(ps.mode)}</div>` : ''}
      ${ps?.version ? `<div class="lt-info-row"><strong>Версия:</strong> ${esc(ps.version)}</div>` : ''}
      ${ps?.dll_path ? `<div class="lt-info-row"><strong>Путь:</strong> <code>${esc(ps.dll_path)}</code></div>` : ''}
    </div>
    ${!ps?.installed ? '<p class="lt-warn" style="margin-top:16px">Плагин не обнаружен. Перейдите в раздел <strong>Режим</strong> для установки.</p><button class="lt-btn lt-btn-primary" data-page="mode">Установить</button>' : ''}`;
}

// ══════════════════════════════════════════════════════════════════
// DOWNLOADS
// ══════════════════════════════════════════════════════════════════

async function renderDownloads(el) {
  el.innerHTML = `<h2 class="lt-page-title">Загрузки</h2>
    <div class="lt-dl-sections">
      <div class="lt-section"><h3>Активные</h3><div id="lt-dl-active">${dlQueue.items.length ? '' : '<div class="lt-empty">Нет активных загрузок</div>'}</div></div>
      <div class="lt-section"><h3>История</h3><div id="lt-dl-history">${dlQueue.history.length ? '' : '<div class="lt-empty">Пусто</div>'}</div></div>
      <div class="lt-section"><h3>Манифесты в depotcache</h3><div id="lt-manifests" class="lt-loading">Загружаю…</div></div>
    </div>`;

  if (dlQueue.items.length) {
    const ST = { pending: "В очереди", downloading: "Скачиваю", installing: "Устанавливаю" };
    el.querySelector("#lt-dl-active").innerHTML = dlQueue.items.map(i => `<div class="lt-dl-item"><span>${esc(i.label)}</span><div class="lt-usage-bar"><div class="lt-usage-fill" style="width:${i.progress}%"></div></div><span class="lt-muted">${esc(ST[i.status] || i.status)}${i.status === "downloading" && i.progress ? ` · ${i.progress}%` : ""}</span></div>`).join("");
  }
  if (dlQueue.history.length) {
    el.querySelector("#lt-dl-history").innerHTML = dlQueue.history.slice(0, 20).map(i => `<div class="lt-dl-item"><span>${esc(i.label)}</span><span class="${i.status === 'done' ? 'lt-ok' : 'lt-error'}">${i.status === 'done' ? '✅' : '❌'} ${esc(i.error || 'Готово')}</span>${i.status !== 'done' && retryFns.has(i.id) ? ` <button class="lt-btn lt-btn-sm" data-dl-retry="${i.id}">Повторить</button>` : ''}</div>`).join("");
  }

  try {
    const manifests = await invoke("lt_list_manifests");
    const m = el.querySelector("#lt-manifests");
    if (!manifests.length) { m.innerHTML = '<div class="lt-empty">Нет манифестов</div>'; return; }
    m.innerHTML = `<table class="lt-table"><thead><tr><th>Файл</th><th>Depot</th><th>Размер</th><th>Дата</th></tr></thead><tbody>
      ${manifests.slice(0, 50).map(m => `<tr><td><code>${esc(m.name)}</code></td><td>${m.depot_id}</td><td>${fmtSize(m.size)}</td><td>${fmtDate(m.modified)}</td></tr>`).join("")}</tbody></table>
      ${manifests.length > 50 ? `<div class="lt-muted">…и ещё ${manifests.length - 50}</div>` : ''}`;
  } catch (e) { el.querySelector("#lt-manifests").innerHTML = `<div class="lt-error">${esc(errMsg(e))}</div>`; }
}

// ══════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════

async function renderSettings(el) {
  let cfg = {};
  try { cfg = await invoke("lt_config_get") || {}; } catch {}
  el.innerHTML = `<h2 class="lt-page-title">Настройки</h2>
    <div class="lt-section"><h3>Steam</h3>
    <div class="lt-settings-list">
      <div class="lt-info-row"><strong>Путь:</strong> ${steamInfo?.path ? esc(steamInfo.path) : '<span class="lt-error">Не найден</span>'}</div>
      <div class="lt-info-row"><strong>stplug-in:</strong> ${steamInfo?.stplugin_dir ? `<code>${esc(steamInfo.stplugin_dir)}</code>` : '—'}</div>
      <div class="lt-info-row"><strong>depotcache:</strong> ${steamInfo?.depotcache_dir ? `<code>${esc(steamInfo.depotcache_dir)}</code>` : '—'}</div>
      <div class="lt-info-row"><strong>Steam запущен:</strong> ${steamInfo?.running ? '<span class="lt-warn">Да</span>' : '<span class="lt-ok">Нет</span>'}</div>
    </div></div>

    <div class="lt-section"><h3>Общие</h3>
    <div class="lt-settings-list">
      <label class="lt-info-row"><input type="checkbox" id="lt-cfg-encrypt" ${cfg.encrypt_token ? 'checked' : ''}> Шифровать токен lua.tools (DPAPI)</label>
      <label class="lt-info-row"><input type="checkbox" id="lt-cfg-hardfilter" ${cfg.filter_hardware !== false ? 'checked' : ''}> Скрывать hardware AppID из поиска</label>
    </div></div>

    <div class="lt-section"><h3>Источники</h3>
    <div class="lt-settings-list">
      <label class="lt-info-row"><input type="checkbox" id="lt-src-sushi" ${cfg.src_sushi !== false ? 'checked' : ''}> sushitools-games-repo</label>
      <label class="lt-info-row"><input type="checkbox" id="lt-src-hubcap" ${cfg.src_hubcap ? 'checked' : ''}> Hubcap (нужен API-ключ)</label>
    </div></div>

    <div class="lt-section"><h3>API-сервер</h3>
    <div class="lt-settings-list">
      <div class="lt-info-row"><label>Base URL: <input type="text" class="lt-input" id="lt-cfg-apibase" value="${esc(cfg.api_base || '')}" placeholder="https://lua.tools (по умолчанию)" style="width:300px"></label></div>
      <button class="lt-btn lt-btn-sm" id="lt-cfg-apibase-save">Сохранить</button>
      <span class="lt-muted">Оставьте пустым для lua.tools</span>
    </div></div>

    <div class="lt-section"><h3>Аккаунт lua.tools</h3><div class="lt-auth-area"></div></div>
    <div class="lt-section"><h3>Сообщество</h3>
      <div class="lt-info-row">Discord: <a href="https://discord.gg/luatools" target="_blank">discord.gg/luatools</a></div>
    </div>
    <div class="lt-section"><h3>CEF интеграция</h3>
    <p class="lt-muted">Подключение к отладочному порту Steam-клиента (8080) для инъекции в магазин.</p>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="lt-btn lt-btn-sm" id="lt-cef-check">Проверить CEF</button>
      <button class="lt-btn lt-btn-sm" id="lt-cef-dismiss">Сбросить загруженные</button>
    </div>
    <pre id="lt-cef-out" class="lt-muted" style="font-size:.75rem;max-height:150px;overflow:auto;margin-top:8px"></pre>
    </div>

    <div class="lt-section"><h3>Данные</h3>
      <button class="lt-btn lt-btn-sm" id="lt-reset-onboard">Сбросить onboarding</button>
    </div>

    <div class="lt-section"><h3>opensteamtool.toml</h3>
    <p class="lt-muted">Конфигурация OpenSteamTool / BetterSteamTools. Секции: [manifest], [stats], [inject], [lua], [donate], [remote], [log].</p>
    <textarea id="lt-ost-editor" class="lt-input" style="width:100%;min-height:200px;font-family:monospace;font-size:.8rem;resize:vertical" placeholder="Загружаю…"></textarea>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button class="lt-btn lt-btn-sm" id="lt-ost-reload">Перечитать</button>
      <button class="lt-btn lt-btn-sm lt-btn-primary" id="lt-ost-save">Сохранить</button>
    </div>
    </div>`;
  updateAuthUI();
  const saveOn = (id, key, boolVal = true) => el.querySelector(id)?.addEventListener("change", async e => {
    const v = boolVal ? e.target.checked : e.target.value;
    try { await invoke("lt_config_set", { key, value: v }); ltConfig[key] = v; toast("Сохранено", "ok"); } catch (err) { toast(errMsg(err), "error"); }
  });
  el.querySelector("#lt-cfg-encrypt")?.addEventListener("change", async e => {
    const on = e.target.checked;
    try {
      await invoke("lt_config_set", { key: "encrypt_token", value: on });
      ltConfig.encrypt_token = on;
      if (on) await persistEncryptedSession(ltSession());
      else await invoke("lt_config_set", { key: "session_enc", value: null });
      ltSetSessionPersist(!on);
      toast("Сохранено", "ok");
    } catch (err) { e.target.checked = !on; toast(errMsg(err), "error"); }
  });
  saveOn("#lt-cfg-hardfilter", "filter_hardware");
  saveOn("#lt-src-sushi", "src_sushi");
  saveOn("#lt-src-hubcap", "src_hubcap");
  el.querySelector("#lt-cfg-apibase-save")?.addEventListener("click", async () => {
    const v = el.querySelector("#lt-cfg-apibase").value.trim();
    try {
      await invoke("lt_config_set", { key: "api_base", value: v || "" });
      if (v) ltSetApiConfig({ api_base: v }); else ltSetApiConfig(null);
      toast("API-сервер обновлён", "ok");
    } catch (e) { toast(String(e), "error"); }
  });
  el.querySelector("#lt-reset-onboard")?.addEventListener("click", () => { try { localStorage.removeItem("lt_onboarded"); } catch {} toast("Onboarding сброшен", "ok"); });
  el.querySelector("#lt-cef-check")?.addEventListener("click", async () => {
    const out = el.querySelector("#lt-cef-out"); out.textContent = "Подключаюсь…";
    try {
      const targets = await invoke("lt_cef_targets");
      const arr = Array.isArray(targets) ? targets : [];
      out.textContent = arr.length ? arr.map(t => `${t.title || t.url || "?"}`).join("\n") : "Нет открытых вкладок";
    } catch (e) { out.textContent = String(e); }
  });
  el.querySelector("#lt-cef-dismiss")?.addEventListener("click", async () => {
    try { const r = await invoke("lt_cef_dismiss_loaded_apps"); toast(r, "ok"); } catch (e) { toast(String(e), "error"); }
  });

  const ostEditor = el.querySelector("#lt-ost-editor");
  const loadOstConfig = async () => {
    try { ostEditor.value = await invoke("lt_ost_config_read"); } catch (e) { ostEditor.value = ""; ostEditor.placeholder = String(e); }
  };
  loadOstConfig();
  el.querySelector("#lt-ost-reload")?.addEventListener("click", async () => { await loadOstConfig(); toast("Перечитано", "ok"); });
  el.querySelector("#lt-ost-save")?.addEventListener("click", async () => {
    try { await invoke("lt_ost_config_write", { content: ostEditor.value }); toast("opensteamtool.toml сохранён", "ok"); } catch (e) { toast(String(e), "error"); }
  });
}

// ══════════════════════════════════════════════════════════════════
// DETAIL (game/depot page)
// ══════════════════════════════════════════════════════════════════

async function openDetail(appId) {
  currentPage = "detail";
  const el = $("#lt-page-content");
  el.innerHTML = '<div class="lt-loading">Загружаю…</div>';

  try {
    const [details, sources, gameInfo] = await Promise.all([
      ltGameDetails(String(appId)),
      ltCheckSources(String(appId)),
      invoke("lt_game_install_path", { appId }),
    ]);

    let luaText = null, luaInfo = null;
    try { luaText = await invoke("lt_read_lua", { appId }); luaInfo = parseLua(luaText, appId); } catch {}

    const name = details?.name || `App ${appId}`;
    const img = details?.header_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
    const sourceList = Object.entries(sources).filter(([, v]) => v === "available").map(([k]) => k);

    // Variants
    let variants = [];
    try { variants = await invoke("lt_list_variants", { appId }); } catch {}
    const currentHash = luaText ? shortHash(luaText) : null;

    // Vault history
    let vaultHistory = [];
    try { vaultHistory = await invoke("lt_vault_history", { appId }); } catch {}

    el.innerHTML = `
      <button class="lt-btn lt-btn-sm" id="lt-back-btn">← Назад</button>
      <div class="lt-detail" style="margin-top:12px">
        <div class="lt-detail-header">
          <img src="${esc(img)}" class="lt-detail-img" alt="">
          <div class="lt-detail-meta">
            <h3>${esc(name)}</h3><span class="lt-card-id">AppID: ${appId}</span>
            ${gameInfo.installed ? `<div class="lt-ok" style="margin-top:6px">📂 ${esc(gameInfo.path)}${gameInfo.size_on_disk ? ` · ${fmtSize(gameInfo.size_on_disk)}` : ''}</div>` : '<div class="lt-muted" style="margin-top:6px">Не установлена на диск</div>'}
            ${luaInfo ? `<div class="lt-ok" style="margin-top:4px">✅ ${luaInfo.depotCount} депо, ${luaInfo.dlcCount} DLC${luaInfo.hasActivePins ? " · Закреплено" : " · Авто-обновление"}</div>` : '<div class="lt-muted" style="margin-top:4px">Lua не установлен</div>'}
            ${gameInfo.installed ? `<div style="margin-top:8px;display:flex;gap:6px;align-items:center">
              <button class="lt-btn lt-btn-primary lt-btn-sm" id="lt-launch-btn">▶ Запустить</button>
              <input type="text" class="lt-input" id="lt-launch-args" placeholder="Параметры запуска" style="max-width:200px;font-size:.8rem">
            </div>` : ''}
          </div>
        </div>

        <div class="lt-detail-sources">
          <h4>Источники${sourceList.length ? ` (${sourceList.length})` : ""}</h4>
          ${sourceList.length ? sourceList.map(s => `<button class="lt-btn lt-btn-primary lt-btn-sm" data-dl-source="${esc(s)}" data-appid="${appId}" data-game-name="${esc(name)}">📥 ${esc(s)}</button>`).join(" ") : '<span class="lt-muted">Нет</span>'}
          ${ltConfig.src_sushi !== false ? `<button class="lt-btn lt-btn-sm" data-dl-alt="sushi" data-appid="${appId}" data-game-name="${esc(name)}">📥 sushitools</button>` : ''}
          ${ltConfig.src_hubcap && ltConfig.hubcap_key ? `<button class="lt-btn lt-btn-sm" data-dl-alt="hubcap" data-appid="${appId}" data-game-name="${esc(name)}">📥 Hubcap</button>` : ''}
        </div>

        ${variants.length ? `<div class="lt-section"><h4>Варианты (${variants.length})</h4>
          <div class="lt-var-list">${variants.map(v => `<div class="lt-var-row ${v.hash === currentHash ? 'lt-var-active' : ''}">
            <span><strong>${esc(v.name)}</strong> · ${v.depot_count}d ${v.dlc_count}dlc${v.is_pinned ? ' 📌' : ''} · <span class="lt-muted">${esc(v.hash)}</span></span>
            <button class="lt-btn lt-btn-sm lt-var-load-d" data-vn="${esc(v.name)}">Загрузить</button>
          </div>`).join("")}</div></div>` : ''}

        ${luaInfo ? `<div class="lt-section"><div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <h4 style="margin:0">Сохранить как вариант</h4>
          <input type="text" class="lt-input" id="lt-save-var-name" placeholder="Имя" style="max-width:200px">
          <button class="lt-btn lt-btn-sm" id="lt-save-var-btn">💾 Сохранить</button>
        </div></div>` : ''}

        ${vaultHistory.length ? `<div class="lt-section"><h4>История версий (${vaultHistory.length})</h4>
          <div class="lt-vault-list">${vaultHistory.slice(0, 10).map(v => `<div class="lt-vault-row">
            <div class="lt-vault-meta">
              <code>${v.hash.slice(0, 12)}…</code>
              <span class="lt-muted">${fmtDate(v.timestamp)} · ${v.source} · ${v.depot_count}d ${v.dlc_count}dlc${v.is_pinned ? ' 📌' : ''}</span>
            </div>
            <button class="lt-btn lt-btn-sm lt-vault-restore-btn" data-vault-hash="${esc(v.hash)}">Восстановить</button>
          </div>`).join("")}
          ${vaultHistory.length > 10 ? `<span class="lt-muted">…и ещё ${vaultHistory.length - 10}</span>` : ''}</div></div>` : ''}

        ${luaInfo ? renderLuaEntries(luaInfo, appId) : ""}
      </div>`;

    el.querySelector("#lt-save-var-btn")?.addEventListener("click", e => withBusy(e.currentTarget, async () => {
      const n = el.querySelector("#lt-save-var-name").value.trim();
      if (!n) { toast("Введите имя", "warn"); return; }
      try { await invoke("lt_save_variant", { appId, name: n }); toast(`Вариант «${n}» сохранён`, "ok"); openDetail(appId); }
      catch (err) { toast(errMsg(err), "error"); }
    }));
    el.querySelectorAll(".lt-var-load-d").forEach(b => b.addEventListener("click", () => withBusy(b, async () => {
      try { await invoke("lt_load_variant", { appId, name: b.dataset.vn }); toast(`Загружен: ${b.dataset.vn}`, "ok"); openDetail(appId); }
      catch (err) { toast(errMsg(err), "error"); }
    })));
    el.querySelectorAll(".lt-vault-restore-btn").forEach(b => b.addEventListener("click", () => withBusy(b, async () => {
      const hash = b.dataset.vaultHash;
      if (!await confirmAction("Восстановить эту версию? Текущий файл будет сохранён в историю.")) return;
      try { await invoke("lt_vault_restore", { appId, hash }); toast("Версия восстановлена", "ok"); openDetail(appId); }
      catch (err) { toast(errMsg(err), "error"); }
    })));
    el.querySelector("#lt-launch-btn")?.addEventListener("click", async () => {
      const args = el.querySelector("#lt-launch-args")?.value?.trim() || "";
      try { await invoke("lt_launch_game", { appId, args }); toast("Запуск через Steam…", "ok"); }
      catch (e) { toast(`Ошибка: ${e}`, "error"); }
    });
  } catch (e) { el.innerHTML = `<button class="lt-btn lt-btn-sm" id="lt-back-btn">← Назад</button><div class="lt-error" style="margin-top:12px">${esc(errMsg(e))}</div>`; }
}

const EXTRA_LABELS = { token: "AccessToken", appTicket: "AppTicket", eTicket: "ETicket", stat: "SteamID (stats)", cdKey: "CD-Key" };

function renderLuaEntries(lua, appId) {
  const all = [...lua.entries.map(e => ({ ...e, disabled: false })), ...lua.disabledEntries.map(e => ({ ...e, disabled: true }))];
  if (!all.length && !lua.extras?.length) return "";

  let html = `<div class="lt-entries"><h4>Содержимое lua (${all.length})</h4>
    <table class="lt-table"><thead><tr><th>ID</th><th>Тип</th><th>Комментарий</th><th>Манифест</th><th></th></tr></thead><tbody>
    ${all.map(e => {
      const hasMf = e.manifestId || e.commentedManifestId;
      return `<tr class="${e.disabled ? 'lt-row-disabled' : ''}">
        <td>${e.id}</td>
        <td>${e.hasKey ? "Депо" : (e.id === lua.baseAppId ? "Base" : "DLC")}</td>
        <td>${esc(e.comment || "")}</td>
        <td>${e.manifestId ? `<code>${e.manifestId}</code>` : (e.commentedManifestId ? `<code class="lt-muted">${e.commentedManifestId}</code>` : "—")}</td>
        <td class="lt-td-actions">
          ${!e.disabled ? `<button class="lt-btn lt-btn-sm lt-btn-danger" data-enable-depot="${e.id}" data-enable-appid="${appId}" data-enable-action="disable" title="Отключить">⊘</button>` : `<button class="lt-btn lt-btn-sm" data-enable-depot="${e.id}" data-enable-appid="${appId}" data-enable-action="enable" title="Включить">✓</button>`}
          ${hasMf && !e.disabled ? (e.manifestId ? `<button class="lt-btn lt-btn-sm" data-lock-depot="${e.id}" data-lock-appid="${appId}" data-lock-action="unlock" title="Открепить">🔓</button>` : `<button class="lt-btn lt-btn-sm" data-lock-depot="${e.id}" data-lock-appid="${appId}" data-lock-action="lock" title="Закрепить">🔒</button>`) : ''}
        </td></tr>`;
    }).join("")}</tbody></table>`;

  if (lua.extras?.length) {
    html += `<h4 style="margin-top:16px">Расширенные записи OST (${lua.extras.length})</h4>
      <table class="lt-table"><thead><tr><th>AppID</th><th>Тип</th><th>Значение</th><th></th></tr></thead><tbody>
      ${lua.extras.map(ex => `<tr class="${ex.disabled ? 'lt-row-disabled' : ''}">
        <td>${ex.appId}</td>
        <td>${esc(EXTRA_LABELS[ex.kind] || ex.kind)}</td>
        <td><code class="lt-extra-val">${esc(ex.value.length > 40 ? ex.value.slice(0, 40) + "…" : ex.value)}</code></td>
        <td>${ex.disabled ? '<span class="lt-muted">выкл</span>' : ''}</td>
      </tr>`).join("")}</tbody></table>`;
  }

  return html + "</div>";
}

// ── Helpers ─────────────────────────────────────────────────────────

function shortHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

async function confirmAction(msg) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "lt-confirm-overlay";
    overlay.innerHTML = `<div class="lt-confirm-box"><p>${esc(msg)}</p><div class="lt-confirm-actions"><button class="lt-btn lt-btn-primary lt-confirm-yes">Да</button><button class="lt-btn lt-confirm-no">Отмена</button></div></div>`;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    document.body.appendChild(overlay);
    const prevFocus = document.activeElement;
    const done = v => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      try { prevFocus?.focus?.(); } catch { /* noop */ }
      resolve(v);
    };
    const onKey = e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("click", e => { if (e.target === overlay) done(false); });
    overlay.querySelector(".lt-confirm-yes").addEventListener("click", () => done(true));
    overlay.querySelector(".lt-confirm-no").addEventListener("click", () => done(false));
    overlay.querySelector(".lt-confirm-no").focus();
  });
}

async function doDownload(appId, source, gameName) {
  if (!ltIsLoggedIn()) { toast("Войдите в lua.tools", "warn"); return; }
  const key = `${appId}:${source}`;
  if (inflight.has(key)) { toast("Уже скачивается", "info"); return; }
  inflight.add(key);
  const url = ltManifestDownloadUrl(appId, source, gameName);
  const item = queueAdd(`${gameName || appId} (${source})`, appId);
  item._url = url;
  retryFns.set(item.id, () => doDownload(appId, source, gameName));
  queueStatus(item, "downloading", 0);
  toast("Скачиваю…", "info");
  try {
    const filePath = await invoke("lt_download", { url, token: ltSession()?.access_token, destDir: await getTmpDir() });
    queueStatus(item, "installing", 100);
    toast("Устанавливаю…", "info");
    const result = await invoke("lt_install_file", { path: filePath, appId, autoUpdate: true });
    const parts = [];
    if (result.lua_installed) parts.push("lua");
    if (result.manifest_count) parts.push(`${result.manifest_count} манифестов`);
    if (result.failed.length) parts.push(`ошибки: ${result.failed.join(", ")}`);
    queueDone(item, !result.failed.length, result.failed.length ? result.failed.join(", ") : null);
    toast(parts.join(", ") || "Готово", result.failed.length ? "warn" : "ok");
    installedList = await invoke("lt_list_installed");
    openDetail(appId);
  } catch (e) {
    queueDone(item, false, errMsg(e));
    toast(`Ошибка: ${errMsg(e)}`, "error");
  } finally { inflight.delete(key); }
}

async function doAltDownload(appId, alt, gameName) {
  const key = `${appId}:${alt}`;
  if (inflight.has(key)) { toast("Уже скачивается", "info"); return; }
  inflight.add(key);
  const item = queueAdd(`${gameName || appId} (${alt})`, appId);
  retryFns.set(item.id, () => doAltDownload(appId, alt, gameName));
  queueStatus(item, "downloading", 0);
  try {
    let zipPath;
    if (alt === "sushi") zipPath = await invoke("lt_source_sushitools", { appId });
    else if (alt === "hubcap") zipPath = await invoke("lt_hubcap_fetch", { appId, apiKey: ltConfig.hubcap_key });
    else throw new Error("Неизвестный источник");
    queueStatus(item, "installing", 100);
    const result = await invoke("lt_install_file", { path: zipPath, appId, autoUpdate: true });
    queueDone(item, true);
    toast(`Установлено${result.manifest_count ? `: ${result.manifest_count} манифестов` : ""}`, "ok");
    installedList = await invoke("lt_list_installed");
    openDetail(appId);
  } catch (e) { queueDone(item, false, errMsg(e)); toast(errMsg(e), "error"); }
  finally { inflight.delete(key); }
}

async function doRemove(appId) {
  if (!await confirmAction(`Удалить lua для ${appId}?`)) return;
  try {
    await invoke("lt_remove_lua", { appId });
    toast(`${appId} удалён`, "ok");
    installedList = await invoke("lt_list_installed");
    renderPage(currentPage);
  } catch (e) { toast(errMsg(e), "error"); }
}

async function doToggleLock(appId, depotId, lock) {
  try {
    let text = await invoke("lt_read_lua", { appId });
    text = setDepotLocked(text, depotId, !lock);
    await invoke("lt_write_lua", { appId, content: text });
    toast(lock ? `${depotId} откреплён` : `${depotId} закреплён`, "ok");
    openDetail(appId);
  } catch (e) { toast(errMsg(e), "error"); }
}

async function doToggleEnable(appId, depotId, enable) {
  try {
    let text = await invoke("lt_read_lua", { appId });
    text = setDepotEnabled(text, depotId, enable);
    await invoke("lt_write_lua", { appId, content: text });
    toast(enable ? `${depotId} включён` : `${depotId} отключён`, "ok");
    openDetail(appId);
  } catch (e) { toast(errMsg(e), "error"); }
}

async function doRestartSteam() {
  if (!await confirmAction("Перезапустить Steam?")) return;
  toast("Перезапускаю…", "info");
  try { await invoke("lt_restart_steam"); toast("Steam перезапущен", "ok"); } catch (e) { toast(errMsg(e), "error"); }
}

async function getTmpDir() {
  try { const info = await invoke("lt_steam_info"); if (info?.path) return info.path + "\\config\\luatools_tmp"; } catch {}
  return (await import("@tauri-apps/api/path").then(m => m.tempDir())) + "luatools";
}

let loginPending = false;
async function doLogin() {
  if (loginPending) { toast("Вход уже открыт в браузере", "info"); return; }
  loginPending = true;
  toast("Войдите через Discord в открывшемся браузере", "info");
  try {
    const tokens = await invoke("lt_oauth_login", { loginUrl: ltLoginUrl() });
    let user = null;
    try { user = await ltFetchUser(tokens.access_token); } catch { /* имя не критично */ }
    ltSaveSession({ ...tokens, user });
    updateAuthUI();
    toast("Вошли в lua.tools", "ok");
  } catch (e) {
    toast(`Вход не выполнен: ${errMsg(e)}`, "error");
  } finally { loginPending = false; }
}

async function persistEncryptedSession(data) {
  if (!data?.access_token) return;
  const enc = await invoke("lt_dpapi_encrypt", { plaintext: JSON.stringify(data) });
  await invoke("lt_config_set", { key: "session_enc", value: enc });
}

// Любая смена сессии (вход, refresh токена) — пересохраняем зашифрованную копию.
ltOnSessionChange(s => {
  if (ltConfig?.encrypt_token) persistEncryptedSession(s).catch(() => {});
});

let sessionRestored = false;
async function restoreEncryptedSession() {
  if (!ltConfig.encrypt_token) { ltSetSessionPersist(true); return; }
  ltSetSessionPersist(false); // убирает открытую копию из localStorage
  if (sessionRestored || ltSession() || !ltConfig.session_enc) return;
  sessionRestored = true;
  try {
    const data = JSON.parse(await invoke("lt_dpapi_decrypt", { ciphertextB64: ltConfig.session_enc }));
    if (data?.access_token) ltSaveSession(data);
  } catch { /* другой пользователь Windows / повреждено — просто нужен повторный вход */ }
}
