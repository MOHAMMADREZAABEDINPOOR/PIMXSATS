// Real astronomical ephemeris used across the app.
//
// Conventions:
//  - "ECI" frame: Earth-centered inertial, X toward vernal equinox, Z toward
//    celestial north pole (same frame satellite.js propagates TLEs in).
//  - "Scene" frame (three.js): Y up. ECI (x, y, z) maps to scene (x, z, -y),
//    identical to the mapping used for satellites in lib/satellite.ts.
//  - Heliocentric positions are computed in the J2000 ecliptic frame and
//    mapped the same way (ecliptic north = scene +Y).

import * as THREE from 'three';

const DEG = Math.PI / 180;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0); // 2000-01-01 12:00 TT (~UTC)

export const AU_KM = 149597870.7;

/** Julian centuries since J2000 */
export function julianCenturies(date: Date): number {
  return (date.getTime() - J2000_MS) / (86400000 * 36525);
}

/** Days since J2000 */
export function daysSinceJ2000(date: Date): number {
  return (date.getTime() - J2000_MS) / 86400000;
}

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------

/**
 * Low-precision solar ephemeris (Astronomical Almanac), accurate to ~0.01°.
 * Returns the unit vector pointing from Earth's center toward the Sun, in ECI.
 */
export function getSunEciDirection(date: Date): THREE.Vector3 {
  const n = daysSinceJ2000(date);

  const L = (280.460 + 0.9856474 * n) * DEG;      // mean longitude
  const g = (357.528 + 0.9856003 * n) * DEG;      // mean anomaly
  const lambda = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG; // ecliptic longitude
  const epsilon = (23.439 - 0.0000004 * n) * DEG; // obliquity of the ecliptic

  return new THREE.Vector3(
    Math.cos(lambda),
    Math.cos(epsilon) * Math.sin(lambda),
    Math.sin(epsilon) * Math.sin(lambda)
  ).normalize();
}

/** Sun direction converted to scene (three.js) coordinates. */
export function getSunSceneDirection(date: Date, target?: THREE.Vector3): THREE.Vector3 {
  const eci = getSunEciDirection(date);
  const out = target ?? new THREE.Vector3();
  return out.set(eci.x, eci.z, -eci.y);
}

// ---------------------------------------------------------------------------
// Planets — JPL approximate Keplerian elements (valid 1800 AD – 2050 AD)
// https://ssd.jpl.nasa.gov/planets/approx_pos.html
// ---------------------------------------------------------------------------

export interface KeplerElements {
  a: number;      // semi-major axis, AU
  e: number;      // eccentricity
  i: number;      // inclination, deg
  L: number;      // mean longitude, deg
  peri: number;   // longitude of perihelion, deg
  node: number;   // longitude of ascending node, deg
}

interface PlanetElementRow {
  el: KeplerElements;      // at J2000
  rate: KeplerElements;    // per Julian century
}

export const PLANET_ELEMENTS: Record<string, PlanetElementRow> = {
  Mercury: {
    el:   { a: 0.38709927, e: 0.20563593, i: 7.00497902,  L: 252.25032350, peri: 77.45779628,  node: 48.33076593 },
    rate: { a: 0.00000037, e: 0.00001906, i: -0.00594749, L: 149472.67411175, peri: 0.16047689, node: -0.12534081 },
  },
  Venus: {
    el:   { a: 0.72333566, e: 0.00677672, i: 3.39467605,  L: 181.97909950, peri: 131.60246718, node: 76.67984255 },
    rate: { a: 0.00000390, e: -0.00004107, i: -0.00078890, L: 58517.81538729, peri: 0.00268329, node: -0.27769418 },
  },
  Earth: {
    el:   { a: 1.00000261, e: 0.01671123, i: -0.00001531, L: 100.46457166, peri: 102.93768193, node: 0.0 },
    rate: { a: 0.00000562, e: -0.00004392, i: -0.01294668, L: 35999.37244981, peri: 0.32327364, node: 0.0 },
  },
  Mars: {
    el:   { a: 1.52371034, e: 0.09339410, i: 1.84969142,  L: -4.55343205,  peri: -23.94362959, node: 49.55953891 },
    rate: { a: 0.00001847, e: 0.00007882, i: -0.00813131, L: 19140.30268499, peri: 0.44441088, node: -0.29257343 },
  },
  Jupiter: {
    el:   { a: 5.20288700, e: 0.04838624, i: 1.30439695,  L: 34.39644051,  peri: 14.72847983,  node: 100.47390909 },
    rate: { a: -0.00011607, e: -0.00013253, i: -0.00183714, L: 3034.74612775, peri: 0.21252668, node: 0.20469106 },
  },
  Saturn: {
    el:   { a: 9.53667594, e: 0.05386179, i: 2.48599187,  L: 49.95424423,  peri: 92.59887831,  node: 113.66242448 },
    rate: { a: -0.00125060, e: -0.00050991, i: 0.00193609, L: 1222.49362201, peri: -0.41897216, node: -0.28867794 },
  },
  Uranus: {
    el:   { a: 19.18916464, e: 0.04725744, i: 0.77263783, L: 313.23810451, peri: 170.95427630, node: 74.01692503 },
    rate: { a: -0.00196176, e: -0.00004397, i: -0.00242939, L: 428.48202785, peri: 0.40805281, node: 0.04240589 },
  },
  Neptune: {
    el:   { a: 30.06992276, e: 0.00859048, i: 1.77004347, L: -55.12002969, peri: 44.96476227,  node: 131.78422574 },
    rate: { a: 0.00026291, e: 0.00005105, i: 0.00035372,  L: 218.45945325, peri: -0.32241464,  node: -0.00508664 },
  },
};

