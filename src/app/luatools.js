// LuaTools — каталог Steam-игр + загрузчик манифестов.
// Полная интеграция: Главная, Добавить, Управление, Инструменты, Режим, Фиксы, Плагин.

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

let loaded = false;
let steamInfo = null;
let installedList = [];
let pluginStatus = null;
let currentPage = "home";

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

// ── Shell with sidebar ─────────────────────────────────────────────

function shell() {
  return `
<div class="lt-shell">
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
  <main class="lt-main">
    <div class="lt-page-content" id="lt-page-content"></div>
  </main>
</div>`;
}

function attachGlobal(body) {
  body.addEventListener("click", e => {
    const nav = e.target.closest(".lt-nav[data-page]");
    if (nav) {
      switchPage(nav.dataset.page);
      return;
    }
    if (e.target.closest("#lt-restart-steam")) {
      doRestartSteam();
      return;
    }
    const card = e.target.closest("[data-appid]");
    if (card && !e.target.closest("[data-dl-source]") && !e.target.closest("[data-remove-appid]")) {
      openDetail(parseInt(card.dataset.appid, 10));
      return;
    }
    if (e.target.closest("#lt-login-btn")) doLogin();
    if (e.target.closest("#lt-logout-btn")) { ltClearSession(); updateAuthUI(); }

    const dl = e.target.closest("[data-dl-source]");
    if (dl) doDownload(parseInt(dl.dataset.appid, 10), dl.dataset.dlSource, dl.dataset.gameName || "");

    const rm = e.target.closest("[data-remove-appid]");
    if (rm) { e.stopPropagation(); doRemove(parseInt(rm.dataset.removeAppid, 10)); }

    const lockBtn = e.target.closest("[data-lock-depot]");
    if (lockBtn) doToggleLock(parseInt(lockBtn.dataset.lockAppid, 10), parseInt(lockBtn.dataset.lockDepot, 10), lockBtn.dataset.lockAction === "lock");

    const enableBtn = e.target.closest("[data-enable-depot]");
    if (enableBtn) doToggleEnable(parseInt(enableBtn.dataset.enableAppid, 10), parseInt(enableBtn.dataset.enableDepot, 10), enableBtn.dataset.enableAction === "enable");

    if (e.target.closest("#lt-back-btn")) switchPage("home");
  });
}

function switchPage(page) {
  currentPage = page;
  const body = $("#luatools-body");
  body.querySelectorAll(".lt-nav[data-page]").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  renderPage(page);
}

async function renderPage(page) {
  const el = $("#lt-page-content");
  if (!el) return;
  switch (page) {
    case "home": return renderHome(el);
    case "add": return renderAdd(el);
    case "manage": return renderManage(el);
    case "tools": return renderTools(el);
    case "mode": return renderMode(el);
    case "fixes": return renderFixes(el);
    case "plugin": return renderPlugin(el);
    case "downloads": return renderDownloads(el);
    case "settings": return renderSettings(el);
    case "detail": return; // handled by openDetail
  }
}

// ── Refresh all data ───────────────────────────────────────────────

async function refreshAll(body) {
  try { steamInfo = await invoke("lt_steam_info"); } catch { steamInfo = null; }
  try { pluginStatus = await invoke("lt_plugin_status"); } catch { pluginStatus = null; }
  try { installedList = await invoke("lt_list_installed"); } catch { installedList = []; }
  updateAuthUI();
  const ver = body.querySelector("#lt-sidebar-ver");
  if (ver) ver.textContent = pluginStatus?.installed ? `v${pluginStatus.version || "?"}` : "";
  renderPage(currentPage);
}

function updateAuthUI() {
  const el = $("#lt-auth-area");
  if (!el) return;
  if (ltIsLoggedIn()) {
    const user = ltSession()?.user;
    el.innerHTML = `<span class="lt-user">👤 ${esc(user?.user_metadata?.full_name || user?.email || "logged in")}</span> <button id="lt-logout-btn" class="lt-btn lt-btn-sm">Выйти</button>`;
  } else {
    el.innerHTML = `<button id="lt-login-btn" class="lt-btn lt-btn-primary lt-btn-sm">Войти в lua.tools</button>`;
  }
}

