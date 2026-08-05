'use client';

// Ground track: the classic 2D flat-map view of where a satellite actually
// passes over the planet — the sinusoid every mission-control room has on the
// wall — drawn straight over the equirectangular Earth texture the 3D globe
// already uses, so nothing extra is downloaded.
//
// Everything is plotted in an SVG whose user units ARE degrees: the viewBox is
// 360 × 180, x = lon + 180, y = 90 - lat. That makes every projection in here
// a one-liner and keeps the overlay pixel-independent.

import { useMemo } from 'react';
import * as satellite from 'satellite.js';
import { SatData } from '@/lib/satellite';
import { getSunEciDirection } from '@/lib/astronomy';

const MAP_URL = '/textures/earth_day.jpg';
// Samples per plotted orbit. 220 left a measurable ~1.6 deg turn between
// segments at the high-latitude apex, which is where the sinusoid bends hardest
// and where faceting reads as a kink in the line. 400 halves that to ~0.86 deg
// for one extra rebuild's worth of SGP4 every 20 s.
const TRACK_SAMPLES = 400;
/** Fraction of the plotted period that lies in the past. */
const TRACK_LOOKBACK = 0.25;
/** How often the sinusoid itself is re-propagated. One rebuild is ~220 SGP4
 *  calls; the curve is visually identical from one bucket to the next, so this
 *  only needs to be short enough that the window does not visibly slide. */
const TRACK_REBUILD_MS = 20000;
const EARTH_RADIUS_KM = 6371;

interface LonLat {
  lon: number;
  lat: number;
}

const projectX = (lon: number) => lon + 180;
const projectY = (lat: number) => 90 - lat;

/** Split a lon/lat sequence wherever it crosses the antimeridian, so the flat
 *  map doesn't get a spurious horizontal streak across the whole world.
 *
 *  A crossing produces TWO boundary points, not one: the run being closed ends
 *  on the meridian the track left through, and the next run starts on the
 *  OPPOSITE meridian, where it re-enters the map. The previous version reused
 *  the exit longitude for both, so every new run opened on the wrong side of
 *  the world and its first segment shot all the way back across the map — the
 *  stray straight line through the middle of the track. */
function splitAtDateline(points: LonLat[]): LonLat[][] {
  const runs: LonLat[][] = [];
  let run: LonLat[] = [];
  const flush = () => {
    if (run.length > 1) runs.push(run);
    run = [];
  };
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    if (i > 0) {
      const prev = points[i - 1];
      const d = cur.lon - prev.lon;
      // A dateline crossing means |d| > 180 (the short way around the world).
      if (Math.abs(d) > 180) {
        // d < 0 means the longitude jumped from ~+180 down to ~−180: the track
        // was travelling EAST and left through the +180 meridian.
        const exitLon = d < 0 ? 180 : -180;
        // Fraction of the step (measured the short way, through the meridian)
        // that lies before the crossing.
        const shortSpan = 360 - Math.abs(d);
        const t = shortSpan > 1e-9 ? Math.abs(exitLon - prev.lon) / shortSpan : 0;
        const lat = prev.lat + t * (cur.lat - prev.lat);
        run.push({ lon: exitLon, lat });
        flush();
        run.push({ lon: -exitLon, lat });
      }
    }
    run.push(cur);
  }
  flush();
  return runs;
}

