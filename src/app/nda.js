// Окно соглашения о неразглашении при входе. Показывается один раз на
// пользователя (и снова — при смене версии текста в nda-core.js).
// Закрыть его иначе, чем «Согласен» или выйти из аккаунта, нельзя:
// Escape и клик по фону возвращают окно обратно. Принятие хранится на
// этом компьютере; на сервер оно пока не отправляется.

import { state } from "./state.js";
import { openSheet } from "./api.js";
import { $, esc } from "./utils.js";
import { NDA_TEXT, ndaAccepted, acceptNda } from "./nda-core.js";

let open = false;

export function maybeAskNda() {
  if (open || ndaAccepted(localStorage, state.telegramId)) return;
  open = true;
  const overlay = openSheet(`
    <div class="nda">
      <span class="kd-label">Перед началом</span>
      <h2>Соглашение о неразглашении</h2>
      ${NDA_TEXT.map(p => `<p>${esc(p)}</p>`).join("")}
      <div class="nda-actions">
        <button class="btn primary" id="nda-yes">Согласен</button>
        <button class="btn ghost" id="nda-no">Не согласен — выйти</button>
      </div>
    </div>`);
  const close = () => { open = false; overlay.remove(); };
  overlay.querySelector("#nda-yes").addEventListener("click", () => {
    acceptNda(localStorage, state.telegramId);
    close();
  });
  overlay.querySelector("#nda-no").addEventListener("click", () => {
    close();
    $("#logout-btn")?.click();
  });
  // Закрытие «снаружи» (Escape, клик по фону) — не отказ и не согласие.
  overlay.addEventListener("sheet-dismissed", () => {
    open = false;
    setTimeout(maybeAskNda, 0);
  });
}
