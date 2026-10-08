// «Сверка текста» (Инструменты): два режима поверх одного окна.
//  • Кальки — подсвечивает обороты, звучащие как дословный перевод, и
//    подсказывает, как сказать живее.
//  • Сверка — два варианта перевода (текст или субтитры .srt/.vtt/.ass):
//    реплики выравниваются по времени (или по строкам), различия
//    подсвечиваются по словам.
// Всё считается локально, ничего никуда не отправляется. Логика — в
// text-check-core.js (её проверяют тесты).

import { openSheet, dismissSheet, toast } from "./api.js";
import { $, esc } from "./utils.js";
import { findCalques, compareTranslations } from "./text-check-core.js";

let mode = "calques";
const texts = { calques: "", a: "", b: "" };
let onlyDiff = true;

async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch (_) { return new TextDecoder("windows-1251").decode(buf); } // старые субтитры
}

function pickFile(accept) {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await readTextFile(f) } : null);
    });
    input.click();
  });
}

const ACCEPT = ".txt,.srt,.vtt,.ass,.ssa";

function markedLine(line, hits) {
  let out = "", pos = 0;
  for (const h of hits) {
    out += esc(line.slice(pos, h.start)) + `<mark class="tc-m" title="${esc(h.hint)}">${esc(line.slice(h.start, h.end))}</mark>`;
    pos = h.end;
  }
  return out + esc(line.slice(pos));
}

function calquesHtml() {
  const text = texts.calques;
  if (!text.trim()) return `<div class="mt-empty"><p>Вставьте текст реплик или загрузите файл — найду обороты, которые звучат как дословный перевод.</p></div>`;
  const hits = findCalques(text);
  const lines = text.split(/\r?\n/);
  const byLine = new Map();
  for (const h of hits) { if (!byLine.has(h.line)) byLine.set(h.line, []); byLine.get(h.line).push(h); }
  const shown = lines.map((l, i) => ({ l, i, hs: (byLine.get(i) || []).sort((a, b) => a.start - b.start) })).filter(x => x.hs.length);
  const plural = (n, one, few, many) => { const m = n % 100, d = n % 10; return m > 10 && m < 20 ? many : d === 1 ? one : d >= 2 && d <= 4 ? few : many; };
  const head = hits.length
    ? `<div class="tc-sum"><b>${hits.length}</b> ${plural(hits.length, "место", "места", "мест")} в <b>${shown.length}</b> ${plural(shown.length, "реплике", "репликах", "репликах")} — стоит перечитать</div>`
    : `<div class="tc-sum ok">Дословных оборотов не нашлось — звучит живо.</div>`;
  return head + shown.map(x => `
    <div class="tc-row">
      <span class="tc-n">${x.i + 1}</span>
      <div class="tc-body">
        <div class="tc-line">${markedLine(x.l, x.hs)}</div>
        ${x.hs.map(h => `<div class="tc-hint">«${esc(h.found)}» → <b>${esc(h.hint)}</b> <i>${esc(h.note)}</i></div>`).join("")}
      </div>
    </div>`).join("");
}

function diffWords(list) {
  return list.map(x => x.d ? `<mark class="tc-d">${esc(x.w)}</mark>` : esc(x.w)).join(" ");
}

function compareHtml() {
  if (!texts.a.trim() || !texts.b.trim()) return `<div class="mt-empty"><p>Загрузите оба варианта (или вставьте текст) — и я покажу, где переводы расходятся.</p></div>`;
  const r = compareTranslations(texts.a, texts.b);
  const sim = Math.round(r.sim * 100);
  const head = `<div class="tc-sum"><b>${sim}%</b> совпадение · расходятся <b>${r.diffRows}</b> из ${r.paired} пар${r.onlyA ? ` · только в вашем: <b>${r.onlyA}</b>` : ""}${r.onlyB ? ` · только в чужом: <b>${r.onlyB}</b>` : ""} · выравнивание ${r.mode === "time" ? "по времени" : "по строкам"}
    <label class="tc-chk"><input type="checkbox" id="tc-only" ${onlyDiff ? "checked" : ""}> только отличия</label></div>`;
  const rows = r.rows.filter(x => !onlyDiff || x.kind !== "same").map((x, i) => {
    const t = (x.a ?? x.b).t;
    const ts = t == null ? "" : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
    const left = x.kind === "diff" ? diffWords(x.diff.a) : x.a ? esc(x.a.text) : `<i class="tc-none">— нет —</i>`;
    const right = x.kind === "diff" ? diffWords(x.diff.b) : x.b ? esc(x.b.text) : `<i class="tc-none">— нет —</i>`;
    return `<div class="tc-cmp ${x.kind}"><span class="tc-n">${ts || i + 1}</span><div>${left}</div><div>${right}</div></div>`;
  }).join("");
  return head + `<div class="tc-cmp tc-cmp-h"><span></span><div>Ваш вариант</div><div>Чужой вариант</div></div>` + (rows || `<div class="tc-sum ok">Различий нет.</div>`);
}

function sourceHtml(key, label) {
  return `
    <div class="tc-src">
      <div class="tc-src-h"><span>${label}</span><button class="btn ghost" data-load="${key}">Загрузить файл</button></div>
      <textarea class="field-textarea" data-ta="${key}" rows="5" placeholder="Вставьте текст или загрузите .txt / .srt / .vtt / .ass">${esc(texts[key])}</textarea>
    </div>`;
}

export function openTextCheck() {
  const o = openSheet(`
    <div class="mt-head">
      <div><span class="kd-label">Текст</span><h2>Сверка текста</h2></div>
      <button class="icon-btn mt-head-close" data-close title="Закрыть" aria-label="Закрыть">✕</button>
    </div>
    <div class="mt-op-tabs">
      <button class="mt-op-tab" data-mode="calques">Кальки</button>
      <button class="mt-op-tab" data-mode="compare">Сверка с чужим переводом</button>
    </div>
    <div id="tc-inputs"></div>
    <div id="tc-out" class="tc-out"></div>`, "wide");
  o.querySelector(".sheet").classList.add("mt-sheet");

  const paint = () => {
    o.querySelectorAll(".mt-op-tab").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
    o.querySelector("#tc-inputs").innerHTML = mode === "calques"
      ? sourceHtml("calques", "Текст реплик")
      : `<div class="tc-two">${sourceHtml("a", "Ваш вариант")}${sourceHtml("b", "Чужой вариант")}</div>`;
    result();
  };
  const result = () => {
    o.querySelector("#tc-out").innerHTML = mode === "calques" ? calquesHtml() : compareHtml();
    o.querySelector("#tc-only")?.addEventListener("change", e => { onlyDiff = e.target.checked; result(); });
  };

  o.addEventListener("input", e => {
    const ta = e.target.closest("[data-ta]");
    if (!ta) return;
    texts[ta.dataset.ta] = ta.value;
    clearTimeout(o._t);
    o._t = setTimeout(result, 250);
  });
  o.addEventListener("click", async e => {
    if (e.target.closest("[data-close]")) { dismissSheet(o); return; }
    const m = e.target.closest("[data-mode]");
    if (m) { mode = m.dataset.mode; paint(); return; }
    const l = e.target.closest("[data-load]");
    if (l) {
      const f = await pickFile(ACCEPT);
      if (!f) return;
      texts[l.dataset.load] = f.text;
      o.querySelector(`[data-ta="${l.dataset.load}"]`).value = f.text;
      toast(`Загружено: ${f.name}`);
      result();
    }
  });
  paint();
}

$("#open-text-check")?.addEventListener("click", openTextCheck);
