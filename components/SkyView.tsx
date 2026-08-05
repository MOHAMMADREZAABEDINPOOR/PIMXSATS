'use client';

// Sky View — a live planisphere of everything above the observer right now.
//
// The 3D globe answers "where is this one satellite?"; this answers the
// opposite question — "what can I actually see from where I'm standing?" — by
// projecting every catalog object currently above the horizon onto a
// radar-style dome. Zenith is the centre, the rim is the horizon, and the dot
// positions are real azimuth/elevation, so the chart is what you'd get holding
// the phone up to the sky.
//
// The computation comes from lib/skyview.ts; this component is presentation
// and interaction only. It re-samples the sky on an interval rather than every
// frame — sub-second updates are imperceptible for a chart, and skipping them
// is what keeps a 10,000-object scan from touching the phone's battery.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  computeSky, projectToDome, visibilityLabel, SkySighting,
} from '@/lib/skyview';
import type { SatData } from '@/lib/satellite';
import {
  X, LocateFixed, Eye, EyeOff, RefreshCw, AlertCircle, Navigation,
} from 'lucide-react';

interface Observer {
  lat: number;
  lon: number;
  altKm?: number;
}

interface SkyViewProps {
  satellites: SatData[];
  selectedSat: SatData | null;
  onSelectSat: (sat: SatData | null) => void;
  /** Best-known coordinates; the view can request fresh ones itself. */
  observer: Observer | null;
  simulatedTimeRef: React.MutableRefObject<Date>;
  onClose: () => void;
}

/** How often the WHOLE catalog is re-scanned to refresh the pool of objects
 *  that are (or are about to be) above the horizon. Objects don't enter and
 *  leave the sky faster than this, so a wide sweep at 2 s is plenty. */
const REFRESH_MS = 2000;
/** How often the POOL is re-propagated for drawing. This is what makes the
 *  dots glide instead of stepping: re-running the topocentric maths over ~400
 *  cached objects is cheap enough to do at animation rate, whereas doing it
 *  over the full 16 000-object catalog is not. */
const POOL_REFRESH_MS = 1000 / 30;
/** Draw at most this many dots — matches lib/skyview's own cap. */
const MAX_RESULTS = 400;
/** The wide sweep keeps objects slightly BELOW the horizon in the pool too, so
 *  one rising during the 2 s between sweeps appears smoothly instead of
 *  popping in at the rim. */
const POOL_MIN_ELEVATION_DEG = -8;

type LocateState = 'idle' | 'locating' | 'ok' | 'denied';

