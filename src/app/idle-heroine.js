// 3D-героиня экрана ожидания (idle-scene.js): своя модель VRM, собранная в VRoid («Звездочёт»), лежит на
// сервере (/api/desktop/idle-model) и качается один раз — дальше её держит кэш браузера. Модуль грузится
// лениво вместе с three.js, только когда сцена показана. Рисует в тот же WebGL-контекст, что и луг: общий
// буфер глубины, поэтому трава перед ней закрывает ноги.
//
// Сценарий: сидит в траве; при появлении экрана (и по клику) встаёт, подходит к камере, машет и улыбается,
// потом возвращается и садится. Ткань и волосы — пружины VRM, мягче и тяжелее, чем в модели по умолчанию.
//
// Анимация процедурная, слоями: базовая поза сидя → «жизнь» (дыхание, покачивание, пальцы) → случайное
// действие (потянуться, покачаться, наклонить голову, поболтать ногами, оглянуться на луну) → приветствие.
// Итог по каждой кости ведёт пружина (вторая производная, с перелётом и затуханием) — поэтому движения
// разгоняются и тормозят как у живого тела, а не переключаются. Взгляд живёт отдельно: глаза быстрые,
// голова догоняет медленнее; сама выбирает, куда смотреть, и следит за курсором.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const MOON = new THREE.Vector3(14, 12, -40);
const TAU = Math.PI * 2;
const FINGERS = ["Index", "Middle", "Ring", "Little"];

// Базовая поза сидя (нормализованные кости VRM 1.0, модель смотрит на +Z): колени к груди, руки их обнимают.
const BASE = {
  hips: [0, 0, 0],
  spine: [0.18, 0, 0],
  chest: [0.08, 0, 0],
  upperChest: [0, 0, 0],
  neck: [0, 0, 0],
  head: [0, 0, 0],
  leftShoulder: [0, 0, 0],
  rightShoulder: [0, 0, 0],
  leftUpperLeg: [-1.75, 0.12, 0.08],
  rightUpperLeg: [-1.75, -0.12, -0.08],
  leftLowerLeg: [2.3, 0, 0],
  rightLowerLeg: [2.3, 0, 0],
  leftFoot: [-0.4, 0, 0],
  rightFoot: [-0.4, 0, 0],
  leftUpperArm: [0, -0.75, -1.05],
  rightUpperArm: [0, 0.75, 1.05],
  leftLowerArm: [0, -1.1, 0],
  rightLowerArm: [0, 1.1, 0],
  leftHand: [0, 0, -0.1],
  rightHand: [0, 0, 0.1],
};

// Насколько согнуты пальцы (0 — прямые, 1 — кулак). Левая кисть сгибается вокруг Z в минус, правая — в плюс.
const CASCADE = [0.78, 0.95, 1.08, 1.2];   // указательный ... мизинец
function curlFingers(t, side, amount, spread = 0) {
  const s = side === "left" ? -1 : 1;
  const relaxed = 0.12;   // живая кисть никогда не бывает совсем прямой
  FINGERS.forEach((f, i) => {
    const k = relaxed + amount * CASCADE[i];
    t[`${side}${f}Proximal`] = [0, (i - 1.5) * spread * 0.14 * -s, s * k * 0.8];
    t[`${side}${f}Intermediate`] = [0, 0, s * k * 1.15];
    t[`${side}${f}Distal`] = [0, 0, s * k * 0.7];
  });
  t[`${side}ThumbMetacarpal`] = [0, s * (-0.25 - 0.3 * amount), s * 0.12];
  t[`${side}ThumbProximal`] = [0, s * -0.25 * amount, s * 0.2 * amount];
  t[`${side}ThumbDistal`] = [0, s * -0.3 * amount, 0];
}

// Пружина второго порядка: тянется к цели с частотой f (Гц) и затуханием z (<1 — с лёгким перелётом).
class Spring {
  constructor(value) { this.x = [...value]; this.v = [0, 0, 0]; }
  step(target, dt, f, z) {
    const w = TAU * f;
    for (let i = 0; i < 3; i++) {
      this.v[i] += (w * w * (target[i] - this.x[i]) - 2 * z * w * this.v[i]) * dt;
      this.x[i] += this.v[i] * dt;
    }
    return this.x;
  }
}