/** Solve Kepler's equation M = E - e·sin(E) via Newton iteration (radians). */
export function solveKepler(M: number, e: number): number {
  // Normalize M to [-PI, PI] for fast convergence
  M = M % (2 * Math.PI);
  if (M > Math.PI) M -= 2 * Math.PI;
  if (M < -Math.PI) M += 2 * Math.PI;

  let E = e < 0.8 ? M : Math.PI * Math.sign(M || 1);
  for (let iter = 0; iter < 12; iter++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-8) break;
  }
  return E;
}

export interface HeliocentricPosition {
  /** J2000 ecliptic coordinates, AU */
  x: number;
  y: number;
  z: number;
  /** heliocentric distance, AU */
  r: number;
  /** heliocentric ecliptic longitude, radians */
  lon: number;
}

/** Position from arbitrary Keplerian elements (angles in degrees, a in AU). */
export function keplerToEcliptic(el: KeplerElements): HeliocentricPosition {
  const { a, e } = el;
  const i = el.i * DEG;
  const node = el.node * DEG;
  const peri = el.peri * DEG;      // longitude of perihelion
  const argPeri = peri - node;     // argument of perihelion
  const M = (el.L - el.peri) * DEG;

  const E = solveKepler(M, e);

  // Position in orbital plane (perifocal)
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);

  const cosO = Math.cos(node), sinO = Math.sin(node);
  const cosI = Math.cos(i), sinI = Math.sin(i);
  const cosW = Math.cos(argPeri), sinW = Math.sin(argPeri);

  const x = (cosW * cosO - sinW * sinO * cosI) * xp + (-sinW * cosO - cosW * sinO * cosI) * yp;
  const y = (cosW * sinO + sinW * cosO * cosI) * xp + (-sinW * sinO + cosW * cosO * cosI) * yp;
  const z = (sinW * sinI) * xp + (cosW * sinI) * yp;

  const r = Math.sqrt(x * x + y * y + z * z);
  return { x, y, z, r, lon: Math.atan2(y, x) };
}

/** Real-time heliocentric position of a major planet (J2000 ecliptic, AU). */
export function getPlanetHeliocentric(name: string, date: Date): HeliocentricPosition | null {
  const row = PLANET_ELEMENTS[name];
  if (!row) return null;
  const T = julianCenturies(date);
  const el: KeplerElements = {
    a: row.el.a + row.rate.a * T,
    e: row.el.e + row.rate.e * T,
    i: row.el.i + row.rate.i * T,
    L: row.el.L + row.rate.L * T,
    peri: row.el.peri + row.rate.peri * T,
    node: row.el.node + row.rate.node * T,
  };
  return keplerToEcliptic(el);
}

// ---------------------------------------------------------------------------
// Earth's Moon — low-precision lunar theory (~0.3° accuracy)
// ---------------------------------------------------------------------------

/**
 * Geocentric direction + distance of the Moon.
 * Returns ecliptic longitude/latitude (radians) and distance (km).
 */
export function getMoonGeocentric(date: Date): { lon: number; lat: number; distKm: number } {
  const n = daysSinceJ2000(date);

  const Lp = (218.316 + 13.176396 * n) * DEG;  // mean longitude
  const Mp = (134.963 + 13.064993 * n) * DEG;  // mean anomaly
  const F = (93.272 + 13.229350 * n) * DEG;    // mean distance (argument of latitude)

  const lon = Lp + 6.289 * DEG * Math.sin(Mp);
  const lat = 5.128 * DEG * Math.sin(F);
  const distKm = 385001 - 20905 * Math.cos(Mp);

  return { lon, lat, distKm };
}

// ---------------------------------------------------------------------------
// Scene mapping helpers
// ---------------------------------------------------------------------------

/**
 * Display scale for heliocentric distances: r_scene = K · AU^0.5, radially
 * compressed so the whole system fits on one screen while the ordering and
 * relative spacing of the orbits is preserved. Angular positions stay exact.
 */
export const ORBIT_SCALE_K = 1.6;
export const ORBIT_SCALE_P = 0.5;

export function auToSceneRadius(au: number): number {
  return ORBIT_SCALE_K * Math.pow(Math.max(au, 0.001), ORBIT_SCALE_P);
}

/** Ecliptic (x, y, z in AU) -> compressed scene position (three.js, Y up). */
export function eclipticToScene(x: number, y: number, z: number, target?: THREE.Vector3): THREE.Vector3 {
  const r = Math.sqrt(x * x + y * y + z * z);
  const out = target ?? new THREE.Vector3();
  if (r < 1e-9) return out.set(0, 0, 0);
  const s = auToSceneRadius(r) / r;
  // Ecliptic frame: X toward vernal equinox, Z ecliptic north.
  // Scene: Y up -> (x, z, -y)
  return out.set(x * s, z * s, -y * s);
}
