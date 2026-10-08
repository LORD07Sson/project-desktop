import assert from "node:assert/strict";
import { parseNyaaRss, magnetLink, sizeToBytes, sortItems, fmtDate, torrentFileName, relTime, splitTitle, categoryKind, summarize, fmtBytes, parseView, buildServices, classifyCheck, normalizeMirror, hostOf, fastestMirror, applyFilters, activeFilterCount, normalizeFilters, DEFAULT_FILTERS, splitWords, mergePages, rangeIds, makeMonitor, monitorTitle, diffMonitor, CLIENT_PORTS, NYAA_MIRRORS, isHash40, sourceUrls, parseSeadex, parseAnimetosho, parseNekoSearch, parseNekoTorrent, parseTsukihime, cleanTitleForSearch, parseSimilar, SIMILAR_QUERY } from "../src/app/nyaa-core.js";

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
const NOW2 = Date.parse("2026-10-08T12:00:00Z");
const mk = (id, title, seeders, mib, downloads, hoursAgo) => ({ id, title, seeders, sizeBytes: mib * 1048576, downloads, date: NOW2 - hoursAgo * 3600e3 });
const L = [mk(1, "[A] Night Watch FLAC", 0, 50, 10, 2), mk(2, "[B] Night Watch 1080p", 40, 1500, 900, 30), mk(3, "[C] Other Show MP3", 5, 20, 3, 24 * 40), mk(4, "[D] night watch remaster", 12, 300, 100, 5)];
const ids = (list) => list.map(i => i.id);
assert.deepEqual(ids(applyFilters(L, {}, { now: NOW2 })), [1, 2, 3, 4], "пустой фильтр ничего не прячет");
assert.deepEqual(ids(applyFilters(L, { hideDead: true }, { now: NOW2 })), [2, 3, 4]);
assert.deepEqual(ids(applyFilters(L, { minSeeders: 10 }, { now: NOW2 })), [2, 4]);
assert.deepEqual(ids(applyFilters(L, { block: ["remaster", "mp3"] }, { now: NOW2 })), [1, 2]);
assert.deepEqual(ids(applyFilters(L, { require: ["1080p", "flac"] }, { now: NOW2 })), [1, 2]);
assert.deepEqual(ids(applyFilters(L, { sizeMinMiB: 100, sizeMaxMiB: 1000 }, { now: NOW2 })), [4]);
assert.deepEqual(ids(applyFilters(L, { completedOp: "gt", completedVal: 50 }, { now: NOW2 })), [2, 4]);
assert.deepEqual(ids(applyFilters(L, { completedOp: "lt", completedVal: 10 }, { now: NOW2 })), [3]);
assert.deepEqual(ids(applyFilters(L, { completedOp: "eq", completedVal: 10 }, { now: NOW2 })), [1]);
assert.deepEqual(ids(applyFilters(L, { age: "7d" }, { now: NOW2 })), [1, 2, 4]);
assert.deepEqual(ids(applyFilters(L, { hideSeen: true }, { now: NOW2, seen: new Set([2, 4]) })), [1, 3]);
assert.equal(activeFilterCount({}), 0);
assert.equal(activeFilterCount({ hideDead: true, block: ["x"], age: "7d" }), 3);
assert.deepEqual(normalizeFilters({ minSeeders: "abc", age: "bogus", completedOp: "zzz" }), { ...DEFAULT_FILTERS });
assert.deepEqual(splitWords(" Raw, DUAL audio ;\n  mp3 ,"), ["raw", "dual audio", "mp3"]);
assert.deepEqual(ids(mergePages([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }])), [1, 2, 3]);
assert.deepEqual(rangeIds([5, 6, 7, 8, 9], 6, 8), [6, 7, 8]);
assert.deepEqual(rangeIds([5, 6, 7, 8, 9], 8, 6), [6, 7, 8], "в обе стороны");
assert.deepEqual(rangeIds([5, 6], 99, 6), [6], "нет якоря — только цель");

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
assert.deepEqual(svc.find(s => s.id === "nyaa").mirrors, [...NYAA_MIRRORS, "https://my.mirror"]);
assert.ok(NYAA_MIRRORS.includes("https://nyaa.si") && NYAA_MIRRORS.includes("https://nyaa.land"));
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
assert.equal(classifyCheck({ url: "https://graphql.anilist.co", ok: true, status: 404, ms: 500, error: "" }).level, "ok", "404 у API без пути — норма");
assert.equal(classifyCheck({ url: "https://nyaa.si", ok: true, status: 404, ms: 500, error: "" }).level, "warn", "а у обычного сайта 404 — подозрительно");
const ck = { "https://a": { ok: true, status: 200, ms: 600 }, "https://b": { ok: true, status: 200, ms: 200 }, "https://c": { ok: false, status: 0, ms: 50, error: "x" }, "https://d": { ok: true, status: 403, ms: 10 } };
assert.equal(fastestMirror(["https://a", "https://b", "https://c", "https://d", "https://e"], ck), "https://b");
assert.equal(fastestMirror(["https://c"], ck), null);
assert.equal(normalizeMirror("nyaa.example/path?q=1"), "https://nyaa.example");
assert.equal(normalizeMirror("http://x.example"), null);
assert.equal(normalizeMirror("localhost"), null);
assert.equal(normalizeMirror(""), null);
assert.equal(hostOf("https://nyaa.si:8443/x"), "nyaa.si:8443");
const m1 = makeMonitor({ type: "query", q: "  night watch ", cat: "1_2" }, 1);
assert.equal(m1.q, "night watch");
assert.equal(m1.cat, "1_2");
assert.equal(m1.new, 0);
assert.equal(makeMonitor({ type: "query", q: "   " }), null);
assert.equal(makeMonitor({ type: "user", q: "JMAX" }).cat, "0_0");
assert.equal(makeMonitor({ type: "user", q: "bad name&" }), null, "имя загрузчика проверяется");
assert.equal(monitorTitle({ type: "user", q: "JMAX" }), "Загрузчик JMAX");
const first = diffMonitor([{ id: 3 }, { id: 2 }, { id: 1 }], { type: "query" });
assert.deepEqual(first.fresh, [], "первая проверка ничего не объявляет");
assert.deepEqual(first.seen, [3, 2, 1]);
const second = diffMonitor([{ id: 5 }, { id: 4 }, { id: 3 }], { seen: [3, 2, 1] });
assert.deepEqual(second.fresh.map(i => i.id), [5, 4]);
assert.deepEqual(second.seen, [5, 4, 3, 2, 1]);
assert.equal(diffMonitor(Array.from({ length: 500 }, (_, i) => ({ id: i })), { seen: [] }).seen.length, 400);
assert.equal(CLIENT_PORTS.deluge, 8112);

