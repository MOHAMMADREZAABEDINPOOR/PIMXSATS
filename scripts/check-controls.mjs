// Behavioural regression check for SmoothControls (lib/orbit-controls.ts).
//
// Run with `npm run check:controls`. It compiles the controller on its own and
// drives synthetic pointer gestures through the real class, asserting the
// properties the mobile experience depends on — a tap moves nothing, a pinch
// never pans, a two-finger drag never zooms, a diagonal swipe never rolls the
// horizon, and a swipe at extreme zoom stays proportionate.
//
// This exists because touch feel cannot be checked by reading the code and is
// tedious to check by hand on a phone: the previous attempt at this fix looked
// right and shipped a control that still lurched. Several of these assertions
// caught real bugs during development, including two-finger drags being
// mis-read as pinches because the browser delivers one pointermove per finger.
import * as THREE from 'three';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import fs from 'node:fs';

const winHandlers = new Map();
const elHandlers = new Map();
globalThis.window = {
  addEventListener: (t, f) => { (winHandlers.get(t) ?? winHandlers.set(t, []).get(t)).push(f); },
  removeEventListener: () => {},
};
globalThis.performance = globalThis.performance ?? { now: () => 0 };

const el = {
  addEventListener: (t, f) => { (elHandlers.get(t) ?? elHandlers.set(t, []).get(t)).push(f); },
  removeEventListener: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 390, height: 844 }), // iPhone-ish portrait
};

// Compile the controller to a temp dir — it is TypeScript, and this script is
// deliberately dependency-free (no test runner, no bundler).
// Emitted under node_modules/.cache rather than the OS temp dir so that the
// compiled module can still resolve its `three` import.
const OUT = path.join('node_modules', '.cache', `pimxsats-controls-${process.pid}`);
// Invoke tsc through node rather than the npx shim — the shim is a .cmd on
// Windows and is not directly spawnable.
execFileSync(
  process.execPath,
  [path.join('node_modules', 'typescript', 'bin', 'tsc'),
    'lib/orbit-controls.ts', 'lib/interaction.ts', '--outDir', OUT, '--module', 'esnext',
    '--target', 'es2020', '--moduleResolution', 'bundler', '--skipLibCheck'],
  { stdio: 'inherit' }
);
process.on('exit', () => { try { fs.rmSync(OUT, { recursive: true, force: true }); } catch {} });

const { SmoothControls } = await import(pathToFileURL(path.join(OUT, 'orbit-controls.js')).href);
// The REAL shipped gains, not a copy — retuning lib/interaction.ts should move
// these assertions, which is the point of having them.
const { gainsFor } = await import(pathToFileURL(path.join(OUT, 'interaction.js')).href);
// The synthetic element below is a 390×844 portrait phone, so 'phone' is the
// device class that matches it. gainsFor now takes one of four classes rather
// than a coarse-pointer boolean.
const CALM_TOUCH = gainsFor('calm', 'phone');

