// Трещины на обложке в герое «Обзора»: чем ближе срок, тем сильнее треснуло стекло. За 3 дня — первые
// волоски от точки удара, в последний день трещины ползут прямо на глазах (до полуночи), просрочено — разбито.
// Рисунок у каждой серии свой (зерно — public_id) и не прыгает между перерисовками: растёт только длина линий.

import { For, Show, createSignal, onCleanup } from "solid-js";
import { apiPost, toast } from "./api.js";
import { initials } from "./utils.js";
import { loadAvatars } from "./profile.js";

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

// «Трещина в плите», как часы Чужого в Dishonored 2: за курсором ходит стеклянный осколок, и в нём видно «прошлое» —
// та же обложка целой, яркой и чуть ближе. Щелчок — прыжок во времени: вспышка, искажение, и открывается серия.
// Цели живут только в «прошлом»: они внутри обрезки осколка, так что видно их, лишь когда смотришь сквозь стекло.
export function TimeLens(props) {
  let clip;
  return (
    <div class="kd-lens" aria-hidden="true">
      <div class="kd-lens-clip" ref={el => { clip = el; }}>
        <img src={props.src} alt="" />
        <For each={props.targets() || []}>
          {t => {
            Promise.resolve().then(() => clip && loadAvatars(clip));
            return (
              <span class={`kd-target${t.cooldown_min ? " cool" : ""}${t.hit ? " hit" : ""}`} style={{ left: `${t.x}%`, top: `${t.y}%` }}>
                <i class="avatar" data-avatar-for={t.telegram_id}>{initials(t.name || "?")}</i>
                <b>{t.cooldown_min ? `${t.name} · ещё ${t.cooldown_min} мин` : t.name}</b>
              </span>
            );
          }}
        </For>
      </div>
    </div>
  );
}

// Где «враги» стоят на обложке — у каждой серии свои места, не слишком близко друг к другу.
export function placeTargets(seed, list) {
  const rand = rng(`${seed}:targets`);
  const spots = [];
  return list.map(t => {
    let x = 50, y = 50;
    for (let k = 0; k < 30; k++) {
      x = 18 + rand() * 64;
      y = 20 + rand() * 62;
      if (spots.every(([sx, sy]) => Math.hypot(sx - x, (sy - y) * 0.75) > 22)) break;
    }
    spots.push([x, y]);
    return { ...t, x, y };
  });
}

// В кого целится курсор (в px обложки): ближе 30px к цели.
export function aimedTarget(e, targets) {
  const el = e.currentTarget;
  return (targets || []).find(t => Math.hypot(e.offsetX - t.x / 100 * el.clientWidth, e.offsetY - t.y / 100 * el.clientHeight) < 30) || null;
}

// Удар: красная вспышка и рассечение из точки щелчка, напоминание в Telegram именно этому человеку.
export async function strike(e, publicId, target, setTargets) {
  const art = e.currentTarget;
  if (target.cooldown_min) {
    toast(`${target.name} уже напоминали — следующий удар через ${target.cooldown_min} мин.`);
    return;
  }
  const hero = art.closest(".kd-hero");
  if (hero && !motionOff()) {
    const b = hero.getBoundingClientRect();
    hero.style.setProperty("--jx", `${e.clientX - b.left}px`);
    hero.style.setProperty("--jy", `${e.clientY - b.top}px`);
    for (const el of [hero, art]) { el.classList.remove("strike"); void el.offsetWidth; el.classList.add("strike"); }
    setTimeout(() => { hero.classList.remove("strike"); art.classList.remove("strike"); }, 900);
  }
  const mark = patch => setTargets(list => list.map(t => (t.telegram_id === target.telegram_id ? { ...t, ...patch } : t)));
  mark({ hit: true });
  try {
    const res = await apiPost(`/report/${publicId}/strike`, { telegram_id: target.telegram_id });
    toast(`⚡ Удар из прошлого — ${res.hit} получил(а) напоминание в Telegram.`, "success");
    mark({ hit: false, cooldown_min: res.cooldown_min });
  } catch (err) {
    toast(err && err.message ? err.message : String(err), "error");
    mark({ hit: false });
  }
}

