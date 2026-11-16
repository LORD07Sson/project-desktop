// LuaTools — полная интеграция.
// Главная, Добавить, Управление, Инструменты, Режим, Фиксы, Плагин, Загрузки, Настройки.

import { invoke } from "./tauri.js";
import { $ } from "./utils.js";
import { toast } from "./api.js";
import {
  ltSearchSteam, ltFeatured, ltCheckSources, ltGameDetails,
  ltIsLoggedIn, ltSession, ltLoginUrl, ltSaveSession, ltClearSession,
  ltManifestDownloadUrl, ltUsage, ltDlcGenerateUrl, ltDenuvoListings, ltDenuvoFixes,
} from "./luatools-api.js";
import { parseLua, setDepotLocked, setDepotEnabled } from "./luatools-parser.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtSize = b => b > 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : (b / 1024).toFixed(1) + " KB";
const fmtDate = ts => ts ? new Date(ts * 1000).toLocaleDateString() : "—";

let loaded = false;
let steamInfo = null;
let installedList = [];
let pluginStatus = null;
let currentPage = "home";
let onboardingDone = false;

// ── Download queue (in-memory) ─────────────────────────────────────
const dlQueue = { items: [], history: [] };
let dlIdCounter = 0;

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
  if (currentPage === "downloads") renderPage("downloads");
}

// ── Entry ──────────────────────────────────────────────────────────

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
      <button class="lt-nav active" data-page="home">🏠 Главная</button>
      <button class="lt-nav" data-page="add">➕ Добавить</button>
      <button class="lt-nav" data-page="manage">📂 Управление</button>
      <button class="lt-nav" data-page="tools">🔧 Инструменты</button>
      <button class="lt-nav" data-page="mode">⚙ Режим</button>
      <button class="lt-nav" data-page="fixes">🛠 Фиксы</button>
      <button class="lt-nav" data-page="plugin">🔌 Плагин</button>
    </div>
    <div class="lt-sidebar-bottom">
      <button class="lt-nav lt-nav-action" id="lt-restart-steam">🔄 Перезапустить Steam</button>
      <button class="lt-nav" data-page="downloads">📥 Загрузки</button>
      <button class="lt-nav" data-page="settings">⚙ Настройки</button>
    </div>
    <div class="lt-sidebar-ver" id="lt-sidebar-ver"></div>
  </nav>
  <main class="lt-main"><div class="lt-page-content" id="lt-page-content"></div></main>
