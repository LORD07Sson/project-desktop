// Вкладка «Я» + карточка коллеги + список команды.
// Разметка и логика ниже — портированы «в точь-точь» из мини-аппа
// (miniapp/static/index.html: profileHtml/teamTeaserHtml/statDonutHtml/
// goalRingHtml/rankTagHtml/tenureTier/avatarHtml), под тот же /api/me
// и /api/user/{id} (совместимая форма ответа — общая разметка на двоих).

import { state } from "./state.js";
import { fillRemindersCard } from "./reminders.js";
import { fetchPerson, fmtDay, wireWorkSection, fillPauseCard } from "./people.js";
import { loadPeopleNames, personName } from "./people-names.js";
import { apiGet, apiPost, apiDelete, openSheet, toast, dialogSkeletonHtml, mediaUrl, forceMediaToken, tabSkeleton, askConfirm } from "./api.js";
import { $, esc, isOverdue, relTime, formatWhen, MONTHS_RU, STATUS_COLOR_VAR, BADGE_RARITY_ORDER, pluralColleagues, showContextMenu } from "./utils.js";
import { setQuickFilter, loadReports } from "./reports.js";
import { switchTab } from "./tabs.js";
import { playDonutIntro, deltaPillHtml } from "./charts.js";
import { rollText } from "./roll-digits.js";
import { devModeActive, devPanelHtml, wireDevPanel } from "./devmode.js";
import { vaultEntryHtml, wireVaultEntry } from "./vault.js";
import { openReportDetail } from "./report-detail.js";
import { openRolesSheet } from "./roles.js";
import { openExternal, sendNotification } from "./tauri.js";
import { markMyReportsSeen } from "./notifications.js";
import { wireGraffiti } from "./graffiti.js";
// Тот же маскот, что на экране загрузки (index.html) — Vite отдаёт
// готовый URL собранного ассета. Больше ему показаться негде, хотя он
// уже лежит в каждой сборке.
import mascotUrl from "../assets/ayaya-club-ayaya.gif";

export function avatarHtml(telegramId, name, size) {
  const initial = esc((name || "?").trim().charAt(0).toUpperCase() || "?");
  const cls = size === "xl" ? " xl" : (size === "sm" ? " sm" : "");
  return `<span class="avatar${cls}" data-avatar-for="${telegramId || ""}">${initial}</span>`;
}

// Реальные фото участников подгружаются лениво поверх инициалов — тот же приём, что в мини-аппе: отдельный <img>, а не background,
// чтобы молча остаться на инициалах при 204/ошибке сети (см. /api/avatar). Пометка ставится, только когда запрос реально ушёл; при
// ошибке — одна повторная попытка с новым токеном; когда токен пришёл — недогруженные подтягиваются сами. Адреса аватарок, которые
// уже загрузились в этом сеансе: такие вставляем сразу, без onload — иначе при каждом показе вкладки на кадр мелькала
// буква-заглушка.
const AVATAR_OK = new Set();

export function loadAvatars(root) {
  (root || document).querySelectorAll("[data-avatar-for]").forEach(el => {
    const tid = el.getAttribute("data-avatar-for");
    if (!tid || el.getAttribute("data-avatar-loaded")) return;
    const src = mediaUrl(`/avatar/${encodeURIComponent(tid)}`);
    if (!src) return; // токена ещё нет — повторим, когда он придёт (событие media-token-ready)
    el.setAttribute("data-avatar-loaded", "1");
    const img = new Image();
    if (AVATAR_OK.has(src)) { img.src = src; el.innerHTML = ""; el.appendChild(img); return; }
    img.onload = () => { AVATAR_OK.add(src); el.innerHTML = ""; el.appendChild(img); };
    img.onerror = () => {
      // 204 (фото нет) тоже приходит сюда — повторяем один раз, а не бесконечно
      if (el.getAttribute("data-avatar-retried")) return;
      el.setAttribute("data-avatar-retried", "1");
      setTimeout(async () => {
        try { await forceMediaToken(); } catch (_) { /* не критично */ }
        el.removeAttribute("data-avatar-loaded");
        if (el.isConnected) loadAvatars(el.parentElement || document);
      }, 2500);
    };
    img.src = src;
  });
}
document.addEventListener("media-token-ready", () => loadAvatars(document));

// Своя картинка баннера профиля (/api/banner/{id}) — 204, если её нет
// (пресет/пусто), тогда молча остаёмся на градиенте из CSS.
// Положение по вертикали — banner_pos_y с сервера (0–100 %, то же, что в мини-аппе).
function loadProfileBanner(el, telegramId) {
  if (!el || !telegramId) return;
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url(${img.src})`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = `50% ${bannerPos(el)}%`;
    el.classList.add("has-img");
    if (el.dataset.editable) wireBannerAdjust(el, img);
  };
  img.onerror = () => {};
  const src = mediaUrl(`/banner/${encodeURIComponent(telegramId)}`);
  if (!src) return;
  img.src = src;
}

function bannerPos(el) {
  const v = Number(el.dataset.pos);
  return Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50;
}

// Свой баннер можно подвинуть прямо в шапке: «Положение» → тянуть картинку вверх-вниз (или колесом) → «Сохранить».
function wireBannerAdjust(el, img) {
  if (el.querySelector(".pf-ban-move")) return;
  const btn = document.createElement("button");
  btn.className = "btn sm pf-ban-move";
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M8 7l4-4 4 4M8 17l4 4 4-4"/></svg>Положение`;
  el.append(btn);
  // сколько пикселей картинки «не влезает» по высоте при cover — столько и можно прокрутить
  const spare = () => {
    const w = el.clientWidth, h = el.clientHeight;
    return Math.max(0, img.naturalHeight * Math.max(w / img.naturalWidth, h / img.naturalHeight) - h);
  };
  btn.addEventListener("click", e => {
    e.stopPropagation();
    if (spare() < 2) { toast("Картинка целиком помещается в шапку — двигать нечего."); return; }
    const was = bannerPos(el);
    let pos = was;
    const set = v => { pos = Math.min(100, Math.max(0, v)); el.style.backgroundPosition = `50% ${pos}%`; };
    const bar = document.createElement("div");
    bar.className = "pf-ban-bar";
    bar.innerHTML = `<span class="pf-ban-hint">Тяните картинку вверх или вниз</span><button class="btn sm ghost" data-a="cancel">Отмена</button><button class="btn sm primary" data-a="save">Сохранить</button>`;
    el.append(bar);
    el.classList.add("adjust");
    let drag = null;
    const down = ev => {
      if (ev.button !== 0 || ev.target.closest(".pf-ban-bar")) return;
      drag = { y: ev.clientY, pos };
      el.setPointerCapture(ev.pointerId);
      el.classList.add("grabbing");
    };
    // тянем картинку: вниз — показываем её верх (процент уменьшается)
    const move = ev => { if (drag) set(drag.pos - (ev.clientY - drag.y) / spare() * 100); };
    const up = () => { drag = null; el.classList.remove("grabbing"); };
    const wheel = ev => { ev.preventDefault(); set(pos + Math.sign(ev.deltaY) * 4); };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("wheel", wheel, { passive: false });
    const done = () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("wheel", wheel);
      el.classList.remove("adjust", "grabbing");
      bar.remove();
    };
    bar.querySelector('[data-a="cancel"]').addEventListener("click", ev => { ev.stopPropagation(); set(was); done(); });
    bar.querySelector('[data-a="save"]').addEventListener("click", async ev => {
      ev.stopPropagation();
      const v = Math.round(pos);
      try {
        await apiPost("/me/profile", { banner_pos_y: v });
        el.dataset.pos = String(v);
        set(v);
        done();
        toast("Положение баннера сохранено.");
      } catch (err) {
        toast(`Не удалось сохранить: ${err.message}`, "error");
      }
    });
  });
}

// Кольцо аватара по стажу в команде — те же пороги, что в мини-аппе.
// Пороги живут одним списком — из него и цвет кольца, и полоска прогресса.
const TENURE_STEPS = [
  { at: 30, tier: "bronze", label: "Бронза", color: "#b0774a" },
  { at: 180, tier: "silver", label: "Серебро", color: "#b9c2cc" },
  { at: 365, tier: "gold", label: "Золото", color: "var(--gold)" },
];

function tenureTier(days) {
  if (days == null) return null;
  for (let i = TENURE_STEPS.length - 1; i >= 0; i--) {
    if (days >= TENURE_STEPS[i].at) return TENURE_STEPS[i].tier;
  }
  return null;
}

