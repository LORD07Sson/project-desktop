// Вкладка «Календарь» в духе «Кадра»: слева расписание на две недели —
// сроки серий полосами от начала работы до сдачи (ромб — срок), справа
// повестка выбранного дня и месяц. Что в ней:
//  • выход серий онгоингов текущего сезона — по next_episode_at из
//    /public/titles/{id}: дальше и раньше серия повторяется раз в неделю
//    в то же время, номер серии считаем от episodes_aired;
//  • дедлайны отчётов (/reports?sort=deadline) — дата без времени, строка
//    «Весь день» сверху;
//  • дни рождения из /overview — тоже «Весь день».

import { state } from "./state.js";
import { fetchReminders, openRemindersSheet } from "./reminders.js";
import { apiGet, dialogSkeletonHtml, mediaUrl } from "./api.js";
import { $, esc, STATUS_COLOR_VAR } from "./utils.js";
import { openReportDetail } from "./report-detail.js";
import { switchTab } from "./tabs.js";
import { openBirthdaysSheet } from "./birthdays.js";

const DAY_MS = 86400000;
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
// Цвета блоков серий: тайтл получает один и тот же оттенок всю неделю.
const TITLE_HUES = ["#3b5bdb", "#9c36b5", "#c2255c", "#e8590c", "#2b8a3e", "#1098ad", "#5f3dc4", "#d9480f"];

const FILTER_KEY = () => `project_calendar_filters_${state.telegramId || "anon"}`;
const LAYERS = { episodes: "Серии", deadlines: "Дедлайны", birthdays: "Дни рождения", reminders: "Мои напоминания" };

let weekStart = startOfWeek(new Date());
let nowTimer = null;
let requestSeq = 0;

