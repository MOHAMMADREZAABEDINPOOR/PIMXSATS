import * as satellite from 'satellite.js';

export type OrbitBand = 'LEO' | 'MEO' | 'GEO' | 'HEO';

export interface SatData {
  name: string;
  line1: string;
  line2: string;
  satrec: satellite.SatRec;
  category: string;
  color: string;
  intlDes: string;
  type: string;
  launchYear?: string;
  country: string;
  operator: string;
  purpose: string;
  fact: string;
  band: OrbitBand;
  /** UTC ms of launch (Jan 1 of the launch year from the intl designator).
   *  Used by time travel: the satellite is hidden before this date. */
  launchMs: number;
}

/** Classify orbit regime from mean motion (satrec.no is rad/min) and eccentricity. */
function classifyBand(satrec: satellite.SatRec): OrbitBand {
  const MU = 398600.4418; // km^3/s^2
  const R_EARTH = 6371;
  const periodSec = satrec.no > 0 ? (2 * Math.PI / satrec.no) * 60 : 0;
  if (periodSec <= 0) return 'LEO';
  const a = Math.cbrt(MU * Math.pow(periodSec / (2 * Math.PI), 2)); // semi-major axis, km
  const ecc = (satrec as unknown as { ecco?: number }).ecco ?? 0;
  if (ecc > 0.25) return 'HEO';
  const alt = a - R_EARTH;
  if (alt < 2000) return 'LEO';
  if (alt >= 34786 && alt <= 36786) return 'GEO';
  if (alt < 35786) return 'MEO';
  return 'HEO';
}