function toPath(run: LonLat[]): string {
  return run
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${projectX(p.lon).toFixed(2)} ${projectY(p.lat).toFixed(2)}`)
    .join(' ');
}

// -- Polar densification -----------------------------------------------------
//
// On an equirectangular map, longitude converges at the poles: the SAME ground
// distance spans 1° of longitude at the equator and ~60° at 89°. A near-polar
// satellite (i ≈ 90°, and the catalog is full of them) therefore swings tens —
// occasionally almost 180 — degrees of longitude between two adjacent samples,
// and a straight segment between them is drawn as a long horizontal streak
// across the high latitudes. That is the "deviation" that is so obvious over
// the poles: the samples are right, the straight line between them is not.
//
// Adding more SGP4 samples everywhere would be the expensive fix. Instead the
// few segments that actually turn fast are subdivided along the true GREAT
// CIRCLE joining their endpoints (slerp on unit vectors) — the real path over
// that 13-second arc to well under a pixel, at a handful of flops per inserted
// point and zero extra propagation. Segments that turn slowly, i.e. nearly all
// of them, are passed through untouched.
const DEG = Math.PI / 180;
/** Longitude swing (deg) above which a segment is subdivided. */
const DENSIFY_STEP_DEG = 4;
/** Cap on inserted points per segment — bounds the cost at the pole itself,
 *  where the swing approaches 180° and the true path is a spike. */
const DENSIFY_MAX = 64;

function toVec(p: LonLat): [number, number, number] {
  const la = p.lat * DEG;
  const lo = p.lon * DEG;
  const c = Math.cos(la);
  return [c * Math.cos(lo), c * Math.sin(lo), Math.sin(la)];
}

type TimedPoint = LonLat & { ms: number };

function densifyTrack(points: TimedPoint[]): TimedPoint[] {
  const out: TimedPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    out.push(a);
    const b = points[i + 1];
    if (!b) break;

    // Shortest-way longitude swing: the dateline is a coordinate seam, not a
    // fast turn, so it must not by itself trigger subdivision.
    let d = b.lon - a.lon;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    const swing = Math.abs(d);
    if (swing <= DENSIFY_STEP_DEG) continue;

    const n = Math.min(DENSIFY_MAX, Math.ceil(swing / DENSIFY_STEP_DEG));
    const va = toVec(a);
    const vb = toVec(b);
    const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
    const omega = Math.acos(dot);
    // Antipodal or coincident endpoints have no unique great circle; leave the
    // straight segment rather than inventing one.
    if (!(omega > 1e-9) || omega > Math.PI - 1e-6) continue;
    const sinO = Math.sin(omega);

    for (let k = 1; k < n; k++) {
      const t = k / n;
      const s0 = Math.sin((1 - t) * omega) / sinO;
      const s1 = Math.sin(t * omega) / sinO;
      const x = va[0] * s0 + vb[0] * s1;
      const y = va[1] * s0 + vb[1] * s1;
      const z = va[2] * s0 + vb[2] * s1;
      out.push({
        lat: Math.asin(Math.max(-1, Math.min(1, z))) / DEG,
        lon: Math.atan2(y, x) / DEG,
        ms: a.ms + t * (b.ms - a.ms),
      });
    }
  }
  return out;
}

/** Sub-satellite point at `date`, or null if SGP4 has nothing sane. */
function subPoint(satrec: satellite.SatRec, date: Date): (LonLat & { altKm: number }) | null {
  let pv: satellite.PositionAndVelocity;
  try {
    pv = satellite.propagate(satrec, date);
  } catch {
    return null;
  }
  const eci = pv.position as satellite.EciVec3<number>;
  if (!eci || typeof eci === 'boolean' || !isFinite(eci.x)) return null;
  const gd = satellite.eciToGeodetic(eci, satellite.gstime(date));
  const lat = satellite.degreesLat(gd.latitude);
  const lon = satellite.degreesLong(gd.longitude);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  return { lat, lon, altKm: gd.height };
}

/** Angular radius of the horizon circle, in radians of great-circle arc. */
function footprintHalfAngle(altKm: number): number {
  return Math.acos(Math.min(1, EARTH_RADIUS_KM / (EARTH_RADIUS_KM + Math.max(altKm, 1))));
}

/**
 * Horizon footprint of a satellite at `altKm` over `centre`.
 *
 * The previous version normalised every ring vertex into −180…180 and then
 * closed each dateline-split run with `Z`, which is what produced the broken
 * circle: a run that leaves through one edge was closed with a straight chord
 * back to its own start instead of continuing on the other side of the map.
 *
 * Instead the ring is built in CONTINUOUS longitude (centre.lon + Δlon, never
 * wrapped), which for any footprint that does not reach a pole is a single
 * smooth closed loop. Drawing that same loop three times, 360° apart, means the
 * piece that runs off one edge is exactly the piece that arrives at the other —
 * the SVG viewport clips the rest. No chords, no stray closing lines.
 *
 * A footprint that swallows a pole cannot be a loop on a flat map at all (its
 * longitude sweep is the full 360°), so that case is closed against the top or
 * bottom edge of the map through the pole it covers.
 */
function footprintGeometry(
  centre: LonLat,
  altKm: number,
  segments = 96
): { d: string; wrapped: boolean } {
  const theta = footprintHalfAngle(altKm);
  const thetaDeg = (theta * 180) / Math.PI;
  const lat0 = (centre.lat * Math.PI) / 180;

  const ring: LonLat[] = [];
  for (let i = 0; i <= segments; i++) {
    const bearing = (i / segments) * 2 * Math.PI;
    const sinLat = Math.sin(lat0) * Math.cos(theta) + Math.cos(lat0) * Math.sin(theta) * Math.cos(bearing);
    const lat = Math.asin(Math.max(-1, Math.min(1, sinLat)));
    const dLon = Math.atan2(
      Math.sin(bearing) * Math.sin(theta) * Math.cos(lat0),
      Math.cos(theta) - Math.sin(lat0) * Math.sin(lat)
    );
    ring.push({ lat: (lat * 180) / Math.PI, lon: centre.lon + (dLon * 180) / Math.PI });
  }

  if (Math.abs(centre.lat) + thetaDeg >= 89.5) {
    const pole = centre.lat >= 0 ? 90 : -90;
    const sweep = ring
      .map((p) => ({ lat: p.lat, lon: ((((p.lon + 180) % 360) + 360) % 360) - 180 }))
      .sort((a, b) => a.lon - b.lon);
    return {
      d: `${toPath(sweep)} L360 ${projectY(pole)} L0 ${projectY(pole)} Z`,
      wrapped: false,
    };
  }

  return { d: `${toPath(ring)} Z`, wrapped: true };
}

/** Night-side polygon for `date`: the terminator curve closed against
 *  whichever pole is currently in darkness. The terminator is drawn with the
 *  SAME longitude→latitude mapping the tracks use (lon range −180…180), so the
 *  day/night boundary and the track cross it at exactly the same place —
 *  previously the terminator was evaluated on 0…360 while the tracks live on
 *  −180…180, which drew the day/night edge up to a degree away from where the
 *  track actually crossed it. */
function nightPath(date: Date): string {
  const sun = getSunEciDirection(date);
  const decl = Math.asin(Math.max(-1, Math.min(1, sun.z)));
  const ra = Math.atan2(sun.y, sun.x);
  const subSolarLon = ((((ra - satellite.gstime(date)) * 180) / Math.PI + 540) % 360) - 180;

  // Near an equinox tan(decl) → 0 and the terminator degenerates into the
  // meridian pair; nudging keeps the closed-form finite without visibly
  // moving the curve.
  const tanDecl = Math.tan(decl) || 1e-6;
  const points: LonLat[] = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const h = ((lon - subSolarLon) * Math.PI) / 180;
    const lat = (Math.atan(-Math.cos(h) / tanDecl) * 180) / Math.PI;
    points.push({ lon, lat });
  }

  // Darkness extends toward the winter pole: north when the Sun is south.
  const nightPole = decl >= 0 ? -90 : 90;
  const body = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${projectX(p.lon).toFixed(2)} ${projectY(p.lat).toFixed(2)}`)
    .join(' ');
  return `${body} L360 ${projectY(nightPole)} L0 ${projectY(nightPole)} Z`;
}