</div>`;
}

function attachGlobal(body) {
  body.addEventListener("click", e => {
    const nav = e.target.closest(".lt-nav[data-page]");
    if (nav) { switchPage(nav.dataset.page); return; }
    if (e.target.closest("#lt-restart-steam")) { doRestartSteam(); return; }
    if (e.target.closest("#lt-back-btn")) { switchPage("home"); return; }
    if (e.target.closest("#lt-login-btn")) { doLogin(); return; }
    if (e.target.closest("#lt-logout-btn")) { ltClearSession(); updateAuthUI(); return; }

    const dl = e.target.closest("[data-dl-source]");
    if (dl) { doDownload(parseInt(dl.dataset.appid, 10), dl.dataset.dlSource, dl.dataset.gameName || ""); return; }

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
  const renderers = { home: renderHome, add: renderAdd, manage: renderManage, tools: renderTools, mode: renderMode, fixes: renderFixes, plugin: renderPlugin, downloads: renderDownloads, settings: renderSettings };
  const fn = renderers[page];
  if (fn) await fn(el);
}

async function refreshAll(body) {
  try { steamInfo = await invoke("lt_steam_info"); } catch { steamInfo = null; }
  try { pluginStatus = await invoke("lt_plugin_status"); } catch { pluginStatus = null; }
  try { installedList = await invoke("lt_list_installed"); } catch { installedList = []; }
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
      <div class="lt-card-info"><span class="lt-card-name">${i.app_id}</span><span class="lt-card-date">${fmtDate(i.modified)}</span></div>
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
      const items = /^\d+$/.test(q) ? [await ltGameDetails(q)].filter(Boolean).map(d => ({ appId: parseInt(q), name: d.name, icon: d.header_image })) : await ltSearchSteam(q);
      if (!items.length) { r.innerHTML = '<div class="lt-empty">Ничего не нашлось</div>'; return; }
      r.innerHTML = items.map(i => `<button class="lt-card lt-card-search" data-appid="${i.appId}"><img src="${esc(i.icon)}" alt="" loading="lazy"><div class="lt-card-info"><span class="lt-card-name">${esc(i.name)}</span><span class="lt-card-id">${i.appId}</span></div></button>`).join("");
    } catch (e) { r.innerHTML = `<div class="lt-error">${esc(e.message)}</div>`; }
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
    <div class="lt-search-bar"><input type="text" id="lt-manage-search" class="lt-input" placeholder="Фильтр по AppID…"></div>
    <p class="lt-muted">${installedList.length} файлов</p>
    <div class="lt-manage-list" id="lt-manage-list"></div>`;

  const renderList = (filter) => {
    const list = filter ? installedList.filter(i => String(i.app_id).includes(filter)) : installedList;
    const c = el.querySelector("#lt-manage-list");
    c.innerHTML = list.map(i => `
      <div class="lt-manage-item" data-appid="${i.app_id}">
        <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${i.app_id}/capsule_sm_120.jpg" alt="" loading="lazy">
        <div class="lt-manage-info"><span class="lt-card-name">${i.app_id}</span><span class="lt-card-date">${fmtDate(i.modified)}</span></div>
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
    </div>`;

  el.querySelector("#lt-dlc-gen").addEventListener("click", async () => {
    const appId = el.querySelector("#lt-dlc-appid").value.trim(); if (!appId) return;
    const r = el.querySelector("#lt-dlc-result");
    if (!ltIsLoggedIn()) { r.innerHTML = '<span class="lt-warn">Войдите в lua.tools</span>'; return; }
    r.innerHTML = '<div class="lt-loading">Генерирую…</div>';
    try {
      const url = ltDlcGenerateUrl(appId, appId, "");
      const filePath = await invoke("lt_download", { url, token: ltSession()?.access_token, destDir: await getTmpDir() });
      await invoke("lt_install_file", { path: filePath, appId: parseInt(appId), autoUpdate: false });
      r.innerHTML = '<span class="lt-ok">✅ DLC установлены</span>';
    } catch (e) { r.innerHTML = `<span class="lt-error">${esc(e.message)}</span>`; }
  });

  el.querySelector("#lt-var-list").addEventListener("click", async () => {
    const appId = el.querySelector("#lt-var-appid").value.trim(); if (!appId) return;
    const r = el.querySelector("#lt-var-result");
    try {
      const variants = await invoke("lt_list_variants", { appId: parseInt(appId) });
      if (!variants.length) { r.innerHTML = '<div class="lt-empty">Нет сохранённых вариантов</div>'; return; }
      r.innerHTML = variants.map(v => `<div class="lt-var-row">
        <span><strong>${esc(v.name)}</strong> · ${v.depot_count} депо, ${v.dlc_count} DLC${v.is_pinned ? ' 📌' : ''}</span>
        <span class="lt-muted">${esc(v.hash)}</span>
        <button class="lt-btn lt-btn-sm lt-var-load" data-vname="${esc(v.name)}" data-vappid="${appId}">Загрузить</button>
        <button class="lt-btn lt-btn-sm lt-btn-danger lt-var-del" data-vname="${esc(v.name)}" data-vappid="${appId}">✕</button>
      </div>`).join("");
      r.querySelectorAll(".lt-var-load").forEach(b => b.addEventListener("click", async () => {
        await invoke("lt_load_variant", { appId: parseInt(b.dataset.vappid), name: b.dataset.vname });
        toast(`Вариант «${b.dataset.vname}» загружен`, "ok");
      }));
      r.querySelectorAll(".lt-var-del").forEach(b => b.addEventListener("click", async () => {
        await invoke("lt_delete_variant", { appId: parseInt(b.dataset.vappid), name: b.dataset.vname });
        toast("Удалён", "ok");
        el.querySelector("#lt-var-list").click();
      }));
    } catch (e) { r.innerHTML = `<span class="lt-error">${esc(e.message)}</span>`; }
  });

  if (ltIsLoggedIn()) {
    const usage = await ltUsage();
    const u = el.querySelector("#lt-usage-info");
    if (usage) { u.innerHTML = `<div class="lt-usage-bar"><div class="lt-usage-fill" style="width:${Math.min(100, usage.used / usage.limit * 100)}%"></div></div><span>${usage.used} / ${usage.limit}</span>`; }
    else { u.innerHTML = '<span class="lt-muted">Нет данных</span>'; }
  } else { el.querySelector("#lt-usage-info").innerHTML = '<span class="lt-warn">Войдите</span>'; }
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
        <h3>Custom</h3>
        <p class="lt-muted">Ручной режим — удаляет DLL-файлы, вы ставите свои.</p>
        <button class="lt-btn lt-btn-danger" id="lt-install-custom">Очистить DLL</button>
      </div>
    </div>
    <div class="lt-section" id="lt-cr-section"></div>`;

  const installHandler = (btnId, mode) => {
    el.querySelector(btnId)?.addEventListener("click", async () => {
      if (!await confirmAction("Установка режима остановит Steam. Продолжить?")) return;
      const btn = el.querySelector(btnId);
      btn.disabled = true; btn.textContent = "Устанавливаю…";
      try {
        const msg = await invoke("lt_install_mode", { mode });
        toast(msg, "ok");
        pluginStatus = await invoke("lt_plugin_status");
        renderMode(el);
      } catch (e) { toast(e.message || String(e), "error"); btn.disabled = false; btn.textContent = "Ошибка"; }
    });
  };
  installHandler("#lt-install-bst", "bst");
  installHandler("#lt-install-ost", "ost");
  installHandler("#lt-install-custom", "custom");

  // Check versions
  invoke("lt_check_mode_update", { mode: "bst" }).then(v => {
    const e = el.querySelector("#lt-bst-ver");
    if (e && v.latest_tag) e.innerHTML = `Последняя: <strong>${esc(v.latest_tag)}</strong>`;
  }).catch(() => {});
  invoke("lt_check_mode_update", { mode: "ost" }).then(v => {
    const e = el.querySelector("#lt-ost-ver");
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
      el.querySelector("#lt-cr-toggle")?.addEventListener("click", async () => {
        await invoke("lt_cloud_redirect_toggle", { enable: !cr.enabled });
        toast(cr.enabled ? "CloudRedirect выключен" : "CloudRedirect включён", "ok");
        renderMode(el);
      });
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
    const game = fixesCache?.find(g => (g.appid || g.appId) == appId);
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
            ${f.description ? `<p class="lt-muted">${esc(f.description)}</p>` : ''}
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
    el.querySelector("#lt-revert-fix")?.addEventListener("click", async () => {
      if (!await confirmAction("Откатить фикс? Оригинальные файлы будут восстановлены.")) return;
      try {
        const n = await invoke("lt_revert_fix", { appId });
        toast(`Откачено ${n} файлов`, "ok");
        openFixDetail(appId);
      } catch (e) { toast(e.message, "error"); }
    });

    el.querySelectorAll("[data-fix-manifest]").forEach(b => b.addEventListener("click", async () => {
      if (!ltIsLoggedIn()) { toast("Войдите", "warn"); return; }
      const fixId = b.dataset.fixManifest;
      toast("Скачиваю манифест…", "info");
      try {
        const url = `https://lua.tools/api/denuvo/fixes/${fixId}/manifest`;
        const filePath = await invoke("lt_download", { url, token: ltSession()?.access_token, destDir: await getTmpDir() });
        await invoke("lt_install_file", { path: filePath, appId, autoUpdate: true });
        toast("Манифест установлен", "ok");
      } catch (e) { toast(e.message, "error"); }
    }));

    el.querySelectorAll("[data-fix-apply]").forEach(b => b.addEventListener("click", async () => {
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
      } catch (e) { toast(e.message, "error"); }
    }));
  } catch (e) { el.innerHTML = `<button class="lt-btn lt-btn-sm" id="lt-back-fix">← Назад</button><div class="lt-error" style="margin-top:12px">${esc(e.message)}</div>`; el.querySelector("#lt-back-fix")?.addEventListener("click", () => { currentPage = "fixes"; renderFixes(el); }); }
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
    el.querySelector("#lt-dl-active").innerHTML = dlQueue.items.map(i => `<div class="lt-dl-item"><span>${esc(i.label)}</span><div class="lt-usage-bar"><div class="lt-usage-fill" style="width:${i.progress}%"></div></div><span class="lt-muted">${i.status}</span></div>`).join("");
  }
  if (dlQueue.history.length) {
    el.querySelector("#lt-dl-history").innerHTML = dlQueue.history.slice(0, 20).map(i => `<div class="lt-dl-item"><span>${esc(i.label)}</span><span class="${i.status === 'done' ? 'lt-ok' : 'lt-error'}">${i.status === 'done' ? '✅' : '❌'} ${esc(i.error || 'Готово')}</span></div>`).join("");
  }

  try {
    const manifests = await invoke("lt_list_manifests");
    const m = el.querySelector("#lt-manifests");
    if (!manifests.length) { m.innerHTML = '<div class="lt-empty">Нет манифестов</div>'; return; }
    m.innerHTML = `<table class="lt-table"><thead><tr><th>Файл</th><th>Depot</th><th>Размер</th><th>Дата</th></tr></thead><tbody>
      ${manifests.slice(0, 50).map(m => `<tr><td><code>${esc(m.name)}</code></td><td>${m.depot_id}</td><td>${fmtSize(m.size)}</td><td>${fmtDate(m.modified)}</td></tr>`).join("")}</tbody></table>
      ${manifests.length > 50 ? `<div class="lt-muted">…и ещё ${manifests.length - 50}</div>` : ''}`;
  } catch (e) { el.querySelector("#lt-manifests").innerHTML = `<div class="lt-error">${esc(e.message)}</div>`; }
}

