// Nyaa/игры, вынесено из games-space.js: Релизы: календарь и список по неделям (по образцу SteamDB).
import { apiGet, dismissSheet, dialogSkeletonHtml } from "./api.js";
import { $, esc } from "./utils.js";
import { sortLibrary, dayLabel, addDays, mondayOf, isoWeek, monthWeeks, rollingWeeks, monthTab, nextMonths, fmtHours, initials2, fmtNum } from "./games-core.js";
import { notifyKinds } from "./desktop-notify.js";
import { empty, errBox, gmSheet, img, libFamily, libFilter, libSort, libUnplayed, loadLibrary, me, paintSession, picHtml, pollMs, skeleton, tab } from "./games-space.js";
import { priceCell, thead } from "./games-charts.js";
import { loadStatus, openDetail } from "./games-card.js";

// ---------- Релизы: календарь и список по неделям (по образцу SteamDB) ----------
export const relToday = () => new Date().toISOString().slice(0, 10);
export let rel = { view: "cal", month: "roll", week: null, only: "all", kind: "all", q: "", range: null };
export let relTimer = 0, relCycle = 0;
export const relCells = new Map();      // дата → игры дня, между которыми листает клетка календаря
const WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const MON_SHORT = ["янв.", "фев.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сен.", "окт.", "ноя.", "дек."];
const cycleOn = () => { try { return localStorage.getItem("project-games-cycle") === "1"; } catch (_) { return false; } };   // по умолчанию вручную: наведите на полоску
export const adultOn = () => { try { return localStorage.getItem("project-games-adult") === "1"; } catch (_) { return false; } };
export const adultParam = () => (adultOn() ? 1 : "");
const persOn = () => { try { return localStorage.getItem("project-games-pers") === "1"; } catch (_) { return false; } };
const persParam = () => (persOn() ? 1 : "");
const persLabel = () => `<label class="gm-cyc gm-adult" title="В клетках и списке выше стоят игры, похожие на то, во что вы играете"><input type="checkbox" data-pers${persOn() ? " checked" : ""}> Под мой вкус</label>`;
export const adultLabel = () => `<label class="gm-cyc gm-adult" title="Игры с пометкой «для взрослых» скрыты, пока не включите"><input type="checkbox" data-adult${adultOn() ? " checked" : ""}> Показывать игры для взрослых (18+)</label>`;
export const monthLong = ym => new Date(`${ym}-01T12:00:00Z`).toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" });

function relBarHtml() {
  const today = relToday();
  const views = [["cal", "Календарь"], ["list", "Список"]].map(([k, l]) => `<button type="button" class="${rel.view === k ? "on" : ""}" data-rview="${k}">${l}</button>`).join("");
  let extra = "";
  if (rel.view === "cal") {
    const tabs = [["roll", "Ближайшие недели"], ...nextMonths(today, 9).map(m => [m, monthTab(m)])];
    extra = `<div class="gm-chips gm-rtabs">${tabs.map(([k, l]) => `<button type="button" class="gm-chip${rel.month === k ? " on" : ""}" data-rmonth="${k}">${l}</button>`).join("")}</div>`;
  } else {
    const lab = d => `${Number(d.slice(8))} ${MON_SHORT[Number(d.slice(5, 7)) - 1]}`;
    const kinds = [["all", "Все"], ["up", "Предстоящие"], ["done", "Вышедшие"]].map(([k, l]) => `<button type="button" class="${rel.kind === k ? "on" : ""}" data-rkind="${k}">${l}</button>`).join("");
    const nav = rel.range
      ? `<b class="gm-rwk">${esc(rel.range.label)}</b><button type="button" class="btn sm" data-rweek="0">К неделям</button>`
      : `<button type="button" class="btn sm" data-rweek="-1">‹ Неделя ${isoWeek(addDays(rel.week, -7))}</button><b class="gm-rwk">Неделя ${isoWeek(rel.week)} · ${lab(rel.week)} — ${lab(addDays(rel.week, 6))}</b><button type="button" class="btn sm" data-rweek="1">Неделя ${isoWeek(addDays(rel.week, 7))} ›</button><button type="button" class="btn sm ghost" data-rweek="0">Сегодня</button>`;
    extra = `<div class="gm-bar gm-rweek">${nav}<span class="ny-sp"></span><div class="ny-seg">${kinds}</div>
      <input id="gm-rq" class="gm-lf" type="text" placeholder="Поиск по названию" value="${esc(rel.q)}" spellcheck="false"><select id="gm-ronly"><option value="all"${rel.only === "all" ? " selected" : ""}>Все игры</option><option value="wish"${rel.only === "wish" ? " selected" : ""}>Только из желаемого</option><option value="owned"${rel.only === "owned" ? " selected" : ""}>Только из библиотеки</option></select>${persLabel()}${adultLabel()}</div>`;
  }
  return `<div class="gm-bar"><div class="ny-seg">${views}</div><span class="ny-sp"></span><span class="ny-hint gm-rnote">Даты берутся из Steam: точную дату выхода объявляют не все игры</span></div>${extra}`;
}

