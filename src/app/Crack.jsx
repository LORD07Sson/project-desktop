// Трещины на обложке в герое «Обзора»: чем ближе срок, тем сильнее треснуло стекло. За 3 дня — первые
// волоски от точки удара, в последний день трещины ползут прямо на глазах (до полуночи), просрочено — разбито.
// Рисунок у каждой серии свой (зерно — public_id) и не прыгает между перерисовками: растёт только длина линий.

import { For, Show, createSignal, onCleanup } from "solid-js";

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
    lines.push({ d: d(pts), pts, start, span: 0.32, w: 1 });
    // Ответвления — появляются позже своей ветки.
    for (let k = 2; k < pts.length - 1; k += 2 + Math.floor(rand() * 3)) {
      if (rand() < 0.45) continue;
      const side = rand() < 0.5 ? -1 : 1;
      const fork = walk(rand, pts[k][0], pts[k][1], a + side * (0.5 + rand() * 0.7), 14 + rand() * 26, 0.7);
      lines.push({ d: d(fork), pts: fork, start: Math.min(0.9, start + 0.18 + (k / pts.length) * 0.3), span: 0.2, w: 0.7 });
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
    lines.push({ d: d(parts), pts: parts, start, span: 0.14, w: 0.6 });
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

// Осколки: кусочки самой обложки откалываются по видимым трещинам и улетают, падая. Чем ближе срок — тем чаще
// и крупнее; у просроченной сыплется очередями. Только на активном слайде и если анимации не выключены.
const SHARD_EVERY = level => (level >= 1 ? 700 : level >= 0.5 ? 3600 - (level - 0.5) * 6000 : level >= 0.35 ? 5500 : level > 0 ? 9000 : 0);
const motionOff = () => document.documentElement.dataset.motion === "off" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let shardSeq = 0;

function makeShard(g, level) {
  const visible = g.lines.filter(l => level() > l.start + 0.02);
  if (!visible.length) return null;
  const line = visible[Math.floor(Math.random() * visible.length)];
  const upTo = Math.max(1, Math.floor(line.pts.length * Math.min(1, (level() - line.start) / line.span)));
  const [px, py] = line.pts[Math.floor(Math.random() * upTo)];
  const size = 6 + Math.random() * 5 + level() * 7;
  const corners = 3 + Math.floor(Math.random() * 2);
  const base = Math.random() * Math.PI * 2;
  const poly = Array.from({ length: corners }, (_, i) => {
    const a = base + (i / corners) * Math.PI * 2 + (Math.random() - 0.5) * 0.9;
    const r = size * (0.45 + Math.random() * 0.6);
    return [Math.max(0, Math.min(W, px + Math.cos(a) * r)), Math.max(0, Math.min(H, py + Math.sin(a) * r))];
  });
  // Летит от точки удара, потом падает вниз.
  const ang = Math.atan2(py - g.cy, px - g.cx) + (Math.random() - 0.5) * 0.8;
  const push = 40 + Math.random() * 90;
  return {
    id: ++shardSeq,
    clip: `polygon(${poly.map(([x, y]) => `${(x / W * 100).toFixed(1)}% ${(y / H * 100).toFixed(1)}%`).join(",")})`,
    origin: `${(px / W * 100).toFixed(1)}% ${(py / H * 100).toFixed(1)}%`,
    dx: `${(Math.cos(ang) * push).toFixed(0)}px`,
    dy: `${(Math.sin(ang) * push * 0.5 + 140 + Math.random() * 120).toFixed(0)}px`,
    rot: `${((Math.random() - 0.5) * 540).toFixed(0)}deg`,
    tilt: `${((Math.random() - 0.5) * 300).toFixed(0)}deg`,
    dur: `${(1.1 + Math.random() * 0.8).toFixed(2)}s`,
  };
}

export function Shards(props) {
  const g = geometryFor(props.seed);
  const [list, setList] = createSignal([]);
  let timer;
  const schedule = () => {
    const every = SHARD_EVERY(props.level());
    timer = setTimeout(() => {
      if (props.active() && every && !motionOff() && !document.hidden) {
        const burst = props.level() >= 1 ? 2 + Math.floor(Math.random() * 3) : props.level() >= 0.5 ? 1 + Math.floor(Math.random() * 2) : 1;
        const fresh = Array.from({ length: burst }, () => makeShard(g, props.level)).filter(Boolean);
        if (fresh.length) setList(l => [...l, ...fresh].slice(-14));
      }
      schedule();
    }, (every || 4000) * (0.6 + Math.random() * 0.8));
  };
  schedule();
  onCleanup(() => clearTimeout(timer));
  const drop = id => setList(l => l.filter(s => s.id !== id));
  return (
    <div class="kd-shards" aria-hidden="true">
      <For each={list()}>
        {s => (<>
          {/* <b> — тёмная выемка на месте откола, пока осколок летит */}
          <b style={{ "clip-path": s.clip, "animation-duration": s.dur }} />
          {/* Обрезка — на <i>, а полёт и кромка (drop-shadow) — на обёртке: фильтр на самом обрезанном элементе срезается вместе с ним */}
          <span style={{ "transform-origin": s.origin, "--dx": s.dx, "--dy": s.dy, "--rot": s.rot, "--tilt": s.tilt, "animation-duration": s.dur }}
            onAnimationEnd={() => drop(s.id)}>
            <i style={{ "background-image": `url("${props.src}")`, "clip-path": s.clip }} />
          </span>
        </>)}
      </For>
    </div>
  );
}
