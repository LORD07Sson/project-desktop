// «Собрать у себя»: рендер финала на ПК (видеокарта NVIDIA, NVENC) вместо слабого сервера.
// Ход: сервер присылает план шагов ffmpeg (POST /report/{id}/local-render/plan) → Rust (local_render_run) скачивает файлы,
// рендерит и отдаёт путь → готовый файл уходит на сервер (local_render_upload), где бот делает с ним то же, что после серверной
// сборки: обложка и превью, отправка в Telegram, прикрепление к отчёту, уборка исходника, пересылка выбранным, черновик поста.
// Прогресс рендера — событие localrender-progress, отмена — local_render_cancel; дальше ход ведёт карточка сборки отчёта.

import { invoke, listen } from "./tauri.js";
import { getLocalVideo, pickLocalVideo } from "./local-video.js";
import { apiPost, toast, openSheet, dismissSheet } from "./api.js";
import { state } from "./state.js";
import { esc } from "./utils.js";

let running = null; // publicId идущей сборки

let preparing = null; // идущая проверка (одна на приложение)
let lastStatus = null;

/** Автопроверка: находит ffmpeg (рядом с приложением → докачанный → PATH), при отсутствии докачивает из релиза на GitHub,
 *  определяет видеокарту и рабочие кодировщики. onProgress({fraction,label}) — ход докачки. Всегда возвращает статус. */
export function prepareLocalRender(onProgress, force = false) {
  if (preparing && !force) return preparing;
  const run = async () => {
    let unlisten = null;
    if (typeof onProgress === "function") {
      try { unlisten = await listen("ffmpeg-fetch-progress", ev => onProgress(ev.payload || {})); } catch (_) { /* не критично */ }
    }
    try {
      lastStatus = await invoke("local_render_prepare");
    } catch (e) {
      lastStatus = { ffmpeg_ok: false, ffprobe_ok: false, source: "none", gpu: "", nvenc_h264: false, nvenc_h265: false, soft_h264: false, soft_h265: false, error: String((e && e.message) || e) };
    } finally {
      if (unlisten) unlisten();
    }
    return lastStatus;
  };
  preparing = run().finally(() => { if (!lastStatus || !lastStatus.ffmpeg_ok) preparing = null; });
  return preparing;
}

export async function localRenderSupport(onProgress) {
  const st = await prepareLocalRender(onProgress);
  const nvenc = !!(st.nvenc_h264 || st.nvenc_h265);
  const soft = !!(st.soft_h264 || st.soft_h265);
  return { ok: !!st.ffmpeg_ok && (nvenc || soft), nvenc, soft, status: st };
}

const SOURCE_LABEL = { bundled: "встроенный", downloaded: "скачан приложением", path: "из системы (PATH)", none: "не найден" };
const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
const STALL_AFTER_MS = 60_000;

/** Человеческое описание состояния инструментов — чтобы в окне никогда не было пусто. */
export function describeTools(st) {
  if (!st) return "Проверяю ffmpeg и видеокарту…";
  const parts = [];
  parts.push(st.ffmpeg_ok ? `ffmpeg: ${SOURCE_LABEL[st.source] || st.source}${st.downloaded_now ? " (только что скачан)" : ""} ✓` : `ffmpeg: ${String(st.error || "не найден").slice(0, 220)}`);
  const gpu = st.gpu ? st.gpu : "видеокарта не определена";
  const encoder = (label, available, error, fallback) => available
    ? `${label}: готов ✓`
    : `${label}: ${String(error || "проверка не пройдена").slice(0, 120)}${fallback ? " (будет процессор)" : ""}`;
  parts.push(`Видеокарта: ${gpu} · ${encoder("NVENC H.264", st.nvenc_h264, st.nvenc_h264_error, st.soft_h264)} · ${encoder("NVENC H.265", st.nvenc_h265, st.nvenc_h265_error, st.soft_h265)}`);
  return parts.join(" · ");
}

function card(overlay) {
  const slot = overlay.querySelector("#rd-prod-asm") || overlay.querySelector(".rd-main");
  let el = overlay.querySelector("#rd-local-card");
  if (!el) {
    el = document.createElement("div");
    el.id = "rd-local-card";
    el.className = "rd-asm";
    slot.appendChild(el);
  }
  return el;
}

