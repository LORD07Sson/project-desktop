// Замена эмодзи на значки (src/app/icons.js): интерфейс меняется, написанное людьми остаётся.
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";

const dom = new JSDOM("<!doctype html><body></body>");
globalThis.document = dom.window.document;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
const { iconizeEmoji, startEmojiIcons, EMOJI_ICON, ICONS } = await import("../src/app/icons.js");

const box = html => { const d = document.createElement("div"); d.innerHTML = html; document.body.append(d); return d; };
const svgCount = el => el.querySelectorAll("svg").length;

// кнопки и заголовки: эмодзи → значок, текст цел
let el = box(`<button class="rd-add">🎬 Собрать финал</button><button class="icon-btn">⬇️</button><h4>🎙 Равка для озвучки</h4>`);
iconizeEmoji(el);
assert.equal(svgCount(el), 3);
assert.equal(el.querySelector(".rd-add").textContent.trim(), "Собрать финал");
assert.ok(!/[\u{1F300}-\u{1FAFF}⬇]/u.test(el.textContent), "эмодзи не остались");

// содержание людей не трогаем
el = box(`<div class="ms-bubble">спасибо 👍🔥</div><button class="ms-react">❤️</button><textarea>🎬</textarea>`);
iconizeEmoji(el);
assert.equal(svgCount(el), 0);
assert.ok(el.querySelector(".ms-bubble").textContent.includes("👍🔥"));

// незнакомый эмодзи и обычные символы остаются, DOM не меняется
el = box(`<span>😀 ★ → ✓</span>`);
const before = el.innerHTML;
iconizeEmoji(el);
assert.equal(el.innerHTML, before);

// цветные точки статуса
el = box(`<span>🟢 Работает</span>`);
iconizeEmoji(el);
assert.equal(el.querySelectorAll(".ei-dot").length, 1);

// все значки из таблицы существуют
for (const [emo, name] of Object.entries(EMOJI_ICON)) assert.ok(ICONS[name], `нет значка ${name} для ${emo}`);

// наблюдатель: узлы, добавленные позже, и смена textContent
startEmojiIcons(document.body);
const late = document.createElement("button");
document.body.append(late);
late.textContent = "🗑";
await new Promise(r => setTimeout(r, 30));
assert.equal(svgCount(late), 1);

console.log("icons-test: OK");