export async function paintReleases() {
  clearInterval(relCycle);
  const body = $("#gm-body");
  if (!rel.week) rel.week = mondayOf(relToday());
  body.innerHTML = `<div id="gm-rbar">${relBarHtml()}</div><div id="gm-rbody">${skeleton(7)}</div>`;
  await (rel.view === "cal" ? paintRelCal() : paintRelList());
}

// Клетки календаря листают игры дня (как «Automatically cycle games» у SteamDB): каждые ~4 секунды со сдвигом по клеткам.
export function relCycleStart() {
  clearInterval(relCycle);
  if (!cycleOn()) return;
  let tick = 0;
  relCycle = setInterval(() => { // DevSkim: ignore DS172411 — функция, не строка
    if (tab !== "rel" || rel.view !== "cal") { clearInterval(relCycle); return; }
    tick++;
    let n = 0;
    document.querySelectorAll(".gm-rc-cell[data-date]").forEach(cell => {
      const items = relCells.get(cell.dataset.date);
      if (!items || items.length < 2 || (n++ + tick) % 3 !== 0) return;
      const i = (Number(cell.dataset.i || 0) + 1) % items.length;
      cell.dataset.i = String(i);
      relPaintCell(cell, items, i);
    });
  }, 2000);
}

export function relPaintCell(cell, items, i) {
  const it = items[i];
  const flag = it.wishlisted ? `<i class="gm-star" title="В желаемом">★</i>` : it.owned ? `<i class="gm-flag own">В БИБЛИОТЕКЕ</i>` : "";
  const btn = cell.querySelector(".gm-rc-it");
  btn.dataset.app = it.appid; btn.dataset.name = it.name; btn.title = it.name;
  btn.innerHTML = picHtml(it.appid, it.port, it.name, "gm-img gm-port", flag);
  cell.querySelectorAll(".gm-pips i").forEach((p, k) => p.classList.toggle("cur", k === i));
}

