// «Дорожная карта» — редактор схем связей: узлы разных форм (система, подсистема, главный блок,
// внешний сервис, клиент, этап, заметка), стрелки (прямые / плавные / ломаные, пунктир, «поток»),
// ветки-списки как в mind map, номера и статусы этапов. Схема целиком — один JSON на сервере
// (/api/roadmaps), сохраняется сама через секунду после правки.

import { apiGet, apiPost, toast, askConfirm } from "./api.js";
import { $, esc, relTime, showContextMenu } from "./utils.js";
import { TAB_PERMS, MEMBER_TABS, tabAllowed } from "./tabs.js";

const NS = "http://www.w3.org/2000/svg";
const GRID = 20;

// Формы узлов: размер по умолчанию, подпись в палитре, цвет.
const KINDS = {
  hub:       { label: "Главный блок",   w: 300, h: 92,  color: "#ef4444" },
  circle:    { label: "Круг",           w: 210, h: 210, color: "#ff3b3b" },
  pill:      { label: "Система",        w: 280, h: 72,  color: "#38d9e8" },
  box:       { label: "Подсистема",     w: 250, h: 66,  color: "#38d9e8" },
  square:    { label: "Внешний сервис", w: 180, h: 180, color: "#fcd34d" },
  tag:       { label: "Клиент",         w: 250, h: 92, color: "#8b5cf6" },
  milestone: { label: "Веха",           w: 130, h: 130, color: "#22c55e" },
  note:      { label: "Заметка",        w: 220, h: 120, color: "#fcd34d" },
  text:      { label: "Текст",          w: 220, h: 40,  color: "transparent" },
  frame:     { label: "Рамка-группа",   w: 520, h: 320, color: "#a78bfa" },
  image:     { label: "Картинка",       w: 320, h: 200, color: "#94a3b8" },
};
const COLORS = ["#ef4444", "#f97316", "#fcd34d", "#22c55e", "#38d9e8", "#3b82f6", "#8b5cf6", "#ec4899", "#94a3b8", "#1f2937", "#ffffff"];
const STATUS = { "": "Без статуса", plan: "План", work: "В работе", done: "Готово", risk: "Риск" };
const STATUS_COLOR = { plan: "#94a3b8", work: "#f59e0b", done: "#22c55e", risk: "#ef4444" };
// Статусы служб на автосхеме «Боты и всё» — в выборе статуса этапа их нет.
const SERVICE_STATUS = { up: "Работает", down: "Не работает" };
Object.assign(STATUS_COLOR, { up: "#22c55e", down: "#ef4444" });
// Линейные иконки (24×24, как в остальном приложении) — эмодзи в SVG рисуются не везде.
const ICON_PATHS = {
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17" cy="7" r="2.4"/><path d="M17 13c2.4.3 4 2.2 4 5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.7 5.7 3.7 9s-1.2 6.3-3.7 9c-2.5-2.7-3.7-5.7-3.7-9S9.5 5.7 12 3z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  db: '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13M5 12c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5"/>',
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16h5"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18h2"/>',
  card: '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3 10h18M7 15h4"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  film: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  rocket: '<path d="M5 15c-1.5 1.5-2 4.5-2 6 1.5 0 4.5-.5 6-2M9 15l-3-3c1-4 4.5-9 15-9 0 10.5-5 14-9 15z"/><circle cx="15" cy="9" r="1.8"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  box: '<path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9z"/><path d="m3.5 7.5 8.5 4.5 8.5-4.5M12 12v9"/>',
  code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 18 8.5a4.8 4.8 0 0 1-.5 9.5z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
};
const ICONS = ["", ...Object.keys(ICON_PATHS)];
// Старые карты хранили эмодзи — переводим в иконки.
const EMOJI_ICON = { "👥": "users", "🌐": "globe", "⚙️": "gear", "🗄️": "db", "🤖": "bot", "📱": "phone", "💳": "card", "📈": "chart", "🔒": "lock", "✉️": "mail", "🎬": "film", "🎙️": "mic", "🚀": "rocket", "⚡": "bolt", "📦": "box", "📞": "phone", "⭐": "target", "🧩": "box" };
const iconKey = i => ICON_PATHS[i] ? i : EMOJI_ICON[i] || "";
function iconSvg(i, cx, cy, size, color) {
  const raw = typeof i === "string" && i.startsWith("svg:") ? i.slice(4) : "";
  const k = raw ? "" : iconKey(i);
  if (!k && !raw) return "";
  const sc = size / 24;
  return `<g transform="translate(${cx - size / 2},${cy - size / 2}) scale(${sc})" fill="none" stroke="${color}" stroke-width="${1.7 / Math.max(sc, .6) * .9}" stroke-linecap="round" stroke-linejoin="round" pointer-events="none">${raw || ICON_PATHS[k]}</g>`;
}

let st = null; // состояние открытой вкладки

const uid = () => Math.random().toString(36).slice(2, 9);
const clone = o => JSON.parse(JSON.stringify(o));
const snap = v => (st.grid ? Math.round(v / GRID) * GRID : Math.round(v));

function emptyData() { return { nodes: [], edges: [], view: { x: 0, y: 0, z: 1 } }; }

// ---------- шаблоны ----------
function node(kind, x, y, text, extra = {}) {
  const k = KINDS[kind];
  return { id: uid(), kind, x, y, w: k.w, h: k.h, text, color: k.color, ...extra };
}
function edge(from, to, extra = {}) {
  return { id: uid(), from: from.id, to: to.id, style: "dotted", arrows: "end", curve: "straight", color: "#64748b", flow: true, label: "", ...extra };
}

const TEMPLATES = {
  blank: { label: "Пустая", make: () => emptyData() },
  links: {
    label: "Диаграмма связей",
    make() {
      const main = node("circle", 700, 130, "Главный\nблок", { color: "#f43f5e", icon: "bolt" });
      const s1 = node("pill", 120, 270, "Система №1", { icon: "users" });
      const s1a = node("box", 140, 390, "Подсистема №1");
      const s1b = node("box", 140, 490, "Подсистема №2");
      const s2 = node("pill", 670, 560, "Система №2", { icon: "globe" });
      const s2a = node("box", 690, 670, "Подсистема №1");
      const s2b = node("box", 690, 770, "Подсистема №2");
      const ext = node("square", 1220, 130, "Внешний\nсервис", { color: "#f59e0b" });
      const c1 = node("tag", 1200, 520, "Клиент №1");
      const c2 = node("tag", 1200, 680, "Клиент №2");
      return {
        nodes: [main, s1, s1a, s1b, s2, s2a, s2b, ext, c1, c2],
        edges: [
          edge(s1, main, { arrows: "both" }), edge(main, s2, { arrows: "both", curve: "straight" }),
          edge(s1a, s1b, { curve: "elbow" }), edge(s1b, s2a), edge(s1b, s2b),
          edge(s2a, ext, { arrows: "both" }), edge(s2b, c1), edge(s2b, c2),
          edge(s1, s1a, { style: "solid", arrows: "none", color: "#475569", flow: false }),
          edge(s2, s2a, { style: "solid", arrows: "none", color: "#475569", flow: false }),
        ],
        view: { x: 40, y: 20, z: 0.62 },
      };
    },
  },
  mind: {
    label: "Карта проекта",
    make() {
      const hub = node("hub", 620, 380, "Студия озвучки", { color: "#a78bfa", sub: "Центр" });
      const a = node("box", 1060, 150, "Сайт: основная часть", { num: 1, color: "#38bdf8", status: "done", items: ["Главная", "Каталог тайтлов", "Расписание", "Контакты"] });
      const b = node("box", 160, 250, "CRM / бот", { num: 2, color: "#38bdf8", status: "work", items: ["Заявки", "Отчёты", "Уведомления"], itemsSide: "left" });
      const c = node("box", 1060, 560, "Личный кабинет", { num: 3, color: "#38bdf8", status: "plan", items: ["Мои серии", "Файлы", "Выплаты"] });
      const d = node("box", 1060, 380, "Продвижение", { num: 4, color: "#38bdf8", status: "work" });
      const e = node("box", 160, 600, "Система задач", { num: 5, color: "#38bdf8", status: "plan", items: ["Очередь", "Доска", "Календарь"], itemsSide: "left" });
      const f = node("box", 160, 90, "Интеграции", { num: 6, color: "#38bdf8", status: "risk" });
      const trunk = { style: "solid", arrows: "none", curve: "curve", color: "#64748b", flow: false };
      const red = { style: "dotted", arrows: "end", curve: "curve", color: "#f87171", flow: true };
      return {
        nodes: [hub, a, b, c, d, e, f],
        edges: [
          edge(hub, a, trunk), edge(hub, b, trunk), edge(hub, c, trunk), edge(hub, d, trunk), edge(hub, e, trunk), edge(hub, f, trunk),
          edge(d, b, { ...red, label: "Заявки из рекламы" }), edge(c, e, { ...red, label: "Заявки → задачи" }),
          edge(f, c, { ...red }),
        ],
        view: { x: 10, y: 10, z: 0.62 },
      };
    },
  },
  road: {
    label: "Дорожная карта релиза",
    make() {
      const steps = [["Перевод", "done"], ["Тайминг", "done"], ["Озвучка", "work"], ["Сведение", "plan"], ["Проверка", "plan"]];
      const nodes = [], edges = [];
      let prev = null;
      steps.forEach(([t, s], i) => {
        const n = node("pill", 80 + i * 400, 260 + (i % 2 ? 110 : 0), t, { num: i + 1, status: s, color: ["#38d9e8", "#3b82f6", "#8b5cf6", "#ec4899", "#f97316"][i] });
        nodes.push(n);
        if (prev) edges.push(edge(prev, n, { curve: "curve", color: "#94a3b8" }));
        prev = n;
      });
      const rel = node("milestone", 2100, 280, "Релиз", { status: "plan" });
      nodes.push(rel); edges.push(edge(prev, rel, { curve: "curve", color: "#22c55e", style: "dashed" }));
      return { nodes, edges, view: { x: 20, y: 40, z: 0.6 } };
    },
  },
};

