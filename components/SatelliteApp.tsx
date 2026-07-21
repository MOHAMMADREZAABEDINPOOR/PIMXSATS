'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { parseTLE, SatData, OrbitBand } from '@/lib/satellite';
import { SolarSat, SelectedBody, PLANETS, SUN_TEXTURE_URL } from '@/lib/solar-system';
import {
  EarthSettings, SolarSettings,
  DEFAULT_EARTH_SETTINGS, DEFAULT_SOLAR_SETTINGS,
} from '@/lib/settings';
import { FALLBACK_TLE } from '@/lib/fallback-tle';
import dynamic from 'next/dynamic';
import { UIOverlay } from './UIOverlay';

const TrackerCanvas = dynamic(
  () => import('./TrackerCanvas').then((mod) => ({ default: mod.TrackerCanvas })),
  { ssr: false, loading: () => null }
);

// All bundled with the site — no runtime download. The live cloud layer
// (/api/clouds) is intentionally NOT here: it upgrades in the background
// inside Earth.tsx and must never gate startup.
const EARTH_TEXTURES = [
  '/textures/earth_day.jpg',
  '/textures/earth_night.jpg',
  '/textures/earth_specular.jpg',
  '/textures/earth_clouds.png',
];

/** Fetch-and-cache one image; resolves even on failure so a single slow CDN
 *  asset can't block startup (three.js will hit the warm HTTP cache later). */
function preloadImage(url: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
    setTimeout(resolve, 15000); // hard cap per asset
  });
}

interface LoadState {
  phase: string;
  done: number;
  total: number;
}

// The full satellite catalog ships WITH the site as a static asset
// (public/tle-snapshot.txt, refreshed at every build). It is served from the
// site's own CDN and cached by the service worker, so a browser downloads it
// at most once and never waits on slow third-party TLE APIs at runtime.
const SNAPSHOT_URL = '/tle-snapshot.txt';
const MIN_SNAPSHOT_SATS = 1000;

