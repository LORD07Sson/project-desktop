// «Ленты и тексты» — три вкладки: тексты песен (LRCLIB), RSS-ленты
// (в том числе публичные ленты релизов) и курс валют ЦБ. Загрузка идёт
// через Rust (fetch_text): CSP окна чужие сайты не пускает, а сама
// команда принимает только публичные https-адреса. Разбор — в
// web-tools-core.js.

import { invoke, openExternal, pickOutputFile } from "./tauri.js";
import { openSheet, toast } from "./api.js";
import { state } from "./state.js";
import { $, esc } from "./utils.js";
import { parseLrc, parseFeed, isFeedUrl, parseCbr, parseRelease, freshItems } from "./web-tools-core.js";
import { notifyDesktop } from "./desktop-notify.js";

const FEEDS_KEY = "project-feeds";
const DEFAULT_FEEDS = [];

const loadFeeds = () => {
  try { const v = JSON.parse(localStorage.getItem(FEEDS_KEY) || "null"); return Array.isArray(v) ? v : DEFAULT_FEEDS; }
  catch (_) { return DEFAULT_FEEDS; }
};
const saveFeeds = list => { try { localStorage.setItem(FEEDS_KEY, JSON.stringify(list)); } catch (_) { /* не запомнится */ } };

const fetchText = url => invoke("fetch_text", { url });

const TABS = [["lyrics", "Тексты песен"], ["feeds", "Ленты"], ["rates", "Курсы валют"]];
let activeTab = "lyrics";

const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ---------- тексты песен ----------
const lyr = { q: "", results: [], picked: null };

function lyricsHtml() {
  return `
    <div class="wt-row">
      <input id="wt-lyr-q" class="field-input" placeholder="Исполнитель и название, например: M83 Midnight City" value="${esc(lyr.q)}">
      <button class="btn primary" id="wt-lyr-go">Найти</button>
    </div>
    <div class="wt-split">
      <div class="wt-list" id="wt-lyr-list">${lyr.results.length ? lyr.results.map((r, i) => `
        <button class="wt-item ${lyr.picked === i ? "on" : ""}" data-pick="${i}">
          <b>${esc(r.trackName || "—")}</b><span>${esc(r.artistName || "")}${r.duration ? ` · ${fmtTime(r.duration)}` : ""}${r.syncedLyrics ? " · по строкам" : ""}</span>
        </button>`).join("") : `<div class="wt-empty">Введите запрос и нажмите «Найти».</div>`}</div>
      <div class="wt-text" id="wt-lyr-text">${lyr.picked != null ? lyricsBody(lyr.results[lyr.picked]) : ""}</div>
    </div>`;
}

function lyricsBody(r) {
  if (!r) return "";
  const lines = r.syncedLyrics ? parseLrc(r.syncedLyrics) : parseLrc(r.plainLyrics || "");
  if (!lines.length) return `<div class="wt-empty">Для этого трека текста нет.</div>`;
  return `<div class="wt-tools">${r.syncedLyrics ? `<button class="btn ghost" id="wt-lyr-save">Сохранить .lrc</button>` : ""}<button class="btn ghost" id="wt-lyr-copy">Копировать текст</button></div>
    ${lines.map(l => `<div class="wt-line">${l.at != null ? `<i>${fmtTime(l.at)}</i>` : ""}${esc(l.text)}</div>`).join("")}`;
}

