// Вкладка «Обзор» — первый компонент на SolidJS в проекте (остальные
// вкладки остаются на vanilla JS, см. tabs.js — осознанно частичная
// миграция, не переписывание всего сразу). Данные приходят уже
// готовыми пропом: fetch и жизненный цикл монтирования — в loadOverview()
// в конце файла, та же схема, что была раньше (сходить на сервер, потом
// отрисовать), только рисует теперь Solid, а не шаблонные строки.
//
// Обзор 2.0: вместо стены счётчиков — «что делать»: срочное с кнопкой,
// конвейер по этапам, ближайшие дедлайны, загрузка команды. В пустой
// студии — три шага онбординга вместо нулей.

import { render } from "solid-js/web";
import { For, Show } from "solid-js";
import { apiGet, openSheet, dialogSkeletonHtml } from "./api.js";
import { $, esc, initials, relTime, STATUS_COLOR_VAR } from "./utils.js";
// esc() нужен только в строковых шаблонах (openMonthlyTopSheet ниже). В JSX его быть не должно: Solid экранирует
// текстовые узлы сам, и esc() поверх этого даёт двойное экранирование —
// имя «Иванов & Co» рендерилось как «Иванов &amp; Co».

import { avatarHtml, loadAvatars } from "./profile.js";
import { openReportDetail } from "./report-detail.js";
import { openTicketsSheet } from "./tickets.js";
import { openBirthdaysSheet } from "./birthdays.js";
import { imgProxy } from "./title-page.js";
import { state } from "./state.js";
import { switchTab } from "./tabs.js";
import { setBackdrop } from "./backdrop.js";

const DAY_MS = 86400000;
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
// Этапы конвейера слева направо — в том же порядке, что колонки «Доски».
const FLOW = ["draft", "review", "revision", "working", "completed"];
const FLOW_CHIPS = 3;
const ATTENTION_MAX = 5;

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 17) return "Добрый день";
  return "Добрый вечер";
}

function todayLabel() {
  const d = new Date();
  const wd = WEEKDAYS[d.getDay()];
  return `${wd[0].toUpperCase()}${wd.slice(1)}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function todayStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Дни до дедлайна относительно сегодняшней даты (дедлайн — дата без времени).
function daysLeft(deadline) {
  if (!deadline) return null;
  return Math.round((Date.parse(deadline.slice(0, 10)) - Date.parse(todayStr())) / DAY_MS);
}

function ddmm(deadline) {
  return `${deadline.slice(8, 10)}.${deadline.slice(5, 7)}`;
}

const isOpen = r => r.status !== "completed" && r.status !== "cancelled";

// «Требует внимания»: просроченное, дедлайн сегодня/завтра, застрявшее
// без смены статуса 3+ дня — по срочности, у каждой строки своя кнопка.
function attentionItems(reports) {
  const items = [];
  const seen = new Set();
  const push = (r, rank, tag, tone, sub) => {
    if (seen.has(r.public_id)) return;
    seen.add(r.public_id);
    items.push({ r, rank, tag, tone, sub });
  };
  const open = reports.filter(isOpen);
  open.forEach(r => {
    const left = daysLeft(r.deadline);
    if (left !== null && left < 0) {
      push(r, left / 1000, `просрочено на ${-left} ${plural(-left, "день", "дня", "дней")}`, "red", `${r.status_label} · срок был ${ddmm(r.deadline)}`);
    }
  });
  open.forEach(r => {
    const left = daysLeft(r.deadline);
    if (left === 0 || left === 1) push(r, 1 + left, left === 0 ? "сегодня" : "завтра", "yel", `${r.status_label} · дедлайн ${left === 0 ? "сегодня" : "завтра"}`);
  });
  open.filter(r => r.stuck).forEach(r => push(r, 3, "без движения", "blue", `${r.status_label} · статус не менялся 3+ дня`));
  return items.sort((a, b) => a.rank - b.rank).slice(0, ATTENTION_MAX);
}

function Sparkline(props) {
  const vals = props.values || [];
  if (vals.length < 2 || vals.every(v => !v)) return <div class="ov2-spark-empty" />;
  const max = Math.max(1, ...vals);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1)) * 100},${26 - (v / max) * 22}`).join(" ");
  return (
    <svg class="ov2-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={`var(${props.color})`} stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
    </svg>
  );
}

function Kpi(props) {
  return (
    <div class="bcell ov2-kpi" style={{ "animation-delay": `${props.delay}ms` }}>
      <span class="ov2-kpi-lbl">{props.label}</span>
      <b class={`ov2-kpi-num ${props.tone || ""}`}>{props.value}</b>
      <span class="ov2-kpi-sub">{props.sub}</span>
      <Sparkline values={props.spark} color={props.color} />
    </div>
  );
}