// ---------- геометрия ----------
const center = n => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
function border(n, dx, dy) {
  const hw = n.w / 2, hh = n.h / 2;
  if (!dx && !dy) return center(n);
  let t;
  if (n.kind === "circle") t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (n.kind === "milestone") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(hw / Math.abs(dx || 1e-9), hh / Math.abs(dy || 1e-9));
  const c = center(n);
  return { x: c.x + dx * t, y: c.y + dy * t };
}
function sidePoint(n, side) {
  const c = center(n);
  return side === "l" ? { x: n.x, y: c.y } : side === "r" ? { x: n.x + n.w, y: c.y } : side === "t" ? { x: c.x, y: n.y } : { x: c.x, y: n.y + n.h };
}
function edgeGeom(e, A, B) {
  const ca = center(A), cb = center(B);
  const dx = cb.x - ca.x, dy = cb.y - ca.y;
  // Соседей по горизонтали соединяем боковыми сторонами даже при заметном перепаде по высоте — так линии не
  // втыкаются в верх и низ карточек и не пересекают их.
  const horiz = Math.abs(dx) >= Math.abs(dy) * 0.6 || Math.abs(dx) > (A.w + B.w) / 2 + 60;
  if (e.curve === "straight") {
    const a = border(A, dx, dy), b = border(B, -dx, -dy);
    return { d: `M${a.x},${a.y} L${b.x},${b.y}`, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, a, b };
  }
  const a = sidePoint(A, horiz ? (dx > 0 ? "r" : "l") : (dy > 0 ? "b" : "t"));
  const b = sidePoint(B, horiz ? (dx > 0 ? "l" : "r") : (dy > 0 ? "t" : "b"));
  if (e.curve === "elbow") {
    // Ломаная со скруглёнными углами (r = 14), а не острыми.
    const r = 14;
    if (horiz) {
      const mx = (a.x + b.x) / 2, sy = Math.sign(b.y - a.y) || 1, sx = Math.sign(b.x - a.x) || 1, rr = Math.min(r, Math.abs(b.y - a.y) / 2, Math.abs(mx - a.x));
      return { d: `M${a.x},${a.y} H${mx - sx * rr} Q${mx},${a.y} ${mx},${a.y + sy * rr} V${b.y - sy * rr} Q${mx},${b.y} ${mx + sx * rr},${b.y} H${b.x}`, mid: { x: mx, y: (a.y + b.y) / 2 }, a, b };
    }
    const my = (a.y + b.y) / 2, sx = Math.sign(b.x - a.x) || 1, sy = Math.sign(b.y - a.y) || 1, rr = Math.min(r, Math.abs(b.x - a.x) / 2, Math.abs(my - a.y));
    return { d: `M${a.x},${a.y} V${my - sy * rr} Q${a.x},${my} ${a.x + sx * rr},${my} H${b.x - sx * rr} Q${b.x},${my} ${b.x},${my + sy * rr} V${b.y}`, mid: { x: (a.x + b.x) / 2, y: my }, a, b };
  }
  const k = horiz ? Math.abs(b.x - a.x) / 2 : Math.abs(b.y - a.y) / 2;
  const c1 = horiz ? { x: a.x + Math.sign(dx) * k, y: a.y } : { x: a.x, y: a.y + Math.sign(dy) * k };
  const c2 = horiz ? { x: b.x - Math.sign(dx) * k, y: b.y } : { x: b.x, y: b.y - Math.sign(dy) * k };
  const mid = { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 };
  return { d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`, mid, a, b };
}

// ---------- отрисовка ----------
// Узел — тёмная «стеклянная» карточка: цвет узла только акцент (рамка, свечение, полоска, иконка).
const gid = c => `rm-g-${String(c).replace(/[^a-z0-9]/gi, "")}`;
function accent(n) {
  const c = n.color;
  if (!c || c === "transparent" || !/^#[0-9a-f]{6}$/i.test(c)) return c && c !== "transparent" ? c : "#94a3b8";
  const v = parseInt(c.slice(1), 16), lum = ((v >> 16) * 299 + ((v >> 8) & 255) * 587 + (v & 255) * 114) / 1000;
  return lum < 70 ? "#94a3b8" : c; // слишком тёмный акцент на тёмной карточке не виден
}
function outline(n) {
  const w = n.w, h = n.h;
  switch (n.kind) {
    case "circle": return { tag: "ellipse", a: `cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}"` };
    case "pill": return { tag: "rect", a: `width="${w}" height="${h}" rx="${h / 2}"` };
    case "tag": return { tag: "path", a: `d="M12,0 H${w - h / 2} L${w},${h / 2} L${w - h / 2},${h} H12 Q0,${h} 0,${h - 12} V12 Q0,0 12,0 Z"` };
    case "milestone": return { tag: "path", a: `d="M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z"` };
    case "hub": return { tag: "rect", a: `width="${w}" height="${h}" rx="18"` };
    case "text": return { tag: "rect", a: `width="${w}" height="${h}" rx="6"` };
    default: return { tag: "rect", a: `width="${w}" height="${h}" rx="12"` };
  }
}
function shapeSvg(n) {
  const c = accent(n), o = outline(n), w = n.w, h = n.h;
  if (n.kind === "text") return `<${o.tag} class="rm-shape" ${o.a} fill="transparent"/>`;
  if (n.kind === "frame") return `<rect class="rm-shape rm-frame" width="${w}" height="${h}" rx="18" fill="${c}" fill-opacity=".05" stroke="${c}" stroke-opacity=".55" stroke-width="1.4" stroke-dasharray="8 6"/>`;
  if (n.kind === "image") {
    const cid = `rm-clip-${n.id}`;
    return `<clipPath id="${cid}"><rect width="${w}" height="${h}" rx="12"/></clipPath><rect class="rm-shape rm-card" width="${w}" height="${h}" rx="12" fill="var(--rm-card)" style="--glow:${c}"/>`
      + (n.src ? `<image href="${esc(n.src)}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid ${n.fit === "contain" ? "meet" : "slice"}" clip-path="url(#${cid})" pointer-events="none"/>` : "")
      + `<rect width="${w}" height="${h}" rx="12" fill="none" stroke="${c}" stroke-opacity=".35" pointer-events="none"/>`;
  }
  let s = `<${o.tag} class="rm-shape rm-card" ${o.a} fill="var(--rm-card)" stroke="${c}" stroke-opacity=".55" stroke-width="1.2" style="--glow:${c}"/>`;
  s += `<${o.tag} ${o.a} fill="url(#${gid(c)})" pointer-events="none"/>`;
  if (n.kind !== "milestone" && n.kind !== "circle") s += `<${o.tag} ${o.a} fill="url(#rm-sheen)" pointer-events="none"/>`;
  if (n.kind === "box" || n.kind === "note") s += `<rect x="0" y="10" width="3" height="${h - 20}" rx="1.5" fill="${c}" pointer-events="none"/>`;
  if (n.kind === "hub") {
    s += `<rect x="1" y="1" width="${w - 2}" height="3" rx="1.5" fill="${c}" pointer-events="none" opacity=".9"/>`;
    s = [1, 2, 3].map(k => `<rect class="rm-halo" style="--k:${k}" x="${-8 * k}" y="${-8 * k}" width="${w + 16 * k}" height="${h + 16 * k}" rx="${18 + 8 * k}" fill="none" stroke="${c}" pointer-events="none"/>`).join("") + s;
  }
  if (n.kind === "square") {
    const k = 16, b = `stroke="${c}" stroke-width="2.4" fill="none" stroke-linecap="round" pointer-events="none"`;
    s += `<path d="M0,${k} V0 H${k} M${w - k},0 H${w} V${k} M${w},${h - k} V${h} H${w - k} M${k},${h} H0 V${h - k}" ${b}/>`;
  }
  if (n.kind === "circle") {
    s += `<ellipse class="rm-orbit" cx="${w / 2}" cy="${h / 2}" rx="${w / 2 + 12}" ry="${h / 2 + 12}" fill="none" stroke="${c}" stroke-opacity=".45" stroke-dasharray="2 10" stroke-linecap="round" pointer-events="none"/>`;
    s += `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2 - 14}" ry="${h / 2 - 14}" fill="none" stroke="${c}" stroke-opacity=".18" pointer-events="none"/>`;
  }
  if (n.kind === "note") s += `<path d="M${w - 18},0 H${w} V18" fill="none" stroke="${c}" stroke-opacity=".6" pointer-events="none"/>`;
  return s;
}

function textSvg(n) {
  if (n.kind === "frame") {
    const c = accent(n);
    return `${n.sub ? `<text class="rm-cap" x="18" y="-12" fill="${c}" dominant-baseline="central">${esc(String(n.sub).toUpperCase())}</text>` : ""}<text class="rm-txt" x="18" y="22" fill="var(--ink)" font-size="${n.fs || 18}" font-weight="700" dominant-baseline="central">${esc(n.text || "")}</text>`;
  }
  if (n.kind === "image") return n.text && n.text !== "Картинка" ? `<text class="rm-txt" x="${n.w / 2}" y="${n.h + 16}" fill="var(--ink-soft)" font-size="13" text-anchor="middle" dominant-baseline="central">${esc(n.text)}</text>` : "";
  const c = accent(n);
  const lines = String(n.text || "").split("\n");
  const big = n.kind === "circle" || n.kind === "hub" || n.kind === "square" || n.kind === "milestone";
  const fs = n.fs || (n.kind === "hub" ? 22 : big ? 19 : n.kind === "note" ? 14 : 16);
  const lh = fs * 1.28;
  const cap = n.kind === "text" ? "" : (n.sub ?? (n.kind === "circle" ? "" : KINDS[n.kind].label));
  const hasIcon = n.icon && (n.kind === "pill" || n.kind === "box" || n.kind === "tag");
  const left = n.kind === "note" || (hasIcon && n.kind !== "tag") || n.kind === "box";
  const tx = n.kind === "note" ? 16 : n.kind === "box" ? 18 + (hasIcon ? 38 : 0) : hasIcon ? n.h * 0.5 + 28 : n.kind === "tag" ? (n.w - n.h / 2) / 2 : n.w / 2;
  const anchor = left || hasIcon ? "start" : "middle";
  const block = lines.length * lh + (cap ? 16 : 0);
  let y0 = n.kind === "note" ? 22 : n.h / 2 - block / 2 + (cap ? 16 : 0) + lh / 2;
  let s = "";
  if (cap && n.kind !== "milestone") {
    s += `<text class="rm-cap" x="${tx}" y="${y0 - lh / 2 - 6}" fill="${c}" text-anchor="${anchor}" dominant-baseline="central">${esc(String(cap).toUpperCase())}</text>`;
  } else if (n.kind === "milestone") { y0 = n.h / 2 - ((lines.length - 1) * lh) / 2; }
  s += `<text class="rm-txt" x="${tx}" y="${y0}" fill="var(--ink)" font-size="${fs}" font-weight="${n.kind === "hub" ? 700 : 600}" text-anchor="${anchor}" dominant-baseline="central">${
    lines.map((l, i) => `<tspan x="${tx}" dy="${i ? lh : 0}">${esc(l) || " "}</tspan>`).join("")}</text>`;
  return s;
}

function decoSvg(n) {
  const c = accent(n);
  let s = "";
  if (n.icon) {
    if (n.kind === "pill" || n.kind === "box" || n.kind === "tag") {
      const r = Math.min(17, n.h * 0.3), cx = n.kind === "box" ? 18 + r : n.kind === "tag" ? 14 + r : n.h * 0.5, cy = n.h / 2;
      s += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c}" fill-opacity=".16" stroke="${c}" stroke-opacity=".5"/>${iconSvg(n.icon, cx, cy, r * 1.05, c)}`;
    } else s += iconSvg(n.icon, n.w / 2, n.kind === "circle" ? n.h * 0.27 : 28, 24, c);
  }
  if (n.num) {
    const col = STATUS_COLOR[n.status] || c;
    const y = n.kind === "circle" || n.kind === "milestone" ? n.h / 2 - 12 : -12;
    s += `<g class="rm-num" transform="translate(-12,${y})"><rect width="24" height="24" rx="7" fill="var(--rm-card)" stroke="${col}"/><text x="12" y="12.5" font-size="12" font-weight="700" fill="${col}" text-anchor="middle" dominant-baseline="central">${String(n.num).padStart(2, "0")}</text></g>`;
  }
  if (n.status) {
    const col = STATUS_COLOR[n.status];
    const label = (STATUS[n.status] || SERVICE_STATUS[n.status] || "") + (n.due ? ` · ${fmtDue(n.due)}` : "");
    const w = label.length * 6.6 + 24;
    s += `<g class="rm-st ${n.status}" transform="translate(${n.w / 2 - w / 2},${n.h + 10})"><rect width="${w}" height="20" rx="10" fill="var(--rm-card)" stroke="${col}" stroke-opacity=".5"/><circle cx="11" cy="10" r="3.5" fill="${col}"${n.status === "work" ? ' class="rm-blink"' : ""}/><text x="20" y="10.5" font-size="11" font-weight="600" fill="${col}" dominant-baseline="central">${esc(label)}</text></g>`;
    if (n.status === "work") s += `<g class="rm-ring">${ringSvg(n, col)}</g>`;
  } else if (n.due) {
    s += `<text x="${n.w / 2}" y="${n.h + 18}" font-size="11" fill="var(--ink-dim)" text-anchor="middle">${esc(fmtDue(n.due))}</text>`;
  }
  return s;
}
function ringSvg(n, col) {
  const p = 5;
  if (n.kind === "circle") return `<ellipse cx="${n.w / 2}" cy="${n.h / 2}" rx="${n.w / 2 + p}" ry="${n.h / 2 + p}" fill="none" stroke="${col}" stroke-width="1.5"/>`;
  if (n.kind === "milestone") return "";
  return `<rect x="${-p}" y="${-p}" width="${n.w + 2 * p}" height="${n.h + 2 * p}" rx="${n.kind === "pill" ? n.h / 2 + p : 16}" fill="none" stroke="${col}" stroke-width="1.5"/>`;
}
function fmtDue(d) {
  const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${+m[3]}.${m[2]}` : d;
}

// Ветки-подпункты (как «Главная / Аренда / Контакты» в mind map).
function itemsSvg(n, i0) {
  const items = (n.items || []).filter(Boolean);
  if (!items.length) return "";
  const left = n.itemsSide === "left";
  const step = 30, c = center(n);
  const sx = left ? n.x : n.x + n.w, sy = c.y;
  const ex = left ? n.x - 70 : n.x + n.w + 70;
  return items.map((t, i) => {
    const y = c.y + (i - (items.length - 1) / 2) * step;
    const d = `M${sx},${sy} C${sx + (left ? -40 : 40)},${sy} ${ex + (left ? 40 : -40)},${y} ${ex},${y}`;
    const ac = accent(n);
    return `<g class="rm-item" data-of="${n.id}" style="--d:${(i0 || 0) + 260 + i * 35}ms"><path class="rm-branch" d="${d}" pathLength="1" fill="none" stroke="${ac}" stroke-opacity=".45" stroke-width="1.4"/><circle cx="${ex}" cy="${y}" r="2.6" fill="${ac}"/><text x="${ex + (left ? -9 : 9)}" y="${y}" font-size="14" fill="${t.startsWith("✓") ? "#4ade80" : t.startsWith("✕") ? "#f87171" : t.startsWith("◐") ? "#fbbf24" : "var(--ink-soft)"}" text-anchor="${left ? "end" : "start"}" dominant-baseline="central">${esc(t)}</text></g>`;
  }).join("");
}

function dashFor(style) { return style === "dotted" ? "2 7" : style === "dashed" ? "10 7" : ""; }
function markerId(color, rev) { return `rm-ah-${rev ? "s" : "e"}-${color.replace(/[^a-z0-9]/gi, "")}`; }

const zRank = n => (n.kind === "frame" ? 0 : n.kind === "note" ? 2 : 1);
const zOrder = ns => [...ns].sort((a, b) => zRank(a) - zRank(b));

