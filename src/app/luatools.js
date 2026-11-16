// LuaTools — каталог Steam-игр + загрузчик манифестов.
// Вкладка «LuaTools» в навигации project-desktop.

import { invoke } from "./tauri.js";
import { $ } from "./utils.js";
import { toast } from "./api.js";
import {
  ltSearchSteam, ltFeatured, ltCheckSources, ltGameDetails,
  ltIsLoggedIn, ltSession, ltLoginUrl, ltSaveSession, ltClearSession,
  ltManifestDownloadUrl, ltUsage,
} from "./luatools-api.js";
import { parseLua } from "./luatools-parser.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let loaded = false;
let steamInfo = null;
let installedList = [];

export async function loadLuatools() {
  const body = $("#luatools-body");
  if (!body) return;

  if (!loaded) {
    body.innerHTML = skeleton();
    attachHandlers(body);
    loaded = true;
  }
  await refresh(body);
}

function skeleton() {
  return `
<div class="lt-page">
  <div class="lt-header">
    <h2 class="lt-title">LuaTools</h2>
    <div class="lt-auth" id="lt-auth"></div>
  </div>

  <div class="lt-search-bar">
    <input type="text" id="lt-search" class="lt-input" placeholder="Поиск игры по названию или AppID…">
    <button id="lt-search-btn" class="lt-btn lt-btn-primary">Найти</button>
  </div>

  <div id="lt-steam-status" class="lt-status"></div>

  <div id="lt-results" class="lt-results"></div>

  <div id="lt-detail" class="lt-detail" hidden></div>

  <section class="lt-section" id="lt-featured-section">
    <h3>Популярное</h3>
    <div class="lt-grid" id="lt-featured"></div>
  </section>

  <section class="lt-section" id="lt-installed-section">
    <h3>Установленные</h3>
    <div class="lt-grid" id="lt-installed"></div>
  </section>
</div>`;
}

