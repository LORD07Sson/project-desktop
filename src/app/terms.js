// Пользовательское соглашение: единственный источник текста — src/terms/user-agreement.md (Markdown), здесь он только
// показывается. Рисуем минимальным разбором (заголовки, абзацы, списки, жирное), без внешних библиотек.

import raw from "../terms/user-agreement.md?raw";
import { openSheet, dismissSheet } from "./api.js";
import { esc } from "./utils.js";

function inline(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

export function termsHtml(md = raw) {
  const out = [];
  let list = null; // "ul" | "ol"
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) { closeList(); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(t))) {
      closeList();
      const level = m[1].length;
      out.push(`<h${level + 1} class="terms-h${level}">${inline(m[2])}</h${level + 1}>`);
    } else if ((m = /^[-*]\s+(.*)$/.exec(t))) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = /^\d+\.\s+(.*)$/.exec(t))) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else {
      closeList();
      out.push(`<p>${inline(t)}</p>`);
    }
  }
  closeList();
  return out.join("");
}

export function openTerms() {
  const overlay = openSheet(`
    <div class="terms-doc">${termsHtml()}</div>
    <div class="sheet-actions"><button type="button" class="btn primary" data-close>Закрыть</button></div>`, "wide");
  overlay.querySelector("[data-close]").addEventListener("click", () => dismissSheet(overlay));
}

// Любая кнопка или ссылка с data-open-terms открывает соглашение (в том числе на экране входа, где модулей ещё нет).
export function installTermsLinks() {
  document.addEventListener("click", e => {
    const el = e.target.closest && e.target.closest("[data-open-terms]");
    if (!el) return;
    e.preventDefault();
    openTerms();
  });
}