// Глаза в темноте вокруг обложки: чем ближе срок, тем больше пар; моргают, следят за курсором, у просроченной — красные.
// Плюс «сердцебиение» — тёмно-красная виньетка, пульс чаще к полуночи.
const EYE_PAIRS = level => (level <= 0 ? 0 : level < 0.3 ? 1 : level < 0.5 ? 2 : level < 1 ? 3 + Math.round((level - 0.5) * 6) : 8);
let eyeSeq = 0;

export function Eyes(props) {
  let box;
  const [pairs, setPairs] = createSignal([]);
  const spawn = () => {
    if (!box || !props.active() || document.hidden) return;
    const alive = pairs().filter(p => !p.gone);
    if (alive.length >= EYE_PAIRS(props.level())) return;
    const hb = box.getBoundingClientRect();
    const art = box.parentElement.querySelector(".kd-slide-art")?.getBoundingClientRect();
    for (let k = 0; k < 20; k++) {
      const x = hb.width * (0.56 + Math.random() * 0.42), y = hb.height * (0.08 + Math.random() * 0.84);
      const inArt = art && art.width && x > art.left - hb.left - 30 && x < art.right - hb.left + 30 && y > art.top - hb.top - 20 && y < art.bottom - hb.top + 20;
      if (inArt || alive.some(p => Math.hypot(p.x - x, p.y - y) < 70)) continue;
      const pair = { id: ++eyeSeq, x, y, size: 0.6 + Math.random() * 0.8, blink: 2.5 + Math.random() * 4, delay: Math.random() * 3, tilt: (Math.random() - 0.5) * 16 };
      setPairs(l => [...l, pair]);
      // Угасание — классом прямо на узле: новый объект в списке пересоздал бы элемент, и переход бы не сыграл.
      setTimeout(() => { pair.gone = true; box?.querySelector(`[data-eye="${pair.id}"]`)?.classList.add("gone"); }, 5000 + Math.random() * 8000);
      setTimeout(() => setPairs(l => l.filter(p => p.id !== pair.id)), 15000);
      return;
    }
  };
  const timer = setInterval(spawn, 1300);
  let raf = 0;
  const look = ev => {
    if (raf || !box) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const hb = box.getBoundingClientRect();
      box.querySelectorAll(".kd-eye-pair").forEach(el => {
        const dx = ev.clientX - hb.left - +el.dataset.x, dy = ev.clientY - hb.top - +el.dataset.y;
        const d = Math.hypot(dx, dy) || 1;
        el.style.setProperty("--px", `${(dx / d * 1.6).toFixed(2)}px`);
        el.style.setProperty("--py", `${(dy / d * 1.1).toFixed(2)}px`);
      });
    });
  };
  document.addEventListener("mousemove", look);
  onCleanup(() => { clearInterval(timer); document.removeEventListener("mousemove", look); cancelAnimationFrame(raf); });
  return (
    <div class={`kd-eyes${props.level() >= 1 ? " red" : ""}`} ref={el => { box = el; }} aria-hidden="true"
      style={{ "--dread": Math.max(0, (props.level() - 0.35) * 1.2).toFixed(2), "--beat": `${(1.9 - props.level() * 0.9).toFixed(2)}s` }}>
      <Show when={props.level() >= 0.4}><div class="kd-dread" /></Show>
      <For each={pairs()}>
        {p => (
          <span class="kd-eye-pair" data-eye={p.id} data-x={p.x} data-y={p.y}
            style={{ left: `${p.x}px`, top: `${p.y}px`, "--s": p.size, "--blink": `${p.blink}s`, "--delay": `${p.delay}s`, "--tilt": `${p.tilt}deg` }}>
            <i /><i />
          </span>
        )}
      </For>
    </div>
  );
}

// offsetX/Y — в собственных координатах обложки (она повёрнута на 2°): все слои внутри неё размером с неё саму.
export function aimLens(e) {
  const el = e.currentTarget;
  el.style.setProperty("--lx", `${e.offsetX}px`);
  el.style.setProperty("--ly", `${e.offsetY}px`);
}

export function timeJump(e, open) {
  const hero = e.currentTarget.closest(".kd-hero");
  if (!hero || motionOff()) return open();
  const b = hero.getBoundingClientRect();
  hero.style.setProperty("--jx", `${e.clientX - b.left}px`);
  hero.style.setProperty("--jy", `${e.clientY - b.top}px`);
  hero.classList.remove("jump");
  void hero.offsetWidth;
  hero.classList.add("jump");
  setTimeout(open, 380);
  setTimeout(() => hero.classList.remove("jump"), 800);
}