function Poster(props) {
  const src = props.url ? imgProxy(props.url) : null;
  return src
    ? <img class="ov2-poster" src={src} alt="" loading="lazy" />
    : <span class="ov2-poster ov2-poster-ph" />;
}

// Пустая студия — вместо стены нулей три шага, чтобы было понятно, с чего начать.
function EmptyStudio(props) {
  const members = props.data.access?.allowed || 0;
  const teamReady = members > 1;
  return (
    <div class="ov2-empty">
      <div class="ov2-empty-mark brand-logo"><svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path class="bm-a" d="M5 5L19 19" /><path class="bm-b" d="M19 5L5 19" /></svg></div>
      <h1>Команда готова к первому сезону</h1>
      <p>Серий пока нет — поэтому здесь три шага вместо пустых графиков. Как только появится первая серия, тут будет живой обзор.</p>
      <div class="ov2-steps">
        <div class={`bcell ov2-step${teamReady ? " done" : ""}`}>
          <span class="ov2-step-n">{teamReady ? "✓" : "1"}</span>
          <b>{teamReady ? "Команда в сборе" : "Соберите команду"}</b>
          <p>{teamReady ? `В команде ${members} ${plural(members, "участник", "участника", "участников")}.` : "Пригласите озвучку и звукорежиссёра — доступ выдаётся через бота."}</p>
          <button class="btn" onClick={() => switchTab("team")}>Команда</button>
        </div>
        <div class="bcell ov2-step">
          <span class="ov2-step-n">2</span>
          <b>Выберите тайтл</b>
          <p>Проголосуйте за тайтлы эфир-сезона — лидер голосования и пойдёт в работу.</p>
          <button class="btn primary" onClick={() => switchTab("titles")}>К голосованию</button>
        </div>
        <div class="bcell ov2-step">
          <span class="ov2-step-n">3</span>
          <b>Заведите первую серию</b>
          <p>На «Доске» — серия, исполнители и дедлайн. Дальше статусы двигаются по ходу работы.</p>
          <button class="btn" onClick={() => switchTab("board")}>Открыть доску</button>
        </div>
      </div>
    </div>
  );
}