function wireLyrics(root) {
  const q = root.querySelector("#wt-lyr-q");
  const go = async () => {
    lyr.q = q.value.trim();
    if (!lyr.q) return;
    try {
      const raw = await fetchText(`https://lrclib.net/api/search?q=${encodeURIComponent(lyr.q)}`);
      lyr.results = (JSON.parse(raw) || []).slice(0, 12);
      lyr.picked = lyr.results.length ? 0 : null;
      if (!lyr.results.length) toast("Ничего не нашлось.", "error");
    } catch (e) { toast(`Не удалось найти: ${e}`, "error"); }
    render(root);
  };
  root.querySelector("#wt-lyr-go").addEventListener("click", go);
  q.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  root.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => { lyr.picked = Number(b.dataset.pick); render(root); }));
  root.querySelector("#wt-lyr-copy")?.addEventListener("click", async () => {
    const r = lyr.results[lyr.picked];
    const text = parseLrc(r.syncedLyrics || r.plainLyrics || "").map(l => l.text).join("\n");
    try { await navigator.clipboard.writeText(text); toast("Текст скопирован.", "success"); } catch (_) { toast("Не удалось скопировать.", "error"); }
  });
  root.querySelector("#wt-lyr-save")?.addEventListener("click", async () => {
    const r = lyr.results[lyr.picked];
    const name = `${r.artistName || "track"} - ${r.trackName || "lyrics"}`.replace(/[\\/:*?"<>|]/g, "_");
    const out = await pickOutputFile(`${name}.lrc`, [{ name: "LRC", extensions: ["lrc"] }]);
    if (!out) return;
    try { await invoke("write_text_file", { path: out, content: r.syncedLyrics }); toast("Файл .lrc сохранён.", "success"); }
    catch (e) { toast(`Не удалось сохранить: ${e}`, "error"); }
  });
}

// ---------- ленты ----------
const feedState = { feeds: loadFeeds(), cur: 0, items: [], loading: false, filter: "" };

function feedsHtml() {
  const f = feedState.feeds;
  const items = feedState.items.filter(i => !feedState.filter || i.title.toLowerCase().includes(feedState.filter.toLowerCase()));
  return `
    <div class="wt-row">
      <input id="wt-feed-url" class="field-input" placeholder="Ссылка на ленту https://…/rss">
      <button class="btn primary" id="wt-feed-add">Добавить</button>
    </div>
    <div class="wt-chips">${f.length ? f.map((x, i) => `<span class="wt-chip ${i === feedState.cur ? "on" : ""}" data-feed="${i}">${esc(x.title || x.url)}<button data-feed-del="${i}" aria-label="Убрать">×</button></span>`).join("") : `<span class="wt-empty">Лент пока нет. Вставьте ссылку на RSS или Atom.</span>`}</div>
    ${f.length ? `<div class="wt-row"><input id="wt-feed-watch" class="field-input" placeholder="Следить: слова через пробел (например, night watch 1080p)" value="${esc(f[feedState.cur]?.watch || "")}"><label class="wt-watch"><input type="checkbox" id="wt-feed-watch-on" ${f[feedState.cur]?.watchOn ? "checked" : ""}> сообщать о новых</label></div>` : ""}
    ${f.length ? `<div class="wt-row"><input id="wt-feed-filter" class="field-input" placeholder="Фильтр по словам" value="${esc(feedState.filter)}"><button class="btn ghost" id="wt-feed-refresh">${feedState.loading ? "Загрузка…" : "Обновить"}</button></div>` : ""}
    <div class="wt-list tall">${items.length ? items.map(i => `
      <div class="wt-item static"><b>${esc(i.title)}</b>
        <span>${releaseChips(i.title)}${esc(i.date || "")}${i.extra.size ? ` · ${esc(i.extra.size)}` : ""}${i.extra.seeders ? ` · раздающих ${esc(i.extra.seeders)}` : ""}</span>
        ${i.link ? `<button class="btn ghost" data-open="${esc(i.link)}">Открыть страницу</button>` : ""}
      </div>`).join("") : (f.length ? `<div class="wt-empty">${feedState.loading ? "Загрузка…" : "Записей нет."}</div>` : "")}</div>
    <p class="wt-note">Ленты только показывают заголовки и ссылки. Права на материалы проверяйте сами — программа ничего не скачивает.</p>`;
}

function releaseChips(title) {
  const r = parseRelease(title);
  const parts = [r.group && `[${r.group}]`, r.episode != null && `серия ${r.episode}`, r.resolution, r.codec, r.source].filter(Boolean);
  return parts.length ? `<em class="wt-rel">${parts.map(esc).join(" · ")}</em> ` : "";
}

// ---------- слежение за лентами ----------
const WATCH_EVERY_MS = 30 * 60 * 1000;
const SEEN_MAX = 400;

async function checkWatchedFeeds() {
  if (!state.token) return;
  let changed = false;
  for (const f of feedState.feeds) {
    if (!f.watchOn) continue;
    try {
      const items = parseFeed(await fetchText(f.url));
      const seen = new Set(f.seen || []);
      const first = !f.seen;
      const fresh = first ? [] : freshItems(items, seen, f.watch);
      items.forEach(i => seen.add(i.link || i.title));
      f.seen = [...seen].slice(-SEEN_MAX);
      changed = true;
      if (fresh.length) {
        const text = fresh.length === 1 ? fresh[0].title : `${fresh[0].title} и ещё ${fresh.length - 1}`;
        toast(`Новое в ленте: ${text}`, "success");
        notifyDesktop("Новое в ленте", text);
      }
    } catch (_) { /* лента недоступна — попробуем в следующий раз */ }
  }
  if (changed) saveFeeds(feedState.feeds);
}
setTimeout(checkWatchedFeeds, 20_000);
setInterval(checkWatchedFeeds, WATCH_EVERY_MS);

async function loadFeed(root) {
  const f = feedState.feeds[feedState.cur];
  if (!f) return;
  feedState.loading = true; render(root);
  try {
    feedState.items = parseFeed(await fetchText(f.url)).slice(0, 80);
    if (!f.title) { f.title = new URL(f.url).hostname; saveFeeds(feedState.feeds); }
  } catch (e) { feedState.items = []; toast(`Лента не загрузилась: ${e}`, "error"); }
  feedState.loading = false; render(root);
}

function wireFeeds(root) {
  const add = async () => {
    const url = root.querySelector("#wt-feed-url").value.trim();
    if (!isFeedUrl(url)) { toast("Нужна ссылка https:// на ленту.", "error"); return; }
    if (!feedState.feeds.some(x => x.url === url)) feedState.feeds.push({ url, title: "" });
    feedState.cur = feedState.feeds.findIndex(x => x.url === url);
    saveFeeds(feedState.feeds);
    await loadFeed(root);
  };
  root.querySelector("#wt-feed-add").addEventListener("click", add);
  root.querySelector("#wt-feed-url").addEventListener("keydown", e => { if (e.key === "Enter") add(); });
  root.querySelectorAll("[data-feed]").forEach(c => c.addEventListener("click", e => {
    if (e.target.closest("[data-feed-del]")) return;
    feedState.cur = Number(c.dataset.feed); loadFeed(root);
  }));
  root.querySelectorAll("[data-feed-del]").forEach(b => b.addEventListener("click", () => {
    feedState.feeds.splice(Number(b.dataset.feedDel), 1);
    feedState.cur = 0; feedState.items = []; saveFeeds(feedState.feeds); render(root);
  }));
  root.querySelector("#wt-feed-refresh")?.addEventListener("click", () => loadFeed(root));
  const watchWords = root.querySelector("#wt-feed-watch");
  const watchOn = root.querySelector("#wt-feed-watch-on");
  const saveWatch = () => {
    const f = feedState.feeds[feedState.cur];
    if (!f) return;
    f.watch = watchWords.value.trim();
    f.watchOn = watchOn.checked;
    if (!f.watchOn) delete f.seen;
    saveFeeds(feedState.feeds);
  };
  watchWords?.addEventListener("input", saveWatch);
  watchOn?.addEventListener("change", saveWatch);
  const flt = root.querySelector("#wt-feed-filter");
  flt?.addEventListener("input", () => {
    feedState.filter = flt.value;
    const pos = flt.selectionStart; render(root);
    const again = root.querySelector("#wt-feed-filter"); again.focus(); again.setSelectionRange(pos, pos);
  });
  root.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => openExternal(b.dataset.open)));
}

