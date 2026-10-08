import assert from "node:assert/strict";
import { addEntry, cacheKey } from "../src/app/audio-cache-core.js";

const MB = 1024 * 1024;
let r = addEntry([], { key: "a", size: 10 * MB, at: 1 }, 3, 100 * MB);
assert.equal(r.index.length, 1);
r = addEntry(r.index, { key: "b", size: 10 * MB, at: 2 }, 3, 100 * MB);
r = addEntry(r.index, { key: "c", size: 10 * MB, at: 3 }, 3, 100 * MB);
r = addEntry(r.index, { key: "d", size: 10 * MB, at: 4 }, 3, 100 * MB);
assert.deepEqual(r.evict, ["a"], "по числу файлов уходит самый старый");
assert.deepEqual(r.index.map(e => e.key), ["b", "c", "d"]);

let s = addEntry([{ key: "x", size: 60 * MB, at: 1 }, { key: "y", size: 30 * MB, at: 2 }], { key: "z", size: 30 * MB, at: 3 }, 12, 100 * MB);
assert.deepEqual(s.evict, ["x"], "по объёму");

const same = addEntry([{ key: "p", size: 5 * MB, at: 1 }], { key: "p", size: 7 * MB, at: 9 }, 3, 100 * MB);
assert.equal(same.index.length, 1);
assert.equal(same.index[0].size, 7 * MB, "повторная запись обновляет, а не дублирует");

const big = addEntry([{ key: "k", size: 1, at: 1 }], { key: "huge", size: 500 * MB, at: 2 }, 12, 400 * MB);
assert.deepEqual(big.evict, []);
assert.ok(!big.index.some(e => e.key === "huge"), "файл больше всего кеша не хранится");
assert.equal(cacheKey("R-1", 5), "R-1/5");
console.log("audio-cache-test: ok");