/** Compute the sunset/sunrise terminator crossings of the track for the
 *  current date, so the solid and dashed strokes join EXACTLY on the night
 *  boundary instead of one ending a few samples short of it. The track is
 *  sampled on a time grid; when two consecutive samples straddle the terminator
 *  (one lit, one dark) the crossing time is interpolated and the sub-satellite
 *  point at that moment is returned. */
function terminatorCrossings(
  satrec: satellite.SatRec,
  samples: (LonLat & { ms: number })[],
  date: Date
): (LonLat & { ms: number })[] {
  const crosses: (LonLat & { ms: number })[] = [];
  const sun = getSunEciDirection(date);
  const decl = Math.asin(Math.max(-1, Math.min(1, sun.z)));
  const ra = Math.atan2(sun.y, sun.x);
  const subSolarLon = ((((ra - satellite.gstime(date)) * 180) / Math.PI + 540) % 360) - 180;

  const cosZenithOf = (p: LonLat): number => {
    const h = ((p.lon - subSolarLon) * Math.PI) / 180;
    const lat = (p.lat * Math.PI) / 180;
    return Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(h);
  };

  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const ca = cosZenithOf(a);
    const cb = cosZenithOf(b);
    if ((ca > 0) !== (cb > 0)) {
      const span = b.ms - a.ms;
      if (span > 0) {
        // Linear-root estimate of the terminator crossing between the two
        // samples (ca and cb straddle zero).
        const frac = ca / (ca - cb);
        const cms = a.ms + frac * span;
        // Longitude must be interpolated the SHORT way around the world. When
        // the pair straddles the antimeridian (a.lon ≈ +179, b.lon ≈ −179) the
        // naive lerp walks the long way through 0° and drops the crossing point
        // on the opposite side of the planet — which is exactly the stray line
        // that shot across the middle of the map. Interpolating the wrapped
        // delta and re-normalising keeps it on the meridian it belongs to.
        let dLon = b.lon - a.lon;
        if (dLon > 180) dLon -= 360;
        else if (dLon < -180) dLon += 360;
        const lon = ((((a.lon + frac * dLon) + 180) % 360) + 360) % 360 - 180;
        crosses.push({
          lon,
          lat: a.lat + frac * (b.lat - a.lat),
          ms: cms,
        });
      }
    }
  }
  return crosses;
}

