// Диалог «Настройки» (автозапуск, тема, режим разработчика, автообновление).

import { invoke, listen } from "./tauri.js";
import { state } from "./state.js";
import { apiGet, openSheet, toast, dismissSheet, API_BASE } from "./api.js";
import { $, esc } from "./utils.js";
import { applyTheme, applyLook } from "./theme.js";
import { applyDensity, currentDensity } from "./density.js";
import { focusModePreferred, setFocusModePreferred } from "./focus-mode.js";
import { isDevModeOn, setDevModeOn } from "./devmode.js";
import { desktopNotifyEnabled, setDesktopNotifyEnabled, NOTIFY_KINDS, notifyKinds, setNotifyKind, quietHours, setQuietHours } from "./desktop-notify.js";
import { ACCENTS, SCALES, START_TABS, currentAccent, applyAccent, currentScale, applyScale, currentMotion, applyMotion, sidebarCompact, applySidebarCompact, startTab, setStartTab } from "./ui-prefs.js";
import { GROUPS as SHORTCUT_GROUPS } from "./shortcuts-help.js";
import { avatarHtml, loadAvatars } from "./profile.js";
import { fetchPerson, openPauseDialog } from "./people.js";
import { openAdminPanel } from "./admin.js";
import { tagLogger } from "./applog.js";
import { availableTours, startTour, showWelcome, tourHintsEnabled, setTourHints, resetTourProgress } from "./tour.js";

const updateLog = tagLogger("updates");

// «Что нового» в Настройках → Обновления. Пополняется руками вместе с релизом.
const CHANGELOG = [
  ["0.6", [
    "Настройки 2.0: поиск, акцентный цвет, масштаб, уведомления по типам и тихие часы",
    "«Взять в работу»: серии по расписанию и раздачи с nyaa каждому из состава в личку",
    "«Моя очередь» и статус серий в календаре",
    "Новые Обзор, Тайтлы и шапка с поиском Ctrl+K",
  ]],
  ["0.5", [
    "Экран входа — стена обложек сезона",
    "Обучение для новичков и уроки по каждому разделу",
    "Плеер: озвучки, весь экран без чёрной полосы",
  ]],
];

// Версию подставляет Vite на этапе сборки (define: __APP_VERSION__ в
// vite.config.js — читает файл VERSION, а в CI ещё и переменную
// PKG_VERSION, куда альфа-сборка кладёт "0.6.0-alpha.N+sha").
// Раньше здесь лежал литерал, который CI правил себе sed'ом по
// исходнику, — и в git он годами расходился и с VERSION, и с
// Cargo.toml: у собранного локально клиента в Настройках показывалась
// версия, которой нигде больше нет.
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

// Альфа-сборки несут короткий коммит как SemVer build-metadata —
// "0.5.8-alpha.90+78ab7a92" (см. build-alpha.yml) — само сравнение
// версий Velopack'ом на него не смотрит (SemVer build-metadata в
// приоритет не участвует), тут его просто вытаскиваем для отображения.
function commitFromVersion(version) {
  const m = /\+([0-9a-f]{6,40})$/i.exec(version || "");
  return m ? m[1] : null;
}

