// Расширенные возможности Steam: разметка блока в настройках, окна входа по QR и результатов проверки.
// Чистые функции без обращения к Tauri — чтобы их можно было проверять тестами (сами вызовы Rust — в steam-session.js).

import qrcode from "qrcode-generator";

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** QR-код ссылки входа в виде масштабируемого SVG (чёрное на белом: так его читает камера телефона). */
export function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(String(text));
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

/** Ссылка входа — только адрес Steam: другое в QR не рисуем. */
export const isSteamQrUrl = u => typeof u === "string" && /^https:\/\/s\.team\/q\/\d+\/\d+$/.test(u);

export function reasonText(reason) {
  return ({
    idle: "Вход сброшен: неделю не пользовались расширенными возможностями.",
    expired: "Вход устарел или отозван в Steam. Войдите снова.",
    revoked: "Вход отозван в Steam. Войдите снова.",
  })[reason] || "";
}

/** Блок в настройках: включено / выключено. */
export function sessionHtml(st) {
  if (!st) return `<p class="ny-hint">Доступно только в приложении на компьютере.</p>`;
  if (st.signed_in) {
    return `<p><b class="gm-green">Включены</b> · аккаунт ${esc(st.account || st.steamid)}</p>
      <p class="ny-hint">Токен лежит только в хранилище Windows на этом компьютере и не отправляется на сервер. Если неделю не пользоваться, вход сбросится сам${st.days_left != null ? ` (осталось дней: ${Number(st.days_left)})` : ""}.</p>
      <div class="gm-d-act"><button type="button" class="btn ghost" data-sess-out>Выйти и стереть токен</button></div>`;
  }
  const why = reasonText(st.reason);
  return `${why ? `<p class="ny-hint gm-warn">${esc(why)}</p>` : ""}
    <p class="ny-hint">Откроют то, что Steam показывает только вошедшему: рекомендации и «очередь открытий», скидки из вашего желаемого, во что играют друзья, прогресс по достижениям, семейную библиотеку.
      Вход подтверждается в приложении Steam на телефоне, пароль сюда не вводится. Приложение только читает данные и ничего не меняет в аккаунте.
      Токен хранится лишь на этом компьютере (хранилище Windows) и на наш сервер не попадает.</p>
    <button type="button" class="btn primary" data-sess-in>Войти по QR-коду</button>`;
}

/** Короткий вариант для «Профиля»: только приглашение войти, а когда вход выполнен — ничего (управление в настройках). */
export function sessionCompactHtml(st) {
  if (!st || st.signed_in) return "";
  const why = reasonText(st.reason);
  return `<div class="gm-sess-line">${why ? `<span class="gm-warn">${esc(why)}</span>` : `<span class="ny-hint">Войдите в Steam по QR-коду, чтобы открыть личные подборки и сведения об аккаунте.</span>`}<button type="button" class="btn sm primary" data-sess-in>Войти по QR-коду</button></div>`;
}

/** Окно входа: QR и подсказка по текущему состоянию. */
export function qrSheetHtml(url, status) {
  const hint = status === "scanned"
    ? "Код отсканирован. Подтвердите вход на телефоне."
    : "Откройте приложение Steam на телефоне → Steam Guard (или значок щита) → «Сканировать QR-код» и наведите камеру.";
  return `<h2>Вход в Steam по QR-коду</h2>
    <div class="gm-qr" aria-label="QR-код входа в Steam">${isSteamQrUrl(url) ? qrSvg(url) : ""}</div>
    <p class="gm-qr-hint">${esc(hint)}</p>
    <p class="ny-hint">Вход называется «Project Desktop». Его можно отозвать в Steam в любой момент (Steam Guard → «Устройства»), а в программе — кнопкой «Выйти».</p>
    <div class="gm-d-act"><button type="button" class="btn" data-d-close>Отмена</button></div>`;
}

export function qrExpiredHtml() {
  return `<h2>Вход в Steam по QR-коду</h2>
    <p class="gm-qr-hint">Код устарел. Начните заново.</p>
    <div class="gm-d-act"><button type="button" class="btn primary" data-sess-in>Показать новый код</button><button type="button" class="btn" data-d-close>Закрыть</button></div>`;
}
