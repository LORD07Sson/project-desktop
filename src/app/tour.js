// Обучение: приветствие для новичка, подробные уроки по каждому разделу
// и подсказка «Впервые здесь?» при первом входе в раздел.
//
// Урок — это шаги: подсвечиваем элемент интерфейса (всё вокруг
// затемнено), рядом карточка с объяснением. Если элемента нет (раздел
// пуст, роль не та) — карточка встаёт по центру, без подсветки.
// Прогресс личный для каждого аккаунта и хранится в localStorage:
// пройденные уроки, отказ от приветствия, отключённые подсказки.
//
// Настройки → «Обучение» (settings.js) — список всех уроков, повтор
// любого из них и сброс.

import { state } from "./state.js";
import { esc } from "./utils.js";
import { dismissSheet } from "./api.js";
import { openWatchMode, closeWatchMode } from "./watch.js";
import mascotGif from "../assets/ayaya-club-ayaya.gif";

// ---------- память ----------
const memKey = () => `project_tour_${state.telegramId || "anon"}`;
function readMem() {
  try { return { done: {}, seen: {}, hints: true, ...JSON.parse(localStorage.getItem(memKey()) || "{}") }; } catch (_) { return { done: {}, seen: {}, hints: true }; }
}
function writeMem(patch) {
  const m = { ...readMem(), ...patch };
  try { localStorage.setItem(memKey(), JSON.stringify(m)); } catch (_) { /* не критично */ }
  return m;
}
function markDone(id) { const m = readMem(); writeMem({ done: { ...m.done, [id]: Date.now() }, seen: { ...m.seen, [id]: 1 } }); }
function markSeen(id) { const m = readMem(); writeMem({ seen: { ...m.seen, [id]: 1 } }); }
export function tourHintsEnabled() { return readMem().hints !== false; }
export function setTourHints(on) { writeMem({ hints: !!on }); }
export function resetTourProgress() {
  try { localStorage.removeItem(memKey()); } catch (_) { /* не критично */ }
}

// ---------- помощники для шагов ----------
const wait = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(sel, timeout = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const el = document.querySelector(sel);
    if (el && isVisible(el)) return el;
    await wait(80);
  }
  return null;
}
function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none";
}
async function goTab(name) {
  const btn = document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if (!btn || !isVisible(btn)) return;
  if (!btn.classList.contains("active")) btn.click();
  await waitFor(`.tab-panel[data-panel="${name}"].active`);
  await wait(450); // данные вкладки догружаются
}
function closeOverlayWith(sel) {
  document.querySelectorAll(".overlay").forEach(o => { if (o.querySelector(sel)) dismissSheet(o); });
}
async function openSettingsSheet() {
  if (!document.querySelector(".st-sheet")) document.querySelector("#open-settings")?.click();
  await waitFor(".st-sheet");
}
async function settingsGo(id) {
  document.querySelector(`[data-st-go="${id}"]`)?.click();
  await wait(380);
}
async function openAnyReport() {
  if (document.querySelector(".overlay .rd-tabs")) return;
  if (state.isAdmin) {
    await goTab("list");
    const row = await waitFor("#reports-body tr[data-id], #reports-body tr");
    row?.click();
  } else {
    await goTab("profile");
    const card = await waitFor("#profile-body [data-open]", 1500);
    card?.click();
  }
  await waitFor(".overlay .rd-tabs", 3000);
}
const kbd = k => `<kbd>${k}</kbd>`;
// Блок по его заголовку: порядок секций в карточке зависит от данных,
// а nth-of-type считает и чужие div — надёжнее искать по тексту.
const byHead = (sel, word) => () => [...document.querySelectorAll(sel)]
  .find(n => (n.textContent || "").trim().toLowerCase().startsWith(word.toLowerCase()));

