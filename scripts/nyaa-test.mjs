import assert from "node:assert/strict";
import { parseNyaaRss, magnetLink, sizeToBytes, sortItems, fmtDate, torrentFileName, relTime, splitTitle, categoryKind, summarize, fmtBytes, parseView, buildServices, classifyCheck, normalizeMirror, hostOf } from "../src/app/nyaa-core.js";

const xml = `<?xml version="1.0"?><rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>
<item><title>[JMAX] [2026.10.09] TVアニメ「Night」ED &amp; OP [FLAC]</title><link>https://nyaa.si/download/2090786.torrent</link><guid isPermaLink="true">https://nyaa.si/view/2090786</guid><pubDate>Thu, 08 Oct 2026 17:39:56 -0000</pubDate><nyaa:seeders>62</nyaa:seeders><nyaa:leechers>8</nyaa:leechers><nyaa:downloads>311</nyaa:downloads><nyaa:infoHash>ABCDEF0123456789ABCDEF0123456789ABCDEF01</nyaa:infoHash><nyaa:categoryId>2_1</nyaa:categoryId><nyaa:category>Audio - Lossless</nyaa:category><nyaa:size>73.6 MiB</nyaa:size><nyaa:comments>1</nyaa:comments><nyaa:trusted>Yes</nyaa:trusted><nyaa:remake>No</nyaa:remake></item>
<item><title>Второй</title><guid isPermaLink="true">https://nyaa.si/view/5</guid><pubDate>Wed, 07 Oct 2026 10:00:00 -0000</pubDate><nyaa:seeders>100</nyaa:seeders><nyaa:leechers>0</nyaa:leechers><nyaa:downloads>9</nyaa:downloads><nyaa:infoHash>0000000000000000000000000000000000000002</nyaa:infoHash><nyaa:size>1.1 GiB</nyaa:size><nyaa:trusted>No</nyaa:trusted><nyaa:remake>Yes</nyaa:remake></item>
<item><title>без guid</title></item>
</channel></rss>`;

const items = parseNyaaRss(xml);
assert.equal(items.length, 2, "запись без id отбрасывается");
assert.equal(items[0].id, 2090786);
assert.equal(items[0].title, "[JMAX] [2026.10.09] TVアニメ「Night」ED & OP [FLAC]");
assert.equal(items[0].seeders, 62);
assert.equal(items[0].category, "Audio - Lossless");
assert.equal(items[0].trusted, true);
assert.equal(items[0].remake, false);
assert.equal(items[1].remake, true);
assert.equal(items[0].hash, "abcdef0123456789abcdef0123456789abcdef01");

const mg = magnetLink(items[0]);
assert.ok(mg.startsWith("magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn="));
assert.ok(mg.includes("&tr="));
assert.ok(!mg.includes("&OP"), "название закодировано");
assert.equal(magnetLink({ title: "x", hash: "" }), "");

assert.equal(sizeToBytes("73.6 MiB"), Math.round(73.6 * 1048576));
assert.equal(sizeToBytes("1.1 GiB"), Math.round(1.1 * 1073741824));
assert.equal(sizeToBytes("512 Bytes"), 0, "незнакомая единица — 0");
assert.equal(sizeToBytes(""), 0);

assert.deepEqual(sortItems(items, "seeders", "desc").map(i => i.id), [5, 2090786]);
assert.deepEqual(sortItems(items, "size", "asc").map(i => i.id), [2090786, 5]);
assert.deepEqual(sortItems(items, "date").map(i => i.id), [2090786, 5]);
assert.match(fmtDate(items[0].date), /^2026-10-0[89] \d\d:\d\d$/);
assert.equal(fmtDate(0), "—");

assert.equal(torrentFileName({ id: 1, title: 'a/b:c*"d' }), "a_b_c__d.torrent");
assert.equal(torrentFileName({ id: 7, title: "" }), "nyaa-7.torrent");
const NOW = Date.parse("2026-10-08T18:00:00Z");
assert.equal(relTime(NOW - 20_000, NOW), "только что");
assert.equal(relTime(NOW - 5 * 60_000, NOW), "5 мин назад");
assert.equal(relTime(NOW - 3 * 3600_000, NOW), "3 ч назад");
assert.equal(relTime(NOW - 30 * 3600_000, NOW), "вчера");
assert.equal(relTime(NOW - 4 * 86400_000, NOW), "4 дн. назад");
assert.match(relTime(NOW - 40 * 86400_000, NOW), /^\d{4}-\d\d-\d\d$/);
assert.equal(relTime(0), "—");

const sp = splitTitle("[JMAX] [2026.10.09] TVアニメ「ホタルの嫁入り」OPテーマ「Period」/ iri [FLAC 48kHz/24bit]");
assert.equal(sp.group, "JMAX");
assert.ok(sp.tags.includes("FLAC"));
assert.ok(sp.tags.some(t => /48kHz/i.test(t)));
const sp2 = splitTitle("[SubsPlease] Night Watch - 09 (1080p) [HEVC]");
assert.deepEqual(sp2.tags, ["1080p", "HEVC"]);
assert.equal(splitTitle("Без разметки").group, "");
assert.deepEqual(splitTitle("[G] Фильм [2024]").tags, []);

