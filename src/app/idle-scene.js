// Экран ожидания: если программой не пользуются N минут (по умолчанию 5), поверх всего встаёт живая сцена —
// холм с травой под небом, днём облака и солнце, ночью луна и светлячки. Сезон — из настроек оформления:
// зимой снег, весной сакура и лепестки, осенью листопад, на Хэллоуин — багровое дерево и оранжевые огоньки. Трава качается от ветра и
// расступается под курсором, примятая полоса медленно выпрямляется. Любая клавиша или «Вернуться» — назад.
// Всё рисуется WebGL2 без библиотек: небо — полноэкранный треугольник, трава — инстансы лезвий (позиции и
// изгиб считает вершинный шейдер), след курсора — маленькая текстура «примятости», которую обновляет JS.
// Сцена не стартует, пока окно свёрнуто, не в фокусе или играет видео/звук, а без фокуса замирает.

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
const BLADES = 80000;

// Сезон — тот же, что в Настройках → Внешний вид (season.js, :root[data-season]); «Выкл.» — лето.
// Цвета травы, земли и кроны, снег, высота травы, доля цветов, оттенок неба и что летает:
// fall 0 — светлячки и пыльца, 1 — снег, 2 — лепестки или листья (кружатся и падают).
const SEASON_LOOKS = {
  summer: {
    root: [0.07, 0.18, 0.04], tip: [0.42, 0.7, 0.2], tip2: [0.6, 0.78, 0.28], ground: [0.09, 0.2, 0.05],
    leaf: [0.1, 0.22, 0.07], leafHi: [0.3, 0.48, 0.16], snow: 0, height: 1, flowers: 0.014, sky: [1, 1, 1],
    fall: 0, flyDay: [1, 1, 0.92], flyNight: [0.85, 1, 0.45], flySize: [0.035, 0.11],
    crown: 1, fallen: 0, mist: 0, layers: [[0, 220, "field"], [3, 14, "near"]],
  },
  spring: {
    root: [0.08, 0.2, 0.05], tip: [0.5, 0.8, 0.28], tip2: [0.66, 0.86, 0.36], ground: [0.11, 0.23, 0.06],
    leaf: [0.9, 0.58, 0.7], leafHi: [1, 0.84, 0.9], snow: 0, height: 0.85, flowers: 0.045, sky: [1.02, 1, 1.03],
    fall: 2, flyDay: [1, 0.76, 0.86], flyNight: [0.8, 0.6, 0.75], flySize: [0.05, 0.05],
    crown: 1, fallen: 0, mist: 0, layers: [[2, 150, "field"], [2, 70, "tree"], [3, 16, "near"]],
  },
  autumn: {
    root: [0.12, 0.13, 0.04], tip: [0.74, 0.6, 0.22], tip2: [0.62, 0.42, 0.14], ground: [0.17, 0.15, 0.06],
    leaf: [0.78, 0.3, 0.08], leafHi: [0.96, 0.64, 0.16], snow: 0, height: 0.9, flowers: 0, sky: [1.05, 0.98, 0.9],
    fall: 2, flyDay: [0.95, 0.52, 0.16], flyNight: [0.6, 0.32, 0.14], flySize: [0.065, 0.065],
    crown: 0.72, fallen: 1, mist: 0, layers: [[2, 130, "field"], [2, 80, "tree"]],
  },
  winter: {
    root: [0.3, 0.36, 0.32], tip: [0.86, 0.9, 0.95], tip2: [0.76, 0.83, 0.87], ground: [0.86, 0.9, 0.96],
    leaf: [0.2, 0.21, 0.23], leafHi: [0.95, 0.97, 1], snow: 0.8, height: 0.45, flowers: 0, sky: [0.92, 0.97, 1.06],
    fall: 1, flyDay: [1, 1, 1], flyNight: [0.82, 0.88, 1], flySize: [0.045, 0.045],
    crown: 0, fallen: 0, mist: 0, layers: [[1, 400, "field"]],
  },
  halloween: {
    root: [0.1, 0.1, 0.04], tip: [0.55, 0.45, 0.18], tip2: [0.45, 0.3, 0.12], ground: [0.13, 0.11, 0.06],
    leaf: [0.34, 0.06, 0.08], leafHi: [0.62, 0.16, 0.1], snow: 0, height: 0.9, flowers: 0, sky: [1, 0.86, 1.1],
    fall: 0, flyDay: [1, 0.72, 0.32], flyNight: [1, 0.55, 0.15], flySize: [0.04, 0.12],
    crown: 0.5, fallen: 1, mist: 1, hat: 1, layers: [[0, 140, "field"], [4, 7, "field"], [5, 10, "bats"]],
  },
};
// Где роятся частицы слоя: всё поле, у дерева (сыплется с кроны), рядом с камерой (бабочки), тыквы у камеры, мыши у дерева
const AREAS_INIT = { field: [0, -6, 1, 1], tree: [1.8, -16.5, 0.12, 0.2], near: [0.3, -1, 0.35, 0.3], bats: [1.8, -16.5, 1, 1] };

