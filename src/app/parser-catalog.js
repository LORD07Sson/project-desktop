import { apiGet, apiPost, toast, clientHeaders } from "./api.js";
import { invoke, openExternal } from "./tauri.js";

const CACHE_MS = 5 * 60 * 1000;
const memo = new Map();
let fastBroken = false;
async function fastGet(path, q) {
  const tauri = window.__TAURI_INTERNALS__;
  if (tauri && !fastBroken) {
    const qs = q ? `?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== "" && v != null))}` : "";
    try {
      const r = await tauri.invoke("api_get_fast", { path: path + qs, headers: clientHeaders({}) });
      if (r.status === 200) return JSON.parse(r.body);
    } catch (e) {
      if (/not found|unknown|not allowed/i.test(String(e))) fastBroken = true;
    }
  }
  return apiGet(path, q);
}
function cget(path, q) {
  const key = `${path}?${JSON.stringify(q || {})}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.p;
  const p = fastGet(path, q);
  memo.set(key, { t: Date.now(), p });
  p.catch(() => memo.delete(key));
  if (memo.size > 400) memo.delete(memo.keys().next().value);
  return p;
}
function markQueued(btn, jobId, html) {
  if (!jobId) return;
  btn.dataset.idle ??= btn.innerHTML;
  btn.dataset.jobId = jobId;
  btn.innerHTML = html;
}
document.addEventListener("parser:jobs", ev => {
  for (const j of ev.detail || []) {
    if (j.status !== "cancelled" && j.status !== "error") continue;
    document.querySelectorAll(`[data-job-id="${window.CSS.escape(String(j.id))}"]`).forEach(b => {
      b.disabled = false;
      b.classList.remove("done");
      if (b.dataset.idle) b.innerHTML = b.dataset.idle;
      delete b.dataset.jobId;
    });
  }
});
const prefetch = (path, q) => { cget(path, q).catch(() => { }); };

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssUrl = u => `url("${String(u || "").replace(/["\\\n\r]/g, encodeURIComponent)}")`;
const SORTS = [["favorited", "Популярные"], ["updated", "Недавние"], ["name", "По имени"]];
const fmtNum = n => Number(n || 0).toLocaleString("ru-RU");
const fmtDate = s => { const d = new Date(s); return isNaN(d) ? "" : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }); };

function pager(page, pages, attr) {
  if (pages <= 1) return "";
  const from = Math.max(1, Math.min(page - 4, pages - 9));
  const nums = [];
  for (let i = from; i <= Math.min(pages, from + 9); i++) nums.push(i);
  const btn = (p, label, on = false, off = false) =>
    `<button type="button" class="pc-page${on ? " on" : ""}" ${attr}="${p}"${off ? " disabled" : ""}>${label}</button>`;
  return `<div class="pc-pager">${btn(1, "«", false, page === 1)}${btn(page - 1, "‹", false, page === 1)}${nums.map(n => btn(n, n, n === page)).join("")}${btn(page + 1, "›", false, page === pages)}${btn(pages, "»", false, page === pages)}</div>`;
}

let tabLabels = {};
const TABS = [["authors", "Авторы", "Профили авторов с постами и файлами"], ["posts", "Посты", "Лента: новые, популярные, теги"], ["releases", "Раздачи", "Торренты: качает сервер — можно закрыть вкладку"]];
const tabs = active => `<div class="pc-top">
  <div class="pc-headline"><span><b>Каталог</b><small>${esc((TABS.find(t => t[0] === active) || TABS[0])[2])}</small></span>
    <button type="button" class="btn sm" data-pc-close title="Вернуться к поиску по ссылке">✕ Закрыть</button></div>
  <div class="pc-tabs">${TABS.map(([id, n]) =>
    `<button type="button" class="pc-tab${id === active ? " on" : ""}" data-pc-tab="${id}">${srcChip(id)}${esc(tabLabels[id] || n)}</button>`).join("")}</div></div>`;

