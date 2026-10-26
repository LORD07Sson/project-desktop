// «Сервисы → Anime 365» — заливка финалов озвучкой на smotret-anime.org (сервер: anime365.py бота).
// Сервер: GET /api/a365 (аккаунт, все серии с собранным финалом и их состояние), POST /api/a365/check {public_id | all},
// POST /api/a365/upload {public_id} (сначала обязательная проверка, потом общая очередь — заливает бот, по одной),
// POST /api/a365/cancel {public_id} (убрать из очереди то, что ещё ждёт).
// Проверки обязательные и на сервере: сезон (номер, сезон выхода, число серий) и дубль нашей озвучки на 365.

import { apiGet, apiPost, askConfirm, toast } from "./api.js";
import { esc, relTime } from "./utils.js";
import { openExternal } from "./tauri.js";

const FILTERS = [
  ["todo", "Не залито"],
  ["queue", "Очередь"],
  ["done", "На 365"],
  ["all", "Все"],
];

let filter = "todo";
let pollTimer = null;

function kindOf(it) {
  if (it.stage === "done") return "done";
  if (it.stage === "queued" || it.stage === "uploading") return "queue";
  if (it.stage === "failed") return "bad";
  if (!it.check) return "unchecked";
  if (!it.check.ok && it.check.dup) return "elsewhere"; // наша озвучка уже на 365 (залита не через бота)
  return it.check.ok ? "ready" : "bad";
}

function fmtSize(n) {
  return n ? `${(n / 1048576).toFixed(0)} МБ` : "";
}

function statusHtml(it) {
  const k = kindOf(it);
  if (it.stage === "done") return `<span class="a3-pill ok">Залито</span>`;
  if (it.stage === "uploading") {
    const pct = Math.max(0, Math.min(100, it.progress || 0));
    return `<span class="a3-pill run">Заливается ${pct}%</span>`;
  }
  if (it.stage === "queued") return `<span class="a3-pill run">В очереди${it.queue_pos ? ` №${it.queue_pos}` : ""}</span>`;
  if (k === "elsewhere") return `<span class="a3-pill ok">Уже на 365</span>`;
  if (it.stage === "failed") return `<span class="a3-pill bad">Не залилось</span>`;
  if (k === "ready") return `<span class="a3-pill ready">Готово к заливке</span>`;
  if (k === "bad") return `<span class="a3-pill bad">Проверка не пройдена</span>`;
  return `<span class="a3-pill">Не проверено</span>`;
}

function detailHtml(it) {
  if (it.stage === "done") return `<button type="button" class="a3-link" data-a3-open="${esc(it.url)}">${esc(it.url)}</button>`;
  if (it.stage === "uploading") {
    const pct = Math.max(0, Math.min(100, it.progress || 0));
    return `<div class="a3-bar"><i style="width:${pct}%"></i></div><div class="a3-note">${esc(it.text || "")}</div>`;
  }
  if (it.stage === "queued") return `<div class="a3-note">${esc(it.text || "Ждёт своей очереди — перед заливкой проверки пройдут ещё раз")}</div>`;
  const c = it.check;
  if (kindOf(it) === "elsewhere") return `<div class="a3-note">Наша озвучка этой серии уже есть на 365 — второй раз не зальётся.</div>
    <button type="button" class="a3-link" data-a3-open="${esc(c.dup)}">${esc(c.dup)}</button>`;
  if (it.stage === "failed") return `<div class="a3-note bad">${esc(it.error || "")}</div>`;
  if (!c) return `<div class="a3-note">Сезон и дубли ещё не проверялись.</div>`;
  if (!c.ok) return `<div class="a3-note bad">${esc(c.error)}</div><div class="a3-note">проверено ${esc(relTime(c.at))}</div>`;
  return `<div class="a3-note">${(c.lines || []).map(esc).join(" · ")}</div>
    <div class="a3-note">на 365: ${esc(c.series || "")} · проверено ${esc(relTime(c.at))}</div>`;
}

function actionsHtml(it) {
  const pid = esc(it.public_id);
  if (it.stage === "done" || it.stage === "uploading") return "";
  if (it.stage === "queued") return `<button type="button" class="btn ghost sm" data-a3-cancel="${pid}">Убрать</button>`;
  const k = kindOf(it);
  const check = `<button type="button" class="btn ghost sm" data-a3-check="${pid}">${it.check ? "Проверить снова" : "Проверить"}</button>`;
  // «Залить» — только после пройденной проверки (сервер всё равно проверит ещё раз).
  return k === "ready" ? `${check}<button type="button" class="btn primary sm" data-a3-upload="${pid}">Залить</button>` : check;
}

function rowHtml(it) {
  return `
    <div class="a3-row">
      <div class="a3-main">
        <div class="a3-title">${esc(it.title)} <b>· серия ${esc(String(it.episode ?? "?"))}</b></div>
        <div class="a3-meta">${esc(it.public_id)} · ${esc(it.file || "")}${it.size ? ` · ${fmtSize(it.size)}` : ""}</div>
        ${detailHtml(it)}
      </div>
      <div class="a3-side">${statusHtml(it)}<div class="a3-actions">${actionsHtml(it)}</div></div>
    </div>`;
}