export function SkyView({
  satellites, selectedSat, onSelectSat, observer, simulatedTimeRef, onClose,
}: SkyViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // The observer is DERIVED: a fresh geolocation won on demand wins, falling
  // back to whatever the app-level hook already knows. Keeping a local copy in
  // state and syncing it in an effect is exactly the cascading render the lint
  // rule exists to catch — a derived value has neither the extra render nor
  // the race.
  const [selfCoords, setSelfCoords] = useState<Observer | null>(null);
  const coords = selfCoords ?? observer;
  // How far the locate flow has got. 'ok' only describes the flow's own
  // attempts; when the app already has coordinates the header shows them
  // regardless of this state.
  const [locateState, setLocateState] = useState<Exclude<LocateState, 'ok'>>('idle');
  const [onlyVisible, setOnlyVisible] = useState(false);
  const [sightings, setSightings] = useState<SkySighting[]>([]);
  const [hover, setHover] = useState<SkySighting | null>(null);

  // --- Geolocation on demand ------------------------------------------------
  const requestLocation = useCallback(() => {
    if (!('geolocation' in navigator)) { setLocateState('denied'); return; }
    setLocateState('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => setSelfCoords({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      () => setLocateState('denied'),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }, []);

  // Ask once on open if we have nothing — deferred so the effect only
  // subscribes to the browser, and the state change arrives async rather than
  // synchronously inside the effect body.
  useEffect(() => {
    if (coords || locateState !== 'idle') return;
    const id = setTimeout(requestLocation, 0);
    return () => clearTimeout(id);
  }, [coords, locateState, requestLocation]);

  // --- Sky scan -------------------------------------------------------------
  // Two loops, for one reason: smoothness.
  //
  //   sweep — every REFRESH_MS, over the ENTIRE catalog, to decide WHICH
  //     objects are in play. Expensive (16 000 SGP4 propagations), so it runs
  //     rarely, and it keeps objects a little below the horizon so one rising
  //     between sweeps does not pop into existence at the rim.
  //   refresh — every POOL_REFRESH_MS, over the sweep's few hundred survivors
  //     only, to get their CURRENT az/el. Cheap, so it runs at animation rate,
  //     and that is what makes the dots glide. Previously there was only the
  //     2 s loop, so every dot teleported twice a second — the lag the user saw.
  const [pool, setPool] = useState<SatData[]>([]);
  const sightingsRef = useRef<SkySighting[]>([]);
  useEffect(() => {
    sightingsRef.current = sightings;
  }, [sightings]);

  useEffect(() => {
    if (!coords) return;
    let cancelled = false;
    const sweep = () => {
      if (cancelled) return;
      const sky = computeSky(
        satellites,
        { lat: coords.lat, lon: coords.lon, altKm: coords.altKm },
        new Date(simulatedTimeRef.current.getTime()),
        { minElevationDeg: POOL_MIN_ELEVATION_DEG, maxResults: MAX_RESULTS }
      );
      if (!cancelled) setPool(sky.map((s) => s.sat));
    };
    // First sweep is deferred a tick so the effect stays a pure subscription.
    const first = setTimeout(sweep, 0);
    const id = setInterval(sweep, REFRESH_MS);
    return () => { cancelled = true; clearTimeout(first); clearInterval(id); };
  }, [coords, satellites, simulatedTimeRef]);

  useEffect(() => {
    if (!coords || pool.length === 0) return;
    let cancelled = false;
    const refresh = () => {
      if (cancelled) return;
      const sky = computeSky(
        pool,
        { lat: coords.lat, lon: coords.lon, altKm: coords.altKm },
        new Date(simulatedTimeRef.current.getTime()),
        { minElevationDeg: 0, maxResults: MAX_RESULTS }
      );
      if (!cancelled) setSightings(sky);
    };
    const first = setTimeout(refresh, 0);
    const id = setInterval(refresh, POOL_REFRESH_MS);
    return () => { cancelled = true; clearTimeout(first); clearInterval(id); };
  }, [coords, pool, simulatedTimeRef]);

  const shown = useMemo(
    () => (onlyVisible ? sightings.filter((s) => s.visible) : sightings),
    [sightings, onlyVisible]
  );

  const selectedSighting = useMemo(
    () => (selectedSat ? shown.find((s) => s.sat === selectedSat) ?? null : null),
    [shown, selectedSat]
  );

  // --- Drawing --------------------------------------------------------------
  // The draw closure is rebuilt in an effect (never during render) so the rAF
  // loop below can hold one stable ref while the closure captures fresh state.
  const drawRef = useRef<() => void>(() => {});
  useEffect(() => {
    drawRef.current = () => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const cssSize = Math.min(wrap.clientWidth, wrap.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = Math.max(1, Math.floor(cssSize * dpr));
    if (canvas.width !== size || canvas.height !== size) {
      canvas.width = size;
      canvas.height = size;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const R = size / 2;
    ctx.clearRect(0, 0, size, size);

    // --- Dome backdrop ---
    ctx.save();
    ctx.translate(R, R);

    // Sky fill: a hair lighter at the zenith than the rim.
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    grad.addColorStop(0, 'rgba(30, 58, 95, 0.35)');
    grad.addColorStop(1, 'rgba(2, 6, 12, 0.85)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, R - 1, 0, Math.PI * 2);
    ctx.fill();

    // Elevation rings every 30° (the rim is 0°, the centre is 90°).
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.lineWidth = Math.max(1, dpr * 0.6);
    for (const el of [0, 30, 60]) {
      const rr = ((90 - el) / 90) * (R - 1);
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Cardinal spokes + labels. North is up.
    ctx.fillStyle = 'rgba(203, 213, 225, 0.55)';
    ctx.font = `${Math.round(size * 0.035)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cardinals: Array<[string, number]> = [['N', 0], ['E', 90], ['S', 180], ['W', 270]];
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.10)';
    for (const [label, az] of cardinals) {
      const a = (az * Math.PI) / 180;
      const x = Math.sin(a), y = -Math.cos(a);
      ctx.beginPath();
      ctx.moveTo(x * R * 0.06, y * R * 0.06);
      ctx.lineTo(x * R * 0.94, y * R * 0.94);
      ctx.stroke();
      ctx.fillText(label, x * R * 0.99, y * R * 0.99);
    }

    // --- Satellites ---
    const list = shown;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const { x, y } = projectToDome(s.azimuthDeg, s.elevationDeg);
      const px = x * (R - 1);
      const py = -y * (R - 1); // projectToDome's +y is north = up on screen

      // Brighter (lower magnitudeProxy) and higher elevation → bigger dot.
      const mag = Math.max(-3, Math.min(12, s.magnitudeProxy));
      const base = s.visible
        ? size * 0.011
        : size * 0.007;
      const rad = Math.max(dpr * 1.1, base * (1.4 - mag / 14));

      ctx.beginPath();
      ctx.arc(px, py, rad, 0, Math.PI * 2);
      if (s.visible) {
        ctx.fillStyle = s.sat.color;
        ctx.shadowColor = s.sat.color;
        ctx.shadowBlur = rad * 2.2;
      } else {
        ctx.fillStyle = hexWithAlpha(s.sat.color, 0.4);
        ctx.shadowBlur = 0;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // --- Selection ring ---
    if (selectedSighting) {
      const { x, y } = projectToDome(selectedSighting.azimuthDeg, selectedSighting.elevationDeg);
      const px = x * (R - 1);
      const py = -y * (R - 1);
      const rr = size * 0.03 + Math.sin(performance.now() / 300) * dpr;
      ctx.strokeStyle = 'rgba(103, 232, 249, 0.95)';
      ctx.lineWidth = Math.max(1.5, dpr);
      ctx.beginPath();
      ctx.arc(px, py, rr, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
    };
  }, [shown, selectedSighting]);

  // Draw every animation frame. The draw itself is a few hundred filled arcs on
  // a 2D context — cheap — and throttling it to 4 fps (which is what this used
  // to do) is what made the chart look laggy even once the positions were
  // refreshing smoothly.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      drawRef.current();
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // --- Picking --------------------------------------------------------------
  // Nearest dot within a touch-friendly radius wins. Threshold is in CSS px so
  // it scales with the dome size, not the pixel buffer.
  const pickAt = useCallback((clientX: number, clientY: number): SkySighting | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const R = Math.min(rect.width, rect.height) / 2;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const tol = Math.max(22, R * 0.08);
    let best: SkySighting | null = null;
    let bestD = tol;
    for (const s of sightingsRef.current) {
      const { x, y } = projectToDome(s.azimuthDeg, s.elevationDeg);
      const px = cx + x * (R - 1);
      const py = cy - y * (R - 1);
      const d = Math.hypot(px - clientX, py - clientY);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }, []);

  const handleTap = useCallback(
    (e: React.PointerEvent) => {
      const hit = pickAt(e.clientX, e.clientY);
      onSelectSat(hit ? hit.sat : null);
    },
    [pickAt, onSelectSat]
  );

  const handleHover = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      setHover(pickAt(e.clientX, e.clientY));
    },
    [pickAt]
  );

  // --- Render ---------------------------------------------------------------
  const visibleCount = useMemo(() => sightings.filter((s) => s.visible).length, [sightings]);

  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-[#010204]/80 backdrop-blur-sm animate-fade-in pointer-events-auto">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 sm:gap-3 px-2.5 sm:px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Navigation className="w-4 h-4 text-cyan-400 shrink-0" />
          <div className="min-w-0">
            <div className="text-[11px] font-mono font-bold tracking-widest text-white truncate">
              SKY VIEW
            </div>
            <div className="text-[10px] font-mono text-gray-500 truncate">
              {coords
                ? `${coords.lat.toFixed(2)}°, ${coords.lon.toFixed(2)}°`
                : 'locating…'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <button
            onClick={() => setOnlyVisible((v) => !v)}
            title={onlyVisible ? 'Show everything overhead' : 'Show only naked-eye visible'}
            className={`flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-full border text-[10px] font-mono font-bold tracking-widest chip-btn ${
              onlyVisible
                ? 'bg-amber-400/15 border-amber-400/50 text-amber-300'
                : 'bg-black/60 border-white/10 text-gray-300 hover:text-white'
            }`}
          >
            {onlyVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">{onlyVisible ? 'VISIBLE' : 'ALL'}</span>
          </button>
          <button
            onClick={requestLocation}
            title="Re-detect your location"
            className="flex items-center gap-1.5 px-2 sm:px-3 py-1.5 rounded-full bg-black/60 border border-white/10 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:text-white chip-btn"
          >
            {locateState === 'locating'
              ? <RefreshCw className="w-3.5 h-3.5 animate-spin text-cyan-400" />
              : <LocateFixed className="w-3.5 h-3.5 text-cyan-400" />}
          </button>
          <button
            onClick={onClose}
            title="Close Sky View"
            className="flex items-center justify-center w-8 h-8 rounded-full bg-black/60 border border-white/10 text-gray-300 hover:text-white chip-btn"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Dome.
          The dome MUST be a true square: the draw code sizes the pixel buffer
          from `min(clientWidth, clientHeight)` and `pickAt` projects onto a
          circle of radius `min(width, height) / 2` centred in this box. The old
          `h-full max-w-[92vw] aspect-square` gave a square only in landscape —
          in portrait `h-full` won and the box came out tall, so the square
          buffer was stretched by CSS and every dot was drawn a few pixels away
          from where taps were resolved.
          `min(100%, 100cqh)` picks the largest square that fits either way:
          `100cqh` is the section's own content height, which needs
          `container-type: size` on the parent (Tailwind's `@container` only
          gives inline-size). */}
      <div className="relative flex-1 flex items-center justify-center px-2 sm:px-4 pb-2 min-h-0 [container-type:size]">
        <div
          ref={wrapRef}
          className="relative aspect-square w-[min(100%,100cqh)] touch-none"
          onPointerUp={handleTap}
          onPointerMove={handleHover}
        >
          <canvas ref={canvasRef} className="w-full h-full block" />

          {/* Tooltip on hover (desktop) */}
          {hover && (
            <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-black/80 border border-cyan-400/40 text-[10px] font-mono text-cyan-200 whitespace-nowrap">
              {hover.sat.name} · {visibilityLabel(hover)}
            </div>
          )}

          {/* Location prompt / denial overlay: shown only while there are no
              coordinates to draw the sky from. Once any source resolves, this
              is gone — the flow's own state is irrelevant from then on. */}
          {!coords && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4 sm:px-6">
              {locateState === 'denied' ? (
                <>
                  <AlertCircle className="w-8 h-8 text-amber-400 mb-3" />
                  <div className="text-[11px] font-mono text-gray-300 mb-1">Location unavailable</div>
                  <p className="text-[10px] font-mono text-gray-500 max-w-[240px] mb-4">
                    Sky View needs your coordinates to know what&apos;s overhead.
                    Allow location access, then retry.
                  </p>
                  <button
                    onClick={requestLocation}
                    className="flex items-center gap-2 px-4 py-2 rounded-full bg-cyan-600/80 border border-cyan-400/50 text-[10px] font-mono font-bold tracking-widest text-white chip-btn"
                  >
                    <LocateFixed className="w-3.5 h-3.5" /> RETRY
                  </button>
                </>
              ) : (
                <>
                  <RefreshCw className="w-7 h-7 text-cyan-400 animate-spin mb-3" />
                  <div className="text-[11px] font-mono text-gray-400">
                    {locateState === 'locating' ? 'Finding your position…' : 'Locating…'}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer: counts + selected readout */}
      <div className="px-2 sm:px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-center justify-between gap-2 sm:gap-3 rounded-2xl bg-black/60 backdrop-blur-xl border border-white/10 px-3 sm:px-4 py-2.5">
          <div className="text-[10px] font-mono text-gray-400 shrink-0">
            <span className="text-white font-bold">{shown.length}</span> overhead
            {visibleCount > 0 && (
              <> · <span className="text-amber-300 font-bold">{visibleCount}</span> visible</>
            )}
          </div>
          {selectedSighting ? (
            // min-w-0 is what actually lets `truncate` bite inside a flex row —
            // without it a long satellite name pushes the counts off the card.
            <div className="min-w-0 text-[10px] font-mono text-cyan-200 text-right truncate">
              {selectedSighting.sat.name} · az {Math.round(selectedSighting.azimuthDeg)}° · el {Math.round(selectedSighting.elevationDeg)}°
            </div>
          ) : (
            <div className="text-[10px] font-mono text-gray-600">Tap a dot to track it</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** `#rrggbb` + alpha → rgba(), for dimming non-visible dots without a second
 *  colour pass. Falls back to a neutral slate for unexpected colour strings. */
function hexWithAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(148,163,184,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
