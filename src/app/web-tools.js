// «Тексты песен» — поиск текста в LRCLIB, просмотр по строкам, сохранение
// .lrc и копирование. Загрузка идёт через Rust (fetch_text): CSP окна чужие
// сайты не пускает, а сама команда принимает только публичные https-адреса.
// Разбор — web-tools-core.js.

import { invoke, pickOutputFile } from "./tauri.js";
import { openSheet, toast } from "./api.js";
import { $, esc } from "./utils.js";
import { parseLrc } from "./web-tools-core.js";

const fetchText = url => invoke("fetch_text", { url });
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const lyr = { q: "", results: [], picked: null };

function listHtml() {
  return lyr.results.length ? lyr.results.map((r, i) => `
        <button class="wt-item ${lyr.picked === i ? "on" : ""}" data-pick="${i}">
          <b>${esc(r.trackName || "—")}</b><span>${esc(r.artistName || "")}${r.duration ? ` · ${fmtTime(r.duration)}` : ""}${r.syncedLyrics ? " · по строкам" : ""}</span>
        </button>`).join("") : `<div class="wt-empty">Введите запрос и нажмите «Найти».</div>`;
}

function lyricsHtml() {
  return `
    <div class="wt-row">
      <input id="wt-lyr-q" class="field-input" placeholder="Исполнитель и название, например: M83 Midnight City" value="${esc(lyr.q)}">
      <button class="btn primary" id="wt-lyr-go">Найти</button>
    </div>
    <div class="wt-split">
      <div class="wt-list" id="wt-lyr-list">${listHtml()}</div>
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

// Перерисовка не трогает поле поиска: меняются только список и текст.
function renderResults(overlay) {
  overlay.querySelector("#wt-lyr-list").innerHTML = listHtml();
  overlay.querySelector("#wt-lyr-text").innerHTML = lyr.picked != null ? lyricsBody(lyr.results[lyr.picked]) : "";
  wireResults(overlay);
}

function wireResults(overlay) {
  overlay.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => {
    lyr.picked = Number(b.dataset.pick);
    renderResults(overlay);
  }));
  overlay.querySelector("#wt-lyr-copy")?.addEventListener("click", async () => {
    const r = lyr.results[lyr.picked];
    const text = parseLrc(r.syncedLyrics || r.plainLyrics || "").map(l => l.text).join("\n");
    try { await navigator.clipboard.writeText(text); toast("Текст скопирован.", "success"); } catch (_) { toast("Не удалось скопировать.", "error"); }
  });
  overlay.querySelector("#wt-lyr-save")?.addEventListener("click", async () => {
    const r = lyr.results[lyr.picked];
    const name = `${r.artistName || "track"} - ${r.trackName || "lyrics"}`.replace(/[\\/:*?"<>|]/g, "_");
    const out = await pickOutputFile(`${name}.lrc`, [{ name: "LRC", extensions: ["lrc"] }]);
    if (!out) return;
    try { await invoke("write_text_file", { path: out, content: r.syncedLyrics }); toast("Файл .lrc сохранён.", "success"); }
    catch (e) { toast(`Не удалось сохранить: ${e}`, "error"); }
  });
}

function wireLyrics(overlay) {
  const q = overlay.querySelector("#wt-lyr-q");
  const go = async () => {
    lyr.q = q.value.trim();
    if (!lyr.q) return;
    try {
      const raw = await fetchText(`https://lrclib.net/api/search?q=${encodeURIComponent(lyr.q)}`);
      lyr.results = (JSON.parse(raw) || []).slice(0, 12);
      lyr.picked = lyr.results.length ? 0 : null;
      if (!lyr.results.length) toast("Ничего не нашлось.", "error");
    } catch (e) { toast(`Не удалось найти: ${e}`, "error"); }
    renderResults(overlay);
  };
  overlay.querySelector("#wt-lyr-go").addEventListener("click", go);
  q.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  wireResults(overlay);
}

export function openLyrics() {
  const overlay = openSheet(`
    <div class="mt-head">
      <div><span class="kd-label">Музыка</span><h2>Тексты песен</h2></div>
      <button class="icon-btn mt-head-close" data-close title="Закрыть" aria-label="Закрыть"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    </div>
    <div id="wt-body">${lyricsHtml()}</div>`, "wide");
  overlay.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
  wireLyrics(overlay);
}

$("#open-web-tools")?.addEventListener("click", openLyrics);
