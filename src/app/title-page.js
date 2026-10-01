// Страница тайтла (по мотивам Shikimori, но не копия): баннер, крупный
// постер, колонка информации, оценка и одобрение команды, ход озвучки
// по сериям и персонажи с теми, кто из команды их озвучивает.
// Данные — /api/public/titles/{id}; картинки — /api/titles/{id}/art/*:
// сервер берёт самую крупную обложку (AniList, иначе Shikimori),
// масштабирует под ширину, которую просит экран (с учётом
// devicePixelRatio), и кэширует до удаления тайтла.

import { mediaUrl } from "./api.js";
import { esc } from "./utils.js";
import { avatarHtml, loadAvatars } from "./profile.js";

export function imgProxy(url) {
  return url ? mediaUrl("/img_proxy", { url }) : "";
}

// Ширина картинки в пикселях экрана, а не CSS: на 150% масштабе Windows
// постер в 240px должен быть 360px, иначе он мылится.
function screenWidth(cssWidth) {
  return Math.round(cssWidth * Math.min(3, window.devicePixelRatio || 1));
}

// HD-постер с запасным вариантом: если сервер не смог собрать картинку
// (204) — <img> получает error, и подставляется обычный постер Shikimori
// (см. обработчик ниже).
export function hdPosterAttrs(titleId, posterUrl, cssWidth) {
  const hd = mediaUrl(`/titles/${titleId}/art/poster`, { w: screenWidth(cssWidth) });
  const fallback = imgProxy(posterUrl);
  if (!hd) return fallback ? `src="${fallback}"` : "";
  return `src="${hd}"${fallback ? ` data-fallback="${fallback}"` : ""}`;
}

document.addEventListener("error", e => {
  const img = e.target;
  if (!img || img.tagName !== "IMG" || !img.dataset.fallback) return;
  const fallback = img.dataset.fallback;
  delete img.dataset.fallback;
  img.src = fallback;
}, true);

const ROLE_LABELS = { main: "Главная роль", supporting: "Второстепенная", background: "Эпизод" };

function infoRows(det) {
  if (!det) return [];
  const rows = [];
  const add = (label, value) => { if (value) rows.push([label, value]); };
  add("Тип", det.kind_label);
  if (det.episodes_total || det.episodes_aired) {
    add("Эпизоды", det.episodes_aired != null && det.episodes_total
      ? `${det.episodes_aired} из ${det.episodes_total}` : String(det.episodes_total || det.episodes_aired));
  }
  add("Длительность", det.duration_min && `${det.duration_min} мин.`);
  add("Статус", det.status_label);
  if (det.next_episode_at) {
    const at = new Date(det.next_episode_at);
    if (!Number.isNaN(at.getTime())) {
      add("Следующая серия", `${det.next_episode ? `${det.next_episode}-я · ` : ""}${at.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}`);
    }
  }
  if (det.aired_on) {
    const d = new Date(det.aired_on);
    add("Выход", Number.isNaN(d.getTime()) ? det.aired_on : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }));
  }
  add("Рейтинг", det.rating_label);
  add("Первоисточник", det.source_label);
  add("Студия", det.studio);
  add("Режиссёр", det.director);
  add("Автор оригинала", det.author);
  return rows;
}

function scoreHtml(score) {
  if (score == null) return "";
  const stars = Math.round(score) / 2; // 0–5 с шагом 0.5
  const star = i => {
    const fill = Math.max(0, Math.min(1, stars - i));
    return `<i class="tp-star" style="--fill:${fill * 100}%"></i>`;
  };
  const verdict = score >= 9 ? "Шедевр" : score >= 8 ? "Отлично" : score >= 7 ? "Хорошо" : score >= 6 ? "Нормально" : "Так себе";
  return `
    <div class="tp-card tp-score">
      <div class="tp-card-label">Оценка зрителей</div>
      <div class="tp-score-row"><b>${score.toFixed(1)}</b><span class="tp-stars">${[0, 1, 2, 3, 4].map(star).join("")}</span></div>
      <div class="tp-card-sub">${verdict} · Shikimori/AniList</div>
    </div>`;
}

