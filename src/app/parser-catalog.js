// Загрузчик: каталог авторов закрытого источника. Что за источник и его адреса знает только сервер —
// здесь лишь сетка карточек, посты автора и выбор поста для загрузки.
import { apiGet } from "./api.js";

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

/** Каталог в box. onPick(url) — выбран пост; onClose() — назад к обычному поиску. */
export function openCatalog(box, { onPick, onClose }) {
  const st = { q: "", service: "", sort: "favorited", page: 1, services: [] };
  let seq = 0;

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
    box.innerHTML = `<div class="pc-wrap">
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
