/* global NodeFilter */
// Линейные иконки вместо цветных эмодзи.
//
// Эмодзи рисуются системным шрифтом, и на разных машинах выглядят по-разному («как в Телеграме»), а рядом с
// остальным интерфейсом — со штриховыми значками 24×24 — смотрятся чужими. Поэтому служебные эмодзи в тексте
// интерфейса заменяются на SVG в том же стиле (штрих 1.7, скруглённые концы, цвет текста).
//
// Замена делается один раз для всего окна (startEmojiIcons в main.js): так она закрывает и разметку, собранную
// в десятках модулей, и подписи, которые присылает сервер («🎙 Равка для озвучки»). Содержание, написанное
// людьми (сообщения, заметки, био, реакции), не трогается — см. EXCLUDE.

const c = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
const r = (x, y, w, h, rx) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const p = d => `<path d="${d}"/>`;

export const ICONS = {
  image: r(3, 4, 18, 16, 2.5) + c(9, 10, 1.6) + p("m3 17 5-4 4 3 3-2 6 4"),
  film: r(3, 4, 18, 16, 2.5) + p("M8 4v16M16 4v16M3 9h5M3 15h5M16 9h5M16 15h5"),
  music: p("M9 18V5l11-2v13") + c(6, 18, 3) + c(17, 16, 3),
  mic: r(9, 3, 6, 11, 3) + p("M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"),
  doc: p("M7 3h8l4 4v14H7V3ZM15 3v4h4M10 12h6M10 16h6"),
  clip: p("M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4L14 8"),
  trash: p("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"),
  download: p("M12 4v11M7 10l5 5 5-5M5 20h14"),
  upload: p("M12 16V5M7 10l5-5 5 5M5 20h14"),
  folder: p("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"),
  board: p("M3 7l2-3h7l2 3h7v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"),
  drop: p("M12 3.5S6 10 6 14a6 6 0 0 0 12 0c0-4-6-10.5-6-10.5Z"),
  sliders: p("M5 3v6M5 13v8M12 3v10M12 17v4M19 3v3M19 10v11") + r(3, 9, 4, 4, 1) + r(10, 13, 4, 4, 1) + r(17, 6, 4, 4, 1),
  chat: p("M4 5h16v11H8l-4 4V5Z"),
  pin: p("M9 4h6l-1 6 3 3H7l3-3-1-6ZM12 13v7"),
  clock: c(12, 12, 8) + p("M12 8v4l3 2"),
  queue: r(4, 4, 16, 16, 3) + p("m8.5 12 2.5 2.5 4.5-5"),
  analytics: p("M4 20V10M12 20V4M20 20v-6"),
  clipboard: p("M9 4h6v3H9V4ZM7 5H5v16h14V5h-2M9 12h6M9 16h4"),
  titles: r(4, 3, 16, 18, 2) + p("M9 3v6l3-2 3 2V3"),
  calendar: r(3.5, 4.5, 17, 16, 2.5) + p("M3.5 9.5h17M8 2.5v4M16 2.5v4"),
  team: c(9, 8, 3) + p("M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5") + c(17, 7, 2.4),
  profile: c(12, 8, 4) + p("M4 20c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"),
  smile: c(12, 12, 8.5) + p("M8.5 14c.8 1.4 2 2.1 3.5 2.1s2.7-.7 3.5-2.1M9 9.8h.01M15 9.8h.01"),
  settings: c(12, 12, 3) + p("M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14 3h-4l-.6 2.6a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.3-1a7 7 0 0 0 2 1.2L10 21h4l.6-2.6a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"),
  keyboard: r(2.5, 6, 19, 12, 2) + p("M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7.5 14h9"),
  search: c(11, 11, 6.5) + p("m20 20-4.2-4.2"),
  link: p("M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"),
  headphones: p("M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4v-6ZM17 14h3v6h-3v-6Z"),
  speaker: p("M4 9v6h4l5 4V5L8 9H4ZM17 9a4 4 0 0 1 0 6M19.5 6.5a8 8 0 0 1 0 11"),
  edit: p("M4 20h4L18 10l-4-4L4 16v4ZM13 7l4 4"),
  timer: c(12, 13, 7) + p("M12 9v4l2 2M9 2h6"),
  compass: c(12, 12, 9) + p("m15.5 8.5-2 5-5 2 2-5 5-2Z"),
  server: r(3, 4, 18, 7, 1.5) + r(3, 13, 18, 7, 1.5) + p("M7 7.5h.01M7 16.5h.01"),
  wrench: p("M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17l3 3 5.2-5.2a4 4 0 0 0 5.3-5.3l-2.6 2.6-2.4-.6-.6-2.4z"),
  rocket: p("M5 19c0-3 2-4 2-4l2 2s-1 2-4 2ZM9 15l-2-2c1-4 4-8 10-9 0 6-3 10-8 11ZM15 9h.01"),
  trenddown: p("M3 7l6 6 4-4 8 8M15 17h6v-6"),
  target: c(12, 12, 9) + c(12, 12, 5) + c(12, 12, 1),
  flame: p("M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 1-3 0-6 1-9Z"),
  bolt: p("M13 3 5 14h6l-1 7 8-11h-6l1-7Z"),
  hourglass: p("M7 3h10M7 21h10M8 3c0 5 4 5 4 9s-4 4-4 9M16 3c0 5-4 5-4 9s4 4 4 9"),
  checkcircle: c(12, 12, 9) + p("m8 12.5 3 3 5-6"),
  ban: c(12, 12, 9) + p("m6 6 12 12"),
  alert: p("M12 4 3 20h18L12 4ZM12 10v4M12 17.5h.01"),
  bell: p("M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2ZM10 21h4"),
  gift: r(4, 9, 16, 11, 2) + p("M12 9v11M4 13h16M12 9c-2.5 0-4-1-4-2.5S9.5 4 12 9ZM12 9c2.5 0 4-1 4-2.5S14.5 4 12 9Z"),
  megaphone: p("M4 10v4h3l8 4V6L7 10H4ZM18 9a4 4 0 0 1 0 6"),
  inbox: p("M4 13l2-8h12l2 8v6H4v-6ZM4 13h5l1 2h4l1-2h5"),
  lock: r(5, 11, 14, 10, 2) + p("M8 11V8a4 4 0 0 1 8 0v3"),
  unlock: r(5, 11, 14, 10, 2) + p("M8 11V8a4 4 0 0 1 7.5-1.5"),
  crown: p("M3 8l4 4 5-7 5 7 4-4-2 11H5L3 8Z"),
  refresh: p("M20 11a8 8 0 1 0-2 6M20 5v6h-6"),
  help: c(12, 12, 9) + p("M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01"),
  database: p("M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"),
  sparkle: p("M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7L19 17Z"),
  thumbup: p("M7 11v9H4v-9h3ZM7 11l4-7c1.5 0 2.5 1 2 3l-.5 3H19a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 17.8 20H7"),
  thumbdown: p("M17 13V4h3v9h-3ZM17 13l-4 7c-1.5 0-2.5-1-2-3l.5-3H5a2 2 0 0 1-2-2.3l1.2-6A2 2 0 0 1 6.2 4H17"),
  dice: r(4, 4, 16, 16, 3) + p("M8.5 8.5h.01M15.5 8.5h.01M12 12h.01M8.5 15.5h.01M15.5 15.5h.01"),
  gamepad: p("M6 8h12a4 4 0 0 1 4 4v2a3 3 0 0 1-5 2l-1-2H8l-1 2a3 3 0 0 1-5-2v-2a4 4 0 0 1 4-4ZM8 10v4M6 12h4M16 11h.01M18 13h.01"),
  sprout: p("M12 21V11M12 11c0-4 3-6 7-6 0 4-3 6-7 6ZM12 14c0-3-2-5-6-5 0 3 2 5 6 5Z"),
  flag: p("M5 21V4M5 4h11l-2 4 2 4H5"),
  scissors: c(6, 6, 3) + c(6, 18, 3) + p("M8.5 7.5 20 18M8.5 16.5 20 6"),
  coffee: p("M5 8h11v6a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V8ZM16 10h2a2 2 0 0 1 0 4h-2M8 3v2M12 3v2"),
  heart: p("M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11Z"),
  ghost: p("M6 21V11a6 6 0 0 1 12 0v10l-3-2-3 2-3-2-3 2ZM10 11h.01M14 11h.01"),
  cap: p("M2 9l10-5 10 5-10 5L2 9ZM6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5"),
  expand: p("M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"),
  medal: c(12, 15, 5) + p("M9 3h6l-1 6h-4L9 3Z"),
  at: c(12, 12, 4) + p("M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"),
  mail: r(3, 5, 18, 14, 2.5) + p("m3.5 7 8.5 6 8.5-6"),
  play: p("M8 5v14l11-7z"),
};