// ---- внешние источники ----
const H = "28881b6c87fc9e2801c634d4a35d91afc7f25e2e";
assert.ok(isHash40(H));
assert.ok(!isHash40("abc") && !isHash40(H + "0") && !isHash40("z".repeat(40)));
const su = sourceUrls(H.toUpperCase());
assert.ok(su.seadexTorrent.includes(encodeURIComponent(`infoHash="${H}"`)), "хэш в нижнем регистре, фильтр закодирован");
assert.ok(su.animetosho.endsWith(`btih=${H}`));
assert.ok(su.nekobtSearch.endsWith(`query=${H}`));
assert.ok(su.tsukihime.endsWith(`/btih/${H}`));

assert.deepEqual(parseSeadex(JSON.stringify({ items: [{ isBest: true }] }), JSON.stringify({ items: [{ alID: 12345 }] })), { found: true, best: true, link: "https://releases.moe/12345" });
assert.equal(parseSeadex(JSON.stringify({ items: [{ isBest: false }] }), "").best, false);
assert.equal(parseSeadex(JSON.stringify({ items: [] }), JSON.stringify({ items: [] })).found, false);
assert.equal(parseSeadex("не json", "{").found, false);
assert.equal(parseSeadex("", JSON.stringify({ items: [{ alID: 7, expand: { trs: [{ isBest: true }] } }] })).best, true);

assert.deepEqual(parseAnimetosho(JSON.stringify({ nyaa_id: 2171202, title: "T", files: [{}, {}] })), { found: true, link: "https://animetosho.org/view/n2171202", title: "T", files: 2 });
assert.equal(parseAnimetosho(JSON.stringify({ error: "nf" })).found, false);
assert.equal(parseAnimetosho(JSON.stringify({})).found, false);