function pluralDays(n) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "день";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "дня";
  return "дней";
}

// Полоска «где я между порогами» + сколько до следующего кольца.
function tenureProgressHtml(days) {
  if (days == null) return "";
  const nextIdx = TENURE_STEPS.findIndex(st => days < st.at);
  const current = nextIdx === -1 ? TENURE_STEPS[TENURE_STEPS.length - 1] : TENURE_STEPS[nextIdx - 1];
  const next = nextIdx === -1 ? null : TENURE_STEPS[nextIdx];
  const from = current ? current.at : 0;
  const pct = next ? Math.max(0, Math.min(100, Math.round(((days - from) / (next.at - from)) * 100))) : 100;
  const color = current ? current.color : "var(--ink-dim)";
  const title = current ? current.label : "Новичок";
  const left = next ? next.at - days : 0;

  return `
    <div class="tenure">
      <div class="tenure-lbl">
        <span class="tl-main"><b style="color:${color};">${esc(title)}</b> · ${days} ${pluralDays(days)} в команде</span>
        ${next ? `<span>${left} ${pluralDays(left)} до «${esc(next.label)}»</span>` : `<span>высший ранг</span>`}
      </div>
      <div class="tenure-track"><i style="width:${pct}%; background:${color};"></i></div>
      <div class="tenure-ticks">
        ${TENURE_STEPS.map(st => `<span class="${days >= st.at ? "on" : ""}" style="${days >= st.at ? `color:${st.color};` : ""}">${st.at}</span>`).join("")}
      </div>
    </div>`;
}

function roleMeta(role) {
  const r = (role || "").toLowerCase();
  if (r.includes("актр") || r.includes("актё") || r.includes("дублир")) return { ic: "🎙", c: "var(--sakura)" };
  if (r.includes("режисс")) return { ic: "🎬", c: "var(--fire)" };
  if (r.includes("звукореж")) return { ic: "🔊", c: "var(--s-review)" };
  if (r.includes("перевод")) return { ic: "📝", c: "var(--gold)" };
  if (r.includes("тайпсет") || r.includes("тайминг")) return { ic: "⏱", c: "var(--ember)" };
  if (r.includes("монтаж")) return { ic: "🎞", c: "var(--sakura)" };
  if (r.includes("дизайн")) return { ic: "✏️", c: "var(--gold)" };
  return { ic: "🎭", c: "var(--fire)" };
}

function profileRolesHtml(d, compact = false) {
  const roles = (Array.isArray(d.roles) ? d.roles : (d.role ? [d.role] : []))
    .filter(role => role && role.toLowerCase() !== "user");
  const tags = roles.length
    ? roles.map(role => {
      const meta = roleMeta(role);
      return `<span class="role-tag" style="--tag-c:${meta.c}">${meta.ic} ${esc(role)}</span>`;
    }).join("")
    : `<span class="role-tag" style="--tag-c:var(--fire)">🎭 Участник Project</span>`;
  const manage = state.isAdmin
    ? `<button class="btn ghost role-manage-btn" data-manage-roles="${esc(String(d.telegram_id))}">${compact ? "Роли" : "Назначить роли"}</button>`
    : "";
  return `<div class="profile-role-list${compact ? " compact" : ""}">${tags}${manage}</div>`;
}

function openProfileRoles(telegramId) {
  openRolesSheet(telegramId);
}

function rankTagHtml(rank) {
  // «#1 из 1» — не достижение, а следствие того, что серии закрывал
  // только один человек. Пока в таблице меньше двоих, места нет.
  if (!rank || !rank.total || rank.total < 2) return "";
  const medals = { 1: "🥇", 2: "🥈", 3: "🥉" };
  const medal = medals[rank.place] || "🏅";
  return `<span class="rank-tag rank-${rank.place <= 3 ? rank.place : "other"}">${medal} #${rank.place} из ${rank.total}</span>`;
}

function goalRingHtml(pct, over) {
  const r = 30, c = 2 * Math.PI * r;
  return `<svg class="goal-ring" viewBox="0 0 70 70" width="70" height="70">
    <circle class="goal-ring-track" cx="35" cy="35" r="${r}"></circle>
    <circle class="goal-ring-fill${over ? " over" : ""}" cx="35" cy="35" r="${r}"
      stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${c.toFixed(2)}"
      data-target-offset="${(c - (pct / 100) * c).toFixed(2)}"></circle>
  </svg>`;
}

// Аватар-стек команды в общей шапке (titlebar) — виден на любой
// вкладке, не только на «Я». Перенесено вживую с референса пользователя
// (Dribbble: Xentra Digital Marketing Dashboard, dribbble.com/shots/27265906)
// — там кластер "N People / Team Members" с перекрывающимися аватарами
// висит в шапке постоянно. Данные и разметка — те же /team + avatarHtml,
// что уже питают тизер на вкладке «Я» и полный список (openTeamSheet)
// ниже, просто с другим местом вывода и лимитом превью.
export async function loadTitlebarTeam() {
  const el = $("#titlebar-team");
  if (!el) return;
  try {
    const d = await apiGet("/team");
    const users = d.users || [];
    if (!users.length) { el.hidden = true; return; }
    const preview = users.slice(0, 4);
    const overflow = users.length - preview.length;
    // Стек аватаров заканчивается кружком "+N" на месте непоказанных
    // участников — та же деталь, что у референса ("21+" в шапке), не
    // просто текстовая подпись сбоку.
    const stack = preview.map(u => avatarHtml(u.telegram_id, u.name, "sm")).join("")
      + (overflow > 0 ? `<span class="avatar sm avatar-overflow">+${overflow}</span>` : "");
    el.innerHTML = `<span class="stack">${stack}</span><span class="tt">${users.length} ${pluralColleagues(users.length)}</span>`;
    el.hidden = false;
    loadAvatars(el);
  } catch (_) { /* не критично — шапка просто останется без кластера */ }
}
$("#titlebar-team")?.addEventListener("click", openTeamSheet);

function teamTeaserHtml(me) {
  if (!me.team || !me.team.count) return "";
  const stack = me.team.preview.map(u => avatarHtml(u.telegram_id, u.name, "sm")).join("");
  const names = me.team.preview.map(u => u.name).join(", ");
  return `
    <div class="team-teaser" id="team-teaser">
      <span class="stack">${stack}</span>
      <div><div class="tt">${me.team.count} ${pluralColleagues(me.team.count)} по команде</div>
      ${names ? `<div class="tsub">${esc(names)}${me.team.count > me.team.preview.length ? " и др." : ""}</div>` : ""}</div>
      <span class="go">→</span>
    </div>`;
}

function wireProfileCommon(root, telegramId, onReload) {
  loadAvatars(root);
  loadProfileBanner(root.querySelector('[data-role="profile-banner"]'), telegramId);
  playDonutIntro(root);
  root.querySelectorAll(".role-bar-fill").forEach(el => {
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.width = el.dataset.pct + "%"; }));
  });
  root.querySelectorAll(".goal-ring-fill").forEach(el => {
    requestAnimationFrame(() => requestAnimationFrame(() => { el.style.strokeDashoffset = el.dataset.targetOffset; }));
  });
  root.querySelectorAll("[data-revoke-badge]").forEach(btn => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!await askConfirm("Отозвать эту награду?")) return;
      btn.disabled = true;
      try {
        await apiDelete(`/dev/badge/${btn.dataset.revokeBadge}`);
        toast("Награда отозвана.");
        if (onReload) await onReload();
      } catch (e) {
        toast(`Не удалось отозвать: ${e.message}`, "error");
        btn.disabled = false;
      }
    });
  });
  const teaser = root.querySelector("#team-teaser");
  if (teaser) teaser.addEventListener("click", openTeamSheet);
}

