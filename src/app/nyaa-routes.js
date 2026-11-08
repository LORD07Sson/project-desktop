// Nyaa/игры, вынесено из nyaa.js: страна выхода сервера; выбор соединения для каждого сервиса.
import { apiBlob } from "./api.js";
import { state } from "./state.js";
import { buildServices, hostOf } from "./nyaa-core.js";
import { checks, localChecks, paintSources, prefs, savePrefs, serverChecks, serverOrigin } from "./nyaa.js";

// ---------- страна выхода сервера ----------
// Когда запросы идут через сервер студии, у него несколько выходов (WireGuard по странам). Для каждого
// сервиса можно выбрать свой: пусто — по умолчанию (то, что задано на сервере), «direct» — без VPN.
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
        try { localStorage.setItem(EXIT_KEY, JSON.stringify({ at: Date.now(), data })); } catch (_) { /* не запомнится */ }
        paintSources();
      }
    } catch (_) { /* временная ошибка не затирает последний рабочий список */ }
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

// ---------- выбор соединения для каждого сервиса ----------
// auto — программа сама берёт лучший путь по замерам (напрямую или через сервер); pc — только этот
// компьютер; server — всегда через сервер студии (его WireGuard).
// Зеркала, которые сервер подсказал без релиза программы (файл mirrors.json на сервере); кэш на сутки.
const MIRRORS_KEY = "project-nyaa-mirrors";
export let remoteMirrors = (() => { try { const c = JSON.parse(localStorage.getItem(MIRRORS_KEY) || "null"); return c && Date.now() - c.at < 24 * 3600e3 ? c.data : {}; } catch (_) { return {}; } })();
export const allServices = () => buildServices(prefs.custom, serverOrigin(), remoteMirrors);
export async function loadRemoteMirrors() {
  try {
    const data = JSON.parse(await (await apiBlob("/mirrors")).text());
    if (data && typeof data === "object") {
      remoteMirrors = data;
      try { localStorage.setItem(MIRRORS_KEY, JSON.stringify({ at: Date.now(), data })); } catch (_) { /* не запомнится */ }
      paintSources();
    }
  } catch (_) { /* старый сервер без ручки — остаются встроенные зеркала */ }
}

export const ROUTES = [["auto", "Авто"], ["pc", "Мой компьютер"], ["server", "Сервер"]];
export const routeOf = id => (prefs.route && ["pc", "server"].includes(prefs.route[id])) ? prefs.route[id] : "auto";
export const serviceOfUrl = url => {
  const h = hostOf(url);
  const sv = allServices().find(s => s.mirrors.some(m => hostOf(m) === h));
  return sv ? sv.id : "";
};
// сам сервер студии проверяется только отсюда: его адрес для проверки «с сервера» недопустим (свой порт)
const routeOfUrl = url => { const id = serviceOfUrl(url); return id === "server" ? "pc" : routeOf(id); };

// Результат последней проверки по выбранному соединению сервиса (для кнопки «Источник» и подсказок).
export function applyChecks() {
  new Set([...Object.keys(serverChecks), ...Object.keys(localChecks)]).forEach(u => {
    const mode = routeOfUrl(u);
    const r = mode === "pc" ? localChecks[u] : mode === "server" ? serverChecks[u] : (serverChecks[u] || localChecks[u]);
    if (r) checks[u] = r;
  });
}

