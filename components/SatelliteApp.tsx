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

const EARTH_TEXTURES = [
  '/textures/earth_day.jpg',
  '/textures/earth_night.jpg',
  '/textures/earth_specular.jpg',
  '/api/clouds', // live global cloud cover (real EUMETSAT-derived data)
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

export function SatelliteApp() {
  const [satellites, setSatellites] = useState<SatData[]>([]);
  const [selectedSat, setSelectedSat] = useState<SatData | null>(null);
  const [selectedSolarSat, setSelectedSolarSat] = useState<SolarSat | null>(null);
  const [selectedBody, setSelectedBody] = useState<SelectedBody | null>(null);
  const [viewMode, setViewMode] = useState<'earth' | 'solar'>('earth');
  const [isFocused, setIsFocused] = useState(false);

  // Startup: everything (TLE data + textures) is loaded and cached BEFORE the
  // app is revealed. `ready` flips once, then the splash fades out.
  const [loadState, setLoadState] = useState<LoadState>({ phase: 'Initializing', done: 0, total: 1 });
  const [ready, setReady] = useState(false);
  const [splashGone, setSplashGone] = useState(false);
  // Escape hatch shown only after repeated catalog download failures.
  const [showOfflineOption, setShowOfflineOption] = useState(false);
  const offlineRequestedRef = useRef(false);

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

  // ----- Startup preload: data + textures, then reveal -----
  useEffect(() => {
    let cancelled = false;
    const textureUrls = [...EARTH_TEXTURES, ...PLANETS.map((p) => p.textureUrl), SUN_TEXTURE_URL];
    // The catalog download dominates startup time, so it owns most of the bar.
    const CATALOG_WEIGHT = 7;
    const totalSteps = CATALOG_WEIGHT + textureUrls.length;
    // The first bump() (fired when the catalog completes) lands on CATALOG_WEIGHT.
    let doneSteps = CATALOG_WEIGHT - 1;
    const bump = (phase: string) => {
      doneSteps++;
      if (!cancelled) setLoadState({ phase, done: doneSteps, total: totalSteps });
    };

    async function boot() {
      // 1. Full satellite catalog — the app does NOT start until it is loaded.
      // The server aggregates ~25k objects (can take a minute on first run);
      // live progress is polled from /api/tle/status. On failure the download
      // is retried indefinitely; after two failed attempts an explicit
      // "continue offline" escape hatch appears on the splash screen.
      let sats: SatData[] = [];
      for (let attempt = 1; !cancelled; attempt++) {
        setLoadState({
          phase: attempt === 1
            ? 'Downloading satellite catalog'
            : `Downloading satellite catalog (attempt ${attempt})`,
          done: 0,
          total: totalSteps,
        });

        const poll = setInterval(async () => {
          try {
            const r = await fetch('/api/tle/status');
            const p = await r.json();
            if (!cancelled && p.phase === 'catalog' && p.total > 0) {
              setLoadState({
                phase: `Downloading satellite catalog — ${p.done.toLocaleString()} / ${p.total.toLocaleString()} objects`,
                done: Math.min(CATALOG_WEIGHT * 0.99, (p.done / p.total) * CATALOG_WEIGHT),
                total: totalSteps,
              });
            }
          } catch { /* status endpoint is best-effort */ }
        }, 700);

        try {
          const res = await fetch('/api/tle?group=active', { signal: AbortSignal.timeout(600000) });
          if (res.ok) sats = parseTLE(await res.text());
        } catch { /* retried below */ }
        clearInterval(poll);
        if (cancelled) return;

        // A real full sky is ~16k objects; below 8k it's a partial/degraded
        // response — keep retrying (offline escape hatch appears after 2 tries).
        if (sats.length >= 8000) break;
        if (offlineRequestedRef.current) {
          if (sats.length === 0) {
            try { sats = parseTLE(FALLBACK_TLE); } catch { /* keep empty list */ }
          }
          break;
        }
        if (attempt >= 2) setShowOfflineOption(true);
        // Responsive wait between attempts (reacts to the offline button)
        for (let w = 0; w < 16 && !cancelled && !offlineRequestedRef.current; w++) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (cancelled) return;
      setShowOfflineOption(false);
      setSatellites(sats);
      bump('Caching textures');

      // 2. All textures for both views + the 3D engine bundle, in parallel —
      // by the time the splash clears, nothing is left to download.
      await Promise.all([
        ...textureUrls.map((url) => preloadImage(url).then(() => bump('Caching textures'))),
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
  }, []);

  // If startup could only get a partial dataset (degraded source tier or the
  // bundled fallback), keep retrying the full catalog in the background and
  // hot-swap it in the moment it arrives — the full fleet appears without a
  // reload.
  const FULL_CATALOG_MIN = 12000;
  const satCountRef = useRef(0);
  useEffect(() => { satCountRef.current = satellites.length; }, [satellites]);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 12 && !cancelled; attempt++) {
        if (satCountRef.current >= FULL_CATALOG_MIN) return; // full catalog already loaded
        await new Promise((r) => setTimeout(r, attempt === 0 ? 8000 : 60000));
        if (cancelled || satCountRef.current >= FULL_CATALOG_MIN) return;
        try {
          const res = await fetch('/api/tle?group=active', { signal: AbortSignal.timeout(600000) });
          if (!res.ok) continue;
          const sats = parseTLE(await res.text());
          if (sats.length > satCountRef.current * 1.5 && !cancelled) {
            setSatellites(sats);
            if (sats.length >= FULL_CATALOG_MIN) return;
          }
        } catch { /* retry on the next pass */ }
      }
    })();
    return () => { cancelled = true; };
  }, [ready]);

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
      {/* ---- Startup splash: shown until every resource is cached ---- */}
      {!splashGone && (
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
          {showOfflineOption && (
            <button
              onClick={() => { offlineRequestedRef.current = true; setShowOfflineOption(false); }}
              className="mt-6 mx-6 text-center text-[11px] font-mono text-yellow-400/90 border border-yellow-400/40 rounded px-3 py-1.5 hover:bg-yellow-400/10 transition-colors"
            >
              Sources unreachable — continue with offline dataset (~100 satellites)
            </button>
          )}
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
