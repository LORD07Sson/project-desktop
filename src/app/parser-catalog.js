// Загрузчик: каталог авторов закрытого источника. Что за источник и его адреса знает только сервер —
// здесь лишь сетка карточек, посты автора и выбор поста для загрузки.
import { apiGet, apiPost, toast } from "./api.js";
import { invoke } from "./tauri.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssUrl = u => `url("${String(u || "").replace(/["\\\n\r]/g, encodeURIComponent)}")`;
const SORTS = [["favorited", "Популярные"], ["updated", "Обновлённые"], ["name", "По имени"]];
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

const tabs = active => `<div class="pc-tabs">${[["authors", "Авторы"], ["releases", "Раздачи"]].map(([id, n]) =>
  `<button type="button" class="pc-tab${id === active ? " on" : ""}" data-pc-tab="${id}">${n}</button>`).join("")}</div>`;

/** Каталог в box. onPick(url) — выбран пост; onClose() — назад к обычному поиску; onQueued() — задача ушла в очередь. */
export function openCatalog(box, { onPick, onClose, onQueued }) {
  const st = { q: "", service: "", sort: "favorited", page: 1, services: [] };
  const rs = { q: "", category: "", sort: "id", page: 1 };
  let seq = 0;

  function tabClick(ev) {
    const t = ev.target.closest("[data-pc-tab]");
    if (!t) return false;
    if (t.dataset.pcTab === "releases") showReleases(); else showAuthors();
    return true;
  }

  async function showReleases() {
    const my = ++seq;
    box.innerHTML = `<div class="pc-wrap">${tabs("releases")}<div class="pc-empty">Загружаю раздачи…</div></div>`;
    box.onclick = ev => { tabClick(ev); };
    let d;
    try {
      d = await apiGet("/parser/access/releases", { q: rs.q, category: rs.category, sort: rs.sort, page: rs.page });
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
        <button type="button" class="btn sm" data-pc-close>← Поиск по ссылке</button>
        <input type="search" class="pc-search" placeholder="Название, студия, RJ-код" value="${esc(rs.q)}" spellcheck="false">
        <select class="pc-select" data-pc-rcat>${(d.categories || []).map(c => `<option value="${esc(c.id)}"${c.id === rs.category ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
        <select class="pc-select" data-pc-rsort>${(d.sorts || []).map(c => `<option value="${esc(c.id)}"${c.id === rs.sort ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      </div>
      ${nav}
      <div class="pc-rels">${(d.items || []).map((x, i) => `
        <div class="pc-rel${x.trusted ? " trusted" : ""}${x.remake ? " remake" : ""}">
          <span class="pc-cover" data-pc-cover="${esc(x.id)}"></span>
          <span class="pc-rbody">
            <span class="pc-badge">${esc(x.category_name)}</span>
            <b class="pc-ptitle" title="${esc(x.title)}">${esc(x.title)}</b>
            <small class="pc-rstats"><span>${esc(x.size)}</span><span class="up">▲ ${x.seeders}</span><span class="down">▼ ${x.leechers}</span><span>⬇ ${fmtNum(x.downloads)}</span><span>${esc(fmtTs(x.published))}</span></small>
            <span class="pc-ract"><button type="button" class="btn sm primary" data-pc-server="${i}" title="Сервер скачает раздачу через VPN, потом заберёте файл из «Очереди и загрузок»">Скачать</button><button type="button" class="btn sm" data-pc-magnet="${i}">В торрент-клиент</button><button type="button" class="btn sm" data-pc-copy="${i}">Magnet</button></span>
          </span>
        </div>`).join("") || `<div class="pc-empty">Ничего не нашлось.</div>`}</div>
      ${nav}
    </div>`;
    const search = box.querySelector(".pc-search");
    let timer;
    search.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { rs.q = search.value.trim(); rs.page = 1; showReleases(); }, 450); });
    box.querySelector("[data-pc-rcat]").addEventListener("change", e => { rs.category = e.target.value; rs.page = 1; showReleases(); });
    box.querySelector("[data-pc-rsort]").addEventListener("change", e => { rs.sort = e.target.value; rs.page = 1; showReleases(); });
    // Обложки — по мере появления карточек на экране: сервер достаёт картинку из описания раздачи.
    const io = new window.IntersectionObserver(entries => entries.forEach(en => {
      if (!en.isIntersecting) return;
      io.unobserve(en.target);
      apiGet(`/parser/access/release-cover/${encodeURIComponent(en.target.dataset.pcCover)}`)
        .then(c => { if (c?.url && en.target.isConnected) en.target.innerHTML = `<img src="${esc(c.url)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`; })
        .catch(() => { /* без обложки */ });
    }), { rootMargin: "200px" });
    box.querySelectorAll("[data-pc-cover]").forEach(el => io.observe(el));
    box.onclick = async ev => {
      if (tabClick(ev)) return;
      if (ev.target.closest("[data-pc-close]")) { seq++; box.onclick = null; onClose(); return; }
      const pg = ev.target.closest("[data-pc-rpage]");
      if (pg && !pg.disabled) { rs.page = +pg.dataset.pcRpage; showReleases(); return; }
      const sv = ev.target.closest("[data-pc-server]");
      if (sv) {
        // Раздачу качает сервер (до 20 ГБ), готовый файл сохраняется из очереди и удаляется с сервера.
        const x = d.items[+sv.dataset.pcServer];
        sv.disabled = true;
        try {
          await apiPost("/parser/download", { url: x.magnet, name: x.title });
          sv.textContent = "В очереди";
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

  async function showAuthors() {
    const my = ++seq;
    box.innerHTML = `<div class="pc-wrap"><div class="pc-empty">Загружаю каталог…</div></div>`;
    let d;
    try {
      d = await apiGet("/parser/access/catalog", { q: st.q, service: st.service, sort: st.sort, page: st.page });
    } catch (e) {
      if (my === seq) box.innerHTML = `<div class="pc-wrap"><div class="pc-empty">Каталог недоступен: ${esc(e.message || e)}</div></div>`;
      return;
    }
    if (my !== seq) return;
    st.services = d.services || st.services;
    const services = [["", "Все сервисы"], ...st.services.map(s => [s.id, s.name])];
    box.innerHTML = `<div class="pc-wrap">${tabs("authors")}
      <div class="pc-bar">
        <button type="button" class="btn sm" data-pc-close>← Поиск по ссылке</button>
        <input type="search" class="pc-search" placeholder="Имя автора или id" value="${esc(st.q)}" spellcheck="false">
        <select class="pc-select" data-pc-service>${services.map(([v, n]) => `<option value="${esc(v)}"${v === st.service ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>
        <select class="pc-select" data-pc-sort>${SORTS.map(([v, n]) => `<option value="${v}"${v === st.sort ? " selected" : ""}>${n}</option>`).join("")}</select>
      </div>
      <div class="pc-count">Авторов: ${fmtNum(d.total)}${d.pages > 1 ? ` · страница ${d.page} из ${fmtNum(d.pages)}` : ""}</div>
      ${pager(d.page, d.pages, "data-pc-page")}
      <div class="pc-grid">${(d.items || []).map(a => `
        <button type="button" class="pc-card" data-pc-author="${esc(a.service)}/${esc(a.id)}" style="--pc-banner:${esc(cssUrl(a.banner))}">
          <img class="pc-ava" src="${esc(a.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">
          <span class="pc-meta"><span class="pc-badge" data-svc="${esc(a.service)}">${esc(a.service_name)}</span>
            <b class="pc-name">${esc(a.name)}</b><small>${fmtNum(a.favorited)} в избранном</small></span>
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
      if (ev.target.closest("[data-pc-close]")) { seq++; box.onclick = null; onClose(); return; }
      const pg = ev.target.closest("[data-pc-page]");
      if (pg) { st.page = +pg.dataset.pcPage; showAuthors(); return; }
      const card = ev.target.closest("[data-pc-author]");
      if (card) { const [service, id] = card.dataset.pcAuthor.split("/"); showPosts(service, id, 1); }
    };
  }

  async function showPosts(service, id, page) {
    const my = ++seq;
    box.innerHTML = `<div class="pc-wrap"><div class="pc-empty">Загружаю посты…</div></div>`;
    let d;
    try {
      d = await apiGet(`/parser/access/creator/${encodeURIComponent(service)}/${encodeURIComponent(id)}`, { page });
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
      if (pg) { showPosts(service, id, +pg.dataset.pcPpage); return; }
      const post = ev.target.closest("[data-pc-post]");
      if (post) { seq++; box.onclick = null; onPick(post.dataset.pcPost); }
    };
  }

  showAuthors();
}
