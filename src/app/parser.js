import { can } from "./state.js";
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
        <small>Любая ссылка: yt-dlp + разбор HTML ищут потоки. Глубокий анализ — запустить headless-браузер и перехватить сеть (медленнее, но берёт сайты с JS-плеерами).</small>
      </div>
      <form class="pr-form" id="pr-form">
        <input id="pr-url" type="url" placeholder="https://… ссылка на страницу с видео" autocomplete="off" required>
        <button class="btn primary" type="submit" id="pr-submit">Найти</button>
        <button class="btn" type="button" id="pr-deep" title="Открыть страницу в headless-браузере и перехватить сеть">Глубокий анализ</button>
      </form>
      <div class="pr-status" id="pr-status" hidden></div>
      <div class="pr-results" id="pr-results"></div>
    </div>
  `;
}

export async function loadParser() {
  const body = $("#parser-body");
  if (!body) return;
  if (!can("parser.use")) {
    body.innerHTML = `<div class="pr-wrap"><div class="empty">Нет права «Парсер видео». Его выдаёт владелец в настройках ролей.</div></div>`;
    return true;
  }
  body.innerHTML = layout();
  const form = $("#pr-form");
  const input = $("#pr-url");
  const submit = $("#pr-submit");
  const deepBtn = $("#pr-deep");
  const status = $("#pr-status");
  const results = $("#pr-results");

  form.addEventListener("submit", e => { e.preventDefault(); analyze(false); });
  deepBtn.addEventListener("click", () => analyze(true));

  async function analyze(deep) {
    const url = input.value.trim();
    if (!url) return;
    submit.disabled = deepBtn.disabled = true;
    (deep ? deepBtn : submit).textContent = deep ? "Браузер…" : "Ищу…";
    status.hidden = false;
    status.textContent = deep
      ? "Глубокий анализ: запускаю headless-Chromium, 10–15 секунд…"
      : "Анализ: yt-dlp + разбор HTML…";
    results.innerHTML = "";
    try {
      const res = await fetch(`${API_BASE}/parser/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...clientHeaders() },
        body: JSON.stringify({ url, deep }),
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
      submit.disabled = deepBtn.disabled = false;
      submit.textContent = "Найти";
      deepBtn.textContent = "Глубокий анализ";
    }
  }

  function renderResults(r) {
    const diag = (r.diagnostics || []).map(d =>
      `<span class="pr-chip ${d.ok ? "ok" : "no"}">L${d.level} ${esc(d.name)}: ${d.ok ? (d.count ?? 0) + " найдено" : "—"}</span>`).join("");
    const head = `
      <div class="pr-meta">
        ${r.title ? `<div class="pr-title">${esc(r.title)}</div>` : ""}
        ${r.duration ? `<div class="pr-dur">${fmtDur(r.duration)}</div>` : ""}
        <div class="pr-diag">${diag}</div>
      </div>`;

    const rowsHtml = (r.candidates || []).map((c, i) => {
      const q = typeof c.quality === "number" ? `${c.quality}p` : esc(c.quality || "?");
      const protoExt = [c.protocol, c.ext].filter(Boolean).join(" · ");
      const size = fmtSize(c.filesize);
      return `
        <div class="pr-row">
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

    const candidatesBlock = (r.candidates && r.candidates.length)
      ? `<div class="pr-list">${rowsHtml}</div>`
      : `<div class="empty">Автоматически видео не найдено.${r.deep ? "" : " Попробуйте «Глубокий анализ»."}</div>`;

    const allReqs = (r.requests || []).filter(x => x.status && x.status < 400);
    const reqs = [
      ...allReqs.filter(x => x.media),
      ...allReqs.filter(x => !x.media),
    ];
    const reqRows = reqs.map((x, i) => {
      const ct = (x.content_type || "").split(";")[0];
      const size = fmtSize(x.size);
      return `
        <div class="pr-req${x.media ? " on" : ""}">
          <div class="pr-req-ct">${x.media ? "🎬 " : ""}${esc(ct)}${size ? ` · ${size}` : ""}</div>
          <div class="pr-req-url" title="${esc(x.url)}">${esc(x.url)}</div>
          <div class="pr-req-actions">
            <button type="button" class="btn sm" data-req-copy="${i}">Копировать</button>
            <button type="button" class="btn sm primary" data-req-dl="${i}">Скачать</button>
          </div>
        </div>`;
    }).join("");
    const requestsBlock = reqs.length
      ? `<details class="pr-reqs"><summary>Сетевые запросы страницы (${reqs.length}) — выбрать вручную</summary><div class="pr-req-list">${reqRows}</div></details>`
      : "";

    results.innerHTML = head + candidatesBlock + requestsBlock;
    status.hidden = true;

    results.onclick = async ev => {
      const cp = ev.target.closest("[data-copy]");
      const dl = ev.target.closest("[data-dl]");
      const rc = ev.target.closest("[data-req-copy]");
      const rd = ev.target.closest("[data-req-dl]");
      if (cp) {
        const c = r.candidates[+cp.dataset.copy];
        try { await navigator.clipboard.writeText(c.url); toast("Ссылка в буфере", "info"); } catch { toast("Не вышло скопировать", "error"); }
      } else if (rc) {
        const q = reqs[+rc.dataset.reqCopy];
        try { await navigator.clipboard.writeText(q.url); toast("Ссылка в буфере", "info"); } catch { toast("Не вышло скопировать", "error"); }
      } else if (dl || rd) {
        const btn = dl || rd;
        const item = dl ? r.candidates[+dl.dataset.dl] : {
          url: reqs[+rd.dataset.reqDl].url,
          headers: { "Referer": input.value.trim(), "Origin": new URL(input.value.trim()).origin },
        };
        btn.disabled = true;
        btn.textContent = "Качаю…";
        try {
          await downloadCandidate(item, r.title);
        } catch (err) {
          toast(`Загрузка: ${err.message || err}`, "error");
        } finally {
          btn.disabled = false;
          btn.textContent = "Скачать";
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