// ---------- уроки ----------
// Шаг: { el: селектор | [селекторы — первый видимый], union: [селекторы —
// подсветить их общую рамку], title, text: строка | (роль) => строка,
// admin: только админам, member: только участникам, before: async () => {} }
const TOURS = [
  {
    id: "intro", name: "Знакомство с приложением", icon: "👋", about: "Где что лежит: меню, разделы и кнопки в шапке",
    steps: [
      {
        title: "Добро пожаловать в Project Desktop",
        text: `Это рабочее место команды: серии и сроки, общение команды, тайтлы сезона и инструменты для звука — всё в одном окне.
          <p>Пробегусь по главному. Листать — ${kbd("→")} или ${kbd("Enter")}, назад — ${kbd("←")}, выйти — ${kbd("Esc")}. Любой урок потом можно повторить: <b>Настройки → Обучение</b>.</p>`,
      },
      {
        el: ".sidebar", title: "Боковое меню",
        text: r => r.admin
          ? `Все разделы приложения. <b>Основное</b> — работа с сериями: Обзор, Список и Доска. <b>Команда</b> — тайтлы, календарь, общение, лента, аналитика, сервисы и команда. В самом низу — <b>«Я»</b>, ваш профиль.
             <p>Переключаться можно и с клавиатуры: ${kbd("Ctrl")} + ${kbd("1")}…${kbd("6")}. Приложение запоминает последний открытый раздел.</p>`
          : `Ваши разделы: <b>Тайтлы</b> (голосование за сезон), <b>Сообщения</b>, <b>Команда</b> и <b>«Я»</b> — ваш профиль с вашими сериями.
             <p>Приложение запоминает последний открытый раздел и в следующий раз откроет его же.</p>`,
      },
      { el: '.tab-btn[data-tab="queue"]', title: "Моя очередь", text: "Только ваши серии: что горит (просрочено, сегодня, завтра), что на неделе и что позже — с обратным отсчётом до срока. Цифра на кнопке — сколько горит прямо сейчас." },
      { el: '.tab-btn[data-tab="overview"]', admin: true, title: "Обзор", text: "Сводка команды на одном экране: сколько серий в работе, что просрочено, что застряло без движения, свежая активность и дни рождения. Хорошее место, чтобы начать день." },
      { el: '.tab-btn[data-tab="list"]', admin: true, title: "Список", text: "Все отчёты (серии) таблицей: поиск, фильтры по статусу, приоритету, исполнителю, сезону и тайтлу, сохранённые фильтры и массовые операции сразу над многими сериями." },
      { union: ['.tab-btn[data-tab="board"]', "#sidebar-board-sub"], admin: true, title: "Доска", text: "Канбан: серии разложены по колонкам статусов, карточку можно перетащить мышью в другую колонку. Под кнопкой — счётчики по статусам, клик по строке сразу открывает Доску." },
      { el: '.tab-btn[data-tab="titles"]', title: "Тайтлы", text: "Голосование за тайтлы эфир-сезона: какие аниме команда берёт в работу. Ставьте 👍 или 👎 — лидер голосования показан крупно. «Подробнее» открывает страницу тайтла с кадрами, персонажами и эпизодами." },
      { el: '.tab-btn[data-tab="calendar"]', admin: true, title: "Календарь", text: "Неделя команды: выход серий онгоингов по вашему времени, дедлайны отчётов, дни рождения команды и ваши личные напоминания." },
      { el: '.tab-btn[data-tab="messages"]', title: "Сообщения", text: "Общий чат команды, каналы по тайтлам и личные переписки. Напишите <b>@имя</b> — человеку придёт уведомление. Красная цифра на кнопке — непрочитанное." },
      { el: '.tab-btn[data-tab="feed"]', admin: true, title: "Лента", text: "Журнал всех изменений в отчётах: кто сменил статус, назначил исполнителя, прикрепил файл или оставил заметку — и откуда (приложение, мини-апп, бот)." },
      { union: ['.tab-btn[data-tab="analytics"]', '.tab-btn[data-tab="services"]'], admin: true, title: "Аналитика и Сервисы", text: "<b>Аналитика</b> — скорость команды за 30 дней: сколько закрыто, среднее время серии, доля сданных вовремя, топ исполнителей. <b>Сервисы</b> — здоровье бота и серверов, аптайм и последние ошибки." },
      { el: '.tab-btn[data-tab="team"]', title: "Команда", text: "Кто в команде, кто сейчас в сети, у кого серия на руках, а кто свободен или на паузе. Фильтры по ролям и поиск по имени; из карточки человека можно сразу написать ему." },
      { el: '.tab-btn[data-tab="profile"]', title: "«Я» — ваш профиль", text: "Ваши серии на руках и сроки, статистика, достижения, цель месяца, напоминания и пауза уведомлений (например, на время отпуска)." },
      { el: "#titlebar-team", title: "Кто в сети", text: "Аватарки коллег, которые сейчас онлайн. Клик — открыть раздел «Команда»." },
      { el: ".ib-wrap", title: "Уведомления", text: "Колокольчик собирает всё, что касается вас: назначения на серии, упоминания, смены статусов по вашим отчётам. Цифра — сколько непрочитанных; внутри есть фильтры и «Прочитать все»." },
      { el: "#open-watch", title: "Смотреть", text: "Отдельный режим для просмотра аниме: онгоинги и анонсы сезона, расписание выхода серий, тайтлы команды и встроенный плеер с озвучками. Подробно — в уроке «Смотреть и плеер»." },
      { el: "#open-cmdk", title: "Поиск и команды", text: `Найти серию, тайтл или человека и выполнить любое действие — с клавиатуры. То же самое — ${kbd("Ctrl")} + ${kbd("K")} из любого места.` },
      { el: "#tools-btn", title: "Инструменты", text: "Всё рабочее в одном меню: <b>QC звука</b> (клиппинг, тишина, громкость с тайм-кодами), <b>инструменты ffmpeg</b> (обрезка, конвертация, сведение дубляжа, субтитры), <b>Обновить</b>, горячие клавиши и <b>настройки</b> — там же раздел «Обучение» со всеми уроками." },
      { el: "#theme-toggle", title: "Тема", text: "Светлая или тёмная тема." },
      { el: "#me-btn", title: "Профиль", text: "Ваш аватар: «Мой профиль» и «Выйти» из аккаунта на этом компьютере." },
      { el: "#win-close", title: "Крестик сворачивает в трей", text: `Окно не закрывается, а уходит в трей и продолжает следить за назначениями. Вернуть его из любой программы — ${kbd("Ctrl")} + ${kbd("Shift")} + ${kbd("P")}.` },
      {
        title: "Готово! 🎉",
        text: `Основное вы знаете. Когда впервые зайдёте в раздел, я предложу подробный разбор именно его — можно согласиться или пропустить.
          <p>Совет: ${kbd("Ctrl")} + ${kbd("K")} — поиск по отчётам, тайтлам и людям из любого места.</p>`,
      },
    ],
  },

  {
    id: "overview", tab: "overview", admin: true, name: "Обзор", icon: "🧭", about: "Главные цифры, внимание, активность",
    steps: [
      { el: ".an-metrics", title: "Главные цифры", text: "<b>Активные серии</b> — сколько сейчас в работе по всей команде и как изменилось. <b>В работе</b> — сколько на озвучке и перезаписи. <b>Завершено</b> — за всё время. <b>Просрочено</b> — с отдельным счётчиком важных (высокий и срочный приоритет)." },
      { el: ".dash-main-row", title: "Темп и то, что требует внимания", text: "График «Создано и завершено» за 14 дней показывает, успевает ли команда: если создаётся больше, чем закрывается, очередь растёт. <b>Требует внимания</b> — серии без движения и просрочки, клик открывает карточку. <b>Недавняя активность</b> — последние действия команды, «вся лента» ведёт в Ленту." },
      { el: ".dash-secondary", title: "Подробности", text: "Структура загрузки по статусам, топ исполнителей и рейтинг месяца, заявки на доступ, открытые тикеты поддержки, ближайшие дни рождения и мини-доска со сроками. Карточки серий здесь тоже кликабельны." },
    ],
  },

  {
    id: "list", tab: "list", admin: true, name: "Список", icon: "📋", about: "Поиск, фильтры, быстрые и массовые действия",
    steps: [
      { el: "#search-input", title: "Поиск", text: `Ищет по номеру отчёта, названию тайтла и исполнителю — прямо пока печатаете. Из любого места «Списка» — ${kbd("Ctrl")} + ${kbd("F")}.` },
      { union: ["#status-filter", "#title-filter"], title: "Фильтры", text: "Статус, приоритет, исполнитель, сезон и тайтл. Тайтл становится доступен после выбора сезона. Фильтры складываются: например, «Срочный» + «Фрирен 2»." },
      { el: "#quick-filters", title: "Быстрые фильтры", text: "<b>Мои</b> — серии на вас, <b>Просрочено</b>, <b>Без исполнителя</b> и <b>★ Избранное</b>. «+ Сохранить фильтр» запоминает текущую комбинацию под именем — она появится тут же чипом, удалить — крестиком на чипе." },
      { el: ".content table thead", title: "Таблица", text: "Серия, статус, этап пайплайна, срок и исполнители. Клик по заголовку столбца — сортировка. 🔥 — срочность, «застряло» — статус не менялся 3+ дня, ☆ — добавить в избранное (оно хранится только у вас)." },
      { el: ["#reports-body tr:first-child .col-actions", "#reports-body tr:first-child td:last-child"], title: "Быстрые действия", text: "👤 — назначить исполнителя, ✓ — сменить статус, не открывая карточку. Правый клик по строке — меню быстрых действий. Клик по строке — полная карточка отчёта." },
      { el: ".col-check", title: "Массовые операции", text: `Отметьте галочками несколько серий (с ${kbd("Shift")} — сразу диапазон), внизу появится панель: сменить статус или назначить исполнителя всем выбранным разом.` },
      { el: "#statusbar", title: "Строка состояния", text: "Сколько отчётов сейчас в выборке и короткая шпаргалка по действиям." },
    ],
  },

  {
    id: "board", tab: "board", admin: true, name: "Доска", icon: "🗂", about: "Канбан, перетаскивание, таймлайн сроков",
    steps: [
      { el: ".board-stats-row", title: "Счётчики колонок", text: "Сколько серий в черновиках, на озвучке, в работе и завершено." },
      { el: "#board-body .page-header-actions", title: "Сроки, импорт и новый проект", text: "<b>Срок: месяц</b> — показать только серии со сроком в выбранном месяце. <b>Импорт</b> — создать отчёт из файла (дорожки, видео, документа). <b>Добавить проект</b> — новый тайтл или серии с исполнителями и сроком." },
      { el: ".board-timeline-cell", title: "Таймлайн", text: "Сроки активных серий на шкале времени: видно, что горит на этой неделе и какие серии идут внахлёст." },
      { el: ".board-performance-cell", title: "Производительность", text: "Распределение серий по колонкам — где скапливается очередь." },
      { el: ".board-toolbar", title: "Поиск и порядок", text: "Поиск по доске, фильтр по сезону и тайтлу и порядок карточек: по срочности, сроку, приоритету, давности или как на сервере." },
      { el: ".board", title: "Колонки и карточки", text: "Каждая колонка — статус. <b>Перетащите карточку мышью</b> в другую колонку — статус сменится. «‹» сворачивает колонку. На карточке: номер, приоритет, срок, прогресс пайплайна, исполнители, 📎 файлы и 💬 заметки. Клик — открыть карточку отчёта." },
    ],
  },

  {
    id: "report", name: "Карточка отчёта", icon: "🎙", about: "Статусы, пайплайн, чек-лист, заметки, файлы",
    setup: openAnyReport,
    cleanup: () => closeOverlayWith(".rd-tabs"),
    steps: [
      { el: ".overlay .rd-titles", title: "Карточка серии", text: "Всё о серии в одном окне: тайтл, номер, приоритет. Открывается кликом по серии где угодно — в Списке, на Доске, в Календаре, Ленте и Обзоре." },
      { el: ".overlay .rd-steps", title: "Статус одним кликом", text: "Путь серии: Черновик → Озвучка → В работе → Готово. Нажмите нужный шаг, чтобы перевести серию. «↺ На перезапись» — вернуть на перезапись или дозапись, если что-то не так." },
      { el: ".overlay .rd-tabs", title: "Вкладки карточки", text: "<b>Обзор</b> — работа над серией. <b>История</b> — все изменения. <b>Активность</b> — кто и когда что делал. <b>QC дорожки</b> — проверка звука прикреплённых файлов прямо отсюда." },
      { el: byHead(".overlay .rd-sec", "пайплайн"), title: "Пайплайн", text: "Этапы производства серии (перевод, тайминг, озвучка, сведение…), у каждого свой исполнитель. «Сейчас» — текущий этап; выберите, кому он переходит, и нажмите «Передать дальше» — следующий человек получит уведомление, прогресс серии посчитается сам." },
      { el: byHead(".overlay .rd-sec", "чек-лист"), title: "Чек-лист", text: "Мелкие дела по серии: «сверить имена персонажей», «проверить надписи». Добавляйте пункты и отмечайте готовые." },
      { el: byHead(".overlay .rd-sec", "заметки"), title: "Заметки", text: "Комментарии к серии — можно с тайм-кодом («перезаписать реплику на 12:34») и картинкой: вставьте скриншот через Ctrl+V." },
      { el: byHead(".overlay .rd-sec", "файлы"), title: "Файлы", text: "Дорожки, субтитры, видео. Перетащите файл прямо на окно — он прикрепится к открытой серии. Аудио можно прослушать и проверить QC, любой файл — скачать." },
      { el: ".overlay .rd-meta", title: "Исполнители, срок, приоритет", text: "Кто работает над серией (несколько человек — галочками; им же уходят уведомления), срок сдачи, приоритет и текущий статус." },
      { el: ".overlay .detail-head-actions", title: "Фокус-режим", text: `Карточка на весь экран, всё остальное прячется — ${kbd("Ctrl")} + ${kbd("Shift")} + ${kbd("F")}. Включить по умолчанию можно в настройках. ${kbd("Alt")} + ${kbd("←")}/${kbd("→")} — предыдущая и следующая серия в списке.` },
      { el: ".overlay .rd-side-foot", title: "Открепить в окне", text: "Откроет серию в маленьком отдельном окне поверх других программ — удобно держать перед глазами во время записи." },
    ],
  },

  {
    id: "titles", tab: "titles", name: "Тайтлы", icon: "🎬", about: "Голосование за сезон и страница тайтла",
    steps: [
      { el: '[data-panel="titles"] .seg-toggle', title: "Карточки или таблица", text: "Два вида одного списка: крупные карточки с обложками или компактная таблица." },
      { el: "#titles-admin-btn", admin: true, title: "Управление", text: "Эфир-сезоны и тайтлы в них: добавить сезон, набрать тайтлы, убрать лишние. То, что вы здесь добавите, появится в голосовании у всей команды." },
      { el: '[data-panel="titles"] .chip-row', title: "Сезоны", text: "Переключение между эфир-сезонами — текущим и прошлыми." },
      { el: ".tl-hero", title: "Лидер голосования", text: "Тайтл, который команда хочет больше всего: описание, процент одобрения, сколько вышло серий и статус. <b>«Нравится»</b> — ваш голос. <b>«Подробнее»</b> — страница тайтла: кадры, жанры, студия, персонажи, список эпизодов." },
      { el: ".vote-grid", title: "Все тайтлы сезона", text: "Голосуйте 👍 или 👎 за каждый — голос можно поменять в любой момент. «В тренде» — что набирает голоса быстрее всего. Наведите на обложку — появится краткая карточка тайтла." },
    ],
  },

  {
    id: "calendar", tab: "calendar", admin: true, name: "Календарь", icon: "📅", about: "Выход серий, дедлайны, дни рождения, напоминания",
    steps: [
      { el: ".cal-layers", title: "Слои", text: "Включайте и выключайте, что показывать: <b>Серии</b> (выход онгоингов), <b>Дедлайны</b> отчётов, <b>Дни рождения</b> команды и <b>Мои напоминания</b>." },
      { el: ".cal-toolbar", title: "Неделя", text: "Стрелки — прошлая и следующая неделя, «Сегодня» — вернуться к текущей." },
      { el: "#cal-body", title: "Сетка недели", text: "Сверху, в строке «Весь день», — дедлайны и дни рождения; ниже по часам — выход серий в вашем часовом поясе. Клик по дедлайну открывает карточку отчёта, по дню рождения или напоминанию — их список, где можно добавить новое." },
    ],
  },

  {
    id: "messages", tab: "messages", name: "Сообщения", icon: "💬", about: "Общий чат, каналы, личка, упоминания",
    steps: [
      { el: "#ms-new", title: "Новый диалог", text: "Начать личную переписку с любым коллегой." },
      { union: [".ms-search", ".ms-filters"], title: "Поиск и фильтры", text: "Поиск по чатам и фильтры: <b>Все</b>, <b>Непрочитанные</b> и <b>Упоминания</b> — где вас позвали через @." },
      { el: "#ms-list", title: "Чаты", text: "Сверху — <b>Общий чат команды</b>. Дальше <b>каналы</b> (обычно по тайтлам, внутри бывают темы) и <b>личные</b> переписки. Цифра — непрочитанные, значок @ — вас упомянули." },
      { el: ".ms-head", title: "Кто в чате", text: "Название чата и его участники." },
      { el: "#ms-msgs", title: "Переписка", text: "Сообщения по дням. Наведите на сообщение, чтобы увидеть действия с ним." },
      { el: ".ms-compose", title: "Написать", text: `${kbd("Enter")} — отправить, ${kbd("Shift")} + ${kbd("Enter")} — новая строка. <b>@имя</b> — упомянуть, человеку придёт уведомление. Картинку можно прикрепить или вставить скриншот через ${kbd("Ctrl")} + ${kbd("V")}.` },
    ],
  },

  {
    id: "feed", tab: "feed", admin: true, name: "Лента", icon: "🕘", about: "Все изменения в отчётах",
    steps: [
      { el: ".fd-filters", title: "Фильтры", text: "Все события или только нужные: <b>Статусы</b>, <b>Назначения</b>, <b>Файлы и заметки</b>, <b>Мои</b> и <b>Администрирование</b> (удаления, доступы)." },
      { el: ".fd-summary", title: "Итоги дня", text: "Сколько событий сегодня, смен статуса и назначений, и кто был в деле." },
      { el: "#fd-list", title: "События", text: "По дням: кто, что сделал, с какой серией и откуда — desktop, mini-app или бот. Клик по событию открывает карточку отчёта." },
    ],
  },

  {
    id: "analytics", tab: "analytics", admin: true, name: "Аналитика", icon: "📈", about: "Скорость команды за 30 дней",
    steps: [
      { el: "#analytics-body .an-metrics", title: "Показатели за 30 дней", text: "Сколько серий завершено (и изменение к прошлым 30 дням), среднее время от создания до готовности, сколько просрочено сейчас и какая доля сдана вовремя." },
      { el: "#analytics-body .an-bottom", title: "Загрузка и лидеры", text: "Сколько серий в каждой колонке доски и топ исполнителей по закрытым отчётам за месяц." },
    ],
  },

  {
    id: "services", tab: "services", admin: true, name: "Сервисы", icon: "🖥", about: "Бот, сервер, аптайм, ошибки",
    steps: [
      { el: "#services-body .an-metrics", title: "Состояние", text: "Сколько сервисов работает, есть ли проблемы, средний аптайм и инциденты за 30 дней. Значок справа сверху — общий итог." },
      { el: "#services-body .svc-bottom-row", title: "Сервисы и инциденты", text: "Статус каждого процесса, аптайм по дням и последние инциденты." },
      { el: "#bot-status-slot", title: "Бот изнутри", text: "То же, что команда /status в боте: сколько бот и мини-апп работают без перезапуска, отклик Telegram, база, люди, отчёты, тикеты и последние ошибки из лога." },
    ],
  },

  {
    id: "team", tab: "team", name: "Команда", icon: "👥", about: "Кто в сети, кто занят, роли",
    steps: [
      { el: ".tm-stats", title: "Команда в цифрах", text: "Сколько всего человек, кто в сети, у кого серия на руках, кто свободен и кто на паузе (отпуск). Клик по цифре — показать только их." },
      { el: ".tm-bar", title: "Фильтры и поиск", text: "Быстрые фильтры и поиск по имени." },
      { el: "#team-roles-btn", admin: true, title: "Роли", text: "Роли в пайплайне (даббер, звукорежиссёр, переводчик, тайпсеттер…) — создать роль и назначить людей." },
      { el: "#tm-groups", title: "Люди", text: "Карточки по ролям: что сейчас на руках, сколько серий сейчас и за месяц, статус «в сети», пауза. Клик по человеку — его профиль; оттуда можно написать ему в «Сообщения»." },
    ],
  },

  {
    id: "profile", tab: "profile", name: "«Я» — профиль", icon: "🙂", about: "Ваши серии, достижения, цель, уведомления",
    steps: [
      { el: ".pf-hero", title: "Это вы", text: "Имя, роль, сколько вы в команде и статус. «Изменить» — поставить статус и написать о себе: это увидят коллеги в «Команде»." },
      { el: ".pf-kpis", title: "Ваши цифры", text: "Сколько серий на вас сейчас (и сколько просрочено), сколько закрыто за неделю и месяц, доля сданных вовремя и средний срок." },
      { el: byHead(".pf-main .pf-card", "моя работа"), title: "Моя работа", text: "Ваши серии по статусам со сроками. Клик — открыть карточку серии." },
      { el: byHead(".pf-main .pf-card", "достижения"), title: "Достижения", text: "Награды за работу: первый отчёт, ноль просрочек, лучший за неделю и другие — с прогрессом до следующей." },
      { el: "#goal-card", title: "Цель месяца", text: "Поставьте себе план на месяц — здесь будет видно, сколько осталось." },
      { el: ".pf-notif", title: "Напоминания и пауза", text: "<b>Напоминания и сроки</b> — личные напоминалки («скинуть дорожки на сведение»). <b>Пауза уведомлений</b> — на время отпуска бот не будет напоминать о сроках." },
    ],
  },

  {
    id: "watch", name: "Смотреть и плеер", icon: "▶️", about: "Каталог сезона, расписание, плеер с озвучками",
    setup: async () => { openWatchMode(); await waitFor("#wm-hero", 4000); await wait(500); },
    cleanup: () => closeWatchMode(),
    steps: [
      { el: ".wm-tabs", title: "Разделы", text: "<b>Главная</b> — подборки сезона. <b>Расписание</b> — когда выходят серии онгоингов. <b>Мой список</b> — тайтлы, которые вы отложили. <b>Наша озвучка</b> — что озвучивает наша команда." },
      { union: [".wm-search", ".wm-lucky"], title: "Поиск и «Мне повезёт»", text: `Поиск по названию — клавиша ${kbd("/")}. «🎲 Мне повезёт» — случайный хороший тайтл, если не знаете, что посмотреть.` },
      { el: "#wm-hero", title: "Баннер", text: "Лучшие тайтлы сезона с кадрами из серий. <b>Смотреть</b> — сразу в плеер, <b>Подробнее</b> — описание, <b>В список</b> — отложить на потом." },
      { el: ".wm-rail", title: "Переключение баннера", text: "Миниатюры — перейти к другому тайтлу баннера. Он и сам листается." },
      { el: ".wm-rows .wm-row", title: "Подборки", text: "«Продолжить просмотр» — с того места, где остановились (появится после первого просмотра), «Топ-10 сезона», «Расписание», «По настроению», «В тренде», онгоинги и анонсы." },
      { el: ".wm-moods", title: "Настроение", text: "Отфильтровать подборки по жанру: экшен, фэнтези, комедия, романтика и другие." },
      {
        title: "Плеер",
        text: `Нажмите «Смотреть» на любом тайтле. Справа — <b>«Серии и озвучка»</b>: выбор серии и озвучки. Шестерёнка — качество и скорость. Плеер помнит серию, озвучку, громкость и место, где вы остановились.
          <p>${kbd("Пробел")} пауза · ${kbd("←")}/${kbd("→")} ±10 с · ${kbd("↑")}/${kbd("↓")} громкость · ${kbd("F")} весь экран · ${kbd("M")} звук · ${kbd("N")} следующая серия · ${kbd("S")} пропустить опенинг · ${kbd("Esc")} выйти</p>`,
      },
    ],
  },

  {
    id: "qc", name: "QC звука", icon: "🎧", about: "Проверка дорожек на клиппинг, тишину и громкость",
    steps: [
      { el: "#tools-btn", title: "Как запустить", text: "«Инструменты» → «QC звука» и выберите файлы: wav, mp3, flac, m4a, aac, ogg или видео mp4/mkv/mov. Можно сразу пачку — до 40 штук. Ещё проще — перетащить файл на окно, когда карточка отчёта закрыта." },
      { el: "#tools-btn", title: "Что проверяется", text: "<b>Клиппинг</b> — перегруз, звук «трещит». <b>Пауза</b> — провал тишины посреди дорожки. <b>Тихо</b> и <b>Громко</b> — куски, выбивающиеся по громкости. Каждая находка с тайм-кодом и важностью." },
      { el: "#tools-btn", title: "Что дальше с находками", text: "Рядом с находкой — кнопка ✂: вырезать этот фрагмент в отдельный файл и отправить на перезапись. Для нескольких файлов — сводная таблица, строку можно раскрыть. Внутри карточки отчёта есть вкладка «QC дорожки» — проверка прикреплённых файлов без поиска по папкам." },
    ],
  },

  {
    id: "ffmpeg", name: "Инструменты ffmpeg", icon: "🛠", about: "Обрезка, конвертация, звук, дубляж, склейка",
    setup: async () => { if (!document.querySelector(".mt-sheet")) document.querySelector("#open-media-tools")?.click(); await waitFor(".mt-sheet"); },
    cleanup: () => { const o = document.querySelector(".mt-sheet")?.closest(".overlay"); o?.querySelector("[data-close]")?.click(); },
    steps: [
      { el: "#mt-pool-bar-mount", title: "Файлы — один раз", text: "Добавьте видео, аудио и субтитры сюда — дальше любая операция берёт их из этого списка. Не нужно выбирать один и тот же файл заново на каждой вкладке." },
      { el: ".mt-op-tabs", title: "Операции", text: "Каждая вкладка — отдельная операция с обычной формой. Пройдёмся по всем." },
      { el: '.mt-op-tab[data-op="cut"]', title: "Обрезка", text: "Вырезать кусок без перекодирования — быстро и без потери качества. Видео открывается в плеере, отметьте начало и конец." },
      { el: '.mt-op-tab[data-op="convert"]', title: "Конвертация", text: "Готовые варианты: универсальный MP4, сжать для Telegram (720p), WebM, ProRes для монтажа — или свои параметры." },
      { el: '.mt-op-tab[data-op="audio"]', title: "Аудио", text: "Вытащить звук из видео и выровнять громкость (нормализация)." },
      { el: '.mt-op-tab[data-op="dub"]', title: "Дубляж", text: "Свести видео с вашей дорожкой озвучки." },
      { el: '.mt-op-tab[data-op="speed"]', title: "Скорость", text: "Ускорить или замедлить видео и звук." },
      { el: '.mt-op-tab[data-op="frames"]', title: "Кадры", text: "Сохранить кадры из видео картинками." },
      { el: '.mt-op-tab[data-op="subs"]', title: "Субтитры", text: "Работа с субтитрами: srt, ass, vtt." },
      { union: ['.mt-op-tab[data-op="concat"]', '.mt-op-tab[data-op="mux"]'], title: "Склейка и муксинг", text: "<b>Склейка</b> — соединить несколько файлов в один. <b>Муксинг</b> — собрать в один контейнер видео, несколько звуковых дорожек и субтитры с языками." },
      { el: "#mt-body", title: "Форма операции", text: "Выберите файлы из списка, настройте параметры и запустите. Пока операция идёт, виден прогресс; по окончании — кнопка «Показать в папке»." },
    ],
  },

  {
    id: "topbar", name: "Уведомления и горячие клавиши", icon: "⌨️", about: "Колокольчик, поиск Ctrl+K, трей",
    steps: [
      { el: ".ib-wrap", title: "Уведомления", text: "Назначения, упоминания и изменения по вашим отчётам. Внутри — фильтры по типу и «Прочитать все». Если окно свёрнуто или в трее, важное придёт уведомлением Windows (включается в настройках)." },
      { el: "#me-btn", title: "Ваш аккаунт", text: "Аватар справа в шапке: «Мой профиль» и «Выйти» — выйти из аккаунта на этом компьютере." },
      {
        title: "Горячие клавиши",
        text: `<p>${kbd("Ctrl")} + ${kbd("K")} — поиск и команды: перейти в раздел, найти отчёт, тайтл или человека.</p>
          <p>${kbd("Ctrl")} + ${kbd("1")}…${kbd("6")} — разделы. ${kbd("Esc")} — закрыть окно. ${kbd("?")} — полный список.</p>
          <p>${kbd("Ctrl")} + ${kbd("Shift")} + ${kbd("P")} — показать или спрятать приложение откуда угодно, даже из трея.</p>`,
      },
    ],
  },

  {
    id: "settings", name: "Настройки", icon: "⚙️", about: "Аккаунт, вид, уведомления, поведение, обновления",
    setup: openSettingsSheet,
    cleanup: () => closeOverlayWith(".st-sheet"),
    steps: [
      { el: ".st-nav", title: "Разделы настроек", text: "Слева — разделы и поиск по всем настройкам, справа — содержимое раздела. Всё сохраняется сразу, кнопки «Сохранить» нет." },
      { el: "#st-acc", before: () => settingsGo("st-acc"), title: "Аккаунт", text: "Под каким именем вы вошли, переход в профиль и выход из аккаунта на этом компьютере." },
      { el: "#st-look", before: () => settingsGo("st-look"), title: "Внешний вид", text: "Тема (Огонь, Золотое свечение, Светлая), акцентный цвет, масштаб интерфейса для больших мониторов, плотность таблиц, анимации и компактное боковое меню." },
      { el: "#st-notif", before: () => settingsGo("st-notif"), title: "Уведомления", text: "Всплывашки Windows: общий выключатель и по типам — назначения, упоминания, личные, сроки, дни рождения. Тихие часы и пауза на отпуск." },
      { el: "#st-behave", before: () => settingsGo("st-behave"), title: "Поведение", text: "Запуск вместе с Windows (сразу в трей), какой раздел открывать при запуске и фокус-режим при открытии отчёта." },
      { el: "#st-keys", before: () => settingsGo("st-keys"), title: "Горячие клавиши", text: "Полный список сочетаний — то же, что по клавише <b>?</b>." },
      { el: "#st-update", before: () => settingsGo("st-update"), title: "Обновления", text: "Версия приложения и проверка обновлений. Канал: <b>Стабильный</b> — для работы, <b>Альфа</b> — свежие сборки для проверки нового, могут быть ошибки." },
      { el: "#st-studio", admin: true, before: () => settingsGo("st-studio"), title: "Команда", text: "Админские инструменты: админ-панель и доступы, объявление для всей команды, тикеты, роли, дни рождения, пост в канал с превью, упоминания и аварийный режим." },
      { el: "#st-learn", before: () => settingsGo("st-learn"), title: "Обучение", text: "Все уроки с отметкой, какие пройдены. Любой можно пройти заново, а подсказки «Впервые здесь?» — выключить или вернуть." },
      { el: "#st-diag", before: () => settingsGo("st-diag"), title: "Диагностика", text: "Связь с сервером, логи приложения и «Отчёт для разработчика» — версия, система и связь одним текстом, чтобы вставить в сообщение." },
    ],
  },
];

