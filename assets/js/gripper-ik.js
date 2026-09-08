// Pure planar kinematics for the hero gripper. No DOM, no three.js, so node
// can test it. Angles in radians; t1 is the shoulder angle from +x, t2 the
// elbow bend relative to link 1. Shoulder is the origin.

export const L1 = 2.6;
export const L2 = 2.2;
export const REACH = L1 + L2 - 0.01;
const MIN_REACH = Math.abs(L1 - L2) + 0.05;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// elbow: -1 bends clockwise (elbow above the chord for targets on the right),
// +1 bends counter-clockwise (elbow above the chord for targets on the left).
export function solveIK(tx, ty, elbow = -1) {
  let d = Math.hypot(tx, ty);
  if (d < 1e-9) { tx = 0; ty = MIN_REACH; d = MIN_REACH; }
  const dc = clamp(d, MIN_REACH, REACH);
  const s = dc / d;
  const x = tx * s, y = ty * s;
  const c2 = clamp((dc * dc - L1 * L1 - L2 * L2) / (2 * L1 * L2), -1, 1);
  const t2 = Math.sign(elbow) * Math.acos(c2);
  const t1 = Math.atan2(y, x) - Math.atan2(L2 * Math.sin(t2), L1 + L2 * Math.cos(t2));
  return { t1, t2, x, y, clamped: dc !== d };
}

export function forward(t1, t2) {
  const ex = L1 * Math.cos(t1), ey = L1 * Math.sin(t1);
  return { elbow: { x: ex, y: ey }, x: ex + L2 * Math.cos(t1 + t2), y: ey + L2 * Math.sin(t1 + t2) };
}

export function bezier(p0, p1, p2, u) {
  const v = 1 - u;
  return {
    x: v * v * p0.x + 2 * v * u * p1.x + u * u * p2.x,
    y: v * v * p0.y + 2 * v * u * p1.y + u * u * p2.y,
  };
}

export function easeInOut(u) {
  return u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
}

// Frame-rate independent exponential approach: lambda is the rate, dt in seconds.
export function damp(current, goal, lambda, dt) {
  return current + (goal - current) * (1 - Math.exp(-lambda * dt));
}