let site = "a";
let flipNext = false;
const SRC_ICON = `<svg class="pc-src-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h11l-3-3M17 17H6l3 3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function srcChip(tab) {
  const names = tabLabels.sources;
  if (!names || (tab !== "authors" && tab !== "posts") || !names[site]) return "";
  const others = Object.keys(names).filter(k => k !== site).map(k => names[k]).join(", ");
  return `<span class="pc-src${flipNext ? " flip" : ""}" data-pc-src title="Сменить на ${esc(others)}">${esc(names[site])}${SRC_ICON}</span><span class="pc-src-sep">·</span>`;
}
const SITE_KEY = "pc-last-site";

const skel = (cls, n) => `<div class="${cls}">${`<div class="pc-sk"></div>`.repeat(n)}</div>`;
const DICE = `<svg class="pc-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8.5" cy="8.5" r="1.6" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>`;
const TAB_KEY = "pc-last-tab";
const saveTab = t => { try { localStorage.setItem(TAB_KEY, t); } catch (_) { } };

// Full-screen viewer: wheel zooms toward the cursor, drag pans, click on the image toggles
// zoom, click on the backdrop or Esc closes. `srcHtml` is already HTML-escaped.
function openZoom(srcHtml) {
  const ov = document.createElement("div");
  ov.className = "pp-zoom";
  ov.innerHTML = `<img src="${srcHtml}" alt="" referrerpolicy="no-referrer" draggable="false">`;
  const img = ov.querySelector("img");
  let s = 1, x = 0, y = 0, drag = null, moved = false;
  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    ov.classList.toggle("is-zoomed", s > 1);
  };
  const zoomAt = (ns, cx, cy) => {
    ns = Math.min(8, Math.max(1, ns));
    const r = ov.getBoundingClientRect();
    const px = cx - r.left - r.width / 2, py = cy - r.top - r.height / 2;
    x = px - (px - x) * (ns / s);
    y = py - (py - y) * (ns / s);
    s = ns;
    if (s === 1) { x = 0; y = 0; }
    apply();
  };
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = e => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  ov.addEventListener("wheel", e => { e.preventDefault(); zoomAt(s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY); }, { passive: false });
  ov.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, x, y };
    moved = false;
    ov.setPointerCapture(e.pointerId);
  });
  ov.addEventListener("pointermove", e => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    if (s > 1) { x = drag.x + dx; y = drag.y + dy; apply(); }
  });
  ov.addEventListener("pointerup", () => { drag = null; });
  ov.addEventListener("click", e => {
    if (moved) return;
    const r = img.getBoundingClientRect(); // pointer capture retargets click to the overlay
    const onImg = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (onImg) zoomAt(s > 1 ? 1 : 2.5, e.clientX, e.clientY);
    else close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(ov);
}

export function openCatalog(box, { onPick, onClose, onQueued, labels }) {
  tabLabels = labels || {};
  const st = { q: "", service: "", sort: "favorited", page: 1, services: [] };
  const rs = { q: "", category: "", sort: "id", page: 1 };
  const fs = { mode: "search", q: "", tag: "", period: "week", page: 1 };
  let seq = 0;
  let hoverTimer = 0;
  box.onpointerover = ev => {
    const el = ev.target.closest("[data-pc-post],[data-pc-author]");
    clearTimeout(hoverTimer);
    if (!el) return;
    hoverTimer = setTimeout(() => {
      if (el.dataset.pcPost) { prefetch("/parser/access/post", { url: el.dataset.pcPost }); return; }
      const [svc, id] = el.dataset.pcAuthor.split("/");
      prefetch(`/parser/access/creator/${encodeURIComponent(svc)}/${encodeURIComponent(id)}`, { page: 1, site });
    }, 120);
  };

  const toTop = () => box.scrollIntoView({ block: "start" });

  function tabClick(ev) {
    if (ev.target.closest("[data-pc-close]")) { seq++; box.onclick = null; onClose(); return true; }
    const sw = ev.target.closest("[data-pc-src]");
    if (sw) {
      const keys = Object.keys(tabLabels.sources || {});
      site = keys[(keys.indexOf(site) + 1) % keys.length] || "a";
      try { localStorage.setItem(SITE_KEY, site); } catch (_) { }
      flipNext = true;
      Object.assign(st, { service: "", page: 1 });
      Object.assign(fs, { page: 1, tag: fs.mode === "tag" ? "" : fs.tag, mode: fs.mode === "tag" ? "tags" : fs.mode });
      const tab = sw.closest("[data-pc-tab]")?.dataset.pcTab;
      saveTab(tab);
      if (tab === "posts") showFeed(); else showAuthors();
      return true;
    }
    const t = ev.target.closest("[data-pc-tab]");
    if (!t) return false;
    const tab = t.dataset.pcTab;
    saveTab(tab);
    if (tab === "releases") showReleases(); else if (tab === "posts") showFeed(); else showAuthors();
    return true;
  }

  async function showReleases() {
    const my = ++seq;
    box.innerHTML = `<div class="pc-wrap">${tabs("releases")}${skel("pc-rels", 8)}</div>`;
    box.onclick = ev => { tabClick(ev); };
    let d;
    try {
      d = await cget("/parser/access/releases", { q: rs.q, category: rs.category, sort: rs.sort, page: rs.page });
      prefetch("/parser/access/releases", { q: rs.q, category: rs.category, sort: rs.sort, page: rs.page + 1 });
    } catch (e) {
      if (my === seq) box.innerHTML = `<div class="pc-wrap">${tabs("releases")}<div class="pc-empty">Раздачи недоступны: ${esc(e.message || e)}</div></div>`;
      return;
    }
    if (my !== seq) return;
    const fmtTs = t => (t ? new Date(t * 1000).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }) : "");
    const nav = `<div class="pc-pager"><button type="button" class="pc-page" data-pc-rpage="${rs.page - 1}"${rs.page === 1 ? " disabled" : ""}>‹ Назад</button>
      <span class="pc-page on">${rs.page}</span><button type="button" class="pc-page" data-pc-rpage="${rs.page + 1}"${d.has_next ? "" : " disabled"}>Вперёд ›</button></div>`;
    box.innerHTML = `<div class="pc-wrap">${tabs("releases")}
      <div class="pc-bar">
        <input type="search" class="pc-search" placeholder="Название, студия, RJ-код" value="${esc(rs.q)}" spellcheck="false">
        <select class="pc-select" data-pc-rcat>${(d.categories || []).map(c => `<option value="${esc(c.id)}"${c.id === rs.category ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
        <select class="pc-select" data-pc-rsort>${(d.sorts || []).map(c => `<option value="${esc(c.id)}"${c.id === rs.sort ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      </div>
      ${nav}
      <div class="pc-rels">${(d.items || []).map((x, i) => `
        <div class="pc-rel${x.trusted ? " trusted" : ""}${x.remake ? " remake" : ""}">
          ${"cover" in x
            ? `<span class="pc-cover" data-pc-open="${i}" title="Подробнее">${x.cover ? `<img src="${esc(x.cover)}" alt="" referrerpolicy="no-referrer">` : ""}</span>`
            : `<span class="pc-cover" data-pc-cover="${esc(x.id)}" data-pc-open="${i}" title="Подробнее"></span>`}
          <span class="pc-rbody">
            <span class="pc-badge">${esc(x.category_name)}</span>
            <b class="pc-ptitle pc-open" data-pc-open="${i}" title="${esc(x.title)}">${esc(x.title)}</b>
            <small class="pc-rstats"><span>${esc(x.size)}</span><span class="up">▲ ${x.seeders}</span><span class="down">▼ ${x.leechers}</span><span>⬇ ${fmtNum(x.downloads)}</span><span>${esc(fmtTs(x.published))}</span></small>
            <span class="pc-ract"><button type="button" class="btn sm primary" data-pc-server="${i}" title="Сервер скачает раздачу сам, потом заберёте файл из «Очереди и загрузок»">Скачать</button><button type="button" class="btn sm" data-pc-magnet="${i}">В торрент-клиент</button><button type="button" class="btn sm" data-pc-copy="${i}">Magnet</button></span>
          </span>
        </div>`).join("") || `<div class="pc-empty">Ничего не нашлось.</div>`}</div>
      ${nav}
    </div>`;
    const search = box.querySelector(".pc-search");
    let timer;
    search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { rs.q = search.value.trim(); rs.page = 1; showReleases(); }, 450); });
    box.querySelector("[data-pc-rcat]").addEventListener("change", e => { rs.category = e.target.value; rs.page = 1; showReleases(); });
    box.querySelector("[data-pc-rsort]").addEventListener("change", e => { rs.sort = e.target.value; rs.page = 1; showReleases(); });
    const io = new window.IntersectionObserver(entries => entries.forEach(en => {
      if (!en.isIntersecting) return;
      io.unobserve(en.target);
      cget(`/parser/access/release-cover/${encodeURIComponent(en.target.dataset.pcCover)}`)
        .then(c => {
          if (!c?.url || !en.target.isConnected) return;
          const img = document.createElement("img");
          img.alt = "";
          img.referrerPolicy = "no-referrer";
          img.addEventListener("error", () => img.remove());
          img.src = c.url;
          en.target.replaceChildren(img);
        })
        .catch(() => { });
    }), { rootMargin: "200px" });
    box.querySelectorAll("[data-pc-cover]").forEach(el => io.observe(el));
    box.querySelectorAll(".pc-cover > img").forEach(img => img.addEventListener("error", () => img.remove()));
    box.onclick = async ev => {
      if (tabClick(ev)) return;
      const pg = ev.target.closest("[data-pc-rpage]");
      if (pg && !pg.disabled) { rs.page = +pg.dataset.pcRpage; toTop(); showReleases(); return; }
      const op = ev.target.closest("[data-pc-open]");
      if (op) { showRelease(d.items[+op.dataset.pcOpen]); return; }
      const sv = ev.target.closest("[data-pc-server]");
      if (sv) {
        const x = d.items[+sv.dataset.pcServer];
        sv.disabled = true;
        try {
          const r = await apiPost("/parser/download", { url: x.magnet, name: x.title });
          markQueued(sv, r?.job_id, "В очереди");
          if (!r?.job_id) sv.textContent = "В очереди";
          toast("Раздача в очереди загрузок: когда будет готова, нажмите «Сохранить»", "success");
          onQueued?.();
        } catch (e) { sv.disabled = false; toast(String(e?.message || e), "error"); }
        return;
      }
      const mg = ev.target.closest("[data-pc-magnet]");
      if (mg) {
        try { await invoke("open_magnet", { magnet: d.items[+mg.dataset.pcMagnet].magnet }); toast("Открыто в торрент-клиенте", "success"); }
        catch (e) { toast(String(e?.message || e), "error"); }
        return;
      }
      const cp = ev.target.closest("[data-pc-copy]");
      if (cp) {
        try { await navigator.clipboard.writeText(d.items[+cp.dataset.pcCopy].magnet); toast("Magnet в буфере", "info"); }
        catch { toast("Не вышло скопировать", "error"); }
      }
    };
  }

  const UNIT = { bytes: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
  const toBytes = s => { const m = /([\d.]+)\s*(\w+)/.exec(s || ""); return m ? +m[1] * (UNIT[m[2].toLowerCase()] || 1) : 0; };
  const fmtBytes = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} ГБ` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} МБ` : `${Math.ceil(n / 1024)} КБ`;

  async function showRelease(x) {
    const my = ++seq;
    const back = `<button type="button" class="btn sm" data-pc-rback>← К раздачам</button>`;
    box.innerHTML = `<div class="pc-wrap">${tabs("releases")}<div class="pc-bar">${back}</div><div class="pc-empty">Загружаю раздачу…</div></div>`;
    box.onclick = ev => { if (tabClick(ev)) return; if (ev.target.closest("[data-pc-rback]")) showReleases(); };
    let d;
    try {
      d = await cget(`/parser/access/release/${encodeURIComponent(x.id)}`);
    } catch (e) {
      if (my === seq) box.innerHTML = `<div class="pc-wrap">${tabs("releases")}<div class="pc-bar">${back}</div><div class="pc-empty">Раздача недоступна: ${esc(e.message || e)}</div></div>`;
      return;
    }
    if (my !== seq) return;
    const files = d.files || [];
    const root = files.length > 1 && files.every(f => f.path.includes("/")) && new Set(files.map(f => f.path.split("/")[0])).size === 1
      ? files[0].path.split("/")[0] : "";
    const shown = p => (root ? p.slice(root.length + 1) : p);
    box.innerHTML = `<div class="pc-wrap">${tabs("releases")}
      <div class="pc-bar">${back}</div>
      <div class="pc-rdetail">
        <div class="pc-rmain">
          <span class="pc-cover pc-dcover"></span>
          <div class="pc-rinfo">
            <span class="pc-badge">${esc(x.category_name)}</span>
            <b class="pc-rtitle">${esc(x.title)}</b>
            <small class="pc-rstats"><span>${esc(x.size)}</span><span class="up">▲ ${x.seeders}</span><span class="down">▼ ${x.leechers}</span><span>⬇ ${fmtNum(x.downloads)}</span></small>
  <span class="pc-ract"><button type="button" class="btn sm primary" data-pc-get title="Сервер скачает выбранное сам, потом заберёте файл из «Очереди и загрузок»">Скачать</button><button type="button" class="btn sm" data-pc-dmagnet>В торрент-клиент</button><button type="button" class="btn sm" data-pc-dcopy>Magnet</button></span>
            ${d.description ? `<div class="pc-rdesc">${esc(d.description.replace(/\*\*/g, ""))}</div>` : ""}
          </div>
        </div>
        ${(d.images || []).length > 1 ? `<div class="pc-gallery">${d.images.map(u => `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer">`).join("")}</div>` : ""}
        <div class="pc-files">
          <div class="pc-fhead"><label><input type="checkbox" data-pc-fall checked> Файлы (${files.length})${root ? ` <small class="pc-froot">📁 ${esc(root)}</small>` : ""}</label><span data-pc-fsum></span></div>
          ${files.map((f, i) => `<label class="pc-file"><input type="checkbox" data-pc-file="${i}" checked><span class="pc-fname" title="${esc(f.path)}">${esc(shown(f.path))}</span><small>${esc(f.size)}</small></label>`).join("") || `<div class="pc-empty">Список файлов не указан — скачается вся раздача.</div>`}
        </div>
      </div>
    </div>`;
    box.querySelectorAll(".pc-gallery img").forEach(img => img.addEventListener("error", () => img.remove()));
    cget(`/parser/access/release-cover/${encodeURIComponent(x.id)}`).then(c => {
      const slot = box.querySelector(".pc-dcover");
      if (!c?.url || !slot) { slot?.remove(); return; }
      const img = document.createElement("img");
      img.alt = ""; img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => slot.remove());
      img.src = c.url;
      slot.replaceChildren(img);
    }).catch(() => box.querySelector(".pc-dcover")?.remove());
    const boxes = [...box.querySelectorAll("[data-pc-file]")];
    const all = box.querySelector("[data-pc-fall]");
    const get = box.querySelector("[data-pc-get]");
    const sum = () => {
      const on = boxes.filter(b => b.checked);
      const bytes = on.reduce((n, b) => n + toBytes(files[+b.dataset.pcFile].size), 0);
      box.querySelector("[data-pc-fsum]").textContent = files.length ? `выбрано ${on.length} · ${fmtBytes(bytes)}` : "";
      all.checked = on.length === boxes.length;
      all.indeterminate = on.length > 0 && on.length < boxes.length;
      get.disabled = files.length > 0 && !on.length;
      get.textContent = on.length && on.length < boxes.length ? `Скачать выбранное (${on.length})` : "Скачать";
    };
    all.addEventListener("change", () => { boxes.forEach(b => { b.checked = all.checked; }); sum(); });
    boxes.forEach(b => b.addEventListener("change", sum));
    sum();
    box.onclick = async ev => {
      if (tabClick(ev)) return;
      if (ev.target.closest("[data-pc-rback]")) { showReleases(); return; }
      if (ev.target.closest("[data-pc-get]")) {
        const on = boxes.filter(b => b.checked).map(b => files[+b.dataset.pcFile].path);
        get.disabled = true;
        try {
          const r = await apiPost("/parser/download", { url: x.magnet, name: x.title, ...(on.length < boxes.length ? { files: on } : {}) });
          markQueued(get, r?.job_id, "В очереди");
          if (!r?.job_id) get.textContent = "В очереди";
          toast("Раздача в очереди загрузок: когда будет готова, нажмите «Сохранить»", "success");
          onQueued?.();
        } catch (e) { get.disabled = false; toast(String(e?.message || e), "error"); }
        return;
      }
      if (ev.target.closest("[data-pc-dmagnet]")) {
        try { await invoke("open_magnet", { magnet: x.magnet }); toast("Открыто в торрент-клиенте", "success"); }
        catch (e) { toast(String(e?.message || e), "error"); }
        return;
      }
      if (ev.target.closest("[data-pc-dcopy]")) {
        try { await navigator.clipboard.writeText(x.magnet); toast("Magnet в буфере", "info"); }
        catch { toast("Не вышло скопировать", "error"); }
      }
    };
  }

  const KIND = { video: "Видео", archive: "Архив", audio: "Аудио", other: "Файл" };
  const fmtDur = s => (s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "");
  const ICON = {
    video: `<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h7A2.5 2.5 0 0 1 16 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 4 17.5zM16 10l4-2.5v9L16 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`,
    archive: `<path d="M5 4h14v4H5zM6 8v11a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8M10 12h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`,
    audio: `<path d="M9 18V6l10-2v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm10-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" fill="none" stroke="currentColor" stroke-width="1.8"/>`,
    other: `<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 0v5h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>`,
    link: `<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
    down: `<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    ok: `<path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    ext: `<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  };
  const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name] || ICON.other}</svg>`;

  async function showPost(url, back) {
    const my = ++seq;
    toTop();
    const backBtn = `<button type="button" class="btn sm" data-pp-back>← Назад</button>`;
    box.innerHTML = `<div class="pc-wrap"><div class="pc-bar">${backBtn}</div>${skel("pc-pp-skel", 2)}</div>`;
    box.onclick = ev => { if (ev.target.closest("[data-pp-back]")) back(); };
    let d;
    try {
      d = await cget("/parser/access/post", { url });
    } catch (e) {
      if (my === seq) box.innerHTML = `<div class="pc-wrap"><div class="pc-bar">${backBtn}</div><div class="pc-empty">Пост недоступен: ${esc(e.message || e)}</div></div>`;
      return;
    }
    if (my !== seq) return;
    const a = d.author || {};
    const files = d.files || [];
    const links = d.links || [];
    const imgs = (d.images || []).length ? d.images : [...new Set(files.map(f => f.thumb).filter(Boolean))].map(thumb => ({ thumb }));
    const sizes = files.map(f => f.size || 0);
    const big = i => esc(imgs[i]?.full || imgs[i]?.thumb || "");
    const counts = Object.entries(files.reduce((m, f) => ({ ...m, [f.kind]: (m[f.kind] || 0) + 1 }), {}))
      .map(([k, n]) => `${n} ${{ video: "видео", archive: n === 1 ? "архив" : "архива", audio: "аудио", other: n === 1 ? "файл" : "файла" }[k] || "файл"}`);
    const downloadable = files.length + links.filter(l => l.downloadable).length;
    const longText = (d.text || "").length > 420;

    box.innerHTML = `<div class="pc-wrap">
      <div class="pc-bar">${backBtn}
        <span class="pp-nav">${d.prev ? `<button type="button" class="btn sm" data-pp-go="${esc(d.prev)}">‹ Новее</button>` : ""}${d.next ? `<button type="button" class="btn sm" data-pp-go="${esc(d.next)}">Старше ›</button>` : ""}</span>
      </div>
      <article class="pp${imgs.length ? "" : " no-media"}">
        ${imgs.length ? `<div class="pp-media">
          <button type="button" class="pp-main" data-pp-zoom="0" style="--pp-bg:${esc(cssUrl(imgs[0].thumb))}"><img src="${big(0)}" alt="" referrerpolicy="no-referrer"><span class="pp-zoomhint">Нажмите, чтобы увеличить</span></button>
          ${imgs.length > 1 ? `<div class="pp-strip">${imgs.map((im, i) => `<button type="button" class="pp-th${i ? "" : " on"}" data-pp-pick="${i}"><img src="${esc(im.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join("")}</div>` : ""}
        </div>` : ""}
        <div class="pp-info">
          <button type="button" class="pp-author" data-pp-author="${esc(a.service)}/${esc(a.id)}" title="Все посты автора">
            <img src="${esc(a.icon)}" alt="" referrerpolicy="no-referrer">
            <span><b>${esc(a.name)}</b><small>${esc(a.service_name)} · все посты →</small></span>
          </button>
          <h3 class="pp-title">${esc(d.title)}</h3>
          <div class="pp-chips">
            ${d.published ? `<span class="pp-chip">${esc(fmtDate(d.published))}</span>` : ""}
            ${counts.map(c => `<span class="pp-chip">${esc(c)}</span>`).join("")}
            ${imgs.length && (d.images || []).length ? `<span class="pp-chip">${imgs.length} ${imgs.length === 1 ? "картинка" : "картинок"}</span>` : ""}
            <span class="pp-chip" data-pp-total hidden></span>
            ${(Array.isArray(d.tags) ? d.tags : []).slice(0, 6).map(t => `<span class="pp-chip tag">#${esc(t)}</span>`).join("")}
          </div>
          ${downloadable > 1 ? `<button type="button" class="btn primary pp-all" data-pp-all>${svg("down")}Скачать всё · ${downloadable}</button>` : ""}
          ${files.length ? `<div class="pp-list">${files.map((f, i) => `
            <div class="pp-row" data-kind="${esc(f.kind)}">
              <span class="pp-ico">${svg(f.kind)}</span>
              <span class="pp-rmain"><b title="${esc(f.name)}">${esc(f.name)}</b>
                <small><span data-pp-size="${i}">${f.size ? fmtBytes(f.size) : `<i class="pp-wait">размер…</i>`}</span>${f.duration ? ` · ${fmtDur(f.duration)}` : ""}${f.resolution ? ` · ${esc(f.resolution)}` : ""} · ${esc(KIND[f.kind] || "Файл")} ${esc((f.ext || "").toUpperCase())}</small></span>
              <button type="button" class="pp-get" data-pp-dl="${i}" title="Сервер скачает файл — потом заберёте его в «Очереди и загрузках»">${svg("down")}<span>Скачать</span></button>
            </div>`).join("")}</div>` : ""}
          ${links.length ? `<div class="pp-list">${links.map((l, i) => `
            <div class="pp-row" data-kind="link">
              <span class="pp-ico">${svg("link")}</span>
              <span class="pp-rmain"><b title="${esc(l.url)}">${esc(l.label)}</b><small>${l.downloadable ? "облако — сервер скачает сам" : "внешний сайт"}</small></span>
              ${l.downloadable
                ? `<button type="button" class="pp-get" data-pp-link="${i}">${svg("down")}<span>Скачать</span></button>`
                : `<button type="button" class="pp-get ghost" data-pp-open="${esc(l.url)}">${svg("ext")}<span>Открыть</span></button>`}
            </div>`).join("")}</div>` : ""}
          ${!downloadable ? `<div class="pp-none">В посте нет файлов для загрузки${imgs.length ? " — только картинки" : ""}.</div>` : ""}
          <div class="pp-more"><button type="button" class="btn sm" data-pp-analyze>Открыть в загрузчике</button><button type="button" class="btn sm" data-pp-copy>Скопировать ссылку</button></div>
        </div>
      </article>
      ${d.text ? `<section class="pp-desc${longText ? " clamp" : ""}"><h4>Описание</h4><div class="pp-text">${esc(d.text)}</div>${longText ? `<button type="button" class="pp-expand" data-pp-expand>Показать полностью</button>` : ""}</section>` : ""}
    </div>`;

    box.querySelectorAll(".pp img").forEach(im => im.addEventListener("error", () => {
      if (im.closest(".pp-th")) { im.closest(".pp-th").remove(); return; }
      if (im.closest(".pp-main") && imgs[0]?.thumb && im.src !== imgs[0].thumb) im.src = imgs[0].thumb;
      else if (im.closest(".pp-author")) im.remove();
    }));
    const showTotal = () => {
      const sum = sizes.reduce((n, x) => n + x, 0);
      const el = box.querySelector("[data-pp-total]");
      if (el && sum && sizes.every(Boolean)) { el.textContent = `всего ${fmtBytes(sum)}`; el.hidden = false; }
    };
    showTotal();
    (async () => {
      for (const [i, f] of files.entries()) {
        if (f.size || my !== seq) continue;
        let size = 0;
        try { size = (await cget("/parser/access/file-size", { url: f.url }))?.size || 0; } catch (_) { }
        const el = box.querySelector(`[data-pp-size="${i}"]`);
        if (!el || my !== seq) return;
        el.textContent = size ? fmtBytes(size) : "размер неизвестен";
        sizes[i] = size;
        showTotal();
      }
    })();
    const queue = async (btn, body, quiet = false) => {
      if (btn.classList.contains("done")) return true;
      btn.disabled = true;
      try {
        const r = await apiPost("/parser/download", body);
        btn.classList.add("done");
        markQueued(btn, r?.job_id, `${svg("ok")}<span>В очереди</span>`);
        if (!r?.job_id) btn.innerHTML = `${svg("ok")}<span>В очереди</span>`;
        if (!quiet) { toast("В очереди загрузок: когда будет готово, нажмите «Сохранить»", "success"); onQueued?.(); }
        return true;
      } catch (e) { btn.disabled = false; toast(String(e?.message || e), "error"); return false; }
    };
    const fileBody = f => ({ url: f.url, name: f.name.replace(/\.[^.]+$/, ""), headers: f.headers || {} });
    box.onclick = async ev => {
      const el = ev.target.closest("button");
      if (!el) return;
      if (el.matches("[data-pp-back]")) { back(); return; }
      if (el.dataset.ppGo) { showPost(el.dataset.ppGo, back); return; }
      if (el.dataset.ppAuthor) { const [s, id] = el.dataset.ppAuthor.split("/"); showPosts(s, id, 1); return; }
      if (el.dataset.ppPick) {
        const i = +el.dataset.ppPick;
        const main = box.querySelector(".pp-main");
        main.querySelector("img").src = imgs[i].full || imgs[i].thumb;
        main.style.setProperty("--pp-bg", cssUrl(imgs[i].thumb));
        main.dataset.ppZoom = String(i);
        box.querySelectorAll(".pp-th").forEach((t, k) => t.classList.toggle("on", k === i));
        return;
      }
      if (el.dataset.ppZoom) {
        openZoom(big(+el.dataset.ppZoom));
        return;
      }
      if (el.matches("[data-pp-expand]")) { el.closest(".pp-desc").classList.remove("clamp"); el.remove(); return; }
      if (el.dataset.ppDl) { queue(el, fileBody(files[+el.dataset.ppDl])); return; }
      if (el.dataset.ppLink) { queue(el, { url: links[+el.dataset.ppLink].url, name: d.title }); return; }
      if (el.matches("[data-pp-all]")) {
        el.disabled = true;
        let ok = 0;
        for (const b of box.querySelectorAll("[data-pp-dl], [data-pp-link]")) {
          const body = b.dataset.ppDl ? fileBody(files[+b.dataset.ppDl]) : { url: links[+b.dataset.ppLink].url, name: d.title };
          if (await queue(b, body, true)) ok++;
        }
        el.innerHTML = `${svg("ok")}В очереди · ${ok}`;
        toast(`В очереди загрузок: ${ok}. Когда будут готовы — «Сохранить все готовые»`, "success");
        onQueued?.();
        return;
      }
      if (el.dataset.ppOpen) { openExternal(el.dataset.ppOpen).catch(e => toast(String(e), "error")); return; }
      if (el.matches("[data-pp-analyze]")) { seq++; box.onclick = null; onPick(d.url); return; }
      if (el.matches("[data-pp-copy]")) {
        try { await navigator.clipboard.writeText(d.url); toast("Ссылка в буфере", "info"); } catch { toast("Не вышло скопировать", "error"); }
      }
    };
  }

  async function randomPick(kind) {
    try {
      const r = await apiGet(`/parser/access/random/${kind}`, { site });
      if (kind === "post") showPost(r.url, showFeed); else showPosts(r.service, r.id, 1);
    } catch (e) { toast(String(e?.message || e), "error"); }
  }

  const MODES = [["search", "Новые и поиск"], ["popular", "Популярные"], ["tags", "Теги"]];
  const can = f => { const list = tabLabels.features?.[site]; return !list || list.includes(f); };

  async function showFeed() {
    const my = ++seq;
    if ((fs.mode === "popular" && !can("popular")) || ((fs.mode === "tags" || fs.mode === "tag") && !can("tags"))) fs.mode = "search";
    const head = (extra, sub = "") => `<div class="pc-wrap">${tabs("posts")}
      <div class="pc-bar">
        ${MODES.filter(([m]) => m === "search" || can(m)).map(([m, n]) => `<button type="button" class="btn sm${(fs.mode === m || (m === "tags" && fs.mode === "tag")) ? " primary" : ""}" data-pc-mode="${m}">${n}</button>`).join("")}
        ${can("random") ? `<button type="button" class="btn sm" data-pc-random="post">${DICE}Случайный пост</button>` : ""}
        ${sub}
      </div>${extra}`;
    box.innerHTML = head(`${skel(fs.mode === "tags" ? "pc-tags" : "pc-posts", 12)}</div>`);
    box.onclick = ev => { tabClick(ev); };
    let d;
    try {
      d = fs.mode === "tags" ? await cget("/parser/access/tags", { site })
        : await cget("/parser/access/posts", { mode: fs.mode, q: fs.q, tag: fs.tag, period: fs.period, page: fs.page, site });
      if (fs.mode !== "tags") prefetch("/parser/access/posts", { mode: fs.mode, q: fs.q, tag: fs.tag, period: fs.period, page: fs.page + 1, site });
    } catch (e) {
      if (my === seq) box.innerHTML = head(`<div class="pc-empty">Посты недоступны: ${esc(e.message || e)}</div></div>`);
      return;
    }
    if (my !== seq) return;
    flipNext = false;
    let body, sub = "";
    if (fs.mode === "tags") {
      body = `<div class="pc-tags">${(d.items || []).map(t => `<button type="button" class="pc-tagb" data-pc-tag="${esc(t.tag)}">${esc(t.tag)} <small>${fmtNum(t.count)}</small></button>`).join("") || `<div class="pc-empty">Тегов нет.</div>`}</div>`;
    } else {
      sub = fs.mode === "popular"
        ? `<select class="pc-select" data-pc-period>${(d.periods || []).map(x => `<option value="${esc(x.id)}"${x.id === fs.period ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select><span class="pc-count">${esc(d.range || "")}</span>`
        : fs.mode === "tag" ? `<span class="pc-count">Тег: <b>${esc(fs.tag)}</b></span>`
          : `<input type="search" class="pc-search" placeholder="Текст в названии или описании" value="${esc(fs.q)}" spellcheck="false">`;
      body = `<div class="pc-count">${d.approx ? `Страница ${d.page}` : `Постов: ${fmtNum(d.total)}${d.pages > 1 ? ` · страница ${d.page} из ${fmtNum(d.pages)}` : ""}`}</div>
        ${pager(d.page, d.pages, "data-pc-fpage")}
        <div class="pc-posts">${(d.items || []).map(p => `
          <button type="button" class="pc-post${p.media ? " has-media" : ""}" data-pc-post="${esc(p.url)}" title="${esc(p.title)}">
            <span class="pc-thumb">${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
              ${p.media ? `<span class="pc-flag">${p.media} для загрузки</span>` : ""}</span>
            <b class="pc-ptitle">${esc(p.title)}</b>
            <small><span class="pc-badge" data-svc="${esc(p.service)}">${esc(p.service_name)}</span> ${esc(fmtDate(p.published))}${p.favs ? ` · ♥ ${fmtNum(p.favs)}` : ""}</small>
            <small class="pc-alink" data-pc-author="${esc(p.service)}/${esc(p.user)}">Все посты автора →</small>
          </button>`).join("") || `<div class="pc-empty">Ничего не нашлось.</div>`}</div>
        ${pager(d.page, d.pages, "data-pc-fpage")}`;
    }
    box.innerHTML = head(body + "</div>", sub);
    const search = box.querySelector(".pc-search");
    let timer;
    search?.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { fs.q = search.value.trim(); fs.page = 1; showFeed(); }, 450); });
    box.querySelector("[data-pc-period]")?.addEventListener("change", e => { fs.period = e.target.value; fs.page = 1; showFeed(); });
    box.onclick = ev => {
      if (tabClick(ev)) return;
      if (ev.target.closest("[data-pc-random]")) { randomPick("post"); return; }
      const md = ev.target.closest("[data-pc-mode]");
      if (md) { fs.mode = md.dataset.pcMode; fs.page = 1; showFeed(); return; }
      const tg = ev.target.closest("[data-pc-tag]");
      if (tg) { fs.mode = "tag"; fs.tag = tg.dataset.pcTag; fs.page = 1; showFeed(); return; }
      const pg = ev.target.closest("[data-pc-fpage]");
      if (pg && !pg.disabled) { fs.page = +pg.dataset.pcFpage; toTop(); showFeed(); return; }
      const au = ev.target.closest("[data-pc-author]");
      if (au) { const [service, id] = au.dataset.pcAuthor.split("/"); showPosts(service, id, 1); return; }
      const post = ev.target.closest("[data-pc-post]");
      if (post) { showPost(post.dataset.pcPost, showFeed); }
    };
  }

  async function showAuthors() {
    const my = ++seq;
    box.innerHTML = `<div class="pc-wrap">${tabs("authors")}${skel("pc-grid", 12)}</div>`;
    box.onclick = ev => { tabClick(ev); };
    let d;
    try {
      d = await cget("/parser/access/catalog", { q: st.q, service: st.service, sort: st.sort, page: st.page, site });
      if (st.page < (d.pages || 1)) prefetch("/parser/access/catalog", { q: st.q, service: st.service, sort: st.sort, page: st.page + 1, site });
    } catch (e) {
      if (my === seq) box.innerHTML = `<div class="pc-wrap">${tabs("authors")}<div class="pc-empty">Каталог недоступен: ${esc(e.message || e)}</div></div>`;
      return;
    }
    if (my !== seq) return;
    flipNext = false;
    st.services = d.services || st.services;
    const services = [["", "Все сервисы"], ...st.services.map(s => [s.id, s.name])];
    box.innerHTML = `<div class="pc-wrap">${tabs("authors")}
      <div class="pc-bar">
        <input type="search" class="pc-search" placeholder="Имя автора или id" value="${esc(st.q)}" spellcheck="false">
        <select class="pc-select" data-pc-service>${services.map(([v, n]) => `<option value="${esc(v)}"${v === st.service ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>
        <select class="pc-select" data-pc-sort>${SORTS.map(([v, n]) => `<option value="${v}"${v === st.sort ? " selected" : ""}>${n}</option>`).join("")}</select>
        ${can("random") ? `<button type="button" class="btn sm" data-pc-random="author">${DICE}Случайный</button>` : ""}
      </div>
      <div class="pc-count">Авторов: ${fmtNum(d.total)}${d.pages > 1 ? ` · страница ${d.page} из ${fmtNum(d.pages)}` : ""}</div>
      ${pager(d.page, d.pages, "data-pc-page")}
      <div class="pc-grid">${(d.items || []).map(a => `
        <button type="button" class="pc-card" data-pc-author="${esc(a.service)}/${esc(a.id)}" style="--pc-banner:${esc(cssUrl(a.banner))}">
          <img class="pc-ava" src="${esc(a.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">
          <span class="pc-meta"><span class="pc-badge" data-svc="${esc(a.service)}">${esc(a.service_name)}</span>
            <b class="pc-name">${esc(a.name)}</b><small>♥ ${fmtNum(a.favorited)}</small></span>
        </button>`).join("") || `<div class="pc-empty">Никого не нашлось.</div>`}</div>
      ${pager(d.page, d.pages, "data-pc-page")}
    </div>`;
    const search = box.querySelector(".pc-search");
    let timer;
    search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { st.q = search.value.trim(); st.page = 1; showAuthors(); }, 350); });
    box.querySelector("[data-pc-service]").addEventListener("change", e => { st.service = e.target.value; st.page = 1; showAuthors(); });
    box.querySelector("[data-pc-sort]").addEventListener("change", e => { st.sort = e.target.value; st.page = 1; showAuthors(); });
    box.onclick = ev => {
      if (tabClick(ev)) return;
      const pg = ev.target.closest("[data-pc-page]");
      if (pg) { st.page = +pg.dataset.pcPage; toTop(); showAuthors(); return; }
      if (ev.target.closest("[data-pc-random]")) { randomPick("author"); return; }
      const card = ev.target.closest("[data-pc-author]");
      if (card) { const [service, id] = card.dataset.pcAuthor.split("/"); showPosts(service, id, 1); }
    };
  }

  async function showPosts(service, id, page) {
    const my = ++seq;
    box.innerHTML = `<div class="pc-wrap">${skel("pc-posts", 12)}</div>`;
    let d;
    try {
      d = await cget(`/parser/access/creator/${encodeURIComponent(service)}/${encodeURIComponent(id)}`, { page, site });
      prefetch(`/parser/access/creator/${encodeURIComponent(service)}/${encodeURIComponent(id)}`, { page: page + 1, site });
    } catch (e) {
      if (my === seq) box.innerHTML = `<div class="pc-wrap"><button type="button" class="btn sm" data-pc-back>← К авторам</button><div class="pc-empty">Посты недоступны: ${esc(e.message || e)}</div></div>`;
      box.onclick = ev => { if (ev.target.closest("[data-pc-back]")) showAuthors(); };
      return;
    }
    if (my !== seq) return;
    box.innerHTML = `<div class="pc-wrap">
      <div class="pc-head" style="--pc-banner:${esc(cssUrl(d.banner))}">
        <button type="button" class="btn sm" data-pc-back>← К авторам</button>
        <img class="pc-ava lg" src="${esc(d.icon)}" alt="" referrerpolicy="no-referrer">
        <span class="pc-meta"><span class="pc-badge" data-svc="${esc(d.service)}">${esc(d.service_name)}</span><b class="pc-name">${esc(d.name)}</b>
          <small>${d.total ? `Постов: ${fmtNum(d.total)}` : ""}</small></span>
      </div>
      ${pager(d.page, d.pages, "data-pc-ppage")}
      <div class="pc-posts">${(d.items || []).map(p => `
        <button type="button" class="pc-post${p.media ? " has-media" : ""}" data-pc-post="${esc(p.url)}" title="${esc(p.title)}">
          <span class="pc-thumb">${p.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}
            ${p.media ? `<span class="pc-flag">${p.media} для загрузки</span>` : ""}</span>
          <b class="pc-ptitle">${esc(p.title)}</b>
          <small>${esc(fmtDate(p.published))}${p.files ? ` · файлов: ${p.files}` : ""}</small>
        </button>`).join("") || `<div class="pc-empty">Постов нет.</div>`}</div>
      ${pager(d.page, d.pages, "data-pc-ppage")}
    </div>`;
    box.onclick = ev => {
      if (ev.target.closest("[data-pc-back]")) { showAuthors(); return; }
      const pg = ev.target.closest("[data-pc-ppage]");
      if (pg) { toTop(); showPosts(service, id, +pg.dataset.pcPpage); return; }
      const post = ev.target.closest("[data-pc-post]");
      if (post) { showPost(post.dataset.pcPost, () => showPosts(service, id, page)); }
    };
  }

  try { const v = localStorage.getItem(SITE_KEY); if (v && tabLabels.sources?.[v]) site = v; } catch (_) { }
  let last = "authors";
  try { last = localStorage.getItem(TAB_KEY) || "authors"; } catch (_) { }
  toTop();
  if (last === "releases") showReleases(); else if (last === "posts") showFeed(); else showAuthors();
  setTimeout(() => {
    prefetch("/parser/access/catalog", { q: st.q, service: st.service, sort: st.sort, page: 1, site });
    prefetch("/parser/access/posts", { mode: fs.mode, q: fs.q, tag: fs.tag, period: fs.period, page: 1, site });
    prefetch("/parser/access/releases", { q: rs.q, category: rs.category, sort: rs.sort, page: 1 });
  }, 600);
}
