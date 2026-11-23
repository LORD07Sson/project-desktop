
import { invoke, listen } from "./tauri.js";
import { state } from "./state.js";
import { esc } from "./utils.js";
import { revealInFolder } from "./tauri.js";
import { dlButton } from "./dl-button.js";
import { reportDownload } from "./telemetry.js";

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

export async function downloadWithCard({ command, args, savePath, name, button = null }) {
  const btnAnim = dlButton(button);
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
  let firstByte = 0, lastByte = 0, bytes = 0;
  const win = [];
  const unlisten = await listen("download-progress", ev => {
    const p = ev.payload || {};
    if (p.job !== job) return;
    if (!firstByte) firstByte = Date.now();
    lastByte = Date.now();
    bytes = p.done || 0;
    // Текущая скорость — по последним ~3 с, а не от нажатия (туда попадало ожидание сервера).
    win.push([lastByte, bytes]);
    while (win.length > 2 && lastByte - win[0][0] > 3000) win.shift();
    const [t0, b0] = win[0];
    const bps = lastByte - t0 >= 400 ? (bytes - b0) / ((lastByte - t0) / 1000) : 0;
    const speed = bps ? ` · ${(bps / 1048576).toFixed(1)} МБ/с (${Math.round(bps * 8 / 1e6)} Мбит/с)` : "";
    if (p.total > 0) {
      bar.style.width = `${Math.min(100, (p.done / p.total) * 100)}%`;
      btnAnim.progress(p.done / p.total);
      note.textContent = `${fmt(p.done)} из ${fmt(p.total)}${speed}`;
    } else {
      bar.classList.add("indet");
      note.textContent = `Скачано ${fmt(p.done)}${speed}`;
    }
  });
  card.classList.add("busy");
  bar.classList.add("indet");
  note.textContent = "Скачиваю… (если файла нет в кэше, сервер достаёт его из архива Telegram — это может занять минуту)";
  try {
    await invoke(command, { ...args, initData: state.token || "", savePath, job });
    bar.classList.remove("indet");
    bar.style.width = "100%";
    card.classList.remove("busy");
    card.classList.add("ok");
    btnAnim.done(true);
    if (firstByte) reportDownload({ bytes, ms: lastByte - firstByte, ok: true });
    note.textContent = `Сохранено в ${savePath.replace(/[\\/][^\\/]*$/, "") || savePath}`;
    note.title = savePath;
    act.innerHTML = `<button type="button" class="btn dl-reveal">📂 Показать в папке</button>`;
    act.querySelector(".dl-reveal").addEventListener("click", () => revealInFolder(savePath));
    revealInFolder(savePath).catch(() => { });
    setTimeout(() => card.remove(), 60000);
    return true;
  } catch (e) {
    bar.classList.remove("indet");
    card.classList.remove("busy");
    card.classList.add("err");
    btnAnim.done(false);
    reportDownload({ bytes, ms: (lastByte || Date.now()) - (firstByte || started), ok: false, error: e });
    note.textContent = `Не удалось скачать: ${e}`;
    return false;
  } finally {
    unlisten();
  }
}
