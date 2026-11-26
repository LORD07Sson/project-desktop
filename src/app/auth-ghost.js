// Ghost arms and legs for the sign-in logo dance: a glowing see-through silhouette of the reference dancer,
// drawn under the logo frame by frame in step with its CSS animation (auth-dance-a / auth-dance-b).
import ghostUrl from "../assets/dance-ghost.webp";
import { GHOST, GHOST_AX, GHOST_AY } from "./auth-ghost-data.js";

let canvas = null, ctx = null, tint = null, tctx = null, sprite = null, raf = 0, logo = null;

export function startGhost(img) {
  logo = img;
  if (raf || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (!sprite) { sprite = new Image(); sprite.src = ghostUrl; }
  if (!canvas) {
    canvas = document.createElement("canvas");
    canvas.className = "auth-ghost";
    canvas.setAttribute("aria-hidden", "true");
    ctx = canvas.getContext("2d");
    tint = document.createElement("canvas");
    tctx = tint.getContext("2d");
  }
  if (canvas.parentElement !== img.parentElement) img.parentElement.prepend(canvas);
  const loop = () => {
    if (!logo || !logo.isConnected || logo.closest("[hidden]")) { raf = 0; clear(); return; }
    raf = requestAnimationFrame(loop);
    draw();
  };
  raf = requestAnimationFrame(loop);
}

function clear() {
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function draw() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const box = logo.parentElement.getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) {
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
  }
  canvas.style.left = `${-box.left}px`;
  canvas.style.top = `${-box.top}px`;
  canvas.style.width = `${vw}px`;
  canvas.style.height = `${vh}px`;
  clear();

  const anim = logo.getAnimations?.()[0];
  const p = anim?.effect?.getComputedTiming().progress;
  if (p == null || !sprite.complete || !sprite.naturalWidth) return;
  const start = GHOST.rest + GHOST.fly, end = start + GHOST.dance;
  // fade in while landing, fade out as it leaves
  const alpha = Math.max(0, Math.min(1, (p - (start - GHOST.fly * .5)) / (GHOST.fly * .5), (end + .05 - p) / .05));
  if (alpha <= 0) return;

  const second = logo.classList.contains("dance-b");
  const count = second ? GHOST.frames - GHOST.half : GHOST.half;
  const k = Math.max(0, Math.min(1, (p - start) / GHOST.dance));
  const i = (second ? GHOST.half : 0) + Math.round(k * (count - 1));

  const tsz = parseFloat(logo.style.getPropertyValue("--tsz")) || 200;
  const r = logo.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hf = tsz / GHOST.d, wf = hf * GHOST.aspect;
  const x = cx - GHOST_AX[i] * wf, y = cy - GHOST_AY[i] * hf;

  // white silhouette -> soft blue-lilac gradient, then onto the page with a glow
  const w = Math.ceil(wf * dpr), h = Math.ceil(hf * dpr);
  if (tint.width !== w || tint.height !== h) { tint.width = w; tint.height = h; }
  tctx.globalCompositeOperation = "source-over";
  tctx.clearRect(0, 0, w, h);
  tctx.drawImage(sprite, (i % GHOST.cols) * GHOST.cellW, Math.floor(i / GHOST.cols) * GHOST.cellH, GHOST.cellW, GHOST.cellH, 0, 0, w, h);
  tctx.globalCompositeOperation = "source-in";
  const g = tctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "rgba(205, 220, 255, 1)");
  g.addColorStop(.55, "rgba(160, 175, 255, .9)");
  g.addColorStop(1, "rgba(150, 120, 255, .35)");
  tctx.fillStyle = g;
  tctx.fillRect(0, 0, w, h);

  ctx.save();
  ctx.globalAlpha = alpha * .5;
  ctx.shadowColor = "rgba(150, 180, 255, .95)";
  ctx.shadowBlur = 22 * dpr;
  ctx.drawImage(tint, x * dpr, y * dpr);
  ctx.restore();
}
