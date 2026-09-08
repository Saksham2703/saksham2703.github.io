import * as THREE from 'three';
import { L1, L2, REACH, solveIK, forward, bezier, easeInOut, damp } from './gripper-ik.js';

const cell = document.querySelector('[data-cell]');
const canvas = cell && cell.querySelector('[data-gripper-canvas]');
if (!canvas) throw new Error('gripper: no cell');
const stateEl = cell.querySelector('[data-cell-state]');

// ---------- constants ----------
const SHOULDER_Y = 0.55;              // shoulder height above the floor
const FLOOR_Y = 0.9;               // lifts the rig clear of the caption strip
// jaw = centre-to-centre finger spacing; fingers are FINGER_W wide, so closed means touching.
const FINGER_W = 0.18;
const JAW = { closed: FINGER_W + 0.02, relaxed: 0.35, open: 0.85 };
// radius from the wrist origin to the farthest finger corner (tip plane 0.725 + 0.35, lateral spread at JAW.open, half-depth 0.2)
const TOOL_R = Math.hypot(JAW.open / 2 + FINGER_W / 2, 0.725 + 0.35, 0.2);
const ENVELOPE = REACH + TOOL_R;      // farthest any geometry gets from the shoulder
const FRAME_PAD = 1.04;               // geometry near the reach limit sits at z ≤ +0.25, so it is magnified ~1% vs the z = 0 plane
// NOTE: this frames the envelope's bounding box; in a tall column that leaves headroom above the arm. Revisit once the tracked workspace is known.
const SCENE_W = 2 * ENVELOPE * FRAME_PAD;                            // min visible width
const MIN_VIS_H = (FLOOR_Y + SHOULDER_Y + ENVELOPE) * FRAME_PAD;      // min visible height
const BASE_H = 0.25;
const REST = { t1: THREE.MathUtils.degToRad(100), t2: THREE.MathUtils.degToRad(-70) };
const COLORS = {
  body: 0xefebe0, joint: 0xd9d2c0, edge: 0x8b8577, path: 0x2b6555,
};

