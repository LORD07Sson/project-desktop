// «Собрать у себя»: рендер финала на ПК (видеокарта NVIDIA, NVENC) вместо слабого сервера.
// Ход: сервер присылает план шагов ffmpeg (POST /report/{id}/local-render/plan) → Rust (local_render_run) скачивает файлы,
// рендерит и отдаёт путь → готовый файл уходит на сервер (local_render_upload), где бот делает с ним то же, что после серверной
// сборки: обложка и превью, отправка в Telegram, прикрепление к отчёту, уборка исходника, пересылка выбранным, черновик поста.
// Прогресс рендера — событие localrender-progress, отмена — local_render_cancel; дальше ход ведёт карточка сборки отчёта.

import { invoke, listen } from "./tauri.js";
import { apiPost, toast } from "./api.js";
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

/** Человеческое описание состояния инструментов — чтобы в окне никогда не было пусто. */
export function describeTools(st) {
  if (!st) return "Проверяю ffmpeg и видеокарту…";
  const parts = [];
  parts.push(st.ffmpeg_ok ? `ffmpeg: ${SOURCE_LABEL[st.source] || st.source}${st.downloaded_now ? " (только что скачан)" : ""} ✓` : `ffmpeg: ${st.error || "не найден"}`);
  const gpu = st.gpu ? st.gpu : "видеокарта не определена";
  const nv = st.nvenc_h264 || st.nvenc_h265;
  parts.push(`Видеокарта: ${gpu} — ${nv ? "NVENC доступен ✓" : "NVENC не найден" + (st.soft_h264 || st.soft_h265 ? " (будет процессор)" : "")}`);
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

function paint(el, { title, label, fraction, cancel }) {
  const pct = Math.round((fraction || 0) * 100);
  el.innerHTML = `<b>${esc(title)}</b>
    <span class="rd-asm-step">${esc(label || "")}</span>
    <div class="rd-asm-bar"><i style="width:${pct}%"></i><em>${pct}%</em></div>
    ${cancel ? `<button type="button" class="btn rd-asm-cancel" data-lr-cancel>⏹ Отменить</button>` : ""}`;
  el.querySelector("[data-lr-cancel]")?.addEventListener("click", async e => {
    e.currentTarget.disabled = true;
    try { await invoke("local_render_cancel"); } catch (_) { /* не критично */ }
  });
}

/** selection — тело, как у /assemble/start (video, sub, audios, mode, profile, inscription). */
export async function runLocalRender(publicId, selection, overlay, onUploaded) {
  if (running) { toast("Сборка у себя уже идёт — дождитесь или отмените её.", "error"); return false; }
  running = publicId;
  const el = card(overlay);
  paint(el, { title: "🖥 Сборка у себя", label: "Готовлю план сборки…", fraction: 0, cancel: false });
  const unlisten = await listen("localrender-progress", ev => {
    const p = ev.payload || {};
    paint(el, { title: p.stage === "download" ? "🖥 Скачиваю файлы" : "🖥 Рендер у себя", label: p.label, fraction: p.fraction, cancel: true });
  });
  let plan = null;
  try {
    plan = await apiPost(`/report/${publicId}/local-render/plan`, selection);
    paint(el, { title: "🖥 Сборка у себя", label: "Скачиваю файлы…", fraction: 0, cancel: true });
    const done = await invoke("local_render_run", { plan, initData: state.token || "" });
    paint(el, { title: "⬆ Отправляю готовое видео на сервер", label: `${done.out_name} · ${(done.size / 1048576).toFixed(0)} МБ · ${done.encoder}`, fraction: 1, cancel: false });
    await invoke("local_render_upload", { publicId, path: done.path, initData: state.token || "" });
    const mins = Math.max(1, Math.round(done.seconds / 60));
    toast(`Рендер у вас готов (${done.encoder}, ~${mins} мин). Бот отправляет видео в Telegram и прикрепляет к отчёту.`, "success");
    el.remove();
    if (typeof onUploaded === "function") onUploaded();
    return true;
  } catch (e) {
    const text = String((e && e.message) || e);
    el.remove();
    toast(/отменен/i.test(text) ? "Сборка у себя отменена." : `Сборка у себя не удалась: ${text}`, /отменен/i.test(text) ? "info" : "error");
    return false;
  } finally {
    unlisten();
    running = null;
    try { await invoke("local_render_cleanup", { publicId }); } catch (_) { /* временная папка уберётся сама */ }
  }
}
