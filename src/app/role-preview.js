// «Смотреть как…» — владелец примеряет роль (даббер, звукарь, админ, участник), чтобы проверить, что ей видно и
// что разрешено. Каждый запрос уходит с заголовком X-Preview-Role, и сервер отвечает так, будто это человек
// с этой ролью: те же вкладки, кнопки и те же 403. Примерка живёт до закрытия программы (sessionStorage);
// при смене — перезагрузка окна, чтобы ничего не осталось от прежних прав.

import { state } from "./state.js";
import { esc } from "./utils.js";

const KEY = "preview-role";

export function setPreviewRole(role) {
  try {
    if (role) sessionStorage.setItem(KEY, role); else sessionStorage.removeItem(KEY);
  } catch (_) { /* без хранилища примерка просто не переживёт перезагрузку */ }
  location.reload();
}

export function addPreviewHeader(headers) {
  if (state.previewRole) headers["X-Preview-Role"] = encodeURIComponent(state.previewRole);
  return headers;
}

const label = role => role.charAt(0).toUpperCase() + role.slice(1);

// Список вариантов для выпадашки — пусто, если человек не владелец.
export function previewOptionsHtml() {
  const choices = state.previewChoices || [];
  return `<option value="">Как есть (владелец)</option>` + choices.map(r => `<option value="${esc(r)}"${r === state.previewRole ? " selected" : ""}>${esc(label(r))}</option>`).join("");
}

// Ответ /me/permissions: что можно примерить и что сервер принял. Роль удалили или сервер старый — снимаем примерку.
export function syncPreview(preview) {
  state.previewChoices = preview && Array.isArray(preview.choices) ? preview.choices : null;
  if (state.previewRole && !(preview && preview.active)) {
    setPreviewRole(null);
    return;
  }
  renderBanner();
}

function renderBanner() {
  let bar = document.getElementById("role-preview-bar");
  if (!state.previewRole) { bar?.remove(); delete document.documentElement.dataset.preview; return; }
  document.documentElement.dataset.preview = "1";
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "role-preview-bar";
    bar.setAttribute("role", "status");
    document.body.appendChild(bar);
    bar.addEventListener("change", e => { if (e.target.matches("select")) setPreviewRole(e.target.value || null); });
    bar.addEventListener("click", e => { if (e.target.closest("[data-rp-exit]")) setPreviewRole(null); });
  }
  bar.innerHTML = `<span class="rp-eye" aria-hidden="true">👁</span><b>Предпросмотр</b>
    <select aria-label="Смотреть как">${previewOptionsHtml()}</select>
    <button type="button" class="rp-exit" data-rp-exit>Выйти</button>`;
}