async function paintRelCal() {
  const today = relToday();
  const weeks = rel.month === "roll" ? rollingWeeks(addDays(today, -7), 7) : monthWeeks(rel.month);
  const from = weeks[0][0], to = weeks[weeks.length - 1][6];
  try {
    const r = await apiGet("/games/releases/calendar", { from, to, adult: adultParam(), pers: persParam() });
    const box = $("#gm-rbody");
    if (tab !== "rel" || rel.view !== "cal" || !box) return;
    const by = new Map((r.days || []).map(d => [d.date, d]));
    relCells.clear();
    const cell = date => {
      const d = by.get(date);
      const out = rel.month !== "roll" && date.slice(0, 7) !== rel.month;
      const dn = Number(date.slice(8));
      if (d) relCells.set(date, d.items);
      const pips = d ? `<span class="gm-pips" title="Наведите на полоску, чтобы увидеть игру. Выходов в этот день: ${d.count}">${[0, 1, 2, 3, 4].map(i => `<i${i < d.items.length ? ` data-pip="${date}:${i}" title="${esc(d.items[i].name)}"` : ""} class="${i < d.items.length ? (d.items[i].hot ? "hot" : "on") : ""}${i === 0 ? " cur" : ""}"></i>`).join("")}</span>` : "";
      const head = `<div class="gm-rc-h"><button type="button" class="gm-rc-day" data-rday="${date}" title="Все выходы дня">${dn}${dn === 1 ? ` ${MON_SHORT[Number(date.slice(5, 7)) - 1]}` : ""}</button>${pips}${d && d.count > d.items.length ? `<button type="button" class="gm-rc-more" data-rday="${date}">+${d.count - d.items.length}</button>` : ""}</div>`;
      const first = d ? d.items[0] : null;
      const flag = first && first.wishlisted ? `<i class="gm-star" title="В желаемом">★</i>` : first && first.owned ? `<i class="gm-flag own">В БИБЛИОТЕКЕ</i>` : "";
      const body = first ? `<button type="button" class="gm-rc-it" data-app="${first.appid}" data-name="${esc(first.name)}" title="${esc(first.name)}">${picHtml(first.appid, first.port, first.name, "gm-img gm-port", flag)}</button>` : `<div class="gm-rc-empty"></div>`;
      return `<div class="gm-rc-cell${date === today ? " today" : ""}${out ? " out" : ""}"${d ? ` data-date="${date}" data-i="0"` : ""}>${head}${body}</div>`;
    };
    const months = rel.month === "roll" ? [...new Set(weeks.flat().map(d => d.slice(0, 7)))].filter(m => m >= today.slice(0, 7)) : [rel.month];
    const und = months.map(ym => {
      const u = (r.undated || {})[ym];
      if (!u || !u.items.length) return "";
      return `<section class="gm-rund"><h3>Выходы в ${esc(monthLong(ym))} без точного дня <small class="ny-hint">всего ${fmtNum(u.total)}, показаны самые ожидаемые</small></h3><div class="gm-rund-g">${u.items.map(g => `<button type="button" class="gm-card" data-app="${g.appid}" data-name="${esc(g.name)}">${picHtml(g.appid, g.cap, g.name, "gm-img", g.wishlisted ? `<i class="gm-heart" title="В желаемом">♥</i>` : "")}<div class="gm-t">${esc(g.name)}</div></button>`).join("")}</div><div class="gm-moreb"><button type="button" class="btn sm" data-rmonthlist="${ym}">Все выходы: ${esc(monthLong(ym))}</button></div></section>`;
    }).join("");
    box.innerHTML = `<div class="gm-rc"><div class="gm-rc-wd"><span>Нед.</span>${WD.map(w => `<span>${w}</span>`).join("")}</div>${weeks.map(w => `<div class="gm-rc-row"><button type="button" class="gm-rc-wk" data-rwkdate="${w[0]}" title="Выходы этой недели списком">${isoWeek(w[0])}</button>${w.map(cell).join("")}</div>`).join("")}</div>
      <div class="gm-rcact"><button type="button" class="btn sm" data-rrange="up">Все предстоящие выходы</button><button type="button" class="btn sm" data-rrange="done">Недавно вышедшие</button><label class="gm-cyc"><input type="checkbox" id="gm-cyc"${cycleOn() ? " checked" : ""}> Автоматически листать игры</label>${persLabel()}${adultLabel()}</div>
      ${und}
      <ul class="gm-rleg"><li>В каждой клетке самая ожидаемая игра дня. Наведите мышь на полоску в шапке клетки, чтобы увидеть следующую игру (до пяти). Зелёные полоски — самые популярные.</li><li>★ — игра из вашего желаемого. Игры для взрослых скрыты, пока не включена галочка 18+.</li><li>Нажмите на число дня, чтобы увидеть все выходы дня, или на номер недели — выходы недели списком.</li><li>Прошедшие дни показывают только самые популярные вышедшие игры (Steam не отдаёт полный список).</li></ul>`;
    relCycleStart();
  } catch (e) { const box = $("#gm-rbody"); if (box) box.innerHTML = errBox(e); }
}

const expectBar = rank => { const w = Math.max(6, Math.round(100 - Math.log10(Math.max(1, rank)) * 20)); return `<span class="gm-exp"><i style="width:${w}%"></i></span><small class="ny-hint">топ-${fmtNum(rank)}</small>`; };

