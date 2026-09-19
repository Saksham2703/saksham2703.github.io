import * as THREE from 'three';
import { bezier, easeInOut, damp } from './gripper-ik.js';

// An XY gantry drawn over the whole page: a rail along the top edge of the viewport, a carriage
// that slides along it, and a telescoping column that lowers a parallel-jaw gripper to the cursor
// or to whatever link is hovered. The hero cell is the dock it parks in.

const cell = document.querySelector('[data-cell]');
if (!cell) throw new Error('gripper: no cell');
const stateEl = cell.querySelector('[data-cell-state]');
function degrade() {
  cell.hidden = true;
  const hero = cell.closest('.hero');
  if (hero) hero.classList.add('hero--solo');
  const hint = document.querySelector('[data-hint]');
  if (hint) hint.hidden = true;
}

// ---------- geometry, in CSS px; scene x = client x, scene y = -client y ----------
const RAIL_H = 10;
const CARRIAGE = { w: 58, h: 26 };
const COL_TOP = RAIL_H - 4 + CARRIAGE.h;      // client y where the column leaves the carriage
const COL_W = [16, 12, 9];                    // telescoping stages, outer to inner
const COL_OV = 14;                            // overlap kept between extended stages
const WRIST_R = 12;
const PALM = { w: 78, h: 14 };
const FINGER = { w: 10, len: 34, d: 6 };
const TIP = 4 + PALM.h + FINGER.len;          // wrist centre → fingertip
const MIN_TIP = COL_TOP + TIP;                // fingertip when fully retracted
const JAW = { closed: FINGER.w + 2, relaxed: 30, open: 64 };
const HOVER = 26;                             // fingertips ride this far above the cursor
const EDGE = PALM.w / 2 + 6;                  // keep the palm inside the viewport
const COLORS = { body: 0xefebe0, joint: 0xd9d2c0, edge: 0x8b8577, path: 0x2b6555 };

// ---------- renderer, camera, lights ----------
const canvas = document.createElement('canvas');
canvas.className = 'arm';
canvas.setAttribute('aria-hidden', 'true');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
} catch (err) {
  degrade();
  throw err;
}
document.body.appendChild(canvas);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(0, 1, 0, -1, 0.1, 200);
camera.position.z = 100;
scene.add(new THREE.HemisphereLight(0xfffaf0, 0xd9d2c0, 2.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-4, 8, 6);
scene.add(sun);

let W = 1, H = 1, maxTip = MIN_TIP, stageLen = 1;
function resize() {
  W = innerWidth; H = innerHeight;
  renderer.setSize(W, H, false);
  camera.right = W; camera.bottom = -H;
  camera.updateProjectionMatrix();
  rail.scale.x = W; rail.position.x = W / 2;
  maxTip = Math.max(MIN_TIP, H - 6);
  stageLen = (maxTip - MIN_TIP) / COL_W.length;
}

// ---------- materials, parts ----------
const bodyMat = new THREE.MeshStandardMaterial({ color: COLORS.body, roughness: 0.92, metalness: 0 });
const jointMat = new THREE.MeshStandardMaterial({ color: COLORS.joint, roughness: 0.92, metalness: 0 });
const edgeMat = new THREE.LineBasicMaterial({ color: COLORS.edge, transparent: true, opacity: 0.7 });
function part(geom, mat, x = 0, y = 0, z = 0, edges = new THREE.EdgesGeometry(geom, 20)) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(geom, mat);
  m.add(new THREE.LineSegments(edges, edgeMat));
  g.add(m);
  g.position.set(x, y, z);
  return g;
}
const cyl = (r, h) => new THREE.CylinderGeometry(r, r, h, 24);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

// ---------- rail → carriage → column stages → wrist → palm → fingers ----------
const rail = part(box(1, RAIL_H, 6), jointMat, 0, -RAIL_H / 2, 0);   // unit width; resize() stretches it
scene.add(rail);

