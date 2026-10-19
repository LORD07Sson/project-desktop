// Тема «Пульса»: страница живёт в iframe и сама цвета приложения не знает — приложение присылает значения переменных своей темы
// (акцент: янтарь, сакура, фиалка, небо, мята…). CSS подхватывает их через переменные, а canvas-сцена рисуется «тёплой» палитрой
// оригинала — её теплые оттенки (оранжевый, золото) переносятся на цвета акцента, а красный (просрочка), фиолетовый и мятный
// (серии и люди) остаются как есть, чтобы цвета не теряли смысл.

const VARS = ["--bg", "--bg-2", "--bg-glow-1", "--bg-glow-2", "--surface", "--surface-2", "--surface-3", "--line", "--ink", "--ink-soft", "--ink-dim",
  "--fire", "--ember", "--gold", "--on-accent", "--fire-rgb", "--gold-rgb", "--glow-rgb"];

export function applyTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;
  // Светлая тема приложения: сцена остаётся тёмной (на светлом фоне неоновая анимация не читается), от темы берём только акцент.
  const accentOnly = theme.light ? ["--fire", "--ember", "--gold", "--on-accent", "--fire-rgb", "--gold-rgb", "--glow-rgb"] : VARS;
  for (const name of accentOnly) if (theme.vars && theme.vars[name]) root.style.setProperty(name, theme.vars[name]);
}

// ---------- перенос тёплых цветов canvas на акцент ----------
function parseColor(str) {
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = [...h].map(c => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(str);
  return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
}
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
const hueOf = hex => { const c = parseColor(hex || ""); return c ? rgbToHsl(c).h : null; };

const BASE_FIRE = 18, BASE_GOLD = 38;    // оттенки оригинальной палитры: «огонь» и «золото»
let mapHue = null;

export function installColorMap(theme) {
  const fire = hueOf(theme && theme.vars && theme.vars["--fire"]), gold = hueOf(theme && theme.vars && theme.vars["--gold"]);
  if (fire == null || gold == null) return;
  // оригинал (янтарь) — ничего переносить не нужно
  if (Math.abs(fire - BASE_FIRE) < 6 && Math.abs(gold - BASE_GOLD) < 8) return;
  // оттенок h из диапазона «огонь…золото» линейно ложится между оттенками акцента
  let dg = gold - fire;
  if (dg > 180) dg -= 360;
  if (dg < -180) dg += 360;
  mapHue = h => (fire + (h - BASE_FIRE) * dg / (BASE_GOLD - BASE_FIRE) + 360) % 360;

  const cache = new Map();
  const map = str => {
    if (cache.has(str)) return cache.get(str);
    let out = str;
    const c = parseColor(str);
    if (c) {
      const { h, s, l } = rgbToHsl(c);
      // тёплые насыщенные цвета (оранжевый, золото) — на акцент; красный (<8°), почти белое и серое не трогаем
      if (s > .3 && l > .08 && l < .9 && h >= 8 && h <= 60) {
        const n = hslToRgb(mapHue(h), s, l);
        out = `rgba(${n.r},${n.g},${n.b},${c.a})`;
      }
    }
    cache.set(str, out);
    return out;
  };

  const protoDesc = prop => Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, prop);
  const patchGradient = gr => { const add = gr.addColorStop.bind(gr); gr.addColorStop = (o, col) => add(o, typeof col === "string" ? map(col) : col); return gr; };
  const origGet = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = origGet.call(this, type, ...rest);
    if (ctx && type === "2d" && !ctx.__pulseMapped) {
      ctx.__pulseMapped = true;
      for (const prop of ["fillStyle", "strokeStyle"]) {
        const d = protoDesc(prop);
        Object.defineProperty(ctx, prop, { configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, typeof v === "string" ? map(v) : v); } });
      }
      const lin = ctx.createLinearGradient.bind(ctx), rad = ctx.createRadialGradient.bind(ctx);
      ctx.createLinearGradient = (...a) => patchGradient(lin(...a));
      ctx.createRadialGradient = (...a) => patchGradient(rad(...a));
    }
    return ctx;
  };
}
