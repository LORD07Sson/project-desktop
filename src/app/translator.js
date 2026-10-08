// «Переводчик» (Инструменты): текст и субтитры (.srt/.vtt/.ass) с любого
// языка на любой — по умолчанию английский → русский. Два режима:
//  • Обычный — бесплатная веб-точка Google Translate через Rust-команду
//    translate_text (translate.rs): из окна наружу ходить нельзя.
//  • Умный — перевод через Claude на сервере (/api/translate/smart,
//    smart_translate.py): понимает контекст сцены, держит глоссарий и
//    единый стиль, для озвучки укладывает длину реплики в оригинал.
// Субтитры переводятся пакетами по репликам, тайм-коды остаются на месте,
// готовый файл можно скачать.
// ВАЖНО: переводимый текст уходит на сервера Google / Anthropic.

import { openSheet, dismissSheet, toast, apiGet, apiPost } from "./api.js";
import { invoke } from "./tauri.js";
import { $ } from "./utils.js";
import { prepareSubtitle, makeBatches, splitBatchResult } from "./translator-core.js";

const LANGS = [
  ["en", "Английский"], ["ru", "Русский"], ["uk", "Украинский"], ["be", "Белорусский"], ["ja", "Японский"], ["ko", "Корейский"],
  ["zh-CN", "Китайский (упр.)"], ["zh-TW", "Китайский (трад.)"], ["es", "Испанский"], ["de", "Немецкий"], ["fr", "Французский"],
  ["it", "Итальянский"], ["pt", "Португальский"], ["tr", "Турецкий"], ["pl", "Польский"], ["cs", "Чешский"], ["nl", "Нидерландский"],
  ["sv", "Шведский"], ["fi", "Финский"], ["el", "Греческий"], ["he", "Иврит"], ["ar", "Арабский"], ["hi", "Хинди"], ["vi", "Вьетнамский"],
  ["th", "Тайский"], ["id", "Индонезийский"], ["ka", "Грузинский"], ["kk", "Казахский"], ["uz", "Узбекский"], ["az", "Азербайджанский"],
].sort((a, b) => a[1].localeCompare(b[1], "ru"));
const NAME = Object.fromEntries(LANGS);
const PREF_KEY = "project-translator-prefs";
const EXT = { srt: "srt", vtt: "vtt", ass: "ass", text: "txt" };
const TONES = [["natural", "Живая речь"], ["neutral", "Нейтральный"], ["formal", "Официальный"], ["casual", "Неформальный, со сленгом"]];

const prefs = { from: "en", to: "ru", smart: false, tone: "natural", dub: true, context: "", glossary: "" };
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY)) || {}); } catch (_) { /* первый запуск */ }
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) { /* не критично */ } };

async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch (_) { return new TextDecoder("windows-1251").decode(buf); } // старые субтитры
}

function pickFile() {
  return new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,.srt,.vtt,.ass,.ssa";
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await readTextFile(f) } : null);
    });
    input.click();
  });
}

const options = (selected, withAuto) =>
  (withAuto ? `<option value="auto" ${selected === "auto" ? "selected" : ""}>Определить язык</option>` : "") +
  LANGS.map(([c, n]) => `<option value="${c}" ${c === selected ? "selected" : ""}>${n}</option>`).join("");