const car = new THREE.Group();
scene.add(car);
// wheels lie along z so their round face looks at the viewer
car.add(part(box(CARRIAGE.w, CARRIAGE.h, 6), bodyMat, 0, -(RAIL_H - 4 + CARRIAGE.h / 2), 8));
car.add(part(cyl(6, 6), jointMat, -19, -7, 16).rotateX(Math.PI / 2));
car.add(part(cyl(6, 6), jointMat, 19, -7, 16).rotateX(Math.PI / 2));
const stages = COL_W.map((w, i) => { const g = part(box(w, 1, 6), bodyMat, 0, 0, 24 + 8 * i); car.add(g); return g; });

const wrist = new THREE.Group();
car.add(wrist);
wrist.add(part(box(PALM.w, PALM.h, 6), bodyMat, 0, -(4 + PALM.h / 2), 48));
wrist.add(part(cyl(WRIST_R, 6), jointMat, 0, 0, 56).rotateX(Math.PI / 2));
const fingerGeom = box(FINGER.w, FINGER.len, FINGER.d);
const fingerEdges = new THREE.EdgesGeometry(fingerGeom, 20);
const fingerY = -(4 + PALM.h + FINGER.len / 2);
const fingerL = part(fingerGeom, bodyMat, 0, fingerY, 56, fingerEdges);
const fingerR = part(fingerGeom, bodyMat, 0, fingerY, 56, fingerEdges);
wrist.add(fingerL, fingerR);

// ---------- trajectory line ----------
const PATH_N = 24;
// NOTE: LineDashedMaterial needs computeLineDistances() after every position write, and the
// zero buffer gives a zero bounding sphere, so the line is not frustum culled.
const pathGeom = new THREE.BufferGeometry();
const pathPos = new THREE.BufferAttribute(new Float32Array(PATH_N * 3), 3);
pathPos.setUsage(THREE.DynamicDrawUsage);
pathGeom.setAttribute('position', pathPos);
const pathMat = new THREE.LineDashedMaterial({ color: COLORS.path, dashSize: 9, gapSize: 6, transparent: true, opacity: 0 });
const pathLine = new THREE.Line(pathGeom, pathMat);
pathLine.frustumCulled = false;
scene.add(pathLine);

// ---------- pose application: x = carriage, y = fingertip client y, jaw = finger spacing ----------
function applyPose(x, y, jaw) {
  car.position.x = x;
  const drop = y - MIN_TIP;
  wrist.position.y = -(COL_TOP + drop);
  stages.forEach((g, i) => {
    const bot = Math.min(drop, (i + 1) * stageLen);
    const top = Math.max(i * stageLen - COL_OV, bot - stageLen);
    const len = bot - top;
    g.visible = len > 0.5;
    g.position.y = -(COL_TOP + (top + bot) / 2);
    g.scale.y = Math.max(len, 0.01);
  });
  fingerL.position.x = -jaw / 2;
  fingerR.position.x = jaw / 2;
}

// ---------- reach ----------
function clampAim(p) {
  return { x: Math.min(W - EDGE, Math.max(EDGE, p.x)), y: Math.min(maxTip, Math.max(MIN_TIP, p.y)) };
}

// ---------- state ----------
const S = { IDLE: 'idle', TRACKING: 'tracking', PLANNING: 'planning', REACHING: 'reaching', GRASP: 'grasp' };
let state = S.IDLE;
function setState(s) { if (s === state) return; state = s; if (stateEl) stateEl.textContent = s; }

const cur = { x: 0, y: MIN_TIP, jaw: JAW.relaxed };
const goal = { x: 0, y: MIN_TIP, jaw: JAW.relaxed };
let lambda = 8;             // smoothing rate: 8 tracking, 5 settling to rest, 14 reach, 30 grasp
let cursor = null;          // last fingertip aim for the cursor, or null when off-page
let sleeping = false;       // stillness timer fired; stop the loop once converged
let stillTimer = 0;
const STILL_MS = 2000;

function aimAt(p) { p = clampAim(p); goal.x = p.x; goal.y = p.y; return p; }

// Rest: park in the hero cell while it is on screen, otherwise retract to the rail. The bay is
// entered a quarter of the way in so the column clears the nav links above it.
function dockPoint() {
  if (cell.hidden) return null;
  const r = cell.getBoundingClientRect();
  const c = { x: r.left + r.width / 4, y: r.top + r.height / 2 };
  return r.width && c.y > MIN_TIP + 60 && c.y < H - 60 ? c : null;
}
function restPose() {
  const d = dockPoint();
  if (d) aimAt(d); else goal.y = MIN_TIP;
  goal.jaw = JAW.relaxed;
}