export function GroundTrack({
  sat,
  now,
  observer,
}: {
  sat: SatData;
  /** Simulated time; the caller re-renders this at whatever rate it likes. */
  now: Date;
  observer: { lat: number; lon: number } | null;
}) {
  const nowMs = now.getTime();

  // Two tiers, because the two halves of this picture have completely
  // different accuracy requirements.
  //
  // The SINUSOID is a 220-sample SGP4 sweep. Rebuilding it on every clock tick
  // would be wasteful, and it does not need to be live: the curve a satellite
  // will fly over the next 70 minutes barely differs from the one computed a
  // minute ago — at 60 s of staleness the whole ribbon shifts by well under a
  // pixel of this map.
  //
  // The MARKER is different. It is the thing the eye tracks against the stat
  // tiles next to it, so it is propagated at the caller's tick rate — the old
  // code quantised it into the same 15 s bucket as the track, which parked the
  // dot up to ~110 km behind the live readout. One SGP4 call per tick is
  // nothing; the visible lag was pure bookkeeping.
  const trackBucket = Math.floor(nowMs / TRACK_REBUILD_MS);

  const track = useMemo(() => {
    const anchor = trackBucket * TRACK_REBUILD_MS;
    const periodMin = sat.satrec.no > 0 ? (2 * Math.PI) / sat.satrec.no : 90;
    const periodMs = periodMin * 60000;
    const from = anchor - periodMs * TRACK_LOOKBACK;

    // Samples carry their timestamp so the past/future split can be re-cut
    // against the LIVE clock without re-propagating anything.
    const samples: (LonLat & { ms: number })[] = [];
    const stepDate = new Date(from);
    for (let i = 0; i <= TRACK_SAMPLES; i++) {
      const ms = from + (i / TRACK_SAMPLES) * periodMs;
      stepDate.setTime(ms);
      const p = subPoint(sat.satrec, stepDate);
      if (p) samples.push({ lon: p.lon, lat: p.lat, ms });
    }
    return { samples, periodMin, fromMs: from, spanMs: periodMs };
  }, [sat, trackBucket]);

  const model = useMemo(() => {
    // Every point carries its timestamp so the three sources merged below —
    // the propagated samples, the terminator crossings, and the live marker —
    // can be re-sorted into strict time order before they are drawn. An
    // out-of-order point draws a straight segment leaping back across the whole
    // map: a crossing pushed onto the end of the past stroke, or unshifted onto
    // the front of the future one, is almost never the point temporally next to
    // the join, and that stray leap is the artifact being reported.
    const pastPts: (LonLat & { ms: number })[] = [];
    const futurePts: (LonLat & { ms: number })[] = [];
    for (const s of track.samples) (s.ms <= nowMs ? pastPts : futurePts).push(s);

    const current = subPoint(sat.satrec, now);
    // The live sub-satellite point closes both strokes on the same coordinate,
    // so the dashed past and solid future meet exactly at the marker. It is the
    // end of the past (ms = now) and the start of the future.
    if (current) {
      pastPts.push({ lon: current.lon, lat: current.lat, ms: nowMs });
      futurePts.push({ lon: current.lon, lat: current.lat, ms: nowMs });
    }

    // Terminator crossings, each already tagged with its interpolated time,
    // dropped into whichever half of the track they fall in.
    const crossings = terminatorCrossings(sat.satrec, track.samples, now);
    for (const c of crossings) {
      if (c.ms < track.fromMs || c.ms > track.fromMs + track.spanMs) continue;
      (c.ms <= nowMs ? pastPts : futurePts).push(c);
    }

    pastPts.sort((a, b) => a.ms - b.ms);
    futurePts.sort((a, b) => a.ms - b.ms);

    // Fill in the true great-circle path across any fast-turning segment before
    // the dateline split, so a near-polar pass reads as a smooth arc over the
    // pole instead of a horizontal streak across the top of the map.
    return {
      past: splitAtDateline(densifyTrack(pastPts)),
      future: splitAtDateline(densifyTrack(futurePts)),
      current,
      footprint: current ? footprintGeometry(current, current.altKm) : null,
      night: nightPath(now),
      periodMin: track.periodMin,
    };
  }, [sat, now, nowMs, track]);

  return (
    // A TRUE 2:1 map, because the texture is 2:1 (8192x4096) and both layers
    // draw with non-uniform scaling (`preserveAspectRatio="none"` + `object-fill`).
    // Any other ratio stretches the world: a 2.4/1 box came out 1.30x too tall,
    // which deformed the continents AND exaggerated every bend in the track by
    // ~20%, making a smooth sinusoid look kinked.
    //
    // Width-driven: w-full takes the pane's width (the old code left this auto,
    // so the box collapsed to its legend's width and the map came out tiny), and
    // the height follows from the ratio. max-w-[60vh] caps it against the
    // VIEWPORT height so a short, wide pane (landscape phone) letterboxes and
    // centres rather than overflowing; on desktop it never binds.
    <div className="rounded-xl overflow-hidden border border-white/10 bg-black/40 w-full max-w-[60vh] flex flex-col">
      <div className="relative w-full aspect-[2/1]">
        {/* eslint-disable-next-line @next/next/no-img-element -- a plain
            equirectangular texture already bundled with the site; the Next
            image pipeline would only add a second copy of it. */}
        <img
          src={MAP_URL}
          alt=""
          aria-hidden
          className="absolute inset-0 w-full h-full object-fill opacity-70"
          draggable={false}
        />
        <svg
          viewBox="0 0 360 180"
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full"
          role="img"
          aria-label={`Ground track of ${sat.name}`}
        >
          {/* Night side */}
          <path d={model.night} fill="rgba(2, 6, 18, 0.62)" />

          {/* Graticule */}
          <g stroke="rgba(255,255,255,0.10)" strokeWidth={0.3} fill="none">
            <line x1={0} y1={90} x2={360} y2={90} strokeWidth={0.5} />
            <line x1={180} y1={0} x2={180} y2={180} />
            <line x1={0} y1={46.5} x2={360} y2={46.5} strokeDasharray="2 3" />
            <line x1={0} y1={133.5} x2={360} y2={133.5} strokeDasharray="2 3" />
          </g>

          {/* Footprint — everything with the satellite above its horizon.
              Drawn three times, one map-width apart, so the part of the circle
              that runs off the left/right edge arrives from the other side
              instead of being closed with a chord across the map. The viewport
              clips the two off-screen copies. */}
          {model.footprint &&
            (model.footprint.wrapped ? [-360, 0, 360] : [0]).map((shift) => (
              <g key={`fp-${shift}`} transform={`translate(${shift} 0)`}>
                <path
                  d={model.footprint!.d}
                  fill={sat.color}
                  fillOpacity={0.13}
                  stroke={sat.color}
                  strokeOpacity={0.5}
                  strokeWidth={0.5}
                />
              </g>
            ))}

            {/* Track already flown */}
          {model.past.map((run, i) => (
            <path
              key={`past-${i}`}
              d={toPath(run)}
              fill="none"
              stroke={sat.color}
              strokeOpacity={0.35}
              strokeWidth={0.8}
              strokeDasharray="2 2"
            />
          ))}

          {/* Track ahead */}
          {model.future.map((run, i) => (
            <path
              key={`next-${i}`}
              d={toPath(run)}
              fill="none"
              stroke={sat.color}
              strokeOpacity={0.95}
              strokeWidth={1}
            />
          ))}

          {/* Observer */}
          {observer && (
            <g>
              <circle
                cx={projectX(observer.lon)}
                cy={projectY(observer.lat)}
                r={2.4}
                fill="none"
                stroke="#34d399"
                strokeWidth={0.8}
              />
              <circle cx={projectX(observer.lon)} cy={projectY(observer.lat)} r={0.9} fill="#34d399" />
            </g>
          )}

          {/* Sub-satellite point */}
          {model.current && (
            <g>
              <circle
                cx={projectX(model.current.lon)}
                cy={projectY(model.current.lat)}
                r={3.4}
                fill={sat.color}
                fillOpacity={0.25}
              />
              <circle
                cx={projectX(model.current.lon)}
                cy={projectY(model.current.lat)}
                r={1.5}
                fill="#ffffff"
                stroke={sat.color}
                strokeWidth={0.8}
              />
            </g>
          )}
        </svg>
      </div>

      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[9px] font-mono text-gray-400 border-t border-white/5 shrink-0">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-0.5 rounded-full" style={{ backgroundColor: sat.color }} />
          Ground track
        </span>
        {model.current ? (
          <span className="text-gray-300">
            {Math.abs(model.current.lat).toFixed(2)}° {model.current.lat >= 0 ? 'N' : 'S'},{' '}
            {Math.abs(model.current.lon).toFixed(2)}° {model.current.lon >= 0 ? 'E' : 'W'}
          </span>
        ) : (
          <span>No solution</span>
        )}
        <span>{model.periodMin >= 1 ? `${model.periodMin.toFixed(0)} min orbit` : '—'}</span>
      </div>
    </div>
  );
}
