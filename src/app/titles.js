// Вкладка «Тайтлы» (голосование, /api/public/*).
// Портировано из мини-аппа: loadVote/renderVoteTitles/voteBentoHtml/
// voteCardHtml/castVote/openTitleDetailPublic (miniapp/static/index.html).

import { state } from "./state.js";
import { apiGet, apiPost, openSheet, toast, dialogSkeletonHtml } from "./api.js";
import { $, esc } from "./utils.js";
import { openSeasonsAdminSheet } from "./titles-admin.js";
import { clearTitleHoverCache } from "./title-hover.js";
import { imgProxy, hdPosterAttrs, titlePageHtml, wireTitlePage } from "./title-page.js";
import { openTakeWork } from "./take-work.js";

function voteActivity(t) { return t.likes + t.dislikes; }

// Вид вкладки: карточки (постеры) или таблица с подробностями — как
// переключатель table/cards в мини-аппе. Личная настройка.
function viewKey() { return `project_titles_view_${state.telegramId || "anon"}`; }
function getView() {
  try { return localStorage.getItem(viewKey()) === "table" ? "table" : "cards"; } catch (_) { return "cards"; }
}
function setView(v) {
  try { localStorage.setItem(viewKey(), v); } catch (_) { /* не критично */ }
}

// Подробности Shikimori/AniList (формат, эпизоды, студия, жанры) есть
// только в /public/titles/{id} — в списке сезона их нет. Догружаются
// после отрисовки, не больше 4 запросов разом, и кэшируются на сессию.
const detailsCache = new Map();
async function loadDetails(ids, onEach) {
  const queue = ids.filter(id => !detailsCache.has(id));
  ids.filter(id => detailsCache.has(id)).forEach(id => onEach(id, detailsCache.get(id)));
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      let det = null;
      try {
        const d = await apiGet(`/public/titles/${id}`);
        det = d.details && !Array.isArray(d.details) ? d.details : null;
      } catch (_) { /* без подробностей строка просто останется с прочерками */ }
      detailsCache.set(id, det);
      onEach(id, det);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
}

function approvalPct(t) {
  const total = voteActivity(t);
  return total ? Math.round((t.likes / total) * 100) : null;
}

function episodesText(det) {
  if (!det) return "";
  if (det.episodes_aired != null && det.episodes_total) return `${det.episodes_aired} / ${det.episodes_total}`;
  if (det.episodes_total) return String(det.episodes_total);
  return "";
}

function cardMetaText(det) {
  if (!det) return "";
  return [det.kind_label, episodesText(det) && `${episodesText(det)} эп.`, det.studio].filter(Boolean).join(" · ");
}

const LIKE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.2 2.6L12.6 10H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"/></svg>';
const DISLIKE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 13V4h3v9zM17 13l-4 7c-1.5 0-2.5-1-2.2-2.6l.6-3.4H5a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 6.2 4H17"/></svg>';

const TABLE_SORTS = {
  rank: (a, b) => (b.likes - b.dislikes) - (a.likes - a.dislikes) || voteActivity(b) - voteActivity(a),
  name: (a, b) => a.name.localeCompare(b.name, "ru"),
  votes: (a, b) => voteActivity(b) - voteActivity(a),
  approval: (a, b) => (approvalPct(b) ?? -1) - (approvalPct(a) ?? -1),
};
let tableSort = "rank";

function detailCellsHtml(det) {
  const loading = det === undefined;
  const dash = loading ? `<span class="tt-loading"></span>` : `<span class="tt-dim">—</span>`;
  const kind = det && [det.kind_label, det.status_label].filter(Boolean);
  const genres = det && det.genres && det.genres.length ? det.genres : null;
  return `
    <td class="tt-kind">${kind && kind.length ? `${esc(kind[0])}${kind[1] ? `<span class="tt-sub">${esc(kind[1])}</span>` : ""}` : dash}</td>
    <td class="tt-num">${det && episodesText(det) ? esc(episodesText(det)) : dash}</td>
    <td class="tt-studio">${det && det.studio ? esc(det.studio) : dash}</td>
    <td class="tt-genres">${genres ? genres.slice(0, 3).map(g => `<span class="tt-genre">${esc(g)}</span>`).join("") + (genres.length > 3 ? `<span class="tt-dim">+${genres.length - 3}</span>` : "") : dash}</td>`;
}