export async function loadProfile() {
  const root = $("#profile-body");
  tabSkeleton(root, `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`);
  let me;
  try {
    me = await apiGet("/me");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить профиль: ${esc(e.message)}</div>`;
    return false;
  }
  state.isDeveloper = !!me.is_developer; // используется для показа переключателя dev-режима в Настройках
  markMyReportsSeen((me.reports || []).map(r => r.public_id));

  const goalSet = me.monthly_goal != null && me.monthly_goal > 0;
  const goalDone = me.completed_month || 0;
  const goalOver = goalSet && goalDone >= me.monthly_goal;
  const goalPct = goalSet ? Math.min(100, Math.round((goalDone / me.monthly_goal) * 100)) : 0;
  const goalCardHtml = goalSet ? `
    <div class="bcell wide goal-card with-ring" id="goal-card">
      <div class="goal-ring-wrap">${goalRingHtml(goalPct, goalOver)}
        <div class="goal-ring-label"><b>${goalDone}</b><span>из ${me.monthly_goal}</span></div>
      </div>
      <div><h3 style="margin-bottom:4px;">Цель месяца</h3><div class="cap">${goalOver ? "цель выполнена" : `выполнено <b>${goalPct}%</b>`}</div>
      <div class="edit-hint">изменить</div></div>
    </div>
  ` : `
    <div class="bcell wide goal-card" id="goal-card">
      <h3>Цель месяца</h3>
      <div class="goal-hint">Цель на месяц не задана — поставьте себе план, и здесь появится кольцо прогресса.</div>
      <div class="goal-hint" id="goal-pace" hidden></div>
      <span class="pff-goal-set"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Поставить цель</span>
    </div>
  `;

  // Число в плитке «докручивается» от нуля, когда плитка появляется на экране (data-count), а справа от него —
  // небольшое дополнение: сравнение с прошлым месяцем, столбики по неделям, кольцо доли.
  const kpi = (label, val, sub, o = {}) => `
    <div class="pf-kpi${o.empty ? " empty" : ""}">
      <span class="l">${label}</span>
      <span class="pff-kv"><b${o.empty || o.count == null ? "" : ` data-count="${o.count}" data-dec="${o.dec || 0}" data-suffix="${esc(o.suffix || "")}"`}>${o.empty ? "пока нет" : val}</b>${o.extra || ""}</span>
      <span class="s">${sub}</span>
    </div>`;
  const prevMonth = me.completed_prev_month || 0;
  const monthDelta = prevMonth > 0 ? deltaPillHtml(Math.round((((me.completed_month || 0) - prevMonth) / prevMonth) * 100)) : "";
  const onTimeRing = me.on_time_pct != null
    ? `<svg class="pff-ring" viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15"></circle><circle class="f" cx="18" cy="18" r="15" pathLength="100" style="--v:${Math.max(0, Math.min(100, me.on_time_pct))};"></circle></svg>`
    : "";

  // Свой профиль — как портфолио (эталон: одноколоночный сайт-визитка): приветствие с меняющейся
  // подписью, ниже секции одна под другой, сверху плавающая «таблетка» с переходом по секциям и
  // прогрессом прокрутки. Все id/классы, на которые завязаны обработчики и тесты, прежние.
  root.innerHTML = `
    <div class="pf pf-folio">
      <nav class="pff-pill" aria-label="Разделы профиля">
        <span class="pff-pill-ic" aria-hidden="true">${avatarHtml(me.telegram_id, me.display_name || me.name, "sm")}</span>
        ${[["pff-about", "Обо мне"], ["pff-work", "Работа"], ["pff-activity", "Активность"], ["pff-awards", "Награды"]].map(([id, t]) => `<button type="button" data-pff-go="${id}">${t}</button>`).join("")}
        <span class="pff-pct" aria-hidden="true">0%</span>
      </nav>
      <section class="pff-sec" id="pff-about">${folioHeroHtml(me)}</section>
      <div class="pf-kpis pff-stats pff-rv">
        ${kpi("Сейчас на мне", me.assigned ?? 0, me.overdue ? `<span class="warn">${me.overdue} просрочено</span>` : "всё в сроках", { count: me.assigned ?? 0 })}
        ${kpi("Закрыто", me.completed_total ?? 0, `${me.completed_week ?? 0} за неделю · ${me.completed_month ?? 0} за месяц`, { count: me.completed_total ?? 0, extra: `${monthDelta}<span class="pff-spark" data-pff-spark hidden></span>` })}
        ${kpi("Вовремя", `${me.on_time_pct}%`, me.on_time_pct != null ? "закрыто не позже срока" : "появится после первого отчёта со сроком", { empty: me.on_time_pct == null, count: me.on_time_pct, suffix: "%", extra: onTimeRing })}
        ${kpi("Средний срок", `${me.avg_days != null ? me.avg_days.toFixed(1) : ""} дн.`, me.avg_days != null ? "на один отчёт" : "появится после первой закрытой серии", { empty: me.avg_days == null, count: me.avg_days, dec: 1, suffix: " дн." })}
      </div>
      <section class="pff-sec pff-rv" id="pff-work">
        <h2 class="pff-h">Работа</h2>
        ${prepHtml(me)}
        ${myWorkHtml(me)}
        <div class="pff-two">
          ${goalCardHtml}
          <section class="pf-card pf-tenure"><h3>Стаж в команде</h3>${tenureProgressHtml(me.member_since_days) || `<div class="pf-quiet">стаж появится позже</div>`}</section>
        </div>
      </section>
      <section class="pff-sec pff-rv" id="pff-activity">
        <h2 class="pff-h">Активность</h2>
        <section class="pf-card pff-pulse" id="pulse-card">
          <div class="pf-card-head"><h3>Пульс <span class="n">полгода по дням</span></h3><span class="pff-pulse-sum" id="pulse-sum"></span></div>
          <div id="pulse-body"><div class="pff-heat-skel"></div></div>
        </section>
        <section class="pf-card" id="activity-card">
          <div class="pf-card-head"><h3>Последние действия</h3><button class="pf-link" id="activity-all">вся активность →</button></div>
          <div class="pf-acts" id="activity-list"><div class="pf-quiet">загружаю…</div></div>
        </section>
        <div class="pff-two">
          <section class="pf-card pf-notif">
            <h3>Уведомления</h3>
            <div class="pf-notif-row" id="reminders-card" role="button" tabindex="0"></div>
            <div class="pf-notif-row" id="pause-card" role="button" tabindex="0"></div>
          </section>
          ${teamTeaserHtml(me)}
        </div>
      </section>
      <section class="pff-sec pff-rv" id="pff-awards">
        <h2 class="pff-h">Награды</h2>
        ${myBadgesHtml(me) || `<div class="pf-quiet">Наград пока нет — они появятся за закрытые серии и стаж.</div>`}
      </section>
      ${folioFooterHtml(me)}
      ${devModeActive() ? devPanelHtml(me) + vaultEntryHtml() : ""}
    </div>
  `;
  wireFolio(root);
  wireGraffiti(root, me.telegram_id);
  wireProfileCommon(root, me.telegram_id, () => loadProfile());
  // Обе догрузки — без await: профиль уже отрисован, и ждать ради
  // подсказки в одном блоке незачем (иначе на них ждала бы и кнопка
  // «Обновить», которая дожидается loadProfile).
  if (state.isAdmin) fillIdleSlot(root);
  fillPauseCard(root, me.telegram_id);
  fillRemindersCard(root);
  fillRecentActivity(root);
  fillPulse(root);
  let suggested = null;
  if (!goalSet) suggestGoal(root).then(v => { suggested = v; });
  root.querySelector("#goal-card").addEventListener("click", () => monthlyGoalDialog(me.monthly_goal || suggested));
  root.querySelectorAll("#btn-edit-profile, [data-edit-profile]").forEach(b => b.addEventListener("click", () => editProfileDialog(me)));
  root.querySelectorAll("[data-manage-roles]").forEach(button => button.addEventListener("click", () => openProfileRoles(Number(button.dataset.manageRoles))));
  root.querySelector("#activity-all").addEventListener("click", () => openMyActivitySheet());
  root.querySelectorAll("[data-open-report]").forEach(row => {
    row.addEventListener("click", () => openReportDetail(row.dataset.openReport));
  });
  if (devModeActive()) { wireDevPanel(root, me.telegram_id, () => loadProfile(), me); wireVaultEntry(root); }
  notifyGoalReachedIfNeeded(me, goalSet, goalOver, goalDone);
}

// ---------- Портфолио (свой профиль) ----------

function folioRoles(d) {
  const roles = (Array.isArray(d.roles) ? d.roles : (d.role ? [d.role] : [])).filter(r => r && r.toLowerCase() !== "user");
  // Только назначенные роли: этапы из отчётов (role_breakdown, напр. «Даббер») ролью человека не являются.
  const list = [...roles];
  if (d.is_developer || d.is_owner) list.push("Разработчик Project");
  return list.length ? list : ["Участник Project"];
}

const WEEKDAYS_RU = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function greeting(h) {
  if (h < 5) return "Доброй ночи";
  if (h < 12) return "Доброе утро";
  if (h < 18) return "Добрый день";
  return "Добрый вечер";
}

function folioHeroHtml(d, isSelf = true) {
  const tier = tenureTier(d.member_since_days);
  const name = d.display_name || d.name || "";
  const first = name.split(/\s+/)[0] || name;
  const roles = folioRoles(d);
  let joined = "";
  if (d.created_at) {
    const jd = new Date(d.created_at.replace(" ", "T") + "Z");
    if (!isNaN(jd.getTime())) joined = `с ${jd.getUTCDate()} ${MONTHS_RU[jd.getUTCMonth() + 1]}. ${jd.getUTCFullYear()}`;
  }
  const meta = [
    d.username ? `@${esc(d.username)}` : "",
    d.internal_id != null ? `<span class="id-chip">#${d.internal_id}</span>` : "",
    joined ? `в команде ${joined}` : "",
  ].filter(Boolean).join(`<i class="dot"></i>`);
  const bio = d.status_text || d.bio
    ? `${d.status_text ? `<p class="pff-status">${esc(d.status_text)}</p>` : ""}${d.bio ? `<p class="pff-bio">${esc(d.bio)}</p>` : ""}`
    : !isSelf ? "" : `<button type="button" class="pff-bio-add" data-edit-profile><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Добавить статус и пару слов о себе — их видят коллеги</button>`;
  const now = new Date();
  return `
    <div class="pf-hero pff-hero">
      <div class="pf-banner pff-banner" data-role="profile-banner" data-pos="${Number(d.banner_pos_y ?? 50)}"${isSelf ? ' data-editable="1"' : ""}></div>
      <div class="pff-hero-row">
        <div class="pff-intro">
          ${isSelf ? `<div class="pff-eyebrow"><span>${WEEKDAYS_RU[now.getDay()]}, ${now.getDate()} ${MONTHS_RU[now.getMonth() + 1]}</span><i class="dot"></i><span class="pff-clock" data-pff-clock></span></div>` : `<div class="pff-eyebrow"><span>${d.is_online ? "в сети" : "профиль коллеги"}</span></div>`}
          <h1 class="pff-hi">${isSelf ? `<span data-pff-greet>${greeting(now.getHours())}</span>, <b>${esc(first)}</b>` : `<b>${esc(name)}</b>`}${d.is_developer || d.is_owner ? ` <span class="dev-pill">DEV</span>` : ""}</h1>
          <div class="pff-role" aria-live="polite"><span class="pff-role-t" data-pff-roles="${esc(JSON.stringify(roles))}">${esc(roles[0])}</span>${rankTagHtml(d.studio_rank)}</div>
          ${bio}
          <div class="pf-meta">${meta}</div>
        </div>
        <span class="avatar-ring pff-av${tier ? " tier-" + tier : ""}${d.is_online ? " online" : ""}">${avatarHtml(d.telegram_id, name, "xl")}</span>
      </div>
      <div class="pff-actions">
        ${profileRolesHtml(d, true)}
        <span class="pff-act-r">
        ${isSelf ? `<button class="btn pf-edit" id="btn-edit-profile"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/></svg>Изменить</button>` : ""}
        ${state.isDeveloper ? `<button class="btn" data-graffiti-edit><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 21c3 0 4-2 4-4a3 3 0 1 1 3 3"/><path d="M10 14 20 4"/></svg>Граффити</button>` : ""}</span>
      </div>
    </div>`;
}

function folioFooterHtml(d, isSelf = true) {
  const days = d.member_since_days;
  const won = (d.badges || []).filter(b => b.unlocked).length;
  return `
    <footer class="pff-foot">
      <blockquote>«Хороший дубляж не слышно — слышно историю.»<cite>девиз студии</cite></blockquote>
      ${days != null ? `<div class="pff-glow"><span>${isSelf ? "Вы" : esc((d.display_name || d.name || "").split(/\s+/)[0])} в команде <b>${days}</b> ${pluralDays(days)}${won ? ` · наград: <b>${won}</b>` : ""}</span></div>` : ""}
      ${isSelf ? `<p class="pff-cta">Возьмём следующую серию?</p>` : ""}
    </footer>`;
}

// Плавающая таблетка: переход по секциям, подсветка текущей и кольцо прокрутки вокруг аватара; подпись роли
// меняется по кругу; часы — местное время с прокруткой цифр; секции проявляются, когда до них докрутили.
function wireFolio(root) {
  const folio = root.querySelector(".pf-folio");
  if (!folio) return;
  const reduce = !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let scroller = folio.parentElement;
  while (scroller && scroller !== document.body && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  if (!scroller || scroller === document.body) scroller = document.scrollingElement || document.documentElement;
  const isDoc = scroller === document.documentElement || scroller === document.scrollingElement;
  const pill = folio.querySelector(".pff-pill");
  const pct = pill.querySelector(".pff-pct");
  const btns = [...pill.querySelectorAll("[data-pff-go]")];
  pill.addEventListener("click", e => {
    const b = e.target.closest("[data-pff-go]");
    if (b) folio.querySelector(`#${b.dataset.pffGo}`)?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  });
  const banner = folio.querySelector(".pff-banner");
  const secs = btns.map(b => [b, folio.querySelector(`#${b.dataset.pffGo}`)]).filter(x => x[1]);
  // Прокрутка: одно обновление на кадр, сначала все чтения, потом записи (иначе каждая запись заставляла браузер
  // заново считать раскладку), и запись только когда значение изменилось. Пока страница едет, декоративные
  // анимации профиля стоят на паузе (класс pff-scrolling) — кадры уходят на саму прокрутку.
  let raf = 0, idle = 0, lastP = -1, lastY = -1, lastCur = null, lastLift = null;
  const update = () => {
    raf = 0;
    if (!folio.isConnected) { scroller.removeEventListener("scroll", onScroll); return; }
    const st = scroller.scrollTop;
    const max = scroller.scrollHeight - scroller.clientHeight;
    const top = isDoc ? 0 : scroller.getBoundingClientRect().top;
    let cur = btns[0];
    for (const [b, sec] of secs) if (sec.getBoundingClientRect().top - top < 160) cur = b;
    const p = max > 0 ? Math.round(Math.min(1, st / max) * 100) : 100;
    if (p !== lastP) { lastP = p; pct.textContent = `${p}%`; pill.style.setProperty("--p", String(p)); }
    // баннер медленно приближается, пока шапка на экране
    const y = reduce ? 0 : Math.round(Math.min(700, st) * 0.18);
    if (banner && y !== lastY) { lastY = y; banner.style.setProperty("--pff-y", String(y)); }
    if (cur !== lastCur) { lastCur = cur; btns.forEach(b => b.classList.toggle("on", b === cur)); }
    const lift = st > 12;
    if (lift !== lastLift) { lastLift = lift; pill.classList.toggle("lifted", lift); }
  };
  const onScroll = () => {
    if (!raf) raf = requestAnimationFrame(update);
    if (!idle) folio.classList.add("pff-scrolling");
    clearTimeout(idle);
    idle = setTimeout(() => { idle = 0; folio.classList.remove("pff-scrolling"); }, 160);
  };
  scroller.addEventListener("scroll", onScroll, { passive: true });
  update();

  // Проявление секций. Без IntersectionObserver (или при выключенных анимациях) — всё видно сразу.
  const rv = [...folio.querySelectorAll(".pff-rv")];
  if (reduce || typeof window.IntersectionObserver !== "function") {
    rv.forEach(el => el.classList.add("in"));
  } else {
    folio.classList.add("pff-anim");
    const io = new window.IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        en.target.classList.add("in");
        countUp(en.target);
      }
    }, { root: isDoc ? null : scroller, rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    rv.forEach(el => io.observe(el));
    // вращающиеся свечения (аватар, плашка в подвале) крутятся, только пока их видно
    const away = new window.IntersectionObserver(entries => {
      for (const en of entries) en.target.classList.toggle("pff-away", !en.isIntersecting);
    }, { root: isDoc ? null : scroller });
    folio.querySelectorAll(".pff-hero, .pff-foot").forEach(el => away.observe(el));
  }

  const clock = folio.querySelector("[data-pff-clock]");
  const greet = folio.querySelector("[data-pff-greet]");
  const role = folio.querySelector("[data-pff-roles]");
  let roles = [];
  try { roles = JSON.parse(role?.dataset.pffRoles || "[]"); } catch (_) { /* подпись останется первой ролью */ }
  let i = 0, n = 0;
  const tick = () => {
    const now = new Date();
    rollText(clock, `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
    if (greet) greet.textContent = greeting(now.getHours());
  };
  const timer = setInterval(() => {
    if (!folio.isConnected) { clearInterval(timer); return; }
    tick();
    if (reduce || roles.length < 2 || !role || ++n % 3) return;
    role.classList.add("out");
    setTimeout(() => { i = (i + 1) % roles.length; role.textContent = roles[i]; role.classList.remove("out"); }, 260);
  }, 1000);
  tick();
}

// Числа в плитках «докручиваются» от нуля до значения (data-count), один раз.
function countUp(root) {
  root.querySelectorAll("[data-count]").forEach(el => {
    const to = Number(el.dataset.count);
    if (!Number.isFinite(to) || to <= 0 || el.dataset.counted) return;
    el.dataset.counted = "1";
    const dec = Number(el.dataset.dec || 0), suffix = el.dataset.suffix || "";
    const dur = 900;
    let t0 = null;
    const step = t => {
      if (t0 == null) t0 = t;
      const k = Math.min(1, Math.max(0, (t - t0) / dur));
      el.textContent = (to * (1 - Math.pow(1 - k, 3))).toFixed(dec) + suffix;
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    el.textContent = (0).toFixed(dec) + suffix;
    requestAnimationFrame(step);
  });
}

// ---------- «Пульс»: календарь активности за полгода ----------

const MSK_MS = 3 * 3600e3, DAY_MS = 86400e3, PULSE_WEEKS = 26;

function pluralRu(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// Сервер отдаёт счётчики по московским датам; раскладываем их в 26 недель (пн–вс), последняя — текущая.
// Даты считаем в UTC со сдвигом на Москву, чтобы сетка не зависела от пояса компьютера.
export function pulseModel(d, nowMs = Date.now()) {
  const actions = (d && d.actions) || {}, closed = (d && d.closed) || {};
  const today = new Date(nowMs + MSK_MS);
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const start = t0 - ((today.getUTCDay() + 6) % 7) * DAY_MS - (PULSE_WEEKS - 1) * 7 * DAY_MS;
  const weeks = [], past = [];
  let max = 0;
  for (let w = 0; w < PULSE_WEEKS; w++) {
    const days = [];
    let closedSum = 0;
    for (let k = 0; k < 7; k++) {
      const ts = start + (w * 7 + k) * DAY_MS;
      const key = new Date(ts).toISOString().slice(0, 10);
      const future = ts > t0;
      const day = { ts, n: future ? 0 : Number(actions[key]) || 0, c: future ? 0 : Number(closed[key]) || 0, future };
      if (!future) { past.push(day); max = Math.max(max, day.n); closedSum += day.c; }
      days.push(day);
    }
    weeks.push({ ts: start + w * 7 * DAY_MS, days, closed: closedSum });
  }
  // серия: дни подряд с действиями, считая от сегодня (или от вчера, если сегодня ещё пусто)
  let streak = 0;
  for (let k = past.length - 1; k >= 0; k--) {
    if (past[k].n > 0) streak++;
    else if (k !== past.length - 1) break;
  }
  const sum = list => list.reduce((a, x) => a + x.n, 0);
  const best = past.reduce((a, x) => (x.n > (a ? a.n : 0) ? x : a), null);
  return {
    weeks, max, streak, best,
    activeDays: past.filter(x => x.n > 0).length,
    total: sum(past),
    last30: sum(past.slice(-30)),
    prev30: sum(past.slice(-60, -30)),
    closedTotal: weeks.reduce((a, w) => a + w.closed, 0),
    maxClosedWeek: weeks.reduce((a, w) => Math.max(a, w.closed), 0),
  };
}

const dayLabel = ts => { const d = new Date(ts); return `${d.getUTCDate()} ${MONTHS_RU[d.getUTCMonth() + 1]}`; };

function pulseHtml(m) {
  const lvl = n => (n > 0 ? Math.min(4, Math.max(1, Math.ceil((n / m.max) * 4))) : 0);
  let lastMonth = -1;
  const months = m.weeks.map(w => {
    const mo = new Date(w.ts).getUTCMonth();
    const show = mo !== lastMonth;
    lastMonth = mo;
    return `<span>${show ? MONTHS_RU[mo + 1] : ""}</span>`;
  }).join("");
  const cells = m.weeks.map((w, wi) => w.days.map(day => day.future
    ? `<i class="f"></i>`
    : `<i class="l${lvl(day.n)}${day.c ? " c" : ""}" style="--i:${wi};" data-tip="${dayLabel(day.ts)} · ${day.n ? `${day.n} ${pluralRu(day.n, "действие", "действия", "действий")}` : "тихо"}${day.c ? ` · закрыто ${day.c}` : ""}"></i>`).join("")).join("");
  const bars = m.closedTotal ? `
    <div class="pff-heat-b">${m.weeks.map((w, wi) => `<i style="--i:${wi}; --h:${Math.round((w.closed / m.maxClosedWeek) * 100)}%;"${w.closed ? ` class="on"` : ""} data-tip="неделя с ${dayLabel(w.ts)} · закрыто ${w.closed}"></i>`).join("")}</div>
    <div class="pff-heat-cap">закрытые серии по неделям</div>` : "";
  const stat = (v, l) => `<div class="pff-ps"><b>${v}</b><span>${l}</span></div>`;
  return `
    <div class="pff-heat" style="--cols:${m.weeks.length};">
      <div class="pff-heat-m">${months}</div>
      <div class="pff-heat-w">
        <div class="pff-heat-wd"><span>пн</span><span></span><span>ср</span><span></span><span>пт</span><span></span><span>вс</span></div>
        <div class="pff-heat-g">${cells}</div>
      </div>
      ${bars}
      <div class="pff-tip" hidden></div>
    </div>
    <div class="pff-pulse-foot">
      <div class="pff-pss">
        ${stat(m.activeDays, pluralRu(m.activeDays, "активный день", "активных дня", "активных дней"))}
        ${stat(m.streak, `${pluralRu(m.streak, "день", "дня", "дней")} подряд`)}
        ${stat(m.best ? m.best.n : 0, m.best ? `рекорд за день · ${dayLabel(m.best.ts)}` : "рекорд за день")}
        ${stat(m.closedTotal, pluralRu(m.closedTotal, "серия закрыта", "серии закрыто", "серий закрыто"))}
      </div>
      <div class="pff-heat-leg">меньше<i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i>больше</div>
    </div>`;
}

async function fillPulse(root, base = "/me") {
  const card = root.querySelector("#pulse-card");
  if (!card) return;
  let d;
  try { d = await apiGet(`${base}/pulse`); } catch (_) { d = null; }
  if (!card.isConnected) return;
  // старый сервер без /me/pulse — просто без карточки
  if (!d || typeof d.actions !== "object" || d.actions === null) { card.remove(); return; }
  const m = pulseModel(d);
  const body = card.querySelector("#pulse-body");
  if (!m.total) {
    body.innerHTML = `<div class="pf-quiet">За полгода действий по отчётам не было — календарь заполнится, как только появится работа.</div>`;
    return;
  }
  body.innerHTML = pulseHtml(m);
  const delta = m.prev30 > 0 ? deltaPillHtml(Math.round(((m.last30 - m.prev30) / m.prev30) * 100)) : "";
  card.querySelector("#pulse-sum").innerHTML = `<b>${m.last30}</b> ${pluralRu(m.last30, "действие", "действия", "действий")} за 30 дней ${delta}`;
  requestAnimationFrame(() => requestAnimationFrame(() => body.classList.add("in")));
  // После появления анимацию с клеток снимаем: законченная анимация оставляла каждую из ~200 клеток отдельным слоем,
  // и прокрутка возле календаря подтормаживала (замер: дёрганые кадры 10 → 4).
  setTimeout(() => body.classList.add("done"), 200 * 16 + 1200); // DevSkim: ignore DS172411 — функция, не строка

  // одна всплывающая подсказка на всю сетку
  const heat = body.querySelector(".pff-heat"), tip = body.querySelector(".pff-tip");
  heat.addEventListener("pointerover", e => {
    const el = e.target.closest("[data-tip]");
    if (!el) { tip.hidden = true; return; }
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const hr = heat.getBoundingClientRect(), r = el.getBoundingClientRect();
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.max(half, Math.min(hr.width - half, r.left - hr.left + r.width / 2))}px`;
    tip.style.top = `${r.top - hr.top}px`;
  });
  heat.addEventListener("pointerleave", () => { tip.hidden = true; });

  // те же недели — столбиками в плитке «Закрыто» (последние 12)
  const spark = root.querySelector("[data-pff-spark]");
  const last = m.weeks.slice(-12);
  const top = last.reduce((a, w) => Math.max(a, w.closed), 0);
  if (spark && top > 0) {
    spark.innerHTML = last.map(w => `<i style="--h:${Math.max(8, Math.round((w.closed / top) * 100))}%;"${w.closed ? ` class="on"` : ""}></i>`).join("");
    spark.title = "Закрытые серии по неделям, последние 12 недель";
    spark.hidden = false;
  }
}