const byId = Object.fromEntries(TOURS.map(t => [t.id, t]));
const role = () => ({ admin: !!state.isAdmin });
const stepAllowed = s => (!s.admin || state.isAdmin) && (!s.member || !state.isAdmin);
export function availableTours() {
  const m = readMem();
  return TOURS.filter(t => !t.admin || state.isAdmin).map(t => ({
    id: t.id, name: t.name, icon: t.icon, about: t.about,
    steps: t.steps.filter(stepAllowed).length, done: !!m.done[t.id],
  }));
}

// ---------- движок ----------
let T = null; // идущий урок

export function tourRunning() { return !!T; }

export async function startTour(id) {
  const tour = byId[id];
  if (!tour || (tour.admin && !state.isAdmin)) return;
  endTour(false);
  hideHint();
  const steps = tour.steps.filter(stepAllowed);
  if (!steps.length) return;
  const root = document.createElement("div");
  root.className = "tr-root";
  root.innerHTML = `
    <div class="tr-catch"></div>
    <div class="tr-spot" hidden></div>
    <div class="tr-card" role="dialog" aria-modal="true" aria-live="polite">
      <button type="button" class="tr-x" data-tr-x aria-label="Закончить обучение">✕</button>
      <div class="tr-kicker"><span>${tour.icon} ${esc(tour.name)}</span><em data-tr-count></em></div>
      <h3 data-tr-title></h3>
      <div class="tr-text" data-tr-text></div>
      <div class="tr-foot">
        <div class="tr-dots" data-tr-dots></div>
        <button type="button" class="btn ghost tr-back" data-tr-back>Назад</button>
        <button type="button" class="btn primary tr-next" data-tr-next>Далее</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  T = { tour, steps, i: 0, root, busy: false, el: null };
  root.querySelector("[data-tr-x]").addEventListener("click", () => endTour(false));
  root.querySelector("[data-tr-back]").addEventListener("click", () => go(T.i - 1));
  root.querySelector("[data-tr-next]").addEventListener("click", () => go(T.i + 1));
  requestAnimationFrame(() => root.classList.add("on"));
  if (tour.setup) {
    root.classList.add("busy");
    try { await tour.setup(); } catch (_) { /* покажем без подсветки */ }
    root.classList.remove("busy");
  } else if (tour.tab) {
    await goTab(tour.tab);
  }
  if (T && T.root === root) go(0);
}

async function go(i) {
  if (!T || T.busy) return;
  if (i < 0) return;
  if (i >= T.steps.length) return endTour(true);
  T.busy = true;
  const run = T;
  const step = T.steps[i];
  try { if (step.before) await step.before(); } catch (_) { /* шаг всё равно покажем */ }
  if (T !== run) return;
  T.i = i;
  let el = null, rect = null;
  if (step.union) {
    const els = step.union.map(s => document.querySelector(s)).filter(isVisible);
    if (els.length) {
      els[0].scrollIntoView({ block: "nearest", behavior: "smooth" });
      await wait(250);
      rect = unionRect(els);
      el = els[0];
    }
  } else if (step.el) {
    const sels = Array.isArray(step.el) ? step.el : [step.el];
    for (const s of sels) { const c = typeof s === "function" ? s() : document.querySelector(s); if (isVisible(c)) { el = c; break; } }
    if (el) {
      const r0 = el.getBoundingClientRect();
      if (r0.top < 50 || r0.bottom > window.innerHeight - 10) { el.scrollIntoView({ block: r0.height > window.innerHeight * 0.6 ? "start" : "center", behavior: "smooth" }); await wait(420); }
      rect = el.getBoundingClientRect();
    }
  }
  T.el = el;
  T.union = step.union && el ? step.union : null;
  render(step, rect);
  T.busy = false;
}

function unionRect(els) {
  const rs = els.map(e => e.getBoundingClientRect());
  const left = Math.min(...rs.map(r => r.left)), top = Math.min(...rs.map(r => r.top));
  const right = Math.max(...rs.map(r => r.right)), bottom = Math.max(...rs.map(r => r.bottom));
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function render(step, rect) {
  const { root, steps, i } = T;
  const card = root.querySelector(".tr-card");
  const spot = root.querySelector(".tr-spot");
  root.querySelector("[data-tr-title]").textContent = step.title;
  root.querySelector("[data-tr-text]").innerHTML = typeof step.text === "function" ? step.text(role()) : step.text;
  root.querySelector("[data-tr-count]").textContent = `${i + 1} из ${steps.length}`;
  root.querySelector("[data-tr-back]").hidden = i === 0;
  root.querySelector("[data-tr-next]").textContent = i === steps.length - 1 ? "Готово" : "Далее";
  root.querySelector("[data-tr-dots]").innerHTML = steps.length > 14
    ? `<span class="tr-bar"><i style="width:${((i + 1) / steps.length) * 100}%"></i></span>`
    : steps.map((_, n) => `<i class="${n === i ? "on" : n < i ? "past" : ""}"></i>`).join("");
  card.classList.remove("swap"); void card.offsetWidth; card.classList.add("swap");

  if (!rect) {
    spot.hidden = true;
    root.classList.add("dim");
    card.classList.add("center");
    card.style.left = card.style.top = "";
    root.querySelector("[data-tr-next]").focus({ preventScroll: true });
    return;
  }
  root.classList.remove("dim");
  card.classList.remove("center");
  const pad = 8;
  const r = {
    left: Math.max(4, rect.left - pad), top: Math.max(4, rect.top - pad),
    right: Math.min(window.innerWidth - 4, rect.right + pad), bottom: Math.min(window.innerHeight - 4, rect.bottom + pad),
  };
  spot.hidden = false;
  Object.assign(spot.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px` });
  placeCard(card, r);
  root.querySelector("[data-tr-next]").focus({ preventScroll: true });
}

