// «Автоматизация» (Настройки, владелец): всё, что бот делает сам, в одном месте — архив серий, чаты бота и ограничения скорости.
// Вкладки собраны в том же стиле, что «Архив серий»; каждая вкладка подгружается при первом открытии.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const TABS = [
  ["factory", "Завод", '<path d="M3 20V9l6 4V9l6 4V5h3v15zM7 20v-3M12 20v-3"/>'],
  ["overview", "Обзор", '<path d="M4 5h7v7H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 14h7v5H4z"/>'],
  ["archive", "Архив серий", '<path d="M4 7h16M6 7v11h12V7M10 11h4"/>'],
  ["chats", "Чаты бота", '<path d="M4 5h16v11H9l-5 4z"/>'],
  ["reports", "Отчёты", '<path d="M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3"/>'],
  ["docs", "Документы", '<path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6"/>'],
  ["speed", "Скорость", '<path d="M12 14l4-5M4 17a8 8 0 1 1 16 0"/>'],
  ["logs", "Логи", '<path d="M5 4h14v16H5zM8 9h8M8 13h8M8 17h5"/>'],
];
// Справка по вкладкам: как это работает (алгоритм простыми словами) и что менялось последним.
const HELP = {
  factory: {
    how: ["Схема показывает четыре линии: серии, отчёты, документы и производство финала. Зелёный огонёк — машина работает, синий — ждёт работу, жёлтый — пауза, красный — ошибки.",
      "Кнопки «Пуск/Стоп» включают и выключают машину сразу; ⚙ открывает её настройки. Конвейер бежит, когда есть что везти."],
    news: ["Новая вкладка: все автоматизации на одной схеме, с живыми счётчиками."],
  },
  overview: {
    how: ["Сводка: что включено, сколько в очередях, сколько уже перенесено и что сломалось.", "Блок «Нужно внимание» собирает всё, что требует действия: невыбранная группа, ошибки, мало места на диске."],
    news: ["Сводка и список проблем в одном месте."],
  },
  archive: {
    how: ["Бот ловит новые серии в канале-источнике, определяет тайтл и номер серии, создаёт тему тайтла в архивной группе и заливает серию строго по порядку.",
      "Если серия не распознана или не тот номер, она ждёт вашего решения, а не уходит наугад. Лимит скорости и отдых между пачками защищают канал от ограничений хостинга."],
    news: ["Подписи, названия и номера определяются точнее; лимит скорости теперь настраивается во вкладке «Скорость»."],
  },
  chats: {
    how: ["Список чатов, где состоит бот. Для каждого можно включить или выключить его функции и выбрать рабочий чат для упоминаний."],
    news: [],
  },
  reports: {
    how: ["Завершённые отчёты по расписанию уезжают в архивную группу: бот берёт самый давний подходящий, создаёт тему тайтла и кладёт в неё карточку (номер, автор, даты, заметки, список файлов).",
      "Фильтры решают, что переносить; окно времени и размер пачки — когда и сколько. Сами отчёты в студии не меняются."],
    news: ["Фильтры, окно времени, предпросмотр очереди, журнал переносов; готовятся маршруты по направлениям."],
  },
  docs: {
    how: ["Файлы отчётов (видео, торренты, субтитры, звук, надписи, архивы) копируются в архивную группу. Если файл уже в Telegram, он пересылается по id без закачки; если лежит на диске сервера, заливается по-настоящему с учётом лимита скорости.",
      "После заливки видео с диска подменяется ссылкой на Telegram-файл, а копия на диске стирается."],
    news: ["Правила по видам файлов и размеру, дедупликация, предпросмотр очереди; готовятся маршруты по направлениям."],
  },
  speed: {
    how: ["Каждый вид загрузки имеет свой потолок скорости, чтобы хостинг не включал ограничение канала (оно приходит выше ~50 Мбит/с надолго).",
      "Ночной режим меняет лимиты по часам, а общий потолок делит канал между архивом и торрентами, когда они идут вместе."],
    news: ["Ночной режим и общий потолок."],
  },
  logs: {
    how: ["Здесь все логи сервера: журнал служб, bot.log, системные логи и записи в базе. Автоочистка раз в сутки оставляет последние N дней.", "Журнал действий админов не очищается: это след безопасности."],
    news: ["Вкладка добавлена: размеры, очистка вручную и автоочистка."],
  },
};

const svg = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

const fmtBytes = n => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} ГБ` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`);

