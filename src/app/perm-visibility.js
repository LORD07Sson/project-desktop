// Скрывает кнопки и вкладки, на которые у роли нет права (матрица «Права ролей»).
// Правила — по селекторам: элементы рисуются и динамически, поэтому проход повторяется при изменениях DOM.
// Сервер всё равно проверяет каждый запрос; здесь только убираем лишнее с глаз.

import { state, can } from "./state.js";

const REPORT_TABS = ["overview", "list", "board", "calendar", "feed", "analytics"].map(t => `.tab-btn[data-tab="${t}"]`).join(",");

const RULES = [
  [REPORT_TABS, "reports.view"],
  ["#titles-admin-btn", "titles.create"],
  ["#team-roles-btn", "roles.manage"],
  ["#tn-edit", "notice.manage"],
];

export function applyPermVisibility() {
  if (!state.perms) return;
  for (const [selector, perm] of RULES) {
    const allowed = can(perm);
    document.querySelectorAll(selector).forEach(el => {
      if (allowed) el.removeAttribute("data-perm-hidden"); else el.setAttribute("data-perm-hidden", "1");
      // Роль без звания админа: CSS прячет админские кнопки у «участника» — для выданного права снимаем это.
      if (allowed && !state.isAdmin) el.setAttribute("data-perm-show", "1"); else el.removeAttribute("data-perm-show");
    });
  }
  document.documentElement.dataset.permReports = can("reports.view") && !state.isAdmin ? "1" : "0";
}

let observer = null;
export function startPermVisibility() {
  applyPermVisibility();
  if (observer || typeof MutationObserver === "undefined") return;
  let queued = false;
  observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; applyPermVisibility(); });
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
