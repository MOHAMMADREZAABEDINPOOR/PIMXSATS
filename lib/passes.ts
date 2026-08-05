// Pass prediction: when does a given satellite actually appear in the sky
// above the user, and will it be bright enough to see with the naked eye?
//
// The search marches the look angle from the observer forward in 20 s steps
// and refines the horizon crossings by linear interpolation. That step cannot
// miss a reportable pass — even a grazing one that only reaches 10° stays up
// for well over a minute, and an overhead ISS pass lasts several.
//
// "Visible" here means visible to the EYE: the satellite must be in sunlight
// while the observer's own sky is dark. That is the difference between a pass
// worth walking outside for and one only a radio can hear.
//
// A full 24 h scan is thousands of SGP4 propagations, so the work is exposed
// both as a plain synchronous call and as a chunked async one that yields to
// the browser between slices — the UI uses the latter and never janks.

import * as satellite from 'satellite.js';
import { getSunEciDirection } from './astronomy';

export interface Observer {
  lat: number; // degrees
  lon: number; // degrees
  /** Height above the ellipsoid, km. */
  heightKm?: number;
}

export interface SatellitePass {
  /** Horizon crossing (rise). */
  start: Date;
  /** Moment of greatest elevation. */
  peak: Date;
  /** Horizon crossing (set). */
  end: Date;
  /** Greatest elevation reached, degrees. */
  maxElevationDeg: number;
  /** Compass bearing, degrees from north, at rise / peak / set. */
  startAzimuthDeg: number;
  peakAzimuthDeg: number;
  endAzimuthDeg: number;
  /** Slant range at peak, km. */
  peakRangeKm: number;
  /** Pass duration, seconds. */
  durationSec: number;
  /** Sunlit satellite over a dark observer — a naked-eye pass. */
  visible: boolean;
}

export interface PassOptions {
  horizonHours?: number;
  maxPasses?: number;
  minElevationDeg?: number;
}

const EARTH_RADIUS_KM = 6378.137;
/** Below this a pass is a horizon graze, normally hidden by terrain. */
const DEFAULT_MIN_ELEVATION_DEG = 10;
const DEFAULT_HORIZON_HOURS = 24;
const DEFAULT_MAX_PASSES = 5;
const STEP_MS = 20_000;
/** Civil twilight — dark enough for satellites to stand out. */
const OBSERVER_DARK_SUN_ELEV_DEG = -6;
/** The Sun moves 0.04°/h; recomputing its direction every 10 simulated
 *  minutes is far finer than any threshold here. */
const SUN_CACHE_MS = 600_000;
/** Simulated span walked between yields in the async variant. */
const CHUNK_MS = 3 * 3600_000;

interface Sample {
  ms: number;
  elevationDeg: number;
  azimuthDeg: number;
  rangeKm: number;
  sunlit: boolean;
  observerDark: boolean;
}

/** Is an ECI position outside Earth's shadow? Cylindrical shadow model, good
 *  to a few seconds of pass time — far finer than what is reported. */
function isSunlit(
  posEci: satellite.EciVec3<number>,
  sun: { x: number; y: number; z: number }
): boolean {
  const along = posEci.x * sun.x + posEci.y * sun.y + posEci.z * sun.z;
  if (along > 0) return true; // day side of the planet
  const px = posEci.x - along * sun.x;
  const py = posEci.y - along * sun.y;
  const pz = posEci.z - along * sun.z;
  return Math.sqrt(px * px + py * py + pz * pz) > EARTH_RADIUS_KM;
}

/** Sun elevation at the observer, degrees. The geocentric radial stands in for
 *  the local vertical — within ~0.2°, irrelevant against a -6° threshold. */
