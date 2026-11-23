import { can, state } from "./state.js";
import { clientHeaders, API_BASE, toast } from "./api.js";
import { $ } from "./utils.js";
import { pickOutputDir, pickOutputFile } from "./tauri.js";
import { downloadWithCard } from "./download-card.js";
import { openCatalog } from "./parser-catalog.js";
import { askCatalogLogin, catalogLogout, mountOwnerAccounts } from "./parser-settings.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtSize(b) {
  if (!b) return "";
  const m = b / 1024 / 1024;
  return m > 1 ? `${m.toFixed(1)} МБ` : `${(b / 1024).toFixed(0)} КБ`;
}

function fmtDur(s) {
  if (!s) return "";
  const n = Math.round(s), h = (n / 3600) | 0, m = ((n % 3600) / 60) | 0, sec = n % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

async function errorText(res) {
  try { const j = await res.json(); if (j.detail) return j.detail; } catch (_) { }
  return `HTTP ${res.status}`;
}

function saveFilter(ext) {
  const e = String(ext || "mp4").toLowerCase().replace(/^\./, "");
  return [{ name: ["zip", "rar", "7z"].includes(e) ? `Архив ${e.toUpperCase()}` : `Файл ${e.toUpperCase()}`, extensions: [e] }];
}

function engineOf(c) {
  if (["zip", "rar", "7z"].includes(c.ext)) return "direct";
  if (/^https:\/\/(www\.)?mega\.(nz|io)\//i.test(c.url || "")) return "megatools";
  return /m3u8|dash|mpd|ism|mss/i.test(`${c.protocol || ""} ${c.ext || ""}`) ? "N_m3u8DL-RE" : "yt-dlp";
}

const ENGINE_KEY = "project_parser_engine";
const ENGINE_NAMES = { nm3u8: "N_m3u8DL-RE", ytdlp: "yt-dlp", megatools: "megatools", direct: "напрямую", torrent: "торрент" };

function torrentStats(j) {
  const peers = `сиды ${j.seeds || 0} · пиры ${j.peers || 0}`;
  if (j.phase === "metadata") return `ищу участников раздачи · ${peers}`;
  const mb = n => (n / 1024 / 1024).toFixed(0);
  const eta = j.eta ? ` · ещё ${j.eta >= 3600 ? `${Math.floor(j.eta / 3600)} ч ${Math.round(j.eta % 3600 / 60)} мин` : `${Math.max(1, Math.round(j.eta / 60))} мин`}` : "";
  const spd = j.speed ? ` · ${(j.speed / 1024 / 1024).toFixed(1)} МБ/с` : (j.total ? " · стоит" : "");
  return `${j.percent || 0}% · ${mb(j.downloaded || 0)}/${mb(j.total || 0)} МБ${spd}${eta} · ${peers}`;
}

function readEngine() {
  try { const v = localStorage.getItem(ENGINE_KEY); return v === "nm3u8" || v === "ytdlp" ? v : "auto"; } catch (_) { return "auto"; }
}

let pageListeners = null;

function isHttpUrl(v) {
  try { const u = new URL(v); return u.protocol === "https:" || u.protocol === "http:"; } catch { return false; }
}

function skeletonHtml() {
  return `<div class="pr-meta pr-skel" aria-hidden="true"><div class="pr-poster"></div><div class="pr-meta-body"><i style="width:30%"></i><i style="width:70%;height:18px"></i><i style="width:45%"></i></div></div>
    <div class="pr-list pr-skel" aria-hidden="true">${"<div class=\"pr-row\"><i style=\"width:48px;height:22px\"></i><i style=\"flex:1\"></i><i style=\"width:150px;height:30px\"></i></div>".repeat(3)}</div>`;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function layout() {
  return `
    <div class="pr-wrap">
      <section class="pr-hero" id="pr-hero">
        <div class="pr-hero-bg" id="pr-hero-bg" aria-hidden="true"></div>
        <div class="pr-hero-body">
          <button class="pr-gear pr-cat-ic" type="button" id="pr-catalog" title="Каталог сайтов" aria-label="Каталог сайтов"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg></button>
          <button class="pr-gear" type="button" id="pr-settings-btn" title="Настройки загрузчика" aria-label="Настройки загрузчика" aria-expanded="false">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
            </button>
          <div class="pr-head">
            <h2>Загрузчик видео <span class="pr-beta">Beta</span></h2>
            <small>Вставьте ссылку на страницу с видео — найдём постер, потоки и качества.</small>
          </div>
          <form class="pr-form" id="pr-form">
            <label class="pr-url-field" id="pr-url-field">
              <span class="pr-host-chip" id="pr-host-chip" hidden><i id="pr-host-ic"></i><b id="pr-host-name"></b></span>
              <input id="pr-url" type="url" placeholder="https://… ссылка на страницу с видео" autocomplete="off" required spellcheck="false">
              <button class="pr-paste" type="button" id="pr-paste" title="Вставить ссылку из буфера" aria-label="Вставить из буфера"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6v3H9zM8 5.5H6.5A1.5 1.5 0 0 0 5 7v12.5A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V7a1.5 1.5 0 0 0-1.5-1.5H16"/></svg><span>Вставить</span></button>
            </label>
            <button class="btn primary" type="submit" id="pr-submit">Найти</button>
          </form>
          <div class="pr-hints">
            <span>Не нашлось видео? <button type="button" class="pr-link" id="pr-deep" title="Открыть страницу в браузере на сервере и перехватить сеть">Глубокий анализ</button></span>
          </div>
          <div class="pr-drop-hint" aria-hidden="true">Отпустите, чтобы найти видео</div>
          <div class="pr-settings" id="pr-settings" hidden>
            <div class="pr-set-row pr-set-col">
              <span><b>Загрузчик</b><small>Каким движком качать потоки.</small></span>
              <div class="pr-engines" id="pr-engines" role="group" aria-label="Загрузчик">
                <button type="button" class="pr-engine" data-engine="auto" title="Сначала N_m3u8DL-RE, если не вышло — yt-dlp">Авто <small>по очереди</small></button>
                <button type="button" class="pr-engine" data-engine="nm3u8" title="Только N_m3u8DL-RE: HLS и DASH">N_m3u8DL-RE <small>HLS и DASH</small></button>
                <button type="button" class="pr-engine" data-engine="ytdlp" title="Только yt-dlp">yt-dlp <small>поддерживаемые сайты</small></button>
              </div>
            </div>
            <div class="pr-set-row pr-set-col">
              <span><b>Cookies</b><small>Только для глубокого анализа: Chromium подставит их исходному сайту, загрузчику они не уходят.</small></span>
              <input id="pr-cookies" type="password" class="pr-cookies-input" placeholder="name=value; name2=value2" aria-label="Cookies для глубокого анализа" autocomplete="off" spellcheck="false">
            </div>
            <div class="pr-set-row" id="pr-set-session" hidden>
              <span><b>Каталог</b><small>Вы вошли в каталог.</small></span>
              <button type="button" class="btn sm" id="pr-catalog-logout">Выйти</button>
            </div>
            <div class="pr-set-owner" id="pr-set-owner" hidden></div>
          </div>
        </div>
      </section>
      <div class="pr-status" id="pr-status" hidden></div>
      <div class="pr-results" id="pr-results"></div>
      <div class="pr-history" id="pr-history"></div>
      <div class="pr-empty" id="pr-empty">
        <div class="pr-empty-ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M10 9l5 3-5 3z"/></svg></div>
        <b>Здесь появятся ваши загрузки</b>
        <small>Сервер скачает видео, а вы заберёте готовый файл. Файлы хранятся 30 минут.</small>
        <div class="pr-empty-tips">
          <div class="pr-tip"><b>Страница с плеером</b><small>Ссылка на серию или ролик — найдём все качества</small></div>
          <div class="pr-tip"><b>Прямая ссылка</b><small>.m3u8, .mpd или .mp4 — скачаем как есть</small></div>
          <button type="button" class="pr-tip" id="pr-tip-catalog"><b>Каталог сайтов</b><small>Поиск по подключённым источникам</small></button>
        </div>
      </div>
    </div>
  `;
}

export async function loadParser() {
  const body = $("#parser-body");
  if (!body) return;
  if (!can("parser.use")) {
    body.innerHTML = `<div class="pr-wrap"><div class="empty">Нет права «Загрузчик видео». Его выдаёт владелец в настройках ролей.</div></div>`;
    return true;
  }
  body.innerHTML = layout();
  const JOB_STATUS = { queued: "в очереди", analyzing: "ищу поток", running: "загружается", done: "готово", error: "ошибка", cancelled: "отменено" };
  const JOB_OPEN = new Set(["queued", "analyzing", "running"]);
  let historyTimer = null;
  const form = $("#pr-form");
  const input = $("#pr-url");
  const cookieInput = $("#pr-cookies");
  const submit = $("#pr-submit");
  const deepBtn = $("#pr-deep");
  const status = $("#pr-status");
  const results = $("#pr-results");

  form.addEventListener("submit", e => { e.preventDefault(); analyze(false); });

  const catalogBtn = $("#pr-catalog");
  let access = { unlocked: false, settings: false, labels: {} };
  const settingsBtn = $("#pr-settings-btn");
  const settingsBox = $("#pr-settings");
  const ownerBox = $("#pr-set-owner");
  let closeOwner = null;
  async function refreshAccess() {
    try {
      const r = await fetch(`${API_BASE}/parser/access/status`, { headers: clientHeaders() });
      if (r.ok) access = { ...access, ...(await r.json()) };
    } catch (_) { }
    $("#pr-set-session").hidden = !access.unlocked;
    if (access.settings && !closeOwner) { ownerBox.hidden = false; closeOwner = mountOwnerAccounts(ownerBox); }
    if (!access.settings && closeOwner) { closeOwner(); closeOwner = null; ownerBox.hidden = true; ownerBox.innerHTML = ""; }
  }
  refreshAccess();
  settingsBtn.addEventListener("click", () => {
    const open = settingsBox.hidden;
    if (open) refreshAccess();
    settingsBox.hidden = !open;
    settingsBtn.setAttribute("aria-expanded", String(open));
    settingsBtn.classList.toggle("on", open);
    if (!open) closeOwner?.();
  });
  $("#pr-catalog-logout").addEventListener("click", async () => {
    await catalogLogout();
    access = { ...access, unlocked: false, labels: {} };
    await refreshAccess();
    toast("Вы вышли из каталога", "info");
  });
  const hero = $("#pr-hero");
  catalogBtn.addEventListener("click", async () => {
    await refreshAccess();
    if (!access.unlocked && state.previewRole) { toast("В режиме предпросмотра каталог недоступен", "info"); return; }
    if (!access.unlocked) {
      if (!await askCatalogLogin()) return;
      await refreshAccess();
      if (!access.unlocked) return;
    }
    status.hidden = true;
    setBackdrop(null);
    hero.hidden = true;
    openCatalog(results, {
      onPick: url => { hero.hidden = false; input.value = url; results.onclick = null; analyze(false); },
      onClose: () => { hero.hidden = false; results.innerHTML = ""; },
      onQueued: () => loadHistory(true),
      labels: access.labels || {},
    });
  });
  deepBtn.addEventListener("click", () => analyze(true));
  $("#pr-tip-catalog").addEventListener("click", () => catalogBtn.click());
  loadHistory();

  const urlField = $("#pr-url-field");
  const hostChip = $("#pr-host-chip");
  function syncUrl() {
    const v = input.value.trim();
    const ok = isHttpUrl(v);
    const host = ok ? hostOf(v) : "";
    hostChip.hidden = !host;
    if (host) { $("#pr-host-name").textContent = host; $("#pr-host-ic").textContent = host[0].toUpperCase(); }
    urlField.classList.toggle("bad", !!v && !ok);
    urlField.classList.toggle("has-host", !!host);
  }
  input.addEventListener("input", syncUrl);
  const takeUrl = text => {
    const m = String(text || "").match(/https?:\/\/[^\s<>"']+/i);
    if (!m) return false;
    input.value = m[0];
    syncUrl();
    analyze(false);
    return true;
  };
  $("#pr-paste").addEventListener("click", async e => {
    e.preventDefault();
    try {
      const text = await navigator.clipboard.readText();
      if (!takeUrl(text)) toast("В буфере нет ссылки", "info");
    } catch { input.focus(); toast("Нажмите Ctrl+V, чтобы вставить", "info"); }
  });
  input.addEventListener("paste", e => {
    const text = e.clipboardData?.getData("text") || "";
    if (input.value.trim() || !isHttpUrl(text.trim())) return;
    e.preventDefault();
    takeUrl(text);
  });
  if (pageListeners) pageListeners.abort();
  pageListeners = new AbortController();
  document.addEventListener("paste", e => {
    if (!input.isConnected) { pageListeners?.abort(); return; }
    if (!input.offsetParent || hero.hidden) return;
    const t = e.target;
    if (t && (t.closest?.("input, textarea, [contenteditable]"))) return;
    if (takeUrl(e.clipboardData?.getData("text"))) e.preventDefault();
  }, { signal: pageListeners.signal });
  hero.addEventListener("dragover", e => {
    if (![...(e.dataTransfer?.types || [])].some(t => t === "text/uri-list" || t === "text/plain")) return;
    e.preventDefault();
    hero.classList.add("drop");
  });
  hero.addEventListener("dragleave", e => { if (!hero.contains(e.relatedTarget)) hero.classList.remove("drop"); });
  hero.addEventListener("drop", e => {
    hero.classList.remove("drop");
    const text = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    if (!takeUrl(text)) toast("Это не ссылка", "info");
  });

  let analyzeReferer = null;
  let engine = readEngine();
  let cookieOrigin = "";

  function pageOrigin(url) {
    try { return new URL(url).origin; } catch { return ""; }
  }

  cookieInput.addEventListener("input", () => { cookieOrigin = pageOrigin(input.value); });

  function syncEngine() {
    body.querySelectorAll("[data-engine]").forEach(b => {
      const on = b.dataset.engine === engine;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    results.querySelectorAll("[data-auto-engine]").forEach(el => { el.textContent = ENGINE_NAMES[engine] || el.dataset.autoEngine; });
  }

  $("#pr-engines").addEventListener("click", ev => {
    const btn = ev.target.closest("[data-engine]");
    if (!btn) return;
    engine = btn.dataset.engine;
    try { localStorage.setItem(ENGINE_KEY, engine); } catch (_) { }
    syncEngine();
  });
  syncEngine();

  async function analyze(deep) {
    const url = input.value.trim();
    if (!url) return;
    let fellBack = false;
    const cookies = cookieInput.value.trim();
    if (cookies && cookieOrigin && cookieOrigin !== pageOrigin(url)) {
      cookieInput.value = "";
      cookieOrigin = "";
      status.hidden = false;
      status.textContent = "Адрес сайта изменился. Введите cookies для нового сайта или запустите поиск без них.";
      return;
    }
    if (!deep && cookies) {
      status.hidden = false;
      status.textContent = "С cookies нажмите «Глубокий анализ» или очистите поле для обычного поиска.";
      return;
    }
    const referer = analyzeReferer;
    analyzeReferer = null;
    if (cookies) cookieOrigin = pageOrigin(url);
    submit.disabled = deepBtn.disabled = true;
    submit.textContent = deep ? "Браузер…" : "Ищу…";
    status.hidden = false;
    status.textContent = deep
      ? "Глубокий анализ: запускаю headless-Chromium, 10–15 секунд…"
      : "Ищу видео на странице…";
    results.innerHTML = skeletonHtml();
    setBackdrop(null);
    try {
      const start = () => fetch(`${API_BASE}/parser/analyze/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...clientHeaders() },
        body: JSON.stringify({ url, deep, referer, ...(deep && cookies ? { cookies } : {}) }),
      });
      let res = await start();
      if (res.status === 403) {
        const detail = await errorText(res);
        if (detail !== "source_locked") throw new Error(detail);
        if (!await askCatalogLogin()) { status.textContent = "Доступ закрыт: нужен вход в каталог."; return; }
        res = await start();
      }
      if (!res.ok) throw new Error(await errorText(res));
      const { analysis_id } = await res.json();
      let state;
      do {
        await new Promise(r => setTimeout(r, 600));
        const r = await fetch(`${API_BASE}/parser/analyze/${analysis_id}/status`, { headers: clientHeaders() });
        if (!r.ok) throw new Error(await errorText(r));
        state = await r.json();
        status.textContent = `${state.stage || "Анализ"}…`;
      } while (state.status === "running");
      if (state.status === "error") throw new Error(state.error || "Анализ не удался");
      const found = (state.result?.candidates || []).length;
      if (!deep && !found && !referer) {
        fellBack = true;
        status.textContent = "Обычный поиск ничего не нашёл — пробую глубокий анализ…";
        submit.disabled = deepBtn.disabled = false;
        return analyze(true);
      }
      renderResults(state.result);
    } catch (err) {
      results.innerHTML = "";
      status.textContent = `Ошибка: ${err.message || err}`;
      toast(`Загрузчик: ${err.message || err}`, "error");
    } finally {
      if (fellBack) return;
      submit.disabled = deepBtn.disabled = false;
      submit.textContent = "Найти";
    }
  }

  function setBackdrop(url) {
    const bg = $("#pr-hero-bg");
    const hero = $("#pr-hero");
    if (!bg || !hero) return;
    bg.style.backgroundImage = url ? `url("${url.replace(/["\\\n\r]/g, encodeURIComponent)}")` : "";
    hero.classList.toggle("has-poster", !!url);
  }

  function renderResults(r) {
    const diag = (r.diagnostics || []).map(d =>
      `<span class="pr-chip ${d.ok ? "ok" : "no"}">L${d.level} ${esc(d.name)}: ${d.ok ? (d.count ?? 0) + " найдено" : "—"}</span>`).join("");
    const poster = /^https:\/\//i.test(r.poster || "") ? r.poster : "";
    const host = hostOf(input.value.trim());
    const count = (r.candidates || []).length;
    // Лучший поток на каждое качество: mp4 по https надёжнее сегментированных и webm.
    const byHeight = new Map();
    (r.candidates || []).forEach((c, i) => {
      if (typeof c.quality !== "number" || c.audio_only || c.drm || c.name) return;
      const score = (c.protocol === "https" ? 2 : 0) + (c.ext === "mp4" ? 1 : 0);
      const prev = byHeight.get(c.quality);
      if (!prev || score > prev.score) byHeight.set(c.quality, { i, c, score });
    });
    const picks = [...byHeight.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => v);
    const def = picks.find(p => p.c.quality <= 1080) || picks[0];
    const pickHtml = picks.length >= 2 ? `
          <div class="pr-pick">
            <select id="pr-pick" class="field-input">${picks.map(p => `<option value="${p.i}"${p === def ? " selected" : ""}>${p.c.quality}p${p.c.ext ? ` · ${esc(p.c.ext)}` : ""}${p.c.filesize ? ` · ${p.c.filesize_estimated ? "≈ " : ""}${fmtSize(p.c.filesize)}` : ""}</option>`).join("")}</select>
            <button type="button" class="btn primary" id="pr-pick-dl" data-dl="${def.i}">Скачать</button>
          </div>` : "";
    const head = `
      <div class="pr-meta${poster ? "" : " no-poster"}">
        <div class="pr-poster">
          ${poster ? `<img id="pr-poster-img" src="${esc(poster)}" alt="" referrerpolicy="no-referrer">` : ""}
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 5h18v14H3z"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/></svg>
        </div>
        <div class="pr-meta-body">
          ${host ? `<div class="pr-host">${esc(host)}</div>` : ""}
          <div class="pr-title">${esc(r.title || "Без названия")}</div>
          <div class="pr-facts">
            ${r.duration ? `<span class="pr-dur">${fmtDur(r.duration)}</span>` : ""}
            <span class="pr-dur">${count ? `Потоков: ${count}` : "Потоки не найдены"}</span>
          </div>
          ${pickHtml}
          <div class="pr-diag">${diag}</div>
        </div>
      </div>`;

    const rowsHtml = (r.candidates || []).map((c, i) => {
      const q = c.name ? esc((c.ext || "файл").toUpperCase()) : typeof c.quality === "number" ? `${c.quality}p` : esc(c.quality || "?");
      const protoExt = [c.protocol, c.ext].filter(Boolean).join(" · ");
      const size = c.filesize ? `${c.filesize_estimated ? "≈ " : ""}${fmtSize(c.filesize)}` : "";
      const extras = [
        c.bitrate ? `${(c.bitrate / 1e6).toFixed(1)} Мбит/с` : "",
        c.codecs ? c.codecs.split(",")[0].split(".")[0] : "",
        c.mirrors?.length ? `+${c.mirrors.length} зеркал${c.mirrors.length === 1 ? "о" : "а"}` : "",
        c.audio_only ? "только звук" : "",
        c.alive === false ? "не отвечает" : "",
        c.drm ? "DRM" : "",
      ].filter(Boolean).map(x => ` · ${esc(x)}`).join("");
      return `
        <div class="pr-row">
          <div class="pr-col pr-q">${q}</div>
          <div class="pr-col pr-info">
            ${c.name ? `<div class="pr-name" title="${esc(c.name)}">${esc(c.name)}</div>` : ""}
            <div class="pr-src"><span class="pr-engine sm" data-auto-engine="${engineOf(c)}">${engineOf(c)}</span> ${esc(c.source || "")} ${protoExt ? `· ${esc(protoExt)}` : ""} ${size ? `· ${size}` : ""}${extras}</div>
            <div class="pr-url" title="${esc(c.url)}">${esc(c.url)}</div>
            ${c.drm ? `<div class="pr-key-row"><input type="text" class="pr-key-input" data-key="${i}" placeholder="KID:KEY (hex32:hex32)" spellcheck="false" autocomplete="off"><button type="button" class="btn sm" data-auto-key="${i}" title="Получить ключ автоматически через Widevine CDM">Авто</button></div>` : ""}
          </div>
          <div class="pr-col pr-actions">
            <button type="button" class="btn sm" data-copy="${i}">Копировать</button>
            <button type="button" class="btn sm primary" data-dl="${i}">Скачать</button>
          </div>
        </div>`;
    }).join("");

    const candidatesBlock = (r.candidates && r.candidates.length)
      ? (pickHtml ? `<details class="pr-reqs pr-all"><summary>Все потоки (${count}) — выбрать вручную</summary><div class="pr-list">${rowsHtml}</div></details>` : `<div class="pr-list">${rowsHtml}</div>`)
      : `<div class="empty">${esc(r.reason?.message || "Видео не нашлось даже глубоким анализом.")} Проверьте, что ссылка открывает страницу с плеером, или выберите поток вручную из сетевых запросов ниже.</div>`;

    const allReqs = (r.requests || []).filter(x => x.status && x.status < 400);
    const reqs = [
      ...allReqs.filter(x => x.media),
      ...allReqs.filter(x => !x.media),
    ];
    const reqRows = reqs.map((x, i) => {
      const ct = (x.content_type || "").split(";")[0];
      const size = fmtSize(x.size);
      return `
        <div class="pr-req${x.media ? " on" : ""}">
          <div class="pr-req-ct">${x.media ? "🎬 " : ""}${esc(ct)}${size ? ` · ${size}` : ""}</div>
          <div class="pr-req-url" title="${esc(x.url)}">${esc(x.url)}</div>
          <div class="pr-req-actions">
            <button type="button" class="btn sm" data-req-copy="${i}">Копировать</button>
            <button type="button" class="btn sm primary" data-req-dl="${i}">Скачать</button>
          </div>
        </div>`;
    }).join("");
    const requestsBlock = reqs.length
      ? `<details class="pr-reqs"><summary>Сетевые запросы страницы (${reqs.length}) — выбрать вручную</summary><div class="pr-req-list">${reqRows}</div></details>`
      : "";

    const notice = r.reason && r.candidates?.length ? `<div class="pr-status">${esc(r.reason.message)}</div>` : "";
    results.innerHTML = head + notice + profileHtml(r.profile) + candidatesBlock + requestsBlock;
    status.hidden = true;
    bindProfile(r);
    $("#pr-pick")?.addEventListener("change", e => { $("#pr-pick-dl").dataset.dl = e.target.value; });
    syncEngine();
    const posterImg = $("#pr-poster-img");
    if (posterImg) {
      posterImg.addEventListener("load", () => setBackdrop(poster), { once: true });
      posterImg.addEventListener("error", () => {
        posterImg.remove();
        results.querySelector(".pr-meta")?.classList.add("no-poster");
      }, { once: true });
    }

    results.onclick = async ev => {
      const cp = ev.target.closest("[data-copy]");
      const dl = ev.target.closest("[data-dl]");
      const rc = ev.target.closest("[data-req-copy]");
      const rd = ev.target.closest("[data-req-dl]");
      if (cp) {
        const c = r.candidates[+cp.dataset.copy];
        try { await navigator.clipboard.writeText(c.url); toast("Ссылка в буфере", "info"); } catch { toast("Не вышло скопировать", "error"); }
      } else if (rc) {
        const q = reqs[+rc.dataset.reqCopy];
        try { await navigator.clipboard.writeText(q.url); toast("Ссылка в буфере", "info"); } catch { toast("Не вышло скопировать", "error"); }
      } else if (ev.target.closest("[data-auto-key]")) {
        const ab = ev.target.closest("[data-auto-key]");
        const idx = +ab.dataset.autoKey;
        const c = r.candidates[idx];
        const ki = results.querySelector(`[data-key="${idx}"]`);
        ab.disabled = true; ab.textContent = "Получаю…";
        try {
          const res = await fetch(`${API_BASE}/parser/drm/keys`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...clientHeaders() },
            body: JSON.stringify({ mpd_url: c.url, page_url: input.value.trim() }),
          });
          if (!res.ok) throw new Error(await errorText(res));
          const { keys } = await res.json();
          if (keys?.length && ki) ki.value = keys.join(", ");
          else toast("Ключи не найдены", "error");
        } catch (err) {
          toast(`DRM: ${err.message || err}`, "error");
        } finally { ab.disabled = false; ab.textContent = "Авто"; }
      } else if (dl || rd) {
        const btn = dl || rd;
        const idx = dl ? +dl.dataset.dl : null;
        const item = dl ? r.candidates[idx] : {
          url: reqs[+rd.dataset.reqDl].url,
          headers: { "Referer": input.value.trim(), "Origin": new URL(input.value.trim()).origin },
        };
        const keyInput = idx !== null ? results.querySelector(`[data-key="${idx}"]`) : null;
        const keys = keyInput?.value.split(/[,\s]+/).map(s => s.trim()).filter(Boolean) || [];
        if (keys.length) item.keys = keys;
        btn.disabled = true;
        btn.textContent = "Куда сохранить…";
        try {
          await downloadCandidate(item, r.title, btn);
        } catch (err) {
          toast(`Загрузка: ${err.message || err}`, "error");
        } finally {
          btn.disabled = false;
          btn.textContent = "Скачать";
          btn.classList.remove("pr-dl-progress");
          btn.style.removeProperty("--pr-progress");
          loadHistory();
        }
      }
    };

    const only = r.candidates || [];
    if (only.length === 1 && !only[0].audio_only && !only[0].drm && only[0].alive !== false) {
      results.querySelector('[data-dl="0"]')?.click();
    }
  }

  async function downloadCandidate(c, title, btn) {
    const defaultName = ((c.name || "").replace(/\.[^.]+$/, "") || title || "video").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 100) || "video";
    const ext = ["zip", "rar", "7z"].includes(c.ext) ? c.ext : "mp4";
    const savePath = await pickOutputFile(`${defaultName}.${ext}`, saveFilter(ext));
    if (!savePath) return;
    toast(`Сохраню в ${savePath}`, "info");
    btn.textContent = "0%";

    const start = await fetch(`${API_BASE}/parser/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...clientHeaders() },
      body: JSON.stringify({ url: c.url, headers: c.headers || {}, name: (c.name || "").replace(/\.[^.]+$/, "") || title || "video", engine, ...(c.keys?.length ? { keys: c.keys } : {}) }),
    });
    if (!start.ok) throw new Error(await errorText(start));
    const { job_id } = await start.json();
    loadHistory();

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn sm";
    cancelBtn.textContent = "Отмена";
    cancelBtn.onclick = () => {
      cancelBtn.disabled = true;
      fetch(`${API_BASE}/parser/download/${job_id}/cancel`, { method: "POST", headers: clientHeaders() })
        .catch(() => { cancelBtn.disabled = false; });
    };
    btn.after(cancelBtn);

    let job = null;
    try {
      while (true) {
        await new Promise(r => setTimeout(r, 700));
        const r = await fetch(`${API_BASE}/parser/download/${job_id}/status`, {
          headers: clientHeaders(),
        });
        if (!r.ok) throw new Error(`статус HTTP ${r.status}`);
        job = await r.json();
        if (btn) renderBtnProgress(btn, job);
        if (job.status === "done") break;
        if (job.status === "cancelled") { toast("Загрузка отменена", "info"); return; }
        if (job.status === "error") throw new Error(job.error || "Ошибка загрузки");
      }
    } finally {
      cancelBtn.remove();
    }

    btn.textContent = "Сохраняю…";
    await saveJob(job_id, savePath);
  }

  function profileHtml(p) {
    if (!p || (!p.translations?.length && !p.episodes?.length)) return "";
    const voices = (p.translations || []).map((t, i) =>
      `<option value="${i}"${t.selected ? " selected" : ""}>${esc(t.title)}${t.type === "subtitles" ? " (субтитры)" : ""}</option>`).join("");
    const episodes = (p.episodes || []).map((e, i) =>
      `<label class="pr-ep"><input type="checkbox" data-ep="${i}"${String(e.id) === String(p.current_episode) ? " checked" : ""}> ${esc(e.number ?? "")}<small>${esc(e.label || "")}</small></label>`).join("");
    return `
      <div class="pr-profile">
        ${voices ? `<label class="pr-field">Озвучка <select id="pr-voice">${voices}</select></label>` : ""}
        <label class="pr-field">Качество <select id="pr-quality">
          <option value="1080">до 1080p</option><option value="720" selected>до 720p</option><option value="480">до 480p</option><option value="360">до 360p</option>
        </select></label>
        ${voices ? `<button type="button" class="btn sm" id="pr-voice-open">Найти потоки этой озвучки</button>` : ""}
        <button type="button" class="btn sm primary" id="pr-enqueue">${episodes ? "Выбранные серии в очередь" : "В очередь"}</button>
        ${episodes ? `<button type="button" class="btn sm" id="pr-ep-all">Выбрать все</button><div class="pr-eps">${episodes}</div>` : ""}
      </div>`;
  }

  function bindProfile(r) {
    const p = r.profile;
    if (!p) return;
    const voice = () => p.translations?.[+($("#pr-voice")?.value ?? -1)];
    $("#pr-voice-open")?.addEventListener("click", () => {
      const v = voice();
      if (!v) return;
      if (cookieOrigin && cookieOrigin !== pageOrigin(v.url)) {
        cookieInput.value = "";
        cookieOrigin = "";
      }
      input.value = v.url;
      analyzeReferer = p.referer || null;
      analyze(true);
    });
    $("#pr-ep-all")?.addEventListener("click", () => {
      const boxes = [...results.querySelectorAll("[data-ep]")];
      const on = !boxes.every(b => b.checked);
      boxes.forEach(b => { b.checked = on; });
    });
    $("#pr-enqueue")?.addEventListener("click", async ev => {
      const btn = ev.currentTarget;
      const picked = [...results.querySelectorAll("[data-ep]:checked")].map(b => p.episodes[+b.dataset.ep]);
      const quality = +$("#pr-quality").value;
      const title = r.title || "video";
      const v = voice();
      let payload;
      if (p.site === "animelib") {
        if (!picked.length || !v) { toast("Выберите серии и озвучку", "error"); return; }
        payload = { site: "animelib", episode_ids: picked.map(e => e.id), team: v.title, title, referer: p.referer, quality };
      } else if (p.episodes?.length) {
        if (!picked.length) { toast("Выберите серии", "error"); return; }
        payload = { items: picked.map(e => ({ url: e.url, referer: p.referer, name: `${title} - ${e.number}` })), quality };
      } else {
        payload = { items: [{ url: v.url, referer: p.referer, name: `${title} [${v.title}]` }], quality };
      }
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/parser/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...clientHeaders() },
          body: JSON.stringify({ ...payload, engine }),
        });
        if (!res.ok) throw new Error(await errorText(res));
        const { job_ids } = await res.json();
        toast(`В очереди: ${job_ids.length}`, "info");
        const details = $("#pr-history details");
        if (details) details.open = true;
        loadHistory(true);
      } catch (err) {
        toast(`Очередь: ${err.message || err}`, "error");
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function saveJob(jobId, savePath) {
    const ok = await downloadWithCard({
      command: "download_api_file",
      args: { apiPath: `parser/download/${jobId}/file` },
      savePath,
      name: savePath.split(/[\\/]/).pop(),
    });
    if (ok) {
      await fetch(`${API_BASE}/parser/download/${jobId}/delete`, { method: "POST", headers: clientHeaders() }).catch(() => {});
      loadHistory();
    }
    return ok;
  }


  async function loadHistory(open = false) {
    const box = $("#pr-history");
    if (!box) return;
    clearTimeout(historyTimer);
    let jobs = [];
    try {
      const r = await fetch(`${API_BASE}/parser/jobs`, { headers: clientHeaders() });
      if (r.ok) ({ jobs } = await r.json());
    } catch (_) { return; }
    if (!jobs.length) { box.innerHTML = ""; return; }
    const wasOpen = open || box.querySelector("details")?.open;
    const done = jobs.filter(j => j.status === "done");
    const active = jobs.filter(j => JOB_OPEN.has(j.status));
    const rest = jobs.filter(j => !JOB_OPEN.has(j.status));
    const activeHtml = active.length ? `<div class="pr-active">${active.map(j => {
      const pct = Math.max(0, Math.min(100, Number(j.percent) || 0));
      const line = j.status === "running"
        ? `${ENGINE_NAMES[j.active_engine] ? `${ENGINE_NAMES[j.active_engine]} · ` : ""}${j.active_engine === "torrent" ? torrentStats(j) : `${pct}%${j.speed ? ` · ${(j.speed / 1048576).toFixed(1)} МБ/с` : ""}`}`
        : JOB_STATUS[j.status] || j.status;
      return `<div class="pr-act">
        <div class="pr-act-top"><b title="${esc(j.filename || j.name)}">${esc(j.filename || j.name)}</b><button type="button" class="btn sm" data-job-cancel="${esc(j.id)}">Отмена</button></div>
        <div class="pr-act-bar${j.status === "running" && pct > 0 ? "" : " indet"}"><i style="width:${pct}%"></i></div>
        <small>${esc(line)}</small>
      </div>`;
    }).join("")}</div>` : "";
    document.dispatchEvent(new CustomEvent("parser:jobs", { detail: jobs }));
    box.innerHTML = activeHtml + (rest.length ? `<details class="pr-reqs"${wasOpen ? " open" : ""}><summary>Готовые и завершённые (${rest.length}) — файлы хранятся 30 минут</summary>
      ${done.length > 1 ? `<button type="button" class="btn sm" id="pr-save-all">Сохранить все готовые (${done.length}) в папку</button>` : ""}
      <div class="pr-req-list">${rest.map(j => `
      <div class="pr-req pr-job">
        <div class="pr-req-ct">${esc(JOB_STATUS[j.status] || j.status)}${j.status === "running" ? ` · ${ENGINE_NAMES[j.active_engine] ? `${esc(ENGINE_NAMES[j.active_engine])} · ` : ""}${j.active_engine === "torrent" ? esc(torrentStats(j)) : `${j.percent || 0}%`}` : ""}${j.size ? ` · ${fmtSize(j.size)}` : ""}${j.error ? ` · ${esc(j.error)}` : ""}</div>
        <div class="pr-req-url" title="${esc(j.filename || j.name)}">${esc(j.filename || j.name)}</div>
        <div class="pr-req-actions">
          ${j.status === "done" ? `<button type="button" class="btn sm primary" data-job-save="${esc(j.id)}">Сохранить</button>` : ""}
          ${JOB_OPEN.has(j.status) ? `<button type="button" class="btn sm" data-job-cancel="${esc(j.id)}">Отмена</button>`
            : `<button type="button" class="btn sm" data-job-remove="${esc(j.id)}" title="${j.status === "done" ? "Убрать из списка и удалить файл с сервера" : "Убрать из списка"}">✕</button>`}
        </div>
      </div>`).join("")}</div></details>` : "");
    box.onclick = async ev => {
      const cancel = ev.target.closest("[data-job-cancel]");
      if (cancel) {
        cancel.disabled = true;
        await fetch(`${API_BASE}/parser/download/${cancel.dataset.jobCancel}/cancel`, { method: "POST", headers: clientHeaders() }).catch(() => {});
        loadHistory();
        return;
      }
      const remove = ev.target.closest("[data-job-remove]");
      if (remove) {
        remove.disabled = true;
        await fetch(`${API_BASE}/parser/download/${remove.dataset.jobRemove}/delete`, { method: "POST", headers: clientHeaders() }).catch(() => {});
        loadHistory();
        return;
      }
      if (ev.target.closest("#pr-save-all")) {
        const dir = await pickOutputDir();
        if (!dir) return;
        for (const j of done) await saveJob(j.id, `${dir}\\${j.filename || `${j.name}.mp4`}`);
        return;
      }
      const b = ev.target.closest("[data-job-save]");
      if (!b) return;
      const job = jobs.find(j => j.id === b.dataset.jobSave);
      const fileName = job.filename || `${job.name}.mp4`;
      const savePath = await pickOutputFile(fileName, saveFilter(fileName.split(".").pop()));
      if (savePath) await saveJob(job.id, savePath);
    };
    if (jobs.some(j => JOB_OPEN.has(j.status)) && box.isConnected) historyTimer = setTimeout(loadHistory, 2500);
  }

  function renderBtnProgress(btn, job) {
    const pct = typeof job.percent === "number" ? job.percent : 0;
    const spd = job.speed ? `${(job.speed / 1024 / 1024).toFixed(1)} МБ/с` : "";
    const got = job.downloaded ? `${(job.downloaded / 1024 / 1024).toFixed(0)}` : "0";
    const total = job.total ? `/${(job.total / 1024 / 1024).toFixed(0)}` : "";
    btn.textContent = job.phase === "merging"
      ? "Склеиваю…"
      : `${ENGINE_NAMES[job.active_engine] ? `${ENGINE_NAMES[job.active_engine]} · ` : ""}${pct}% · ${got}${total} МБ${spd ? " · " + spd : ""}`;
    btn.style.setProperty("--pr-progress", pct + "%");
    btn.classList.add("pr-dl-progress");
  }

  return true;
}
