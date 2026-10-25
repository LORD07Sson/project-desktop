// Принудительное обновление: владелец задал минимальную версию, а эта старее. Сервер говорит об этом флагом
// update_required в /whoami или отказом 426 на остальные запросы (api.js шлёт событие project:update-required).
// Окно не закрывается — работать на старой версии сервер всё равно не даст; кнопка ставит обновление сразу.

import { esc } from "./utils.js";

let shown = false;

function showForceUpdate(message) {
  if (shown) return;
  shown = true;
  const box = document.createElement("div");
  box.className = "force-update";
  box.setAttribute("role", "alertdialog");
  box.innerHTML = `<div class="force-update-card">
      <div class="force-update-ic" aria-hidden="true">⬆</div>
      <h2>Нужно обновить программу</h2>
      <p>${esc(message || "Эта версия Project Desktop устарела — сервер с ней больше не работает.")}</p>
      <button type="button" class="btn primary" data-force-update>Обновить сейчас</button>
      <small data-force-status></small>
    </div>`;
  document.body.appendChild(box);
  const btn = box.querySelector("[data-force-update]");
  const status = box.querySelector("[data-force-status]");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    status.textContent = "Скачиваю обновление… Программа перезапустится сама.";
    // Окно прогресса установки — обычная модалка (z-index 50): опускаемся под неё, чтобы было видно, как качается.
    box.style.zIndex = "45";
    try {
      const m = await import("./settings.js");
      await m.installUpdate();
    } catch (e) {
      status.textContent = `Не получилось: ${e && e.message ? e.message : e}. Закройте программу (трей → «Выход») и откройте снова.`;
    }
    btn.disabled = false;
  });
}

document.addEventListener("project:update-required", ev => showForceUpdate((ev.detail || {}).message));
