// Раздел «Заливка аниме и другие» → Kodik (кабинет dreamyvoice).
// Все запросы идут через наш сервер (/api/kodik/*): токен Kodik хранится только там.
// Каталог и озвучки — живые данные API; остальное — справочник по кабинету для разработчиков
// с генераторами ссылок и кодом, который можно сразу скопировать.
import { $, esc } from "./utils.js";
import { apiGet, apiPost, openSheet, toast } from "./api.js";
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
const cat = { q: "", types: "anime-serial,anime", status: "", genre: "", year: "", country: "", quality: "", items: [], next: "", loading: false };
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
    apiGet(`/kodik/api/${r}`, r === "years" ? q : { ...q, sort: "count" }).then(d => d.results || []).catch(() => [])));
  facets[key] = { genres: g, years: y, countries: c, qualities: ql };
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

function groupResults(list) {
  const map = new Map();
  for (const r of list) {
    const key = r.shikimori_id || r.kinopoisk_id || r.title_orig || r.id;
    if (!map.has(key)) map.set(key, { key, main: r, dubs: [] });
    map.get(key).dubs.push(r);
  }
  return [...map.values()];
}

function posterOf(r) {
  const m = r.material_data || {};
  return m.poster_url || m.anime_poster_url || (r.screenshots || [])[0] || "";
}

