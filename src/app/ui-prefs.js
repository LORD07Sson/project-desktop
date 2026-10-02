// Личные настройки вида (Настройки → Внешний вид / Поведение): акцентный
// цвет, масштаб интерфейса, анимации, компактное боковое меню, стартовый
// раздел. Хранятся в localStorage и применяются сразу при импорте модуля —
// до первой отрисовки, чтобы не мигало.

const KEYS = {
  accent: "project-accent",
  scale: "project-scale",
  motion: "project-motion",
  sidebar: "project-sidebar",
  start: "project-start-tab",
};

// Акцент: основной цвет, светлее, золото для градиента и цвет текста на нём.
export const ACCENTS = {
  fire: { label: "Огонь", fire: null },
  sakura: { label: "Сакура", fire: "#ff4d7d", ember: "#ff7fa0", gold: "#ffb3c6", on: "#2a0610" },
  violet: { label: "Фиалка", fire: "#8b5cff", ember: "#a98bff", gold: "#d0bcff", on: "#12062a" },
  sky: { label: "Небо", fire: "#1fa8ff", ember: "#5cc4ff", gold: "#9fe3ff", on: "#04182a" },
  mint: { label: "Мята", fire: "#1fc77a", ember: "#4fdc97", gold: "#b4f06a", on: "#04190e" },
};
export const SCALES = [90, 100, 110, 125];
export const START_TABS = { last: "Последний", queue: "Моя очередь", overview: "Обзор" };

function get(key, fallback) {
  try { return localStorage.getItem(key) || fallback; } catch (_) { return fallback; }
}
function set(key, value) {
  try { localStorage.setItem(key, value); } catch (_) { /* приватный режим — просто не запомним */ }
}

const root = document.documentElement;

export function currentAccent() { return ACCENTS[get(KEYS.accent, "fire")] ? get(KEYS.accent, "fire") : "fire"; }
export function applyAccent(name) {
  const a = ACCENTS[name] || ACCENTS.fire;
  set(KEYS.accent, ACCENTS[name] ? name : "fire");
  const props = ["--fire", "--ember", "--gold", "--on-accent", "--accent-soft", "--accent-grad"];
  if (!a.fire) { props.forEach(p => root.style.removeProperty(p)); return; }
  root.style.setProperty("--fire", a.fire);
  root.style.setProperty("--ember", a.ember);
  root.style.setProperty("--gold", a.gold);
  root.style.setProperty("--on-accent", a.on);
  root.style.setProperty("--accent-soft", `color-mix(in srgb, ${a.fire} 16%, transparent)`);
  root.style.setProperty("--accent-grad", `linear-gradient(135deg, ${a.fire}, ${a.gold})`);
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

export function sidebarCompact() { return get(KEYS.sidebar, "full") === "compact"; }
export function applySidebarCompact(on) {
  set(KEYS.sidebar, on ? "compact" : "full");
  if (on) root.dataset.sidebar = "compact";
  else delete root.dataset.sidebar;
}

// Стартовый раздел: «last» — как раньше, последний открытый.
export function startTab() { const v = get(KEYS.start, "last"); return START_TABS[v] ? v : "last"; }
export function setStartTab(v) { set(KEYS.start, START_TABS[v] ? v : "last"); }

(function init() {
  applyAccent(currentAccent());
  applyScale(currentScale());
  applyMotion(currentMotion());
  applySidebarCompact(sidebarCompact());
})();
