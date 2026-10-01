// Вложения — картинки и файлы в сообщениях, заметках, тикетах (и равки
// серии). Сервер хранит только file_id из Telegram и отдаёт файл по
// attach.path ("/api/…/file"): картинку показываем <img> по mediaUrl
// (короткий mtok в ссылке, токен не светится), файл качаем Rust-командой
// download_api_file — токен заголовком, путь сохранения выбирает человек.

import { state } from "./state.js";
import { mediaUrl, openSheet, toast } from "./api.js";
import { esc } from "./utils.js";
import { invoke, pickOutputFile, revealInFolder } from "./tauri.js";

// Из десктопа отправляются только картинки: файлы тяжёлые, а канал до
// VPS у провайдеров режется (~190 КБ/с на соединение) — их шлют боту.
export const ATTACH_MAX_MB = 10;

const FILE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6zM14 3v5h5"/></svg>';
const DL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
export const CLIP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5 12.2 19.3a5 5 0 0 1-7.1-7.1l8.2-8.2a3.3 3.3 0 0 1 4.7 4.7l-8.2 8.2a1.7 1.7 0 0 1-2.4-2.4L15 6.9"/></svg>';

// Сервер отдаёт путь от корня ("/api/chats/…"), а mediaUrl и Rust-команда
// ждут его относительно API_BASE (который уже кончается на /api).
function apiRelative(path) { return String(path || "").replace(/^\/api\//, "").replace(/^\//, ""); }

export function sizeText(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
}

export function attachHtml(a) {
  if (!a) return "";
  const rel = apiRelative(a.path);
  if (a.kind === "image") {
    const src = mediaUrl(`/${rel}`, { view: 1 });
    return `<button type="button" class="att-img" data-att-open="${esc(rel)}" data-att-name="${esc(a.name || "")}" title="${esc(a.name || "Картинка")} — открыть">
      <img src="${esc(src)}" alt="${esc(a.name || "картинка")}" loading="lazy"></button>`;
  }
  return `<div class="att-file">
    <span class="att-ic">${FILE_ICON}</span>
    <span class="att-meta"><b>${esc(a.name || "файл")}</b><span>${esc(sizeText(a.size))}</span></span>
    <button type="button" class="icon-btn att-dl" data-att-dl="${esc(rel)}" data-att-name="${esc(a.name || "file")}" title="Скачать" aria-label="Скачать ${esc(a.name || "файл")}">${DL_ICON}</button>
  </div>`;
}

export async function downloadAttachment(rel, name) {
  const savePath = await pickOutputFile(name || "file");
  if (!savePath) return;
  try {
    await invoke("download_api_file", { apiPath: rel, initData: state.token || "", savePath });
    toast("Файл сохранён.", "success", { label: "📂 Показать в папке", onClick: () => revealInFolder(savePath) });
  } catch (e) {
    toast(`Не удалось скачать: ${e}`, "error");
  }
}

function openImage(rel, name) {
  const src = mediaUrl(`/${rel}`, { view: 1 });
  const overlay = openSheet(`
    <div class="att-view"><img src="${esc(src)}" alt="${esc(name || "")}"></div>
    <div class="sheet-actions"><span class="att-view-name">${esc(name || "")}</span><span style="flex:1"></span>
      <button class="btn" id="att-save">${DL_ICON}Сохранить</button>
      <button class="btn" data-close>Закрыть</button></div>`, "wide");
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#att-save").addEventListener("click", () => downloadAttachment(rel, name));
}

// Один обработчик на контейнер — переживает перерисовки содержимого.
export function wireAttachments(root) {
  if (!root || root.dataset.attWired) return;
  root.dataset.attWired = "1";
  root.addEventListener("click", e => {
    const img = e.target.closest("[data-att-open]");
    if (img) { e.preventDefault(); openImage(img.dataset.attOpen, img.dataset.attName); return; }
    const dl = e.target.closest("[data-att-dl]");
    if (dl) { e.preventDefault(); downloadAttachment(dl.dataset.attDl, dl.dataset.attName); }
  });
}

// Системный диалог выбора файла — обычный <input type=file>: WebView сам
// открывает проводник и отдаёт байты странице, Rust тут не нужен.
export function pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.style.display = "none";
    input.addEventListener("change", () => { resolve(input.files[0] || null); input.remove(); }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

// Картинка из буфера обмена (Ctrl+V скриншота) — File или null.
export function pastedFile(e) {
  const items = [...(e.clipboardData?.items || [])];
  const item = items.find(i => i.kind === "file");
  const file = item && item.getAsFile();
  if (!file) return null;
  if (!file.name || file.name === "image.png") {
    const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
    return new File([file], `скриншот-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`, { type: file.type });
  }
  return file;
}

export function tooBig(file) {
  if (file && !/^image\//.test(file.type)) {
    toast("Из десктопа можно отправить только картинку. Файлы отправляйте боту в Telegram.", "error");
    return true;
  }
  if (file && file.size > ATTACH_MAX_MB * 1024 * 1024) {
    toast(`Картинка больше ${ATTACH_MAX_MB} МБ — так не отправить.`, "error");
    return true;
  }
  return false;
}

// Плашка «будет отправлено» над полем ввода. Собирается через DOM, а не
// строкой HTML: имя и превью приходят из выбранного человеком файла, и
// так им негде превратиться в разметку (CodeQL: DOM text → HTML).
export function renderPending(box, file, onCancel) {
  if (!box) return;
  box.replaceChildren();
  if (!file) return;
  const wrap = document.createElement("div");
  wrap.className = "att-pending";
  if (/^image\//.test(file.type)) {
    // Миниатюра рисуется на canvas прямо из байтов, без адреса в src —
    // данным из файла некуда попасть в разметку.
    const SIDE = 44;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = SIDE;
    canvas.className = "att-thumb";
    window.createImageBitmap(file).then(bmp => {
      const s = Math.min(bmp.width, bmp.height);
      canvas.getContext("2d").drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, SIDE, SIDE);
      bmp.close();
    }).catch(() => { /* не картинка на самом деле — остаётся пустой квадрат */ });
    wrap.append(canvas);
  } else {
    const ic = document.createElement("span");
    ic.className = "att-ic";
    ic.innerHTML = FILE_ICON; // константа, не пользовательские данные
    wrap.append(ic);
  }
  const meta = document.createElement("span");
  meta.className = "att-meta";
  const name = document.createElement("b");
  name.textContent = file.name;
  const size = document.createElement("span");
  size.textContent = sizeText(file.size);
  meta.append(name, size);
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "icon-btn";
  cancel.title = cancel.ariaLabel = "Убрать вложение";
  cancel.textContent = "✕";
  cancel.addEventListener("click", () => onCancel && onCancel());
  wrap.append(meta, cancel);
  box.append(wrap);
}
