// Nyaa/игры, вынесено из nyaa.js: внешние источники (SeaDex, AnimeTosho, nekoBT, Tsukihime); AnimeTosho: субтитры и кадры.
import { invoke, pickOutputFile } from "./tauri.js";
import { toast, apiBlob } from "./api.js";
import { $, esc } from "./utils.js";
import { fmtBytes, isHash40, sourceUrls, parseToshoTorrent, parseSubtitle, parseTsukiFull, exactLinks, parseMediainfo, highlightSubtitle, defaultShotTrack } from "./nyaa-core.js";
import { ICONS, SRC_NAMES, detail, drawerBodyHtml, hashOf, loadSources, paintDrawer, prefs, shortErr } from "./nyaa.js";
import { exitOf, routeOf, viaQuery } from "./nyaa-routes.js";

// ---------- внешние источники (SeaDex, AnimeTosho, nekoBT, Tsukihime) ----------
// Сначала напрямую с этого компьютера; если сайт не отвечает (закрыт у провайдера) —
// через сервер студии (/api/meta/relay), у которого другая сеть. Ответ «404» от сайта —
// это «в базе нет», а не поломка, поэтому дальше он не пробуется.
export const isNotFound = e => /ответил 404/.test(String(e && e.message ? e.message : e));
export const isNoConnection = e => /Не удалось загрузить|error sending request|timed out|connect/i.test(String(e && e.message ? e.message : e));

export async function metaGet(url) {
  const mode = routeOf("sources");
  const viaRelay = async () => {
    const wrapped = JSON.parse(await (await apiBlob(`/meta/relay?url=${encodeURIComponent(url)}${viaQuery("sources")}`)).text());
    if (wrapped.status === 404) throw new Error("Сайт ответил 404");
    if (wrapped.status !== 200) throw new Error(`Сайт ответил ${wrapped.status}`);
    return String(wrapped.body || "");
  };
  if (mode === "server") return viaRelay();
  try { return await invoke("meta_get", { url }); }
  catch (e) {
    if (mode === "pc" || isNotFound(e) || !isNoConnection(e)) throw e;
    let wrapped;
    try { wrapped = JSON.parse(await (await apiBlob(`/meta/relay?url=${encodeURIComponent(url)}${viaQuery("sources")}`)).text()); }
    catch (_) { throw e; }                      // на сервере ручки нет или он недоступен — показываем исходную ошибку
    if (wrapped.status === 404) throw new Error("Сайт ответил 404");
    if (wrapped.status !== 200) throw new Error(`Сайт ответил ${wrapped.status}`);
    return String(wrapped.body || "");
  }
}

// ---------- AnimeTosho: субтитры и кадры ----------
const DATA_SHOT = b64 => `data:image/jpeg;base64,${b64}`;
async function toshoRelay(params) {
  const q = new URLSearchParams({ ...params, ...(exitOf("sources") ? { via: exitOf("sources") } : {}) });
  try { return JSON.parse(await (await apiBlob(`/tosho/relay?${q}`)).text()); }
  catch (e) { throw new Error(/404|Not Found/i.test(String(e && e.message ? e.message : e)) ? "Нужно обновить сервер студии (нет ручки AnimeTosho)." : shortErr(e)); }
}

async function loadTosho(d) {
  if (d.tosho) return;
  d.tosho = { state: "loading", files: [], shots: {}, sub: null };
  const paint = () => { if (detail === d && d.tab === "tosho") $("#ny-d-body").innerHTML = drawerBodyHtml(d); };
  const hash = hashOf(d);
  if (!isHash40(hash)) { d.tosho.state = "none"; paint(); return; }
  // Tsukihime даёт точные номера тайтла (ссылки) и MediaInfo файла; не мешает AnimeTosho, если недоступен.
  metaGet(sourceUrls(hash).tsukihime).then(txt => {
    const r = parseTsukiFull(txt);
    if (!r.found) return;
    d.tosho.tsuki = r; d.exact = exactLinks(r.ids);
    if (detail === d) paintDrawer();
  }).catch(() => {});
  try {
    const r = parseToshoTorrent(await metaGet(sourceUrls(hash).animetosho));
    d.tosho.files = r.files; d.tosho.state = r.found ? "ok" : "none";
    if (r.found) d.tosho.track = defaultShotTrack(r.files[0].subs);
  } catch (e) { d.tosho.state = isNotFound(e) ? "none" : "err"; d.tosho.err = shortErr(e); }
  paint();
  if (d.tosho.state === "ok") loadShots(d, paint);
}

export async function loadMediainfo(d) {
  const t = d.tosho;
  if (!t || !t.tsuki || !t.tsuki.files.length || t.info) return;
  const f = t.tsuki.files[0];
  t.info = { state: "loading", text: "" };
  $("#ny-d-body").innerHTML = drawerBodyHtml(d);
  try {
    t.info.text = parseMediainfo(await metaGet(`https://api.tsukihime.org/v1/torrents/${t.tsuki.tid}/file/${f.id}`));
    t.info.state = t.info.text ? "ok" : "none";
  } catch (e) { t.info.state = "err"; t.info.err = shortErr(e); }
  if (detail === d && d.tab === "tosho") $("#ny-d-body").innerHTML = drawerBodyHtml(d);
}