// Рисунки карандашом/маркером/стрелкой: сглаженный путь по точкам.
function strokePath(pts) {
  if (!pts.length) return "";
  if (pts.length < 3) return `M${pts.map(q => q.join(",")).join(" L")}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0]},${pts[i][1]} ${mx.toFixed(1)},${my.toFixed(1)}`;
  }
  const l = pts[pts.length - 1];
  return `${d} L${l[0]},${l[1]}`;
}
function strokeSvg(sk, sel) {
  const d = sk.t === "arrow" ? `M${sk.pts[0].join(",")} L${sk.pts[sk.pts.length - 1].join(",")}` : strokePath(sk.pts);
  const me = sk.t === "arrow" ? ` marker-end="url(#${markerId(sk.c)})"` : "";
  return `<g class="rm-stroke${sel ? " sel" : ""}" data-draw="${sk.id}"><path class="rm-hit" d="${d}"/><path d="${d}" fill="none" stroke="${sk.c}" stroke-width="${sk.w}" stroke-linecap="round" stroke-linejoin="round" opacity="${sk.t === "marker" ? 0.38 : 1}"${me}/></g>`;
}

function render() {
  const { data } = st.map;
  const svg = st.svg;
  const byId = new Map(data.nodes.map(n => [n.id, n]));
  const colors = new Set([...data.edges.map(e => e.color || "#64748b"), ...(data.draw || []).filter(x => x.t === "arrow").map(x => x.c)]);
  const defs = [...colors].map(c => `
    <marker id="${markerId(c)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,1 L10,5 L0,9 L3,5 Z" fill="${c}"/></marker>
    <marker id="${markerId(c, 1)}" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M10,1 L0,5 L10,9 L7,5 Z" fill="${c}"/></marker>`).join("");
  const ncol = new Set(data.nodes.map(accent));
  const grads = [...ncol].map(c => `<linearGradient id="rm-g-${c.replace(/[^a-z0-9]/gi, "")}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".22"/><stop offset=".55" stop-color="${c}" stop-opacity=".05"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient>`).join("");
  const intro = st.intro;
  const depth = graphDepth(data);
  const delayOf = new Map();
  const perLevel = {};
  for (const n of zOrder(data.nodes)) {
    const lv = depth.get(n.id) ?? 0;
    const k = (perLevel[lv] = (perLevel[lv] || 0) + 1) - 1;
    delayOf.set(n.id, lv * 230 + Math.min(k, 12) * 45);
  }
  const accentOf = new Map(data.nodes.map(n => [n.id, accent(n)]));
  const egrads = [];
  const nodesSvg = zOrder(data.nodes).map(n => {
    const sel = st.sel.has(n.id);
    const d = delayOf.get(n.id) || 0;
    return `<g class="rm-node k-${n.kind}${sel ? " sel" : ""}" data-id="${n.id}" transform="translate(${n.x},${n.y})">
      <g class="rm-in" style="--d:${d}ms">
        ${shapeSvg(n)}${textSvg(n)}${decoSvg(n)}
      </g>
      ${sel ? `<rect class="rm-selbox" x="-6" y="-6" width="${n.w + 12}" height="${n.h + 12}" rx="8"/>
        <rect class="rm-resize" data-resize="1" x="${n.w - 2}" y="${n.h - 2}" width="12" height="12" rx="3"/>` : ""}
      ${["t", "r", "b", "l"].map(s => { const p = sidePoint({ ...n, x: 0, y: 0 }, s); return `<circle class="rm-port" data-port="${s}" cx="${p.x}" cy="${p.y}" r="6"/>`; }).join("")}
    </g>`;
  }).join("");
  const itemSvg = data.nodes.map(n => itemsSvg(n, delayOf.get(n.id) || 0)).join("");
  const edgesSvg = data.edges.map((e, i) => {
    const A = byId.get(e.from), B = byId.get(e.to);
    if (!A || !B) return "";
    const g = edgeGeom(e, A, B);
    const col = e.color || "#64748b";
    const sel = st.selEdge === e.id;
    const dash = dashFor(e.style);
    const me = e.arrows !== "none" ? ` marker-end="url(#${markerId(col)})"` : "";
    const ms = e.arrows === "both" ? ` marker-start="url(#${markerId(col, 1)})"` : "";
    // Серые связи без своего цвета красим плавным переходом от цвета одного узла к цвету другого.
    const auto = !e.color || e.color === "#64748b" || e.color === "#475569";
    let paint = col;
    if (auto && g.a && g.b) {
      const id = `rm-eg-${String(e.id).replace(/[^a-z0-9_-]/gi, "")}`;
      egrads.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${g.a.x}" y1="${g.a.y}" x2="${g.b.x}" y2="${g.b.y}"><stop offset="0" stop-color="${accentOf.get(e.from)}"/><stop offset="1" stop-color="${accentOf.get(e.to)}"/></linearGradient>`);
      paint = `url(#${id})`;
    }
    const len = g.a && g.b ? Math.hypot(g.b.x - g.a.x, g.b.y - g.a.y) * 1.2 : 300;
    const dur = Math.max(1.4, Math.min(5, len / 190));
    const d0 = (delayOf.get(e.from) || 0) + 160;
    const lw = e.label ? Math.min(260, e.label.length * 6.4 + 18) : 0;
    return `<g class="rm-edge${sel ? " sel" : ""}${e.flow ? " flow" : ""}${auto ? " auto" : ""}" data-edge="${e.id}" data-from="${e.from}" data-to="${e.to}" style="--d:${d0}ms;--dur:${dur.toFixed(2)}s;--off:${(-(i * 0.61) % dur).toFixed(2)}s">
      <path class="rm-hit" d="${g.d}"/>
      <path class="rm-line" d="${g.d}" stroke="${paint}" stroke-width="${e.w || 1.6}" stroke-dasharray="${dash}" stroke-linecap="round" fill="none"${me}${ms}/>
      <path class="rm-drawin" d="${g.d}" pathLength="1" stroke="${paint}" stroke-width="${(e.w || 1.6) + 0.6}" fill="none" stroke-linecap="round"/>
      ${e.flow && st.anim ? `<path class="rm-comet" d="${g.d}" pathLength="100" stroke="${auto ? accentOf.get(e.to) : col}" stroke-width="${(e.w || 1.6) + 1.4}" fill="none" stroke-linecap="round"/>` : ""}
      ${e.label ? `<g class="rm-elabel" transform="translate(${g.mid.x},${g.mid.y})"><rect x="${-lw / 2}" y="-11" width="${lw}" height="22" rx="11"/><text text-anchor="middle" dominant-baseline="central" y="0.5">${esc(e.label)}</text></g>` : ""}
    </g>`;
  }).join("");
  svg.innerHTML = `<defs>${defs}${grads}${egrads.join("")}
      <linearGradient id="rm-sheen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".07"/><stop offset=".45" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <filter id="rm-soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <pattern id="rm-grid" width="${GRID}" height="${GRID}" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="var(--rm-dot)"/></pattern>
      <filter id="rm-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <g class="rm-vp" transform="translate(${data.view.x},${data.view.y}) scale(${data.view.z})">
      ${st.grid ? `<rect class="rm-gridbg" x="-20000" y="-20000" width="40000" height="40000" fill="url(#rm-grid)"/>` : ""}
      <g class="rm-items">${itemSvg}</g>
      <g class="rm-edges">${edgesSvg}</g>
      <g class="rm-nodes">${nodesSvg}</g>
      <g class="rm-draw">${(data.draw || []).map(sk => strokeSvg(sk, st.selDraw === sk.id)).join("")}</g>
      <g class="rm-temp"></g>
    </g>`;
  st.wrap.classList.toggle("intro", !!intro);
  st.wrap.classList.toggle("anim", !!st.anim);
  st.vp = svg.querySelector(".rm-vp");
  st.wrap.classList.toggle("far", data.view.z < 0.38);
  renderMini();
  renderInspector();
  renderStats();
  $("#rm-zoom").textContent = `${Math.round(data.view.z * 100)}%`;
}

// Глубина узла от «центра» схемы (главный блок или самый связанный узел) — для волны появления.
function graphDepth(data) {
  const deg = new Map();
  const adj = new Map(data.nodes.map(n => [n.id, []]));
  for (const e of data.edges) {
    if (!adj.has(e.from) || !adj.has(e.to)) continue;
    adj.get(e.from).push(e.to); adj.get(e.to).push(e.from);
    deg.set(e.from, (deg.get(e.from) || 0) + 1); deg.set(e.to, (deg.get(e.to) || 0) + 1);
  }
  const hub = data.nodes.find(n => n.kind === "hub") || [...data.nodes].sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0))[0];
  const depth = new Map();
  if (!hub) return depth;
  const q = [hub.id]; depth.set(hub.id, 0);
  while (q.length) {
    const id = q.shift();
    for (const nb of adj.get(id) || []) if (!depth.has(nb)) { depth.set(nb, depth.get(id) + 1); q.push(nb); }
  }
  const max = Math.max(0, ...depth.values());
  for (const n of data.nodes) if (!depth.has(n.id)) depth.set(n.id, max + 1);
  return depth;
}

// Плавный перелёт камеры (вписать, кнопки масштаба, клик по мини-карте).
function animateView(to, ms = 520) {
  const v = st.map.data.view, from = { ...v };
  cancelAnimationFrame(st.camRaf);
  const t0 = window.performance.now();
  const ease = t => 1 - Math.pow(1 - t, 4);
  const step = now => {
    const t = Math.min(1, (now - t0) / ms), k = ease(t);
    v.x = from.x + (to.x - from.x) * k; v.y = from.y + (to.y - from.y) * k; v.z = from.z + (to.z - from.z) * k;
    applyView();
    if (t < 1) st.camRaf = requestAnimationFrame(step);
  };
  st.camRaf = requestAnimationFrame(step);
}