function approvalHtml(d) {
  const total = d.likes + d.dislikes;
  const pct = total ? Math.round((d.likes / total) * 100) : null;
  return `
    <div class="tp-card">
      <div class="tp-card-label">Одобрение команды</div>
      <div class="tp-score-row"><b>${pct == null ? "—" : `${pct}%`}</b><span class="tp-card-sub">${total ? `${total} голос${total % 10 === 1 && total % 100 !== 11 ? "" : (total % 10 >= 2 && total % 10 <= 4 && (total % 100 < 12 || total % 100 > 14) ? "а" : "ов")}` : "ещё никто не голосовал"}</span></div>
      <div class="tp-approval"><i style="width:${pct ?? 0}%"></i></div>
      <div class="tp-votes">
        <span class="td-stat-pill like">👍 ${d.likes}</span>
        <span class="td-stat-pill dislike">👎 ${d.dislikes}</span>
      </div>
    </div>`;
}

function progressHtml(d) {
  const eps = d.episodes || [];
  const crew = d.crew || [];
  const done = eps.filter(e => e.pct === 100).length;
  return `
    <section class="tp-section">
      <div class="tp-section-head"><h3>Ход озвучки</h3>${eps.length ? `<span>${done} из ${eps.length} серий готово</span>` : ""}</div>
      ${eps.length ? `<div class="tp-eps">${eps.map(e => `
        <div class="tp-ep${e.pct === 100 ? " done" : ""}" title="${esc(e.label)}: готово ${e.completed} из ${e.total}">
          <span class="tp-ep-label">${esc(e.label)}</span>
          <span class="tp-ep-bar"><i style="width:${e.pct}%"></i></span>
          <span class="tp-ep-val">${e.completed}/${e.total}</span>
        </div>`).join("")}</div>` : `<div class="tp-empty">Серии ещё не заведены.</div>`}
      ${crew.length ? `<div class="tp-crew">${crew.map(c => `
        <span class="tp-crew-chip"${c.telegram_id ? ` data-open-profile="${c.telegram_id}"` : ""}>
          ${avatarHtml(c.telegram_id, c.name, "sm")}<span><b>${esc(c.name || "не назначен")}</b><small>${esc(c.role || "")}</small></span>
        </span>`).join("")}</div>` : ""}
    </section>`;
}

function charactersHtml(chars) {
  if (!chars || !chars.length) return "";
  const order = { main: 0, supporting: 1, background: 2 };
  const list = chars.slice().sort((a, b) => (order[a.role] ?? 3) - (order[b.role] ?? 3));
  const voiced = list.filter(c => c.voiced_by).length;
  return `
    <section class="tp-section">
      <div class="tp-section-head"><h3>Персонажи и голоса</h3><span>озвучено ${voiced} из ${list.length}</span></div>
      <div class="tp-chars">${list.map(c => {
        const img = imgProxy(c.image_url);
        return `
        <div class="tp-char${c.voiced_by ? " voiced" : ""}">
          ${img ? `<img class="tp-char-img" src="${img}" alt="" loading="lazy">` : `<span class="tp-char-img ph"></span>`}
          <div class="tp-char-body">
            <b class="tp-char-name">${esc(c.name)}</b>
            <span class="tp-char-role">${esc(ROLE_LABELS[c.role] || "")}${c.original_va_name ? `${ROLE_LABELS[c.role] ? " · " : ""}яп. ${esc(c.original_va_name)}` : ""}</span>
            ${c.voiced_by
              ? `<span class="tp-char-voice" data-open-profile="${c.voiced_by.telegram_id}">${avatarHtml(c.voiced_by.telegram_id, c.voiced_by.name, "sm")}${esc(c.voiced_by.name)}</span>`
              : `<span class="tp-char-voice none">голос не назначен</span>`}
          </div>
        </div>`;
      }).join("")}</div>
    </section>`;
}

