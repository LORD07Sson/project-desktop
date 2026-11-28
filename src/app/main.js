
import "@fontsource-variable/manrope";
import { installFileLogging } from "./applog.js";
import { appWindow } from "./tauri.js";
import { installWindowChrome } from "./window-chrome.js";
import { tryRestoreSession } from "./auth.js";

installFileLogging();
installWindowChrome();
startSplash();
import "./density.js";
import "./ui-prefs.js";
import "./season.js";
import "./tabs.js";
import "./qc.js";
import "./media-tools.js";
import "./deeplink.js";
import "./tune.js";
import { maybeAutoCheckUpdates } from "./settings.js";
import "./notifications.js";
import "./chat-notify.js";
import "./presence.js";
import "./telemetry.js";
import "./command-palette.js";
import "./titlebar-menus.js";
import "./shortcuts-help.js";
import "./idle-scene.js";
import "./file-drop.js";
import "./force-update.js";
import "./lofi.js";
import "./avatar-hover.js";
import "./award-cards.js";
import "./feed-badge.js";
import "./title-hover.js";
import "./clip-title.js";
import "./watch.js";
import { installLiquidNav } from "./nyaa-fx.js";
import { startEmojiIcons } from "./icons.js";
import { startAntivirusAuto } from "./antivirus-ui.js";
import { startSplash } from "./splash.js";
installLiquidNav();
document.addEventListener("contextmenu", e => {
  if (e.defaultPrevented) return;
  const t = e.target instanceof window.Element ? e.target : null;
  if (t && t.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return;
  if (String(window.getSelection?.() || "").trim()) return;
  e.preventDefault();
});
startEmojiIcons();
startAntivirusAuto();

tryRestoreSession();
setTimeout(() => appWindow.show(), 0); // DevSkim: ignore DS172411
setTimeout(maybeAutoCheckUpdates, 3000); // DevSkim: ignore DS172411

setTimeout(() => {
  import("./local-render.js").then(m => m.prepareLocalRender()).catch(() => { });
}, 8000);