function placeCard(card, r) {
  const cw = card.offsetWidth || 380, ch = card.offsetHeight || 220, gap = 16, m = 12;
  const fits = {
    right: window.innerWidth - r.right - gap >= cw + m,
    left: r.left - gap >= cw + m,
    bottom: window.innerHeight - r.bottom - gap >= ch + m,
    top: r.top - gap >= ch + m,
  };
  let x, y, side;
  if (fits.right) { side = "right"; x = r.right + gap; y = (r.top + r.bottom) / 2 - ch / 2; }
  else if (fits.left) { side = "left"; x = r.left - gap - cw; y = (r.top + r.bottom) / 2 - ch / 2; }
  else if (fits.bottom) { side = "bottom"; y = r.bottom + gap; x = (r.left + r.right) / 2 - cw / 2; }
  else if (fits.top) { side = "top"; y = r.top - gap - ch; x = (r.left + r.right) / 2 - cw / 2; }
  else { side = "inside"; x = window.innerWidth - cw - 24; y = window.innerHeight - ch - 24; }
  x = Math.max(m, Math.min(window.innerWidth - cw - m, x));
  y = Math.max(54, Math.min(window.innerHeight - ch - m, y));
  card.dataset.side = side;
  card.style.left = `${Math.round(x)}px`;
  card.style.top = `${Math.round(y)}px`;
}