// Ширина веток-подпунктов узла по самой длинной строке — чтобы «вписать» не обрезал подписи.
const itemsW = n => (n.items?.length ? 90 + Math.max(...n.items.map(t => String(t).length)) * 7.3 : 0);
function bounds() {
  const ns = st.map.data.nodes;
  if (!ns.length) return null;
  return {
    x0: Math.min(...ns.map(n => n.x - (n.itemsSide === "left" ? itemsW(n) : 0))),
    y0: Math.min(...ns.map(n => n.y)),
    x1: Math.max(...ns.map(n => n.x + n.w + (n.itemsSide !== "left" ? itemsW(n) : 0))),
    y1: Math.max(...ns.map(n => n.y + n.h)),
  };
}
// Мини-карта в углу: вся схема крупными мазками и рамка видимой области; клик/тяни — перелёт туда.
function renderMini() {
  const box = st.wrap.querySelector(".rm-mini");
  if (!box) return;
  const b = bounds();
  box.hidden = !b || st.map.data.nodes.length < 4;
  if (box.hidden) return;
  const W = 150, H = 96, pad = 60;
  const bw = b.x1 - b.x0 + pad * 2, bh = b.y1 - b.y0 + pad * 2;
  const k = Math.min(W / bw, H / bh);
  st.mini = { k, ox: b.x0 - pad - (W / k - bw) / 2, oy: b.y0 - pad - (H / k - bh) / 2 };
  const m = st.mini;
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${st.map.data.nodes.map(n => `<rect x="${((n.x - m.ox) * k).toFixed(1)}" y="${((n.y - m.oy) * k).toFixed(1)}" width="${Math.max(2, n.w * k).toFixed(1)}" height="${Math.max(2, n.h * k).toFixed(1)}" rx="1.5" fill="${accent(n)}" opacity="${n.kind === "frame" ? 0.15 : 0.75}"/>`).join("")}<rect class="rm-mini-vp" rx="3"/></svg>`;
  miniViewport();
}
function miniViewport() {
  const r = st.wrap.querySelector(".rm-mini-vp");
  if (!r || !st.mini) return;
  const v = st.map.data.view, s = st.svg.getBoundingClientRect(), m = st.mini;
  r.setAttribute("x", ((-v.x / v.z - m.ox) * m.k).toFixed(1)); r.setAttribute("y", ((-v.y / v.z - m.oy) * m.k).toFixed(1));
  r.setAttribute("width", (s.width / v.z * m.k).toFixed(1)); r.setAttribute("height", (s.height / v.z * m.k).toFixed(1));
}
function miniJump(ev, smooth) {
  const box = st.wrap.querySelector(".rm-mini svg");
  if (!box || !st.mini) return;
  const r = box.getBoundingClientRect(), s = st.svg.getBoundingClientRect(), v = st.map.data.view, m = st.mini;
  const wx = (ev.clientX - r.left) / m.k + m.ox, wy = (ev.clientY - r.top) / m.k + m.oy;
  const to = { z: v.z, x: s.width / 2 - wx * v.z, y: s.height / 2 - wy * v.z };
  if (smooth) animateView(to, 380); else { Object.assign(v, to); applyView(); }
}

// Наведение на узел: он, его связи и соседи — ярко, остальное приглушается.
function focusOn(id) {
  const svg = st.svg;
  svg.querySelectorAll(".hl").forEach(x => x.classList.remove("hl"));
  if (!id) { svg.classList.remove("focus"); return; }
  const near = new Set([id]);
  svg.querySelectorAll(".rm-edge").forEach(g => {
    if (g.dataset.from === id || g.dataset.to === id) { g.classList.add("hl"); near.add(g.dataset.from); near.add(g.dataset.to); }
  });
  near.forEach(n => {
    svg.querySelector(`.rm-node[data-id="${window.CSS.escape(n)}"]`)?.classList.add("hl");
    svg.querySelectorAll(`.rm-item[data-of="${window.CSS.escape(n)}"]`).forEach(x => x.classList.add("hl"));
  });
  svg.classList.add("focus");
}

function applyView() {
  const v = st.map.data.view;
  st.vp?.setAttribute("transform", `translate(${v.x},${v.y}) scale(${v.z})`);
  $("#rm-zoom").textContent = `${Math.round(v.z * 100)}%`;
  st.wrap.classList.toggle("far", v.z < 0.38);
  miniViewport();
}

function autoStats() {
  const d = st.map.data, ns = d.nodes;
  const chip = (cls, t) => `<span class="rm-chip ${cls}">${t}</span>`;
  if (d.auto === "infra") {
    const up = ns.filter(n => n.status === "up").length, down = ns.filter(n => n.status === "down").length;
    const srv = ns.find(n => n.id === "srv");
    return `${chip(down ? "risk" : "done", down ? `● ${down} не работает` : "● все службы работают")}${chip("plan", `${up + down} служб`)}${srv ? `<span class="rm-hint">${esc(srv.sub || "")}</span>` : ""}`;
  }
  if (d.auto === "roles") {
    const roles = ns.filter(n => n.kind === "box");
    const none = roles.filter(n => (n.items || []).some(t => t.startsWith("✕ Ничего"))).length;
    return `${chip("plan", `${roles.length} ролей`)}${none ? chip("risk", `${none} без прав`) : ""}<span class="rm-hint">обновляется при смене прав</span>`;
  }
  if (d.auto === "project") {
    const tabs = ns.filter(n => String(n.id).startsWith("t-"));
    const open = tabs.filter(n => n.mine).length;
    return `${chip("plan", `${tabs.length} разделов`)}${chip("done", `${open} открыто вам`)}${tabs.length - open ? chip("risk", `${tabs.length - open} закрыто`) : ""}`;
  }
  return "";
}
function renderStats() {
  if (st.map.data.auto) { $("#rm-stats").innerHTML = autoStats(); return; }
  const ns = st.map.data.nodes;
  const c = s => ns.filter(n => n.status === s).length;
  const total = ns.filter(n => n.status).length;
  const done = c("done");
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("#rm-stats").innerHTML = total ? `
    <span class="rm-prog"><i style="width:${pct}%"></i></span><b>${pct}%</b>
    <span class="rm-chip done">${done} готово</span><span class="rm-chip work">${c("work")} в работе</span><span class="rm-chip plan">${c("plan")} план</span>${c("risk") ? `<span class="rm-chip risk">${c("risk")} риск</span>` : ""}`
    : `<span class="rm-hint">Узлов: ${ns.length} · связей: ${st.map.data.edges.length}</span>`;
}

// ---------- инспектор ----------
let inspectorFrozen = false;
function renderInspector() {
  if (inspectorFrozen) return;
  const box = $("#rm-insp");
  const data = st.map.data;
  const n = st.sel.size === 1 ? data.nodes.find(x => st.sel.has(x.id)) : null;
  const e = st.selEdge ? data.edges.find(x => x.id === st.selEdge) : null;
  box.classList.toggle("open", !!(n || e || st.sel.size > 1));
  if (st.sel.size > 1) {
    box.innerHTML = `<h4>Выбрано: ${st.sel.size}</h4>
      <div class="rm-f"><label>Цвет</label>${swatches("color")}</div>
      <div class="rm-f"><label>Выровнять</label><div class="rm-seg">
        <button data-align="left">⇤ лево</button><button data-align="cx">↔ центр</button><button data-align="top">⇡ верх</button><button data-align="cy">↕ середина</button></div></div>
      <div class="rm-f"><label>Распределить</label><div class="rm-seg"><button data-align="dh">по горизонтали</button><button data-align="dv">по вертикали</button></div></div>
      <div class="rm-row"><button class="btn ghost" data-act="dup">Дублировать</button><button class="btn danger" data-act="del">Удалить</button></div>`;
    return;
  }
  if (n) {
    box.innerHTML = `<h4>${esc(KINDS[n.kind].label)}</h4>
      <div class="rm-f"><label>Текст</label><textarea data-k="text" rows="2">${esc(n.text)}</textarea></div>
      <div class="rm-f"><label>Надпись над текстом</label><input data-k="sub" value="${esc(n.sub ?? (n.kind === "frame" || n.kind === "circle" || n.kind === "text" ? "" : KINDS[n.kind].label))}" placeholder="пусто — без надписи"></div>
      <div class="rm-f"><label>Форма</label><select data-k="kind">${Object.entries(KINDS).map(([k, v]) => `<option value="${k}"${k === n.kind ? " selected" : ""}>${v.label}</option>`).join("")}</select></div>
      <div class="rm-f"><label>Цвет</label>${swatches("color", n.color)}</div>
      <div class="rm-f two"><div><label>Номер</label><input data-k="num" type="number" min="0" max="99" value="${n.num || ""}"></div>
        <div><label>Шрифт</label><input data-k="fs" type="number" min="10" max="60" placeholder="авто" value="${n.fs || ""}"></div></div>
      <div class="rm-f"><label>Статус этапа</label><div class="rm-seg st">${Object.entries(STATUS).map(([k, v]) => `<button data-set="status" data-v="${k}" class="${(n.status || "") === k ? "on" : ""} ${k}">${v}</button>`).join("")}</div></div>
      <div class="rm-f"><label>Срок</label><input data-k="due" type="date" value="${esc(n.due || "")}"></div>
      <div class="rm-f"><label>Иконка</label><div class="rm-icons">${ICONS.map(i => `<button data-set="icon" data-v="${i}" class="${iconKey(n.icon || "") === i ? "on" : ""}" title="${i || "без иконки"}">${i ? `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[i]}</svg>` : "—"}</button>`).join("")}</div></div>
      <div class="rm-f"><label>Ветки (по строке)</label><textarea data-k="items" rows="3" placeholder="Главная&#10;Контакты">${esc((n.items || []).join("\n"))}</textarea>
        <div class="rm-seg sm"><button data-set="itemsSide" data-v="left" class="${n.itemsSide === "left" ? "on" : ""}">← слева</button><button data-set="itemsSide" data-v="right" class="${n.itemsSide !== "left" ? "on" : ""}">справа →</button></div></div>
      <div class="rm-f two"><div><label>Ширина</label><input data-k="w" type="number" min="40" value="${n.w}"></div><div><label>Высота</label><input data-k="h" type="number" min="24" value="${n.h}"></div></div>
      <div class="rm-row"><button class="btn ghost" data-act="front">Наверх</button><button class="btn ghost" data-act="dup">Дублировать</button><button class="btn danger" data-act="del">Удалить</button></div>`;
    return;
  }
  if (e) {
    box.innerHTML = `<h4>Связь</h4>
      <div class="rm-f"><label>Подпись</label><input data-ek="label" value="${esc(e.label || "")}" placeholder="например, «Заявки из рекламы»"></div>
      <div class="rm-f"><label>Линия</label><div class="rm-seg">${[["dotted", "· · ·"], ["dashed", "– – –"], ["solid", "——"]].map(([k, v]) => `<button data-eset="style" data-v="${k}" class="${e.style === k ? "on" : ""}">${v}</button>`).join("")}</div></div>
      <div class="rm-f"><label>Форма</label><div class="rm-seg">${[["straight", "Прямая"], ["curve", "Плавная"], ["elbow", "Ломаная"]].map(([k, v]) => `<button data-eset="curve" data-v="${k}" class="${e.curve === k ? "on" : ""}">${v}</button>`).join("")}</div></div>
      <div class="rm-f"><label>Стрелки</label><div class="rm-seg">${[["end", "→"], ["both", "↔"], ["none", "—"]].map(([k, v]) => `<button data-eset="arrows" data-v="${k}" class="${e.arrows === k ? "on" : ""}">${v}</button>`).join("")}</div></div>
      <div class="rm-f"><label>Цвет</label>${swatches("ecolor", e.color)}</div>
      <div class="rm-f two"><div><label>Толщина</label><input data-ek="w" type="number" min="1" max="10" step=".5" value="${e.w || 1.6}"></div>
        <div><label>Поток</label><label class="rm-sw"><input type="checkbox" data-ek="flow"${e.flow ? " checked" : ""}><span>бегущие точки</span></label></div></div>
      <div class="rm-row"><button class="btn ghost" data-act="flip">⇄ Развернуть</button><button class="btn danger" data-act="del">Удалить</button></div>`;
    return;
  }
  box.innerHTML = "";
}
function swatches(key, cur) {
  return `<div class="rm-sw-row">${COLORS.map(c => `<button class="rm-swatch${c === cur ? " on" : ""}" data-${key === "ecolor" ? "ecolor" : "color"}="${c}" style="--c:${c}" title="${c}"></button>`).join("")}<input type="color" data-${key === "ecolor" ? "ecolor" : "color"}-pick value="${/^#[0-9a-f]{6}$/i.test(cur || "") ? cur : "#888888"}"></div>`;
}

// ---------- история и сохранение ----------
function commit(rerender = true) {
  st.undo.push(st.last);
  if (st.undo.length > 120) st.undo.shift();
  st.redo = [];
  st.last = JSON.stringify(st.map.data);
  if (rerender) render();
  scheduleSave();
}
function undo() {
  if (!st.undo.length) return;
  st.redo.push(st.last);
  st.last = st.undo.pop();
  st.map.data = JSON.parse(st.last);
  st.sel.clear(); st.selEdge = null;
  render(); scheduleSave();
}
function redo() {
  if (!st.redo.length) return;
  st.undo.push(st.last);
  st.last = st.redo.pop();
  st.map.data = JSON.parse(st.last);
  render(); scheduleSave();
}
function scheduleSave() {
  clearTimeout(st.saveT);
  if (st.map.auto) { setSaveState("Автосхема — правки не сохраняются", "busy"); return; }
  if (st.ro) { setSaveState("Только просмотр — сделайте копию, чтобы править", "busy"); return; }
  setSaveState("Сохраняю…", "busy");
  st.saveT = setTimeout(save, 900);
}
async function save() {
  if (!st.map.id) return;
  try {
    await apiPost(`/roadmaps/${st.map.id}`, { title: st.map.title, data: st.map.data });
    setSaveState("Сохранено", "ok");
    const item = st.list.find(m => m.id === st.map.id);
    if (item) { item.title = st.map.title; item.nodes = st.map.data.nodes.length; item.updated_at = new Date().toISOString().slice(0, 19).replace("T", " "); }
  } catch (e) {
    setSaveState("Не сохранено", "err");
    toast(`Карта не сохранилась: ${e.message}`, "error");
  }
}
function setSaveState(t, k) { const el = $("#rm-save"); if (el) { el.textContent = t; el.className = `rm-save ${k}`; } }