// ---------- renderer, camera, lights ----------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
} catch (err) {
  // No WebGL: undo what the loader did and fall back to the single-column hero.
  cell.hidden = true;
  const hero = cell.closest('.hero');
  if (hero) hero.classList.add('hero--solo');
  const hint = document.querySelector('[data-hint]');
  if (hint) hint.hidden = true;
  throw err;
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 100);
scene.add(new THREE.HemisphereLight(0xfffaf0, 0xd9d2c0, 2.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-4, 8, 6);
scene.add(sun);

const rig = new THREE.Group();       // everything that stands on the floor
rig.position.y = FLOOR_Y;
scene.add(rig);

let visW = SCENE_W, visH = SCENE_W; // visible scene width/height at z = 0; set by resize()
function resize() {
  const w = cell.clientWidth, h = cell.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  const aspect = w / h;
  camera.aspect = aspect;
  visW = Math.max(SCENE_W, MIN_VIS_H * aspect);
  visH = visW / aspect;
  const dist = (visW / 2) / (aspect * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.position.set(0, visH / 2, dist);
  camera.lookAt(0, visH / 2, 0);
  camera.far = dist + SCENE_W;
  camera.updateProjectionMatrix();
}

// ---------- materials ----------
const bodyMat = new THREE.MeshStandardMaterial({ color: COLORS.body, roughness: 0.92, metalness: 0 });
const jointMat = new THREE.MeshStandardMaterial({ color: COLORS.joint, roughness: 0.92, metalness: 0 });
const edgeMat = new THREE.LineBasicMaterial({ color: COLORS.edge, transparent: true, opacity: 0.7 });

function part(geom, mat, x = 0, y = 0, z = 0, rz = 0, edges = new THREE.EdgesGeometry(geom, 20)) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(geom, mat);
  m.add(new THREE.LineSegments(edges, edgeMat));
  g.add(m);
  g.position.set(x, y, z);
  g.rotation.z = rz;
  return g;
}
const cyl = (r, h) => new THREE.CylinderGeometry(r, r, h, 24);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// ---------- the arm: base → shoulder → link1 → elbow → link2 → wrist → palm → fingers ----------
const base = part(cyl(0.9, BASE_H), jointMat, 0, BASE_H / 2);
rig.add(base);
const pedestal = part(box(0.6, SHOULDER_Y - BASE_H, 0.6), bodyMat, 0, BASE_H + (SHOULDER_Y - BASE_H) / 2);
rig.add(pedestal);

const shoulder = new THREE.Group();
shoulder.position.set(0, SHOULDER_Y, 0);
rig.add(shoulder);
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
const fingerGeom = box(FINGER_W, 0.7, 0.4);
const fingerEdges = new THREE.EdgesGeometry(fingerGeom, 20);
const fingerL = part(fingerGeom, bodyMat, 0, 0.725, 0, 0, fingerEdges);
const fingerR = part(fingerGeom, bodyMat, 0, 0.725, 0, 0, fingerEdges);
wrist.add(fingerL, fingerR);

// ---------- trajectory line ----------
const PATH_N = 24;
// NOTE: LineDashedMaterial needs computeLineDistances() after every position write, and the
// zero buffer gives a zero bounding sphere, so the line is not frustum culled.
const pathGeom = new THREE.BufferGeometry();
const pathPos = new THREE.BufferAttribute(new Float32Array(PATH_N * 3), 3);
pathPos.setUsage(THREE.DynamicDrawUsage);
pathGeom.setAttribute('position', pathPos);
const pathMat = new THREE.LineDashedMaterial({ color: COLORS.path, dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0 });
const pathLine = new THREE.Line(pathGeom, pathMat);
pathLine.frustumCulled = false;
pathLine.position.y = SHOULDER_Y;
rig.add(pathLine);

// ---------- pose application ----------
// Links are modelled along +y, so a shoulder angle of t1 (from +x) is a z-rotation of t1 - 90°.
function applyPose(t1, t2, wristRel, jaw) {
  shoulder.rotation.z = t1 - Math.PI / 2;
  elbow.rotation.z = t2;
  wrist.rotation.z = wristRel;
  fingerL.position.x = -jaw / 2;
  fingerR.position.x = jaw / 2;
}

// ---------- coordinate mapping (client px → scene units, shoulder-relative) ----------
function toScene(cx, cy) {
  const r = canvas.getBoundingClientRect();
  const x = ((cx - r.left) / r.width) * visW - visW / 2;
  const y = ((r.bottom - cy) / r.height) * visH - FLOOR_Y - SHOULDER_Y;
  return { x, y };
}

// ---------- state ----------
const S = { IDLE: 'idle', TRACKING: 'tracking', PLANNING: 'planning', REACHING: 'reaching', GRASP: 'grasp' };
let state = S.IDLE;
function setState(s) { if (s === state) return; state = s; if (stateEl) stateEl.textContent = s; }

const cur = { t1: REST.t1, t2: REST.t2, w: 0, jaw: JAW.relaxed };
const goal = { t1: REST.t1, t2: REST.t2, w: 0, jaw: JAW.relaxed };
let lambda = 8;             // smoothing rate: 8 tracking, 5 settling to rest, 14 reach, 30 grasp
let elbowSign = -1;
let cursor = null;          // last cursor in shoulder-relative scene units, or null when off-page
let sleeping = false;       // stillness timer fired; stop the loop once converged
let stillTimer = 0;
const STILL_MS = 2000;

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));      // into (-π, π]
const nearest = (a, ref) => ref + wrap(a - ref);               // equivalent of a closest to ref, so damping never takes the long way round

function aimAt(p) {
  // hysteresis on the elbow side so a cursor near x = 0 does not flap;
  // while a target is committed (PLANNING/REACHING/GRASP) the sign holds instead
  if (!target) { if (p.x > 0.4) elbowSign = -1; else if (p.x < -0.4) elbowSign = 1; }
  const ik = solveIK(p.x, p.y, elbowSign);
  goal.t1 = ik.t1; goal.t2 = ik.t2;
  // jaws face the bearing to the target: absolute palm angle = bearing, so wrist relative = bearing - (t1 + t2)
  goal.w = wrap(Math.atan2(ik.y, ik.x) - (ik.t1 + ik.t2));
  return ik;
}

