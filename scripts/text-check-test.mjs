// Проверка чистой логики «Сверки текста»: поиск калек, разбор субтитров,
// выравнивание и пословное сравнение. Без DOM и сборки:
//   node scripts/text-check-test.mjs

import assert from "node:assert/strict";
import { findCalques, parseCues, wordDiff, alignCues, compareTranslations } from "../src/app/text-check-core.js";

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`✓ ${name}`); };

ok("калька находится и даёт подсказку", () => {
  const r = findCalques("Он взял себя в руки.\nМы сделали это!");
  assert.equal(r.length, 2);
  assert.equal(r[0].line, 0);
  assert.equal(r[0].hint, "собраться");
  assert.equal(r[1].line, 1);
});

ok("живая фраза не помечается", () => {
  assert.equal(findCalques("Он собрался и пошёл. У нас получилось!").length, 0);
});

ok("srt разбирается с таймкодами", () => {
  const cues = parseCues("1\n00:00:01,000 --> 00:00:03,000\nПривет!\n\n2\n00:01:02,500 --> 00:01:04,000\nПока,\nмир\n");
  assert.equal(cues.length, 2);
  assert.equal(cues[0].t, 1);
  assert.equal(cues[1].t, 62.5);
  assert.equal(cues[1].text, "Пока, мир");
});

ok("ass: берётся только текст реплики", () => {
  const bs = String.fromCharCode(92), nl = String.fromCharCode(10);
  const raw = ["[Script Info]", "[Events]", "Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,{" + bs + "i1}Привет" + bs + "Nмир"].join(nl);
  const cues = parseCues(raw);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].t, 5);
  assert.equal(cues[0].text, "Привет мир");
});

ok("простой текст — по реплике на строку", () => {
  const cues = parseCues("Раз\n\nДва\n");
  assert.deepEqual(cues.map(c => c.text), ["Раз", "Два"]);
  assert.equal(cues[0].t, null);
});

ok("пословный diff: ё=е, регистр и знаки не мешают", () => {
  const d = wordDiff("Мы выжили, всё!", "мы выжили все");
  assert.equal(d.a.filter(x => x.d).length, 0);
  assert.equal(wordDiff("Привет, мир", "привет мир").sim, 1);
  assert.equal(wordDiff("Мы выжили", "Мы справились").a.filter(x => x.d).length, 1);
});

ok("выравнивание по времени", () => {
  const A = [{ t: 1, text: "а" }, { t: 10, text: "б" }];
  const B = [{ t: 1.4, text: "а" }, { t: 20, text: "в" }];
  const { rows, mode } = alignCues(A, B);
  assert.equal(mode, "time");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].b.text, "а");
  assert.equal(rows[1].b, null);
  assert.equal(rows[2].a, null);
});

ok("сверка: сводка отличий", () => {
  const r = compareTranslations("Мы выживем\nПока", "Мы справимся\nПока");
  assert.equal(r.paired, 2);
  assert.equal(r.diffRows, 1);
  assert.equal(r.rows[1].kind, "same");
});

console.log(`\nВсе ${n} проверок прошли`);