// ---------- координаты ----------
function toWorld(ev) {
  const r = st.svg.getBoundingClientRect(), v = st.map.data.view;
  return { x: (ev.clientX - r.left - v.x) / v.z, y: (ev.clientY - r.top - v.y) / v.z };
}
function nodeAt(p) {
  const ns = zOrder(st.map.data.nodes);
  for (let i = ns.length - 1; i >= 0; i--) { const n = ns[i]; if (p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h) return n; }
  return null;
}
function fit(smooth) {
  // Рисунки тоже входят в рамку «вписать»: каждый штрих — как маленький узел по своим границам.
  const sk = (st.map.data.draw || []).filter(x => x.pts.length).map(x => {
    const xs = x.pts.map(q => q[0]), ys = x.pts.map(q => q[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  });
  const ns = st.map.data.nodes.concat(sk);
  const r = st.svg.getBoundingClientRect();
  if (!ns.length) { st.map.data.view = { x: r.width / 2 - 200, y: r.height / 2 - 100, z: 1 }; applyView(); return; }
  const x0 = Math.min(...ns.map(n => n.x - (n.itemsSide === "left" ? itemsW(n) : 0))) - 40;
  const y0 = Math.min(...ns.map(n => n.y)) - 60;
  const x1 = Math.max(...ns.map(n => n.x + n.w + (n.itemsSide !== "left" ? itemsW(n) : 0))) + 40;
  const y1 = Math.max(...ns.map(n => n.y + n.h)) + 80;
  const z = Math.max(0.2, Math.min(1.4, Math.min(r.width / (x1 - x0), r.height / (y1 - y0))));
  const to = { z, x: (r.width - (x1 - x0) * z) / 2 - x0 * z, y: (r.height - (y1 - y0) * z) / 2 - y0 * z };
  if (smooth) { animateView(to); return; }
  st.map.data.view = to;
  applyView();
}
function zoomAt(f, cx, cy) {
  const v = st.map.data.view;
  const z = Math.max(0.15, Math.min(3, v.z * f));
  v.x = cx - ((cx - v.x) * z) / v.z; v.y = cy - ((cy - v.y) * z) / v.z; v.z = z;
  applyView();
}

// ---------- добавление ----------
function addNode(kind, at) {
  const r = st.svg.getBoundingClientRect(), v = st.map.data.view;
  const k = KINDS[kind];
  const p = at || { x: (r.width / 2 - v.x) / v.z - k.w / 2, y: (r.height / 2 - v.y) / v.z - k.h / 2 };
  const n = node(kind, snap(p.x), snap(p.y), k.label);
  // Не кладём новый узел ровно поверх прошлого.
  while (st.map.data.nodes.some(o => Math.abs(o.x - n.x) < 10 && Math.abs(o.y - n.y) < 10)) { n.x += 40; n.y += 40; }
  st.map.data.nodes.push(n);
  st.sel = new Set([n.id]); st.selEdge = null;
  commit();
  pop(n.id);
  return n;
}
function pop(id) {
  const g = st.svg.querySelector(`.rm-node[data-id="${id}"] .rm-in`);
  g?.animate([{ transform: "scale(.6)", opacity: 0 }, { transform: "scale(1.06)", opacity: 1, offset: 0.7 }, { transform: "scale(1)" }], { duration: 380, easing: "cubic-bezier(.2,.9,.3,1.2)" });
}
function duplicate() {
  const data = st.map.data;
  const ids = [...st.sel];
  if (!ids.length) return;
  const map = new Map();
  for (const id of ids) {
    const n = data.nodes.find(x => x.id === id);
    const c = { ...clone(n), id: uid(), x: n.x + 40, y: n.y + 40 };
    map.set(id, c.id); data.nodes.push(c);
  }
  for (const e of data.edges.filter(e => map.has(e.from) && map.has(e.to))) data.edges.push({ ...clone(e), id: uid(), from: map.get(e.from), to: map.get(e.to) });
  st.sel = new Set(map.values());
  commit();
}
function removeSelected() {
  const data = st.map.data;
  if (st.selDraw) { data.draw = (data.draw || []).filter(x => x.id !== st.selDraw); st.selDraw = null; commit(); return; }
  if (st.selEdge) data.edges = data.edges.filter(e => e.id !== st.selEdge);
  if (st.sel.size) {
    data.nodes = data.nodes.filter(n => !st.sel.has(n.id));
    data.edges = data.edges.filter(e => !st.sel.has(e.from) && !st.sel.has(e.to));
  }
  st.sel.clear(); st.selEdge = null;
  commit();
}

// ---------- правка текста прямо на холсте ----------
function editText(n) {
  const r = st.svg.getBoundingClientRect(), v = st.map.data.view;
  const ta = document.createElement("textarea");
  ta.className = "rm-inline";
  ta.value = n.text;
  Object.assign(ta.style, {
    left: `${r.left + v.x + n.x * v.z}px`, top: `${r.top + v.y + n.y * v.z}px`,
    width: `${Math.max(140, n.w * v.z)}px`, height: `${Math.max(40, n.h * v.z)}px`, fontSize: `${16 * Math.max(0.7, v.z)}px`,
  });
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  let done = false;
  const finish = ok => {
    if (done) return; done = true;
    if (ok && ta.value !== n.text) { n.text = ta.value; commit(); }
    ta.remove();
  };
  ta.addEventListener("blur", () => finish(true));
  ta.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
    else if (e.key === "Enter" && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); finish(true); }
    e.stopPropagation();
  });
}

// ---------- мышь ----------
function bindCanvas() {
  const svg = st.svg;
  svg.addEventListener("wheel", e => {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    if (e.ctrlKey || !e.shiftKey && Math.abs(e.deltaY) > 0 && !e.deltaX) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    else { st.map.data.view.x -= e.deltaX || e.deltaY; applyView(); }
  }, { passive: false });

  svg.addEventListener("pointerdown", e => {
    if (e.button === 2) return;
    if (svg.classList.contains("focus")) focusOn(null);
    const p = toWorld(e);
    const t = e.target;
    const panNow = () => { st.drag = { mode: "pan", cx: e.clientX, cy: e.clientY, vx: st.map.data.view.x, vy: st.map.data.view.y }; svg.classList.add("panning"); };
    if (e.button === 1 || st.mode === "hand" || st.space || (st.ro && !t.closest?.(".rm-node,.rm-edge"))) { svg.setPointerCapture(e.pointerId); panNow(); return; }
    if (st.ro) { svg.setPointerCapture(e.pointerId); const ne = t.closest?.(".rm-node"); st.sel = ne ? new Set([ne.dataset.id]) : new Set(); render(); return; }
    if (!st.map.id) return;
    if (st.mode === "pen" || st.mode === "marker" || st.mode === "arrow") {
      svg.setPointerCapture(e.pointerId);
      const w = st.mode === "marker" ? st.pen.w * 5 : st.pen.w;
      st.drag = { mode: "draw", sk: { id: uid(), t: st.mode, c: st.pen.c, w, pts: [[Math.round(p.x), Math.round(p.y)]] } };
      return;
    }
    if (st.mode === "eraser") { svg.setPointerCapture(e.pointerId); st.drag = { mode: "erase", hit: false, last: p }; eraseAt(p); return; }
    if (st.mode === "frame") { svg.setPointerCapture(e.pointerId); st.drag = { mode: "frame", sx: p.x, sy: p.y }; return; }
    if (st.mode === "text") {
      const nn = addNode("text", { x: p.x - 10, y: p.y - 20 });
      nn.text = ""; editText(nn); setMode("select"); return;
    }
    const strokeEl = t.closest?.(".rm-stroke");
    if (strokeEl) {
      svg.setPointerCapture(e.pointerId);
      st.sel.clear(); st.selEdge = null; st.selDraw = strokeEl.dataset.draw;
      const sk = (st.map.data.draw || []).find(x => x.id === st.selDraw);
      st.drag = { mode: "moveDraw", sk, sx: p.x, sy: p.y, pts: sk.pts.map(q => [...q]), moved: false };
      render(); return;
    }
    st.selDraw = null;
    const port = t.closest?.(".rm-port");
    const nodeEl = t.closest?.(".rm-node");
    const edgeEl = t.closest?.(".rm-edge");
    svg.setPointerCapture(e.pointerId);
    const n = nodeEl ? st.map.data.nodes.find(x => x.id === nodeEl.dataset.id) : null;

    if (port && n) { // тянем новую связь
      st.drag = { mode: "link", from: n };
      return;
    }
    if (t.dataset?.resize && n) { st.drag = { mode: "resize", n, sx: p.x, sy: p.y, w: n.w, h: n.h }; return; }
    if (n) {
      if (e.altKey) { st.drag = { mode: "link", from: n }; return; }
      if (e.shiftKey) { st.sel.has(n.id) ? st.sel.delete(n.id) : st.sel.add(n.id); }
      else if (!st.sel.has(n.id)) st.sel = new Set([n.id]);
      st.selEdge = null;
      const start = new Map([...st.sel].map(id => { const o = st.map.data.nodes.find(x => x.id === id); return [id, { x: o.x, y: o.y }]; }));
      st.drag = { mode: "move", sx: p.x, sy: p.y, start, moved: false };
      render();
      return;
    }
    if (edgeEl) {
      st.sel.clear(); st.selEdge = edgeEl.dataset.edge; render(); return;
    }
    // пустое место: Shift — рамка выбора, иначе — двигаем холст
    if (e.shiftKey) { st.drag = { mode: "marquee", sx: p.x, sy: p.y }; return; }
    st.sel.clear(); st.selEdge = null;
    st.drag = { mode: "pan", cx: e.clientX, cy: e.clientY, vx: st.map.data.view.x, vy: st.map.data.view.y };
    render();
    svg.classList.add("panning");
  });

  svg.addEventListener("pointermove", e => {
    const d = st.drag;
    if (!d) return;
    const p = toWorld(e);
    const temp = svg.querySelector(".rm-temp");
    if (d.mode === "pan") {
      st.map.data.view.x = d.vx + e.clientX - d.cx; st.map.data.view.y = d.vy + e.clientY - d.cy; applyView();
    } else if (d.mode === "draw") {
      const pts = d.sk.pts, last = pts[pts.length - 1];
      const q = [Math.round(p.x), Math.round(p.y)];
      if (d.sk.t === "arrow") { pts[1] = q; pts.length = 2; }
      else if (Math.hypot(q[0] - last[0], q[1] - last[1]) * st.map.data.view.z >= 2) pts.push(q);
      if (d.sk.t === "arrow" && !temp.querySelector("defs")) temp.innerHTML = "";
      temp.innerHTML = strokeSvg(d.sk, false);
    } else if (d.mode === "erase") {
      // Курсор мог проскочить штрих между событиями — проверяем и промежуточные точки.
      const from = d.last || p, steps = Math.max(1, Math.ceil(Math.hypot(p.x - from.x, p.y - from.y) * st.map.data.view.z / 5));
      for (let i = 1; i <= steps; i++) eraseAt({ x: from.x + (p.x - from.x) * i / steps, y: from.y + (p.y - from.y) * i / steps });
      d.last = p;
    } else if (d.mode === "frame") {
      const x = Math.min(d.sx, p.x), y = Math.min(d.sy, p.y), w = Math.abs(p.x - d.sx), h = Math.abs(p.y - d.sy);
      temp.innerHTML = `<rect class="rm-marq" x="${x}" y="${y}" width="${w}" height="${h}" rx="18"/>`;
      d.box = { x, y, w, h };
    } else if (d.mode === "moveDraw") {
      const dx = p.x - d.sx, dy = p.y - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      d.sk.pts = d.pts.map(([x, y]) => [Math.round(x + dx), Math.round(y + dy)]);
      render();
    } else if (d.mode === "move") {
      const dx = p.x - d.sx, dy = p.y - d.sy;
      if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
      for (const [id, s] of d.start) { const o = st.map.data.nodes.find(x => x.id === id); o.x = snap(s.x + dx); o.y = snap(s.y + dy); }
      render();
    } else if (d.mode === "resize") {
      d.n.w = Math.max(40, snap(d.w + p.x - d.sx)); d.n.h = Math.max(24, snap(d.h + p.y - d.sy));
      if (d.n.kind === "circle" && !e.shiftKey) d.n.h = d.n.w;
      render();
    } else if (d.mode === "link") {
      const a = center(d.from);
      const over = nodeAt(p);
      temp.innerHTML = `<path d="M${a.x},${a.y} L${p.x},${p.y}" class="rm-ghost"/>${over && over !== d.from ? `<rect class="rm-target" x="${over.x - 6}" y="${over.y - 6}" width="${over.w + 12}" height="${over.h + 12}" rx="10"/>` : ""}`;
    } else if (d.mode === "marquee") {
      const x = Math.min(d.sx, p.x), y = Math.min(d.sy, p.y), w = Math.abs(p.x - d.sx), h = Math.abs(p.y - d.sy);
      temp.innerHTML = `<rect class="rm-marq" x="${x}" y="${y}" width="${w}" height="${h}"/>`;
      d.box = { x, y, w, h };
    }
  });

  svg.addEventListener("pointerup", e => {
    const d = st.drag; st.drag = null;
    svg.classList.remove("panning");
    if (!d) return;
    const temp = svg.querySelector(".rm-temp");
    if (temp) temp.innerHTML = "";
    if (d.mode === "draw") {
      if (d.sk.pts.length > 1 || d.sk.t !== "arrow") {
        if (d.sk.pts.length === 1) d.sk.pts.push([d.sk.pts[0][0] + 0.5, d.sk.pts[0][1] + 0.5]);
        (st.map.data.draw ||= []).push(d.sk);
        commit();
      }
      return;
    }
    if (d.mode === "erase") { if (d.hit) commit(); return; }
    if (d.mode === "frame") {
      const b = d.box;
      if (b && b.w > 30 && b.h > 30) {
        const fr = node("frame", snap(b.x), snap(b.y), "Группа", { w: snap(b.w), h: snap(b.h), color: st.pen.c });
        st.map.data.nodes.push(fr); st.sel = new Set([fr.id]); commit(); editText(fr);
      }
      setMode("select");
      return;
    }
    if (d.mode === "moveDraw") { if (d.moved) commit(false); return; }
    if (d.mode === "move" && d.moved) commit(false);
    else if (d.mode === "resize") commit(false);
    else if (d.mode === "link") {
      const to = nodeAt(toWorld(e));
      if (to && to !== d.from) {
        const exists = st.map.data.edges.some(x => (x.from === d.from.id && x.to === to.id));
        if (!exists) {
          const ed = { ...st.edgeDefaults, id: uid(), from: d.from.id, to: to.id, label: "" };
          st.map.data.edges.push(ed);
          st.sel.clear(); st.selEdge = ed.id;
          commit();
          drawIn(ed.id);
        }
      }
    } else if (d.mode === "marquee" && d.box) {
      const b = d.box;
      st.sel = new Set(st.map.data.nodes.filter(n => n.x >= b.x && n.y >= b.y && n.x + n.w <= b.x + b.w && n.y + n.h <= b.y + b.h).map(n => n.id));
      render();
    }
  });

  svg.addEventListener("dblclick", e => {
    const p = toWorld(e);
    const n = nodeAt(p);
    if (n) { editText(n); return; }
    const edgeEl = e.target.closest?.(".rm-edge");
    if (edgeEl) { st.selEdge = edgeEl.dataset.edge; render(); $("#rm-insp [data-ek=label]")?.focus(); return; }
    const k = st.tool || "box";
    const nn = addNode(k, { x: p.x - KINDS[k].w / 2, y: p.y - KINDS[k].h / 2 });
    editText(nn);
  });

  svg.addEventListener("contextmenu", e => {
    e.preventDefault();
    const p = toWorld(e);
    const n = nodeAt(p);
    if (n) {
      if (!st.sel.has(n.id)) { st.sel = new Set([n.id]); st.selEdge = null; render(); }
      showContextMenu(e.clientX, e.clientY, [
        { label: "Изменить текст", action: () => editText(n) },
        { label: "Дублировать", action: duplicate },
        { label: "Наверх", action: () => toFront() },
        { label: "Связать с…  (тяните за точку на краю)", action: () => {} },
        { label: "Удалить", danger: true, action: removeSelected },
      ]);
    } else {
      showContextMenu(e.clientX, e.clientY, Object.entries(KINDS).map(([k, v]) => ({ label: `+ ${v.label}`, action: () => addNode(k, { x: p.x - v.w / 2, y: p.y - v.h / 2 }) })));
    }
  });
}
function eraseAt(p) {
  const r = 10 / st.map.data.view.z;
  const list = st.map.data.draw || [];
  const keep = list.filter(sk => !sk.pts.some(([x, y], i) => {
    if (Math.hypot(x - p.x, y - p.y) <= r + sk.w / 2) return true;
    const q = sk.pts[i + 1];
    if (!q) return false;
    const vx = q[0] - x, vy = q[1] - y, len = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - x) * vx + (p.y - y) * vy) / len));
    return Math.hypot(x + t * vx - p.x, y + t * vy - p.y) <= r + sk.w / 2;
  }));
  if (keep.length !== list.length) { st.map.data.draw = keep; if (st.drag) st.drag.hit = true; render(); }
}

