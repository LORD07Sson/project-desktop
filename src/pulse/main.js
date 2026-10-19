// Точка входа страницы «Пульс»: ждёт данные от приложения и запускает сцену. Принимает сообщения только от родительского
// окна того же origin.

import { startPulse } from "./pulse.js";

let started = false;

function showEmpty(text) {
  const wrap = document.querySelector("#wrap");
  wrap.innerHTML = `<div class="pl-empty"><b>Пульс пока пуст</b>${text}</div>`;
}

window.addEventListener("message", ev => {
  if (ev.origin !== window.location.origin || ev.source !== window.parent) return;
  const msg = ev.data;
  if (!msg || msg.source !== "app" || started) return;
  if (msg.type === "pulse-error") { started = true; showEmpty(String(msg.text || "Не удалось загрузить данные.")); return; }
  if (msg.type !== "pulse-data" || !msg.data) return;
  started = true;
  const data = msg.data;
  const month = new Date(`${data.today}T00:00:00`).toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
  const live = document.querySelector("#liveTxt");
  if (live) live.textContent = `${month} · команда ${data.people.length}`;
  if (!data.titles.length) { showEmpty("Когда появятся серии в работе, здесь будет живая карта студии."); return; }
  startPulse(data);
});

window.parent.postMessage({ source: "pulse", type: "ready" }, window.location.origin);
