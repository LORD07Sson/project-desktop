
import { appWindow } from "./tauri.js";
import { $ } from "./utils.js";

async function syncMaximizedClass() {
  let maximized = false;
  try { maximized = await appWindow.isMaximized(); } catch { }
  document.body.classList.toggle("window-maximized", maximized);
  const btn = $("#win-maximize");
  if (btn) {
    btn.title = maximized ? "Свернуть в окно" : "Развернуть";
    btn.setAttribute("aria-label", btn.title);
  }
}

export function installWindowChrome() {
  $("#win-minimize")?.addEventListener("click", () => appWindow.minimize());
  $("#win-maximize")?.addEventListener("click", async () => {
    await appWindow.toggleMaximize();
    syncMaximizedClass();
  });
  $("#win-close")?.addEventListener("click", () => appWindow.close());

  $("#titlebar")?.addEventListener("dblclick", async e => {
    if (e.target.closest("button")) return;
    await appWindow.toggleMaximize();
    syncMaximizedClass();
  });

  appWindow.onResized(syncMaximizedClass).catch(() => {});
  syncMaximizedClass();
}