// ══════════════════════════════════════════════════════════════════
// ── HOME PAGE ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

async function renderHome(el) {
  const steamOk = !!steamInfo?.path;
  const pluginOk = pluginStatus?.installed;
  const mode = pluginStatus?.mode || "—";
  const luaCount = installedList.length;

  el.innerHTML = `
    <h2 class="lt-page-title">Добро пожаловать в LuaTools</h2>
    <div class="lt-home-stats">
      <div class="lt-stat-card">
        <span class="lt-stat-num">${luaCount}</span>
        <span class="lt-stat-label">Lua на борту</span>
      </div>
      <div class="lt-stat-card">
        <span class="lt-stat-label">Статус плагина</span>
        <span class="${pluginOk ? 'lt-ok' : 'lt-error'}">${pluginOk ? `Установлено` : 'Не установлен'}</span>
        ${pluginStatus?.version ? `<span class="lt-ok" style="font-size:.85rem"> · v${esc(pluginStatus.version)}</span>` : ''}
      </div>
    </div>

    <div class="lt-home-info">
      <div class="lt-info-row">${steamOk ? `<span class="lt-ok">✅ Steam обнаружен · ${esc(steamInfo.path)}</span>` : '<span class="lt-error">❌ Steam не найден</span>'}</div>
      <div class="lt-info-row" id="lt-auth-area"></div>
      <div class="lt-info-row">${pluginOk ? `<span>⚙ Режим · ${esc(mode)}</span>` : ''}</div>
    </div>

    <div class="lt-drop-zone" id="lt-drop-home">
      <div class="lt-drop-inner">
        <span class="lt-drop-icon">📥</span>
        <div>Перетащите сюда файлы .lua, .manifest или .zip</div>
        <div class="lt-muted">…или перетащите сюда ссылку SteamDB / магазина Steam, чтобы добавить эту игру.</div>
        <button class="lt-btn lt-btn-sm" id="lt-browse-home">📂 Обзор файлов…</button>
      </div>
    </div>

    <section class="lt-section" id="lt-recent-section">
      <h3>Недавно добавленные</h3>
      <div class="lt-grid" id="lt-recent-grid"></div>
    </section>
  `;

  updateAuthUI();
  renderRecentCards();
  loadFeaturedStrip();
}

function renderRecentCards() {
  const grid = $("#lt-recent-grid");
  if (!grid) return;
  if (!installedList.length) {
    grid.innerHTML = '<div class="lt-empty">Пока ничего не установлено</div>';
    return;
  }
  grid.innerHTML = installedList.slice(0, 8).map(i => `
    <button class="lt-card" data-appid="${i.app_id}">
      <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${i.app_id}/header.jpg" alt="" loading="lazy">
      <div class="lt-card-info">
        <span class="lt-card-name">${i.app_id}</span>
        <span class="lt-card-date">${new Date(i.modified * 1000).toLocaleDateString()}</span>
      </div>
    </button>`).join("");
}

async function loadFeaturedStrip() {
  try {
    const { topSellers } = await ltFeatured();
    if (!topSellers.length) return;
    const section = $("#lt-recent-section");
    if (!section) return;
    section.insertAdjacentHTML("afterend", `
      <section class="lt-section">
        <h3>Популярное в Steam</h3>
        <div class="lt-grid lt-grid-featured">${topSellers.slice(0, 6).map(i => `
          <button class="lt-card lt-card-featured" data-appid="${i.appId}">
            <img src="${esc(i.image)}" alt="" loading="lazy">
            <div class="lt-card-info">
              <span class="lt-card-name">${esc(i.name)}</span>
              ${i.discount ? `<span class="lt-discount">-${i.discount}%</span>` : ""}
            </div>
          </button>`).join("")}
        </div>
      </section>`);
  } catch { /* non-critical */ }
}

