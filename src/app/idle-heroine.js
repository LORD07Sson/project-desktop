// 3D-героиня экрана ожидания (idle-scene.js): своя модель VRM, собранная в VRoid («Звездочёт»), лежит на
// сервере (/api/desktop/idle-model) и качается один раз — дальше её держит кэш браузера. Модуль грузится
// лениво вместе с three.js, только когда сцена показана. Рисует в тот же WebGL-контекст, что и луг: общий
// буфер глубины, поэтому трава перед ней закрывает ноги. Сидит в траве, обхватив колени: дышит, моргает,
// волосы и юбку колышет ветер (пружины VRM), голова следит за курсором, без курсора — смотрит на луну.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";

const MOON = new THREE.Vector3(14, 12, -40);

// Поза сидя (нормализованные кости VRM 1.0, модель смотрит на +Z): бёдра вперёд-вверх, голени назад к земле,
// руки обнимают колени. Подбирал на глаз в предпросмотре.
const POSE = {
  spine: [0.18, 0, 0],
  chest: [0.08, 0, 0],
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
};

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
  for (const [name, [x, y, z]] of Object.entries(POSE)) bone(name)?.rotation.set(x, y, z);
  // Опустить таз на землю: в T-позе он стоит на высоте ног
  vrm.scene.updateMatrixWorld(true);
  const hipsY = bone("hips").getWorldPosition(new THREE.Vector3()).y;
  vrm.scene.position.set(place.x, place.y - hipsY + 0.1, place.z);
  vrm.scene.rotation.y = place.yaw;

  const lookTarget = new THREE.Object3D();
  lookTarget.position.copy(MOON);
  scene.add(lookTarget);
  if (vrm.lookAt) vrm.lookAt.target = lookTarget;
  const head = bone("head"), neck = bone("neck"), chest = bone("chest");
  const want = new THREE.Vector3().copy(MOON);
  const tmp = new THREE.Vector3();
  const joints = vrm.springBoneManager ? [...vrm.springBoneManager.joints] : [];
  const baseGravity = joints.map(j => j.settings.gravityPower);
  let nextBlink = 2, blinkT = -1;

  function update(dt, time, night, cursor, hill) {
    // Куда смотреть: на курсор (точка над травой) или на луну; плавно
    if (cursor) want.set(cursor[0], hill(cursor[0], cursor[1]) + 0.5, cursor[1]); else want.copy(MOON);
    lookTarget.position.lerp(want, Math.min(1, dt * 3));
    // Голова и шея поворачиваются к цели в пределах шеи, остальное доводят глаза
    head.getWorldPosition(tmp);
    const local = vrm.scene.worldToLocal(lookTarget.position.clone()).sub(vrm.scene.worldToLocal(tmp.clone()));
    const yaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -0.9, 0.9);
    const pitch = THREE.MathUtils.clamp(-Math.atan2(local.y, Math.hypot(local.x, local.z)), -0.6, 0.35);
    head.rotation.y += (yaw * 0.6 - head.rotation.y) * Math.min(1, dt * 4);
    head.rotation.x += (pitch * 0.6 - head.rotation.x) * Math.min(1, dt * 4);
    neck.rotation.y = head.rotation.y * 0.5;
    neck.rotation.x = head.rotation.x * 0.4;
    chest.rotation.x = POSE.chest[0] + Math.sin(time * 1.6) * 0.025;

    // Моргание раз в 2–6 с, иногда двойное
    if (time > nextBlink && blinkT < 0) blinkT = 0;
    let blink = 0;
    if (blinkT >= 0) {
      blinkT += dt;
      blink = Math.sin(Math.min(1, blinkT / 0.16) * Math.PI);
      if (blinkT > 0.16) { blinkT = -1; nextBlink = time + (Math.random() < 0.2 ? 0.25 : 2 + Math.random() * 4); }
    }
    vrm.expressionManager?.setValue("blink", blink);
    vrm.expressionManager?.setValue("relaxed", 0.35);

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

  function render(width, height) {
    renderer.resetState();
    renderer.setViewport(0, 0, width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    renderer.resetState();
  }

  function dispose() {
    VRMUtils.deepDispose(vrm.scene);
    renderer.dispose();
  }

  return { update, render, dispose };
}
