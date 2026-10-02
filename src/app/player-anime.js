// Плеер серий (режим «Смотреть»). Сервер находит тайтл по id Shikimori
// (/api/player/series), отдаёт переводы серии (/api/player/episode/{id})
// и прямые ссылки на видео (/api/player/stream/{id}); видео грузится
// напрямую с CDN источника, не через наш сервер.
//
// Своё управление поверх видео вместо стандартной полосы браузера:
// перемотка с буфером и подсказкой времени, громкость, скорость,
// качество, «пропустить опенинг», карточка следующей серии, панель
// серий/озвучек, весь экран вместе с управлением. Прячется, когда мышь
// не двигается. Запоминаются серия, озвучка, качество, громкость и место.

import { state } from "./state.js";
import { apiGet, toast } from "./api.js";
import { esc } from "./utils.js";

const SAVE_EVERY_MS = 5000;
const HIDE_AFTER_MS = 2600;
const OP_SKIP = 85;            // длина типичного опенинга
const OP_WINDOW = [5, 240];    // когда предлагать его пропустить
const NEXT_CARD_SEC = 25;      // за сколько до конца показать «Следующая серия»
const NEXT_COUNTDOWN = 10;
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

const I = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  back10: '<svg viewBox="0 0 24 24"><path d="M12 5a7 7 0 1 1-7 7"/><path d="M12 2 8.5 5 12 8"/><text x="12" y="15.2" text-anchor="middle" font-size="6.5" font-weight="800" fill="currentColor" stroke="none">10</text></svg>',
  fwd10: '<svg viewBox="0 0 24 24"><path d="M12 5a7 7 0 1 0 7 7"/><path d="M12 2l3.5 3L12 8"/><text x="12" y="15.2" text-anchor="middle" font-size="6.5" font-weight="800" fill="currentColor" stroke="none">10</text></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 5.5v13l9-6.5z" fill="currentColor"/><path d="M17 5v14" stroke-width="2.4"/></svg>',
  vol: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>',
  mute: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" stroke="none"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  unfull: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.6A7 7 0 0 0 5 12l.1 1.2-2 1.6 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M5 6l7 6-7 6zM12 6l7 6-7 6z" fill="currentColor" stroke="none"/></svg>',
};

