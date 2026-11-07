// Раздел «Заливка аниме и другие» → Kodik (кабинет dreamyvoice).
// Все запросы идут через наш сервер (/api/kodik/*): токен Kodik хранится только там.
// Каталог и озвучки — живые данные API; остальное — справочник по кабинету для разработчиков
// с генераторами ссылок и кодом, который можно сразу скопировать.
import { $, esc } from "./utils.js";
import { apiGet, apiPost, openSheet, toast, mediaUrl } from "./api.js";
import { openExternal, pickOutputFile } from "./tauri.js";
import { downloadWithCard } from "./download-card.js";
import { loadA365 } from "./a365.js";

const CABINET = "https://bd.kodikres.com";
const PART_KEY = "project-uploads-part";
const VIEW_KEY = "project-kodik-view";

const VIEWS = [
  ["upload", "Заливка"], ["converter", "Конвертер"], ["catalog", "Каталог"], ["translations", "Озвучки"], ["dumps", "Файлы базы"], ["api", "API"],
  ["player", "API плеера"], ["iframe", "Параметры iframe"], ["scripts", "Скрипты"], ["dle", "Модули DLE"],
  ["stats", "Статистика"], ["faq", "FAQ"],
];

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) || d; } catch (_) { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* не запомним — не страшно */ } },
};

let view = store.get(VIEW_KEY, "catalog");
const cat = { q: "", types: "anime-serial,anime", status: "", genre: "", year: "", country: "", quality: "", adult: false, items: [], next: "", loading: false };
// Тайтлы 18+ (эротика, хентай) по умолчанию не показываем — только по галочке «18+».
const ADULT_GENRES = /^(эротика|хентай|erotica|hentai)$/i;
const isAdult = r => {
  const m = r.material_data || {};
  return [...(m.anime_genres || []), ...(m.genres || []), ...(m.all_genres || [])].some(g => ADULT_GENRES.test(String(g).trim()));
};
const facets = {};
const PROGRESS_KEY = "project-kodik-progress";

