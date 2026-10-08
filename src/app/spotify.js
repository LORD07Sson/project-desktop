// Spotify в программе: вход под своим аккаунтом и управление
// воспроизведением. Звук идёт на устройстве самого Spotify (телефон,
// компьютер, колонка) — программа показывает, что играет, и управляет
// (Premium нужен для управления). У каждого свой Client ID: создаётся
// приложение в Spotify for Developers, в Redirect URIs вписывается
// http://127.0.0.1:8898/callback. Секрета нет (PKCE), на диске лежит только
// refresh-токен в хранилище ОС. Сетевая часть — spotify.rs.

import { invoke, openExternal } from "./tauri.js";
import { openSheet, toast } from "./api.js";
import { $, esc } from "./utils.js";
import {
  pkcePair, randomString, authUrl, looksLikeClientId, parsePlayer, fmtMs,
  spotifyError, REDIRECT_URI,
} from "./spotify-core.js";

const CLIENT_KEY = "project-spotify-client";
const getClientId = () => { try { return localStorage.getItem(CLIENT_KEY) || ""; } catch (_) { return ""; } };
const setClientId = v => { try { localStorage.setItem(CLIENT_KEY, v); } catch (_) { /* не запомнится */ } };

let access = "";
let accessExp = 0;

const http = req => invoke("spotify_http", { req });

async function tokenRequest(pairs) {
  const r = await http({ method: "POST", url: "https://accounts.spotify.com/api/token", form: pairs });
  let j = {};
  try { j = JSON.parse(r.body); } catch (_) { /* не JSON */ }
  if (r.status >= 400 || !j.access_token) {
    throw new Error(j.error_description || j.error || `Spotify ответил ${r.status}`);
  }
  access = j.access_token;
  accessExp = Date.now() + (j.expires_in || 3600) * 1000;
  if (j.refresh_token) await invoke("spotify_save_refresh", { token: j.refresh_token });
}

async function getAccess(force = false) {
  if (!force && access && Date.now() < accessExp - 30_000) return access;
  const refresh = await invoke("spotify_load_refresh");
  if (!refresh) throw new Error("Не подключено.");
  await tokenRequest([["grant_type", "refresh_token"], ["refresh_token", refresh], ["client_id", getClientId()]]);
  return access;
}

async function api(method, path, json) {
  const call = async force => http({ method, url: `https://api.spotify.com/v1${path}`, bearer: await getAccess(force), json });
  let r = await call(false);
  if (r.status === 401) r = await call(true);
  if (r.status >= 400) throw new Error(spotifyError(r.status, r.body));
  if (r.status === 204 || !r.body) return null;
  try { return JSON.parse(r.body); } catch (_) { return null; }
}

async function connect() {
  const clientId = getClientId();
  const { verifier, challenge } = await pkcePair();
  const state = randomString(24);
  const waiting = invoke("spotify_wait_callback", { timeoutSecs: 180 });
  waiting.catch(() => { /* ошибку заберёт await ниже */ });
  await new Promise(r => setTimeout(r, 300));          // слушатель должен успеть подняться
  await openExternal(authUrl({ clientId, challenge, state }));
  const [code, backState] = await waiting;
  if (backState !== state) throw new Error("Ответ не от этого входа. Попробуйте ещё раз.");
  await tokenRequest([
    ["grant_type", "authorization_code"], ["code", code], ["redirect_uri", REDIRECT_URI],
    ["client_id", clientId], ["code_verifier", verifier],
  ]);
}

async function disconnect() {
  access = ""; accessExp = 0;
  await invoke("spotify_clear_refresh");
}

// ---------- окно ----------
let timer = 0;
let view = { player: null, at: 0, devices: [], playlists: [], results: [] };

function setupHtml(connected) {
  const id = getClientId();
  return `
    <div class="sp-setup">
      <ol class="sp-steps">
        <li>Откройте <b>developer.spotify.com/dashboard</b> и создайте приложение (любое название).</li>
        <li>В «Redirect URIs» добавьте <code>${esc(REDIRECT_URI)}</code> и отметьте Web API.</li>
        <li>Скопируйте <b>Client ID</b> (32 символа) и вставьте ниже. Секрет не нужен.</li>
      </ol>
      <div class="sp-row">
        <input id="sp-client" class="field-input" placeholder="Client ID" value="${esc(id)}" spellcheck="false">
        <button class="btn primary" id="sp-connect">${connected ? "Подключиться заново" : "Подключить Spotify"}</button>
      </div>
      <p class="sp-note">Нужен Spotify Premium. В режиме разработки к приложению можно добавить до пяти человек (Users and Access в панели приложения). Программа не скачивает и не записывает музыку.</p>
    </div>`;
}