// «Моя работа» — вместо огромного доната на одно значение: тонкая
// полоска по статусам и сам список того, что на руках.
function myWorkHtml(me, other = false) {
  const reports = me.reports || [];
  const heading = other ? "Сейчас в работе" : "Моя работа";
  if (!reports.length && other) {
    return `<section class="pf-card"><div class="pf-card-head"><h3>${heading}</h3></div><div class="pf-quiet">Сейчас в работе ничего нет</div></section>`;
  }
  if (!reports.length) {
    return `
      <section class="pf-card">
        <div class="pf-card-head"><h3>Моя работа</h3></div>
        <div class="idle-card" id="idle-slot">
          <img class="idle-mascot" src="${mascotUrl}" alt="">
          <div class="idle-text"><div class="t">На руках пусто</div><div class="d">${state.isAdmin ? "смотрю, есть ли свободные серии…" : "когда назначат серию, она появится здесь"}</div></div>
        </div>
      </section>`;
  }
  const counts = {};
  for (const r of reports) counts[r.status] = (counts[r.status] || 0) + 1;
  const label = st => state.statusOptions.find(([v]) => v === st)?.[1] || st;
  const segs = Object.entries(STATUS_COLOR_VAR).filter(([st]) => counts[st]);
  const bar = segs.map(([st, c]) => `<i style="flex:${counts[st]}; background:var(${c});" title="${esc(label(st))}: ${counts[st]}"></i>`).join("");
  const legend = segs.map(([st, c]) => `<span><i style="background:var(${c});"></i>${esc(label(st))} <b>${counts[st]}</b></span>`).join("");
  const rows = (other ? reports : reports.slice(0, 6)).map(r => {
    const late = isOverdue(r);
    const c = STATUS_COLOR_VAR[r.status] || "--ink-dim";
    return `
      <button class="pf-rep" data-open-report="${esc(r.public_id)}">
        <i class="pf-rep-dot" style="background:var(${c});"></i>
        <span class="t">${esc(r.title || r.public_id)}</span>
        <span class="id">${esc(r.public_id)}</span>
        <span class="st" style="--c:var(${c});">${esc(r.status_label || label(r.status))}</span>
        <span class="dl${late ? " late" : ""}">${r.deadline ? `${late ? "просрочено · " : "до "}${esc(r.deadline.slice(8, 10))}.${esc(r.deadline.slice(5, 7))}` : "без срока"}</span>
      </button>`;
  }).join("");
  const roles = (me.role_breakdown || []).map(rb => `<span class="pf-role">${esc(rb.role)} <b>${rb.pct}%</b></span>`).join("");
  return `
    <section class="pf-card">
      <div class="pf-card-head"><h3>${heading} <span class="n">${reports.length}</span></h3></div>
      <div class="pf-bar">${bar}</div>
      <div class="pf-legend">${legend}</div>
      <div class="pf-reps">${rows}</div>
      ${!other && reports.length > 6 ? `<div class="pf-quiet">и ещё ${reports.length - 6} — во вкладке «Список»</div>` : ""}
      ${roles ? `<div class="pf-roles"><span class="l">Роли в пайплайне</span>${roles}</div>` : ""}
    </section>`;
}