export function SatelliteApp() {
  const [satellites, setSatellites] = useState<SatData[]>([]);
  const [selectedSat, setSelectedSat] = useState<SatData | null>(null);
  const [selectedSolarSat, setSelectedSolarSat] = useState<SolarSat | null>(null);
  const [selectedBody, setSelectedBody] = useState<SelectedBody | null>(null);
  const [viewMode, setViewMode] = useState<'earth' | 'solar'>('earth');
  const [isFocused, setIsFocused] = useState(false);

  // Startup: the bundled catalog + core textures are cached BEFORE the app is
  // revealed. Because the catalog is a local static asset this is fast — no
  // waiting on external downloads. `ready` flips once, then the splash fades.
  const [loadState, setLoadState] = useState<LoadState>({ phase: 'Initializing', done: 0, total: 1 });
  const [ready, setReady] = useState(false);
  const [splashGone, setSplashGone] = useState(false);
  // Shown only when the network is too weak to fetch even the bundled catalog.
  const [connectionError, setConnectionError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  // Fully independent settings per view — changing one never touches the other.
  const [earthSettings, setEarthSettings] = useState<EarthSettings>(DEFAULT_EARTH_SETTINGS);
  const [solarSettings, setSolarSettings] = useState<SolarSettings>(DEFAULT_SOLAR_SETTINGS);

  // Earth-view data filters
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedBands, setSelectedBands] = useState<OrbitBand[]>([]);

  // Mutable simulated clock consumed by the render loops (no React churn).
  // Starts at real astronomical time.
  const simulatedTimeRef = useRef<Date>(new Date());

  // Active view's clock parameters, mirrored into refs for the rAF loop.
  const activeSpeedRef = useRef(1);
  const activeMovementRef = useRef(true);
  const activeRealTimeRef = useRef(true);
  const activeSettings = viewMode === 'earth' ? earthSettings : solarSettings;
  useEffect(() => {
    activeSpeedRef.current = activeSettings.timeSpeed;
    activeMovementRef.current = activeSettings.enableMovement;
    activeRealTimeRef.current = activeSettings.realTime;
    if (activeSettings.realTime) {
      simulatedTimeRef.current = new Date();
    }
  }, [activeSettings.timeSpeed, activeSettings.enableMovement, activeSettings.realTime]);

  // ----- Startup preload: bundled data + core textures, then reveal -----
  useEffect(() => {
    let cancelled = false;
    // Only the Earth-view essentials gate startup; the solar-system textures
    // are warmed in the background so the first paint isn't held up by them.
    const criticalTextures = EARTH_TEXTURES;
    const bgTextures = [...PLANETS.map((p) => p.textureUrl), SUN_TEXTURE_URL];
    // Catalog parse gets the first chunk of the bar; the rest is textures.
    const CATALOG_WEIGHT = 4;
    const totalSteps = CATALOG_WEIGHT + criticalTextures.length;
    let doneSteps = CATALOG_WEIGHT;
    const bump = (phase: string) => {
      doneSteps++;
      if (!cancelled) setLoadState({ phase, done: doneSteps, total: totalSteps });
    };

    async function boot() {
      setConnectionError(false);
      setLoadState({ phase: 'Loading satellite catalog', done: 0, total: totalSteps });

      // 1. Full satellite catalog — bundled with the site as a static asset,
      // so it comes off the CDN / service-worker cache in one quick request.
      // No polling, no attempt loop, no external API on the critical path.
      let sats: SatData[] = [];
      try {
        const res = await fetch(SNAPSHOT_URL, { signal: AbortSignal.timeout(30000) });
        if (res.ok) sats = parseTLE(await res.text());
      } catch { /* handled by the connection-error branch below */ }
      if (cancelled) return;

      // If the bundled catalog couldn't be read at all, the network is down or
      // too weak — show the styled connection-error screen and stop here. The
      // built-in mini fallback is used only as a last resort so the globe is
      // never completely empty once the user chooses to continue.
      if (sats.length < MIN_SNAPSHOT_SATS) {
        try {
          const fb = parseTLE(FALLBACK_TLE);
          if (fb.length > sats.length) sats = fb;
        } catch { /* keep whatever parsed */ }
        if (sats.length === 0) {
          setConnectionError(true);
          return;
        }
      }

      setLoadState({ phase: 'Preparing textures', done: CATALOG_WEIGHT, total: totalSteps });
      setSatellites(sats);

      // 2. Core Earth textures + the 3D engine bundle, in parallel. Solar-view
      // textures are warmed in the background (not awaited) so they're already
      // cached by the time the user switches views, without delaying startup.
      bgTextures.forEach((url) => { void preloadImage(url); });
      await Promise.all([
        ...criticalTextures.map((url) => preloadImage(url).then(() => bump('Caching textures'))),
        import('./TrackerCanvas').catch(() => undefined),
      ]);

      if (!cancelled) {
        setLoadState({ phase: 'Ready', done: totalSteps, total: totalSteps });
        simulatedTimeRef.current = new Date(); // launch at real time
        setReady(true);
        setTimeout(() => { if (!cancelled) setSplashGone(true); }, 600);
      }
    }

    boot();
    return () => { cancelled = true; };
  }, [retryNonce]);

  // Continuous simulated-time integration (delta-time based).
  useEffect(() => {
    let lastTime = performance.now();
    let frameId: number;

    const tick = (now: number) => {
      const deltaSeconds = (now - lastTime) / 1000;
      lastTime = now;
      if (activeRealTimeRef.current) {
        // Real Time mode: hard-locked to the wall clock — no drift ever.
        simulatedTimeRef.current = new Date();
      } else if (activeMovementRef.current) {
        simulatedTimeRef.current = new Date(
          simulatedTimeRef.current.getTime() + deltaSeconds * 1000 * activeSpeedRef.current
        );
      }
      frameId = requestAnimationFrame(tick);
    };

    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, []);

  // ----- Time travel API (leaves Real Time mode for the active view) -----
  const leaveRealTime = useCallback(() => {
    if (viewMode === 'earth') setEarthSettings((s) => (s.realTime ? { ...s, realTime: false } : s));
    else setSolarSettings((s) => (s.realTime ? { ...s, realTime: false } : s));
  }, [viewMode]);

  const setSimulatedTime = useCallback((date: Date) => {
    leaveRealTime();
    activeRealTimeRef.current = false;
    simulatedTimeRef.current = new Date(date);
  }, [leaveRealTime]);

  const jumpSimulatedTime = useCallback((deltaMs: number) => {
    leaveRealTime();
    activeRealTimeRef.current = false;
    simulatedTimeRef.current = new Date(simulatedTimeRef.current.getTime() + deltaMs);
  }, [leaveRealTime]);

  const resetSimulatedTime = useCallback(() => {
    // NOW = back to Real Time mode for the active view
    simulatedTimeRef.current = new Date();
    if (viewMode === 'earth') setEarthSettings((s) => ({ ...s, realTime: true, timeSpeed: 1 }));
    else setSolarSettings((s) => ({ ...s, realTime: true, timeSpeed: 1 }));
  }, [viewMode]);

  // LEVEL VIEW: each press bumps a nonce; the camera rig watches it and
  // glides the Earth view back to an upright equatorial pose.
  const [resetViewNonce, setResetViewNonce] = useState(0);
  const requestResetView = useCallback(() => setResetViewNonce((n) => n + 1), []);

  const handleSelectSat = useCallback((sat: SatData | null) => {
    setSelectedSat(sat);
    if (sat) { setSelectedSolarSat(null); setSelectedBody(null); }
    setIsFocused(false);
  }, []);

  const handleSelectSolarSat = useCallback((sat: SolarSat | null) => {
    setSelectedSolarSat(sat);
    if (sat) { setSelectedSat(null); setSelectedBody(null); }
    setIsFocused(false);
  }, []);

  const handleSelectBody = useCallback((body: SelectedBody | null) => {
    setSelectedBody(body);
    if (body) { setSelectedSat(null); setSelectedSolarSat(null); }
    setIsFocused(false);
  }, []);

  // ----- Time-aware catalog -----
  // When the simulated clock is moved to a historical date, the catalog (and
  // everything derived from it: table counts, categories, search, the 3D
  // swarm) only contains satellites already launched at that time. The sim
  // clock lives in a ref, so it is sampled on a slow interval and React state
  // changes ONLY when the launched set actually changes (launch dates have
  // year granularity, so this fires when crossing a year boundary, not 4×/s).
  const sortedLaunchMs = useMemo(() => {
    const arr = satellites.map((s) => s.launchMs);
    arr.sort((a, b) => a - b);
    return arr;
  }, [satellites]);

  // MAX_SAFE_INTEGER = "everything launched" sentinel → zero filtering cost
  // and unchanged array identity in the (default) real-time case.
  const [launchCutoffMs, setLaunchCutoffMs] = useState(Number.MAX_SAFE_INTEGER);

  useEffect(() => {
    if (sortedLaunchMs.length === 0) return;
    const update = () => {
      const t = simulatedTimeRef.current.getTime();
      // Upper bound: number of satellites with launchMs <= t
      let lo = 0;
      let hi = sortedLaunchMs.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedLaunchMs[mid] <= t) lo = mid + 1;
        else hi = mid;
      }
      const cutoff =
        lo === sortedLaunchMs.length
          ? Number.MAX_SAFE_INTEGER
          : lo > 0
            ? sortedLaunchMs[lo - 1]
            : -1; // before the first launch → empty sky
      setLaunchCutoffMs((prev) => (prev === cutoff ? prev : cutoff));
    };
    update();
    const id = setInterval(update, 500);
    return () => clearInterval(id);
  }, [sortedLaunchMs]);

  const eraSatellites = useMemo(() => {
    if (launchCutoffMs === Number.MAX_SAFE_INTEGER) return satellites;
    return satellites.filter((sat) => sat.launchMs <= launchCutoffMs);
  }, [satellites, launchCutoffMs]);

  // Earth satellites after category / orbit-band filtering
  const displayedSatellites = useMemo(() => {
    if (selectedCategories.length === 0 && selectedBands.length === 0) return eraSatellites;
    return eraSatellites.filter(
      (sat) =>
        (selectedCategories.length === 0 || selectedCategories.includes(sat.category)) &&
        (selectedBands.length === 0 || selectedBands.includes(sat.band))
    );
  }, [eraSatellites, selectedCategories, selectedBands]);

  return (
    <>
      {/* ---- Weak-connection error screen (styled, with retry) ---- */}
      {connectionError && !ready && (
        <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-[#010204] px-6 text-center">
          <div className="text-5xl mb-6" aria-hidden>📡</div>
          <div className="text-2xl font-bold font-mono tracking-[0.3em] mb-2 text-shimmer">
            PIMX<span>SATS</span>
          </div>
          <div className="text-sm font-mono text-red-400/90 uppercase tracking-widest mb-4">
            Connection problem
          </div>
          <p className="text-xs font-mono text-gray-400 max-w-sm leading-relaxed mb-8">
            Your internet connection appears to be weak or offline, so the tracker
            couldn&apos;t load. Check your connection and try again — once loaded,
            PIMXSATS is cached on this device and starts instantly next time.
          </p>
          <button
            onClick={() => setRetryNonce((n) => n + 1)}
            className="text-xs font-mono text-cyan-300 border border-cyan-400/40 rounded px-6 py-2 hover:bg-cyan-400/10 transition-colors uppercase tracking-widest"
          >
            Retry
          </button>
        </div>
      )}

      {/* ---- Startup splash: shown briefly while local assets are cached ---- */}
      {!splashGone && !connectionError && (
        <div
          className={`fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#010204] transition-opacity duration-500 ${
            ready ? 'opacity-0 pointer-events-none' : 'opacity-100'
          }`}
        >
          <div className="orbit-spinner mb-8" />
          <div className="text-3xl font-bold font-mono tracking-[0.3em] mb-1 text-shimmer animate-fade-up">
            PIMX<span>SATS</span>
          </div>
          <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mb-8 animate-fade-up">
            Satellite &amp; Solar System Tracker
          </div>
          <div className="w-64 h-1 bg-white/10 rounded-full overflow-hidden mb-3">
            <div
              className="h-full rounded-full transition-all duration-300 progress-glow"
              style={{ width: `${Math.round((loadState.done / loadState.total) * 100)}%` }}
            />
          </div>
          <div className="text-xs font-mono text-gray-400 px-6 text-center max-w-md" aria-live="polite">
            {loadState.phase}… {Math.round((loadState.done / loadState.total) * 100)}%
          </div>
        </div>
      )}

      {/* ---- App (mounted only when fully preloaded) ---- */}
      {ready && (
        <>
          <UIOverlay
            satellites={eraSatellites}
            selectedSat={selectedSat}
            onSelectSat={handleSelectSat}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            selectedSolarSat={selectedSolarSat}
            onSelectSolarSat={handleSelectSolarSat}
            selectedBody={selectedBody}
            onSelectBody={handleSelectBody}
            simulatedTimeRef={simulatedTimeRef}
            isLoading={false}
            earthSettings={earthSettings}
            onEarthSettingsChange={setEarthSettings}
            solarSettings={solarSettings}
            onSolarSettingsChange={setSolarSettings}
            isFocused={isFocused}
            onIsFocusedChange={setIsFocused}
            selectedCategories={selectedCategories}
            onSelectedCategoriesChange={setSelectedCategories}
            selectedBands={selectedBands}
            onSelectedBandsChange={setSelectedBands}
            onSetSimulatedTime={setSimulatedTime}
            onJumpSimulatedTime={jumpSimulatedTime}
            onResetSimulatedTime={resetSimulatedTime}
            onResetView={requestResetView}
          />
          <div className="w-full h-dvh relative bg-[#010204]">
            <TrackerCanvas
              satellites={displayedSatellites}
              selectedSat={selectedSat}
              onSelectSat={handleSelectSat}
              viewMode={viewMode}
              selectedSolarSat={selectedSolarSat}
              onSelectSolarSat={handleSelectSolarSat}
              selectedBody={selectedBody}
              onSelectBody={handleSelectBody}
              simulatedTimeRef={simulatedTimeRef}
              earthSettings={earthSettings}
              solarSettings={solarSettings}
              isFocused={isFocused}
              resetViewNonce={resetViewNonce}
            />
          </div>
        </>
      )}
    </>
  );
}