// Где остановился в плеере Kodik: ключ — ссылка плеера без параметров. Приходит из postMessage плеера.
function progressAll() { try { return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}"); } catch (_) { return {}; } }
function progressOf(link) { return progressAll()[(link || "").split("?")[0]] || null; }
function saveProgress(link, patch) {
  const all = progressAll();
  const key = (link || "").split("?")[0];
  all[key] = { ...(all[key] || {}), ...patch, at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > 300) keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 300).forEach(k => delete all[k]);
  try { localStorage.setItem(PROGRESS_KEY, JSON.stringify(all)); } catch (_) { /* без памяти — просто не продолжим */ }
}
const clock = sec => { sec = Math.max(0, Math.round(sec || 0)); const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, x = String(sec % 60).padStart(2, "0"); return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`; };

async function loadFacets(types) {
  const key = types || "all";
  if (facets[key]) return facets[key];
  const q = types ? { types } : {};
  const [g, y, c, ql] = await Promise.all(["genres", "years", "countries", "qualities/v2"].map(r =>
    apiGet(`/kodik/api/${r}`, r === "years" ? q : r === "genres" ? { ...q, sort: "count", genres_type: "all" } : { ...q, sort: "count" }).then(d => d.results || []).catch(() => [])));
  // genres_type=all: жанры КиноПоиска + Shikimori (эротика/хентай есть только у Shikimori); склеиваем дубли по названию.
  const byTitle = new Map();
  for (const x of g) {
    const k = String(x.title || "").trim().toLowerCase();
    const prev = byTitle.get(k);
    if (!prev || (x.count || 0) > (prev.count || 0)) byTitle.set(k, x);
  }
  const genres = [...byTitle.values()].sort((a, b) => (b.count || 0) - (a.count || 0));
  facets[key] = { genres, years: y, countries: c, qualities: ql };
  return facets[key];
}

// ---------- переключатель Anime 365 / Kodik ----------

export async function loadUploads() {
  const part = store.get(PART_KEY, "a365");
  const sw = $("#uploads-switch");
  if (sw && !sw.dataset.wired) {
    sw.dataset.wired = "1";
    sw.addEventListener("click", e => {
      const b = e.target.closest("[data-part]");
      if (!b) return;
      store.set(PART_KEY, b.dataset.part);
      loadUploads();
    });
  }
  sw?.querySelectorAll("[data-part]").forEach(b => { const on = b.dataset.part === part; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
  $("#a365-body").hidden = part !== "a365";
  $("#kodik-body").hidden = part !== "kodik";
  return part === "kodik" ? loadKodik() : loadA365();
}

export async function loadKodik() {
  const root = $("#kodik-body");
  if (!root) return false;
  if (!root.dataset.wired) {
    root.dataset.wired = "1";
    root.addEventListener("click", onClick);
  }
  root.innerHTML = `
    <div class="kk-head">
      <div><b>Kodik</b> <span class="kk-dim">кабинет dreamyvoice · база, API, плееры</span></div>
      <button type="button" class="btn ghost" data-kk-open="/">Открыть кабинет ↗</button>
    </div>
    <div class="a3-seg kk-views" role="tablist">${VIEWS.map(([k, t]) => `<button type="button" role="tab" class="${view === k ? "on" : ""}" aria-selected="${view === k}" data-kk-view="${k}">${t}</button>`).join("")}</div>
    <div class="kk-body"></div>`;
  await RENDER[view](root.querySelector(".kk-body"));
  return true;
}

function onClick(e) {
  const v = e.target.closest("[data-kk-view]");
  if (v) { view = v.dataset.kkView; store.set(VIEW_KEY, view); loadKodik(); return; }
  const open = e.target.closest("[data-kk-open]");
  if (open) { openExternal(CABINET + open.dataset.kkOpen); return; }
  const copy = e.target.closest("[data-kk-copy]");
  if (copy) {
    const src = copy.dataset.kkCopy ? copy.dataset.kkCopy : copy.closest(".kk-code")?.querySelector("pre")?.textContent;
    navigator.clipboard.writeText(src || "").then(() => toast("Скопировано", "success"));
  }
}

const codeBlock = (text, label = "") => `<div class="kk-code">${label ? `<div class="kk-code-h">${esc(label)}</div>` : ""}<pre>${esc(text)}</pre><button type="button" class="btn ghost" data-kk-copy>Копировать</button></div>`;
const table = (head, rows) => `<div class="kk-table"><table><thead><tr>${head.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td>${i === 0 ? `<code>${esc(c)}</code>` : esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const playerUrl = link => (link || "").startsWith("//") ? `https:${link}` : link;

// ---------- Каталог ----------

// /list отдаёт по записи на пару «тайтл + озвучка», отсортировано по обновлению: на странице у тайтла оказывается
// только озвучка, обновлённая последней. Полный набор озвучек догружаем поиском по Shikimori ID и держим здесь.
const fullDubs = new Map(); // shikimori_id → все записи тайтла (по одной на озвучку) или null, пока грузится

function groupResults(list) {
  const map = new Map();
  for (const r of list) {
    const key = r.shikimori_id || r.kinopoisk_id || r.title_orig || r.id;
    if (!map.has(key)) map.set(key, { key, main: r, dubs: [] });
    map.get(key).dubs.push(r);
  }
  for (const g of map.values()) {
    const full = g.main.shikimori_id ? fullDubs.get(String(g.main.shikimori_id)) : null;
    if (!full) continue;
    const seen = new Set(g.dubs.map(d => d.translation?.id ?? d.id));
    for (const d of full) if (!seen.has(d.translation?.id ?? d.id)) { seen.add(d.translation?.id ?? d.id); g.dubs.push(d); }
  }
  return [...map.values()];
}

// Догрузить озвучки тайтлов на экране (по 4 запроса за раз; сервер кэширует ответы Kodik на 5 минут).
async function loadFullDubs(groups, onDone) {
  const missing = [...new Set(groups.map(g => g.main.shikimori_id).filter(Boolean).map(String))].filter(sid => !fullDubs.has(sid));
  if (!missing.length) return;
  missing.forEach(sid => fullDubs.set(sid, null));
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const sid = missing[next++];
      try { fullDubs.set(sid, (await apiGet("/kodik/api/search", { shikimori_id: sid, limit: 100 })).results || []); }
      catch (_) { fullDubs.set(sid, []); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  onDone();
}

function posterOf(r) {
  return postersOf(r)[0] || "";
}

function postersOf(r) {
  const m = r.material_data || {};
  return [...new Set([m.anime_poster_url, ...(r.screenshots || []).slice(0, 1), m.poster_url].filter(u => /^https:\/\//.test(u || "")))];
}

const fmtNum = n => Math.round(Number(n) || 0).toLocaleString("ru-RU");

function cardHtml(g) {
  const r = g.main, m = r.material_data || {};
  const poster = posterOf(r);
  const eps = r.episodes_count ? `${r.last_episode || "?"} из ${m.episodes_total || r.episodes_count} эп.` : (r.type || "").includes("serial") ? "" : "фильм";
  const dubs = [...g.dubs].sort((a, b) => (b.last_episode || 0) - (a.last_episode || 0));
  const genres = (m.anime_genres || m.genres || []).slice(0, 4);
  const about = m.anime_description || m.description || "";
  const status = ({ ongoing: "онгоинг", released: "вышло", anons: "анонс" })[m.anime_status] || "";
  return `<article class="kk-card">
    <div class="kk-cover">${poster ? `<img src="${esc(poster)}" data-fb="${esc(postersOf(r).slice(1).join(" "))}" alt="" loading="lazy">` : `<div class="kk-noposter"></div>`}${m.shikimori_rating ? `<span class="kk-rate">★ ${esc(String(m.shikimori_rating))}</span>` : ""}</div>
    <div class="kk-card-main">
      <b class="kk-clamp2">${esc(r.title)}</b>
      <span class="kk-dim kk-clamp1">${esc([r.title_orig, r.year, eps].filter(Boolean).join(" · "))}</span>
      <div class="kk-tags">${status ? `<span class="kk-tag ${esc(m.anime_status)}">${status}</span>` : ""}${genres.map(x => `<span class="kk-tag">${esc(x)}</span>`).join("")}</div>
      ${about ? `<p class="kk-about kk-clamp3">${esc(about)}</p>` : ""}
      <div class="kk-dubs">${dubs.map((d, di) => `<button type="button" class="kk-dub${/dreamy/i.test(d.translation?.title || "") ? " ours" : ""}${di >= 8 ? " kk-dub-more" : ""}" data-kk-play="${esc(d.link)}" data-kk-title="${esc(`${r.title} — ${d.translation?.title || ""}`)}" title="${progressOf(playerUrl(d.link)) ? "Продолжить просмотр" : "Открыть плеер"}">${progressOf(playerUrl(d.link)) ? "▶ " : ""}${esc(d.translation?.title || "?")}${d.last_episode ? ` <i>${d.last_episode}</i>` : ""}</button>`).join("")}${dubs.length > 8 ? `<button type="button" class="kk-dub kk-dub-toggle" data-more="+${dubs.length - 8}">+${dubs.length - 8}</button>` : ""}</div>
      <div class="kk-ids">${r.shikimori_id ? `<span>shikimori ${esc(r.shikimori_id)}</span>` : ""}${r.kinopoisk_id ? `<span>КП ${esc(r.kinopoisk_id)}</span>` : ""}<span>${esc(r.id)}</span></div>
    </div>
  </article>`;
}

async function fetchCatalog(more) {
  if (cat.loading) return;
  cat.loading = true;
  try {
    const q = cat.q.trim();
    const common = { types: cat.types, with_material_data: "true", limit: 100 };
    if (cat.status) common.anime_status = cat.status;
    if (cat.genre) common.all_genres = cat.genre;
    if (cat.year) common.year = cat.year;
    if (cat.country) common.countries = cat.country;
    let d;
    if (q) d = await apiGet("/kodik/api/search", { ...common, ...(/^\d+$/.test(q) ? { shikimori_id: q } : { title: q }) });
    else d = await apiGet("/kodik/api/list", { ...common, sort: "updated_at", ...(more && cat.next ? { next: cat.next } : {}) });
    cat.items = more ? [...cat.items, ...(d.results || [])] : (d.results || []);
    cat.next = d.next_page ? new URL(d.next_page).searchParams.get("next") || "" : "";
    cat.total = d.total;
  } finally { cat.loading = false; }
}

async function renderCatalog(box) {
  box.innerHTML = `
    <div class="kk-tools">
      <input class="field-input" data-kk-q placeholder="Название или Shikimori ID — пусто: последние обновления" value="${esc(cat.q)}">
      <select class="field-input" data-kk-types>
        ${[["anime-serial,anime", "Аниме"], ["anime-serial", "Аниме-сериалы"], ["anime", "Аниме-фильмы"], ["", "Всё"]].map(([v, t]) => `<option value="${v}"${cat.types === v ? " selected" : ""}>${t}</option>`).join("")}
      </select>
      <select class="field-input" data-kk-status>
        ${[["", "Любой статус"], ["ongoing", "Онгоинги"], ["released", "Вышедшие"], ["anons", "Анонсы"]].map(([v, t]) => `<option value="${v}"${cat.status === v ? " selected" : ""}>${t}</option>`).join("")}
      </select>
    </div>
    <div class="kk-tools kk-facets">
      <select class="field-input" data-kk-f="genre"><option value="">Жанр</option></select>
      <select class="field-input" data-kk-f="year"><option value="">Год</option></select>
      <select class="field-input" data-kk-f="country"><option value="">Страна</option></select>
      <select class="field-input" data-kk-f="quality"><option value="">Качество</option></select>
      <label class="kk-adult" title="Показывать тайтлы с жанрами «Эротика» и «Хентай»"><input type="checkbox" data-kk-adult${cat.adult ? " checked" : ""}> 18+</label>
      <button type="button" class="btn ghost" data-kk-reset>Сбросить</button>
    </div>
    <div class="kk-list"><div class="kk-dim">Загружаю…</div></div>`;
  const list = box.querySelector(".kk-list");
  const fillFacets = async () => {
    const f = await loadFacets(cat.types);
    const opts = (sel, rows, label, val) => {
      const el = box.querySelector(`[data-kk-f="${sel}"]`);
      if (!el) return;
      el.innerHTML = `<option value="">${label}</option>` + rows.map(r => { const v = String(r.title ?? r.year); return `<option value="${esc(v)}"${val === v ? " selected" : ""}>${esc(v)} · ${r.count}</option>`; }).join("");
    };
    opts("genre", cat.adult ? f.genres : f.genres.filter(g => !ADULT_GENRES.test(String(g.title).trim())), "Жанр", cat.genre); opts("year", f.years, "Год", cat.year);
    opts("country", f.countries, "Страна", cat.country); opts("quality", f.qualities, "Качество", cat.quality);
  };
  fillFacets();
  const paint = () => {
    // Фильтра по качеству в API нет — отбираем по полю quality в ответе.
    const shown = cat.items.filter(r => (!cat.quality || r.quality === cat.quality) && (cat.adult || !isAdult(r)));
    const groups = groupResults(shown);
    const hiddenAdult = cat.adult ? 0 : groupResults(cat.items.filter(isAdult)).length;
    list.innerHTML = groups.length
      ? `<div class="kk-dim kk-count">${cat.q ? `Найдено тайтлов: ${groups.length}` : `Последние обновления · в базе ${Number.isFinite(Number(cat.total)) ? Number(cat.total) : "?"} материалов`}${hiddenAdult ? ` · скрыто 18+: ${hiddenAdult}` : ""}</div><div class="kk-grid kk-grid-wide">${groups.map(cardHtml).join("")}</div>${!cat.q && cat.next ? `<button type="button" class="btn ghost kk-more" data-kk-more>Показать ещё</button>` : ""}`
      : `<div class="kk-dim">Ничего не нашлось.</div>`;
    // Битый адрес постера у Kodik — показываем заглушку, а не значок сломанной картинки.
    list.querySelectorAll(".kk-cover img").forEach(img => img.addEventListener("error", () => {
      const rest = (img.dataset.fb || "").split(" ").filter(Boolean);
      if (rest.length) { img.dataset.fb = rest.slice(1).join(" "); img.src = rest[0]; return; }
      const ph = document.createElement("div"); ph.className = "kk-noposter"; img.replaceWith(ph);
    }));
    list.querySelector("[data-kk-more]")?.addEventListener("click", async e => { e.target.disabled = true; await fetchCatalog(true).catch(err => toast(err.message, "error")); paint(); });
    // Полный список озвучек — после того как карточки уже на экране; перерисуем, когда догрузится.
    if (!cat.q) loadFullDubs(groups, () => { if (list.isConnected && !cat.q) paint(); });
  };
  const reload = async () => {
    list.innerHTML = `<div class="kk-dim">Загружаю…</div>`;
    try { await fetchCatalog(false); paint(); } catch (err) { list.innerHTML = `<div class="kk-dim">${esc(err.message || "Kodik не ответил")}</div>`; }
  };
  let t = 0;
  box.querySelector("[data-kk-q]").addEventListener("input", e => { cat.q = e.target.value; clearTimeout(t); t = setTimeout(reload, 450); });
  box.querySelector("[data-kk-types]").addEventListener("change", e => { cat.types = e.target.value; fillFacets(); reload(); });
  // Только эти четыре поля: запись в cat[любое имя из DOM] позволила бы странице подменить, например, cat.total.
  const FACET_FIELDS = { genre: "genre", year: "year", country: "country", quality: "quality" };
  box.querySelectorAll("[data-kk-f]").forEach(el => el.addEventListener("change", () => {
    const field = FACET_FIELDS[el.dataset.kkF];
    if (!field) return;
    cat[field] = String(el.value);
    if (field === "quality") paint(); else reload();
  }));
  box.querySelector("[data-kk-adult]").addEventListener("change", e => { cat.adult = e.target.checked; fillFacets(); paint(); });
  box.querySelector("[data-kk-reset]").addEventListener("click", () => { Object.assign(cat, { genre: "", year: "", country: "", quality: "", status: "", adult: false, items: [] }); renderCatalog(box); });
  box.querySelector("[data-kk-status]").addEventListener("change", e => { cat.status = e.target.value; reload(); });
  list.addEventListener("click", e => {
    const more = e.target.closest(".kk-dub-toggle");
    if (more) { const card = more.closest(".kk-card"); const open = card.classList.toggle("kk-dubs-open"); more.textContent = open ? "свернуть" : more.dataset.more; return; }
    const p = e.target.closest("[data-kk-play]");
    if (p) openKodikPlayer(p.dataset.kkPlay, p.dataset.kkTitle);
  });
  if (cat.items.length) paint(); else reload();
}

export function openKodikPlayer(link, title) {
  const base = playerUrl(link);
  // Продолжить с того же места: серия, сезон и секунда из прошлого просмотра (API плеера).
  const prog = progressOf(base);
  let src = base;
  if (prog && !/[?&](season|episode|start_from)=/.test(base)) {
    const u = new URL(base);
    if (prog.season != null) u.searchParams.set("season", prog.season);
    if (prog.episode != null) u.searchParams.set("episode", prog.episode);
    if (prog.time > 15 && !prog.ended) u.searchParams.set("start_from", Math.floor(prog.time - 5));
    src = u.toString();
  }
  const overlay = openSheet(`
    <div class="kk-player-head"><b>${esc(title || "Kodik")}</b>
      <span class="kk-dim" data-kk-now>${prog ? esc(`продолжаю: ${prog.episode ? `${prog.season ?? 1} сезон, ${prog.episode} серия, ` : ""}${clock(prog.time)}`) : ""}</span>
      <button type="button" class="btn ghost" data-kk-cmd="prev" title="Предыдущая серия">‹</button>
      <button type="button" class="btn ghost" data-kk-cmd="next" title="Следующая серия">›</button>
      <button type="button" class="btn ghost" data-kk-copy="${esc(base)}">Ссылка</button>
      <button type="button" class="btn ghost" data-kk-page title="Если плеер здесь пишет «страницы не существует»">Открыть в браузере ↗</button>
      <button type="button" class="btn ghost" data-close>Закрыть</button></div>
    <div class="kk-player"><iframe src="${esc(src)}" allow="autoplay *; fullscreen *; picture-in-picture *" allowfullscreen referrerpolicy="origin"></iframe></div>`, "wide");
  overlay.querySelector(".sheet").classList.add("kk-player-sheet");
  // Голая ссылка плеера вне сайта у Kodik не открывается — в браузер отдаём их «страницу с плеером».
  overlay.querySelector("[data-kk-page]").addEventListener("click", async () => {
    try {
      const d = await apiGet("/kodik/api/search", { player_link: base, with_page_links: "true", limit: 1 });
      const page = d.results?.[0]?.link;
      openExternal(page ? playerUrl(page) : base);
    } catch (err) { toast(err.message, "error"); }
  });
  const frame = overlay.querySelector("iframe");
  const now = overlay.querySelector("[data-kk-now]");
  const cur = { season: prog?.season ?? null, episode: prog?.episode ?? null, time: 0 };
  const send = value => frame.contentWindow?.postMessage({ key: "kodik_player_api", value }, "*");
  let lastSave = 0;
  const onMessage = e => {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data.key !== "string") return;
    const { key, value } = e.data;
    if (key === "kodik_player_current_episode" && value) {
      cur.season = value.season; cur.episode = value.episode;
      saveProgress(base, { season: value.season, episode: value.episode, translation: value.translation?.title || "", time: 0, ended: false });
    } else if (key === "kodik_player_time_update" || key === "kodik_player_time") {
      cur.time = Number(value) || 0;
      if (Date.now() - lastSave > 5000) { lastSave = Date.now(); saveProgress(base, { season: cur.season, episode: cur.episode, time: cur.time, ended: false }); }
    } else if (key === "kodik_player_video_ended") {
      saveProgress(base, { ended: true });
    } else return;
    now.textContent = `${cur.episode ? `${cur.season ?? 1} сезон, ${cur.episode} серия · ` : ""}${clock(cur.time)}`;
  };
  window.addEventListener("message", onMessage);
  const close = () => { if (cur.time) saveProgress(base, { season: cur.season, episode: cur.episode, time: cur.time }); window.removeEventListener("message", onMessage); };
  overlay.addEventListener("sheet-dismissed", close);
  overlay.querySelectorAll("[data-kk-cmd]").forEach(b => b.addEventListener("click", () => {
    if (!cur.episode) { toast("Номер серии плеер ещё не прислал — запусти видео", "info"); return; }
    const episode = cur.episode + (b.dataset.kkCmd === "next" ? 1 : -1);
    if (episode < 1) return;
    send({ method: "change_episode", ...(cur.season != null ? { season: cur.season } : {}), episode, without_reload: true });
  }));
  overlay.querySelector("[data-close]").addEventListener("click", () => { close(); overlay.remove(); });
  overlay.querySelector("[data-kk-copy]").addEventListener("click", e => navigator.clipboard.writeText(e.target.dataset.kkCopy).then(() => toast("Ссылка на плеер скопирована", "success")));
}

// ---------- Озвучки ----------

async function renderTranslations(box) {
  box.innerHTML = `<div class="kk-stat-bar">
      <input class="field-input kk-search" data-kk-tq placeholder="Найти озвучку или ID">
      <div class="a3-seg" data-kk-tt><button type="button" class="on" data-v="anime-serial,anime">Аниме</button><button type="button" data-v="">Вся база</button></div>
    </div><div class="kk-tlist"><div class="kk-skel"></div></div>`;
  const out = box.querySelector(".kk-tlist");
  let rows = [], types = "anime-serial,anime";
  const paint = () => {
    const q = box.querySelector("[data-kk-tq]").value.trim().toLowerCase();
    // «Не требуется» (ID 703) — не озвучка, а отметка Kodik: материалу перевод не нужен (русская оригинальная дорожка).
    // В рейтинг команд её не ставим, показываем отдельно.
    const isService = r => r.id === 703 || /^не требуется$/i.test(r.title.trim());
    const service = rows.filter(isService);
    const teams = rows.filter(r => !isService(r));
    const ranked = teams.map((r, i) => ({ ...r, rank: i + 1 }));
    const list = ranked.filter(r => !q || r.title.toLowerCase().includes(q) || String(r.id) === q);
    const max = Math.max(1, ...teams.map(r => r.count));
    const ours = ranked.find(r => /dreamy/i.test(r.title));
    const totalTitles = teams.reduce((a, r) => a + r.count, 0);
    const rowHtml = r => `<button type="button" class="kk-trow${/dreamy/i.test(r.title) ? " ours" : ""}" data-kk-copy="${esc(String(r.id))}" title="Нажми — скопировать ID ${esc(String(r.id))}">
        <span class="kk-rank">${r.rank}</span>
        <span class="kk-tname"><b>${esc(r.title)}</b><i>ID ${esc(String(r.id))}</i></span>
        <span class="kk-tbar"><u style="width:${Math.max(1.5, r.count / max * 100)}%"></u></span>
        <span class="kk-tcount">${fmtNum(r.count)}</span>
      </button>`;
    out.innerHTML = `
      <div class="kk-tiles">
        <div class="kk-tile"><b>${fmtNum(teams.length)}</b><span>озвучек и субтитров</span></div>
        <div class="kk-tile"><b>${fmtNum(totalTitles)}</b><span>материалов с переводом</span></div>
        ${ours ? `<div class="kk-tile ok"><b>#${ours.rank}</b><span>место DreamyVoice · ${fmtNum(ours.count)} тайтлов</span></div>` : ""}
        <div class="kk-tile"><b>${esc(teams[0]?.title || "—")}</b><span>больше всех · ${fmtNum(teams[0]?.count || 0)} тайтлов</span></div>
      </div>
      <p class="kk-dim kk-lead">ID озвучки нужен для параметров translation_id, only_translations и hide_translations — нажми на строку, чтобы скопировать.</p>
      ${service.length ? `<p class="kk-dim kk-lead">Не в рейтинге: ${service.map(s => `«${esc(s.title)}» (ID ${esc(String(s.id))}, ${fmtNum(s.count)} материалов)`).join(", ")} — служебная отметка Kodik для материалов, которым перевод не нужен: в основном русские фильмы и сериалы с оригинальной дорожкой.</p>` : ""}
      ${list.length ? `<div class="kk-tgrid">${list.slice(0, 300).map(rowHtml).join("")}</div>${list.length > 300 ? `<div class="kk-dim kk-count">Показаны первые 300 из ${list.length} — уточни поиск.</div>` : ""}` : `<div class="kk-empty">Ничего не нашлось.</div>`}`;
  };
  const load = async () => {
    out.innerHTML = `<div class="kk-skel"></div>`;
    try {
      rows = ((await apiGet("/kodik/api/translations/v2", { ...(types ? { types } : {}), sort: "count" })).results || [])
        .map(r => ({ id: r.id, title: String(r.title || ""), count: Number(r.count) || 0 })).sort((a, b) => b.count - a.count);
      paint();
    } catch (err) { out.innerHTML = `<div class="kk-empty">${esc(err.message)}</div>`; }
  };
  box.querySelector("[data-kk-tq]").addEventListener("input", () => rows.length && paint());
  box.querySelector("[data-kk-tt]").addEventListener("click", e => {
    const b = e.target.closest("[data-v]"); if (!b) return;
    types = b.dataset.v;
    box.querySelectorAll("[data-kk-tt] button").forEach(x => x.classList.toggle("on", x === b));
    load();
  });
  load();
}

// ---------- Файлы базы ----------

const DUMP_LABEL = {
  "films": "Все фильмы", "serials": "Все сериалы", "calendar": "Календарь (выгрузка Shikimori)",
  "films/foreign-movie": "Зарубежные фильмы", "films/russian-movie": "Русские фильмы", "films/anime": "Аниме-фильмы",
  "serials/foreign-serial": "Зарубежные сериалы", "serials/russian-serial": "Русские сериалы", "serials/anime-serial": "Аниме-сериалы",
};
const fmtSize = b => !b ? "—" : b >= 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`;

async function renderDumps(box) {
  box.innerHTML = `<p class="kk-dim">Вся база одним файлом — для программ и скриптов. Файлы пересобираются раз в час, API обновляется сразу. Данные КиноПоиска есть только в JSON. Скачивание идёт через наш сервер, токен в ссылку не попадает.</p><div class="kk-dumps kk-dim">Проверяю файлы…</div>`;
  const out = box.querySelector(".kk-dumps");
  try {
    const { files } = await apiGet("/kodik/dumps");
    const groups = new Map();
    for (const f of files) {
      const base = f.name.replace(/\.(json|csv|xml)$/, "");
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(f);
    }
    const order = Object.keys(DUMP_LABEL);
    out.className = "kk-dumps kk-grid";
    out.innerHTML = [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([base, list]) => `
      <div class="kk-dump kk-dcard"><div><span class="kk-dicon">${base.startsWith("films") ? "🎬" : base.startsWith("serials") ? "📺" : "📅"}</span><b>${esc(DUMP_LABEL[base] || base)}</b><span class="kk-dim">${esc(list[0].modified ? new Date(list[0].modified).toLocaleString("ru-RU") : "")}</span></div>
      <div class="kk-dump-f">${list.map(f => `<button type="button" class="btn ghost" data-kk-dump="${esc(f.key)}" data-kk-name="${esc(`kodik-${f.name.replace("/", "-")}`)}">${esc(f.name.split(".").pop().toUpperCase())} · ${fmtSize(f.size)}</button>`).join("")}</div></div>`).join("");
    out.addEventListener("click", async e => {
      const b = e.target.closest("[data-kk-dump]");
      if (!b) return;
      const savePath = await pickOutputFile(b.dataset.kkName);
      if (savePath) await downloadWithCard({ command: "download_api_file", args: { apiPath: `kodik/dump/${b.dataset.kkDump}` }, savePath, name: b.dataset.kkName });
    });
  } catch (err) { out.textContent = err.message; }
}

// ---------- API ----------

const RESOURCES = {
  search: "Поиск тайтла: по названию (нечётко) или по ID — shikimori_id, kinopoisk_id, imdb_id, mdl_id, worldart_*.",
  list: "Весь каталог страницами (limit до 100, переход по next). Фильтры почти по любому полю.",
  "translations/v2": "Все озвучки (ID, название, число тайтлов) — для всей базы или по фильтрам.",
  genres: "Жанры (genres_type: kinopoisk, shikimori, mydramalist, all)", years: "Годы", countries: "Страны", "qualities/v2": "Качества видео с числом материалов",
  translations: "Озвучки, старая версия (без числа тайтлов, с типом voice/subtitles)", qualities: "Качества видео, старая версия (только названия)",
};

const API_PARAMS = [
  ["title / title_orig", "Название (можно неточно). strict=true — порядок слов, full_match=true — полное совпадение."],
  ["shikimori_id, kinopoisk_id, imdb_id, mdl_id", "Поиск по ID внешних баз. Можно несколько — выше те, где совпало больше."],
  ["id / player_link", "Kodik ID (serial-123, movie-123) или любая ссылка на плеер."],
  ["types", "anime-serial, anime, foreign-serial, foreign-movie, russian-serial, cartoon-serial… через запятую."],
  ["translation_id, translation_type", "Только эти озвучки / только voice или subtitles."],
  ["prioritize_translations, unprioritize_translations, block_translations", "Порядок и исключение озвучек (0 — снять стандартный приоритет)."],
  ["with_material_data", "true — данные КиноПоиска и Shikimori: постер, описание, рейтинги, жанры, статус."],
  ["with_seasons, season", "Сезоны сериала; season — только сериалы с этим сезоном."],
  ["with_episodes / with_episodes_data, episode", "Ссылки на каждую серию; _data — ещё название и кадры серии."],
  ["with_page_links", "Ссылки на готовые страницы с плеером вместо iframe."],
  ["anime_status, anime_kind, anime_studios, genres, year, shikimori_rating…", "Фильтры по данным Shikimori и КиноПоиска (диапазоны: 6.5-8)."],
  ["not_blocked_in, not_blocked_for_me", "Только незаблокированные в странах / в стране запроса."],
  ["limit, sort, order, next", "Страницы /list: sort=updated_at|year|created_at|*_rating, order=asc|desc."],
];

function renderApi(box) {
  box.innerHTML = `
    <p class="kk-dim">Запросы — к <code>https://kodik-api.com/&lt;ресурс&gt;?token=…</code>, GET или POST, ответ JSON. Здесь можно выполнить любой запрос: он уйдёт через наш сервер с токеном кабинета.</p>
    ${table(["Ресурс", "Что даёт"], Object.entries(RESOURCES).map(([k, v]) => ["/" + k, v]))}
    <h4>Песочница</h4>
    <div class="kk-tools">
      <select class="field-input" data-kk-res>${Object.keys(RESOURCES).map(k => `<option>${k}</option>`).join("")}</select>
    </div>
    <textarea class="field-input kk-params" data-kk-params rows="4" spellcheck="false" placeholder="параметр=значение, по одному на строку">shikimori_id=52991
with_material_data=true
limit=5</textarea>
    <div class="sheet-actions"><button type="button" class="btn primary" data-kk-run>Выполнить</button></div>
    <div class="kk-out"></div>
    <h4>Основные параметры /search и /list</h4>
    ${table(["Параметр", "Описание"], API_PARAMS)}
    <h4>Поля ответа</h4>
    <p class="kk-dim">id, title, title_orig, other_title, link (плеер), year, kinopoisk_id, imdb_id, shikimori_id, worldart_link, type, quality, camrip, lgbt, translation {id, title, type}, created_at, updated_at, blocked_countries, last_season, last_episode, episodes_count, blocked_seasons, screenshots, seasons (с with_seasons / with_episodes), material_data (с with_material_data).</p>
    <p class="kk-dim">Лимиты и разбор последних серий — во вкладке FAQ.</p>`;
  box.querySelector("[data-kk-run]").addEventListener("click", async () => {
    const out = box.querySelector(".kk-out");
    const params = {};
    for (const line of box.querySelector("[data-kk-params]").value.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) params[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    out.innerHTML = `<div class="kk-dim">Выполняю…</div>`;
    try {
      const started = Date.now();
      const d = await apiGet(`/kodik/api/${box.querySelector("[data-kk-res]").value}`, params);
      out.innerHTML = `<div class="kk-dim">${Date.now() - started} мс · ${d.total ?? (d.results || []).length} в ответе</div>` + codeBlock(JSON.stringify(d, null, 2).slice(0, 60000));
    } catch (err) { out.innerHTML = `<div class="kk-dim">${esc(err.message)}</div>`; }
  });
}

// ---------- API плеера ----------

const PLAYER_EVENTS = [
  ["kodik_player_play", "Старт или продолжение воспроизведения"],
  ["kodik_player_pause", "Пауза"],
  ["kodik_player_seek", "{ time } — перемотка, секунды"],
  ["kodik_player_time_update", "Текущее время, раз в секунду (целое)"],
  ["kodik_player_duration_update", "Длительность — в начале и при смене качества"],
  ["kodik_player_video_started / _ended", "Начало / конец видео"],
  ["kodik_player_volume_change", "{ muted, volume }"],
  ["kodik_player_current_episode", "{ episode, season, translation {id, title} } — в начале серии"],
  ["kodik_player_speed_change", "{ speed }"],
  ["kodik_player_skip_button", "{ title } — нажат пропуск опенинга / эндинга / титров"],
  ["kodik_player_enter_pip / _exit_pip", "Картинка в картинке"],
  ["kodik_player_time", "Ответ на get_time — точное время (дробное)"],
];
const PLAYER_METHODS = [
  ["play", "Запуск (первый — только по действию пользователя)"],
  ["pause", "Пауза"],
  ["seek", "{ seconds } — перемотка"],
  ["volume", "{ volume: 0…1 }"],
  ["mute / unmute", "Звук"],
  ["change_episode", "{ season?, episode, without_reload? } — сменить серию, без перезагрузки — сохраняет полный экран"],
  ["speed", "{ speed: 0.25…2 }"],
  ["enter_pip / exit_pip", "Картинка в картинке (вход — по действию пользователя)"],
  ["get_time", "Запросить время — придёт событие kodik_player_time"],
];

function renderPlayer(box) {
  box.innerHTML = `
    <p class="kk-dim">Плеер общается со страницей через <code>postMessage</code>: шлёт события и принимает команды. Так можно запоминать, где человек остановился, и самим переключать серии.</p>
    <h4>События от плеера</h4>
    ${table(["key", "value / когда"], PLAYER_EVENTS)}
    ${codeBlock(`window.addEventListener("message", e => {
  if (e.data?.key === "kodik_player_time_update") console.log("секунда", e.data.value);
  if (e.data?.key === "kodik_player_current_episode") console.log("серия", e.data.value);
});`, "Получение событий")}
    <h4>Команды плееру</h4>
    ${table(["method", "Параметры / что делает"], PLAYER_METHODS)}
    ${codeBlock(`const player = document.getElementById("kodik-player").contentWindow;
player.postMessage({ key: "kodik_player_api", value: { method: "seek", seconds: 67 } }, "*");
player.postMessage({ key: "kodik_player_api", value: { method: "change_episode", season: 1, episode: 3, without_reload: true } }, "*");`, "Управление")}`;
}

// ---------- Параметры iframe (с конструктором) ----------

const IFRAME_PARAMS = [
  ["geoblock", "RU,UA", "Скрыть плеер в странах (RU/UA — вместе с Крымом)"],
  ["translations", "false", "Убрать выбор озвучки"],
  ["hide_translations", "735,737 / voice / subtitles", "Скрыть озвучки в селекторе"],
  ["only_translations", "735,737", "Показывать только эти озвучки"],
  ["auto_translation", "true", "Сам выбирает верхнюю озвучку (обычно с последней серией)"],
  ["season, episode", "2, 3", "Какую серию открыть новому зрителю"],
  ["only_season / only_episode", "true", "Плеер одного сезона / одной серии из ссылки на сериал"],
  ["hide_selectors", "true", "Спрятать выбор сезона, серии и озвучки (через API плеера работает)"],
  ["hide_resume_button", "true", "Спрятать «Продолжить просмотр»"],
  ["start_from", "300", "Старт с секунды (только для первой серии)"],
  ["skip_button", "[opening]12-60,[ending]24:12-26:15", "Кнопки пропуска: opening, ending, intro, credits"],
  ["poster", "https://…/poster.jpg", "Свой постер до запуска"],
  ["min_age, min_age_confirmation", "18, true", "Возрастной рейтинг и подтверждение 18+"],
  ["lgbt_preview_icon, lgbt_confirmation", "true", "Иконка и предупреждение о LGBT-контенте"],
];

function renderIframe(box) {
  box.innerHTML = `
    <p class="kk-dim">Параметры дописываются к ссылке плеера: <code>?a=1&amp;b=2</code>. Многое можно задать глобально в настройках плеера в кабинете — параметр в ссылке важнее.</p>
    ${table(["Параметр", "Пример", "Что делает"], IFRAME_PARAMS)}
    <h4>Конструктор ссылки</h4>
    <div class="kk-builder">
      <input class="field-input" data-ib="link" placeholder="Ссылка на плеер (из каталога: кнопка «Ссылка»)">
      <div class="kk-bgrid">
        <input class="field-input" data-ib="season" placeholder="season">
        <input class="field-input" data-ib="episode" placeholder="episode">
        <input class="field-input" data-ib="start_from" placeholder="start_from, сек">
        <input class="field-input" data-ib="only_translations" placeholder="only_translations">
        <input class="field-input" data-ib="hide_translations" placeholder="hide_translations">
        <input class="field-input" data-ib="skip_button" placeholder="skip_button">
        <input class="field-input" data-ib="geoblock" placeholder="geoblock">
        <input class="field-input" data-ib="poster" placeholder="poster">
      </div>
      <div class="kk-checks">${["auto_translation", "only_episode", "only_season", "hide_selectors", "hide_resume_button"].map(k => `<label><input type="checkbox" data-ib="${k}"> ${k}</label>`).join("")}<label><input type="checkbox" data-ib="translations"> translations=false</label></div>
      <div class="kk-out"></div>
    </div>`;
  const out = box.querySelector(".kk-out");
  const build = () => {
    const link = box.querySelector('[data-ib="link"]').value.trim();
    if (!link) { out.innerHTML = `<div class="kk-dim">Вставь ссылку — здесь появится готовая ссылка и код iframe.</div>`; return; }
    let url;
    try { url = new URL(playerUrl(link)); } catch (_) { out.innerHTML = `<div class="kk-dim">Это не ссылка.</div>`; return; }
    for (const el of box.querySelectorAll("[data-ib]")) {
      const k = el.dataset.ib;
      if (k === "link") continue;
      if (el.type === "checkbox") { if (el.checked) url.searchParams.set(k, k === "translations" ? "false" : "true"); else url.searchParams.delete(k); }
      else if (el.value.trim()) url.searchParams.set(k, el.value.trim()); else url.searchParams.delete(k);
    }
    const href = decodeURIComponent(url.toString());
    out.innerHTML = codeBlock(href, "Ссылка") + codeBlock(`<iframe src="${href}" width="610" height="370" frameborder="0" allowfullscreen allow="autoplay *; fullscreen *"></iframe>`, "Код для сайта") +
      `<button type="button" class="btn ghost" data-ib-try>Открыть плеер</button>`;
    out.querySelector("[data-ib-try]").addEventListener("click", () => openKodikPlayer(href, "Проверка параметров"));
  };
  box.querySelector(".kk-builder").addEventListener("input", build);
  build();
}

// ---------- Скрипты ----------

function renderScripts(box) {
  const domain = { from: "kodik.org", to: "kodikplayer.com", ready: true };
  box.innerHTML = `
    <h4>Автодобавление плееров</h4>
    <p class="kk-dim">Скрипт на сайте сам находит плеер для каждой страницы (по названию, году, ID КиноПоиска, IMDb, World Art, Shikimori, MyDramaList) и вставляет его; где не нашёл — ничего не показывает. Может заменять чужие плееры, фильтровать озвучки и типы, ставить приоритет озвучек, вызывать ваш JS-callback. Если скрипт нельзя — есть вариант iframe (но он виден всегда). Код собирается в генераторе кабинета.</p>
    <div class="kk-row"><button type="button" class="btn ghost" data-kk-open="/add-players">Генератор автодобавления ↗</button><button type="button" class="btn ghost" data-kk-open="/api-links">Найденные плееры ↗</button></div>
    <p class="kk-dim">«Найденные плееры» — что скрипт нашёл на страницах сайта: можно скрыть лишние или заменить плеер другим. Раздел работает, когда в профиле кабинета добавлен сайт; сейчас сайтов нет — для страниц с плеером он не нужен.</p>
    <h4>Замена домена</h4>
    <p class="kk-dim">Если домен плеера заблокируют — меняет домен во всех вставленных вручную плеерах. Плееры из автодобавления обновляются сами.</p>
    <div class="kk-bgrid">
      <input class="field-input" data-cd="from" value="${domain.from}" placeholder="Какие домены (через запятую)">
      <input class="field-input" data-cd="to" value="${domain.to}" placeholder="На какой домен">
      <label class="kk-checks"><input type="checkbox" data-cd="ready" checked> ждать загрузки страницы</label>
    </div>
    <div class="kk-cd-out"></div>`;
  const paint = () => {
    const from = box.querySelector('[data-cd="from"]').value.split(",").map(s => s.trim()).filter(Boolean);
    const to = box.querySelector('[data-cd="to"]').value.trim() || "kodikplayer.com";
    const ready = box.querySelector('[data-cd="ready"]').checked;
    box.querySelector(".kk-cd-out").innerHTML = codeBlock(`<script type="text/javascript">
var kodikChangeDomains = {
  fromDomains: ${JSON.stringify(from)},
  toDomain: ${JSON.stringify(to)},
  onDomReady: ${ready}
};
!function(e,n,t,r,a){r=e.createElement(n),a=e.getElementsByTagName(n)[0],r.async=!0,r.src=t,a.parentNode.insertBefore(r,a)}(document,"script","//kodik-add.com/change-domains.min.js");
</script>`, ready ? "Можно ставить в любое место страницы" : "Ставить сразу после кода плеера");
  };
  box.addEventListener("input", paint);
  paint();
}

// ---------- Модули DLE ----------

const DLE = [
  ["Kodik Replacer (Антиблок) 1.3.0", "официальный", "Плееры работают, даже если домен Kodik заблокировали. Лёгкий, базу не меняет — ставить стоит всем."],
  ["Kodik 2.7.0", "официальный", "Плееры при добавлении новости и массово, автодобавление по cron, приоритет озвучек, автозаполнение полей (ID, качество, озвучка, сезон, серия)."],
  ["Kodik Serials 3.3.1", "официальный", "Сам выводит и обновляет сериалы, блок обновлений, много настроек."],
  ["Kodik Base 2.6.0", "официальный", "Список материалов базы с проверкой, что уже есть на сайте."],
  ["Grabber Kodik", "сторонний, бесплатный", "Граббер аниме, дорам, фильмов, сериалов с поднятием при новых сериях и постраничной разбивкой."],
  ["Advanced Kodik Parser", "сторонний, бесплатный", "Парсинг и граббинг аниме с Shikimori, Kodik и World Art, обновление новостей при новой серии."],
  ["Посерийный модуль 1.2.0", "сторонний", "Отдельная страница на каждую серию."],
  ["Parser / Grabber KinoPoisk", "сторонний, платный", "Плеер плюс данные КиноПоиска; Grabber — массовое добавление."],
  ["Kodik Ajax Playlist", "сторонний, бесплатный", "Плейлист с запоминанием последней серии."],
];

function renderDle(box) {
  box.innerHTML = `<p class="kk-dim">Модули для движка DataLife Engine — если сайт на DLE. Установка, обновление и удаление каждого расписаны в кабинете.</p>
    <div class="kk-grid">${DLE.map(([n, k, d]) => `<div class="kk-dump kk-dcard"><div><b>${esc(n)}</b><span class="kk-dim">${esc(k)}</span></div><div class="kk-dim">${esc(d)}</div></div>`).join("")}</div>
    <div class="kk-row"><button type="button" class="btn ghost" data-kk-open="/modules/dle">Инструкции по модулям ↗</button></div>`;
}

// ---------- Статистика ----------

// Статистика показов: одна величина (показы) — одна ось. Прошлый период пунктиром на той же оси, чтобы было с чем сравнить.
const statsState = { src: "all-sites", days: 30, table: false };
const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const fmtN = n => Math.round(n).toLocaleString("ru-RU");
const parseDay = s => { const [d, m, y] = String(s).split("."); return new Date(2000 + Number(y), Number(m) - 1, Number(d)); };
const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function niceMax(v) {
  // Не меньше 4: деления по четвертям остаются целыми (иначе на оси «1, 1, 1, 0»).
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map(k => k * p).find(x => x >= v);
}

function lineChartSvg(cur, prev, W = 1000) {
  const H = 260, L = 48, R = 12, T = 14, B = 28;
  const n = cur.length;
  const max = niceMax(Math.max(1, ...cur.map(r => r.count), ...prev.map(r => r.count)));
  const x = i => L + (n <= 1 ? 0 : i * (W - L - R) / (n - 1));
  const y = v => T + (H - T - B) * (1 - v / max);
  const path = rows => rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(r.count).toFixed(1)}`).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(k => k * max);
  const step = Math.max(1, Math.ceil(n / 8));
  return `<svg class="kk-line" viewBox="0 0 ${W} ${H}" data-w="${W}" role="img" aria-label="Показы по дням">
    ${ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="ax" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${fmtN(t)}</text>`).join("")}
    ${cur.map((r, i) => (i % step === 0 && n - 1 - i >= step / 2) || i === n - 1 ? `<text class="ax" x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(r.date.slice(0, 5))}</text>` : "").join("")}
    ${prev.length ? `<path class="prev" d="${path(prev.slice(-n))}"/>` : ""}
    <path class="area" d="${path(cur)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z"/>
    <path class="cur" d="${path(cur)}"/>
    <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
    <circle class="dot" r="5" visibility="hidden"/>
    <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/>
  </svg>`;
}

function wireLineHover(wrap, cur, prev) {
  const svg = wrap.querySelector("svg");
  const tip = wrap.querySelector(".kk-tip");
  const cross = svg.querySelector(".cross"), dot = svg.querySelector(".dot");
  const W = Number(svg.dataset.w) || 1000, H = 260, L = 48, R = 12, T = 14, B = 28, n = cur.length;
  const max = niceMax(Math.max(1, ...cur.map(r => r.count), ...prev.map(r => r.count)));
  const prevAligned = prev.slice(-n);
  svg.querySelector(".hit").addEventListener("mousemove", e => {
    const box = svg.getBoundingClientRect();
    const vx = (e.clientX - box.left) / box.width * W;
    const i = Math.max(0, Math.min(n - 1, Math.round((vx - L) / ((W - L - R) / Math.max(1, n - 1)))));
    const px = L + i * (W - L - R) / Math.max(1, n - 1);
    const py = T + (H - T - B) * (1 - cur[i].count / max);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("visibility", "visible");
    const d = parseDay(cur[i].date);
    tip.innerHTML = `<b>${esc(cur[i].date)} · ${WEEKDAYS[(d.getDay() + 6) % 7]}</b><span>${fmtN(cur[i].count)} показов</span>${prevAligned[i] ? `<span class="kk-dim">прошлый период: ${fmtN(prevAligned[i].count)}</span>` : ""}`;
    tip.hidden = false;
    const left = px / W * box.width;
    tip.style.left = `${Math.min(box.width - 170, Math.max(0, left + 12))}px`;
    tip.style.top = `${py / H * box.height - 10}px`;
  });
  svg.querySelector(".hit").addEventListener("mouseleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); });
}

async function renderStats(box) {
  box.innerHTML = `
    <div class="kk-stat-bar">
      <div class="a3-seg" data-st-src><button type="button" class="on" data-v="all-sites">Все сайты</button></div>
      <div class="a3-seg" data-st-range>${[[7, "7 дней"], [30, "30 дней"], [90, "90 дней"], [365, "Год"]].map(([v, t]) => `<button type="button" class="${statsState.days === v ? "on" : ""}" data-v="${v}">${t}</button>`).join("")}</div>
      <button type="button" class="btn ghost" data-st-table>${statsState.table ? "График" : "Таблица"}</button>
      <button type="button" class="btn ghost" data-kk-open="/users/stats">Кабинет ↗</button>
    </div>
    <div class="kk-stats"><div class="kk-skel"></div></div>
    <details class="kk-faq kk-found"><summary>Найденные плееры</summary><p>Результаты скрипта автодобавления по страницам сайта. В профиле кабинета пока нет ни одного сайта, поэтому список пуст — для страниц с плеером он не нужен.</p>
      <div class="kk-row"><button type="button" class="btn ghost" data-kk-open="/api-links">Найденные плееры ↗</button><button type="button" class="btn ghost" data-kk-open="/users/profile">Настройки кабинета ↗</button></div></details>`;
  const out = box.querySelector(".kk-stats");
  const srcBar = box.querySelector("[data-st-src]");
  let sources = [{ value: "all-sites", title: "Все сайты" }];
  const paintSources = () => {
    srcBar.innerHTML = sources.map(o => `<button type="button" class="${statsState.src === o.value ? "on" : ""}" data-v="${esc(o.value)}">${esc(o.title)}</button>`).join("");
  };
  const sourcesReady = apiGet("/kodik/stats/sources").then(d => { sources = d.sources; paintSources(); }).catch(() => {});
  srcBar.addEventListener("click", e => { const b = e.target.closest("[data-v]"); if (!b) return; statsState.src = b.dataset.v; paintSources(); load(); });
  box.querySelector("[data-st-range]").addEventListener("click", e => {
    const b = e.target.closest("[data-v]"); if (!b) return;
    statsState.days = Number(b.dataset.v);
    box.querySelectorAll("[data-st-range] button").forEach(x => x.classList.toggle("on", x === b));
    load();
  });
  box.querySelector("[data-st-table]").addEventListener("click", e => { statsState.table = !statsState.table; e.target.textContent = statsState.table ? "График" : "Таблица"; load(); });

  const load = async () => {
    out.innerHTML = `<div class="kk-skel"></div>`;
    const days = statsState.days;
    const end = new Date();
    const start = new Date(end.getTime() - (2 * days - 1) * 86400000); // два периода сразу: текущий и прошлый для сравнения
    try {
      const d = await apiGet("/kodik/stats", { domain: statsState.src, start: isoDay(start), end: isoDay(end) });
      const all = d.rows.filter(r => !r.event || r.event === "impression").map(r => ({ date: r.date, count: Number(r.count) || 0 }));
      const cur = all.slice(-days), prev = all.slice(0, Math.max(0, all.length - days));
      const total = cur.reduce((a, r) => a + r.count, 0);
      if (!cur.length || !total) {
        const name = (sources.find(x => x.value === statsState.src) || {}).title || "этого источника";
        out.innerHTML = `<div class="kk-empty"><b>Показов нет</b><p>У «${esc(name)}» за ${days} дн. ни одного показа. Выбери другой источник или период.</p></div>`;
        return;
      }
      const prevTotal = prev.reduce((a, r) => a + r.count, 0);
      const delta = prevTotal ? (total - prevTotal) / prevTotal * 100 : null;
      const best = cur.reduce((a, r) => r.count > a.count ? r : a, cur[0]);
      const last = cur[cur.length - 1];
      const last7 = cur.slice(-7).reduce((a, r) => a + r.count, 0) / Math.min(7, cur.length);
      const byWd = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
      cur.forEach(r => { const w = (parseDay(r.date).getDay() + 6) % 7; byWd[w].sum += r.count; byWd[w].n++; });
      const wdAvg = byWd.map(w => w.n ? w.sum / w.n : 0);
      const wdMax = Math.max(1, ...wdAvg);
      const bestWd = wdAvg.indexOf(Math.max(...wdAvg));
      const srcTitle = (sources.find(s => s.value === statsState.src) || {}).title || "";
      out.innerHTML = `
        <div class="kk-tiles">
          <div class="kk-tile"><b>${fmtN(total)}</b><span>показов за ${days} дн. · ${esc(srcTitle)}</span>${delta == null ? "" : `<em class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(0)}% к прошлым ${days} дн.</em>`}</div>
          <div class="kk-tile"><b>${fmtN(total / cur.length)}</b><span>в среднем за день</span><em class="kk-dim">за последние 7 дн.: ${fmtN(last7)}</em></div>
          <div class="kk-tile"><b>${fmtN(best.count)}</b><span>лучший день · ${esc(best.date)}</span><em class="kk-dim">${WEEKDAYS[(parseDay(best.date).getDay() + 6) % 7]}</em></div>
          <div class="kk-tile"><b>${fmtN(last.count)}</b><span>${esc(last.date)} · сегодня (день ещё идёт)</span></div>
        </div>
        ${statsState.table ? `<div class="kk-table"><table><thead><tr><th>Дата</th><th>День</th><th>Показы</th><th>Прошлый период</th></tr></thead><tbody>${cur.map((r, i) => `<tr><td>${esc(r.date)}</td><td>${WEEKDAYS[(parseDay(r.date).getDay() + 6) % 7]}</td><td>${fmtN(r.count)}</td><td>${prev.slice(-cur.length)[i] ? fmtN(prev.slice(-cur.length)[i].count) : "—"}</td></tr>`).join("")}</tbody></table></div>`
        : `<section class="kk-chart"><div class="kk-chart-h"><b>Показы по дням</b><span class="kk-key"><i class="cur"></i>этот период<i class="prev"></i>прошлый</span></div>
            <div class="kk-linewrap">${lineChartSvg(cur, prev, Math.max(480, Math.round(out.clientWidth - 32)))}<div class="kk-tip" hidden></div></div></section>`}
        <div class="kk-two">
          <section class="kk-chart"><div class="kk-chart-h"><b>По дням недели</b><span class="kk-dim">в среднем за день · больше всего — ${WEEKDAYS[bestWd]}</span></div>
            <div class="kk-wd">${wdAvg.map((v, i) => `<div title="${WEEKDAYS[i]}: в среднем ${fmtN(v)}"><span>${fmtN(v)}</span><i style="height:${Math.max(3, v / wdMax * 100)}%" class="${i === bestWd ? "top" : ""}"></i><b>${WEEKDAYS[i]}</b></div>`).join("")}</div></section>
          <section class="kk-chart kk-srcs"><div class="kk-chart-h"><b>Откуда показы</b><span class="kk-dim">доля от всех показов · ${days} дн.</span></div><div class="kk-srclist kk-dim">Считаю…</div></section>
        </div>`;
      if (!statsState.table) wireLineHover(out.querySelector(".kk-linewrap"), cur, prev);
      // Сравнение источников: тот же период по каждому (запросы кэшируются на сервере).
      const list = out.querySelector(".kk-srclist");
      await sourcesReady;
      const totals = await Promise.all(sources.map(s => apiGet("/kodik/stats", { domain: s.value, start: isoDay(new Date(end.getTime() - (days - 1) * 86400000)), end: isoDay(end) })
        .then(r => r.rows.filter(x => !x.event || x.event === "impression").reduce((a, x) => a + (Number(x.count) || 0), 0)).catch(() => null)));
      if (!list.isConnected) return;
      // Источники кабинета не складываются: «Все сайты» — все показы аккаунта, остальные — их части
      // (озвучка — плееры с переводом DreamyVoice на любых сайтах; страница с плеером — ссылки w.kdkonl.com).
      const allIdx = sources.findIndex(x => x.value === "all-sites");
      const base = allIdx >= 0 && totals[allIdx] ? totals[allIdx] : Math.max(1, ...totals.filter(v => v != null));
      const NOTE = { translation: "плееры с вашей озвучкой на любых сайтах", uid: "ваша страница с плеером — ссылки для соцсетей" };
      const parts = sources.map((s, i) => ({ s, v: totals[i] })).filter(x => x.s.value !== "all-sites");
      list.className = "kk-srclist";
      list.innerHTML = `<div class="kk-src-total"><b>${allIdx >= 0 && totals[allIdx] != null ? fmtN(totals[allIdx]) : "—"}</b><span>всего показов на всех сайтах</span></div>` +
        parts.map(({ s, v }) => {
          const pct = v == null ? null : v / base * 100;
          const note = NOTE[s.value.split(":")[0]] || "";
          const zero = v === 0 && s.value.startsWith("uid:") ? " Ноль — такими ссылками сейчас никто не пользуется." : "";
          return `<div class="kk-src${s.value === statsState.src ? " on" : ""}">
            <span>${esc(s.title)}<small class="kk-src-note">${esc(note + (note && zero ? "." : "") + zero)}</small></span>
            <i><u style="width:${pct == null ? 0 : Math.min(100, pct)}%"></u></i>
            <b>${v == null ? "—" : `${pct.toFixed(pct > 0 && pct < 1 ? 1 : 0)}%`}<em>${v == null ? "" : fmtN(v)}</em></b></div>`;
        }).join("") +
        `<p class="kk-dim kk-src-hint">Это не отдельные источники, а части «Всех сайтов»: их не складывают. Если доля озвучки — 100%, значит все показы аккаунта идут через плееры с DreamyVoice.</p>`;
    } catch (err) {
      out.innerHTML = /KODIK_LOGIN/.test(err.message)
        ? `<div class="kk-empty"><b>Нужен вход в кабинет</b><p>Добавь в <code>/etc/telegram-bot.env</code> две строки и перезапусти сервис:</p>${codeBlock("KODIK_LOGIN=логин_кабинета\nKODIK_PASSWORD=пароль_кабинета")}${codeBlock("systemctl restart telegram-miniapp", "Перезапуск")}</div>`
        : `<div class="kk-empty">${esc(err.message)}</div>`;
    }
  };
  load();
}

// ---------- FAQ ----------

const FAQ = [
  ["Как материалы попадают в базу?", "Аниме — по World Art (затем Shikimori): каждый сезон — отдельный сериал («[ТВ-1]», «[ТВ-2]»). Спешлы — в 0 сезон, OVA и прочее — в -1, -2… Фильмы и сериалы — по КиноПоиску, все сезоны в одном сериале."],
  ["Что вообще есть в базе?", "В первую очередь восток: аниме, дорамы, турецкие, индийские, бразильские сериалы. США, Европа и Россия — только контент Netflix, Apple+, Disney+, Amazon по тематике базы."],
  ["Что считается аниме?", "Китайские и корейские 3D-мультфильмы — аниме. Материалы Netflix — в той категории, что на Netflix."],
  ["Как взять ссылку на серию?", "В API — with_episodes / with_episodes_data (ссылка на каждую серию); в iframe — season + episode и only_episode=true; в кабинете — по номеру сезона в колонке «S»."],
  ["Что за «ссылка на страницу»?", "Готовая страница с плеером (with_page_links=true) — когда своего сайта нет. Вид настраивается в кабинете: «Страница для соц сетей»."],
  ["Как парсить последние серии?", "/list с sort=updated_at (по умолчанию) и проходить страницы по next, пока не дойдёшь до уже известного updated_at."],
  ["Есть ли лимиты API?", "Жёстких не объявлено; на нашей стороне ответы кэшируются на 5 минут. Выгрузки базы лучше качать не ровно в начале часа — скорость выше."],
  ["Нашёл ошибку в материале", "В таблице кабинета — значок треугольника «Добавить заказ на обновление», или чат поддержки справа снизу, или support@kodikres.com."],
];

function renderFaq(box) {
  // Две постоянные колонки: раскрытый вопрос сдвигает вниз только свою колонку и ничего не перескакивает.
  const item = ([q, a]) => `<details class="kk-faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`;
  const half = Math.ceil(FAQ.length / 2);
  box.innerHTML = `<div class="kk-faqgrid"><div class="kk-faqcol">${FAQ.slice(0, half).map(item).join("")}</div><div class="kk-faqcol">${FAQ.slice(half).map(item).join("")}</div></div>` +
    `<div class="kk-row"><button type="button" class="btn ghost" data-kk-open="/faq">Полный FAQ ↗</button></div>`;
}

// ---------- Заливка в Kodik (через Kodik Converter) ----------

let upTimer = 0;

async function renderUpload(box) {
  clearTimeout(upTimer);
  let d;
  try { d = await apiGet("/kodik/uploads"); } catch (err) { box.innerHTML = `<div class="kk-empty">${esc(err.message)}</div>`; return; }
  if (!d.configured) {
    box.innerHTML = `<div class="kk-empty"><b>Нужен вход в Kodik Converter</b><p>Добавь на сервере в <code>/etc/telegram-bot.env</code>:</p>
      ${codeBlock("KODIK_CONVERTER_LOGIN=логин_конвертера\nKODIK_CONVERTER_PASSWORD=пароль_конвертера")}${codeBlock("systemctl restart telegram-miniapp", "Перезапуск")}</div>`;
    return;
  }
  const items = d.items;
  const stageOf = it => it.running && !it.kodik?.stage ? "queued" : it.kodik?.stage;
  const count = p => items.filter(i => i.presence === p).length;
  const busyN = items.filter(i => ["queued", "file", "pulling"].includes(stageOf(i))).length;
  // Серии одного тайтла — в одну карточку: постер, название и серии плашками.
  const groups = new Map();
  for (const it of items) {
    const k = it.title_id || it.title;
    if (!groups.has(k)) groups.set(k, { title: it.title, title_id: it.title_id, shiki: it.shiki_id, eps: [] });
    groups.get(k).eps.push(it);
  }
  const tile = (n, label, cls = "") => `<div class="kk-tile ${cls}"><b>${n}</b><span>${label}</span></div>`;
  box.innerHTML = `
    <div class="kk-tiles">
      ${tile(items.length, "готовых финалов")}
      ${tile(count("base"), "уже на Kodik", "ok")}
      ${tile(count("converter") + busyN, "в пути: конвертер и отправка", "run")}
      ${tile(count("none"), "нет на Kodik — можно залить", count("none") ? "warn" : "")}
    </div>
    <p class="kk-dim kk-lead">Те же финалы, что уходят на Anime 365. Kodik сам скачивает файл с нашего сервера по одноразовой ссылке — через твой компьютер видео не идёт. Нажми на серию: откроется карточка, её можно проверить перед отправкой.</p>
    <div class="kk-grid">${[...groups.values()].map(g => `
      <article class="kk-tcard">
        ${g.title_id ? `<img src="${esc(mediaUrl(`/titles/${g.title_id}/art/poster`, { w: 320 }))}" alt="" loading="lazy">` : `<div class="kk-noposter"></div>`}
        <div class="kk-tcard-main">
          <b class="kk-clamp2">${esc(g.title || "?")}</b>
          <div class="kk-eps">${g.eps.sort((a, b) => (Number(a.episode) || 0) - (Number(b.episode) || 0)).map(it => {
            const stage = stageOf(it);
            const busy = ["queued", "file", "pulling"].includes(stage);
            const cls = busy ? "run" : stage === "failed" ? "bad" : it.presence === "base" ? "ok" : it.presence === "converter" ? "run" : it.presence === "none" ? "warn" : "";
            const tip = busy ? (it.kodik?.text || "отправляю") : stage === "failed" ? `ошибка: ${it.kodik?.error || ""}` : it.presence === "base" ? "уже на Kodik — нажми, чтобы заменить" : it.presence === "converter" ? `в конвертере: ${it.converter_status}` : "нет на Kodik — нажми, чтобы залить";
            return `<button type="button" class="kk-ep ${cls}" data-up-key="${esc(it.key)}" title="${esc(tip)}"${busy ? " disabled" : ""}>
              <b>${esc(String(it.episode ?? "?"))}</b><span>${busy ? `${it.kodik?.pct ?? 0}%` : cls === "ok" ? "✓" : cls === "warn" ? "↑" : cls === "bad" ? "!" : "⏳"}</span></button>`;
          }).join("")}</div>
          ${g.eps.filter(it => stageOf(it) === "failed").map(it => `<div class="kk-uperr">${esc(String(it.episode))} серия: ${esc(it.kodik?.error || "не отправилось")}</div>`).join("")}
          ${g.eps.filter(it => ["queued", "file", "pulling"].includes(stageOf(it))).map(it => `<div class="kk-uprun">${esc(String(it.episode))} серия: ${esc(it.kodik?.text || "отправляю…")}</div>`).join("")}
        </div>
      </article>`).join("") || `<div class="kk-empty">Готовых финалов нет.</div>`}
    </div>
    <div class="kk-legend"><span class="ok">✓ на Kodik</span><span class="run">⏳ в конвертере / отправляется</span><span class="warn">↑ нет на Kodik</span><span class="bad">! ошибка</span></div>`;
  box.querySelectorAll(".kk-tcard img").forEach(img => img.addEventListener("error", () => { const ph = document.createElement("div"); ph.className = "kk-noposter"; img.replaceWith(ph); }));
  box.querySelectorAll("[data-up-key]").forEach(b => b.addEventListener("click", () => {
    const it = items.find(x => x.key === b.dataset.upKey);
    if (it) openUploadForm(it, () => renderUpload(box));
  }));
  if (items.some(it => it.running || ["queued", "file", "pulling"].includes(it.kodik?.stage))) {
    upTimer = setTimeout(() => { if (box.isConnected && view === "upload") renderUpload(box); }, 4000);
  }
}

const UP_FIELDS = [
  ["title", "Название (по-русски) *"], ["year", "Год *"], ["season", "Сезон"], ["episode", "Серия *"],
  ["translation", "Озвучка *"], ["quality", "Качество (пусто — определю по файлу)"], ["shikimori_id", "Shikimori ID"],
  ["worldart_link", "Ссылка на World Art"], ["kinopoisk_id", "КиноПоиск ID"], ["imdb_id", "IMDb ID"],
  ["torrent_link", "Ссылка на страницу торрента"], ["note", "Комментарий"],
];

async function openUploadForm(it, onDone) {
  const overlay = openSheet(`<div class="kk-upform"><div class="kk-dim">Собираю карточку…</div></div>`);
  overlay.querySelector(".sheet").classList.add("kk-upsheet");
  const box = overlay.querySelector(".kk-upform");
  let pre;
  try { pre = await apiGet("/kodik/upload/prefill", { key: it.key }); } catch (err) { box.innerHTML = `<div class="kk-dim">${esc(err.message)}</div>`; return; }
  const f = pre.fields;
  box.innerHTML = `
    <h3>Залить в Kodik: ${esc(it.title || "")} · ${esc(String(it.episode ?? ""))} серия</h3>
    ${pre.already ? `<div class="kk-warn">На Kodik у DreamyVoice эта серия уже есть (серии: ${esc(pre.ours_episodes.join(", "))}). Отправлять повторно стоит, только если это замена.</div>` : ""}
    ${!pre.found ? `<div class="kk-warn">Тайтла пока нет в базе Kodik — поля заполнены из нашего тайтла, проверь название и год.</div>` : ""}
    <form class="kk-bgrid kk-upgrid">
      ${UP_FIELDS.map(([k, label]) => `<label><span>${esc(label)}</span><input class="field-input" name="${k}" value="${esc(String(f[k] ?? ""))}"></label>`).join("")}
      <label><span>Приоритет</span><select class="field-input" name="priority">
        <option value="1"${String(f.priority) === "1" ? " selected" : ""}>Высокий — новинка</option><option value="0"${String(f.priority) === "0" ? " selected" : ""}>Обычный</option><option value="-1">Низкий</option>
      </select></label>
    </form>
    <p class="kk-dim">Правила конвертера: название только по-русски, озвучка как в базе, без вшитой рекламы. Ошибка в полях — файл удалят.</p>
    <div class="sheet-actions"><button type="button" class="btn ghost" data-x>Отмена</button><button type="button" class="btn primary" data-send>Отправить в Kodik</button></div>`;
  box.querySelector("[data-x]").addEventListener("click", () => overlay.remove());
  box.querySelector("[data-send]").addEventListener("click", async e => {
    const form = box.querySelector("form");
    const fields = Object.fromEntries([...form.elements].filter(x => x.name).map(x => [x.name, x.value.trim()]));
    e.target.disabled = true;
    try {
      await apiPost("/kodik/upload", { key: it.key, fields, again: (it.kodik || {}).stage === "done" });
      toast("Отправляю в Kodik — статус в списке", "success");
      overlay.remove();
      onDone();
    } catch (err) { toast(err.message, "error"); e.target.disabled = false; }
  });
}

// ---------- Конвертер: файлы студии на converter.kodikres.com ----------

const CONV_FILTERS = [["", "Все"], ["hidden", "Скрытые"], ["to-be-deleted", "На удалении"], ["error", "Ошибки"]];
const conv = { filter: "", page: 1, query: "" };

async function renderConverter(box) {
  box.innerHTML = `<div class="kk-stat-bar">
      <div class="a3-seg">${CONV_FILTERS.map(([k, t]) => `<button type="button" class="${conv.filter === k ? "on" : ""}" data-cf="${k}">${t}<i data-cfc="${k}"></i></button>`).join("")}</div>
      <input class="field-input kk-search" data-cq placeholder="Поиск по названию" value="${esc(conv.query)}">
      <button type="button" class="btn ghost" data-conv-open>Открыть конвертер ↗</button>
    </div><div class="kk-conv"><div class="kk-skel"></div></div>`;
  const out = box.querySelector(".kk-conv");
  box.querySelector("[data-conv-open]").addEventListener("click", () => openExternal("https://converter.kodikres.com/media-files"));
  box.querySelectorAll("[data-cf]").forEach(b => b.addEventListener("click", () => { conv.filter = b.dataset.cf; conv.page = 1; renderConverter(box); }));
  let t = 0;
  box.querySelector("[data-cq]").addEventListener("input", e => { conv.query = e.target.value; clearTimeout(t); t = setTimeout(() => { conv.page = 1; load(); }, 450); });
  const rel = iso => { const d = new Date(iso); if (isNaN(d)) return ""; const h = Math.round((Date.now() - d) / 3600000); return h < 1 ? "только что" : h < 24 ? `${h} ч назад` : `${Math.round(h / 24)} дн. назад`; };
  const load = async () => {
    out.innerHTML = `<div class="kk-skel"></div>`;
    try {
      const d = await apiGet("/kodik/converter/files", { filter: conv.filter, page: conv.page, query: conv.query });
      for (const [k, n] of Object.entries(d.counts || {})) { const el = box.querySelector(`[data-cfc="${k}"]`); if (el) el.textContent = ` ${Number(n) || 0}`; }
      if (!d.files.length) { out.innerHTML = `<div class="kk-empty">${conv.query ? "Ничего не нашлось." : "Здесь пусто."}</div>`; return; }
      const inBase = d.files.filter(f => f.info?.in_base).length;
      out.innerHTML = `
        <div class="kk-dim kk-count">Страница ${Number(d.page) || 1} · файлов: ${d.files.length} · в базе Kodik: ${inBase}</div>
        <div class="kk-grid kk-grid-wide">${d.files.map(f => {
          const i = f.info || {};
          const [ru, orig] = String(i.title || "").split(" / ");
          const poster = (d.posters || {})[i.shikimori_id] || "";
          const busy = !["finished", "error", ""].includes(f.status_class);
          return `<article class="kk-card kk-ccard">
            <div class="kk-cover">${poster ? `<img src="${esc(poster)}" alt="" loading="lazy">` : `<div class="kk-noposter"></div>`}
              <span class="kk-epbadge">${i.season ? `S${esc(String(Number(i.season)))} · ` : ""}${esc(String(Number(i.episode) || i.episode || "?"))} серия</span></div>
            <div class="kk-card-main">
              <b class="kk-clamp2">${esc(ru || "?")}</b>
              ${orig ? `<span class="kk-dim kk-clamp1">${esc(orig)}</span>` : ""}
              <div class="kk-tags">
                <span class="kk-tag kk-st ${esc(f.status_class)}">${esc(f.status || "—")}</span>
                ${i.in_base ? `<span class="kk-tag ongoing" title="${esc(i.in_base_text)}">✓ в базе Kodik</span>` : `<span class="kk-tag anons" title="${esc(i.in_base_text || "Модератор ещё не добавил файл в базу")}">ждёт модерации</span>`}
                ${i.quality ? `<span class="kk-tag">${esc(i.quality)}</span>` : ""}${i.size ? `<span class="kk-tag">${esc(i.size)}</span>` : ""}
                ${i.priority ? `<span class="kk-tag">приоритет: ${esc(i.priority.toLowerCase())}</span>` : ""}
              </div>
              ${busy ? `<div class="kk-prog"><u style="width:${Math.max(3, Number(i.progress) || 0)}%"></u></div>` : ""}
              <div class="kk-card-foot">
                <span class="kk-dim">${esc([i.translation, i.year, rel(i.date)].filter(Boolean).join(" · "))}</span>
                <span class="kk-acts">
                  ${f.player ? `<button type="button" class="btn ghost" data-cv-play="${esc(f.player)}" data-cv-title="${esc(`${ru} · ${Number(i.episode) || i.episode} серия`)}">▶ Плеер</button><button type="button" class="btn ghost" data-kk-copy="${esc(playerUrl(f.player))}">Ссылка</button>` : ""}
                  ${i.shikimori_id ? `<button type="button" class="btn ghost" data-cv-shiki="${esc(i.shikimori_id)}">Shikimori ↗</button>` : ""}
                </span>
              </div>
            </div>
          </article>`;
        }).join("")}</div>
        <div class="kk-row kk-pager">${conv.page > 1 ? `<button type="button" class="btn ghost" data-cp="-1">← Назад</button>` : ""}<span class="kk-dim">страница ${Number(d.page) || 1}</span>${d.files.length >= 20 ? `<button type="button" class="btn ghost" data-cp="1">Дальше →</button>` : ""}</div>`;
      out.querySelectorAll(".kk-cover img").forEach(img => img.addEventListener("error", () => { const ph = document.createElement("div"); ph.className = "kk-noposter"; img.replaceWith(ph); }, { once: true }));
      out.querySelectorAll("[data-cv-play]").forEach(b => b.addEventListener("click", () => openKodikPlayer(b.dataset.cvPlay, b.dataset.cvTitle)));
      out.querySelectorAll("[data-cv-shiki]").forEach(b => b.addEventListener("click", () => openExternal(`https://shikimori.one/animes/${encodeURIComponent(b.dataset.cvShiki)}`)));
      out.querySelectorAll("[data-cp]").forEach(b => b.addEventListener("click", () => { conv.page += Number(b.dataset.cp); load(); }));
    } catch (err) {
      out.innerHTML = /KODIK_CONVERTER/.test(err.message)
        ? `<div class="kk-empty"><b>Нужен вход в конвертер</b>${codeBlock("KODIK_CONVERTER_LOGIN=логин_конвертера\nKODIK_CONVERTER_PASSWORD=пароль_конвертера")}${codeBlock("systemctl restart telegram-miniapp", "Перезапуск")}</div>`
        : `<div class="kk-empty">${esc(err.message)}</div>`;
    }
  };
  load();
}

const RENDER = {
  upload: renderUpload, converter: renderConverter,
  catalog: renderCatalog, translations: renderTranslations, dumps: renderDumps, api: renderApi, player: renderPlayer,
  iframe: renderIframe, scripts: renderScripts, dle: renderDle, stats: renderStats, faq: renderFaq,
};