// «Вклад росписи»: их работа — сабы, равки, пайплайн и распределение людей, а не закрытые серии, поэтому обычные
// цифры профиля у них нули. Показываем тем, у кого роль «Роспись» или уже есть такой вклад (prep с сервера).
function prepHtml(me) {
  const p = me.prep;
  if (!p || (!p.is_role && !p.series)) return "";
  const n = (v, one, few, many) => `${v} ${v % 10 === 1 && v % 100 !== 11 ? one : v % 10 >= 2 && v % 10 <= 4 && (v % 100 < 12 || v % 100 > 14) ? few : many}`;
  if (!p.series && !p.assigned) {
    return `
      <section class="pf-card pf-prep">
        <div class="pf-card-head"><h3>✍️ Вклад росписи</h3></div>
        <div class="pf-quiet">Пока пусто. Выложите субтитры или равки к серии или настройте пайплайн — это засчитается сюда, а дабберы увидят в уведомлении, кто подготовил серию.</div>
      </section>`;
  }
  const tile = (v, l) => `<div class="pf-prep-t"><b>${v}</b><span>${l}</span></div>`;
  return `
    <section class="pf-card pf-prep">
      <div class="pf-card-head"><h3>✍️ Вклад росписи</h3>${p.month ? `<span class="pf-prep-m">${n(p.month, "серия", "серии", "серий")} за 30 дней</span>` : ""}</div>
      <div class="pf-prep-grid">
        ${tile(p.series, "серий подготовлено")}
        ${tile(p.titles, "тайтлов")}
        ${tile(p.subs, "субтитров выложено")}
        ${tile(p.raws, "равок выложено")}
        ${tile(p.assigned, "людей распределено")}
        ${tile(p.pipelines, "пайплайнов собрано")}
      </div>
      <div class="pf-quiet">Без росписи дабберам нечего озвучивать: каждая серия здесь — это серия, которую команда смогла начать.</div>
    </section>`;
}

