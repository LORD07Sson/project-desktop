// Экран ожидания: если программой не пользуются N минут (по умолчанию 5), поверх всего встаёт живая сцена —
// холм с травой под небом, днём облака и солнце, ночью луна и светлячки. Трава качается от ветра и
// расступается под курсором, примятая полоса медленно выпрямляется. Любая клавиша или «Вернуться» — назад.
// Всё рисуется WebGL2 без библиотек: небо — полноэкранный треугольник, трава — инстансы лезвий (позиции и
// изгиб считает вершинный шейдер), след курсора — маленькая текстура «примятости», которую обновляет JS.
// Сцена не стартует, пока окно свёрнуто, не в фокусе или играет видео/звук, а без фокуса замирает.

import { API_BASE } from "./api.js";

const PREF_KEY = "project-idle-scene";
export const IDLE_CHOICES = [["off", "Выключен"], ["5", "5 мин"], ["10", "10 мин"], ["15", "15 мин"]];

export function idleSceneMinutes() {
  try { return localStorage.getItem(PREF_KEY) || "5"; } catch (_) { return "5"; }
}
export function setIdleSceneMinutes(value) {
  try { localStorage.setItem(PREF_KEY, value); } catch (_) { /* приватный режим — останется по умолчанию */ }
}

// ---------- геометрия сцены (одна и та же формула холма в JS и в шейдерах) ----------

const HILL_GLSL = `
float hill(vec2 p) {
  float ridge = 3.0 * exp(-pow((p.y + 16.0) / 8.5, 2.0));
  float side = 1.0 - 0.18 * clamp(abs(p.x) / 22.0, 0.0, 1.0);
  float roll = 0.35 * sin(p.x * 0.17 + 0.8) * exp(-pow((p.y + 12.0) / 10.0, 2.0));
  return ridge * side + roll;
}`;
function hill(x, z) {
  const ridge = 3.0 * Math.exp(-(((z + 16.0) / 8.5) ** 2));
  const side = 1.0 - 0.18 * Math.min(Math.abs(x) / 22.0, 1.0);
  const roll = 0.35 * Math.sin(x * 0.17 + 0.8) * Math.exp(-(((z + 12.0) / 10.0) ** 2));
  return ridge * side + roll;
}

const EYE = [0, 0.8, 6];
const TARGET = [0, 4.2, -16];
const FOV = Math.PI / 4;
const TREE = [1.8, -16.5];
// Где сидит героиня (idle-heroine.js): справа на переднем плане, вполоборота к нам; трава под ней примята
const HERO = { x: 1.1, z: 1.7, yaw: -0.5 };
const BLADES = 80000;
const FLIES = 220;
// Текстура примятости покрывает луг: x ∈ [-22, 22], z ∈ [-20, 4]
const TR_W = 192, TR_H = 96, TR_RECT = [-22, -20, 44, 24];