function cardHtml(g) {
  const r = g.main, m = r.material_data || {};
  const poster = posterOf(r);
  const eps = r.episodes_count ? `${r.last_episode || "?"} из ${m.episodes_total || r.episodes_count} эп.` : (r.type || "").includes("serial") ? "" : "фильм";
  const dubs = [...g.dubs].sort((a, b) => (b.last_episode || 0) - (a.last_episode || 0));
  return `<article class="kk-card">
    ${poster ? `<img src="${esc(poster)}" alt="" loading="lazy">` : `<div class="kk-noposter"></div>`}
    <div class="kk-card-main">
      <b>${esc(r.title)}</b>
      <span class="kk-dim">${esc([r.title_orig, r.year, eps, m.anime_status && ({ ongoing: "онгоинг", released: "вышло", anons: "анонс" })[m.anime_status], m.shikimori_rating && `★ ${m.shikimori_rating}`].filter(Boolean).join(" · "))}</span>
      <div class="kk-dubs">${dubs.slice(0, 12).map(d => `<button type="button" class="kk-dub${/dreamy/i.test(d.translation?.title || "") ? " ours" : ""}" data-kk-play="${esc(d.link)}" data-kk-title="${esc(`${r.title} — ${d.translation?.title || ""}`)}" title="${progressOf(playerUrl(d.link)) ? "Продолжить просмотр" : "Открыть плеер"}">${progressOf(playerUrl(d.link)) ? "▶ " : ""}${esc(d.translation?.title || "?")}${d.last_episode ? ` <i>${d.last_episode}</i>` : ""}</button>`).join("")}${dubs.length > 12 ? `<span class="kk-dim">+${dubs.length - 12}</span>` : ""}</div>
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
    opts("genre", f.genres, "Жанр", cat.genre); opts("year", f.years, "Год", cat.year);
    opts("country", f.countries, "Страна", cat.country); opts("quality", f.qualities, "Качество", cat.quality);
  };
  fillFacets();
  const paint = () => {
    // Фильтра по качеству в API нет — отбираем по полю quality в ответе.
    const groups = groupResults(cat.quality ? cat.items.filter(r => r.quality === cat.quality) : cat.items);
    list.innerHTML = groups.length
      ? `<div class="kk-dim kk-count">${cat.q ? `Найдено тайтлов: ${groups.length}` : `Последние обновления · в базе ${Number.isFinite(Number(cat.total)) ? Number(cat.total) : "?"} материалов`}</div>${groups.map(cardHtml).join("")}${!cat.q && cat.next ? `<button type="button" class="btn ghost kk-more" data-kk-more>Показать ещё</button>` : ""}`
      : `<div class="kk-dim">Ничего не нашлось.</div>`;
    list.querySelector("[data-kk-more]")?.addEventListener("click", async e => { e.target.disabled = true; await fetchCatalog(true).catch(err => toast(err.message, "error")); paint(); });
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
  box.querySelector("[data-kk-reset]").addEventListener("click", () => { Object.assign(cat, { genre: "", year: "", country: "", quality: "", status: "", items: [] }); renderCatalog(box); });
  box.querySelector("[data-kk-status]").addEventListener("change", e => { cat.status = e.target.value; reload(); });
  list.addEventListener("click", e => {
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
  box.innerHTML = `<div class="kk-tools"><input class="field-input" data-kk-tq placeholder="Найти озвучку"><select class="field-input" data-kk-tt><option value="anime-serial,anime">Аниме</option><option value="">Всё</option></select></div><div class="kk-tlist kk-dim">Загружаю…</div>`;
  const out = box.querySelector(".kk-tlist");
  let rows = [];
  const paint = () => {
    const q = box.querySelector("[data-kk-tq]").value.trim().toLowerCase();
    const list = rows.filter(r => !q || r.title.toLowerCase().includes(q) || String(r.id) === q);
    out.className = "kk-tlist";
    out.innerHTML = `<div class="kk-dim kk-count">Озвучек: ${list.length}${q ? ` из ${rows.length}` : ""}. ID нужен для параметров translation_id, only_translations, hide_translations.</div>` +
      table(["ID", "Озвучка", "Тайтлов"], list.map(r => [String(r.id), r.title, String(r.count)]));
    out.querySelectorAll("tbody tr").forEach((tr, i) => { if (/dreamy/i.test(list[i].title)) tr.classList.add("ours"); });
  };
  const load = async () => {
    try {
      const types = box.querySelector("[data-kk-tt]").value;
      rows = (await apiGet("/kodik/api/translations/v2", { ...(types ? { types } : {}), sort: "count" })).results || [];
      paint();
    } catch (err) { out.textContent = err.message; }
  };
  box.querySelector("[data-kk-tq]").addEventListener("input", paint);
  box.querySelector("[data-kk-tt]").addEventListener("change", load);
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
    out.className = "kk-dumps";
    out.innerHTML = [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([base, list]) => `
      <div class="kk-dump"><div><b>${esc(DUMP_LABEL[base] || base)}</b><span class="kk-dim">${esc(list[0].modified ? new Date(list[0].modified).toLocaleString("ru-RU") : "")}</span></div>
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
    ${DLE.map(([n, k, d]) => `<div class="kk-dump"><div><b>${esc(n)}</b><span class="kk-dim">${esc(k)}</span></div><div class="kk-dim">${esc(d)}</div></div>`).join("")}
    <div class="kk-row"><button type="button" class="btn ghost" data-kk-open="/modules/dle">Инструкции по модулям ↗</button></div>`;
}

// ---------- Статистика ----------

async function renderStats(box) {
  box.innerHTML = `
    <div class="kk-tools">
      <select class="field-input" data-st-src><option value="all-sites">Все сайты</option></select>
      <select class="field-input" data-st-range>
        <option value="7">7 дней</option><option value="30" selected>30 дней</option><option value="90">90 дней</option><option value="365">Год</option>
      </select>
      <button type="button" class="btn ghost" data-kk-open="/users/stats">Кабинет ↗</button>
    </div>
    <div class="kk-stats kk-dim">Загружаю…</div>
    <p class="kk-dim">Показы рекламы в плеерах — то, что кабинет называет статистикой. Данные берутся из кабинета через наш сервер и обновляются раз в 10 минут.</p>
    <h4>Найденные плееры</h4>
    <p class="kk-dim">Результаты скрипта автодобавления по страницам сайта. Сейчас в профиле кабинета нет ни одного сайта, поэтому список пуст — для страниц с плеером он не нужен. Добавишь сайт — плееры появятся в кабинете.</p>
    <div class="kk-row"><button type="button" class="btn ghost" data-kk-open="/api-links">Найденные плееры ↗</button><button type="button" class="btn ghost" data-kk-open="/users/profile">Настройки кабинета ↗</button></div>`;
  const out = box.querySelector(".kk-stats");
  const src = box.querySelector("[data-st-src]");
  const range = box.querySelector("[data-st-range]");
  apiGet("/kodik/stats/sources").then(d => {
    src.innerHTML = d.sources.map(o => `<option value="${esc(o.value)}">${esc(o.title)}</option>`).join("");
  }).catch(() => {});
  const load = async () => {
    out.className = "kk-stats kk-dim";
    out.textContent = "Загружаю…";
    const days = Number(range.value);
    const iso = d => d.toISOString().slice(0, 10);
    try {
      const d = await apiGet("/kodik/stats", { domain: src.value, start: iso(new Date(Date.now() - days * 86400000)), end: iso(new Date()) });
      const rows = d.rows.filter(r => !r.event || r.event === "impression");
      const total = rows.reduce((a, r) => a + (r.count || 0), 0);
      const max = Math.max(1, ...rows.map(r => r.count || 0));
      const last = rows.length ? rows[rows.length - 1].count || 0 : 0;
      const best = rows.reduce((a, r) => (r.count || 0) > (a?.count || 0) ? r : a, null);
      out.className = "kk-stats";
      out.innerHTML = `
        <div class="kk-stat-tiles">
          <div><b>${total.toLocaleString("ru-RU")}</b><span>показов за период</span></div>
          <div><b>${last.toLocaleString("ru-RU")}</b><span>за последний день</span></div>
          <div><b>${Math.round(total / Math.max(1, rows.length)).toLocaleString("ru-RU")}</b><span>в среднем за день</span></div>
          <div><b>${best ? best.count.toLocaleString("ru-RU") : "—"}</b><span>${best ? `лучший день · ${esc(best.date)}` : "лучший день"}</span></div>
        </div>
        <div class="kk-bars" role="img" aria-label="Показы по дням">${rows.map(r => `<i style="height:${Math.max(2, (r.count || 0) / max * 100)}%" title="${esc(r.date)}: ${r.count}"></i>`).join("")}</div>
        <div class="kk-bars-axis"><span>${esc(rows[0]?.date || "")}</span><span>${esc(rows[rows.length - 1]?.date || "")}</span></div>`;
    } catch (err) {
      out.innerHTML = /KODIK_LOGIN/.test(err.message)
        ? `Чтобы статистика шла прямо сюда, серверу нужен вход в кабинет. Добавь в <code>/etc/telegram-bot.env</code> две строки и перезапусти сервис:${codeBlock("KODIK_LOGIN=логин_кабинета\nKODIK_PASSWORD=пароль_кабинета")}${codeBlock("systemctl restart telegram-miniapp", "Перезапуск")}Пароль увидят только владельцы — в хранилище, раздел «Сервер».`
        : esc(err.message);
    }
  };
  src.addEventListener("change", load);
  range.addEventListener("change", load);
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
  box.innerHTML = FAQ.map(([q, a]) => `<details class="kk-faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join("") +
    `<div class="kk-row"><button type="button" class="btn ghost" data-kk-open="/faq">Полный FAQ ↗</button></div>`;
}