/** SVG-разметка иконки: <span class="ei"> наследует цвет и размер текста. */
export function iconHtml(name, extra = "") {
  const body = ICONS[name];
  if (!body) return "";
  return `<span class="ei${extra ? " " + extra : ""}" aria-hidden="true"><svg viewBox="0 0 24 24">${body}</svg></span>`;
}

// Эмодзи → иконка. Ключи без селектора вида (U+FE0F). Чего здесь нет, остаётся эмодзи как есть.
export const EMOJI_ICON = {
  "🖼": "image", "🎬": "film", "🎞": "film", "🎵": "music", "🎙": "mic", "📄": "doc", "📜": "doc", "🧾": "doc", "📎": "clip",
  "🗑": "trash", "⬇": "download", "⬆": "upload", "📥": "inbox", "📂": "folder", "📁": "folder", "🗂": "board", "🗄": "database", "💾": "database",
  "💧": "drop", "🎚": "sliders", "💬": "chat", "✉": "mail", "📌": "pin", "📍": "pin", "🕓": "clock", "🕘": "clock", "⏰": "clock", "🕸": "clock",
  "☑": "queue", "📊": "analytics", "📈": "analytics", "📉": "trenddown", "📋": "clipboard", "🗳": "titles", "📅": "calendar",
  "👥": "team", "👤": "profile", "🙂": "smile", "😂": "smile", "⚙": "settings", "⌨": "keyboard", "🔎": "search", "🔗": "link",
  "🎧": "headphones", "🔊": "speaker", "📝": "edit", "✏": "edit", "⏱": "timer", "🎭": "team", "🧭": "compass", "🖥": "server",
  "🛠": "wrench", "🚀": "rocket", "🎯": "target", "🔥": "flame", "⚡": "bolt", "⏳": "hourglass", "✅": "checkcircle", "⛔": "ban",
  "⚠": "alert", "🚨": "alert", "🔔": "bell", "🎂": "gift", "📣": "megaphone", "📢": "megaphone", "🔐": "lock", "🔓": "unlock",
  "👑": "crown", "♻": "refresh", "❔": "help", "✨": "sparkle", "🎉": "sparkle", "👋": "sparkle", "👍": "thumbup", "👎": "thumbdown",
  "🎲": "dice", "🎮": "gamepad", "🌱": "sprout", "⚑": "flag", "✂": "scissors", "☕": "coffee", "💗": "heart", "👻": "ghost",
  "🎓": "cap", "⛶": "expand", "🥇": "medal", "🥈": "medal", "🥉": "medal", "🏅": "medal",
};