// ══════════════════════════════════════════════════════════════════
// ── ADD PAGE ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function renderAdd(el) {
  el.innerHTML = `
    <h2 class="lt-page-title">Добавить</h2>
    <div class="lt-search-bar">
      <input type="text" id="lt-search" class="lt-input" placeholder="Поиск игры по названию или AppID…">
      <button id="lt-search-btn" class="lt-btn lt-btn-primary">Найти</button>
    </div>
    <div id="lt-results" class="lt-results"></div>
    <div id="lt-detail" class="lt-detail" hidden></div>
    <div class="lt-drop-zone" id="lt-drop-add" style="margin-top:20px">
      <div class="lt-drop-inner">
        <span class="lt-drop-icon">📥</span>
        <div>Перетащите сюда файлы .lua, .manifest или .zip</div>
        <button class="lt-btn lt-btn-sm" id="lt-browse-add">📂 Обзор файлов…</button>
      </div>
    </div>
  `;

  const input = el.querySelector("#lt-search");
  const btn = el.querySelector("#lt-search-btn");
  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) return;
    const results = el.querySelector("#lt-results");
    results.innerHTML = '<div class="lt-loading">Ищу…</div>';
    try {
      const items = /^\d+$/.test(q)
        ? [await ltGameDetails(q)].filter(Boolean).map(d => ({ appId: parseInt(q), name: d.name, icon: d.header_image }))
        : await ltSearchSteam(q);
      if (!items.length) { results.innerHTML = '<div class="lt-empty">Ничего не нашлось</div>'; return; }
      results.innerHTML = items.map(i => `
        <button class="lt-card lt-card-search" data-appid="${i.appId}">
          <img src="${esc(i.icon)}" alt="" loading="lazy">
          <div class="lt-card-info">
            <span class="lt-card-name">${esc(i.name)}</span>
            <span class="lt-card-id">${i.appId}</span>
          </div>
        </button>`).join("");
    } catch (e) { results.innerHTML = `<div class="lt-error">${esc(e.message)}</div>`; }
  };
  btn.addEventListener("click", doSearch);
  input.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); });
}

// ══════════════════════════════════════════════════════════════════
// ── MANAGE PAGE ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