// Достижения плитками: полученные цветные, остальные приглушены
// с прогрессом — вся сетка видна сразу, без пустых строк «нет данных».
function myBadgesHtml(d) {
  const all = (d.badges || []).slice().sort((a, b) => (b.unlocked ? 1 : 0) - (a.unlocked ? 1 : 0) || (BADGE_RARITY_ORDER[a.rarity] ?? 9) - (BADGE_RARITY_ORDER[b.rarity] ?? 9));
  if (!all.length) return "";
  const won = all.filter(b => b.unlocked).length;
  const tiles = all.map(b => {
    const has = b.target ? Math.max(0, Math.min(b.target, b.current || 0)) : null;
    const pct = b.target ? Math.round((has / b.target) * 100) : 0;
    return `
      <div class="pf-badge${b.unlocked ? " won" : ""} r-${esc(b.rarity || "common")}" title="${esc(b.label)}">
        <span class="ic">${esc(b.icon)}</span>
        <span class="lb">${esc(b.label)}</span>
        ${b.unlocked ? `<span class="pr">получено</span>` : `<span class="pr">${b.target ? `${has} / ${b.target}` : "нет данных"}</span><span class="tr"><i style="width:${pct}%;"></i></span>`}
        ${b.unlocked && b.custom && devModeActive() ? `<button class="icon-btn badge-revoke" data-revoke-badge="${b.id}" title="Отозвать награду">✕</button>` : ""}
      </div>`;
  }).join("");
  return `
    <section class="pf-card">
      <div class="pf-card-head"><h3>Достижения <span class="n">${won} из ${all.length}</span></h3></div>
      <div class="pf-badges">${tiles}</div>
    </section>`;
}

// Вид действия — для цвета и значка точки на таймлайне.
function actKind(action) {
  const a = String(action || "").toLowerCase();
  if (/удал|снят|отмен|отозв/.test(a)) return "del";
  if (/назнач|добав|созда/.test(a)) return "add";
  if (/файл|загруж|залит|выложен/.test(a)) return "file";
  if (/статус|закры|заверш|готов|принят/.test(a)) return "done";
  return "etc";
}
const ACT_ICONS = {
  add: `<path d="M12 5v14M5 12h14"/>`,
  del: `<path d="M5 12h14"/>`,
  file: `<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>`,
  done: `<path d="M5 12.5l4.5 4.5L19 7.5"/>`,
  etc: `<circle cx="12" cy="12" r="2.5"/>`,
};