function approvalCellHtml(t) {
  const pct = approvalPct(t);
  return `
    <div class="tt-approval">
      <div class="tt-approval-track"><i style="width:${pct ?? 0}%;"></i></div>
      <span class="tt-approval-val">${pct == null ? "нет голосов" : `${pct}% · ${voteActivity(t)}`}</span>
    </div>`;
}

function titleRowHtml(t, rank) {
  const posterSrc = imgProxy(t.poster_url);
  const det = detailsCache.has(t.id) ? detailsCache.get(t.id) : undefined;
  return `
    <tr data-title-row="${t.id}">
      <td class="tt-rank">${rank}</td>
      <td class="tt-main" data-open-title-detail="${t.id}">
        <div class="tt-title">
          ${posterSrc ? `<img class="tt-poster" src="${posterSrc}" alt="" loading="lazy">` : `<span class="tt-poster tt-poster-ph"></span>`}
          <div class="tt-names">
            <span class="tt-name">${esc(t.name)}</span>
            <span class="tt-sub tt-original">${det && det.name_original ? esc(det.name_original) : ""}</span>
          </div>
        </div>
      </td>
      ${detailCellsHtml(det)}
      <td class="tt-approval-cell">${approvalCellHtml(t)}</td>
      <td class="tt-vote">
        <div class="vote-actions tt-vote-actions">
          <button class="vote-btn${t.my_vote === 1 ? " on-like" : ""}" data-vote-title="${t.id}" data-vote-choice="1" title="Нравится">${LIKE_ICON}<span>${t.likes}</span></button>
          <button class="vote-btn${t.my_vote === -1 ? " on-dislike" : ""}" data-vote-title="${t.id}" data-vote-choice="-1" title="Не то">${DISLIKE_ICON}<span>${t.dislikes}</span></button>
        </div>
      </td>
    </tr>`;
}

function titlesTableHtml(titles) {
  const ranked = currentTitles.slice().sort(TABLE_SORTS.rank);
  const rankOf = new Map(ranked.map((t, i) => [t.id, i + 1]));
  const rows = titles.slice().sort(TABLE_SORTS[tableSort] || TABLE_SORTS.rank);
  const th = (key, label, cls = "") => key
    ? `<th class="${cls}${tableSort === key ? " sorted" : ""}" data-titles-sort="${key}">${label}</th>`
    : `<th class="${cls}">${label}</th>`;
  return `
    <div class="tt-wrap">
      <table class="tt-table">
        <thead><tr>
          ${th("rank", "#", "tt-rank")}${th("name", "Тайтл")}${th(null, "Формат")}${th(null, "Эп.", "tt-num")}
          ${th(null, "Студия")}${th(null, "Жанры")}${th("approval", "Одобрение")}${th("votes", "Голос")}
        </tr></thead>
        <tbody>${rows.map(t => titleRowHtml(t, rankOf.get(t.id))).join("")}</tbody>
      </table>
    </div>`;
}

// Лидер голосования — компактный блок над сеткой (раньше — карусель на
// полэкрана, где большую часть места занимало размытое пятно). Слева
// постер, по центру описание и кнопки, справа панель голосов: сколько
// «за» и «против», доля одобрения, ваш голос.
const HERO_ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.3v5.4l4.6-2.7z" fill="currentColor" stroke="none"/></svg>',
  flame: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5.3 1.5 1 2.5 2 3-.5-3 0-6 1-8.5Z"/></svg>',
  info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/></svg>',
};

function heroTitle(titles) {
  return titles.slice().sort(TABLE_SORTS.rank)[0] || null;
}

// «Взять в работу» — только админам; у взятого тайтла та же кнопка
// открывает его настройки (состав, дедлайн, остановить автосерии).
function takeButtonHtml(t) {
  if (!state.isAdmin) return "";
  return t.in_work
    ? `<button class="btn tl-take on" data-take-title="${t.id}" title="Состав, дедлайн, автосерии">● В работе</button>`
    : `<button class="btn tl-take" data-take-title="${t.id}">⚑ Взять в работу</button>`;
}

