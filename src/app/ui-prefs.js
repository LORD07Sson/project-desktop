
const KEYS = {
  accent: "project-accent",
  scale: "project-scale",
  motion: "project-motion",
  backdrop: "project-backdrop",
  start: "project-start-tab",
};

export const ACCENTS = {
  original: { label: "Оригинал", sw: ["#0b0908", "#1d1713", "#ff7a3d", "#ffb35c"] },
  amber: { label: "Янтарь", sw: ["#070403", "#1c1310", "#ff6a2b", "#ffb444"] },
  sakura: { label: "Сакура", sw: ["#090407", "#1f1118", "#ff4d7d", "#ffb3c6"] },
  violet: { label: "Фиалка", sw: ["#06050b", "#171224", "#8b5cff", "#d0bcff"] },
  sky: { label: "Небо", sw: ["#04070a", "#101a22", "#1fa8ff", "#9fe3ff"] },
  mint: { label: "Мята", sw: ["#040805", "#111c16", "#1fc77a", "#b4f06a"] },
};
export const SCALES = [90, 100, 110, 125];
export const START_TABS = { last: "Последний", queue: "Моя очередь", overview: "Обзор" };

function get(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
}
function set(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { }
}

const root = document.documentElement;

export function currentAccent() { const v = get(KEYS.accent, "original"); return ACCENTS[v] ? v : "original"; }
export function applyAccent(name) {
  const key = ACCENTS[name] ? name : "original";
  set(KEYS.accent, key);
  ["--fire", "--ember", "--gold", "--on-accent", "--accent-soft", "--accent-grad"].forEach(p => root.style.removeProperty(p));
  if (key === "original") delete root.dataset.accent;
  else root.dataset.accent = key;
}

export function currentScale() {
  const v = Number(get(KEYS.scale, "100"));
  return SCALES.includes(v) ? v : 100;
}
export function applyScale(pct) {
  const v = SCALES.includes(Number(pct)) ? Number(pct) : 100;
  set(KEYS.scale, String(v));
  root.style.zoom = v === 100 ? "" : String(v / 100);
}

export function currentMotion() { return get(KEYS.motion, "on") === "off" ? "off" : "on"; }
export function applyMotion(mode) {
  set(KEYS.motion, mode === "off" ? "off" : "on");
  if (mode === "off") root.dataset.motion = "off";
  else delete root.dataset.motion;
}

export function backdropOn() { return get(KEYS.backdrop, "on") !== "off"; }
export function applyBackdrop(on) {
  set(KEYS.backdrop, on ? "on" : "off");
  if (on) delete root.dataset.backdrop;
  else root.dataset.backdrop = "off";
}

export function startTab() { const v = get(KEYS.start, "last"); return START_TABS[v] ? v : "last"; }
export function setStartTab(v) { set(KEYS.start, START_TABS[v] ? v : "last"); }

(function init() {
  applyAccent(currentAccent());
  applyScale(currentScale());
  applyMotion(currentMotion());
  applyBackdrop(backdropOn());
})();