export async function loadShots(d, paint) {
  const f = d.tosho.files[0];
  if (!f || !f.id) return;
  const stamps = f.shots.slice(0, 6);
  const track = d.tosho.track || 0;
  d.tosho.shots = {}; d.tosho.shotErr = "";
  let next = 0;
  const worker = async () => {
    while (next < stamps.length) {
      const ts = stamps[next++];
      try {
        const w = await toshoRelay({ kind: "shot", fid: f.id, ts, s: track });
        if (d.tosho.track !== track) return;
        if (w.status === 200 && w.b64) d.tosho.shots[ts] = DATA_SHOT(w.b64);
      } catch (e) { d.tosho.shotErr = String(e.message || e); }
      paint();
    }
  };
  await Promise.all([worker(), worker()]);
}

export async function openSubtitle(d, subId) {
  const file = d.tosho.files.find(f => f.subs.some(s => s.id === subId));
  const sub = file && file.subs.find(s => s.id === subId);
  if (!sub) return;
  d.tosho.sub = { id: subId, sub, state: "loading", lines: [], raw: "", q: "" };
  $("#ny-d-body").innerHTML = drawerBodyHtml(d);
  try {
    const w = await toshoRelay({ kind: "sub", aid: subId });
    if (w.status !== 200) throw new Error(`Сайт ответил ${w.status}`);
    d.tosho.sub.raw = String(w.body || "");
    d.tosho.sub.lines = parseSubtitle(d.tosho.sub.raw, sub.codec);
    d.tosho.sub.state = "ok";
  } catch (e) { d.tosho.sub.state = "err"; d.tosho.sub.err = String(e.message || e); }
  if (detail === d && d.tab === "tosho") $("#ny-d-body").innerHTML = drawerBodyHtml(d);
}

export async function saveSubtitle(d) {
  const s = d.tosho && d.tosho.sub;
  if (!s || s.state !== "ok") return;
  const ext = (s.sub.codec || "srt").toLowerCase();
  const out = await pickOutputFile(`${(d.item.title || "subtitle").replace(/[\\/:*?"<>|]/g, "_").slice(0, 80)}.${s.sub.lang}.${ext}`, [{ name: "Субтитры", extensions: [ext] }]);
  if (!out) return;
  try { await invoke("write_text_file", { path: out, content: s.raw }); toast("Субтитры сохранены.", "success"); }
  catch (e) { toast(`Не удалось сохранить: ${e}`, "error"); }
}