function heroEyebrow(t) {
  if (t.in_work) return "● В работе у студии";
  if (!voteActivity(t)) return "Ждёт первых голосов";
  return t.likes > t.dislikes ? "★ Лидер голосования" : "Пока впереди";
}

function myVoteText(t) {
  if (t.my_vote === 1) return "Ваш голос: нравится";
  if (t.my_vote === -1) return "Ваш голос: не то";
  return "Вы ещё не голосовали";
}

function heroBodyHtml(t, seasonName) {
  const det = detailsCache.get(t.id);
  const posterSrc = imgProxy(t.poster_url);
  const pct = approvalPct(t);
  const total = voteActivity(t);
  const meta = [seasonName, det && det.kind_label, det && det.studio, det && det.aired_on && det.aired_on.slice(0, 4)].filter(Boolean);
  const eps = episodesText(det);
  return `
    <div class="tl-spot-bg"${posterSrc ? ` style="background-image:url('${posterSrc}')"` : ""}></div>
    ${posterSrc ? `<img class="tl-spot-poster" ${hdPosterAttrs(t.id, t.poster_url, 150)} alt="" data-open-title-detail="${t.id}">` : `<span class="tl-spot-poster tt-poster-ph"></span>`}
    <div class="tl-spot-body">
      <span class="tl-spot-eyebrow">${heroEyebrow(t)}</span>
      <h2 class="tl-spot-name" data-open-title-detail="${t.id}">${esc(t.name)}</h2>
      ${meta.length ? `<div class="tl-spot-meta">${meta.map(esc).join("<i></i>")}</div>` : ""}
      ${det && det.description ? `<p class="tl-spot-desc">${esc(det.description)}</p>` : (det === undefined ? `<p class="tl-spot-desc"><span class="tt-loading"></span></p>` : "")}
      <div class="tl-spot-stats">
        ${eps ? `<span>${HERO_ICONS.play}${esc(eps)} эп.</span>` : ""}
        ${det && det.status_label ? `<span>${HERO_ICONS.flame}${esc(det.status_label)}</span>` : ""}
      </div>
      <div class="tl-spot-actions vote-actions">
        <button class="btn primary tl-hero-like${t.my_vote === 1 ? " on-like" : ""}" data-vote-title="${t.id}" data-vote-choice="1">${LIKE_ICON}Нравится <span>${t.likes}</span></button>
        <button class="btn tl-hero-dislike${t.my_vote === -1 ? " on-dislike" : ""}" data-vote-title="${t.id}" data-vote-choice="-1" title="Не то">${DISLIKE_ICON}<span>${t.dislikes}</span></button>
        <button class="btn tl-hero-more" data-open-title-detail="${t.id}">${HERO_ICONS.info}Подробнее</button>
        ${takeButtonHtml(t)}
      </div>
    </div>
    <div class="tl-spot-vote">
      <div class="tl-spot-big">${pct == null ? "—" : `${pct}%`}<small>${pct == null ? "нет голосов" : "одобрения"}</small></div>
      <div class="tl-spot-bar"><i style="width:${pct ?? 0}%"></i></div>
      <div class="tl-spot-split"><span class="like">👍 ${t.likes} за</span><span class="dislike">👎 ${t.dislikes} против</span></div>
      <div class="tl-spot-mine">${myVoteText(t)}${total ? ` · всего ${total}` : ""}</div>
    </div>`;
}

function voteHeroHtml(titles, seasonName) {
  const t = heroTitle(titles);
  if (!t) return "";
  return `<section class="tl-spot" data-hero data-hero-id="${t.id}">${heroBodyHtml(t, seasonName)}</section>`;
}

function wireHero(wrap, titles, seasonName) {
  const hero = wrap.querySelector("[data-hero]");
  if (!hero) return;
  const redraw = () => {
    const t = titles.find(x => x.id === Number(hero.dataset.heroId));
    if (!t) return;
    hero.innerHTML = heroBodyHtml(t, seasonName);
    wireVoteButtons(hero);
  };
  // Подробности (описание, серии) догружаются после отрисовки, голоса
  // меняются кликами — перерисовываем блок лидера из тех же объектов.
  hero._refresh = id => { if (Number(hero.dataset.heroId) === id) redraw(); };
}

