// productionNow: что показывать в плашке «Сейчас блокирует» над этапами производства.
import assert from "node:assert/strict";
import { productionNow } from "../src/app/report-now-core.js";

// нет видео — это главное, даже если пайплайн ещё не пройден
let n = productionNow({ hasVideo: false, hasFinal: false, pipeLeft: "сдали 1 из 6", canAssemble: true });
assert.equal(n.tone, "wait"); assert.match(n.title, /нет видео/); assert.deepEqual(n.act, { jump: ".rd-files" });

// видео есть, озвучка не сдана — ждём пайплайн, число берём из pipeLeft
n = productionNow({ hasVideo: true, hasFinal: false, pipeLeft: "сдали 3 из 6", canAssemble: true });
assert.equal(n.tone, "wait"); assert.match(n.title, /сдали 3 из 6/); assert.deepEqual(n.act, { jump: ".rd-pipe" });

// всё сдано, финала нет — можно собирать, но только с правом на сборку
n = productionNow({ hasVideo: true, hasFinal: false, canAssemble: true });
assert.equal(n.tone, "go"); assert.deepEqual(n.act, { click: "#report-assemble" });
assert.equal(productionNow({ hasVideo: true, hasFinal: false, canAssemble: false }), null);

// финал есть — предлагаем пост, если есть право; иначе молчим
n = productionNow({ hasVideo: true, hasFinal: true, canPost: true });
assert.equal(n.tone, "go"); assert.deepEqual(n.act, { click: "#report-post" }); assert.equal(n.sub, "");
assert.equal(productionNow({ hasVideo: true, hasFinal: true, canPost: false }), null);

// финал есть, а пайплайн ещё идёт — важнее дождаться озвучки
n = productionNow({ hasVideo: true, hasFinal: true, pipeLeft: "сдали 5 из 6", canPost: true });
assert.equal(n.tone, "wait");
console.log("now-test: ok");