export function memKey(shikiId) { return `project_player_${state.telegramId || "anon"}_${shikiId}`; }
function readMem(shikiId) {
  try { return JSON.parse(localStorage.getItem(memKey(shikiId)) || "{}"); } catch (_) { return {}; }
}
function writeMem(shikiId, patch) {
  const m = { ...readMem(shikiId), ...patch };
  try { localStorage.setItem(memKey(shikiId), JSON.stringify(m)); } catch (_) { /* не критично */ }
  return m;
}
const VOL_KEY = "project_player_volume";
function readVolume() {
  try { const v = JSON.parse(localStorage.getItem(VOL_KEY) || "null"); return v && typeof v.v === "number" ? v : { v: 1, muted: false }; } catch (_) { return { v: 1, muted: false }; }
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h ? `${h}:` : ""}${h ? String(m).padStart(2, "0") : m}:${String(s).padStart(2, "0")}`;
}
const qLabel = h => (h >= 2160 ? "4K" : `${h}p`);

let P = null; // состояние открытого плеера

export async function openAnimePlayer({ shikiId, name }) {
  closeAnimePlayer();
  const root = document.createElement("section");
  root.className = "ap-root";
  root.innerHTML = `
    <div class="ap-stage" data-ap-stage>
      <video class="ap-video" playsinline preload="auto"></video>
      <div class="ap-wait" data-ap-wait><span></span><b data-ap-wait-text>Загружаю…</b></div>
      <div class="ap-buffer"><span></span></div>
      <div class="ap-flash" data-ap-flash></div>
      <div class="ap-shade top"></div><div class="ap-shade bottom"></div>
      <header class="ap-top">
        <button type="button" class="ap-icon ap-back" data-ap-close title="Назад (Esc)">${I.close}</button>
        <div class="ap-title"><b>${esc(name || "")}</b><span data-ap-ep></span></div>
        <span class="ap-sp"></span>
        <button type="button" class="ap-pill" data-ap-panel>${I.list}Серии и озвучка</button>
      </header>
      <button type="button" class="ap-center" data-ap-center aria-label="Пауза/воспроизведение">${I.play}</button>
      <button type="button" class="ap-skip" data-ap-skip hidden>${I.skip}Пропустить опенинг</button>
      <div class="ap-nextcard" data-ap-nextcard hidden>
        <div><small>Следующая серия</small><b data-ap-next-label></b></div>
        <button type="button" class="ap-nextgo" data-ap-nextgo><i data-ap-next-ring></i>${I.play}<span data-ap-next-sec></span></button>
        <button type="button" class="ap-nextno" data-ap-nextno title="Не переключать">✕</button>
      </div>
      <div class="ap-controls">
        <div class="ap-seek" data-ap-seek>
          <div class="ap-seek-track"><i class="ap-buf" data-ap-buf></i><i class="ap-hov" data-ap-hov></i><i class="ap-fill" data-ap-fill></i><i class="ap-op" data-ap-op></i></div>
          <span class="ap-thumb" data-ap-thumb></span>
          <span class="ap-tip" data-ap-tip>0:00</span>
        </div>
        <div class="ap-row">
          <button type="button" class="ap-icon big" data-ap-play title="Пауза (пробел)">${I.play}</button>
          <button type="button" class="ap-icon" data-ap-back10 title="Назад 10 с (←)">${I.back10}</button>
          <button type="button" class="ap-icon" data-ap-fwd10 title="Вперёд 10 с (→)">${I.fwd10}</button>
          <button type="button" class="ap-icon" data-ap-next title="Следующая серия (N)">${I.next}</button>
          <div class="ap-vol">
            <button type="button" class="ap-icon" data-ap-mute title="Звук (M)">${I.vol}</button>
            <input type="range" min="0" max="1" step="0.01" data-ap-volume aria-label="Громкость">
          </div>
          <span class="ap-time"><b data-ap-cur>0:00</b> / <span data-ap-dur>0:00</span></span>
          <span class="ap-sp"></span>
          <div class="ap-menu-wrap">
            <button type="button" class="ap-pill ghost" data-ap-settings>${I.gear}<span data-ap-qlabel>—</span></button>
            <div class="ap-menu" data-ap-menu hidden></div>
          </div>
          <button type="button" class="ap-icon" data-ap-full title="Во весь экран (F)">${I.full}</button>
        </div>
      </div>
    </div>
    <aside class="ap-panel" data-ap-side>
      <div class="ap-panel-in">
        <div class="ap-panel-head"><b>Серии</b><span data-ap-count></span></div>
        <div class="ap-eps" data-ap-eps></div>
        <div class="ap-panel-head"><b>Озвучка</b></div>
        <div class="ap-trs" data-ap-trs><div class="ap-muted">—</div></div>
      </div>
    </aside>`;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("on"));

  const video = root.querySelector("video");
  const vol = readVolume();
  video.volume = vol.v;
  video.muted = vol.muted;
  P = { root, video, shikiId, name, series: null, episodeIdx: 0, translations: [], trId: null, sources: [], quality: null, saveTimer: null, hideTimer: null, nextCancelled: false, nextTimer: null };
  wireControls();
  setWait("Ищу серии…");

  let series;
  try {
    series = await apiGet(`/player/series?shiki_id=${encodeURIComponent(shikiId)}`);
  } catch (e) {
    return fail(`Не удалось открыть: ${e.message}`);
  }
  if (!P || P.root !== root) return;
  if (!series.series_id || !series.episodes.length) return fail("Для этого тайтла пока нет серий.");
  P.series = series;
  const mem = readMem(shikiId);
  renderEpisodes();
  goEpisode(Math.max(0, series.episodes.findIndex(e => e.id === mem.episodeId)));
}

// ---------- вспомогательное ----------
const $r = sel => P.root.querySelector(sel);
function setWait(text) {
  const w = $r("[data-ap-wait]");
  w.hidden = !text;
  w.classList.remove("err");
  // Пока идёт загрузка, свой индикатор буфера и кнопка паузы не нужны —
  // иначе поверх друг друга крутятся два «загружаю».
  P.root.classList.toggle("loading", !!text);
  if (text) $r("[data-ap-wait-text]").textContent = text;
}
function fail(text) {
  if (!P) return;
  setWait(text);
  $r("[data-ap-wait]").classList.add("err");
  P.root.classList.add("show-ui");
}
function flash(html) {
  const f = $r("[data-ap-flash]");
  f.innerHTML = html;
  f.classList.remove("go");
  void f.offsetWidth;
  f.classList.add("go");
}
function poke() {
  if (!P) return;
  P.root.classList.add("show-ui");
  window.clearTimeout(P.hideTimer);
  P.hideTimer = window.setTimeout(() => {
    if (!P || P.video.paused || P.root.querySelector(".ap-seek.drag, .ap-panel:hover") || !$r("[data-ap-menu]").hidden) return;
    P.root.classList.remove("show-ui");
  }, HIDE_AFTER_MS);
}

// ---------- серии и озвучки ----------
function renderEpisodes() {
  const mem = readMem(P.shikiId);
  const watched = new Set(mem.watched || []);
  $r("[data-ap-count]").textContent = `${P.series.episodes.length}`;
  const box = $r("[data-ap-eps]");
  box.innerHTML = P.series.episodes.map((e, i) => `
    <button type="button" class="ap-ep${i === P.episodeIdx ? " on" : ""}${watched.has(e.id) ? " seen" : ""}" data-ap-ep-i="${i}" title="${esc(e.label)}">${esc(e.number != null ? String(e.number) : e.label)}</button>`).join("");
  box.querySelectorAll("[data-ap-ep-i]").forEach(b => b.addEventListener("click", () => goEpisode(Number(b.dataset.apEpI))));
}

async function goEpisode(idx) {
  if (!P || !P.series) return;
  const eps = P.series.episodes;
  if (idx < 0 || idx >= eps.length) return;
  saveProgress();
  hideNextCard();
  P.episodeIdx = idx;
  P.nextCancelled = false;
  const ep = eps[idx];
  writeMem(P.shikiId, { episodeId: ep.id });
  renderEpisodes();
  $r("[data-ap-ep]").textContent = ep.label;
  $r("[data-ap-next]").disabled = idx === eps.length - 1;
  P.video.pause();
  P.video.removeAttribute("src");
  P.video.load();
  setWait("Ищу озвучки…");
  let d;
  try {
    d = await apiGet(`/player/episode/${ep.id}`);
  } catch (e) {
    return fail(`Не удалось получить озвучки: ${e.message}`);
  }
  if (!P || P.series.episodes[P.episodeIdx].id !== ep.id) return;
  P.translations = d.translations.filter(t => t.kind === "voice" || t.kind === "raw");
  renderTranslations();
  if (!P.translations.length) return fail("У этой серии пока нет озвучки.");
  const mem = readMem(P.shikiId);
  const same = mem.authors && P.translations.find(t => t.authors === mem.authors);
  pickTranslation((same || P.translations[0]).id);
}

function renderTranslations() {
  const box = $r("[data-ap-trs]");
  if (!P.translations.length) { box.innerHTML = `<div class="ap-muted">нет</div>`; return; }
  let lastGroup = "";
  box.innerHTML = P.translations.map(t => {
    const head = t.group !== lastGroup ? `<div class="ap-group">${esc(t.group)}</div>` : "";
    lastGroup = t.group;
    return `${head}<button type="button" class="ap-tr${t.id === P.trId ? " on" : ""}" data-ap-tr="${t.id}"><span>${esc(t.authors)}</span>${t.height ? `<small>${qLabel(t.height)}</small>` : ""}</button>`;
  }).join("");
  box.querySelectorAll("[data-ap-tr]").forEach(b => b.addEventListener("click", () => pickTranslation(Number(b.dataset.apTr), true)));
}

async function pickTranslation(trId, keepTime = false) {
  if (!P) return;
  const resumeAt = keepTime && P.video.currentTime ? P.video.currentTime : null;
  P.trId = trId;
  renderTranslations();
  const tr = P.translations.find(t => t.id === trId);
  if (tr) writeMem(P.shikiId, { authors: tr.authors });
  setWait("Загружаю видео…");
  let d;
  try {
    d = await apiGet(`/player/stream/${trId}`);
  } catch (e) {
    return fail(`Видео не получено: ${e.message}`);
  }
  if (!P || P.trId !== trId) return;
  P.sources = d.sources;
  const mem = readMem(P.shikiId);
  const q = d.sources.find(s => s.height === mem.quality) || d.sources.find(s => s.height === 1080) || d.sources[0];
  playSource(q, resumeAt);
}

function playSource(src, resumeAt) {
  P.quality = src.height;
  $r("[data-ap-qlabel]").textContent = qLabel(src.height);
  const v = P.video;
  const ep = P.series.episodes[P.episodeIdx];
  const mem = readMem(P.shikiId);
  const saved = resumeAt != null ? resumeAt : (mem.times || {})[ep.id];
  const speed = v.playbackRate || 1;
  setWait("Загружаю видео…");
  v.addEventListener("loadedmetadata", () => {
    v.playbackRate = speed;
    if (saved && saved > 5 && saved < v.duration - 20) {
      v.currentTime = saved;
      if (resumeAt == null) toast(`Продолжаю с ${fmtTime(saved)}.`);
    }
    const op = $r("[data-ap-op]");
    op.style.left = `${(OP_WINDOW[0] / v.duration) * 100}%`;
    op.style.width = `${(OP_SKIP / v.duration) * 100}%`;
  }, { once: true });
  v.src = src.url;
  v.play().catch(() => { /* автозапуск запрещён — ждём клика */ });
  window.clearInterval(P.saveTimer);
  P.saveTimer = window.setInterval(saveProgress, SAVE_EVERY_MS);
  poke();
}

// ---------- следующая серия ----------
function showNextCard() {
  if (!P || P.nextCancelled || P.episodeIdx >= P.series.episodes.length - 1) return;
  const card = $r("[data-ap-nextcard]");
  if (!card.hidden) return;
  card.hidden = false;
  $r("[data-ap-next-label]").textContent = P.series.episodes[P.episodeIdx + 1].label;
}
function hideNextCard() {
  if (!P) return;
  $r("[data-ap-nextcard]").hidden = true;
  window.clearInterval(P.nextTimer);
  P.nextTimer = null;
}
function startCountdown() {
  if (!P || P.nextCancelled || P.episodeIdx >= P.series.episodes.length - 1) return;
  showNextCard();
  let left = NEXT_COUNTDOWN;
  const sec = $r("[data-ap-next-sec]");
  const ring = $r("[data-ap-next-ring]");
  sec.textContent = left;
  ring.style.animation = "none"; void ring.offsetWidth; ring.style.animation = `ap-ring ${NEXT_COUNTDOWN}s linear forwards`;
  window.clearInterval(P.nextTimer);
  P.nextTimer = window.setInterval(() => {
    left -= 1;
    sec.textContent = Math.max(0, left);
    if (left <= 0) { hideNextCard(); goEpisode(P.episodeIdx + 1); }
  }, 1000);
}

// ---------- прогресс ----------
function markWatched(epId) {
  const mem = readMem(P.shikiId);
  const w = new Set(mem.watched || []);
  if (w.has(epId)) return;
  w.add(epId);
  writeMem(P.shikiId, { watched: [...w] });
  renderEpisodes();
}
function saveProgress() {
  if (!P || !P.series) return;
  const v = P.video;
  if (!v.duration || !v.currentTime) return;
  const ep = P.series.episodes[P.episodeIdx];
  const mem = readMem(P.shikiId);
  const times = { ...(mem.times || {}) };
  times[ep.id] = v.currentTime > v.duration - 20 ? 0 : Math.floor(v.currentTime);
  // Для ряда «Продолжить просмотр» в режиме «Смотреть».
  const last = { episodeId: ep.id, label: ep.label, time: Math.floor(v.currentTime), duration: Math.floor(v.duration), at: Date.now() };
  writeMem(P.shikiId, { times, last, title: P.name });
}

// ---------- управление ----------
function togglePlay() {
  const v = P.video;
  if (!v.src) return;
  if (v.paused) { v.play(); flash(I.play); } else { v.pause(); flash(I.pause); }
}
function seekBy(d) {
  const v = P.video;
  if (!v.duration) return;
  v.currentTime = Math.max(0, Math.min(v.duration - 0.5, v.currentTime + d));
  flash(`<span class="ap-flash-txt">${d > 0 ? "+" : "−"}${Math.abs(d)} с</span>`);
  poke();
}
function setVolume(value, muted) {
  const v = P.video;
  v.volume = Math.max(0, Math.min(1, value));
  v.muted = muted;
  try { localStorage.setItem(VOL_KEY, JSON.stringify({ v: v.volume, muted: v.muted })); } catch (_) { /* не критично */ }
}
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else P.root.requestFullscreen?.().catch(() => {});
}
function renderMenu() {
  const menu = $r("[data-ap-menu]");
  const v = P.video;
  menu.innerHTML = `
    <div class="ap-menu-h">Качество</div>
    ${P.sources.map(s => `<button type="button" class="${s.height === P.quality ? "on" : ""}" data-ap-q="${s.height}">${qLabel(s.height)}${s.height >= 1080 ? " <i>HD</i>" : ""}</button>`).join("")}
    <div class="ap-menu-h">Скорость</div>
    <div class="ap-speeds">${SPEEDS.map(s => `<button type="button" class="${Math.abs(v.playbackRate - s) < 0.01 ? "on" : ""}" data-ap-speed="${s}">${s}×</button>`).join("")}</div>`;
  menu.querySelectorAll("[data-ap-q]").forEach(b => b.addEventListener("click", () => {
    const s = P.sources.find(x => x.height === Number(b.dataset.apQ));
    menu.hidden = true;
    if (s && s.height !== P.quality) { writeMem(P.shikiId, { quality: s.height }); playSource(s, v.currentTime || null); }
  }));
  menu.querySelectorAll("[data-ap-speed]").forEach(b => b.addEventListener("click", () => {
    v.playbackRate = Number(b.dataset.apSpeed);
    renderMenu();
    flash(`<span class="ap-flash-txt">${v.playbackRate}×</span>`);
  }));
}

function wireControls() {
  const { root, video: v } = P;
  root.querySelector("[data-ap-close]").addEventListener("click", closeAnimePlayer);
  root.querySelector("[data-ap-panel]").addEventListener("click", () => root.classList.toggle("panel-open"));
  root.querySelector("[data-ap-center]").addEventListener("click", togglePlay);
  root.querySelector("[data-ap-play]").addEventListener("click", togglePlay);
  root.querySelector("[data-ap-back10]").addEventListener("click", () => seekBy(-10));
  root.querySelector("[data-ap-fwd10]").addEventListener("click", () => seekBy(10));
  root.querySelector("[data-ap-next]").addEventListener("click", () => goEpisode(P.episodeIdx + 1));
  root.querySelector("[data-ap-full]").addEventListener("click", toggleFullscreen);
  root.querySelector("[data-ap-skip]").addEventListener("click", () => { v.currentTime = Math.min(v.duration - 1, v.currentTime + OP_SKIP); flash(`<span class="ap-flash-txt">+${OP_SKIP} с</span>`); });
  root.querySelector("[data-ap-nextgo]").addEventListener("click", () => { hideNextCard(); goEpisode(P.episodeIdx + 1); });
  root.querySelector("[data-ap-nextno]").addEventListener("click", () => { P.nextCancelled = true; hideNextCard(); });
  const settings = root.querySelector("[data-ap-settings]");
  const menu = root.querySelector("[data-ap-menu]");
  settings.addEventListener("click", e => { e.stopPropagation(); renderMenu(); menu.hidden = !menu.hidden; poke(); });
  root.addEventListener("click", e => { if (!menu.hidden && !e.target.closest(".ap-menu-wrap")) menu.hidden = true; });

  // клик по видео — пауза, двойной — весь экран
  let clickTimer = null;
  v.addEventListener("click", () => {
    window.clearTimeout(clickTimer);
    clickTimer = window.setTimeout(togglePlay, 220);
  });
  v.addEventListener("dblclick", () => { window.clearTimeout(clickTimer); toggleFullscreen(); });

  // громкость
  const volRange = root.querySelector("[data-ap-volume]");
  const muteBtn = root.querySelector("[data-ap-mute]");
  const syncVol = () => {
    const level = v.muted ? 0 : v.volume;
    volRange.value = level;
    volRange.style.setProperty("--p", `${level * 100}%`);
    muteBtn.innerHTML = level === 0 ? I.mute : I.vol;
  };
  volRange.addEventListener("input", () => setVolume(Number(volRange.value), Number(volRange.value) === 0));
  muteBtn.addEventListener("click", () => setVolume(v.volume || 1, !v.muted));
  v.addEventListener("volumechange", syncVol);
  syncVol();

  // перемотка
  const seek = root.querySelector("[data-ap-seek]");
  const fill = root.querySelector("[data-ap-fill]");
  const buf = root.querySelector("[data-ap-buf]");
  const hov = root.querySelector("[data-ap-hov]");
  const thumb = root.querySelector("[data-ap-thumb]");
  const tip = root.querySelector("[data-ap-tip]");
  const ratioAt = x => { const r = seek.getBoundingClientRect(); return Math.max(0, Math.min(1, (x - r.left) / r.width)); };
  const showTip = x => {
    if (!v.duration) return;
    const p = ratioAt(x);
    tip.textContent = fmtTime(p * v.duration);
    tip.style.left = `${p * 100}%`;
    hov.style.width = `${p * 100}%`;
  };
  seek.addEventListener("pointermove", e => showTip(e.clientX));
  seek.addEventListener("pointerleave", () => { hov.style.width = "0"; });
  seek.addEventListener("pointerdown", e => {
    if (!v.duration) return;
    seek.setPointerCapture(e.pointerId);
    seek.classList.add("drag");
    const move = ev => { const p = ratioAt(ev.clientX); fill.style.width = `${p * 100}%`; thumb.style.left = `${p * 100}%`; showTip(ev.clientX); };
    const up = ev => {
      seek.classList.remove("drag");
      v.currentTime = ratioAt(ev.clientX) * v.duration;
      seek.removeEventListener("pointermove", move);
      seek.removeEventListener("pointerup", up);
    };
    move(e);
    seek.addEventListener("pointermove", move);
    seek.addEventListener("pointerup", up);
  });

  const playBtn = root.querySelector("[data-ap-play]");
  const center = root.querySelector("[data-ap-center]");
  const syncPlay = () => {
    playBtn.innerHTML = v.paused ? I.play : I.pause;
    center.innerHTML = v.paused ? I.play : I.pause;
    root.classList.toggle("paused", v.paused);
    if (v.paused) root.classList.add("show-ui"); else poke();
  };
  v.addEventListener("play", syncPlay);
  v.addEventListener("pause", syncPlay);
  v.addEventListener("waiting", () => root.classList.add("buffering"));
  v.addEventListener("playing", () => { root.classList.remove("buffering"); setWait(""); });
  v.addEventListener("canplay", () => { root.classList.remove("buffering"); setWait(""); });
  v.addEventListener("error", () => { if (v.getAttribute("src")) fail("Видео не загрузилось — попробуйте другое качество или озвучку."); });
  v.addEventListener("durationchange", () => { root.querySelector("[data-ap-dur]").textContent = fmtTime(v.duration); });
  v.addEventListener("progress", () => {
    if (!v.duration || !v.buffered.length) return;
    let end = 0;
    for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 1) end = Math.max(end, v.buffered.end(i));
    buf.style.width = `${(end / v.duration) * 100}%`;
  });
  v.addEventListener("timeupdate", () => {
    if (!v.duration) return;
    const p = v.currentTime / v.duration;
    if (!seek.classList.contains("drag")) { fill.style.width = `${p * 100}%`; thumb.style.left = `${p * 100}%`; }
    root.querySelector("[data-ap-cur]").textContent = fmtTime(v.currentTime);
    root.querySelector("[data-ap-skip]").hidden = !(v.currentTime > OP_WINDOW[0] && v.currentTime < Math.min(OP_WINDOW[1], v.duration * 0.3));
    const left = v.duration - v.currentTime;
    if (left < NEXT_CARD_SEC && !P.nextCancelled) showNextCard();
    if (p > 0.9) markWatched(P.series.episodes[P.episodeIdx].id);
  });
  v.addEventListener("ended", () => {
    markWatched(P.series.episodes[P.episodeIdx].id);
    startCountdown();
  });

  root.addEventListener("pointermove", poke);
  document.addEventListener("fullscreenchange", onFullscreen);
}

function onFullscreen() {
  if (!P) return;
  const on = document.fullscreenElement === P.root;
  P.root.classList.toggle("fs", on);
  $r("[data-ap-full]").innerHTML = on ? I.unfull : I.full;
}

export function closeAnimePlayer() {
  if (!P) return;
  saveProgress();
  window.clearInterval(P.saveTimer);
  window.clearInterval(P.nextTimer);
  window.clearTimeout(P.hideTimer);
  document.removeEventListener("fullscreenchange", onFullscreen);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const { root, video } = P;
  video.pause();
  video.removeAttribute("src");
  video.load();
  P = null;
  root.classList.remove("on");
  window.setTimeout(() => root.remove(), 250);
}

document.addEventListener("keydown", e => {
  if (!P) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" && e.target.type !== "range") return;
  if (tag === "TEXTAREA") return;
  const v = P.video;
  const k = e.key;
  if (k === "Escape") {
    if (!$r("[data-ap-menu]").hidden) { $r("[data-ap-menu]").hidden = true; e.stopImmediatePropagation(); return; }
    if (document.fullscreenElement) return;
    e.stopImmediatePropagation();
    closeAnimePlayer();
    return;
  }
  const handled = () => { e.preventDefault(); e.stopImmediatePropagation(); poke(); };
  if (k === " " || k === "k" || k === "л") { handled(); togglePlay(); }
  else if (k === "ArrowRight" || k === "l" || k === "д") { handled(); seekBy(10); }
  else if (k === "ArrowLeft" || k === "j" || k === "о") { handled(); seekBy(-10); }
  else if (k === "ArrowUp") { handled(); setVolume(v.volume + 0.05, false); flash(`<span class="ap-flash-txt">${Math.round(v.volume * 100)}%</span>`); }
  else if (k === "ArrowDown") { handled(); setVolume(v.volume - 0.05, v.volume - 0.05 <= 0); flash(`<span class="ap-flash-txt">${Math.round(v.volume * 100)}%</span>`); }
  else if (k === "m" || k === "ь") { handled(); setVolume(v.volume || 1, !v.muted); }
  else if (k === "f" || k === "а") { handled(); toggleFullscreen(); }
  else if (k === "n" || k === "т") { handled(); goEpisode(P.episodeIdx + 1); }
  else if (k === "s" || k === "ы") { handled(); if (!$r("[data-ap-skip]").hidden) $r("[data-ap-skip]").click(); }
}, true);
