// Lofi-радио в шапке: пять бесплатных интернет-станций (обычный <audio> по https — CSP media-src это разрешает),
// пластинка и эквалайзер, пока играет, и свои слои атмосферы — дождь и треск винила, синтезированные Web Audio
// (файлов нет, ничего не качается). Станция, громкость и слои запоминаются; само радио при запуске не включается.
// Другое видео или звук в программе (плеер серий, дорожки) ставит радио на паузу.

import { $, esc } from "./utils.js";

const STATIONS = [
  { id: "lofihiphop", name: "Lofi Hip Hop Radio", note: "zeno.fm", url: "https://stream.zeno.fm/0r0xa792kwzuv" },
  { id: "lautlofi", name: "laut.fm · lofi", note: "лоуфай без перерыва", url: "https://lofi.stream.laut.fm/lofi" },
  { id: "chillhop", name: "FluxFM · Chillhop", note: "чиллхоп и битс", url: "https://streams.fluxfm.de/Chillhop/mp3-128/audio/" },
  { id: "ilovechill", name: "I Love Chillhop", note: "ilovemusic.de", url: "https://streams.ilovemusic.de/iloveradio17.mp3" },
  { id: "lofimusic", name: "Lofi Music", note: "zeno.fm", url: "https://stream.zeno.fm/f3wvbbqmdg8uv" },
];
const STORE = "lofi-radio";

function load() {
  try { return JSON.parse(localStorage.getItem(STORE) || "{}"); } catch (_) { return {}; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ station: cur.id, volume, rain, crackle })); } catch (_) { /* приватный режим — не страшно */ }
}

const saved = load();
let cur = STATIONS.find(s => s.id === saved.station) || STATIONS[0];
let volume = typeof saved.volume === "number" ? saved.volume : 0.6;
let rain = saved.rain ?? 0;        // 0…1
let crackle = saved.crackle ?? 0;  // 0…1
let status = "idle";               // idle | loading | playing | error

const audio = new Audio();
audio.preload = "none";
audio.volume = volume;

// ── Атмосфера: дождь (коричневый шум через полосовой фильтр + редкие капли) и треск винила (щелчки и шипение). ──
let ctx = null, rainGain = null, crackleGain = null;
function noiseBuffer(c, seconds, brown) {
  const buf = c.createBuffer(1, c.sampleRate * seconds, c.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
  }
  return buf;
}
function ensureAmbience() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  // Дождь: шелест + отдельный слой капель повыше.
  rainGain = ctx.createGain();
  rainGain.connect(ctx.destination);
  const hush = ctx.createBufferSource();
  hush.buffer = noiseBuffer(ctx, 4, true);
  hush.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "lowpass"; band.frequency.value = 1400;
  hush.connect(band).connect(rainGain);
  hush.start();
  const drops = ctx.createBufferSource();
  drops.buffer = noiseBuffer(ctx, 3, false);
  drops.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = 3500;
  const dropsGain = ctx.createGain();
  dropsGain.gain.value = 0.05;
  drops.connect(hp).connect(dropsGain).connect(rainGain);
  drops.start();
  // Винил: тихое шипение + случайные щелчки.
  crackleGain = ctx.createGain();
  crackleGain.connect(ctx.destination);
  const buf = ctx.createBuffer(1, ctx.sampleRate * 5, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    d[i] = (Math.random() * 2 - 1) * 0.012;
    if (Math.random() < 0.00018) {
      const amp = 0.25 + Math.random() * 0.6, len = 20 + Math.floor(Math.random() * 60);
      for (let k = 0; k < len && i + k < d.length; k++) d[i + k] += (Math.random() * 2 - 1) * amp * (1 - k / len);
    }
  }
  const vinyl = ctx.createBufferSource();
  vinyl.buffer = buf;
  vinyl.loop = true;
  const warm = ctx.createBiquadFilter();
  warm.type = "lowpass"; warm.frequency.value = 5200;
  vinyl.connect(warm).connect(crackleGain);
  vinyl.start();
  applyAmbience();
}
function applyAmbience() {
  if (!ctx) return;
  const on = status === "playing" || status === "loading";
  const t = ctx.currentTime;
  rainGain.gain.setTargetAtTime(on ? rain * volume * 0.9 : 0, t, 0.4);
  crackleGain.gain.setTargetAtTime(on ? crackle * volume * 1.6 : 0, t, 0.3);
}

// ── Воспроизведение ──
function setStatus(s) {
  status = s;
  render();
  applyAmbience();
}
async function play() {
  if (rain || crackle) ensureAmbience();
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
  if (audio.src !== cur.url) audio.src = cur.url;
  setStatus("loading");
  try {
    await audio.play();
  } catch (e) {
    if (e && e.name === "AbortError") return;
    setStatus("error");
  }
}
function stop() {
  audio.pause();
  // Поток не держим: после паузы радио должно играть «сейчас», а не догонять старый буфер.
  audio.removeAttribute("src");
  audio.load();
  setStatus("idle");
}
function toggle() { (status === "playing" || status === "loading") ? stop() : play(); }

audio.addEventListener("playing", () => setStatus("playing"));
audio.addEventListener("waiting", () => { if (status === "playing") setStatus("loading"); });
audio.addEventListener("error", () => { if (audio.getAttribute("src")) setStatus("error"); });

