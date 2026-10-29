// Принудительное обновление: владелец задал минимальную версию, а эта старее. Сервер говорит об этом флагом
// update_required в /whoami или отказом 426 на остальные запросы (api.js шлёт событие project:update-required).
// Окно не закрывается — работать на старой версии сервер всё равно не даст; кнопка ставит обновление сразу.
// До настроек отсюда не добраться, поэтому всё, что может понадобиться, — прямо в окне: откуда качать (GitHub
// у части людей не открывается — тогда «Сервер»), «Переустановить начисто» и установщик в браузере.

import { esc } from "./utils.js";
import { API_BASE } from "./api.js";
import { invoke, openExternal } from "./tauri.js";

let shown = false;

const SOURCES = [["auto", "Авто: GitHub, если не открывается — сервер"], ["github", "GitHub"], ["server", "Сервер"]];

async function setupUrl() {
  let channel = "stable";
  try { channel = await invoke("get_update_channel"); } catch (_) { /* старая сборка — стабильный канал */ }
  const origin = API_BASE.replace(/\/api$/, "");
  return channel === "alpha" ? `${origin}/updates/alpha/ProjectDesktop-alpha-Setup.exe` : `${origin}/updates/stable/ProjectDesktop-win-Setup.exe`;
}

async function showForceUpdate(message) {
  if (shown) return;
  shown = true;
  let source = "auto";
  try { source = await invoke("get_update_source"); } catch (_) { /* команды нет — источник не выбрать */ }
  const box = document.createElement("div");
  box.className = "force-update";
  box.setAttribute("role", "alertdialog");
  box.innerHTML = `<div class="force-update-card">
      <div class="force-update-ic" aria-hidden="true">⬆</div>
      <h2>Нужно обновить программу</h2>
      <p>${esc(message || "Эта версия Project Desktop устарела — сервер с ней больше не работает.")}</p>
      <label class="force-update-src"><span>Откуда скачивать</span>
        <select data-force-source>${SOURCES.map(([k, v]) => `<option value="${k}"${k === source ? " selected" : ""}>${v}</option>`).join("")}</select>
      </label>
      <button type="button" class="btn primary" data-force-update>Обновить сейчас</button>
      <small data-force-status></small>
      <div class="force-update-more">
        <button type="button" class="btn ghost sm" data-force-reinstall>Переустановить начисто</button>
        <button type="button" class="btn ghost sm" data-force-setup>Скачать установщик в браузере</button>
      </div>
    </div>`;
  document.body.appendChild(box);
  const btn = box.querySelector("[data-force-update]");
  const status = box.querySelector("[data-force-status]");
  // Окна прогресса и подтверждения — обычные модалки (z-index 50): опускаемся под них, пока они открыты.
  const lower = () => { box.style.zIndex = "45"; };
  box.querySelector("[data-force-source]").addEventListener("change", async e => {
    try {
      await invoke("set_update_source", { source: e.target.value });
      status.textContent = e.target.value === "server" ? "Буду качать с сервера." : e.target.value === "github" ? "Буду качать с GitHub." : "Сначала GitHub, при сбое — сервер.";
    } catch (err) { status.textContent = `Источник не сменить в этой версии — нажмите «Скачать установщик в браузере». (${err})`; }
  });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    status.textContent = "Скачиваю обновление… Программа перезапустится сама.";
    lower();
    try {
      const m = await import("./settings.js");
      await m.installUpdate();
      status.textContent = "Не вышло? Выберите «Сервер» выше и нажмите ещё раз — или «Переустановить начисто».";
    } catch (e) {
      status.textContent = `Не получилось: ${e && e.message ? e.message : e}. Выберите «Сервер» выше или «Переустановить начисто».`;
    }
    btn.disabled = false;
  });
  box.querySelector("[data-force-reinstall]").addEventListener("click", async () => {
    lower();
    try {
      const m = await import("./settings.js");
      await m.reinstallApp();
    } catch (e) { status.textContent = `Не получилось: ${e && e.message ? e.message : e}`; }
  });
  box.querySelector("[data-force-setup]").addEventListener("click", async () => {
    const url = await setupUrl();
    openExternal(url);
    status.textContent = "Скачайте установщик, закройте программу (трей → «Выход») и запустите его — встанет поверх.";
  });
}

document.addEventListener("project:update-required", ev => showForceUpdate((ev.detail || {}).message));
