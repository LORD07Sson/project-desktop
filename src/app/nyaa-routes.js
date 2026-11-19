import { apiBlob } from "./api.js";
import { state } from "./state.js";
import { buildServices, hostOf } from "./nyaa-core.js";
import { checks, localChecks, paintSources, prefs, savePrefs, serverChecks, serverOrigin } from "./nyaa.js";

const EXIT_KEY = "project-nyaa-exits";
export let exitList = (() => { try { const c = JSON.parse(localStorage.getItem(EXIT_KEY) || "null"); return c && Date.now() - c.at < 5 * 60e3 ? c.data : null; } catch (_) { return null; } })()
  || { default: "direct", exits: [{ code: "direct", name: "Напрямую, без VPN" }] };
let exitRefresh = null;
export const exitOf = id => { const v = prefs.exit && prefs.exit[id]; return exitList.exits.some(e => e.code === v) ? v : ""; };
export const exitName = id => {
  const code = exitOf(id) || exitList.default;
  const e = exitList.exits.find(x => x.code === code);
  return e ? e.name : code;
};
export async function loadExits() {
  if (exitRefresh) return exitRefresh;
  exitRefresh = (async () => {
    try {
      const data = JSON.parse(await (await apiBlob("/exits")).text());
      if (data && Array.isArray(data.exits)) {
        exitList = data;
        const valid = new Set(data.exits.map(e => e.code));
        let changed = false;
        for (const [id, code] of Object.entries(prefs.exit || {})) {
          if (code && !valid.has(code)) { delete prefs.exit[id]; changed = true; }
        }
        if (changed) savePrefs();
        try { localStorage.setItem(EXIT_KEY, JSON.stringify({ at: Date.now(), data })); } catch (_) { }
        paintSources();
      }
    } catch (_) { }
  })();
  try {
    await exitRefresh;
  } finally {
    exitRefresh = null;
  }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.isAdmin) loadExits();
});
setInterval(() => {
  if (state.isAdmin && !document.hidden) loadExits();
}, 60 * 1000);
export const viaQuery = id => { const v = exitOf(id); return v ? `&via=${encodeURIComponent(v)}` : ""; };

const MIRRORS_KEY = "project-nyaa-mirrors";
export let remoteMirrors = (() => { try { const c = JSON.parse(localStorage.getItem(MIRRORS_KEY) || "null"); return c && Date.now() - c.at < 24 * 3600e3 ? c.data : {}; } catch (_) { return {}; } })();
export const allServices = () => buildServices(prefs.custom, serverOrigin(), remoteMirrors);
export async function loadRemoteMirrors() {
  try {
    const data = JSON.parse(await (await apiBlob("/mirrors")).text());
    if (data && typeof data === "object") {
      remoteMirrors = data;
      try { localStorage.setItem(MIRRORS_KEY, JSON.stringify({ at: Date.now(), data })); } catch (_) { }
      paintSources();
    }
  } catch (_) { }
}

export const ROUTES = [["auto", "Авто"], ["pc", "Мой компьютер"], ["server", "Сервер"]];
export const routeOf = id => (prefs.route && ["pc", "server"].includes(prefs.route[id])) ? prefs.route[id] : "auto";
export const serviceOfUrl = url => {
  const h = hostOf(url);
  const sv = allServices().find(s => s.mirrors.some(m => hostOf(m) === h));
  return sv ? sv.id : "";
};
const routeOfUrl = url => { const id = serviceOfUrl(url); return id === "server" ? "pc" : routeOf(id); };

export function applyChecks() {
  new Set([...Object.keys(serverChecks), ...Object.keys(localChecks)]).forEach(u => {
    const mode = routeOfUrl(u);
    const r = mode === "pc" ? localChecks[u] : mode === "server" ? serverChecks[u] : (serverChecks[u] || localChecks[u]);
    if (r) checks[u] = r;
  });
}

