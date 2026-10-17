// «Собрать у себя»: рендер финала на ПК (видеокарта NVIDIA, NVENC) вместо слабого сервера.
// Ход: сервер присылает план шагов ffmpeg (POST /report/{id}/local-render/plan) → Rust (local_render_run) скачивает файлы,
// рендерит и отдаёт путь → готовое видео загружается в отчёт обычным upload_report_file → сервер убирает свой исходник
// (POST …/local-render/done). Прогресс — событие localrender-progress, отмена — local_render_cancel.

import { invoke, listen } from "./tauri.js";
import { apiPost, toast } from "./api.js";
import { state } from "./state.js";
import { esc } from "./utils.js";

let running = null; // publicId идущей сборки

export async function localRenderSupport() {
  try {
    const e = await invoke("local_render_encoders");
    return { ok: !!(e.nvenc_h264 || e.nvenc_h265 || e.soft_h264 || e.soft_h265), nvenc: !!(e.nvenc_h264 || e.nvenc_h265), soft: !!(e.soft_h264 || e.soft_h265), raw: e };
  } catch (_) {
    return { ok: false, nvenc: false, soft: false, raw: null };
  }
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
export async function runLocalRender(publicId, selection, overlay) {
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
    paint(el, { title: "⬆ Загружаю готовое видео в отчёт", label: `${done.out_name} · ${(done.size / 1048576).toFixed(0)} МБ · ${done.encoder}`, fraction: 1, cancel: false });
    await invoke("upload_report_file", { reportId: publicId, filePath: done.path, initData: state.token || "" });
    try { await apiPost(`/report/${publicId}/local-render/done`, { source: plan.source_video }); } catch (_) { /* исходник уберётся позже */ }
    const mins = Math.max(1, Math.round(done.seconds / 60));
    toast(`Финал собран у вас (${done.encoder}) за ~${mins} мин и загружен в отчёт.`, "success");
    document.dispatchEvent(new CustomEvent("report-file-uploaded", { detail: { publicId } }));
    el.remove();
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
