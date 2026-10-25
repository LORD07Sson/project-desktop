// Project Desktop — точка входа. В основном vanilla JS с ES-модулями
// (Overview.jsx — первый компонент на SolidJS, см. историю миграции на
// Vite) — ходит напрямую в тот же REST API, что и мини-апп, через fetch().
//
// Раздроблено на src/app/*.js по темам (было — один файл на ~2000 строк,
// см. историю git) — каждый модуль явно импортирует то, что ему нужно,
// вместо общей области видимости одного <script>. Порядок import'ов ниже
// не имеет значения для графа зависимостей (ES-модули резолвятся сами),
// но некоторые модули нужно импортировать именно отсюда явно — их
// побочный эффект (навешивание обработчиков на кнопки) не тянется
// транзитивно ни из одного другого модуля. Если добавляете новый модуль
// с своей DOM-разводкой (addEventListener на верхнем уровне) и он не
// импортируется ни одним из уже переходимых отсюда — добавьте import
// сюда тоже, иначе его код просто никогда не выполнится.

// Шрифт интерфейса — Manrope (лежит в сборке, CSP пускает только свои шрифты).
import "@fontsource-variable/manrope";
import { installFileLogging } from "./applog.js";
import { appWindow } from "./tauri.js";
import { installWindowChrome } from "./window-chrome.js";
import { tryRestoreSession } from "./auth.js";

// Максимально рано — до любого другого кода, который уже мог бы
// что-то залогировать (см. applog.js).
installFileLogging();
// Кнопки окна — до любого экрана: полоса заголовка своя (системная
// выключена), и на экране входа/загрузки окно тоже нужно чем-то
// двигать и закрывать.
installWindowChrome();
// Заставка — сразу после того, как тема и акцент применены (theme.js и ui-prefs.js при импорте).
startSplash();
import "./density.js";
import "./ui-prefs.js";
import "./tabs.js";
import "./qc.js";
import "./media-tools.js";
import "./midi-control.js";
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
import "./focus-mode.js";
import "./file-drop.js";
import "./force-update.js";
import "./lofi.js";
import "./avatar-hover.js";
import "./feed-badge.js";
import "./title-hover.js";
import "./watch.js";
import { installLiquidNav } from "./nyaa-fx.js";
import { startEmojiIcons } from "./icons.js";
import { startAntivirusAuto } from "./antivirus-ui.js";
import { startSplash } from "./splash.js";
installLiquidNav();
// Системное меню браузера (Back / Refresh / Save as / Print) по правому клику программе ни к чему: убираем его.
// Своё меню (чаты, отчёты, профиль) отменяет событие раньше и работает как было. Браузерное меню остаётся только
// в полях ввода и на выделенном тексте — там оно полезно: копировать, вставить, проверка орфографии.
document.addEventListener("contextmenu", e => {
  if (e.defaultPrevented) return;
  const t = e.target instanceof window.Element ? e.target : null;
  if (t && t.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return;
  if (String(window.getSelection?.() || "").trim()) return;
  e.preventDefault();
});
// Эмодзи в тексте интерфейса → линейные значки в стиле остальных иконок (см. icons.js).
startEmojiIcons();
startAntivirusAuto();

tryRestoreSession();
setTimeout(() => appWindow.show(), 0); // DevSkim: ignore DS172411 — функция, не строка
setTimeout(maybeAutoCheckUpdates, 3000); // DevSkim: ignore DS172411 — функция, не строка

// Автопроверка ffmpeg и видеокарты для «Собрать у себя»: если ffmpeg нет, приложение само докачает его из релиза на GitHub.
setTimeout(() => {
  import("./local-render.js").then(m => m.prepareLocalRender()).catch(() => { /* не в Tauri или нет сети — окно сборки проверит сам */ });
}, 8000);