async function openSettings() {
  let autostartOn = false;
  try { autostartOn = await invoke("is_autostart"); } catch (_) {}
  let updateChannel = "stable";
  try { updateChannel = await invoke("get_update_channel"); } catch (_) {}

  // Переключатель dev-режима виден только реальным разработчикам студии
  // (state.isDeveloper — из /api/me, is_developer сервер сам проверяет
  // по OWNER_IDS на каждый /api/dev/* запрос, фронту тут не доверяют).
  if (state.isDeveloper == null) {
    try { state.isDeveloper = !!(await apiGet("/me")).is_developer; } catch (_) { state.isDeveloper = false; }
  }

  const ic = d => `<span class="st-ic"><svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg></span>`;
  const ICONS = {
    acc: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
    keys: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.9 1.4-1.9-.5-1.2.2-2.6 1.6-2.6h1.7a3.8 3.8 0 0 0 3.8-3.8C20.5 7.4 16.7 3.5 12 3.5Z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15" cy="8" r="1"/>',
    scale: '<path d="M4 20h6M7 20V8M3 8h8M14 20h7M17.5 20V4M14 4h7"/>',
    motion: '<path d="M4 12h3l2-5 4 10 2-5h5"/>',
    sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9 4.5v15"/>',
    dot: '<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
    pause: '<rect x="6.5" y="5" width="3.5" height="14" rx="1"/><rect x="14" y="5" width="3.5" height="14" rx="1"/>',
    home: '<path d="M4 11 12 4l8 7v9H4zM10 20v-5h4v5"/>',
    server: '<rect x="3.5" y="4" width="17" height="7" rx="1.5"/><rect x="3.5" y="13" width="17" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    look: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M12 3.5a8.5 8.5 0 0 1 0 17" fill="currentColor" stroke="none" opacity=".35"/>',
    behave: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    update: '<path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/>',
    studio: '<path d="M4 20V9l8-5 8 5v11M9 20v-6h6v6"/>',
    diag: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    power: '<path d="M12 3v8M6.3 7.3a8 8 0 1 0 11.4 0"/>',
    bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/>',
    focus: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/><circle cx="12" cy="12" r="2.5"/>',
    dev: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
    density: '<path d="M4 6h16M4 10h16M4 14h16M4 18h16"/>',
    logs: '<path d="M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7"/>',
    bot: '<path d="M4 5h16v11H9l-5 4zM8 9h8M8 12h5"/>',
    learn: '<path d="M2.5 9 12 4.5 21.5 9 12 13.5z"/><path d="M6.5 11v4.5c0 1.4 2.5 3 5.5 3s5.5-1.6 5.5-3V11M21.5 9v5"/>',
    hint: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 17h.01"/>',
  };
  const TILES = [
    ["s-open-admin", "Админ-панель", "Доступ, заявки, система", '<circle cx="12" cy="8" r="3.5"/><path d="M4.5 20c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/>'],
    ["s-tile-notice", "Объявление", "Строка для всей команды", '<path d="M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v6"/>'],
    ["s-tile-tickets", "Тикеты", "Поддержка, переписка", '<path d="M4 6h16v9H9l-5 4z"/>'],
    ["s-tile-roles", "Роли", "Пайплайны и люди", '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5M16 11l2 2 4-4"/>'],
    ["s-tile-bdays", "Дни рождения", "Бот поздравит сам", '<path d="M4 21h16M5 21v-7h14v7M12 14V9M9 5c0 1.7 1.3 3 3 3s3-1.3 3-3c0-1.2-3-3-3-3S9 3.8 9 5Z"/>'],
    ["s-tile-post", "Пост в канал", "Конструктор с превью", '<path d="M3 12l18-8-8 18-2-8-8-2Z"/>'],
    ["s-tile-mentions", "Упоминания", "Кого поднять в чате", '<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>'],
    ["s-tile-lockdown", "Аварийный режим", "«Саботаж»: заморозить удаление", '<path d="M12 3 2 20h20L12 3zM12 10v4M12 17h.01"/>'],
    ...(state.isDeveloper ? [["s-tile-trash", "Корзина", "Вернуть удалённое за 7 дней", '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>']] : []),
    ...(state.isDeveloper ? [["s-tile-log", "Журнал действий", "Надзор за админами", '<path d="M6 3h9l4 4v14H6zM9 12h7M9 16h5"/>']] : []),
  ];
  const theme = document.documentElement.dataset.theme || "dark";
  const look = document.documentElement.dataset.look || "glow";
  const themeCard = theme === "light" ? "light" : look;
  const density = currentDensity();
  const accent = currentAccent();
  const scale = currentScale();
  const motion = currentMotion();
  const start = startTab();
  const kinds = notifyKinds();
  const quiet = quietHours();
  const sw = (id, on, extra = "") => `<label class="mn-switch st-switch"><input type="checkbox" id="${id}" ${on ? "checked" : ""} ${extra}><span></span></label>`;
  const seg = (attr, items, cur) => `<div class="seg-toggle" role="group">${items.map(([v, l]) => `<button type="button" class="seg-btn${String(v) === String(cur) ? " active" : ""}" ${attr}="${v}">${l}</button>`).join("")}</div>`;
  const row = (icon, title, sub, control, keywords = "") => `<div class="st-row" data-st-find="${esc(`${title} ${sub} ${keywords}`.toLowerCase())}">${ic(icon)}<div class="st-text"><b>${title}</b>${sub ? `<span>${sub}</span>` : ""}</div>${control}</div>`;
  const NAV = [
    ["Личное", [["st-acc", "Аккаунт", ICONS.acc], ["st-look", "Внешний вид", ICONS.look], ["st-notif", "Уведомления", ICONS.bell], ["st-behave", "Поведение", ICONS.behave], ["st-keys", "Горячие клавиши", ICONS.keys]]],
    ["Приложение", [["st-update", "Обновления", ICONS.update], ["st-learn", "Обучение", ICONS.learn], ["st-diag", "Диагностика", ICONS.diag]]],
    ...(state.isAdmin || state.isDeveloper ? [["Студия", [["st-studio", "Студия", ICONS.studio], ...(state.isDeveloper ? [["st-bot", "Чаты бота", ICONS.bot]] : [])]]] : []),
  ];

  const overlay = openSheet(`
    <div class="st-layout">
      <nav class="st-nav" aria-label="Разделы настроек">
        <div class="st-nav-title">Настройки</div>
        <label class="st-find">${ic(ICONS.search)}<input type="search" id="st-find" placeholder="Найти настройку…" autocomplete="off"></label>
        ${NAV.map(([group, items]) => `<div class="st-nav-grp">${group}</div>` + items.map(([id, label, i], n) => `<button type="button" class="st-nav-btn${id === "st-acc" && n === 0 ? " on" : ""}" data-st-go="${id}">${ic(i)}<span>${label}</span></button>`).join("")).join("")}
      </nav>
      <div class="st-body" id="st-body">
        <button type="button" class="icon-btn st-close" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        <div class="st-empty" id="st-find-empty" hidden>Ничего не нашлось — попробуйте другое слово.</div>

        <section class="st-sec on" id="st-acc">
          <h3>Аккаунт</h3><p class="st-lead">Кто вы в студии и выход с этого компьютера.</p>
          <div class="st-group">
            <div class="st-acc" data-st-find="аккаунт профиль имя аватар">
              ${avatarHtml(state.telegramId, state.name || "?", "xl")}
              <div class="st-text"><b>${esc(state.name || "Без имени")}</b><span>${state.isAdmin ? "Администратор студии" : "Участник студии"}</span></div>
              <button type="button" class="btn" id="s-acc-profile">Открыть профиль</button>
            </div>
          </div>
          <div class="st-group">
            ${row(ICONS.power, "Выйти из аккаунта", "На этом компьютере — для входа понадобится новый код из бота", `<button type="button" class="btn danger" id="s-acc-logout">Выйти</button>`, "logout выход")}
          </div>
        </section>

        <section class="st-sec" id="st-look">
          <h3>Внешний вид</h3><p class="st-lead">Изменения видны сразу, без перезапуска.</p>
          <div class="st-group" data-st-find="тема тёмная светлая огонь золото свечение">
            <div class="st-group-h">Тема</div>
            <div class="st-cards st-cards-3">
              <button type="button" class="st-card${themeCard === "fire" ? " on" : ""}" data-st-themecard="fire"><span class="st-prev st-prev-fire"><i></i><i></i><i></i></span><b>Огонь</b><em>тёмная, свечение снизу</em></button>
              <button type="button" class="st-card${themeCard === "glow" ? " on" : ""}" data-st-themecard="glow"><span class="st-prev st-prev-glow"><i></i><i></i><i></i></span><b>Золотое свечение</b><em>тёмная, золотые кромки</em></button>
              <button type="button" class="st-card${themeCard === "light" ? " on" : ""}" data-st-themecard="light"><span class="st-prev st-prev-light"><i></i><i></i><i></i></span><b>Светлая</b><em>для дня</em></button>
            </div>
          </div>
          <div class="st-group">
            ${row(ICONS.palette, "Акцентный цвет", "Кнопки, подсветка, графики", `<div class="st-accents">${Object.entries(ACCENTS).map(([k, a]) => `<button type="button" class="st-accent${k === accent ? " on" : ""}" data-st-accent="${k}" title="${a.label}" style="--a1:${a.fire || "#ff6a2b"};--a2:${a.gold || "#ffb444"}"></button>`).join("")}</div>`, "цвет акцент")}
            ${row(ICONS.scale, "Масштаб интерфейса", "Для больших мониторов и 4K", seg("data-st-scale", SCALES.map(v => [v, `${v}%`]), scale), "размер шрифт крупнее")}
            ${row(ICONS.density, "Плотность таблиц", "Сколько строк влезает в «Список»", seg("data-st-density", [["comfortable", "Обычная"], ["compact", "Компактная"]], density))}
            ${row(ICONS.motion, "Анимации", "Выключите на слабом компьютере", seg("data-st-motion", [["on", "Включены"], ["off", "Выключены"]], motion), "движение плавность")}
            ${row(ICONS.sidebar, "Компактное боковое меню", "Только иконки — больше места под содержимое", sw("s-sidebar-compact", sidebarCompact()), "сайдбар")}
          </div>
          <select id="s-theme" hidden><option value="dark">Тёмная</option><option value="light">Светлая</option></select>
          <select id="s-density" hidden><option value="comfortable">Обычная</option><option value="compact">Компактная</option></select>
        </section>

        <section class="st-sec" id="st-notif">
          <h3>Уведомления</h3><p class="st-lead">Всплывашки Windows — когда окно свёрнуто, в трее или за другими окнами. Колокольчик в шапке собирает всё в любом случае.</p>
          <div class="st-group">
            ${row(ICONS.bell, "Уведомления на рабочий стол", "Общий выключатель", sw("s-desktop-notify", desktopNotifyEnabled()), "windows всплывашки")}
          </div>
          <div class="st-group" id="st-kinds">
            <div class="st-group-h">Что показывать</div>
            ${Object.entries(NOTIFY_KINDS).map(([k, [t, sub]]) => row(ICONS.dot, t, sub, sw(`s-kind-${k}`, kinds[k], `data-st-kind="${k}"`), "уведомления")).join("")}
          </div>
          <div class="st-group">
            ${row(ICONS.moon, "Тихие часы", "В это время всплывашки не показываются", `<div class="st-quiet"><input type="time" id="s-quiet-from" value="${esc(quiet.from)}"><span>—</span><input type="time" id="s-quiet-to" value="${esc(quiet.to)}">${sw("s-quiet-on", quiet.on)}</div>`, "ночь не беспокоить")}
            ${row(ICONS.pause, "Пауза — отпуск или болезнь", "Бот не напоминает о сроках и не пишет о просрочке", `<button type="button" class="btn" id="s-pause">Настроить</button>`, "отпуск пауза бот")}
          </div>
        </section>

        <section class="st-sec" id="st-behave">
          <h3>Поведение</h3><p class="st-lead">Как приложение ведёт себя в системе.</p>
          <div class="st-group">
            ${row(ICONS.power, "Запускать при старте системы", "Окно сразу уходит в трей и следит за назначениями", sw("s-autostart", autostartOn), "автозапуск windows")}
            ${row(ICONS.home, "Стартовый раздел", "Что открывать при запуске", seg("data-st-start", Object.entries(START_TABS), start), "запуск вкладка")}
            ${row(ICONS.focus, "Фокус-режим при открытии отчёта", "Карточка отчёта на весь экран, остальное прячется", sw("s-focus-mode", focusModePreferred()))}
            ${state.isDeveloper ? `<div class="dev-pill-toggle">${row(ICONS.dev, "Режим разработчика", "Правка чужих ролей, профиля, даты вступления и наград — на карточке коллеги", sw("s-dev-mode", isDevModeOn()))}</div>` : ""}
          </div>
        </section>

        <section class="st-sec" id="st-keys">
          <h3>Горячие клавиши</h3><p class="st-lead">То же, что по клавише <kbd>?</kbd> из любого места.</p>
          ${SHORTCUT_GROUPS.map(g => `<div class="st-group"><div class="st-group-h">${esc(g.title)}</div><div class="st-keylist">${g.rows.map(([k, d]) => `<div data-st-find="${esc(`${k} ${d}`.toLowerCase())}"><span class="st-kbd">${k.split(/\s*\+\s*/).map(x => `<kbd>${esc(x)}</kbd>`).join("")}</span><span>${esc(d)}</span></div>`).join("")}</div></div>`).join("")}
        </section>

        <section class="st-sec" id="st-update">
          <h3>Обновления</h3><p class="st-lead">Версия, канал и что нового.</p>
          <div class="st-group">
            <div class="st-version">
              <div class="st-version-logo">${ic('<path d="M5 5L19 19M19 5L5 19"/>')}</div>
              <div class="st-text"><b>Project Desktop</b><span>версия ${esc(APP_VERSION)}</span></div>
              <button class="btn primary" id="s-check-update">Проверить обновления</button>
            </div>
            ${row(ICONS.update, "Канал обновлений", "Альфа — сборка на каждый коммит, для проверки нового", seg("data-st-channel", [["stable", "Стабильный"], ["alpha", "Альфа"]], updateChannel), "альфа стабильный")}
            <select id="s-update-channel" hidden>
              <option value="stable" ${updateChannel === "stable" ? "selected" : ""}>Стабильный</option>
              <option value="alpha" ${updateChannel === "alpha" ? "selected" : ""}>Альфа</option>
            </select>
            <div id="s-alpha-block" hidden>
              <div class="alpha-warn">Альфа-сборки собираются на каждый коммит в main и не являются стабильными релизами — автоматического отката нет.</div>
              <div class="st-commits">
                <div><span>Текущий коммит</span><code id="s-commit-current">—</code></div>
                <div><span>Последний коммит</span><code id="s-commit-latest">—</code></div>
              </div>
            </div>
          </div>
          <div class="st-group" data-st-find="что нового изменения версии">
            <div class="st-group-h">Что нового</div>
            <div class="st-changelog">${CHANGELOG.map(([v, items]) => `<div class="st-cl"><b>${esc(v)}</b><ul>${items.map(x => `<li>${esc(x)}</li>`).join("")}</ul></div>`).join("")}</div>
          </div>
        </section>

        <section class="st-sec" id="st-learn">
          <h3>Обучение</h3><p class="st-lead">Уроки по каждому разделу — любой можно пройти снова.</p>
          <div class="st-learn-top">
            <div class="st-learn-prog"><b id="st-learn-count"></b><span>уроков пройдено</span><i><em id="st-learn-bar"></em></i></div>
            <button class="btn primary" id="s-learn-intro">Пройти знакомство</button>
          </div>
          <div class="st-learn-grid" id="st-learn-grid"></div>
          <div class="st-group">
            ${row(ICONS.hint, "Подсказки «Впервые в разделе?»", "При первом входе в раздел предложить его разбор — показать или пропустить", sw("s-learn-hints", tourHintsEnabled()), "обучение подсказки")}
          </div>
          <div class="st-learn-foot"><button type="button" class="btn ghost" id="s-learn-reset">Начать обучение с нуля</button><span>снова покажет приветствие и все подсказки</span></div>
        </section>

        <section class="st-sec" id="st-diag">
          <h3>Диагностика</h3><p class="st-lead">Если что-то сломалось — отсюда проще всего рассказать, что именно.</p>
          <div class="st-group">
            ${row(ICONS.server, "Сервер студии", "Связь с сервером и время ответа", `<span class="st-ping" id="s-ping">проверяю…</span><button type="button" class="btn" id="s-ping-again">Проверить</button>`, "сеть сервер соединение")}
            ${row(ICONS.logs, "Файловые логи приложения", "Обновления, QC звука, инструменты ffmpeg, плеер", `<button class="btn" id="s-open-logs">Открыть логи</button>`, "логи")}
            ${row(ICONS.copy, "Отчёт для разработчика", "Версия, система, канал, связь с сервером — одним текстом в буфер обмена", `<button class="btn" id="s-copy-report">Скопировать</button>`, "баг ошибка")}
          </div>
        </section>

        <section class="st-sec" id="st-studio">
          <h3>Студия</h3><p class="st-lead">Инструменты администратора.</p>
          <div class="st-tiles">
            ${TILES.map(([id, title, sub, path]) => `<button type="button" class="st-tile" id="${id}" data-st-find="${esc(`${title} ${sub}`.toLowerCase())}">${ic(path)}<b>${title}</b><span>${sub}</span></button>`).join("")}
          </div>
        </section>

        ${state.isDeveloper ? `
        <section class="st-sec" id="st-bot">
          <h3>Чаты бота</h3>
          <div id="st-bot-chats"></div>
        </section>` : ""}
      </div>
    </div>
  `, "wide");
  overlay.querySelector(".sheet").classList.add("st-sheet");
  overlay.querySelector("#s-theme").value = document.documentElement.dataset.theme || "dark";
  overlay.querySelector("#s-theme").addEventListener("change", e => applyTheme(e.target.value));
  overlay.querySelector("#s-density").value = currentDensity();
  overlay.querySelector("#s-density").addEventListener("change", e => applyDensity(e.target.value));
  overlay.querySelector("#s-focus-mode").addEventListener("change", e => setFocusModePreferred(e.target.checked));
  overlay.querySelector("#s-desktop-notify").addEventListener("change", e => setDesktopNotifyEnabled(e.target.checked));
  overlay.querySelector("#s-autostart").addEventListener("change", async e => {
    try {
      await invoke("set_autostart", { enabled: e.target.checked });
    } catch (err) {
      toast(`Не удалось изменить автозапуск: ${err}`, "error");
      e.target.checked = !e.target.checked;
    }
  });
  const devToggle = overlay.querySelector("#s-dev-mode");
  if (devToggle) devToggle.addEventListener("change", e => setDevModeOn(e.target.checked));
  overlay.querySelector("#s-check-update").addEventListener("click", () => checkForUpdates(false));

  // Блок "текущий/последний коммит" — только для альфа-канала (у
  // стабильных сборок нет вшитого коммита, см. commitFromVersion).
  // "Последний" узнаём тем же check_for_update, которым пользуется
  // обычная проверка обновлений — лишнего эндпоинта не нужно, только
  // здесь мы его не открываем диалогом, а просто вытаскиваем коммит.
  async function refreshAlphaBlock(channel) {
    const block = overlay.querySelector("#s-alpha-block");
    block.hidden = channel !== "alpha";
    if (channel !== "alpha") return;

    const currentSha = commitFromVersion(APP_VERSION) || "?";
    const currentEl = overlay.querySelector("#s-commit-current");
    const latestEl = overlay.querySelector("#s-commit-latest");
    currentEl.textContent = currentSha;
    currentEl.title = APP_VERSION;
    latestEl.textContent = "…";
    latestEl.title = "";
    try {
      const update = await invoke("check_for_update");
      // update === null у Velopack означает "на канале нечего ставить" —
      // не то же самое, что ошибка запроса (см. catch ниже), различаем
      // текстом, чтобы не гадать по одному "?" в обоих случаях.
      if (update) {
        latestEl.textContent = commitFromVersion(update.version) || "?";
        latestEl.title = update.version;
      } else {
        latestEl.textContent = "нет новее";
        latestEl.title = "check_for_update вернул null — Velopack считает текущую версию актуальной для этого канала.";
      }
    } catch (e) {
      latestEl.textContent = "?";
      latestEl.title = `Ошибка check_for_update: ${e}`;
    }
  }
  refreshAlphaBlock(updateChannel);

  overlay.querySelector("#s-update-channel").addEventListener("change", async e => {
    const channel = e.target.value;
    try {
      await invoke("set_update_channel", { channel });
      toast(channel === "alpha" ? "Альфа-канал включён." : "Возвращено на стабильный канал.");
      await refreshAlphaBlock(channel);
    } catch (err) {
      toast(`Не удалось сменить канал: ${err}`, "error");
    }
  });
  overlay.querySelector("#s-open-admin").addEventListener("click", openAdminPanel);
  overlay.querySelector("#s-open-logs").addEventListener("click", async () => {
    try {
      await invoke("open_log_folder");
    } catch (err) {
      toast(`Не удалось открыть папку с логами: ${err}`, "error");
    }
  });
  overlay.querySelector("[data-close]").addEventListener("click", () => dismissSheet(overlay));

  // Плитки и сегменты — поверх тех же скрытых <select>, что и раньше:
  // обработчики выше не поменялись.
  const pick = (attr, sel, value) => {
    overlay.querySelectorAll(`[${attr}]`).forEach(b => b.classList.toggle(b.classList.contains("seg-btn") ? "active" : "on", b.getAttribute(attr) === value));
    if (sel) { const el = overlay.querySelector(sel); el.value = value; el.dispatchEvent(new window.Event("change")); }
  };
  overlay.querySelectorAll("[data-st-density]").forEach(b => b.addEventListener("click", () => pick("data-st-density", "#s-density", b.dataset.stDensity)));
  overlay.querySelectorAll("[data-st-channel]").forEach(b => b.addEventListener("click", () => pick("data-st-channel", "#s-update-channel", b.dataset.stChannel)));
  const tile = (id, fn) => { const el = overlay.querySelector(`#${id}`); if (el) el.addEventListener("click", fn); };
  tile("s-tile-notice", () => import("./team-notice.js").then(m => m.openNoticeEditor()));
  tile("s-tile-tickets", () => import("./tickets.js").then(m => m.openTicketsSheet()));
  tile("s-tile-roles", () => import("./roles.js").then(m => m.openRolesSheet()));
  tile("s-tile-bdays", () => import("./birthdays.js").then(m => m.openBirthdaysSheet()));
  tile("s-tile-post", () => { dismissSheet(overlay); import("./channel-post.js").then(m => m.openChannelPostSheet()); });
  tile("s-tile-mentions", () => import("./mentions.js").then(m => m.openMentionsSheet()));
  tile("s-tile-log", () => import("./admin-log.js").then(m => m.openAdminLogSheet()));
  tile("s-tile-lockdown", () => { dismissSheet(overlay); import("./lockdown.js").then(m => m.openLockdownSheet()); });
  tile("s-tile-trash", () => { dismissSheet(overlay); import("./lockdown.js").then(m => m.openTrashSheet()); });

  // Обучение: список уроков, запуск закрывает настройки.
  const renderLearn = () => {
    const tours = availableTours();
    const done = tours.filter(t => t.done).length;
    overlay.querySelector("#st-learn-count").textContent = `${done} из ${tours.length}`;
    overlay.querySelector("#st-learn-bar").style.width = `${tours.length ? (done / tours.length) * 100 : 0}%`;
    overlay.querySelector("#st-learn-grid").innerHTML = tours.map(t => `
      <button type="button" class="st-lesson${t.done ? " done" : ""}" data-learn="${t.id}">
        <span class="st-lesson-ic">${t.icon}</span>
        <span class="st-lesson-t"><b>${esc(t.name)}</b><span>${esc(t.about)}</span></span>
        <em>${t.done ? "✓ пройден" : `${t.steps} шаг.`}</em>
      </button>`).join("");
    overlay.querySelectorAll("[data-learn]").forEach(b => b.addEventListener("click", () => {
      dismissSheet(overlay);
      setTimeout(() => startTour(b.dataset.learn), 200);
    }));
  };
  renderLearn();
  overlay.querySelector("#s-learn-intro").addEventListener("click", () => { dismissSheet(overlay); setTimeout(() => startTour("intro"), 200); });
  overlay.querySelector("#s-learn-hints").addEventListener("change", e => setTourHints(e.target.checked));
  overlay.querySelector("#s-learn-reset").addEventListener("click", () => {
    resetTourProgress();
    dismissSheet(overlay);
    setTimeout(showWelcome, 200);
  });

  const botRoot = overlay.querySelector("#st-bot-chats");
  if (botRoot) import("./bot-chats.js").then(m => m.mountBotChats(botRoot));

  // ---------- Настройки 2.0: разделы по одному, поиск, новые пункты ----------
  const body = overlay.querySelector("#st-body");
  const showSection = id => {
    overlay.querySelectorAll(".st-sec").forEach(sec => sec.classList.toggle("on", sec.id === id));
    overlay.querySelectorAll("[data-st-go]").forEach(b => b.classList.toggle("on", b.dataset.stGo === id));
    body.scrollTop = 0;
  };
  overlay.querySelectorAll("[data-st-go]").forEach(b => b.addEventListener("click", () => {
    const find = overlay.querySelector("#st-find");
    if (find.value) { find.value = ""; applyFind(""); }
    showSection(b.dataset.stGo);
  }));

  // Поиск: показываем все разделы, в них — только подходящие строки.
  const applyFind = q => {
    q = q.trim().toLowerCase();
    overlay.classList.toggle("st-finding", !!q);
    let any = false;
    overlay.querySelectorAll(".st-sec").forEach(sec => {
      if (!q) { sec.querySelectorAll("[data-st-find]").forEach(el => { el.hidden = false; }); return; }
      const title = sec.querySelector("h3")?.textContent.toLowerCase() || "";
      let hit = 0;
      sec.querySelectorAll("[data-st-find]").forEach(el => {
        const ok = title.includes(q) || el.dataset.stFind.includes(q);
        el.hidden = !ok;
        if (ok) hit++;
      });
      sec.classList.toggle("st-hit", hit > 0);
      if (hit) any = true;
    });
    overlay.querySelector("#st-find-empty").hidden = !q || any;
    if (!q) showSection(overlay.querySelector("[data-st-go].on")?.dataset.stGo || "st-acc");
  };
  overlay.querySelector("#st-find").addEventListener("input", e => applyFind(e.target.value));

  // Аккаунт
  overlay.querySelector("#s-acc-profile").addEventListener("click", () => {
    dismissSheet(overlay);
    import("./tabs.js").then(m => m.switchTab("profile"));
  });
  overlay.querySelector("#s-acc-logout").addEventListener("click", () => {
    dismissSheet(overlay);
    $("#logout-btn").click();
  });
  loadAvatars(overlay.querySelector(".st-acc"));

  // Внешний вид
  overlay.querySelectorAll("[data-st-themecard]").forEach(b => b.addEventListener("click", () => {
    overlay.querySelectorAll("[data-st-themecard]").forEach(x => x.classList.toggle("on", x === b));
    const v = b.dataset.stThemecard;
    if (v === "light") { applyTheme("light"); return; }
    applyLook(v);
    applyTheme("dark");
  }));
  overlay.querySelectorAll("[data-st-accent]").forEach(b => b.addEventListener("click", () => {
    overlay.querySelectorAll("[data-st-accent]").forEach(x => x.classList.toggle("on", x === b));
    applyAccent(b.dataset.stAccent);
  }));
  overlay.querySelectorAll("[data-st-scale]").forEach(b => b.addEventListener("click", () => {
    pick("data-st-scale", null, b.dataset.stScale);
    applyScale(Number(b.dataset.stScale));
  }));
  overlay.querySelectorAll("[data-st-motion]").forEach(b => b.addEventListener("click", () => {
    pick("data-st-motion", null, b.dataset.stMotion);
    applyMotion(b.dataset.stMotion);
  }));
  overlay.querySelector("#s-sidebar-compact").addEventListener("change", e => applySidebarCompact(e.target.checked));

  // Уведомления
  overlay.querySelectorAll("[data-st-kind]").forEach(inp => inp.addEventListener("change", () => setNotifyKind(inp.dataset.stKind, inp.checked)));
  const kindsBox = overlay.querySelector("#st-kinds");
  const syncKinds = () => kindsBox.classList.toggle("st-off", !overlay.querySelector("#s-desktop-notify").checked);
  overlay.querySelector("#s-desktop-notify").addEventListener("change", syncKinds);
  syncKinds();
  const saveQuiet = () => setQuietHours({
    on: overlay.querySelector("#s-quiet-on").checked,
    from: overlay.querySelector("#s-quiet-from").value || "23:00",
    to: overlay.querySelector("#s-quiet-to").value || "09:00",
  });
  ["#s-quiet-on", "#s-quiet-from", "#s-quiet-to"].forEach(sel => overlay.querySelector(sel).addEventListener("change", saveQuiet));
  overlay.querySelector("#s-pause").addEventListener("click", async () => {
    const p = await fetchPerson(state.telegramId);
    if (p) openPauseDialog(p, () => {});
    else toast("Не удалось загрузить ваш профиль.", "error");
  });

  // Поведение
  overlay.querySelectorAll("[data-st-start]").forEach(b => b.addEventListener("click", () => {
    pick("data-st-start", null, b.dataset.stStart);
    setStartTab(b.dataset.stStart);
  }));

  // Диагностика: связь с сервером и отчёт для разработчика.
  let lastPing = null;
  const ping = async () => {
    const el = overlay.querySelector("#s-ping");
    el.className = "st-ping";
    el.textContent = "проверяю…";
    const t0 = window.performance.now();
    try {
      await apiGet("/whoami");
      lastPing = Math.round(window.performance.now() - t0);
      el.textContent = `в сети · ${lastPing} мс`;
      el.classList.add(lastPing > 1500 ? "slow" : "ok");
    } catch (e) {
      lastPing = null;
      el.textContent = `нет связи: ${e.message}`;
      el.classList.add("bad");
    }
  };
  ping();
  overlay.querySelector("#s-ping-again").addEventListener("click", ping);
  overlay.querySelector("#s-copy-report").addEventListener("click", async () => {
    const lines = [
      `Project Desktop ${APP_VERSION}`,
      `Канал: ${overlay.querySelector("#s-update-channel").value}`,
      `Система: ${navigator.userAgent}`,
      `Экран: ${window.screen.width}×${window.screen.height} @${window.devicePixelRatio}`,
      `Сервер: ${API_BASE} · ${lastPing == null ? "нет связи" : `${lastPing} мс`}`,
      `Роль: ${state.isAdmin ? "админ" : "участник"} · вкладка: ${state.activeTab}`,
      `Тема: ${document.documentElement.dataset.theme}/${document.documentElement.dataset.look} · масштаб ${currentScale()}%`,
      `Время: ${new Date().toISOString()}`,
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast("Отчёт скопирован — вставьте его в сообщение разработчику.");
    } catch (e) {
      toast(`Не удалось скопировать: ${e.message}`, "error");
    }
  });
}
$("#open-settings").addEventListener("click", openSettings);