assert.equal(categoryKind("2_1"), "audio");
assert.equal(categoryKind("1_2"), "anime");
assert.equal(categoryKind("4_1"), "video");
assert.equal(categoryKind(""), "other");

const sm = summarize([{ sizeBytes: 100, seeders: 5, trusted: true }, { sizeBytes: 50, seeders: 9, trusted: false }]);
assert.deepEqual(sm, { count: 2, bytes: 150, topSeeders: 9, trusted: 1 });
assert.equal(summarize([]).topSeeders, 0);
assert.equal(fmtBytes(0), "0 Б");
assert.equal(fmtBytes(1536), "1.5 КиБ");
assert.equal(fmtBytes(5 * 1073741824), "5.0 ГиБ");
assert.equal(fmtBytes(300 * 1048576), "300 МиБ");
const { JSDOM } = await import("jsdom");
const VIEW = `<html><body><div class="panel panel-success"><div class="panel-heading"><h3 class="panel-title">[261005]花たん - Insert Song[Amazon][FLAC]</h3></div>
<div class="panel-body"><div class="row"><div class="col-md-1">Category:</div><div class="col-md-5"><a>Audio</a> - <a>Lossless</a></div><div class="col-md-1">Date:</div><div class="col-md-5" data-timestamp="1759599600">2026-10-04 17:40 UTC</div></div>
<div class="row"><div class="col-md-1">Submitter:</div><div class="col-md-5">Anonymous</div><div class="col-md-1">Seeders:</div><div class="col-md-5"><span style="color: green;">4</span></div></div>
<div class="row"><div class="col-md-1">File size:</div><div class="col-md-5">314.0 MiB</div><div class="col-md-1">Info hash:</div><div class="col-md-5"><kbd>bef1699b656e684865c8acbbac50554fc6835171</kbd></div></div></div>
<div class="panel-footer"><a href="/download/2169558.torrent">Download Torrent</a> or <a href="magnet:?xt=urn:btih:bef1">Magnet</a></div></div>
<div id="torrent-description"><p>Первая строка<br>вторая</p><p><img src="https://i.example/cover.jpg"><img src="http://insecure.example/a.png"><img src="https://i.example/cover.jpg"><img src="data:image/png;base64,AAAA"></p><script>alert(1)</script><p>Третья</p></div>
<div class="torrent-file-list panel-body"><ul><li>Альбом<ul><li>01 track.flac (30 MiB)</li><li>02 track.flac (28 MiB)</li></ul></li></ul></div></body></html>`;
const win = new JSDOM("").window;
const v = parseView(VIEW, win.DOMParser);
assert.equal(v.title, "[261005]花たん - Insert Song[Amazon][FLAC]");
assert.equal(v.fields.category, "Audio - Lossless");
assert.equal(v.fields.submitter, "Anonymous");
assert.equal(v.fields.seeders, "4");
assert.equal(v.fields["file size"], "314.0 MiB");
assert.equal(v.fields["info hash"], "bef1699b656e684865c8acbbac50554fc6835171");
assert.equal(v.date, 1759599600000);
assert.equal(v.magnet, "magnet:?xt=urn:btih:bef1");
assert.deepEqual(v.images, ["https://i.example/cover.jpg"], "только https, без дублей, без data:");
assert.ok(v.description.includes("Первая строка\nвторая"));
assert.ok(v.description.includes("Третья"));
assert.ok(!v.description.includes("alert"), "скрипт не попадает в текст");
assert.deepEqual(v.files, ["01 track.flac (30 MiB)", "02 track.flac (28 MiB)"]);
assert.equal(parseView("", win.DOMParser).images.length, 0);

const svc = buildServices(["https://my.mirror"], "https://srv.example");
assert.deepEqual(svc.find(s => s.id === "nyaa").mirrors, ["https://nyaa.si", "https://nyaa.land", "https://my.mirror"]);
assert.ok(svc.find(s => s.id === "nyaa").apply);
assert.ok(!svc.find(s => s.id === "shikimori").apply);
assert.equal(svc.at(-1).id, "server");
assert.ok(!buildServices([], "").some(s => s.id === "server"));
assert.equal(classifyCheck(null).level, "idle");
assert.equal(classifyCheck({ ok: true, status: 200, ms: 120, error: "" }).level, "ok");
assert.equal(classifyCheck({ ok: true, status: 200, ms: 2000, error: "" }).level, "slow");
assert.equal(classifyCheck({ ok: true, status: 403, ms: 100, error: "" }).level, "warn");
assert.equal(classifyCheck({ ok: false, status: 502, ms: 100, error: "" }).level, "bad");
assert.equal(classifyCheck({ ok: false, status: 0, ms: 8000, error: "нет ответа за 8 секунд" }).text, "нет ответа за 8 секунд");
assert.equal(normalizeMirror("nyaa.example/path?q=1"), "https://nyaa.example");
assert.equal(normalizeMirror("http://x.example"), null);
assert.equal(normalizeMirror("localhost"), null);
assert.equal(normalizeMirror(""), null);
assert.equal(hostOf("https://nyaa.si:8443/x"), "nyaa.si:8443");
console.log("nyaa-test: ok");
