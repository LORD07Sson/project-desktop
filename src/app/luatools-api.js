// API-клиент для lua.tools: поиск игр, проверка источников, скачивание манифестов.
// Supabase auth + lua.tools REST API — или свой бэкенд (переключается в настройках).

const DEFAULTS = {
  supabase_url: "https://db.lua.tools",
  supabase_anon_key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzYwMzkzNzYsImV4cCI6MTg5MzQ1NjAwMCwicm9sZSI6ImFub24iLCJpc3MiOiJzdXBhYmFzZSJ9.f_-K38u3odjltP-g_67FVmG32Vg-_-k-lNBvIaVUVBM",
  api_base: "https://lua.tools",
  manifest_backend_url: "http://167.235.229.108",
  manifest_backend_ua: "secretgoonpoon",
};

import { invoke } from "./tauri.js";

// fetch() из вебвью до этих API не доходит (CSP connect-src + у Steam store API
// нет CORS) — запросы идут через Rust (lt_http, список разрешённых хостов там).
// Возвращает объект с тем же интерфейсом, что нужен коду ниже: ok/status/json/text/headers.get.
async function ltFetch(url, { method = "GET", headers = {}, body } = {}) {
  const r = await invoke("lt_http", { method, url, headers, body: body ?? null });
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    headers: { get: k => r.headers[String(k).toLowerCase()] ?? null },
    text: async () => r.body,
    json: async () => JSON.parse(r.body),
  };
}

let _apiConfig = null;

export function ltSetApiConfig(cfg) { _apiConfig = cfg; }

function cfg(key) { return _apiConfig?.[key] || DEFAULTS[key]; }

const STEAM_SEARCH_URL = "https://store.steampowered.com/api/storesearch/";
const STEAM_FEATURED_URL = "https://store.steampowered.com/api/featuredcategories";
const DAILY_LIMIT = 25;
const OAUTH_PORT = 53789;

const LT_STORAGE_KEY = "lt_session";

// ── Session ─────────────────────────────────────────────────────────

// Сессия (access/refresh токены) живёт только в памяти. На диск она попадает
// исключительно зашифрованной DPAPI (luatools.js → session_enc в
// luatools_config.json) — открытым текстом в localStorage её больше не пишем.
let _session = null;

export function ltSession() { return _session; }