async function renderManage(el) {
  el.innerHTML = '<div class="lt-loading">Загружаю…</div>';
  try { installedList = await invoke("lt_list_installed"); } catch { installedList = []; }

  if (!installedList.length) {
    el.innerHTML = '<h2 class="lt-page-title">Управление</h2><div class="lt-empty">Нет установленных lua-файлов</div>';
    return;
  }
  el.innerHTML = `
    <h2 class="lt-page-title">Управление</h2>
    <p class="lt-muted">${installedList.length} файлов установлено</p>
    <div class="lt-manage-list">${installedList.map(i => `
      <div class="lt-manage-item" data-appid="${i.app_id}">
        <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${i.app_id}/capsule_sm_120.jpg" alt="" loading="lazy">
        <div class="lt-manage-info">
          <span class="lt-card-name">${i.app_id}</span>
          <span class="lt-card-date">${new Date(i.modified * 1000).toLocaleDateString()}</span>
        </div>
        <div class="lt-manage-actions">
          <button class="lt-btn lt-btn-sm" data-appid="${i.app_id}">Открыть</button>
          <button class="lt-btn lt-btn-danger lt-btn-sm" data-remove-appid="${i.app_id}">Удалить</button>
        </div>
      </div>`).join("")}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════
// ── TOOLS PAGE ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

async function renderTools(el) {
  el.innerHTML = `
    <h2 class="lt-page-title">Инструменты</h2>
    <div class="lt-tools-grid">
      <div class="lt-tool-card" id="lt-tool-dlc">
        <h3>🎮 DLC Генератор</h3>
        <p class="lt-muted">Генерация DLC-записей для игры</p>
        <div class="lt-tool-form">
          <input type="text" class="lt-input" id="lt-dlc-appid" placeholder="AppID игры">
          <button class="lt-btn lt-btn-primary" id="lt-dlc-gen-btn">Сгенерировать</button>
        </div>
        <div id="lt-dlc-result"></div>
      </div>
      <div class="lt-tool-card" id="lt-tool-usage">
        <h3>📊 Лимиты</h3>
        <p class="lt-muted">Использование API за сегодня</p>
        <div id="lt-usage-info" class="lt-loading">Загружаю…</div>
      </div>
    </div>
  `;

  el.querySelector("#lt-dlc-gen-btn").addEventListener("click", async () => {
    const appId = el.querySelector("#lt-dlc-appid").value.trim();
    if (!appId) return;
    const res = el.querySelector("#lt-dlc-result");
    if (!ltIsLoggedIn()) { res.innerHTML = '<span class="lt-warn">Войдите в lua.tools</span>'; return; }
    res.innerHTML = '<div class="lt-loading">Генерирую…</div>';
    try {
      const url = ltDlcGenerateUrl(appId, appId, "");
      const token = ltSession()?.access_token;
      const filePath = await invoke("lt_download", { url, token, destDir: await getTmpDir() });
      await invoke("lt_install_file", { path: filePath, appId: parseInt(appId), autoUpdate: false });
      res.innerHTML = '<span class="lt-ok">✅ DLC установлены</span>';
    } catch (e) { res.innerHTML = `<span class="lt-error">${esc(e.message)}</span>`; }
  });

  if (ltIsLoggedIn()) {
    const usage = await ltUsage();
    const uEl = el.querySelector("#lt-usage-info");
    if (usage) {
      uEl.innerHTML = `<div class="lt-usage-bar"><div class="lt-usage-fill" style="width:${Math.min(100, usage.used / usage.limit * 100)}%"></div></div>
        <span>${usage.used} / ${usage.limit} загрузок сегодня</span>`;
    } else { uEl.innerHTML = '<span class="lt-muted">Нет данных</span>'; }
  } else {
    const uEl = el.querySelector("#lt-usage-info");
    uEl.innerHTML = '<span class="lt-warn">Войдите для просмотра</span>';
  }
}

// ══════════════════════════════════════════════════════════════════
// ── MODE PAGE ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function renderMode(el) {
  const current = pluginStatus?.mode || "Не определён";
  el.innerHTML = `
    <h2 class="lt-page-title">Режим</h2>
    <div class="lt-mode-current">
      <span>Текущий режим:</span>
      <strong class="lt-ok">${esc(current)}</strong>
    </div>
    <div class="lt-mode-list">
      <div class="lt-mode-option ${current === 'BetterSteamTools' ? 'lt-mode-active' : ''}">
        <h3>BetterSteamTools</h3>
        <p class="lt-muted">Современный вариант с расширенной поддержкой</p>
      </div>
      <div class="lt-mode-option ${current === 'stplug-in' ? 'lt-mode-active' : ''}">
        <h3>stplug-in</h3>
        <p class="lt-muted">Классический режим через stplug-in.dll</p>
      </div>
    </div>
    <p class="lt-muted" style="margin-top:16px">Переключение режима требует ручной замены DLL. В будущем это будет автоматизировано.</p>
  `;
}

// ══════════════════════════════════════════════════════════════════
// ── FIXES PAGE ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

async function renderFixes(el) {
  el.innerHTML = `
    <h2 class="lt-page-title">Фиксы</h2>
    <p class="lt-muted">Denuvo-фиксы из базы lua.tools</p>
    <div id="lt-fixes-list" class="lt-loading">Загружаю…</div>
  `;
  try {
    const listings = await ltDenuvoListings();
    const container = el.querySelector("#lt-fixes-list");
    if (!listings?.length) {
      container.innerHTML = '<div class="lt-empty">Нет доступных фиксов</div>';
      return;
    }
    container.innerHTML = `<div class="lt-grid">${listings.map(g => `
      <button class="lt-card" data-appid="${g.appid || g.appId || 0}">
        <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid || g.appId || 0}/capsule_sm_120.jpg" alt="" loading="lazy">
        <div class="lt-card-info">
          <span class="lt-card-name">${esc(g.name || g.game || `App ${g.appid}`)}</span>
          <span class="lt-card-id">${g.appid || g.appId || ""}</span>
        </div>
      </button>`).join("")}</div>`;
  } catch (e) {
    el.querySelector("#lt-fixes-list").innerHTML = `<div class="lt-error">${esc(e.message)}</div>`;
  }
}

// ══════════════════════════════════════════════════════════════════
// ── PLUGIN PAGE ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function renderPlugin(el) {
  const ps = pluginStatus;
  el.innerHTML = `
    <h2 class="lt-page-title">Плагин</h2>
    <div class="lt-plugin-info">
      <div class="lt-info-row"><strong>Статус:</strong> ${ps?.installed ? '<span class="lt-ok">Установлен</span>' : '<span class="lt-error">Не установлен</span>'}</div>
      ${ps?.mode ? `<div class="lt-info-row"><strong>Тип:</strong> ${esc(ps.mode)}</div>` : ''}
      ${ps?.version ? `<div class="lt-info-row"><strong>Версия:</strong> ${esc(ps.version)}</div>` : ''}
      ${ps?.dll_path ? `<div class="lt-info-row"><strong>Путь:</strong> <code>${esc(ps.dll_path)}</code></div>` : ''}
    </div>
    ${!ps?.installed ? '<p class="lt-warn" style="margin-top:16px">Плагин не обнаружен. Установите stplug-in или BetterSteamTools для работы с lua-файлами.</p>' : ''}
  `;
}

// ══════════════════════════════════════════════════════════════════
// ── DOWNLOADS PAGE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

async function renderDownloads(el) {
  el.innerHTML = `
    <h2 class="lt-page-title">Загрузки</h2>
    <h3>Установленные манифесты</h3>
    <div id="lt-manifests" class="lt-loading">Загружаю…</div>
  `;
  try {
    const manifests = await invoke("lt_list_manifests");
    const mEl = el.querySelector("#lt-manifests");
    if (!manifests.length) {
      mEl.innerHTML = '<div class="lt-empty">Нет манифестов в depotcache</div>';
      return;
    }
    mEl.innerHTML = `<table class="lt-table"><thead><tr><th>Файл</th><th>Depot</th><th>Размер</th><th>Дата</th></tr></thead><tbody>
      ${manifests.slice(0, 100).map(m => `<tr>
        <td><code>${esc(m.name)}</code></td>
        <td>${m.depot_id}</td>
        <td>${(m.size / 1024).toFixed(1)} KB</td>
        <td>${new Date(m.modified * 1000).toLocaleDateString()}</td>
      </tr>`).join("")}
    </tbody></table>
    ${manifests.length > 100 ? `<div class="lt-muted">…и ещё ${manifests.length - 100}</div>` : ''}`;
  } catch (e) {
    el.querySelector("#lt-manifests").innerHTML = `<div class="lt-error">${esc(e.message)}</div>`;
  }
}

// ══════════════════════════════════════════════════════════════════
// ── SETTINGS PAGE ────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function renderSettings(el) {
  el.innerHTML = `
    <h2 class="lt-page-title">Настройки</h2>
    <div class="lt-settings-list">
      <div class="lt-info-row"><strong>Steam:</strong> ${steamInfo?.path ? esc(steamInfo.path) : '<span class="lt-error">Не найден</span>'}</div>
      <div class="lt-info-row"><strong>stplug-in:</strong> ${steamInfo?.stplugin_dir ? `<code>${esc(steamInfo.stplugin_dir)}</code>` : '—'}</div>
      <div class="lt-info-row"><strong>depotcache:</strong> ${steamInfo?.depotcache_dir ? `<code>${esc(steamInfo.depotcache_dir)}</code>` : '—'}</div>
      <div class="lt-info-row"><strong>Steam запущен:</strong> ${steamInfo?.running ? '<span class="lt-warn">Да</span>' : '<span class="lt-ok">Нет</span>'}</div>
    </div>
    <div style="margin-top:20px" id="lt-auth-area"></div>
  `;
  updateAuthUI();
}

// ══════════════════════════════════════════════════════════════════
// ── DETAIL VIEW ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

async function openDetail(appId) {
  currentPage = "detail";
  const el = $("#lt-page-content");
  if (!el) return;
  el.innerHTML = '<div class="lt-loading">Загружаю…</div>';

  try {
    const [details, sources] = await Promise.all([
      ltGameDetails(String(appId)),
      ltCheckSources(String(appId)),
    ]);

    let luaText = null;
    let luaInfo = null;
    try {
      luaText = await invoke("lt_read_lua", { appId });
      luaInfo = parseLua(luaText, appId);
    } catch { /* not installed */ }

    const name = details?.name || `App ${appId}`;
    const img = details?.header_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

    const sourceList = Object.entries(sources)
      .filter(([, v]) => v === "available")
      .map(([k]) => k);

    el.innerHTML = `
      <button class="lt-btn lt-btn-sm" id="lt-back-btn">← Назад</button>
      <div class="lt-detail" style="margin-top:12px">
        <div class="lt-detail-header">
          <img src="${esc(img)}" class="lt-detail-img" alt="">
          <div class="lt-detail-meta">
            <h3>${esc(name)}</h3>
            <span class="lt-card-id">AppID: ${appId}</span>
            ${luaInfo ? `<div class="lt-ok" style="margin-top:8px">Установлено: ${luaInfo.depotCount} депо, ${luaInfo.dlcCount} DLC${luaInfo.hasActivePins ? " (закреплено)" : ""}</div>` : '<div class="lt-muted" style="margin-top:8px">Не установлено</div>'}
          </div>
        </div>
        <div class="lt-detail-sources">
          <h4>Источники${sourceList.length ? ` (${sourceList.length})` : ""}</h4>
          ${sourceList.length
            ? sourceList.map(s => `<button class="lt-btn lt-btn-primary" data-dl-source="${esc(s)}" data-appid="${appId}" data-game-name="${esc(name)}">📥 ${esc(s)}</button>`).join(" ")
            : '<span class="lt-muted">Нет доступных источников</span>'}
        </div>
        ${luaInfo ? renderLuaEntries(luaInfo, appId) : ""}
      </div>
    `;
  } catch (e) {
    el.innerHTML = `<button class="lt-btn lt-btn-sm" id="lt-back-btn">← Назад</button><div class="lt-error" style="margin-top:12px">${esc(e.message)}</div>`;
  }
}

function renderLuaEntries(lua, appId) {
  if (!lua.entries.length && !lua.disabledEntries.length) return "";
  const all = [...lua.entries.map(e => ({ ...e, disabled: false })), ...lua.disabledEntries.map(e => ({ ...e, disabled: true }))];
  return `<div class="lt-entries">
    <h4>Содержимое lua (${all.length})</h4>
    <table class="lt-table"><thead><tr><th>ID</th><th>Тип</th><th>Комментарий</th><th>Манифест</th><th>Действия</th></tr></thead><tbody>
    ${all.map(e => {
      const isDepot = e.hasKey;
      const hasMf = e.manifestId || e.commentedManifestId;
      return `<tr class="${e.disabled ? 'lt-row-disabled' : ''}">
        <td>${e.id}</td>
        <td>${isDepot ? "Депо" : (e.id === lua.baseAppId ? "Base" : "DLC")}</td>
        <td>${esc(e.comment || "")}</td>
        <td>${e.manifestId ? `<code>${e.manifestId}</code>` : (e.commentedManifestId ? `<code class="lt-muted">${e.commentedManifestId}</code>` : "—")}</td>
        <td>
          ${!e.disabled
            ? `<button class="lt-btn lt-btn-sm lt-btn-danger" data-enable-depot="${e.id}" data-enable-appid="${appId}" data-enable-action="disable" title="Отключить">⊘</button>`
            : `<button class="lt-btn lt-btn-sm lt-ok" data-enable-depot="${e.id}" data-enable-appid="${appId}" data-enable-action="enable" title="Включить">✓</button>`}
          ${hasMf && !e.disabled ? (e.manifestId
            ? `<button class="lt-btn lt-btn-sm" data-lock-depot="${e.id}" data-lock-appid="${appId}" data-lock-action="unlock" title="Открепить манифест">🔓</button>`
            : `<button class="lt-btn lt-btn-sm" data-lock-depot="${e.id}" data-lock-appid="${appId}" data-lock-action="lock" title="Закрепить манифест">🔒</button>`)
          : ''}
        </td>
      </tr>`;
    }).join("")}
    </tbody></table>
  </div>`;
}

// ── Actions ────────────────────────────────────────────────────────

async function doDownload(appId, source, gameName) {
  if (!ltIsLoggedIn()) { toast("Войдите в lua.tools для скачивания", "warn"); return; }
  const url = ltManifestDownloadUrl(appId, source, gameName);
  const token = ltSession()?.access_token;
  const tmpDir = await getTmpDir();
  toast("Скачиваю…", "info");
  try {
    const filePath = await invoke("lt_download", { url, token, destDir: tmpDir });
    toast("Устанавливаю…", "info");
    const result = await invoke("lt_install_file", { path: filePath, appId, autoUpdate: true });
    const parts = [];
    if (result.lua_installed) parts.push("lua установлен");
    if (result.manifest_count) parts.push(`${result.manifest_count} манифестов`);
    if (result.failed.length) parts.push(`ошибки: ${result.failed.join(", ")}`);
    toast(parts.join(", ") || "Готово", result.failed.length ? "warn" : "ok");
    installedList = await invoke("lt_list_installed");
    openDetail(appId);
  } catch (e) {
    toast(`Ошибка: ${e.message || e}`, "error");
  }
}

async function doRemove(appId) {
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
    toast(lock ? `Манифест ${depotId} откреплён` : `Манифест ${depotId} закреплён`, "ok");
    openDetail(appId);
  } catch (e) { toast(e.message || String(e), "error"); }
}

async function doToggleEnable(appId, depotId, enable) {
  try {
    let text = await invoke("lt_read_lua", { appId });
    text = setDepotEnabled(text, depotId, enable);
    await invoke("lt_write_lua", { appId, content: text });
    toast(enable ? `${depotId} включён` : `${depotId} отключён`, "ok");
    openDetail(appId);
  } catch (e) { toast(e.message || String(e), "error"); }
}

async function doRestartSteam() {
  toast("Перезапускаю Steam…", "info");
  try {
    await invoke("lt_restart_steam");
    toast("Steam перезапущен", "ok");
  } catch (e) { toast(e.message || String(e), "error"); }
}

async function getTmpDir() {
  try {
    const info = await invoke("lt_steam_info");
    if (info?.path) return info.path + "\\config\\luatools_tmp";
  } catch { /* fallback */ }
  return (await import("@tauri-apps/api/path").then(m => m.tempDir())) + "luatools";
}

function doLogin() {
  const url = ltLoginUrl();
  window.open(url, "_blank", "width=500,height=700");
  toast("Войдите через Discord в открывшемся окне", "info");
}

window.__ltSetSession = (data) => {
  ltSaveSession(data);
  updateAuthUI();
  toast("Вошли в lua.tools", "ok");
};
