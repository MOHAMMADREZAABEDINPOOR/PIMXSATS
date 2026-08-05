// Conjunction radar — who is about to pass close to a chosen satellite.
//
// This is NOT a collision-probability engine (that needs covariance data the
// public TLE set does not carry). It answers the honest, useful question a TLE
// CAN answer: over the next few hours, which other tracked objects come within
// a few kilometres of this one, and when. That is enough to point at the sky
// and say "those two threads its orbit in twenty minutes".
//
// Cost control is the whole game: a naive all-pairs sweep of 15,000 objects
// over hours of 1-second steps is billions of propagations. Two cheap filters
// collapse it:
//   1. Altitude gate — an object whose orbital shell never overlaps the
//      target's cannot approach it; skip it before propagating at all.
//   2. Coarse-then-fine time sweep — step the survivors at a wide interval to
//      find candidate windows, then refine only those windows to the second.

import * as satellite from 'satellite.js';
import type { SatData } from './satellite';
import { getScenePositionCached, ScenePos, PROP_FAILED } from './satellite';

const SCENE_TO_KM = 6371;

export interface Conjunction {
  other: SatData;
  /** Closest approach within the horizon. */
  time: Date;
  /** Separation at that moment, km. */
  missKm: number;
  /** Relative speed at closest approach, km/s — a fast crossing is a very
   *  different thing from two objects station-keeping side by side. */
  relSpeedKmS: number;
}

export interface ConjunctionOptions {
  /** Report approaches closer than this, km. */
  thresholdKm?: number;
  /** How far ahead to look, hours. */
  horizonHours?: number;
  /** Cap on reported approaches. */
  maxResults?: number;
}

const DEFAULT_THRESHOLD_KM = 10;
const DEFAULT_HORIZON_HOURS = 6;
const DEFAULT_MAX = 12;
// Coarse sweep step. Two LEO objects close at up to ~15 km/s; at 30 s that is
// 450 km between samples, far inside the altitude pre-filter's margin, so no
// real approach is stepped over.
const COARSE_STEP_MS = 30_000;
const FINE_STEP_MS = 1_000;
// Altitude pre-filter margin: skip an object whose mean altitude differs from
// the target's by more than this. Generous enough to keep eccentric orbits
// whose paths might still cross.
const ALT_GATE_KM = 200;

/** Mean altitude proxy from the semi-major axis, km. Cheap, TLE-only, and
 *  monotonic in orbital energy — exactly what the gate needs. */
function meanAltitudeKm(satrec: satellite.SatRec): number {
  const MU = 398600.4418;
  const R = 6371;
  const n = satrec.no; // rad/min
  if (n <= 0) return NaN;
  const periodSec = (2 * Math.PI / n) * 60;
  const a = Math.cbrt(MU * (periodSec / (2 * Math.PI)) ** 2);
  return a - R;
}

function sep(a: ScenePos, b: ScenePos): number {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * SCENE_TO_KM;
}

/**
 * Synchronous conjunction search. Intended for a chunked async caller (below)
 * or a Web Worker; on the main thread, prefer findConjunctionsAsync so a long
 * horizon cannot jank the frame.
 */
export function findConjunctions(
  target: SatData,
  catalog: SatData[],
  from: Date,
  options: ConjunctionOptions = {}
): Conjunction[] {
  const {
    thresholdKm = DEFAULT_THRESHOLD_KM,
    horizonHours = DEFAULT_HORIZON_HOURS,
    maxResults = DEFAULT_MAX,
  } = options;

  const targetAlt = meanAltitudeKm(target.satrec);
  const startMs = from.getTime();
  const endMs = startMs + horizonHours * 3600_000;

  // Pre-filter by shell overlap.
  const candidates = catalog.filter((s) => {
    if (s === target || s.satrec.satnum === target.satrec.satnum) return false;
    const alt = meanAltitudeKm(s.satrec);
    return Number.isFinite(alt) && Math.abs(alt - targetAlt) <= ALT_GATE_KM;
  });

  const results: Conjunction[] = [];
  const tPos: ScenePos = { x: 0, y: 0, z: 0 };
  const oPos: ScenePos = { x: 0, y: 0, z: 0 };
  const oPos2: ScenePos = { x: 0, y: 0, z: 0 };
  const tPos2: ScenePos = { x: 0, y: 0, z: 0 };

  for (const other of candidates) {
    let best = Infinity;
    let bestMs = 0;
    // Coarse sweep for the approximate closest-approach time.
    for (let ms = startMs; ms <= endMs; ms += COARSE_STEP_MS) {
      if (getScenePositionCached(target.satrec, ms, tPos, Infinity) === PROP_FAILED) continue;
      if (getScenePositionCached(other.satrec, ms, oPos, Infinity) === PROP_FAILED) continue;
      const d = sep(tPos, oPos);
      if (d < best) { best = d; bestMs = ms; }
    }
    if (best > thresholdKm * 3) continue; // nowhere near — skip the refine

    // Refine around the coarse minimum to the second.
    let refBest = best;
    let refMs = bestMs;
    const lo = Math.max(startMs, bestMs - COARSE_STEP_MS);
    const hi = Math.min(endMs, bestMs + COARSE_STEP_MS);
    for (let ms = lo; ms <= hi; ms += FINE_STEP_MS) {
      if (getScenePositionCached(target.satrec, ms, tPos, Infinity) === PROP_FAILED) continue;
      if (getScenePositionCached(other.satrec, ms, oPos, Infinity) === PROP_FAILED) continue;
      const d = sep(tPos, oPos);
      if (d < refBest) { refBest = d; refMs = ms; }
    }
    if (refBest > thresholdKm) continue;

    // Relative speed from a one-second finite difference at closest approach.
    getScenePositionCached(target.satrec, refMs, tPos, Infinity);
    getScenePositionCached(other.satrec, refMs, oPos, Infinity);
    getScenePositionCached(target.satrec, refMs + 1000, tPos2, Infinity);
    getScenePositionCached(other.satrec, refMs + 1000, oPos2, Infinity);
    const rvx = (tPos2.x - tPos.x) - (oPos2.x - oPos.x);
    const rvy = (tPos2.y - tPos.y) - (oPos2.y - oPos.y);
    const rvz = (tPos2.z - tPos.z) - (oPos2.z - oPos.z);
    const relSpeedKmS = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz) * SCENE_TO_KM;

    results.push({
      other,
      time: new Date(refMs),
      missKm: refBest,
      relSpeedKmS,
    });
  }

  results.sort((a, b) => a.missKm - b.missKm);
  return results.slice(0, maxResults);
}