assert.equal(parseNekoSearch(JSON.stringify({ error: false, data: { infohash_match: 4521 } })), "4521");
assert.equal(parseNekoSearch(JSON.stringify({ error: false, data: { infohash_match: null } })), null);
assert.equal(parseNekoSearch(JSON.stringify({ error: false, data: { infohash_match: "../x" } })), null, "странный id отбрасывается");
const nk = parseNekoTorrent(JSON.stringify({ error: false, data: { id: 9, title: "Show", uploader: { display_name: "U" }, groups: [{ name: "G" }], seeders: 5, leechers: 1, completed: 40, filesize: 1048576 * 300, audio_lang: ["ja"], sub_lang: ["en", "ru"], batch: true } }));
assert.equal(nk.found, true);
assert.equal(nk.link, "https://nekobt.to/torrents/9");
assert.equal(nk.group, "G");
assert.equal(nk.size, "300 МиБ");
assert.equal(nk.subs, "en, ru");
assert.deepEqual(nk.flags, ["batch"]);
assert.equal(parseNekoTorrent("{}").found, false);

const ts = parseTsukihime(JSON.stringify({ id: 77, name: "N", anime: { title: "Yoru", english_title: "Night" }, group: { name: "G" }, episode_no: 9, totalsize: 5368709120, filecount: 12, audiolangs: ["ja"], sublangs: "en,ru" }));
assert.equal(ts.link, "https://tsukihime.org/view/77");
assert.equal(ts.anime, "Yoru (Night)");
assert.equal(ts.size, "5.0 ГиБ");
assert.equal(ts.subs, "en, ru");
assert.equal(parseTsukihime(JSON.stringify({ detail: "x" })).found, false);
const fresh = parseTsukihime(JSON.stringify({ id: 5, name: "N", totalsize: 0, filecount: 0 }));
assert.equal(fresh.size, "", "нулевой размер не показывается");
assert.equal(fresh.files, "");

assert.equal(cleanTitleForSearch("[SubsPlease] Night Watch - 09 (1080p) [ABCD1234].mkv"), "Night Watch");
assert.equal(cleanTitleForSearch("[Group] Show Name S02E05 [WEB-DL][HEVC]"), "Show Name");
assert.equal(cleanTitleForSearch("[JMAX] [2026.10.09] Fall in Dream [FLAC 48kHz]"), "Fall in Dream");
assert.equal(cleanTitleForSearch(""), "");

const sim = parseSimilar(JSON.stringify({ data: { Media: { id: 1, siteUrl: "https://anilist.co/anime/1", title: { romaji: "Yoru", english: "Night" }, seasonYear: 2023, genres: ["Action"], coverImage: { medium: "https://s4.anilist.co/a.jpg" },
  relations: { edges: [{ relationType: "SEQUEL", node: { id: 2, title: { romaji: "Yoru 2" }, coverImage: { medium: "http://insecure/x.jpg" } } }, { relationType: "CHARACTER", node: { id: 3, title: { romaji: "X" } } }] },
  recommendations: { nodes: [{ mediaRecommendation: { id: 4, title: { english: "Rec" }, averageScore: 80 } }, { mediaRecommendation: null }] } } } }));
assert.equal(sim.found, true);
assert.equal(sim.self.title, "Night");
assert.equal(sim.related.length, 1, "лишние типы связей отбрасываются");
assert.equal(sim.related[0].relation, "Продолжение");
assert.equal(sim.related[0].cover, "", "картинка не по https не берётся");
assert.equal(sim.recs.length, 1);
assert.equal(parseSimilar(JSON.stringify({ data: { Media: null } })).found, false);
assert.equal(parseSimilar("oops").found, false);
assert.ok(SIMILAR_QUERY.includes("recommendations"));

console.log("nyaa-test: ok");

