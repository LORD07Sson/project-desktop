import assert from "node:assert/strict";
import {
  newHealth, record, statsOf, cooling, pathScore, bestPath, pickMirror, shouldSwitch, sparkPoints, levelOf, serialize, deserialize, cooldownMs, HIST_MAX,
} from "../src/app/mirror-health.js";

const A = "https://a.example", B = "https://b.example", C = "https://c.example";
const T = 1_000_000;

// замеры и статистика
let h = newHealth();
[100, 300, 200].forEach((ms, i) => record(h, A, "pc", ms, T + i));
record(h, A, "pc", null, T + 5);
let s = statsOf(h.m[A].pc);
assert.equal(s.n, 4); assert.equal(s.median, 200); assert.equal(s.loss, 0.25); assert.equal(s.last, null);
for (let i = 0; i < 30; i++) record(h, B, "pc", 50, T + i);
assert.equal(h.m[B].pc.length, HIST_MAX, "история обрезается");

// пауза после сбоев
h = newHealth();
record(h, A, "server", null, T); record(h, A, "server", null, T + 1);
assert.ok(!cooling(h, A, "server", T + 2), "после двух сбоев пауза не нужна");
record(h, A, "server", null, T + 2);
assert.ok(cooling(h, A, "server", T + 3), "после трёх — пауза");
assert.ok(!cooling(h, A, "server", T + 2 + 5 * 60_000 + 1), "пауза 5 минут кончается");
for (let i = 0; i < 3; i++) record(h, A, "server", null, T + 10 + i);
assert.equal(cooldownMs(6), 10 * 60_000);
record(h, A, "server", 120, T + 20);
assert.ok(!cooling(h, A, "server", T + 21), "успех снимает паузу");

// выбор пути
h = newHealth();
assert.equal(bestPath(h, A), null, "нет данных — по умолчанию");
record(h, A, "pc", 400, T); record(h, A, "server", 150, T);
assert.equal(bestPath(h, A, T + 1), "server", "сервер заметно быстрее");
record(h, B, "pc", 200, T); record(h, B, "server", 100, T);
assert.equal(bestPath(h, B, T + 1), "pc", "почти равны — прямой путь не нагружает сервер");
record(h, C, "pc", null, T); record(h, C, "pc", null, T); record(h, C, "pc", null, T); record(h, C, "server", 300, T);
assert.equal(bestPath(h, C, T + 1), "server", "прямой на паузе");

// выбор зеркала и переключение
h = newHealth();
record(h, A, "pc", 3000, T); record(h, A, "pc", 3200, T); // медленное текущее
record(h, B, "pc", 400, T);
record(h, C, "server", null, T);
assert.deepEqual(pickMirror(h, [A, B, C], T + 1).url, B);
assert.equal(shouldSwitch(h, A, [A, B, C], T + 1), B, "текущее медленное, другое вдвое быстрее");
assert.equal(shouldSwitch(h, B, [A, B, C], T + 1), null, "лучшее не трогаем");
const h2 = newHealth();
for (let i = 0; i < 3; i++) record(h2, A, "pc", null, T + i);
record(h2, B, "pc", 800, T);
assert.equal(shouldSwitch(h2, A, [A, B], T + 5), B, "текущее на паузе");
assert.equal(shouldSwitch(newHealth(), A, [A, B], T), null, "нет данных — не переключаем");
const h3 = newHealth(); record(h3, A, "pc", 900, T); record(h3, B, "pc", 500, T);
assert.equal(shouldSwitch(h3, A, [A, B], T + 1), null, "не медленное — не переключаем");

// уровень и график
assert.equal(levelOf([]), "idle");
assert.equal(levelOf([{ t: 1, ms: 100 }, { t: 2, ms: 120 }]), "ok");
assert.equal(levelOf([{ t: 1, ms: 2000 }, { t: 2, ms: 2100 }]), "slow");
assert.equal(levelOf([{ t: 1, ms: 100 }, { t: 2, ms: null }]), "bad");
const pts = sparkPoints([{ t: 1, ms: 100 }, { t: 2, ms: null }, { t: 3, ms: 400 }], 70, 22).split(" ");
assert.equal(pts.length, 3); assert.equal(pts[0].split(",")[0], "0.0"); assert.equal(sparkPoints([]), "");

// сохранение
const raw = JSON.parse(JSON.stringify(serialize(h, T + 1)));
const back = deserialize(raw);
assert.equal(back.m[A].pc.length, 2);
assert.equal(deserialize(null).m && Object.keys(deserialize(null).m).length, 0);
assert.equal(Object.keys(deserialize({ m: { "http://x": { pc: [] }, [A]: { pc: [{ t: 1, ms: 5 }, "мусор"] } } }).m).join(), A, "не-https и мусор отбрасываются");
assert.equal(Object.keys(serialize(h, T + 10 * 24 * 3600_000).m).length, 0, "старые замеры не хранятся");
console.log("mirror-health-test: ok");
