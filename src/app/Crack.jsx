// Трещины на обложке в герое «Обзора»: чем ближе срок, тем сильнее треснуло стекло. За 3 дня — первые
// волоски от точки удара, в последний день трещины ползут прямо на глазах (до полуночи), просрочено — разбито.
// Рисунок у каждой серии свой (зерно — public_id) и не прыгает между перерисовками: растёт только длина линий.

import { For, Show } from "solid-js";

const W = 100, H = 140;   // viewBox под пропорции обложки 3 : 4.2

function rng(seedText) {
  let h = 1779033703;
  for (const ch of String(seedText)) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353), h = (h << 13) | (h >>> 19);
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const inside = (x, y) => x > -2 && x < W + 2 && y > -2 && y < H + 2;

// Ломаная от (x, y) в направлении angle до края или пока не кончится maxLen.
function walk(rand, x, y, angle, maxLen, wobble) {
  const pts = [[x, y]];
  let len = 0;
  while (len < maxLen && inside(x, y)) {
    const step = 5 + rand() * 8;
    angle += (rand() - 0.5) * wobble;
    x += Math.cos(angle) * step;
    y += Math.sin(angle) * step;
    len += step;
    pts.push([x, y]);
  }
  return pts;
}

const d = pts => pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("");

// Линии с порогом: start — с какой силы трещина появляется, span — за сколько дорастает до конца.
function geometry(seed) {
  const rand = rng(seed);
  const cx = 28 + rand() * 44, cy = 40 + rand() * 50;
  const lines = [];
  const n = 8 + Math.floor(rand() * 3);
  const order = Array.from({ length: n }, (_, i) => i).sort(() => rand() - 0.5);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.5;
    const pts = walk(rand, cx, cy, a, 200, 0.55);
    const start = 0.02 + (order[i] / n) * 0.5;
    lines.push({ d: d(pts), start, span: 0.32, w: 1 });
    // Ответвления — появляются позже своей ветки.
    for (let k = 2; k < pts.length - 1; k += 2 + Math.floor(rand() * 3)) {
      if (rand() < 0.45) continue;
      const side = rand() < 0.5 ? -1 : 1;
      const fork = walk(rand, pts[k][0], pts[k][1], a + side * (0.5 + rand() * 0.7), 14 + rand() * 26, 0.7);
      lines.push({ d: d(fork), start: Math.min(0.9, start + 0.18 + (k / pts.length) * 0.3), span: 0.2, w: 0.7 });
    }
  }
  // Кольца вокруг удара — паутина, когда уже совсем горит.
  for (const [r, start] of [[7 + rand() * 3, 0.55], [15 + rand() * 6, 0.72], [27 + rand() * 8, 0.86]]) {
    const parts = [];
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2 + (rand() - 0.5) * 0.25;
      const rr = r * (0.8 + rand() * 0.4);
      parts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
    }
    lines.push({ d: d(parts), start, span: 0.14, w: 0.6 });
  }
  // Выбитый осколок у точки удара — только у просроченных.
  const shard = Array.from({ length: 5 }, (_, i) => {
    const a = (i / 5) * Math.PI * 2 + rand() * 0.6;
    const rr = 3 + rand() * 4;
    return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
  });
  return { cx, cy, lines, shard: d(shard) + "Z" };
}

const cache = new Map();
function geometryFor(seed) {
  if (!cache.has(seed)) cache.set(seed, geometry(seed));
  return cache.get(seed);
}

// Сила 0…1 по оставшемуся времени. left — целые дни до срока (null — без срока).
export function crackLevel(left, now) {
  if (left === null || left === undefined || left > 3) return 0;
  if (left < 0) return 1;
  if (left > 0) return [0, 0.4, 0.26, 0.13][left];
  // Сегодня: от 0.5 утром до 0.97 к полуночи — трещины растут, пока идёт обратный отсчёт.
  const dayPart = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
  return 0.5 + 0.47 * dayPart;
}

export function Crack(props) {
  const g = geometryFor(props.seed);
  const shown = line => Math.max(0, Math.min(1, (props.level() - line.start) / line.span));
  return (
    <Show when={props.level() > 0}>
      <svg class={`kd-crack${props.level() >= 1 ? " broken" : ""}`} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true"
        style={{ "--crack-glow": `${(props.level() * 0.55).toFixed(2)}` }}>
        <radialGradient id={`kd-crack-g-${props.seed}`} cx={g.cx / W} cy={g.cy / H} r="0.6">
          <stop offset="0" stop-color="#fff" stop-opacity=".22" />
          <stop offset="1" stop-color="#fff" stop-opacity="0" />
        </radialGradient>
        <rect class="kd-crack-flash" width={W} height={H} fill={`url(#kd-crack-g-${props.seed})`} />
        <path class="kd-crack-hole" d={g.shard} />
        <For each={g.lines}>
          {line => (
            <g style={{ "--w": line.w, "--off": 1 - shown(line) }} data-start={line.start} data-span={line.span}>
              <path class="kd-crack-dark" d={line.d} pathLength="1" />
              <path class="kd-crack-lit" d={line.d} pathLength="1" />
            </g>
          )}
        </For>
      </svg>
    </Show>
  );
}