function attachHandlers(body) {
  const input = body.querySelector("#lt-search");
  const btn = body.querySelector("#lt-search-btn");

  const doSearch = async () => {
    const q = input.value.trim();
    if (!q) return;
    const results = body.querySelector("#lt-results");
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

  body.addEventListener("click", e => {
    const card = e.target.closest("[data-appid]");
    if (card) openDetail(parseInt(card.dataset.appid, 10));

    if (e.target.closest("#lt-login-btn")) doLogin();
    if (e.target.closest("#lt-logout-btn")) { ltClearSession(); updateAuth(body); }

    const dl = e.target.closest("[data-dl-source]");
    if (dl) doDownload(parseInt(dl.dataset.appid, 10), dl.dataset.dlSource, dl.dataset.gameName || "");

    const rm = e.target.closest("[data-remove-appid]");
    if (rm) doRemove(parseInt(rm.dataset.removeAppid, 10));
  });
}

async function refresh(body) {
  try { steamInfo = await invoke("lt_steam_info"); } catch { steamInfo = null; }
  const statusEl = body.querySelector("#lt-steam-status");
  if (steamInfo?.path) {
    statusEl.innerHTML = `<span class="lt-ok">Steam: ${esc(steamInfo.path)}</span>${steamInfo.running ? ' <span class="lt-warn">(запущен)</span>' : ""}`;
  } else {
    statusEl.innerHTML = '<span class="lt-error">Steam не найден</span>';
  }

  updateAuth(body);
  await loadInstalled(body);
  loadFeaturedStrip(body);
}

function updateAuth(body) {
  const el = body.querySelector("#lt-auth");
  if (ltIsLoggedIn()) {
    const user = ltSession()?.user;
    el.innerHTML = `<span class="lt-user">${esc(user?.email || "logged in")}</span> <button id="lt-logout-btn" class="lt-btn lt-btn-sm">Выйти</button>`;
  } else {
    el.innerHTML = `<button id="lt-login-btn" class="lt-btn lt-btn-primary lt-btn-sm">Войти в lua.tools</button>`;
  }
}

async function loadInstalled(body) {
  const el = body.querySelector("#lt-installed");
  try {
    installedList = await invoke("lt_list_installed");
    if (!installedList.length) {
      el.innerHTML = '<div class="lt-empty">Пока ничего не установлено</div>';
      return;
    }
    el.innerHTML = installedList.map(i => `
      <div class="lt-card lt-card-installed" data-appid="${i.app_id}">
        <img src="https://cdn.cloudflare.steamstatic.com/steam/apps/${i.app_id}/capsule_sm_120.jpg" alt="" loading="lazy">
        <div class="lt-card-info">
          <span class="lt-card-id">${i.app_id}</span>
          <span class="lt-card-date">${new Date(i.modified * 1000).toLocaleDateString()}</span>
        </div>
        <button class="lt-btn lt-btn-danger lt-btn-sm" data-remove-appid="${i.app_id}" title="Удалить">✕</button>
      </div>`).join("");
  } catch (e) {
    el.innerHTML = `<div class="lt-error">${esc(e.message)}</div>`;
  }
}

async function loadFeaturedStrip(body) {
  const el = body.querySelector("#lt-featured");
  const { topSellers } = await ltFeatured();
  if (!topSellers.length) { el.innerHTML = ""; return; }
  el.innerHTML = topSellers.map(i => `
    <button class="lt-card lt-card-featured" data-appid="${i.appId}">
      <img src="${esc(i.image)}" alt="" loading="lazy">
      <div class="lt-card-info">
        <span class="lt-card-name">${esc(i.name)}</span>
        ${i.discount ? `<span class="lt-discount">-${i.discount}%</span>` : ""}
      </div>
    </button>`).join("");
}

async function openDetail(appId) {
  const el = $("#lt-detail");
  if (!el) return;
  el.hidden = false;
  el.innerHTML = '<div class="lt-loading">Загружаю…</div>';

  try {
    const [details, sources] = await Promise.all([
      ltGameDetails(String(appId)),
      ltCheckSources(String(appId)),
    ]);

    let luaInfo = null;
    try {
      const text = await invoke("lt_read_lua", { appId });
      luaInfo = parseLua(text, appId);
    } catch { /* not installed */ }

    const name = details?.name || `App ${appId}`;
    const img = details?.header_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;

    const sourceList = Object.entries(sources)
      .filter(([, v]) => v === "available")
      .map(([k]) => k);

    el.innerHTML = `
      <div class="lt-detail-header">
        <button class="lt-btn lt-btn-sm lt-back" onclick="document.getElementById('lt-detail').hidden=true">← Назад</button>
        <img src="${esc(img)}" class="lt-detail-img" alt="">
        <div class="lt-detail-meta">
          <h3>${esc(name)}</h3>
          <span class="lt-card-id">AppID: ${appId}</span>
          ${luaInfo ? `<span class="lt-ok">Установлено: ${luaInfo.depotCount} депо, ${luaInfo.dlcCount} DLC${luaInfo.hasActivePins ? " (закреплено)" : ""}</span>` : '<span class="lt-muted">Не установлено</span>'}
        </div>
      </div>
      <div class="lt-detail-sources">
        <h4>Источники${sourceList.length ? ` (${sourceList.length})` : ""}</h4>
        ${sourceList.length
          ? sourceList.map(s => `<button class="lt-btn lt-btn-primary" data-dl-source="${esc(s)}" data-appid="${appId}" data-game-name="${esc(name)}">Скачать из ${esc(s)}</button>`).join(" ")
          : '<span class="lt-muted">Нет доступных источников</span>'}
      </div>
      ${luaInfo ? renderLuaEntries(luaInfo) : ""}
    `;
  } catch (e) {
    el.innerHTML = `<div class="lt-error">${esc(e.message)}</div>`;
  }
}

function renderLuaEntries(lua) {
  if (!lua.entries.length) return "";
  return `<div class="lt-entries">
    <h4>Содержимое lua (${lua.entries.length})</h4>
    <table class="lt-table"><thead><tr><th>ID</th><th>Тип</th><th>Комментарий</th><th>Манифест</th></tr></thead><tbody>
    ${lua.entries.map(e => `<tr>
      <td>${e.id}</td>
      <td>${e.hasKey ? "Депо" : (e.id === lua.baseAppId ? "Base" : "DLC")}</td>
      <td>${esc(e.comment || "")}</td>
      <td>${e.manifestId ? `<code>${e.manifestId}</code>` : (e.commentedManifestId ? `<code class="lt-muted">${e.commentedManifestId}</code>` : "—")}</td>
    </tr>`).join("")}
    </tbody></table>
  </div>`;
}

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
    await loadInstalled($("#luatools-body"));
    openDetail(appId);
  } catch (e) {
    toast(`Ошибка: ${e.message || e}`, "error");
  }
}

async function doRemove(appId) {
  try {
    await invoke("lt_remove_lua", { appId });
    toast(`${appId} удалён`, "ok");
    await loadInstalled($("#luatools-body"));
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

// OAuth callback listener — LuaTools uses localhost:53789/callback redirect.
// In a Tauri app we can't listen on that port easily, so the user must paste
// the tokens or we'll integrate a proper deeplink later.
// For now, expose a global for manual token injection from devtools or deeplink handler.
window.__ltSetSession = (data) => {
  ltSaveSession(data);
  const body = $("#luatools-body");
  if (body) updateAuth(body);
  toast("Вошли в lua.tools", "ok");
};