function paint(el, { title, label, fraction, cancel, warning, diagnostic }) {
  const pct = Math.round((fraction || 0) * 100);
  el.innerHTML = `<b>${esc(title)}</b>
    <span class="rd-asm-step">${esc(label || "")}</span>
    <div class="rd-asm-bar"><i style="width:${pct}%"></i><em>${pct}%</em></div>
    ${warning ? `<div class="rd-asm-stall"><b>Прогресс не меняется ${Math.floor(warning.idleMs / 60000)} мин.</b><span>${esc(warning.text)}</span>
      <div class="rd-asm-support"><button type="button" class="btn" data-lr-copy>Скопировать диагностику</button><button type="button" class="btn" data-lr-logs>Открыть логи</button></div></div>` : ""}
    ${cancel ? `<button type="button" class="btn rd-asm-cancel" data-lr-cancel>⏹ Отменить</button>` : ""}`;
  el.querySelector("[data-lr-cancel]")?.addEventListener("click", async e => {
    e.currentTarget.disabled = true;
    try { await invoke("local_render_cancel"); } catch (_) { /* не критично */ }
  });
  el.querySelector("[data-lr-copy]")?.addEventListener("click", () => copySupportReport(diagnostic));
  el.querySelector("[data-lr-logs]")?.addEventListener("click", openAppLogs);
}

