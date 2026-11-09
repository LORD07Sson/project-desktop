import assert from "node:assert/strict";
import { parseVtt } from "../src/app/subs-core.js";

const cues = parseVtt("﻿WEBVTT\n\n00:26.390 --> 00:28.760\nНи у кого <i>даже</i> нет?\n\n7\r\n01:00:01,500 --> 01:00:03.000 line:90%\r\nПервая &amp; вторая\r\n<b>строка</b>\r\n\r\nNOTE комментарий\n\n00:10.000 --> 00:09.000\nкривое время\n\n00:12.000 --> 00:13.000\n\n");
assert.equal(cues.length, 2, "кривые и пустые реплики пропущены");
assert.deepEqual(cues[0], { start: 26.39, end: 28.76, text: "Ни у кого даже нет?" });
assert.equal(cues[1].start, 3601.5);
assert.equal(cues[1].end, 3603);
assert.equal(cues[1].text, "Первая & вторая\nстрока");
assert.deepEqual(parseVtt(""), []);
assert.deepEqual(parseVtt(null), []);

console.log("subs-test: ok");
