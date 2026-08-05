// Live sky view: what is over the observer's head RIGHT NOW.
//
// lib/passes.ts answers "when will this one satellite appear?" by marching a
// single object forward in time. This answers the complementary question —
// "which of the ten thousand objects in the catalog are above me at this
// instant, and which of them could I actually SEE?" — for the whole catalog,
// several times a second.
//
// That budget rules out the convenient satellite.js path the pass scanner
// uses. `propagate(Date)` allocates a Date and re-derives the Julian date per
// call, and `ecfToLookAngles` re-runs `geodeticToEcf` for the (unchanging)
// observer every time and allocates two intermediate vectors. So here the
// observer frame is built once per call, the ECI→ECF rotation and the
// topocentric projection are inlined with no allocations, and satellite
// positions come from the shared extrapolation cache in lib/satellite.ts —
// the same anchors the 3D globe already primed, which makes the sky view
// nearly free whenever both are live.
//
// "Visible" carries the same meaning as in the pass predictor: sunlit
// satellite over a dark observer. That is the difference between a dot worth
// looking up at and one only a radio can hear.

import * as satellite from 'satellite.js';
import { getSunEciDirection } from './astronomy';
import { getScenePositionCached, PROP_FAILED, type SatData, type ScenePos } from './satellite';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
/** Inverse of SCENE_SCALE in lib/satellite.ts — scene units back to km. */
const KM_PER_SCENE_UNIT = 6371;
const EARTH_RADIUS_KM = 6378.137;
/** Civil twilight — dark enough for satellites to stand out. Same threshold
 *  as the pass predictor, so the two panels never disagree. */
const OBSERVER_DARK_SUN_ELEV_DEG = -6;
/** Observer height when the caller has none; a typical rooftop/eye height.
 *  Matches the pass predictor's default. */
const DEFAULT_OBSERVER_ALT_KM = 0.05;

const DEFAULT_MIN_ELEVATION_DEG = 0;
const DEFAULT_MAX_RESULTS = 400;
/** Faintest star a good pair of eyes resolves under a dark sky. Only used to
 *  word the label — it does not gate `visible`. */
const NAKED_EYE_MAG_LIMIT = 6.0;
/** Magnitudes added to an eclipsed satellite. Earthshine leaves it far below
 *  anything observable, but keeping it on a finite scale means sorting and
 *  dot-sizing still behave sensibly for radar-style plots that show
 *  everything overhead, not just the visible ones. */
const ECLIPSE_MAG_PENALTY = 20;

export interface SkySighting {
  sat: SatData;
  azimuthDeg: number;
  elevationDeg: number;
  rangeKm: number;
  /** true when the satellite is in sunlight but the observer is in darkness —
   *  i.e. actually visible to the naked eye */
  visible: boolean;
  /** approximate apparent brightness proxy, lower = brighter; used for dot
   *  sizing/sorting */
  magnitudeProxy: number;
  /** Satellite is outside Earth's shadow. Exposed so the UI can distinguish
   *  "in shadow" from "lost in daylight" — see visibilityLabel(). */
  sunlit: boolean;
  /** The observer's own sky is dark (Sun below civil twilight). Constant
   *  across every sighting of one computeSky() call. */
  observerDark: boolean;
}

export interface SkyOptions {
  /** Horizon cutoff. 0 (default) is the geometric horizon; ~10 excludes the
   *  low grazes that buildings and terrain hide anyway. Negative values are
   *  allowed if the caller wants to show objects that are about to rise. */
  minElevationDeg?: number;
  maxResults?: number;
}

// ---------------------------------------------------------------------------
// Brightness model
// ---------------------------------------------------------------------------

// "Standard magnitude": apparent brightness at 1000 km range, fully
// illuminated. Real values depend on attitude, surface area and whether the
// object tumbles — none of which a TLE knows — so these are per-category
// order-of-magnitude estimates good enough to rank dots and size them, and
// nothing more. Anything absent falls back to a generic satellite bus.
const STANDARD_MAGNITUDE: Record<string, number> = {
  'Space Station': -1.8, // ISS/Tiangong: acres of solar array, brighter than Venus
  'Starlink': 5.5,
  'OneWeb': 6.5,
  'Iridium': 6.0,
  'Comms (LEO)': 6.0,
  'Rocket Body': 3.5,    // large bare cylinders; tumbling ones flare
  'Debris': 8.5,
  'CubeSat': 9.5,
  'Navigation': 4.5,     // physically large, but MEO puts them 20 000 km away
  'Comms (GEO)': 5.0,
  'Weather': 5.0,
  'Science': 4.0,
};
const DEFAULT_STANDARD_MAGNITUDE = 5.0;

