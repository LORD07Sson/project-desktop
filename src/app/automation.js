// «Автоматизация» (Настройки, владелец): всё, что бот делает сам, в одном месте — архив серий, чаты бота и ограничения скорости.
// Вкладки собраны в том же стиле, что «Архив серий»; каждая вкладка подгружается при первом открытии.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const TABS = [
  ["archive", "Архив серий", '<path d="M4 7h16M6 7v11h12V7M10 11h4"/>'],
  ["chats", "Чаты бота", '<path d="M4 5h16v11H9l-5 4z"/>'],
  ["docs", "Документы", '<path d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6"/>'],
  ["speed", "Скорость", '<path d="M12 14l4-5M4 17a8 8 0 1 1 16 0"/>'],
];
const svg = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

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
    </div>`;

  root.querySelectorAll("[data-sp-preset]").forEach(b => b.addEventListener("click", () => {
    const [key, v] = b.dataset.spPreset.split(":");
    root.querySelector(`#sp-${key}`).value = v;
  }));
  root.querySelectorAll("[data-sp-save]").forEach(b => b.addEventListener("click", async () => {
    const key = b.dataset.spSave;
    const v = Number(root.querySelector(`#sp-${key}`).value);
    b.disabled = true;
    try {
      const r = await apiPost("/speed", { [key]: v });
      toast(`Сохранено: ${r[key + "_mbit"] || "без ограничения"}${r[key + "_mbit"] ? " Мбит/с" : ""}.`, "success");
    } catch (e) { toast(`Не сохранилось: ${e.message}`, "error"); }
    finally { b.disabled = false; }
  }));
}

const STATE = { done: "отправлен", failed: "ошибка", retry: "повтор" };

async function mountDocs(root) {
  const load = async () => {
    let d;
    try { d = await apiGet("/docs-archive"); }
    catch (e) { root.innerHTML = `<div class="bc-warn">Не удалось загрузить: ${esc(e.message)}</div>`; return; }
    const target = d.chats.find(c => String(c.chat_id) === String(d.target));
    root.innerHTML = `
    <div class="ar" style="display:grid; gap:14px;">
      <div class="ar-card">
        <div class="ar-card-head"><h4>Архив документов</h4>
          <label class="ar-switch"><input type="checkbox" id="dc-enabled" ${d.enabled ? "checked" : ""}><i></i></label></div>
        <p class="ar-hint" style="margin:0;">Файлы отчётов — озвучка, субтитры, надписи, торренты, архивы — бот копирует в архивную группу, по теме на тайтл. Файлы уже в Telegram, поэтому копирование мгновенное и не нагружает канал; файлы с диска сервера заливаются с лимитом скорости (${d.limit_mbit ? `${d.limit_mbit} Мбит/с` : "без ограничения"}, вкладка «Скорость»).</p>
        <label class="ar-label" for="dc-target">Архивная группа</label>
        <select id="dc-target" class="field-input ar-select">
          <option value=""${d.target ? "" : " selected"}>— не выбрана —</option>
          ${d.chats.map(c => `<option value="${c.chat_id}"${String(c.chat_id) === String(d.target) ? " selected" : ""}>${esc(c.title)}${c.is_forum ? " · с темами" : ""} (${c.chat_id})</option>`).join("")}
        </select>
        ${target && !target.is_forum ? `<div class="bc-warn">В группе не включены темы — всё пойдёт в общую ленту.</div>` : ""}
      </div>
      <div class="ar-card">
        <h4>Что архивировать</h4>
        ${Object.entries(d.kind_labels).map(([k, label]) => `
        <label class="bcn-feature"><span>${esc(label)}</span><span class="ar-switch sm"><input type="checkbox" data-dc-kind="${k}" ${d.kinds.includes(k) ? "checked" : ""}><i></i></span></label>`).join("")}
        <label class="bcn-feature"><span>Включая файлы, накопившиеся раньше (иначе только новые)</span><span class="ar-switch sm"><input type="checkbox" id="dc-backfill" ${d.backfill ? "checked" : ""}><i></i></span></label>
      </div>
      <div class="ar-card">
        <div class="ar-card-head"><h4>Очередь <em>${d.pending}</em></h4>
          <div class="ar-actions">
            <button class="btn" id="dc-pause">${d.paused ? "▶ Снять паузу" : "⏸ Пауза"}</button>
            ${d.failed ? `<button class="btn" id="dc-retry">Повторить ошибки (${d.failed})</button>` : ""}
            <button class="btn" id="dc-refresh">Обновить</button>
          </div>
        </div>
        <p class="ar-hint" style="margin:0 0 8px;">Отправлено: <b>${d.done}</b>${d.failed ? ` · ошибок: <b>${d.failed}</b>` : ""}${d.paused ? " · <b>на паузе</b>" : ""}. Бот отправляет по одному файлу раз в несколько секунд, порциями.</p>
        ${d.recent.length ? `<div class="ar-list">${d.recent.map(r => `
          <div class="ar-row"><b>${esc(r.public_id || "")} · ${esc(r.name || r.type || "файл")}</b><span class="ar-meta">${esc(STATE[r.state] || r.state)}${r.error ? ` — ${esc(r.error)}` : ""}</span></div>`).join("")}</div>` : `<p class="ar-hint">Пока ничего не отправлено.</p>`}
      </div>
    </div>`;
    const save = async body => {
      try { await apiPost("/docs-archive", body); toast("Сохранено.", "success"); }
      catch (e) { toast(e.message, "error"); }
      load();
    };
    root.querySelector("#dc-enabled").addEventListener("change", e => save({ enabled: e.target.checked }));
    root.querySelector("#dc-target").addEventListener("change", e => save({ target: e.target.value }));
    root.querySelector("#dc-backfill").addEventListener("change", e => save({ backfill: e.target.checked }));
    root.querySelectorAll("[data-dc-kind]").forEach(c => c.addEventListener("change", () =>
      save({ kinds: [...root.querySelectorAll("[data-dc-kind]:checked")].map(x => x.dataset.dcKind) })));
    root.querySelector("#dc-pause").addEventListener("click", () => save({ paused: !d.paused }));
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
    if (name === "archive") import("./archive.js").then(m => m.mountArchive(host));
    else if (name === "chats") import("./bot-chats.js").then(m => m.mountBotChats(host));
    else if (name === "docs") mountDocs(host);
    else mountSpeed(host);
  };
  root.querySelectorAll("[data-au-tab]").forEach(b => b.addEventListener("click", () => show(b.dataset.auTab)));
  show("archive");
}
