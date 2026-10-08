// Чистая логика проверки текста перевода (без DOM — её гоняют тесты):
// 1) поиск «калек» — оборотов, которые звучат как дословный перевод;
// 2) сверка двух вариантов перевода: разбор субтитров/текста, выравнивание
//    реплик и пословное сравнение.

// [шаблон, подсказка, пояснение]. Шаблоны — по корню слова, без учёта
// регистра; подсказка — как сказать живее. Список намеренно короткий и
// консервативный: лучше пропустить спорное, чем засыпать ложными срабатываниями.
const RULES = [
  [/взя(?:ть|л|ла|ли|ли́)\s+себя\s+в\s+руки/i, "собраться", "дословно «pull yourself together»"],
  [/это\s+име(?:ет|ло)\s+смысл/i, "в этом есть смысл / логично", "«that makes sense»"],
  [/дел(?:ать|аю|аешь|ает|аем)\s+деньги/i, "зарабатывать", "«make money»"],
  [/мы\s+сделали\s+это/i, "у нас получилось", "«we did it»"],
  [/я\s+сделаю\s+это\b/i, "я справлюсь / займусь этим", "«I'll do it»"],
  [/дай(?:те)?\s+мне\s+знать/i, "сообщи / дай знать", "«let me know»"],
  [/как\s+насчёт/i, "а если / давай", "«how about»"],
  [/позаботь(?:ся|тесь)\s+о\s+себе/i, "береги себя", "«take care of yourself»"],
  [/не\s+беспокой(?:ся|тесь)\s+об\s+этом/i, "не бери в голову", "«don't worry about it»"],
  [/я\s+должен\s+идти|я\s+должна\s+идти/i, "мне пора", "«I have to go»"],
  [/ты\s+в\s+порядке\s*\?|вы\s+в\s+порядке\s*\?/i, "ты как? / с тобой всё хорошо?", "«are you okay»"],
  [/рад(?:а)?\s+встретить\s+(?:тебя|вас)/i, "рад знакомству", "«nice to meet you»"],
  [/хорошая\s+работа/i, "отлично сработано / молодец", "«good job»"],
  [/по\s+моему\s+мнению|по\s+мо[её]му\s+мнению/i, "по-моему", "громоздкий оборот"],
  [/(?:я|мы)\s+име(?:ю|ем)\s+(?:проблему|вопрос|идею)/i, "у меня проблема / вопрос / идея", "«I have a problem»"],
  [/иметь\s+проблему/i, "столкнуться с проблемой", "«have a problem»"],
  [/быть\s+в\s+состоянии/i, "мочь / суметь", "«be able to»"],
  [/в\s+этот\s+момент\b/i, "сейчас / тогда", "«at this moment»"],
  [/это\s+не\s+весело/i, "ничего смешного", "«it's not funny»"],
  [/дайте\s+мне\s+минутку|дай\s+мне\s+минутку/i, "минутку / погоди", "«give me a minute»"],
  [/я\s+говорю\s+(?:тебе|вам)\b/i, "говорю же / слушай", "«I'm telling you»"],
  [/позволь(?:те)?\s+мне/i, "дай(те) / разреши(те)", "«let me»"],
  [/я\s+собираюсь|мы\s+собираемся|ты\s+собираешься|он\s+собирается|она\s+собирается/i, "перестроить фразу: «сейчас…», «хочу…», «намерен…»", "«going to»"],
  [/что\s+ты\s+делаешь\s+здесь/i, "ты что здесь забыл? / что ты здесь делаешь", "порядок слов «what are you doing here»"],
  [/как\s+вы\s+знаете|как\s+ты\s+знаешь/i, "если ты знаешь / сам знаешь", "«as you know»"],
  [/не\s+имеет\s+значения/i, "неважно / какая разница", "«doesn't matter»"],
  [/в\s+конце\s+дня/i, "в итоге / в конце концов", "«at the end of the day»"],
  [/ты\s+шутишь\s+со\s+мной/i, "ты издеваешься? / шутишь", "«are you kidding me»"],
  [/получить\s+(?:обратно|назад)/i, "вернуть", "«get back»"],
];

export function findCalques(text) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [re, hint, note] of RULES) {
      const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
      const g = new RegExp(re.source, flags);
      let m;
      while ((m = g.exec(line))) {
        out.push({ line: i, start: m.index, end: m.index + m[0].length, found: m[0], hint, note });
        if (m[0].length === 0) g.lastIndex++;
      }
    }
  });
  return out;
}

// ---------- разбор субтитров ----------

