// project:// — ссылки на отчёты внутри программы: в заметках они
// кликабельны, у карточки отчёта есть кнопка «Копировать ссылку», а в
// Ctrl+K можно вставить ссылку и открыть. Регистрация схемы в системе
// (чтобы ссылка из Telegram запускала приложение) — отдельный шаг.

import { toast } from "./api.js";
import { openReportDetail } from "./report-detail.js";
import { parseProjectLink, reportLink } from "./deeplink-core.js";

export function openProjectLink(url) {
  const link = parseProjectLink(url);
  if (!link) return false;
  openReportDetail(link.id);
  return true;
}

document.addEventListener("click", async e => {
  const open = e.target.closest("[data-plink]");
  if (open) { e.preventDefault(); openProjectLink(open.dataset.plink); return; }
  const copy = e.target.closest("[data-copy-plink]");
  if (copy) {
    e.preventDefault();
    try { await navigator.clipboard.writeText(reportLink(copy.dataset.copyPlink)); toast("Ссылка скопирована.", "success"); }
    catch (_) { toast("Не удалось скопировать.", "error"); }
  }
});
