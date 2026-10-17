// «Отчёты» (Настройки → Автоматизация): завершённые отчёты бот сам переносит в архивную группу — карточка отчёта с заметками
// и списком файлов, по теме на тайтл. Сами файлы копирует вкладка «Документы». Устроено как «Архив серий»: вкладки
// «Настройки / Очередь / Журнал» и сводка счётчиков.
// Сервер: GET/POST /api/reports-archive {enabled?, target?, days?, statuses?, skip_titles?, hold_notes?, load_guard?,
// window? {from,to}, batch?, skip? (id), unskip? (id), now? (id | "all"), retry?}.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const ICON = {
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  queue: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  log: '<path d="M6 3h9l4 4v14H6zM9 12h7M9 16h7M9 8h3"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

const when = ts => {
  const d = new Date(ts * 1000);
  return `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const hourOptions = cur => `<option value=""${cur === null || cur === undefined ? " selected" : ""}>—</option>` +
  Array.from({ length: 24 }, (_, h) => `<option value="${h}"${cur === h ? " selected" : ""}>${String(h).padStart(2, "0")}:00</option>`).join("");

export async function mountReportsArchive(root) {
  let tab = "settings";

  const load = async () => {
    let d;
    try { d = await apiGet("/reports-archive"); }
    catch (e) { root.innerHTML = `<div class="bc-warn">Не удалось загрузить: ${esc(e.message)}</div>`; return; }
    const target = d.chats.find(c => String(c.chat_id) === String(d.target));
    const skipTitles = new Set(d.skip_titles);
    const windowOn = d.win_from !== null && d.win_to !== null;

    const stat = (n, label, warn) => `<div class="ar-card" style="padding:12px 16px;"><b style="font-size:22px;${warn ? "color:var(--danger,#ff6b6b);" : ""}">${n}</b><div class="ar-meta">${label}</div></div>`;

    const statePill = d.enabled
      ? (d.paused ? "на общей паузе" : d.busy ? "сервер занят — жду" : !d.in_window ? "вне окна времени" : d.current ? `переношу ${esc(d.current)}` : "работает")
      : "выключен";

    const paneSettings = `
      <div class="ar-card">
        <div class="ar-card-head"><h4>Архив отчётов</h4>
          <label class="ar-switch"><input type="checkbox" id="ra-enabled" ${d.enabled ? "checked" : ""}><i></i></label></div>
        <p class="ar-hint" style="margin:0;">Отчёты уезжают в архивную группу: карточка с названием, автором, датами, заметками и списком файлов — в теме своего тайтла (тема создаётся сама). Это только текст, нагрузки на канал нет. Отчёты и файлы в студии остаются как были.</p>
        <label class="ar-label" for="ra-target">Архивная группа</label>
        <select id="ra-target" class="field-input ar-select">
          <option value=""${d.target ? "" : " selected"}>— не выбрана —</option>
          ${d.chats.map(c => `<option value="${c.chat_id}"${String(c.chat_id) === String(d.target) ? " selected" : ""}>${esc(c.title)}${c.is_forum ? " · с темами" : ""} (${c.chat_id})</option>`).join("")}
        </select>
        ${target && !target.is_forum ? `<div class="bc-warn">В группе не включены темы — всё пойдёт в общую ленту.</div>` : ""}
      </div>
      <div class="ar-card">
        <h4>Что переносить</h4>
        <span class="ar-label">Статусы отчётов</span>
        ${Object.entries(d.status_choices).map(([k, label]) => `
        <label class="bcn-feature"><span>${esc(label)}</span><span class="ar-switch sm"><input type="checkbox" data-ra-status="${k}" ${d.statuses.includes(k) ? "checked" : ""}><i></i></span></label>`).join("")}
        <label class="ar-label" for="ra-days">Переносить через (дней после последнего изменения)</label>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <input class="field-input" type="number" id="ra-days" min="0" max="365" value="${d.days}" style="max-width:110px;">
          <button class="btn" id="ra-days-save">Сохранить</button>
          <span class="ar-meta">0 — сразу</span>
        </div>
        <label class="bcn-feature" style="margin-top:10px;"><span>Не переносить отчёты с заметками <small class="ar-meta">— сначала разберитесь с ними</small></span><span class="ar-switch sm"><input type="checkbox" id="ra-hold" ${d.hold_notes ? "checked" : ""}><i></i></span></label>
        <span class="ar-label">Тайтлы-исключения <small class="ar-meta">— их отчёты не переносятся</small></span>
        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          ${d.skip_titles.map(id => {
            const t = d.titles.find(x => x.id === id);
            return `<button type="button" class="btn" data-ra-unskip-title="${id}" title="Убрать из исключений">${esc(t ? t.name : `№${id}`)} ✕</button>`;
          }).join("") || `<span class="ar-meta">нет</span>`}
          <select id="ra-skip-title" class="field-input ar-select" style="max-width:260px;">
            <option value="">+ добавить тайтл…</option>
            ${d.titles.filter(t => !skipTitles.has(t.id)).map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}
          </select>
        </div>
      </div>
      <div class="ar-card">
        <h4>Когда и как быстро</h4>
        <span class="ar-label">Окно времени <small class="ar-meta">по Москве; вне окна бот не переносит, кроме кнопки «Сейчас»</small></span>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          с <select id="ra-win-from" class="field-input" style="max-width:110px;">${hourOptions(d.win_from)}</select>
          до <select id="ra-win-to" class="field-input" style="max-width:110px;">${hourOptions(d.win_to)}</select>
          <button class="btn" id="ra-win-save">Сохранить</button>
          ${windowOn ? `<button class="btn" id="ra-win-clear">В любое время</button>` : `<span class="ar-meta">сейчас — в любое время</span>`}
        </div>
        <label class="ar-label" for="ra-batch">Отчётов за один запуск (раз в 2 минуты)</label>
        <div style="display:flex; gap:10px; align-items:center;">
          <input class="field-input" type="number" id="ra-batch" min="1" max="10" value="${d.batch}" style="max-width:110px;">
          <button class="btn" id="ra-batch-save">Сохранить</button>
        </div>
        <label class="bcn-feature" style="margin-top:10px;"><span>Не переносить, пока сервер занят <small class="ar-meta">— идёт сборка финала или высокая нагрузка</small></span><span class="ar-switch sm"><input type="checkbox" id="ra-guard" ${d.load_guard ? "checked" : ""}><i></i></span></label>
        <p class="ar-hint" style="margin:6px 0 0;">Общая пауза архива («Архив серий») действует и здесь.</p>
      </div>`;

    const paneQueue = `
      <div class="ar-card">
        <div class="ar-card-head"><h4>Очередь <em>${d.queue.length}</em></h4>
          <div class="ar-actions">
            ${d.queue.length ? `<button class="btn" id="ra-all">Перенести всё сейчас</button>` : ""}
            ${d.failed ? `<button class="btn" id="ra-retry">Повторить ошибки (${d.failed})</button>` : ""}
            <button class="btn" id="ra-refresh">Обновить</button>
          </div>
        </div>
        <p class="ar-hint" style="margin:0 0 8px;">Порядок — самые давние первыми. В колонке справа — когда отчёт уедет по сроку и окну времени.</p>
        ${d.queue.length ? `<div class="ar-list">${d.queue.slice(0, 40).map((r, i) => `
          <div class="ar-row"><b>${esc(r.public_id)} · ${esc(r.title)}</b>
            <span class="ar-meta">${esc(r.title_name)} · файлов: ${r.files} · ${r.current ? "переношу…" : r.failed ? "не вышло (3 попытки)" : r.forced ? "сейчас" : `уедет ≈ ${esc(r.eta)}`}</span>
            ${r.current ? "" : `<button class="btn" data-ra-now="${r.id}" title="Перенести без ожидания">Сейчас</button><button class="btn" data-ra-skip="${r.id}" title="Исключить этот отчёт из переноса">Исключить</button>`}</div>`).join("")}</div>`
          : `<p class="ar-hint">Очередь пуста: подходящих отчётов нет.</p>`}
      </div>
      ${d.skipped.length ? `<div class="ar-card"><h4>Исключено вручную <em>${d.skipped.length}</em></h4>
        <div class="ar-list">${d.skipped.map(r => `<div class="ar-row"><b>${esc(r.public_id)} · ${esc(r.title)}</b><button class="btn" data-ra-unskip="${r.id}">Вернуть</button></div>`).join("")}</div></div>` : ""}`;

    const paneLog = `
      <div class="ar-card">
        <h4>Журнал переносов <em>${d.log.length}</em></h4>
        ${d.log.length ? `<div class="ar-list">${d.log.map(e => `
          <div class="ar-row"><b>${e.ok ? "✅" : "❌"} ${esc(e.public_id)}</b>
            <span class="ar-meta">${esc(when(e.at))}${e.ok ? ` · файлов в карточке: ${e.files}` : ` — ${esc(e.error)}`}</span>
            ${e.ok && e.link ? `<a class="btn" href="${esc(e.link)}" target="_blank" rel="noopener">Тема</a>` : ""}</div>`).join("")}</div>`
          : `<p class="ar-hint">Пока ничего не переносилось.</p>`}
      </div>`;

    root.innerHTML = `
    <div class="ar" style="display:grid; gap:14px;">
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px;">
        ${stat(d.today, "перенесено сегодня")}${stat(d.done, "всего перенесено")}${stat(d.queue.length, "в очереди")}${stat(d.failed + d.today_failed, "ошибок", d.failed + d.today_failed > 0)}
      </div>
      <p class="ar-hint" style="margin:0;">Состояние: <b>${statePill}</b></p>
      <div class="ar-tabs" role="tablist">
        <button data-ra-tab="settings">${icon("settings")}Настройки</button>
        <button data-ra-tab="queue">${icon("queue")}Очередь${d.queue.length ? `<em>${d.queue.length}</em>` : ""}</button>
        <button data-ra-tab="log">${icon("log")}Журнал</button>
      </div>
      ${tab === "settings" ? paneSettings : tab === "queue" ? paneQueue : paneLog}
    </div>`;

    root.querySelectorAll("[data-ra-tab]").forEach(b => {
      b.classList.toggle("on", b.dataset.raTab === tab);
      b.addEventListener("click", () => { tab = b.dataset.raTab; load(); });
    });
    const save = async (body, ok = "Сохранено.") => {
      try { await apiPost("/reports-archive", body); toast(ok, "success"); }
      catch (e) { toast(e.message, "error"); }
      load();
    };
    const q = sel => root.querySelector(sel);
    q("#ra-enabled")?.addEventListener("change", e => save({ enabled: e.target.checked }));
    q("#ra-target")?.addEventListener("change", e => save({ target: e.target.value }));
    q("#ra-days-save")?.addEventListener("click", () => save({ days: q("#ra-days").value }));
    q("#ra-hold")?.addEventListener("change", e => save({ hold_notes: e.target.checked }));
    q("#ra-guard")?.addEventListener("change", e => save({ load_guard: e.target.checked }));
    root.querySelectorAll("[data-ra-status]").forEach(c => c.addEventListener("change", () =>
      save({ statuses: [...root.querySelectorAll("[data-ra-status]:checked")].map(x => x.dataset.raStatus) })));
    q("#ra-skip-title")?.addEventListener("change", e => { if (e.target.value) save({ skip_titles: [...d.skip_titles, Number(e.target.value)] }); });
    root.querySelectorAll("[data-ra-unskip-title]").forEach(b => b.addEventListener("click", () =>
      save({ skip_titles: d.skip_titles.filter(x => String(x) !== b.dataset.raUnskipTitle) })));
    q("#ra-win-save")?.addEventListener("click", () => save({ window: { from: q("#ra-win-from").value, to: q("#ra-win-to").value } }));
    q("#ra-win-clear")?.addEventListener("click", () => save({ window: { from: "", to: "" } }));
    q("#ra-batch-save")?.addEventListener("click", () => save({ batch: q("#ra-batch").value }));
    q("#ra-all")?.addEventListener("click", () => save({ now: "all" }, "Всё в очереди — бот перенесёт по одному."));
    q("#ra-retry")?.addEventListener("click", () => save({ retry: true }, "Вернул в очередь."));
    q("#ra-refresh")?.addEventListener("click", load);
    root.querySelectorAll("[data-ra-now]").forEach(b => b.addEventListener("click", () => save({ now: b.dataset.raNow }, "Бот перенесёт этот отчёт следующим.")));
    root.querySelectorAll("[data-ra-skip]").forEach(b => b.addEventListener("click", () => save({ skip: b.dataset.raSkip }, "Отчёт исключён из переноса.")));
    root.querySelectorAll("[data-ra-unskip]").forEach(b => b.addEventListener("click", () => save({ unskip: b.dataset.raUnskip }, "Отчёт снова в очереди.")));
  };
  await load();
}