const callPlain = (text, f, t) => invoke("translate_text", { text, from: f, to: t });
const attr = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function openTranslator() {
  const o = openSheet(`
    <div class="mt-head">
      <div><span class="kd-label">Текст</span><h2>Переводчик</h2></div>
      <button class="icon-btn mt-head-close" data-close title="Закрыть" aria-label="Закрыть">✕</button>
    </div>
    <div class="mt-op-tabs tl-mode">
      <button class="mt-op-tab" data-mode="plain">Обычный</button>
      <button class="mt-op-tab" data-mode="smart">Умный <small id="tl-smart-state"></small></button>
    </div>
    <div class="tl-smart" id="tl-smart" hidden>
      <div class="tl-smart-row">
        <label>О чём тайтл или сцена<input class="field-input" id="tl-ctx" maxlength="1500" placeholder="например: боевик, герой Рэн — резкий, говорит коротко; второй герой — его наставник" value="${attr(prefs.context)}"></label>
        <label>Стиль<select class="field-input" id="tl-tone">${TONES.map(([k, n]) => `<option value="${k}" ${k === prefs.tone ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      </div>
      <div class="tl-smart-row">
        <label>Глоссарий — по строке: термин = перевод<textarea class="field-textarea" id="tl-gl" rows="3" maxlength="3000" placeholder="Hollow Gate = Врата Пустоты&#10;Ren = Рэн">${attr(prefs.glossary)}</textarea></label>
        <label class="tl-dub"><input type="checkbox" id="tl-dub" ${prefs.dub ? "checked" : ""}> Для озвучки: длина близка к оригиналу</label>
      </div>
    </div>
    <div class="tl-bar">
      <select class="field-input" id="tl-from">${options(prefs.from, true)}</select>
      <button class="icon-btn tl-swap" id="tl-swap" title="Поменять языки местами" aria-label="Поменять языки">⇄</button>
      <select class="field-input" id="tl-to">${options(prefs.to, false)}</select>
    </div>
    <div class="tl-cols">
      <div class="tl-pane">
        <div class="tl-h"><span id="tl-src-lbl">Оригинал</span><button class="btn ghost" id="tl-file">Загрузить файл</button></div>
        <textarea class="field-textarea" id="tl-in" placeholder="Вставьте текст или загрузите .txt / .srt / .vtt / .ass"></textarea>
        <div class="tl-f"><span id="tl-count">0 знаков</span></div>
      </div>
      <div class="tl-pane">
        <div class="tl-h"><span id="tl-dst-lbl">Перевод</span><span><button class="btn ghost" id="tl-copy" disabled>Копировать</button> <button class="btn ghost" id="tl-save" disabled>Скачать</button></span></div>
        <textarea class="field-textarea" id="tl-out" readonly placeholder="Здесь появится перевод"></textarea>
        <div class="tl-f"><span id="tl-status"></span></div>
      </div>
    </div>
    <div class="tl-actions">
      <span class="tl-note" id="tl-note"></span>
      <button class="btn primary" id="tl-go">Перевести <small>Ctrl+Enter</small></button>
    </div>`, "wide");
  o.querySelector(".sheet").classList.add("mt-sheet");

  const el = id => o.querySelector(id);
  let kind = "text";
  let busy = false;
  let smartOk = null; // null — ещё не знаем

  const labels = () => {
    el("#tl-src-lbl").textContent = prefs.from === "auto" ? "Оригинал" : NAME[prefs.from] || "Оригинал";
    el("#tl-dst-lbl").textContent = NAME[prefs.to] || "Перевод";
  };
  const count = () => { el("#tl-count").textContent = `${el("#tl-in").value.length.toLocaleString("ru-RU")} знаков`; };
  const status = t => { el("#tl-status").textContent = t; };
  const paintMode = () => {
    o.querySelectorAll("[data-mode]").forEach(b => b.classList.toggle("active", (b.dataset.mode === "smart") === prefs.smart));
    el("#tl-smart").hidden = !prefs.smart;
    el("#tl-note").textContent = prefs.smart
      ? "Умный перевод идёт через Claude: текст уходит в Anthropic — не вставляйте то, что нельзя показывать наружу."
      : "Текст отправляется в Google Translate — не вставляйте то, что нельзя показывать наружу.";
    el("#tl-smart-state").textContent = smartOk === false ? "· не настроен" : "";
  };
  const readSmartFields = () => {
    prefs.context = el("#tl-ctx").value;
    prefs.glossary = el("#tl-gl").value;
    prefs.tone = el("#tl-tone").value;
    prefs.dub = el("#tl-dub").checked;
    savePrefs();
  };

  apiGet("/translate/smart/status").then(s => { smartOk = !!s.configured; paintMode(); }).catch(() => { smartOk = null; });

  async function translatePlain(sub, raw) {
    if (sub.kind === "text") {
      status("Перевожу…");
      const r = await callPlain(raw, prefs.from, prefs.to);
      return { result: r.text, detected: r.detected };
    }
    const tr = new Array(sub.texts.length).fill("");
    const batches = makeBatches(sub.texts);
    let detected = null;
    for (let b = 0; b < batches.length; b++) {
      status(`Субтитры: пакет ${b + 1} из ${batches.length} · реплик ${sub.texts.length}`);
      const idx = batches[b];
      const r = await callPlain(idx.map(i => sub.texts[i]).join("\n"), prefs.from, prefs.to);
      detected = detected || r.detected;
      const lines = splitBatchResult(r.text, idx.length);
      if (lines) idx.forEach((i, k) => { tr[i] = lines[k]; });
      else for (const i of idx) { tr[i] = (await callPlain(sub.texts[i], prefs.from, prefs.to)).text.trim(); } // строки разъехались — по одной
    }
    return { result: sub.build(tr), detected };
  }

  async function translateSmart(sub, raw) {
    readSmartFields();
    // Обычный текст — по строкам (пустые сохраняются), субтитры — по репликам.
    let texts, rebuild;
    if (sub.kind === "text") {
      const lines = raw.split(/\r?\n/);
      const idx = [];
      lines.forEach((l, i) => { if (l.trim()) idx.push(i); });
      texts = idx.map(i => lines[i].trim());
      rebuild = tr => { const out = lines.slice(); idx.forEach((li, k) => { out[li] = tr[k]; }); return out.join("\n"); };
    } else { texts = sub.texts; rebuild = tr => sub.build(tr); }
    const tr = new Array(texts.length).fill("");
    const batches = makeBatches(texts, 3500, 40);
    let prev = [], model = "";
    for (let b = 0; b < batches.length; b++) {
      status(`Умный перевод: часть ${b + 1} из ${batches.length} · реплик ${texts.length}`);
      const idx = batches[b];
      const r = await apiPost("/translate/smart", {
        texts: idx.map(i => texts[i]), source: prefs.from, target: prefs.to, tone: prefs.tone,
        context: prefs.context, glossary: prefs.glossary, dub: prefs.dub, prev,
      });
      model = r.model;
      idx.forEach((i, k) => { tr[i] = r.texts[k]; });
      prev = idx.map((i, k) => ({ src: texts[i], dst: r.texts[k] })).slice(-4);
    }
    return { result: rebuild(tr), detected: null, model };
  }

  async function translate() {
    if (busy) return;
    const raw = el("#tl-in").value;
    if (!raw.trim()) { toast("Вставьте текст для перевода.", "error"); return; }
    if (prefs.smart && prefs.from !== "auto" && prefs.from === prefs.to) { toast("Язык оригинала и перевода совпадают.", "error"); return; }
    busy = true;
    const go = el("#tl-go");
    go.disabled = true;
    el("#tl-copy").disabled = true; el("#tl-save").disabled = true;
    try {
      const sub = prepareSubtitle(raw);
      kind = sub.kind;
      const r = prefs.smart ? await translateSmart(sub, raw) : await translatePlain(sub, raw);
      el("#tl-out").value = r.result;
      el("#tl-copy").disabled = false;
      el("#tl-save").disabled = false;
      const what = sub.kind === "text" ? "" : `субтитры (${sub.kind.toUpperCase()}, ${sub.texts.length} реплик) · `;
      const how = prefs.smart ? `умный перевод${r.model ? ` (${r.model})` : ""}` : (r.detected && prefs.from === "auto" ? `определён язык: ${NAME[r.detected] || r.detected}` : "готово");
      status(what + how);
    } catch (e) {
      status("");
      toast(String(e.message || e), "error");
    } finally {
      busy = false;
      go.disabled = false;
    }
  }

  o.addEventListener("click", async e => {
    if (e.target.closest("[data-close]")) { dismissSheet(o); return; }
    const m = e.target.closest("[data-mode]");
    if (m) { prefs.smart = m.dataset.mode === "smart"; savePrefs(); paintMode(); return; }
    if (e.target.closest("#tl-go")) translate();
    else if (e.target.closest("#tl-swap")) {
      const outText = el("#tl-out").value;
      const newTo = prefs.from === "auto" ? "en" : prefs.from;
      prefs.from = prefs.to; prefs.to = newTo;
      el("#tl-from").value = prefs.from; el("#tl-to").value = prefs.to;
      if (outText) { el("#tl-in").value = outText; el("#tl-out").value = ""; count(); }
      savePrefs(); labels();
    } else if (e.target.closest("#tl-file")) {
      const f = await pickFile();
      if (!f) return;
      el("#tl-in").value = f.text;
      count();
      toast(`Загружено: ${f.name}`);
    } else if (e.target.closest("#tl-copy")) {
      try { await navigator.clipboard.writeText(el("#tl-out").value); toast("Перевод скопирован."); } catch (_) { toast("Не удалось скопировать.", "error"); }
    } else if (e.target.closest("#tl-save")) {
      const blob = new Blob([el("#tl-out").value], { type: "text/plain;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `translated_${prefs.to}.${EXT[kind] || "txt"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  });
  el("#tl-from").addEventListener("change", e => { prefs.from = e.target.value; savePrefs(); labels(); });
  el("#tl-to").addEventListener("change", e => { prefs.to = e.target.value; savePrefs(); labels(); });
  el("#tl-in").addEventListener("input", count);
  for (const id of ["#tl-ctx", "#tl-gl", "#tl-tone", "#tl-dub"]) el(id).addEventListener("change", readSmartFields);
  o.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); translate(); } });
  labels();
  paintMode();
  setTimeout(() => el("#tl-in").focus(), 50);
}

$("#open-translator")?.addEventListener("click", openTranslator);