// ══════════════════════════════════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════════════════════════════════

function renderSettings(el) {
  el.innerHTML = `<h2 class="lt-page-title">Настройки</h2>
    <div class="lt-settings-list">
      <div class="lt-info-row"><strong>Steam:</strong> ${steamInfo?.path ? esc(steamInfo.path) : '<span class="lt-error">Не найден</span>'}</div>
      <div class="lt-info-row"><strong>stplug-in:</strong> ${steamInfo?.stplugin_dir ? `<code>${esc(steamInfo.stplugin_dir)}</code>` : '—'}</div>
      <div class="lt-info-row"><strong>depotcache:</strong> ${steamInfo?.depotcache_dir ? `<code>${esc(steamInfo.depotcache_dir)}</code>` : '—'}</div>
      <div class="lt-info-row"><strong>Steam запущен:</strong> ${steamInfo?.running ? '<span class="lt-warn">Да</span>' : '<span class="lt-ok">Нет</span>'}</div>
    </div>
    <div class="lt-section"><h3>Аккаунт lua.tools</h3><div class="lt-auth-area"></div></div>
    <div class="lt-section"><h3>Данные</h3>
      <button class="lt-btn lt-btn-sm" id="lt-reset-onboard">Сбросить onboarding</button>
    </div>`;
  updateAuthUI();
  el.querySelector("#lt-reset-onboard")?.addEventListener("click", () => { try { localStorage.removeItem("lt_onboarded"); } catch {} toast("Onboarding сброшен", "ok"); });
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

    el.innerHTML = `
      <button class="lt-btn lt-btn-sm" id="lt-back-btn">← Назад</button>
      <div class="lt-detail" style="margin-top:12px">
        <div class="lt-detail-header">
          <img src="${esc(img)}" class="lt-detail-img" alt="">
          <div class="lt-detail-meta">
            <h3>${esc(name)}</h3><span class="lt-card-id">AppID: ${appId}</span>
            ${gameInfo.installed ? `<div class="lt-ok" style="margin-top:6px">📂 ${esc(gameInfo.path)}${gameInfo.size_on_disk ? ` · ${fmtSize(gameInfo.size_on_disk)}` : ''}</div>` : '<div class="lt-muted" style="margin-top:6px">Не установлена на диск</div>'}
            ${luaInfo ? `<div class="lt-ok" style="margin-top:4px">✅ ${luaInfo.depotCount} депо, ${luaInfo.dlcCount} DLC${luaInfo.hasActivePins ? " · Закреплено" : " · Авто-обновление"}</div>` : '<div class="lt-muted" style="margin-top:4px">Lua не установлен</div>'}
          </div>
        </div>

        <div class="lt-detail-sources">
          <h4>Источники${sourceList.length ? ` (${sourceList.length})` : ""}</h4>
          ${sourceList.length ? sourceList.map(s => `<button class="lt-btn lt-btn-primary lt-btn-sm" data-dl-source="${esc(s)}" data-appid="${appId}" data-game-name="${esc(name)}">📥 ${esc(s)}</button>`).join(" ") : '<span class="lt-muted">Нет</span>'}
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

        ${luaInfo ? renderLuaEntries(luaInfo, appId) : ""}
      </div>`;

    el.querySelector("#lt-save-var-btn")?.addEventListener("click", async () => {
      const n = el.querySelector("#lt-save-var-name").value.trim();
      if (!n) { toast("Введите имя", "warn"); return; }
      await invoke("lt_save_variant", { appId, name: n });
      toast(`Вариант «${n}» сохранён`, "ok");
      openDetail(appId);
    });
    el.querySelectorAll(".lt-var-load-d").forEach(b => b.addEventListener("click", async () => {
      await invoke("lt_load_variant", { appId, name: b.dataset.vn });
      toast(`Загружен: ${b.dataset.vn}`, "ok");
      openDetail(appId);
    }));
  } catch (e) { el.innerHTML = `<button class="lt-btn lt-btn-sm" id="lt-back-btn">← Назад</button><div class="lt-error" style="margin-top:12px">${esc(e.message)}</div>`; }
}

