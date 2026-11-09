import assert from "node:assert/strict";
import { pickSameVoice, preloadFresh, shouldPreload, PRELOAD_TTL_MS, bufferedAhead, startBufferReady, START_BUFFER_MAX_WAIT_MS } from "../src/app/preload-core.js";

const tr = [{ id: 1, kind: "sub", authors: "A" }, { id: 2, kind: "voice", authors: "Студия" }, { id: 3, kind: "voice", authors: "Другие" }];
assert.equal(pickSameVoice(tr, "Другие").id, 3);
assert.equal(pickSameVoice(tr, "нет такой").id, 2, "нет совпадения — первая озвучка");
assert.equal(pickSameVoice(tr, null).id, 2);
assert.equal(pickSameVoice([{ kind: "sub" }], "x"), null);
assert.equal(pickSameVoice(null, "x"), null);
assert.equal(pickSameVoice(tr, "A", "sub").id, 1, "смотрел с субтитрами — те же субтитры");
assert.equal(pickSameVoice(tr, "нет такой", "sub").id, 1, "нет той команды — первые субтитры");
assert.equal(pickSameVoice(tr.slice(1), "Другие", "sub").id, 3, "субтитров нет — озвучка");

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
const ranges = list => ({ length: list.length, start: i => list[i][0], end: i => list[i][1] });
assert.equal(bufferedAhead(ranges([[0, 10], [100, 140]]), 110), 30);
assert.equal(bufferedAhead(ranges([[100, 140]]), 50), 0, "позиция вне загруженного");
assert.equal(bufferedAhead(null, 0), 0);
const base = { ahead: 5, left: 1000, suspended: false, waitedMs: 0 };
assert.ok(!startBufferReady(base));
assert.ok(startBufferReady({ ...base, ahead: 30 }));
assert.ok(startBufferReady({ ...base, ahead: 5, left: 5 }), "до конца меньше 30 с");
assert.ok(startBufferReady({ ...base, suspended: true }));
assert.ok(startBufferReady({ ...base, waitedMs: START_BUFFER_MAX_WAIT_MS }), "не ждём вечно");
console.log("preload-test: ok");