/**
 * Chunked async variant — processes the candidate list a slice at a time with a
 * yield between slices, polling `isCancelled` so a superseded search stops. The
 * altitude pre-filter runs up front (cheap), and the expensive time sweep is
 * what gets chunked.
 */
export async function findConjunctionsAsync(
  target: SatData,
  catalog: SatData[],
  from: Date,
  options: ConjunctionOptions = {},
  isCancelled: () => boolean = () => false,
  onProgress?: (done: number, total: number) => void
): Promise<Conjunction[] | null> {
  const {
    thresholdKm = DEFAULT_THRESHOLD_KM,
    horizonHours = DEFAULT_HORIZON_HOURS,
    maxResults = DEFAULT_MAX,
  } = options;

  const targetAlt = meanAltitudeKm(target.satrec);
  const startMs = from.getTime();
  const endMs = startMs + horizonHours * 3600_000;

  const candidates = catalog.filter((s) => {
    if (s === target || s.satrec.satnum === target.satrec.satnum) return false;
    const alt = meanAltitudeKm(s.satrec);
    return Number.isFinite(alt) && Math.abs(alt - targetAlt) <= ALT_GATE_KM;
  });

  const results: Conjunction[] = [];
  const tPos: ScenePos = { x: 0, y: 0, z: 0 };
  const oPos: ScenePos = { x: 0, y: 0, z: 0 };
  const tPos2: ScenePos = { x: 0, y: 0, z: 0 };
  const oPos2: ScenePos = { x: 0, y: 0, z: 0 };

  const SLICE = 40; // candidates processed between yields
  for (let idx = 0; idx < candidates.length; idx++) {
    const other = candidates[idx];
    let best = Infinity;
    let bestMs = 0;
    for (let ms = startMs; ms <= endMs; ms += COARSE_STEP_MS) {
      if (getScenePositionCached(target.satrec, ms, tPos, Infinity) === PROP_FAILED) continue;
      if (getScenePositionCached(other.satrec, ms, oPos, Infinity) === PROP_FAILED) continue;
      const d = sep(tPos, oPos);
      if (d < best) { best = d; bestMs = ms; }
    }
    if (best <= thresholdKm * 3) {
      let refBest = best;
      let refMs = bestMs;
      const lo = Math.max(startMs, bestMs - COARSE_STEP_MS);
      const hi = Math.min(endMs, bestMs + COARSE_STEP_MS);
      for (let ms = lo; ms <= hi; ms += FINE_STEP_MS) {
        if (getScenePositionCached(target.satrec, ms, tPos, Infinity) === PROP_FAILED) continue;
        if (getScenePositionCached(other.satrec, ms, oPos, Infinity) === PROP_FAILED) continue;
        const d = sep(tPos, oPos);
        if (d < refBest) { refBest = d; refMs = ms; }
      }
      if (refBest <= thresholdKm) {
        getScenePositionCached(target.satrec, refMs, tPos, Infinity);
        getScenePositionCached(other.satrec, refMs, oPos, Infinity);
        getScenePositionCached(target.satrec, refMs + 1000, tPos2, Infinity);
        getScenePositionCached(other.satrec, refMs + 1000, oPos2, Infinity);
        const rvx = (tPos2.x - tPos.x) - (oPos2.x - oPos.x);
        const rvy = (tPos2.y - tPos.y) - (oPos2.y - oPos.y);
        const rvz = (tPos2.z - tPos.z) - (oPos2.z - oPos.z);
        const relSpeedKmS = Math.sqrt(rvx * rvx + rvy * rvy + rvz * rvz) * SCENE_TO_KM;
        results.push({ other, time: new Date(refMs), missKm: refBest, relSpeedKmS });
      }
    }

    if ((idx + 1) % SLICE === 0) {
      onProgress?.(idx + 1, candidates.length);
      await new Promise((r) => setTimeout(r, 0));
      if (isCancelled()) return null;
    }
  }

  onProgress?.(candidates.length, candidates.length);
  results.sort((a, b) => a.missKm - b.missKm);
  return results.slice(0, maxResults);
}

/** "12.4 km" / "840 m" — sub-kilometre approaches are the interesting ones, so
 *  they get metre precision. */
export function formatMiss(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}
