// Страница игры: «Обновления Steam» — текущая сборка и история сборок, которые мы записали (данные с сервера, /games/app/{id}/build).
// Чистые функции без DOM и сети: проверяются в scripts/games-test.mjs.

import { shortDate, fmtNum } from "./games-core.js";

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Размер: 72684619429 → «67,7 ГиБ»; нет данных — «—». */
export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return "—";
  const units = ["Б", "КиБ", "МиБ", "ГиБ", "ТиБ"];
  let i = 0, x = v;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: x >= 100 || i === 0 ? 0 : 1 }).format(x)} ${units[i]}`;
}

/** Дата и время «10 окт. 2026, 15:17» по метке времени (секунды). */
export function dateTime(ts, locale = "ru-RU") {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(locale, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Изменение размера между соседними записями: «+1,2 ГиБ», «−28,5 МиБ», пусто если не изменился. */
export function sizeDelta(cur, prev) {
  const a = Number(cur), b = Number(prev);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b || a <= 0 || b <= 0) return "";
  return `${a > b ? "+" : "−"}${fmtBytes(Math.abs(a - b))}`;
}

export function buildHtml(b) {
  if (!b || !b.available) return `<small class="ny-hint">Данные о сборке сейчас недоступны.</small>`;
  const rows = (b.history || []).map((h, i, all) => {
    const d = sizeDelta(h.size, all[i + 1] && all[i + 1].size);
    return `<tr><td>${esc(dateTime(h.updated || h.seen))}</td><td>${esc(h.buildid)}</td><td>${esc(fmtBytes(h.size))}${d ? ` <small class="ny-hint">${esc(d)}</small>` : ""}</td><td>${h.change ? esc(fmtNum(h.change)) : "—"}</td></tr>`;
  }).join("");
  return `<div class="gm-online-s gm-prof-s">
      <div><small>Сборка (публичная)</small><b>${esc(b.buildid)}</b></div>
      <div><small>Обновлена</small><b>${esc(dateTime(b.updated || b.built))}</b></div>
      <div><small>Размер на диске</small><b>${esc(fmtBytes(b.size))}</b></div>
      <div><small>Скачать</small><b>${esc(fmtBytes(b.download))}</b></div>
      <div><small>Номер изменения</small><b>${b.change ? esc(fmtNum(b.change)) : "—"}</b></div>
      ${b.release ? `<div><small>Выход в Steam</small><b>${esc(shortDate(b.release))}</b></div>` : ""}
    </div>
    ${rows ? `<table class="gm-sess-t gm-btable"><thead><tr><th>Обновлена</th><th>Сборка</th><th>Размер</th><th>Изменение</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
    <p class="ny-hint gm-hnote">Steam не хранит историю сборок в открытом виде, поэтому мы записываем её сами с того дня, как игру начали смотреть. Заметки к патчам — во вкладке «Патчноуты» ниже. Данные о сборке берутся из общедоступной копии данных клиента Steam (steamcmd.net), туда уходит только номер игры.</p>`;
}

/** Колонка «минимум у нас» в таблице цен по странам: цена и скидка, пусто если записей нет. */
export function lowestText(x, priceText) {
  if (!x || x.lowest == null) return "";
  return `${priceText({ final: x.lowest, initial: x.lowest, discount: 0, currency: x.currency })}${x.lowest_discount ? ` · −${x.lowest_discount}%` : ""}`;
}