// ---------- курсы ----------
const rates = { list: null, error: "" };

function ratesHtml() {
  if (rates.error) return `<div class="wt-empty">${esc(rates.error)} <button class="btn ghost" id="wt-rates-go">Повторить</button></div>`;
  if (!rates.list) return `<div class="wt-empty">Загрузка…</div>`;
  return `<div class="wt-rates">${rates.list.map(r => `
    <div class="wt-rate"><b>${esc(r.code)}</b><span>${esc(r.name)}</span><strong>${r.value.toFixed(2)} ₽</strong>
      <em class="${r.change >= 0 ? "up" : "down"}">${r.change >= 0 ? "▲" : "▼"} ${Math.abs(r.change).toFixed(2)}</em></div>`).join("")}</div>
    <p class="wt-note">Курс Центрального банка на сегодня, для пересчёта ставок и счетов.</p>`;
}

async function loadRates(root) {
  rates.error = ""; rates.list = null; render(root);
  try { rates.list = parseCbr(JSON.parse(await fetchText("https://www.cbr-xml-daily.ru/daily_json.js"))); }
  catch (e) { rates.error = `Курс не загрузился: ${e}`; }
  render(root);
}

// ---------- каркас ----------
function render(root) {
  const body = root.querySelector("#wt-body");
  body.innerHTML = activeTab === "lyrics" ? lyricsHtml() : activeTab === "feeds" ? feedsHtml() : ratesHtml();
  root.querySelectorAll(".mt-op-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === activeTab));
  if (activeTab === "lyrics") wireLyrics(body);
  else if (activeTab === "feeds") wireFeeds(body);
  else body.querySelector("#wt-rates-go")?.addEventListener("click", () => loadRates(root));
}

export function openWebTools() {
  const overlay = openSheet(`
    <div class="mt-head">
      <div><span class="kd-label">Интернет</span><h2>Ленты и тексты</h2></div>
      <button class="icon-btn mt-head-close" data-close title="Закрыть" aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div class="mt-op-tabs">${TABS.map(([k, l]) => `<button class="mt-op-tab ${k === activeTab ? "active" : ""}" data-tab="${k}">${l}</button>`).join("")}</div>
    <div id="wt-body"></div>`, "wide");
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  overlay.querySelectorAll(".mt-op-tab").forEach(b => b.addEventListener("click", () => {
    activeTab = b.dataset.tab;
    render(overlay);
    if (activeTab === "rates" && !rates.list && !rates.error) loadRates(overlay);
    if (activeTab === "feeds" && feedState.feeds.length && !feedState.items.length && !feedState.loading) loadFeed(overlay);
  }));
  render(overlay);
  if (activeTab === "rates" && !rates.list) loadRates(overlay);
}

$("#open-web-tools")?.addEventListener("click", openWebTools);
