// Numerical check: does the drawn orbit ellipse stay coincident with the
// moving dot? Reproduces the exact math of lib/satellite.ts (cache anchor +
// second-order extrapolation + getOrbitEllipseFromSceneState) against raw
// SGP4 truth, for a spread of real TLEs from the bundled snapshot.
import fs from 'node:fs';
import * as satellite from 'satellite.js';

const R = 6371;
const SCENE_SCALE = 1 / R;
const MU = 398600.4418;
const MU_SCENE = MU * SCENE_SCALE ** 3;

const raw = fs.readFileSync('public/tle-snapshot.txt', 'utf8').split(/\r?\n/);
const sats = [];
for (let i = 0; i + 2 < raw.length; i += 3) {
  const name = raw[i].trim();
  const l1 = raw[i + 1], l2 = raw[i + 2];
  if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) continue;
  try {
    const rec = satellite.twoline2satrec(l1, l2);
    if (rec.error === 0) sats.push({ name, rec });
  } catch {}
}
console.log(`parsed ${sats.length} satrecs`);

function anchor(rec, ms) {
  const tsince = (ms / 86400000 + 2440587.5 - rec.jdsatepoch) * 1440;
  const pv = satellite.sgp4(rec, tsince);
  const p = pv.position, v = pv.velocity;
  if (!p || !v || typeof p === 'boolean' || !isFinite(p.x)) return null;
  const s = {
    x: p.x * SCENE_SCALE, y: p.z * SCENE_SCALE, z: -p.y * SCENE_SCALE,
    vx: v.x * SCENE_SCALE, vy: v.z * SCENE_SCALE, vz: -v.y * SCENE_SCALE,
  };
  const r2 = s.x ** 2 + s.y ** 2 + s.z ** 2;
  const g = -MU_SCENE / (r2 * Math.sqrt(r2));
  s.ax = g * s.x; s.ay = g * s.y; s.az = g * s.z;
  return s;
}

function extrap(a, dtSec) {
  const h = 0.5 * dtSec * dtSec;
  return {
    x: a.x + a.vx * dtSec + a.ax * h,
    y: a.y + a.vy * dtSec + a.ay * h,
    z: a.z + a.vz * dtSec + a.az * h,
  };
}

function truth(rec, ms) {
  const tsince = (ms / 86400000 + 2440587.5 - rec.jdsatepoch) * 1440;
  const pv = satellite.sgp4(rec, tsince);
  const p = pv.position;
  if (!p || typeof p === 'boolean' || !isFinite(p.x)) return null;
  return { x: p.x * SCENE_SCALE, y: p.z * SCENE_SCALE, z: -p.y * SCENE_SCALE };
}

// Ellipse from scene state — mirror of getOrbitEllipseFromSceneState
function ellipse(s, segments = 256) {
  const rlen = Math.hypot(s.x, s.y, s.z);
  const v2 = s.vx ** 2 + s.vy ** 2 + s.vz ** 2;
  const a = 1 / (2 / rlen - v2 / MU_SCENE);
  if (!isFinite(a) || a <= 0) return null;
  const hx = s.y * s.vz - s.z * s.vy;
  const hy = s.z * s.vx - s.x * s.vz;
  const hz = s.x * s.vy - s.y * s.vx;
  const hlen = Math.hypot(hx, hy, hz);
  if (hlen < 1e-12) return null;
  const wx = hx / hlen, wy = hy / hlen, wz = hz / hlen;
  const rv = s.x * s.vx + s.y * s.vy + s.z * s.vz;
  const c1 = v2 - MU_SCENE / rlen;
  const ex = (c1 * s.x - rv * s.vx) / MU_SCENE;
  const ey = (c1 * s.y - rv * s.vy) / MU_SCENE;
  const ez = (c1 * s.z - rv * s.vz) / MU_SCENE;
  const e = Math.hypot(ex, ey, ez);
  if (e >= 0.999) return null;
  let px, py, pz;
  if (e > 1e-6) { px = ex / e; py = ey / e; pz = ez / e; }
  else { px = s.x / rlen; py = s.y / rlen; pz = s.z / rlen; }
  const qx = wy * pz - wz * py, qy = wz * px - wx * pz, qz = wx * py - wy * px;
  const b = a * Math.sqrt(1 - e * e);
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const E = (i / segments) * 2 * Math.PI;
    const X = a * (Math.cos(E) - e), Y = b * Math.sin(E);
    pts.push([X * px + Y * qx, X * py + Y * qy, X * pz + Y * qz]);
  }
  return pts;
}

/** Perpendicular distance from p to the polyline, in km. */
function distToPath(pts, p) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay, az] = pts[i], [bx, by, bz] = pts[i + 1];
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len2 = dx * dx + dy * dy + dz * dz;
    let t = len2 > 0 ? ((p.x - ax) * dx + (p.y - ay) * dy + (p.z - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx - p.x, cy = ay + t * dy - p.y, cz = az + t * dz - p.z;
    const d = cx * cx + cy * cy + cz * cz;
    if (d < best) best = d;
  }
  return Math.sqrt(best) * R;
}