function playerHtml() {
  const p = view.player;
  const dev = view.devices;
  const cur = p && p.device ? p.device.id : "";
  const art = p && !p.idle && p.art ? `<img class="sp-art" src="${esc(p.art)}" alt="">` : `<span class="sp-art"></span>`;
  return `
    <div class="sp-now">
      ${art}
      <div class="sp-meta">
        ${p && !p.idle ? `<b>${esc(p.title)}</b><span>${esc(p.artist)}</span><i>${esc(p.album)}</i>` : `<b>Ничего не играет</b><span>Запустите трек в Spotify или найдите ниже</span>`}
        <div class="sp-bar"><u id="sp-prog" style="width:${p && !p.idle && p.durationMs ? Math.min(100, p.progressMs / p.durationMs * 100) : 0}%"></u></div>
        <div class="sp-time"><span id="sp-pos">${p && !p.idle ? fmtMs(p.progressMs) : "0:00"}</span><span>${p && !p.idle ? fmtMs(p.durationMs) : "0:00"}</span></div>
      </div>
    </div>
    <div class="sp-ctl">
      <button class="icon-btn" data-sp="prev" title="Предыдущий" aria-label="Предыдущий">⏮</button>
      <button class="icon-btn big" data-sp="toggle" title="Пауза / играть" aria-label="Пауза или играть">${p && p.playing ? "⏸" : "▶"}</button>
      <button class="icon-btn" data-sp="next" title="Следующий" aria-label="Следующий">⏭</button>
      <button class="icon-btn${p && p.shuffle ? " on" : ""}" data-sp="shuffle" title="Перемешать" aria-label="Перемешать">🔀</button>
      <button class="icon-btn" data-sp="like" title="В «Любимое»" aria-label="В любимое">♥</button>
      <input type="range" class="st-range" id="sp-vol" min="0" max="100" value="${p && p.device && p.device.volume_percent != null ? p.device.volume_percent : 50}" title="Громкость">
    </div>
    <div class="sp-row">
      <select id="sp-dev" class="field-input">
        ${dev.length ? dev.map(d => `<option value="${esc(d.id)}" ${d.id === cur ? "selected" : ""}>${esc(d.name)} · ${esc(d.type)}</option>`).join("") : `<option value="">Устройств нет — откройте Spotify</option>`}
      </select>
      <button class="btn ghost" id="sp-dev-go">Играть здесь</button>
    </div>
    <div class="sp-row">
      <input id="sp-q" class="field-input" placeholder="Найти трек" value="">
      <button class="btn" id="sp-find">Найти</button>
    </div>
    <div class="sp-list" id="sp-results">${view.results.map((t, i) => `
      <button class="sp-item" data-play-uri="${esc(t.uri)}"><b>${esc(t.name)}</b><span>${esc((t.artists || []).map(a => a.name).join(", "))}</span></button>`).join("")}</div>
    <div class="hd" style="margin-top:12px">Ваши плейлисты</div>
    <div class="sp-list">${view.playlists.length ? view.playlists.map(pl => `
      <button class="sp-item" data-play-ctx="${esc(pl.uri)}"><b>${esc(pl.name)}</b><span>${pl.tracks ? pl.tracks.total : ""} треков</span></button>`).join("") : `<div class="wt-empty">Плейлистов нет или они ещё грузятся.</div>`}</div>
    <div class="sp-row"><button class="btn ghost" id="sp-out">Отключить Spotify</button><button class="btn ghost" id="sp-reset-id">Сменить Client ID</button></div>`;
}

async function refreshPlayer(root) {
  try {
    const j = await api("GET", "/me/player");
    view.player = parsePlayer(j);
    view.at = Date.now();
  } catch (e) {
    view.player = null;
    if (/заново|Не подключено/.test(e.message)) { render(root, "setup"); return; }
  }
  if (root.isConnected) updateLive(root);
}

// Обновляем только то, что меняется само, чтобы не сбивать фокус и поле поиска.
function updateLive(root) {
  const bar = root.querySelector("#sp-prog");
  if (!bar) return;
  const body = root.querySelector("#sp-body");
  const typing = document.activeElement && body.contains(document.activeElement) && document.activeElement.tagName === "INPUT" && document.activeElement.type === "text";
  if (typing) return;
  const q = body.querySelector("#sp-q")?.value || "";
  render(root, "player");
  const nq = root.querySelector("#sp-q"); if (nq) nq.value = q;
}

function tick(root) {
  if (!root.isConnected) { clearInterval(timer); timer = 0; return; }
  const p = view.player;
  if (p && p.playing && !p.idle) {
    const pos = Math.min(p.durationMs, p.progressMs + (Date.now() - view.at));
    const bar = root.querySelector("#sp-prog"); if (bar) bar.style.width = `${p.durationMs ? pos / p.durationMs * 100 : 0}%`;
    const t = root.querySelector("#sp-pos"); if (t) t.textContent = fmtMs(pos);
  }
}

async function loadLists(root) {
  try { view.devices = (await api("GET", "/me/player/devices"))?.devices || []; } catch (_) { view.devices = []; }
  try { view.playlists = (await api("GET", "/me/playlists?limit=30"))?.items || []; } catch (_) { view.playlists = []; }
  if (root.isConnected) render(root, "player");
}