const ease = x => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };
// Огибающая действия длиной len: плавный вход и выход
const envelope = (t, len, fadeIn = 0.6, fadeOut = 0.8) => Math.min(ease(t / fadeIn), ease((len - t) / fadeOut));
const mix = (t, name, value, k) => {
  const a = t[name] || [0, 0, 0];
  t[name] = [a[0] + (value[0] - a[0]) * k, a[1] + (value[1] - a[1]) * k, a[2] + (value[2] - a[2]) * k];
};
const add = (t, name, d) => { const a = t[name] || [0, 0, 0]; t[name] = [a[0] + d[0], a[1] + d[1], a[2] + d[2]]; };

// Случайные действия, пока никто не трогает: каждое правит цели поз и выражение лица.
const ACTIONS = {
  stretch: {
    len: 3.6,
    apply(t, p, k, face) {
      mix(t, "leftUpperArm", [0, -0.2, 1.3], k);
      mix(t, "rightUpperArm", [0, 0.2, -1.3], k);
      mix(t, "leftLowerArm", [0, -0.2, 0.25], k);
      mix(t, "rightLowerArm", [0, 0.2, -0.25], k);
      add(t, "spine", [-0.22 * k, 0, 0]);
      add(t, "head", [-0.25 * k, 0, 0]);
      curlFingers(t, "left", 0.1);
      curlFingers(t, "right", 0.1);
      face.happy += 0.7 * k;
      face.oh += 0.35 * k * Math.sin(Math.min(1, p * 1.4) * Math.PI);
      return { lookUp: k };
    },
  },
  rock: {
    len: 5,
    apply(t, p, k) {
      const r = Math.sin(p * TAU * 2.5) * 0.11 * k;
      add(t, "spine", [r, 0, 0]);
      add(t, "hips", [r * 0.5, 0, 0]);
      add(t, "leftLowerArm", [0, -0.12 * k, 0]);
      add(t, "rightLowerArm", [0, 0.12 * k, 0]);
      curlFingers(t, "left", 0.75);
      curlFingers(t, "right", 0.75);
      return {};
    },
  },
  tilt: {
    len: 3,
    apply(t, p, k, face) {
      add(t, "head", [0.05 * k, 0, 0.28 * k]);
      add(t, "neck", [0, 0, 0.1 * k]);
      face.relaxed += 0.35 * k;
      return {};
    },
  },
  feet: {
    len: 3.4,
    apply(t, p, k) {
      const a = Math.sin(p * TAU * 4) * 0.16 * k;
      add(t, "leftLowerLeg", [a, 0, 0]);
      add(t, "rightLowerLeg", [-a, 0, 0]);
      add(t, "leftFoot", [a * 0.8, 0, 0]);
      add(t, "rightFoot", [-a * 0.8, 0, 0]);
      add(t, "spine", [0, 0, Math.sin(p * TAU * 2) * 0.03 * k]);
      return {};
    },
  },
  moon: {
    len: 4.5,
    apply(t, p, k, face) {
      add(t, "chest", [-0.05 * k, 0.32 * k, 0]);
      add(t, "spine", [0, 0.18 * k, 0]);
      face.relaxed += 0.25 * k;
      return { forceLook: MOON };
    },
  },
};
const ACTION_NAMES = Object.keys(ACTIONS);

// Стоя: руки вдоль тела, локти чуть согнуты, ноги прямые
const STAND = {
  hips: [0, 0, 0], spine: [0.03, 0, 0], chest: [0, 0, 0], upperChest: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0],
  leftShoulder: [0, 0, 0], rightShoulder: [0, 0, 0],
  leftUpperLeg: [-0.03, 0, 0.03], rightUpperLeg: [-0.03, 0, -0.03],
  leftLowerLeg: [0.06, 0, 0], rightLowerLeg: [0.06, 0, 0], leftFoot: [-0.03, 0, 0], rightFoot: [-0.03, 0, 0],
  leftUpperArm: [0.06, 0, -1.22], rightUpperArm: [0.06, 0, 1.22],
  leftLowerArm: [0, -0.28, 0], rightLowerArm: [0, 0.28, 0],
  leftHand: [0, 0, -0.08], rightHand: [0, 0, 0.08],
};
const WALK_SPEED = 0.62;     // м/с — неторопливо
const STEP_HZ = 0.9;         // полных циклов шага в секунду
const STAND_UP = 2.0, SIT_DOWN = 2.1, GREET = 6.5, GREET_NIGHT = 12;