const now = Date.now();
// Sample a spread across the catalog (LEO, MEO, GEO, HEO all included).
const step = Math.max(1, Math.floor(sats.length / 400));
const WINDOW = 90; // seconds — MAX_EXTRAP_WINDOW_MS
let n = 0;
let maxDotToPath = 0, sumDotToPath = 0, worst = null;
let maxExtrapErr = 0, sumExtrapErr = 0, worstExtrap = null;
let maxLinearErr = 0; // old first-order behaviour, for comparison

for (let i = 0; i < sats.length; i += step) {
  const { name, rec } = sats[i];
  const a = anchor(rec, now);
  if (!a) continue;
  const pts = ellipse(a);
  if (!pts) continue;
  n++;
  for (const dt of [0, 15, 30, 45, 60, 75, 90]) {
    const ms = now + dt * 1000;
    const dot = extrap(a, dt);
    const tru = truth(rec, ms);
    // 1. Is the rendered dot ON the rendered orbit line? (the reported bug)
    const dp = distToPath(pts, dot);
    sumDotToPath += dp;
    if (dp > maxDotToPath) { maxDotToPath = dp; worst = `${name} @+${dt}s`; }
    // 2. How far is the dot from true SGP4?
    if (tru) {
      const err = Math.hypot(dot.x - tru.x, dot.y - tru.y, dot.z - tru.z) * R;
      sumExtrapErr += err;
      if (err > maxExtrapErr) { maxExtrapErr = err; worstExtrap = `${name} @+${dt}s`; }
      const lin = {
        x: a.x + a.vx * dt, y: a.y + a.vy * dt, z: a.z + a.vz * dt,
      };
      const lerr = Math.hypot(lin.x - tru.x, lin.y - tru.y, lin.z - tru.z) * R;
      if (lerr > maxLinearErr) maxLinearErr = lerr;
    }
  }
}

const samples = n * 7;
console.log(`\nchecked ${n} satellites × 7 time samples over a ${WINDOW}s anchor window\n`);
console.log(`dot→orbit-line distance   mean ${(sumDotToPath / samples).toFixed(4)} km   max ${maxDotToPath.toFixed(4)} km  (${worst})`);
console.log(`dot→true SGP4 error       mean ${(sumExtrapErr / samples).toFixed(4)} km   max ${maxExtrapErr.toFixed(4)} km  (${worstExtrap})`);
console.log(`  ...same, 1st-order (old)                              max ${maxLinearErr.toFixed(2)} km`);
console.log(`\nvisual tolerance: 1 px at typical zoom ≈ 20 km; dot radius ≈ 10 km`);

// --- Old behaviour, for comparison -----------------------------------------
// Ellipse rebuilt at a `baseMs` up to 60 s stale, dot on 1st-order tangent
// from an anchor up to `extrapWindow` old (34 s LEO / 600 s cap before).
let oldMax = 0, oldSum = 0, oldN = 0, oldWorst = null;
for (let i = 0; i < sats.length; i += step) {
  const { name, rec } = sats[i];
  for (const dt of [0, 15, 30, 45, 60]) {
    const ms = now + dt * 1000;
    const stale = anchor(rec, now);            // ellipse drawn at baseMs = now
    if (!stale) continue;
    const pts = ellipse(stale);
    if (!pts) continue;
    const lin = { x: stale.x + stale.vx * dt, y: stale.y + stale.vy * dt, z: stale.z + stale.vz * dt };
    const d = distToPath(pts, lin);
    oldSum += d; oldN++;
    if (d > oldMax) { oldMax = d; oldWorst = `${name} @+${dt}s`; }
  }
}
console.log(`\nOLD code path (1st-order dot vs ellipse): mean ${(oldSum / oldN).toFixed(2)} km   max ${oldMax.toFixed(2)} km  (${oldWorst})`);

// --- The regime that actually matters --------------------------------------
// The SELECTED satellite is the only one with a drawn orbit line, and it
// re-anchors every TRACKED_MAX_AGE_MS = 5 s. Report its dot→line distance
// both in km and as a fraction of the rendered dot radius (SAT_SIZE = 0.0016
// scene units = 10.2 km), which is what "the dot is off the line" means.
const DOT_R_KM = 0.0016 * R;
function selectedRegime(label, dts, order) {
  let mx = 0, sum = 0, cnt = 0, who = null;
  for (let i = 0; i < sats.length; i += step) {
    const { name, rec } = sats[i];
    const a = anchor(rec, now);
    if (!a) continue;
    const pts = ellipse(a);
    if (!pts) continue;
    for (const dt of dts) {
      const p = order === 2
        ? extrap(a, dt)
        : { x: a.x + a.vx * dt, y: a.y + a.vy * dt, z: a.z + a.vz * dt };
      const d = distToPath(pts, p);
      sum += d; cnt++;
      if (d > mx) { mx = d; who = `${name} @+${dt}s`; }
    }
  }
  console.log(
    `${label.padEnd(34)} mean ${(sum / cnt).toFixed(3)} km (${((sum / cnt) / DOT_R_KM * 100).toFixed(1)}% of dot)` +
    `   max ${mx.toFixed(3)} km (${(mx / DOT_R_KM * 100).toFixed(0)}% of dot)  ${who}`
  );
}
console.log('\nSelected satellite (re-anchors every 5 s — this is the drawn orbit):');
selectedRegime('  OLD  1st-order extrapolation', [0, 1, 2, 3, 4, 5], 1);
selectedRegime('  NEW  2nd-order extrapolation', [0, 1, 2, 3, 4, 5], 2);