function render(slot, d) {
  const items = d.items || [];
  const count = k => items.filter(it => kindOf(it) === k).length;
  const isDone = it => ["done", "elsewhere"].includes(kindOf(it));
  const acc = d.account || {};
  const cell = (label, value, sub, tone) =>
    `<div class="bs-cell"><span>${esc(label)}</span><b class="${tone || ""}">${esc(String(value))}</b>${sub ? `<em>${esc(sub)}</em>` : ""}</div>`;
  const shown = items.filter(it => filter === "all" ? true
    : filter === "done" ? isDone(it)
      : filter === "queue" ? ["queued", "uploading"].includes(it.stage)
        : !isDone(it) && !["queued", "uploading"].includes(it.stage));
  const empty = { todo: "Всё собранное уже на 365 🎉", queue: "Очередь пуста", done: "На 365 пока ничего нет", all: "Собранных финалов пока нет" }[filter];
  slot.innerHTML = `
    <div class="bcell bs-card a3-card" style="animation-delay:140ms;">
      <div class="dash-cell-head">
        <span class="dash-cell-title">Anime 365</span>
        <span class="dash-cell-hint">${acc.ok ? `аккаунт ${esc(acc.name || "")} · подпись «${esc(acc.authors || "")}»` : `<span class="a3-bad">нет входа на 365: ${esc(acc.error || "аккаунт не принят")}</span>`}</span>
        <span style="flex:1"></span>
        <button type="button" class="btn ghost sm" data-a3-checkall>Проверить всё</button>
      </div>
      <div class="bs-grid">
        ${cell("На 365", count("done") + count("elsewhere"), count("elsewhere") ? `${count("done")} через бота, ${count("elsewhere")} вручную` : "залито через бота")}
        ${cell("В очереди", count("queue"), d.uploading ? `сейчас: ${d.uploading}` : "заливается по одной", count("queue") ? "warn" : "")}
        ${cell("Готово к заливке", count("ready"), "проверки пройдены")}
        ${cell("Проблемы", count("bad"), `${count("unchecked")} не проверено`, count("bad") ? "danger" : "")}
      </div>
      <div class="a3-filters">${FILTERS.map(([k, label]) => `<button type="button" class="a3-filter${filter === k ? " on" : ""}" data-a3-filter="${k}">${label}</button>`).join("")}</div>
      <div class="a3-list">${shown.map(rowHtml).join("") || `<div class="no-assignee">${empty}</div>`}</div>
    </div>`;
}

async function refresh(slot) {
  let d;
  try { d = await apiGet("/a365"); } catch (_) { slot.remove(); return; }
  if (!slot.isConnected) return;
  render(slot, d);
  clearTimeout(pollTimer);
  // Пока что-то в очереди или заливается — обновляемся сами, чтобы были видны проценты.
  if ((d.items || []).some(it => it.stage === "queued" || it.stage === "uploading")) {
    pollTimer = setTimeout(() => { if (slot.isConnected) refresh(slot); }, 3000); // DevSkim: ignore DS172411 — функция, не строка
  }
}

export function mountA365(slot) {
  if (!slot) return;
  slot.addEventListener("click", async e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.a3Filter) { filter = b.dataset.a3Filter; refresh(slot); return; }
    if (b.dataset.a3Open) { openExternal(b.dataset.a3Open); return; }
    const busy = text => { b.disabled = true; b.textContent = text; };
    try {
      if (b.hasAttribute("data-a3-checkall")) {
        busy("Проверяю…");
        await apiPost("/a365/check", { all: true });
      } else if (b.dataset.a3Check) {
        busy("Проверяю…");
        const r = await apiPost("/a365/check", { public_id: b.dataset.a3Check });
        toast(r.ok ? "Проверки пройдены — можно заливать." : `Проверка не пройдена: ${r.error}`, r.ok ? "ok" : "error");
      } else if (b.dataset.a3Upload) {
        const ok = await askConfirm(`Залить ${b.dataset.a3Upload} на Anime 365?\n\nПеревод появится на публичном сайте после модерации 365. `
          + "Перед заливкой сервер ещё раз проверит сезон и дубли нашей озвучки — если что-то не так, не зальёт.", { yes: "Залить" });
        if (!ok) return;
        busy("Проверяю…");
        await apiPost("/a365/upload", { public_id: b.dataset.a3Upload });
        toast("Поставлено в очередь — бот заливает по одной.", "ok");
      } else if (b.dataset.a3Cancel) {
        busy("Убираю…");
        await apiPost("/a365/cancel", { public_id: b.dataset.a3Cancel });
      } else {
        return;
      }
    } catch (err) {
      toast(err.message, "error");
    }
    refresh(slot);
  });
  refresh(slot);
}