function Overview(props) {
  const d = props.data;
  if (!d.reports.total) return <EmptyStudio data={d} />;

  const count = st => d.reports.statuses.find(s => s.status === st)?.count || 0;
  const label = st => d.reports.statuses.find(s => s.status === st)?.label || st;
  const reports = (props.dash?.board?.columns || []).flatMap(c => c.reports || []);
  const activeTotal = d.reports.total - count("completed") - count("cancelled");
  const attention = attentionItems(reports);
  const days = props.trend?.days || [];
  const sum = (key, from = 0) => days.slice(from).reduce((s, x) => s + (x[key] || 0), 0);
  const upcoming = reports
    .filter(r => isOpen(r) && r.deadline && daysLeft(r.deadline) >= 0)
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .slice(0, 5);
  const maxAssigned = Math.max(1, ...d.performers.map(x => x.assigned));
  const activity = (props.feed?.events || []).slice(0, 4);
  const summary = [
    `${activeTotal} ${plural(activeTotal, "серия", "серии", "серий")} в работе`,
    attention.length ? `${attention.length} ${plural(attention.length, "требует", "требуют", "требуют")} внимания` : "срочного нет",
  ].join(" · ");

  return (
    <>
    <div class="page-header ov2-head">
      <div>
        <h1>{greeting()}{state.name ? `, ${state.name}` : ""}</h1>
        <div class="sub">{todayLabel()} · {summary}</div>
      </div>
      <div class="page-header-actions">
        <button class="btn" onClick={() => switchTab("board")}>Открыть доску</button>
        <button class="btn primary" onClick={() => switchTab("titles")}>Взять тайтл</button>
      </div>
    </div>

    <div class="ov2-grid">
      <div class="ov2-col">
        <div class="bcell ov2-card" style={{ "animation-delay": "0ms" }}>
          <div class="ov2-card-head"><b>Требует внимания</b><span>сначала срочное</span></div>
          <Show when={attention.length} fallback={<div class="ov2-calm">Всё идёт по плану — просроченного и застрявшего нет.</div>}>
            <div class="ov2-att">
              <For each={attention}>
                {it => (
                  <div class="ov2-att-row" onClick={() => openReportDetail(it.r.public_id)}>
                    <Poster url={it.r.poster_url} />
                    <div class="ov2-att-text">
                      <b>{it.r.title}</b>
                      <span>{it.sub}</span>
                    </div>
                    <span class={`ov2-tag ${it.tone}`}>{it.tag}</span>
                    <button class="btn" onClick={e => { e.stopPropagation(); openReportDetail(it.r.public_id); }}>Открыть</button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="bcell ov2-card" style={{ "animation-delay": "60ms" }}>
          <div class="ov2-card-head"><b>Конвейер</b><span>{activeTotal} в работе</span><button type="button" class="dash-link" onClick={() => switchTab("board")}>Открыть доску →</button></div>
          <div class="ov2-flow">
            <For each={FLOW}>
              {st => {
                const items = reports.filter(r => r.status === st);
                return (
                  <button type="button" class="ov2-stage" onClick={() => switchTab("board")}>
                    <span class="ov2-stage-lbl"><i style={{ background: `var(${STATUS_COLOR_VAR[st] || "--s-draft"})` }} />{label(st)}</span>
                    <b>{count(st)}</b>
                    <span class="ov2-stage-eps">
                      <For each={items.slice(0, FLOW_CHIPS)}>{r => <em title={r.title}>{r.public_id}</em>}</For>
                      <Show when={count(st) > FLOW_CHIPS}><em>+{count(st) - FLOW_CHIPS}</em></Show>
                    </span>
                  </button>
                );
              }}
            </For>
          </div>
        </div>

        <div class="ov2-kpis">
          <Kpi delay={100} label="Завершено" value={sum("completed")} sub={`за 14 дней · ${sum("completed", 7)} за неделю`} spark={days.map(x => x.completed)} color="--s-done" />
          <Kpi delay={130} label="Создано" value={sum("created")} sub={`за 14 дней · ${sum("created", 7)} за неделю`} spark={days.map(x => x.created)} color="--ember" />
          <Kpi delay={160} label="Просрочено" value={d.reports.overdue} tone={d.reports.overdue ? "danger" : ""} sub={`${d.reports.important} ${plural(d.reports.important, "важная", "важные", "важных")} в работе`} />
          <Kpi delay={190} label="Всего серий" value={d.reports.total} sub={`${count("completed")} готово · ${count("cancelled")} отменено`} />
        </div>
      </div>

      <div class="ov2-col">
        <div class="bcell ov2-card" style={{ "animation-delay": "40ms" }}>
          <div class="ov2-card-head"><b>Ближайшие дедлайны</b><button type="button" class="dash-link" onClick={() => switchTab("calendar")}>Календарь →</button></div>
          <Show when={upcoming.length} fallback={<div class="ov2-calm">Дедлайнов впереди нет.</div>}>
            <For each={upcoming}>
              {r => {
                const left = daysLeft(r.deadline);
                return (
                  <button type="button" class="ov2-dl-row" onClick={() => openReportDetail(r.public_id)}>
                    <time>{ddmm(r.deadline)}</time>
                    <b>{r.title}</b>
                    <span class={`ov2-tag ${left === 0 ? "red" : left === 1 ? "yel" : ""}`}>{left === 0 ? "сегодня" : left === 1 ? "завтра" : `через ${left} ${plural(left, "день", "дня", "дней")}`}</span>
                  </button>
                );
              }}
            </For>
          </Show>
        </div>

        <div class="bcell ov2-card" style={{ "animation-delay": "80ms" }}>
          <div class="ov2-card-head"><b>Загрузка команды</b><span>назначено серий</span></div>
          <Show when={d.performers.length} fallback={<div class="ov2-calm">Пока никому ничего не назначено.</div>}>
            <div class="ov2-load">
              <For each={d.performers.slice(0, 6)}>
                {p => (
                  <div class="ov2-load-row">
                    <span class="avatar sm" data-avatar-for={p.telegram_id || ""}>{initials(p.name || "?")}</span>
                    <span class="ov2-load-name">{p.name}</span>
                    <span class="ov2-bar"><i class={p.overdue ? "hot" : ""} style={{ width: `${Math.round((p.assigned / maxAssigned) * 100)}%` }} /></span>
                    <em>{p.assigned}{p.overdue ? ` · ${p.overdue} просрочено` : ""}</em>
                  </div>
                )}
              </For>
            </div>
            <button class="btn ov2-wide-btn" onClick={openMonthlyTopSheet}>Рейтинг месяца</button>
          </Show>
        </div>

        <div class="bcell ov2-card" style={{ "animation-delay": "120ms" }}>
          <div class="ov2-card-head"><b>Недавно</b><button type="button" class="dash-link" onClick={() => switchTab("feed")}>Вся лента →</button></div>
          <Show when={activity.length} fallback={<div class="ov2-calm">Пока тихо.</div>}>
            <For each={activity}>
              {ev => (
                <div class="dash-activity-row">
                  <span class="avatar-bubble" style={{ "margin-left": "0" }} data-avatar-for={ev.actor_telegram_id || ""}>{initials(ev.actor || "?")}</span>
                  <span class="dash-activity-text">
                    <span><b>{ev.actor}</b> {ev.action}{ev.title ? ` · ${ev.title}` : ""}</span>
                    <span class="dash-activity-time">{relTime(ev.created_at)}</span>
                  </span>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="ov2-mini">
          <div class="bcell ov2-mini-cell">
            <span>Доступ</span><b>{d.access.allowed}</b>
            <em>{d.access.pending_requests ? `${d.access.pending_requests} ${plural(d.access.pending_requests, "заявка ждёт", "заявки ждут", "заявок ждут")}` : "заявок нет"}</em>
          </div>
          <div class="bcell ov2-mini-cell dash-clickable" role="button" tabindex="0" title="Открыть тикеты"
            onClick={() => openTicketsSheet()} onKeyDown={e => { if (e.key === "Enter") openTicketsSheet(); }}>
            <span>Тикеты</span><b class={d.open_tickets ? "warn" : ""}>{d.open_tickets}</b><em>открыто сейчас</em>
          </div>
          <Show when={d.birthdays.length}>
            <div class="bcell ov2-mini-cell dash-clickable" role="button" tabindex="0" title="Все дни рождения"
              onClick={() => openBirthdaysSheet(loadOverview)} onKeyDown={e => { if (e.key === "Enter") openBirthdaysSheet(loadOverview); }}>
              <span>День рождения</span><b class="ov2-bday">{d.birthdays[0]?.name}</b><em>{d.birthdays[0]?.day}.{String(d.birthdays[0]?.month).padStart(2, "0")}</em>
            </div>
          </Show>
        </div>
      </div>
    </div>
    </>
  );
}

// Диалог «Рейтинг месяца» — остался на imperative openSheet (та же
// функция, что и в остальном приложении), не переписан на Solid: это
// одноразовый sheet поверх всего окна, а не часть дерева Обзора — Solid
// тут не даёт ничего сверх того, что уже даёт openSheet.
async function openMonthlyTopSheet() {
  const overlay = openSheet(`<h2>Рейтинг месяца</h2>${dialogSkeletonHtml(5)}`);
  const sheet = overlay.querySelector(".sheet");
  let d;
  try {
    d = await apiGet("/overview/monthly-top");
  } catch (e) {
    sheet.innerHTML = `<h2>Рейтинг месяца</h2><div class="bento-empty">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  const medals = ["🥇", "🥈", "🥉"];
  const rows = (d.top || []).map((p, i) => `
    <div class="mini-row">
      <span class="rank">${medals[i] || i + 1}</span>
      ${avatarHtml(p.telegram_id, p.name, "sm")}
      <span class="name">${esc(p.name)}</span>
      <span class="val">${p.completed} ✓</span>
    </div>
  `).join("");
  sheet.innerHTML = `
    <h2>Рейтинг месяца</h2>
    <div style="color:var(--ink-dim); font-size:12px; margin:-8px 0 12px;">по закрытым отчётам за последние 30 дней</div>
    <div class="mini-list">${rows || `<div class="no-assignee">Пока никто не закрыл ни одной серии за последние 30 дней</div>`}</div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  loadAvatars(sheet);
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
}

// Монтирование/размонтирование — та же схема, что была у старого
// loadOverview(): сходить на сервер, затем отрисовать заново с нуля
// (полный remount дерева на каждый вызов, не тонкое обновление сигналов
// — ровно то же поведение, что раньше давал root.innerHTML = ...).
// loadActiveTab()/refreshAll() в tabs.js продолжают звать loadOverview()
// как раньше — сигнатура (async функция без аргументов, возвращающая
// промис) не изменилась, имя файла — единственное отличие импорта.
let disposePrev = null;

export async function loadOverview() {
  const root = $("#overview-body");
  if (disposePrev) { disposePrev(); disposePrev = null; }
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let d, trend, dash, feed;
  try {
    [d, trend, dash, feed] = await Promise.all([
      apiGet("/overview"),
      apiGet("/trend").catch(() => null),
      // Не критично для остального Обзора — если недоступно, просто не
      // покажем «Требует внимания», а не завалим всю вкладку.
      apiGet("/dashboard/project").catch(() => null),
      apiGet("/feed", { offset: 0, page_size: 4 }).catch(() => null),
    ]);
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить обзор: ${esc(e.message)}</div>`;
    return false;
  }
  root.innerHTML = "";
  disposePrev = render(() => <Overview data={d} trend={trend} dash={dash} feed={feed} />, root);
  loadAvatars(root);
  // Фон окна — обложка самой горячей серии, а если горящих нет —
  // любой серии в работе с обложкой.
  const reports = (dash?.board?.columns || []).flatMap(c => c.reports || []);
  const hot = attentionItems(reports).find(it => it.r.poster_url)?.r || reports.find(r => isOpen(r) && r.poster_url);
  if (hot) setBackdrop(imgProxy(hot.poster_url));
}