const NOISE_GLSL = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}`;

// Общий хвост фрагментных шейдеров: ночной тон и дымка к горизонту.
const SHADE_GLSL = `
uniform float uNight;
vec3 nightTint(vec3 c) { return mix(c, c * vec3(0.22, 0.4, 0.62) + vec3(0.0, 0.02, 0.05), uNight); }
vec3 fog(vec3 c, float d) {
  vec3 haze = mix(vec3(0.78, 0.86, 0.93), vec3(0.08, 0.13, 0.27), uNight);
  return mix(c, haze, clamp(pow(d / 55.0, 2.0) * 0.7, 0.0, 0.7));
}`;

const SKY_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.999, 1.0);
}`;
const SKY_FS = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform float uTime, uNight, uAspect, uHorizon;
${NOISE_GLSL}
void main() {
  vec2 uv = vUv;
  float h = clamp((uv.y - uHorizon) / (1.0 - uHorizon), 0.0, 1.0);
  vec3 day = mix(vec3(0.80, 0.88, 0.95), vec3(0.30, 0.56, 0.88), pow(h, 0.7));
  vec3 night = mix(vec3(0.10, 0.17, 0.36), vec3(0.02, 0.05, 0.15), pow(h, 0.8));
  vec3 c = mix(day, night, uNight);
  vec2 sp = vec2(uv.x * uAspect, uv.y);
  // Звёзды
  vec2 cell = floor(sp * 90.0);
  vec2 inCell = fract(sp * 90.0) - 0.5 - (vec2(hash(cell + 1.7), hash(cell + 5.3)) - 0.5) * 0.6;
  float star = step(0.993, hash(cell)) * smoothstep(0.16, 0.0, length(inCell)) * (0.6 + 0.4 * sin(uTime * 2.0 + hash(cell + 3.0) * 30.0));
  c += vec3(0.8, 0.85, 1.0) * star * uNight * smoothstep(0.05, 0.3, h);
  // Луна ночью, мягкое солнце днём
  vec2 moon = vec2(0.66 * uAspect, uHorizon + 0.2);
  float md = length(sp - moon);
  c += uNight * (vec3(0.95, 0.97, 1.0) * smoothstep(0.022, 0.018, md) + vec3(0.35, 0.45, 0.75) * 0.06 / (md * 6.0 + 0.05) * 0.4);
  vec2 sun = vec2(0.18 * uAspect, 1.05);
  float sd = length(sp - sun);
  c += (1.0 - uNight) * vec3(1.0, 0.95, 0.85) * 0.25 / (sd * 3.0 + 0.4) * 0.6;
  // Облака
  vec2 cp = vec2(sp.x * 1.6 + uTime * 0.008, sp.y * 3.2);
  float cl = fbm(cp * 1.4) * 0.65 + fbm(cp * 3.3 + 7.0) * 0.35;
  float cover = smoothstep(0.5, 0.78, cl) * smoothstep(0.02, 0.25, h);
  vec3 cloud = mix(vec3(1.0, 1.0, 1.0), vec3(0.22, 0.29, 0.48), uNight);
  c = mix(c, cloud * (0.86 + 0.14 * cl), cover * mix(0.9, 0.55, uNight));
  // Дальние холмы в дымке у горизонта
  float far = uHorizon + 0.025 + 0.02 * fbm(vec2(sp.x * 2.5, 1.0)) + 0.012 * sin(sp.x * 3.0);
  vec3 farc = mix(vec3(0.50, 0.66, 0.52), vec3(0.06, 0.12, 0.2), uNight);
  c = mix(c, farc, smoothstep(far + 0.006, far - 0.01, uv.y) * 0.6);
  o = vec4(c, 1.0);
}`;

const GROUND_VS = `#version 300 es
in vec2 aXZ;
uniform mat4 uVP;
uniform vec3 uEye;
out float vD;
out vec2 vXZ;
${HILL_GLSL}
void main() {
  vec3 p = vec3(aXZ.x, hill(aXZ) - 0.02, aXZ.y);
  vD = distance(p, uEye);
  vXZ = aXZ;
  gl_Position = uVP * vec4(p, 1.0);
}`;
const GROUND_FS = `#version 300 es
precision highp float;
in float vD;
in vec2 vXZ;
out vec4 o;
${NOISE_GLSL}
${SHADE_GLSL}
void main() {
  vec3 c = vec3(0.09, 0.2, 0.05) * (0.75 + 0.5 * noise(vXZ * 0.8));
  o = vec4(fog(nightTint(c), vD), 1.0);
}`;

const GRASS_VS = `#version 300 es
in vec2 aVert;        // x — доля высоты лезвия (0..1), y — сторона (-1..1, у кончика 0)
in vec4 aInst;        // x, z, случайное число, поворот
uniform mat4 uVP;
uniform vec3 uEye;
uniform float uTime;
uniform sampler2D uTrample;
uniform vec4 uTrRect;
uniform vec4 uCursor; // x, z, сила, радиус
uniform vec3 uSeat;   // x, z, радиус: где сидит героиня
out float vT;
out float vSeed;
out float vPress;
out float vD;
${HILL_GLSL}
void main() {
  float t = aVert.x;
  vec3 base = vec3(aInst.x, hill(aInst.xy), aInst.y);
  float d = distance(base.xz, uEye.xz);
  float seed = aInst.z;
  float h = (0.3 + 0.32 * fract(seed * 7.13)) * (1.0 + d * 0.02);
  h *= mix(0.12, 1.0, smoothstep(uSeat.z * 0.5, uSeat.z, length((base.xz - uSeat.xy) * vec2(1.0, 0.55))));
  float w = (0.03 + d * 0.0035) * (1.0 - t * 0.85);
  vec2 side = vec2(cos(aInst.w), sin(aInst.w));

  float gust = 0.25 + 0.2 * sin(uTime * 0.6 + base.x * 0.12 - base.z * 0.05) + 0.12 * sin(uTime * 2.3 + seed * 12.0);
  vec2 lean = normalize(vec2(1.0, 0.25)) * gust * 0.4;

  vec4 tr = texture(uTrample, (base.xz - uTrRect.xy) / uTrRect.zw);
  vec2 tdir = tr.rg * 2.0 - 1.0;
  float press = tr.b;
  lean += tdir * press * 1.15;

  vec2 dv = base.xz - uCursor.xy;
  float cd = length(dv);
  float push = uCursor.z * smoothstep(uCursor.w, 0.0, cd);
  lean += (cd > 0.001 ? dv / cd : vec2(0.0)) * push * 1.1;
  float ll = length(lean);
  if (ll > 1.25) lean *= 1.25 / ll;

  float bend = min(length(lean), 1.0);
  vec2 horiz = lean * t * t * h;
  float up = h * t * (1.0 - 0.4 * bend * t);
  vec3 p = base + vec3(side.x * w * aVert.y, 0.0, side.y * w * aVert.y) + vec3(horiz.x, up, horiz.y);

  vT = t;
  vSeed = seed;
  vPress = max(press, push);
  vD = distance(p, uEye);
  gl_Position = uVP * vec4(p, 1.0);
}`;
const GRASS_FS = `#version 300 es
precision highp float;
in float vT;
in float vSeed;
in float vPress;
in float vD;
out vec4 o;
${SHADE_GLSL}
void main() {
  vec3 root = vec3(0.07, 0.18, 0.04);
  vec3 tip = mix(vec3(0.42, 0.7, 0.2), vec3(0.6, 0.78, 0.28), fract(vSeed * 13.7));
  vec3 c = mix(root, tip, smoothstep(0.0, 1.0, vT));
  if (vSeed > 0.986 && vT > 0.82) {
    float k = fract(vSeed * 91.0);
    c = k < 0.4 ? vec3(0.92, 0.55, 0.75) : k < 0.75 ? vec3(0.7, 0.55, 0.95) : vec3(0.98, 0.88, 0.4);
  }
  c *= 0.92 + 0.16 * fract(vSeed * 3.1);
  c = nightTint(c);
  // Примятая трава подсвечивается: днём чуть светлее, ночью — мерцающим светом
  c += vPress * vT * mix(vec3(0.08, 0.1, 0.04), vec3(0.35, 0.7, 0.4), uNight);
  o = vec4(fog(c, vD), 1.0);
}`;

const TREE_VS = `#version 300 es
in vec2 aCorner;
uniform mat4 uVP;
uniform vec3 uEye;
uniform vec3 uTree;
out vec2 vUv;
out float vD;
void main() {
  vUv = aCorner;
  vec3 p = uTree + vec3(aCorner.x * 1.9, aCorner.y * 4.2 - 0.2, 0.0);
  vD = distance(p, uEye);
  gl_Position = uVP * vec4(p, 1.0);
}`;
const TREE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in float vD;
out vec4 o;
${NOISE_GLSL}
${SHADE_GLSL}
void main() {
  vec2 p = vUv;
  float trunk = max(abs(p.x + 0.04 * sin(p.y * 6.0)) - 0.05 * (1.25 - p.y), p.y - 0.7);
  float crown = min(min(length((p - vec2(0.0, 0.74)) * vec2(0.8, 1.3)) - 0.3,
                        length((p - vec2(-0.45, 0.66)) * vec2(1.0, 1.6)) - 0.24),
                    min(length((p - vec2(0.46, 0.68)) * vec2(1.0, 1.6)) - 0.24,
                        length((p - vec2(0.08, 0.88)) * vec2(1.0, 1.5)) - 0.2));
  crown += (fbm(p * 9.0) - 0.5) * 0.12;
  float a = smoothstep(0.012, -0.012, min(trunk, crown));
  if (a < 0.02) discard;
  vec3 leaf = mix(vec3(0.1, 0.22, 0.07), vec3(0.3, 0.48, 0.16), smoothstep(0.5, 1.0, p.y + fbm(p * 14.0) * 0.3));
  vec3 c = crown < trunk ? leaf : vec3(0.22, 0.15, 0.1);
  o = vec4(fog(nightTint(c), vD), a);
}`;