// Афиша: крупный постер, поверх — место в рейтинге, метки, название,
// доля одобрения и кнопки голоса. Лидер — в цветной рамке; «Взять в
// работу» (админам) — при наведении.
function votesWord(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "голос";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "голоса";
  return "голосов";
}

function voteCardHtml(t, rank, isLeader) {
  const posterSrc = imgProxy(t.poster_url);
  const pct = approvalPct(t);
  const total = voteActivity(t);
  return `
    <div class="af-card${isLeader ? " lead" : ""}${t.in_work ? " in-work" : ""}" data-open-title-detail="${t.id}" data-af="${t.id}">
      ${posterSrc ? `<img class="af-poster" ${hdPosterAttrs(t.id, t.poster_url, 320)} alt="" loading="lazy">` : `<div class="af-poster af-poster-ph">🎬</div>`}
      <div class="af-tags">${isLeader ? `<span class="af-tag lead">★ Лидер</span>` : ""}${t.in_work ? `<span class="af-tag work">● В работе</span>` : ""}</div>
      <span class="af-rank">${rank}</span>
      <div class="af-body">
        <h3 class="af-name">${esc(t.name)}</h3>
        <div class="af-meta" data-card-meta="${t.id}">${esc(cardMetaText(detailsCache.get(t.id)))}</div>
        <div class="af-votes"><b>${pct == null ? "—" : `${pct}%`}</b><span class="af-bar"><i style="width:${pct ?? 0}%"></i></span><span>${total ? `${total} ${votesWord(total)}` : "нет голосов"}</span></div>
        <div class="vote-actions af-acts">
          <button class="vote-btn${t.my_vote === 1 ? " on-like" : ""}" data-vote-title="${t.id}" data-vote-choice="1">${LIKE_ICON}<span>${t.likes}</span></button>
          <button class="vote-btn${t.my_vote === -1 ? " on-dislike" : ""}" data-vote-title="${t.id}" data-vote-choice="-1">${DISLIKE_ICON}<span>${t.dislikes}</span></button>
        </div>
        ${takeButtonHtml(t)}
      </div>
    </div>`;
}

function leaderOf(titles) {
  const t = heroTitle(titles);
  return t && voteActivity(t) && t.likes > t.dislikes ? t.id : null;
}