export function parseTLE(tleData: string): SatData[] {
  const lines = tleData.split('\n').map((l) => l.trim());
  const sats: SatData[] = [];

  for (let i = 0; i < lines.length; i += 3) {
    if (i + 2 >= lines.length) break;
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];

    if (!name || !line1 || !line2) continue;

    try {
      const satrec = satellite.twoline2satrec(line1, line2);
      // Determine category based on name
      let category = 'Other';
      let color = '#ffffff';
      let type = 'Unknown';
      const nameUpper = name.toUpperCase();

      if (nameUpper.includes('STARLINK')) {
        category = 'Starlink';
        color = '#00ffff'; // Cyan
        type = 'Communication (Mega-constellation)';
      } else if (nameUpper.includes('ISS') || nameUpper.includes('ZARYA') || nameUpper.includes('TIANGONG')) {
        category = 'Space Station';
        color = '#ff00ff'; // Magenta
        type = 'Manned Spacecraft';
      } else if (nameUpper.includes('NAVSTAR') || nameUpper.includes('GPS') || nameUpper.includes('GLONASS') || nameUpper.includes('GALILEO') || nameUpper.includes('BEIDOU')) {
        category = 'Navigation';
        color = '#ffd700'; // Gold
        type = 'Positioning & Navigation';
      } else if (nameUpper.includes('GOES') || nameUpper.includes('NOAA') || nameUpper.includes('METEOSAT')) {
        category = 'Weather';
        color = '#00ff00'; // Green
        type = 'Weather & Earth Observation';
      } else if (nameUpper.includes('USA') || nameUpper.includes('COSMOS')) {
        category = 'Military / Govt';
        color = '#ff4444'; // Red
        type = 'Government / Reconnaissance';
      } else if (nameUpper.includes('ONEWEB')) {
        category = 'OneWeb';
        color = '#4488ff'; // Blue
        type = 'Communication';
      } else if (nameUpper.includes('HUBBLE') || nameUpper.includes('JWST') || nameUpper.includes('CHANDRA')) {
        category = 'Science';
        color = '#ffffff';
        type = 'Scientific Observatory';
      } else if (nameUpper.includes('IRIDIUM')) {
        category = 'Iridium';
        color = '#66ff99';
        type = 'Voice & Data Communication';
      } else if (nameUpper.includes('GLOBALSTAR') || nameUpper.includes('ORBCOMM')) {
        category = 'Comms (LEO)';
        color = '#44ddcc';
        type = 'Communication';
      } else if (nameUpper.includes('INTELSAT') || nameUpper.includes('SES ') || nameUpper.includes('EUTELSAT') || nameUpper.includes('ASTRA') || nameUpper.includes('INMARSAT')) {
        category = 'Comms (GEO)';
        color = '#dd88ff';
        type = 'Geostationary Communication';
      } else if (nameUpper.includes('CUBESAT') || nameUpper.includes('CUBEBUG') || nameUpper.includes('DOVE') || nameUpper.includes('FLOCK') || nameUpper.includes('LEMUR')) {
        category = 'CubeSat';
        color = '#aaff44';
        type = 'Nanosatellite';
      } else if (nameUpper.includes(' R/B') || nameUpper.endsWith('R/B')) {
        category = 'Rocket Body';
        color = '#996644';
        type = 'Spent Rocket Stage';
      } else if (nameUpper.includes(' DEB')) {
        category = 'Debris';
        color = '#555555';
        type = 'Orbital Debris';
      } else {
        color = '#888888'; // Dim grey for others to keep focus on interesting ones
      }

      // Extract intl designator
      const intlDes = line1.substring(9, 17).trim();
      let launchYear = 'Unknown';
      let launchMs = 0; // unknown → treated as "always existed"
      if (intlDes) {
        let yearPrefix = parseInt(intlDes.substring(0, 2), 10);
        if (!isNaN(yearPrefix)) {
          // 57 to 99 are 1900s, 00 to 56 are 2000s
          const yr = yearPrefix >= 57 ? 1900 + yearPrefix : 2000 + yearPrefix;
          launchYear = yr.toString();
          launchMs = Date.UTC(yr, 0, 1);
        }
      }

      // Dynamically map operator, country, purpose, and fact
      let country = 'Global / International';
      let operator = 'Various Operators';
      let purpose = 'Earth Observation / Experimental';
      let fact = 'An active spacecraft contributing to global scientific knowledge and tech capabilities.';

      if (category === 'Starlink') {
        country = 'USA';
        operator = 'SpaceX';
        purpose = 'Global Broadband Internet';
        fact = `Part of SpaceX's high-speed global internet mega-constellation, deploying thousands of spacecraft to connect underserved areas.`;
      } else if (category === 'Space Station') {
        if (nameUpper.includes('ISS') || nameUpper.includes('ZARYA')) {
          country = 'International (USA, Russia, Europe, Japan, Canada)';
          operator = 'NASA / Roscosmos / ESA / JAXA';
          purpose = 'Manned Space Laboratory & Research';
          fact = 'The largest human-made structure in space, orbiting Earth at ~28,000 km/h with a rotating crew of scientists.';
        } else if (nameUpper.includes('TIANGONG') || nameUpper.includes('CSS')) {
          country = 'China';
          operator = 'CNSA (China National Space Administration)';
          purpose = 'Manned Space Station';
          fact = "China's permanent space station, supporting scientific experiments, crew rotations, and deep space exploration studies.";
        }
      } else if (category === 'Navigation') {
        if (nameUpper.includes('NAVSTAR') || nameUpper.includes('GPS')) {
          country = 'USA';
          operator = 'United States Space Force';
          purpose = 'Global Positioning System (GPS)';
          fact = 'Provides highly accurate time synchronization and location positioning anywhere in the world, 24/7.';
        } else if (nameUpper.includes('GLONASS')) {
          country = 'Russia';
          operator = 'Roscosmos';
          purpose = 'Global Navigation';
          fact = "Russia's premier satellite navigation constellation, providing dual-use civil and military positioning signals.";
        } else if (nameUpper.includes('GALILEO')) {
          country = 'Europe';
          operator = 'ESA / EUSPA';
          purpose = 'Highly Precise Civil Navigation';
          fact = "Europe's independent global navigation system, known for its exceptional centimeter-level precision and search-and-rescue services.";
        } else if (nameUpper.includes('BEIDOU')) {
          country = 'China';
          operator = 'CNSA';
          purpose = 'Global Navigation & Communication';
          fact = "China's global navigation constellation, incorporating unique short message messaging and high-precision services.";
        }
      } else if (category === 'Weather') {
        country = 'USA';
        operator = 'NOAA / NASA';
        purpose = 'Severe Weather Monitoring & Climate Study';
        fact = 'Captures advanced real-time weather imagery, atmospheric temperature soundings, and lightning maps to save lives during major storms.';
        if (nameUpper.includes('METEOSAT')) {
          country = 'Europe';
          operator = 'EUMETSAT';
          purpose = 'Meteorological Monitoring';
          fact = 'Maintains constant geostationary surveillance over Europe and Africa, providing vital updates every 15 minutes.';
        }
      } else if (category === 'Military / Govt') {
        if (nameUpper.includes('USA')) {
          country = 'USA';
          operator = 'National Reconnaissance Office (NRO)';
          purpose = 'Strategic Reconnaissance & Secure Defense Comm';
          fact = 'A highly classified government satellite operating on secret frequencies to support national security.';
        } else {
          country = 'Russia';
          operator = 'Russian Aerospace Forces';
          purpose = 'Government / Defense Communications';
          fact = 'Used for high-priority sovereign security operations and secure command networks.';
        }
      } else if (category === 'OneWeb') {
        country = 'United Kingdom';
        operator = 'Eutelsat OneWeb';
        purpose = 'Low Earth Orbit Broadband Internet';
        fact = 'Alternative global satellite broadband constellation operating in polar orbits to cover remote Arctic and sub-Arctic regions.';
      } else if (category === 'Science') {
        country = 'International';
        operator = 'NASA / ESA / JAXA';
        purpose = 'Astrophysics & Space Science';
        fact = 'Observes distant galaxies, exoplanets, and stellar clusters, expanding humanity’s understanding of the cosmos.';
      }

      sats.push({
        name: name.replace(/^0 /, '').trim(), // Sometimes names start with 0
        line1,
        line2,
        satrec,
        category,
        color,
        intlDes,
        type,
        launchYear,
        country,
        operator,
        purpose,
        fact,
        band: classifyBand(satrec),
        launchMs
      });
    } catch (e) {
      // invalid TLE
    }
  }

  return sats;
}