/**
 * Apparent magnitude of a diffuse sphere at `rangeKm`, seen at a phase angle
 * whose cosine is `cosPhase` (0° phase = the observer sees the fully lit
 * face). The phase law is the standard Lambertian sphere integral; it is why
 * a satellite near the anti-solar point looks dramatically brighter than the
 * same satellite low in the twilight arch at the same distance.
 */
function apparentMagnitude(standardMag: number, rangeKm: number, cosPhase: number): number {
  const phase = Math.acos(cosPhase < -1 ? -1 : cosPhase > 1 ? 1 : cosPhase);
  const lambert = (Math.sin(phase) + (Math.PI - phase) * Math.cos(phase)) / Math.PI;
  // Floor keeps the log finite at exactly 180° phase (a satellite between the
  // observer and the Sun, showing only its unlit face).
  return (
    standardMag +
    5 * Math.log10(Math.max(rangeKm, 1) / 1000) -
    2.5 * Math.log10(Math.max(lambert, 1e-4))
  );
}

// ---------------------------------------------------------------------------
// Sky snapshot
// ---------------------------------------------------------------------------

/**
 * Every catalog object currently above `observer`'s horizon at `at`, brightest
 * geometry first (highest elevation first), capped at `maxResults`.
 *
 * Elevation ordering — rather than magnitude — is deliberate: the caller wants
 * a stable, physically meaningful z-order for a dome plot, and the truncation
 * should drop the horizon clutter, not the dim-but-overhead objects.
 *
 * Objects whose propagation fails (decayed or garbage TLEs) and objects not
 * yet launched at `at` are silently skipped, so time travel to a historical
 * date shows the sky as it actually looked then.
 */
export function computeSky(
  satellites: SatData[],
  observer: { lat: number; lon: number; altKm?: number },
  at: Date,
  opts: SkyOptions = {}
): SkySighting[] {
  const { minElevationDeg = DEFAULT_MIN_ELEVATION_DEG, maxResults = DEFAULT_MAX_RESULTS } = opts;
  const atMs = at.getTime();
  const results: SkySighting[] = [];
  if (maxResults <= 0 || satellites.length === 0) return results;

  // --- Per-call frame setup: everything that does not vary per satellite ---

  const latRad = observer.lat * DEG;
  const lonRad = observer.lon * DEG;
  const sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad), cosLon = Math.cos(lonRad);

  const observerGd: satellite.GeodeticLocation = {
    longitude: lonRad,
    latitude: latRad,
    height: observer.altKm ?? DEFAULT_OBSERVER_ALT_KM,
  };
  const obs = satellite.geodeticToEcf(observerGd);

  const gmst = satellite.gstime(at);
  const cosG = Math.cos(gmst), sinG = Math.sin(gmst);

  const sun = getSunEciDirection(at);
  const sunX = sun.x, sunY = sun.y, sunZ = sun.z;

  // Observer position in ECI (ECF rotated forward by GMST) — needed only to
  // ask how far the Sun is below the local horizon. The geocentric radial
  // stands in for the local vertical here: the ~0.2° error is irrelevant
  // against a -6° threshold, and it saves a geodetic round trip.
  const obsEciX = obs.x * cosG - obs.y * sinG;
  const obsEciY = obs.x * sinG + obs.y * cosG;
  const obsEciZ = obs.z;
  const obsLen = Math.hypot(obsEciX, obsEciY, obsEciZ) || 1;
  const sunElevDeg =
    Math.asin(
      Math.max(-1, Math.min(1, (obsEciX * sunX + obsEciY * sunY + obsEciZ * sunZ) / obsLen))
    ) * RAD;
  const observerDark = sunElevDeg < OBSERVER_DARK_SUN_ELEV_DEG;

  // Cheap pre-reject: for a non-negative cutoff, anything with a negative "up"
  // component is below the horizon and can be dropped before the sqrt.
  const cutoffAboveHorizon = minElevationDeg >= 0;

  // --- Hot loop: allocation-free until a satellite actually qualifies ---

  const scenePos: ScenePos = { x: 0, y: 0, z: 0 };
  const wallNowMs = performance.now();

  for (let i = 0; i < satellites.length; i++) {
    const sat = satellites[i];
    if (sat.launchMs > atMs) continue;

    if (getScenePositionCached(sat.satrec, atMs, scenePos, Infinity, wallNowMs) === PROP_FAILED) {
      continue;
    }

    // Scene (three.js, Y up) → ECI km. Inverse of the (x, z, -y) mapping that
    // lib/satellite.ts applies on the way out.
    const eciX = scenePos.x * KM_PER_SCENE_UNIT;
    const eciY = -scenePos.z * KM_PER_SCENE_UNIT;
    const eciZ = scenePos.y * KM_PER_SCENE_UNIT;

    // ECI → ECF: rotate backwards by GMST (Z unchanged).
    const ecfX = eciX * cosG + eciY * sinG;
    const ecfY = -eciX * sinG + eciY * cosG;

    const rx = ecfX - obs.x;
    const ry = ecfY - obs.y;
    const rz = eciZ - obs.z;

    // Topocentric south / east / up, matching satellite.js's ecfToLookAngles.
    const topZ = cosLat * cosLon * rx + cosLat * sinLon * ry + sinLat * rz;
    if (topZ <= 0 && cutoffAboveHorizon) continue; // below the horizon — done

    const topS = sinLat * cosLon * rx + sinLat * sinLon * ry - cosLat * rz;
    const topE = -sinLon * rx + cosLon * ry;

    const rangeKm = Math.sqrt(topS * topS + topE * topE + topZ * topZ);
    if (rangeKm < 1e-6) continue;
    const elevationDeg = Math.asin(topZ / rangeKm) * RAD;
    if (elevationDeg < minElevationDeg) continue;

    // Cylindrical shadow model: project the satellite onto the Sun axis; if it
    // sits behind Earth and within Earth's radius of that axis, it is eclipsed.
    // Good to a few seconds of pass time — finer than anything reported here.
    const along = eciX * sunX + eciY * sunY + eciZ * sunZ;
    let sunlit = along > 0;
    if (!sunlit) {
      const px = eciX - along * sunX;
      const py = eciY - along * sunY;
      const pz = eciZ - along * sunZ;
      sunlit = px * px + py * py + pz * pz > EARTH_RADIUS_KM * EARTH_RADIUS_KM;
    }

    // Phase angle at the satellite, between the Sun and the observer. Both
    // directions are unit vectors: the Sun is ~1 AU away so its direction from
    // the satellite and from Earth's center are the same to well under a
    // degree.
    const cosPhase = (-rx * sunX - ry * sunY - rz * sunZ) / rangeKm;
    const standardMag = STANDARD_MAGNITUDE[sat.category] ?? DEFAULT_STANDARD_MAGNITUDE;
    const magnitudeProxy =
      apparentMagnitude(standardMag, rangeKm, cosPhase) + (sunlit ? 0 : ECLIPSE_MAG_PENALTY);

    results.push({
      sat,
      azimuthDeg: ((Math.atan2(-topE, topS) * RAD + 180) % 360 + 360) % 360,
      elevationDeg,
      rangeKm,
      visible: sunlit && observerDark,
      magnitudeProxy,
      sunlit,
      observerDark,
    });
  }

  results.sort((a, b) => b.elevationDeg - a.elevationDeg);
  return results.length > maxResults ? results.slice(0, maxResults) : results;
}

