// «Автоматизация» (Настройки, владелец): всё, что бот делает сам, в одном месте — архив серий, чаты бота и ограничения скорости.
// Вкладки собраны в том же стиле, что «Архив серий»; каждая вкладка подгружается при первом открытии.

import { apiGet, apiPost, toast } from "./api.js";
import { esc } from "./utils.js";

const TABS = [
  ["archive", "Архив серий", '<path d="M4 7h16M6 7v11h12V7M10 11h4"/>'],
  ["chats", "Чаты бота", '<path d="M4 5h16v11H9l-5 4z"/>'],
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
    else mountSpeed(host);
  };
  root.querySelectorAll("[data-au-tab]").forEach(b => b.addEventListener("click", () => show(b.dataset.auTab)));
  show("archive");
}
