import assert from "node:assert/strict";
import { pickSameVoice, preloadFresh, shouldPreload, PRELOAD_TTL_MS } from "../src/app/preload-core.js";

const tr = [{ id: 1, kind: "sub", authors: "A" }, { id: 2, kind: "voice", authors: "Студия" }, { id: 3, kind: "voice", authors: "Другие" }];
assert.equal(pickSameVoice(tr, "Другие").id, 3);
assert.equal(pickSameVoice(tr, "нет такой").id, 2, "нет совпадения — первая озвучка");
assert.equal(pickSameVoice(tr, null).id, 2);
assert.equal(pickSameVoice([{ kind: "sub" }], "x"), null);
assert.equal(pickSameVoice(null, "x"), null);

const pre = { episodeId: 7, at: 1000, sources: [{ height: 1080 }] };
assert.ok(preloadFresh(pre, 7, 1000 + PRELOAD_TTL_MS - 1));
assert.ok(!preloadFresh(pre, 7, 1000 + PRELOAD_TTL_MS), "кеш протух");
assert.ok(!preloadFresh(pre, 8, 1001), "другая серия");
assert.ok(!preloadFresh(null, 7));
assert.ok(!preloadFresh({ episodeId: 7, at: 1000 }, 7, 1001), "без ссылок кеш бесполезен");

assert.ok(shouldPreload({ left: 100, duration: 1400, hasNext: true, alreadyFor: null, nextId: 8 }));
assert.ok(!shouldPreload({ left: 500, duration: 1400, hasNext: true, alreadyFor: null, nextId: 8 }), "ещё рано");
assert.ok(!shouldPreload({ left: 100, duration: 1400, hasNext: false, alreadyFor: null, nextId: 8 }), "последняя серия");
assert.ok(!shouldPreload({ left: 100, duration: 1400, hasNext: true, alreadyFor: 8, nextId: 8 }), "уже грузили");
assert.ok(!shouldPreload({ left: 100, duration: 30, hasNext: true, alreadyFor: null, nextId: 8 }), "короткий ролик");
console.log("preload-test: ok");