function reposition() {
  if (!T || T.busy) return;
  const step = T.steps[T.i];
  let rect = null;
  if (T.union) rect = unionRect(T.union.map(s => document.querySelector(s)).filter(isVisible));
  else if (T.el && isVisible(T.el)) rect = T.el.getBoundingClientRect();
  render(step, rect);
}
window.addEventListener("resize", () => reposition());

function endTour(completed) {
  if (!T) return;
  const { tour, root } = T;
  T = null;
  if (completed) markDone(tour.id); else markSeen(tour.id);
  root.classList.remove("on");
  setTimeout(() => root.remove(), 260);
  try { tour.cleanup?.(); } catch (_) { /* не критично */ }
  if (completed && tour.id === "intro") showDoneToast();
}

// Клавиши урока — раньше всех остальных (захват на window): Esc не
// должен закрывать заодно открытую под уроком модалку или «Смотреть».
window.addEventListener("keydown", e => {
  if (!T) return;
  const k = e.key;
  if (k === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); endTour(false); }
  else if (k === "ArrowRight" || k === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); go(T.i + 1); }
  else if (k === "ArrowLeft") { e.preventDefault(); e.stopImmediatePropagation(); go(T.i - 1); }
  else if (k !== "Tab") { e.stopImmediatePropagation(); }
}, true);