export function titlePageHtml(d) {
  const det = d.details && !Array.isArray(d.details) ? d.details : null;
  const year = det && det.aired_on ? det.aired_on.slice(0, 4) : "";
  const eyebrow = [d.season_name, det && det.kind_label, year].filter(Boolean);
  const rows = infoRows(det);
  return `
    <div class="tp">
      <div class="tp-banner${d.has_banner ? "" : " from-poster"}" data-tp-banner></div>
      <button class="tp-close" data-close aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      <div class="tp-top">
        <aside class="tp-left">
          <img class="tp-poster" ${hdPosterAttrs(d.id, d.poster_url, 230)} alt="">
          <div class="td-vote-cta tp-vote">
            <button class="${d.my_vote === 1 ? "on-like" : ""}" data-vote-title="${d.id}" data-vote-choice="1">👍 Нравится</button>
            <button class="${d.my_vote === -1 ? "on-dislike" : ""}" data-vote-title="${d.id}" data-vote-choice="-1">👎 Не то</button>
          </div>
        </aside>
        <div class="tp-main">
          ${eyebrow.length ? `<div class="tp-eyebrow">${eyebrow.map(esc).join("<i></i>")}</div>` : ""}
          <h1 class="tp-name">${esc(d.name)}</h1>
          ${det && det.name_original ? `<div class="tp-orig">${esc(det.name_original)}</div>` : ""}
          <div class="tp-cols">
            ${rows.length ? `<dl class="tp-info">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : `<div class="tp-empty">Подробностей с Shikimori/AniList нет — тайтл не привязан или сайт недоступен.</div>`}
            <div class="tp-side">
              ${scoreHtml(det && det.score)}
              ${approvalHtml(d)}
            </div>
          </div>
          ${det && det.genres && det.genres.length ? `<div class="tp-genres">${det.genres.map(g => `<span>${esc(g)}</span>`).join("")}</div>` : ""}
        </div>
      </div>
      ${det && det.description ? `
      <section class="tp-section">
        <div class="tp-section-head"><h3>Описание</h3></div>
        <p class="tp-desc clamped" data-tp-desc>${esc(det.description)}</p>
        <button class="tp-more" data-tp-more hidden>Показать полностью</button>
      </section>` : ""}
      ${progressHtml(d)}
      ${charactersHtml(d.characters)}
    </div>`;
}

// После вставки в DOM: баннер, «показать полностью», аватарки, профили.
export function wireTitlePage(root, d, { openProfile } = {}) {
  const banner = root.querySelector("[data-tp-banner]");
  if (banner) {
    const setBg = src => { banner.style.backgroundImage = `url("${src}")`; banner.classList.add("ready"); };
    const fallback = imgProxy(d.poster_url);
    const src = d.has_banner ? mediaUrl(`/titles/${d.id}/art/banner`, { w: screenWidth(root.clientWidth || 1080) }) : "";
    if (src) {
      const img = new Image();
      img.onload = () => setBg(src);
      img.onerror = () => { banner.classList.add("from-poster"); if (fallback) setBg(fallback); };
      img.src = src;
    } else if (fallback) {
      setBg(fallback);
    }
  }
  const desc = root.querySelector("[data-tp-desc]");
  const more = root.querySelector("[data-tp-more]");
  if (desc && more) {
    // С line-clamp scrollHeight в Chromium равен видимой высоте — поэтому
    // сравниваем высоту с обрезкой и без неё.
    requestAnimationFrame(() => {
      const clamped = desc.clientHeight;
      desc.classList.remove("clamped");
      if (desc.clientHeight > clamped + 4) {
        desc.classList.add("clamped");
        more.hidden = false;
      }
    });
    more.addEventListener("click", () => {
      const open = desc.classList.toggle("clamped");
      more.textContent = open ? "Показать полностью" : "Свернуть";
    });
  }
  loadAvatars(root);
  if (openProfile) {
    root.querySelectorAll("[data-open-profile]").forEach(el => el.addEventListener("click", () => openProfile(Number(el.dataset.openProfile))));
  }
}