export async function paintRelList() {
  const from = rel.range ? rel.range.from : rel.week;
  const to = rel.range ? rel.range.to : addDays(rel.week, 6);
  try {
    const r = await apiGet("/games/releases", { from, to, q: rel.q, only: rel.only === "all" ? "" : rel.only, kind: rel.kind === "all" ? "" : rel.kind, adult: adultParam(), pers: persParam() });
    const box = $("#gm-rbody");
    if (tab !== "rel" || rel.view !== "list" || !box) return;
    const rows = r.items.map(g => {
      const lb = dayLabel(g.day);
      const flag = g.wishlisted ? `<i class="gm-star sm" title="В желаемом">★</i>` : g.owned ? `<i class="gm-own2" title="В библиотеке">✓</i>` : "";
      const rating = g.pct != null && g.reviews >= 10 ? `<span class="gm-tc"><b class="${g.pct >= 70 ? "gm-green" : g.pct >= 40 ? "" : "gm-red"}">${g.pct}%</b><small class="ny-hint">${fmtNum(g.reviews)}</small></span>` : `<span class="gm-tc ny-hint">—</span>`;
      return `<div class="gm-tr" data-app="${g.appid}" data-name="${esc(g.name)}"><span class="gm-rk">${flag}</span>${picHtml(g.appid, g.cap, g.name, "gm-img gm-tth")}<span class="gm-tn"><b>${esc(g.name)}</b>${g.tags && g.tags.length ? `<small class="ny-hint">${esc(g.tags.join(" · "))}</small>` : ""}</span>${g.price ? priceCell(g.price) : `<span class="gm-tc ny-hint">—</span>`}${rating}<span class="gm-tc"><b>${lb.date}</b><small class="ny-hint">${g.released ? "вышла" : lb.dow}</small></span><span class="gm-tc">${g.released ? (g.online != null ? `<b class="gm-green">${fmtNum(g.online)}</b>` : "—") : "—"}</span><span class="gm-tc gm-exp-c">${expectBar(g.rank)}</span></div>`;
    }).join("");
    const title = rel.range ? rel.range.label : `Выходы на неделе ${isoWeek(rel.week)}`;
    box.innerHTML = `<div class="gm-rl-hero"><h2>${esc(title)}</h2><p>${fmtNum(r.total)} ${r.total === 1 ? "игра" : "игр"} с объявленной датой${r.total >= 400 ? " (показаны первые 400)" : ""}</p></div>`
      + (rows ? `<div class="gm-tbl gm-rl" style="--cols:30px 110px minmax(0,1fr) 120px 100px 90px 90px 150px">${thead(["", "", "Игра", "Цена", "Рейтинг", "Выход", "Онлайн", "Ожидание"])}${rows}</div>` : empty("Ничего не найдено", "Смените период или сбросьте фильтры."));
  } catch (e) { const box = $("#gm-rbody"); if (box) box.innerHTML = errBox(e); }
}

export async function openRelDay(date) {
  const ov = gmSheet(dialogSkeletonHtml(5), "wide");
  const lb = dayLabel(date);
  try {
    const r = await apiGet("/games/releases", { from: date, to: date, adult: adultParam() });
    ov.querySelector(".sheet").innerHTML = `<h2>Выходы ${lb.dow}, ${lb.date}: ${fmtNum(r.total)}</h2><div class="gm-list gm-impl">${r.items.map(g => `<div class="gm-row" data-rd-app="${g.appid}" data-name="${esc(g.name)}">${picHtml(g.appid, g.cap, g.name, "gm-img gm-rimg")}<div class="gm-row-t"><b>${esc(g.name)}</b><small>${esc((g.tags || []).join(" · "))}</small></div>${g.wishlisted ? `<i class="gm-star sm">★</i>` : ""}${g.price ? priceCell(g.price) : "<span></span>"}</div>`).join("")}</div><div class="gm-d-act"><button type="button" class="btn ghost" data-d-close>Закрыть</button></div>`;
  } catch (e) { ov.querySelector(".sheet").innerHTML = `${errBox(e)}<div class="gm-d-act"><button type="button" class="btn" data-d-close>Закрыть</button></div>`; }
  ov.addEventListener("click", ev => {
    if (ev.target.closest("[data-d-close]")) { dismissSheet(ov); return; }
    const row = ev.target.closest("[data-rd-app]");
    if (row) { dismissSheet(ov); openDetail(Number(row.dataset.rdApp), row.dataset.name || ""); }
  });
}

