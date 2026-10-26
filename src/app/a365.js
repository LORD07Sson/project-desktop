// «Ещё → Anime 365» — наша озвучка на smotret-anime.org (сервер: anime365.py бота, API /api/a365…).
// Три вкладки:
//   «Финалы» — серии, собранные в отчётах: что на 365, что в очереди, итог проверок, «Проверить» / «Залить»;
//   «Архив»  — весь архив серий сверяется с 365: чего там нет — залить отсюда же. Тайтлы архива, которых нет
//              в студии, привязываются к аниме на 365 вручную («Привязать» — поиск по названию);
//   «Вручную» — как форма «Добавить перевод» на сайте: аниме, серия, тип, авторы, свой файл (и субтитры). Файл грузит
//              сам десктоп по tus прямо на сервер загрузки 365; сервер проверяет до загрузки и создаёт перевод после.
// Проверки обязательные и на сервере: сезон (номер, сезон выхода, число серий) и дубль нашей озвучки на 365.

import { apiGet, apiPost, askConfirm, openSheet, dismissSheet, toast } from "./api.js";
import { $, esc, relTime } from "./utils.js";
import { can } from "./state.js";
import { openExternal } from "./tauri.js";

let view = "finals";
let finalsFilter = "todo";
let archFilter = "missing";
let openEp = null; // какая серия в карточке архива раскрыта
let pollTimer = null;
let last = null;
const manual = { series: null, episodes: null, check: null, busy: false };
// Право «Anime 365: заливать»: без него страница только для просмотра и проверок (сервер всё равно проверит каждый запрос).
const canUpload = () => can("a365.upload");

// ---------- общее ----------

function kindOf(it) {
  if (it.stage === "done") return "done";
  if (it.stage === "queued" || it.stage === "uploading") return "queue";
  if (it.stage === "failed" && !(it.check && it.check.dup)) return "bad";
  if (!it.check) return it.unbound ? "unbound" : "unchecked";
  if (!it.check.ok && it.check.dup) return "elsewhere"; // наша озвучка уже на 365 (залита не отсюда или вручную)
  if (it.unbound) return "unbound";
  return it.check.ok ? "ready" : "bad";
}
const isOn365 = it => ["done", "elsewhere"].includes(kindOf(it));
const fmtSize = n => (n ? `${(n / 1048576).toFixed(0)} МБ` : "");

function pillHtml(it) {
  const k = kindOf(it);
  if (it.stage === "done") return `<span class="a3-pill ok">Залито</span>`;
  if (k === "elsewhere") return `<span class="a3-pill ok">Уже на 365</span>`;
  if (it.stage === "uploading") return `<span class="a3-pill run">Заливается ${Math.max(0, Math.min(100, it.progress || 0))}%</span>`;
  if (it.stage === "queued") return `<span class="a3-pill run">В очереди${it.queue_pos ? ` №${it.queue_pos}` : ""}</span>`;
  if (k === "unbound") return `<span class="a3-pill">Не привязано</span>`;
  if (it.stage === "failed") return `<span class="a3-pill bad">Не залилось</span>`;
  if (k === "ready") return `<span class="a3-pill ready">Нет на 365 · готово</span>`;
  if (k === "bad") return `<span class="a3-pill bad">Проверка не пройдена</span>`;
  return `<span class="a3-pill">Не проверено</span>`;
}

function detailHtml(it) {
  const k = kindOf(it);
  const link = url => `<button type="button" class="a3-link" data-a3-open="${esc(url)}">${esc(url)}</button>`;
  if (it.stage === "done") return link(it.url);
  if (it.stage === "uploading") {
    const pct = Math.max(0, Math.min(100, it.progress || 0));
    return `<div class="a3-bar"><i style="width:${pct}%"></i></div><div class="a3-note">${esc(it.text || "")}</div>`;
  }
  if (it.stage === "queued") return `<div class="a3-note">${esc(it.text || "Ждёт своей очереди — перед заливкой проверки пройдут ещё раз")}</div>`;
  const c = it.check;
  if (k === "elsewhere") return `<div class="a3-note">Наша озвучка этой серии уже есть на 365 — второй раз не зальётся.</div>${link(c.dup)}`;
  if (it.stage === "failed") return `<div class="a3-note bad">${esc(it.error || "")}</div>`;
  if (!c) return `<div class="a3-note">${it.unbound ? "Привяжите тайтл к аниме на 365 — тогда можно проверить." : "Сезон и дубли ещё не проверялись."}</div>`;
  if (!c.ok) return `<div class="a3-note bad">${esc(c.error)}</div><div class="a3-note">проверено ${esc(relTime(c.at))}</div>`;
  return `<div class="a3-note">${(c.lines || []).map(esc).join(" · ")}</div>
    <div class="a3-note">на 365: ${esc(c.series || "")} · проверено ${esc(relTime(c.at))}</div>`;
}

