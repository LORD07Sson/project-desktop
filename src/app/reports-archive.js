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
  routes: '<path d="M5 5h5v5H5zM14 14h5v5h-5zM10 7.5h4a2 2 0 0 1 2 2V14"/>',
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
  let draft = null;        // правки маршрутов, ещё не сохранённые
  let checkResult = {};    // id маршрута → результат «Проверить на отчёте»

  const load = async () => {
    let d;
    try { d = await apiGet("/reports-archive"); }
    catch (e) { root.innerHTML = `<div class="bc-warn">Не удалось загрузить: ${esc(e.message)}</div>`; return; }
    if (!draft) draft = JSON.parse(JSON.stringify(d.routes));
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
        <label class="ar-label" for="ra-target">Общая группа <small class="ar-meta">— куда едут отчёты, не попавшие ни под один маршрут (вкладка «Маршруты»)</small></label>
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


    const strip = list => JSON.stringify(list.map(({ count, ...r }) => r));
    const dirty = strip(draft) !== strip(d.routes);
    const chatOpts = sel => `<option value="">— выберите группу —</option>${d.chats.map(c => `<option value="${c.chat_id}"${String(c.chat_id) === String(sel) ? " selected" : ""}>${esc(c.title)}${c.is_forum ? " · с темами" : " · без тем"}</option>`).join("")}`;
    const multi = (field, i, label, hint, chosen, options, noun) => `
      <div class="ar-field"><span class="ar-label">${label} <small class="ar-meta">${hint}</small></span>
        <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
          ${chosen.map(v => `<button type="button" class="btn" data-rt-del="${i}:${field}:${esc(String(v))}" title="Убрать условие">${esc((options.find(o => String(o.id) === String(v)) || { name: v }).name)} ✕</button>`).join("") || `<span class="ar-meta">любые</span>`}
          <select class="field-input ar-select" data-rt-add="${i}:${field}" style="max-width:220px;"><option value="">+ ${noun}…</option>${options.filter(o => !chosen.map(String).includes(String(o.id))).map(o => `<option value="${esc(String(o.id))}">${esc(o.name)}</option>`).join("")}</select>
        </div></div>`;
    const statusOptions = Object.entries(d.status_choices).map(([id, name]) => ({ id, name }));
    const roleOptions = d.roles.map(r => ({ id: r, name: r }));
    const paneRoutes = `
      <div class="ar-card">
        <div class="ar-card-head"><h4>Маршруты <em>${draft.length}</em></h4>
          <div class="ar-actions">
            <button class="btn" id="rt-add">+ Маршрут</button>
            <button class="btn primary" id="rt-save" ${dirty ? "" : "disabled"}>Сохранить маршруты</button>
          </div></div>
        <p class="ar-hint" style="margin:0;">Маршрут — правило «если отчёт подходит под условия → отправить в такую группу и такую схему тем». Условия внутри маршрута складываются по «И» (пусто — любые). Отчёт попадает в <b>первый подошедший сверху</b> маршрут; не подошёл ни один — едет в общую группу (она задаётся во вкладке «Настройки», там тема на тайтл, как раньше).</p>
        ${dirty ? `<div class="bc-warn">Есть несохранённые изменения.</div>` : ""}
      </div>
      ${draft.map((r, i) => `
      <div class="ar-card" data-rt="${i}">
        <div class="ar-card-head">
          <h4><span class="ar-meta">${i + 1}.</span> ${esc(r.name || "Маршрут")} <em title="сколько отчётов уже перенесено по этому маршруту">перенесено: ${r.count || 0}</em></h4>
          <div class="ar-actions">
            <button class="btn" data-rt-up="${i}" ${i === 0 ? "disabled" : ""} title="Приоритет выше">↑</button>
            <button class="btn" data-rt-down="${i}" ${i === draft.length - 1 ? "disabled" : ""} title="Приоритет ниже">↓</button>
            <button class="btn" data-rt-remove="${i}">Удалить</button>
          </div>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px;">
          <div><span class="ar-label">Название</span><input class="field-input" data-rt-f="${i}:name" value="${esc(r.name || "")}"></div>
          <div><span class="ar-label">Группа</span><select class="field-input ar-select" data-rt-f="${i}:target">${chatOpts(r.target)}</select></div>
          <div><span class="ar-label">Схема тем <small class="ar-meta">как раскладывать внутри группы</small></span>
            <select class="field-input ar-select" data-rt-f="${i}:scheme">${Object.entries(d.schemes).map(([k, l]) => `<option value="${k}"${r.scheme === k ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
          <div><span class="ar-label">Префикс темы <small class="ar-meta">необязательно</small></span><input class="field-input" data-rt-f="${i}:prefix" value="${esc(r.prefix || "")}" placeholder="например: Архив"></div>
        </div>
        <p class="ar-hint" style="margin:6px 0 8px;">${{ title: "Для каждого тайтла своя тема.", status: "Для каждого статуса своя тема: «Завершено», «Отменено»…", single: "Все отчёты маршрута падают в одну тему «Отчёты»." }[r.scheme] || ""}</p>
        <span class="ar-label">Условия <small class="ar-meta">пусто — подходит любой</small></span>
        ${multi("titles", i, "Тайтл", "", r.titles || [], d.titles, "тайтл")}
        ${multi("statuses", i, "Статус", "", r.statuses || [], statusOptions, "статус")}
        ${multi("roles", i, "Роль", "кем сделан отчёт (озвучка, звук…)", r.roles || [], roleOptions, "роль")}
        ${multi("authors", i, "Автор", "", r.authors || [], d.users, "автора")}
        <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px;">
          <input class="field-input" data-rt-check-id="${i}" placeholder="R-000022" style="max-width:150px;">
          <button class="btn" data-rt-check="${i}" title="Показать, куда этот отчёт уедет сейчас (по сохранённым маршрутам)">Проверить на отчёте</button>
          ${checkResult[r.id] ? `<span class="ar-meta">${checkResult[r.id]}</span>` : ""}
        </div>
      </div>`).join("")}
      <div class="ar-card">
        <h4>Общая группа (по умолчанию) <em>перенесено: ${d.default_count}</em></h4>
        <p class="ar-hint" style="margin:0;">${target ? `Сюда едут отчёты, не попавшие ни под один маршрут: <b>${esc(target.title)}</b>, тема на тайтл.` : "Общая группа не задана — отчёты без подходящего маршрута никуда не поедут."} Меняется во вкладке «Настройки».</p>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px;">
          <input class="field-input" id="rt-check-default" placeholder="R-000022" style="max-width:150px;">
          <button class="btn" id="rt-check-any">Проверить на отчёте</button>
          ${checkResult.any ? `<span class="ar-meta">${checkResult.any}</span>` : ""}
        </div>
      </div>`;

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
        <button data-ra-tab="routes">${icon("routes")}Маршруты${d.routes.length ? `<em>${d.routes.length}</em>` : ""}</button>
        <button data-ra-tab="log">${icon("log")}Журнал</button>
      </div>
      ${tab === "settings" ? paneSettings : tab === "queue" ? paneQueue : tab === "routes" ? paneRoutes : paneLog}
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
    // ---- маршруты ----
    const repaint = () => load();
    const field = (i, key) => draft[i][key];
    root.querySelectorAll("[data-rt-f]").forEach(el => el.addEventListener("change", () => {
      const [i, key] = el.dataset.rtF.split(":");
      draft[Number(i)][key] = el.value;
      if (key === "scheme") repaint();
    }));
    root.querySelectorAll("[data-rt-add]").forEach(el => el.addEventListener("change", () => {
      if (!el.value) return;
      const [i, key] = el.dataset.rtAdd.split(":");
      const v = ["titles", "authors"].includes(key) ? Number(el.value) : el.value;
      draft[Number(i)][key] = [...(draft[Number(i)][key] || []), v];
      repaint();
    }));
    root.querySelectorAll("[data-rt-del]").forEach(b => b.addEventListener("click", () => {
      const [i, key, v] = b.dataset.rtDel.split(":");
      draft[Number(i)][key] = (draft[Number(i)][key] || []).filter(x => String(x) !== v);
      repaint();
    }));
    root.querySelectorAll("[data-rt-up]").forEach(b => b.addEventListener("click", () => { const i = Number(b.dataset.rtUp); [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]]; repaint(); }));
    root.querySelectorAll("[data-rt-down]").forEach(b => b.addEventListener("click", () => { const i = Number(b.dataset.rtDown); [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]]; repaint(); }));
    root.querySelectorAll("[data-rt-remove]").forEach(b => b.addEventListener("click", () => { draft.splice(Number(b.dataset.rtRemove), 1); repaint(); }));
    q("#rt-add")?.addEventListener("click", () => {
      draft.push({ id: `r${Date.now().toString(36)}`, name: `Маршрут ${draft.length + 1}`, target: "", scheme: "title", prefix: "", titles: [], statuses: [], roles: [], authors: [] });
      repaint();
    });
    q("#rt-save")?.addEventListener("click", async () => {
      try {
        await apiPost("/reports-archive", { routes: draft.map(({ count, ...r }) => r) });
        toast("Маршруты сохранены.", "success");
        draft = null;
      } catch (e) { toast(e.message, "error"); }
      load();
    });
    const runCheck = async (id, key) => {
      try {
        const r = await apiPost("/reports-archive/check", { public_id: id });
        checkResult[key] = r.ok
          ? `${esc(r.facts.title)} · ${esc(r.facts.status)} → <b>${esc(r.route)}${r.default ? " (общая группа)" : ""}</b>, тема «${esc(r.topic)}» (${esc(r.scheme)})${r.facts.done ? " — уже перенесён" : ""}`
          : esc(r.message);
      } catch (e) { checkResult[key] = esc(e.message); }
      load();
    };
    root.querySelectorAll("[data-rt-check]").forEach(b => b.addEventListener("click", () => {
      const i = Number(b.dataset.rtCheck);
      runCheck(root.querySelector(`[data-rt-check-id="${i}"]`).value, draft[i].id);
    }));
    q("#rt-check-any")?.addEventListener("click", () => runCheck(q("#rt-check-default").value, "any"));

    root.querySelectorAll("[data-ra-now]").forEach(b => b.addEventListener("click", () => save({ now: b.dataset.raNow }, "Бот перенесёт этот отчёт следующим.")));
    root.querySelectorAll("[data-ra-skip]").forEach(b => b.addEventListener("click", () => save({ skip: b.dataset.raSkip }, "Отчёт исключён из переноса.")));
    root.querySelectorAll("[data-ra-unskip]").forEach(b => b.addEventListener("click", () => save({ unskip: b.dataset.raUnskip }, "Отчёт снова в очереди.")));
  };
  await load();
}