async function mountOverview(root, go) {
  let d;
  try { d = await apiGet("/automation/overview"); }
  catch (e) { root.innerHTML = `<div class="bc-warn">Не удалось загрузить: ${esc(e.message)}</div>`; return; }
  const mb = d.speed.total ? ` · общий потолок ${d.speed.total}` : "";
  const lim = v => (v ? `${v} Мбит/с` : "без лимита");
  const state = (on, paused) => (!on ? ["выключен", "off"] : paused ? ["на паузе", "warn"] : ["работает", "ok"]);
  const card = (tab, title, st, lines) => {
    const [label, cls] = st;
    return `<button type="button" class="ar-card" data-au-go="${tab}" style="text-align:left; cursor:pointer; display:grid; gap:6px;">
      <div class="ar-card-head"><h4>${title}</h4><span class="bcn-badge ${cls === "ok" ? "work" : cls === "warn" ? "" : "gone"}">${label}</span></div>
      ${lines.map(l => `<span class="ar-hint" style="margin:0;">${l}</span>`).join("")}
    </button>`;
  };
  root.innerHTML = `
    <div class="ar" style="display:grid; gap:14px;">
      ${d.problems.length ? `<div class="ar-card" style="border-color:rgba(255,120,90,.5);"><div class="ar-card-head"><h4>Нужно внимание · ${d.problems.length}</h4></div>
        ${d.problems.map(p => `<div class="ar-row" style="display:flex; justify-content:space-between; gap:12px; align-items:center;"><span>${esc(p.text)}</span><button type="button" class="btn" data-au-go="${p.tab}">Открыть</button></div>`).join("")}</div>`
        : `<div class="ar-card"><div class="ar-card-head"><h4>Всё в порядке</h4></div><p class="ar-hint" style="margin:0;">Ошибок и зависших очередей нет. Свободно на диске сервера: ${(d.disk_free / 1024 ** 3).toFixed(1)} ГБ.</p></div>`}
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px;">
        ${card("archive", "Архив серий", state(d.archive.enabled, d.archive.paused), [`В очереди: ${d.archive.queue}${d.archive.held ? ` · ждут решения: ${d.archive.held}` : ""}`, `Лимит заливки: ${lim(d.archive.limit)}`])}
        ${card("reports", "Архив отчётов", state(d.reports.enabled, d.reports.paused), [`В очереди: ${d.reports.queue} · перенесено: ${d.reports.done}`, d.reports.failed ? `Ошибок: ${d.reports.failed}` : "Ошибок нет"])}
        ${card("docs", "Архив документов", state(d.docs.enabled, d.docs.paused), [`В очереди: ${d.docs.queue} · отправлено: ${d.docs.done}`, d.docs.failed ? `Ошибок: ${d.docs.failed}` : "Ошибок нет"])}
        ${card("speed", "Скорость", ["действует", "ok"], [`Архив: ${lim(d.speed.archive)} · торренты: ${lim(d.speed.torrent)}${mb}`, d.speed.night_now ? "Сейчас ночной режим" : "Обычный режим"])}
        ${card("logs", "Логи", ["действует", d.logs.auto ? "ok" : "warn"], [`Занимают ${(d.logs.bytes / 1048576).toFixed(0)} МБ`, d.logs.auto ? `Автоочистка: хранить ${d.logs.days} дн.` : "Автоочистка выключена"])}
      </div>
    </div>`;
  root.querySelectorAll("[data-au-go]").forEach(b => b.addEventListener("click", () => go(b.dataset.auGo)));
}

async function mountLogs(root) {
  let d;
  const load = async () => { d = await apiGet("/logs"); };
  try { await load(); }
  catch (e) { root.innerHTML = `<div class="bc-warn">Не удалось загрузить: ${esc(e.message)}</div>`; return; }

  const paint = () => {
    const total = d.sources.reduce((a, x) => a + (x.bytes || 0), 0);
    root.innerHTML = `
    <div class="ar" style="display:grid; gap:14px;">
      <div class="ar-card">
        <div class="ar-card-head"><h4>Хранение логов</h4></div>
        <p class="ar-hint" style="margin:0 0 10px;">Раз в сутки сервер сам оставляет только последние дни во всех логах ниже. Журнал действий админов (кто что менял) не очищается: это след безопасности.</p>
        <div class="ar-fields" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <label class="bcn-feature" style="gap:10px;"><span>Автоочистка</span><span class="ar-switch sm"><input type="checkbox" id="lg-auto" ${d.auto ? "checked" : ""}><i></i></span></label>
          <input class="field-input" type="number" min="1" max="365" id="lg-days" value="${d.keep_days}" style="max-width:100px;">
          <span class="ar-meta">дней хранить</span>
          <button type="button" class="btn primary" id="lg-save">Сохранить</button>
        </div>
      </div>
      <div class="ar-card">
        <div class="ar-card-head"><h4>Все логи${total ? ` · ${fmtBytes(total)} на диске` : ""}</h4>
          <button type="button" class="btn" data-lg-clean="all">Очистить всё (по сроку)</button></div>
        <div style="display:grid; gap:10px; margin-top:8px;">
          ${d.sources.map(x => `
          <div class="ar-row" style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
            <div style="flex:1; min-width:200px;"><b>${esc(x.title)}</b><div class="ar-hint" style="margin:2px 0 0;">${esc(x.sub)}</div></div>
            <span class="ar-meta">${x.bytes != null ? fmtBytes(x.bytes) : `${Number(x.rows).toLocaleString("ru-RU")} записей`}</span>
            <button type="button" class="btn" data-lg-clean="${x.key}">Очистить</button>
          </div>`).join("")}
        </div>
      </div>
    </div>`;
    root.querySelector("#lg-save").addEventListener("click", async e => {
      e.currentTarget.disabled = true;
      try {
        d = await apiPost("/logs", { auto: root.querySelector("#lg-auto").checked, keep_days: Number(root.querySelector("#lg-days").value) });
        toast("Настройки логов сохранены.", "success");
        paint();
      } catch (err) { toast(`Не сохранилось: ${err.message}`, "error"); e.currentTarget.disabled = false; }
    });
    root.querySelectorAll("[data-lg-clean]").forEach(b => b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        const r = await apiPost("/logs/clean", { source: b.dataset.lgClean });
        d = r;
        const freed = Object.entries(r.freed || {}).reduce((a, [k, v]) => a + (["snapshots", "messages"].includes(k) ? 0 : v), 0);
        toast(freed ? `Освобождено ${fmtBytes(freed)}.` : "Очищено: старше срока хранения ничего не было.", "success");
        paint();
      } catch (err) { toast(`Не получилось очистить: ${err.message}`, "error"); b.disabled = false; }
    }));
  };
  paint();
}