function renderLuaEntries(lua, appId) {
  const all = [...lua.entries.map(e => ({ ...e, disabled: false })), ...lua.disabledEntries.map(e => ({ ...e, disabled: true }))];
  if (!all.length) return "";
  return `<div class="lt-entries"><h4>Содержимое lua (${all.length})</h4>
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
    }).join("")}</tbody></table></div>`;
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
    document.body.appendChild(overlay);
    overlay.querySelector(".lt-confirm-yes").addEventListener("click", () => { overlay.remove(); resolve(true); });
    overlay.querySelector(".lt-confirm-no").addEventListener("click", () => { overlay.remove(); resolve(false); });
  });
}

async function doDownload(appId, source, gameName) {
  if (!ltIsLoggedIn()) { toast("Войдите в lua.tools", "warn"); return; }
  const item = queueAdd(`${gameName || appId} (${source})`, appId);
  if (currentPage === "downloads") renderPage("downloads");
  const url = ltManifestDownloadUrl(appId, source, gameName);
  toast("Скачиваю…", "info");
  try {
    const filePath = await invoke("lt_download", { url, token: ltSession()?.access_token, destDir: await getTmpDir() });
    item.progress = 50;
    toast("Устанавливаю…", "info");
    const result = await invoke("lt_install_file", { path: filePath, appId, autoUpdate: true });
    const parts = [];
    if (result.lua_installed) parts.push("lua");
    if (result.manifest_count) parts.push(`${result.manifest_count} манифестов`);
    if (result.failed.length) parts.push(`ошибки: ${result.failed.join(", ")}`);
    queueDone(item, true);
    toast(parts.join(", ") || "Готово", result.failed.length ? "warn" : "ok");
    installedList = await invoke("lt_list_installed");
    openDetail(appId);
  } catch (e) {
    queueDone(item, false, e.message || String(e));
    toast(`Ошибка: ${e.message || e}`, "error");
  }
}