function actionsHtml(it) {
  const key = esc(it.key);
  if (it.stage === "done" || it.stage === "uploading") return "";
  if (it.stage === "queued") return canUpload() ? `<button type="button" class="btn ghost sm" data-a3-cancel="${key}">Убрать</button>` : "";
  const k = kindOf(it);
  if (k === "unbound") return "";
  const check = `<button type="button" class="btn ghost sm" data-a3-check="${key}">${it.check ? "Проверить снова" : "Проверить"}</button>`;
  // «Залить» — только после пройденной проверки (сервер всё равно проверит ещё раз).
  return k === "ready" && canUpload() ? `${check}<button type="button" class="btn primary sm" data-a3-upload="${key}" data-a3-label="${esc(it.label || it.public_id || "")}">Залить</button>` : check;
}

function rowHtml(it, title, meta) {
  return `
    <div class="a3-row">
      <div class="a3-main">
        <div class="a3-title">${title}</div>
        <div class="a3-meta">${meta}</div>
        ${detailHtml(it)}
      </div>
      <div class="a3-side">${pillHtml(it)}<div class="a3-actions">${actionsHtml(it)}</div></div>
    </div>`;
}

const cell = (label, value, sub, tone) =>
  `<div class="bs-cell"><span>${esc(label)}</span><b class="${tone || ""}">${esc(String(value))}</b>${sub ? `<em>${esc(sub)}</em>` : ""}</div>`;

const filtersHtml = (list, current, attr) =>
  `<div class="a3-filters">${list.map(([k, label, n]) => `<button type="button" class="a3-filter${current === k ? " on" : ""}" data-${attr}="${k}">${label}${n != null ? ` <i>${n}</i>` : ""}</button>`).join("")}</div>`;

// ---------- «Финалы» ----------

function finalsHtml(d) {
  const items = d.items || [];
  const count = k => items.filter(it => kindOf(it) === k).length;
  const shown = items.filter(it => finalsFilter === "all" ? true
    : finalsFilter === "done" ? isOn365(it)
      : finalsFilter === "queue" ? kindOf(it) === "queue"
        : !isOn365(it) && kindOf(it) !== "queue");
  const empty = { todo: "Всё собранное уже на 365 🎉", queue: "Очередь пуста", done: "На 365 пока ничего нет", all: "Собранных финалов пока нет" }[finalsFilter];
  return `
    <div class="a3-tools">
      ${filtersHtml([["todo", "Не залито", items.filter(it => !isOn365(it) && kindOf(it) !== "queue").length], ["queue", "Очередь", count("queue")],
        ["done", "На 365", items.filter(isOn365).length], ["all", "Все", items.length]], finalsFilter, "a3-ff")}
      <span style="flex:1"></span>
      <button type="button" class="btn ghost sm" data-a3-checkall>Проверить всё</button>
    </div>
    <div class="a3-list">${shown.map(it => rowHtml({ ...it, label: it.public_id },
      `${esc(it.title)} <b>· серия ${esc(String(it.episode ?? "?"))}</b>`,
      `${esc(it.public_id)} · ${esc(it.file || "")}${it.size ? ` · ${fmtSize(it.size)}` : ""}`)).join("") || `<div class="no-assignee">${empty}</div>`}</div>`;
}

// ---------- «Архив» ----------

