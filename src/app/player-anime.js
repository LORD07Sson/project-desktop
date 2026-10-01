// Плеер серий (режим «Смотреть»): видео с anime365 (smotret-anime.org).
// Сервер находит тайтл по id Shikimori (/api/player/series), отдаёт
// переводы серии (/api/player/episode/{id}) и прямые ссылки на mp4 CDN
// anime365 под аккаунтом студии (/api/player/stream/{id}); само видео
// идёт с CDN напрямую, не через наш сервер.
//
// v1: озвучки и оригинал (субтитры anime365 — отдельный .ass, позже),
// выбор качества, запоминание места и озвучки, автопереход на
// следующую серию, горячие клавиши.

import { state } from "./state.js";
import { apiGet, toast } from "./api.js";
import { esc } from "./utils.js";

const SAVE_EVERY_MS = 5000;

function memKey(shikiId) { return `project_player_${state.telegramId || "anon"}_${shikiId}`; }
function readMem(shikiId) {
  try { return JSON.parse(localStorage.getItem(memKey(shikiId)) || "{}"); } catch (_) { return {}; }
}
function writeMem(shikiId, patch) {
  const m = { ...readMem(shikiId), ...patch };
  try { localStorage.setItem(memKey(shikiId), JSON.stringify(m)); } catch (_) { /* не критично */ }
  return m;
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h ? `${h}:` : ""}${h ? String(m).padStart(2, "0") : m}:${String(s).padStart(2, "0")}`;
}

let current = null; // { root, shikiId, name, series, episodeIdx, translations, trId, sources, quality, video }

export async function openAnimePlayer({ shikiId, name }) {
  closeAnimePlayer();
  const root = document.createElement("section");
  root.className = "ap-root";
  root.innerHTML = `
    <div class="ap-main">
      <header class="ap-top">
        <button type="button" class="ap-back" data-ap-close>← Назад</button>
        <div class="ap-title"><b>${esc(name || "")}</b><span data-ap-ep>ищу на anime365…</span></div>
      </header>
      <div class="ap-stage" data-ap-stage><div class="ap-wait"><span></span>Загружаю…</div></div>
      <div class="ap-bar">
        <div class="ap-quality" data-ap-quality></div>
        <span class="ap-sp"></span>
        <button type="button" class="ap-btn" data-ap-prev>‹ Предыдущая</button>
        <button type="button" class="ap-btn primary" data-ap-next>Следующая ›</button>
      </div>
    </div>
    <aside class="ap-side">
      <h3>Серии</h3>
      <div class="ap-eps" data-ap-eps></div>
      <h3>Озвучка</h3>
      <div class="ap-trs" data-ap-trs><div class="ap-muted">—</div></div>
      <p class="ap-note">Видео — с anime365 под аккаунтом студии. Субтитры подключим следующим шагом.</p>
    </aside>`;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add("on"));
  current = { root, shikiId, name, series: null, episodeIdx: 0, translations: [], trId: null, sources: [], quality: null, video: null, saveTimer: null };
  root.querySelector("[data-ap-close]").addEventListener("click", closeAnimePlayer);
  root.querySelector("[data-ap-prev]").addEventListener("click", () => goEpisode(current.episodeIdx - 1));
  root.querySelector("[data-ap-next]").addEventListener("click", () => goEpisode(current.episodeIdx + 1));

  let series;
  try {
    series = await apiGet(`/player/series?shiki_id=${encodeURIComponent(shikiId)}`);
  } catch (e) {
    return fail(`Не удалось открыть: ${e.message}`);
  }
  if (!current || current.root !== root) return;
  if (!series.series_id || !series.episodes.length) {
    return fail("На anime365 этого тайтла пока нет (или у него ещё нет вышедших серий).");
  }
  current.series = series;
  const mem = readMem(shikiId);
  const idx = Math.max(0, series.episodes.findIndex(e => e.id === mem.episodeId));
  renderEpisodes();
  goEpisode(idx);
}

function fail(text) {
  if (!current) return;
  current.root.querySelector("[data-ap-stage]").innerHTML = `<div class="ap-wait err">${esc(text)}</div>`;
  current.root.querySelector("[data-ap-ep]").textContent = "";
}

function renderEpisodes() {
  const box = current.root.querySelector("[data-ap-eps]");
  const mem = readMem(current.shikiId);
  const watched = new Set(mem.watched || []);
  box.innerHTML = current.series.episodes.map((e, i) => `
    <button type="button" class="ap-ep${i === current.episodeIdx ? " on" : ""}${watched.has(e.id) ? " seen" : ""}" data-ap-ep-i="${i}" title="${esc(e.label)}">${esc(e.number != null ? String(e.number) : e.label)}</button>`).join("");
  box.querySelectorAll("[data-ap-ep-i]").forEach(b => b.addEventListener("click", () => goEpisode(Number(b.dataset.apEpI))));
}

async function goEpisode(idx) {
  if (!current || !current.series) return;
  const eps = current.series.episodes;
  if (idx < 0 || idx >= eps.length) return;
  saveProgress();
  current.episodeIdx = idx;
  const ep = eps[idx];
  writeMem(current.shikiId, { episodeId: ep.id });
  renderEpisodes();
  current.root.querySelector("[data-ap-ep]").textContent = ep.label;
  current.root.querySelector("[data-ap-prev]").disabled = idx === 0;
  current.root.querySelector("[data-ap-next]").disabled = idx === eps.length - 1;
  current.root.querySelector("[data-ap-stage]").innerHTML = `<div class="ap-wait"><span></span>Ищу озвучки…</div>`;
  let d;
  try {
    d = await apiGet(`/player/episode/${ep.id}`);
  } catch (e) {
    return fail(`Не удалось получить переводы: ${e.message}`);
  }
  if (!current || current.series.episodes[current.episodeIdx].id !== ep.id) return;
  // v1: только то, что смотрится без отдельного файла субтитров.
  current.translations = d.translations.filter(t => t.kind === "voice" || t.kind === "raw");
  if (!current.translations.length) {
    renderTranslations();
    return fail("У этой серии пока нет озвучки — только субтитры (их подключим следующим шагом).");
  }
  const mem = readMem(current.shikiId);
  const same = mem.authors && current.translations.find(t => t.authors === mem.authors);
  pickTranslation((same || current.translations[0]).id);
}

function renderTranslations() {
  const box = current.root.querySelector("[data-ap-trs]");
  if (!current.translations.length) { box.innerHTML = `<div class="ap-muted">нет</div>`; return; }
  let lastGroup = "";
  box.innerHTML = current.translations.map(t => {
    const head = t.group !== lastGroup ? `<div class="ap-group">${esc(t.group)}</div>` : "";
    lastGroup = t.group;
    return `${head}<button type="button" class="ap-tr${t.id === current.trId ? " on" : ""}" data-ap-tr="${t.id}"><span>${esc(t.authors)}</span>${t.height ? `<small>${t.height >= 2160 ? "4K" : `${t.height}p`}</small>` : ""}</button>`;
  }).join("");
  box.querySelectorAll("[data-ap-tr]").forEach(b => b.addEventListener("click", () => pickTranslation(Number(b.dataset.apTr), true)));
}

async function pickTranslation(trId, keepTime = false) {
  if (!current) return;
  const resumeAt = keepTime && current.video ? current.video.currentTime : null;
  current.trId = trId;
  renderTranslations();
  const tr = current.translations.find(t => t.id === trId);
  if (tr) writeMem(current.shikiId, { authors: tr.authors });
  current.root.querySelector("[data-ap-stage]").innerHTML = `<div class="ap-wait"><span></span>Получаю видео…</div>`;
  let d;
  try {
    d = await apiGet(`/player/stream/${trId}`);
  } catch (e) {
    return fail(`Видео не получено: ${e.message}`);
  }
  if (!current || current.trId !== trId) return;
  current.sources = d.sources;
  const mem = readMem(current.shikiId);
  const q = d.sources.find(s => s.height === mem.quality) || d.sources.find(s => s.height === 1080) || d.sources[0];
  playSource(q, resumeAt);
}

function renderQuality() {
  const box = current.root.querySelector("[data-ap-quality]");
  box.innerHTML = current.sources.map(s => `<button type="button" class="ap-q${current.quality === s.height ? " on" : ""}" data-ap-q="${s.height}">${s.height >= 2160 ? "4K" : `${s.height}p`}</button>`).join("");
  box.querySelectorAll("[data-ap-q]").forEach(b => b.addEventListener("click", () => {
    const s = current.sources.find(x => x.height === Number(b.dataset.apQ));
    if (s) { writeMem(current.shikiId, { quality: s.height }); playSource(s, current.video ? current.video.currentTime : null); }
  }));
}

function playSource(src, resumeAt) {
  current.quality = src.height;
  renderQuality();
  const stage = current.root.querySelector("[data-ap-stage]");
  stage.innerHTML = `<video class="ap-video" controls autoplay preload="auto" playsinline></video>`;
  const video = stage.querySelector("video");
  current.video = video;
  const ep = current.series.episodes[current.episodeIdx];
  const mem = readMem(current.shikiId);
  const saved = resumeAt != null ? resumeAt : (mem.times || {})[ep.id];
  video.addEventListener("loadedmetadata", () => {
    if (saved && saved > 5 && saved < video.duration - 20) {
      video.currentTime = saved;
      if (resumeAt == null) toast(`Продолжаю с ${fmtTime(saved)}.`);
    }
  }, { once: true });
  video.addEventListener("ended", () => {
    markWatched(ep.id);
    if (current.episodeIdx < current.series.episodes.length - 1) {
      toast("Следующая серия…");
      goEpisode(current.episodeIdx + 1);
    }
  });
  video.addEventListener("error", () => {
    toast("Видео не загрузилось — попробуйте другое качество или озвучку.", "error");
  });
  video.addEventListener("timeupdate", () => {
    if (video.duration && video.currentTime > video.duration * 0.9) markWatched(ep.id);
  });
  video.src = src.url;
  window.clearInterval(current.saveTimer);
  current.saveTimer = window.setInterval(saveProgress, SAVE_EVERY_MS);
}

function markWatched(epId) {
  const mem = readMem(current.shikiId);
  const w = new Set(mem.watched || []);
  if (w.has(epId)) return;
  w.add(epId);
  writeMem(current.shikiId, { watched: [...w] });
  renderEpisodes();
}

function saveProgress() {
  if (!current || !current.video || !current.series) return;
  const v = current.video;
  if (!v.duration || !v.currentTime) return;
  const ep = current.series.episodes[current.episodeIdx];
  const mem = readMem(current.shikiId);
  const times = { ...(mem.times || {}) };
  times[ep.id] = v.currentTime > v.duration - 20 ? 0 : Math.floor(v.currentTime);
  writeMem(current.shikiId, { times });
}

export function closeAnimePlayer() {
  if (!current) return;
  saveProgress();
  window.clearInterval(current.saveTimer);
  const { root, video } = current;
  if (video) { video.pause(); video.removeAttribute("src"); video.load(); }
  current = null;
  root.classList.remove("on");
  window.setTimeout(() => root.remove(), 250);
}

document.addEventListener("keydown", e => {
  if (!current) return;
  const tag = (e.target && e.target.tagName) || "";
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  const v = current.video;
  if (e.key === "Escape" && !document.fullscreenElement) { e.stopImmediatePropagation(); closeAnimePlayer(); return; }
  if (!v) return;
  if (e.key === " " || e.key === "k") { e.preventDefault(); if (v.paused) v.play(); else v.pause(); }
  else if (e.key === "ArrowRight") { e.preventDefault(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - 10); }
  else if (e.key === "f" || e.key === "а") { e.preventDefault(); if (document.fullscreenElement) document.exitFullscreen(); else v.requestFullscreen?.(); }
  else if (e.key === "n" || e.key === "т") { e.preventDefault(); goEpisode(current.episodeIdx + 1); }
}, true);