const MODES = {
  select: ["Выбор", "V", '<path d="M5 3l14 8-6 2-2 6z"/>'],
  hand: ["Рука — двигать холст", "H", '<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-2.7L3 14a1.5 1.5 0 0 1 2.5-1.7L8 15"/>'],
  pen: ["Карандаш", "P", '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>'],
  marker: ["Маркер-выделитель", "M", '<path d="M9 15l-4 4h5l2-2M9 15l7-7 3 3-7 7z"/><path d="M4 21h16" opacity=".5"/>'],
  arrow: ["Стрелка от руки", "L", '<path d="M5 19 19 5M10 5h9v9"/>'],
  frame: ["Рамка-группа — обведите область", "R", '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5" stroke-dasharray="3 2.5"/>'],
  text: ["Текст — клик по холсту", "T", '<path d="M5 6h14M12 6v13M9 19h6"/>'],
  eraser: ["Ластик для рисунков", "E", '<path d="m7 21-4-4L14 6l6 6-9 9z"/><path d="M11 21h10M9 11l6 6"/>'],
};
const PEN_COLORS = ["#f8fafc", "#f43f5e", "#f59e0b", "#fcd34d", "#22c55e", "#38bdf8", "#a78bfa", "#ec4899"];
function setMode(m) {
  st.mode = m;
  st.wrap.querySelectorAll("[data-mode]").forEach(b => b.classList.toggle("on", b.dataset.mode === m));
  st.wrap.dataset.mode = m;
  st.wrap.querySelector(".rm-pen")?.classList.toggle("open", ["pen", "marker", "arrow", "frame"].includes(m));
}

// Картинка: Ctrl+V или кнопка. Ужимаем до 1200 px (webp), чтобы схема оставалась лёгкой.
async function addImage(file, at) {
  if (!file || !/^image\//.test(file.type)) return;
  if (st.ro || !st.map.id) { toast("Картинку можно вставить только в свою карту."); return; }
  const bmp = await window.createImageBitmap(file);
  const k = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const src = c.toDataURL("image/webp", 0.82);
  if (src.length > 2_500_000) { toast("Картинка слишком большая даже после сжатия.", "error"); return; }
  const w = Math.min(420, c.width), h = Math.round(w * c.height / c.width);
  const r = st.svg.getBoundingClientRect(), v = st.map.data.view;
  const p = at || { x: (r.width / 2 - v.x) / v.z - w / 2, y: (r.height / 2 - v.y) / v.z - h / 2 };
  const n = node("image", snap(p.x), snap(p.y), "Картинка", { w, h, src });
  st.map.data.nodes.push(n); st.sel = new Set([n.id]); commit(); pop(n.id);
}
function onPaste(e) {
  if (!st || !st.wrap.offsetParent) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return;
  const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith("image/"));
  if (f) { e.preventDefault(); addImage(f).catch(err => toast(`Не вставилось: ${err.message}`, "error")); }
}
async function copyMap() {
  const data = clone(st.map.data); delete data.auto;
  const title = `Копия — ${st.map.title}`.slice(0, 120);
  const r = await apiPost("/roadmaps", { title, data });
  st.list.unshift({ id: r.id, title, can_edit: true, nodes: data.nodes.length, updated_at: new Date().toISOString().slice(0, 19).replace("T", " ") });
  await openMap(r.id);
  toast("Копия создана — теперь её можно править.");
}

function drawIn(edgeId) {
  const path = st.svg.querySelector(`.rm-edge[data-edge="${edgeId}"] .rm-line`);
  if (!path) return;
  const len = path.getTotalLength();
  const dash = path.getAttribute("stroke-dasharray");
  path.style.strokeDasharray = `${len}`;
  path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 450, easing: "ease-out" }).onfinish = () => { path.style.strokeDasharray = dash || ""; };
}
function toFront() {
  const data = st.map.data;
  const keep = data.nodes.filter(n => !st.sel.has(n.id));
  data.nodes = keep.concat(data.nodes.filter(n => st.sel.has(n.id)));
  commit();
}
function align(kind) {
  const ns = st.map.data.nodes.filter(n => st.sel.has(n.id));
  if (ns.length < 2) return;
  if (kind === "left") { const x = Math.min(...ns.map(n => n.x)); ns.forEach(n => { n.x = x; }); }
  if (kind === "top") { const y = Math.min(...ns.map(n => n.y)); ns.forEach(n => { n.y = y; }); }
  if (kind === "cx") { const x = ns.reduce((a, n) => a + n.x + n.w / 2, 0) / ns.length; ns.forEach(n => { n.x = snap(x - n.w / 2); }); }
  if (kind === "cy") { const y = ns.reduce((a, n) => a + n.y + n.h / 2, 0) / ns.length; ns.forEach(n => { n.y = snap(y - n.h / 2); }); }
  if (kind === "dh" || kind === "dv") {
    const k = kind === "dh" ? "x" : "y", s = kind === "dh" ? "w" : "h";
    ns.sort((a, b) => a[k] - b[k]);
    const first = ns[0], last = ns[ns.length - 1];
    const total = ns.reduce((a, n) => a + n[s], 0);
    const gap = (last[k] + last[s] - first[k] - total) / (ns.length - 1);
    let pos = first[k];
    ns.forEach(n => { n[k] = Math.round(pos); pos += n[s] + gap; });
  }
  commit();
}

// ---------- инспектор: события ----------
function bindInspector() {
  const box = $("#rm-insp");
  const curNode = () => st.map.data.nodes.find(x => st.sel.has(x.id));
  const curEdge = () => st.map.data.edges.find(x => x.id === st.selEdge);
  box.addEventListener("input", e => {
    const t = e.target;
    const n = st.sel.size === 1 ? curNode() : null;
    if (t.dataset.k && n) {
      const k = t.dataset.k;
      if (k === "items") n.items = t.value.split("\n").map(s => s.trim()).filter(Boolean);
      else if (["num", "w", "h", "fs"].includes(k)) n[k] = t.value ? Number(t.value) : (k === "w" || k === "h" ? n[k] : undefined);
      else if (k === "kind") { n.kind = t.value; const kk = KINDS[t.value]; n.w = kk.w; n.h = kk.h; if (!n.color || n.color === "transparent") n.color = kk.color; }
      else n[k] = t.value;
      commitSoft(k === "kind");
    } else if (t.dataset.ek) {
      const ed = curEdge(); if (!ed) return;
      ed[t.dataset.ek] = t.type === "checkbox" ? t.checked : t.type === "number" ? Number(t.value) : t.value;
      commitSoft(t.type === "checkbox");
    } else if (t.matches("[data-color-pick]")) { for (const n2 of st.map.data.nodes) if (st.sel.has(n2.id)) n2.color = t.value; commitSoft(false); }
    else if (t.matches("[data-ecolor-pick]")) { const ed = curEdge(); if (ed) { ed.color = t.value; commitSoft(false); } }
  });
  box.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    const n = st.sel.size === 1 ? curNode() : null;
    const ed = curEdge();
    if (b.dataset.color) { for (const x of st.map.data.nodes) if (st.sel.has(x.id)) x.color = b.dataset.color; commit(); }
    else if (b.dataset.ecolor && ed) { ed.color = b.dataset.ecolor; st.edgeDefaults.color = ed.color; commit(); }
    else if (b.dataset.set && n) { n[b.dataset.set] = b.dataset.v || undefined; commit(); }
    else if (b.dataset.eset && ed) { ed[b.dataset.eset] = b.dataset.v; st.edgeDefaults[b.dataset.eset] = b.dataset.v; commit(); drawIn(ed.id); }
    else if (b.dataset.align) align(b.dataset.align);
    else if (b.dataset.act === "del") removeSelected();
    else if (b.dataset.act === "dup") duplicate();
    else if (b.dataset.act === "front") toFront();
    else if (b.dataset.act === "flip" && ed) { [ed.from, ed.to] = [ed.to, ed.from]; commit(); drawIn(ed.id); }
  });
}
// Ввод в полях инспектора: перерисовываем холст, но не сам инспектор (иначе слетит фокус).
function commitSoft(full) {
  if (full) { commit(); return; }
  inspectorFrozen = true;
  try { commit(); } finally { inspectorFrozen = false; }
}

// ---------- клавиатура ----------
function onKey(e) {
  if (!st || !document.body.contains(st.wrap) || !st.wrap.offsetParent) return;
  if (st.ro && (e.ctrlKey || e.metaKey) && /^[zydv]$/i.test(e.key)) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) return;
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (ctrl && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
  else if (ctrl && k === "d") { e.preventDefault(); duplicate(); }
  else if (ctrl && k === "a") { e.preventDefault(); st.sel = new Set(st.map.data.nodes.map(n => n.id)); render(); }
  else if (ctrl && k === "c") { st.clip = clone({ nodes: st.map.data.nodes.filter(n => st.sel.has(n.id)), edges: st.map.data.edges.filter(x => st.sel.has(x.from) && st.sel.has(x.to)) }); }
  else if (ctrl && k === "v" && st.clip?.nodes.length) {
    e.preventDefault();
    const map = new Map();
    for (const n of st.clip.nodes) { const c = { ...clone(n), id: uid(), x: n.x + 60, y: n.y + 60 }; map.set(n.id, c.id); st.map.data.nodes.push(c); }
    for (const x of st.clip.edges) st.map.data.edges.push({ ...clone(x), id: uid(), from: map.get(x.from), to: map.get(x.to) });
    st.sel = new Set(map.values()); st.clip.nodes.forEach(n => { n.x += 60; n.y += 60; });
    commit();
  }
  else if (k === "delete" || k === "backspace") { if (!st.ro && (st.sel.size || st.selEdge || st.selDraw)) { e.preventDefault(); removeSelected(); } }
  else if (k === "escape") { st.sel.clear(); st.selEdge = null; render(); }
  else if (k === "enter" && st.sel.size === 1) { e.preventDefault(); editText(st.map.data.nodes.find(n => st.sel.has(n.id))); }
  else if (k.startsWith("arrow") && st.sel.size) {
    e.preventDefault();
    const step = e.shiftKey ? GRID : 2;
    const dx = k === "arrowleft" ? -step : k === "arrowright" ? step : 0, dy = k === "arrowup" ? -step : k === "arrowdown" ? step : 0;
    st.map.data.nodes.forEach(n => { if (st.sel.has(n.id)) { n.x += dx; n.y += dy; } });
    commit();
  }
  else if (k === "f") fit(true);
  else if (!ctrl && !e.altKey && !st.ro && Object.values(MODES).some(m => m[1].toLowerCase() === k)) setMode(Object.keys(MODES).find(x => MODES[x][1].toLowerCase() === k));
  else if (k === " " && !st.space) { st.space = true; st.wrap.classList.add("space"); e.preventDefault(); }
  else if (k === "g") { st.grid = !st.grid; render(); }
}

