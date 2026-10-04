// Вкладка «Моя очередь» — личный экран участника: незакрытые серии,
// назначенные на меня, по срочности (/api/me/queue). Открыта всем, не
// только админам: «что мне записать и к какому сроку» нужно каждому.

import { state } from "./state.js";
import { apiGet } from "./api.js";
import { $, esc } from "./utils.js";
import { imgProxy } from "./title-page.js";
import { openReportDetail } from "./report-detail.js";
import { switchTab } from "./tabs.js";
import { setBackdrop } from "./backdrop.js";

const DAY_MS = 86400000;

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function daysLeft(deadline, today) {
  if (!deadline) return null;
  return Math.round((Date.parse(deadline.slice(0, 10)) - Date.parse(today)) / DAY_MS);
}

function dueText(left) {
  if (left === null) return "без срока";
  if (left < 0) return `просрочено на ${-left} ${plural(-left, "день", "дня", "дней")}`;
  if (left === 0) return "сегодня";
  if (left === 1) return "завтра";
  return `через ${left} ${plural(left, "день", "дня", "дней")}`;
}

// Полоска «сколько осталось»: полная — срок прямо сейчас, пустая — неделя и больше.
function urgencyPct(left) {
  if (left === null) return 0;
  if (left <= 0) return 100;
  return Math.max(6, Math.round((1 - Math.min(left, 7) / 7) * 100));
}

const COLUMNS = [
  { key: "hot", label: "Горит", hint: "просрочено, сегодня и завтра", test: l => l !== null && l <= 1 },
  { key: "week", label: "На неделе", hint: "2–7 дней", test: l => l !== null && l > 1 && l <= 7 },
  { key: "later", label: "Позже", hint: "дальше недели и без срока", test: l => l === null || l > 7 },
];

function cardHtml(it, today) {
  const left = daysLeft(it.deadline, today);
  const src = it.poster_url ? imgProxy(it.poster_url) : null;
  const hot = left !== null && left <= 0;
  const head = it.title_name || it.title;
  const sub = it.title_name ? [it.episode, it.role && `роль ${it.role}`].filter(Boolean).join(" · ") : "";
  return `
    <div class="bcell q-card${hot ? " hot" : ""}${state.isAdmin ? " q-open" : ""}" data-q-open="${esc(it.public_id)}">
      <div class="q-head">
        ${src ? `<img class="q-poster" src="${src}" alt="" loading="lazy">` : `<span class="q-poster q-poster-ph"></span>`}
        <div class="q-names">
          <b>${esc(head)}</b>
          ${sub ? `<span>${esc(sub)}</span>` : ""}
          <span class="q-id">${esc(it.public_id)} · ${esc(it.status_label)}</span>
        </div>
      </div>
      <div class="q-due"><span>${it.deadline ? `Срок ${it.deadline.slice(8, 10)}.${it.deadline.slice(5, 7)}` : "Срок не назначен"}</span><b>${dueText(left)}</b></div>
      <div class="q-bar"><i style="width:${urgencyPct(left)}%"></i></div>
    </div>`;
}

export async function loadQueue() {
  const root = $("#queue-body");
  if (!root) return;
  root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  let d;
  try {
    d = await apiGet("/me/queue");
  } catch (e) {
    root.innerHTML = `<div class="bento-empty">Не удалось загрузить очередь: ${esc(e.message)}</div>`;
    return false;
  }
  const today = d.today;
  const items = d.items || [];
  // Фон окна — обложка первой (самой срочной) серии на руках.
  const lead = items.find(it => it.poster_url);
  if (lead) setBackdrop(imgProxy(lead.poster_url));
  const lefts = items.map(it => daysLeft(it.deadline, today)).filter(l => l !== null);
  const nearest = lefts.length ? Math.min(...lefts) : null;
  const overdue = lefts.filter(l => l < 0).length;

  const head = `
    <div class="page-header">
      <div>
        <h1>Моя очередь</h1>
        <div class="sub">Серии, назначенные на вас, — по срочности.${state.isAdmin ? " Клик по карточке открывает отчёт." : " Сдать работу — в боте: «📋 Мои задачи»."}</div>
      </div>
    </div>
    <div class="bcell q-stats">
      <div><b>${items.length}</b><span>${plural(items.length, "серия", "серии", "серий")} на руках</span></div><i></i>
      <div><b class="${nearest !== null && nearest <= 0 ? "danger" : ""}">${nearest === null ? "—" : dueText(nearest)}</b><span>ближайший срок</span></div><i></i>
      <div><b class="${overdue ? "danger" : ""}">${overdue}</b><span>просрочено</span></div><i></i>
      <div><b>${d.completed_week}</b><span>закрыто за неделю</span></div>
    </div>`;

  if (!items.length) {
    root.innerHTML = head + `
      <div class="q-empty">
        <div class="q-empty-ic">☕</div>
        <b>На руках пусто</b>
        <p>Когда вам назначат серию, она появится здесь с обратным отсчётом до срока.</p>
        <button class="btn" data-q-titles>Проголосовать за тайтлы</button>
      </div>`;
    root.querySelector("[data-q-titles]").addEventListener("click", () => switchTab("titles"));
    return;
  }

  const cols = COLUMNS.map(col => {
    const list = items.filter(it => col.test(daysLeft(it.deadline, today)));
    return `
      <div class="q-col">
        <div class="q-col-head"><b>${col.label}</b><span>${list.length}</span><em>${col.hint}</em></div>
        ${list.map(it => cardHtml(it, today)).join("") || `<div class="q-col-empty">пусто</div>`}
      </div>`;
  }).join("");
  root.innerHTML = head + `<div class="q-cols">${cols}</div>`;
  refreshQueueBadge();
  if (state.isAdmin) {
    root.querySelectorAll("[data-q-open]").forEach(el => el.addEventListener("click", () => openReportDetail(el.dataset.qOpen)));
  }
}

// Счётчик на пункте меню — сколько серий горит (просрочено, сегодня, завтра).
export async function refreshQueueBadge() {
  const el = $("#queue-badge");
  if (!el) return;
  try {
    const d = await apiGet("/me/queue");
    const hot = (d.items || []).filter(it => { const l = daysLeft(it.deadline, d.today); return l !== null && l <= 1; }).length;
    el.textContent = String(hot);
    el.hidden = !hot;
  } catch (_) { el.hidden = true; }
}