// Старые версии хранили сессию открытым текстом в localStorage: забираем её
// один раз для переноса в зашифрованное хранилище и сразу удаляем.
export function ltTakeLegacySession() {
  try {
    const raw = localStorage.getItem(LT_STORAGE_KEY);
    localStorage.removeItem(LT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function ltSaveSession(s) {
  _session = s;
  for (const fn of _sessionListeners) { try { fn(s); } catch { /* noop */ } }
}

const _sessionListeners = new Set();
export function ltOnSessionChange(fn) { _sessionListeners.add(fn); }

export async function ltFetchUser(accessToken) {
  const res = await ltFetch(`${cfg("supabase_url")}/auth/v1/user`, {
    headers: { apikey: cfg("supabase_anon_key"), Authorization: `Bearer ${accessToken}` },
  });
  return res.ok ? res.json() : null;
}

export function ltClearSession() {
  _session = null;
  try { localStorage.removeItem(LT_STORAGE_KEY); } catch { /* noop */ }
  for (const fn of _sessionListeners) { try { fn(null); } catch { /* noop */ } }
}

export function ltIsLoggedIn() {
  const s = ltSession();
  if (!s?.access_token) return false;
  if (s.expires_at && Date.now() / 1000 > s.expires_at) return false;
  return true;
}

async function ltAuthHeaders() {
  const s = ltSession();
  if (!s?.access_token) throw new Error("Войдите в lua.tools");
  return { Authorization: `Bearer ${s.access_token}` };
}

// ── Supabase auth (OAuth via browser) ───────────────────────────────

export function ltLoginUrl() {
  return `${cfg("supabase_url")}/auth/v1/authorize?provider=discord&redirect_to=http://localhost:${OAUTH_PORT}/callback`;
}

export async function ltRefreshToken() {
  const s = ltSession();
  if (!s?.refresh_token) throw new Error("Нет refresh token");
  const res = await ltFetch(`${cfg("supabase_url")}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: cfg("supabase_anon_key") },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });
  if (!res.ok) throw new Error(`Refresh failed: ${res.status}`);
  const data = await res.json();
  ltSaveSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    user: data.user,
  });
  return ltSession();
}

// ── Public endpoints (no auth) ──────────────────────────────────────

export async function ltSearchSteam(query) {
  const res = await ltFetch(`${STEAM_SEARCH_URL}?term=${encodeURIComponent(query)}&l=english&cc=US`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).slice(0, 8).map(i => ({
    appId: i.id,
    name: i.name,
    icon: i.tiny_image || `https://cdn.cloudflare.steamstatic.com/steam/apps/${i.id}/capsule_sm_120.jpg`,
  }));
}

export async function ltFeatured() {
  try {
    const res = await ltFetch(`${STEAM_FEATURED_URL}?cc=us&l=english`);
    if (!res.ok) return { topSellers: [], newReleases: [] };
    const data = await res.json();
    const clean = c => (c?.items || [])
      .filter(i => i.type === 0 && i.id > 0 && i.large_capsule_image)
      .filter((v, idx, arr) => arr.findIndex(x => x.id === v.id) === idx)
      .slice(0, 20)
      .map(i => ({ appId: i.id, name: i.name, image: i.large_capsule_image, discount: i.discount_percent }));
    return { topSellers: clean(data.top_sellers), newReleases: clean(data.new_releases) };
  } catch { return { topSellers: [], newReleases: [] }; }
}

export async function ltCheckSources(appId) {
  try {
    const res = await ltFetch(`${cfg("manifest_backend_url")}/check_apis?appid=${appId}`, {
      headers: { "User-Agent": cfg("manifest_backend_ua") },
    });
    if (!res.ok) return {};
    return await res.json();
  } catch { return {}; }
}

export async function ltGameDetails(appId) {
  try {
    const res = await ltFetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=english&cc=US`);
    if (!res.ok) return null;
    const data = await res.json();
    const info = data?.[String(appId)];
    if (!info?.success) return null;
    return info.data;
  } catch { return null; }
}

// ── Authenticated endpoints ─────────────────────────────────────────

async function ltApi(method, path) {
  const headers = await ltAuthHeaders();
  const res = await ltFetch(`${cfg("api_base")}${path}`, { method, headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* noop */ }
    throw new Error(msg);
  }
  return res;
}

export async function ltUsage() {
  try {
    const todayUtc = new Date().toISOString().split("T")[0] + "T00:00:00Z";
    const url = `${cfg("supabase_url")}/rest/v1/user_downloads?select=appid&downloaded_at=gte.${encodeURIComponent(todayUtc)}`;
    const res = await ltFetch(url, {
      method: "HEAD",
      headers: {
        apikey: cfg("supabase_anon_key"),
        Authorization: `Bearer ${ltSession()?.access_token}`,
        Prefer: "count=exact",
      },
    });
    if (!res.ok) return null;
    const range = res.headers.get("Content-Range") || res.headers.get("content-range") || "";
    const parts = range.split("/");
    const used = parts.length === 2 ? parseInt(parts[1], 10) || 0 : 0;
    return { used, limit: DAILY_LIMIT };
  } catch { return null; }
}

// Returns the download URL for Tauri's lt_download command.
export function ltManifestDownloadUrl(appId, source, gameName) {
  let url = `${cfg("api_base")}/api/manifest/download?appid=${appId}&source=${encodeURIComponent(source)}`;
  if (gameName) url += `&game_name=${encodeURIComponent(gameName)}`;
  return url;
}

// Скачивание фикса Denuvo: slot=manifest — lua/манифест, slot=fix — архив с файлами игры
// (как в LuaTools: /api/denuvo/download?fix=<id>&slot=…; старые /fixes/<id>/… отдают 404).
export function ltDenuvoDownloadUrl(fixId, slot) {
  return `${cfg("api_base")}/api/denuvo/download?fix=${encodeURIComponent(fixId)}&slot=${encodeURIComponent(slot)}`;
}

export function ltDlcGenerateUrl(appId, baseAppId, gameName) {
  let url = `${cfg("api_base")}/api/dlc/generate?appid=${appId}&base=${baseAppId}`;
  if (gameName) url += `&game_name=${encodeURIComponent(gameName)}`;
  return url;
}

export async function ltDlcInfo(appId, baseAppId) {
  const res = await ltApi("GET", `/api/dlc/info?appid=${appId}&base=${baseAppId}`);
  return await res.json();
}

// ── Denuvo fixes ────────────────────────────────────────────────────

export async function ltDenuvoListings() {
  try {
    const res = await ltFetch(`${cfg("api_base")}/api/denuvo/listings`);
    if (!res.ok) return null;
    // API: { games: [...], tags: [...] } — наружу отдаём массив игр.
    const data = await res.json();
    return Array.isArray(data) ? data : (data?.games || []);
  } catch { return null; }
}

export async function ltDenuvoFixes(appId) {
  try {
    const res = await ltFetch(`${cfg("api_base")}/api/denuvo/fixes?appid=${encodeURIComponent(appId)}`);
    if (!res.ok) return null;
    // API: { appid, name, header_image, fixes: [{ hasManifest, hasFix, createdAt, ... }] }
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data?.fixes || []);
    return list.map(f => ({
      ...f,
      has_manifest: f.has_manifest ?? f.hasManifest,
      has_fix: f.has_fix ?? f.hasFix,
      manifest_filename: f.manifest_filename ?? f.manifestFilename,
      fix_filename: f.fix_filename ?? f.fixFilename,
      created_at: f.created_at ?? f.createdAt,
    }));
  } catch { return null; }
}

const _depotInfoCache = new Map();
/** Depot names/sizes and branch build info from api.steamcmd.net (public PICS mirror). */
export async function ltDepotInfo(appId) {
  if (_depotInfoCache.has(appId)) return _depotInfoCache.get(appId);
  const p = (async () => {
    const res = await ltFetch(`https://api.steamcmd.net/v1/info/${encodeURIComponent(appId)}`);
    if (!res.ok) return null;
    const app = (await res.json())?.data?.[appId];
    if (!app) return null;
    const depots = {};
    for (const [id, d] of Object.entries(app.depots || {})) {
      if (!/^\d+$/.test(id) || typeof d !== "object") continue;
      depots[id] = { name: d.name || "", size: Number(d.manifests?.public?.size) || 0, gid: d.manifests?.public?.gid || "" };
    }
    const pub = app.depots?.branches?.public || {};
    return { depots, buildid: pub.buildid || "", updated: Number(pub.timeupdated) || 0 };
  })().catch(() => null);
  _depotInfoCache.set(appId, p);
  return p;
}