// ---------- Релизы 2.0 ----------
{
  const core = await import("../src/app/nyaa-core.js");
  const { parseRelease, groupReleases, bestPerEpisode, makeRule, freshForRule, makeMonitor: mk, episodeKey } = core;
  const a = parseRelease("[Erai-raws] Seihantai na Kimi to Boku 2nd Season - 13 [1080p CR WEBRip HEVC AAC][MultiSub]");
  assert.equal(a.episode, 13); assert.equal(a.season, 2); assert.equal(a.group, "Erai-raws"); assert.equal(a.res, "1080p"); assert.equal(a.codec, "hevc");
  const b = parseRelease("You and I Are Polar Opposites S02E13 1080p CR WEB-DL AAC2.0 H.264 | Seihantai na Kimi to Boku 2nd Season");
  assert.equal(b.episode, 13); assert.equal(b.season, 2); assert.equal(b.codec, "avc");
  assert.equal(parseRelease("[JMAX] Night Watch OST [FLAC]").episode, null);
  assert.equal(parseRelease("[Group] Show Name (Batch) 01-12 [1080p]").episode, null);
  assert.equal(parseRelease("[SubsPlease] Night Watch - 09 (1080p) [HEVC]").episode, 9);
  const mkItem = (id, title, seeders = 10) => ({ id, title, seeders });
  const list = [
    mkItem("1", "[A] Show X - 03 [1080p HEVC]", 50), mkItem("2", "[B] Show X - 03 [1080p AVC]", 20),
    mkItem("3", "[A] Show X - 02 [720p]", 5), mkItem("4", "[A] Other OST [FLAC]", 5),
  ];
  const g = groupReleases(list);
  assert.equal(g.length, 2); assert.equal(g[0].kind, "group"); assert.equal(g[0].episodes.length, 2); assert.equal(g[1].kind, "item");
  assert.equal(bestPerEpisode(list, { groups: ["B", "A"] })[0].item.id, "2", "по правилу приоритет у группы B");
  assert.equal(bestPerEpisode(list, { noHevc: true })[0].item.id, "2", "без HEVC выбирается AVC");
  assert.equal(bestPerEpisode(list, { res: "720p" }).length, 1);
  assert.equal(makeRule({}), null);
  assert.deepEqual(makeRule({ groups: "A, B, A", res: "1080p", auto: true }), { groups: ["A", "B"], res: "1080p", noHevc: false, auto: true });
  const m = mk({ type: "query", q: "show x", rule: makeRule({ groups: "A" }) });
  assert.deepEqual(m.got, []);
  const fr = freshForRule(list, { ...m, got: [episodeKey(list[0])] });
  assert.ok(!fr.some(i => i.id === "1" || i.id === "2"), "серия 3 уже получена");
  assert.equal(mk({ type: "query", q: "x" }).rule, undefined);
}

{
  const { parseCover, coverKey } = await import("../src/app/nyaa-core.js");
  assert.equal(parseCover('{"data":{"Media":{"id":1,"coverImage":{"medium":"https://s4.anilist.co/a.jpg"}}}}'), "https://s4.anilist.co/a.jpg");
  assert.equal(parseCover('{"data":{"Media":null}}'), "");
  assert.equal(parseCover("не json"), "");
  assert.equal(coverKey("[Sokudo] Re ZERO - S04E19 [1080p AV1]"), coverKey("[Breeze] Re ZERO - S04E19 [1080p AV1]"));
  assert.ok(coverKey("[A] Show X - 03 [1080p]").startsWith("show x"));
}

{
  const html = '<html><body><div class="panel-heading"><h3 class="panel-title">T</h3></div><div id="torrent-description">![alt text](https://i.ibb.co/KpVhrcHV/Cover.jpg)\n\nТрек-лист: [сайт](https://example.com/a)</div></body></html>';
  const v = parseView(html, win.DOMParser);
  assert.deepEqual(v.images, ["https://i.ibb.co/KpVhrcHV/Cover.jpg"]);
  assert.ok(!v.description.includes("!["), "markdown-картинка убрана из текста");
  assert.ok(v.description.includes("сайт (https://example.com/a)"));
}

