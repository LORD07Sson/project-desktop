// Проверка чистой логики «Переводчика»: разбор субтитров, сборка файла с
// переводом, нарезка на пакеты. Без DOM, сети и сборки:
//   node scripts/translator-test.mjs

import assert from "node:assert/strict";
import { prepareSubtitle, makeBatches, splitBatchResult } from "../src/app/translator-core.js";

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`✓ ${name}`); };
const NL = String.fromCharCode(10);
const join = (...rows) => rows.join(NL);

ok("srt: реплики вынимаются, теги чистятся", () => {
  const raw = join("1", "00:00:01,000 --> 00:00:03,000", "<i>Hello</i>", "world", "", "2", "00:00:04,000 --> 00:00:05,000", "Bye", "");
  const s = prepareSubtitle(raw);
  assert.equal(s.kind, "srt");
  assert.deepEqual(s.texts, ["Hello world", "Bye"]);
});

ok("srt: сборка сохраняет номера и тайм-коды", () => {
  const raw = join("1", "00:00:01,000 --> 00:00:03,000", "Hello", "", "2", "00:00:04,000 --> 00:00:05,000", "Bye", "");
  const out = prepareSubtitle(raw).build(["Привет", "Пока"]);
  assert.equal(out, join("1", "00:00:01,000 --> 00:00:03,000", "Привет", "", "2", "00:00:04,000 --> 00:00:05,000", "Пока", ""));
});

ok("vtt распознаётся", () => {
  const raw = join("WEBVTT", "", "00:00:01.000 --> 00:00:02.000", "Hi", "");
  const s = prepareSubtitle(raw);
  assert.equal(s.kind, "vtt");
  assert.equal(s.build(["Привет"]), join("WEBVTT", "", "00:00:01.000 --> 00:00:02.000", "Привет", ""));
});

ok("ass: подставляется только текст реплики", () => {
  const bs = String.fromCharCode(92);
  const head = "Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,";
  const raw = join("[Script Info]", "[Events]", head + "{" + bs + "i1}Hello" + bs + "Nworld");
  const s = prepareSubtitle(raw);
  assert.equal(s.kind, "ass");
  assert.deepEqual(s.texts, ["Hello world"]);
  assert.equal(s.build(["Привет мир"]), join("[Script Info]", "[Events]", head + "Привет мир"));
});

ok("простой текст остаётся целиком", () => {
  const s = prepareSubtitle(join("Line one", "Line two"));
  assert.equal(s.kind, "text");
  assert.equal(s.texts.length, 1);
  assert.equal(s.build(["Строка"]), "Строка");
});

ok("пакеты не превышают лимиты и покрывают все реплики", () => {
  const texts = Array.from({ length: 200 }, (_, i) => "x".repeat(100) + i);
  const batches = makeBatches(texts, 1000, 60);
  assert.ok(batches.every(b => b.length <= 60 && b.reduce((a, i) => a + texts[i].length + 1, 0) <= 1000));
  assert.deepEqual(batches.flat(), texts.map((_, i) => i));
});

ok("ответ пакета: совпало / не совпало число строк", () => {
  assert.deepEqual(splitBatchResult(join("а", "б", ""), 2), ["а", "б"]);
  assert.equal(splitBatchResult(join("а"), 2), null);
});

console.log(`${NL}Все ${n} проверок прошли`);
