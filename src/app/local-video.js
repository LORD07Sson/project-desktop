
import { invoke, pickInputFiles } from "./tauri.js";
import { toast } from "./api.js";

const KEY = "project-local-video";
const POLL_MS = 4000;
const timers = new Map();

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (_) { return {}; }
}
function writeAll(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (_) { }
}
function changed(publicId) {
  document.dispatchEvent(new CustomEvent("local-video-changed", { detail: { publicId } }));
}

export function getLocalVideo(publicId) {
  return readAll()[publicId] || null;
}

export function setLocalVideo(publicId, value) {
  const all = readAll();
  if (value) all[publicId] = value; else delete all[publicId];
  writeAll(all);
  changed(publicId);
}

function stopTracking(publicId) {
  const t = timers.get(publicId);
  if (t) clearInterval(t);
  timers.delete(publicId);
}

const baseName = p => String(p || "").split(/[\/]/).pop();

export function trackLocalDownload(publicId, magnet, title) {
  stopTracking(publicId);
  setLocalVideo(publicId, { name: title || "видео", magnet, state: "downloading", progress: 0, speed: 0 });
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const st = await invoke("tc_progress", { magnet });
      const cur = getLocalVideo(publicId);
      if (!cur || cur.magnet !== magnet) { stopTracking(publicId); return; }
      if (st.state === "done" && st.path) {
        stopTracking(publicId);
        setLocalVideo(publicId, { name: baseName(st.path), path: st.path, state: "ready" });
        toast(`Видео скачано на компьютер: ${baseName(st.path)}. В «Собрать финал» выберите «Видео на этом компьютере».`, "success");
      } else if (st.state === "not_found") {
        stopTracking(publicId);
        setLocalVideo(publicId, Object.assign({}, cur, { state: "lost" }));
        toast("Раздача пропала из торрент-клиента. Если файл уже скачан, укажите его кнопкой «Файл на компьютере».", "error");
      } else {
        setLocalVideo(publicId, Object.assign({}, cur, { progress: st.progress, speed: st.speed }));
      }
    } catch (e) {
      const text = String((e && e.message) || e);
      if (/только в qBittorrent|не настроен|Файл раздачи не найден|нет видеофайла/i.test(text)) {
        stopTracking(publicId);
        const cur = getLocalVideo(publicId);
        if (cur) setLocalVideo(publicId, Object.assign({}, cur, { state: "lost" }));
        toast(text, "error");
      }
    } finally { busy = false; }
  };
  timers.set(publicId, setInterval(tick, POLL_MS));
  tick();
}

export async function pickLocalVideo(publicId) {
  const picked = await pickInputFiles({ multiple: false, filters: [{ name: "Видео", extensions: ["mkv", "mp4", "avi", "mov", "webm", "m4v", "ts"] }] });
  const path = Array.isArray(picked) ? picked[0] : null;
  if (!path) return null;
  stopTracking(publicId);
  setLocalVideo(publicId, { name: baseName(path), path, state: "ready" });
  return path;
}

export function resumeLocalTracking() {
  const all = readAll();
  for (const [publicId, v] of Object.entries(all)) {
    if (v && v.state === "downloading" && v.magnet && !timers.has(publicId)) trackLocalDownload(publicId, v.magnet, v.name);
  }
}
resumeLocalTracking();