function redactDiagnosticText(value) {
  return String(value || "")
    .replace(/[A-Za-z]:\\[^\r\n"<>|]*/g, "[локальный путь]")
    .replace(/(?:\/Users\/|\/home\/|\/tmp\/)[^\s"']+/g, "[локальный путь]")
    .slice(0, 2400);
}

function makeRenderDiagnostic(monitor, startedAt, error = "", phase = "") {
  const idleMs = monitor ? Date.now() - monitor.lastAdvanceAt : 0;
  return [
    `Project Desktop ${APP_VERSION}`,
    `Система: ${navigator.userAgent}`,
    `Этап: ${phase || monitor?.stage || "подготовка"}${monitor?.label ? ` — ${redactDiagnosticText(monitor.label)}` : ""}`,
    `Прогресс: ${Math.round((monitor?.fraction || 0) * 100)}%`,
    `Без продвижения: ${Math.floor(idleMs / 1000)} с`,
    `Длительность операции: ${Math.floor((Date.now() - startedAt) / 1000)} с`,
    error ? `Ошибка: ${redactDiagnosticText(error)}` : "Ошибка: нет; прогресс не обновлялся",
    `Время: ${new Date().toISOString()}`,
  ].join("\n");
}

async function copySupportReport(report) {
  try {
    await navigator.clipboard.writeText(report || "Диагностика FFmpeg недоступна.");
    toast("Диагностика скопирована — отправьте её разработчику.", "success");
  } catch (e) {
    toast(`Не удалось скопировать диагностику: ${String((e && e.message) || e)}`, "error");
  }
}

async function openAppLogs() {
  try { await invoke("open_log_folder"); }
  catch (e) { toast(`Не удалось открыть логи: ${String((e && e.message) || e)}`, "error"); }
}

function showRenderFailure(error, monitor, startedAt, phase) {
  const detail = redactDiagnosticText(error);
  const report = makeRenderDiagnostic(monitor, startedAt, error, phase);
  const sheet = openSheet(`<h2>Операция не завершилась</h2>
    <p class="lr-error-summary">Этап: ${esc(phase || monitor?.label || monitor?.stage || "подготовка")} · последний прогресс FFmpeg ${Math.round((monitor?.fraction || 0) * 100)}%</p>
    <pre class="lr-error-detail">${esc(detail || "FFmpeg завершился без текста ошибки.")}</pre>
    <p class="lr-error-summary">Скопируйте диагностику и отправьте её разработчику. Подробная причина также записана в лог приложения.</p>
    <div class="sheet-actions"><button type="button" class="btn" data-lr-logs>Открыть логи</button><button type="button" class="btn primary" data-lr-copy>Скопировать диагностику</button><button type="button" class="btn" data-lr-close>Закрыть</button></div>`);
  sheet.querySelector("[data-lr-copy]")?.addEventListener("click", () => copySupportReport(report));
  sheet.querySelector("[data-lr-logs]")?.addEventListener("click", openAppLogs);
  sheet.querySelector("[data-lr-close]")?.addEventListener("click", () => dismissSheet(sheet));
}

/** Окно «Сохранить копию себе?»: после рендера, пока файл ещё лежит во временной папке (потом её убирают). */
function askSaveCopy(done) {
  return new Promise(resolve => {
    const overlay = openSheet(`<h2>Сохранить копию себе?</h2>
      <p class="dev-hint">${esc(done.out_name)} · ${(done.size / 1048576).toFixed(0)} МБ. На сервер видео уйдёт в любом случае, а на компьютере временный файл после отправки удаляется.</p>
      <div class="sheet-actions"><button type="button" class="btn primary" data-yes>Да, выбрать папку</button><button type="button" class="btn" data-no>Нет</button></div>`);
    const finish = yes => { resolve(yes); dismissSheet(overlay); };
    overlay.addEventListener("sheet-dismissed", () => resolve(false));
    overlay.querySelector("[data-yes]").addEventListener("click", () => finish(true));
    overlay.querySelector("[data-no]").addEventListener("click", () => finish(false));
  });
}

async function saveCopy(done) {
  try {
    const dir = await invoke("pick_output_dir");
    if (!dir) return;
    const saved = await invoke("local_render_save_copy", { path: done.path, dir, name: done.out_name });
    toast("Копия сохранена.", "success");
    try { await invoke("reveal_in_folder", { path: saved }); } catch (_) { /* не критично */ }
  } catch (e) {
    toast(`Копию сохранить не удалось: ${String((e && e.message) || e)}`, "error");
  }
}

/** Видео «у себя» (равка, которую качает торрент-клиент): ждём, пока докачается, и берём параметры файла. Сервер файла не видит. */
async function prepareLocalVideo(publicId, el) {
  let cancelled = false;
  const waitText = v => `Жду, пока видео докачается на компьютер: ${Math.round((v.progress || 0) * 100)}%${v.speed > 0 ? ` · ${(v.speed / 1048576).toFixed(1)} МБ/с` : ""}`;
  let v = getLocalVideo(publicId);
  while (v && v.state === "downloading" && !cancelled) {
    paint(el, { title: "💻 Скачиваю видео себе", label: waitText(v), fraction: v.progress || 0, cancel: true });
    el.querySelector("[data-lr-cancel]")?.addEventListener("click", () => { cancelled = true; });
    await new Promise(r => setTimeout(r, 1500));
    v = getLocalVideo(publicId);
  }
  if (cancelled) throw new Error("Операция отменена.");
  if (!v || v.state !== "ready" || !v.path) throw new Error("Видео на компьютере не найдено — укажите файл кнопкой «Файл на компьютере» в Nyaa.");
  paint(el, { title: "🖥 Сборка у себя", label: "Читаю параметры видео…", fraction: 0, cancel: false });
  let path = v.path;
  let info;
  try {
    info = await invoke("local_render_probe", { path });
  } catch (e) {
    // после перезапуска приложения доступ к файлу сброшен — просим выбрать его ещё раз (диалог заново выдаёт доступ)
    if (!/не выбирали|доступ/i.test(String((e && e.message) || e))) throw e;
    toast("Укажите файл видео ещё раз — после перезапуска приложение не помнит разрешение на чтение.", "info");
    path = await pickLocalVideo(publicId);
    if (!path) throw new Error("Операция отменена.");
    info = await invoke("local_render_probe", { path });
  }
  return { path, info };
}

/** selection — тело, как у /assemble/start (video, sub, audios, mode, profile, inscription). */
export async function runLocalRender(publicId, selection, overlay, onUploaded) {
  if (running) { toast("Сборка у себя уже идёт — дождитесь или отмените её.", "error"); return false; }
  running = publicId;
  const startedAt = Date.now();
  const el = card(overlay);
  paint(el, { title: "🖥 Сборка у себя", label: "Готовлю план сборки…", fraction: 0, cancel: false });
  let monitor = null;
  let unlisten = () => {};
  let stallTimer = null;
  let warnedMinute = 0;
  let phase = "подготовка";
  const paintMonitor = () => {
    if (!monitor?.active) return;
    const idleMs = Date.now() - monitor.lastAdvanceAt;
    const minute = Math.floor(idleMs / STALL_AFTER_MS);
    const warning = minute >= 1 ? {
      idleMs,
      text: monitor.stage === "render"
        ? `FFmpeg не сообщил новый прогресс на этапе «${monitor.label || "рендер"}». Он может обрабатывать тяжёлый кадр. Проверьте нагрузку CPU/GPU; рендер продолжает работать.`
        : `На этапе «${monitor.label || monitor.stage}» нет нового прогресса. Проверьте интернет и активность приложения; операция продолжает работать.`,
    } : null;
    paint(el, {
      title: monitor.stage === "download" ? "🖥 Скачиваю файлы" : "🖥 Рендер у себя",
      label: monitor.label,
      fraction: monitor.fraction,
      cancel: true,
      warning,
      diagnostic: warning ? makeRenderDiagnostic(monitor, startedAt) : null,
    });
  };
  try {
    unlisten = await listen("localrender-progress", ev => {
    const p = ev.payload || {};
      if (!monitor?.active) return;
      const stage = p.stage || "render";
      const label = p.label || monitor.label;
      const fraction = Number(p.fraction) || 0;
      const stepChanged = stage !== monitor.stage || label !== monitor.label;
      const advanced = fraction > monitor.fraction + 0.00001;
      if (stepChanged || advanced) {
        monitor.lastAdvanceAt = Date.now();
        warnedMinute = 0;
      }
      monitor.stage = stage;
      monitor.label = label;
      monitor.fraction = fraction;
      paintMonitor();
    });
  } catch (_) { /* без слушателя сборка всё равно может завершиться; лог доступен через настройки */ }
  let plan = null;
  try {
    let localPath = null;
    const uploadRaw = !!selection.upload_raw;
    selection = Object.assign({}, selection);
    delete selection.upload_raw;
    if (selection.video === "local") {
      phase = "чтение локального видео";
      const lv = await prepareLocalVideo(publicId, el);
      localPath = lv.path;
      selection = Object.assign({}, selection, { video: 0, local_video: lv.info });
    }
    paint(el, { title: "🖥 Сборка у себя", label: "Готовлю план сборки…", fraction: 0, cancel: false });
    phase = "запрос плана сборки";
    plan = await apiPost(`/report/${publicId}/local-render/plan`, selection);
    paint(el, { title: "🖥 Сборка у себя", label: "Скачиваю файлы…", fraction: 0, cancel: true });
    phase = "скачивание файлов и рендер";
    monitor = { active: true, stage: "download", label: "Скачиваю файлы…", fraction: 0, lastAdvanceAt: Date.now() };
    stallTimer = setInterval(() => {
      if (!monitor?.active) return;
      const minute = Math.floor((Date.now() - monitor.lastAdvanceAt) / STALL_AFTER_MS);
      if (minute > warnedMinute) {
        warnedMinute = minute;
        paintMonitor();
      }
    }, 5000);
    const done = await invoke("local_render_run", { plan, initData: state.token || "", localVideo: localPath });
    if (monitor) monitor.active = false;
    if (stallTimer) clearInterval(stallTimer);
    phase = "загрузка финала на сервер";
    if (await askSaveCopy(done)) await saveCopy(done);
    paint(el, { title: "⬆ Отправляю готовое видео на сервер", label: `${done.out_name} · ${(done.size / 1048576).toFixed(0)} МБ · ${done.encoder}`, fraction: 1, cancel: false });
    await invoke("local_render_upload", { publicId, path: done.path, initData: state.token || "" });
    if (uploadRaw && localPath) {
      phase = "загрузка равки в отчёт";
      paint(el, { title: "⬆ Загружаю равку в отчёт", label: `${localPath.split("\\").pop().split("/").pop()} — это может занять время`, fraction: 1, cancel: false });
      try {
        await invoke("upload_report_file", { reportId: publicId, filePath: localPath, initData: state.token || "" });
        document.dispatchEvent(new CustomEvent("report-file-uploaded", { detail: { publicId } }));
      } catch (e) { toast(`Финал отправлен, а равку в отчёт загрузить не удалось: ${String((e && e.message) || e)}`, "error"); }
    }
    const mins = Math.max(1, Math.round(done.seconds / 60));
    toast(`Рендер у вас готов (${done.encoder}, ~${mins} мин). Бот отправляет видео в Telegram и прикрепляет к отчёту.`, "success");
    el.remove();
    if (typeof onUploaded === "function") onUploaded();
    return true;
  } catch (e) {
    const text = String((e && e.message) || e);
    if (monitor) monitor.active = false;
    el.remove();
    if (/отменен/i.test(text)) toast("Сборка у себя отменена.", "info");
    else showRenderFailure(text, monitor, startedAt, phase);
    return false;
  } finally {
    if (stallTimer) clearInterval(stallTimer);
    unlisten();
    running = null;
    try { await invoke("local_render_cleanup", { publicId }); } catch (_) { /* временная папка уберётся сама */ }
  }
}
