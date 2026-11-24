
import { origin as SERVER_ORIGIN } from "../../server.json";
import { state } from "./state.js";
import { addPreviewHeader } from "./role-preview.js";
import { $ } from "./utils.js";
import { tagLogger } from "./applog.js";
import { getVersion } from "./tauri.js";

const toastLog = tagLogger("toast");

let appVersion = "";
getVersion().then(v => { appVersion = v; }).catch(() => { });

export function clientHeaders(headers = {}) {
  if (state.token) headers["X-Init-Data"] = state.token;
  if (appVersion) headers["X-App-Version"] = appVersion;
  return addPreviewHeader(headers);
}

export const API_BASE = `${SERVER_ORIGIN}/api`;

const REQUEST_TIMEOUT_MS = 20_000;
const NET_RETRY_MS = [1500, 3000, 5000];
const BLOB_STALL_MS = 30_000;
const BLOB_START_MS = 300_000;

let sessionExpiredFired = false;
function notifySessionExpired(detail) {
  if (sessionExpiredFired || !state.token) return;
  sessionExpiredFired = true;
  document.dispatchEvent(new CustomEvent("session-expired", { detail }));
}
export function armSessionExpiry() { sessionExpiredFired = false; }

let inFlight = 0;
function netStart() {
  inFlight += 1;
  document.documentElement.classList.add("net-busy");
}
function netEnd() {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0) document.documentElement.classList.remove("net-busy");
}

function checkSessionLost(status, detail, path) {
  const revoked = status === 403 && /участник/i.test(String(detail));
  if ((status === 401 || revoked) && path !== "/desktop/pair") notifySessionExpired(String(detail));
}

function formatApiError(detail, status) {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map(item => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const message = item.msg || item.message || item.detail;
      if (!message) return "";
      const location = Array.isArray(item.loc) ? item.loc.filter(part => part !== "query" && part !== "body" && part !== "path").join(" → ") : "";
      return location ? `${message} (${location})` : String(message);
    }).filter(Boolean);
    if (messages.length) return messages.join("; ");
  }
  if (detail && typeof detail === "object") {
    const message = detail.message || detail.msg || detail.detail || detail.error;
    if (typeof message === "string" && message) return message;
    try { return JSON.stringify(detail); } catch (_) { }
  }
  return `Ошибка ${status}`;
}

function reportApiFail(method, path, status, message) {
  document.dispatchEvent(new CustomEvent("project:api-fail", { detail: { method, path: String(path).split("?")[0], status, message } }));
}