async function fillRecentActivity(root, base = "/me") {
  const box = root.querySelector("#activity-list");
  if (!box) return;
  let d;
  try { d = await apiGet(`${base}/activity`); } catch (_) { d = null; }
  if (!box.isConnected) return;
  const evs = ((d && d.events) || []).slice(0, 6);
  if (!evs.length) { box.innerHTML = `<div class="pf-quiet">пока тихо — действия по отчётам появятся здесь</div>`; return; }
  box.classList.add("pff-tl");
  box.innerHTML = evs.map((ev, i) => {
    const kind = actKind(ev.action);
    return `
    <div class="pf-act k-${kind}" style="--i:${i};"${ev.public_id ? ` data-open-report="${esc(ev.public_id)}"` : ""}>
      <i><svg viewBox="0 0 24 24" aria-hidden="true">${ACT_ICONS[kind]}</svg></i>
      <div class="pff-tl-b"><div class="a">${esc(ev.action || "")}${ev.detail ? ` <span>· ${esc(ev.detail)}</span>` : ""}</div>
      <div class="m">${ev.public_id ? `${esc(ev.public_id)} ${esc(ev.title || "")}` : ""}</div></div>
      <time title="${esc(formatWhen(ev.created_at))}">${esc(relTime(ev.created_at))}</time>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-open-report]").forEach(row => {
    row.addEventListener("click", () => openReportDetail(row.dataset.openReport));
  });
}

// Свободные серии для пустого профиля — тот же быстрый фильтр
// «без исполнителя», что и на вкладке «Список». Отдельным запросом
// после отрисовки: профиль не должен ждать его, чтобы показаться.
async function fillIdleSlot(root) {
  const slot = root.querySelector("#idle-slot");
  if (!slot) return;
  let d;
  try {
    d = await apiGet("/reports", { unassigned: 1, page_size: 100 });
  } catch (_) {
    slot.querySelector(".d").textContent = "свободные серии сейчас не посмотреть — нет связи";
    return;
  }
  if (!slot.isConnected) return;
  const free = d.reports || [];
  const total = d.total || free.length;
  if (!total) {
    slot.querySelector(".d").textContent = "свободных серий тоже нет — всё разобрано";
    return;
  }
  const hot = free.filter(isOverdue).length;
  slot.querySelector(".d").innerHTML =
    `${total} ${total === 1 ? "серия" : "серий"} без исполнителя` +
    (hot ? ` · <span style="color:var(--s-stop);">${hot} просрочено</span>` : "");
  const btn = document.createElement("button");
  btn.className = "btn primary idle-go";
  btn.textContent = "Посмотреть";
  btn.addEventListener("click", () => {
    // Если «Список» уже был загружен, switchTab его не перечитает
    // (loadedTabs) — перечитываем сами, иначе фильтр применится только
    // визуально, к чипу.
    const wasLoaded = state.loadedTabs.has("list");
    setQuickFilter("unassigned");
    switchTab("list");
    if (wasLoaded) loadReports();
  });
  slot.appendChild(btn);
}

// Сколько закрывают остальные — чтобы «поставьте себе план» не был
// вопросом в пустоту. Берём уже существующий рейтинг месяца (тот же
// эндпоинт дёргает «Обзор»), считаем средний темп по тем, кто вообще
// закрывал. Не вышло — просто не показываем подсказку.
async function suggestGoal(root) {
  const el = root.querySelector("#goal-pace");
  if (!el) return null;
  try {
    const d = await apiGet("/overview/monthly-top");
    const done = (d.top || []).map(p => p.completed || 0).filter(n => n > 0);
    if (!done.length) return null;
    const avg = Math.max(1, Math.round(done.reduce((a, b) => a + b, 0) / done.length));
    if (!el.isConnected) return avg;
    el.hidden = false;
    el.textContent = `Темп команды за месяц — ${avg} ${avg === 1 ? "серия" : "серий"} на человека.`;
    return avg;
  } catch (_) {
    return null;
  }
}

// Системный тост при первом заходе после того, как цель месяца
// выполнена — а не только цвет кольца, который увидишь лишь если сам
// зашёл на вкладку «Я». Флаг «уже уведомляли в этом месяце» — в
// localStorage (per-machine, не критично разделять между устройствами
// одного человека), ключ включает telegram_id и месяц, чтобы новый
// месяц с той же целью снова мог уведомить.
function notifyGoalReachedIfNeeded(me, goalSet, goalOver, goalDone) {
  if (!goalSet || !goalOver) return;
  const monthKey = new Date().toISOString().slice(0, 7);
  const flagKey = `project_goal_notified_${me.telegram_id}_${monthKey}`;
  try {
    if (localStorage.getItem(flagKey)) return;
    localStorage.setItem(flagKey, "1");
  } catch (_) { return; } // приватный режим/запрет хранилища — не критично, просто без уведомления
  sendNotification({
    title: "Project",
    body: `Цель месяца выполнена — ${goalDone} из ${me.monthly_goal} отчётов закрыто. 🎯`,
  });
}

function editProfileDialog(me) {
  const overlay = openSheet(`
    <h2>Статус и о себе</h2>
    <div class="row"><input type="text" id="dlg-status" maxlength="80" placeholder="Короткий статус" value="${esc(me.status_text || "")}"></div>
    <div class="row"><textarea id="dlg-bio" rows="3" maxlength="300" placeholder="О себе">${esc(me.bio || "")}</textarea></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Сохранить</button>
    </div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-apply").addEventListener("click", async () => {
    const status_text = overlay.querySelector("#dlg-status").value;
    const bio = overlay.querySelector("#dlg-bio").value;
    try {
      await apiPost("/me/profile", { status_text, bio });
      toast("Профиль обновлён.");
      overlay.remove();
      await loadProfile();
    } catch (e) {
      toast(`Не удалось сохранить: ${e.message}`, "error");
    }
  });
}

