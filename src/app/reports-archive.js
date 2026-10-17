// «Отчёты» (Настройки → Автоматизация): завершённые отчёты бот сам переносит в архивную группу — карточка отчёта с заметками
// и списком файлов, по теме на тайтл. Сами файлы копирует вкладка «Документы». Сервер: GET/POST /api/reports-archive
// {enabled?, target?, days?, now? (id отчёта или "all"), retry?}.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

export async function mountReportsArchive(root) {
  const load = async () => {
    let d;
    try { d = await apiGet("/reports-archive"); }
    catch (e) { root.innerHTML = `<div class="bc-warn">Не удалось загрузить: ${esc(e.message)}</div>`; return; }
    const target = d.chats.find(c => String(c.chat_id) === String(d.target));
    root.innerHTML = `
    <div class="ar" style="display:grid; gap:14px;">
      <div class="ar-card">
        <div class="ar-card-head"><h4>Архив отчётов</h4>
          <label class="ar-switch"><input type="checkbox" id="ra-enabled" ${d.enabled ? "checked" : ""}><i></i></label></div>
        <p class="ar-hint" style="margin:0;">Завершённые отчёты уезжают в архивную группу: карточка с названием, автором, датами, заметками и списком файлов — в теме своего тайтла (тема создаётся сама). Нагрузки на канал нет: это только текст. Отчёты и файлы в студии остаются как были.</p>
        <label class="ar-label" for="ra-target">Архивная группа</label>
        <select id="ra-target" class="field-input ar-select">
          <option value=""${d.target ? "" : " selected"}>— не выбрана —</option>
          ${d.chats.map(c => `<option value="${c.chat_id}"${String(c.chat_id) === String(d.target) ? " selected" : ""}>${esc(c.title)}${c.is_forum ? " · с темами" : ""} (${c.chat_id})</option>`).join("")}
        </select>
        ${target && !target.is_forum ? `<div class="bc-warn">В группе не включены темы — всё пойдёт в общую ленту.</div>` : ""}
        <label class="ar-label" for="ra-days">Переносить через (дней после завершения)</label>
        <div style="display:flex; gap:10px; align-items:center;">
          <input class="field-input" type="number" id="ra-days" min="0" max="365" value="${d.days}" style="max-width:110px;">
          <button class="btn" id="ra-days-save">Сохранить</button>
          <span class="ar-meta">0 — сразу, как только отчёт завершён</span>
        </div>
      </div>
      <div class="ar-card">
        <div class="ar-card-head"><h4>Очередь <em>${d.queue.length}</em></h4>
          <div class="ar-actions">
            ${d.queue.length ? `<button class="btn" id="ra-all">Перенести всё сейчас</button>` : ""}
            ${d.failed ? `<button class="btn" id="ra-retry">Повторить ошибки (${d.failed})</button>` : ""}
            <button class="btn" id="ra-refresh">Обновить</button>
          </div>
        </div>
        <p class="ar-hint" style="margin:0 0 8px;">Перенесено: <b>${d.done}</b>${d.failed ? ` · с ошибкой: <b>${d.failed}</b>` : ""}${d.paused ? " · <b>общая пауза архива — бот ждёт</b>" : ""}. Бот переносит по одному отчёту раз в пару минут.</p>
        ${d.queue.length ? `<div class="ar-list">${d.queue.map(r => `
          <div class="ar-row"><b>${esc(r.public_id)} · ${esc(r.title)}</b>
            <span class="ar-meta">${esc(r.title_name)} · файлов: ${r.files}${r.current ? " · переношу…" : r.failed ? " · не вышло" : r.forced ? " · сейчас" : ""}</span>
            ${r.current ? "" : `<button class="btn" data-ra-now="${r.id}">Сейчас</button>`}</div>`).join("")}</div>`
          : `<p class="ar-hint">Очередь пуста: подходящих завершённых отчётов нет.</p>`}
      </div>
    </div>`;
    const save = async (body, ok = "Сохранено.") => {
      try { await apiPost("/reports-archive", body); toast(ok, "success"); }
      catch (e) { toast(e.message, "error"); }
      load();
    };
    root.querySelector("#ra-enabled").addEventListener("change", e => save({ enabled: e.target.checked }));
    root.querySelector("#ra-target").addEventListener("change", e => save({ target: e.target.value }));
    root.querySelector("#ra-days-save").addEventListener("click", () => save({ days: root.querySelector("#ra-days").value }));
    root.querySelector("#ra-all")?.addEventListener("click", () => save({ now: "all" }, "Всё в очереди — бот перенесёт по одному."));
    root.querySelector("#ra-retry")?.addEventListener("click", () => save({ retry: true }, "Вернул в очередь."));
    root.querySelectorAll("[data-ra-now]").forEach(b => b.addEventListener("click", () => save({ now: b.dataset.raNow }, "Бот перенесёт этот отчёт следующим.")));
    root.querySelector("#ra-refresh").addEventListener("click", load);
  };
  await load();
}