// ---------- автообновление (Velopack) ----------
// Апдейтер целиком на Rust-стороне (см. check_for_update/
// download_and_apply_update в main.rs, Velopack + GithubSource читает
// релизы репозитория напрямую, без прокси на своём сервере). JS только
// вызывает команды и слушает событие "update-progress" для прогресс-бара.

// Автопроверка на каждом запуске (см. main.js) без троттлинга уходила в
// GitHub API без токена (60 запросов/час НА IP, не на пользователя — см.
// friendly_update_error в main.rs) при каждом старте приложения. На одном
// рабочем месте это несущественно, но студия — несколько компьютеров за
// одним офисным NAT, и совокупный поток запусков/перезапусков легко
// выбивает лимит даже без единого ручного клика «Проверить обновления».
// Ручная проверка из Настроек троттлингу не подчиняется — явный клик
// пользователя должен сходить на сервер всегда, даже если автопроверка
// была недавно.
const AUTO_CHECK_THROTTLE_MS = 4 * 60 * 60 * 1000; // 4 часа
const AUTO_CHECK_STORAGE_KEY = "project_last_update_check_at";

export function maybeAutoCheckUpdates() {
  let last = 0;
  try {
    last = Number(localStorage.getItem(AUTO_CHECK_STORAGE_KEY) || 0);
  } catch {
    // localStorage недоступен (приватный режим и т.п.) — считаем, что
    // проверять можно, лучше лишний запрос, чем никогда не проверять.
  }
  if (Date.now() - last < AUTO_CHECK_THROTTLE_MS) return;
  try {
    localStorage.setItem(AUTO_CHECK_STORAGE_KEY, String(Date.now()));
  } catch {
    // не критично — просто не притормозит следующий запуск
  }
  checkForUpdates(true);
}