// ---------- planning / reaching / grasp ----------
const PLAN_MS = 120, REACH_MS = 350, FADE_MS = 200, PULSE_MS = 150, PATH_ALPHA = 0.85;
let target = null;      // fingertip aim on the hovered element (clamped to the viewport)
let targetEl = null;    // the element being targeted, so focus after pointerenter does not re-plan
let path = null;        // { p0, p1, p2 }
let clock = 0;          // ms elapsed in the current time-based state
let arrived = false;

function elementPoint(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
function writePath() {
  const pos = pathGeom.attributes.position;
  for (let i = 0; i < PATH_N; i++) {
    const p = bezier(path.p0, path.p1, path.p2, i / (PATH_N - 1));
    pos.setXYZ(i, p.x, -p.y, 64);
  }
  pos.needsUpdate = true;
  pathLine.computeLineDistances();
}
function retarget(el) {
  target = clampAim(elementPoint(el));
  const p0 = { x: cur.x, y: cur.y };
  // lift-and-place: the control point sits above the chord midpoint, never above the rail
  const chord = Math.hypot(target.x - p0.x, target.y - p0.y);
  const p1 = { x: (p0.x + target.x) / 2, y: Math.max(MIN_TIP, (p0.y + target.y) / 2 - chord * 0.3) };
  path = { p0, p1, p2: target };
  writePath();
}
function plan(el) {
  if (targetEl === el) return;
  targetEl = el;
  retarget(el);
  aimAt(path.p0); // hold position during the fade
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
function ungrasp() { if (state === S.GRASP) { goal.jaw = arrived ? JAW.closed : JAW.open; setState(S.REACHING); wake(); } }
// The page moved under a held target: re-plan from wherever the arm is now.
function refreshTarget() {
  if (!targetEl) return;
  retarget(targetEl);
  if (arrived) { aimAt(target); wake(); }
  else if (state === S.REACHING || state === S.GRASP) { clock = 0; arrived = false; }
}

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
      if (u >= 1) { arrived = true; clock = 0; if (state === S.REACHING) goal.jaw = JAW.closed; } // close on the link
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
function converged() {
  return Math.abs(goal.x - cur.x) < 0.05 && Math.abs(goal.y - cur.y) < 0.05 &&
         Math.abs(goal.jaw - cur.jaw) < 0.05 && pathMat.opacity < 1e-3;
}
function tick(now) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000) || 0.016);
  last = now;
  step(dt);
  cur.x = damp(cur.x, goal.x, lambda, dt);
  cur.y = damp(cur.y, goal.y, lambda, dt);
  cur.jaw = damp(cur.jaw, goal.jaw, state === S.GRASP ? 30 : lambda, dt);
  applyPose(cur.x, cur.y, cur.jaw);
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
  requestAnimationFrame(tick);
}
function start() {
  if (!running) { running = true; last = performance.now(); requestAnimationFrame(tick); }
}
function wake() {
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
let px = 0, py = 0; // last client position, so a scroll can re-aim without a pointermove
const track = () => {
  cursor = { x: px, y: py - HOVER };
  if (!target && (state === S.IDLE || state === S.TRACKING)) { setState(S.TRACKING); lambda = 8; aimAt(cursor); goal.jaw = JAW.relaxed; }
  wake();
};
document.addEventListener('pointermove', (e) => { px = e.clientX; py = e.clientY; track(); }, { passive: true });
addEventListener('scroll', () => {
  if (target) { refreshTarget(); wake(); }
  else if (cursor) track();
  else if (state === S.IDLE || state === S.TRACKING) { lambda = 5; restPose(); settle(); }
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

document.querySelectorAll('a[href], button').forEach((el) => {
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

addEventListener('resize', () => {
  resize();
  if (target) refreshTarget();
  else if (!cursor) restPose();
  if (!running) { applyPose(cur.x, cur.y, cur.jaw); renderer.render(scene, camera); }
});

// ---------- startup: begin parked in the dock ----------
resize();
restPose();
cur.x = goal.x; cur.y = goal.y;
applyPose(cur.x, cur.y, cur.jaw);
renderer.render(scene, camera);