// ---------------------------------------------------------------------------
// Dome projection
// ---------------------------------------------------------------------------

/**
 * Sky dome → unit disc, for a radar / planisphere plot.
 *
 * Convention: **zenith at (0, 0), horizon on the unit circle, +y = NORTH,
 * +x = EAST.** That is the map-maker's convention (looking DOWN on the dome).
 * A naked-eye chart — held overhead, looking UP — has east on the left, so a
 * UI that wants that view should negate x. Rotating the pair by -θ turns the
 * chart to any other heading (e.g. θ = device compass heading for an
 * "up is where I'm facing" view).
 *
 * The radial law is equidistant (azimuthal equidistant): r = (90 - el) / 90,
 * so elevation maps linearly to radius. True stereographic projection is
 * conformal but crowds everything toward the rim, where satellites spend most
 * of a pass; equidistant keeps elevation rings evenly spaced and readable,
 * which is what a sky chart is for. Elevation is clamped to [-90, 90], so
 * below-horizon inputs (allowed by a negative minElevationDeg) land outside
 * the unit circle rather than folding back over it.
 */
export function projectToDome(azimuthDeg: number, elevationDeg: number): { x: number; y: number } {
  const el = elevationDeg < -90 ? -90 : elevationDeg > 90 ? 90 : elevationDeg;
  const r = (90 - el) / 90;
  const az = azimuthDeg * DEG;
  return { x: r * Math.sin(az), y: r * Math.cos(az) };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * One-line explanation of why a sighting is (or is not) worth looking up for.
 *
 * 'Sunlit' rather than 'Naked-eye visible' means the geometry is right — lit
 * object, dark sky — but the object is too faint for the unaided eye by the
 * crude brightness proxy. `visible` itself stays purely geometric so the flag
 * never hides a real pass on the strength of a guessed magnitude.
 */
export function visibilityLabel(s: SkySighting): string {
  if (!s.observerDark) return 'Daylight';
  if (!s.sunlit) return 'In shadow';
  return s.magnitudeProxy <= NAKED_EYE_MAG_LIMIT ? 'Naked-eye visible' : 'Sunlit';
}
