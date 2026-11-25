
// Only the dark theme is left (the light one was removed); callers passing "light" still get dark.
export function applyTheme() {
  document.documentElement.dataset.theme = "dark";
  try { localStorage.setItem("project-theme", "dark"); } catch (_) {}
}

export function applyLook(look) {
  document.documentElement.dataset.look = look;
  try { localStorage.setItem("project-look", look); } catch (_) {}
}

(function initTheme() {
  applyTheme();
  let look = null;
  try { look = localStorage.getItem("project-look"); } catch (_) {}
  document.documentElement.dataset.look = look || "kadr";
})();