function restPose() {
  goal.t1 = REST.t1; goal.t2 = REST.t2; goal.w = 0; goal.jaw = JAW.relaxed;
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- planning / reaching / grasp ----------
const PLAN_MS = 120, REACH_MS = 350, FADE_MS = 200, PULSE_MS = 150, PATH_ALPHA = 0.85;
let target = null;      // shoulder-relative scene point of the hovered element (clamped to reach)
let targetEl = null;    // the element being targeted, so focus after pointerenter does not re-plan
let path = null;        // { p0, p1, p2 }
let clock = 0;          // ms elapsed in the current time-based state
let arrived = false;

function elementPoint(el) {
  const r = el.getBoundingClientRect();
  return toScene(r.left + r.width / 2, r.top + r.height / 2);
}
function writePath() {
  const pos = pathGeom.attributes.position;
  for (let i = 0; i < PATH_N; i++) {
    const p = bezier(path.p0, path.p1, path.p2, i / (PATH_N - 1));
    pos.setXYZ(i, p.x, p.y, 0.3);
  }
  pos.needsUpdate = true;
  pathLine.computeLineDistances();
}
function retarget(el) {
  // elbowSign is committed by plan() and held for the whole reach; a resize must not flip it
  const raw = elementPoint(el);
  const ik = solveIK(raw.x, raw.y, elbowSign);
  target = { x: ik.x, y: ik.y };               // clamped to reach along the bearing
  const p0 = forward(cur.t1, cur.t2);
  const dx = target.x - p0.x, dy = target.y - p0.y;
  // control point: chord midpoint pushed 25% of the chord length along the
  // perpendicular (-dy, dx), on the side that keeps the elbow up
  const side = elbowSign < 0 ? 1 : -1;
  const p1 = { x: (p0.x + target.x) / 2 - side * dy * 0.25, y: (p0.y + target.y) / 2 + side * dx * 0.25 };
  path = { p0: { x: p0.x, y: p0.y }, p1, p2: target };
  writePath();
}
function plan(el) {
  if (targetEl === el) return;
  targetEl = el;
  const raw = elementPoint(el);
  elbowSign = raw.x > 0.4 ? -1 : raw.x < -0.4 ? 1 : elbowSign;
  retarget(el);
  aimAt(path.p0); // hold position during the fade; if plan() flipped the elbow, that swing is spent here
  clock = 0; arrived = false;
  setState(S.PLANNING);
  wake();
}
function release(el) {
  if (el && targetEl !== el) return;
  target = null; targetEl = null; path = null; arrived = false;
  goal.jaw = JAW.relaxed;
  if (cursor) { lambda = 8; aimAt(cursor); setState(S.TRACKING); wake(); }
  else { lambda = 5; restPose(); setState(S.TRACKING); settle(); }
}
function grasp() {
  if (!target) return;
  // interrupting the fade-in: jump straight to full opacity so the later arrival fade has no pop
  if (state === S.PLANNING) { clock = 0; lambda = 14; pathMat.opacity = PATH_ALPHA; }
  goal.jaw = JAW.closed; setState(S.GRASP); wake();
}
function ungrasp() { if (state === S.GRASP) { goal.jaw = JAW.open; setState(S.REACHING); wake(); } }

function step(dt) {
  const ms = dt * 1000;
  if (state === S.PLANNING) {
    clock += ms;
    pathMat.opacity = Math.min(1, clock / PLAN_MS) * PATH_ALPHA;
    if (clock >= PLAN_MS) { clock = 0; lambda = 14; setState(S.REACHING); goal.jaw = JAW.open; }
  } else if (state === S.REACHING || state === S.GRASP) {
    clock += ms;
    if (!arrived) {
      const u = easeInOut(Math.min(1, clock / REACH_MS));
      aimAt(bezier(path.p0, path.p1, path.p2, u));
      if (u >= 1) { arrived = true; clock = 0; }
    } else {
      pathMat.opacity = Math.max(0, PATH_ALPHA * (1 - clock / FADE_MS));
      aimAt(target);
    }
  } else if (pathMat.opacity > 0) {
    pathMat.opacity = Math.max(0, pathMat.opacity - (ms / FADE_MS) * PATH_ALPHA);
  }
}

// ---------- loop ----------
let running = false, last = 0;
let visible = true;
function converged() {
  return Math.abs(wrap(goal.t1 - cur.t1)) < 1e-3 && Math.abs(wrap(goal.t2 - cur.t2)) < 1e-3 &&
         Math.abs(wrap(goal.w - cur.w)) < 1e-3 && Math.abs(goal.jaw - cur.jaw) < 1e-3 &&
         pathMat.opacity < 1e-3;
}
function tick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000) || 0.016);
  last = now;
  step(dt);
  cur.t1 = damp(cur.t1, nearest(goal.t1, cur.t1), lambda, dt);
  cur.t2 = damp(cur.t2, nearest(goal.t2, cur.t2), lambda, dt);
  cur.w = damp(cur.w, nearest(goal.w, cur.w), lambda, dt);
  cur.jaw = damp(cur.jaw, goal.jaw, state === S.GRASP ? 30 : lambda, dt);
  applyPose(cur.t1, cur.t2, cur.w, cur.jaw);
  renderer.render(scene, camera);
  const canStop = state === S.TRACKING || state === S.IDLE || ((state === S.REACHING || state === S.GRASP) && arrived);
  if (sleeping && canStop && converged()) {
    // Stop the loop. Time-driven states (PLANNING, mid-REACH) never stop here; a held
    // hover target keeps `target` set so the next pointermove does not yank the arm off the link.
    // GRASP keeps its label while stopped: jaws stay clamped and pointerup/Enter must still open them.
    running = false;
    if (state !== S.IDLE && state !== S.GRASP) setState(S.IDLE);
    return;
  }
  if (!visible) { running = false; return; }
  requestAnimationFrame(tick);
}
function start() {
  if (!visible) return;
  if (!running) { running = true; last = performance.now(); requestAnimationFrame(tick); }
}
function wake() {
  if (!visible) return;
  sleeping = false;
  clearTimeout(stillTimer);
  stillTimer = setTimeout(() => { sleeping = true; }, STILL_MS);
  start();
}
// No stillness grace: the loop stops as soon as the pose converges.
function settle() {
  clearTimeout(stillTimer);
  sleeping = true;
  start();
}

