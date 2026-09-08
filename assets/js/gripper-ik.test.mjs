import assert from 'node:assert/strict';
import { L1, L2, REACH, MIN_REACH, solveIK, forward, bezier, easeInOut, damp } from './gripper-ik.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// Forward kinematics of the IK solution lands on the target when in reach.
{
  const t = { x: 2.0, y: 3.0 };
  const s = solveIK(t.x, t.y, -1);
  const p = forward(s.t1, s.t2);
  assert.ok(close(p.x, t.x, 1e-6) && close(p.y, t.y, 1e-6), `reach ${JSON.stringify(p)}`);
  assert.equal(s.clamped, false);
}

// Out-of-reach targets are clamped to the reach circle along the same bearing.
{
  const s = solveIK(40, 30, -1);
  const p = forward(s.t1, s.t2);
  const r = Math.hypot(p.x, p.y);
  assert.ok(close(r, REACH, 1e-6), `clamped radius ${r}`);
  assert.ok(close(Math.atan2(p.y, p.x), Math.atan2(30, 40), 1e-6));
  assert.equal(s.clamped, true);
}

// Elbow sign flips the bend direction, not the end position.
{
  const a = solveIK(1.5, 2.5, -1), b = solveIK(1.5, 2.5, +1);
  assert.ok(a.t2 < 0 && b.t2 > 0);
  const pa = forward(a.t1, a.t2), pb = forward(b.t1, b.t2);
  assert.ok(close(pa.x, pb.x) && close(pa.y, pb.y));
}

// A target at the shoulder does not produce NaN.
{
  const s = solveIK(0, 0, -1);
  assert.ok(Number.isFinite(s.t1) && Number.isFinite(s.t2));
}

// Non-finite input falls back to the same safe pose instead of NaN.
{
  for (const [x, y] of [[NaN, 1], [Infinity, 1], [1, -Infinity]]) {
    const s = solveIK(x, y, -1);
    assert.ok(Number.isFinite(s.t1) && Number.isFinite(s.t2) && Number.isFinite(s.x) && Number.isFinite(s.y), `finite for ${x},${y}`);
  }
}

// Near-origin targets are pushed out to MIN_REACH along the same bearing.
{
  const s = solveIK(0.1, 0.1, -1);
  const p = forward(s.t1, s.t2);
  assert.ok(close(Math.hypot(p.x, p.y), MIN_REACH, 1e-6));
  assert.ok(close(Math.atan2(p.y, p.x), Math.atan2(0.1, 0.1), 1e-6));
  assert.equal(s.clamped, true);
}

// Bezier endpoints and easing endpoints.
{
  const p0 = { x: 0, y: 0 }, p1 = { x: 1, y: 2 }, p2 = { x: 2, y: 0 };
  assert.deepEqual(bezier(p0, p1, p2, 0), { x: 0, y: 0 });
  assert.deepEqual(bezier(p0, p1, p2, 1), { x: 2, y: 0 });
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.ok(easeInOut(0.5) > 0.49 && easeInOut(0.5) < 0.51);
}

// damp moves toward the goal and never overshoots.
{
  let v = 0;
  for (let i = 0; i < 100; i++) v = damp(v, 1, 8, 1 / 60);
  assert.ok(v > 0.99 && v <= 1);
}

console.log('gripper-ik: all assertions passed');