async function castVote(titleId, choice, btn) {
  // Пара кнопок 👍/👎 живёт в двух разных обёртках: .vote-actions (карточка
  // сезона и герой-блок) и .td-vote-cta (шторка тайтла). Раньше тут был
  // closest(".vote-card") || closest(".vote-hero") — в шторке ни того, ни
  // другого предка нет, card был null, и клик по «Нравится» падал
  // TypeError ещё до запроса: голосовать из детальной карточки было
  // нельзя вообще, причём молча.
  const group = btn.closest(".vote-actions, .td-vote-cta");
  if (!group) return;
  const pendingHost = btn.closest(".vote-card, .af-card") || group;
  const likeBtn = group.querySelector('[data-vote-choice="1"]');
  const dislikeBtn = group.querySelector('[data-vote-choice="-1"]');
  const already = btn.classList.contains(choice === 1 ? "on-like" : "on-dislike");
  const vote = already ? 0 : choice;

  pendingHost.classList.add("vote-pending");
  try {
    const r = await apiPost(`/public/titles/${titleId}/vote`, { vote });
    likeBtn.classList.toggle("on-like", r.my_vote === 1);
    dislikeBtn.classList.toggle("on-dislike", r.my_vote === -1);
    // В шторке у кнопок текстовые подписи («👍 Нравится») без <span> со
    // счётчиком — числа там показывают отдельные .td-stat-pill.
    setCount(likeBtn.querySelector("span"), r.likes);
    setCount(dislikeBtn.querySelector("span"), r.dislikes);
    // Модель обновляем всегда, а не только из строки таблицы: баннер
    // перерисовывает слайд из этих объектов, и после «Нравится» →
    // другой тайтл → обратно там всплывал старый счётчик.
    const t = currentTitles.find(x => x.id === titleId);
    if (t) { t.likes = r.likes; t.dislikes = r.dislikes; t.my_vote = r.my_vote; }
    // Та же пара кнопок есть и в баннере, и в таблице/сетке — синхронизируем.
    document.querySelectorAll(`[data-vote-title="${titleId}"]`).forEach(b => {
      if (b === likeBtn || b === dislikeBtn) return;
      const like = b.dataset.voteChoice === "1";
      b.classList.toggle(like ? "on-like" : "on-dislike", r.my_vote === (like ? 1 : -1));
      setCount(b.querySelector("span"), like ? r.likes : r.dislikes);
    });
    const row = document.querySelector(`[data-title-row="${titleId}"]`);
    if (row && t) row.querySelector(".tt-approval-cell").innerHTML = approvalCellHtml(t);
    const hero = document.querySelector("#titles-grid [data-hero]");
    if (hero && hero._refresh) hero._refresh(titleId);
    const grid = btn.closest("#titles-grid");
    if (grid && btn.closest(".af-card")) renderTitlesBody(grid);
    const sheet = btn.closest(".sheet");
    if (sheet) {
      setCount(sheet.querySelector(".td-stat-pill.like"), `👍 ${r.likes}`);
      setCount(sheet.querySelector(".td-stat-pill.dislike"), `👎 ${r.dislikes}`);
      const bar = sheet.querySelector(".tpg-approval i");
      const total = r.likes + r.dislikes;
      if (bar) bar.style.width = `${total ? Math.round((r.likes / total) * 100) : 0}%`;
      setCount(bar && bar.closest(".tpg-card").querySelector(".tpg-score-row b"), total ? `${Math.round((r.likes / total) * 100)}%` : "—");
    }
  } catch (e) {
    toast(e.message, "error");
  } finally {
    pendingHost.classList.remove("vote-pending");
  }
}

function setCount(el, value) {
  if (el) el.textContent = value;
}

function wireVoteButtons(root) {
  root.querySelectorAll("[data-vote-title]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      castVote(parseInt(btn.dataset.voteTitle, 10), parseInt(btn.dataset.voteChoice, 10), btn);
    });
  });
  root.querySelectorAll("[data-open-title-detail]").forEach(el => {
    el.addEventListener("click", () => openTitleDetail(parseInt(el.dataset.openTitleDetail, 10)));
  });
  root.querySelectorAll("[data-take-title]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      openTakeWork(parseInt(btn.dataset.takeTitle, 10), () => loadTitlesTab());
    });
  });
}

export async function openTitleDetail(titleId) {
  const overlay = openSheet(dialogSkeletonHtml(4));
  const sheet = overlay.querySelector(".sheet");
  sheet.classList.add("tpg-sheet");
  let d;
  try {
    d = await apiGet(`/public/titles/${titleId}`);
  } catch (e) {
    sheet.classList.remove("tpg-sheet");
    sheet.innerHTML = `<div style="color:var(--s-stop);">Не удалось загрузить тайтл: ${esc(e.message)}</div><div class="sheet-actions"><button class="btn" data-close>Закрыть</button></div>`;
    sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    return;
  }
  sheet.innerHTML = titlePageHtml(d);
  sheet.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  wireVoteButtons(sheet);
  wireTitlePage(sheet, d, {
    openProfile: id => import("./profile.js").then(m => m.openUserProfile(id)),
  });
}