let fallbackUntil = 0;
async function viaFallback(method, path, init, write) {
  const tauri = window.__TAURI_INTERNALS__;
  if (!tauri) return null;
  try {
    const r = await tauri.invoke("api_fallback", { method, path, headers: init.headers, body: init.body ?? null, write });
    fallbackUntil = Date.now() + 5 * 60_000;
    return new window.Response(r.body, { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch (_) {
    fallbackUntil = 0;
    return null;
  }
}

export async function api(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["X-Init-Data"] = state.token;
  if (appVersion) headers["X-App-Version"] = appVersion;
  addPreviewHeader(headers);
  const url = `${API_BASE}${path}`;
  const controller = new AbortController();
  const timeoutMs = /^\/titles\/\d+\/(?:take|nyaa-test|nyaa-browse)(?:\?|$)/.test(path) ? 45_000
    : /^\/report\/[^/]+\/files\/\d+\/(?:qc|peaks)(?:\?|$)/.test(path) ? 300_000
    // План сборки: сервер сперва достаёт видео серии из Telegram (сотни МБ) — это минуты, а не 20 с.
    : /^\/report\/[^/]+\/local-render\/plan(?:\?|$)/.test(path) ? 1_200_000
    : REQUEST_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs); // DevSkim: ignore DS172411
  let resp;
  const init = {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "default",
    signal: controller.signal,
  };
  netStart();
  const retryable = method === "GET" || path === "/presence/ping";
  try {
    if (Date.now() < fallbackUntil) resp = await viaFallback(method, path, init, !retryable);
    if (!resp) for (let attempt = 0; ; attempt++) {
      try {
        resp = await fetch(url, init);
        if (!(retryable && resp.status >= 502 && resp.status <= 504 && attempt < NET_RETRY_MS.length)) break;
      } catch (e) {
        if (e.name !== "AbortError" && attempt === 0) {
          resp = await viaFallback(method, path, init, !retryable);
          if (resp) break;
        }
        if (!retryable || e.name === "AbortError" || attempt >= NET_RETRY_MS.length) throw e;
      }
      await new Promise(r => setTimeout(r, NET_RETRY_MS[attempt])); // DevSkim: ignore DS172411
    }
  } catch (e) {
    const failure = e.name === "AbortError"
      ? new Error("Сервер не отвечает — проверьте соединение и попробуйте снова.")
      : new Error(`Нет связи с сервером: ${e.message}`);
    failure.network = true;
    reportApiFail(method, path, 0, failure.message);
    throw failure;
  } finally {
    clearTimeout(timeout);
    netEnd();
  }
  if (!resp.ok) {
    let detail = resp.status;
    try { detail = (await resp.json()).detail ?? detail; } catch (_) {}
    checkSessionLost(resp.status, detail, path);
    if (resp.status === 426) document.dispatchEvent(new CustomEvent("project:update-required", { detail: { message: formatApiError(detail, resp.status) } }));
    const err = new Error(formatApiError(detail, resp.status));
    err.status = resp.status;
    reportApiFail(method, path, resp.status, err.message);
    throw err;
  }
  const text = await resp.text();
  const data = text ? stripStatusEmoji(JSON.parse(text)) : {};
  if (path === "/whoami" && data.update_required) {
    document.dispatchEvent(new CustomEvent("project:update-required", { detail: { message: `Эта версия устарела — нужна ${data.min_version} или новее.` } }));
  }
  return data;
}

const LEADING_EMOJI_RE = /^(?:[\p{Extended_Pictographic}️‍]\s*)+/u;
const STATUS_LABEL_KEYS = ["status_label", "new_status_label", "old_status_label", "priority_label"];
function cleanLabel(value) {
  const cleaned = value.replace(LEADING_EMOJI_RE, "");
  return cleaned.trim() ? cleaned : value;
}
function stripStatusEmoji(node) {
  if (Array.isArray(node)) { node.forEach(stripStatusEmoji); return node; }
  if (!node || typeof node !== "object") return node;
  for (const key of STATUS_LABEL_KEYS) {
    if (typeof node[key] === "string") node[key] = cleanLabel(node[key]);
  }
  if (typeof node.label === "string" && typeof node.status === "string") node.label = cleanLabel(node.label);
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") stripStatusEmoji(value);
  }
  return node;
}

export async function apiBlob(path, onProgress) {
  const headers = clientHeaders();
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), BLOB_START_MS); // DevSkim: ignore DS172411
  const arm = ms => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), ms); }; // DevSkim: ignore DS172411
  const stalled = "Сервер перестал отвечать — проверьте соединение и попробуйте снова.";
  netStart();
  try {
    let resp;
    try {
      resp = await fetch(`${API_BASE}${path}`, { headers, signal: controller.signal });
    } catch (e) {
      if (e.name === "AbortError") throw new Error(stalled);
      throw new Error(`Нет связи с сервером: ${e.message}`);
    }
    if (!resp.ok) {
      let detail = resp.status;
      try { detail = (await resp.json()).detail ?? detail; } catch (_) {}
      checkSessionLost(resp.status, detail, path);
      throw new Error(typeof detail === "string" ? detail : `Ошибка ${detail}`);
    }
    const total = Number(resp.headers.get("Content-Length")) || 0;
    if (!resp.body) { arm(BLOB_STALL_MS); return await resp.blob(); }
    const reader = resp.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      arm(BLOB_STALL_MS);
      let step;
      try { step = await reader.read(); }
      catch (e) {
        reader.cancel().catch(() => {});
        throw new Error(e.name === "AbortError" ? stalled : `Загрузка прервалась: ${e.message}`);
      }
      if (step.done) break;
      chunks.push(step.value);
      got += step.value.length;
      if (onProgress) onProgress(got, total);
    }
    return new Blob(chunks);
  } finally {
    clearTimeout(timer);
    netEnd();
  }
}

