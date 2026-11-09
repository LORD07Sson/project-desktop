import assert from "node:assert/strict";
import { parseVtt, parseAss, parseSubsFile, decodeSubs } from "../src/app/subs-core.js";

const cues = parseVtt("﻿WEBVTT\n\n00:26.390 --> 00:28.760\nНи у кого <i>даже</i> нет?\n\n7\r\n01:00:01,500 --> 01:00:03.000 line:90%\r\nПервая &amp; вторая\r\n<b>строка</b>\r\n\r\nNOTE комментарий\n\n00:10.000 --> 00:09.000\nкривое время\n\n00:12.000 --> 00:13.000\n\n");
assert.equal(cues.length, 2, "кривые и пустые реплики пропущены");
assert.deepEqual(cues[0], { start: 26.39, end: 28.76, text: "Ни у кого даже нет?" });
assert.equal(cues[1].start, 3601.5);
assert.equal(cues[1].end, 3603);
assert.equal(cues[1].text, "Первая & вторая\nстрока");
assert.deepEqual(parseVtt(""), []);
assert.deepEqual(parseVtt(null), []);

const srt = parseSubsFile("a.srt", "1\r\n00:00:01,000 --> 00:00:02,500\r\nПривет\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nПока\r\n");
assert.deepEqual(srt.map(c => [c.start, c.end, c.text]), [[1, 2.5, "Привет"], [3, 4, "Пока"]]);

const ass = "[Script Info]\nTitle: x\n\n[V4+ Styles]\nFormat: Name, Fontname, Text\nStyle: D,Arial,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
  + "Dialogue: 0,0:00:02.00,0:00:03.50,D,,0,0,0,,{\\an8}Раз, два\\Nтри\n"
  + "Dialogue: 1,0:00:02.00,0:00:03.50,D,,0,0,0,,Раз, два\\Nтри\n"
  + "Dialogue: 0,0:00:01.00,0:00:05.00,D,,0,0,0,,{\\p1}m 0 0 l 1 1{\\p0}\n"
  + "Dialogue: 0,1:00:00.00,1:00:01.00,D,,0,0,0,,Конец\n";
assert.deepEqual(parseAss(ass), [{ start: 2, end: 3.5, text: "Раз, два\nтри" }, { start: 3600, end: 3601, text: "Конец" }]);
assert.equal(parseSubsFile("B.ASS", ass).length, 2);
assert.equal(decodeSubs(new Uint8Array([0xd0, 0x9f])), "П", "UTF-8");
assert.equal(decodeSubs(new Uint8Array([0xcf])), "П", "Windows-1251");

console.log("subs-test: ok");