// ---------- SeaDex по списку, AnimeTosho, вкладки ----------
{
  const { seadexListUrl, parseSeadexList, parseToshoTorrent, parseSubtitle, titleLinks, normalizeTabs, bestPerEpisode } = await import("../src/app/nyaa-core.js");
  const h1 = "a".repeat(40), h2 = "b".repeat(40);
  const u = seadexListUrl([h1, h2, "bad", h1]);
  assert.ok(u.includes("releases.moe") && decodeURIComponent(u).includes(`infoHash="${h1}"||infoHash="${h2}"`));
  assert.equal(seadexListUrl(["x"]), "");
  const m = parseSeadexList(JSON.stringify({ items: [{ infoHash: h1, isBest: true }, { infoHash: h2, isBest: false }] }));
  assert.equal(m.get(h1), "best"); assert.equal(m.get(h2), "alt"); assert.equal(parseSeadexList("не json").size, 0);
  const t = parseToshoTorrent(JSON.stringify({ anidb_aid: 5, files: [{ id: 7, filename: "a.mkv", size: 100, vidframe_timestamps: [10, 20],
    attachments: [{ id: 3, type: "subtitle", info: { codec: "ASS", lang: "eng", default: 1 }, size: 9 }, { id: 4, type: "other", info: { mime: "font/ttf" } }] }] }));
  assert.equal(t.found, true); assert.equal(t.files[0].subs[0].lang, "eng"); assert.equal(t.files[0].fonts, 1); assert.deepEqual(t.files[0].shots, [10, 20]);
  assert.equal(parseToshoTorrent("{}").found, false);
  const BS = String.fromCharCode(92), NL = String.fromCharCode(10);
  const ass = ["[Script Info]", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", "Dialogue: 0,0:00:05.50,0:00:07.00,Default,,0,0,0,,{" + BS + "i1}Привет{" + BS + "i0}" + BS + "Nмир, как дела"].join(NL);
  const a = parseSubtitle(ass, "ASS");
  assert.equal(a.length, 1); assert.equal(a[0].at, 5500); assert.equal(a[0].text, "Привет / мир, как дела");
  const srt = "1\n00:00:01,000 --> 00:00:02,000\n<i>Hello</i>\nthere\n\n2\n00:00:03,500 --> 00:00:04,000\nBye";
  const s2 = parseSubtitle(srt, "SRT");
  assert.equal(s2.length, 2); assert.equal(s2[0].text, "Hello / there"); assert.equal(s2[1].at, 3500);
  assert.equal(titleLinks("[Erai-raws] Show X - 03 [1080p]").length, 4);
  assert.deepEqual(normalizeTabs({ order: ["sim", "desc"], hidden: ["desc", "files", "zzz"] }), { order: ["sim", "desc", "files", "src", "tosho"], hidden: ["files"] });
  const best = bestPerEpisode([{ id: "1", title: "[A] X - 01 [1080p]", seeders: 90, _sd: "" }, { id: "2", title: "[B] X - 01 [1080p]", seeders: 1, _sd: "best" }], {});
  assert.equal(best[0].item.id, "2", "SeaDex-релиз выигрывает у более раздаваемого");
}

{
  const { parseTsukiFull, exactLinks, parseMediainfo, highlightSubtitle, defaultShotTrack, parseToshoTorrent } = await import("../src/app/nyaa-core.js");
  const t = parseTsukiFull(JSON.stringify({ id: 5, anime: { anilist: 11, mal: 22, anidb: 33 }, files: [{ id: 9, filename: "a.mkv" }] }));
  assert.equal(t.tid, 5); assert.equal(t.files[0].id, 9); assert.equal(exactLinks(t.ids).length, 3);
  assert.equal(exactLinks({ anilist: 0 }).length, 0); assert.equal(parseTsukiFull("{}").found, false);
  assert.equal(parseMediainfo(JSON.stringify({ mediainfo: "General\nFormat : Matroska" })), "General\nFormat : Matroska");
  assert.equal(parseMediainfo("не json"), "");
  const h = highlightSubtitle("[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,x,,0,0,0,,{\i1}<b>Hi</b>");
  assert.ok(h.includes('class="hl-sec"') && h.includes('class="hl-tag"') && !h.includes("<b>Hi"), "теги экранированы и подсвечены");
  const f = parseToshoTorrent(JSON.stringify({ files: [{ id: 1, filename: "a", attachments: [
    { id: 1, type: "subtitle", info: { codec: "SRT", lang: "eng", tracknum: 2 } }, { id: 2, type: "subtitle", info: { codec: "ASS", lang: "eng", tracknum: 3, forced: 1 } },
    { id: 3, type: "subtitle", info: { codec: "ASS", lang: "eng", tracknum: 4 } }] }] }));
  assert.equal(defaultShotTrack(f.files[0].subs), 4, "первая не форсированная ASS-дорожка");
  assert.equal(defaultShotTrack([]), 0);
}