function moonPhase(date = new Date()) {
  const days = (date.getTime() - Date.UTC(2000, 0, 6, 18, 14)) / 86400000;
  return ((days / 29.530588) % 1 + 1) % 1;   // 0 — новолуние, 0.5 — полнолуние
}
function seasonLook() {
  return SEASON_LOOKS[document.documentElement.dataset.season] || SEASON_LOOKS.summer;
}
const FLIES = 400;
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
uniform float uNight, uSnow, uFlowers, uFallen, uMist;
uniform vec3 uGround, uRoot, uTip, uTip2, uLeaf, uLeafHi;
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
uniform float uTime, uNight, uAspect, uHorizon, uSnow, uPhase;
uniform vec3 uSkyTint;
${NOISE_GLSL}
void main() {
  vec2 uv = vUv;
  float h = clamp((uv.y - uHorizon) / (1.0 - uHorizon), 0.0, 1.0);
  vec3 day = mix(vec3(0.80, 0.88, 0.95), vec3(0.30, 0.56, 0.88), pow(h, 0.7)) * uSkyTint;
  vec3 night = mix(vec3(0.10, 0.17, 0.36), vec3(0.02, 0.05, 0.15), pow(h, 0.8)) * mix(vec3(1.0), uSkyTint, 0.6);
  vec3 c = mix(day, night, uNight);
  vec2 sp = vec2(uv.x * uAspect, uv.y);
  // Звёзды
  vec2 cell = floor(sp * 90.0);
  vec2 inCell = fract(sp * 90.0) - 0.5 - (vec2(hash(cell + 1.7), hash(cell + 5.3)) - 0.5) * 0.6;
  float star = step(0.993, hash(cell)) * smoothstep(0.16, 0.0, length(inCell)) * (0.6 + 0.4 * sin(uTime * 2.0 + hash(cell + 3.0) * 30.0));
  c += vec3(0.8, 0.85, 1.0) * star * uNight * smoothstep(0.05, 0.3, h);
  // Луна: настоящая фаза по дате, моря и кратеры, пепельный свет на тёмной стороне, ореол; медленно плывёт
  vec2 moon = vec2((0.66 + 0.012 * sin(uTime * 0.013)) * uAspect, uHorizon + 0.2 + 0.006 * sin(uTime * 0.011));
  float R = 0.026;
  vec2 q = (sp - moon) / R;
  float r2 = dot(q, q);
  float lit = 0.5 + 0.5 * cos((uPhase - 0.5) * 6.2832);   // доля освещённого диска
  if (r2 < 1.0) {
    vec3 n = vec3(q, sqrt(1.0 - r2));
    float a = uPhase * 6.2832;
    vec3 L = vec3(sin(a), 0.0, -cos(a));
    float day = smoothstep(-0.06, 0.06, dot(n, L));
    float maria = smoothstep(0.45, 0.7, fbm(q * 1.7 + 3.0));
    float craters = smoothstep(0.62, 0.7, noise(q * 6.0 + 11.0)) * 0.5;
    vec3 surf = vec3(0.96, 0.95, 0.9) * (1.0 - 0.28 * maria - 0.15 * craters) * (0.75 + 0.25 * n.z);
    vec3 m = mix(vec3(0.07, 0.09, 0.14), surf, day);
    c = mix(c, m, uNight * smoothstep(1.0, 0.94, r2));
  }
  float md = length(sp - moon);
  c += uNight * vec3(0.35, 0.45, 0.75) * (0.03 / (md * 5.0 + 0.04)) * (0.3 + 0.7 * lit) * (0.92 + 0.08 * sin(uTime * 0.7));
  // Солнце днём: мягкое сияние и медленно вращающиеся лучи
  vec2 sun = vec2(0.18 * uAspect, 1.05);
  vec2 sv = sp - sun;
  float sd = length(sv);
  float ang = atan(sv.y, sv.x);
  float rays = pow(0.5 + 0.5 * sin(ang * 14.0 + uTime * 0.05), 6.0) * 0.5 + pow(0.5 + 0.5 * sin(ang * 9.0 - uTime * 0.04 + 1.0), 8.0) * 0.4;
  c += (1.0 - uNight) * vec3(1.0, 0.95, 0.85) * (0.15 / (sd * 3.0 + 0.4) + rays * 0.12 * smoothstep(0.9, 0.0, sd));
  // Облака
  vec2 cp = vec2(sp.x * 1.6 + uTime * 0.008, sp.y * 3.2);
  float cl = fbm(cp * 1.4) * 0.65 + fbm(cp * 3.3 + 7.0) * 0.35;
  float cover = smoothstep(0.5, 0.78, cl) * smoothstep(0.02, 0.25, h);
  vec3 cloud = mix(vec3(1.0, 1.0, 1.0), vec3(0.22, 0.29, 0.48), uNight);
  float rim = uNight * (0.25 + 0.75 * lit) * smoothstep(0.35, 0.0, length(sp - moon)) * smoothstep(0.85, 0.5, cover) * cover;
  c = mix(c, cloud * (0.86 + 0.14 * cl), cover * mix(0.9, 0.55, uNight));
  c += vec3(0.55, 0.62, 0.8) * rim * 0.9;
  // Дальние холмы в дымке у горизонта
  float far = uHorizon + 0.025 + 0.02 * fbm(vec2(sp.x * 2.5, 1.0)) + 0.012 * sin(sp.x * 3.0);
  vec3 farc = mix(mix(vec3(0.50, 0.66, 0.52), vec3(0.86, 0.9, 0.95), uSnow) * mix(vec3(1.0), uSkyTint, 2.0), vec3(0.06, 0.12, 0.2), uNight);
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
uniform float uTime;
${NOISE_GLSL}
${SHADE_GLSL}
void main() {
  vec3 c = uGround * (0.75 + 0.5 * noise(vXZ * 0.8));
  // Снег: сугробы (мягкие тени) и искорки, которые вспыхивают на солнце и под луной
  float drift = fbm(vXZ * 0.35);
  vec3 snow = vec3(0.9, 0.94, 1.0) * (0.82 + 0.25 * drift) + vec3(0.0, 0.02, 0.06) * (1.0 - drift);
  vec2 g = floor(vXZ * 45.0);
  float glint = step(0.994, hash(g)) * pow(0.5 + 0.5 * sin(uTime * 2.5 + hash(g + 4.0) * 40.0), 8.0);
  c = mix(c, snow + glint * 0.8, uSnow);
  c = mix(c, mix(uLeaf, uLeafHi, noise(vXZ * 4.0)), uFallen * step(0.62, noise(vXZ * 5.0)) * 0.8);
  c = nightTint(c);
  c = mix(c, mix(vec3(0.62, 0.58, 0.7), vec3(0.16, 0.13, 0.24), uNight), uMist * 0.6);
  o = vec4(fog(c, vD), 1.0);
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
uniform float uHeight;
uniform vec3 uClear[8];   // x, z, радиус: где трава примята (тыквы)
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
  float h = (0.3 + 0.32 * fract(seed * 7.13)) * (1.0 + d * 0.02) * uHeight;
  for (int i = 0; i < 8; i++) if (uClear[i].z > 0.0) h *= mix(0.18, 1.0, smoothstep(uClear[i].z * 0.45, uClear[i].z, distance(base.xz, uClear[i].xy)));
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
  vec3 root = uRoot;
  vec3 tip = mix(uTip, uTip2, fract(vSeed * 13.7));
  vec3 c = mix(root, tip, smoothstep(0.0, 1.0, vT));
  if (vSeed > 1.0 - uFlowers && vT > 0.82) {
    float k = fract(vSeed * 91.0);
    c = k < 0.4 ? vec3(0.92, 0.55, 0.75) : k < 0.75 ? vec3(0.7, 0.55, 0.95) : vec3(0.98, 0.88, 0.4);
  }
  c *= 0.92 + 0.16 * fract(vSeed * 3.1);
  // Осень: у корней опавшие листья; зима: иней по кончикам; Хэллоуин: туман стелется по земле
  c = mix(c, mix(uLeaf, uLeafHi, fract(vSeed * 29.0)), uFallen * step(0.72, fract(vSeed * 7.7)) * (1.0 - smoothstep(0.12, 0.35, vT)));
  c = mix(c, vec3(0.95, 0.97, 1.0), uSnow * smoothstep(0.7, 1.0, vT) * step(0.4, fract(vSeed * 5.3)) * 0.6);
  c = nightTint(c);
  c = mix(c, mix(vec3(0.62, 0.58, 0.7), vec3(0.16, 0.13, 0.24), uNight), uMist * (1.0 - smoothstep(0.0, 0.75, vT)) * 0.65);
  // Примятая трава подсвечивается: днём чуть светлее, ночью — мерцающим светом
  c += vPress * vT * mix(vec3(0.08, 0.1, 0.04), vec3(0.35, 0.7, 0.4), uNight);
  o = vec4(fog(c, vD), 1.0);
}`;

const TREE_VS = `#version 300 es
in vec2 aCorner;
uniform mat4 uVP;
uniform vec3 uEye;
uniform vec3 uTree;
uniform float uTime;
out vec2 vUv;
out float vD;
void main() {
  vUv = aCorner;
  // Всё дерево чуть гнётся по ветру: верх сильнее, порывы волнами
  float gust = 0.5 + 0.5 * sin(uTime * 0.6 + 1.3) * sin(uTime * 0.23);
  float bendX = (sin(uTime * 0.9) * 0.05 + gust * 0.09) * aCorner.y * aCorner.y;
  vec3 p = uTree + vec3(aCorner.x * 1.9 + bendX, aCorner.y * 4.2 - 0.2, 0.0);
  vD = distance(p, uEye);
  gl_Position = uVP * vec4(p, 1.0);
}`;
const TREE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in float vD;
out vec4 o;
uniform float uTime, uCrown, uHat;
${NOISE_GLSL}
${SHADE_GLSL}
float seg(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}
void main() {
  vec2 p = vUv;
  vec2 asp = vec2(1.0, 2.2);   // квадрат 3.8 × 4.2 м — круг в мировых единицах
  // Ветки качаются: чем выше и дальше от ствола, тем сильнее; у каждой свой ритм
  vec2 sw = vec2(sin(uTime * 1.3 + p.y * 3.0) * 0.012, 0.0) * p.y;
  vec2 q = p - sw;
  float wood = seg(q * asp, vec2(0.0, 0.0), vec2(0.03, 0.62) * asp, 0.09, 0.04);
  wood = min(wood, seg(q * asp, vec2(0.0, 0.42) * asp, vec2(-0.42, 0.72) * asp, 0.035, 0.012));
  wood = min(wood, seg(q * asp, vec2(0.02, 0.48) * asp, vec2(0.44, 0.76) * asp, 0.035, 0.012));
  wood = min(wood, seg(q * asp, vec2(0.02, 0.58) * asp, vec2(-0.16, 0.94) * asp, 0.03, 0.01));
  wood = min(wood, seg(q * asp, vec2(0.03, 0.6) * asp, vec2(0.22, 0.92) * asp, 0.03, 0.01));
  wood = min(wood, seg(q * asp, vec2(-0.24, 0.6) * asp, vec2(-0.62, 0.66) * asp, 0.018, 0.007));
  wood = min(wood, seg(q * asp, vec2(0.26, 0.64) * asp, vec2(0.6, 0.63) * asp, 0.018, 0.007));
  wood = min(wood, seg(q * asp, vec2(-0.3, 0.66) * asp, vec2(-0.36, 0.86) * asp, 0.012, 0.005));
  wood = min(wood, seg(q * asp, vec2(0.3, 0.7) * asp, vec2(0.4, 0.88) * asp, 0.012, 0.005));
  // Крона — грозди листвы, каждая качается со своим запаздыванием; листья шелестят (шум бежит по времени)
  float crown = 1e3, shade = 0.0;
  vec3 C[9] = vec3[9](vec3(0.0, 0.74, 0.3), vec3(-0.42, 0.68, 0.22), vec3(0.44, 0.7, 0.22), vec3(0.1, 0.9, 0.2),
                      vec3(-0.2, 0.86, 0.2), vec3(0.3, 0.84, 0.19), vec3(-0.6, 0.64, 0.14), vec3(0.6, 0.64, 0.14), vec3(0.0, 0.6, 0.2));
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    vec2 c = C[i].xy + vec2(sin(uTime * (1.1 + fi * 0.13) + fi * 1.7), cos(uTime * (0.9 + fi * 0.11) + fi)) * vec2(0.018, 0.006) * C[i].y;
    vec2 d = (p - c) * vec2(1.0, 1.55);
    float k = length(d) - C[i].z * (0.55 + 0.45 * uCrown);
    if (k < crown) { crown = k; shade = dot(normalize(d + 1e-4), normalize(vec2(-0.5, 0.85))); }
  }
  float rustle = fbm(p * 11.0 + vec2(uTime * 0.35, uTime * 0.12));
  crown += (rustle - 0.5) * 0.14 + (1.0 - uCrown) * 0.06;
  // Осенью и в Хэллоуин крона редкая — сквозь неё видны ветки
  crown += step(uCrown, fbm(p * 7.0 + 5.0) * 1.2) * 0.2 * (1.0 - uCrown);
  if (uCrown < 0.01) crown = 1e3;
  // Шляпа ведьмы: нитка от ветки, острый конус с загнутой вниз-вбок макушкой, широкие поля, оранжевая лента
  float hat = 1e3, band = 0.0, thread = 1e3;
  if (uHat > 0.5) {
    vec2 pivot = vec2(0.44, 0.76) * asp;
    float th = sin(uTime * 1.2) * 0.18 + sin(uTime * 0.47) * 0.08;
    vec2 l = q * asp - pivot;
    l = mat2(cos(th), -sin(th), sin(th), cos(th)) * l / 1.8;
    thread = abs(l.x) - 0.004 + step(0.0, l.y) + step(l.y, -0.14);
    vec2 h = l - vec2(0.0, -0.36);   // центр полей
    float cone = max(abs(h.x) - mix(0.085, 0.006, clamp((h.y) / 0.22, 0.0, 1.0)), max(-h.y, h.y - 0.22));
    float tip = length((h - vec2(0.03, 0.235)) * vec2(1.0, 1.4)) - 0.02;
    float brim = length(h * vec2(1.0, 5.5)) - 0.17;
    hat = min(min(cone, tip), brim);
    band = step(0.018, h.y) * step(h.y, 0.045) * step(cone, 0.0);
  }
  float a = smoothstep(0.012, -0.012, min(min(wood, crown), min(hat, thread)));
  if (a < 0.02) discard;
  if (min(hat, thread) < min(wood, crown)) {
    vec3 hc = thread < hat ? vec3(0.75, 0.72, 0.65) : mix(vec3(0.24, 0.1, 0.34), vec3(1.0, 0.55, 0.12), band);
    hc *= 0.85 + 0.25 * smoothstep(-0.1, 0.1, (q.x - 0.44) * asp.x);
    o = vec4(fog(mix(hc, nightTint(hc), 0.6) + band * uNight * vec3(0.45, 0.2, 0.0), vD), a);
    return;
  }
  vec3 leaf = mix(uLeaf, uLeafHi, smoothstep(-0.4, 0.9, shade + (rustle - 0.5) * 0.6));
  leaf *= 0.78 + 0.3 * smoothstep(0.4, 1.0, p.y);
  vec3 bark = vec3(0.22, 0.15, 0.1) * (0.8 + 0.4 * noise(p * vec2(30.0, 6.0)));
  vec3 c = crown < wood ? leaf : bark;
  // Снег лежит на верхней стороне веток и кроны
  float topSide = smoothstep(0.0, -0.02, crown < wood ? crown + 0.03 : wood + 0.012 * asp.y);
  c = mix(c, vec3(0.94, 0.96, 1.0), uSnow * (crown < wood ? smoothstep(0.55, 0.9, p.y + fbm(p * 11.0) * 0.25) : step(0.5, noise(p * 40.0)) * 0.9));
  o = vec4(fog(nightTint(c), vD), a);
}`;

const FLY_VS = `#version 300 es
in vec4 aFly;   // x ∈ [-12, 12], z ∈ [-15, 3], высота над травой, случайное число
uniform mat4 uVP;
uniform vec3 uEye;
uniform float uTime, uNight, uPx, uFall;
uniform vec2 uFlySize;
uniform vec4 uArea;   // центр x, z и масштаб по x, z — куда сжать облако частиц (у дерева, у камеры)
out float vGlow;
out float vSeed;
out float vFlap;
${HILL_GLSL}
void main() {
  float s = aFly.w;
  vec3 p = vec3(uArea.x + aFly.x / 12.0 * uArea.z * 12.0, 0.0, uArea.y + (aFly.y + 6.0) / 9.0 * uArea.w * 9.0);
  float size = mix(uFlySize.x, uFlySize.y, uNight);
  if (uFall < 0.5) {
    // Светлячки ночью, пыльца днём: плавают над травой
    p += vec3(sin(uTime * 0.3 + s * 10.0) * 0.7, 0.0, cos(uTime * 0.27 + s * 5.0) * 0.7);
    p.y = hill(p.xz) + aFly.z + sin(uTime * 0.5 + s * 7.0) * 0.25;
    float blink = pow(0.5 + 0.5 * sin(uTime * (0.8 + s) + s * 20.0), 3.0);
    vGlow = mix(0.3, blink, uNight);
  } else if (uFall < 2.5) {
    // Падают и кружатся: снег медленнее и прямее, листья и лепестки качает сильнее
    float sway = uFall > 1.5 ? 0.6 : 0.25;
    p.x += sin(uTime * (1.1 + s) + s * 9.0) * sway;
    p.z += cos(uTime * (0.7 + s) + s * 4.0) * sway * 0.5;
    p.y = hill(p.xz) + 4.0 - mod(uTime * (uFall > 1.5 ? 0.45 : 0.32) * (0.7 + 0.6 * s) + s * 9.0, 4.2);
    size *= 0.6 + 0.8 * fract(s * 17.0);
    vGlow = mix(0.95, 0.7, uNight);
  } else if (uFall < 3.5) {
    // Бабочки: порхают над травой днём, ночью прячутся
    p += vec3(sin(uTime * 0.35 + s * 10.0) * 1.6, 0.0, cos(uTime * 0.29 + s * 7.0) * 1.2);
    p.y = hill(p.xz) + 0.35 + 0.25 * sin(uTime * 1.7 + s * 3.0) + abs(sin(uTime * 3.1 + s * 9.0)) * 0.12;
    size = 0.09;
    vGlow = 1.0 - uNight;
  } else if (uFall > 4.5) {
    // Летучие мыши: кружат над деревом рваными петлями, иногда пролетают на фоне луны
    float w = 0.55 + 0.35 * s;
    float a = uTime * w + s * 6.2832;
    float R = 1.8 + 2.5 * fract(s * 7.0);
    p = vec3(uArea.x + cos(a) * R + sin(uTime * 1.7 + s * 9.0) * 0.4,
             0.0,
             uArea.y + sin(a) * R * 0.7);
    p.y = hill(uArea.xy) + 3.6 + sin(a * 2.0 + s * 3.0) * 0.9 + sin(uTime * 3.1 + s * 11.0) * 0.15;
    size = 0.42;
    vGlow = 1.0;
  } else {
    // Тыквы: стоят в траве, ночью внутри горит свеча
    p.y = hill(p.xz) + 0.34;
    size = 0.75;
    vGlow = 1.0;
  }
  float d = distance(p, uEye);
  vSeed = s;
  vFlap = uFall > 4.5 ? sin(uTime * 16.0 + s * 40.0) : abs(sin(uTime * 13.0 + s * 40.0));
  gl_PointSize = clamp(size * uPx / d, 1.0, 90.0);
  gl_Position = uVP * vec4(p, 1.0);
}`;
const FLY_FS = `#version 300 es
precision highp float;
in float vGlow;
in float vSeed;
in float vFlap;
out vec4 o;
uniform float uNight, uFall;
uniform vec3 uFlyDay, uFlyNight;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r = length(q) * 2.0;
  vec3 c = mix(uFlyDay, uFlyNight, uNight);
  float a;
  if (uFall > 4.5) {
    // Летучая мышь: тело, уши, крылья с зубчатым краем, машут вверх-вниз
    vec2 b = q * 2.0;
    float flap = vFlap;
    float ax = abs(b.x);
    float wingY = flap * 0.35 * ax;
    float wing = step(ax, 0.95) * step(b.y, 0.12 + wingY - 0.18 * ax) * step(-0.05 + wingY - 0.25 * ax + 0.08 * abs(sin(ax * 14.0)), b.y);
    float body = smoothstep(0.2, 0.16, length(b * vec2(1.6, 1.0)));
    float ears = step(abs(ax - 0.07), 0.035) * step(b.y, -0.12) * step(-0.26, b.y);
    a = min(1.0, wing + body + ears);
    c = mix(vec3(0.06, 0.04, 0.08), vec3(0.03, 0.02, 0.05), uNight);
  } else if (uFall > 3.5) {
    // Тыква: рёбра, хвостик, ночью — светящиеся глаза и улыбка
    vec2 b = q * vec2(2.0, 2.5) + vec2(0.0, 0.12);
    float body = smoothstep(1.0, 0.92, length(b * vec2(0.8, 1.0)));
    float ribs = 0.75 + 0.25 * abs(sin(b.x * 6.0));
    vec3 pumpkin = vec3(0.95, 0.45, 0.08) * ribs * mix(1.0, 0.35, uNight);
    float stem = step(abs(q.x + 0.02), 0.04) * step(q.y, -0.28) * step(-0.42, q.y);
    vec2 e = abs(q - vec2(0.0, -0.02)) - vec2(0.13, 0.0);
    float eyes = smoothstep(0.07, 0.05, length(e));
    float mouth = step(abs(q.y - 0.14), 0.035 + 0.02 * sin(q.x * 40.0)) * step(abs(q.x), 0.2);
    float face = max(eyes, mouth) * body;
    c = mix(pumpkin, vec3(0.2, 0.4, 0.1), stem);
    c = mix(c, vec3(1.0, 0.8, 0.3), face * (0.4 + 0.6 * uNight));
    a = max(body, stem);
    c += vec3(1.0, 0.5, 0.1) * uNight * 0.25 * smoothstep(1.0, 0.0, r);
    a = max(a, uNight * 0.3 * smoothstep(1.0, 0.3, r));
  } else if (uFall > 2.5) {
    // Бабочка: два крыла, складываются в такт взмаху; окраска своя у каждой
    float k = fract(vSeed * 7.0);
    vec3 wing = k < 0.3 ? vec3(1.0, 0.98, 0.9) : k < 0.55 ? vec3(1.0, 0.82, 0.25) : k < 0.8 ? vec3(0.98, 0.55, 0.2) : vec3(0.45, 0.7, 1.0);
    vec2 w = vec2(abs(q.x) / (0.12 + 0.88 * vFlap), q.y);
    float wings = smoothstep(0.5, 0.42, length((w - vec2(0.25, -0.05)) * vec2(1.0, 1.3))) + smoothstep(0.32, 0.25, length(w - vec2(0.2, 0.22)));
    float body = step(abs(q.x), 0.03) * step(abs(q.y), 0.22);
    c = mix(wing * (0.85 + 0.3 * smoothstep(0.4, 0.0, length(w - vec2(0.25, 0.0)))), vec3(0.15, 0.12, 0.1), body);
    a = min(1.0, wings + body) * vGlow;
  } else if (uFall > 1.5) {
    // Лепесток или лист: плотная капля, у каждого свой оттенок
    vec2 l = q * vec2(2.0, 3.2);
    a = smoothstep(1.0, 0.8, length(l)) * vGlow;
    c *= 0.75 + 0.5 * fract(vSeed * 13.0);
  } else if (uFall > 0.5) {
    a = smoothstep(1.0, 0.35, r) * vGlow;   // снежинка — мягкая
  } else {
    a = pow(max(1.0 - r, 0.0), 2.2) * vGlow;   // светлячок — свечение
  }
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
function camera(aspect) {
  const z = norm(sub(EYE, TARGET));
  const x = norm(cross([0, 1, 0], z));
  const y = cross(z, x);
  const view = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, EYE), -dot(y, EYE), -dot(z, EYE), 1];
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
  // Тыквы стоят на заранее выбранных местах переднего плана (в кадре, не друг за другом); трава вокруг примята
  const PUMPKINS = [[-1.7, 1.9], [1.5, 2.3], [-0.3, 0.7], [2.7, 0.1], [-2.9, -0.5], [0.9, -1.3], [-1.3, -2.7]];
  const clear = new Float32Array(24);
  {
    let first = 0;
    for (const [mode, count] of seasonLook().layers) {
      if (mode === 4) {
        PUMPKINS.slice(0, count).forEach(([x, z], i) => {
          const j = (first + i) % FLIES;
          fl[j * 4] = x; fl[j * 4 + 1] = z;
          clear.set([x, z, 1.0], i * 3);
        });
      }
      first = (first + count) % FLIES;
    }
  }
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

  let cam = camera(1), aspect = 1, horizon = 0.42;
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    aspect = canvas.width / canvas.height;
    cam = camera(aspect);
    const crest = [0, hill(0, -16), -16, 1];
    const v = cam.vp;
    const cy = v[1] * crest[0] + v[5] * crest[1] + v[9] * crest[2] + v[13];
    const cw = v[3] * crest[0] + v[7] * crest[1] + v[11] * crest[2] + v[15];
    horizon = (cy / cw) * 0.5 + 0.5;
  }

  // Луч из камеры через точку экрана (0..1) — до пересечения с холмом
  function pick(sx, sy) {
    const t = Math.tan(FOV / 2);
    const nx = (sx * 2 - 1) * t * aspect, ny = (1 - sy * 2) * t;
    const dir = norm([cam.x[0] * nx + cam.y[0] * ny - cam.z[0], cam.x[1] * nx + cam.y[1] * ny - cam.z[1], cam.x[2] * nx + cam.y[2] * ny - cam.z[2]]);
    for (let s = 0.5; s < 40; s += 0.05) {
      const px = EYE[0] + dir[0] * s, py = EYE[1] + dir[1] * s, pz = EYE[2] + dir[2] * s;
      if (py <= hill(px, pz) + 0.15) return [px, pz];
    }
    return null;
  }

  // Юниформы сезона: каждой программе — те, что у неё есть
  const look = seasonLook();
  const phase = moonPhase();
  const AREAS = AREAS_INIT;
  function seasonUniforms(prog) {
    const u = prog.u;
    const v3 = { uRoot: look.root, uTip: look.tip, uTip2: look.tip2, uGround: look.ground, uLeaf: look.leaf, uLeafHi: look.leafHi, uSkyTint: look.sky, uFlyDay: look.flyDay, uFlyNight: look.flyNight };
    for (const [name, v] of Object.entries(v3)) if (u[name]) gl.uniform3fv(u[name], v);
    if (u.uSnow) gl.uniform1f(u.uSnow, look.snow);
    if (u.uFlowers) gl.uniform1f(u.uFlowers, look.flowers);
    if (u.uHeight) gl.uniform1f(u.uHeight, look.height);
    if (u.uFall) gl.uniform1f(u.uFall, look.fall);
    if (u.uFlySize) gl.uniform2fv(u.uFlySize, look.flySize);
    if (u.uCrown) gl.uniform1f(u.uCrown, look.crown);
    if (u.uFallen) gl.uniform1f(u.uFallen, look.fallen);
    if (u.uMist) gl.uniform1f(u.uMist, look.mist);
    if (u.uHat) gl.uniform1f(u.uHat, look.hat || 0);
    if (u.uPhase) gl.uniform1f(u.uPhase, phase);
  }

  function draw(time, dt, night, cursor) {
    uploadTrample(dt);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(sky.p);
    seasonUniforms(sky);
    gl.uniform1f(sky.u.uTime, time);
    gl.uniform1f(sky.u.uNight, night);
    gl.uniform1f(sky.u.uAspect, aspect);
    gl.uniform1f(sky.u.uHorizon, horizon);
    gl.bindVertexArray(skyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.useProgram(ground.p);
    seasonUniforms(ground);
    gl.uniformMatrix4fv(ground.u.uVP, false, cam.vp);
    gl.uniform3fv(ground.u.uEye, EYE);
    gl.uniform1f(ground.u.uNight, night);
    gl.uniform1f(ground.u.uTime, time);
    gl.bindVertexArray(groundVao);
    gl.drawElements(gl.TRIANGLES, groundCount, gl.UNSIGNED_INT, 0);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(tree.p);
    seasonUniforms(tree);
    gl.uniformMatrix4fv(tree.u.uVP, false, cam.vp);
    gl.uniform3fv(tree.u.uEye, EYE);
    gl.uniform3f(tree.u.uTree, TREE[0], hill(TREE[0], TREE[1]), TREE[1]);
    gl.uniform1f(tree.u.uNight, night);
    gl.uniform1f(tree.u.uTime, time);
    gl.bindVertexArray(treeVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);

    gl.useProgram(grass.p);
    seasonUniforms(grass);
    gl.uniformMatrix4fv(grass.u.uVP, false, cam.vp);
    gl.uniform3fv(grass.u.uEye, EYE);
    gl.uniform1f(grass.u.uTime, time);
    gl.uniform1f(grass.u.uNight, night);
    gl.uniform4f(grass.u.uTrRect, ...TR_RECT);
    if (grass.u["uClear[0]"]) gl.uniform3fv(grass.u["uClear[0]"], clear);
    gl.uniform4f(grass.u.uCursor, cursor ? cursor[0] : 999, cursor ? cursor[1] : 999, cursor ? 1 : 0, 0.9);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, trTex);
    gl.uniform1i(grass.u.uTrample, 0);
    gl.bindVertexArray(grassVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 11, BLADES);

    gl.enable(gl.BLEND);
    gl.depthMask(false);
    gl.useProgram(flies.p);
    seasonUniforms(flies);
    gl.uniformMatrix4fv(flies.u.uVP, false, cam.vp);
    gl.uniform3fv(flies.u.uEye, EYE);
    gl.uniform1f(flies.u.uTime, time);
    gl.uniform1f(flies.u.uNight, night);
    gl.uniform1f(flies.u.uPx, canvas.height / (2 * Math.tan(FOV / 2)));
    gl.bindVertexArray(flyVao);
    let first = 0;
    for (const [mode, count, area] of look.layers) {
      // Светлячки и снег светятся (сложение), листья, бабочки и тыквы — обычная прозрачность
      if (mode === 0 || mode === 1) gl.blendFunc(gl.SRC_ALPHA, gl.ONE); else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(flies.u.uFall, mode);
      gl.uniform4fv(flies.u.uArea, AREAS[area]);
      gl.drawArrays(gl.POINTS, first, Math.min(count, FLIES - first));
      first = (first + count) % FLIES;
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  function dispose() { gl.getExtension("WEBGL_lose_context")?.loseContext(); }

  return { resize, pick, stamp, draw, dispose };
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
    scene.draw((now - t0) / 1000, dt, night, cursor);
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
    setTimeout(() => { scene.dispose(); box.remove(); }, 600);
  }

  box.addEventListener("pointermove", onMove);
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