const FLY_VS = `#version 300 es
in vec4 aFly;   // x, z, высота над травой, случайное число
uniform mat4 uVP;
uniform vec3 uEye;
uniform float uTime, uNight, uPx;
out float vGlow;
${HILL_GLSL}
void main() {
  float s = aFly.w;
  vec3 p = vec3(aFly.x, 0.0, aFly.y);
  p += vec3(sin(uTime * 0.3 + s * 10.0) * 0.7, 0.0, cos(uTime * 0.27 + s * 5.0) * 0.7);
  p.y = hill(p.xz) + aFly.z + sin(uTime * 0.5 + s * 7.0) * 0.25;
  float d = distance(p, uEye);
  float blink = pow(0.5 + 0.5 * sin(uTime * (0.8 + s) + s * 20.0), 3.0);
  float size = mix(0.035, 0.11, uNight);
  vGlow = mix(0.3, blink, uNight);
  gl_PointSize = clamp(size * uPx / d, 1.0, 40.0);
  gl_Position = uVP * vec4(p, 1.0);
}`;
const FLY_FS = `#version 300 es
precision highp float;
in float vGlow;
out vec4 o;
uniform float uNight;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = pow(max(1.0 - r, 0.0), 2.2) * vGlow;
  vec3 c = mix(vec3(1.0, 1.0, 0.92), vec3(0.85, 1.0, 0.45), uNight);
  o = vec4(c, a);
}`;

