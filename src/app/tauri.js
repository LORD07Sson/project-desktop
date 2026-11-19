
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion } from "@tauri-apps/api/app";
export { invoke, listen, emit, getCurrentWindow, WebviewWindow, convertFileSrc, getVersion };

export function sendNotification({ title, body } = {}) {
  invoke("notify_desktop", { title: String(title || "Project"), body: body == null ? null : String(body) })
    .catch(() => { });
}


export async function pickInputFiles({ multiple = false, filters = [] } = {}) {
  return invoke("pick_input_files", { filters, multiple });
}

export async function pickInputFile(filters = []) {
  const picked = await pickInputFiles({ multiple: false, filters });
  return picked[0] || null;
}

export async function pickOutputFile(defaultName, filters = []) {
  return invoke("pick_output_file", { defaultName: defaultName || null, filters });
}

export async function pickOutputDir() {
  return invoke("pick_output_dir");
}

export const appWindow = getCurrentWindow();

export const PIN_WINDOW_LABEL = "report-pin";
export const PIN_REPORT_EVENT = "pin-report-changed";

export async function pinReportWindow(publicId) {
  const existing = await WebviewWindow.getByLabel(PIN_WINDOW_LABEL);
  if (existing) {
    await emit(PIN_REPORT_EVENT, { publicId });
    await existing.setFocus();
    return existing;
  }
  return new WebviewWindow(PIN_WINDOW_LABEL, {
    url: `pin.html?id=${encodeURIComponent(publicId)}`,
    title: `📌 ${publicId} — Project`,
    width: 360,
    height: 520,
    minWidth: 300,
    minHeight: 340,
    alwaysOnTop: true,
    decorations: true,
  });
}

export function openExternal(url) {
  return invoke("plugin:shell|open", { path: url });
}

function parentDir(filePath) {
  const idx = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}
export function openInSystemPlayer(filePath) {
  return invoke("plugin:shell|open", { path: filePath });
}
export async function revealInFolder(filePath) {
  try {
    await invoke("reveal_in_folder", { path: filePath });
  } catch (_) {
    await invoke("plugin:shell|open", { path: parentDir(filePath) });
  }
}
