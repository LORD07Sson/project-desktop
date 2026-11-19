
import { appWindow, invoke } from "./tauri.js";
import { state } from "./state.js";
import { toast } from "./api.js";
import { runQc, QC_EXTENSIONS } from "./qc.js";

let activeReportId = null;
export function setDropTarget(publicId) { activeReportId = publicId; }

let luatoolsDrop = null;
export function setLuatoolsDropHandler(fn) { luatoolsDrop = fn; }

export const ATTACH_EXTENSIONS = [
  ...QC_EXTENSIONS, "png", "jpg", "jpeg", "webp", "pdf", "doc", "docx", "ppt", "pptx", "zip",
];
const extRe = list => new RegExp(`\\.(${list.join("|")})$`, "i");
const ALLOWED_EXT = extRe(ATTACH_EXTENSIONS);
const QC_EXT_RE = extRe(QC_EXTENSIONS);

function baseName(path) {
  return path.split(/[\\/]/).pop() || path;
}

(async () => {
  await appWindow.onDragDropEvent(async event => {
    const type = event.payload.type;
    if (type === "over" || type === "enter") {
      document.body.classList.add("drop-armed");
      return;
    }
    document.body.classList.remove("drop-armed");
    if (type !== "drop") return;

    const paths = event.payload.paths || [];

    if (luatoolsDrop && document.querySelector("#luatools-body")?.offsetParent) {
      await luatoolsDrop(paths);
      return;
    }

    if (!activeReportId && document.querySelector("#ms-input")?.offsetParent) {
      toast("Чтобы отправить файл в чат, нажмите скрепку или скопируйте файл в проводнике и вставьте Ctrl+V.");
      return;
    }
    if (!activeReportId) {
      const qcPaths = paths.filter(p => QC_EXT_RE.test(baseName(p)));
      if (!qcPaths.length) {
        toast("Откройте карточку отчёта, чтобы прикрепить файл (или перетащите аудио/видео для QC).", "error");
        return;
      }
      await runQc(qcPaths);
      return;
    }

    for (const path of paths) {
      const name = baseName(path);
      if (!ALLOWED_EXT.test(name)) {
        toast(`Формат файла не поддерживается: ${name}`, "error");
        continue;
      }
      toast(`Загружаю ${name}…`);
      try {
        await invoke("upload_report_file", { reportId: activeReportId, filePath: path, initData: state.token || "" });
        toast(`Файл прикреплён: ${name}`);
        document.dispatchEvent(new CustomEvent("report-file-uploaded", { detail: { publicId: activeReportId } }));
      } catch (e) {
        toast(`Не удалось загрузить ${name}: ${e}`, "error");
      }
    }
  });
})();