const toSec = (h, m, s, ms) => (+h) * 3600 + (+m) * 60 + (+s) + (+(ms || 0)) / (ms && ms.length === 3 ? 1000 : ms && ms.length === 2 ? 100 : 1);

function clean(t) {
  return t.replace(/\{[^}]*\}/g, "").replace(/<[^>]+>/g, "").replace(/\\N|\\n/g, " ").replace(/\s+/g, " ").trim();
}

// -> [{ t: секунды|null, text }]. Понимает .srt, .vtt, .ass/.ssa и простой текст
// (одна реплика на строку).
export function parseCues(raw) {
  const text = String(raw || "").replace(/^﻿/, "");
  const cues = [];
  if (/^\s*\[Script Info\]/im.test(text) || /^Dialogue:/im.test(text)) {
    for (const line of text.split(/\r?\n/)) {
      const m = /^Dialogue:\s*[^,]*,\s*(\d+):(\d+):(\d+)[.,](\d+),[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/.exec(line);
      if (m) { const t = clean(m[5]); if (t) cues.push({ t: toSec(m[1], m[2], m[3], m[4]), text: t }); }
    }
    return cues;
  }
  const tc = /(\d+):(\d{2}):(\d{2})[.,](\d{2,3})\s*-->/;
  if (tc.test(text)) {
    for (const block of text.split(/\r?\n\s*\r?\n/)) {
      const rows = block.split(/\r?\n/);
      const idx = rows.findIndex(r => tc.test(r));
      if (idx < 0) continue;
      const m = tc.exec(rows[idx]);
      const t = clean(rows.slice(idx + 1).join(" "));
      if (t) cues.push({ t: toSec(m[1], m[2], m[3], m[4]), text: t });
    }
    return cues;
  }
  for (const line of text.split(/\r?\n/)) {
    const t = clean(line);
    if (t) cues.push({ t: null, text: t });
  }
  return cues;
}

// ---------- сверка двух переводов ----------

const words = s => s.split(/\s+/).filter(Boolean);
const norm = w => w.toLowerCase().replace(/[.,!?…:;"«»()—–-]+/g, "").replace(/ё/g, "е");

// Пословный diff (LCS). -> { a: [{w, d}], b: [{w, d}], same }, d — слово
// не совпало с другой стороной.
export function wordDiff(aText, bText) {
  const A = words(aText), B = words(bText);
  const na = A.map(norm), nb = B.map(norm);
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = na[i] === nb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ra = A.map(w => ({ w, d: true })), rb = B.map(w => ({ w, d: true }));
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (na[i] === nb[j]) { ra[i].d = false; rb[j].d = false; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const same = dp[0][0];
  return { a: ra, b: rb, same, sim: n + m ? (2 * same) / (n + m) : 1 };
}

// Выравнивание: если у обеих сторон есть тайм-коды — по ближайшему
// времени (в пределах tol секунд), иначе по порядковому номеру.
export function alignCues(A, B, tol = 1.5) {
  const timed = A.length && B.length && A.every(c => c.t != null) && B.every(c => c.t != null);
  const rows = [];
  if (!timed) {
    const n = Math.max(A.length, B.length);
    for (let i = 0; i < n; i++) rows.push({ a: A[i] || null, b: B[i] || null });
    return { rows, mode: "line" };
  }
  const used = new Set();
  for (const a of A) {
    let best = -1, bd = Infinity;
    B.forEach((b, k) => { const d = Math.abs(b.t - a.t); if (!used.has(k) && d <= tol && d < bd) { bd = d; best = k; } });
    if (best >= 0) { used.add(best); rows.push({ a, b: B[best] }); } else rows.push({ a, b: null });
  }
  B.forEach((b, k) => { if (!used.has(k)) rows.push({ a: null, b }); });
  rows.sort((x, y) => ((x.a ?? x.b).t) - ((y.a ?? y.b).t));
  return { rows, mode: "time" };
}

export function compareTranslations(rawA, rawB) {
  const { rows, mode } = alignCues(parseCues(rawA), parseCues(rawB));
  let diffRows = 0, simSum = 0, paired = 0, onlyA = 0, onlyB = 0;
  const out = rows.map(r => {
    if (!r.a) { onlyB++; return { ...r, kind: "onlyB" }; }
    if (!r.b) { onlyA++; return { ...r, kind: "onlyA" }; }
    const d = wordDiff(r.a.text, r.b.text);
    paired++; simSum += d.sim;
    const same = d.sim === 1;
    if (!same) diffRows++;
    return { ...r, kind: same ? "same" : "diff", diff: d };
  });
  return { rows: out, mode, paired, diffRows, onlyA, onlyB, sim: paired ? simSum / paired : 0 };
}