// Другой звук в программе — радио уступает.
document.addEventListener("play", e => {
  if (e.target !== audio && e.target instanceof window.HTMLMediaElement && !e.target.muted && status !== "idle") stop();
}, true);

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => play());
  navigator.mediaSession.setActionHandler("pause", () => stop());
  navigator.mediaSession.setActionHandler("stop", () => stop());
  navigator.mediaSession.setActionHandler("nexttrack", () => pick(STATIONS[(STATIONS.indexOf(cur) + 1) % STATIONS.length].id));
  navigator.mediaSession.setActionHandler("previoustrack", () => pick(STATIONS[(STATIONS.indexOf(cur) + STATIONS.length - 1) % STATIONS.length].id));
}

function pick(id) {
  const st = STATIONS.find(s => s.id === id);
  if (!st) return;
  cur = st;
  save();
  play();
}

// ── Панель ──
const STATUS_TEXT = { idle: "Пауза", loading: "Подключаюсь…", playing: "В эфире", error: "Станция не отвечает — попробуйте другую" };

function render() {
  const btn = $("#lofi-btn");
  const panel = $("#lofi-panel");
  if (!btn || !panel) return;
  const on = status === "playing";
  btn.classList.toggle("on", on);
  btn.classList.toggle("loading", status === "loading");
  btn.title = on ? `Lofi-радио: ${cur.name}` : "Lofi-радио";
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = status === "idle" ? null : new window.MediaMetadata({ title: cur.name, artist: "Lofi-радио · Project Desktop" });
    navigator.mediaSession.playbackState = on ? "playing" : status === "idle" ? "paused" : "none";
  }
  if (panel.hidden) return;
  panel.querySelector(".lr-vinyl").classList.toggle("spin", on);
  panel.querySelector(".lr-eq").classList.toggle("on", on);
  panel.querySelector(".lr-now b").textContent = cur.name;
  const stEl = panel.querySelector(".lr-status");
  stEl.textContent = STATUS_TEXT[status];
  stEl.dataset.s = status;
  panel.querySelector("[data-lr-play]").classList.toggle("on", status === "playing" || status === "loading");
  panel.querySelector("[data-lr-play]").setAttribute("aria-label", on ? "Пауза" : "Играть");
  panel.querySelectorAll("[data-lr-st]").forEach(b => b.classList.toggle("cur", b.dataset.lrSt === cur.id));
}

function panelHtml() {
  return `
    <div class="lr-top">
      <div class="lr-vinyl" aria-hidden="true"><i></i></div>
      <div class="lr-now">
        <small>Lofi-радио</small>
        <b></b>
        <span class="lr-status"></span>
        <span class="lr-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      </div>
      <button type="button" class="lr-play" data-lr-play aria-label="Играть">
        <svg class="pl" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="none"/></svg>
        <svg class="pa" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14" stroke-width="3.2"/></svg>
      </button>
    </div>
    <div class="lr-list" role="listbox" aria-label="Станции">
      ${STATIONS.map(s => `<button type="button" class="lr-st" data-lr-st="${s.id}" role="option"><b>${esc(s.name)}</b><small>${esc(s.note)}</small></button>`).join("")}
    </div>
    <label class="lr-row"><span>Громкость</span><input type="range" min="0" max="1" step="0.01" data-lr-vol value="${volume}"></label>
    <label class="lr-row"><span>🌧 Дождь</span><input type="range" min="0" max="1" step="0.01" data-lr-rain value="${rain}"></label>
    <label class="lr-row"><span>💿 Винил</span><input type="range" min="0" max="1" step="0.01" data-lr-crackle value="${crackle}"></label>`;
}

function openPanel() {
  const panel = $("#lofi-panel");
  if (!panel.dataset.built) {
    panel.innerHTML = panelHtml();
    panel.dataset.built = "1";
    panel.querySelector("[data-lr-play]").addEventListener("click", toggle);
    panel.querySelectorAll("[data-lr-st]").forEach(b => b.addEventListener("click", () => pick(b.dataset.lrSt)));
    panel.querySelector("[data-lr-vol]").addEventListener("input", e => { volume = +e.target.value; audio.volume = volume; applyAmbience(); save(); });
    panel.querySelector("[data-lr-rain]").addEventListener("input", e => { rain = +e.target.value; if (rain) ensureAmbience(); applyAmbience(); save(); });
    panel.querySelector("[data-lr-crackle]").addEventListener("input", e => { crackle = +e.target.value; if (crackle) ensureAmbience(); applyAmbience(); save(); });
  }
  panel.hidden = false;
  $("#lofi-btn").setAttribute("aria-expanded", "true");
  render();
}
function closePanel() {
  const panel = $("#lofi-panel");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  $("#lofi-btn").setAttribute("aria-expanded", "false");
}

$("#lofi-btn")?.addEventListener("click", e => {
  e.stopPropagation();
  $("#lofi-panel").hidden ? openPanel() : closePanel();
});
document.addEventListener("click", e => { if (!e.target.closest(".lr-wrap")) closePanel(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closePanel(); });

export function toggleLofi() { toggle(); }