function sunElevationDeg(
  observerEci: satellite.EciVec3<number>,
  sun: { x: number; y: number; z: number }
): number {
  const len = Math.hypot(observerEci.x, observerEci.y, observerEci.z);
  if (len < 1e-6) return 0;
  const dot = (observerEci.x * sun.x + observerEci.y * sun.y + observerEci.z * sun.z) / len;
  return (Math.asin(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/** Horizon crossing time between two straddling samples. */
function crossingMs(before: Sample, after: Sample): number {
  const span = after.elevationDeg - before.elevationDeg;
  if (Math.abs(span) < 1e-9) return after.ms;
  const t = -before.elevationDeg / span;
  return before.ms + Math.max(0, Math.min(1, t)) * (after.ms - before.ms);
}

// ---------------------------------------------------------------------------
// Resumable scan
// ---------------------------------------------------------------------------

interface ScanState {
  cursorMs: number;
  endMs: number;
  prev: Sample | null;
  /** Pass currently being walked through (null between passes). */
  riseMs: number;
  riseAzimuthDeg: number;
  peak: Sample | null;
  sawSunlitDark: boolean;
  sunMs: number;
  sun: { x: number; y: number; z: number };
  passes: SatellitePass[];
  done: boolean;
}

function createScan(from: Date, horizonHours: number): ScanState {
  const startMs = from.getTime();
  return {
    cursorMs: startMs,
    endMs: startMs + horizonHours * 3600_000,
    prev: null,
    riseMs: 0,
    riseAzimuthDeg: 0,
    peak: null,
    sawSunlitDark: false,
    sunMs: -Infinity,
    sun: { x: 1, y: 0, z: 0 },
    passes: [],
    done: false,
  };
}

/** Advance the scan by at most `budgetMs` of simulated time. Sets
 *  `state.done` when the horizon or the pass quota is reached. */
function advanceScan(
  satrec: satellite.SatRec,
  observerGd: satellite.GeodeticLocation,
  observerEcf: satellite.EcfVec3<number>,
  state: ScanState,
  budgetMs: number,
  minElevationDeg: number,
  maxPasses: number
): void {
  const sliceEnd = Math.min(state.endMs, state.cursorMs + budgetMs);
  const scratchDate = new Date(state.cursorMs);

  for (; state.cursorMs <= sliceEnd; state.cursorMs += STEP_MS) {
    const ms = state.cursorMs;
    scratchDate.setTime(ms);

    let pv: satellite.PositionAndVelocity;
    try {
      pv = satellite.propagate(satrec, scratchDate);
    } catch {
      state.prev = null;
      continue;
    }
    const posEci = pv.position as satellite.EciVec3<number>;
    if (!posEci || typeof posEci === 'boolean' || !isFinite(posEci.x)) {
      state.prev = null;
      continue;
    }

    if (ms - state.sunMs > SUN_CACHE_MS) {
      const s = getSunEciDirection(scratchDate);
      state.sun = { x: s.x, y: s.y, z: s.z };
      state.sunMs = ms;
    }

    const gmst = satellite.gstime(scratchDate);
    const look = satellite.ecfToLookAngles(observerGd, satellite.eciToEcf(posEci, gmst));

    const elevationDeg = (look.elevation * 180) / Math.PI;
    const wasUp = state.prev !== null && state.prev.elevationDeg > 0;
    const isUp = elevationDeg > 0;

    // Sunlight/darkness only matter while the satellite is actually up, and
    // they are the expensive part of the sample — skip them otherwise.
    let sunlit = false;
    let observerDark = false;
    if (isUp) {
      sunlit = isSunlit(posEci, state.sun);
      observerDark =
        sunElevationDeg(satellite.ecfToEci(observerEcf, gmst), state.sun) < OBSERVER_DARK_SUN_ELEV_DEG;
    }

    const sample: Sample = {
      ms,
      elevationDeg,
      azimuthDeg: (((look.azimuth * 180) / Math.PI) % 360 + 360) % 360,
      rangeKm: look.rangeSat,
      sunlit,
      observerDark,
    };

    if (isUp) {
      if (!wasUp) {
        state.riseMs = state.prev ? crossingMs(state.prev, sample) : ms;
        state.riseAzimuthDeg = sample.azimuthDeg;
        state.peak = sample;
        state.sawSunlitDark = false;
      } else if (!state.peak || sample.elevationDeg > state.peak.elevationDeg) {
        state.peak = sample;
      }
      if (sunlit && observerDark) state.sawSunlitDark = true;
    } else if (wasUp && state.peak && state.prev) {
      const setMs = crossingMs(state.prev, sample);
      if (state.peak.elevationDeg >= minElevationDeg) {
        state.passes.push({
          start: new Date(state.riseMs),
          peak: new Date(state.peak.ms),
          end: new Date(setMs),
          maxElevationDeg: state.peak.elevationDeg,
          startAzimuthDeg: state.riseAzimuthDeg,
          peakAzimuthDeg: state.peak.azimuthDeg,
          endAzimuthDeg: state.prev.azimuthDeg,
          peakRangeKm: state.peak.rangeKm,
          durationSec: Math.max(0, (setMs - state.riseMs) / 1000),
          visible: state.sawSunlitDark,
        });
        if (state.passes.length >= maxPasses) {
          state.done = true;
          return;
        }
      }
      state.peak = null;
    }

    state.prev = sample;
  }

  if (state.cursorMs > state.endMs) state.done = true;
}

function observerFrame(observer: Observer) {
  const observerGd: satellite.GeodeticLocation = {
    longitude: (observer.lon * Math.PI) / 180,
    latitude: (observer.lat * Math.PI) / 180,
    height: observer.heightKm ?? 0.05,
  };
  return { observerGd, observerEcf: satellite.geodeticToEcf(observerGd) };
}

/**
 * Next passes of `satrec` over `observer`, starting at `from`.
 *
 * An empty result means the satellite never rises to `minElevationDeg` over
 * this location within the horizon — normal for a low-inclination orbit seen
 * from a high latitude.
 */
export function predictPasses(
  satrec: satellite.SatRec,
  observer: Observer,
  from: Date,
  options: PassOptions = {}
): SatellitePass[] {
  const {
    horizonHours = DEFAULT_HORIZON_HOURS,
    maxPasses = DEFAULT_MAX_PASSES,
    minElevationDeg = DEFAULT_MIN_ELEVATION_DEG,
  } = options;
  const { observerGd, observerEcf } = observerFrame(observer);
  const state = createScan(from, horizonHours);
  while (!state.done) {
    advanceScan(satrec, observerGd, observerEcf, state, Infinity, minElevationDeg, maxPasses);
  }
  return state.passes;
}

/** Yield to the browser so a long scan never blocks paint or input. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Chunked variant: identical results, computed a few simulated hours at a
 * time with a yield between slices. `isCancelled` is polled at every yield so
 * a superseded request stops instead of finishing wastefully.
 */
export async function predictPassesAsync(
  satrec: satellite.SatRec,
  observer: Observer,
  from: Date,
  options: PassOptions = {},
  isCancelled: () => boolean = () => false
): Promise<SatellitePass[] | null> {
  const {
    horizonHours = DEFAULT_HORIZON_HOURS,
    maxPasses = DEFAULT_MAX_PASSES,
    minElevationDeg = DEFAULT_MIN_ELEVATION_DEG,
  } = options;
  const { observerGd, observerEcf } = observerFrame(observer);
  const state = createScan(from, horizonHours);

  while (!state.done) {
    advanceScan(satrec, observerGd, observerEcf, state, CHUNK_MS, minElevationDeg, maxPasses);
    if (state.done) break;
    await yieldToBrowser();
    if (isCancelled()) return null;
  }
  return state.passes;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** 137° → "SE". */
export function compassPoint(azimuthDeg: number): string {
  const idx = Math.round(((((azimuthDeg % 360) + 360) % 360)) / 22.5) % 16;
  return COMPASS[idx];
}

/** 312 → "5m 12s". */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, '0')}s` : `${s}s`;
}

/** "in 3h 12m" / "in 8m" / "now". */
export function formatCountdown(target: Date, now: Date): string {
  const delta = target.getTime() - now.getTime();
  if (delta <= 0) return 'now';
  const mins = Math.round(delta / 60000);
  if (mins < 1) return 'in <1m';
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem > 0 ? `in ${hours}h ${rem}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

/** Grade used for the badge in the pass list. */
export function passQuality(pass: SatellitePass): 'excellent' | 'good' | 'fair' {
  if (pass.maxElevationDeg >= 60) return 'excellent';
  if (pass.maxElevationDeg >= 30) return 'good';
  return 'fair';
}
