// Вкладка «Ещё → Парсер»: ввод URL, поиск видео на любой странице (yt-dlp + HTML-скрапинг),
// список найденных потоков с качеством, прямая загрузка mp4 через сервер.
// Доступно только владельцу — бэкенд (miniapp/parser_api.py) режет 403, здесь только косметика.

import { state } from "./state.js";
import { clientHeaders, API_BASE, toast } from "./api.js";
import { $ } from "./utils.js";

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtSize(b) {
  if (!b) return "";
  const m = b / 1024 / 1024;
  return m > 1 ? `${m.toFixed(1)} МБ` : `${(b / 1024).toFixed(0)} КБ`;
}

function fmtDur(s) {
  if (!s) return "";
  const n = Math.round(s), h = (n / 3600) | 0, m = ((n % 3600) / 60) | 0, sec = n % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

function layout() {
  return `
    <div class="pr-wrap">
      <div class="pr-head">
        <h2>Парсер видео</h2>
        <small>Любая ссылка: yt-dlp + разбор HTML ищут потоки, кнопка «Скачать» тянет mp4 через сервер.</small>
      </div>
      <form class="pr-form" id="pr-form">
        <input id="pr-url" type="url" placeholder="https://… ссылка на страницу с видео" autocomplete="off" required>
        <button class="btn primary" type="submit" id="pr-submit">Найти</button>
      </form>
      <div class="pr-status" id="pr-status" hidden></div>
      <div class="pr-results" id="pr-results"></div>
    </div>
  `;
}

export async function loadParser() {
  const body = $("#parser-body");
  if (!body) return;
  if (!state.isOwner) {
    body.innerHTML = `<div class="pr-wrap"><div class="empty">Раздел доступен только владельцу.</div></div>`;
    return true;
  }
  body.innerHTML = layout();
  const form = $("#pr-form");
  const input = $("#pr-url");
  const submit = $("#pr-submit");
  const status = $("#pr-status");
  const results = $("#pr-results");

  form.addEventListener("submit", async e => {
    e.preventDefault();
    const url = input.value.trim();
    if (!url) return;
    submit.disabled = true;
    submit.textContent = "Ищу…";
    status.hidden = false;
    status.textContent = "Анализ: yt-dlp + разбор HTML…";
    results.innerHTML = "";
    try {
      // Анализ может длиться дольше обычного 20-секундного таймаута apiPost
      // (yt-dlp + скрапинг нескольких iframes), поэтому fetch напрямую, без таймаута.
      const res = await fetch(`${API_BASE}/parser/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...clientHeaders() },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j.detail) msg = j.detail; } catch (_) { /* не json */ }
        throw new Error(msg);
      }
      renderResults(await res.json());
    } catch (err) {
      status.textContent = `Ошибка: ${err.message || err}`;
      toast(`Парсер: ${err.message || err}`, "error");
    } finally {
      submit.disabled = false;
      submit.textContent = "Найти";
    }
  });

  function renderResults(r) {
    const diag = (r.diagnostics || []).map(d =>
      `<span class="pr-chip ${d.ok ? "ok" : "no"}">L${d.level} ${esc(d.name)}: ${d.ok ? (d.count ?? 0) + " найдено" : "—"}</span>`).join("");
    const head = `
      <div class="pr-meta">
        ${r.title ? `<div class="pr-title">${esc(r.title)}</div>` : ""}
        ${r.duration ? `<div class="pr-dur">${fmtDur(r.duration)}</div>` : ""}
        <div class="pr-diag">${diag}</div>
      </div>`;
    if (!r.candidates || !r.candidates.length) {
      results.innerHTML = head + `<div class="empty">Видео на странице не найдено.</div>`;
      status.hidden = true;
      return;
    }
    const rows = r.candidates.map((c, i) => {
      const q = typeof c.quality === "number" ? `${c.quality}p` : esc(c.quality || "?");
      const protoExt = [c.protocol, c.ext].filter(Boolean).join(" · ");
      const size = fmtSize(c.filesize);
      return `
        <div class="pr-row" data-idx="${i}">
          <div class="pr-col pr-q">${q}</div>
          <div class="pr-col pr-info">
            <div class="pr-src">${esc(c.source || "")} ${protoExt ? `· ${esc(protoExt)}` : ""} ${size ? `· ${size}` : ""}</div>
            <div class="pr-url" title="${esc(c.url)}">${esc(c.url)}</div>
          </div>
          <div class="pr-col pr-actions">
            <button type="button" class="btn sm" data-copy="${i}">Копировать</button>
            <button type="button" class="btn sm primary" data-dl="${i}">Скачать</button>
          </div>
        </div>`;
    }).join("");
    results.innerHTML = head + `<div class="pr-list">${rows}</div>`;
    status.hidden = true;

    // Один живой обработчик на блок: innerHTML пересоздаёт разметку, а .onclick
    // перезаписывается без накопления старых закрытий со stale r.candidates.
    results.onclick = async ev => {
      const cp = ev.target.closest("[data-copy]");
      const dl = ev.target.closest("[data-dl]");
      if (cp) {
        const c = r.candidates[+cp.dataset.copy];
        try { await navigator.clipboard.writeText(c.url); toast("Ссылка в буфере", "info"); } catch { toast("Не вышло скопировать", "error"); }
      } else if (dl) {
        const i = +dl.dataset.dl;
        const c = r.candidates[i];
        dl.disabled = true;
        dl.textContent = "Качаю…";
        try {
          await downloadCandidate(c, r.title);
        } catch (err) {
          toast(`Загрузка: ${err.message || err}`, "error");
        } finally {
          dl.disabled = false;
          dl.textContent = "Скачать";
        }
      }
    };
  }

  async function downloadCandidate(c, title) {
    const res = await fetch(`${API_BASE}/parser/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...clientHeaders() },
      body: JSON.stringify({ url: c.url, headers: c.headers || {}, name: title || "video" }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j.detail) msg = j.detail; } catch (_) { /* не json */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const cd = res.headers.get("Content-Disposition") || "";
    const fn = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    const name = fn ? decodeURIComponent(fn[1]) : `${(title || "video").replace(/[^\w\-. ]+/g, "_").slice(0, 100)}.mp4`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    toast(`Скачано: ${name}`, "ok");
  }

  return true;
}