const PROGRESS_FROM_BYTES = 2 * 1024 * 1024;

function uploadProgress(name, size) {
  if (size < PROGRESS_FROM_BYTES) return { set() {}, done() {} };
  const el = document.createElement("div");
  el.className = "upload-progress";
  const label = document.createElement("span");
  const bar = document.createElement("i");
  el.append(label, bar);
  let host = document.getElementById("dl-root");
  if (!host) {
    host = document.createElement("div");
    host.id = "dl-root";
    document.body.append(host);
  }
  host.append(el);
  const set = frac => {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    label.textContent = pct < 100 ? `⬆ ${pct}% · ${name}` : `⬆ Сохраняю… · ${name}`;
    bar.style.width = `${pct}%`;
  };
  set(0);
  return { set, done() { const h = el.parentElement; el.remove(); if (h && !h.children.length) h.remove(); } };
}

function xhrRequest(url, body, { contentType, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    for (const [k, v] of Object.entries(clientHeaders())) xhr.setRequestHeader(k, v);
    if (contentType) xhr.setRequestHeader("Content-Type", contentType);
    if (onProgress) xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onerror = () => {
      const err = new Error("Нет связи с сервером — отправка оборвалась.");
      err.status = 0;
      reject(err);
    };
    xhr.onload = () => {
      let data = null;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch (_) { }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(stripStatusEmoji(data || {})); return; }
      const detail = (data && data.detail) || (xhr.status === 413 ? "Файл слишком большой для сервера." : `Ошибка ${xhr.status}`);
      if (xhr.status === 401) notifySessionExpired(String(detail));
      const err = new Error(String(detail));
      err.status = xhr.status;
      reject(err);
    };
    xhr.send(body);
  });
}

const CHUNKED_FROM = 2 * 1024 * 1024;
const PARALLEL = 8;
const CHUNK_RETRIES = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function chunkedUpload(file, ui) {
  const start = await api("POST", "/upload/start", { name: file.name || "file", size: file.size });
  const { upload_id: id, chunk_size: chunk, parts } = start;
  const sent = new Array(parts).fill(0);
  const report = () => ui.set(sent.reduce((a, b) => a + b, 0) / file.size);
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (next < parts && !failed) {
      const i = next++;
      const blob = file.slice(i * chunk, Math.min(file.size, (i + 1) * chunk));
      for (let attempt = 1; ; attempt++) {
        try {
          await xhrRequest(`${API_BASE}/upload/${id}/chunk/${i}`, blob, {
            contentType: "application/octet-stream",
            onProgress: loaded => { sent[i] = loaded; report(); },
          });
          sent[i] = blob.size;
          report();
          break;
        } catch (e) {
          sent[i] = 0;
          const retryable = !e.status || e.status >= 500 || e.status === 400;
          if (!retryable || attempt >= CHUNK_RETRIES) { failed = e; return; }
          await sleep(1500 * attempt);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, parts) }, worker));
  if (failed) throw failed;
  return id;
}

export async function apiUpload(path, file, fields) {
  const ui = uploadProgress(file.name || "файл", file.size || 0);
  netStart();
  try {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields || {})) form.append(k, v);
    if (file.size > CHUNKED_FROM) {
      form.append("upload_id", await chunkedUpload(file, ui));
      ui.set(1);
      return await xhrRequest(`${API_BASE}${path}`, form);
    }
    form.append("file", file, file.name || "image.png");
    return await xhrRequest(`${API_BASE}${path}`, form, { onProgress: loaded => ui.set(loaded / (file.size || 1)) });
  } finally {
    ui.done();
    netEnd();
  }
}

const inflightGets = new Map();
export function apiGet(path, params) {
  const qs = params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)) : "";
  const key = path + qs;
  let p = inflightGets.get(key);
  if (!p) {
    p = api("GET", key);
    inflightGets.set(key, p);
    const drop = () => { if (inflightGets.get(key) === p) inflightGets.delete(key); };
    p.then(drop, drop);
    return p;
  }
  return p.then(d => (d && typeof d === "object" ? globalThis.structuredClone(d) : d));
}
export function apiPost(path, body) { return api("POST", path, body || {}); }
export function apiDelete(path) { return api("DELETE", path); }

