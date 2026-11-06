// Страница Anime 365: статус серии, сводка, разбор строк проверки, группы (a365-core.js).
import assert from "node:assert/strict";
import { kindOf, isOn365, summarize, checkFacts, sameTitle, groupItems } from "../src/app/a365-core.js";

// ---- статус
assert.equal(kindOf({ stage: "done" }), "done");
assert.equal(kindOf({ stage: "done", newer: { key: "x" } }), "newer");
assert.equal(kindOf({ stage: "uploading" }), "queue");
assert.equal(kindOf({ stage: "failed", check: { ok: false, error: "e" } }), "bad");
assert.equal(kindOf({ stage: "failed", check: { ok: false, dup: "u" } }), "elsewhere");
assert.equal(kindOf({}), "unchecked");
assert.equal(kindOf({ unbound: true }), "unbound");
assert.equal(kindOf({ check: { ok: true } }), "ready");
assert.equal(kindOf({ check: { ok: true }, twin: { url: "u" } }), "elsewhere");
assert.ok(isOn365({ stage: "done", newer: {} }));
assert.ok(!isOn365({ check: { ok: true } }));

// ---- сводка: на сайте считаются и серии с новой версией, пустых сегментов нет
const s = summarize([{ stage: "done" }, { stage: "done", newer: {} }, { check: { ok: true } }, { check: { ok: true } }, {}, { unbound: true }]);
assert.equal(s.total, 6);
assert.equal(s.onSite, 2);
assert.equal(s.ready, 2);
assert.deepEqual(s.segments.map(x => [x.key, x.count]), [["on", 1], ["newer", 1], ["ready", 2], ["unbound", 1], ["unchecked", 1]]);
assert.deepEqual(summarize([]).segments, []);

// ---- строки проверки
assert.deepEqual(checkFacts(["Сезон: 1-й, Осень 2026 — совпадает ✅", "Серия: 4 из 12", "Нашей озвучки этой серии на 365 нет ✅"]), [
  { text: "Сезон 1-й, Осень 2026", tone: "ok" }, { text: "Серия 4 из 12", tone: "ok" }, { text: "Дубля нет", tone: "ok" }]);
assert.deepEqual(checkFacts(["Перезаливка: прежний перевод https://x после заливки удалите на сайте 365 ⚠️"]), [
  { text: "Перезаливка: прежний перевод https://x после заливки удалите на сайте 365", tone: "warn" }]);
assert.deepEqual(checkFacts(["Перезаливка ✅"]), [{ text: "Перезаливка", tone: "ok" }]);
assert.deepEqual(checkFacts(undefined), []);

// ---- названия
assert.ok(sameTitle("Не слишком  ли", " не слишком ли "));
assert.ok(!sameTitle("А", "Б"));

// ---- группы: сначала то, что можно залить; пустых нет
const g = groupItems([{ stage: "done" }, {}, { check: { ok: true } }]);
assert.deepEqual(g.map(x => x.key), ["ready", "unchecked", "on"]);
assert.equal(g[0].title, "Можно заливать");

console.log("a365-test: ok");