// ---------- матрицы ----------

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}
function camera(aspect, eye, target) {
  const z = norm(sub(eye, target));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  const view = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
  const f = 1 / Math.tan(FOV / 2), near = 0.1, far = 120;
  const proj = [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
  return { vp: mul(proj, view), x, y, z };
}

// ---------- WebGL ----------

function program(gl, vs, fs) {
  const make = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}
function buffer(gl, prog, name, data, size, divisor = 0) {
  const loc = gl.getAttribLocation(prog.p, name);
  const b = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, b);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  if (divisor) gl.vertexAttribDivisor(loc, divisor);
}

function buildScene(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, powerPreference: "low-power" });
  if (!gl) return null;
  const sky = program(gl, SKY_VS, SKY_FS);
  const ground = program(gl, GROUND_VS, GROUND_FS);
  const grass = program(gl, GRASS_VS, GRASS_FS);
  const tree = program(gl, TREE_VS, TREE_FS);
  const flies = program(gl, FLY_VS, FLY_FS);


  const skyVao = gl.createVertexArray();

  const groundVao = gl.createVertexArray();
  gl.bindVertexArray(groundVao);
  const GX = 120, GZ = 90, gv = [], gi = [];
  for (let j = 0; j <= GZ; j++) for (let i = 0; i <= GX; i++) gv.push(-34 + 68 * i / GX, -32 + 38 * j / GZ);
  for (let j = 0; j < GZ; j++) for (let i = 0; i < GX; i++) {
    const a = j * (GX + 1) + i, b = a + 1, c = a + GX + 1, d = c + 1;
    gi.push(a, c, b, b, c, d);
  }
  buffer(gl, ground, "aXZ", new Float32Array(gv), 2);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(gi), gl.STATIC_DRAW);
  const groundCount = gi.length;

  const grassVao = gl.createVertexArray();
  gl.bindVertexArray(grassVao);
  const blade = [];
  for (let k = 0; k < 5; k++) { const t = k / 5; blade.push(t, -1, t, 1); }
  blade.push(1, 0);
  buffer(gl, grass, "aVert", new Float32Array(blade), 2);
  const inst = new Float32Array(BLADES * 4);
  for (let i = 0; i < BLADES; i++) {
    const d = 2.5 + 21.5 * Math.pow(Math.random(), 1.35);
    const x = (Math.random() * 2 - 1) * (0.85 * d + 1);
    inst.set([x, EYE[2] - d, Math.random(), Math.random() * Math.PI], i * 4);
  }
  buffer(gl, grass, "aInst", inst, 4, 1);

  const treeVao = gl.createVertexArray();
  gl.bindVertexArray(treeVao);
  buffer(gl, tree, "aCorner", new Float32Array([-1, 0, 1, 0, -1, 1, 1, 1]), 2);

  const flyVao = gl.createVertexArray();
  gl.bindVertexArray(flyVao);
  const fl = new Float32Array(FLIES * 4);
  for (let i = 0; i < FLIES; i++) fl.set([(Math.random() * 2 - 1) * 12, 3 - Math.random() * 18, 0.15 + Math.random() * 1.4, Math.random()], i * 4);
  buffer(gl, flies, "aFly", fl, 4);
  gl.bindVertexArray(null);

  // Примятость: r,g — направление наклона, b — сила. Пишется из JS каждый кадр.
  const trTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, trTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TR_W, TR_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const strength = new Float32Array(TR_W * TR_H);
  const dirX = new Float32Array(TR_W * TR_H);
  const dirZ = new Float32Array(TR_W * TR_H);
  const pixels = new Uint8Array(TR_W * TR_H * 4);

  function stamp(x, z, mx, mz) {
    const ml = Math.hypot(mx, mz);
    if (ml < 0.01) return;
    const r = 0.95;
    const cx = (x - TR_RECT[0]) / TR_RECT[2] * TR_W, cz = (z - TR_RECT[1]) / TR_RECT[3] * TR_H;
    const rx = r / TR_RECT[2] * TR_W, rz = r / TR_RECT[3] * TR_H;
    for (let j = Math.max(0, Math.floor(cz - rz)); j <= Math.min(TR_H - 1, Math.ceil(cz + rz)); j++) {
      for (let i = Math.max(0, Math.floor(cx - rx)); i <= Math.min(TR_W - 1, Math.ceil(cx + rx)); i++) {
        const dx = (i - cx) / rx, dz = (j - cz) / rz;
        const f = 1 - Math.hypot(dx, dz);
        if (f <= 0) continue;
        const k = j * TR_W + i;
        if (f > strength[k] * 0.6) {
          const ox = mx / ml * 0.7 + dx * 0.5, oz = mz / ml * 0.7 + dz * 0.5;
          const ol = Math.hypot(ox, oz) || 1;
          dirX[k] = ox / ol; dirZ[k] = oz / ol;
        }
        strength[k] = Math.max(strength[k], Math.min(1, f * 1.6));
      }
    }
  }
  function uploadTrample(dt) {
    const keep = Math.pow(0.9935, dt * 60);
    for (let k = 0; k < strength.length; k++) {
      const s = strength[k] *= keep;
      pixels[k * 4] = (dirX[k] * 0.5 + 0.5) * 255;
      pixels[k * 4 + 1] = (dirZ[k] * 0.5 + 0.5) * 255;
      pixels[k * 4 + 2] = s * 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, trTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TR_W, TR_H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  }

  // Камера подвижна: приветствие героини наезжает к ней и отъезжает обратно (showIdleScene → setView)
  const view = { eye: [...EYE], target: [...TARGET] };
  let cam = camera(1, view.eye, view.target), aspect = 1, horizon = 0.42;
  function setView(eye, target) {
    view.eye = eye;
    view.target = target;
    cam = camera(aspect, eye, target);
    const crest = [0, hill(0, -16), -16, 1];
    const v = cam.vp;
    const cy = v[1] * crest[0] + v[5] * crest[1] + v[9] * crest[2] + v[13];
    const cw = v[3] * crest[0] + v[7] * crest[1] + v[11] * crest[2] + v[15];
    horizon = cw > 0 ? (cy / cw) * 0.5 + 0.5 : -1;
  }
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    aspect = canvas.width / canvas.height;
    setView(view.eye, view.target);
  }

  // Луч из камеры через точку экрана (0..1) — до пересечения с холмом
  function pick(sx, sy) {
    const t = Math.tan(FOV / 2);
    const nx = (sx * 2 - 1) * t * aspect, ny = (1 - sy * 2) * t;
    const dir = norm([cam.x[0] * nx + cam.y[0] * ny - cam.z[0], cam.x[1] * nx + cam.y[1] * ny - cam.z[1], cam.x[2] * nx + cam.y[2] * ny - cam.z[2]]);
    for (let s = 0.5; s < 40; s += 0.05) {
      const px = view.eye[0] + dir[0] * s, py = view.eye[1] + dir[1] * s, pz = view.eye[2] + dir[2] * s;
      if (py <= hill(px, pz) + 0.15) return [px, pz];
    }
    return null;
  }

  function draw(time, dt, night, cursor, heroine) {
    uploadTrample(dt);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(sky.p);
    gl.uniform1f(sky.u.uTime, time);
    gl.uniform1f(sky.u.uNight, night);
    gl.uniform1f(sky.u.uAspect, aspect);
    gl.uniform1f(sky.u.uHorizon, horizon);
    gl.bindVertexArray(skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.useProgram(ground.p);
    gl.uniformMatrix4fv(ground.u.uVP, false, cam.vp);
    gl.uniform3fv(ground.u.uEye, view.eye);
    gl.uniform1f(ground.u.uNight, night);
    gl.bindVertexArray(groundVao);
    gl.drawElements(gl.TRIANGLES, groundCount, gl.UNSIGNED_INT, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(tree.p);
    gl.uniformMatrix4fv(tree.u.uVP, false, cam.vp);
    gl.uniform3fv(tree.u.uEye, view.eye);
    gl.uniform3f(tree.u.uTree, TREE[0], hill(TREE[0], TREE[1]), TREE[1]);
    gl.uniform1f(tree.u.uNight, night);
    gl.bindVertexArray(treeVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);

    if (heroine) {
      heroine.render(canvas.width, canvas.height, view.eye, view.target);
      gl.enable(gl.DEPTH_TEST);
    }

    gl.useProgram(grass.p);
    gl.uniformMatrix4fv(grass.u.uVP, false, cam.vp);
    gl.uniform3fv(grass.u.uEye, view.eye);
    gl.uniform1f(grass.u.uTime, time);
    gl.uniform1f(grass.u.uNight, night);
    gl.uniform4f(grass.u.uTrRect, ...TR_RECT);
    gl.uniform3f(grass.u.uSeat, HERO.x, HERO.z + 0.45, 1.05);
    gl.uniform4f(grass.u.uCursor, cursor ? cursor[0] : 999, cursor ? cursor[1] : 999, cursor ? 1 : 0, 0.9);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, trTex);
    gl.uniform1i(grass.u.uTrample, 0);
    gl.bindVertexArray(grassVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 11, BLADES);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.useProgram(flies.p);
    gl.uniformMatrix4fv(flies.u.uVP, false, cam.vp);
    gl.uniform3fv(flies.u.uEye, view.eye);
    gl.uniform1f(flies.u.uTime, time);
    gl.uniform1f(flies.u.uNight, night);
    gl.uniform1f(flies.u.uPx, canvas.height / (2 * Math.tan(FOV / 2)));
    gl.bindVertexArray(flyVao);
    gl.drawArrays(gl.POINTS, 0, FLIES);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  function dispose() { gl.getExtension("WEBGL_lose_context")?.loseContext(); }

  return { gl, resize, setView, pick, stamp, draw, dispose };
}

// ---------- экран ----------

let lastActive = Date.now();
let current = null;

const nightByClock = () => { const h = new Date().getHours(); return h < 6 || h >= 19; };
const pad2 = n => String(n).padStart(2, "0");

function mediaPlaying() {
  return [...document.querySelectorAll("video, audio")].some(m => !m.paused && !m.ended && m.readyState > 2);
}

export function showIdleScene() {
  if (current) return;
  const box = document.createElement("div");
  box.className = "idle-scene";
  box.innerHTML = `<canvas></canvas>
    <div class="idle-top"><b data-idle-clock></b><span data-idle-away></span><button type="button" class="idle-back" data-idle-back>Вернуться</button></div>
    <div class="idle-bottom">
      <div class="idle-seg" role="group"><button type="button" data-idle-mode="day">☀ День</button><button type="button" data-idle-mode="night">☾ Ночь</button></div>
      <span class="idle-hint">Проведите мышью по траве · любая клавиша — назад</span>
    </div>`;
  document.body.appendChild(box);
  const canvas = box.querySelector("canvas");
  let scene;
  try { scene = buildScene(canvas); } catch (error) { console.warn("Экран ожидания: WebGL не поднялся", error); }
  if (!scene) { box.remove(); return; }

  let heroine = null;
  let camEye = [...EYE];
  let greetT = -1;   // сколько секунд героиня здоровается (по кадрам; -1 — не здоровается). Камера наезжает, она машет, отъезжает
  import("./idle-heroine.js")
    .then(m => m.loadHeroine({ gl: scene.gl, canvas, url: `${API_BASE}/desktop/idle-model`, place: { x: HERO.x, y: hill(HERO.x, HERO.z), z: HERO.z, yaw: HERO.yaw }, eye: EYE, target: TARGET }))
    .then(h => { if (current) { heroine = h; greetT = 0; } else h.dispose(); })
    .catch(error => console.warn("Экран ожидания: героиня не загрузилась", error));

  const since = lastActive;
  let night = nightByClock() ? 1 : 0, nightGoal = night;
  let cursor = null, lastHit = null, raf = 0, prev = window.performance.now(), t0 = prev;
  const clock = box.querySelector("[data-idle-clock]");
  const away = box.querySelector("[data-idle-away]");
  const syncMode = () => box.querySelectorAll("[data-idle-mode]").forEach(b => b.classList.toggle("on", (b.dataset.idleMode === "night") === (nightGoal === 1)));
  const tickText = () => {
    const now = new Date();
    clock.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    away.textContent = `нет на месте ${Math.max(1, Math.round((Date.now() - since) / 60000))} мин`;
  };
  syncMode();
  tickText();
  const textTimer = setInterval(tickText, 15000);

  const frame = now => {
    const dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    night += (nightGoal - night) * Math.min(1, dt * 1.6);
    const time = (now - t0) / 1000;
    let greet = null;
    if (heroine && greetT >= 0) {
      const g = greetT += dt;
      const ease = x => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
      const near = g < 1.4 ? ease(g / 1.4) : g < 5 ? 1 : 1 - ease((g - 5) / 2.6);
      greet = { t: g, w: g < 4.6 ? ease((g - 0.9) / 0.5) : 1 - ease((g - 4.6) / 0.8), eye: camEye };
      // Крупный план: камера в метре перед лицом, чуть сбоку, смотрит в лицо
      const headPos = heroine.headPosition();
      const close = [headPos[0] - 0.36, headPos[1] - 0.04, headPos[2] + 1.25];
      const face = [headPos[0] + 0.05, headPos[1] - 0.12, headPos[2]];
      camEye = EYE.map((v, i) => v + (close[i] - v) * near);
      scene.setView(camEye, TARGET.map((v, i) => v + (face[i] - v) * near));
      if (g > 7.8) { greetT = -1; camEye = [...EYE]; scene.setView(camEye, [...TARGET]); }
    }
    heroine?.update(dt, time, night, cursor, hill, greet);
    scene.draw(time, dt, night, cursor, heroine);
    raf = document.hidden || !document.hasFocus() ? 0 : requestAnimationFrame(frame);
  };
  const resume = () => { if (!raf && current) { prev = window.performance.now(); raf = requestAnimationFrame(frame); } };
  const onResize = () => scene.resize();
  const onMove = e => {
    if (e.target !== canvas) { cursor = null; return; }
    const r = canvas.getBoundingClientRect();
    const hit = scene.pick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (hit && lastHit) scene.stamp(hit[0], hit[1], hit[0] - lastHit[0], hit[1] - lastHit[1]);
    cursor = hit;
    lastHit = hit;
  };
  const onKey = e => { e.preventDefault(); e.stopPropagation(); close(); };

  function close() {
    if (!current) return;
    current = null;
    cancelAnimationFrame(raf);
    clearInterval(textTimer);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("focus", resume);
    document.removeEventListener("visibilitychange", resume);
    lastActive = Date.now();
    box.classList.remove("on");
    setTimeout(() => { heroine?.dispose(); scene.dispose(); box.remove(); }, 600);
  }

  box.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", e => {
    if (!heroine || greetT >= 0) return;
    const r = canvas.getBoundingClientRect();
    const hit = scene.pick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    if (hit && Math.hypot(hit[0] - HERO.x, hit[1] - HERO.z) < 0.9) greetT = 0;
  });
  box.addEventListener("pointerleave", () => { cursor = null; lastHit = null; });
  box.addEventListener("wheel", close, { passive: true });
  box.querySelector("[data-idle-back]").addEventListener("click", close);
  box.querySelectorAll("[data-idle-mode]").forEach(b => b.addEventListener("click", () => { nightGoal = b.dataset.idleMode === "night" ? 1 : 0; syncMode(); }));
  window.addEventListener("resize", onResize);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", resume);

  current = { close };
  scene.resize();
  requestAnimationFrame(() => box.classList.add("on"));
  raf = requestAnimationFrame(frame);
}

for (const type of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) {
  window.addEventListener(type, () => { if (!current) lastActive = Date.now(); }, { capture: true, passive: true });
}

setInterval(() => {
  const minutes = Number(idleSceneMinutes());
  if (current || !minutes || document.hidden || !document.hasFocus()) return;
  if (mediaPlaying()) { lastActive = Date.now(); return; }
  if (Date.now() - lastActive >= minutes * 60000) showIdleScene();
}, 5000);
