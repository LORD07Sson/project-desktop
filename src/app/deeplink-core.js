// Ссылки project:// на объекты программы. Чистые функции.
//   project://report/<публичный id>  — карточка отчёта
// Публичный id — буквы, цифры, «-», «_», «.»; всё остальное — не ссылка.

const RE = /^project:\/\/report\/([A-Za-z0-9._-]{1,64})\/?$/;
const RE_INLINE = /project:\/\/report\/[A-Za-z0-9._-]{1,64}/g;

const RE_LT = /^luatools:\/\/(game|install|fix)\/(\d{1,10})\/?$/;

export function parseLuaToolsLink(value) {
  const m = RE_LT.exec(String(value || "").trim());
  return m ? { kind: m[1], appId: parseInt(m[2], 10) } : null;
}

export function reportLink(id) {
  return `project://report/${id}`;
}

export function parseProjectLink(value) {
  const m = RE.exec(String(value || "").trim());
  return m ? { kind: "report", id: m[1] } : null;
}

/** В УЖЕ экранированном тексте (esc) превращает project://report/… в ссылки. */
export function linkifyProject(escapedText) {
  return String(escapedText).replace(RE_INLINE, url => `<a href="#" class="pl" data-plink="${url}">${url}</a>`);
}