function fire(map, type, ev) { for (const f of map.get(type) ?? []) f({ preventDefault() {}, ...ev }); }
const down = (id, x, y) => fire(elHandlers, 'pointerdown', { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', button: 0 });
const move = (id, x, y) => fire(winHandlers, 'pointermove', { pointerId: id, clientX: x, clientY: y, pointerType: 'touch' });
const up = (id) => fire(winHandlers, 'pointerup', { pointerId: id, pointerType: 'touch' });

function makeControls() {
  const cam = new THREE.PerspectiveCamera(45, 390 / 844, 0.01, 400);
  cam.position.set(0, 5, 10);
  const c = new SmoothControls(cam, el);
  c.gains = { ...CALM_TOUCH };
  return { cam, c };
}
// Settle: run enough frames for the exponential drain to finish.
const settle = (c) => { for (let i = 0; i < 400; i++) c.update(1 / 60); };

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} — ${detail}`); failures++; }
}

// --- 1. A tap must move nothing ------------------------------------------
{
  const { cam, c } = makeControls();
  const before = cam.position.clone(); const t0 = c.target.clone();
  down(1, 200, 400); move(1, 203, 402); move(1, 201, 404); up(1);
  settle(c);
  check('tap inside the dead zone moves the camera 0',
    cam.position.distanceTo(before) < 1e-9 && c.target.distanceTo(t0) < 1e-9,
    `moved ${cam.position.distanceTo(before).toExponential(2)}`);
}

// --- 2. A pinch must NOT pan ---------------------------------------------
{
  const { cam, c } = makeControls();
  c.noPan = false; // Solar view
  const t0 = c.target.clone();
  const d0 = cam.position.distanceTo(c.target);
  down(1, 150, 400); down(2, 250, 500);
  // Fingers separate; the midpoint also drifts 30 px, the classic case that
  // made TrackballControls drag the whole solar system sideways.
  for (let i = 1; i <= 20; i++) {
    move(1, 150 - i * 4 + i * 1.5, 400 - i * 4 + i * 1.5);
    move(2, 250 + i * 4 + i * 1.5, 500 + i * 4 + i * 1.5);
    c.update(1 / 60);
  }
  up(1); up(2); settle(c);
  const d1 = cam.position.distanceTo(c.target);
  check('pinch changes distance', d1 < d0 * 0.95, `d0=${d0.toFixed(3)} d1=${d1.toFixed(3)}`);
  // The pivot may only move along the zoom-to-point path, which is bounded by
  // the focal-plane half-size — never the unbounded eye-length pan.
  const tanHalf = Math.tan((45 * Math.PI) / 360);
  check('pinch does not pan the pivot arbitrarily',
    c.target.distanceTo(t0) < tanHalf * d0 * 1.1,
    `target moved ${c.target.distanceTo(t0).toFixed(3)} (bound ${(tanHalf * d0 * 1.1).toFixed(3)})`);
}

// --- 3. A two-finger drag must NOT zoom -----------------------------------
{
  const { cam, c } = makeControls();
  c.noPan = false;
  const d0 = cam.position.distanceTo(c.target);
  down(1, 150, 400); down(2, 250, 500);
  for (let i = 1; i <= 20; i++) {
    // Both fingers translate together; spread wobbles by a pixel of jitter.
    const j = i % 2 ? 1 : -1;
    move(1, 150 + i * 5 + j, 400 + i * 5);
    move(2, 250 + i * 5 - j, 500 + i * 5);
    c.update(1 / 60);
  }
  up(1); up(2); settle(c);
  const d1 = cam.position.distanceTo(c.target);
  check('two-finger drag leaves distance untouched',
    Math.abs(d1 - d0) < 1e-6, `d0=${d0.toFixed(4)} d1=${d1.toFixed(4)}`);
  check('two-finger drag pans', c.target.length() > 0.1, `target=${c.target.length().toFixed(3)}`);
}

// --- 4. Earth view: a pinch can never pan --------------------------------
{
  const { cam, c } = makeControls();
  c.noPan = true; // Earth view
  down(1, 150, 400); down(2, 250, 500);
  for (let i = 1; i <= 20; i++) {
    move(1, 150 + i * 6, 400 + i * 6); // pure translation — would be a "pan"
    move(2, 250 + i * 6, 500 + i * 6);
    c.update(1 / 60);
  }
  up(1); up(2); settle(c);
  check('noPan keeps the pivot exactly at the origin',
    c.target.length() < 1e-9, `target moved ${c.target.length().toExponential(2)}`);
}

// --- 5. Rotation magnitude: a full short-edge swipe ------------------------
{
  const { cam, c } = makeControls();
  const before = cam.position.clone().sub(c.target).normalize();
  down(1, 20, 400);
  for (let i = 1; i <= 37; i++) { move(1, 20 + i * 10, 400); c.update(1 / 60); }
  up(1); settle(c);
  const after = cam.position.clone().sub(c.target).normalize();
  const deg = (Math.acos(THREE.MathUtils.clamp(before.dot(after), -1, 1)) * 180) / Math.PI;
  // A usability band, not a restatement of the constant: on the calmest preset
  // a full-width swipe must still turn the view enough to be worth doing, and
  // must not spin it so far that the user loses their bearings. The band was
  // lowered when the per-swipe degrees were halved (view-angle sensitivity was
  // overshooting) — a full Calm swipe now turns ~23°, which is deliberate.
  check(`full-width swipe rotates usefully on Calm (${deg.toFixed(1)}°)`,
    deg > 15 && deg < 60, `got ${deg.toFixed(1)}°`);
}

// --- 6. No roll: a diagonal swipe must keep the horizon level -------------
{
  const { cam, c } = makeControls();
  cam.position.set(0, 0, 10); cam.up.set(0, 1, 0);
  c.update(1 / 60);
  down(1, 100, 100);
  for (let i = 1; i <= 25; i++) { move(1, 100 + i * 8, 100 + i * 8); c.update(1 / 60); }
  up(1); settle(c);
  // Roll = how far the camera's up has tilted out of the plane containing
  // world-up and the view direction.
  const eye = cam.position.clone().sub(c.target).normalize();
  const noRollUp = new THREE.Vector3(0, 1, 0).addScaledVector(eye, -eye.y);
  const rollDeg = noRollUp.lengthSq() < 1e-9 ? 0
    : (Math.acos(THREE.MathUtils.clamp(cam.up.clone().normalize().dot(noRollUp.normalize()), -1, 1)) * 180) / Math.PI;
  check('diagonal swipe induces no roll', rollDeg < 1, `rolled ${rollDeg.toFixed(2)}°`);
}

// --- 7. Released gesture settles (no runaway glide) -----------------------
{
  const { cam, c } = makeControls();
  down(1, 200, 400);
  for (let i = 1; i <= 10; i++) { move(1, 200 + i * 20, 400); c.update(1 / 60); }
  up(1);
  const atRelease = cam.position.clone();
  for (let i = 0; i < 60; i++) c.update(1 / 60); // first second after release
  const afterOne = cam.position.clone();
  for (let i = 0; i < 60; i++) c.update(1 / 60); // second second
  const glide1 = atRelease.distanceTo(afterOne);
  const glide2 = afterOne.distanceTo(cam.position);
  const radius = cam.position.distanceTo(c.target);
  // Measured against the orbit radius, because that is what "did the scene
  // keep sliding?" actually means to a viewer. An absolute epsilon would
  // either pass a runaway at solar-system scale or fail a settled camera in
  // close-up. The decay check is what would have caught TrackballControls'
  // `_lastAngle` coast, which never converged at all.
  check('released gesture has settled a second later',
    glide2 < radius * 1e-3 && glide2 < glide1,
    `second-second drift ${glide2.toExponential(2)} of radius ${radius.toFixed(2)} (first second ${glide1.toExponential(2)})`);
}

// --- 8. Distance clamps hold ---------------------------------------------
{
  const { cam, c } = makeControls();
  c.minDistance = 2; c.maxDistance = 40;
  down(1, 100, 400); down(2, 300, 400);
  for (let i = 1; i <= 60; i++) { move(1, 100 + i * 1.5, 400); move(2, 300 - i * 1.5, 400); c.update(1 / 60); }
  up(1); up(2); settle(c);
  const d = cam.position.distanceTo(c.target);
  check('zoom-out respects maxDistance', d <= 40 + 1e-6, `d=${d.toFixed(3)}`);
}

// --- 9. Deep zoom: a small swipe must stay small --------------------------
// The original complaint. Pinched all the way down to a planet-surface
// distance, a short finger swipe used to throw the view completely, because
// the camera was still orbiting a pivot on the far side of the solar system.
{
  const { cam, c } = makeControls();
  c.noPan = false;
  c.minDistance = 0.005;
  cam.position.set(0, 0, 0.02); // ~a planet's surface in scene units
  c.update(1 / 60);
  const d0 = cam.position.distanceTo(c.target);
  const before = cam.position.clone();
  down(1, 200, 400);
  for (let i = 1; i <= 6; i++) { move(1, 200 + i * 5, 400 + i * 3); c.update(1 / 60); }
  up(1); settle(c);
  const travelled = cam.position.distanceTo(before);
  check('deep zoom keeps the orbit radius', Math.abs(cam.position.distanceTo(c.target) - d0) < 1e-6,
    `d0=${d0} d1=${cam.position.distanceTo(c.target)}`);
  // A 36 px swipe is under a tenth of the screen; it must not sweep the camera
  // further than the radius it is orbiting at.
  check('deep zoom: 36 px swipe moves less than one orbit radius',
    travelled < d0, `moved ${travelled.toFixed(5)} at radius ${d0.toFixed(5)}`);
}

// --- 10. Zoom walks the pivot toward what you zoom into --------------------
{
  const { cam, c } = makeControls();
  c.noPan = false;
  cam.position.set(0, 0, 12); cam.up.set(0, 1, 0);
  c.update(1 / 60);
  // Pinch open centred well off to the right of the screen.
  down(1, 300, 300); down(2, 340, 340);
  for (let i = 1; i <= 25; i++) {
    move(1, 300 - i * 3, 300 - i * 3);
    move(2, 340 + i * 3, 340 + i * 3);
    c.update(1 / 60);
  }
  up(1); up(2); settle(c);
  check('zooming in pulls the pivot toward the pinch centre',
    c.target.x > 0.2, `target.x=${c.target.x.toFixed(3)}`);
  check('zooming in reduces distance', cam.position.distanceTo(c.target) < 12,
    `d=${cam.position.distanceTo(c.target).toFixed(3)}`);
}

// --- 11. Navigation speed is scale-invariant ------------------------------
// The focus-mode crawl. The near-floor easing used to be measured against the
// scene-wide maxDistance, so standing 0.02 units from a planet in a 60-unit
// solar system read as "basically at zero" and throttled rotation to a tenth
// of its gain — and the crawl outlived the focus that caused it. Easing is now
// measured as a RATIO of the closest allowed distance, so the same swipe at
// the same *relative* distance sweeps the same angle whatever the scale.
{
  // Same gesture, same dist/minDistance ratio, wildly different absolute
  // scales and scene extents.
  const sweep = (minDistance, maxDistance, ratio) => {
    const { cam, c } = makeControls();
    c.minDistance = minDistance;
    c.maxDistance = maxDistance;
    cam.position.set(0, 0, minDistance * ratio);
    c.target.set(0, 0, 0);
    c.update(1 / 60);
    const before = cam.position.clone().sub(c.target).normalize();
    down(1, 195, 600);
    for (let i = 1; i <= 20; i++) { move(1, 195 + i * 8, 600); c.update(1 / 60); }
    up(1); settle(c);
    const after = cam.position.clone().sub(c.target).normalize();
    return THREE.MathUtils.radToDeg(before.angleTo(after));
  };

  const tiny = sweep(0.005, 0.5, 3);   // parked on a moon
  const huge = sweep(2, 60, 3);        // browsing the whole solar system
  check('same swipe sweeps the same angle at any scale',
    Math.abs(tiny - huge) < Math.max(1, huge * 0.02),
    `tiny scene ${tiny.toFixed(2)}° vs large scene ${huge.toFixed(2)}°`);

  // And full gain really is reached: beyond PROGRESSIVE_OCTAVES (now 6 → 64×
  // the floor) a swipe is not throttled at all, so focusing on a body cannot
  // slow the controls down once you have backed off from it.
  const far = sweep(0.005, 5, 200);
  const eased = sweep(0.005, 5, 64);
  check('easing is over by 64x the floor', Math.abs(far - eased) < Math.max(1, far * 0.03),
    `at 64x ${eased.toFixed(2)}° vs far out ${far.toFixed(2)}°`);

  // Resting against the floor still steers — softened, never stuck.
  const atFloor = sweep(0.005, 0.5, 1);
  check('a swipe at the floor still turns the camera', atFloor > far * 0.25,
    `${atFloor.toFixed(2)}° at the floor vs ${far.toFixed(2)}° far out`);
}

// --- 12. dampFloor eases WITHOUT pinning the camera -----------------------
// The planet-click lock. The rig used to publish the ray-cast surface distance
// as minDistance even when nothing was focused, so a camera sitting near a
// selected planet had minDistance ≈ its own distance: the offset was clamped up
// to that value (teleport) and octaves collapsed to 0, throttling rotation to
// the floor gain. dampFloor carries the easing signal instead, so the camera
// slows down near a surface but is never clamped and never stops steering.
{
  const softSweep = (useDampFloor) => {
    const { cam, c } = makeControls();
    c.minDistance = 0.0005;
    c.maxDistance = 60;
    if (useDampFloor) c.dampFloor = 0.02;
    cam.position.set(0, 0, 0.021); // just outside a planet surface
    c.target.set(0, 0, 0);
    c.update(1 / 60);
    const d0 = cam.position.distanceTo(c.target);
    const before = cam.position.clone().sub(c.target).normalize();
    down(1, 195, 600);
    for (let i = 1; i <= 20; i++) { move(1, 195 + i * 8, 600); c.update(1 / 60); }
    up(1); settle(c);
    const after = cam.position.clone().sub(c.target).normalize();
    return { deg: THREE.MathUtils.radToDeg(before.angleTo(after)), d0, d1: cam.position.distanceTo(c.target) };
  };
  const eased = softSweep(true);
  const free = softSweep(false);
  check('dampFloor never clamps the camera distance',
    Math.abs(eased.d1 - eased.d0) < 1e-9, `d0=${eased.d0} d1=${eased.d1}`);
  check('dampFloor does ease rotation near a surface',
    eased.deg < free.deg * 0.6, `eased ${eased.deg.toFixed(2)}° vs free ${free.deg.toFixed(2)}°`);
  check('dampFloor still leaves the camera steerable',
    eased.deg > 1, `only ${eased.deg.toFixed(2)}°`);
}

// --- 13. Distance-adaptive zoom crosses open space -------------------------
// "Zooming from Earth over to Mars on the far side of the Sun, the increments
// become so tiny the user gets frustrated." The pivot is stuck on Earth while
// the camera is out in open space, so a multiplicative step is taken against a
// tiny `dist` and moves almost nothing. zoomScale sizes the step against the
// free space the camera actually has instead.
{
  const travel = (zoomScale) => {
    const { cam, c } = makeControls();
    c.noPan = true; // isolate the zoom from the zoom-to-point pivot walk
    c.minDistance = 0.0005;
    c.maxDistance = 60;
    c.zoomScale = zoomScale;
    cam.position.set(0, 0, 0.05); // pivot glued to a nearby planet
    c.target.set(0, 0, 0);
    c.update(1 / 60);
    const before = cam.position.clone();
    // Ten notches of wheel-out.
    for (let i = 0; i < 10; i++) {
      fire(elHandlers, 'wheel', { deltaY: 120, deltaMode: 0, clientX: 195, clientY: 422 });
      settle(c);
    }
    return cam.position.distanceTo(before);
  };
  const plain = travel(0);
  // 3 scene units of clear space — roughly Earth-to-Mars across the compressed
  // solar system, which is what the user was trying to cross.
  const adaptive = travel(3);
  check('adaptive zoom crosses open space far faster',
    adaptive > plain * 20, `plain ${plain.toFixed(4)} vs adaptive ${adaptive.toFixed(4)}`);

  // …and it must NOT change the feel when the pivot IS the nearest thing: with
  // no free space to speak of, max(dist, zoomScale) is dist and the step is the
  // familiar multiplicative one.
  const tight = travel(0.001);
  check('adaptive zoom is inert when the pivot is what you are looking at',
    Math.abs(tight - plain) < Math.max(1e-6, plain * 0.02),
    `plain ${plain.toFixed(6)} vs tight ${tight.toFixed(6)}`);

  // Zooming IN with a huge reference must not slam the camera into the pivot:
  // each commit is capped at 30 % of the remaining gap.
  {
    const { cam, c } = makeControls();
    c.noPan = true;
    c.minDistance = 0.0005;
    c.maxDistance = 60;
    c.zoomScale = 5; // vastly more free space than the camera's own distance
    cam.position.set(0, 0, 0.05);
    c.target.set(0, 0, 0);
    c.update(1 / 60);
    fire(elHandlers, 'wheel', { deltaY: -120, deltaMode: 0, clientX: 195, clientY: 422 });
    // One frame — the whole point is that a single commit cannot collapse it.
    c.update(1 / 60);
    const d = cam.position.distanceTo(c.target);
    check('adaptive zoom-in never collapses onto the pivot in one frame',
      d > 0.05 * 0.65, `0.05 → ${d.toFixed(5)}`);
  }
}

// --- 14. Clearance-based proximity damping --------------------------------
// "Starting near Earth with Mars on the far side of the Sun, the zoom and
// view-angle increments become so tiny it's infuriating" — and, at the same
// time, "near any planet or moon the increments must be small enough that
// nothing transforms drastically."
//
// Those pull in opposite directions only if proximity is measured by distance to
// the PIVOT, which in the solar view is unrelated to how close anything is: the
// pivot sits on Earth while the camera is in open space, and dampFloor (a ray
// cast that the Sun intercepts) collapses the octave count to ~0, so every
// gesture runs at floor gain in the middle of nowhere.
//
// The rig now publishes `clearance` (camera → nearest surface) and
// `clearanceFloor` (0.05 × that body's radius) instead, and the controller
// prefers them. One number, all three requirements.
{
  // The identical swipe, at the identical camera pose, under three different
  // stories about what is nearby.
  const sweep = (setup) => {
    const { cam, c } = makeControls();
    c.minDistance = 0.0005;
    c.maxDistance = 60;
    cam.position.set(0, 0, 1.6); // Earth's orbital radius in the compressed scene
    c.target.set(0, 0, 0);       // …with the pivot glued to the Sun
    setup(c);
    c.update(1 / 60);
    const before = cam.position.clone().sub(c.target).normalize();
    down(1, 195, 600);
    for (let i = 1; i <= 20; i++) { move(1, 195 + i * 8, 600); c.update(1 / 60); }
    up(1); settle(c);
    const after = cam.position.clone().sub(c.target).normalize();
    return THREE.MathUtils.radToDeg(before.angleTo(after));
  };

  // (a) The reported bug, reproduced: the ray from camera through pivot lands on
  // the Sun, so dampFloor ≈ the camera's own distance and the octave count is 0.
  const rayBound = sweep((c) => { c.dampFloor = 1.55; });
  // (b) Same pose, measured honestly: 1.1 units of clear space above a Sun whose
  // clearance floor is 0.05 × 0.5.
  const open = sweep((c) => { c.dampFloor = 1.55; c.clearance = 1.1; c.clearanceFloor = 0.025; });
  check('clearance overrides a Sun-corrupted dampFloor in open space',
    open > rayBound * 2.5, `ray-bound ${rayBound.toFixed(2)}° vs clearance ${open.toFixed(2)}°`);

  // (c) Item 9: skimming a body, the same swipe must be small. Earth's solar-view
  // radius is ~0.0275, so its clearance floor is ~0.0014; sitting 0.002 above the
  // surface is a fraction of an octave and must run at floor gain.
  const hugging = sweep((c) => { c.clearance = 0.002; c.clearanceFloor = 0.0014; });
  check('clearance damps hard when hugging a surface',
    hugging < open * 0.45, `hugging ${hugging.toFixed(2)}° vs open ${open.toFixed(2)}°`);
  check('hugging a surface still leaves the camera steerable',
    hugging > 0.5, `only ${hugging.toFixed(3)}°`);

  // (d) Item 8's Sun rule, which falls out of the same measure: with the Sun as
  // the nearest body, the sweep must grow monotonically as the camera retreats
  // from it. 0.1 / 1.1 / 8.3 units of clearance ≈ just above the surface,
  // Earth's orbit, Neptune's.
  const nearSun = sweep((c) => { c.clearance = 0.1; c.clearanceFloor = 0.025; });
  const farSun = sweep((c) => { c.clearance = 8.3; c.clearanceFloor = 0.025; });
  check('view-angle change grows monotonically with distance from the Sun',
    nearSun < open && open < farSun,
    `0.1u ${nearSun.toFixed(2)}° · 1.1u ${open.toFixed(2)}° · 8.3u ${farSun.toFixed(2)}°`);

  // (e) The rate limit. A single frame may not carry the camera more than
  // ARC_CLEARANCE_FRACTION (0.25) of its clearance — this is what stopped a
  // damped zoom frame from moving ~0.4 units while skimming 0.01 above Mars,
  // which made the planet simply vanish. Checked frame by frame, mid-gesture.
  {
    const { cam, c } = makeControls();
    c.noPan = true;
    c.minDistance = 0.0005;
    c.maxDistance = 60;
    c.zoomScale = 3;        // the adaptive reference that made the jump possible
    c.clearance = 0.01;     // …while grazing a surface
    c.clearanceFloor = 0.0014;
    cam.position.set(0, 0, 2.4);
    c.target.set(0, 0, 0);
    c.update(1 / 60);
    let worst = 0;
    for (let i = 0; i < 12; i++) {
      fire(elHandlers, 'wheel', { deltaY: -120, deltaMode: 0, clientX: 195, clientY: 422 });
      const p0 = cam.position.clone();
      c.update(1 / 60);
      worst = Math.max(worst, cam.position.distanceTo(p0));
    }
    // A little slack: the cap is applied to the radial zoom displacement, and
    // zoom-to-point walks the pivot as well.
    check('a frame never moves the camera further than its clearance allows',
      worst < 0.25 * 0.01 * 1.6, `worst frame moved ${worst.toFixed(5)} with clearance 0.01`);
  }

  // (f) …and the limit is a RATE limit, not a reduction: what does not fit in one
  // frame is refunded to the pending buffer, so a gesture still travels. Without
  // the refund the capped input would be silently discarded and the zoom would
  // appear dead — the failure mode this whole mechanism exists to avoid.
  {
    const { cam, c } = makeControls();
    c.noPan = true;
    c.minDistance = 0.0005;
    c.maxDistance = 60;
    c.zoomScale = 3;
    c.clearance = 0.01;
    c.clearanceFloor = 0.0014;
    cam.position.set(0, 0, 2.4);
    c.target.set(0, 0, 0);
    c.update(1 / 60);
    const d0 = cam.position.distanceTo(c.target);
    for (let i = 0; i < 12; i++) {
      fire(elHandlers, 'wheel', { deltaY: -120, deltaMode: 0, clientX: 195, clientY: 422 });
      c.update(1 / 60);
    }
    settle(c);
    const d1 = cam.position.distanceTo(c.target);
    check('rate-limited zoom still travels once the gesture is drained',
      d0 - d1 > 0.25 * 0.01, `moved ${(d0 - d1).toFixed(5)} over the whole gesture`);
  }
}

// --- 15. The per-view trim ------------------------------------------------
// The Earth view is the reference and MUST be bit-identical to the raw tables —
// the user calls it perfect, so any retune of the solar feel that moves it is a
// regression. The solar view is slower on both axes and identical on everything
// else: the trim is a matter of gesture gain, not of damping or of the per-frame
// backstops (shrinking those would eat input from a fast swipe rather than slow
// it, since the angle cap is not refunded).
{
  const SENS = ['calm', 'standard', 'fast'];
  const DEVS = ['phone', 'tablet', 'laptop', 'desktop'];

  let earthUntrimmed = true;
  let solarSlower = true;
  let restIdentical = true;
  for (const s of SENS) {
    for (const d of DEVS) {
      const bare = gainsFor(s, d);
      const earth = gainsFor(s, d, 'earth');
      const solar = gainsFor(s, d, 'solar');
      if (earth.rotatePerEdge !== bare.rotatePerEdge || earth.zoom !== bare.zoom) earthUntrimmed = false;
      if (!(solar.rotatePerEdge < earth.rotatePerEdge && solar.zoom < earth.zoom)) solarSlower = false;
      if (solar.response !== earth.response ||
          solar.maxAnglePerFrame !== earth.maxAnglePerFrame ||
          solar.maxZoomLogPerFrame !== earth.maxZoomLogPerFrame ||
          solar.deadZone !== earth.deadZone ||
          solar.pan !== earth.pan) restIdentical = false;
    }
  }
  check('the Earth view is the untrimmed reference', earthUntrimmed,
    'gainsFor(s, d, "earth") differs from gainsFor(s, d)');
  check('the solar view rotates and zooms slower than Earth on every preset', solarSlower,
    'a solar gain was not below its Earth counterpart');
  check('the trim touches gains only, not damping or the frame caps', restIdentical,
    'response / caps / dead zone / pan differ between views');

  // And the same swipe really does turn the camera less out there. Driven through
  // the actual control rather than read off the table, because rotatePerEdge is
  // normalised per viewport edge and clamped per frame on the way in.
  const swing = (view) => {
    const { cam, c } = makeControls();
    c.gains = { ...gainsFor('standard', 'phone', view) };
    const eye0 = cam.position.clone().sub(c.target).normalize();
    down(1, 95, 400);
    for (let x = 105; x <= 295; x += 10) { move(1, x, 400); c.update(1 / 60); }
    up(1);
    settle(c);
    const eye1 = cam.position.clone().sub(c.target).normalize();
    return (Math.acos(Math.min(1, Math.max(-1, eye0.dot(eye1)))) * 180) / Math.PI;
  };
  const earthDeg = swing('earth');
  const solarDeg = swing('solar');
  check('a 200 px swipe turns the camera less in the solar view',
    solarDeg < earthDeg * 0.8 && solarDeg > 1,
    `earth ${earthDeg.toFixed(1)}° vs solar ${solarDeg.toFixed(1)}°`);
  console.log(`        (same swipe: ${earthDeg.toFixed(1)}° in Earth view, ${solarDeg.toFixed(1)}° in solar)`);
}

// --- 16. The pivot has to be the body the camera is next to ----------------
// "I pick a planet from the list in the solar view, then close it, and the screen
// is locked." Reported repeatedly, and it is not the input path: it is where the
// pivot ends up. Focus welds the pivot to the planet; releasing it used to walk
// the pivot to the scene centre, which in the solar view is the SUN — one AU
// behind a camera that is resting on that planet's collision guard.
//
// Rotation then sweeps the camera along an arc of length dist·angle, and the
// controller caps that arc at a quarter of the clearance so a swipe cannot fling
// the camera through the surface it is hugging. With dist ≈ 1 and clearance ≈
// 0.003 that cap is 0.045° per frame: a swipe turns the view by about a degree
// and the planet slides out of frame sideways without the view ever turning to
// follow it. Zooming in is pinned by the collision guard at the same moment, so
// only zoom-out answers at all.
//
// No cap tuning can rescue that pose — one degree around the Sun really does
// translate the camera by an Earth radius. The pivot has to be the body, and then
// the ratio the cap works from is gap/(gap+radius), which is 0.23 even resting on
// the guard. CameraRig.desiredPivot is what puts it there.
{
  // Mercury: the smallest and therefore worst case. sceneRadius = 3·2440/696000,
  // orbit = 1.6·√0.387 AU^½, camera parked on the browsing guard at 1.31 radii —
  // where you are after flying to it and zooming in.
  const R = (0.5 * 2440 * 6) / 696000;
  const ORBIT = 1.6 * Math.sqrt(0.387);
  const CAM_Z = ORBIT + R * 1.31;
  const GAP = R * 0.31;

  const swipe = (pivotZ) => {
    const { cam, c } = makeControls();
    c.gains = { ...gainsFor('standard', 'phone', 'solar') };
    c.minDistance = 0.0005;
    c.maxDistance = 60;
    // What the rig publishes at this pose, either way: clearance and its floor
    // describe the camera and the planet, not the pivot.
    c.clearance = GAP;
    c.clearanceFloor = 0.05 * R;
    c.zoomScale = GAP;
    cam.position.set(0, 0, CAM_Z);
    c.target.set(0, 0, pivotZ);
    c.update(1 / 60);
    const eye0 = cam.position.clone().sub(c.target).normalize();
    down(1, 95, 400);
    for (let x = 105; x <= 295; x += 10) { move(1, x, 400); c.update(1 / 60); }
    up(1);
    // Half a second of frames, not the usual 400-frame settle. The arc limit
    // REFUNDS what it withholds, so given seven seconds even the locked pose
    // eventually delivers the whole swipe — which is exactly why this bug
    // survived: it is a lock on the timescale of the gesture, and that is the
    // only timescale the user has an opinion about.
    for (let i = 0; i < 10; i++) c.update(1 / 60);
    return THREE.MathUtils.radToDeg(eye0.angleTo(cam.position.clone().sub(c.target).normalize()));
  };

  const sunPivot = swipe(0);
  const bodyPivot = swipe(ORBIT);
  check('the reported lock is reproduced: hugging a planet, pivot on the Sun',
    sunPivot < 2, `the swipe still turned the view ${sunPivot.toFixed(2)}°`);
  check('the same swipe turns the view once the pivot is the planet',
    bodyPivot > 4 && bodyPivot > sunPivot * 4,
    `sun pivot ${sunPivot.toFixed(2)}° vs body pivot ${bodyPivot.toFixed(2)}°`);
  console.log(`        (same swipe on Mercury's doorstep: ${sunPivot.toFixed(2)}° with the Sun as pivot, ${bodyPivot.toFixed(2)}° with Mercury)`);
}

// --- 17. OVERVIEW's exit condition has to be reachable -------------------
// The reported symptom was that pressing OVERVIEW locked the view: every frame
// the glide pulled the camera back to (0, 5, 10), so any drag snapped straight
// back. Nothing was wrong with the glide's motion — its FINISH LINE was a pose
// the controller refuses to hold. `update()` orthogonalises cam.up against the
// view direction, so looking down at the origin from (0, 5, 10) up can never be
// (0, 1, 0), and `solarResetRef` stayed true for the rest of the session.
//
// This measures both halves: world up is unreachable from that pose, and the
// projected up the rig now aims at is exactly what the controller settles on.
{
  const HOME = new THREE.Vector3(0, 5, 10);
  const eye = HOME.clone().normalize(); // the pose looks at the origin
  const projected = new THREE.Vector3(0, 1, 0)
    .addScaledVector(eye, -eye.y)
    .normalize();

  const { cam, c } = makeControls();
  cam.position.copy(HOME);
  c.target.set(0, 0, 0);
  cam.up.set(0, 1, 0);
  c.update(1 / 60);

  const toWorldUp = cam.up.distanceTo(new THREE.Vector3(0, 1, 0));
  const toProjected = cam.up.distanceTo(projected);
  check('world up is NOT reachable from the OVERVIEW pose (the old exit test)',
    toWorldUp > 0.01, `cam.up settled ${toWorldUp.toFixed(4)} from world up`);
  check('the projected up IS what the controller settles on (the new exit test)',
    toProjected < 0.01, `cam.up settled ${toProjected.toFixed(4)} from the projected up`);
  console.log(`        (OVERVIEW pose: cam.up is ${toWorldUp.toFixed(3)} from world up, ${toProjected.toFixed(4)} from the projected up)`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