async function command(root, name) {
  const p = view.player;
  try {
    if (name === "toggle") await api("PUT", p && p.playing ? "/me/player/pause" : "/me/player/play");
    else if (name === "next") await api("POST", "/me/player/next");
    else if (name === "prev") await api("POST", "/me/player/previous");
    else if (name === "shuffle") await api("PUT", `/me/player/shuffle?state=${p && p.shuffle ? "false" : "true"}`);
    else if (name === "like") {
      const j = await api("GET", "/me/player/currently-playing");
      if (j && j.item) { await api("PUT", `/me/tracks?ids=${j.item.id}`); toast("Добавлено в «Любимое».", "success"); }
    }
  } catch (e) { toast(e.message, "error"); }
  setTimeout(() => refreshPlayer(root), 350);
}

function wirePlayer(root) {
  root.querySelectorAll("[data-sp]").forEach(b => b.addEventListener("click", () => command(root, b.dataset.sp)));
  const vol = root.querySelector("#sp-vol");
  let volTimer = 0;
  vol?.addEventListener("input", () => {
    clearTimeout(volTimer);
    volTimer = setTimeout(() => api("PUT", `/me/player/volume?volume_percent=${vol.value}`).catch(e => toast(e.message, "error")), 250);
  });
  root.querySelector("#sp-dev-go")?.addEventListener("click", async () => {
    const id = root.querySelector("#sp-dev").value;
    if (!id) return;
    try { await api("PUT", "/me/player", { device_ids: [id], play: true }); } catch (e) { toast(e.message, "error"); }
    setTimeout(() => refreshPlayer(root), 500);
  });
  const find = async () => {
    const q = root.querySelector("#sp-q").value.trim();
    if (!q) return;
    try { view.results = (await api("GET", `/search?type=track&limit=8&q=${encodeURIComponent(q)}`))?.tracks?.items || []; }
    catch (e) { toast(e.message, "error"); return; }
    render(root, "player");
    root.querySelector("#sp-q").value = q;
  };
  root.querySelector("#sp-find")?.addEventListener("click", find);
  root.querySelector("#sp-q")?.addEventListener("keydown", e => { if (e.key === "Enter") find(); });
  root.querySelectorAll("[data-play-uri]").forEach(b => b.addEventListener("click", async () => {
    try { await api("PUT", "/me/player/play", { uris: [b.dataset.playUri] }); } catch (e) { toast(e.message, "error"); }
    setTimeout(() => refreshPlayer(root), 500);
  }));
  root.querySelectorAll("[data-play-ctx]").forEach(b => b.addEventListener("click", async () => {
    try { await api("PUT", "/me/player/play", { context_uri: b.dataset.playCtx }); } catch (e) { toast(e.message, "error"); }
    setTimeout(() => refreshPlayer(root), 500);
  }));
  root.querySelector("#sp-out")?.addEventListener("click", async () => { await disconnect(); render(root, "setup"); });
  root.querySelector("#sp-reset-id")?.addEventListener("click", () => render(root, "setup"));
}

function wireSetup(root) {
  const btn = root.querySelector("#sp-connect");
  btn.addEventListener("click", async () => {
    const id = root.querySelector("#sp-client").value.trim();
    if (!looksLikeClientId(id)) { toast("Client ID — 32 символа из букв a–f и цифр.", "error"); return; }
    setClientId(id);
    btn.disabled = true; btn.textContent = "Ждём подтверждения в браузере…";
    try {
      await connect();
      toast("Spotify подключён.", "success");
      render(root, "player");
      refreshPlayer(root); loadLists(root);
    } catch (e) {
      toast(`Не подключилось: ${e && e.message ? e.message : e}`, "error");
      btn.disabled = false; btn.textContent = "Подключить Spotify";
    }
  });
}

function render(root, mode) {
  const body = root.querySelector("#sp-body");
  if (mode === "setup") { body.innerHTML = setupHtml(false); wireSetup(root); }
  else { body.innerHTML = playerHtml(); wirePlayer(root); }
}

export async function openSpotify() {
  const overlay = openSheet(`
    <div class="mt-head">
      <div><span class="kd-label">Музыка</span><h2>Spotify</h2></div>
      <button class="icon-btn mt-head-close" data-close title="Закрыть" aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div id="sp-body"></div>`, "wide");
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  const hasRefresh = !!(await invoke("spotify_load_refresh").catch(() => null));
  if (!hasRefresh || !getClientId()) { render(overlay, "setup"); return; }
  render(overlay, "player");
  refreshPlayer(overlay); loadLists(overlay);
  clearInterval(timer);
  let n = 0;
  timer = setInterval(() => { if (!overlay.isConnected) { tick(overlay); return; } tick(overlay); if (++n % 6 === 0) refreshPlayer(overlay); }, 1000);
}

$("#open-spotify")?.addEventListener("click", openSpotify);