const DOT_COLOR = { "🟢": "#4fbf8b", "🟡": "#e3b23c", "🔴": "#e5534b", "⚪": "#807169" };

// Содержание, написанное людьми, и поля ввода — эмодзи там остаются как есть.
const EXCLUDE = [
  "input", "textarea", "select", "[contenteditable]", "script", "style", "[data-keep-emoji]",
  ".ms-bubble", ".ms-quote", ".ms-react", ".ms-reacts", ".ms-react-pop", ".ms-replybar", ".ms-pin-item", ".ms-file-item",
  ".tk-bubble", ".note-body", ".rm-text", ".ib-q", ".status-quote", ".profile-bio", ".bio", ".st",
  ".pin-note", ".cmdk-input",
].join(",");

const QUICK = /[←-⯿\u{1F000}-\u{1FAFF}]/u;
const EMOJI_RE = /(?:[\u{1F000}-\u{1FAFF}←-⯿])️?/gu;

function replaceText(node) {
  const text = node.nodeValue;
  if (!text || !QUICK.test(text)) return;
  const parent = node.parentElement;
  if (!parent || parent.closest(EXCLUDE)) return;
  let last = 0;
  let changed = false;
  const frag = document.createDocumentFragment();
  for (const m of text.matchAll(EMOJI_RE)) {
    const ch = m[0].replace(/️/g, "");
    const name = EMOJI_ICON[ch];
    const dot = DOT_COLOR[ch];
    if (!name && !dot) continue;
    if (m.index > last) frag.append(text.slice(last, m.index));
    const holder = document.createElement("span");
    holder.innerHTML = dot ? `<span class="ei-dot" style="--d:${dot}" aria-hidden="true"></span>` : iconHtml(name);
    frag.append(holder.firstChild);
    last = m.index + m[0].length;
    changed = true;
  }
  if (!changed) return; // ничего не заменили — DOM не трогаем (иначе наблюдатель зациклится)
  if (last < text.length) frag.append(text.slice(last));
  node.replaceWith(frag);
}

function iconize(root) {
  if (root.nodeType === 3) return replaceText(root);
  if (root.nodeType !== 1) return;
  if (root.closest && root.closest(EXCLUDE)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let t = walker.nextNode(); t; t = walker.nextNode()) texts.push(t);
  texts.forEach(replaceText);
}

/** Заменяет эмодзи на иконки во всём окне и следит за новыми узлами (экраны перерисовываются постоянно). */
export function startEmojiIcons(root = document.body) {
  // Проверка сборки (verify-modules.mjs) выполняет бандл в Node с урезанным document — без DOM-API делать нечего.
  if (!root || typeof NodeFilter === "undefined" || typeof MutationObserver === "undefined" || typeof requestAnimationFrame === "undefined") return;
  const queue = new Set();
  let frame = 0;
  const flush = () => {
    frame = 0;
    const nodes = [...queue];
    queue.clear();
    for (const n of nodes) if (n.isConnected) iconize(n);
  };
  const schedule = n => { queue.add(n); if (!frame) frame = requestAnimationFrame(flush); };
  new MutationObserver(list => {
    for (const m of list) {
      if (m.type === "characterData") schedule(m.target);
      else m.addedNodes.forEach(schedule);
    }
  }).observe(root, { childList: true, subtree: true, characterData: true });
  iconize(root);
}

export { iconize as iconizeEmoji };