function startOfWeek(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const wd = (x.getDay() + 6) % 7; // Пн = 0
  x.setDate(x.getDate() - wd);
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function sameDay(a, b) { return ymd(a) === ymd(b); }
function hhmm(d) { return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
function hueFor(id) { return TITLE_HUES[Math.abs(Number(id) || 0) % TITLE_HUES.length]; }

function getFilters() {
  try {
    const v = JSON.parse(localStorage.getItem(FILTER_KEY()) || "null");
    if (v && typeof v === "object") return { episodes: v.episodes !== false, deadlines: v.deadlines !== false, birthdays: v.birthdays !== false, reminders: v.reminders !== false };
  } catch (_) { /* по умолчанию всё включено */ }
  return { episodes: true, deadlines: true, birthdays: true, reminders: true };
}
function setFilters(f) {
  try { localStorage.setItem(FILTER_KEY(), JSON.stringify(f)); } catch (_) { /* не критично */ }
}

// ---------- данные ----------

async function fetchAirings() {
  let seasons;
  try { seasons = (await apiGet("/public/seasons")).seasons || []; } catch (_) { return []; }
  if (!seasons.length) return [];
  // Эфир-сезоны отсортированы сервером от свежего к старому — онгоинги
  // живут в первом, реже во втором (длинные двухкуровые сериалы).
  const titles = [];
  for (const s of seasons.slice(0, 2)) {
    try { titles.push(...((await apiGet(`/public/seasons/${s.id}/titles`)).titles || [])); } catch (_) { /* пропускаем сезон */ }
  }
  const out = [];
  const queue = titles.slice();
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      try {
        const d = await apiGet(`/public/titles/${t.id}`);
        const det = d.details && !Array.isArray(d.details) ? d.details : null;
        if (det && det.next_episode_at) out.push({ title: t, det });
      } catch (_) { /* без расписания */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  return out;
}

// Ход нашей работы по сериям взятых тайтлов (/work/episodes, только
// админам): {title_id: {номер: {total, completed, overdue}}}.
async function fetchWork() {
  if (!state.isAdmin) return {};
  try { return (await apiGet("/work/episodes")).titles || {}; } catch (_) { return {}; }
}

// Подпись серии взятого тайтла: что с ней у студии.
function workPill(e, work, past) {
  const eps = work[String(e.id)];
  if (!eps) return "";
  const st = eps[String(e.num)];
  if (!st) return past ? `<em class="cal-work todo">не заведена</em>` : `<em class="cal-work">ждём выхода</em>`;
  if (st.completed >= st.total) return `<em class="cal-work done">готово</em>`;
  if (st.overdue) return `<em class="cal-work late">опаздываем · ${st.completed}/${st.total}</em>`;
  return `<em class="cal-work wip">в работе · ${st.completed}/${st.total}</em>`;
}

async function fetchDeadlines(from, to) {
  const out = [];
  for (let page = 0; page < 5; page++) {
    let r;
    try { r = await apiGet("/reports", { sort: "deadline", page, page_size: 100 }); } catch (_) { break; }
    const list = r.reports || [];
    for (const rep of list) {
      if (rep.deadline && rep.deadline >= from && rep.deadline <= to) out.push(rep);
    }
    const last = list[list.length - 1];
    if (list.length < 100 || !last || !last.deadline || last.deadline > to) break;
  }
  return out;
}

// Полный список (/birthdays); на старом сервере без него — 5 ближайших
// из /overview.
async function fetchBirthdays() {
  try { return (await apiGet("/birthdays")).birthdays || []; } catch (_) { /* старый сервер */ }
  try { return (await apiGet("/overview")).birthdays || []; } catch (_) { return []; }
}

// ---------- «Кадр»: расписание на две недели, повестка дня, месяц ----------

const RANGE_DAYS = 14;
const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const WD_LONG = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const BDAY_COLOR = "#ff8fb0";
const REM_COLOR = "#78aefc";
const pad2 = n => String(n).padStart(2, "0");
const cleanLabel = s => String(s || "").replace(/^[^\p{L}\p{N}]+/u, "");
const dayDiff = (a, b) => Math.round((startOfDay(a) - startOfDay(b)) / DAY_MS);
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function parseDay(s) { const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); }

let selected = startOfDay(new Date());
let monthCursor = new Date(selected.getFullYear(), selected.getMonth(), 1);

// Серии тайтлов в промежутке [start, end): next_episode_at ± k недель.
function airingsBetween(airings, start, end) {
  const events = [];
  for (const { title, det } of airings) {
    const next = new Date(det.next_episode_at);
    if (Number.isNaN(next.getTime())) continue;
    const nextNum = (det.next_episode ?? ((det.episodes_aired || 0) + 1));
    const k0 = Math.floor((start - next) / (7 * DAY_MS));
    const k1 = Math.ceil((end - next) / (7 * DAY_MS));
    for (let k = k0; k <= k1; k++) {
      const at = new Date(next.getTime() + k * 7 * DAY_MS);
      if (at < start || at >= end) continue;
      const num = nextNum + k;
      if (num < 1 || (det.episodes_total && num > det.episodes_total)) continue;
      events.push({ kind: "episode", at, id: title.id, name: title.name, poster: title.poster_url, num, total: det.episodes_total, minutes: det.duration_min || 24, color: hueFor(title.id) });
    }
  }
  return events;
}

// Все события дня, по времени: серии (со временем), напоминания,
// дни рождения и сроки (срок — до конца дня, поэтому в самом низу).
function dayEvents(date, data) {
  const f = getFilters();
  const key = ymd(date);
  const out = [];
  if (f.episodes) for (const e of airingsBetween(data.airings, startOfDay(date), addDays(startOfDay(date), 1))) out.push({ ...e, time: hhmm(e.at), sort: e.at.getHours() * 60 + e.at.getMinutes() });
  if (f.reminders) for (const r of data.reminders || []) if (r.date === key) out.push({ kind: "reminder", r, time: "—", sort: -1, color: REM_COLOR });
  if (f.birthdays) for (const b of data.birthdays) if (b.month === date.getMonth() + 1 && b.day === date.getDate()) out.push({ kind: "birthday", b, time: "весь день", sort: -2, color: BDAY_COLOR });
  if (f.deadlines) for (const r of data.deadlines) if (r.deadline === key) out.push({ kind: "deadline", r, time: "23:59", sort: 24 * 60, color: `var(${STATUS_COLOR_VAR[r.status] || "--s-draft"})` });
  return out.sort((a, b) => a.sort - b.sort);
}

function stageOf(r) {
  const roles = r.pipeline_roles || [];
  if (roles.length && r.pipeline_stage != null) return roles[Math.min(r.pipeline_stage, roles.length - 1)];
  return cleanLabel(r.status_label) || "";
}
function seriesName(r) { return r.title_name || String(r.title || "").replace(/\s*[,—–-]\s*сери[яи].*$/i, ""); }
function epOf(r) { const m = String(r.title || "").match(/сери[яи]\s*(\d+)/i); return m ? Number(m[1]) : null; }
function dueWords(n) { return n < 0 ? "просрочено" : n === 0 ? "сегодня" : n === 1 ? "завтра" : `через ${n} дн.`; }

function headerHtml() {
  const f = getFilters();
  return `
    <div class="page-header">
      <div>
        <span class="kd-label">Команда · ${MONTHS_NOM[selected.getMonth()].toLowerCase()} ${selected.getFullYear()}</span>
        <h1>Календарь</h1>
      </div>
      <div class="page-header-actions">
        <div class="kd-seg kcal-layers">${Object.entries(LAYERS).map(([k, label]) => `<button type="button" class="${f[k] ? "on" : ""}" data-cal-layer="${k}" aria-pressed="${f[k]}">${label}</button>`).join("")}</div>
        <button type="button" class="btn kcal-ib" data-cal-nav="-1" title="Назад на неделю" aria-label="Назад"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
        <button type="button" class="btn" data-cal-nav="0">Сегодня</button>
        <button type="button" class="btn kcal-ib" data-cal-nav="1" title="Вперёд на неделю" aria-label="Вперёд"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button>
      </div>
    </div>
    <div class="kcal" id="cal-body">${dialogSkeletonHtml(3)}</div>`;
}

function ganttHtml(data) {
  const today = startOfDay(new Date());
  const days = Array.from({ length: RANGE_DAYS }, (_, i) => addDays(weekStart, i));
  const f = getFilters();
  const rows = f.deadlines ? data.deadlines
    .filter(r => r.status !== "cancelled" && r.deadline >= ymd(days[0]) && r.deadline <= ymd(days[RANGE_DAYS - 1]))
    .sort((a, b) => a.deadline.localeCompare(b.deadline)) : [];
  const shown = rows.slice(0, 12);
  const head = days.map((d, i) => {
    const evs = dayEvents(d, data);
    return `<button type="button" class="kcal-dc${sameDay(d, today) ? " td" : ""}${sameDay(d, selected) ? " pick" : ""}${d.getDay() % 6 === 0 ? " we" : ""}" data-day="${ymd(d)}">
      <small>${WD_SHORT[d.getDay()]}</small><b>${d.getDate()}</b><i>${evs.slice(0, 3).map(e => `<span style="background:${e.color}"></span>`).join("")}</i></button>`;
  }).join("");
  const cols = days.map(d => `<span class="${d.getDay() % 6 === 0 ? "we" : ""}${sameDay(d, selected) ? " pick" : ""}" data-col="${ymd(d)}"></span>`).join("");
  const body = shown.map(r => {
    const end = dayDiff(parseDay(r.deadline), days[0]);
    const created = r.created_at ? dayDiff(parseDay(r.created_at), days[0]) : end - 2;
    const st = Math.max(0, Math.min(created, end));
    const cut = created < 0;
    const left = dayDiff(parseDay(r.deadline), today);
    const ep = epOf(r);
    const poster = r.poster_url ? mediaUrl("/img_proxy", { url: r.poster_url }) : "";
    return `<div class="kcal-r">
      <div class="kcal-who">${poster ? `<img src="${poster}" alt="" loading="lazy">` : `<span class="kcal-ph"></span>`}<div><b>${esc(seriesName(r))}</b><span>${esc(r.public_id)}${ep != null ? ` · EP ${pad2(ep)}` : ""}</span></div></div>
      <button type="button" class="kcal-bar${cut ? " cut" : ""}${left <= 1 ? " hot" : ""}" data-cal-report="${esc(r.public_id)}" style="--c:var(${STATUS_COLOR_VAR[r.status] || "--s-draft"}); grid-column:${st + 2} / ${end + 3}" title="${esc(r.title)}"><span>${esc(stageOf(r))}</span><em></em></button>
    </div>`;
  }).join("");
  const nowIdx = dayDiff(today, days[0]);
  const now = new Date();
  const frac = (now.getHours() + now.getMinutes() / 60) / 24;
  return `
    <section class="kd-gl kcal-gt">
      <div class="kcal-h"><span class="kd-label">Серия</span>${head}</div>
      <div class="kcal-body">
        <div class="kcal-cols">${cols}</div>
        ${body || `<div class="kcal-quiet">${f.deadlines ? "В эти две недели сроков нет." : "Сроки скрыты фильтром."}</div>`}
        ${nowIdx >= 0 && nowIdx < RANGE_DAYS ? `<div class="kcal-now" id="cal-now" style="left:calc(210px + (100% - 210px) * ${((nowIdx + frac) / RANGE_DAYS).toFixed(4)})"></div>` : ""}
      </div>
      <div class="kcal-lg">${rows.length > shown.length ? `<span>ещё ${rows.length - shown.length} в списке</span>` : ""}<span><i class="kcal-dia"></i>срок сдачи</span><span><i class="kcal-nowk"></i>сейчас</span><span><i class="kcal-dot" style="background:${BDAY_COLOR}"></i>день рождения</span><span><i class="kcal-dot" style="background:${REM_COLOR}"></i>напоминание</span></div>
    </section>`;
}

function agendaHtml(data) {
  const evs = dayEvents(selected, data);
  const isToday = sameDay(selected, new Date());
  const hot = evs.some(e => e.kind === "deadline" && dayDiff(parseDay(e.r.deadline), new Date()) <= 1);
  const word = n => (n === 1 ? "событие" : n >= 2 && n <= 4 ? "события" : "событий");
  const item = e => {
    if (e.kind === "episode") {
      const poster = e.poster ? mediaUrl("/img_proxy", { url: e.poster }) : "";
      const past = e.at.getTime() + e.minutes * 60000 < Date.now();
      return `<button type="button" class="kcal-ai" data-cal-title="${e.id}"><time>${e.time}</time><span class="kcal-ad" style="--c:${e.color}"></span>
        <span class="kcal-ac">${poster ? `<img src="${poster}" alt="" loading="lazy">` : ""}<span><b>${esc(e.name)} · ${e.num}</b><span>Выход серии${e.total ? ` · ${e.num} из ${e.total}` : ""}</span>${workPill(e, data.work || {}, past)}</span></span></button>`;
    }
    if (e.kind === "deadline") {
      const poster = e.r.poster_url ? mediaUrl("/img_proxy", { url: e.r.poster_url }) : "";
      const n = dayDiff(parseDay(e.r.deadline), new Date());
      return `<button type="button" class="kcal-ai" data-cal-report="${esc(e.r.public_id)}"><time>${e.time}</time><span class="kcal-ad" style="--c:${n <= 1 ? "var(--gold)" : e.color}"></span>
        <span class="kcal-ac${n <= 1 ? " hot" : ""}">${poster ? `<img src="${poster}" alt="" loading="lazy">` : ""}<span><b>${esc(seriesName(e.r))}${epOf(e.r) != null ? ` · ${epOf(e.r)}` : ""}</b><span>Срок · ${esc(stageOf(e.r).toLowerCase())} · ${dueWords(n)}</span></span></span></button>`;
    }
    if (e.kind === "birthday") return `<button type="button" class="kcal-ai" data-cal-bday><time>${e.time}</time><span class="kcal-ad" style="--c:${e.color}"></span><span class="kcal-ac"><span class="kcal-ic">🎂</span><span><b>${esc(e.b.name)}</b><span>День рождения</span></span></span></button>`;
    return `<button type="button" class="kcal-ai" data-cal-rem><time>${e.time}</time><span class="kcal-ad" style="--c:${e.color}"></span><span class="kcal-ac"><span class="kcal-ic">🔔</span><span><b>${esc(e.r.text)}</b><span>Моё напоминание</span></span></span></button>`;
  };
  return `
    <div class="kcal-agh"><b>${pad2(selected.getDate())}</b><div><span>${MONTHS_GEN[selected.getMonth()]}</span><small>${WD_LONG[selected.getDay()]}${isToday ? " · сегодня" : ""}</small></div>
      <em class="chip${hot ? " hot" : ""}">${evs.length ? `${evs.length} ${word(evs.length)}` : "свободно"}</em></div>
    <div class="kcal-al">${evs.length ? evs.map(item).join("") : `<div class="kcal-empty">Свободный день — сроков и релизов нет</div>`}</div>`;
}

function monthHtml(data) {
  const first = monthCursor;
  const gridStart = startOfWeek(first);
  const today = new Date();
  const cells = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  return `
    <div class="kcal-mmh"><b>${MONTHS_NOM[first.getMonth()]} ${first.getFullYear()}</b>
      <span><button type="button" data-mm-nav="-1" aria-label="Прошлый месяц"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button><button type="button" data-mm-nav="1" aria-label="Следующий месяц"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button></span></div>
    <div class="kcal-mmg">${WEEKDAYS.map(w => `<small>${w}</small>`).join("")}${cells.map(d => `<button type="button" class="kcal-md${d.getMonth() !== first.getMonth() ? " out" : ""}${sameDay(d, today) ? " td" : ""}${sameDay(d, selected) ? " pick" : ""}${dayEvents(d, data).length ? " ev" : ""}" data-day="${ymd(d)}">${d.getDate()}</button>`).join("")}</div>`;
}

function bodyHtml(data) {
  return `${ganttHtml(data)}<aside class="kcal-side"><section class="kd-gl kcal-ag" id="kcal-ag">${agendaHtml(data)}</section><section class="kd-gl kcal-mm" id="kcal-mm">${monthHtml(data)}</section></aside>`;
}

function placeNowLine(root) {
  const line = root.querySelector("#cal-now");
  if (!line) return;
  const now = new Date();
  const idx = dayDiff(now, weekStart);
  const frac = (now.getHours() + now.getMinutes() / 60) / 24;
  line.style.left = `calc(210px + (100% - 210px) * ${((idx + frac) / RANGE_DAYS).toFixed(4)})`;
}

let cache = null; // { airings, birthdays, reminders, work, deadlines, from, to }

function wireBody(body) {
  body.querySelectorAll("[data-cal-report]").forEach(b => b.addEventListener("click", () => openReportDetail(b.dataset.calReport)));
  body.querySelectorAll("[data-cal-rem]").forEach(b => b.addEventListener("click", () => openRemindersSheet(() => { cache = null; renderWeek(); })));
  body.querySelectorAll("[data-cal-bday]").forEach(b => b.addEventListener("click", () => openBirthdaysSheet(() => { cache = null; renderWeek(); })));
  body.querySelectorAll("[data-cal-title]").forEach(b => b.addEventListener("click", () => switchTab("titles")));
  body.querySelectorAll("[data-day]").forEach(b => b.addEventListener("click", () => pickDay(parseDay(b.dataset.day))));
  body.querySelectorAll("[data-mm-nav]").forEach(b => b.addEventListener("click", () => {
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + Number(b.dataset.mmNav), 1);
    renderWeek();
  }));
}

// Выбор дня: внутри двух недель — подсветка колонки и новая повестка;
// за их пределами — расписание сдвигается на неделю этого дня.
function pickDay(d) {
  selected = startOfDay(d);
  if (selected.getMonth() !== monthCursor.getMonth() || selected.getFullYear() !== monthCursor.getFullYear()) monthCursor = new Date(selected.getFullYear(), selected.getMonth(), 1);
  const idx = dayDiff(selected, weekStart);
  if (idx < 0 || idx >= RANGE_DAYS) weekStart = startOfWeek(selected);
  renderWeek();
}

async function renderWeek() {
  const root = $("#calendar-body");
  const body = root.querySelector("#cal-body");
  const seq = ++requestSeq;
  // Сроки — на две недели расписания и на весь показанный месяц.
  const monthEnd = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0);
  const fromD = monthCursor < weekStart ? startOfWeek(monthCursor) : weekStart;
  const toD = addDays(weekStart, RANGE_DAYS - 1) > monthEnd ? addDays(weekStart, RANGE_DAYS - 1) : addDays(startOfWeek(monthEnd), 6);
  const from = ymd(fromD);
  const to = ymd(toD);
  if (!cache) {
    const [airings, birthdays, rem, work] = await Promise.all([fetchAirings(), fetchBirthdays(), fetchReminders(), fetchWork()]);
    cache = { airings, birthdays, reminders: rem ? rem.reminders : [], work, deadlines: [], from: null, to: null };
  }
  if (cache.from !== from || cache.to !== to) {
    cache.deadlines = await fetchDeadlines(from, to);
    cache.from = from; cache.to = to;
  }
  if (seq !== requestSeq || !body.isConnected) return;
  body.innerHTML = bodyHtml(cache);
  wireBody(body);
  const label = root.querySelector(".page-header .kd-label");
  if (label) label.textContent = `Команда · ${MONTHS_NOM[selected.getMonth()].toLowerCase()} ${selected.getFullYear()}`;
}