function showDoneToast() {
  const n = availableTours().filter(t => t.id !== "intro").length;
  showHintCard({
    id: null, icon: "🎓", title: "Знакомство пройдено",
    text: `Ещё ${n} подробных уроков ждут в <b>Настройки → Обучение</b>, а при первом входе в раздел я сам предложу разбор.`,
    ok: "Понятно", okOnly: true,
  });
}

// ---------- приветствие ----------
export function maybeWelcome() {
  if (!state.telegramId) return;
  const m = readMem();
  if (m.welcome) return;
  setTimeout(() => {
    if (readMem().welcome || T || document.querySelector(".tr-welcome") || document.querySelector(".overlay")) return;
    showWelcome();
  }, 1400);
}

export function showWelcome() {
  document.querySelector(".tr-welcome")?.remove();
  const name = state.name || "";
  const tours = availableTours();
  const el = document.createElement("div");
  el.className = "tr-welcome";
  el.innerHTML = `
    <div class="tr-w-card" role="dialog" aria-modal="true" aria-labelledby="tr-w-h">
      <div class="tr-w-art"><span class="tr-w-glow"></span><img src="${mascotGif}" alt=""></div>
      <h2 id="tr-w-h">Добро пожаловать${name ? `, ${esc(name)}` : ""}!</h2>
      <p>Похоже, вы здесь впервые. Хотите, я за пару минут покажу, где что лежит и как тут всё устроено?</p>
      <ul class="tr-w-list">
        <li><b>Знакомство</b><span>меню, разделы и кнопки — ${tours.find(t => t.id === "intro")?.steps || 0} шагов</span></li>
        <li><b>Подробные уроки</b><span>${tours.length - 1} штук — по каждому разделу и инструменту</span></li>
        <li><b>Подсказки</b><span>при первом входе в раздел — «показать или пропустить»</span></li>
      </ul>
      <div class="tr-w-acts">
        <button type="button" class="btn ghost" data-w-skip>Пропустить</button>
        <button type="button" class="btn primary" data-w-go>Начать знакомство</button>
      </div>
      <label class="tr-w-check"><input type="checkbox" data-w-nohints> Не предлагать подсказки в разделах</label>
      <div class="tr-w-foot">Всё обучение всегда доступно в <b>Настройки → Обучение</b>.</div>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("on"));
  const close = () => { el.classList.remove("on"); setTimeout(() => el.remove(), 260); };
  const decide = welcome => {
    writeMem({ welcome, hints: !el.querySelector("[data-w-nohints]").checked });
    close();
  };
  el.querySelector("[data-w-skip]").addEventListener("click", () => { decide("skipped"); hintSoon(state.activeTab, 1200); });
  el.querySelector("[data-w-go]").addEventListener("click", () => { decide("started"); setTimeout(() => startTour("intro"), 280); });
  el.querySelector("[data-w-go]").focus();
  el.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); decide("skipped"); } });
}

// ---------- «Впервые здесь?» ----------
let hintEl = null;
function hideHint() {
  if (!hintEl) return;
  const h = hintEl;
  hintEl = null;
  h.classList.remove("on");
  setTimeout(() => h.remove(), 260);
}
function showHintCard({ id, icon, title, text, ok = "Показать", okOnly = false }) {
  hideHint();
  const el = document.createElement("div");
  el.className = "tr-hint";
  el.innerHTML = `
    <div class="tr-h-ic">${icon}</div>
    <div class="tr-h-body">
      <b>${esc(title)}</b>
      <span>${text}</span>
      <div class="tr-h-acts">
        ${okOnly ? "" : `<button type="button" class="btn ghost" data-h-no>Не сейчас</button>`}
        <button type="button" class="btn primary" data-h-ok>${esc(ok)}</button>
      </div>
      ${okOnly ? "" : `<button type="button" class="tr-h-off" data-h-off>Больше не предлагать подсказки</button>`}
    </div>
    <button type="button" class="tr-h-x" data-h-x aria-label="Закрыть">✕</button>`;
  document.body.appendChild(el);
  hintEl = el;
  requestAnimationFrame(() => el.classList.add("on"));
  el.querySelector("[data-h-x]").addEventListener("click", () => { if (id) markSeen(id); hideHint(); });
  el.querySelector("[data-h-no]")?.addEventListener("click", () => { markSeen(id); hideHint(); });
  el.querySelector("[data-h-off]")?.addEventListener("click", () => { markSeen(id); setTourHints(false); hideHint(); });
  el.querySelector("[data-h-ok]").addEventListener("click", () => { hideHint(); if (id) startTour(id); });
}

function maybeHint(id) {
  const tour = byId[id];
  if (!tour || (tour.admin && !state.isAdmin) || T || !state.telegramId) return;
  const m = readMem();
  if (!m.welcome || m.hints === false || m.seen[id] || m.done[id]) return;
  if (document.querySelector(".tr-welcome")) return;
  const n = tour.steps.filter(stepAllowed).length;
  showHintCard({ id, icon: tour.icon, title: `Впервые в разделе «${tour.name}»?`, text: `${esc(tour.about)}. Покажу, как тут всё устроено — ${n} ${plural(n, "шаг", "шага", "шагов")}.` });
}
function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

let hintTimer = null;
function hintSoon(id, delay = 900) {
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => maybeHint(id), delay);
}
// Вкладки: tabs.js шлёт событие при переключении (без импорта отсюда —
// иначе циклическая зависимость tabs ↔ tour).
document.addEventListener("project:tab", e => { hideHint(); hintSoon(e.detail); });
// Кнопки шапки и карточка отчёта.
document.addEventListener("click", e => {
  if (e.target.closest("#open-watch")) hintSoon("watch", 1800);
  else if (e.target.closest("#open-media-tools")) hintSoon("ffmpeg", 700);
}, true);
new MutationObserver(muts => {
  for (const m of muts) for (const n of m.addedNodes) {
    if (n.nodeType === 1 && n.classList?.contains("overlay") && n.querySelector?.(".rd-tabs")) hintSoon("report", 900);
  }
}).observe(document.body, { childList: true });

// Сменился пользователь — урок и подсказки от прошлого прячем.
export function resetTourUi() {
  endTour(false);
  hideHint();
  document.querySelector(".tr-welcome")?.remove();
}