async function mountSpeed(root) {
  let d;
  try { d = await apiGet("/speed"); }
  catch (e) { root.innerHTML = `<div class="bc-warn">Не удалось загрузить: ${esc(e.message)}</div>`; return; }

  const field = (key, title, sub, value) => `
    <div class="ar-card">
      <div class="ar-card-head"><h4>${title}</h4></div>
      <p class="ar-hint" style="margin:0 0 10px;">${sub}</p>
      <div class="ar-fields" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
        <input class="field-input" type="number" min="0" max="1000" step="1" id="sp-${key}" value="${value}" style="max-width:140px;">
        <span class="ar-meta">Мбит/с</span>
        <button type="button" class="btn" data-sp-preset="${key}:45">45 Мбит/с</button>
        <button type="button" class="btn" data-sp-preset="${key}:30">30 Мбит/с</button>
        <button type="button" class="btn" data-sp-preset="${key}:0">Без лимита</button>
        <button type="button" class="btn primary" data-sp-save="${key}">Сохранить</button>
      </div>
    </div>`;

  root.innerHTML = `
    <div class="ar" style="display:grid; gap:14px;">
      <p class="ar-hint" style="margin:0;">Хостинг сервера включает ограничение канала, если нагрузка долго держится выше ~50 Мбит/с. Задайте потолок для каждого вида загрузки: изменения подхватываются на ходу, перезапуск не нужен.</p>
      ${field("archive", "Заливка архива серий в Telegram", "Сколько бот заливает в архивную группу. Когда очередь пуста, бот сам снимает лимит; для большой пачки серий верните 45.", d.archive_mbit)}
      ${field("torrent", "Скачивание торрентов на сервере", "Очередь Nyaa и кнопка ☁ «Видео с Nyaa» в отчёте. Действует на новые скачивания.", d.torrent_mbit)}
      ${field("social", "Скачивание видео по ссылкам", "Видео с YouTube и других сайтов, которые бот качает по ссылке из чата. Действует на новые скачивания.", d.social_mbit)}
      <div class="ar-card">
        <div class="ar-card-head"><h4>Ночной режим</h4>
          <label class="ar-switch sm"><input type="checkbox" id="sp-night-on" ${d.night_on ? "checked" : ""}><i></i></label></div>
        <p class="ar-hint" style="margin:0 0 10px;">В заданные часы по Москве действуют свои лимиты, например ночью, когда студия не работает, можно качать быстрее.
          Сейчас: <b>${d.night_now ? "ночной режим включён" : "обычный режим"}</b>; действующие лимиты — архив ${d.effective_archive || "без ограничения"}, торренты ${d.effective_torrent || "без ограничения"}${d.effective_archive || d.effective_torrent ? " Мбит/с" : ""}.</p>
        <div class="ar-fields" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <span class="ar-meta">с</span><input class="field-input" type="number" min="0" max="23" id="sp-night-from" value="${d.night_from}" style="max-width:80px;">
          <span class="ar-meta">до</span><input class="field-input" type="number" min="0" max="23" id="sp-night-to" value="${d.night_to}" style="max-width:80px;">
          <span class="ar-meta">часов · архив</span><input class="field-input" type="number" min="0" max="1000" id="sp-night-archive" value="${d.night_archive}" style="max-width:100px;">
          <span class="ar-meta">торренты</span><input class="field-input" type="number" min="0" max="1000" id="sp-night-torrent" value="${d.night_torrent}" style="max-width:100px;">
          <span class="ar-meta">Мбит/с</span>
          <button type="button" class="btn primary" id="sp-night-save">Сохранить</button>
        </div>
      </div>
      ${field("total", "Общий потолок", "Если архив заливает серии, а рядом качаются торренты, канал делится: торренты получают не больше половины этого потолка. 0 — не делить.", d.total_mbit)}
    </div>`;

  root.querySelectorAll("[data-sp-preset]").forEach(b => b.addEventListener("click", () => {
    const [key, v] = b.dataset.spPreset.split(":");
    root.querySelector(`#sp-${key}`).value = v;
  }));
  root.querySelector("#sp-night-save").addEventListener("click", async e => {
    e.currentTarget.disabled = true;
    try {
      d = await apiPost("/speed", {
        night_on: root.querySelector("#sp-night-on").checked,
        night_from: Number(root.querySelector("#sp-night-from").value),
        night_to: Number(root.querySelector("#sp-night-to").value),
        night_archive: Number(root.querySelector("#sp-night-archive").value),
        night_torrent: Number(root.querySelector("#sp-night-torrent").value),
      });
      toast("Ночной режим сохранён.", "success");
    } catch (err) { toast(`Не сохранилось: ${err.message}`, "error"); }
    finally { e.currentTarget.disabled = false; }
  });
  root.querySelectorAll("[data-sp-save]").forEach(b => b.addEventListener("click", async () => {
    const key = b.dataset.spSave;
    const v = Number(root.querySelector(`#sp-${key}`).value);
    b.disabled = true;
    try {
      const r = await apiPost("/speed", { [key]: v });
      const saved = r[key + "_mbit"] ?? r[key];
      toast(`Сохранено: ${saved || "без ограничения"}${saved ? " Мбит/с" : ""}.`, "success");
    } catch (e) { toast(`Не сохранилось: ${e.message}`, "error"); }
    finally { b.disabled = false; }
  }));
}