function renderShell() {
  const root = $("#calendar-body");
  root.innerHTML = headerHtml();
  root.querySelectorAll("[data-cal-nav]").forEach(b => b.addEventListener("click", () => {
    const dir = Number(b.dataset.calNav);
    if (dir === 0) { weekStart = startOfWeek(new Date()); pickDay(new Date()); return; }
    weekStart = addDays(weekStart, dir * 7);
    selected = addDays(selected, dir * 7);
    monthCursor = new Date(selected.getFullYear(), selected.getMonth(), 1);
    renderWeek();
  }));
  root.querySelectorAll("[data-cal-layer]").forEach(b => b.addEventListener("click", () => {
    const f = getFilters();
    f[b.dataset.calLayer] = !f[b.dataset.calLayer];
    setFilters(f);
    b.classList.toggle("on", f[b.dataset.calLayer]);
    b.setAttribute("aria-pressed", String(f[b.dataset.calLayer]));
    renderWeek();
  }));
  return renderWeek();
}

export async function loadCalendar() {
  cache = null;
  window.clearInterval(nowTimer);
  nowTimer = window.setInterval(() => {
    const body = document.querySelector("#cal-body");
    if (!body || !body.isConnected) { window.clearInterval(nowTimer); return; }
    placeNowLine(body);
  }, 60000);
  try {
    await renderShell();
  } catch (e) {
    const body = document.querySelector("#cal-body");
    if (body) body.innerHTML = `<div class="bento-empty">Не удалось загрузить календарь: ${esc(e.message)}</div>`;
    return false;
  }
}