export async function paintLib() {
  const body = $("#gm-body");
  if (!me || !me.steamid) { body.innerHTML = empty("Steam не привязан", "Привяжите аккаунт, чтобы увидеть свои игры и запускать их отсюда.", `<button type="button" class="btn primary" data-gadd>Привязать Steam</button>`); return; }
  body.innerHTML = skeleton(8);
  try {
    const l = await loadLibrary(true);
    if (tab !== "lib") return;
    const f = libFilter.toLowerCase();
    const items = sortLibrary(l.items.filter(g => !f || String(g.name).toLowerCase().includes(f)), libSort, libUnplayed);
    const lsorts = [["recent", "недавние"], ["hours", "по часам"], ["name", "по названию"]].map(([k, n]) => `<option value="${k}"${libSort === k ? " selected" : ""}>${n}</option>`).join("");
    body.innerHTML = `<div class="gm-bar"><span class="gm-count">${items.length === l.items.length ? l.items.length : `${items.length} из ${l.items.length}`} игр</span><div class="ny-seg"><button type="button" class="${libUnplayed ? "on" : ""}" data-lunplayed>Не запускал</button><button type="button" data-lrandom title="Случайная игра из списка">🎲 Случайная</button><button type="button" class="${libFamily ? "on" : ""}" data-lfamily title="Показать и игры, которыми с вами делятся по семейному доступу">Семейная</button></div><label class="gm-sort">Сортировка <select id="gm-lsort">${lsorts}</select></label><span class="ny-sp"></span><input id="gm-lf" class="gm-lf" type="text" placeholder="Фильтр по названию" value="${esc(libFilter)}" spellcheck="false"></div>`
      + (items.length ? `<div class="gm-grid">${items.map(g => `<div class="gm-card lib" data-app="${g.appid}" data-name="${esc(g.name)}" role="button" tabindex="0">${picHtml(g.appid, g.image, g.name)}<div class="gm-t">${esc(g.name)}</div><div class="gm-pr"><small title="${g.hours_deck ? `На Steam Deck: ${esc(fmtHours(g.hours_deck))}` : ""}">${esc(fmtHours(g.hours))}${g.hours_deck ? " · 🎮" : ""}</small><button type="button" class="btn primary sm" data-launch="${g.appid}">Запустить</button></div></div>`).join("")}</div>` : empty("Ничего не найдено", "Библиотека пуста или фильтр слишком строгий."));
  } catch (e) { body.innerHTML = errBox(e); }
}

export function paintSettings() {
  const body = $("#gm-body");
  if (!me) { body.innerHTML = ""; return; }
  const cc = Object.entries(me.countries || {}).map(([k, n]) => `<option value="${k}"${k === me.cc ? " selected" : ""}>${esc(n)} (${k})</option>`).join("");
  const accs = (me.accounts || []).map(a => `<div class="gm-acc${a.steamid === me.steamid ? " on" : ""}"><i class="gm-ava">${a.avatar ? `<img src="${esc(img(a.avatar))}" alt="">` : `<span>${esc(initials2(a.name))}</span>`}</i><div><b>${esc(a.name || a.steamid)}</b><small>${a.steamid === me.steamid ? "активный" : a.steamid}</small></div><span class="ny-sp"></span>${a.steamid === me.steamid ? "" : `<button type="button" class="btn sm" data-gsel="${a.steamid}">Сделать активным</button>`}<button type="button" class="btn ghost sm" data-gunlink="${a.steamid}">Отвязать</button></div>`).join("");
  body.innerHTML = `<div class="gm-set">
    <section><h3>Страна цен</h3><p class="ny-hint">От страны зависят цена и валюта в магазине Steam. У каждого профиля своя.</p><select id="gm-cc">${cc}</select></section>
    <section><h3>Аккаунты Steam</h3>${accs || `<p class="ny-hint">Пока ни одного.</p>`}<button type="button" class="btn primary" data-gadd>Привязать аккаунт Steam</button>
      <p class="ny-hint">Вход идёт через сайт Steam, пароль в Project не вводится. Чтобы видеть библиотеку, в Steam → «Настройки конфиденциальности» → «Сведения об играх» поставьте «Открытый».${me.steam_key ? "" : " На сервере не задан ключ Steam Web API — библиотека недоступна."}</p></section>
    <section><h3>Уведомления о цене</h3><p class="ny-hint">Сервер проверяет «Желаемое» каждые 30 минут и пишет в Telegram. Здесь — как часто программа забирает их себе.</p>
      <label class="gm-sort"><input type="checkbox" id="gm-npr"${notifyKinds().price === false ? "" : " checked"}> всплывашки Windows о ценах</label>
      <label class="gm-sort">Проверять раз в <select id="gm-poll">${[[60000, "минуту"], [120000, "2 минуты"], [300000, "5 минут"], [900000, "15 минут"]].map(([v, l]) => `<option value="${v}"${pollMs() === v ? " selected" : ""}>${l}</option>`).join("")}</select></label></section>
    <section><h3>Список желаемого</h3><p class="ny-hint">Резервная копия или перенос на другой аккаунт.</p><div class="gm-d-act"><button type="button" class="btn" data-wl-export>Скопировать список</button><button type="button" class="btn" data-wl-import>Импортировать…</button></div></section>
    <section><h3>Вход в Steam (личные подборки)</h3><div id="gm-sess-body"><small class="ny-hint">Проверяю…</small></div></section>
    <section><h3>Состояние сервера</h3><div id="gm-status"><small class="ny-hint">Загружаю…</small></div></section>
  </div>`;
  loadStatus();
  paintSession();
}


export function setRelTimer(value) { relTimer = value; return value; }
