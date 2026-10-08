import assert from "node:assert/strict";
import { parseLrc, activeLrcIndex, parseFeed, isFeedUrl, parseCbr, parseRelease, matchesWatch, freshItems } from "../src/app/web-tools-core.js";

const lrc = parseLrc("[00:05.50] вторая\n[00:01.00] первая\n[00:09.00][00:20.00] повтор\nбез времени");
assert.equal(lrc.length, 5);
assert.equal(lrc[0].text, "первая");
assert.equal(lrc[1].at, 5.5);
assert.equal(lrc.filter(l => l.text === "повтор").length, 2);
assert.equal(lrc[lrc.length - 1].at, null, "строки без времени — в конце");
assert.equal(activeLrcIndex(lrc, 0.5), -1);
assert.equal(activeLrcIndex(lrc, 6), 1);
assert.equal(activeLrcIndex(lrc, 99), 3);

const rss = `<rss><channel><item><title><![CDATA[[Группа] Ночной дозор &amp; 09]]></title>
<link>https://nyaa.si/view/1</link><pubDate>Tue, 08 Oct 2026 10:00:00 -0000</pubDate>
<nyaa:size>1.4 GiB</nyaa:size><nyaa:seeders>42</nyaa:seeders></item>
<item><title>Второй</title><link>https://nyaa.si/view/2</link></item></channel></rss>`;
const items = parseFeed(rss);
assert.equal(items.length, 2);
assert.equal(items[0].title, "[Группа] Ночной дозор & 09");
assert.equal(items[0].extra.size, "1.4 GiB");
assert.equal(items[0].extra.seeders, "42");
assert.equal(items[1].link, "https://nyaa.si/view/2");

const atom = `<feed><entry><title>Запись</title><link href="https://x.example/a"/><updated>2026-10-08</updated></entry></feed>`;
const a = parseFeed(atom);
assert.equal(a[0].link, "https://x.example/a");
assert.equal(a[0].date, "2026-10-08");

assert.ok(isFeedUrl("https://nyaa.si/?page=rss"));
assert.ok(!isFeedUrl("http://nyaa.si/"));
assert.ok(!isFeedUrl("javascript:alert(1)"));
assert.ok(!isFeedUrl("https://localhost/"));

const cb = parseCbr({ Valute: { USD: { Name: "Доллар", Value: 96.4, Previous: 95.9, Nominal: 1 }, JPY: { Name: "Иена", Value: 63, Previous: 62, Nominal: 100 } } }, ["USD", "JPY", "EUR"]);
assert.equal(cb.length, 2);
assert.equal(cb[0].value, 96.4);
assert.ok(Math.abs(cb[1].value - 0.63) < 1e-9);

const r1 = parseRelease("[SubsPlease] Night Watch - 09 (1080p) [ABCD1234].mkv");
assert.equal(r1.group, "SubsPlease");
assert.equal(r1.episode, 9);
assert.equal(r1.resolution, "1080p");
const r2 = parseRelease("[Group] Название S2 - 12v2 [WEB-DL][720p][x265]");
assert.equal(r2.episode, 12);
assert.equal(r2.codec, "HEVC");
assert.equal(r2.source, "WEB-DL");
assert.equal(parseRelease("[G] Фильм 2024 [1080p]").episode, null, "год — не номер серии");
assert.equal(parseRelease("без разметки").group, "");
assert.ok(matchesWatch("[G] Night Watch - 09", "night 09"));
assert.ok(!matchesWatch("[G] Night Watch - 09", "night 10"));
assert.ok(matchesWatch("что угодно", ""));
const seen = new Set(["https://x/1"]);
const fr = freshItems([{ title: "A night", link: "https://x/1" }, { title: "B night", link: "https://x/2" }, { title: "C day", link: "https://x/3" }], seen, "night");
assert.deepEqual(fr.map(i => i.link), ["https://x/2"]);

console.log("web-tools-test: ok");