const STATE = { done: "отправлен", failed: "ошибка", retry: "повтор", dup: "дубль — пропущен", skipped: "исключён" };
const CAT_ICON = { video: "🎞", torrent: "🧲", sub: "💬", audio: "🎙", inscr: "🏷", zip: "📦", other: "📄", photo: "🖼" };

// «Маршруты» архива документов: какой файл куда уезжает. Первый подошедший маршрут по порядку, иначе маршрут по умолчанию.
function wireDocsRoutes(box, d, saveAll) {
  const st = { routes: d.routes.map(r => ({ ...r })), def: { scheme: d.default_route.scheme, prefix: d.default_route.prefix } };
  const chatOpts = sel => `<option value=""${sel ? "" : " selected"}>— группа по умолчанию —</option>${d.chats.map(c => `<option value="${c.chat_id}"${String(c.chat_id) === String(sel) ? " selected" : ""}>${esc(c.title)}${c.is_forum ? " · с темами" : ""}</option>`).join("")}`;
  const schemeOpts = sel => Object.entries(d.schemes).map(([k, l]) => `<option value="${k}"${k === sel ? " selected" : ""}>${esc(l)}</option>`).join("");
  const titleName = id => (d.titles.find(t => t.id === id) || {}).name || `№${id}`;

  const paint = () => {
    box.innerHTML = `
    <div class="ar-card">
      <h4>Маршруты <em>${st.routes.length}</em></h4>
      <p class="ar-hint" style="margin:0 0 10px;">Маршрут решает, в какую группу и тему уедет файл. Файл проверяется по маршрутам сверху вниз, срабатывает первый подошедший; если не подошёл ни один — маршрут «По умолчанию». Пустое условие значит «любой»: маршрут без видов берёт любые виды, без тайтлов — любые тайтлы. Порядок меняйте стрелками: чем выше, тем важнее.</p>
      ${st.routes.map((r, i) => `
      <div class="ar-result" data-rt="${i}" style="display:grid; gap:8px; margin-bottom:10px;">
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
          <input class="field-input" data-f="name" value="${esc(r.name)}" style="max-width:220px;" title="Название маршрута — только для вас">
          <span class="ar-meta">отправлено <b>${r.sent || 0}</b></span>
          <span style="flex:1;"></span>
          <button class="btn" data-up title="Выше — приоритетнее">↑</button><button class="btn" data-down title="Ниже">↓</button>
          <button class="btn danger" data-del>Удалить</button>
          <label class="ar-switch sm" title="Выключенный маршрут не участвует"><input type="checkbox" data-f="on" ${r.on ? "checked" : ""}><i></i></label>
        </div>
        <div>
          <span class="ar-label">Какие виды файлов <small>— пусто: любые</small></span>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">${Object.entries(d.cat_labels).map(([k, l]) => `
            <label class="ar-row ad-pick" style="padding:4px 10px;"><input type="checkbox" data-cat="${k}" ${r.cats.includes(k) ? "checked" : ""}><span>${esc(String(l).split(" (")[0])}</span></label>`).join("")}</div>
        </div>
        <div>
          <span class="ar-label">Только эти тайтлы <small>— пусто: любые</small></span>
          <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
            ${r.titles.map(id => `<button type="button" class="btn" data-untitle="${id}">${esc(titleName(id))} ✕</button>`).join("")}
            <select class="field-input ar-select" data-addtitle style="max-width:240px;"><option value="">+ тайтл…</option>${d.titles.filter(t => !r.titles.includes(t.id)).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select>
          </div>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:end;">
          <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">Размер от, МБ</span><input class="field-input" type="number" min="0" data-f="min_mb" value="${r.min_mb || 0}" style="max-width:100px;"></label>
          <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">до, МБ (0 — без предела)</span><input class="field-input" type="number" min="0" data-f="max_mb" value="${r.max_mb || 0}" style="max-width:100px;"></label>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:end;">
          <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">Куда слать</span><select class="field-input ar-select" data-f="target">${chatOpts(r.target)}</select></label>
          <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">Схема тем</span><select class="field-input ar-select" data-f="scheme">${schemeOpts(r.scheme)}</select></label>
          <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">Префикс названия темы</span><input class="field-input" data-f="prefix" value="${esc(r.prefix)}" style="max-width:200px;"></label>
        </div>
      </div>`).join("") || `<p class="ar-hint">Своих маршрутов нет — всё уезжает по маршруту «По умолчанию».</p>`}
      <button class="btn" id="rt-add">+ Добавить маршрут</button>
      <button class="btn primary" id="rt-save" style="margin-left:6px;">Сохранить маршруты</button>
    </div>

    <div class="ar-card" style="margin-top:14px;">
      <div class="ar-card-head"><h4>Маршрут по умолчанию</h4><span class="ar-meta">отправлено <b>${d.default_route.sent}</b></span></div>
      <p class="ar-hint" style="margin:0 0 8px;">Сюда попадает всё, что не подошло ни одному маршруту. Группа — «Архивная группа» из верхней карточки. «Тема на тайтл» — по теме на каждый тайтл, «на вид файлов» — по теме на субтитры, звук и т. д., «одна общая» — одна тема на всё, «без тем» — общая лента группы (для групп без тем).</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:end;">
        <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">Схема тем</span><select class="field-input ar-select" id="rt-def-scheme">${schemeOpts(st.def.scheme)}</select></label>
        <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">Префикс названия темы</span><input class="field-input" id="rt-def-prefix" value="${esc(st.def.prefix)}" style="max-width:200px;"></label>
        <button class="btn" id="rt-def-save">Сохранить</button>
      </div>
    </div>

    <div class="ar-card" style="margin-top:14px;">
      <h4>Проверить на файле</h4>
      <p class="ar-hint" style="margin:0 0 8px;">Выберите вид, размер и тайтл — покажу, по какому маршруту, в какую группу и тему уедет такой файл. Ничего не отправляется. Проверяются сохранённые маршруты.</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:end;">
        <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">Вид</span><select class="field-input ar-select" id="rt-t-cat">${Object.entries(d.cat_labels).map(([k, l]) => `<option value="${k}">${esc(String(l).split(" (")[0])}</option>`).join("")}</select></label>
        <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">Размер, МБ</span><input class="field-input" type="number" min="0" id="rt-t-size" value="5" style="max-width:100px;"></label>
        <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">Тайтл</span><select class="field-input ar-select" id="rt-t-title"><option value="">— любой —</option>${d.titles.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
        <button class="btn" id="rt-test">Проверить</button>
      </div>
      <div id="rt-test-out" class="ar-hint" style="margin-top:8px;"></div>
    </div>`;

    const row = el => st.routes[Number(el.closest("[data-rt]").dataset.rt)];
    const pull = () => box.querySelectorAll("[data-rt]").forEach(el => {
      const r = st.routes[Number(el.dataset.rt)];
      el.querySelectorAll("[data-f]").forEach(f => {
        const k = f.dataset.f;
        r[k] = f.type === "checkbox" ? f.checked : (f.type === "number" ? Number(f.value || 0) : f.value);
      });
      r.cats = [...el.querySelectorAll("[data-cat]:checked")].map(c => c.dataset.cat);
    });
    box.querySelectorAll("[data-up]").forEach(b => b.addEventListener("click", () => {
      pull(); const i = Number(b.closest("[data-rt]").dataset.rt);
      if (i > 0) { [st.routes[i - 1], st.routes[i]] = [st.routes[i], st.routes[i - 1]]; paint(); }
    }));
    box.querySelectorAll("[data-down]").forEach(b => b.addEventListener("click", () => {
      pull(); const i = Number(b.closest("[data-rt]").dataset.rt);
      if (i < st.routes.length - 1) { [st.routes[i + 1], st.routes[i]] = [st.routes[i], st.routes[i + 1]]; paint(); }
    }));
    box.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => { pull(); st.routes.splice(Number(b.closest("[data-rt]").dataset.rt), 1); paint(); }));
    box.querySelectorAll("[data-untitle]").forEach(b => b.addEventListener("click", () => {
      pull(); const r = row(b); r.titles = r.titles.filter(id => id !== Number(b.dataset.untitle)); paint();
    }));
    box.querySelectorAll("[data-addtitle]").forEach(sel => sel.addEventListener("change", () => {
      if (!sel.value) return;
      pull(); row(sel).titles.push(Number(sel.value)); paint();
    }));
    box.querySelector("#rt-add").addEventListener("click", () => {
      pull();
      st.routes.push({ id: "r" + Date.now().toString(36), name: `Маршрут ${st.routes.length + 1}`, on: true, cats: [], titles: [], min_mb: 0, max_mb: 0, target: "", scheme: "title", prefix: "Документы", sent: 0 });
      paint();
    });
    box.querySelector("#rt-save").addEventListener("click", () => {
      pull();
      saveAll({ routes: st.routes.map(({ sent, ...r }) => r) });
    });
    box.querySelector("#rt-def-save").addEventListener("click", () =>
      saveAll({ default_scheme: box.querySelector("#rt-def-scheme").value, default_prefix: box.querySelector("#rt-def-prefix").value }));
    box.querySelector("#rt-test").addEventListener("click", async () => {
      const out = box.querySelector("#rt-test-out");
      try {
        const r = await apiPost("/docs-archive/test", {
          cat: box.querySelector("#rt-t-cat").value, size_mb: Number(box.querySelector("#rt-t-size").value || 0),
          title_id: Number(box.querySelector("#rt-t-title").value || 0) || null,
        });
        const chat = (d.chats.find(c => String(c.chat_id) === String(r.target)) || {}).title || r.target || "— группа не выбрана —";
        out.innerHTML = r.skipped
          ? `Файл будет <b>пропущен</b>: ${esc(r.skipped)}.`
          : `Маршрут <b>${esc(r.route)}</b> → группа <b>${esc(chat)}</b> → тема <b>${esc(r.topic)}</b>${r.reply ? ". Торрент отправится ответом на видео этого отчёта, если оно уже в той же группе" : ""}.`;
      } catch (e) { out.textContent = e.message; }
    });
  };
  paint();
}

async function mountDocs(root) {
  const load = async () => {
    let d;
    try { d = await apiGet("/docs-archive"); }
    catch (e) { root.innerHTML = `<div class="bc-warn">Не удалось загрузить: ${esc(e.message)}</div>`; return; }
    const target = d.chats.find(c => String(c.chat_id) === String(d.target));
    const excludedIds = new Set(d.excluded_titles.map(t => t.id));
    root.innerHTML = `
    <div class="ar" style="display:grid; gap:14px;">
      <div class="ar-card">
        <div class="ar-card-head"><h4>Архив документов</h4>
          <label class="ar-switch"><input type="checkbox" id="dc-enabled" ${d.enabled ? "checked" : ""}><i></i></label></div>
        <p class="ar-hint" style="margin:0;">Файлы отчётов бот копирует в архивную группу, по теме на тайтл. Файлы уже в Telegram, поэтому копирование мгновенное и без нагрузки на канал. Видео с диска сервера заливается с лимитом скорости (${d.limit_mbit ? `${d.limit_mbit} Мбит/с` : "без ограничения"}), после чего в отчёте подменяется на файл из Telegram и место на диске освобождается.</p>
        <label class="ar-label" for="dc-target">Архивная группа</label>
        <select id="dc-target" class="field-input ar-select">
          <option value=""${d.target ? "" : " selected"}>— не выбрана —</option>
          ${d.chats.map(c => `<option value="${c.chat_id}"${String(c.chat_id) === String(d.target) ? " selected" : ""}>${esc(c.title)}${c.is_forum ? " · с темами" : ""} (${c.chat_id})</option>`).join("")}
        </select>
        ${target && !target.is_forum ? `<div class="bc-warn">В группе не включены темы — всё пойдёт в общую ленту.</div>` : ""}
        <div class="ar-actions" style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
          <span class="ar-meta">Отправлено <b>${d.done}</b></span>
          ${d.dup ? `<span class="ar-meta">дублей пропущено <b>${d.dup}</b></span>` : ""}
          ${d.skipped ? `<span class="ar-meta">по правилам пропущено <b>${d.skipped}</b></span>` : ""}
          ${d.failed ? `<span class="ar-meta" style="color:#ff8f8f;">ошибок <b>${d.failed}</b></span>` : ""}
          <span class="ar-meta">освобождено на диске сервера <b>${fmtBytes(d.freed_bytes)}</b></span>
        </div>
      </div>

      <div class="ar-card">
        <h4>Правила по видам файлов</h4>
        <p class="ar-hint" style="margin:0 0 8px;">Что отправлять и какого размера максимум (0 — без ограничения). Файлы, не подошедшие по правилам, пропускаются и при смене правил рассматриваются заново.</p>
        ${d.rules.map(r => `
        <div class="bcn-feature" data-dc-rule="${r.cat}" style="gap:10px; align-items:center;">
          <span style="flex:1;">${CAT_ICON[r.cat] || ""} ${esc(r.label)}</span>
          <input class="field-input" type="number" min="0" step="1" value="${r.max_mb}" data-dc-max style="max-width:90px;" title="Максимум, МБ">
          <span class="ar-meta">МБ</span>
          <label class="ar-switch sm"><input type="checkbox" data-dc-on ${r.on ? "checked" : ""}><i></i></label>
        </div>`).join("")}
        <button class="btn" id="dc-rules-save" style="margin-top:8px;">Сохранить размеры</button>
      </div>

      <div id="dc-routes"></div>

      <div class="ar-card">
        <h4>Подача</h4>
        <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:end;">
          <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">Файлов за проход (раз в минуту)</span>
            <input class="field-input" type="number" min="1" max="50" id="dc-batch" value="${d.batch}" style="max-width:110px;"></label>
          <label style="display:grid; gap:4px;"><span class="ar-label" style="margin:0;">Окно работы по Москве (например 02:00-08:00; пусто — всегда)</span>
            <input class="field-input" id="dc-window" value="${esc(d.window)}" placeholder="круглосуточно" style="max-width:180px;"></label>
          <button class="btn" id="dc-feed-save">Сохранить</button>
        </div>
        ${d.window && !d.in_window ? `<p class="ar-hint" style="margin:8px 0 0;">Сейчас вне окна — бот ждёт.</p>` : ""}
        <span class="ar-label">Порядок</span>
        <div class="ar-seg" id="dc-order">
          <button data-order="new" class="${d.order === "new" ? "on" : ""}">Новые первыми<small>свежие версии раньше накопившихся</small></button>
          <button data-order="old" class="${d.order === "old" ? "on" : ""}">По порядку<small>от самых старых</small></button>
        </div>
        <label class="bcn-feature"><span>Когда все файлы отчёта в архиве — освобождать их кэш на сервере (Telegram помнит, при сборке скачается снова)</span><span class="ar-switch sm"><input type="checkbox" id="dc-free-cache" ${d.free_cache ? "checked" : ""}><i></i></span></label>
        <label class="bcn-feature"><span>Включая файлы, накопившиеся раньше (иначе только новые)</span><span class="ar-switch sm"><input type="checkbox" id="dc-backfill" ${d.backfill ? "checked" : ""}><i></i></span></label>
        <p class="ar-hint" style="margin:6px 0 0;">Файлы одного отчёта идут подряд: видео, под ним торрент (ответом на видео), потом субтитры, звук, надписи. Одинаковые файлы (то же имя и размер) второй раз не отправляются; zip подписывается списком содержимого.</p>
      </div>

      <div class="ar-card">
        <h4>Исключённые тайтлы <em>${d.excluded_titles.length}</em></h4>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px;">
          ${d.excluded_titles.map(t => `<button type="button" class="btn" data-dc-unex="${t.id}" title="Вернуть в архив">${esc(t.name)} ✕</button>`).join("") || `<span class="ar-hint" style="margin:0;">Все тайтлы архивируются.</span>`}
        </div>
        <select id="dc-ex-add" class="field-input ar-select"><option value="">+ Исключить тайтл…</option>
          ${d.titles.filter(t => !excludedIds.has(t.id)).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select>
      </div>

      <div class="ar-card">
        <div class="ar-card-head"><h4>Ближайшие файлы <em>${d.pending}</em></h4>
          <div class="ar-actions">
            <button class="btn" id="dc-pause">${d.paused ? "▶ Снять паузу" : "⏸ Пауза"}</button>
            ${d.failed ? `<button class="btn" id="dc-retry">Повторить ошибки (${d.failed})</button>` : ""}
            <button class="btn" id="dc-refresh">Обновить</button>
          </div>
        </div>
        ${d.paused ? `<p class="ar-hint" style="margin:0 0 8px;"><b>На паузе.</b></p>` : ""}
        ${d.upcoming.length ? `<div class="ar-list">${d.upcoming.map(r => `
          <div class="ar-row"><b>${CAT_ICON[r.cat] || ""} ${esc(r.public_id || "")} · ${esc(r.name || r.type || "файл")}</b>
            <span class="ar-meta">${fmtBytes(r.size)}${r.version > 1 ? ` · v${r.version}` : ""}</span>
            <button class="btn" data-dc-ex="${r.file}">Исключить</button></div>`).join("")}</div>` : `<p class="ar-hint">${d.enabled ? "Очередь пуста." : "Архив выключен — очередь не считается."}</p>`}
      </div>

      <div class="ar-card">
        <h4>Журнал</h4>
        ${d.recent.length ? `<div class="ar-list">${d.recent.map(r => `
          <div class="ar-row"><b>${esc(r.public_id || "")} · ${esc(r.name || r.type || "файл")}</b>
            <span class="ar-meta"${r.state === "failed" ? ' style="color:#ff8f8f;"' : ""}>${esc(STATE[r.state] || r.state)}${r.error && r.state !== "dup" ? ` — ${esc(r.error)}` : ""}</span>
            ${r.state === "skipped" ? `<button class="btn" data-dc-restore="${r.file}">Вернуть</button>` : ""}</div>`).join("")}</div>` : `<p class="ar-hint">Пока ничего не отправлено.</p>`}
      </div>
    </div>`;
    const save = async (body, quiet) => {
      try { await apiPost("/docs-archive", body); if (!quiet) toast("Сохранено.", "success"); }
      catch (e) { toast(e.message, "error"); }
      load();
    };
    wireDocsRoutes(root.querySelector("#dc-routes"), d, body => save(body));
    root.querySelector("#dc-enabled").addEventListener("change", e => save({ enabled: e.target.checked }));
    root.querySelector("#dc-target").addEventListener("change", e => save({ target: e.target.value }));
    root.querySelector("#dc-free-cache").addEventListener("change", e => save({ free_cache: e.target.checked }));
    root.querySelector("#dc-backfill").addEventListener("change", e => save({ backfill: e.target.checked }));
    root.querySelector("#dc-rules-save").addEventListener("click", () => {
      const rules = {};
      root.querySelectorAll("[data-dc-rule]").forEach(row => {
        rules[row.dataset.dcRule] = { on: row.querySelector("[data-dc-on]").checked, max_mb: Number(row.querySelector("[data-dc-max]").value || 0) };
      });
      save({ rules });
    });
    root.querySelectorAll("[data-dc-on]").forEach(c => c.addEventListener("change", () => root.querySelector("#dc-rules-save").click()));
    root.querySelector("#dc-feed-save").addEventListener("click", () =>
      save({ batch: Number(root.querySelector("#dc-batch").value), window: root.querySelector("#dc-window").value.trim() }));
    root.querySelectorAll("[data-order]").forEach(b => b.addEventListener("click", () => save({ order: b.dataset.order }, true)));
    root.querySelector("#dc-ex-add").addEventListener("change", e => {
      if (e.target.value) save({ excluded_titles: [...excludedIds, Number(e.target.value)] });
    });
    root.querySelectorAll("[data-dc-unex]").forEach(b => b.addEventListener("click", () =>
      save({ excluded_titles: [...excludedIds].filter(id => id !== Number(b.dataset.dcUnex)) })));
    root.querySelectorAll("[data-dc-ex]").forEach(b => b.addEventListener("click", () => save({ exclude_file: Number(b.dataset.dcEx) }, true)));
    root.querySelectorAll("[data-dc-restore]").forEach(b => b.addEventListener("click", () => save({ restore_file: Number(b.dataset.dcRestore) }, true)));
    root.querySelector("#dc-pause").addEventListener("click", () => save({ paused: !d.paused }, true));
    root.querySelector("#dc-retry")?.addEventListener("click", () => save({ retry: true }));
    root.querySelector("#dc-refresh").addEventListener("click", load);
  };
  await load();
}

export function mountAutomation(root) {
  if (!root) return;
  root.innerHTML = `
    <div class="ar-tabs au-tabs" role="tablist">
      ${TABS.map(([k, label, ic]) => `<button type="button" data-au-tab="${k}">${svg(ic)}${label}</button>`).join("")}
    </div>
    <div id="au-pane" style="margin-top:14px;"></div>`;
  const pane = root.querySelector("#au-pane");
  const mounted = {};
  const show = name => {
    root.querySelectorAll("[data-au-tab]").forEach(b => b.classList.toggle("on", b.dataset.auTab === name));
    pane.querySelectorAll("[data-au-pane]").forEach(p => { p.hidden = p.dataset.auPane !== name; });
    if (mounted[name]) return;
    mounted[name] = true;
    const host = document.createElement("div");
    host.dataset.auPane = name;
    pane.appendChild(host);
    const help = HELP[name];
    if (help) {
      const info = document.createElement("details");
      info.className = "au-help";
      let open = false;
      try { open = localStorage.getItem(`au-help-${name}`) === "1"; } catch (_) { /* без хранилища — свернуто */ }
      info.open = open;
      info.innerHTML = `<summary>Как это работает${help.news.length ? " · что нового" : ""}</summary>
        <div>${help.how.map(t => `<p>${esc(t)}</p>`).join("")}${help.news.length ? `<p class="au-news"><b>Что нового:</b></p><ul>${help.news.map(t => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}</div>`;
      info.addEventListener("toggle", () => { try { localStorage.setItem(`au-help-${name}`, info.open ? "1" : "0"); } catch (_) { /* не критично */ } });
      host.appendChild(info);
      const body = document.createElement("div");
      host.appendChild(body);
      host.__body = body;
    }
    const target = host.__body || host;
    if (name === "factory") import("./automation-factory.js").then(m => m.mountFactory(target, show));
    else if (name === "overview") mountOverview(target, show);
    else if (name === "archive") import("./archive.js").then(m => m.mountArchive(target));
    else if (name === "chats") import("./bot-chats.js").then(m => m.mountBotChats(target));
    else if (name === "reports") import("./reports-archive.js").then(m => m.mountReportsArchive(target));
    else if (name === "docs") mountDocs(target);
    else if (name === "logs") mountLogs(target);
    else mountSpeed(target);
  };
  root.querySelectorAll("[data-au-tab]").forEach(b => b.addEventListener("click", () => show(b.dataset.auTab)));
  show("factory");
  // F5 / «Обновить»: перечитать открытую вкладку Автоматизации.
  const onRefresh = () => {
    if (!root.isConnected) { document.removeEventListener("app:refresh", onRefresh); return; }
    const active = root.querySelector("[data-au-tab].on");
    if (!active) return;
    const name = active.dataset.auTab;
    pane.querySelector(`[data-au-pane="${name}"]`)?.remove();
    mounted[name] = false;
    show(name);
  };
  document.addEventListener("app:refresh", onRefresh);
}