// Physical sanity bounds for SGP4 output. Decayed or stale TLEs make SGP4
// diverge into garbage (objects "orbiting" millions of km out at thousands
// of km/s, streaking across the scene even at 1× real time). Anything
// outside these bounds is not a real orbiting satellite and is hidden:
//   - below ~100 km altitude it has re-entered,
//   - beyond the Moon it is not a tracked Earth satellite,
//   - faster than ~11.2 km/s exceeds Earth escape velocity.
const MIN_SANE_R_KM = 6478;    // Earth radius + ~100 km
const MAX_SANE_R_KM = 500000;  // ~1.3× lunar distance
const MAX_SANE_SPEED_KMS = 13;

function isSaneState(pos: satellite.EciVec3<number>, vel?: satellite.EciVec3<number> | boolean): boolean {
  const r = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
  if (r < MIN_SANE_R_KM || r > MAX_SANE_R_KM) return false;
  if (vel && typeof vel !== 'boolean' && isFinite(vel.x)) {
    const v2 = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z;
    if (v2 > MAX_SANE_SPEED_KMS * MAX_SANE_SPEED_KMS) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cached scene-space propagation.
//
// SGP4's deep-space resonance handling (GEO, GPS, GLONASS, Molniya, …)
// integrates from the TLE epoch in 720-minute steps, and its internal state
// only resumes while the requested time moves AWAY from the epoch. After time
// travel to a historical date the clock runs forward — toward the epoch — so
// every propagate() re-integrates the whole epoch→date span from scratch:
// ~4.7 ms per GEO satellite for a 30-year jump (measured) instead of ~8 µs,
// for 1000+ resonant satellites in the catalog. That was the time-travel lag.
//
// The fix: anchor each satrec at one true SGP4 state (position + velocity)
// and serve linear extrapolation from that anchor while it stays within a
// per-orbit accuracy window (~5 km of drift). The expensive propagation then
// runs a few times per minute per satellite instead of every frame, in any
// era, and the per-call cost of the cheap path is a handful of flops with no
// allocations.
// ---------------------------------------------------------------------------

export interface ScenePos { x: number; y: number; z: number; }

export const PROP_FAILED = 0;
export const PROP_CACHED = 1;
export const PROP_FULL = 2;
export type PropResult = typeof PROP_FAILED | typeof PROP_CACHED | typeof PROP_FULL;

const SCENE_SCALE = 1 / 6371;
const MU_EARTH = 398600.4418; // km^3/s^2
// Max drift allowed from linear extrapolation before re-anchoring (~half a
// rendered dot diameter at scene scale).
const EXTRAP_TOL_KM = 5;
// Wall-clock backoff after a failed propagation: decayed/garbage TLEs far
// from their epoch would otherwise re-run a doomed (and possibly multi-ms)
// propagation every single frame.
const FAIL_BACKOFF_MS = 1500;

interface SceneCache {
  has: boolean;      // anchor holds a valid state
  ms: number;        // simulated time of the anchor
  x: number; y: number; z: number;    // scene units
  vx: number; vy: number; vz: number; // scene units per simulated second
  window: number;    // ± ms of simulated time the anchor stays accurate
  failUntil: number; // wall-clock ms: skip full attempts until then
}

type CachedSatRec = satellite.SatRec & { __sceneCache?: SceneCache };

/** How long linear extrapolation stays within EXTRAP_TOL_KM. The error is
 *  bounded by the gravitational acceleration at perigee: t ≈ √(2·tol/a) —
 *  about 34 s of simulated time for LEO, ~3.5 min for GEO. */
function extrapWindowMs(satrec: satellite.SatRec): number {
  const n = satrec.no / 60; // rad/min → rad/s
  if (!(n > 0)) return 2000;
  const sma = Math.cbrt(MU_EARTH / (n * n)); // semi-major axis, km
  const perigee = Math.max(6500, sma * (1 - (satrec.ecco || 0)));
  const accel = MU_EARTH / (perigee * perigee); // km/s^2
  const tSec = Math.sqrt((2 * EXTRAP_TOL_KM) / accel);
  return Math.min(600, Math.max(2, tSec)) * 1000;
}

/**
 * Scene-space position of a satellite at `ms` (Unix ms), written into `out`.
 *
 * Returns PROP_CACHED when served by extrapolation (cheap — safe to call for
 * the whole catalog every frame), PROP_FULL when a full SGP4 propagation ran
 * (potentially milliseconds for deep-space satellites far from their TLE
 * epoch — budgeted loops should re-check their deadline after one), and
 * PROP_FAILED when the state is unavailable (failure backoff is handled
 * internally).
 *
 * `maxAgeMs` optionally forces a fresher anchor than the accuracy window —
 * used for the selected satellite, where the camera gets close enough that a
 * re-anchor snap of even a few km would be visible.
 * `wallNowMs` (performance.now()) can be passed by tight loops to avoid a
 * clock read on the backoff path.
 */
export function getScenePositionCached(
  satrec: satellite.SatRec, ms: number, out: ScenePos,
  maxAgeMs = Infinity, wallNowMs?: number
): PropResult {
  const rec = satrec as CachedSatRec;
  let c = rec.__sceneCache;
  if (c === undefined) {
    c = rec.__sceneCache = {
      has: false, ms: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      window: extrapWindowMs(satrec), failUntil: 0,
    };
  }

  if (c.has) {
    const dt = ms - c.ms;
    const age = Math.abs(dt);
    if (age <= c.window && age <= maxAgeMs) {
      const s = dt / 1000;
      out.x = c.x + c.vx * s;
      out.y = c.y + c.vy * s;
      out.z = c.z + c.vz * s;
      return PROP_CACHED;
    }
  }

  if (c.failUntil > (wallNowMs ?? performance.now())) return PROP_FAILED;

  // Full SGP4 via the raw-minutes API — identical to propagate(), minus the
  // per-call Date allocation and calendar → julian-date conversion.
  const tsinceMin = (ms / 86400000 + 2440587.5 - satrec.jdsatepoch) * 1440;
  let pv: satellite.PositionAndVelocity;
  try {
    pv = satellite.sgp4(satrec, tsinceMin);
  } catch {
    pv = { position: false, velocity: false };
  }
  const pos = pv.position as satellite.EciVec3<number>;
  const vel = pv.velocity as satellite.EciVec3<number>;
  if (
    !pos || typeof pos === 'boolean' || !vel || typeof vel === 'boolean' ||
    !isFinite(pos.x) || !isFinite(vel.x) || !isSaneState(pos, vel)
  ) {
    c.has = false;
    c.failUntil = (wallNowMs ?? performance.now()) + FAIL_BACKOFF_MS;
    return PROP_FAILED;
  }

  // ECI → scene mapping (x, z, -y), identical to getPosition()
  c.has = true;
  c.failUntil = 0;
  c.ms = ms;
  c.x = pos.x * SCENE_SCALE;
  c.y = pos.z * SCENE_SCALE;
  c.z = -pos.y * SCENE_SCALE;
  c.vx = vel.x * SCENE_SCALE;
  c.vy = vel.z * SCENE_SCALE;
  c.vz = -vel.y * SCENE_SCALE;
  out.x = c.x;
  out.y = c.y;
  out.z = c.z;
  return PROP_FULL;
}

export function getPosition(satrec: satellite.SatRec, date: Date) {
  let positionAndVelocity: satellite.PositionAndVelocity;
  try {
    positionAndVelocity = satellite.propagate(satrec, date);
  } catch {
    return null; // SGP4 can throw far from the TLE epoch
  }
  const positionEci = positionAndVelocity.position as satellite.EciVec3<number>;

  if (!positionEci || typeof positionEci === 'boolean') return null;
  // Guard against numerically decayed/diverged propagation
  if (!isFinite(positionEci.x) || !isFinite(positionEci.y) || !isFinite(positionEci.z)) return null;
  if (!isSaneState(positionEci, positionAndVelocity.velocity)) return null;

  // Earth radius in km is about 6371.
  // satellite.js returns positions in km.
  // We can scale it down. Let's say Earth radius in Three.js is 1.
  // Then scale = 1 / 6371.
  const R_EARTH = 6371;
  const scale = 1 / R_EARTH;

  // Convert ECI to Three.js coordinates
  // ECI x, y, z
  // Three.js: y is up. ECI: z is up (North pole).
  // So Three.js (X, Y, Z) = ECI (X, Z, -Y)
  
  // Actually, standard ECEF or ECI to ThreeJS:
  // Let's just use (x, z, -y)
  const x = positionEci.x * scale;
  const y = positionEci.z * scale;
  const z = -positionEci.y * scale;

  return { x, y, z, eci: positionEci };
}

/**
 * Closed orbit path of a satellite, in scene units (Earth radius = 1).
 *
 * Instead of time-sampling SGP4 over ~1.02 orbital periods (which both
 * overshoots — the line overlaps itself — and leaves a gap when perturbations
 * drift the track, and was capped at 48 h so high orbits came out truncated),
 * this builds the OSCULATING ELLIPSE from the instantaneous position/velocity
 * state vector. Sampling the eccentric anomaly 0 → 2π yields a mathematically
 * perfect closed ellipse through the satellite's current position, correct
 * for every regime: LEO, MEO, GEO and highly elliptical orbits.
 */
export function getOrbitEllipsePoints(
  satrec: satellite.SatRec, date: Date, segments = 256
): [number, number, number][] | null {
  const MU = 398600.4418; // km^3/s^2
  let pv: satellite.PositionAndVelocity;
  try {
    pv = satellite.propagate(satrec, date);
  } catch {
    return null;
  }
  const r = pv.position as satellite.EciVec3<number>;
  const v = pv.velocity as satellite.EciVec3<number>;
  if (!r || !v || typeof r === 'boolean' || typeof v === 'boolean') return null;
  if (!isFinite(r.x) || !isFinite(v.x)) return null;

  const rlen = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
  const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
  if (rlen < 1) return null;

  // Semi-major axis from the vis-viva equation
  const a = 1 / (2 / rlen - v2 / MU);
  if (!isFinite(a) || a <= 0) return null; // hyperbolic / diverged state

  // Specific angular momentum h = r × v (orbit plane normal)
  const hx = r.y * v.z - r.z * v.y;
  const hy = r.z * v.x - r.x * v.z;
  const hz = r.x * v.y - r.y * v.x;
  const hlen = Math.sqrt(hx * hx + hy * hy + hz * hz);
  if (hlen < 1e-6) return null;
  const wx = hx / hlen, wy = hy / hlen, wz = hz / hlen;

  // Eccentricity vector (points at perigee)
  const rv = r.x * v.x + r.y * v.y + r.z * v.z;
  const c1 = v2 - MU / rlen;
  const ex = (c1 * r.x - rv * v.x) / MU;
  const ey = (c1 * r.y - rv * v.y) / MU;
  const ez = (c1 * r.z - rv * v.z) / MU;
  const e = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (e >= 0.999) return null;
  if (a * (1 + e) > MAX_SANE_R_KM) return null; // garbage TLE

  // In-plane basis: p̂ toward perigee (fallback: current radial for e ≈ 0),
  // q̂ = ŵ × p̂ completes the right-handed frame.
  let px: number, py: number, pz: number;
  if (e > 1e-6) {
    px = ex / e; py = ey / e; pz = ez / e;
  } else {
    px = r.x / rlen; py = r.y / rlen; pz = r.z / rlen;
  }
  const qx = wy * pz - wz * py;
  const qy = wz * px - wx * pz;
  const qz = wx * py - wy * px;

  const b = a * Math.sqrt(1 - e * e);
  const scale = 1 / 6371;
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const E = (i / segments) * 2 * Math.PI;
    const X = a * (Math.cos(E) - e);
    const Y = b * Math.sin(E);
    const eciX = X * px + Y * qx;
    const eciY = X * py + Y * qy;
    const eciZ = X * pz + Y * qz;
    // ECI → scene mapping, identical to getPosition()
    pts.push([eciX * scale, eciZ * scale, -eciY * scale]);
  }
  return pts;
}

export function getLatLng(satrec: satellite.SatRec, date: Date, eci: satellite.EciVec3<number>) {
    const gmst = satellite.gstime(date);
    const positionGd = satellite.eciToGeodetic(eci, gmst);
    
    return {
        lat: satellite.degreesLat(positionGd.latitude),
        lng: satellite.degreesLong(positionGd.longitude),
        alt: positionGd.height
    };
}

export interface SatelliteRealtimeInfo {
  altitude: number;
  speed: number;
  coverageRadius: number;
  coverageArea: number;
  lat: number;
  lng: number;
}

export function getSatelliteRealtimeInfo(satrec: satellite.SatRec, date: Date): SatelliteRealtimeInfo | null {
  let positionAndVelocity: satellite.PositionAndVelocity;
  try {
    positionAndVelocity = satellite.propagate(satrec, date);
  } catch {
    return null;
  }
  const posEci = positionAndVelocity.position as satellite.EciVec3<number>;
  const velEci = positionAndVelocity.velocity as satellite.EciVec3<number>;

  if (!posEci || !velEci || typeof posEci === 'boolean' || typeof velEci === 'boolean') return null;
  if (!isFinite(posEci.x) || !isFinite(velEci.x)) return null;
  if (!isSaneState(posEci, velEci)) return null;

  const gmst = satellite.gstime(date);
  const positionGd = satellite.eciToGeodetic(posEci, gmst);
  const altitude = positionGd.height; // in km

  const speed = Math.sqrt(velEci.x * velEci.x + velEci.y * velEci.y + velEci.z * velEci.z); // in km/s

  const R = 6371; // Earth radius in km
  const cosTheta = R / (R + altitude);
  const theta = Math.acos(Math.min(1.0, Math.max(-1.0, cosTheta))); // radians
  const coverageRadius = R * theta; // ground footprint radius
  const coverageArea = 2 * Math.PI * R * R * (1.0 - cosTheta); // surface area in km^2

  return {
    altitude,
    speed,
    coverageRadius,
    coverageArea,
    lat: satellite.degreesLat(positionGd.latitude),
    lng: satellite.degreesLong(positionGd.longitude),
  };
}
