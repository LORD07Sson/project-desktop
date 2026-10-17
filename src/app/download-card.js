// Карточка скачивания файла: полоса прогресса, итог и «Показать в папке». Rust шлёт события download-progress
// {job, done, total}; по завершении проводник открывается сразу, а в карточке остаётся кнопка на случай, если окно закрыли.

import { invoke, listen } from "./tauri.js";
import { state } from "./state.js";
import { esc } from "./utils.js";
import { revealInFolder } from "./tauri.js";

let seq = 0;

function root() {
  let el = document.getElementById("dl-root");
  if (!el) {
    el = document.createElement("div");
    el.id = "dl-root";
    document.body.appendChild(el);
  }
  return el;
}

function fmt(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} ГБ`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** command — имя tauri-команды скачивания, args — её аргументы без job; savePath — куда сохраняем. Возвращает true при успехе. */
export async function downloadWithCard({ command, args, savePath, name }) {
  const job = `dl-${Date.now()}-${++seq}`;
  const card = document.createElement("div");
  card.className = "dl-card";
  card.innerHTML = `<div class="dl-head"><b>⬇ ${esc(name || "Файл")}</b><button type="button" class="dl-x" title="Скрыть" aria-label="Скрыть">✕</button></div>
    <div class="dl-bar"><i></i></div><div class="dl-note">Скачиваю…</div><div class="dl-act"></div>`;
  root().appendChild(card);
  const bar = card.querySelector(".dl-bar i");
  const note = card.querySelector(".dl-note");
  const act = card.querySelector(".dl-act");
  card.querySelector(".dl-x").addEventListener("click", () => card.remove());
  const started = Date.now();
  const unlisten = await listen("download-progress", ev => {
    const p = ev.payload || {};
    if (p.job !== job) return;
    if (p.total > 0) {
      bar.style.width = `${Math.min(100, (p.done / p.total) * 100)}%`;
      const sec = Math.max(1, (Date.now() - started) / 1000);
      note.textContent = `${fmt(p.done)} из ${fmt(p.total)} · ${(p.done / sec / 1048576).toFixed(1)} МБ/с`;
    } else {
      bar.classList.add("indet");
      note.textContent = `Скачано ${fmt(p.done)}`;
    }
  });
  card.classList.add("busy");
  // Пока сервер достаёт файл из архива Telegram, байтов ещё нет — полоса бегает, чтобы было видно, что идёт работа.
  bar.classList.add("indet");
  note.textContent = "Скачиваю… (если файла нет в кэше, сервер достаёт его из архива Telegram — это может занять минуту)";
  try {
    await invoke(command, { ...args, initData: state.token || "", savePath, job });
    bar.classList.remove("indet");
    bar.style.width = "100%";
    card.classList.remove("busy");
    card.classList.add("ok");
    note.textContent = `Сохранено: ${savePath}`;
    act.innerHTML = `<button type="button" class="btn dl-reveal">📂 Показать в папке</button>`;
    act.querySelector(".dl-reveal").addEventListener("click", () => revealInFolder(savePath));
    revealInFolder(savePath).catch(() => { /* кнопка остаётся */ });
    setTimeout(() => card.remove(), 60000);
    return true;
  } catch (e) {
    bar.classList.remove("indet");
    card.classList.remove("busy");
    card.classList.add("err");
    note.textContent = `Не удалось скачать: ${e}`;
    return false;
  } finally {
    unlisten();
  }
}