export async function loadHeroine({ gl, canvas, url, place, eye, target, hill, approach }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`модель не скачалась: ${res.status}`);
  const loader = new GLTFLoader();
  loader.register(parser => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(await res.arrayBuffer(), "");
  const vrm = gltf.userData.vrm;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  vrm.scene.traverse(o => { o.frustumCulled = false; });

  const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
  renderer.autoClear = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120);
  camera.position.set(...eye);
  camera.lookAt(...target);
  const key = new THREE.DirectionalLight(0xffffff, 2);
  key.position.set(-4, 7, 5);
  const fill = new THREE.AmbientLight(0xffffff, 0.8);
  scene.add(key, fill, vrm.scene);

  const bone = name => vrm.humanoid.getNormalizedBoneNode(name);
  const sit = { ...BASE };
  curlFingers(sit, "left", 0.55);
  curlFingers(sit, "right", 0.55);
  const stand = { ...STAND };
  curlFingers(stand, "left", 0.35);
  curlFingers(stand, "right", 0.35);
  for (const [name, r] of Object.entries(sit)) bone(name)?.rotation.set(...r);
  // Сидя таз опускается к земле: в T-позе он на высоте ног
  const hips = bone("hips");
  const hipsRest = hips.position.clone();
  vrm.scene.updateMatrixWorld(true);
  const sitDrop = hips.getWorldPosition(new THREE.Vector3()).y - 0.1;

  // Пружины по костям: корпус — медленные и мягкие, руки — живее, кисти и пальцы — быстрые
  const springs = {};
  const tuning = name => /Thumb|Index|Middle|Ring|Little/.test(name) ? [4.5, 0.75]
    : /Hand/.test(name) ? [3.4, 0.6]
    : /Arm/.test(name) ? [2.6, 0.6]
    : /Leg|Foot/.test(name) ? [3.2, 0.8]
    : /head|neck/.test(name) ? [1.9, 0.8]
    : [1.8, 0.75];

  // Ткань и волосы: пружины VRM мягче и тяжелее — юбка и пряди качаются от шагов и ветра, а не дрожат
  const joints = vrm.springBoneManager ? [...vrm.springBoneManager.joints] : [];
  joints.forEach(j => {
    j.settings.stiffness *= 0.7;
    j.settings.dragForce = Math.min(0.6, Math.max(j.settings.dragForce, 0.35));
  });
  const baseGravity = joints.map(j => j.settings.gravityPower);

  const lookTarget = new THREE.Object3D();
  lookTarget.position.copy(MOON);
  scene.add(lookTarget);
  if (vrm.lookAt) vrm.lookAt.target = lookTarget;
  const head = bone("head");
  const gaze = new THREE.Vector3().copy(MOON);
  const eyes = new THREE.Vector3().copy(MOON);
  const glance = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const headLook = new Spring([0, 0, 0]);
  const face = { blink: 0, blinkLeft: 0, happy: 0, relaxed: 0, ih: 0, oh: 0, aa: 0, ou: 0 };
  const faceNow = { ...face };

  // Где она и куда идёт. seat — место на траве, approach — точка перед камерой
  const seat = { x: place.x, z: place.z };
  const pos = { x: place.x, z: place.z };
  const yaw = new Spring([place.yaw, 0, 0]);
  let lensStep = 0;
  let state = "sit", stT = 0, dest = null, phase = 0, walkK = 0, focus = 0, wantYaw = place.yaw;
  let nextBlink = 2, blinkT = -1, nextGlance = 0, nextGaze = 0, gazeKind = "moon";
  let lastCursor = null, cursorAt = -10;
  let action = null, actionT = 0, nextAction = 9 + Math.random() * 4;
  const firefly = new THREE.Vector3();
  const go = s => { state = s; stT = 0; };
  const headingTo = p => Math.atan2(p.x - pos.x, p.z - pos.z);
  const shortest = (from, to) => from + Math.atan2(Math.sin(to - from), Math.cos(to - from));

  function chooseGaze(time, cursorFresh) {
    if (cursorFresh) { gazeKind = "cursor"; return; }
    const r = Math.random();
    gazeKind = r < 0.35 ? "moon" : r < 0.55 ? "camera" : r < 0.8 ? "field" : "firefly";
    if (gazeKind === "field") firefly.set(pos.x + (Math.random() - 0.3) * 6, place.y + Math.random() * 0.5, pos.z - 2 - Math.random() * 8);
    if (gazeKind === "firefly") firefly.set(pos.x + (Math.random() - 0.5) * 3, place.y + 0.6 + Math.random() * 1.2, pos.z - 0.5 - Math.random() * 2.5);
    nextGaze = time + 2.5 + Math.random() * 4;
  }

  // Подойти к камере: встать → повернуться → пройти → поздороваться → вернуться и сесть
  function visit() { if (state === "sit") { action = null; go("stand"); } }

  function update(dt, time, night, cursor, camEye) {
    dt = Math.min(dt, 1 / 30);
    stT += dt;
    for (const k of Object.keys(face)) face[k] = 0;

    // ----- сценарий -----
    let standK = 0, crouch = 0, wave = 0, slide = 0, kissT = -1;
    lensStep = 0;
    if (state === "stand") {
      const p = stT / STAND_UP;
      standK = ease((p - 0.25) / 0.75);
      crouch = Math.sin(Math.min(1, p) * Math.PI);
      slide = ease(p);
      if (p >= 1) { dest = approach; wantYaw = shortest(yaw.x[0], headingTo(dest)); go("turn"); }
    } else if (state === "turn" || state === "turnBack" || state === "face") {
      standK = 1;
      if (Math.abs(yaw.x[0] - wantYaw) < 0.06 && stT > 0.5) go(state === "face" ? "sitDown" : "walk");
    } else if (state === "walk") {
      standK = 1;
      wantYaw = shortest(yaw.x[0], headingTo(dest));
      const d = Math.hypot(dest.x - pos.x, dest.z - pos.z);
      walkK += (Math.min(1, d / 0.45) - walkK) * Math.min(1, dt * 3);
      const step = Math.min(d, WALK_SPEED * walkK * dt);
      pos.x += (dest.x - pos.x) / (d || 1) * step;
      pos.z += (dest.z - pos.z) / (d || 1) * step;
      if (d < 0.02 && walkK < 0.08) {
        walkK = 0;
        if (dest === approach) { wantYaw = shortest(yaw.x[0], Math.atan2(camEye[0] - pos.x, camEye[2] - pos.z)); go("greet"); }
        else { wantYaw = shortest(yaw.x[0], place.yaw); go("face"); }
      }
    } else if (state === "greet") {
      standK = 1;
      wantYaw = shortest(yaw.x[0], Math.atan2(camEye[0] - pos.x, camEye[2] - pos.z));
      const len = night > 0.5 ? GREET_NIGHT : GREET;
      wave = night > 0.5 ? envelope(stT, 4.2, 0.9, 0.9) : envelope(stT, len, 0.9, 1.1);
      if (night > 0.5) kissT = stT - 3.6;
      if (stT >= len) {
        dest = { x: seat.x + Math.sin(place.yaw) * 0.32, z: seat.z + Math.cos(place.yaw) * 0.32 };
        wantYaw = shortest(yaw.x[0], headingTo(dest));
        go("turnBack");
      }
    } else if (state === "sitDown") {
      const p = stT / SIT_DOWN;
      standK = 1 - ease(p / 0.8);
      crouch = Math.sin(Math.min(1, p) * Math.PI);
      slide = 1 - ease(p);
      if (p >= 1) { pos.x = seat.x; pos.z = seat.z; go("sit"); nextAction = time + 8 + Math.random() * 6; }
    }
    if (state === "stand" || state === "sitDown") {
      // Пока встаёт и садится, ступни на месте, а таз уезжает вперёд над ними
      pos.x = seat.x + Math.sin(place.yaw) * 0.32 * slide;
      pos.z = seat.z + Math.cos(place.yaw) * 0.32 * slide;
    }
    if (state !== "walk") walkK += (0 - walkK) * Math.min(1, dt * 4);
    yaw.step([wantYaw, 0, 0], dt, state === "walk" ? 1.2 : 0.9, 0.85);
    const comingToMe = (state === "walk" && dest === approach) || state === "greet" || state === "turn";
    focus += ((comingToMe ? 1 : 0) - focus) * Math.min(1, dt * 0.9);

    // ----- позы -----
    const t = {};
    for (const name of new Set([...Object.keys(sit), ...Object.keys(stand)])) {
      const a = sit[name] || [0, 0, 0], b = stand[name] || [0, 0, 0];
      t[name] = [a[0] + (b[0] - a[0]) * standK, a[1] + (b[1] - a[1]) * standK, a[2] + (b[2] - a[2]) * standK];
    }
    // Вставая и садясь: присед, наклон вперёд, руки упираются в землю
    if (crouch > 0) {
      add(t, "spine", [0.45 * crouch, 0, 0]);
      add(t, "chest", [0.15 * crouch, 0, 0]);
      add(t, "head", [-0.3 * crouch, 0, 0]);
      add(t, "leftUpperLeg", [-0.9 * crouch * standK, 0, 0]);
      add(t, "rightUpperLeg", [-0.9 * crouch * standK, 0, 0]);
      add(t, "leftLowerLeg", [1.3 * crouch * standK, 0, 0]);
      add(t, "rightLowerLeg", [1.3 * crouch * standK, 0, 0]);
      mix(t, "leftUpperArm", [0.6, 0, -1.3], crouch * 0.7);
      mix(t, "rightUpperArm", [0.6, 0, 1.3], crouch * 0.7);
    }

    // Жизнь: дыхание, покачивание, пальцы — всегда
    const breath = Math.sin(time * (1.45 + walkK * 0.8));
    add(t, "chest", [0.025 * breath, 0, 0]);
    add(t, "upperChest", [0.015 * breath, 0, 0]);
    add(t, "leftShoulder", [0, 0, 0.03 * breath]);
    add(t, "rightShoulder", [0, 0, -0.03 * breath]);
    const calm = 1 - walkK;
    add(t, "spine", [0.02 * Math.sin(time * 0.23 + 1) * calm, 0.03 * Math.sin(time * 0.17) * calm, 0.025 * Math.sin(time * 0.31) * calm]);
    const fidget = 0.08 * Math.max(0, Math.sin(time * 0.7)) * Math.sin(time * 6);
    add(t, "leftIndexProximal", [0, 0, -fidget]);
    add(t, "rightMiddleProximal", [0, 0, fidget]);
    // Микродвижения: живое тело никогда не стоит идеально неподвижно
    const n = (a, b, c) => (Math.sin(time * a + c) * 0.6 + Math.sin(time * b + c * 1.7) * 0.4);
    add(t, "neck", [0.015 * n(0.53, 1.31, 0.2), 0.02 * n(0.41, 0.97, 1.1), 0.012 * n(0.37, 1.13, 2.3)]);
    add(t, "upperChest", [0.008 * n(0.61, 1.7, 0.5), 0.012 * n(0.29, 0.83, 3.1), 0]);
    add(t, "leftUpperArm", [0.02 * n(0.47, 1.21, 0.9), 0, 0.015 * n(0.33, 0.9, 1.7)]);
    add(t, "rightUpperArm", [0.02 * n(0.43, 1.37, 2.9), 0, 0.015 * n(0.39, 1.05, 0.4)]);
    add(t, "leftHand", [0.03 * n(0.71, 1.9, 0.3), 0.02 * n(0.57, 1.4, 2.2), 0]);
    add(t, "rightHand", [0.03 * n(0.67, 1.8, 1.4), 0.02 * n(0.51, 1.6, 0.8), 0]);
    // Стоя на месте — переносит вес с ноги на ногу
    if (standK > 0.9 && walkK < 0.1) {
      const shift = Math.sin(time * 0.5) * 0.035;
      add(t, "hips", [0, 0, shift]);
      add(t, "leftUpperLeg", [0, 0, -shift]);
      add(t, "rightUpperLeg", [0, 0, -shift]);
      add(t, "spine", [0, 0, -shift * 0.6]);
    }

    // Шаг: бёдра в противофазе, колено сгибается на переносе, таз качается и поворачивается, руки — навстречу ногам
    let bob = 0;
    if (walkK > 0.01) {
      phase += dt * TAU * STEP_HZ * (0.4 + 0.6 * walkK);
      const s = Math.sin(phase), c = Math.cos(phase), k = walkK;
      add(t, "leftUpperLeg", [-0.42 * s * k, 0, 0]);
      add(t, "rightUpperLeg", [0.42 * s * k, 0, 0]);
      add(t, "leftLowerLeg", [(0.95 * Math.pow(Math.max(0, c), 1.4) + 0.06) * k, 0, 0]);
      add(t, "rightLowerLeg", [(0.95 * Math.pow(Math.max(0, -c), 1.4) + 0.06) * k, 0, 0]);
      add(t, "leftFoot", [(-0.25 * Math.max(0, c) + 0.2 * Math.max(0, -s)) * k, 0, 0]);
      add(t, "rightFoot", [(-0.25 * Math.max(0, -c) + 0.2 * Math.max(0, s)) * k, 0, 0]);
      add(t, "hips", [0.03 * k, 0.08 * s * k, 0.045 * c * k]);
      add(t, "spine", [0.04 * k, -0.06 * s * k, -0.03 * c * k]);
      add(t, "chest", [0, -0.04 * s * k, 0]);
      add(t, "head", [0, 0.05 * s * k, 0.02 * c * k]);
      add(t, "leftUpperArm", [0.32 * s * k, 0, 0.06 * k]);
      add(t, "rightUpperArm", [-0.32 * s * k, 0, -0.06 * k]);
      add(t, "leftLowerArm", [0, -0.22 * Math.max(0, -s) * k, 0]);
      add(t, "rightLowerArm", [0, 0.22 * Math.max(0, s) * k, 0]);
      bob = -0.035 * Math.abs(s) * k;
    }

    // Случайные действия — только сидя
    let actionOut = {};
    if (state === "sit") {
      if (!action && time > nextAction) { action = ACTIONS[ACTION_NAMES[Math.floor(Math.random() * ACTION_NAMES.length)]]; actionT = 0; }
      if (action) {
        actionT += dt;
        actionOut = action.apply(t, actionT / action.len, envelope(actionT, action.len), face) || {};
        if (actionT >= action.len) { action = null; nextAction = time + 7 + Math.random() * 8; }
      }
    }

    // Приветствие стоя: рука взлетает и мягко машет раскрытой ладонью, она подаётся к камере и улыбается
    if (wave > 0) {
      const wt = stT;
      mix(t, "rightUpperArm", [0, 0.45, -0.25 + Math.sin(wt * 5.2 + 0.7) * 0.05], wave);
      mix(t, "rightLowerArm", [0, -0.1, -1.55 + Math.sin(wt * 5.2) * 0.32], wave);
      mix(t, "rightHand", [0.15, -0.4, Math.sin(wt * 5.2 - 1.1) * 0.25], wave);
      mix(t, "rightShoulder", [0, 0, -0.12], wave);
      curlFingers(t, "right", 0.08 * wave + 0.35 * (1 - wave), 0.6 * wave);
      mix(t, "leftUpperArm", [0.25, 0.3, -1.15], wave * 0.6);   // левая рука — к груди, чуть смущённо
      mix(t, "leftLowerArm", [0, -1.6, 0], wave * 0.6);
      add(t, "spine", [0.1 * wave, 0, -0.04 * wave]);
      add(t, "head", [0, 0, 0.14 * wave]);
      face.happy += 0.3 * wave;
      face.relaxed += 0.25 * wave;
    }
    let kissClose = 0;
    if (kissT >= 0 && kissT < 3.4) {
      // 0–1.2 с: шагает к объективу и наклоняется; 1.2–2.1: поцелуй (глаза закрыты, губы); 2.1–3.2: отходит
      const lean = ease(kissT / 1.2) * (1 - ease((kissT - 2.1) / 1.0));
      lensStep = 0.95 * lean;
      add(t, "spine", [0.1 * lean, 0, 0]);
      add(t, "chest", [0.04 * lean, 0, 0]);
      add(t, "head", [-0.1 * lean, 0, 0.18 * lean]);
      add(t, "leftLowerLeg", [0.12 * lean, 0, 0]);
      add(t, "rightLowerLeg", [0.05 * lean, 0, 0]);
      mix(t, "leftUpperArm", [0.35, 0, -1.2], lean);     // руки сцеплены за спиной
      mix(t, "rightUpperArm", [0.35, 0, 1.2], lean);
      mix(t, "leftLowerArm", [0, -0.6, 0], lean);
      mix(t, "rightLowerArm", [0, 0.6, 0], lean);
      kissClose = ease((kissT - 0.8) / 0.3) * (1 - ease((kissT - 2.1) / 0.25));
      face.ou += 0.75 * ease((kissT - 0.7) / 0.4) * (1 - ease((kissT - 2.1) / 0.3));
      face.relaxed += 0.3 * lean;
    }
    if (kissT >= 3.0 && kissT < 8.6) {
      // Потом — воздушный поцелуй: пальцы к губам, подмигивает, рука уходит к камере; счастливая улыбка
      const kt = kissT - 3.0;
      const toLips = ease(kt / 0.9) * (1 - ease((kt - 1.3) / 0.5));
      const blow = ease((kt - 1.3) / 0.5) * (1 - ease((kt - 3.4) / 1.2));
      const k = Math.max(toLips, blow);
      mix(t, "rightUpperArm", toLips >= blow ? [-0.25, 1.05, 0.5] : [0, 1.15, 0.25], k);
      mix(t, "rightLowerArm", toLips >= blow ? [0, 2.5, 0] : [0, 0.55, 0], k);
      mix(t, "rightHand", toLips >= blow ? [0, 0.2, 0.25] : [0, -0.2, -0.15], k);
      curlFingers(t, "right", toLips >= blow ? 0.25 : 0.05, toLips >= blow ? 0 : 0.5);
      mix(t, "leftUpperArm", [0.2, 0.3, -1.15], k * 0.6);
      mix(t, "leftLowerArm", [0, -1.5, 0], k * 0.6);
      add(t, "spine", [0.08 * blow, 0, 0]);
      add(t, "head", [0.04 * toLips, 0, -0.12 * blow]);
      face.ou += 0.55 * toLips;
      face.blinkLeft += Math.sin(Math.min(1, Math.max(0, (kt - 1.35) / 0.5)) * Math.PI);
      face.happy += 0.35 * blow;
      face.relaxed += 0.3 * (1 - toLips);
    }
    if (comingToMe && state === "walk") { face.relaxed += 0.3; face.happy += 0.12; }

    // ----- взгляд -----
    if (cursor && (!lastCursor || Math.hypot(cursor[0] - lastCursor[0], cursor[1] - lastCursor[1]) > 0.02)) { cursorAt = time; lastCursor = cursor; }
    const cursorFresh = cursor && time - cursorAt < 2;
    if (time > nextGaze || (cursorFresh && gazeKind !== "cursor")) chooseGaze(time, cursorFresh);
    if (comingToMe) gaze.set(...camEye);
    else if (state === "walk" || state === "turnBack" || state === "face") gaze.set(seat.x, place.y + 0.2, seat.z - 1.5);
    else if (actionOut.forceLook) gaze.copy(actionOut.forceLook);
    else if (gazeKind === "cursor" && lastCursor) gaze.set(lastCursor[0], hill(lastCursor[0], lastCursor[1]) + 0.45, lastCursor[1]);
    else if (gazeKind === "camera") gaze.set(...camEye);
    else if (gazeKind === "moon") gaze.copy(MOON);
    else gaze.copy(firefly);
    if (actionOut.lookUp) gaze.y += 6 * actionOut.lookUp;
    if (time > nextGlance) { glance.set((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.05, 0); nextGlance = time + 0.5 + Math.random() * 1.6; }
    tmp.copy(gaze).add(glance);
    eyes.lerp(tmp, Math.min(1, dt * 14));
    lookTarget.position.copy(eyes);

    // Корень модели: на земле, развёрнут по направлению тела; таз — сидя у земли, стоя — на своей высоте.
    // При поцелуе она шагает к объективу (lensStep метров в сторону камеры)
    const toCam = Math.hypot(camEye[0] - pos.x, camEye[2] - pos.z) || 1;
    const rx = pos.x + (camEye[0] - pos.x) / toCam * lensStep, rz = pos.z + (camEye[2] - pos.z) / toCam * lensStep;
    vrm.scene.position.set(rx, hill(rx, rz), rz);
    vrm.scene.rotation.y = yaw.x[0];
    hips.position.set(hipsRest.x, hipsRest.y - sitDrop * (1 - standK) - 0.12 * crouch * standK + bob, hipsRest.z);
    vrm.scene.updateMatrixWorld(true);

    head.getWorldPosition(tmp);
    const local = vrm.scene.worldToLocal(gaze.clone()).sub(vrm.scene.worldToLocal(tmp.clone()));
    const lyaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -1, 1);
    const pitch = THREE.MathUtils.clamp(-Math.atan2(local.y, Math.hypot(local.x, local.z)), -0.7, 0.45);
    const turn = 0.55 + 0.4 * Math.max(wave, focus);
    const hl = headLook.step([pitch * turn, lyaw * turn, 0], dt, 1.3, 0.72);
    add(t, "head", [hl[0] * 0.65, hl[1] * 0.6, 0]);
    add(t, "neck", [hl[0] * 0.35, hl[1] * 0.4, 0]);

    for (const [name, target] of Object.entries(t)) {
      const node = bone(name);
      if (!node) continue;
      const s = springs[name] || (springs[name] = new Spring(target));
      const [f, z] = tuning(name);
      node.rotation.set(...s.step(target, dt, f, z));
    }

    // Моргание раз в 2–6 с, иногда двойное; при резком повороте головы — тоже
    if ((time > nextBlink || Math.abs(headLook.v[1]) > 1.6) && blinkT < 0) blinkT = 0;
    if (blinkT >= 0) {
      blinkT += dt;
      face.blink = Math.sin(Math.min(1, blinkT / 0.15) * Math.PI);
      if (blinkT > 0.15) { blinkT = -1; nextBlink = time + (Math.random() < 0.2 ? 0.25 : 2 + Math.random() * 4); }
    }
    face.blink = Math.max(face.blink, kissClose);
    face.relaxed += 0.25;
    for (const k of Object.keys(face)) {
      faceNow[k] = k === "blink" ? face.blink : faceNow[k] + (Math.min(1, face[k]) - faceNow[k]) * Math.min(1, dt * 6);
      vrm.expressionManager?.setValue(k, faceNow[k]);
    }

    // Ветер: пружины волос и юбки тянет вбок волнами
    const gust = 0.5 + 0.5 * Math.sin(time * 0.6) * Math.sin(time * 1.7 + 1);
    joints.forEach((j, i) => {
      j.settings.gravityDir.set(0.9 * gust, -1, -0.3 * gust).normalize();
      j.settings.gravityPower = baseGravity[i] + 0.2 * gust;
    });
    vrm.update(dt);

    // Свет: днём тёплое солнце слева сверху, ночью холодная луна справа
    key.color.setRGB(1 - 0.4 * night, 0.96 - 0.25 * night, 0.9 + 0.1 * night);
    key.intensity = 2 - 1.1 * night;
    key.position.set(-4 + 10 * night, 7, 5 - 8 * night);
    fill.color.setRGB(1 - 0.55 * night, 1 - 0.45 * night, 1 - 0.2 * night);
    fill.intensity = 0.8 - 0.35 * night;
  }

  return {
    update,
    visit,
    // Насколько камере смотреть на неё (0 — общий вид, 1 — она перед камерой)
    focus: () => focus,
    // Насколько она сейчас у самого объектива (поцелуй): 0..1 — камера поднимается на уровень лица
    closeness: () => lensStep / 0.95,
    sitting: () => state === "sit",
    position: () => [pos.x, pos.z],
    walking: () => walkK > 0.1,
    headPosition: () => head.getWorldPosition(new THREE.Vector3()).toArray(),
    render(width, height, eyeNow, targetNow) {
      renderer.resetState();
      renderer.setViewport(0, 0, width, height);
      camera.position.set(...eyeNow);
      camera.lookAt(...targetNow);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      renderer.resetState();
    },
    dispose() { VRMUtils.deepDispose(vrm.scene); renderer.dispose(); },
    debug: { start: name => { action = ACTIONS[name]; actionT = 0; }, visit },
  };
}
