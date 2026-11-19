import assert from "node:assert/strict";
import { productionNow } from "../src/app/report-now-core.js";

let n = productionNow({ hasVideo: false, hasFinal: false, pipeLeft: "сдали 1 из 6", canAssemble: true });
assert.equal(n.tone, "wait"); assert.match(n.title, /нет видео/); assert.deepEqual(n.act, { jump: ".rd-files" });

n = productionNow({ hasVideo: true, hasFinal: false, pipeLeft: "сдали 3 из 6", canAssemble: true });
assert.equal(n.tone, "wait"); assert.match(n.title, /сдали 3 из 6/); assert.deepEqual(n.act, { jump: ".rd-pipe" });

n = productionNow({ hasVideo: true, hasFinal: false, canAssemble: true });
assert.equal(n.tone, "go"); assert.deepEqual(n.act, { click: "#report-assemble" });
assert.equal(productionNow({ hasVideo: true, hasFinal: false, canAssemble: false }), null);

n = productionNow({ hasVideo: true, hasFinal: true, canPost: true });
assert.equal(n.tone, "go"); assert.deepEqual(n.act, { click: "#report-post" }); assert.equal(n.sub, "");
assert.equal(productionNow({ hasVideo: true, hasFinal: true, canPost: false }), null);

n = productionNow({ hasVideo: true, hasFinal: true, pipeLeft: "сдали 5 из 6", canPost: true });
assert.equal(n.tone, "wait");
console.log("now-test: ok");