export async function checkForUpdates(silent) {
  try {
    const update = await invoke("check_for_update");
    if (!update) {
      if (!silent) toast("У вас уже последняя версия.");
      return;
    }
    const yes = await confirmUpdateSheet(update);
    if (!yes) return;
    await installUpdate();
  } catch (e) {
    // Тихую автопроверку при старте (silent=true) пользователь никогда
    // не видит тостом — раньше падение здесь (тот самый 403 на общем IP
    // студии) не оставляло вообще никакого следа. error-тост ниже уже
    // сам логируется через toast() (см. api.js), поэтому явный вызов
    // нужен именно на silent-ветке.
    if (!silent) toast(`Не удалось проверить обновления: ${e}`, "error");
    else updateLog.error(`тихая автопроверка при старте не удалась: ${e}`);
  }
}

function confirmUpdateSheet(update) {
  return new Promise(resolve => {
    const overlay = openSheet(`
      <h2>Доступно обновление ${esc(update.version)}</h2>
      <div style="color:var(--ink-soft); font-size:13px; white-space:pre-wrap; max-height:200px; overflow:auto; margin-bottom:6px;">${esc(update.notes || "Без описания изменений.")}</div>
      <div class="sheet-actions">
        <button class="btn ghost" data-no>Позже</button>
        <button class="btn primary" data-yes>Обновить и перезапустить</button>
      </div>
    `);
    overlay.querySelector("[data-no]").addEventListener("click", () => { overlay.remove(); resolve(false); });
    overlay.querySelector("[data-yes]").addEventListener("click", () => { overlay.remove(); resolve(true); });
    // Закрытие клавишей Escape или кликом по фону — тоже ответ «позже».
    // Раньше Escape просто удалял оверлей из DOM, промис не резолвился
    // никогда, и checkForUpdates() оставался висеть на await до конца
    // жизни процесса.
    overlay.addEventListener("sheet-dismissed", () => resolve(false));
  });
}

async function installUpdate() {
  const overlay = openSheet(`
    <h2>Устанавливаю обновление…</h2>
    <div class="update-progress-track"><div class="update-progress-fill" id="upd-fill"></div></div>
    <div id="upd-status" style="color:var(--ink-soft); font-size:12.5px;">Скачивание…</div>
  `);
  const fill = overlay.querySelector("#upd-fill");
  const statusEl = overlay.querySelector("#upd-status");
  const unlisten = await listen("update-progress", event => {
    const pct = Math.max(0, Math.min(100, event.payload));
    fill.style.width = pct + "%";
    statusEl.textContent = pct < 100 ? `Скачано ${pct}%` : "Устанавливаю…";
  });
  try {
    // При успехе download_and_apply_update завершает процесс изнутри
    // (apply_updates_and_restart) — этот await просто никогда не
    // вернётся управлением дальше в обычном сценарии, окно закроется
    // само. Ветка catch — только на случай реальной ошибки.
    await invoke("download_and_apply_update");
  } catch (e) {
    unlisten();
    statusEl.textContent = `Ошибка: ${e}`;
    statusEl.style.color = "var(--s-stop)";
  }
}