// ---------- input ----------
if (!reducedMotion) {
  document.addEventListener('pointermove', (e) => {
    cursor = toScene(e.clientX, e.clientY);
    if (!target && (state === S.IDLE || state === S.TRACKING)) { setState(S.TRACKING); lambda = 8; aimAt(cursor); goal.jaw = JAW.relaxed; }
    wake();
  }, { passive: true });
  // pointerleave on <html> fires when the pointer exits the viewport;
  // on document it does not fire reliably in every browser.
  document.documentElement.addEventListener('pointerleave', () => {
    cursor = null;
    if (target) { release(targetEl); return; }
    if (state === S.TRACKING || state === S.IDLE) { lambda = 5; restPose(); settle(); }
  });
  document.addEventListener('pointerup', ungrasp);
  document.addEventListener('pointercancel', ungrasp);
  window.addEventListener('blur', ungrasp);

  document.querySelectorAll('[data-grasp]').forEach((el) => {
    el.addEventListener('pointerenter', () => plan(el));
    el.addEventListener('pointerleave', () => release(el));
    el.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; grasp(); });
    el.addEventListener('focus', () => plan(el));
    el.addEventListener('blur', () => release(el));
    el.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.key === 'Enter' || (e.key === ' ' && el.matches('button,[role="button"]'))) { grasp(); setTimeout(ungrasp, PULSE_MS); }
    });
  });

  // Pointer motion over a hero scrolled out of view must not restart an invisible loop.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) start(); }).observe(cell);
  }
}

// ---------- startup ----------
applyPose(REST.t1, REST.t2, 0, JAW.relaxed);
// The observer fires once on observe(), so the first frame is drawn at the real size.
// While the loop runs, tick() renders; otherwise draw one frame here.
new ResizeObserver(() => {
  if (!cell.clientWidth || !cell.clientHeight) return;
  resize();
  if (targetEl) {
    retarget(targetEl);
    if (arrived) { aimAt(target); wake(); }                       // parked (possibly IDLE): move to the new spot
    else if (state === S.REACHING || state === S.GRASP) { clock = 0; arrived = false; } // mid-reach: restart from here
  }
  if (!running) renderer.render(scene, camera);
}).observe(cell);