export function toshoTabHtml(d) {
  if (!d.tosho) setTimeout(() => loadTosho(d), 0);
  const t = d.tosho || { state: "loading" };
  if (t.state === "loading") return `<div class="ny-d-load"><div class="ny-sk w80"></div><div class="ny-sk w40"></div></div>`;
  if (t.state === "err") return `<div class="ny-empty"><b>AnimeTosho не отвечает</b><p>${esc(t.err || "")}</p></div>`;
  if (t.state === "none") return `<div class="ny-empty"><b>Этой раздачи нет на AnimeTosho</b><p>Субтитры и кадры берутся оттуда, если сайт успел разобрать файл.</p></div>`;
  const f0 = t.files[0];
  const burn = f0.subs.filter(s => s.num);
  const trackSel = burn.length ? `<div class="ny-shot-track"><span>Субтитры на кадрах:</span><select id="ny-shot-track"><option value="0">без субтитров</option>${burn.map(s => `<option value="${s.num}"${t.track === s.num ? " selected" : ""}>Дорожка ${s.num} · ${esc(s.lang)} · ${esc(s.codec || "—")}${s.forced ? " · форсированные" : ""}</option>`).join("")}</select></div>` : "";
  const shots = trackSel + (Object.keys(t.shots).length || f0.shots.length
    ? `<div class="ny-shots">${f0.shots.slice(0, 6).map(ts => t.shots[ts] ? `<button type="button" class="ny-shot" data-shot="${ts}"><img src="${esc(t.shots[ts])}" alt="Кадр"></button>` : `<div class="ny-shot sk"></div>`).join("")}</div>${t.shotErr ? `<p class="ny-hint">${esc(t.shotErr)}</p>` : ""}`
    : `<p class="ny-hint">Кадров у файла нет.</p>`);
  const LANG_OK = ["en", "eng", "enm", "und"];
  const only = prefs.subLangs !== false;
  const subs = `<label class="ny-sub-filter"><input type="checkbox" data-sub-langs ${only ? "checked" : ""}> только английские и без языка</label>` + t.files.slice(0, 6).map(f => `<div class="ny-tosho-file"><b>${esc(f.name)}</b><span>${esc(fmtBytes(f.size))}${f.fonts ? ` · шрифтов: ${f.fonts}` : ""}</span>
    ${f.subs.length ? f.subs.filter(s => !only || LANG_OK.includes(s.lang.toLowerCase())).map(s => `<div class="ny-sub-row"><span class="ny-sub-lang">${esc(s.lang)}</span><span>${esc(s.codec || "—")}${s.def ? " · по умолчанию" : ""}${s.forced ? " · форсированные" : ""} · ${esc(fmtBytes(s.size))}</span><button type="button" class="btn ghost" data-sub-open="${s.id}">Смотреть</button></div>`).join("") || `<span class="ny-hint">Нет дорожек под фильтр языка.</span>` : `<span class="ny-hint">Дорожек субтитров нет.</span>`}</div>`).join("");
  const sv = t.sub;
  const viewer = !sv ? "" : sv.state === "loading" ? `<div class="ny-d-load"><div class="ny-sk w80"></div></div>`
    : sv.state === "err" ? `<p class="ny-hint">${esc(sv.err)}</p>`
    : `<div class="ny-sub-view"><div class="ny-sub-bar"><input type="text" id="ny-sub-q" placeholder="Найти в субтитрах" value="${esc(sv.q)}" spellcheck="false"><button type="button" class="btn" data-sub-find>Найти</button><button type="button" class="btn ghost" data-sub-raw>${sv.raw_on ? "Реплики" : "Исходный текст"}</button><button type="button" class="btn ghost" data-sub-save>Сохранить файл</button><button type="button" class="ny-ib" data-sub-close aria-label="Закрыть">${ICONS.close}</button></div>
      ${sv.raw_on ? `<pre class="ny-sub-raw">${highlightSubtitle(sv.raw)}</pre>` : `<div class="ny-sub-lines">${(sv.q ? sv.lines.filter(l => l.text.toLowerCase().includes(sv.q.toLowerCase())) : sv.lines).slice(0, 600).map(l => `<div><time>${esc(l.clock)}</time><span>${esc(l.text)}</span></div>`).join("") || `<p class="ny-hint">Ничего не найдено.</p>`}</div>`}
      <p class="ny-hint">Реплик: ${sv.lines.length}${sv.lines.length > 600 && !sv.q ? " (показаны первые 600)" : ""}</p></div>`;
  const info = !t.tsuki || !t.tsuki.files.length ? "" : !t.info ? `<button type="button" class="btn ghost" data-fileinfo>Показать FileInfo (MediaInfo)</button>`
    : t.info.state === "loading" ? `<div class="ny-d-load"><div class="ny-sk w80"></div></div>`
    : t.info.state === "ok" ? `<pre class="ny-fileinfo">${esc(t.info.text)}</pre>` : `<p class="ny-hint">${esc(t.info.err || "MediaInfo недоступен.")}</p>`;
  return `<h4 class="ny-sec">Кадры</h4>${shots}<h4 class="ny-sec">Субтитры и вложения</h4>${subs}${viewer}${info ? `<h4 class="ny-sec">FileInfo</h4>${info}` : ""}`;
}

function srcLines(k, r) {
  const L = [];
  const add = (label, v) => { if (v) L.push(`<div><span>${esc(label)}</span><b>${esc(String(v))}</b></div>`); };
  if (k === "seadex") add("Оценка", r.best === true ? "лучший релиз" : r.best === false ? "запасной вариант" : "есть в базе");
  if (k === "at") { add("Название", r.title); add("Файлов", r.files || ""); }
  if (k === "neko") { add("Название", r.title); add("Загрузил", r.uploader); add("Группа", r.group); add("Раздача", r.swarm); add("Размер", r.size); add("Звук", r.audio); add("Субтитры", r.subs); add("Метки", (r.flags || []).join(", ")); }
  if (k === "tsuki") { add("Название", r.title); add("Тайтл", r.anime); add("Группа", r.group); add("Серия", r.episode); add("Размер", r.size); add("Файлов", r.files); add("Звук", r.audio); add("Субтитры", r.subs); }
  return L.join("");
}

export function sourcesTabHtml(d) {
  loadSources(d);
  const src = d.src || {};
  return `<div class="ny-srcs">${Object.keys(SRC_NAMES).map(k => {
    const r = src[k] || { s: "loading" };
    const badge = r.s === "loading" ? `<em class="load">проверяю…</em>` : r.s === "ok" ? `<em class="ok">${k === "seadex" ? (r.best === true ? "лучший" : r.best === false ? "запасной" : "найдено") : "найдено"}</em>` : r.s === "none" ? `<em>нет в базе</em>` : `<em class="bad" title="${esc(r.full || r.err || "")}">недоступен</em>`;
    return `<div class="ny-src-card"><div class="ny-src-top"><b>${SRC_NAMES[k]}</b>${badge}</div>
      ${r.s === "ok" ? `<div class="ny-src-lines">${srcLines(k, r)}</div>${r.link ? `<button type="button" class="btn ghost" data-ext="${esc(r.link)}">${ICONS.open} Открыть</button>` : ""}` : r.s === "err" ? `<p class="ny-hint">${esc(r.err)}. Возможно, сайт закрыт у вашего провайдера: включите VPN (WireGuard) и откройте вкладку заново.</p>` : ""}
    </div>`;
  }).join("")}</div>
  <p class="ny-hint">Данные запрашиваются по info hash раздачи и только когда вы открыли эту вкладку.</p>`;
}