// ---------- Заливка в Kodik (через Kodik Converter) ----------

const UP_STAGE = { queued: "в очереди", file: "беру файл", pulling: "Kodik качает", done: "отправлено", failed: "ошибка" };
let upTimer = 0;

async function renderUpload(box) {
  clearTimeout(upTimer);
  let d;
  try { d = await apiGet("/kodik/uploads"); } catch (err) { box.innerHTML = `<div class="kk-dim">${esc(err.message)}</div>`; return; }
  if (!d.configured) {
    box.innerHTML = `<p class="kk-dim">Заливка идёт через Kodik Converter — у него свой вход. Добавь на сервере в <code>/etc/telegram-bot.env</code>:</p>
      ${codeBlock("KODIK_CONVERTER_LOGIN=логин_конвертера\nKODIK_CONVERTER_PASSWORD=пароль_конвертера")}${codeBlock("systemctl restart telegram-miniapp", "Перезапуск")}`;
    return;
  }
  box.innerHTML = `
    <p class="kk-dim">Те же финалы, что уходят на Anime 365. Kodik сам скачивает файл с нашего сервера по одноразовой ссылке — через твой компьютер видео не идёт. Перед отправкой карточку можно проверить и поправить; дальше конвертация и модерация у Kodik — статус во вкладке «Конвертер».</p>
    <div class="kk-list">${d.items.map(it => {
      const st = it.kodik || {};
      const stage = it.running && !st.stage ? "queued" : st.stage;
      return `<div class="kk-dump kk-up" data-up-key="${esc(it.key)}">
        <div><b>${esc(it.title || "?")} · ${esc(String(it.episode ?? "?"))} серия</b>
          <span class="kk-dim">${esc(it.file || "")}${it.size ? ` · ${fmtSize(it.size)}` : ""}</span>
          ${stage ? `<span class="kk-upst ${esc(stage)}">${esc(UP_STAGE[stage] || stage)}${st.text && stage !== "done" ? ` — ${esc(st.text)}` : ""}${st.error ? ` — ${esc(st.error)}` : ""}</span>` : ""}
        </div>
        <div class="kk-dump-f">${["queued", "file", "pulling"].includes(stage) ? "" : `<button type="button" class="btn ${stage === "done" ? "ghost" : "primary"}" data-up-go>${stage === "done" ? "Залить ещё раз" : stage === "failed" ? "Повторить" : "Залить в Kodik"}</button>`}</div>
      </div>`;
    }).join("") || `<div class="kk-dim">Готовых финалов нет.</div>`}</div>`;
  box.querySelectorAll("[data-up-go]").forEach(b => b.addEventListener("click", () => {
    const key = b.closest("[data-up-key]").dataset.upKey;
    const it = d.items.find(x => x.key === key);
    openUploadForm(it, () => renderUpload(box));
  }));
  // Пока что-то отправляется — обновляем раз в 4 секунды, пока вкладка открыта.
  if (d.items.some(it => it.running || ["queued", "file", "pulling"].includes(it.kodik?.stage))) {
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
  box.innerHTML = `<div class="kk-tools">
      <div class="a3-seg">${CONV_FILTERS.map(([k, t]) => `<button type="button" class="${conv.filter === k ? "on" : ""}" data-cf="${k}">${t}<i data-cfc="${k}"></i></button>`).join("")}</div>
      <input class="field-input" data-cq placeholder="Поиск по названию" value="${esc(conv.query)}">
      <button type="button" class="btn ghost" data-conv-open>Конвертер ↗</button>
    </div><div class="kk-conv kk-dim">Загружаю…</div>`;
  const out = box.querySelector(".kk-conv");
  box.querySelector("[data-conv-open]").addEventListener("click", () => openExternal("https://converter.kodikres.com/media-files"));
  box.querySelectorAll("[data-cf]").forEach(b => b.addEventListener("click", () => { conv.filter = b.dataset.cf; conv.page = 1; renderConverter(box); }));
  let t = 0;
  box.querySelector("[data-cq]").addEventListener("input", e => { conv.query = e.target.value; clearTimeout(t); t = setTimeout(() => { conv.page = 1; load(); }, 450); });
  const load = async () => {
    out.className = "kk-conv kk-dim"; out.textContent = "Загружаю…";
    try {
      const d = await apiGet("/kodik/converter/files", { filter: conv.filter, page: conv.page, query: conv.query });
      for (const [k, n] of Object.entries(d.counts || {})) { const el = box.querySelector(`[data-cfc="${k}"]`); if (el) el.textContent = ` ${n}`; }
      out.className = "kk-conv";
      out.innerHTML = d.files.length ? `<div class="kk-table"><table><thead><tr><th>Файл</th><th>Статус</th><th></th></tr></thead><tbody>${d.files.map(f => `<tr>
          <td>${esc(f.cells.filter(c => c && c !== "Копировать").slice(0, 8).join(" · "))}</td>
          <td><span class="kk-upst ${esc(f.status_class)}">${esc(f.status || "—")}</span></td>
          <td>${f.player ? `<button type="button" class="btn ghost" data-kk-copy="${esc(playerUrl(f.player))}">Ссылка</button>` : ""}</td></tr>`).join("")}</tbody></table></div>
        <div class="kk-row">${conv.page > 1 ? `<button type="button" class="btn ghost" data-cp="-1">← Назад</button>` : ""}<span class="kk-dim">страница ${d.page}</span>${d.files.length ? `<button type="button" class="btn ghost" data-cp="1">Дальше →</button>` : ""}</div>`
        : `<div class="kk-dim">Пусто.</div>`;
      out.querySelectorAll("[data-cp]").forEach(b => b.addEventListener("click", () => { conv.page += Number(b.dataset.cp); load(); }));
    } catch (err) {
      out.innerHTML = /KODIK_CONVERTER/.test(err.message)
        ? `Нужен вход в конвертер: ${codeBlock("KODIK_CONVERTER_LOGIN=логин_конвертера\nKODIK_CONVERTER_PASSWORD=пароль_конвертера")}${codeBlock("systemctl restart telegram-miniapp", "Перезапуск")}`
        : esc(err.message);
    }
  };
  load();
}

const RENDER = {
  upload: renderUpload, converter: renderConverter,
  catalog: renderCatalog, translations: renderTranslations, dumps: renderDumps, api: renderApi, player: renderPlayer,
  iframe: renderIframe, scripts: renderScripts, dle: renderDle, stats: renderStats, faq: renderFaq,
};
