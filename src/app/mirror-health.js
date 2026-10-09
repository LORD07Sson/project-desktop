// Здоровье зеркал для «Источников и зеркал 2.0»: по каждому адресу хранятся последние замеры
// на двух путях — «pc» (напрямую с этого компьютера) и «server» (через сервер студии, его WireGuard).
// Из замеров считаются медиана, потери и «пауза» после серии сбоев; по ним «Авто» выбирает лучший
// путь и зеркало. Модуль чистый (без сети и DOM): время передаётся параметром, поэтому легко тестируется.

export const HIST_MAX = 12;          // замеров на путь
export const SLOW_MS = 1500;         // «медленно»
export const PATHS = ["pc", "server"];
const MIN = 60_000;

export const newHealth = () => ({ m: {} });

const entry = (h, url) => (h.m[url] ||= { pc: [], server: [], fail: { pc: 0, server: 0 }, until: { pc: 0, server: 0 } });

/** Пауза после серии сбоев: 3 подряд — 5 минут, 6 и больше — 10. */
export const cooldownMs = streak => (streak >= 6 ? 10 * MIN : streak >= 3 ? 5 * MIN : 0);

/** Записать замер. ms === null — сбой. */
export function record(h, url, path, ms, now = Date.now()) {
  if (!PATHS.includes(path) || !url) return;
  const e = entry(h, url);
  const ok = typeof ms === "number" && ms >= 0;
  e[path].push({ t: now, ms: ok ? Math.round(ms) : null });
  if (e[path].length > HIST_MAX) e[path].splice(0, e[path].length - HIST_MAX);
  if (ok) { e.fail[path] = 0; e.until[path] = 0; }
  else {
    e.fail[path] += 1;
    const c = cooldownMs(e.fail[path]);
    if (c) e.until[path] = now + c;
  }
}

/** Статистика по замерам: число, медиана успешных, доля потерь, последний замер. */
export function statsOf(samples) {
  const n = samples.length;
  const oks = samples.filter(s => s.ms != null).map(s => s.ms).sort((a, b) => a - b);
  const median = oks.length ? oks[Math.floor((oks.length - 1) / 2)] : null;
  const last = n ? samples[n - 1] : null;
  return { n, median, loss: n ? (n - oks.length) / n : 0, last: last ? last.ms : undefined, lastAt: last ? last.t : 0 };
}

export const cooling = (h, url, path, now = Date.now()) => !!(h.m[url] && h.m[url].until[path] > now);

/** Оценка пути: меньше — лучше; Infinity — не годится сейчас; null — нет данных. */
export function pathScore(h, url, path, now = Date.now()) {
  const e = h.m[url];
  if (!e || !e[path].length) return null;
  if (cooling(h, url, path, now)) return Infinity;
  const s = statsOf(e[path]);
  if (s.median == null) return Infinity;
  return s.median + s.loss * 3000;
}

/** Лучший путь для адреса: "pc" | "server" | null (данных нет — пробуйте по умолчанию: сначала pc). */
export function bestPath(h, url, now = Date.now()) {
  const a = pathScore(h, url, "pc", now), b = pathScore(h, url, "server", now);
  if (a == null && b == null) return null;
  if (a == null) return b === Infinity ? null : "server";
  if (b == null) return a === Infinity ? null : "pc";
  if (a === Infinity && b === Infinity) return null;
  // прямой путь не нагружает сервер: при почти равных значениях берём его
  return a <= b + 150 ? "pc" : "server";
}

/** Лучшая пара «зеркало + путь» среди зеркал: { url, path, score } или null. */
export function pickMirror(h, mirrors, now = Date.now(), preferred = "") {
  let best = null;
  for (const url of mirrors) {
    const p = bestPath(h, url, now);
    if (!p) continue;
    const score = pathScore(h, url, p, now);
    if (!Number.isFinite(score)) continue;
    if (!best || score < best.score || (score === best.score && url === preferred)) best = { url, path: p, score };
  }
  return best;
}

/**
 * Нужно ли переключить зеркало: текущее на паузе/не отвечает, либо медленное (>1,5 с),
 * а другое как минимум вдвое быстрее. Возвращает адрес нового зеркала или null.
 */
export function shouldSwitch(h, current, mirrors, now = Date.now()) {
  const best = pickMirror(h, mirrors.filter(u => u !== current), now);
  if (!best) return null;
  const known = PATHS.map(p => pathScore(h, current, p, now)).filter(x => x != null);
  if (!known.length) return null;                    // про текущее ничего не знаем — не трогаем
  const cur = Math.min(...known);
  if (!Number.isFinite(cur)) return best.url;
  if (cur > SLOW_MS && best.score < cur / 2) return best.url;
  return null;
}

/** Точки ломаной (мини-график) для SVG: «x,y x,y …»; сбой рисуется на дне. */
export function sparkPoints(samples, w = 70, hgt = 22) {
  if (!samples.length) return "";
  const vals = samples.map(s => (s.ms == null ? null : s.ms));
  const max = Math.max(200, ...vals.filter(v => v != null));
  const step = samples.length > 1 ? w / (samples.length - 1) : 0;
  return vals.map((v, i) => `${(i * step).toFixed(1)},${(v == null ? hgt - 2 : 2 + (1 - Math.min(v, max) / max) * (hgt - 6)).toFixed(1)}`).join(" ");
}

/** Класс статуса по замерам пути: ok | slow | bad | idle. */
export function levelOf(samples, coolingNow = false) {
  if (!samples.length) return "idle";
  const s = statsOf(samples);
  if (coolingNow || s.median == null || s.last === null) return "bad";
  if (s.median > SLOW_MS || s.loss >= 0.34) return "slow";
  return "ok";
}

/** Сохраняемое представление: без старых и без лишнего. */
export function serialize(h, now = Date.now(), maxAgeMs = 3 * 24 * 60 * MIN) {
  const m = {};
  for (const [url, e] of Object.entries(h.m)) {
    const keep = p => e[p].filter(s => now - s.t < maxAgeMs);
    const pc = keep("pc"), server = keep("server");
    if (pc.length || server.length) m[url] = { pc, server, fail: e.fail, until: e.until };
  }
  return { m };
}

export function deserialize(raw) {
  const h = newHealth();
  const m = raw && typeof raw === "object" && raw.m && typeof raw.m === "object" ? raw.m : {};
  for (const [url, e] of Object.entries(m).slice(0, 80)) {
    if (!/^https:\/\//.test(url) || !e || typeof e !== "object") continue;
    const clean = arr => (Array.isArray(arr) ? arr : []).filter(s => s && typeof s.t === "number" && (s.ms === null || typeof s.ms === "number")).slice(-HIST_MAX);
    h.m[url] = {
      pc: clean(e.pc), server: clean(e.server),
      fail: { pc: Number(e.fail && e.fail.pc) || 0, server: Number(e.fail && e.fail.server) || 0 },
      until: { pc: Number(e.until && e.until.pc) || 0, server: Number(e.until && e.until.server) || 0 },
    };
  }
  return h;
}
