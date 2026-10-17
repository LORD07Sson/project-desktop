// «Автоматизация» (Настройки, владелец): всё, что бот делает сам, в одном месте — архив серий, чаты бота и ограничения скорости.
// Вкладки собраны в том же стиле, что «Архив серий»; каждая вкладка подгружается при первом открытии.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const TABS = [
  ["overview", "Обзор", '<path d="M4 5h7v7H4zM13 5h7v4h-7zM13 11h7v8h-7zM4 14h7v5H4z"/>'],
  ["archive", "Архив серий", '<path d="M4 7h16M6 7v11h12V7M10 11h4"/>'],
  ["chats", "Чаты бота", '<path d="M4 5h16v11H9l-5 4z"/>'],
  ["reports", "Отчёты", '<path d="M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3"/>'],
  ["docs", "Документы", '<path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6"/>'],
  ["speed", "Скорость", '<path d="M12 14l4-5M4 17a8 8 0 1 1 16 0"/>'],
  ["logs", "Логи", '<path d="M5 4h14v16H5zM8 9h8M8 13h8M8 17h5"/>'],
];
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
        <span class="ar-meta">Мбит/с · 0 — без ограничения</span>
        <button type="button" class="btn" data-sp-preset="${key}:45">45</button>
        <button type="button" class="btn" data-sp-preset="${key}:30">30</button>
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
          <span class="ar-switch sm"><input type="checkbox" id="sp-night-on" ${d.night_on ? "checked" : ""}><i></i></span></div>
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
          <span class="ar-switch sm"><input type="checkbox" data-dc-on ${r.on ? "checked" : ""}><i></i></span>
        </div>`).join("")}
        <button class="btn" id="dc-rules-save" style="margin-top:8px;">Сохранить размеры</button>
      </div>

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
    root.querySelector("#dc-enabled").addEventListener("change", e => save({ enabled: e.target.checked }));
    root.querySelector("#dc-target").addEventListener("change", e => save({ target: e.target.value }));
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
    <div class="ar-tabs" role="tablist">
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
    if (name === "overview") mountOverview(host, show);
    else if (name === "archive") import("./archive.js").then(m => m.mountArchive(host));
    else if (name === "chats") import("./bot-chats.js").then(m => m.mountBotChats(host));
    else if (name === "reports") import("./reports-archive.js").then(m => m.mountReportsArchive(host));
    else if (name === "docs") mountDocs(host);
    else if (name === "logs") mountLogs(host);
    else mountSpeed(host);
  };
  root.querySelectorAll("[data-au-tab]").forEach(b => b.addEventListener("click", () => show(b.dataset.auTab)));
  show("overview");
}