export function mediaUrl(path, params) {
  if (!state.mediaToken) return "";
  const qs = new URLSearchParams({ ...(params || {}), mtok: state.mediaToken });
  return `${API_BASE}${path}?${qs}`;
}

export const AVATAR_REFRESH_MS = 120_000;
export function avatarUrl(telegramId) {
  return mediaUrl(`/avatar/${encodeURIComponent(telegramId)}`, { v: Math.floor(Date.now() / AVATAR_REFRESH_MS) });
}

const MEDIA_TOKEN_REFRESH_SLACK_MS = 60_000;
let mediaTokenPromise = null;

export function forceMediaToken() {
  state.mediaTokenExpiresAt = 0;
  return ensureMediaToken();
}

export async function ensureMediaToken() {
  if (!state.token) return;
  if (state.mediaToken && Date.now() < state.mediaTokenExpiresAt - MEDIA_TOKEN_REFRESH_SLACK_MS) return;
  if (mediaTokenPromise) return mediaTokenPromise;
  mediaTokenPromise = (async () => {
    try {
      const res = await apiPost("/media/token", {});
      state.mediaToken = res.token;
      state.mediaTokenExpiresAt = Date.now() + res.expires_in * 1000;
      document.dispatchEvent(new CustomEvent("media-token-ready"));
    } catch (_) {
    } finally {
      mediaTokenPromise = null;
    }
  })();
  return mediaTokenPromise;
}

const MEDIA_RETRY_DELAYS_MS = [2500, 20_000, 75_000];
document.addEventListener("error", ev => {
  const img = ev.target;
  if (!img || img.tagName !== "IMG") return;
  const attempt = Number(img.dataset.mtokRetried || 0);
  if (attempt >= MEDIA_RETRY_DELAYS_MS.length) return;
  const src = img.currentSrc || img.src || "";
  if (!src.startsWith(API_BASE) || !src.includes("mtok=")) return;
  img.dataset.mtokRetried = String(attempt + 1);
  setTimeout(async () => {
    if ((img.currentSrc || img.src) !== src) return;
    try { await forceMediaToken(); } catch (_) { }
    if (!img.isConnected || !state.mediaToken) return;
    const url = new URL(src);
    url.searchParams.set("mtok", state.mediaToken);
    img.src = url.toString();
  }, MEDIA_RETRY_DELAYS_MS[attempt]);
}, true);

const MEDIA_TOKEN_CHECK_INTERVAL_MS = 60_000;
setInterval(ensureMediaToken, MEDIA_TOKEN_CHECK_INTERVAL_MS);

export function openSheet(html, variant) {
  const tpl = $(variant === "wide" ? "#tpl-overlay-wide" : "#tpl-overlay").content.cloneNode(true);
  const overlay = tpl.querySelector(".overlay");
  overlay.querySelector(".sheet").innerHTML = html;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) dismissSheet(overlay); });
  return overlay;
}

export function dismissSheet(overlay) {
  if (!overlay || !overlay.isConnected) return;
  overlay.remove();
  overlay.dispatchEvent(new CustomEvent("sheet-dismissed"));
}

export function askConfirm(text, { yes = "Да", no = "Отмена", danger = /удал|отозв|снять|сотр|навсегда|карантин|заверш/i.test(String(text)) } = {}) {
  return new Promise(resolve => {
    const overlay = openSheet(`
      <div class="ask-text">${String(text).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])}</div>
      <div class="sheet-actions">
        <button type="button" class="btn ghost" data-ask="no">${no}</button>
        <button type="button" class="btn ${danger ? "danger" : "primary"}" data-ask="yes">${yes}</button>
      </div>`);
    overlay.querySelector(".sheet").classList.add("ask-sheet");
    let done = false;
    const finish = ok => { if (done) return; done = true; overlay.remove(); resolve(ok); };
    overlay.querySelector('[data-ask="yes"]').addEventListener("click", () => finish(true));
    overlay.querySelector('[data-ask="no"]').addEventListener("click", () => finish(false));
    overlay.addEventListener("sheet-dismissed", () => finish(false));
    overlay.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); finish(true); } });
    overlay.querySelector('[data-ask="yes"]').focus();
  });
}

