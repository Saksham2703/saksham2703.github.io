import * as THREE from 'three';
import { L1, L2, solveIK, forward, bezier, easeInOut, damp } from './gripper-ik.js';

const cell = document.querySelector('[data-cell]');
const canvas = cell && cell.querySelector('[data-gripper-canvas]');
if (!canvas) throw new Error('gripper: no cell');
const stateEl = cell.querySelector('[data-cell-state]');

// ---------- constants ----------
const SCENE_W = 10;                   // scene units across the cell
const SHOULDER_Y = 0.55;              // shoulder height above the floor
const REST = { t1: 1.75, t2: -1.22 }; // 100°, -70°
const JAW = { closed: 0.15, relaxed: 0.35, open: 0.85 };
const COLORS = {
  body: 0xefebe0, joint: 0xd9d2c0, edge: 0x8b8577, path: 0x2b6555,
};

// ---------- renderer, camera, lights ----------
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 100);
scene.add(new THREE.HemisphereLight(0xfffaf0, 0xd9d2c0, 0.9));
const sun = new THREE.DirectionalLight(0xffffff, 0.55);
sun.position.set(-4, 8, 6);
scene.add(sun);

let visH = SCENE_W; // visible scene height at z = 0; set by resize()
function resize() {
  const w = cell.clientWidth, h = cell.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  camera.aspect = aspect;
  visH = SCENE_W / aspect;
  const dist = (SCENE_W / 2) / (aspect * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.position.set(0, visH / 2, dist);
  camera.lookAt(0, visH / 2, 0);
  camera.updateProjectionMatrix();
}
new ResizeObserver(() => { resize(); requestFrame(); }).observe(cell);

// ---------- materials ----------
const bodyMat = new THREE.MeshStandardMaterial({ color: COLORS.body, roughness: 0.92, metalness: 0 });
const jointMat = new THREE.MeshStandardMaterial({ color: COLORS.joint, roughness: 0.92, metalness: 0 });
const edgeMat = new THREE.LineBasicMaterial({ color: COLORS.edge, transparent: true, opacity: 0.7 });

function part(geom, mat, x = 0, y = 0, z = 0, rz = 0) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(geom, mat);
  m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geom, 20), edgeMat));
  g.add(m);
  g.position.set(x, y, z);
  g.rotation.z = rz;
  return g;
}
const cyl = (r, h) => new THREE.CylinderGeometry(r, r, h, 24);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// ---------- the arm: base → shoulder → link1 → elbow → link2 → wrist → palm → fingers ----------
const base = part(cyl(0.9, 0.25), jointMat, 0, 0.125);
scene.add(base);
const pedestal = part(box(0.6, SHOULDER_Y - 0.25, 0.6), bodyMat, 0, 0.25 + (SHOULDER_Y - 0.25) / 2);
scene.add(pedestal);

const shoulder = new THREE.Group();
shoulder.position.set(0, SHOULDER_Y, 0);
scene.add(shoulder);
// joint cylinders lie along z so their round face looks at the viewer
shoulder.add(part(cyl(0.35, 0.6), jointMat).rotateX(Math.PI / 2));
shoulder.add(part(box(0.45, L1, 0.45), bodyMat, 0, L1 / 2));

const elbow = new THREE.Group();
elbow.position.set(0, L1, 0);
shoulder.add(elbow);
elbow.add(part(cyl(0.3, 0.55), jointMat).rotateX(Math.PI / 2));
elbow.add(part(box(0.38, L2, 0.38), bodyMat, 0, L2 / 2));

const wrist = new THREE.Group();
wrist.position.set(0, L2, 0);
elbow.add(wrist);
wrist.add(part(cyl(0.28, 0.5), jointMat).rotateX(Math.PI / 2));
wrist.add(part(box(1.1, 0.35, 0.5), bodyMat, 0, 0.2));
const fingerL = part(box(0.18, 0.7, 0.4), bodyMat, 0, 0.725);
const fingerR = part(box(0.18, 0.7, 0.4), bodyMat, 0, 0.725);
wrist.add(fingerL, fingerR);

// ---------- trajectory line ----------
const PATH_N = 24;
const pathGeom = new THREE.BufferGeometry();
pathGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PATH_N * 3), 3));
const pathMat = new THREE.LineDashedMaterial({ color: COLORS.path, dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0 });
const pathLine = new THREE.Line(pathGeom, pathMat);
pathLine.position.y = SHOULDER_Y;
scene.add(pathLine);

// ---------- pose application ----------
// Links are modelled along +y, so a shoulder angle of t1 (from +x) is a z-rotation of t1 - 90°.
function applyPose(t1, t2, wristRel, jaw) {
  shoulder.rotation.z = t1 - Math.PI / 2;
  elbow.rotation.z = t2;
  wrist.rotation.z = wristRel;
  fingerL.position.x = -jaw / 2;
  fingerR.position.x = jaw / 2;
}

// ---------- render on demand ----------
let frameQueued = false;
function requestFrame() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => { frameQueued = false; renderer.render(scene, camera); });
}

resize();
applyPose(REST.t1, REST.t2, 0, JAW.relaxed);
requestFrame();

// Behaviour is attached in the next tasks; keep these referenced so the
// import list stays honest under a linter.
void solveIK; void forward; void bezier; void easeInOut; void damp; void stateEl; void visH;
