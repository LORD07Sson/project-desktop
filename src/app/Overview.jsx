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
import { For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { apiGet, openSheet, dialogSkeletonHtml } from "./api.js";
import { $, esc, initials, relTime, STATUS_COLOR_VAR } from "./utils.js";
// esc() нужен только в строковых шаблонах (openMonthlyTopSheet ниже). В JSX его быть не должно: Solid экранирует
// текстовые узлы сам, и esc() поверх этого даёт двойное экранирование —
// имя «Иванов & Co» рендерилось как «Иванов &amp; Co».

import { avatarHtml, loadAvatars } from "./profile.js";
import { openReportDetail } from "./report-detail.js";
import { openTicketsSheet } from "./tickets.js";
import { openBirthdaysSheet } from "./birthdays.js";
import { imgProxy, titleArt } from "./title-page.js";
import { state } from "./state.js";
import { switchTab } from "./tabs.js";
import { setBackdrop } from "./backdrop.js";

const DAY_MS = 86400000;
const WEEKDAYS_SHORT = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
// Этапы конвейера слева направо — в том же порядке, что колонки «Доски».
const FLOW = ["draft", "review", "revision", "working", "completed"];
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

// «Кадр»: серия — номер эпизода, этап и готовность в одном месте.
const cleanLabel = s => (s || "").replace(/^[^\p{L}\p{N}]+/u, "");
const epNum = r => { const m = (r.title || "").match(/сери[яи]\s*(\d+)/i); return m ? Number(m[1]) : null; };
const showName = r => r.title_name || (r.title || "").replace(/\s*[,—–-]\s*сери[яи].*$/i, "");
const stageOf = r => (r.pipeline_roles && r.pipeline_roles.length && r.pipeline_stage != null
  ? r.pipeline_roles[Math.min(r.pipeline_stage, r.pipeline_roles.length - 1)]
  : cleanLabel(r.status_label));
const STATUS_PCT = { draft: 6, working: 45, revision: 60, review: 75, completed: 100 };
const progressOf = r => (r.pipeline_roles && r.pipeline_roles.length && r.pipeline_stage != null
  ? Math.round((r.pipeline_stage / r.pipeline_roles.length) * 100)
  : STATUS_PCT[r.status] ?? 0);
const statusColor = st => `var(${STATUS_COLOR_VAR[st] || "--s-draft"})`;
const pad2 = n => String(n).padStart(2, "0");

// Сколько осталось до конца дня срока (сроки — даты, без времени).
function countdown(now) {
  const end = new Date(now);
  end.setHours(23, 59, 59, 0);
  const s = Math.max(0, Math.floor((end - now) / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

function heroLead(it) {
  const left = daysLeft(it.r.deadline);
  if (it.tone === "blue") return "Статус не менялся три дня и больше — стоит узнать, что мешает.";
  if (left !== null && left < 0) return `Срок был ${ddmm(it.r.deadline)} — серия опаздывает на ${-left} ${plural(-left, "день", "дня", "дней")}.`;
  if (left === 0) return "Сдать нужно сегодня до полуночи.";
  if (left === 1) return "Срок завтра — самое время проверить, всё ли готово.";
  return left !== null ? `Срок ${ddmm(it.r.deadline)} — через ${left} ${plural(left, "день", "дня", "дней")}.` : "Срок не назначен.";
}

function heroKick(it) {
  const left = daysLeft(it.r.deadline);
  if (it.tone === "red") return `Горит · ${it.tag}`;
  if (it.tone === "blue") return "Без движения";
  if (left === 0) return "Горит · сдать сегодня";
  if (left === 1) return "Срок завтра";
  return "Ближайший срок";
}

// Герой: самые срочные серии слайдами. Картинка — баннер тайтла с
// нашего сервера; если баннера нет — размытая обложка и сама обложка
// справа. Слайды листаются сами раз в 8 секунд, наведение — пауза.
function Hero(props) {
  const items = props.items;
  const [idx, setIdx] = createSignal(0);
  const [now, setNow] = createSignal(new Date());
  const [paused, setPaused] = createSignal(false);
  const tick = setInterval(() => setNow(new Date()), 1000);
  const flip = setInterval(() => { if (!paused() && items.length > 1) setIdx(i => (i + 1) % items.length); }, 8000);
  onCleanup(() => { clearInterval(tick); clearInterval(flip); });
  createEffect(() => {
    const r = items[idx()]?.r;
    if (r) setBackdrop(titleArt(r.title_id, "banner", 1440), imgProxy(r.poster_url));
  });
  const go = i => setIdx(i);
  return (
    <section class="kd-hero" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
      <For each={items}>
        {(it, i) => {
          const r = it.r;
          const poster = imgProxy(r.poster_url);
          const banner = titleArt(r.title_id, "banner", 1440);
          const left = daysLeft(r.deadline);
          const ep = epNum(r);
          return (
            <div class={`kd-slide${i() === idx() ? " on" : ""}${banner ? "" : " no-ban"}`}>
              <div class="kd-slide-amb" style={poster ? { "background-image": `url("${poster}")` } : {}} />
              <Show when={banner}>
                <img class="kd-slide-ban" src={banner} alt="" onError={e => e.currentTarget.closest(".kd-slide").classList.add("no-ban")} />
              </Show>
              <Show when={poster}><img class="kd-slide-art" src={poster} alt="" /></Show>
              <div class="kd-slide-fade" />
              <div class="kd-slide-tx">
                <span class={`kd-kick ${it.tone === "red" || left === 0 ? "hot" : ""}`}><i />{heroKick(it)}</span>
                <h2 class="kd-ttl">{showName(r)}</h2>
                <p class="kd-lead">{heroLead(it)}</p>
                <div class="kd-strip">
                  <div><small>Серия</small><b>{ep != null ? pad2(ep) : r.public_id}</b></div>
                  <div><small>Этап</small><b>{stageOf(r)}</b></div>
                  <div><small>Команда</small><b class="kd-avs">
                    <Show when={(r.assignees || []).length} fallback={<span class="kd-none">не назначено</span>}>
                      <For each={(r.assignees || []).slice(0, 4)}>{a => <span class="avatar sm" data-avatar-for={a.telegram_id || ""}>{initials(a.name || "?")}</span>}</For>
                    </Show>
                  </b></div>
                  <div><small>{left === 0 ? "Осталось" : "Срок"}</small>
                    <b class={left !== null && left <= 1 ? "hot" : ""}>{left === 0 ? countdown(now()) : r.deadline ? ddmm(r.deadline) : "—"}</b></div>
                </div>
                <div class="kd-acts">
                  <button class="btn primary" onClick={() => openReportDetail(r.public_id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none" /></svg>Открыть серию</button>
                  <button class="btn" onClick={() => switchTab("board")}>Открыть доску</button>
                </div>
              </div>
            </div>
          );
        }}
      </For>
      <span class="kd-cb a" /><span class="kd-cb b" /><span class="kd-cb c" /><span class="kd-cb d" />
      <Show when={items.length > 1}>
        <div class="kd-cnt"><b>{pad2(idx() + 1)}</b> / {pad2(items.length)}</div>
        <div class="kd-pager">
          <For each={items}>
            {(it, i) => (
              <button type="button" class={`kd-pg${i() === idx() ? " on" : ""}`} onClick={() => go(i())}>
                <Show when={it.r.poster_url} fallback={<i class="kd-pg-ph" />}><img src={imgProxy(it.r.poster_url)} alt="" /></Show>
                <span><b>{showName(it.r)}</b><span>{epNum(it.r) != null ? `серия ${epNum(it.r)} · ` : ""}{it.tag}</span></span>
                <Show when={i() === idx() && !paused()}><u /></Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function Overview(props) {
  const d = props.data;
  if (!d.reports.total) return <EmptyStudio data={d} />;

  const count = st => d.reports.statuses.find(s => s.status === st)?.count || 0;
  const label = st => cleanLabel(d.reports.statuses.find(s => s.status === st)?.label || st);
  const reports = (props.dash?.board?.columns || []).flatMap(c => c.reports || []);
  const activeTotal = d.reports.total - count("completed") - count("cancelled");
  const attention = attentionItems(reports);
  const days = props.trend?.days || [];
  const sum = (key, from = 0) => days.slice(from).reduce((s, x) => s + (x[key] || 0), 0);
  const upcoming = reports
    .filter(r => isOpen(r) && r.deadline && daysLeft(r.deadline) >= 0)
    .sort((a, b) => a.deadline.localeCompare(b.deadline))
    .slice(0, 5);
  const heroItems = attention.length
    ? attention.slice(0, 4)
    : upcoming.slice(0, 3).map(r => { const l = daysLeft(r.deadline); return { r, tone: "", tag: l === 0 ? "сегодня" : l === 1 ? "завтра" : `через ${l} ${plural(l, "день", "дня", "дней")}` }; });
  const reel = reports.filter(isOpen).sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999")).slice(0, 24);
  const maxAssigned = Math.max(1, ...d.performers.map(x => x.assigned));
  const activity = (props.feed?.events || []).slice(0, 4);
  const summary = [
    `${activeTotal} ${plural(activeTotal, "серия", "серии", "серий")} в работе`,
    attention.length ? `${attention.length} ${plural(attention.length, "требует", "требуют", "требуют")} внимания` : "срочного нет",
  ].join(" · ");
  const flowTotal = Math.max(1, FLOW.reduce((s, st) => s + count(st), 0));
  // Фон окна ведёт герой (смена слайда — смена фона); без героя — первая
  // серия в работе.
  if (!heroItems.length && reel[0]) setBackdrop(titleArt(reel[0].title_id, "banner", 1440), imgProxy(reel[0].poster_url));

  return (
    <div class="kd-ov">
      <div class="kd-hello">
        <h1>{greeting()}{state.name ? `, ${state.name}` : ""}</h1>
        <span>{todayLabel()} · {summary}</span>
        <div class="kd-hello-acts">
          <button class="btn primary" onClick={() => switchTab("titles")}>Взять тайтл</button>
        </div>
      </div>

      <Show when={heroItems.length} fallback={<div class="kd-gl kd-calm">Всё идёт по плану — просроченного и застрявшего нет, сроков впереди тоже нет.</div>}>
        <Hero items={heroItems} />
      </Show>

      <div class="kd-gl kd-pipe">
        <div class="kd-pipe-lbl"><b>Конвейер</b><span>{activeTotal} в работе · {count("completed")} готово</span></div>
        <div class="kd-pipe-bar">
          <div class="kd-pipe-tk">
            <For each={FLOW}>{st => <Show when={count(st)}><i title={`${label(st)}: ${count(st)}`} style={{ background: statusColor(st), flex: count(st) / flowTotal }} /></Show>}</For>
          </div>
          <div class="kd-pipe-lg">
            <For each={FLOW}>{st => <button type="button" onClick={() => switchTab("board")}><i class="kd-dot" style={{ background: statusColor(st) }} />{label(st)} <b>{count(st)}</b></button>}</For>
          </div>
        </div>
        <button class="btn" onClick={() => switchTab("board")}>Открыть доску</button>
      </div>

      <Show when={reel.length}>
        <div class="kd-sh"><h2>На плёнке</h2><span class="kd-label">в работе · {activeTotal}</span><span class="kd-orn" /><button type="button" class="kd-link" onClick={() => switchTab("board")}>Вся доска</button></div>
        <div class="kd-reel">
          <For each={reel}>
            {r => {
              const left = daysLeft(r.deadline);
              const ep = epNum(r);
              return (
                <button type="button" class="kd-fr" onClick={() => openReportDetail(r.public_id)} title={r.title}>
                  <span class="kd-fr-pc">
                    <Show when={r.poster_url} fallback={<span class="kd-fr-ph">{initials(showName(r))}</span>}><img src={imgProxy(r.poster_url)} alt="" loading="lazy" /></Show>
                    <span class={`kd-fr-ep${left !== null && left <= 0 ? " hot" : ""}`}>{ep != null ? `EP ${pad2(ep)}` : r.public_id}</span>
                    <span class="kd-track"><i style={{ width: `${progressOf(r)}%`, background: statusColor(r.status) }} /></span>
                  </span>
                  <b>{showName(r)}</b>
                  <span class="kd-fr-sub"><i class="kd-dot" style={{ background: statusColor(r.status) }} />{stageOf(r)}{r.deadline ? ` · ${left === 0 ? "сегодня" : left === 1 ? "завтра" : left < 0 ? "просрочено" : ddmm(r.deadline)}` : ""}</span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      <div class="kd-three">
        <section class="kd-gl">
          <div class="kd-ch"><h3>Ближайшие сроки</h3><button type="button" class="kd-link" onClick={() => switchTab("calendar")}>Календарь</button></div>
          <Show when={upcoming.length} fallback={<div class="kd-quiet">Сроков впереди нет.</div>}>
            <For each={upcoming.slice(0, 4)}>
              {r => {
                const left = daysLeft(r.deadline);
                const dt = new Date(r.deadline.slice(0, 10) + "T00:00:00");
                return (
                  <button type="button" class={`kd-dl${left <= 1 ? " hot" : ""}`} onClick={() => openReportDetail(r.public_id)}>
                    <span class="kd-dl-d"><b>{pad2(dt.getDate())}</b><small>{WEEKDAYS_SHORT[dt.getDay()]}</small></span>
                    <span class="kd-dl-t"><b>{showName(r)}{epNum(r) != null ? ` · ${epNum(r)}` : ""}</b><span>{stageOf(r)} · {left === 0 ? "сегодня" : left === 1 ? "завтра" : `через ${left} ${plural(left, "день", "дня", "дней")}`}</span></span>
                  </button>
                );
              }}
            </For>
          </Show>
        </section>

        <section class="kd-gl">
          <div class="kd-ch"><h3>Команда</h3><span class="kd-label">назначено серий</span><button type="button" class="kd-link" onClick={openMonthlyTopSheet}>Рейтинг месяца</button></div>
          <Show when={d.performers.length} fallback={<div class="kd-quiet">Пока никому ничего не назначено.</div>}>
            <For each={d.performers.slice(0, 5)}>
              {p => (
                <div class="kd-mb">
                  <span class="avatar sm" data-avatar-for={p.telegram_id || ""}>{initials(p.name || "?")}</span>
                  <span class="kd-mb-n"><b>{p.name}</b><span>{p.overdue ? `${p.overdue} просрочено` : "без просрочек"}</span></span>
                  <span class="kd-mb-ld"><span class="kd-track"><i class={p.overdue ? "hot" : ""} style={{ width: `${Math.round((p.assigned / maxAssigned) * 100)}%` }} /></span><small>{p.assigned} {plural(p.assigned, "серия", "серии", "серий")}</small></span>
                </div>
              )}
            </For>
          </Show>
        </section>

        <section class="kd-gl">
          <div class="kd-ch"><h3>Сводка</h3><span class="kd-label">14 дней</span><button type="button" class="kd-link" onClick={() => switchTab("analytics")}>Аналитика</button></div>
          <div class="kd-st4">
            <div class="kd-sb"><small>Завершено</small><b>{sum("completed")}<em>{sum("completed", 7)} за неделю</em></b><Sparkline values={days.map(x => x.completed)} color="--gold" /></div>
            <div class="kd-sb"><small>Создано</small><b>{sum("created")}<em>{sum("created", 7)} за неделю</em></b><Sparkline values={days.map(x => x.created)} color="--gold" /></div>
            <div class="kd-sb"><small>Просрочено</small><b class={d.reports.overdue ? "hot" : ""}>{d.reports.overdue}<em class="w">{d.reports.important} {plural(d.reports.important, "важная", "важные", "важных")}</em></b></div>
            <div class="kd-sb"><small>Всего серий</small><b>{d.reports.total}<em>{count("completed")} готово</em></b></div>
          </div>
        </section>
      </div>

      <div class="kd-row2">
        <section class="kd-gl">
          <div class="kd-ch"><h3>Недавно</h3><button type="button" class="kd-link" onClick={() => switchTab("feed")}>Вся лента</button></div>
          <Show when={activity.length} fallback={<div class="kd-quiet">Пока тихо.</div>}>
            <div class="kd-act">
              <For each={activity}>
                {ev => (
                  <div class="kd-act-row">
                    <span class="avatar sm" data-avatar-for={ev.actor_telegram_id || ""}>{initials(ev.actor || "?")}</span>
                    <span class="kd-act-t"><span><b>{ev.actor}</b> {ev.action}{ev.title ? ` · ${ev.title}` : ""}</span><small>{relTime(ev.created_at)}</small></span>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
        <div class="kd-tiles">
          <div class="kd-gl kd-tile">
            <small>Доступ</small><b>{d.access.allowed}</b>
            <span>{d.access.pending_requests ? `${d.access.pending_requests} ${plural(d.access.pending_requests, "заявка ждёт", "заявки ждут", "заявок ждут")}` : "заявок нет"}</span>
          </div>
          <button type="button" class="kd-gl kd-tile" title="Открыть тикеты" onClick={() => openTicketsSheet()}>
            <small>Тикеты</small><b class={d.open_tickets ? "hot" : ""}>{d.open_tickets}</b><span>открыто сейчас</span>
          </button>
          <Show when={d.birthdays.length}>
            <button type="button" class="kd-gl kd-tile" title="Все дни рождения" onClick={() => openBirthdaysSheet(loadOverview)}>
              <small>День рождения</small><b class="kd-bday">{d.birthdays[0]?.name}</b><span>{d.birthdays[0]?.day}.{String(d.birthdays[0]?.month).padStart(2, "0")}</span>
            </button>
          </Show>
        </div>
      </div>
    </div>
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
}
