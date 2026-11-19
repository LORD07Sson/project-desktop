
const KEY = "project-density";

export function applyDensity(density) {
  document.documentElement.dataset.density = density;
  try { localStorage.setItem(KEY, density); } catch (_) {}
}

export function currentDensity() {
  try { return localStorage.getItem(KEY) || "comfortable"; } catch (_) { return "comfortable"; }
}

applyDensity(currentDensity());
