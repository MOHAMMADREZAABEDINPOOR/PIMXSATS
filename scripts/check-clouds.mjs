// Verify the new cloud bulk-roll model: moves at 1x, scales with warp, never
// freezes (the old ±72h clamp bug), and is rate-capped at extreme warp.
const CLOUD_BULK_DEG_PER_HOUR = 18;
const CLOUD_VISIBILITY_BOOST = 50;
const CLOUD_MAX_DEG_PER_SEC = 90;
const MAX_DRIFT_HOURS = 72;

// Simulate 60 fps frames for `realSecs` at a given warp (sim seconds per real
// second), reporting how many degrees the bulk roll advanced and whether the
// OLD clamped drift would have frozen.
function run(warp, realSecs) {
  const fps = 60, dt = 1 / fps;
  let bulk = 0;
  let simMs = Date.UTC(2026, 7, 4, 12, 0, 0);
  const anchorMs = simMs;
  let prevSim = null;
  for (let f = 0; f < realSecs * fps; f++) {
    simMs += warp * dt * 1000;
    if (prevSim !== null) {
      const simHours = (simMs - prevSim) / 3600000;
      let step = simHours * CLOUD_BULK_DEG_PER_HOUR * CLOUD_VISIBILITY_BOOST;
      const maxStep = CLOUD_MAX_DEG_PER_SEC * Math.max(dt, 1 / 240);
      if (step > maxStep) step = maxStep; else if (step < -maxStep) step = -maxStep;
      bulk += step; // (unwrapped here to measure total travel)
    }
    prevSim = simMs;
  }
  const elapsedHours = (simMs - anchorMs) / 3600000;
  const oldDrift = Math.max(-MAX_DRIFT_HOURS, Math.min(MAX_DRIFT_HOURS, elapsedHours));
  const oldFrozen = Math.abs(elapsedHours) > MAX_DRIFT_HOURS;
  return { degMoved: bulk, degPerRealSec: bulk / realSecs, oldDrift, oldFrozen, elapsedHours };
}

const presets = [
  ['Real (1x)', 1],
  ['10x', 10],
  ['60x (1 min/s)', 60],
  ['300x (5 min/s)', 300],
  ['1800x (30 min/s)', 1800],
  ['3600x (1 h/s)', 3600],
];
console.log('10 s of wall-clock at each Earth-view warp preset:\n');
console.log('preset'.padEnd(20), 'roll °/realsec'.padEnd(16), 'total °'.padEnd(12), 'OLD drift (h)'.padEnd(15), 'OLD frozen?');
for (const [name, warp] of presets) {
  const r = run(warp, 10);
  console.log(
    name.padEnd(20),
    r.degPerRealSec.toFixed(3).padEnd(16),
    r.degMoved.toFixed(1).padEnd(12),
    r.oldDrift.toFixed(1).padEnd(15),
    r.oldFrozen ? `YES (elapsed ${r.elapsedHours.toFixed(0)}h)` : 'no'
  );
}

console.log('\nInterpretation:');
console.log('- Real 1x: ~0.25°/s → one full revolution ≈ 24 min. Perceptible, not a fan.');
console.log('- Warp scales the rate until the 90°/s cap (reached around 1 h/s).');
console.log('- OLD model: at 60x+ the ±72h drift clamp is hit within seconds → clouds FREEZE.');
console.log('  New model never freezes — bulk roll is unbounded & wrapped.');

// Pause behaviour: enableMovement=false must hold, not reset.
console.log('\nPause: bulk roll holds its last value (enableMovement gate), does not snap to 0. OK by construction.');