export async function loadTitlesTab() {
  // Вкладку открыли заново или нажали «Обновить» — подробности (счётчик
  // серий, статус) берём свежие, а не из кэша прошлого показа.
  detailsCache.clear();
  clearTitleHoverCache();
  const root = $("#titles-body");
  root.innerHTML = dialogSkeletonHtml(3);
  let d;
  try {
    d = await apiGet("/public/seasons");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить сезоны: ${esc(e.message)}</div>`;
    return false;
  }
  d.seasons = d.seasons || [];
  if (!d.seasons.length) {
    // Раньше тут не было ни одной кнопки: удалили последний сезон — и
    // создать новый из десктопа было негде («Управление» живёт в шапке
    // renderTitlesForSeason, которая без сезонов не рисуется).
    root.innerHTML = `<div class="empty-state"><div style="font-size:34px; margin-bottom:8px;">📅</div>Эфир-сезонов пока нет.
      ${state.isAdmin ? `<div style="margin-top:14px;"><button class="btn primary" id="titles-admin-btn">+ Создать сезон</button></div>` : ""}</div>`;
    root.querySelector("#titles-admin-btn")?.addEventListener("click", () => openSeasonsAdminSheet(() => loadTitlesTab()));
    return;
  }
  if (state.titleSeasonId == null || !d.seasons.some(s => s.id === state.titleSeasonId)) {
    state.titleSeasonId = d.seasons[0].id;
  }
  renderTitlesForSeason(d.seasons);
}

let currentTitles = [];
let currentSeasonName = "";

const FILTERS = {
  all: { label: "Все", test: () => true },
  work: { label: "В работе", test: t => t.in_work },
  novote: { label: "Без моего голоса", test: t => !t.my_vote },
  like: { label: "Мне нравится", test: t => t.my_vote === 1 },
  dislike: { label: "Не то", test: t => t.my_vote === -1 },
};
let titlesFilter = "all";

function toolbarHtml() {
  const chips = Object.entries(FILTERS).map(([key, f]) => {
    const n = currentTitles.filter(f.test).length;
    return `<button type="button" class="tl-filter${titlesFilter === key ? " on" : ""}" data-titles-filter="${key}">${f.label}<span>${n}</span></button>`;
  }).join("");
  const sorts = [["rank", "по рейтингу"], ["votes", "по голосам"], ["approval", "по одобрению"], ["name", "по названию"]];
  return `
    <div class="tl-toolbar">
      <div class="tl-filters">${chips}</div>
      <label class="tl-sort">Сортировка
        <select data-titles-sort-select>${sorts.map(([k, l]) => `<option value="${k}"${tableSort === k ? " selected" : ""}>${l}</option>`).join("")}</select>
      </label>
    </div>`;
}

function visibleTitles() {
  const f = FILTERS[titlesFilter] || FILTERS.all;
  return currentTitles.filter(f.test).sort(TABLE_SORTS[tableSort] || TABLE_SORTS.rank);
}

function renderTitlesBody(wrap) {
  const view = getView();
  const shown = visibleTitles();
  const empty = `<div class="tl-empty">Под этот фильтр тайтлов нет.</div>`;
  const ranked = currentTitles.slice().sort(TABLE_SORTS.rank);
  const rankOf = new Map(ranked.map((t, i) => [t.id, i + 1]));
  const leader = leaderOf(currentTitles);
  const addCard = state.isAdmin
    ? `<button type="button" class="af-add" data-af-add><b>＋</b><span>Добавить тайтл</span><em>сезоны и тайтлы — в «Управлении»</em></button>` : "";
  wrap.innerHTML = toolbarHtml() + (!shown.length ? empty : view === "table"
    ? voteHeroHtml(currentTitles, currentSeasonName) + titlesTableHtml(shown)
    : `<div class="af-grid">${shown.map(t => voteCardHtml(t, rankOf.get(t.id), t.id === leader)).join("")}${addCard}</div>`);
  wrap.querySelector("[data-af-add]")?.addEventListener("click", () => openSeasonsAdminSheet(() => loadTitlesTab()));
  wrap.querySelectorAll("[data-titles-filter]").forEach(btn => {
    btn.addEventListener("click", () => { titlesFilter = btn.dataset.titlesFilter; renderTitlesBody(wrap); });
  });
  wrap.querySelector("[data-titles-sort-select]")?.addEventListener("change", e => {
    tableSort = e.target.value;
    renderTitlesBody(wrap);
  });
  wireVoteButtons(wrap);
  wireHero(wrap, currentTitles, currentSeasonName);
  wrap.querySelectorAll("[data-titles-sort]").forEach(th => {
    th.addEventListener("click", () => {
      tableSort = th.dataset.titlesSort;
      renderTitlesBody(wrap);
    });
  });
  const seq = titlesRequestSeq;
  // Сначала подробности лидера — его описание видно сразу.
  const heroIds = [heroTitle(currentTitles)].filter(Boolean).map(t => t.id);
  loadDetails([...heroIds, ...currentTitles.map(t => t.id).filter(id => !heroIds.includes(id))], (id, det) => {
    if (seq !== titlesRequestSeq || !wrap.isConnected) return;
    const row = wrap.querySelector(`[data-title-row="${id}"]`);
    if (row) {
      row.querySelectorAll(".tt-kind, .tt-num, .tt-studio, .tt-genres").forEach(td => td.remove());
      row.querySelector(".tt-main").insertAdjacentHTML("afterend", detailCellsHtml(det));
      const orig = row.querySelector(".tt-original");
      if (orig && det && det.name_original) orig.textContent = det.name_original;
    }
    const meta = wrap.querySelector(`[data-card-meta="${id}"]`);
    if (meta) meta.textContent = cardMetaText(det);
    const hero = wrap.querySelector("[data-hero]");
    if (hero && hero._refresh) hero._refresh(id);
  });
}

// Номер последнего запрошенного сезона: ответ на предыдущий запрос
// может прийти позже, чем на текущий (кликнули «Лето» → «Осень»), и
// раньше он молча затирал уже отрисованную сетку чужими тайтлами.
let titlesRequestSeq = 0;

function renderTitlesForSeason(seasons) {
  const root = $("#titles-body");
  root.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Тайтлы</h1>
        <div class="sub">Голосование за тайтлы эфир-сезона: что студия берёт в работу.</div>
      </div>
      <div class="page-header-actions">
        <div class="seg-toggle" role="group" aria-label="Вид">
          <button type="button" class="seg-btn${getView() === "cards" ? " active" : ""}" data-titles-view="cards" aria-pressed="${getView() === "cards"}">Карточки</button>
          <button type="button" class="seg-btn${getView() === "table" ? " active" : ""}" data-titles-view="table" aria-pressed="${getView() === "table"}">Таблица</button>
        </div>
        <button class="btn" id="titles-admin-btn"${state.isAdmin ? "" : " hidden"}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/></svg>Управление</button>
      </div>
    </div>
    <div class="chip-row" style="padding:0 0 14px;">
      ${seasons.map(s => `<button class="qchip${s.id === state.titleSeasonId ? " on" : ""}" data-season="${s.id}">${esc(s.name)}</button>`).join("")}
    </div>
    <div id="titles-grid">${dialogSkeletonHtml(3)}</div>
  `;
  root.querySelectorAll("[data-season]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.titleSeasonId = parseInt(btn.dataset.season, 10);
      renderTitlesForSeason(seasons);
    });
  });
  root.querySelectorAll("[data-titles-view]").forEach(btn => {
    btn.addEventListener("click", () => {
      setView(btn.dataset.titlesView);
      root.querySelectorAll("[data-titles-view]").forEach(b => {
        const on = b === btn;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      const wrap = $("#titles-grid");
      if (wrap && currentTitles.length) renderTitlesBody(wrap);
    });
  });
  root.querySelector("#titles-admin-btn").addEventListener("click", () => {
    openSeasonsAdminSheet(() => loadTitlesTab());
  });

  const seq = ++titlesRequestSeq;
  const seasonId = state.titleSeasonId;
  apiGet(`/public/seasons/${seasonId}/titles`).then(d => {
    const wrap = $("#titles-grid");
    if (!wrap || seq !== titlesRequestSeq) return; // успели переключить сезон/вкладку, пока грузилось
    if (!d.titles.length) {
      wrap.innerHTML = `<div class="empty-state"><div style="font-size:34px; margin-bottom:8px;">🎬</div>Тайтлов в этом сезоне пока нет.</div>`;
      return;
    }
    currentTitles = d.titles;
    currentSeasonName = (seasons.find(x => x.id === seasonId) || {}).name || "";
    titlesFilter = "all";
    renderTitlesBody(wrap);
  }).catch(e => {
    const wrap = $("#titles-grid");
    if (wrap && seq === titlesRequestSeq) wrap.innerHTML = `<div class="bento-empty">Не удалось загрузить тайтлы: ${esc(e.message)}</div>`;
  });
}
