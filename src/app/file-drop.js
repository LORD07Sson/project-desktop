//
// Два разных действия в зависимости от того, что сейчас открыто:
// - открыта карточка отчёта (см. setDropTarget в report-detail.js) —
//   файл прикрепляется к ней. Привязка не по координатам курсора (в
//   физических пикселях, с масштабированием под DPI — легко
//   промахнуться мимо строки без реального железа под рукой), а по
//   тому, какая карточка ОТКРЫТА. Сами байты читает и шлёт на сервер
//   Rust-команда upload_report_file (см. main.rs) — так не нужен
//   tauri-plugin-fs с capability-скоупом на произвольный путь на диске.
// - карточка не открыта, а файл похож на аудио/видео (те же
//   расширения, что у кнопки «QC звука») — вместо ошибки запускаем
//   локальный QC прямо по перетащенному файлу (runQcAnalysis в
//   qc.js), путь уже известен из самого drop-события, диалог выбора
//   файла тут не нужен.

import { appWindow, invoke } from "./tauri.js";
import { state } from "./state.js";
import { toast } from "./api.js";
import { runQc, QC_EXTENSIONS } from "./qc.js";

let activeReportId = null;
export function setDropTarget(publicId) { activeReportId = publicId; }

// Всё, что можно приложить к отчёту = то, что понимает QC (аудио/видео)
// плюс документы и картинки. Тот же список продублирован в Rust
// (ALLOWED_UPLOAD_EXT в main.rs) — держать в синхроне руками,
// JS-проверку легко обойти, Rust-нельзя.
export const ATTACH_EXTENSIONS = [
  ...QC_EXTENSIONS, "png", "jpg", "jpeg", "webp", "pdf", "doc", "docx", "ppt", "pptx", "zip",
];
const extRe = list => new RegExp(`\\.(${list.join("|")})$`, "i");
const ALLOWED_EXT = extRe(ATTACH_EXTENSIONS);
const QC_EXT_RE = extRe(QC_EXTENSIONS);

function baseName(path) {
  return path.split(/[\\/]/).pop() || path;
}

// IIFE, не top-level await — тот же принцип, что и везде в проекте:
// не рассчитывать на фичи движка новее самого необходимого (см.
// историю с внешним import map, не подхватившимся в реальном WebView2).
(async () => {
  await appWindow.onDragDropEvent(async event => {
    const type = event.payload.type;
    if (type === "over" || type === "enter") {
      // Дроп что-то делает в любом случае (прикрепить к карточке ИЛИ
      // прогнать QC) — подсказку показываем всегда, а не только когда
      // есть открытая карточка.
      document.body.classList.add("drop-armed");
      return;
    }
    document.body.classList.remove("drop-armed");
    if (type !== "drop") return;

    const paths = event.payload.paths || [];

    // Открыт чат — перетаскивание туда пока не поддерживается (файл до 2 ГБ надо грузить частями, а drop отдаёт только путь).
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
      // Одним вызовом, а не циклом по файлам: на несколько дорожек
      // runQc открывает сводную таблицу вместо стопки модалок
      // (см. runQcBatch в qc.js).
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
