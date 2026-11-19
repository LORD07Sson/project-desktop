
export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("project-theme", theme); } catch (_) {}
}

export function applyLook(look) {
  document.documentElement.dataset.look = look;
  try { localStorage.setItem("project-look", look); } catch (_) {}
}

(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("project-theme"); } catch (_) {}
  applyTheme(saved || "dark");
  let look = null;
  try { look = localStorage.getItem("project-look"); } catch (_) {}
  document.documentElement.dataset.look = look || "kadr";
})();

document.querySelector("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  if (!document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    applyTheme(next);
    return;
  }
  document.startViewTransition(() => applyTheme(next));
});
