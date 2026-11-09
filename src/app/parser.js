import { can } from "./state.js";
import { clientHeaders, API_BASE, toast } from "./api.js";
import { $ } from "./utils.js";
import { pickOutputDir, pickOutputFile } from "./tauri.js";
import { downloadWithCard } from "./download-card.js";

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

async function errorText(res) {
  try { const j = await res.json(); if (j.detail) return j.detail; } catch (_) { /* не json */ }
  return `HTTP ${res.status}`;
}

function engineOf(c) {
  return /m3u8|dash|mpd|ism|mss/i.test(`${c.protocol || ""} ${c.ext || ""}`) ? "N_m3u8DL-RE" : "yt-dlp";
}

const ENGINE_KEY = "project_parser_engine";
const ENGINE_NAMES = { nm3u8: "N_m3u8DL-RE", ytdlp: "yt-dlp" };

function readEngine() {
  try { const v = localStorage.getItem(ENGINE_KEY); return v === "nm3u8" || v === "ytdlp" ? v : "auto"; } catch (_) { return "auto"; }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function layout() {
  return `
    <div class="pr-wrap">
      <section class="pr-hero" id="pr-hero">
        <div class="pr-hero-bg" id="pr-hero-bg" aria-hidden="true"></div>
        <div class="pr-hero-body">
          <div class="pr-head">
            <h2>Парсер видео <span class="pr-beta">Beta</span></h2>
            <small>Вставьте ссылку: найдём постер, потоки и качества. Если сайт прячет плеер в JS, поможет глубокий анализ.</small>
          </div>
          <form class="pr-form" id="pr-form">
            <input id="pr-url" type="url" placeholder="https://… ссылка на страницу с видео" autocomplete="off" required>
            <button class="btn primary" type="submit" id="pr-submit">Найти</button>
            <button class="btn" type="button" id="pr-deep" title="Открыть страницу в headless-браузере и перехватить сеть">Глубокий анализ</button>
          </form>
          <div class="pr-engines" id="pr-engines" role="group" aria-label="Загрузчик">
            <button type="button" class="pr-engine" data-engine="auto" title="Сначала N_m3u8DL-RE, если не вышло — yt-dlp">Авто <small>по очереди</small></button>
            <button type="button" class="pr-engine" data-engine="nm3u8" title="Только N_m3u8DL-RE: HLS и DASH">N_m3u8DL-RE <small>HLS и DASH</small></button>
            <button type="button" class="pr-engine" data-engine="ytdlp" title="Только yt-dlp">yt-dlp <small>любые ссылки</small></button>
          </div>
        </div>
      </section>
      <div class="pr-status" id="pr-status" hidden></div>
      <div class="pr-results" id="pr-results"></div>
      <div class="pr-history" id="pr-history"></div>
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
  loadHistory();

  let analyzeReferer = null;
  let engine = readEngine();

  function syncEngine() {
    body.querySelectorAll("[data-engine]").forEach(b => {
      const on = b.dataset.engine === engine;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
    results.querySelectorAll("[data-auto-engine]").forEach(el => { el.textContent = ENGINE_NAMES[engine] || el.dataset.autoEngine; });
  }

  $("#pr-engines").addEventListener("click", ev => {
    const btn = ev.target.closest("[data-engine]");
    if (!btn) return;
    engine = btn.dataset.engine;
    try { localStorage.setItem(ENGINE_KEY, engine); } catch (_) { /* не критично */ }
    syncEngine();
  });
  syncEngine();

  async function analyze(deep) {
    const url = input.value.trim();
    const referer = analyzeReferer;
    analyzeReferer = null;
    if (!url) return;
    submit.disabled = deepBtn.disabled = true;
    (deep ? deepBtn : submit).textContent = deep ? "Браузер…" : "Ищу…";
    status.hidden = false;
    status.textContent = deep
      ? "Глубокий анализ: запускаю headless-Chromium, 10–15 секунд…"
      : "Анализ: yt-dlp + разбор HTML…";
    results.innerHTML = "";
    setBackdrop(null);
    try {
      const res = await fetch(`${API_BASE}/parser/analyze/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...clientHeaders() },
        body: JSON.stringify({ url, deep, referer }),
      });
      if (!res.ok) throw new Error(await errorText(res));
      const { analysis_id } = await res.json();
      let state;
      do {
        await new Promise(r => setTimeout(r, 600));
        const r = await fetch(`${API_BASE}/parser/analyze/${analysis_id}/status`, { headers: clientHeaders() });
        if (!r.ok) throw new Error(await errorText(r));
        state = await r.json();
        status.textContent = `${state.stage || "Анализ"}…`;
      } while (state.status === "running");
      if (state.status === "error") throw new Error(state.error || "Анализ не удался");
      renderResults(state.result);
    } catch (err) {
      status.textContent = `Ошибка: ${err.message || err}`;
      toast(`Парсер: ${err.message || err}`, "error");
    } finally {
      submit.disabled = deepBtn.disabled = false;
      submit.textContent = "Найти";
      deepBtn.textContent = "Глубокий анализ";
    }
  }

  function setBackdrop(url) {
    const bg = $("#pr-hero-bg");
    const hero = $("#pr-hero");
    if (!bg || !hero) return;
    bg.style.backgroundImage = url ? `url("${url.replace(/["\\\n\r]/g, encodeURIComponent)}")` : "";
    hero.classList.toggle("has-poster", !!url);
  }

  function renderResults(r) {
    const diag = (r.diagnostics || []).map(d =>
      `<span class="pr-chip ${d.ok ? "ok" : "no"}">L${d.level} ${esc(d.name)}: ${d.ok ? (d.count ?? 0) + " найдено" : "—"}</span>`).join("");
    const poster = /^https:\/\//i.test(r.poster || "") ? r.poster : "";
    const host = hostOf(input.value.trim());
    const count = (r.candidates || []).length;
    const head = `
      <div class="pr-meta${poster ? "" : " no-poster"}">
        <div class="pr-poster">
          ${poster ? `<img id="pr-poster-img" src="${esc(poster)}" alt="" referrerpolicy="no-referrer">` : ""}
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 5h18v14H3z"/><path d="M10 9l5 3-5 3z" fill="currentColor" stroke="none"/></svg>
        </div>
        <div class="pr-meta-body">
          ${host ? `<div class="pr-host">${esc(host)}</div>` : ""}
          <div class="pr-title">${esc(r.title || "Без названия")}</div>
          <div class="pr-facts">
            ${r.duration ? `<span class="pr-dur">${fmtDur(r.duration)}</span>` : ""}
            <span class="pr-dur">${count ? `Потоков: ${count}` : "Потоки не найдены"}</span>
          </div>
          <div class="pr-diag">${diag}</div>
        </div>
      </div>`;

    const rowsHtml = (r.candidates || []).map((c, i) => {
      const q = typeof c.quality === "number" ? `${c.quality}p` : esc(c.quality || "?");
      const protoExt = [c.protocol, c.ext].filter(Boolean).join(" · ");
      const size = c.filesize ? `${c.filesize_estimated ? "≈ " : ""}${fmtSize(c.filesize)}` : "";
      const extras = [
        c.bitrate ? `${(c.bitrate / 1e6).toFixed(1)} Мбит/с` : "",
        c.codecs ? c.codecs.split(",")[0].split(".")[0] : "",
        c.mirrors?.length ? `+${c.mirrors.length} зеркал${c.mirrors.length === 1 ? "о" : "а"}` : "",
        c.audio_only ? "только звук" : "",
        c.alive === false ? "не отвечает" : "",
        c.drm ? "защищено DRM" : "",
      ].filter(Boolean).map(x => ` · ${esc(x)}`).join("");
      return `
        <div class="pr-row">
          <div class="pr-col pr-q">${q}</div>
          <div class="pr-col pr-info">
            <div class="pr-src"><span class="pr-engine sm" data-auto-engine="${engineOf(c)}">${engineOf(c)}</span> ${esc(c.source || "")} ${protoExt ? `· ${esc(protoExt)}` : ""} ${size ? `· ${size}` : ""}${extras}</div>
            <div class="pr-url" title="${esc(c.url)}">${esc(c.url)}</div>
          </div>
          <div class="pr-col pr-actions">
            <button type="button" class="btn sm" data-copy="${i}">Копировать</button>
            <button type="button" class="btn sm primary" data-dl="${i}"${c.drm ? " disabled" : ""}>Скачать</button>
          </div>
        </div>`;
    }).join("");

    const candidatesBlock = (r.candidates && r.candidates.length)
      ? `<div class="pr-list">${rowsHtml}</div>`
      : `<div class="empty">${esc(r.reason?.message || "Автоматически видео не найдено.")}${r.deep ? "" : " Попробуйте «Глубокий анализ»."}</div>`;

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

    const notice = r.reason && r.candidates?.length ? `<div class="pr-status">${esc(r.reason.message)}</div>` : "";
    results.innerHTML = head + notice + profileHtml(r.profile) + candidatesBlock + requestsBlock;
    status.hidden = true;
    bindProfile(r);
    syncEngine();
    const posterImg = $("#pr-poster-img");
    if (posterImg) {
      posterImg.addEventListener("load", () => setBackdrop(poster), { once: true });
      posterImg.addEventListener("error", () => {
        posterImg.remove();
        results.querySelector(".pr-meta")?.classList.add("no-poster");
      }, { once: true });
    }

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
        btn.textContent = "Куда сохранить…";
        try {
          await downloadCandidate(item, r.title, btn);
        } catch (err) {
          toast(`Загрузка: ${err.message || err}`, "error");
        } finally {
          btn.disabled = false;
          btn.textContent = "Скачать";
          btn.classList.remove("pr-dl-progress");
          btn.style.removeProperty("--pr-progress");
          loadHistory();
        }
      }
    };
  }

  async function downloadCandidate(c, title, btn) {
    const defaultName = (title || "video").replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 100) || "video";
    const savePath = await pickOutputFile(`${defaultName}.mp4`, [{ name: "Видео MP4", extensions: ["mp4"] }]);
    if (!savePath) return;
    toast(`Сохраню в ${savePath}`, "info");
    btn.textContent = "0%";

    const start = await fetch(`${API_BASE}/parser/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...clientHeaders() },
      body: JSON.stringify({ url: c.url, headers: c.headers || {}, name: title || "video", engine }),
    });
    if (!start.ok) throw new Error(await errorText(start));
    const { job_id } = await start.json();
    loadHistory();

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "btn sm";
    cancelBtn.textContent = "Отмена";
    cancelBtn.onclick = () => {
      cancelBtn.disabled = true;
      fetch(`${API_BASE}/parser/download/${job_id}/cancel`, { method: "POST", headers: clientHeaders() })
        .catch(() => { cancelBtn.disabled = false; });
    };
    btn.after(cancelBtn);

    let job = null;
    try {
      while (true) {
        await new Promise(r => setTimeout(r, 700));
        const r = await fetch(`${API_BASE}/parser/download/${job_id}/status`, {
          headers: clientHeaders(),
        });
        if (!r.ok) throw new Error(`статус HTTP ${r.status}`);
        job = await r.json();
        if (btn) renderBtnProgress(btn, job);
        if (job.status === "done") break;
        if (job.status === "cancelled") { toast("Загрузка отменена", "info"); return; }
        if (job.status === "error") throw new Error(job.error || "Ошибка загрузки");
      }
    } finally {
      cancelBtn.remove();
    }

    btn.textContent = "Сохраняю…";
    await saveJob(job_id, savePath);
  }

  function profileHtml(p) {
    if (!p || (!p.translations?.length && !p.episodes?.length)) return "";
    const voices = (p.translations || []).map((t, i) =>
      `<option value="${i}"${t.selected ? " selected" : ""}>${esc(t.title)}${t.type === "subtitles" ? " (субтитры)" : ""}</option>`).join("");
    const episodes = (p.episodes || []).map((e, i) =>
      `<label class="pr-ep"><input type="checkbox" data-ep="${i}"${String(e.id) === String(p.current_episode) ? " checked" : ""}> ${esc(e.number ?? "")}<small>${esc(e.label || "")}</small></label>`).join("");
    return `
      <div class="pr-profile">
        ${voices ? `<label class="pr-field">Озвучка <select id="pr-voice">${voices}</select></label>` : ""}
        <label class="pr-field">Качество <select id="pr-quality">
          <option value="1080">до 1080p</option><option value="720" selected>до 720p</option><option value="480">до 480p</option><option value="360">до 360p</option>
        </select></label>
        ${voices ? `<button type="button" class="btn sm" id="pr-voice-open">Найти потоки этой озвучки</button>` : ""}
        <button type="button" class="btn sm primary" id="pr-enqueue">${episodes ? "Выбранные серии в очередь" : "В очередь"}</button>
        ${episodes ? `<button type="button" class="btn sm" id="pr-ep-all">Выбрать все</button><div class="pr-eps">${episodes}</div>` : ""}
      </div>`;
  }

  function bindProfile(r) {
    const p = r.profile;
    if (!p) return;
    const voice = () => p.translations?.[+($("#pr-voice")?.value ?? -1)];
    $("#pr-voice-open")?.addEventListener("click", () => {
      const v = voice();
      if (!v) return;
      input.value = v.url;
      analyzeReferer = p.referer || null;
      analyze(true);
    });
    $("#pr-ep-all")?.addEventListener("click", () => {
      const boxes = [...results.querySelectorAll("[data-ep]")];
      const on = !boxes.every(b => b.checked);
      boxes.forEach(b => { b.checked = on; });
    });
    $("#pr-enqueue")?.addEventListener("click", async ev => {
      const btn = ev.currentTarget;
      const picked = [...results.querySelectorAll("[data-ep]:checked")].map(b => p.episodes[+b.dataset.ep]);
      const quality = +$("#pr-quality").value;
      const title = r.title || "video";
      const v = voice();
      let payload;
      if (p.site === "animelib") {
        if (!picked.length || !v) { toast("Выберите серии и озвучку", "error"); return; }
        payload = { site: "animelib", episode_ids: picked.map(e => e.id), team: v.title, title, referer: p.referer, quality };
      } else if (p.episodes?.length) {
        if (!picked.length) { toast("Выберите серии", "error"); return; }
        payload = { items: picked.map(e => ({ url: e.url, referer: p.referer, name: `${title} - ${e.number}` })), quality };
      } else {
        payload = { items: [{ url: v.url, referer: p.referer, name: `${title} [${v.title}]` }], quality };
      }
      btn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/parser/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...clientHeaders() },
          body: JSON.stringify({ ...payload, engine }),
        });
        if (!res.ok) throw new Error(await errorText(res));
        const { job_ids } = await res.json();
        toast(`В очереди: ${job_ids.length}`, "info");
        const details = $("#pr-history details");
        if (details) details.open = true;
        loadHistory(true);
      } catch (err) {
        toast(`Очередь: ${err.message || err}`, "error");
      } finally {
        btn.disabled = false;
      }
    });
  }

  function saveJob(jobId, savePath) {
    return downloadWithCard({
      command: "download_api_file",
      args: { apiPath: `parser/download/${jobId}/file` },
      savePath,
      name: savePath.split(/[\\/]/).pop(),
    });
  }

  const JOB_STATUS = { queued: "в очереди", analyzing: "ищу поток", running: "загружается", done: "готово", error: "ошибка", cancelled: "отменено" };
  const JOB_OPEN = new Set(["queued", "analyzing", "running"]);
  let historyTimer = null;

  async function loadHistory(open = false) {
    const box = $("#pr-history");
    if (!box) return;
    clearTimeout(historyTimer);
    let jobs = [];
    try {
      const r = await fetch(`${API_BASE}/parser/jobs`, { headers: clientHeaders() });
      if (r.ok) ({ jobs } = await r.json());
    } catch (_) { return; }
    if (!jobs.length) { box.innerHTML = ""; return; }
    const wasOpen = open || box.querySelector("details")?.open;
    const done = jobs.filter(j => j.status === "done");
    box.innerHTML = `<details class="pr-reqs"${wasOpen ? " open" : ""}><summary>Очередь и загрузки (${jobs.length}) — файлы хранятся 6 часов</summary>
      ${done.length > 1 ? `<button type="button" class="btn sm" id="pr-save-all">Сохранить все готовые (${done.length}) в папку</button>` : ""}
      <div class="pr-req-list">${jobs.map(j => `
      <div class="pr-req">
        <div class="pr-req-ct">${esc(JOB_STATUS[j.status] || j.status)}${j.status === "running" ? ` · ${j.engine ? `${esc(j.engine)} · ` : ""}${j.percent || 0}%` : ""}${j.size ? ` · ${fmtSize(j.size)}` : ""}${j.error ? ` · ${esc(j.error)}` : ""}</div>
        <div class="pr-req-url" title="${esc(j.filename || j.name)}">${esc(j.filename || j.name)}</div>
        <div class="pr-req-actions">
          ${j.status === "done" ? `<button type="button" class="btn sm primary" data-job-save="${esc(j.id)}">Сохранить</button>` : ""}
          ${JOB_OPEN.has(j.status) ? `<button type="button" class="btn sm" data-job-cancel="${esc(j.id)}">Отмена</button>` : ""}
        </div>
      </div>`).join("")}</div></details>`;
    box.onclick = async ev => {
      const cancel = ev.target.closest("[data-job-cancel]");
      if (cancel) {
        cancel.disabled = true;
        await fetch(`${API_BASE}/parser/download/${cancel.dataset.jobCancel}/cancel`, { method: "POST", headers: clientHeaders() }).catch(() => {});
        loadHistory();
        return;
      }
      if (ev.target.closest("#pr-save-all")) {
        const dir = await pickOutputDir();
        if (!dir) return;
        for (const j of done) await saveJob(j.id, `${dir}\\${j.filename || `${j.name}.mp4`}`);
        return;
      }
      const b = ev.target.closest("[data-job-save]");
      if (!b) return;
      const job = jobs.find(j => j.id === b.dataset.jobSave);
      const savePath = await pickOutputFile(job.filename || `${job.name}.mp4`, [{ name: "Видео MP4", extensions: ["mp4"] }]);
      if (savePath) await saveJob(job.id, savePath);
    };
    if (jobs.some(j => JOB_OPEN.has(j.status)) && box.isConnected) historyTimer = setTimeout(loadHistory, 2500);
  }

  function renderBtnProgress(btn, job) {
    const pct = typeof job.percent === "number" ? job.percent : 0;
    const spd = job.speed ? `${(job.speed / 1024 / 1024).toFixed(1)} МБ/с` : "";
    const got = job.downloaded ? `${(job.downloaded / 1024 / 1024).toFixed(0)}` : "0";
    const total = job.total ? `/${(job.total / 1024 / 1024).toFixed(0)}` : "";
    btn.textContent = job.phase === "merging"
      ? "Склеиваю…"
      : `${job.engine ? `${job.engine} · ` : ""}${pct}% · ${got}${total} МБ${spd ? " · " + spd : ""}`;
    btn.style.setProperty("--pr-progress", pct + "%");
    btn.classList.add("pr-dl-progress");
  }

  return true;
}
