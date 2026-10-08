import assert from "node:assert/strict";
import { buildRpp, reaperMarkers } from "../src/app/reaper-core.js";

const bs = String.fromCharCode(92);
const rpp = buildRpp({
  name: "Серия 8",
  tracks: [
    { name: 'Ден "дубль"', path: `C:${bs}audio${bs}den.wav`, length: 12.5 },
    { name: "Фон", path: `C:${bs}audio${bs}bg.wav`, length: 0 },
  ],
  markers: [{ at: 5, name: "вдох" }, { at: 1.25, name: "шум" }, { at: -1, name: "мимо" }],
});

assert.ok(rpp.startsWith("<REAPER_PROJECT"));
assert.equal((rpp.match(/<TRACK/g) || []).length, 2);
assert.equal((rpp.match(/<ITEM/g) || []).length, 2);
assert.ok(rpp.includes('NAME "Ден \'дубль\'"'), "кавычки в имени заменены");
assert.ok(rpp.includes(`FILE "C:${bs}audio${bs}den.wav"`));
assert.ok(rpp.includes("LENGTH 12.5"));
assert.ok(rpp.includes("LENGTH 1\r\n"), "нулевая длина заменяется на 1 с");
const lines = reaperMarkers([{ at: 5, name: "a" }, { at: 1.25, name: "b" }, { at: -1 }]);
assert.equal(lines.length, 2);
assert.ok(lines[0].includes("1 1.25 \"b\""), "метки по возрастанию времени");
assert.throws(() => buildRpp({ tracks: [] }));
assert.ok(rpp.trimEnd().endsWith(">"));
console.log("reaper-test: ok");