// In-app replacement for window.prompt(): resolves to the trimmed text, or null when cancelled
// or left unchanged.
export function askText(title, value = "", { yes = "Сохранить", no = "Отмена", placeholder = "", maxLength = 200 } = {}) {
  const e = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  return new Promise(resolve => {
    const overlay = openSheet(`
      <div class="ask-text">${e(title)}</div>
      <input class="ask-input" type="text" maxlength="${maxLength}" value="${e(value)}" placeholder="${e(placeholder)}" autocomplete="off" spellcheck="false">
      <div class="sheet-actions">
        <button type="button" class="btn ghost" data-ask="no">${no}</button>
        <button type="button" class="btn primary" data-ask="yes">${yes}</button>
      </div>`);
    overlay.querySelector(".sheet").classList.add("ask-sheet", "ask-input-sheet");
    const input = overlay.querySelector(".ask-input");
    const ok = overlay.querySelector('[data-ask="yes"]');
    const sync = () => { const v = input.value.trim(); ok.disabled = !v || v === String(value).trim(); };
    let done = false;
    const finish = v => { if (done) return; done = true; overlay.remove(); resolve(v); };
    input.addEventListener("input", sync);
    ok.addEventListener("click", () => { if (!ok.disabled) finish(input.value.trim()); });
    overlay.querySelector('[data-ask="no"]').addEventListener("click", () => finish(null));
    overlay.addEventListener("sheet-dismissed", () => finish(null));
    input.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); ok.click(); } });
    sync();
    input.focus();
    input.select();
  });
}

document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const overlays = document.querySelectorAll(".overlay");
  if (overlays.length) dismissSheet(overlays[overlays.length - 1]);
});

const TOAST_ICON = { info: "", error: "⚠️", success: "✓" };

export function toast(text, kind = "info", action = null) {
  if (kind === "error") {
    toastLog.error(text);
    document.dispatchEvent(new CustomEvent("project:error-shown", { detail: { text: String(text) } }));
  }
  const root = $("#toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.dataset.kind = kind;
  const duration = action ? 7000 : 4200;
  const icon = TOAST_ICON[kind] || "";
  el.innerHTML = `${icon ? `<span class="toast-icon">${icon}</span>` : ""}<span class="toast-text"></span>${action ? `<button type="button" class="toast-action"></button>` : ""}<span class="toast-progress" style="animation-duration:${duration}ms;"></span>`;
  el.querySelector(".toast-text").textContent = text;
  root.appendChild(el);
  const remove = () => {
    el.classList.add("toast-out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  const timer = setTimeout(remove, duration); // DevSkim: ignore DS172411
  if (action) {
    const actionBtn = el.querySelector(".toast-action");
    actionBtn.textContent = action.label;
    actionBtn.addEventListener("click", e => {
      e.stopPropagation();
      clearTimeout(timer);
      action.onClick();
      remove();
    });
  }
  el.addEventListener("click", () => { clearTimeout(timer); remove(); });
}

export function keepOnReload(root) {
  return !!(state.softReload && root && root.children.length && !root.querySelector(":scope > .skeleton-wrap"));
}
export function tabSkeleton(root, html) {
  if (root && !keepOnReload(root)) root.innerHTML = html;
}

export function dialogSkeletonHtml(lines = 4, variant = "rows") {
  const shape = i => {
    if (variant === "cards") return i === 0 ? "line" : "card";
    return i === 0 ? "line" : i === 1 ? "line-sm" : "";
  };
  const rows = Array.from({ length: lines }, (_, i) =>
    `<div class="skeleton-row ${shape(i)}" style="animation-delay:${i * 70}ms;"></div>`).join("");
  return `<div class="skeleton-wrap">${rows}</div>`;
}
