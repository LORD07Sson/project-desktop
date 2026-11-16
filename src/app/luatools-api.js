// API-клиент для lua.tools: поиск игр, проверка источников, скачивание манифестов.
// Supabase auth + lua.tools REST API.

const SUPABASE_URL = "https://db.lua.tools";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpYXQiOjE3NzYwMzkzNzYsImV4cCI6MTg5MzQ1NjAwMCwicm9sZSI6ImFub24iLCJpc3MiOiJzdXBhYmFzZSJ9.f_-K38u3odjltP-g_67FVmG32Vg-_-k-lNBvIaVUVBM";
const API_BASE = "https://lua.tools";
const STEAM_SEARCH_URL = "https://store.steampowered.com/api/storesearch/";
const STEAM_FEATURED_URL = "https://store.steampowered.com/api/featuredcategories";
const MANIFEST_BACKEND_URL = "http://167.235.229.108";
const MANIFEST_BACKEND_UA = "secretgoonpoon";
const DAILY_LIMIT = 25;
const OAUTH_PORT = 53789;

const LT_STORAGE_KEY = "lt_session";

// ── Session ─────────────────────────────────────────────────────────

let _session = null;

export function ltSession() {
  if (_session) return _session;
  try {
    const raw = localStorage.getItem(LT_STORAGE_KEY);
    if (raw) _session = JSON.parse(raw);
  } catch { /* noop */ }
  return _session;
}

export function ltSaveSession(s) {
  _session = s;
  try { localStorage.setItem(LT_STORAGE_KEY, JSON.stringify(s)); } catch { /* noop */ }
}

export function ltClearSession() {
  _session = null;
  try { localStorage.removeItem(LT_STORAGE_KEY); } catch { /* noop */ }
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
  return `${SUPABASE_URL}/auth/v1/authorize?provider=discord&redirect_to=http://localhost:${OAUTH_PORT}/callback`;
}

export async function ltRefreshToken() {
  const s = ltSession();
  if (!s?.refresh_token) throw new Error("Нет refresh token");
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY },
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
  const res = await fetch(`${STEAM_SEARCH_URL}?term=${encodeURIComponent(query)}&l=english&cc=US`);
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
    const res = await fetch(`${STEAM_FEATURED_URL}?cc=us&l=english`);
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
    const res = await fetch(`${MANIFEST_BACKEND_URL}/check_apis?appid=${appId}`, {
      headers: { "User-Agent": MANIFEST_BACKEND_UA },
    });
    if (!res.ok) return {};
    return await res.json();
  } catch { return {}; }
}

export async function ltGameDetails(appId) {
  try {
    const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=english&cc=US`);
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
  const res = await fetch(`${API_BASE}${path}`, { method, headers });
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
    const url = `${SUPABASE_URL}/rest/v1/user_downloads?select=appid&downloaded_at=gte.${encodeURIComponent(todayUtc)}`;
    const res = await fetch(url, {
      method: "HEAD",
      headers: {
        apikey: SUPABASE_ANON_KEY,
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
  let url = `${API_BASE}/api/manifest/download?appid=${appId}&source=${encodeURIComponent(source)}`;
  if (gameName) url += `&game_name=${encodeURIComponent(gameName)}`;
  return url;
}

export function ltDlcGenerateUrl(appId, baseAppId, gameName) {
  let url = `${API_BASE}/api/dlc/generate?appid=${appId}&base=${baseAppId}`;
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
    const res = await fetch(`${API_BASE}/api/denuvo/listings`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function ltDenuvoFixes(appId) {
  try {
    const res = await fetch(`${API_BASE}/api/denuvo/fixes?appid=${encodeURIComponent(appId)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