async function openMyActivitySheet() {
  const overlay = openSheet(`<h2>Моя активность</h2>${dialogSkeletonHtml(6)}`);
  const sheet = overlay.querySelector(".sheet");
  let d;
  try {
    d = await apiGet("/me/activity");
  } catch (e) {
    sheet.innerHTML = `<h2>Моя активность</h2><div class="bento-empty">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  const rows = (d.events || []).map(ev => `
    <div class="note-item" data-open-report="${esc(ev.public_id || "")}" style="${ev.public_id ? "cursor:pointer;" : ""}">
      <div class="meta">${esc(ev.public_id || "")} ${esc(ev.title || "")} · ${esc(ev.created_at || "")}</div>
      <div>${esc(ev.action || "")}${ev.detail ? ` — ${esc(ev.detail)}` : ""}</div>
    </div>
  `).join("");
  sheet.innerHTML = `
    <h2>Моя активность</h2>
    <div>${rows || `<div class="bento-empty">Пока пусто</div>`}</div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  sheet.querySelectorAll("[data-open-report]").forEach(row => {
    if (row.dataset.openReport) row.addEventListener("click", () => openReportDetail(row.dataset.openReport));
  });
}

function monthlyGoalDialog(current) {
  const overlay = openSheet(`
    <h2>Цель на месяц</h2>
    <p style="color:var(--ink-soft); font-size:12.5px; margin-top:-8px;">Сколько отчётов хотите закрыть в этом месяце. 0 — снять цель.</p>
    <div class="row"><input type="number" id="dlg-goal" min="0" max="500" value="${current || 0}"></div>
    <div class="sheet-actions">
      <button class="btn ghost" data-close>Отмена</button>
      <button class="btn primary" id="dlg-apply">Сохранить</button>
    </div>
  `);
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelector("#dlg-apply").addEventListener("click", async () => {
    const goal = Number(overlay.querySelector("#dlg-goal").value) || 0;
    try {
      await apiPost("/me/goal", { goal });
      toast(goal ? "Цель сохранена." : "Цель снята.");
      overlay.remove();
      await loadProfile();
    } catch (e) {
      toast(`Не удалось сохранить цель: ${e.message}`, "error");
    }
  });
}

// ---------- Команда / чужой профиль ----------

export async function openTeamSheet() {
  const overlay = openSheet(dialogSkeletonHtml(6), "wide");
  overlay.querySelector(".sheet").innerHTML = `<h2>Команда</h2>` + dialogSkeletonHtml(6);
  let d;
  try {
    d = await apiGet("/team");
  } catch (e) {
    overlay.querySelector(".sheet").innerHTML = `<h2>Команда</h2><div class="bento-empty">Не удалось загрузить: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  const rows = (d.users || []).map(u => `
    <div class="team-row" data-open-user="${u.telegram_id}" data-username="${esc(u.username || "")}">
      ${avatarHtml(u.telegram_id, u.name, "sm")}
      <span class="online-dot${u.online ? "" : " off"}"></span>
      <div class="nm"><div class="n">${esc(u.name)}${u.is_owner ? ` <span class="dev-pill">DEV</span>` : ""}</div><div class="r">${esc(u.role || "без роли")}</div></div>
      <div class="stat">${u.assigned} сейчас · ${u.completed_total} закрыто</div>
    </div>
  `).join("");
  overlay.querySelector(".sheet").innerHTML = `
    <h2>Команда · ${d.users.length}</h2>
    <div class="team-list">${rows || `<div class="bento-empty">Пока никого нет.</div>`}</div>
    <div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>
  `;
  const sheet = overlay.querySelector(".sheet");
  loadAvatars(sheet);
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  sheet.querySelectorAll("[data-open-user]").forEach(row => {
    const telegramId = parseInt(row.dataset.openUser, 10);
    row.addEventListener("click", () => openUserProfile(telegramId));
    // Правый клик — быстрые действия без открытия целого профиля:
    // привычка из проводника/почты, а не только «клик = открыть».
    row.addEventListener("contextmenu", e => {
      e.preventDefault();
      const username = row.dataset.username;
      const items = [{ label: "Открыть профиль", action: () => openUserProfile(telegramId) }];
      if (username) {
        items.push({ label: "Написать в Telegram", action: () => openTelegramProfile(username) });
      }
      items.push({
        label: "Скопировать Telegram ID",
        action: () => {
          navigator.clipboard.writeText(String(telegramId))
            .then(() => toast("ID скопирован."))
            .catch(() => toast("Не удалось скопировать.", "error"));
        },
      });
      showContextMenu(e.clientX, e.clientY, items);
    });
  });
}

// Открыть личный чат в Telegram — во внешнем приложении/браузере
// (plugin:shell|open), а не внутри окна Project: это desktop-клиент
// студии, не браузер, встраивать чужой веб-клиент Telegram сюда незачем.
async function openTelegramProfile(username) {
  try {
    await openExternal(`https://t.me/${encodeURIComponent(username)}`);
  } catch (e) {
    toast(`Не удалось открыть Telegram: ${e}`, "error");
  }
}

// Экспортирована для вкладки «Команда» (team.js) — та же карточка
// коллеги, что уже открывается кликом по строке в openTeamSheet.
export async function openUserProfile(telegramId) {
  const overlay = openSheet(dialogSkeletonHtml(6), "wide");
  overlay.classList.add("pf-page-overlay");
  let d;
  let person = null;
  try {
    // Карточка «Работа» (загрузка, пауза, передача дел) — отдельным
    // запросом; на старом сервере без /people профиль просто без неё.
    [d, person] = await Promise.all([apiGet(`/user/${telegramId}`), fetchPerson(telegramId), loadPeopleNames()]);
  } catch (e) {
    overlay.querySelector(".sheet").innerHTML = `<div class="bento-empty">Не удалось загрузить профиль: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  d.telegram_id = telegramId;
  // Имя как на карточке команды, а не логин.
  d.display_name = personName(telegramId, d.display_name || d.name);
  if (person) d.reports = person.load;
  const st = (person && person.stats) || {};
  const avg = st.avg_days ?? d.avg_days;
  const late = st.overdue_count ?? d.overdue ?? 0;
  const kpi = (label, val, sub) => `<div class="pf-kpi"><span class="l">${label}</span><b>${val}</b><span class="s">${sub}</span></div>`;
  const manage = person && (person.can_pause || (person.can_transfer && person.load.length));

  const sheet = overlay.querySelector(".sheet");
  // Коллега — в той же «портфолио»-разметке, что и свой профиль (без приветствия, часов и кнопок своих настроек).
  sheet.innerHTML = `
    <div class="pf pf-folio pf-folio-other">
      <nav class="pff-pill" aria-label="Разделы профиля">
        <button class="pff-back" type="button" data-close title="Назад"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12H6M11 6l-6 6 6 6"/></svg></button>
        <span class="pff-pill-ic" aria-hidden="true">${avatarHtml(telegramId, d.display_name || d.name, "sm")}</span>
        ${[["pff-about", "О человеке"], ["pff-work", "Работа"], ["pff-activity", "Активность"], ["pff-awards", "Награды"]].map(([id, t]) => `<button type="button" data-pff-go="${id}">${t}</button>`).join("")}
        <span class="pff-pct" aria-hidden="true">0%</span>
      </nav>
      <section class="pff-sec" id="pff-about">${folioHeroHtml(d, false)}</section>
      <div class="pf-kpis pff-stats pff-rv">
        ${kpi("Сейчас в работе", (d.reports || []).length, late ? `<span class="warn">${late} просрочено</span>` : "всё в сроках")}
        ${kpi("Закрыто", st.completed_count ?? d.completed_total ?? 0, st.assigned_total != null ? `из ${st.assigned_total} назначенных` : "за всё время")}
        ${kpi("Просрочено", late, "за всё время")}
        ${kpi("Средний срок", avg != null ? `${avg.toFixed ? avg.toFixed(1) : avg} дн.` : "пока нет", "на один отчёт")}
      </div>
      <section class="pff-sec pff-rv" id="pff-work">
        <h2 class="pff-h">Работа</h2>
        ${prepHtml(d)}
        ${myWorkHtml(d, true)}
        <div class="pff-two">
          <section class="pf-card pf-tenure"><h3>Стаж в команде</h3>${tenureProgressHtml(d.member_since_days) || `<div class="pf-quiet">стаж появится позже</div>`}</section>
          ${manage ? `<section class="pf-card pf-manage">
            <h3>Управление</h3>
            <div class="pf-quiet">${person.paused_until ? `На паузе до ${esc(fmtDay(person.paused_until))}` : "Напоминания приходят"}</div>
            ${person.can_pause ? `<button type="button" class="btn" data-pp-pause>${person.paused_until ? "Изменить паузу" : "Поставить паузу"}</button>` : ""}
            ${person.can_transfer && person.load.length ? `<button type="button" class="btn" data-pp-transfer>Передать дела · ${person.load.length}</button>` : ""}
          </section>` : teamTeaserHtml(d)}
        </div>
        ${manage ? teamTeaserHtml(d) : ""}
      </section>
      <section class="pff-sec pff-rv" id="pff-activity">
        <h2 class="pff-h">Активность</h2>
        <section class="pf-card pff-pulse" id="pulse-card">
          <div class="pf-card-head"><h3>Пульс <span class="n">полгода по дням</span></h3><span class="pff-pulse-sum" id="pulse-sum"></span></div>
          <div id="pulse-body"><div class="pff-heat-skel"></div></div>
        </section>
        <section class="pf-card" id="activity-card">
          <div class="pf-card-head"><h3>Последние действия</h3></div>
          <div class="pf-acts" id="activity-list"><div class="pf-quiet">загружаю…</div></div>
        </section>
      </section>
      <section class="pff-sec pff-rv" id="pff-awards">
        <h2 class="pff-h">Награды</h2>
        ${myBadgesHtml(d) || `<div class="pf-quiet">Наград пока нет.</div>`}
      </section>
      ${folioFooterHtml(d, false)}
      ${devModeActive() ? devPanelHtml(d) : ""}
      ${state.isDeveloper && String(telegramId) !== String(state.telegramId) ? `<div class="sheet-actions"><button class="btn danger" data-purge-chats title="Только владелец команды">Удалить личные переписки</button></div>` : ""}
    </div>
  `;
  wireFolio(sheet);
  wireGraffiti(sheet, telegramId);
  fillPulse(sheet, `/user/${encodeURIComponent(telegramId)}`);
  fillRecentActivity(sheet, `/user/${encodeURIComponent(telegramId)}`);
  wireProfileCommon(sheet, telegramId, async () => { await openUserProfile(telegramId); overlay.remove(); });
  sheet.querySelectorAll("[data-manage-roles]").forEach(button => button.addEventListener("click", () => openProfileRoles(Number(button.dataset.manageRoles))));
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  sheet.querySelectorAll("[data-open-report]").forEach(row => {
    row.addEventListener("click", () => openReportDetail(row.dataset.openReport));
  });
  if (person) wireWorkSection(sheet, person, async () => { await openUserProfile(telegramId); overlay.remove(); });
  const purgeBtn = sheet.querySelector("[data-purge-chats]");
  if (purgeBtn) purgeBtn.addEventListener("click", async () => {
    if (!await askConfirm(`Удалить ВСЕ личные переписки ${d.name || "этого человека"}? Они сотрутся целиком, у обеих сторон. Общий чат не затронут. Вернуть нельзя.`)) return;
    purgeBtn.disabled = true;
    try {
      const r = await apiPost("/chats/purge-person", { telegram_id: telegramId });
      toast(r.chats ? `Удалено переписок: ${r.chats}, сообщений: ${r.messages}.` : "Личных переписок у человека не было.");
    } catch (e) { toast(e.message, "error"); purgeBtn.disabled = false; }
  });
  if (devModeActive()) wireDevPanel(sheet, telegramId, async () => { await openUserProfile(telegramId); overlay.remove(); }, d);
}