function archiveHtml(d) {
  const a = d.archive || { items: [] };
  const items = a.items || [];
  const missing = it => !isOn365(it) && kindOf(it) !== "queue" && kindOf(it) !== "unbound";
  const pick = { missing, on: isOn365, queue: it => kindOf(it) === "queue", unbound: it => kindOf(it) === "unbound", all: () => true }[archFilter] || missing;
  // Карточка на тайтл (тег + сезон): постер, название, привязка и серии кнопками-номерами по цвету статуса.
  // Фильтр выбирает тайтлы, где есть хоть одна подходящая серия; серии в карточке видны все — картина целиком.
  const groups = new Map();
  for (const it of items) {
    const g = `${(it.tag || "").toLowerCase()}|${it.season}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  const shown = [...groups.values()].filter(list => list.some(pick));
  return toolsHtml(a, items, missing) + `<div class="a3-cards">${shown.map(cardHtml).join("") || `<div class="no-assignee">${emptyText(items)}</div>`}</div>`;
}

const CHIP = { done: ["ok", "✓"], elsewhere: ["ok", "✓"], ready: ["ready", "↑"], queue: ["run", "…"], bad: ["bad", "!"], unchecked: ["", ""], unbound: ["", ""] };

function chipTitle(it) {
  const k = kindOf(it);
  const c = it.check || {};
  if (k === "done") return "Залито отсюда";
  if (k === "elsewhere") return "Наша озвучка уже на 365";
  if (k === "ready") return "Нет на 365 — можно залить";
  if (it.stage === "uploading") return `Заливается ${it.progress || 0}%`;
  if (it.stage === "queued") return `В очереди${it.queue_pos ? ` №${it.queue_pos}` : ""}`;
  if (k === "bad") return it.error || c.error || "Проверка не пройдена";
  if (k === "unbound") return "Тайтл не привязан к аниме на 365";
  return "Ещё не проверялось";
}

function cardHtml(list) {
  const first = list[0];
  const withPoster = list.find(it => it.poster) || first;
  const name = first.title || first.tag || "?";
  const count = k => list.filter(it => kindOf(it) === k).length;
  const on = list.filter(isOn365).length;
  const ready = list.filter(it => kindOf(it) === "ready");
  const bad = count("bad");
  const unbound = !first.studio && !first.bound;
  const where = first.studio ? "тайтл студии"
    : first.bound ? (first.auto ? "подобрано автоматически — проверьте" : "привязан вручную")
      : "не привязан к 365";
  const bindBtn = first.studio || !canUpload() ? ""
    : `<button type="button" class="btn ${first.bound ? "ghost" : "primary"} sm" data-a3-bind="${esc(first.tag || "")}" data-a3-season="${esc(String(first.season))}" data-a3-name="${esc(name)}">${first.bound ? "Сменить" : "Привязать"}</button>`;
  const upAll = ready.length && canUpload() ? `<button type="button" class="btn primary sm" data-a3-upall="${esc(ready.map(it => it.key).join(","))}" data-a3-name="${esc(name)}">Залить недостающие · ${ready.length}</button>` : "";
  const progress = list.length ? Math.round(on * 100 / list.length) : 0;
  const open = list.find(it => it.key === openEp);
  const sorted = list.slice().sort((x, y) => Number(x.episode) - Number(y.episode));
  return `
    <div class="a3-tcard${unbound ? " unbound" : ""}">
      <div class="a3-tposter">${withPoster.poster ? `<img src="${esc(withPoster.poster)}" alt="" loading="lazy">` : `<span>${esc(name.slice(0, 1).toUpperCase())}</span>`}</div>
      <div class="a3-tbody">
        <div class="a3-thead">
          <div class="a3-tname" title="${esc(name)}">${esc(name)}</div>
          <div class="a3-tacts">${upAll}${bindBtn}</div>
        </div>
        <div class="a3-tmeta">
          <span>${esc(String(first.season))}-й сезон</span>
          <span class="a3-dot"></span><span class="${unbound ? "a3-warn" : first.auto ? "a3-auto" : ""}">${esc(where)}</span>
          ${withPoster.series_season ? `<span class="a3-dot"></span><span>на 365: ${esc(withPoster.series_season)}</span>` : ""}
        </div>
        <div class="a3-tstat">
          <div class="a3-tprog"><i style="width:${progress}%"></i></div>
          <b>${on}</b><span>из ${list.length} на 365</span>
          ${ready.length ? `<span class="a3-tag ready">${ready.length} можно залить</span>` : ""}
          ${count("queue") ? `<span class="a3-tag run">${count("queue")} в очереди</span>` : ""}
          ${bad ? `<span class="a3-tag bad">${bad} с проблемой</span>` : ""}
        </div>
        <div class="a3-chips">${sorted.map(it => {
          const [tone, mark] = CHIP[kindOf(it)] || ["", ""];
          return `<button type="button" class="a3-chip ${tone}${it.key === openEp ? " on" : ""}" data-a3-chip="${esc(it.key)}" title="Серия ${esc(String(it.episode))}: ${esc(chipTitle(it))}">${esc(String(it.episode))}${mark ? `<i>${mark}</i>` : ""}</button>`;
        }).join("")}</div>
      </div>
      ${open ? `<div class="a3-tdetail">${rowHtml({ ...open, label: `«${name}», серия ${open.episode}` }, `Серия ${esc(String(open.episode))}`,
        `${esc(open.file || "")}${open.size ? ` · ${fmtSize(open.size)}` : ""}`)}</div>` : ""}
    </div>`;
}

function toolsHtml(a, items, missing) {
  const scanLine = a.scanning ? `Бот читает посты архива… осталось ${a.unindexed}`
    : a.unindexed ? `В индексе нет ${a.unindexed} постов архива — нажмите «Обновить архив»`
      : `Индекс архива полный · ${items.length} серий · нажмите на номер серии — подробности`;
  return `
    <div class="a3-tools">
      ${filtersHtml([["missing", "Нет на 365", items.filter(missing).length], ["on", "На 365", items.filter(isOn365).length],
        ["queue", "Очередь", items.filter(it => kindOf(it) === "queue").length], ["unbound", "Не привязано", items.filter(it => kindOf(it) === "unbound").length],
        ["all", "Все", items.length]], archFilter, "a3-af")}
      <span style="flex:1"></span>
      ${canUpload() ? `<button type="button" class="btn ghost sm" data-a3-scan ${a.scanning ? "disabled" : ""}>Обновить архив</button>` : ""}
      <button type="button" class="btn ghost sm" data-a3-checkarch>Проверить весь архив</button>
    </div>
    <div class="a3-note a3-scanline">${esc(scanLine)}</div>`;
}

function emptyText(items) {
  return {
    missing: items.length ? "Всё из архива уже на 365 (или ещё не проверено — «Проверить весь архив») 🎉" : "Индекс архива пуст — нажмите «Обновить архив»",
    on: "Ничего из архива на 365 не найдено", queue: "Очередь пуста", unbound: "Все тайтлы архива привязаны", all: "Индекс архива пуст",
  }[archFilter];
}

// ---------- «Вручную» ----------

function seriesCardHtml(s, extra = "") {
  return `<div class="a3-series">
    ${s.poster ? `<img src="${esc(s.poster)}" alt="" loading="lazy">` : `<div class="a3-noposter"></div>`}
    <div class="a3-main"><div class="a3-title"><b>${esc(s.title)}</b></div>
      <div class="a3-meta">${esc(s.romaji || "")}</div>
      <div class="a3-meta">${esc(s.type || "")} · ${esc(s.season || "сезон не указан")} · ${s.season_number}-й сезон по названию${s.episodes ? ` · ${s.episodes} серий` : ""} · #${esc(String(s.id))}</div></div>
    ${extra}</div>`;
}

function manualHtml() {
  const s = manual.series;
  const eps = manual.episodes || [];
  const epsHtml = eps.length ? `<div class="a3-eps">${eps.map(e => {
    const tone = e.voice.length ? "ok" : "";
    return `<button type="button" class="a3-ep ${tone}" data-a3-ep="${esc(String(e.number))}" data-a3-eptype="${esc(e.type)}" title="${esc(e.label || "")}: переводов на 365 — ${e.total}${e.voice.length ? ", наша озвучка есть" : ""}${e.sub.length ? ", наши субтитры есть" : ""}">${esc(String(e.number))}${e.type !== "tv" ? ` ${esc(e.type)}` : ""}${e.voice.length ? " ✓" : ""}</button>`;
  }).join("")}</div><div class="a3-note">✓ — наша озвучка этой серии уже есть на 365. Нажмите на серию, чтобы выбрать её.</div>` : "";
  const c = manual.check;
  return `
    <div class="a3-manual">
      <label class="field-label">Аниме на 365</label>
      ${s ? seriesCardHtml(s, `<button type="button" class="btn ghost sm" data-a3-mclear>Другое</button>`) + epsHtml
        : `<input class="field-input" id="a3-msearch" placeholder="Поиск по названию (рус., ромадзи или англ.)" autocomplete="off"><div id="a3-mresults" class="a3-results"></div>`}
      <div class="a3-grid">
        <div><label class="field-label">Номер серии</label><input class="field-input" id="a3-mnum" type="number" min="0" step="0.5" placeholder="Если это фильм — 1"></div>
        <div><label class="field-label">Тип серии</label><select class="field-input" id="a3-meptype">${["tv", "ova", "ona", "movie", "special"].map(t => `<option value="${t}">${{ tv: "TV", ova: "OVA", ona: "ONA", movie: "Фильм", special: "Спешл" }[t]}</option>`).join("")}</select></div>
        <div><label class="field-label">Тип перевода</label><select class="field-input" id="a3-mtype"><option value="voiceRu">Озвучка</option><option value="subRu">Русские субтитры</option></select></div>
        <div><label class="field-label">Авторы</label><input class="field-input" id="a3-mauthors" value="${esc((last && last.account && last.account.authors) || "DreamyVoice")}"></div>
      </div>
      <div class="a3-note">Формат «Авторы», как на сайте: Команда (Участник &amp; Участник), например Dream Cast (Brigella &amp; Kirisiya). Без команды: Участник &amp; Участник.</div>
      <label class="a3-check"><input type="checkbox" id="a3-mauthor" checked> Я участник команды авторов этого перевода</label>
      <div class="a3-grid">
        <div><label class="field-label">Видео</label><input class="field-input" id="a3-mvideo" type="file" accept="video/*,.mkv,.mp4,.webm,.avi,.mov,.ts"></div>
        <div><label class="field-label">Надписи / субтитры (если есть)</label><input class="field-input" id="a3-msub" type="file" accept=".ass,.ssa,.srt,.vtt"></div>
      </div>
      <div class="a3-note">Советуем H264 и mp4. Субтитры — лучше ass. Загружайте отдельно видео и субтитры, а не хардсаб (по возможности).</div>
      <div class="a3-tools" style="margin-top:12px;">
        <button type="button" class="btn ghost" data-a3-mcheck ${manual.busy ? "disabled" : ""}>Проверить</button>
        <button type="button" class="btn primary" data-a3-msend ${manual.busy || !(c && c.ok) ? "disabled" : ""}>Загрузить и добавить перевод</button>
        ${c && c.ok && c.endpoints ? `<select class="field-input a3-chan" id="a3-mchan">${c.endpoints.map((p, i) => `<option value="${i}">${esc(p.label || p.id)}${p.recommended ? " (рекомендуется)" : ""}</option>`).join("")}</select>` : ""}
      </div>
      <div id="a3-mstatus" class="a3-mstatus">${c ? (c.ok ? `<div class="a3-note">✅ Проверки пройдены: этой серии в нашей подписи на 365 нет. Сезон аниме: ${esc(c.series.season || "?")}, ${c.series.season_number}-й по названию — убедитесь, что это нужный.</div>` : `<div class="a3-note bad">${esc(c.error)}</div>`) : ""}</div>
    </div>`;
}

// tus 1.0.0 прямо из десктопа на сервер загрузки 365: адреса по очереди, куски по 8 МБ, при обрыве — докачка с места,
// которое назовёт сервер (HEAD). Возвращает {serverId, uuid}.
const TUS_CHUNK = 8 * 1024 * 1024;
async function tusUpload(file, point, onProgress) {
  const meta = "filename " + btoa(String.fromCharCode(...new TextEncoder().encode(file.name)));
  let created = null;
  let lastError = "";
  for (const url of point.tusUrls) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Tus-Resumable": "1.0.0", "Upload-Length": String(file.size), "Upload-Metadata": meta } });
      if (r.status === 201 && r.headers.get("Location")) { created = { url, r }; break; }
      lastError = `ответ ${r.status}`;
    } catch (e) { lastError = e.message; }
  }
  if (!created) throw new Error(`Сервер загрузки 365 не принял файл (${lastError}).`);
  const location = new URL(created.r.headers.get("Location"), created.url).toString();
  const uuid = created.r.headers.get("X-Upload-Uuid") || (location.match(/id=([0-9a-fA-F-]{8,})/) || [])[1];
  const serverId = Number(created.r.headers.get("X-Upload-Server-Id") || point.serverId);
  let offset = 0;
  let fails = 0;
  while (offset < file.size) {
    try {
      const r = await fetch(location, { method: "PATCH", headers: { "Tus-Resumable": "1.0.0", "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
        body: file.slice(offset, offset + TUS_CHUNK) });
      if (r.status !== 204) throw new Error(`PATCH ${r.status}`);
      offset = Number(r.headers.get("Upload-Offset") || offset + TUS_CHUNK);
      fails = 0;
    } catch (e) {
      if (++fails >= 6) throw new Error(`Загрузка на 365 обрывается (${e.message}) — попробуйте позже.`);
      await new Promise(res => setTimeout(res, 3000 * fails)); // DevSkim: ignore DS172411 — функция, не строка
      try {
        const h = await fetch(location, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } });
        offset = Number(h.headers.get("Upload-Offset") || offset);
      } catch (_) { /* следующий круг попробует снова */ }
    }
    onProgress(Math.min(offset, file.size), file.size);
  }
  return { serverId, uuid };
}

function manualForm(root) {
  const v = id => root.querySelector(id);
  return {
    number: v("#a3-mnum")?.value.trim(), epType: v("#a3-meptype")?.value, type: v("#a3-mtype")?.value,
    authors: v("#a3-mauthors")?.value.trim(), author: v("#a3-mauthor")?.checked,
    video: v("#a3-mvideo")?.files?.[0], sub: v("#a3-msub")?.files?.[0], chan: Number(v("#a3-mchan")?.value || 0),
  };
}

// Поля формы переживают перерисовку (поиск, выбор серии) — сохраняем и возвращаем значения.
function keepForm(root, fn) {
  const ids = ["#a3-mnum", "#a3-meptype", "#a3-mtype", "#a3-mauthors"];
  const saved = ids.map(id => root.querySelector(id)?.value);
  const author = root.querySelector("#a3-mauthor")?.checked;
  const files = ["#a3-mvideo", "#a3-msub"].map(id => root.querySelector(id)?.files);
  fn();
  ids.forEach((id, i) => { const el = root.querySelector(id); if (el && saved[i] != null) el.value = saved[i]; });
  const cb = root.querySelector("#a3-mauthor"); if (cb && author != null) cb.checked = author;
  ["#a3-mvideo", "#a3-msub"].forEach((id, i) => { const el = root.querySelector(id); if (el && files[i]?.length) el.files = files[i]; });
}

async function manualSend(root) {
  const f = manualForm(root);
  const c = manual.check;
  if (!manual.series || !c || !c.ok) return;
  if (!f.video) { toast("Выберите видеофайл.", "error"); return; }
  const ok = await askConfirm(`Загрузить «${f.video.name}» на Anime 365 как ${f.type === "voiceRu" ? "озвучку" : "субтитры"} к серии ${f.number} аниме «${manual.series.title}»?\n\n`
    + `Подпись: ${f.authors}. Перевод появится на публичном сайте после модерации 365.`, { yes: "Загрузить" });
  if (!ok) return;
  const status = root.querySelector("#a3-mstatus");
  const show = html => { if (status) status.innerHTML = html; };
  manual.busy = true;
  root.querySelectorAll("[data-a3-mcheck],[data-a3-msend]").forEach(b => { b.disabled = true; });
  try {
    const point = c.endpoints[f.chan] || c.endpoints[0];
    const bar = (what, done, total) => show(`<div class="a3-note">${what}: ${Math.floor(done * 100 / total)}% (${fmtSize(done) || "0 МБ"} из ${fmtSize(total)})</div>
      <div class="a3-bar"><i style="width:${Math.floor(done * 100 / total)}%"></i></div>`);
    const vid = await tusUpload(f.video, point, (d, t) => bar("Видео", d, t));
    let sub = null;
    if (f.sub) sub = await tusUpload(f.sub, point, (d, t) => bar("Субтитры", d, t));
    show(`<div class="a3-note">Файл загружен — проверяю ещё раз и добавляю перевод…</div>`);
    const res = await apiPost("/a365/manual/create", {
      seriesId: manual.series.id, episodeNumber: Number(f.number), episodeType: f.epType, type: f.type, authors: f.authors,
      addedByAuthor: f.author, serverId: vid.serverId, videoUuid: vid.uuid, videoFilename: f.video.name, videoSize: f.video.size,
      ...(sub ? { subUuid: sub.uuid, subFilename: f.sub.name, subSize: f.sub.size } : {}),
    });
    manual.check = null;
    show(`<div class="a3-note">✅ Перевод добавлен — появится на сайте после модерации 365.</div><button type="button" class="a3-link" data-a3-open="${esc(res.url)}">${esc(res.url)}</button>`);
    toast("Перевод добавлен на Anime 365.", "ok");
    loadSeriesEpisodes(root);
  } catch (e) {
    show(`<div class="a3-note bad">${esc(e.message)}</div>`);
  } finally {
    manual.busy = false;
    root.querySelectorAll("[data-a3-mcheck]").forEach(b => { b.disabled = false; });
  }
}

async function loadSeriesEpisodes(root) {
  if (!manual.series) return;
  try {
    const info = await apiGet(`/a365/series/${manual.series.id}`);
    manual.series = info.series;
    manual.episodes = info.episodes;
  } catch (e) { toast(e.message, "error"); }
  if (view === "manual") keepForm(root, () => paint(root));
}

function searchSeries(input, results, onPick) {
  let timer = null;
  let seq = 0;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ""; return; }
    timer = setTimeout(async () => { // DevSkim: ignore DS172411 — функция, не строка
      const my = ++seq;
      results.innerHTML = `<div class="a3-note">Ищу на 365…</div>`;
      try {
        const r = await apiGet("/a365/search", { q });
        if (my !== seq) return;
        results.innerHTML = (r.items || []).map((s, i) => `<button type="button" class="a3-pick" data-i="${i}">${seriesCardHtml(s)}</button>`).join("")
          || `<div class="a3-note">Ничего не нашлось.</div>`;
        results.querySelectorAll("[data-i]").forEach(b => b.addEventListener("click", () => onPick(r.items[Number(b.dataset.i)])));
      } catch (e) { results.innerHTML = `<div class="a3-note bad">${esc(e.message)}</div>`; }
    }, 350);
  });
}

function openBind(root, tag, season, name) {
  const overlay = openSheet(`
    <h3 style="margin:0 0 4px;">Привязать «${esc(name)}», ${esc(season)}-й сезон</h3>
    <div class="a3-note" style="margin-bottom:10px;">Выберите аниме на 365 именно этого сезона — по нему проверки сверят номер сезона, и туда лягут серии.</div>
    <input class="field-input" id="a3-bsearch" placeholder="Название на 365" value="${esc(name)}" autocomplete="off">
    <div id="a3-bresults" class="a3-results" style="max-height:52vh;"></div>
    <div class="sheet-actions"><button type="button" class="btn ghost" data-close>Отмена</button></div>`, "wide");
  overlay.querySelector("[data-close]").addEventListener("click", () => dismissSheet(overlay));
  const input = overlay.querySelector("#a3-bsearch");
  searchSeries(input, overlay.querySelector("#a3-bresults"), async s => {
    if (s.season_number !== Number(season)) {
      const sure = await askConfirm(`У «${s.title}» по названию ${s.season_number}-й сезон, а в архиве — ${season}-й. Проверки такую привязку не пропустят. Всё равно привязать?`, { yes: "Привязать" });
      if (!sure) return;
    }
    try {
      await apiPost("/a365/archive/bind", { tag, season: Number(season), series_id: s.id });
      dismissSheet(overlay);
      toast(`Привязано к «${s.title}». Проверяю серии…`, "ok");
      await apiPost("/a365/check", { archive: true });
    } catch (e) { toast(e.message, "error"); }
    refresh(root);
  });
  input.dispatchEvent(new window.Event("input"));
  input.focus();
}

// ---------- страница ----------

function paint(root) {
  const d = last || {};
  const acc = d.account || {};
  const every = [...(d.items || []), ...((d.archive || {}).items || [])];
  const queue = every.filter(it => kindOf(it) === "queue").length;
  const tabs = [["finals", "Финалы", (d.items || []).filter(it => !isOn365(it)).length],
    ["archive", "Архив", ((d.archive || {}).items || []).filter(it => !isOn365(it) && kindOf(it) !== "unbound").length], ...(canUpload() ? [["manual", "Вручную", null]] : [])];
  if (view === "manual" && !canUpload()) view = "finals";
  root.innerHTML = `
    <div class="page-header">
      <div><span class="kd-label">Публикация · smotret-anime.org</span><h1>Anime 365</h1></div>
    </div>
    <div class="bcell a3-card">
      <div class="dash-cell-head">
        <span class="dash-cell-title">${acc.ok ? `Аккаунт ${esc(acc.name || "")}` : "Нет входа на 365"}</span>
        <span class="dash-cell-hint">${acc.ok ? `подпись «${esc(acc.authors || "")}» · заливает бот, по одной` : `<span class="a3-bad">${esc(acc.error || "аккаунт не принят")}</span>`}</span>
      </div>
      <div class="bs-grid">
        ${cell("На 365", every.filter(isOn365).length, "залито отсюда и найдено на сайте")}
        ${cell("В очереди", queue, d.uploading ? `сейчас: ${d.uploading}` : "по одной, с проверками", queue ? "warn" : "")}
        ${cell("Нет на 365", every.filter(it => kindOf(it) === "ready").length, "проверено — можно заливать")}
        ${cell("Проблемы", every.filter(it => kindOf(it) === "bad").length, `${every.filter(it => ["unchecked", "unbound"].includes(kindOf(it))).length} не проверено или не привязано`, every.some(it => kindOf(it) === "bad") ? "danger" : "")}
      </div>
      ${filtersHtml(tabs, view, "a3-view").replace("a3-filters", "a3-filters a3-tabs")}
      <div class="a3-body">${view === "finals" ? finalsHtml(d) : view === "archive" ? archiveHtml(d) : manualHtml()}</div>
    </div>`;
  if (view === "manual" && !manual.series) {
    const input = root.querySelector("#a3-msearch");
    searchSeries(input, root.querySelector("#a3-mresults"), s => {
      manual.series = s; manual.episodes = null; manual.check = null;
      keepForm(root, () => paint(root));
      loadSeriesEpisodes(root);
    });
  }
}

async function refresh(root) {
  let d;
  try { d = await apiGet("/a365"); } catch (e) {
    if (!last) root.innerHTML = `<div class="bento-empty">Не удалось загрузить Anime 365: ${esc(e.message)}</div>`;
    return false;
  }
  if (!root.isConnected) return true;
  last = d;
  if (view === "manual") keepForm(root, () => paint(root)); else paint(root);
  clearTimeout(pollTimer);
  // Пока что-то в очереди, заливается или бот читает архив — обновляемся сами.
  const every = [...(d.items || []), ...((d.archive || {}).items || [])];
  if (every.some(it => it.stage === "queued" || it.stage === "uploading") || (d.archive && d.archive.scanning)) {
    pollTimer = setTimeout(() => { if (root.isConnected && view !== "manual") refresh(root); }, 3000); // DevSkim: ignore DS172411 — функция, не строка
  }
  return true;
}

let bound = false;

function bind(root) {
  if (bound) return;
  bound = true;
  root.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b || !root.contains(b)) return;
    if (b.dataset.a3View) { view = b.dataset.a3View; if (view === "manual") paint(root); else refresh(root); return; }
    if (b.dataset.a3Ff) { finalsFilter = b.dataset.a3Ff; paint(root); return; }
    if (b.dataset.a3Af) { archFilter = b.dataset.a3Af; paint(root); return; }
    if (b.dataset.a3Open) { openExternal(b.dataset.a3Open); return; }
    if (b.dataset.a3Chip) { openEp = openEp === b.dataset.a3Chip ? null : b.dataset.a3Chip; paint(root); return; }
    if (b.dataset.a3Bind != null && b.dataset.a3Season) { openBind(root, b.dataset.a3Bind, b.dataset.a3Season, b.dataset.a3Name); return; }
    if (b.hasAttribute("data-a3-mclear")) { manual.series = null; manual.episodes = null; manual.check = null; keepForm(root, () => paint(root)); return; }
    if (b.dataset.a3Ep) {
      const num = root.querySelector("#a3-mnum"); if (num) num.value = b.dataset.a3Ep;
      const t = root.querySelector("#a3-meptype"); if (t && b.dataset.a3Eptype) t.value = b.dataset.a3Eptype;
      manual.check = null;
      return;
    }
    if (b.hasAttribute("data-a3-msend")) { manualSend(root); return; }
    const busy = text => { b.disabled = true; b.textContent = text; };
    try {
      if (b.hasAttribute("data-a3-mcheck")) {
        const f = manualForm(root);
        if (!manual.series || !f.number) { toast("Выберите аниме и номер серии.", "error"); return; }
        busy("Проверяю…");
        try {
          manual.check = { ok: true, ...(await apiPost("/a365/manual/check", { seriesId: manual.series.id, episodeNumber: Number(f.number), type: f.type, authors: f.authors })) };
        } catch (err) { manual.check = { ok: false, error: err.message }; }
        keepForm(root, () => paint(root));
        return;
      }
      if (b.hasAttribute("data-a3-checkall")) { busy("Проверяю…"); await apiPost("/a365/check", { all: true }); }
      else if (b.hasAttribute("data-a3-checkarch")) { busy("Проверяю архив…"); await apiPost("/a365/check", { archive: true }); }
      else if (b.hasAttribute("data-a3-scan")) {
        busy("Читаю…");
        const r = await apiPost("/a365/archive/scan");
        toast(r.unindexed ? `Бот прочитает ${r.unindexed} постов архива — это пара минут.` : "Индекс архива уже полный.", "ok");
      } else if (b.dataset.a3Check) {
        busy("Проверяю…");
        const r = await apiPost("/a365/check", { key: b.dataset.a3Check });
        toast(r.ok ? "Проверки пройдены — можно заливать." : (r.dup ? "Наша озвучка этой серии уже есть на 365." : `Проверка не пройдена: ${r.error}`), r.ok ? "ok" : "error");
      } else if (b.dataset.a3Upload) {
        const ok = await askConfirm(`Залить ${b.dataset.a3Label || "серию"} на Anime 365?\n\nПеревод появится на публичном сайте после модерации 365. `
          + "Перед заливкой сервер ещё раз проверит сезон и дубли нашей озвучки — если что-то не так, не зальёт.", { yes: "Залить" });
        if (!ok) return;
        busy("Проверяю…");
        await apiPost("/a365/upload", { key: b.dataset.a3Upload });
        toast("Поставлено в очередь — бот заливает по одной.", "ok");
      } else if (b.dataset.a3Upall) {
        const keys = b.dataset.a3Upall.split(",").filter(Boolean);
        const ok = await askConfirm(`Залить на Anime 365 недостающие серии «${b.dataset.a3Name}» — ${keys.length} шт.?\n\n`
          + "Встанут в очередь, бот зальёт по одной; перед каждой — ещё раз проверка сезона и дублей.", { yes: "Залить" });
        if (!ok) return;
        busy("Ставлю в очередь…");
        let put = 0;
        const fails = [];
        for (const key of keys) {
          try { await apiPost("/a365/upload", { key }); put++; } catch (err) { fails.push(err.message); }
        }
        toast(`В очереди: ${put} из ${keys.length}.${fails.length ? ` Не поставлено: ${fails[0]}` : ""}`, fails.length ? "error" : "ok");
      } else if (b.dataset.a3Cancel) {
        busy("Убираю…");
        await apiPost("/a365/cancel", { key: b.dataset.a3Cancel });
      } else {
        return;
      }
    } catch (err) {
      toast(err.message, "error");
    }
    refresh(root);
  });
  // Смена серии, типа или подписи — прежняя проверка уже не про то, что будет загружено.
  root.addEventListener("input", e => {
    if (e.target.closest("#a3-mnum, #a3-mtype, #a3-mauthors") && manual.check) {
      manual.check = null;
      const send = root.querySelector("[data-a3-msend]"); if (send) send.disabled = true;
      const st = root.querySelector("#a3-mstatus"); if (st) st.innerHTML = `<div class="a3-note">Данные изменились — нажмите «Проверить» ещё раз.</div>`;
    }
  });
}

export async function loadA365() {
  const root = $("#a365-body");
  if (!root) return false;
  bind(root);
  if (!last) root.innerHTML = `<div class="skeleton-wrap"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
  if (view === "manual" && last) { keepForm(root, () => paint(root)); return true; }
  return refresh(root);
}
