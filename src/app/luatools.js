// LuaTools — полная интеграция.
// Главная, Добавить, Управление, Инструменты, Режим, Фиксы, Плагин, Загрузки, Настройки.

import { invoke, listen, openExternal, pickInputFiles } from "./tauri.js";
import { $ } from "./utils.js";
import { toast } from "./api.js";
import {
  ltSearchSteam, ltFeatured, ltCheckSources, ltGameDetails,
  ltIsLoggedIn, ltSession, ltSaveSession, ltClearSession,
  ltManifestDownloadUrl, ltUsage, ltDlcGenerateUrl, ltDenuvoDownloadUrl, ltDenuvoListings, ltDenuvoFixes,
  ltSetApiConfig, ltTakeLegacySession, ltOnSessionChange, ltFetchUser, ltDepotInfo, ltRedeemBotCode, ltPkceStart, ltPkceExchange } from "./luatools-api.js";
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
  queuePump();
}
// Downloads run one at a time in queue order; pending ones can be reordered or cancelled.
function queuePump() {
  if (dlQueue.items.some(i => i.status === "downloading" || i.status === "installing")) return;
  const next = dlQueue.items.find(i => i.status === "pending" && i._go);
  if (next) { const go = next._go; next._go = null; go(); }
}
function queueTurn(item) {
  return new Promise((resolve, reject) => {
    item._go = resolve;
    item._cancel = () => reject(new Error("cancelled"));
    queuePump();
  });
}
function queueCancel(id) {
  const item = dlQueue.items.find(i => i.id === id && i.status === "pending");
  if (!item) return;
  item._cancel?.();
  queueDone(item, false, "Отменено");
}
function queueMove(id, dir) {
  const idx = dlQueue.items.findIndex(i => i.id === id);
  const to = idx + dir;
  if (idx < 0 || to < 0 || to >= dlQueue.items.length) return;
  if (dlQueue.items[to].status !== "pending" || dlQueue.items[idx].status !== "pending") return;
  [dlQueue.items[idx], dlQueue.items[to]] = [dlQueue.items[to], dlQueue.items[idx]];
  if (currentPage === "downloads") renderPage("downloads");
}
async function confirmOverwrite(appId) {
  if (!installedList.some(i => i.app_id === appId)) return true;
  return confirmAction(`Lua для ${gameName(appId)} уже установлен. Заменить его? Текущий файл сохранится в пресетах (auto).`);
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
      // applist.morrenus.xyz отдаёт голый массив [{appid, name}], Steam — {applist:{apps}}.
      const apps = Array.isArray(data) ? data : (data?.applist?.apps || data?.apps || []);
      for (const a of apps) if (a.appid && a.name) gameNames[a.appid] = a.name;
      // Названия пришли позже первой отрисовки — перерисовать списки с AppID вместо имён.
      if (Object.keys(gameNames).length && ["home", "builds", "manage"].includes(currentPage)) renderPage(currentPage);
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
      <button class="lt-nav" data-page="add"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M12 4v16m8-8H4"/></svg> Добавить</button>
      <button class="lt-nav" data-page="manage"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg> Управление</button>
      <button class="lt-nav" data-page="tools"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.573-1.066z"/><circle cx="12" cy="12" r="3"/></svg> Инструменты</button>
      <button class="lt-nav" data-page="mode"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M4 6h16M4 12h16m-7 6h7"/></svg> Режим</button>
      <button class="lt-nav" data-page="fixes"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> Фиксы</button>
      <button class="lt-nav" data-page="plugin"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M13 10V3L4 14h7v7l9-11h-7z"/></svg> Плагин</button>
    </div>
    <div class="lt-sidebar-bottom">
      <button class="lt-nav lt-nav-action" id="lt-restart-steam"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Перезапустить Steam</button>
      <button class="lt-nav" data-page="downloads"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/></svg> Загрузки</button>
      <button class="lt-nav" data-page="settings"><svg class="lt-icon" viewBox="0 0 24 24"><path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"/></svg> Настройки</button>
    </div>
    <div class="lt-sidebar-ver" id="lt-sidebar-ver"></div>
  </nav>
  <main class="lt-main"><div class="lt-page-content" id="lt-page-content"></div></main>
</div>`;
}

function attachDropZone(body) {
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

  setLuatoolsDropHandler(paths => installPaths(paths, body));
}

// Установка файлов, пришедших перетаскиванием или из «Обзор файлов…».
async function installPaths(paths, body) {
  const validExt = /\.(lua|manifest|zip)$/i;
  {
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
  }
}

// Картинки: у новых игр header.jpg лежит по другому пути CDN (store_item_assets/…/<hash>/),
// старый адрес отдаёт 404. При ошибке берём header_image из appdetails, иначе — заглушка.
const imgCache = new Map(); // appId → Promise<string|null>
function headerImageFor(appId) {
  if (!imgCache.has(appId)) imgCache.set(appId, ltGameDetails(String(appId)).then(d => d?.header_image || null).catch(() => null));
  return imgCache.get(appId);
}
function attachImageFallback(body) {
  body.addEventListener("error", async e => {
    const img = e.target;
    if (img?.tagName !== "IMG" || !img.dataset?.ltImg) return;
    const stage = img.dataset.ltStage || "";
    if (!stage) {
      img.dataset.ltStage = "details";
      const url = await headerImageFor(img.dataset.ltImg);
      if (url && url !== img.src) { img.src = url; return; }
    }
    img.dataset.ltStage = "dead";
    img.removeAttribute("src");
    img.classList.add("lt-img-missing");
  }, true);
}

function attachGlobal(body) {
  attachDropZone(body);
  attachImageFallback(body);
  listen("lt-store-add", ev => handleStoreAdd(Number(ev.payload)));
  listen("lt-download-progress", ev => {
    const { url, percent } = ev.payload || {};
    const active = dlQueue.items.find(i => i._url === url);
    if (active) { active.progress = percent; if (currentPage === "downloads") renderPage("downloads"); }
  });
  body.addEventListener("click", e => {
    // <a target="_blank"> в webview ничего не открывает — отдаём системному браузеру.
    const link = e.target.closest('a[target="_blank"][href^="http"]');
    if (link) { e.preventDefault(); openExternal(link.href).catch(err => toast(errMsg(err), "error")); return; }

    const nav = e.target.closest("[data-page]");
    if (nav) { switchPage(nav.dataset.page); return; }
    if (e.target.closest("#lt-restart-steam")) { doRestartSteam(); return; }
    if (e.target.closest("#lt-back-btn")) { switchPage("home"); return; }
    if (e.target.closest("#lt-login-btn")) { doLogin(); return; }
    if (e.target.closest("#lt-code-btn")) { doCodeLogin(); return; }
    if (e.target.closest("#lt-logout-btn")) {
      ltClearSession();
      invoke("lt_config_set", { key: "session_enc", value: null }).catch(() => {});
      updateAuthUI();
      return;
    }

    const mv = e.target.closest("[data-dl-move]");
    if (mv) { const [id, dir] = mv.dataset.dlMove.split(":").map(Number); queueMove(id, dir); return; }
    const cancel = e.target.closest("[data-dl-cancel]");
    if (cancel) { queueCancel(Number(cancel.dataset.dlCancel)); return; }
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
  el.dataset.page = page; // ширина страницы задаётся в luatools.css по data-page
  if (fn) await fn(el);
}

async function refreshAll(body) {
  try { steamInfo = await invoke("lt_steam_info"); } catch { steamInfo = null; }
  try { pluginStatus = await invoke("lt_plugin_status"); } catch { pluginStatus = null; }
  try { installedList = await invoke("lt_list_installed"); } catch { installedList = []; }
  try { ltConfig = await invoke("lt_config_get") || {}; } catch { ltConfig = {}; }
  if (ltConfig.api_base) ltSetApiConfig({ api_base: ltConfig.api_base, manifest_backend_url: ltConfig.manifest_backend_url });
  await restoreEncryptedSession();
  if (ltConfig.store_button) invoke("lt_store_button_state").catch(() => {});
  if (ltConfig.filter_hardware !== false) {
    invoke("lt_hardware_appids").then(ids => { hardwareAppIds = new Set(ids); }).catch(() => {});
  }
  loadGameNames();
  const ver = body.querySelector("#lt-sidebar-ver");
  if (ver) {
    const v = pluginStatus?.installed ? `v${String(pluginStatus.version || "?").replace(/^v/i, "")}` : "";
    ver.textContent = [v, ltIsLoggedIn() ? "Выполнен вход" : ""].filter(Boolean).join(" · ");
  }

  try { onboardingDone = !!localStorage.getItem("lt_onboarded"); } catch { onboardingDone = true; }
  if (!onboardingDone) {
    renderOnboarding($("#lt-page-content"));
    return;
  }
  renderPage(currentPage);
}

function updateAuthUI() {
  for (const el of document.querySelectorAll(".lt-auth-area")) {
    if (el.dataset.variant === "row") {
      const u = ltSession()?.user;
      const who = u?.user_metadata?.full_name || u?.user_metadata?.name || u?.email || "";
      el.innerHTML = ltIsLoggedIn()
        ? `<span>Выполнен вход${who ? ` как ${esc(who)}` : ""}</span><button id="lt-logout-btn" class="lt-btn lt-btn-sm lt-hi-action">Выйти</button>`
        : `<span class="lt-muted">Вход в lua.tools не выполнен</span><button id="lt-login-btn" class="lt-btn lt-btn-sm lt-hi-action">Войти</button><button id="lt-code-btn" class="lt-btn lt-btn-sm lt-hi-action">Код от бота</button>`;
      continue;
    }
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
    <h2>Добро пожаловать в LuaProject <span class="lt-beta">Beta</span></h2>
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
    <div class="lt-section" style="margin-top:16px"><h3>Настройки</h3>
      <div class="lt-settings-list">
        <label class="lt-info-row"><input type="checkbox" id="lt-ob-sushi" ${ltConfig.src_sushi !== false ? "checked" : ""}> Источник sushitools-games-repo</label>
        <label class="lt-info-row"><input type="checkbox" id="lt-ob-hw" ${ltConfig.filter_hardware !== false ? "checked" : ""}> Скрывать железо/софт в поиске</label>
        <label class="lt-info-row"><input type="checkbox" id="lt-ob-doh" ${ltConfig.use_doh ? "checked" : ""}> DNS-over-HTTPS (если lua.tools или GitHub не открываются)</label>
      </div>
      <div class="lt-row-gap" style="margin-top:10px">${ltIsLoggedIn() ? '<span class="lt-ok">Вход в lua.tools выполнен</span>' : '<button class="lt-btn" id="lt-login-btn">Войти в lua.tools</button><button class="lt-btn" id="lt-code-btn">Код от бота</button>'}</div>
    </div>
    <div style="margin-top:20px;display:flex;gap:8px">
      ${!pluginStatus?.installed ? '<button class="lt-btn lt-btn-primary" data-page="mode">Установить плагин</button>' : ''}
      <button class="lt-btn" id="lt-onboard-skip">Продолжить</button>
    </div>
  </div>`;
  el.querySelector("#lt-onboard-skip")?.addEventListener("click", async () => {
    for (const [id, key] of [["#lt-ob-sushi", "src_sushi"], ["#lt-ob-hw", "filter_hardware"], ["#lt-ob-doh", "use_doh"]]) {
      const v = !!el.querySelector(id)?.checked;
      ltConfig[key] = v;
      await invoke("lt_config_set", { key, value: v }).catch(() => {});
    }
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
          <img data-lt-img="${i.app_id}" src="https://cdn.cloudflare.steamstatic.com/steam/apps/${i.app_id}/header.jpg" alt="" loading="lazy">
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

const HOME_ICONS = {
  steam: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="12" rx="6"/><path d="M6 12h4M8 10v4"/><circle cx="15.5" cy="11" r=".6"/><circle cx="17.5" cy="13" r=".6"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5"/></svg>',
  mode: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>',
  drop: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>',
};

async function renderHome(el) {
  const ps = pluginStatus;
  const ver = ps?.version ? ` · v${esc(String(ps.version).replace(/^v/i, ""))}` : "";
  el.innerHTML = `
    <h2 class="lt-page-title">Добро пожаловать в LuaProject <span class="lt-beta">Beta</span></h2>
    <div class="lt-hs">
      <div class="lt-hs-card">
        <span class="lt-hs-num">${installedList.length}</span>
        <span class="lt-hs-label">Lua на борту</span>
      </div>
      <div class="lt-hs-card">
        <span class="lt-hs-label">Статус плагина</span>
        <span class="lt-hs-status ${ps?.installed ? "is-ok" : ""}">${ps?.installed ? `Установлено${ver}` : "Не установлено"}</span>
        ${ps?.installed ? "" : '<button class="lt-btn lt-hs-btn" data-page="mode">Установить</button>'}
      </div>
    </div>
    <div class="lt-hi">
      <div class="lt-hi-row">${HOME_ICONS.steam}${steamInfo?.path
        ? `<span>Steam обнаружен · ${esc(steamInfo.path)}</span>`
        : '<span class="lt-error">Steam не найден</span>'}</div>
      ${ps?.mode ? `<div class="lt-hi-row">${HOME_ICONS.mode}<span>Режим · ${esc(ps.mode)}</span></div>` : ""}
      ${steamInfo?.running && !ps?.installed ? `<div class="lt-hi-row lt-hi-warn">${HOME_ICONS.warn}<span>Steam запущен — установка плагина его перезапустит</span></div>` : ""}
    </div>
    <div class="lt-drop-zone lt-hd" id="lt-drop-home">
      <span class="lt-hd-icon">${HOME_ICONS.drop}</span>
      <div class="lt-hd-text">
        <strong>Перетащите сюда файлы .lua, .manifest или .zip</strong>
        <span class="lt-muted">…или перетащите сюда ссылку SteamDB / магазина Steam, чтобы добавить эту игру.</span>
        <button class="lt-btn lt-btn-sm lt-hd-browse" id="lt-browse-files">${HOME_ICONS.folder} Обзор файлов…</button>
      </div>
    </div>
    <section class="lt-section"><h3>Недавно добавленные</h3><div class="lt-grid" id="lt-recent-grid"></div></section>
    <section class="lt-section"><h3>Популярное</h3><div class="lt-grid lt-grid-featured" id="lt-featured-grid"><div class="lt-loading">Загружаю…</div></div></section>`;
  el.querySelector("#lt-browse-files")?.addEventListener("click", e => withBusy(e.currentTarget, async () => {
    try {
      const paths = await pickInputFiles({ multiple: true, filters: [{ name: "LuaProject", extensions: ["lua", "manifest", "zip"] }] });
      if (paths?.length) await installPaths(paths, $("#luatools-body"));
    } catch (err) { toast(errMsg(err), "error"); }
  }));
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
      <img data-lt-img="${i.app_id}" src="https://cdn.cloudflare.steamstatic.com/steam/apps/${i.app_id}/header.jpg" alt="" loading="lazy">
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
// UI helpers for the redesigned pages
// ══════════════════════════════════════════════════════════════════

const UI_ICONS = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 11-2.34-5.66M20 4v4h-4"/></svg>',
  filter: '<svg viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  manage: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="10" rx="5"/><path d="M8 12h3M9.5 10.5v3"/><circle cx="16" cy="12" r=".8"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  rename: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 17h16M9 4v16"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/></svg>',
  wrench: '<svg viewBox="0 0 24 24"><path d="M14 6a4 4 0 005 5l-8 8a2 2 0 01-3-3z"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M7 18a4 4 0 010-8 6 6 0 0111 2 3 3 0 010 6z"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 4l2.4 5 5.6.6-4.2 3.8 1.2 5.6L12 16.3 7 19l1.2-5.6L4 9.6l5.6-.6z"/></svg>',
  puzzle: '<svg viewBox="0 0 24 24"><path d="M9 4h3v3a2 2 0 104 0V4h4v6h-3a2 2 0 100 4h3v6h-6v-3a2 2 0 10-4 0v3H4v-6h3a2 2 0 100-4H4V4z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/></svg>',
  tag: '<svg viewBox="0 0 24 24"><path d="M4 4h7l9 9-7 7-9-9z"/><circle cx="8" cy="8" r="1"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>',
  no: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M9.5 9.5l5 5M14.5 9.5l-5 5"/></svg>',
  chevL: '<svg viewBox="0 0 24 24"><path d="M14 6l-6 6 6 6"/></svg>',
  chevR: '<svg viewBox="0 0 24 24"><path d="M10 6l6 6-6 6"/></svg>',
};

const steamHeader = id => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`;

// «Результатов на странице» + номера страниц (1 2 … N), как в LuaTools.
function pagerHtml(page, pages, perPage, sizes = [12, 24, 48]) {
  let nums = "";
  if (pages > 1) {
    const set = new Set([0, pages - 1, page - 1, page, page + 1].filter(p => p >= 0 && p < pages));
    let prev = -1;
    for (const p of [...set].sort((a, b) => a - b)) {
      if (prev >= 0 && p - prev > 1) nums += '<span class="lt-pg-gap">…</span>';
      nums += `<button class="lt-pg-num ${p === page ? "is-active" : ""}" data-pg="${p}">${p + 1}</button>`;
      prev = p;
    }
  }
  return `<div class="lt-pg">
    <div class="lt-pg-nums">${pages > 1 ? `<button class="lt-pg-arrow" data-pg="${page - 1}" ${page === 0 ? "disabled" : ""}>${UI_ICONS.chevL}</button>${nums}<button class="lt-pg-arrow" data-pg="${page + 1}" ${page >= pages - 1 ? "disabled" : ""}>${UI_ICONS.chevR}</button>` : ""}</div>
    <label class="lt-pg-size">Результатов на странице
      <select class="lt-select" data-pg-size>${sizes.map(n => `<option ${n === perPage ? "selected" : ""}>${n}</option>`).join("")}</select>
    </label>
  </div>`;
}
function bindPager(root, onPage, onSize) {
  root.querySelectorAll("[data-pg]").forEach(b => b.addEventListener("click", () => onPage(parseInt(b.dataset.pg, 10))));
  root.querySelector("[data-pg-size]")?.addEventListener("change", e => onSize(parseInt(e.target.value, 10)));
}

function gameCardHtml({ appId, name, img, sub, sub2 }) {
  return `<button class="lt-gc" data-appid="${appId}">
    <img data-lt-img="${appId}" src="${esc(img || steamHeader(appId))}" alt="" loading="lazy">
    <span class="lt-gc-body"><span class="lt-gc-name">${esc(name)}</span>
    ${sub ? `<span class="lt-gc-sub">${sub}</span>` : ""}${sub2 ? `<span class="lt-gc-sub2">${sub2}</span>` : ""}</span>
  </button>`;
}

function dropZoneHtml() {
  return `<div class="lt-drop-zone lt-hd">
    <span class="lt-hd-icon">${HOME_ICONS.drop}</span>
    <div class="lt-hd-text">
      <strong>Перетащите сюда файлы .lua, .manifest или .zip</strong>
      <span class="lt-muted">…или перетащите сюда ссылку SteamDB / магазина Steam, чтобы добавить эту игру.</span>
      <button class="lt-btn lt-btn-sm lt-hd-browse" data-browse-files>${HOME_ICONS.folder} Обзор файлов…</button>
    </div>
  </div>`;
}
function bindBrowse(el) {
  el.querySelectorAll("[data-browse-files]").forEach(b => b.addEventListener("click", () => withBusy(b, async () => {
    try {
      const paths = await pickInputFiles({ multiple: true, filters: [{ name: "LuaProject", extensions: ["lua", "manifest", "zip"] }] });
      if (paths?.length) await installPaths(paths, $("#luatools-body"));
    } catch (err) { toast(errMsg(err), "error"); }
  })));
}

// ══════════════════════════════════════════════════════════════════
// ADD
// ══════════════════════════════════════════════════════════════════

function renderAdd(el) {
  el.innerHTML = `<div class="lt-narrow">
    <h2 class="lt-page-title lt-title-tight">Погнали за Lua™!</h2>
    <p class="lt-page-sub">Введите App ID, вставьте ссылку Steam или выполните поиск по названию игры</p>
    <label class="lt-search">${UI_ICONS.search}<input type="text" id="lt-search" placeholder="Введите App ID или найдите игры…" autocomplete="off"></label>
    <div id="lt-results" class="lt-add-results" hidden></div>
    <div id="lt-add-strips">
      <h3 class="lt-strip-title">Бестселлеры</h3><div class="lt-strip" id="lt-strip-top"><div class="lt-loading">Загружаю…</div></div>
      <h3 class="lt-strip-title">Новинки</h3><div class="lt-strip" id="lt-strip-new"></div>
    </div>
    <h3 class="lt-strip-title">Уже есть файлы?</h3>
    ${dropZoneHtml()}
  </div>`;
  bindBrowse(el);

  // Steam lists its own hardware (Controller, Deck, Frame…) among games.
  const isHardware = i => hardwareAppIds.has(i.appId) || hardwareAppIds.has(String(i.appId))
    || /^(Steam (Controller|Deck|Frame|Machine|Link|Index)|Valve Index)/i.test(i.name || "");
  const strip = (items, id) => {
    const box = el.querySelector(id);
    if (!box) return;
    if (ltConfig.filter_hardware !== false) items = items.filter(i => !isHardware(i));
    box.innerHTML = items.length
      ? items.map(i => gameCardHtml({ appId: i.appId, name: i.name, img: i.image })).join("")
      : '<div class="lt-empty">—</div>';
  };
  ltFeatured().then(({ topSellers, newReleases }) => { strip(topSellers, "#lt-strip-top"); strip(newReleases, "#lt-strip-new"); });

  const input = el.querySelector("#lt-search");
  const results = el.querySelector("#lt-results");
  const strips = el.querySelector("#lt-add-strips");
  let seq = 0, timer = null;
  const doSearch = async () => {
    const q = input.value.trim();
    const my = ++seq;
    if (!q) { results.hidden = true; strips.hidden = false; return; }
    const link = q.match(/(?:store\.steampowered\.com\/app|steamdb\.info\/app)\/(\d+)/);
    if (link) { openDetail(parseInt(link[1], 10)); return; }
    results.hidden = false; strips.hidden = true;
    results.innerHTML = '<div class="lt-loading">Ищу…</div>';
    try {
      let items = /^\d+$/.test(q)
        ? [await ltGameDetails(q)].filter(Boolean).map(d => ({ appId: parseInt(q, 10), name: d.name, icon: d.header_image }))
        : await ltSearchSteam(q);
      if (my !== seq) return;
      if (ltConfig.filter_hardware !== false && hardwareAppIds.size) items = items.filter(i => !hardwareAppIds.has(i.appId));
      results.innerHTML = items.length
        ? `<div class="lt-gc-grid">${items.map(i => gameCardHtml({ appId: i.appId, name: i.name, img: steamHeader(i.appId), sub: `App ID: ${i.appId}` })).join("")}</div>`
        : '<div class="lt-empty">Ничего не нашлось</div>';
    } catch (e) { if (my === seq) results.innerHTML = `<div class="lt-error">${esc(errMsg(e))}</div>`; }
  };
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(doSearch, 350); });
  input.addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(timer); doSearch(); } });
  input.focus();
}

// ══════════════════════════════════════════════════════════════════
// MANAGE
// ══════════════════════════════════════════════════════════════════

const manageState = { q: "", page: 0, perPage: 24, sort: "added" };

async function renderManage(el) {
  try { installedList = await invoke("lt_list_installed"); } catch { installedList = []; }
  await loadGameNames();
  el.innerHTML = `<div class="lt-head">
      <h2 class="lt-page-title">Управление</h2>
      <button class="lt-btn lt-btn-ghost" id="lt-manage-refresh">${UI_ICONS.refresh} Обновить</button>
    </div>
    <div class="lt-toolbar">
      <label class="lt-search lt-grow">${UI_ICONS.search}<input type="text" id="lt-manage-search" placeholder="Поиск по имени или App ID…" value="${esc(manageState.q)}"></label>
      <label class="lt-btn lt-btn-ghost lt-filter-btn">${UI_ICONS.filter} Фильтры
        <select id="lt-manage-sort" class="lt-filter-select">
          <option value="added" ${manageState.sort === "added" ? "selected" : ""}>Сначала новые</option>
          <option value="name" ${manageState.sort === "name" ? "selected" : ""}>По названию</option>
          <option value="appid" ${manageState.sort === "appid" ? "selected" : ""}>По App ID</option>
        </select>
      </label>
    </div>
    <div id="lt-manage-grid"></div>
    <div id="lt-manage-pager"></div>`;

  const draw = () => {
    const q = manageState.q.toLowerCase();
    let list = q ? installedList.filter(i => String(i.app_id).includes(q) || gameName(i.app_id).toLowerCase().includes(q)) : [...installedList];
    if (manageState.sort === "name") list.sort((a, b) => gameName(a.app_id).localeCompare(gameName(b.app_id)));
    else if (manageState.sort === "appid") list.sort((a, b) => a.app_id - b.app_id);
    const pages = Math.max(1, Math.ceil(list.length / manageState.perPage));
    manageState.page = Math.min(manageState.page, pages - 1);
    const slice = list.slice(manageState.page * manageState.perPage, (manageState.page + 1) * manageState.perPage);
    el.querySelector("#lt-manage-grid").innerHTML = list.length
      ? `<div class="lt-gc-grid">${slice.map(i => gameCardHtml({
        appId: i.app_id, name: gameName(i.app_id),
        sub: `App ID: ${i.app_id}`, sub2: `Добавлено ${fmtDate(i.modified)}`,
      })).join("")}</div>`
      : `<div class="lt-empty">${installedList.length ? "Ничего не нашлось" : "Нет установленных lua-файлов. Добавьте игру через «Добавить»."}</div>`;
    const pg = el.querySelector("#lt-manage-pager");
    pg.innerHTML = pagerHtml(manageState.page, pages, manageState.perPage);
    bindPager(pg, p => { manageState.page = p; draw(); }, n => { manageState.perPage = n; manageState.page = 0; draw(); });
  };
  draw();
  el.querySelector("#lt-manage-search").addEventListener("input", e => { manageState.q = e.target.value.trim(); manageState.page = 0; draw(); });
  el.querySelector("#lt-manage-sort").addEventListener("change", e => { manageState.sort = e.target.value; draw(); });
  el.querySelector("#lt-manage-refresh").addEventListener("click", e => withBusy(e.currentTarget, () => renderManage(el)));
}

// ══════════════════════════════════════════════════════════════════
// TOOLS — game list + depot editor with presets
// ══════════════════════════════════════════════════════════════════

const toolsState = { appId: null, q: "", page: 0, perPage: 10, tab: "depots", depotQ: "", preset: "" };

async function renderTools(el) {
  try { installedList = await invoke("lt_list_installed"); } catch { installedList = []; }
  await loadGameNames();
  if (!installedList.length) {
    el.innerHTML = '<h2 class="lt-page-title">Инструменты</h2><div class="lt-empty">Нет установленных lua-файлов. Добавьте игру через «Добавить».</div>';
    return;
  }
  if (!installedList.some(i => i.app_id === toolsState.appId)) toolsState.appId = installedList[0].app_id;

  el.innerHTML = `<div class="lt-tools">
    <aside class="lt-tl">
      <label class="lt-search">${UI_ICONS.search}<input type="text" id="lt-tl-search" placeholder="Поиск по имени или App ID…" value="${esc(toolsState.q)}"></label>
      <div class="lt-tl-list" id="lt-tl-list"></div>
      <div class="lt-tl-pager" id="lt-tl-pager"></div>
    </aside>
    <section class="lt-tr" id="lt-tr"></section>
  </div>`;

  const drawList = () => {
    const q = toolsState.q.toLowerCase();
    const list = q ? installedList.filter(i => String(i.app_id).includes(q) || gameName(i.app_id).toLowerCase().includes(q)) : installedList;
    const pages = Math.max(1, Math.ceil(list.length / toolsState.perPage));
    toolsState.page = Math.min(toolsState.page, pages - 1);
    const slice = list.slice(toolsState.page * toolsState.perPage, (toolsState.page + 1) * toolsState.perPage);
    el.querySelector("#lt-tl-list").innerHTML = slice.map(i => `<button class="lt-tl-item ${i.app_id === toolsState.appId ? "is-active" : ""}" data-tl-app="${i.app_id}">
        <img data-lt-img="${i.app_id}" src="${steamHeader(i.app_id)}" alt="" loading="lazy">
        <span><span class="lt-tl-name">${esc(gameName(i.app_id))}</span><span class="lt-tl-sub">${i.app_id}</span></span>
      </button>`).join("") || '<div class="lt-empty">Ничего не нашлось</div>';
    el.querySelectorAll("[data-tl-app]").forEach(b => b.addEventListener("click", () => {
      toolsState.appId = parseInt(b.dataset.tlApp, 10); toolsState.preset = ""; toolsState.depotQ = "";
      drawList(); drawRight();
    }));
    const pg = el.querySelector("#lt-tl-pager");
    pg.innerHTML = `<div class="lt-tl-pg">
        <button class="lt-pg-arrow" data-pg="${toolsState.page - 1}" ${toolsState.page === 0 ? "disabled" : ""}>${UI_ICONS.chevL}</button>
        <span>Страница ${toolsState.page + 1} из ${pages}</span>
        <button class="lt-pg-arrow" data-pg="${toolsState.page + 1}" ${toolsState.page >= pages - 1 ? "disabled" : ""}>${UI_ICONS.chevR}</button>
      </div>
      <label class="lt-pg-size">Результатов на странице <select class="lt-select" data-pg-size>${[10, 20, 50].map(n => `<option ${n === toolsState.perPage ? "selected" : ""}>${n}</option>`).join("")}</select></label>`;
    bindPager(pg, p => { toolsState.page = p; drawList(); }, n => { toolsState.perPage = n; toolsState.page = 0; drawList(); });
  };

  const drawRight = async () => {
    const right = el.querySelector("#lt-tr");
    const appId = toolsState.appId;
    right.innerHTML = '<div class="lt-loading">Загружаю…</div>';
    let text = "", lua = null, variants = [];
    try { text = await invoke("lt_read_lua", { appId }); lua = parseLua(text, appId); } catch { /* нет файла */ }
    try { variants = await invoke("lt_list_variants", { appId }); } catch { /* нет */ }
    if (appId !== toolsState.appId) return;
    const curHash = text ? shortHash(text) : null;
    const activeVariant = variants.find(v => v.hash === curHash);
    if (!toolsState.preset || !variants.some(v => v.name === toolsState.preset)) toolsState.preset = activeVariant?.name || "";
    const sel = variants.find(v => v.name === toolsState.preset);
    const presetMeta = v => v ? `${v.depot_count} депо · ${v.dlc_count} DLC · ${v.is_pinned ? "Закреплена" : "Авто-обновление"}`
      : (lua ? `${lua.depotCount} депо · ${lua.dlcCount} DLC · ${lua.hasActivePins ? "Закреплена" : "Авто-обновление"}` : "");

    right.innerHTML = `<div class="lt-head">
        <div><h2 class="lt-page-title lt-title-tight">${esc(gameName(appId))}</h2>
        <p class="lt-page-sub">App ID: ${appId}</p></div>
        <div class="lt-head-actions">
          <button class="lt-btn lt-btn-ghost" id="lt-tr-download">${UI_ICONS.download} Скачать</button>
          <button class="lt-btn lt-btn-ghost" id="lt-tr-detail">${UI_ICONS.manage} Управление</button>
          <button class="lt-btn lt-btn-ghost" id="lt-tr-refresh">${UI_ICONS.refresh} Обновить</button>
        </div>
      </div>
      <nav class="lt-tabs">
        <button class="lt-tab ${toolsState.tab === "depots" ? "is-active" : ""}" data-tab="depots">Депо</button>
        <button class="lt-tab ${toolsState.tab === "achievements" ? "is-active" : ""}" data-tab="achievements">Достижения</button>
        <button class="lt-tab ${toolsState.tab === "stats" ? "is-active" : ""}" data-tab="stats">Статистика</button>
        <button class="lt-tab ${toolsState.tab === "launch" ? "is-active" : ""}" data-tab="launch">Параметры запуска</button>
        <button class="lt-tab ${toolsState.tab === "playtime" ? "is-active" : ""}" data-tab="playtime">Время в игре</button>
      </nav>
      <div id="lt-tr-body"></div>`;
    right.querySelectorAll("[data-tab]").forEach(b => b.addEventListener("click", () => { toolsState.tab = b.dataset.tab; drawRight(); }));
    right.querySelector("#lt-tr-download").addEventListener("click", () => openDetail(appId));
    right.querySelector("#lt-tr-detail").addEventListener("click", () => openDetail(appId));
    right.querySelector("#lt-tr-refresh").addEventListener("click", () => drawRight());
    const body = right.querySelector("#lt-tr-body");

    if (toolsState.tab === "achievements" || toolsState.tab === "stats") {
      body.innerHTML = '<div class="lt-loading">Читаю данные Steam…</div>';
      let data = null;
      try { data = await invoke("lt_game_stats", { appId }); } catch (e) { body.innerHTML = `<div class="lt-error">${esc(errMsg(e))}</div>`; return; }
      if (appId !== toolsState.appId) return;
      const root = data.schema ? Object.values(data.schema)[0] : null;
      const stats = root?.stats || null;
      if (!stats) {
        body.innerHTML = `<div class="lt-empty">Steam ещё не скачал список достижений этой игры. Откройте игру в Steam (или запустите её) и нажмите «Обновить».</div>`;
        return;
      }
      const progress = data.user?.cache || {};
      const loc = v => (v && typeof v === "object") ? (v.russian || v.english || Object.values(v).find(x => typeof x === "string") || "") : String(v ?? "");
      const isAchType = t => String(t).toUpperCase() === "ACHIEVEMENTS" || String(t) === "4" || String(t).toUpperCase() === "GROUPACHIEVEMENTS" || String(t) === "5";

      if (toolsState.tab === "achievements") {
        const list = [];
        for (const [statId, st] of Object.entries(stats)) {
          if (!st.bits) continue;
          const mask = (progress[statId]?.data ?? 0) >>> 0;
          const times = progress[statId]?.AchievementTimes || {};
          for (const [bit, a] of Object.entries(st.bits)) {
            const n = parseInt(bit, 10);
            const got = ((mask >>> n) & 1) === 1;
            const d = a.display || {};
            list.push({
              name: loc(d.name) || a.name, desc: loc(d.desc), hidden: String(d.hidden) === "1",
              icon: got ? d.icon : (d.icon_gray || d.icon), got, time: times[bit] || 0,
            });
          }
        }
        const total = list.length, done = list.filter(a => a.got).length;
        if (!total) { body.innerHTML = '<div class="lt-empty">У этой игры нет достижений.</div>'; return; }
        body.innerHTML = `<div class="lt-ach-head">
            <div class="lt-ach-sum"><strong>${done}</strong> из ${total} получено
              <div class="lt-usage-bar"><div class="lt-usage-fill" style="width:${Math.round(done / total * 100)}%"></div></div></div>
            <span class="lt-muted lt-ach-note">Только просмотр — данные из кэша Steam</span>
          </div>
          <label class="lt-search">${UI_ICONS.search}<input type="text" id="lt-ach-search" placeholder="Поиск достижений"></label>
          <div id="lt-ach-list"></div>`;
        const iconUrl = f => f ? `https://shared.akamai.steamstatic.com/community_assets/images/apps/${appId}/${encodeURIComponent(f)}` : "";
        const draw = q => {
          q = (q || "").toLowerCase();
          const rows = list.filter(a => !q || a.name.toLowerCase().includes(q) || a.desc.toLowerCase().includes(q));
          body.querySelector("#lt-ach-list").innerHTML = rows.length ? rows.map(a => `<div class="lt-ach ${a.got ? "is-got" : ""}">
              <img src="${esc(iconUrl(a.icon))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
              <div class="lt-ach-main">
                <div class="lt-ach-name">${esc(a.name)}</div>
                ${a.desc ? `<div class="lt-ach-desc">${esc(a.desc)}</div>` : ""}
                <div class="lt-ach-meta">${a.hidden ? '<span class="lt-ach-hidden">Скрытое достижение</span>' : ""}${a.got ? `<span>Получено ${a.time ? esc(new Date(a.time * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" })) : ""}</span>` : ""}</div>
              </div>
              <span class="lt-switch ${a.got ? "is-on" : ""} is-static" aria-label="${a.got ? "Получено" : "Не получено"}"></span>
            </div>`).join("") : '<div class="lt-empty">Ни одно достижение не подходит под поиск.</div>';
        };
        draw("");
        body.querySelector("#lt-ach-search").addEventListener("input", e => draw(e.target.value.trim()));
        return;
      }

      // Stats tab: everything that isn't an achievements bitfield.
      const f32 = i => { const dv = new DataView(new ArrayBuffer(4)); dv.setInt32(0, i | 0, true); return dv.getFloat32(0, true); };
      const rows = Object.entries(stats).filter(([, st]) => !st.bits && !isAchType(st.type)).map(([id, st]) => {
        const type = String(st.type).toUpperCase();
        const isFloat = type === "FLOAT" || type === "AVGRATE" || type === "2" || type === "3";
        const raw = progress[id]?.data;
        const val = raw == null ? (st.default ?? 0) : (isFloat ? f32(raw) : raw);
        return { id, name: loc(st.display?.name) || st.name || `Stat ${id}`, api: st.name || "", val: isFloat ? Number(val).toFixed(2) : val, type };
      });
      body.innerHTML = rows.length ? `<p class="lt-muted lt-ach-note">Только просмотр — значения из кэша Steam.</p>
        <table class="lt-table"><thead><tr><th>Статистика</th><th>API-имя</th><th>Тип</th><th>Значение</th></tr></thead><tbody>
        ${rows.map(r => `<tr><td>${esc(r.name)}</td><td><code>${esc(r.api)}</code></td><td>${esc(r.type)}</td><td><strong>${esc(r.val)}</strong></td></tr>`).join("")}
        </tbody></table>` : '<div class="lt-empty">У этой игры нет статистики (кроме достижений).</div>';
      return;
    }

    if (toolsState.tab === "playtime") {
      body.innerHTML = '<div class="lt-loading">Читаю localconfig.vdf…</div>';
      let pt;
      try { pt = await invoke("lt_get_playtime", { appId }); } catch (e) { body.innerHTML = `<div class="lt-error">${esc(errMsg(e))}</div>`; return; }
      if (appId !== toolsState.appId) return;
      const hours = pt.minutes != null ? pt.minutes / 60 : 0;
      body.innerHTML = `<div class="lt-panel">
          <div class="lt-panel-title">Время в игре</div>
          ${pt.known ? `<div class="lt-pt-now"><strong>${pt.minutes != null ? `${hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} ч` : "Steam ещё не записал время для этой игры"}</strong>
            ${pt.last_played ? `<span class="lt-muted">последний запуск ${esc(new Date(pt.last_played * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" }))}</span>` : ""}</div>
          <div class="lt-row-gap">
            <input type="number" class="lt-input lt-pt-input" id="lt-pt-hours" min="0" step="0.1" value="${hours ? Number(hours.toFixed(1)) : 0}">
            <span class="lt-pt-unit">часов</span>
            <button class="lt-btn lt-btn-accent" id="lt-pt-save">Сохранить</button>
          </div>
          <p class="lt-muted lt-pt-note">Steam читает время в игре только при запуске${pt.steam_running ? " — он будет закрыт и открыт заново" : ""}. Перед записью делается копия localconfig.vdf.ltbak.</p>`
          : '<p class="lt-muted">Steam ещё не записал данные об этой игре. Запустите её хотя бы раз — после этого время можно будет поменять.</p>'}
        </div>`;
      body.querySelector("#lt-pt-save")?.addEventListener("click", e => withBusy(e.currentTarget, async () => {
        const h = parseFloat(body.querySelector("#lt-pt-hours").value);
        if (!Number.isFinite(h) || h < 0) { toast("Введите число часов", "warn"); return; }
        const minutes = Math.round(h * 60);
        if (pt.steam_running && !await confirmAction("Чтобы записать время, Steam будет закрыт и запущен снова. Продолжить?")) return;
        try { await invoke("lt_set_playtime", { appId, minutes }); toast(`Время в игре: ${h} ч`, "ok"); drawRight(); }
        catch (err) { toast(errMsg(err), "error"); }
      }));
      return;
    }

    if (toolsState.tab === "launch") {
      const game = await invoke("lt_game_install_path", { appId }).catch(() => ({ installed: false }));
      const current = await invoke("lt_get_launch_options", { appId }).catch(() => null);
      const saved = (ltConfig.launch_saved || {})[appId];
      // Steam resets launch options on some updates/reinstalls: offer to put ours back.
      const drift = saved != null && (current ?? "") !== saved;
      body.innerHTML = `<div class="lt-panel">
        <div class="lt-panel-title">Параметры запуска</div>
        <p class="lt-muted">${game.installed ? `Игра установлена: ${esc(game.path)}` : "Игра не установлена на диск — Steam предложит её скачать."}</p>
        ${drift ? `<p class="lt-warn">Steam сбросил параметры (сейчас: «${esc(current || "пусто")}»). <button class="lt-btn lt-btn-sm" id="lt-launch-reapply">Вернуть «${esc(saved)}»</button></p>` : ""}
        <div class="lt-row-gap"><input type="text" class="lt-input lt-grow" id="lt-launch-args" placeholder="Например: -windowed -nointro" value="${esc(current ?? "")}">
        <button class="lt-btn" id="lt-launch-save">Сохранить в Steam</button>
        <button class="lt-btn lt-btn-accent" id="lt-launch-go">▶ Запустить</button></div>
        <p class="lt-muted lt-pt-note">«Сохранить» пишет параметры в свойства игры в Steam (Steam будет перезапущен). «Запустить» применяет их только к одному запуску.</p>
      </div>`;
      const save = async value => {
        await invoke("lt_set_launch_options", { appId, value });
        const map = { ...(ltConfig.launch_saved || {}) };
        if (value) map[appId] = value; else delete map[appId];
        ltConfig.launch_saved = map;
        await invoke("lt_config_set", { key: "launch_saved", value: map });
        toast("Параметры сохранены в Steam", "ok");
        renderTools(el);
      };
      body.querySelector("#lt-launch-save").addEventListener("click", e => withBusy(e.currentTarget, () =>
        save(body.querySelector("#lt-launch-args").value.trim()).catch(err => toast(errMsg(err), "error"))));
      body.querySelector("#lt-launch-reapply")?.addEventListener("click", e => withBusy(e.currentTarget, () =>
        save(saved).catch(err => toast(errMsg(err), "error"))));
      body.querySelector("#lt-launch-go").addEventListener("click", async () => {
        try { await invoke("lt_launch_game", { appId, args: body.querySelector("#lt-launch-args").value.trim() }); toast("Запуск через Steam…", "ok"); }
        catch (e) { toast(errMsg(e), "error"); }
      });
      return;
    }

    if (!lua) { body.innerHTML = '<div class="lt-empty">Lua-файл не найден</div>'; return; }
    body.innerHTML = `<div class="lt-panel">
        <div class="lt-panel-title">Активный пресет</div>
        <label class="lt-preset">
          <span class="lt-preset-main"><strong>${esc(sel ? sel.name : "Текущий файл")}</strong><span class="lt-muted">${esc(presetMeta(sel))}</span></span>
          ${(!sel || sel === activeVariant) ? '<span class="lt-badge lt-badge-ok">АКТИВНА</span>' : ""}
          <select id="lt-preset-select" class="lt-preset-select">
            <option value="" ${!toolsState.preset ? "selected" : ""}>Текущий файл</option>
            ${variants.map(v => `<option value="${esc(v.name)}" ${v.name === toolsState.preset ? "selected" : ""}>${esc(v.name)}${v === activeVariant ? " — активен" : ""}</option>`).join("")}
          </select>
        </label>
        <div class="lt-preset-actions">
          <button class="lt-btn lt-btn-ghost" id="lt-pr-apply" ${!sel || sel === activeVariant ? "disabled" : ""}>${UI_ICONS.check} Применить</button>
          <button class="lt-btn lt-btn-ghost" id="lt-pr-rename" ${sel ? "" : "disabled"}>${UI_ICONS.rename} Переименовать</button>
          <button class="lt-btn lt-btn-ghost" id="lt-pr-save">${UI_ICONS.edit} ${sel ? "Перезаписать" : "Сохранить как пресет"}</button>
          <button class="lt-btn lt-btn-ghost lt-btn-dangertext" id="lt-pr-del" ${sel ? "" : "disabled"}>${UI_ICONS.trash} Удалить</button>
        </div>
      </div>
      <label class="lt-search">${UI_ICONS.search}<input type="text" id="lt-depot-search" placeholder="Поиск депо по названию, ID или типу…" value="${esc(toolsState.depotQ)}"></label>
      <div id="lt-depots"></div>`;


    body.querySelector("#lt-preset-select").addEventListener("change", e => { toolsState.preset = e.target.value; drawRight(); });
    body.querySelector("#lt-pr-apply").addEventListener("click", e => withBusy(e.currentTarget, async () => {
      try { await invoke("lt_load_variant", { appId, name: sel.name }); toast(`Пресет «${sel.name}» применён`, "ok"); drawRight(); }
      catch (err) { toast(errMsg(err), "error"); }
    }));
    body.querySelector("#lt-pr-rename").addEventListener("click", async () => {
      const to = await promptName("Новое имя пресета", sel.name);
      if (!to) return;
      try { await invoke("lt_rename_variant", { appId, from: sel.name, to }); toolsState.preset = to.replace(/[^\p{L}\p{N}_-]/gu, "_"); drawRight(); }
      catch (err) { toast(errMsg(err), "error"); }
    });
    body.querySelector("#lt-pr-save").addEventListener("click", async () => {
      const name = sel ? sel.name : await promptName("Имя нового пресета");
      if (!name) return;
      if (sel && !await confirmAction(`Перезаписать пресет «${sel.name}» текущим файлом?`)) return;
      try { await invoke("lt_save_variant", { appId, name }); toolsState.preset = name.replace(/[^\p{L}\p{N}_-]/gu, "_"); toast("Пресет сохранён", "ok"); drawRight(); }
      catch (err) { toast(errMsg(err), "error"); }
    });
    body.querySelector("#lt-pr-del").addEventListener("click", async () => {
      if (!await confirmAction(`Удалить пресет «${sel.name}»? Текущий lua-файл не изменится.`)) return;
      try { await invoke("lt_delete_variant", { appId, name: sel.name }); toolsState.preset = ""; drawRight(); }
      catch (err) { toast(errMsg(err), "error"); }
    });

    const all = [...lua.entries.map(e => ({ ...e, disabled: false })), ...lua.disabledEntries.map(e => ({ ...e, disabled: true }))];
    ltDepotInfo(appId).then(info => {
      if (!info || toolsState.appId !== appId) return;
      for (const e of all) {
        const d = info.depots[e.id];
        if (!d) continue;
        if (!e.comment && d.name) e.comment = d.name;
        if (!e.sizeOnDisk && d.size) e.sizeOnDisk = d.size;
        e.latestGid = d.gid;
      }
      if (body.isConnected && body.querySelector("#lt-depots")) drawDepots();
    });
    const typeOf = e => (e.id === (lua.baseAppId || appId) ? "ИГРА" : e.hasKey ? "ДЕПО" : "DLC");
    const drawDepots = () => {
      const q = toolsState.depotQ.toLowerCase();
      const list = q ? all.filter(e => String(e.id).includes(q) || (e.comment || "").toLowerCase().includes(q) || typeOf(e).toLowerCase().includes(q)) : all;
      body.querySelector("#lt-depots").innerHTML = `<div class="lt-dp-group">В lua <span class="lt-muted">(${all.length})</span></div>` + list.map(e => {
        const mf = e.manifestId || e.commentedManifestId;
        return `<div class="lt-dp ${e.disabled ? "is-off" : ""}">
          <button class="lt-switch ${e.disabled ? "" : "is-on"}" data-dp-toggle="${e.id}" ${e.id === lua.baseAppId ? "disabled title=\"Основное приложение\"" : ""} aria-label="Включить/выключить"></button>
          <div class="lt-dp-main">
            <div class="lt-dp-title">${esc(e.comment || `Depot ${e.id}`)} <span class="lt-chip lt-chip-${typeOf(e) === "DLC" ? "dlc" : typeOf(e) === "ИГРА" ? "game" : "depot"}">${typeOf(e)}</span></div>
            <div class="lt-dp-sub">${e.id}${e.sizeOnDisk ? ` · ${fmtSize(e.sizeOnDisk)}` : ""}</div>
            ${mf ? `<div class="lt-dp-mf">манифест ${esc(mf)}${e.latestGid && mf !== e.latestGid ? ` <span class="lt-warn">· в Steam новее: ${esc(e.latestGid)}</span>` : ""}</div>` : ""}
          </div>
          ${mf && !e.disabled ? `<label class="lt-dp-lock"><input type="checkbox" data-dp-lock="${e.id}" ${e.manifestId ? "checked" : ""}> Закрепить</label>` : ""}
        </div>`;
      }).join("");
      body.querySelectorAll("[data-dp-toggle]").forEach(b => b.addEventListener("click", async () => {
        const id = parseInt(b.dataset.dpToggle, 10);
        const entry = all.find(x => x.id === id);
        try {
          const t = await invoke("lt_read_lua", { appId });
          await invoke("lt_write_lua", { appId, content: setDepotEnabled(t, id, entry.disabled) });
          drawRight();
        } catch (err) { toast(errMsg(err), "error"); }
      }));
      body.querySelectorAll("[data-dp-lock]").forEach(c => c.addEventListener("change", async () => {
        const id = parseInt(c.dataset.dpLock, 10);
        try {
          const t = await invoke("lt_read_lua", { appId });
          await invoke("lt_write_lua", { appId, content: setDepotLocked(t, id, c.checked) });
          drawRight();
        } catch (err) { c.checked = !c.checked; toast(errMsg(err), "error"); }
      }));
    };
    drawDepots();
    body.querySelector("#lt-depot-search").addEventListener("input", e => { toolsState.depotQ = e.target.value.trim(); drawDepots(); });
  };

  drawList();
  drawRight();
  el.querySelector("#lt-tl-search").addEventListener("input", e => { toolsState.q = e.target.value.trim(); toolsState.page = 0; drawList(); });
}

// ══════════════════════════════════════════════════════════════════
// MODE
// ══════════════════════════════════════════════════════════════════

const MODES = [
  { key: "bst", mode: "BetterSteamTools", title: "BetterSteamTools", badges: ["rec", "cloud"],
    desc: "Форк OpenSteamTools с открытым исходным кодом, который активно поддерживается: исправления и новые функции!" },
  { key: "ost", mode: "stplug-in", title: "OpenSteamTool (Nightly)", badges: ["exp"],
    desc: "Nightly-сборки upstream OpenSteamTool. Свежие изменения раньше всех, но может быть нестабильным." },
  { key: "ltsp", mode: "LTSP", title: "LTSP", badges: [],
    desc: "Альтернативный анлокер (madoiscool/LTSP). Используйте, если BST и OST не работают." },
];
const BADGE = {
  active: `<span class="lt-badge2 is-ok">${UI_ICONS.check} АКТИВЕН</span>`,
  rec: `<span class="lt-badge2 is-blue">${UI_ICONS.star} РЕКОМЕНДУЕТСЯ</span>`,
  cloud: `<span class="lt-badge2 is-violet">${UI_ICONS.cloud} ПОДДЕРЖКА CLOUDREDIRECT</span>`,
  exp: '<span class="lt-badge2 is-warn">ЭКСПЕРИМЕНТАЛЬНЫЙ</span>',
};
const modeLatest = {};

async function renderMode(el) {
  const current = pluginStatus?.installed ? pluginStatus.mode : null;
  const curVer = String(pluginStatus?.version || "").replace(/^v/i, "");
  const anyKnown = MODES.some(m => m.mode === current);
  el.innerHTML = `<div class="lt-narrow lt-narrow-wide">
    <div class="lt-head">
      <div><h2 class="lt-page-title lt-title-tight">Режим</h2>
      <p class="lt-page-sub">Переключите бэкенд, используемый для разблокировки игр, добавленных через LuaProject.</p></div>
      <button class="lt-btn lt-btn-ghost" id="lt-mode-check">${UI_ICONS.refresh} Проверить обновления</button>
    </div>
    ${MODES.map(m => {
      const active = current === m.mode;
      const latest = modeLatest[m.key];
      const status = active
        ? (latest && latest.replace(/^v/i, "") !== curVer ? `<span class="lt-warn">Доступно обновление ${esc(latest)}</span>` : "Актуально")
        : (latest ? `Последняя версия: ${esc(latest)}` : "Неактивен");
      return `<div class="lt-mcard">
        <div class="lt-mcard-main">
          <div class="lt-mcard-title">${UI_ICONS.wrench}<strong>${m.title}</strong>${active ? BADGE.active : ""}${m.badges.map(b => BADGE[b]).join("")}</div>
          <p class="lt-mcard-desc">${m.desc}</p>
          <div class="lt-mcard-status">${status}</div>
        </div>
        <button class="lt-btn lt-btn-ghost" data-install-mode="${m.key}">${active ? "Переустановить" : "Переключиться на этот"}</button>
      </div>`;
    }).join("")}
    <div class="lt-mcard">
      <div class="lt-mcard-main">
        <div class="lt-mcard-title">${UI_ICONS.wrench}<strong>Свой анлокер</strong>${current && !anyKnown ? BADGE.active : ""}</div>
        <p class="lt-mcard-desc">Используй своё решение для разблокировки — мы в него не лезем. Плагины, установленные этим приложением, будут удалены.</p>
        <div class="lt-mcard-status">${current && !anyKnown ? `Активен · ${esc(current)}` : "Неактивен"}</div>
      </div>
      <button class="lt-btn lt-btn-ghost" data-install-mode="custom">Переключиться на этот</button>
    </div>
    <div class="lt-sep"></div>
    <div id="lt-cr-card"></div>
  </div>`;

  el.querySelectorAll("[data-install-mode]").forEach(btn => btn.addEventListener("click", async () => {
    const mode = btn.dataset.installMode;
    const msg = mode === "custom" ? "Удалить установленный этим приложением плагин и перейти на свой анлокер? Steam будет перезапущен."
      : "Установка перезапустит Steam. Продолжить?";
    if (!await confirmAction(msg)) return;
    btn.disabled = true; btn.textContent = "Устанавливаю…";
    try {
      toast(await invoke("lt_install_mode", { mode }), "ok");
      pluginStatus = await invoke("lt_plugin_status");
      renderMode(el);
    } catch (e) { toast(errMsg(e), "error"); btn.disabled = false; btn.textContent = "Повторить"; }
  }));

  el.querySelector("#lt-mode-check").addEventListener("click", e => withBusy(e.currentTarget, async () => {
    await Promise.all(MODES.map(m => invoke("lt_check_mode_update", { mode: m.key })
      .then(v => { if (v?.latest_tag) modeLatest[m.key] = v.latest_tag; }).catch(() => {})));
    renderMode(el);
  }));
  if (!Object.keys(modeLatest).length) el.querySelector("#lt-mode-check").click();

  try {
    const cr = await invoke("lt_cloud_redirect_state");
    const box = el.querySelector("#lt-cr-card");
    if (!box) return;
    box.innerHTML = `<div class="lt-mcard">
      <div class="lt-mcard-main">
        <div class="lt-mcard-title lt-cr-title">${UI_ICONS.cloud}<strong>CloudRedirect</strong></div>
        <p class="lt-mcard-desc">Возвращает встроенную поддержку Steam Cloud через сторонние хранилища, такие как Google Drive / OneDrive / Cloudflare R2 и другие. Пока совместимо только с BetterSteamTools. После включения перезапустите Steam.</p>
        <div class="lt-mcard-status">${!cr.supported ? "Нужен BetterSteamTools" : !cr.installed ? "Ещё не установлено." : cr.enabled ? '<span class="lt-ok">Включено</span>' : "Выключено"}</div>
      </div>
      <div class="lt-row-gap">
        <button class="lt-btn lt-btn-ghost" id="lt-cr-manage" title="Настройка облачных хранилищ (CloudRedirect.exe)">Управление</button>
        <button class="lt-btn lt-btn-ghost" id="lt-cr-toggle" ${cr.supported ? "" : "disabled"}>${cr.enabled ? "Выключить" : "Включить"}</button>
      </div>
    </div>`;
    box.querySelector("#lt-cr-manage").addEventListener("click", e => withBusy(e.currentTarget, () => launchTool("cloudredirect", "CloudRedirect")));
    box.querySelector("#lt-cr-toggle").addEventListener("click", e => withBusy(e.currentTarget, async () => {
      try {
        await invoke("lt_cloud_redirect_toggle", { enable: !cr.enabled });
        toast(cr.enabled ? "CloudRedirect выключен" : "CloudRedirect включён — перезапустите Steam", "ok");
        renderMode(el);
      } catch (err) { toast(errMsg(err), "error"); }
    }));
  } catch { /* нет Steam */ }
}

// ══════════════════════════════════════════════════════════════════
// FIXES
// ══════════════════════════════════════════════════════════════════

let fixesCache = null;
const fixState = { q: "", tag: null, mine: false, page: 0, perPage: 24 };

async function renderFixes(el, force = false) {
  el.innerHTML = `<div class="lt-head">
      <h2 class="lt-page-title">Фиксы</h2>
      <button class="lt-btn lt-btn-ghost" id="lt-fix-refresh">${UI_ICONS.refresh} Обновить</button>
    </div>
    <label class="lt-search">${UI_ICONS.search}<input type="text" id="lt-fix-search" placeholder="Поиск по имени или App ID…" value="${esc(fixState.q)}"></label>
    <div class="lt-chips" id="lt-fix-tags"></div>
    <div id="lt-fixes-list"><div class="lt-loading">Загружаю…</div></div>
    <div id="lt-fix-pager"></div>`;
  el.querySelector("#lt-fix-refresh").addEventListener("click", () => renderFixes(el, true));

  if (!fixesCache || force) {
    const data = await ltDenuvoListings();
    fixesCache = Array.isArray(data) ? [...data].sort((a, b) => (b.fixCount || 0) - (a.fixCount || 0)) : [];
  }
  if (currentPage !== "fixes") return;

  const tags = new Map();
  fixesCache.forEach(g => (g.tags || []).forEach(t => tags.set(t.id || t, t.name || t)));
  const tagBox = el.querySelector("#lt-fix-tags");
  const drawTags = () => {
    tagBox.innerHTML = `<button class="lt-chip2 ${fixState.mine ? "is-active" : ""}" data-mine>Мои игры</button>`
      + [...tags.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])))
        .map(([id, nm]) => `<button class="lt-chip2 ${fixState.tag === id ? "is-active" : ""}" data-tag="${esc(id)}">${esc(nm)}</button>`).join("");
    tagBox.querySelector("[data-mine]").addEventListener("click", () => { fixState.mine = !fixState.mine; fixState.page = 0; drawTags(); draw(); });
    tagBox.querySelectorAll("[data-tag]").forEach(b => b.addEventListener("click", () => {
      fixState.tag = fixState.tag === b.dataset.tag ? null : b.dataset.tag; fixState.page = 0; drawTags(); draw();
    }));
  };

  const draw = () => {
    const q = fixState.q.toLowerCase();
    const mine = new Set(installedList.map(i => String(i.app_id)));
    const list = fixesCache.filter(g =>
      (!q || (g.name || "").toLowerCase().includes(q) || String(g.appid).includes(q))
      && (!fixState.mine || mine.has(String(g.appid)))
      && (!fixState.tag || (g.tags || []).some(t => (t.id || t) === fixState.tag)));
    const pages = Math.max(1, Math.ceil(list.length / fixState.perPage));
    fixState.page = Math.min(fixState.page, pages - 1);
    const slice = list.slice(fixState.page * fixState.perPage, (fixState.page + 1) * fixState.perPage);
    const box = el.querySelector("#lt-fixes-list");
    box.innerHTML = slice.length
      ? `<div class="lt-gc-grid">${slice.map(g => gameCardHtml({ appId: g.appid, name: g.name || `App ${g.appid}`, img: g.header_image, sub: `Фиксов: ${g.fixCount ?? "?"}` }).replace('data-appid=', 'data-fixappid=')).join("")}</div>`
      : '<div class="lt-empty">Нет фиксов</div>';
    box.querySelectorAll("[data-fixappid]").forEach(b => b.addEventListener("click", () => openFixDetail(parseInt(b.dataset.fixappid, 10))));
    const pg = el.querySelector("#lt-fix-pager");
    pg.innerHTML = pagerHtml(fixState.page, pages, fixState.perPage);
    bindPager(pg, p => { fixState.page = p; draw(); el.closest(".lt-main")?.scrollTo?.(0, 0); }, n => { fixState.perPage = n; fixState.page = 0; draw(); });
  };
  drawTags();
  draw();
  el.querySelector("#lt-fix-search").addEventListener("input", e => { fixState.q = e.target.value.trim(); fixState.page = 0; draw(); });
}

// ══════════════════════════════════════════════════════════════════
// PLUGIN
// ══════════════════════════════════════════════════════════════════

async function renderPlugin(el) {
  try { pluginStatus = await invoke("lt_plugin_status"); } catch { /* keep */ }
  const ps = pluginStatus;
  const ver = ps?.version ? `v${String(ps.version).replace(/^v/i, "")}` : "—";
  const loaderOk = !!ps?.dll_path;
  const row = (ok, label, value) => `<div class="lt-st-row">${ok ? `<span class="lt-st-ok">${UI_ICONS.ok}</span>` : `<span class="lt-st-no">${UI_ICONS.no}</span>`}<span class="lt-st-label">${label}</span><span class="lt-st-val">${value}</span></div>`;
  el.innerHTML = `<div class="lt-narrow lt-narrow-wide">
    <h2 class="lt-page-title lt-title-tight">Плагин</h2>
    <p class="lt-page-sub">Анлокер Steam, через который работают игры, добавленные в LuaProject.</p>
    <div class="lt-panel lt-st">
      <div class="lt-st-head">${UI_ICONS.puzzle}<strong>Статус</strong></div>
      <div class="lt-st-row"><span class="lt-st-tag">${UI_ICONS.tag}</span><span class="lt-st-label">Установленная версия</span><span class="lt-st-val"><strong>${esc(ver)}</strong></span></div>
      ${row(!!ps?.installed, "Режим", esc(ps?.mode || "Не установлен"))}
      ${row(loaderOk, "Загрузчик", loaderOk ? `<code>${esc(ps.dll_path)}</code>` : "Не установлено")}
      ${row(!!steamInfo?.path, "Steam", steamInfo?.path ? esc(steamInfo.path) : "Не найден")}
      <div class="lt-st-actions">
        <button class="lt-btn lt-hs-btn" data-page="mode">${ps?.installed ? "Переустановить" : "Установить"}</button>
        <button class="lt-btn lt-btn-ghost" data-page="mode">Проверить обновления</button>
      </div>
    </div>
    <div class="lt-feat-title">Ключевые возможности</div>
    <div class="lt-feat"><span class="lt-feat-ic">${UI_ICONS.plus}</span>Игры из lua-файлов появляются в библиотеке Steam и скачиваются как обычные</div>
    <div class="lt-feat"><span class="lt-feat-ic">${UI_ICONS.refresh}</span>Манифесты обновляются автоматически, если депо не закреплены</div>
    <div class="lt-feat"><span class="lt-feat-ic">${UI_ICONS.cloud}</span>CloudRedirect — сохранения в облаке для разблокированных игр (BetterSteamTools)</div>
    <p class="lt-footnote">Плагин устанавливается в папку Steam. Переустановка и смена режима перезапускают Steam.</p>
  </div>`;
}


// ══════════════════════════════════════════════════════════════════
// UTILITIES (в «Настройках»): DLC, лимиты, DDM, Hubcap, DoH, Steamless
// ══════════════════════════════════════════════════════════════════

async function renderUtilities(el) {
  el.innerHTML = `<h3 class="lt-utils-title">Утилиты</h3>
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
          <input type="text" class="lt-input" id="lt-steamless-appid" placeholder="AppID" style="max-width:110px">
          <button class="lt-btn" id="lt-steamless-find">Найти exe</button>
        </div>
        <div class="lt-tool-form">
          <input type="text" class="lt-input" id="lt-steamless-exe" placeholder="Путь к .exe игры" list="lt-steamless-exes">
          <datalist id="lt-steamless-exes"></datalist>
        </div>
        <div class="lt-tool-form">
          <button class="lt-btn" id="lt-steamless-install-btn">Установить / Обновить</button>
          <button class="lt-btn lt-btn-primary" id="lt-steamless-run-btn">Снять DRM</button>
        </div>
        <pre id="lt-steamless-out" class="lt-muted" style="font-size:.75rem;max-height:200px;overflow:auto;margin-top:8px"></pre>
      </div>
      <div class="lt-tool-card"><h3>🧩 SteamAutoCrack</h3><p class="lt-muted">Эмулятор Steam API (Goldberg) для запуска без Steam. Скачивается с GitHub в папку приложения.</p>
        <div id="lt-sac-status" class="lt-muted">—</div>
        <div class="lt-tool-form"><button class="lt-btn lt-btn-primary" id="lt-sac-run">Запустить</button></div>
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
    try { toast("Скачиваю DepotDownloaderMod…", "info"); const path = await invoke("lt_depot_downloader_install"); toast("Установлено: " + path, "ok"); renderUtilities(el); }
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
      const expRaw = res?.api_key_expires_at ?? res?.expires_at ?? res?.expiry;
      const exp = expRaw ? (isNaN(Date.parse(expRaw)) ? expRaw : new Date(expRaw).toLocaleDateString()) : null;
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
  invoke("lt_tool_info", { tool: "steamautocrack" }).then(i => {
    const s = el.querySelector("#lt-sac-status");
    if (s) s.textContent = i.installed ? `Установлено · ${i.version || "?"}` : "Не установлено — скачается при запуске (~37 МБ)";
  }).catch(() => {});
  el.querySelector("#lt-sac-run")?.addEventListener("click", e => withBusy(e.currentTarget, () => launchTool("steamautocrack", "SteamAutoCrack")));
  el.querySelector("#lt-steamless-find")?.addEventListener("click", async () => {
    const aid = parseInt(el.querySelector("#lt-steamless-appid").value, 10);
    if (!aid) { toast("Введите AppID", "warn"); return; }
    try {
      const exes = await invoke("lt_find_game_exes", { appId: aid });
      if (!exes.length) { toast("Exe не найден", "warn"); return; }
      el.querySelector("#lt-steamless-exe").value = exes[0];
      el.querySelector("#lt-steamless-exes").innerHTML = exes.map(x => `<option value="${esc(x)}"></option>`).join("");
    } catch (err) { toast(errMsg(err), "error"); }
  });
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
          <img data-lt-img="${appId}" src="https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg" class="lt-detail-img" alt="">
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

    el.querySelector("#lt-back-fix")?.addEventListener("click", () => { switchPage("fixes"); });
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
        const url = ltDenuvoDownloadUrl(fixId, "manifest");
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
        const url = ltDenuvoDownloadUrl(fixId, "fix");
        const zipPath = await invoke("lt_download", { url, token: ltSession()?.access_token, destDir: await getTmpDir() });
        const result = await invoke("lt_apply_fix", { appId, zipPath });
        toast(`Фикс применён: ${result.files_extracted} файлов${result.backup_created ? ' (бэкап создан)' : ''}`, "ok");
        openFixDetail(appId);
      } catch (e) { toast(errMsg(e), "error"); }
    })));
  } catch (e) { el.innerHTML = `<button class="lt-btn lt-btn-sm" id="lt-back-fix">← Назад</button><div class="lt-error" style="margin-top:12px">${esc(errMsg(e))}</div>`; el.querySelector("#lt-back-fix")?.addEventListener("click", () => { switchPage("fixes"); }); }
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
    el.querySelector("#lt-dl-active").innerHTML = dlQueue.items.map(i => `<div class="lt-dl-item"><span>${esc(i.label)}</span><div class="lt-usage-bar"><div class="lt-usage-fill" style="width:${i.progress}%"></div></div><span class="lt-muted">${esc(ST[i.status] || i.status)}${i.status === "downloading" && i.progress ? ` · ${i.progress}%` : ""}</span>${i.status === "pending" ? `<button class="lt-btn lt-btn-sm" data-dl-move="${i.id}:-1" title="Выше">▲</button><button class="lt-btn lt-btn-sm" data-dl-move="${i.id}:1" title="Ниже">▼</button><button class="lt-btn lt-btn-sm" data-dl-cancel="${i.id}">Отмена</button>` : ""}</div>`).join("");
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
      <label class="lt-info-row"><input type="checkbox" id="lt-cfg-hardfilter" ${cfg.filter_hardware !== false ? 'checked' : ''}> Скрывать hardware AppID из поиска</label>
    </div></div>

    <div class="lt-section"><h3>Источники</h3>
    <div class="lt-settings-list">
      <label class="lt-info-row"><input type="checkbox" id="lt-src-sushi" ${cfg.src_sushi !== false ? 'checked' : ''}> sushitools-games-repo</label>
      <label class="lt-info-row"><input type="checkbox" id="lt-src-hubcap" ${cfg.src_hubcap ? 'checked' : ''}> Hubcap (нужен API-ключ)</label>
    </div></div>

    <div class="lt-section"><h3>Магазин Steam</h3>
    <div class="lt-settings-list">
      <label class="lt-info-row"><input type="checkbox" id="lt-cfg-store" ${cfg.store_button ? 'checked' : ''}> Кнопка «Добавить в LuaProject» на страницах игр в магазине Steam</label>
      <div class="lt-muted" id="lt-store-state" style="font-size:.75rem">Steam перезапустится с отладкой CEF (порт 8080, только localhost).</div>
    </div></div>

    <div class="lt-section"><h3>Сеть</h3>
    <div class="lt-settings-list">
      <label class="lt-info-row"><input type="checkbox" id="lt-cfg-doh" ${cfg.use_doh ? 'checked' : ''}> DNS-over-HTTPS (1.1.1.1) — если провайдер блокирует lua.tools или GitHub</label>
    </div></div>

    <div class="lt-section"><h3>API-сервер</h3>
    <div class="lt-settings-list">
      <div class="lt-info-row"><label>Base URL: <input type="text" class="lt-input" id="lt-cfg-apibase" value="${esc(cfg.api_base || '')}" placeholder="https://lua.tools (по умолчанию)" style="width:300px"></label></div>
      <button class="lt-btn lt-btn-sm" id="lt-cfg-apibase-save">Сохранить</button>
      <span class="lt-muted">Оставьте пустым для lua.tools</span>
    </div></div>

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
  const utils = document.createElement("div");
  utils.className = "lt-section lt-utils";
  el.appendChild(utils);
  renderUtilities(utils);
  const saveOn = (id, key, boolVal = true) => el.querySelector(id)?.addEventListener("change", async e => {
    const v = boolVal ? e.target.checked : e.target.value;
    try { await invoke("lt_config_set", { key, value: v }); ltConfig[key] = v; toast("Сохранено", "ok"); } catch (err) { toast(errMsg(err), "error"); }
  });
  saveOn("#lt-cfg-hardfilter", "filter_hardware");
  saveOn("#lt-src-sushi", "src_sushi");
  saveOn("#lt-src-hubcap", "src_hubcap");
  saveOn("#lt-cfg-doh", "use_doh");
  el.querySelector("#lt-cfg-store")?.addEventListener("change", async e => {
    const on = e.target.checked;
    try {
      await invoke("lt_store_button_set", { enabled: on });
      ltConfig.store_button = on;
      toast(on ? "Кнопка в магазине включена" : "Кнопка в магазине выключена", "ok");
    } catch (err) { e.target.checked = !on; toast(errMsg(err), "error"); }
  });
  invoke("lt_store_button_state").then(st => {
    const n = el.querySelector("#lt-store-state");
    if (n && st.enabled) n.textContent = st.cef_debug ? "Работает: Steam доступен по CEF." : "Включено, но Steam запущен без отладки CEF — перезапустите Steam из LuaProject.";
  }).catch(() => {});
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
  // «Сбросить загруженные» — команда локального MFG-плагина (127.0.0.1:6767), без него не работает.
  invoke("lt_mfg_ping").then(ok => {
    const b = el.querySelector("#lt-cef-dismiss");
    if (b && !ok) { b.disabled = true; b.title = "Нужен запущенный MFG-плагин (127.0.0.1:6767)"; }
  }).catch(() => {});
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
            <div class="lt-row-gap" style="margin-top:6px;flex-wrap:wrap">
              <button class="lt-btn lt-btn-sm" id="lt-d-copy">Копировать AppID</button>
              ${luaInfo ? '<button class="lt-btn lt-btn-sm" id="lt-d-reveal">Показать lua в папке</button>' : ""}
              <a class="lt-btn lt-btn-sm" target="_blank" href="https://steamdb.info/app/${appId}/">SteamDB</a>
              ${gameInfo.installed ? '<button class="lt-btn lt-btn-sm" id="lt-d-drm" title="Steamless: снять SteamStub с exe игры">Снять DRM</button>' : ""}
            </div>
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
          ${ltConfig.src_hubcap && ltConfig.hubcap_key ? `<button class="lt-btn lt-btn-sm" id="lt-hubcap-btn" data-dl-alt="hubcap" data-appid="${appId}" data-game-name="${esc(name)}">📥 Hubcap <span class="lt-muted" id="lt-hubcap-badge">…</span></button>` : ''}
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
    if (el.querySelector("#lt-hubcap-badge")) {
      invoke("lt_hubcap_status", { appId, apiKey: ltConfig.hubcap_key }).then(st => {
        const b = el.querySelector("#lt-hubcap-badge");
        if (!b) return;
        const ok = st && st.available !== false && !/unavail|missing|none/i.test(String(st.status || ""));
        b.textContent = ok ? "· есть" : "· нет";
        b.className = ok ? "lt-ok" : "lt-muted";
      }).catch(() => { const b = el.querySelector("#lt-hubcap-badge"); if (b) b.textContent = ""; });
    }
    el.querySelector("#lt-d-copy")?.addEventListener("click", () => {
      navigator.clipboard.writeText(String(appId)).then(() => toast("AppID скопирован", "ok"), () => toast("Буфер обмена недоступен", "error"));
    });
    el.querySelector("#lt-d-reveal")?.addEventListener("click", async () => {
      try {
        const info = await invoke("lt_steam_info");
        await invoke("reveal_in_folder", { path: `${info.path}\\config\\stplug-in\\${appId}.lua` });
      } catch (err) { toast(errMsg(err), "error"); }
    });
    el.querySelector("#lt-d-drm")?.addEventListener("click", e => withBusy(e.currentTarget, async () => {
      try {
        const exes = await invoke("lt_find_game_exes", { appId });
        if (!exes.length) { toast("Exe игры не найден", "warn"); return; }
        if (!await confirmAction(`Снять SteamStub DRM с ${exes[0]}? Оригинал сохранится как .exe.bak.`)) return;
        if (!(await invoke("lt_steamless_info")).installed) { toast("Скачиваю Steamless…", "info"); await invoke("lt_steamless_install"); }
        await invoke("lt_steamless_run", { exePath: exes[0] });
        toast("DRM снят", "ok");
      } catch (err) { toast(errMsg(err), "error"); }
    }));
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
        <td>${e.id === (lua.baseAppId || appId) ? "Base" : e.hasKey ? "Депо" : "DLC"}</td>
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
  if (!await confirmOverwrite(appId)) { inflight.delete(key); return; }
  const url = ltManifestDownloadUrl(appId, source, gameName);
  const item = queueAdd(`${gameName || appId} (${source})`, appId);
  item._url = url;
  retryFns.set(item.id, () => doDownload(appId, source, gameName));
  if (currentPage === "downloads") renderPage("downloads");
  try { await queueTurn(item); } catch { inflight.delete(key); return; }
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
    await ensureManifests(appId);
    openDetail(appId);
  } catch (e) {
    queueDone(item, false, errMsg(e));
    toast(`Ошибка: ${errMsg(e)}`, "error");
  } finally { inflight.delete(key); }
}

// The lua pins manifest GIDs; Steam can't download a depot without its
// <depot>_<gid>.manifest, so pull any that the archive didn't include.
async function ensureManifests(appId) {
  try {
    const r = await invoke("lt_fetch_missing_manifests", { appId, token: ltSession()?.access_token || "" });
    if (r.fetched) toast(`Догружено манифестов: ${r.fetched}`, "ok");
    if (r.failed.length) toast(`Манифесты не найдены: ${r.failed.join(", ")}`, "warn");
  } catch { /* lua without pins or Steam missing: nothing to fetch */ }
}

// Click on "Add to LuaProject" in the Steam store (via the CEF injector).
async function handleStoreAdd(appId) {
  if (!appId) return;
  const status = text => invoke("lt_store_status", { appId, text }).catch(() => {});
  status("Ищу источник…");
  try {
    const name = (await ltGameDetails(String(appId)).catch(() => null))?.name || gameName(appId);
    let src = null;
    if (ltIsLoggedIn()) {
      const sources = await ltCheckSources(String(appId)).catch(() => ({}));
      src = Object.entries(sources).find(([, v]) => v === "available")?.[0] || null;
    }
    if (src) await doDownload(appId, src, name);
    else if (ltConfig.src_hubcap && ltConfig.hubcap_key) await doAltDownload(appId, "hubcap", name);
    else if (ltConfig.src_sushi !== false) await doAltDownload(appId, "sushi", name);
    else { status(ltIsLoggedIn() ? "Нет источников" : "Войдите в LuaProject"); return; }
    status(installedList.some(i => i.app_id === appId) ? "Добавлено ✓ — перезапустите Steam" : "Не удалось — см. LuaProject");
  } catch (e) { status("Ошибка: " + errMsg(e)); }
}

async function doAltDownload(appId, alt, gameName) {
  const key = `${appId}:${alt}`;
  if (inflight.has(key)) { toast("Уже скачивается", "info"); return; }
  inflight.add(key);
  if (!await confirmOverwrite(appId)) { inflight.delete(key); return; }
  const item = queueAdd(`${gameName || appId} (${alt})`, appId);
  retryFns.set(item.id, () => doAltDownload(appId, alt, gameName));
  if (currentPage === "downloads") renderPage("downloads");
  try { await queueTurn(item); } catch { inflight.delete(key); return; }
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
    await ensureManifests(appId);
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
    text = setDepotLocked(text, depotId, lock);
    await invoke("lt_write_lua", { appId, content: text });
    toast(lock ? `${depotId} закреплён` : `${depotId} откреплён`, "ok");
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

function promptName(title, value = "") {
  return new Promise(resolve => {
  const ov = document.createElement("div");
  ov.className = "lt-confirm-overlay";
  ov.innerHTML = `<div class="lt-confirm-box"><p>${esc(title)}</p><input type="text" class="lt-input" value="${esc(value)}" style="width:100%"><div class="lt-confirm-actions"><button class="lt-btn lt-btn-primary">OK</button><button class="lt-btn">Отмена</button></div></div>`;
  document.body.appendChild(ov);
  const inp = ov.querySelector("input"); inp.focus(); inp.select();
  const done = v => { ov.remove(); resolve(v); };
  const [ok, cancel] = ov.querySelectorAll("button");
  ok.addEventListener("click", () => done(inp.value.trim() || null));
  cancel.addEventListener("click", () => done(null));
  inp.addEventListener("keydown", e => { if (e.key === "Enter") done(inp.value.trim() || null); if (e.key === "Escape") done(null); });
});
}

async function launchTool(tool, label) {
  try {
    const info = await invoke("lt_tool_info", { tool });
    let latest = null;
    try { latest = await invoke("lt_tool_latest", { tool }); } catch { /* offline: use what we have */ }
    if (!info.installed || (latest && info.version && latest !== info.version)) {
      toast(`${info.installed ? "Обновляю" : "Скачиваю"} ${label}${latest ? ` ${latest}` : ""}…`, "info");
      await invoke("lt_tool_install", { tool });
    }
    await invoke("lt_tool_launch", { tool });
    toast(`${label} запущен`, "ok");
  } catch (e) { toast(`${label}: ${errMsg(e)}`, "error"); }
}

async function doCodeLogin() {
  const code = await promptName("Код из Discord-бота LuaTools");
  if (!code) return;
  try {
    await ltRedeemBotCode(code);
    updateAuthUI();
    toast("Вошли в lua.tools", "ok");
  } catch (e) { toast(`Вход не выполнен: ${errMsg(e)}`, "error"); }
}

let loginPending = false;
async function doLogin() {
  if (loginPending) { toast("Вход уже открыт в браузере", "info"); return; }
  loginPending = true;
  toast("Войдите через Discord в открывшемся браузере", "info");
  try {
    const pkce = await ltPkceStart();
    let tokens = await invoke("lt_oauth_login", { loginUrl: pkce.url });
    // Server answered with a PKCE code (normal) or, on older setups, implicit tokens.
    if (tokens.code) tokens = await ltPkceExchange(tokens.code, pkce.verifier);
    let user = tokens.user || null;
    if (!user) { try { user = await ltFetchUser(tokens.access_token); } catch { /* имя не критично */ } }
    ltSaveSession({ ...tokens, user });
    updateAuthUI();
    toast("Вошли в lua.tools", "ok");
  } catch (e) {
    toast(`Вход не выполнен: ${errMsg(e)}`, "error");
  } finally { loginPending = false; }
}

// Сессия на диске — только зашифрованная DPAPI (ключ привязан к учётке Windows).
async function persistEncryptedSession(data) {
  if (!data?.access_token) {
    await invoke("lt_config_set", { key: "session_enc", value: null });
    return;
  }
  const enc = await invoke("lt_dpapi_encrypt", { plaintext: JSON.stringify(data) });
  await invoke("lt_config_set", { key: "session_enc", value: enc });
}

// Любая смена сессии (вход, refresh токена, выход) — пересохраняем.
ltOnSessionChange(s => { persistEncryptedSession(s).catch(() => {}); });

let sessionRestored = false;
async function restoreEncryptedSession() {
  if (sessionRestored) return;
  sessionRestored = true;
  const legacy = ltTakeLegacySession();
  if (ltConfig.session_enc) {
    try {
      const data = JSON.parse(await invoke("lt_dpapi_decrypt", { ciphertextB64: ltConfig.session_enc }));
      if (data?.access_token) { ltSaveSession(data); return; }
    } catch { /* другая учётка Windows / повреждено */ }
  }
  // Перенос открытой сессии из старых версий → сразу перешифровывается слушателем выше.
  if (legacy?.access_token) ltSaveSession(legacy);
}