async function doRemove(appId) {
  if (!await confirmAction(`Удалить lua для ${appId}?`)) return;
  try {
    await invoke("lt_remove_lua", { appId });
    toast(`${appId} удалён`, "ok");
    installedList = await invoke("lt_list_installed");
    renderPage(currentPage);
  } catch (e) { toast(e.message || String(e), "error"); }
}

async function doToggleLock(appId, depotId, lock) {
  try {
    let text = await invoke("lt_read_lua", { appId });
    text = setDepotLocked(text, depotId, !lock);
    await invoke("lt_write_lua", { appId, content: text });
    toast(lock ? `${depotId} откреплён` : `${depotId} закреплён`, "ok");
    openDetail(appId);
  } catch (e) { toast(e.message, "error"); }
}

async function doToggleEnable(appId, depotId, enable) {
  try {
    let text = await invoke("lt_read_lua", { appId });
    text = setDepotEnabled(text, depotId, enable);
    await invoke("lt_write_lua", { appId, content: text });
    toast(enable ? `${depotId} включён` : `${depotId} отключён`, "ok");
    openDetail(appId);
  } catch (e) { toast(e.message, "error"); }
}

async function doRestartSteam() {
  if (!await confirmAction("Перезапустить Steam?")) return;
  toast("Перезапускаю…", "info");
  try { await invoke("lt_restart_steam"); toast("Steam перезапущен", "ok"); } catch (e) { toast(e.message, "error"); }
}

async function getTmpDir() {
  try { const info = await invoke("lt_steam_info"); if (info?.path) return info.path + "\\config\\luatools_tmp"; } catch {}
  return (await import("@tauri-apps/api/path").then(m => m.tempDir())) + "luatools";
}

function doLogin() {
  window.open(ltLoginUrl(), "_blank", "width=500,height=700");
  toast("Войдите через Discord", "info");
}

window.__ltSetSession = (data) => { ltSaveSession(data); updateAuthUI(); toast("Вошли в lua.tools", "ok"); };
