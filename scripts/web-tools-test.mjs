import assert from "node:assert/strict";
import { parseLrc, activeLrcIndex } from "../src/app/web-tools-core.js";

const lrc = parseLrc("[00:05.50] вторая\n[00:01.00] первая\n[00:09.00][00:20.00] повтор\nбез времени");
assert.equal(lrc.length, 5);
assert.equal(lrc[0].text, "первая");
assert.equal(lrc[1].at, 5.5);
assert.equal(lrc.filter(l => l.text === "повтор").length, 2);
assert.equal(lrc[lrc.length - 1].at, null, "строки без времени — в конце");
assert.equal(activeLrcIndex(lrc, 0.5), -1);
assert.equal(activeLrcIndex(lrc, 6), 1);
assert.equal(activeLrcIndex(lrc, 99), 3);

console.log("web-tools-test: ok");
