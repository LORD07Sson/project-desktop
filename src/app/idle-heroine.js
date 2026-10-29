// 3D-героиня экрана ожидания (idle-scene.js): своя модель VRM, собранная в VRoid («Звездочёт»), лежит на
// сервере (/api/desktop/idle-model) и качается один раз — дальше её держит кэш браузера. Модуль грузится
// лениво вместе с three.js, только когда сцена показана. Рисует в тот же WebGL-контекст, что и луг: общий
// буфер глубины, поэтому трава перед ней закрывает ноги.
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
function curlFingers(t, side, amount, spread = 0) {
  const s = side === "left" ? -1 : 1;
  FINGERS.forEach((f, i) => {
    const k = amount * (1 + i * 0.08);
    t[`${side}${f}Proximal`] = [0, (i - 1.5) * spread * 0.12 * -s, s * k * 0.9];
    t[`${side}${f}Intermediate`] = [0, 0, s * k * 1.1];
    t[`${side}${f}Distal`] = [0, 0, s * k * 0.8];
  });
  t[`${side}ThumbProximal`] = [0, s * -0.35 * amount, s * 0.25 * amount];
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

export async function loadHeroine({ gl, canvas, url, place, eye, target }) {
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
  const base = { ...BASE };
  curlFingers(base, "left", 0.55);
  curlFingers(base, "right", 0.55);
  for (const [name, r] of Object.entries(base)) bone(name)?.rotation.set(...r);
  // Опустить таз на землю: в T-позе он стоит на высоте ног
  vrm.scene.updateMatrixWorld(true);
  const hipsY = bone("hips").getWorldPosition(new THREE.Vector3()).y;
  vrm.scene.position.set(place.x, place.y - hipsY + 0.1, place.z);
  vrm.scene.rotation.y = place.yaw;

  // Пружины по костям: корпус — медленные и мягкие, руки — живее, кисти и пальцы — быстрые
  const springs = {};
  const tuning = name => /Thumb|Index|Middle|Ring|Little/.test(name) ? [4.5, 0.75]
    : /Hand/.test(name) ? [3.2, 0.55]
    : /Arm/.test(name) ? [2.2, 0.55]
    : /head|neck/.test(name) ? [1.8, 0.8]
    : [1.4, 0.75];

  const lookTarget = new THREE.Object3D();
  lookTarget.position.copy(MOON);
  scene.add(lookTarget);
  if (vrm.lookAt) vrm.lookAt.target = lookTarget;
  const head = bone("head");
  const gaze = new THREE.Vector3().copy(MOON);    // куда она решила смотреть
  const eyes = new THREE.Vector3().copy(MOON);    // куда смотрят глаза (быстро догоняют gaze)
  const glance = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const headLook = new Spring([0, 0, 0]);
  const joints = vrm.springBoneManager ? [...vrm.springBoneManager.joints] : [];
  const baseGravity = joints.map(j => j.settings.gravityPower);
  const face = { blink: 0, happy: 0, relaxed: 0, ih: 0, oh: 0, aa: 0 };
  const faceNow = { ...face };

  let nextBlink = 2, blinkT = -1, nextGlance = 0, nextGaze = 0, gazeKind = "moon";
  let lastCursor = null, cursorAt = -10;
  let action = null, actionT = 0, nextAction = 6 + Math.random() * 4;
  const firefly = new THREE.Vector3();

  function chooseGaze(time, cursorFresh) {
    if (cursorFresh) { gazeKind = "cursor"; return; }
    const r = Math.random();
    gazeKind = r < 0.35 ? "moon" : r < 0.55 ? "camera" : r < 0.8 ? "field" : "firefly";
    if (gazeKind === "field") firefly.set(place.x + (Math.random() - 0.3) * 6, place.y + Math.random() * 0.5, place.z - 2 - Math.random() * 8);
    if (gazeKind === "firefly") firefly.set(place.x + (Math.random() - 0.5) * 3, place.y + 0.6 + Math.random() * 1.2, place.z - 0.5 - Math.random() * 2.5);
    nextGaze = time + 2.5 + Math.random() * 4;
  }

  // greet: { w — сила приветствия 0..1, t — секунды с его начала, eye — где камера }
  function update(dt, time, night, cursor, hill, greet) {
    dt = Math.min(dt, 1 / 30);
    const w = greet ? greet.w : 0;
    for (const k of Object.keys(face)) face[k] = 0;
    const t = {};
    for (const [name, r] of Object.entries(base)) t[name] = [...r];

    // Жизнь: дыхание (грудь и плечи), медленное покачивание, лёгкое шевеление пальцев
    const breath = Math.sin(time * 1.45);
    add(t, "chest", [0.025 * breath, 0, 0]);
    add(t, "upperChest", [0.015 * breath, 0, 0]);
    add(t, "leftShoulder", [0, 0, 0.03 * breath]);
    add(t, "rightShoulder", [0, 0, -0.03 * breath]);
    add(t, "spine", [0.02 * Math.sin(time * 0.23 + 1), 0.03 * Math.sin(time * 0.17), 0.025 * Math.sin(time * 0.31)]);
    add(t, "hips", [0, 0, 0.012 * Math.sin(time * 0.31 + 0.5)]);
    const fidget = 0.08 * Math.max(0, Math.sin(time * 0.7)) * Math.sin(time * 6);
    add(t, "leftIndexProximal", [0, 0, -fidget]);
    add(t, "rightMiddleProximal", [0, 0, fidget]);

    // Случайное действие, если не здоровается
    let actionOut = {};
    if (!action && w < 0.05 && time > nextAction) { action = ACTIONS[ACTION_NAMES[Math.floor(Math.random() * ACTION_NAMES.length)]]; actionT = 0; }
    if (action) {
      actionT += dt;
      const k = envelope(actionT, action.len) * (1 - w);
      actionOut = action.apply(t, actionT / action.len, k, face) || {};
      if (actionT >= action.len) { action = null; nextAction = time + 7 + Math.random() * 8; }
    }

    // Приветствие: замах, рука взлетает и мягко машет раскрытой ладонью; корпус подаётся к камере
    if (w > 0) {
      const gt = greet.t;
      const wave = Math.sin(gt * 5.2) * 0.32;
      const wrist = Math.sin(gt * 5.2 - 1.1) * 0.25;
      mix(t, "rightUpperArm", [0, 0.5, -0.32 + Math.sin(gt * 5.2 + 0.7) * 0.05], w);
      mix(t, "rightLowerArm", [0, -0.1, -1.5 + wave], w);
      mix(t, "rightHand", [0.15, -0.4, wrist], w);
      mix(t, "rightShoulder", [0, 0, -0.12], w);
      curlFingers(t, "right", 0.08 * w + 0.55 * (1 - w), 0.6 * w);
      add(t, "spine", [0.08 * w, 0.22 * w, -0.04 * w]);
      add(t, "head", [0, 0, 0.14 * w]);
      face.happy += 0.38 * w;
      face.ih += 0.14 * w;
      face.relaxed += 0.12 * w;
    }

    // Взгляд: курсор (если двигался последние 2 с), камера при приветствии, иначе — сама выбирает
    if (cursor && (!lastCursor || Math.hypot(cursor[0] - lastCursor[0], cursor[1] - lastCursor[1]) > 0.02)) { cursorAt = time; lastCursor = cursor; }
    const cursorFresh = cursor && time - cursorAt < 2;
    if (time > nextGaze || (cursorFresh && gazeKind !== "cursor")) chooseGaze(time, cursorFresh);
    if (w > 0.15 && greet.eye) gaze.set(...greet.eye);
    else if (actionOut.forceLook) gaze.copy(actionOut.forceLook);
    else if (gazeKind === "cursor" && lastCursor) gaze.set(lastCursor[0], hill(lastCursor[0], lastCursor[1]) + 0.45, lastCursor[1]);
    else if (gazeKind === "camera") gaze.set(...(greet?.eye || eye));
    else if (gazeKind === "moon") gaze.copy(MOON);
    else gaze.copy(firefly);
    if (actionOut.lookUp) gaze.y += 6 * actionOut.lookUp;
    // Саккады: глаза то и дело чуть перескакивают
    if (time > nextGlance) { glance.set((Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.05, 0); nextGlance = time + 0.5 + Math.random() * 1.6; }
    tmp.copy(gaze).add(glance);
    eyes.lerp(tmp, Math.min(1, dt * 14));
    lookTarget.position.copy(eyes);

    // Голова догоняет взгляд пружиной (с лёгким перелётом), шея берёт часть поворота
    head.getWorldPosition(tmp);
    const local = vrm.scene.worldToLocal(gaze.clone()).sub(vrm.scene.worldToLocal(tmp.clone()));
    const yaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -1, 1);
    const pitch = THREE.MathUtils.clamp(-Math.atan2(local.y, Math.hypot(local.x, local.z)), -0.7, 0.4);
    const turn = 0.55 + 0.4 * w;
    const hl = headLook.step([pitch * turn, yaw * turn, 0], dt, 1.3, 0.72);
    add(t, "head", [hl[0] * 0.65, hl[1] * 0.6, 0]);
    add(t, "neck", [hl[0] * 0.35, hl[1] * 0.4, 0]);

    // Пружины → кости
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
    face.relaxed += 0.25;
    // Лицо меняется плавно (кроме моргания)
    for (const k of Object.keys(face)) {
      faceNow[k] = k === "blink" ? face.blink : faceNow[k] + (Math.min(1, face[k]) - faceNow[k]) * Math.min(1, dt * 6);
      vrm.expressionManager?.setValue(k, faceNow[k]);
    }

    // Ветер: пружины волос и юбки тянет вбок волнами
    const gust = 0.5 + 0.5 * Math.sin(time * 0.6) * Math.sin(time * 1.7 + 1);
    joints.forEach((j, i) => {
      j.settings.gravityDir.set(0.9 * gust, -1, -0.3 * gust).normalize();
      j.settings.gravityPower = baseGravity[i] + 0.25 * gust;
    });
    vrm.update(dt);

    // Свет: днём тёплое солнце слева сверху, ночью холодная луна справа
    key.color.setRGB(1 - 0.4 * night, 0.96 - 0.25 * night, 0.9 + 0.1 * night);
    key.intensity = 2 - 1.1 * night;
    key.position.set(-4 + 10 * night, 7, 5 - 8 * night);
    fill.color.setRGB(1 - 0.55 * night, 1 - 0.45 * night, 1 - 0.2 * night);
    fill.intensity = 0.8 - 0.35 * night;
  }

  function headPosition() {
    return head.getWorldPosition(new THREE.Vector3()).toArray();
  }

  function render(width, height, eyeNow, targetNow) {
    renderer.resetState();
    renderer.setViewport(0, 0, width, height);
    camera.position.set(...eyeNow);
    camera.lookAt(...targetNow);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    renderer.resetState();
  }

  function dispose() {
    VRMUtils.deepDispose(vrm.scene);
    renderer.dispose();
  }

  return { update, render, headPosition, dispose, debug: { start: name => { action = ACTIONS[name]; actionT = 0; } } };
}