// ---------- экспорт ----------
function exportSvgString() {
  const ns = st.map.data.nodes;
  const x0 = Math.min(...ns.map(n => n.x - (n.items?.length && n.itemsSide === "left" ? 220 : 40))) - 30;
  const y0 = Math.min(...ns.map(n => n.y)) - 50;
  const x1 = Math.max(...ns.map(n => n.x + n.w + (n.items?.length && n.itemsSide !== "left" ? 240 : 0))) + 40;
  const y1 = Math.max(...ns.map(n => n.y + n.h)) + 60;
  const clone2 = st.svg.cloneNode(true);
  clone2.querySelectorAll(".rm-port,.rm-selbox,.rm-resize,.rm-comet,.rm-drawin,.rm-hit,.rm-temp").forEach(x => x.remove());
  clone2.querySelector(".rm-vp").setAttribute("transform", `translate(${-x0},${-y0})`);
  clone2.querySelector('rect[fill="url(#rm-grid)"]')?.remove();
  const cs = getComputedStyle(st.wrap);
  const vars = ["--ink", "--ink-soft", "--ink-dim", "--rm-bg", "--rm-branch", "--rm-dot"].map(v => `${v}:${cs.getPropertyValue(v)}`).join(";");
  const bg = cs.getPropertyValue("--rm-bg").trim() || "#111";
  const w = x1 - x0, h = y1 - y0;
  clone2.setAttribute("xmlns", NS);
  clone2.setAttribute("width", w); clone2.setAttribute("height", h); clone2.setAttribute("viewBox", `0 0 ${w} ${h}`);
  clone2.setAttribute("style", `${vars};font-family:${cs.fontFamily};background:${bg}`);
  const style = document.createElementNS(NS, "style");
  style.textContent = ".rm-elabel{font-size:13px;fill:var(--ink-soft);paint-order:stroke;stroke:var(--rm-bg);stroke-width:6px;font-style:italic}";
  clone2.insertBefore(style, clone2.firstChild);
  const bgr = document.createElementNS(NS, "rect");
  bgr.setAttribute("width", "100%"); bgr.setAttribute("height", "100%"); bgr.setAttribute("fill", bg);
  clone2.insertBefore(bgr, clone2.querySelector(".rm-vp"));
  return { s: new window.XMLSerializer().serializeToString(clone2), w, h };
}
async function exportAs(kind) {
  if (!st.map.data.nodes.length) { toast("Карта пустая."); return; }
  const { s, w, h } = exportSvgString();
  const name = (st.map.title || "roadmap").replace(/[\\/:*?"<>|]+/g, "_");
  let blob;
  if (kind === "svg") blob = new Blob([s], { type: "image/svg+xml" });
  else {
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
    await img.decode();
    const scale = 2, c = document.createElement("canvas");
    c.width = w * scale; c.height = h * scale;
    const g = c.getContext("2d"); g.scale(scale, scale); g.drawImage(img, 0, 0);
    blob = await new Promise(r => c.toBlob(r, "image/png"));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${name}.${kind}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`Сохранено: ${name}.${kind}`);
}

// ---------- показ (проигрывание появления) ----------
function play() {
  st.intro = true; render();
  clearTimeout(st.introT);
  const levels = Math.max(0, ...graphDepth(st.map.data).values());
  st.introT = setTimeout(() => { st.intro = false; st.wrap.classList.remove("intro"); }, 1800 + levels * 230 + 12 * 45);
}

// ---------- список карт ----------
function renderList() {
  const box = $("#rm-list");
  box.innerHTML = st.list.length ? st.list.map(m => `
    <button class="rm-li${st.map && st.map.id === m.id ? " on" : ""}" data-open="${m.id}">
      <b>${m.auto ? '<i class="rm-auto">АВТО</i>' : ""}${esc(m.title)}</b><small>${m.auto === "project" ? "из меню приложения" : m.auto ? "обновляется сама" : `${m.author ? `${esc(m.author)} · ` : ""}${esc(relTime(m.updated_at))}${m.can_edit ? "" : " · просмотр"}`}</small>
    </button>`).join("") : `<div class="rm-empty-l">Карт пока нет</div>`;
}
// ---------- автосхема «Проект «Кадр»: все разделы» ----------
// Строится прямо из меню приложения (кнопки .tab-btn в index.html): новая вкладка в обновлении — новый узел на схеме,
// без правки этой схемы руками. Доступ к разделу — из тех же правил, по которым вкладка открывается (tabs.js).
const PROJECT_ID = "auto-project";
const PERM_LABELS = {
  "reports.feed": "Лента", "reports.board": "Доска", "reports.overview": "Обзор", "reports.list": "Список",
  "reports.calendar": "Календарь", "reports.analytics": "Аналитика", "parser.use": "Парсер видео",
  "a365.view": "Anime 365: смотреть", "a365.upload": "Anime 365: заливать",
};
const GROUPS = [
  { name: "Работа над сериями", sub: "Очередь · отчёты · сроки", color: "#f97316", icon: "target" },
  { name: "Контент и релизы", sub: "Тайтлы · раздачи · заливка", color: "#22c55e", icon: "film" },
  { name: "Команда и общение", sub: "Чат · лента · люди", color: "#ec4899", icon: "users" },
  { name: "Аналитика и сервисы", sub: "Цифры · инструменты · профиль", color: "#38bdf8", icon: "chart" },
];
function buildProjectMap() {
  const tabs = [...document.querySelectorAll(".tab-btn[data-tab]")].filter((b, i, a) => a.findIndex(x => x.dataset.tab === b.dataset.tab) === i).map(b => ({
    key: b.dataset.tab, grp: Number(b.dataset.grp || 0),
    label: (b.querySelector(".tab-lbl")?.textContent || b.title || b.dataset.tab).trim(),
    desc: (b.querySelector("small")?.textContent || b.title || "").trim(),
    color: (b.style.getPropertyValue("--c") || "").trim(),
    // Иконка раздела — та же, что в меню (только линии и круги, без скриптов и атрибутов событий).
    icon: (() => {
      const svg = b.querySelector(".tab-ic svg");
      if (!svg) return "";
      const parts = [...svg.querySelectorAll("path,circle,rect,line,polyline,ellipse")].map(el => {
        const keep = ["d", "cx", "cy", "r", "x", "y", "width", "height", "rx", "x1", "y1", "x2", "y2", "points", "rx", "ry"];
        return `<${el.tagName.toLowerCase()} ${keep.filter(a => el.hasAttribute(a)).map(a => `${a}="${esc(el.getAttribute(a))}"`).join(" ")}/>`;
      });
      return parts.length ? `svg:${parts.join("")}` : "";
    })(),
  }));
  const access = k => {
    if (MEMBER_TABS.has(k)) return "Доступ: все участники";
    if (k === "nyaa") return "Доступ: право «Релизы (Nyaa)» или админ";
    if (TAB_PERMS[k]) return `Доступ: право ${[].concat(TAB_PERMS[k]).map(x => `«${PERM_LABELS[x] || x}»`).join(" или ")}`;
    return "Доступ: только админы";
  };
  const nodes = [{ id: "hub", kind: "hub", x: 1040, y: 0, w: 360, h: 104, text: "Проект «Кадр»", color: "#a78bfa", sub: `Автосхема · разделов: ${tabs.length}` }];
  const edges = [];
  const trunk = { style: "solid", arrows: "none", curve: "curve", color: "#475569", flow: true, label: "", w: 2.2 };
  const colY = [0, 0];
  const placed = [];
  GROUPS.forEach((g, gi) => {
    const list = tabs.filter(t => t.grp === gi);
    if (!list.length) return;
    const side = gi < 2 ? 0 : 1;
    const top = colY[side];
    const gid = `g${gi}`;
    list.forEach((t, i) => {
      const id = `t-${t.key}`;
      const desc = t.desc && t.desc !== t.label ? t.desc : "";
      nodes.push({ id, kind: "box", x: side ? 1980 : 120, y: top + i * 150, w: 320, h: 74, text: t.label, sub: g.name, icon: t.icon,
        color: t.color || g.color, mine: tabAllowed(t.key), items: [desc, access(t.key), MEMBER_TABS.has(t.key) ? "" : tabAllowed(t.key) ? "✓ У вас: открыт" : "✕ У вас: закрыт"].filter(Boolean),
        itemsSide: side ? "right" : "left" });
      edges.push({ id: `e-${t.key}`, from: gid, to: id, ...trunk, color: "#64748b", style: "solid", flow: true, arrows: "none" });
    });
    const h = list.length * 150;
    placed.push({ id: gid, kind: "pill", x: side ? 1500 : 600, y: top + h / 2 - 70, w: 320, h: 72, text: g.name, sub: g.sub, color: g.color, icon: g.icon, num: gi + 1 });
    edges.push({ id: `h-${gi}`, from: "hub", to: gid, ...trunk, label: `${list.length} ${list.length === 1 ? "раздел" : list.length < 5 ? "раздела" : "разделов"}` });
    colY[side] += h + 90;
  });
  nodes.push(...placed);
  nodes[0].y = Math.max(...colY) / 2 - 140;
  nodes.push({ id: "legend", kind: "note", x: 1050, y: nodes[0].y + 170, w: 340, h: 64, color: "#94a3b8", sub: "Автосхема",
    text: "Строится из меню приложения сама" });
  return { auto: "project", nodes, edges, view: { x: 0, y: 0, z: 1 } };
}

async function openMap(id) {
  if (id === PROJECT_ID) {
    clearTimeout(st.saveT);
    if (st.map?.id && !st.map.auto && !st.ro) await save();
    const data = buildProjectMap();
    st.map = { id: PROJECT_ID, title: "Проект «Кадр»: все разделы", data, auto: "project", author: "" };
    st.ro = true;
    st.wrap.classList.add("automap", "ro");
    st.undo = []; st.redo = []; st.last = JSON.stringify(data);
    st.sel = new Set(); st.selEdge = null; st.selDraw = null;
    setMode("select");
    $("#rm-title").value = st.map.title;
    st.wrap.classList.remove("nomap");
    renderList(); render(); fit(); play();
    setSaveState("Автосхема · из меню приложения", "ok");
    return;
  }
  clearTimeout(st.saveT);
  if (st.map?.id && st.map.id !== id && !st.map.auto && !st.ro) await save();
  const m = await apiGet(`/roadmaps/${id}`);
  const data = { ...emptyData(), ...(m.data || {}) };
  st.map = { id: m.id, title: m.title, data, auto: data.auto || "", author: m.author || "" };
  st.ro = !!st.map.auto || m.can_edit === false;
  st.wrap.classList.toggle("automap", !!st.map.auto);
  st.wrap.classList.toggle("ro", st.ro);
  st.selDraw = null;
  setMode("select");
  st.undo = []; st.redo = []; st.last = JSON.stringify(data);
  st.sel = new Set(); st.selEdge = null;
  $("#rm-title").value = m.title;
  st.wrap.classList.remove("nomap");
  renderList();
  render();
  if (!m.data?.view || (m.data.view.x === 0 && m.data.view.y === 0 && m.data.view.z === 1)) fit();
  play();
  setSaveState(st.map.auto ? "Автосхема · обновляется сама" : "Сохранено", "ok");
}

// Автосхема (роли и права) строится сервером из живых данных: перечитываем её при каждом открытии вкладки и раз в
// 30 с, пока вкладка на экране. Если роли или права поменяли — схема перерисовывается с подсветкой изменившихся узлов.
async function refreshAuto() {
  if (!st?.map?.auto || st.map.id === PROJECT_ID || !st.wrap.offsetParent || st.drag) return;
  const id = st.map.id;
  let m;
  try { m = await apiGet(`/roadmaps/${id}`); } catch (_) { return; }
  if (!st.map || st.map.id !== id) return;
  const sig = d => JSON.stringify((d.nodes || []).filter(n => n.id !== "legend"));
  if (sig(m.data || {}) === sig(st.map.data)) return;
  const before = new Map(st.map.data.nodes.map(n => [n.id, JSON.stringify(n)]));
  const view = st.map.data.view;
  st.map.data = { ...emptyData(), ...m.data, view };
  st.last = JSON.stringify(st.map.data);
  render();
  const meaning = n => JSON.stringify([n.text, n.status, n.items]);
  for (const n of st.map.data.nodes) {
    const was = before.get(n.id);
    if (n.id !== "legend" && (!was || meaning(JSON.parse(was)) !== meaning(n))) pop(n.id);
  }
  setSaveState(`Обновлено ${new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`, "ok");
}
async function createMap(tpl) {
  const t = TEMPLATES[tpl] || TEMPLATES.blank;
  const data = t.make();
  const title = tpl === "blank" ? "Новая карта" : t.label;
  const r = await apiPost("/roadmaps", { title, data });
  st.list.unshift({ id: r.id, title, can_edit: true, nodes: data.nodes.length, edges: data.edges.length, updated_at: new Date().toISOString().slice(0, 19).replace("T", " ") });
  await openMap(r.id);
  if (tpl !== "blank") fit();
}
async function deleteMap() {
  if (!st.map?.id) return;
  if (!(await askConfirm(`Удалить карту «${st.map.title}» навсегда?`))) return;
  try {
    await apiPost(`/roadmaps/${st.map.id}/delete`, {});
    st.list = st.list.filter(m => m.id !== st.map.id);
    st.map = null;
    if (st.list.length) await openMap(st.list[0].id);
    else { st.wrap.classList.add("nomap"); st.map = { id: 0, title: "", data: emptyData() }; renderList(); render(); }
  } catch (e) { toast(`Не удалось удалить: ${e.message}`, "error"); }
}

// ---------- разметка ----------
const SHAPE_ICONS = {
  hub: '<rect x="3" y="7" width="18" height="10" rx="3"/><path d="m8 12 .01 0"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  pill: '<rect x="2.5" y="8" width="19" height="8" rx="4"/>',
  box: '<rect x="3" y="8" width="18" height="8" rx="1"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  tag: '<path d="M3 7h13l5 5-5 5H3z"/>',
  milestone: '<path d="m12 3 9 9-9 9-9-9z"/>',
  note: '<path d="M4 4h16v11l-5 5H4z"/><path d="M15 20v-5h5"/>',
  text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  frame: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5" stroke-dasharray="3 2.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
};
function layout() {
  return `<div class="rm-wrap nomap">
    <aside class="rm-side">
      <div class="rm-side-h">Дорожные карты</div>
      <div class="rm-new">
        <button class="btn primary" data-tpl="blank">+ Новая карта</button>
        <div class="rm-tpls">${Object.entries(TEMPLATES).filter(([k]) => k !== "blank").map(([k, v]) => `<button data-tpl="${k}">${esc(v.label)}</button>`).join("")}</div>
      </div>
      <div class="rm-list" id="rm-list"></div>
      <div class="rm-help">
        <b>Подсказки</b>
        <span>Двойной клик по пустому месту — новый узел</span>
        <span>Тяните за точку на краю узла — связь (или Alt+тяните)</span>
        <span>Shift+тяните — выбрать рамкой · колесо — масштаб</span>
        <span>Ctrl+Z / Ctrl+Y · Ctrl+D · Del · F — вписать · G — сетка</span>
      </div>
    </aside>
    <section class="rm-main">
      <header class="rm-top">
        <input id="rm-title" class="rm-title" maxlength="120" placeholder="Название карты">
        <span class="rm-save" id="rm-save"></span>
        <div class="rm-stats" id="rm-stats"></div>
        <div class="rm-top-act">
          <button class="icon-btn" data-cmd="play" title="Проиграть появление">▶</button>
          <button class="icon-btn" data-cmd="anim" title="Анимация потоков">≋</button>
          <button class="btn ghost" data-cmd="png">PNG</button>
          <button class="btn ghost" data-cmd="svg">SVG</button>
          <button class="btn ghost rm-copy" data-cmd="copy" title="Сделать свою копию карты">Копия</button>
          <button class="icon-btn danger" data-cmd="delmap" title="Удалить карту">🗑</button>
          <input type="file" accept="image/*" data-imgfile hidden>
        </div>
      </header>
      <div class="rm-stage">
        <div class="rm-tools">
          <div class="rm-modes">${Object.entries(MODES).map(([k, [t, key, ic]]) => `<button class="rm-mode${k === "select" ? " on" : ""}" data-mode="${k}" title="${t} (${key})"><svg viewBox="0 0 24 24">${ic}</svg></button>`).join("")}
            <button class="rm-mode" data-cmd="img" title="Картинка из файла (или Ctrl+V)"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m4 18 5-5 4 4 3-3 4 4"/></svg></button>
          </div>
          <div class="rm-pen">
            <div class="rm-pen-c">${PEN_COLORS.map((c, i) => `<button class="rm-swatch${i === 1 ? " on" : ""}" data-pen="${c}" style="--c:${c}"></button>`).join("")}</div>
            <input type="range" min="1" max="14" value="3" data-penw title="Толщина">
          </div>
          <i class="rm-sep"></i>
          ${Object.entries(KINDS).map(([k, v]) => `<button class="rm-tool" data-add="${k}" title="${v.label} — клик добавить, или выберите и дважды кликните по холсту" style="--c:${v.color === "transparent" ? "var(--ink-soft)" : v.color}"><svg viewBox="0 0 24 24">${SHAPE_ICONS[k]}</svg><span>${v.label}</span></button>`).join("")}
          <i class="rm-sep"></i>
          <button class="rm-tool" data-cmd="undo" title="Отменить (Ctrl+Z)"><svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg><span>Отменить</span></button>
          <button class="rm-tool" data-cmd="redo" title="Вернуть (Ctrl+Y)"><svg viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></svg><span>Вернуть</span></button>
          <button class="rm-tool" data-cmd="grid" title="Сетка и привязка (G)"><svg viewBox="0 0 24 24"><path d="M4 4h16v16H4zM4 12h16M12 4v16"/></svg><span>Сетка</span></button>
        </div>
        <div class="rm-canvas" id="rm-canvas">
          <svg id="rm-svg" xmlns="${NS}"></svg>
          <div class="rm-mini" hidden title="Мини-карта: кликните или тяните, чтобы перейти"></div>
          <div class="rm-zoombar">
            <button data-cmd="zout" title="Отдалить">−</button><span id="rm-zoom">100%</span><button data-cmd="zin" title="Приблизить">+</button><button data-cmd="fit" title="Вписать (F)">⤢</button>
          </div>
          <div class="rm-nomap">
            <div class="rm-nomap-in">
              <svg viewBox="0 0 120 70" class="rm-hero"><circle cx="60" cy="35" r="16"/><rect x="4" y="8" width="30" height="12" rx="6"/><rect x="86" y="8" width="30" height="12" rx="2"/><path d="M90 50h22l6 6-6 6H90z"/><rect x="4" y="50" width="30" height="12" rx="2"/><path d="M34 14 44 28M86 14 76 28M34 56l10-12M90 56 76 42"/></svg>
              <h3>Нарисуйте схему проекта</h3>
              <p>Системы, связи, этапы и сроки — на одном холсте, с анимацией потоков.</p>
              <div class="rm-row">${Object.entries(TEMPLATES).map(([k, v]) => `<button class="btn${k === "links" ? " primary" : " ghost"}" data-tpl="${k}">${esc(v.label)}</button>`).join("")}</div>
            </div>
          </div>
        </div>
        <aside class="rm-insp" id="rm-insp"></aside>
      </div>
    </section>
  </div>`;
}

export async function loadRoadmap() {
  const body = $("#roadmap-body");
  if (!body) return;
  if (!st || !body.contains(st.wrap)) {
    body.innerHTML = layout();
    st = {
      wrap: body.querySelector(".rm-wrap"), svg: $("#rm-svg"),
      map: { id: 0, title: "", data: emptyData() }, list: [],
      sel: new Set(), selEdge: null, undo: [], redo: [], last: "{}",
      grid: true, anim: true, tool: "box", drag: null, intro: false,
      edgeDefaults: { style: "dotted", arrows: "end", curve: "curve", color: "#64748b", flow: true },
      mode: "select", pen: { c: "#f43f5e", w: 3 }, ro: false, selDraw: null, space: false,
    };
    bindCanvas();
    bindInspector();
    st.svg.addEventListener("pointerover", e => {
      if (st.drag || st.mode !== "select") return;
      const n = e.target.closest?.(".rm-node");
      const id = n && !n.classList.contains("k-frame") ? n.dataset.id : null;
      if (id !== st.focusId) { st.focusId = id; clearTimeout(st.focusT); st.focusT = setTimeout(() => focusOn(st.focusId), id ? 90 : 0); }
    });
    st.svg.addEventListener("pointerleave", () => { st.focusId = null; clearTimeout(st.focusT); focusOn(null); });
    const mini = st.wrap.querySelector(".rm-mini");
    mini.addEventListener("pointerdown", e => { e.preventDefault(); mini.setPointerCapture(e.pointerId); st.miniDrag = true; miniJump(e, true); });
    mini.addEventListener("pointermove", e => { if (st.miniDrag && e.buttons) miniJump(e, false); });
    mini.addEventListener("pointerup", () => { st.miniDrag = false; });
    st.wrap.addEventListener("click", async e => {
      const b = e.target.closest("button");
      if (!b) return;
      try {
        if (b.dataset.tpl) await createMap(b.dataset.tpl);
        else if (b.dataset.open) await openMap(b.dataset.open === PROJECT_ID ? PROJECT_ID : Number(b.dataset.open));
        else if (b.dataset.add) {
          if (!st.map.id) { toast("Сначала создайте карту."); return; }
          if (b.dataset.add === "image") { st.wrap.querySelector("[data-imgfile]").click(); return; }
          st.tool = b.dataset.add;
          st.wrap.querySelectorAll("[data-add]").forEach(x => x.classList.toggle("on", x === b));
          addNode(b.dataset.add);
        } else {
          const c = b.dataset.cmd;
          if (c === "undo") undo(); else if (c === "redo") redo();
          else if (c === "grid") { st.grid = !st.grid; b.classList.toggle("on", st.grid); render(); }
          else if (c === "fit") fit(true);
          else if (c === "zin" || c === "zout") {
            const r = st.svg.getBoundingClientRect(), v = st.map.data.view;
            const z = Math.max(0.15, Math.min(3, v.z * (c === "zin" ? 1.35 : 1 / 1.35))), cx = r.width / 2, cy = r.height / 2;
            animateView({ z, x: cx - ((cx - v.x) * z) / v.z, y: cy - ((cy - v.y) * z) / v.z }, 300);
          }
          else if (c === "play") play();
          else if (c === "anim") { st.anim = !st.anim; b.classList.toggle("on", st.anim); render(); }
          else if (c === "png" || c === "svg") await exportAs(c);
          else if (c === "delmap") await deleteMap();
          else if (c === "copy") await copyMap();
          else if (c === "img") st.wrap.querySelector("[data-imgfile]").click();
        }
        if (b.dataset.mode) setMode(b.dataset.mode);
        if (b.dataset.pen) {
          st.pen.c = b.dataset.pen;
          st.wrap.querySelectorAll("[data-pen]").forEach(x => x.classList.toggle("on", x === b));
          if (st.selDraw) { const sk = st.map.data.draw.find(x => x.id === st.selDraw); if (sk) { sk.c = st.pen.c; commit(); } }
        }
      } catch (err) { toast(`Не получилось: ${err.message}`, "error"); }
    });
    st.wrap.querySelector('[data-cmd="grid"]').classList.add("on");
    st.wrap.querySelector('[data-cmd="anim"]').classList.add("on");
    $("#rm-title").addEventListener("input", e => { if (!st.map.id) return; st.map.title = e.target.value.trim() || "Без названия"; scheduleSave(); });
    $("#rm-title").addEventListener("change", () => renderList());
    document.addEventListener("keydown", onKey);
    document.addEventListener("keyup", e => { if (e.key === " " && st?.space) { st.space = false; st.wrap.classList.remove("space"); } });
    document.addEventListener("paste", onPaste);
    st.wrap.querySelector("[data-penw]").addEventListener("input", e => { st.pen.w = Number(e.target.value); });
    st.wrap.querySelector("[data-imgfile]").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; addImage(f).catch(err => toast(`Не вставилось: ${err.message}`, "error")); });
    st.svg.addEventListener("dragover", e => e.preventDefault());
    st.svg.addEventListener("drop", e => { const f = [...(e.dataTransfer?.files || [])].find(x => x.type.startsWith("image/")); if (f) { e.preventDefault(); const p = toWorld(e); addImage(f, { x: p.x, y: p.y }).catch(err => toast(`Не вставилось: ${err.message}`, "error")); } });
    window.addEventListener("resize", () => { if (st?.map.id) applyView(); });
    render();
  }
  try {
    const r = await apiGet("/roadmaps");
    st.list = [{ id: PROJECT_ID, title: "Проект «Кадр»: все разделы", auto: "project", can_edit: false }, ...(r.maps || [])];
  } catch (e) {
    body.querySelector(".rm-list").innerHTML = `<div class="rm-empty-l">Не удалось загрузить: ${esc(e.message)}</div>`;
    return false;
  }
  renderList();
  if (!st.map.id && st.list.length) await openMap(st.list[0].id);
  else if (st.map.auto) await refreshAuto();
  if (!st.autoT) st.autoT = setInterval(() => { refreshAuto(); }, 30000);
  return true;
}
