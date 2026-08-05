'use client';

import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { parseTLE, SatData, OrbitBand } from '@/lib/satellite';
import { SolarSat, SelectedBody, PLANETS, SUN_TEXTURE_URL } from '@/lib/solar-system';
import {
  EarthSettings, SolarSettings,
  DEFAULT_EARTH_SETTINGS, DEFAULT_SOLAR_SETTINGS,
} from '@/lib/settings';
import { FALLBACK_TLE } from '@/lib/fallback-tle';
import { Sensitivity, defaultSensitivityForDevice } from '@/lib/interaction';
import { TourStop } from '@/lib/tour';
import { downloadPostcard } from '@/lib/postcard';
import { buildShareUrl, parseUrlState, loadPersistedScene, persistScene, loadPersistedFilters, persistFilters, UrlSceneState } from '@/lib/app-state';
import type { CaptureFn } from './TrackerCanvas';import dynamic from 'next/dynamic';
import { UIOverlay } from './UIOverlay';
import { Globe } from 'lucide-react';
import { OrbitalSonification } from './OrbitalSonification';

const TrackerCanvas = dynamic(
  () => import('./TrackerCanvas').then((mod) => ({ default: mod.TrackerCanvas })),
  { ssr: false, loading: () => null }
);

// All bundled with the site — no runtime download.
const EARTH_TEXTURES = [
  '/textures/earth_day.jpg',
  '/textures/earth_night.jpg',
  '/textures/earth_specular.jpg',
  '/textures/earth_clouds.png',
];

/** How long the splash will wait for the live cloud composite before revealing
 *  the globe anyway. The globe is supposed to come up with real weather already
 *  on it, so this step genuinely gates startup — but a third-party origin having
 *  a bad day must not hold the whole site hostage, and Earth.tsx adopts the
 *  composite whenever it does land. */
const CLOUD_DEADLINE_MS = 12000;

/** Resolve after `ms`. Used to put a deadline on a step that is allowed to
 *  finish later, off-screen, rather than to fail. */
const deadline = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

// Gesture sensitivity is a comfort setting, not scene state: it belongs to the
// device, survives reloads, and is deliberately kept out of the per-view
// settings objects so switching views can never reset it.
const SENSITIVITY_KEY = 'pimxsats.sensitivity';

/** URL state parsed once at module level — before React — so the very first
 *  boot can restore the linked scene instead of flashing the default one. */
const INITIAL_URL_STATE: UrlSceneState | null =
  typeof window !== 'undefined' ? parseUrlState(window.location.search) : null;

function readStoredSensitivity(): Sensitivity {
  if (typeof window === 'undefined') return 'standard';
  try {
    const raw = window.localStorage.getItem(SENSITIVITY_KEY);
    if (raw === 'calm' || raw === 'standard' || raw === 'fast') return raw;
  } catch {
    // private mode / storage disabled — the default is perfectly usable
  }
  // Nothing stored: every device opens on Standard. The per-class gain tables in
  // lib/interaction.ts already make Standard mean "standard for THIS device", so
  // there is nothing left for a device-dependent default to fix.
  return defaultSensitivityForDevice();
}

export function SatelliteApp() {
  const [satellites, setSatellites] = useState<SatData[]>([]);
  const [selectedSat, setSelectedSat] = useState<SatData | null>(null);
  const [selectedSolarSat, setSelectedSolarSat] = useState<SolarSat | null>(null);
  const [selectedBody, setSelectedBody] = useState<SelectedBody | null>(null);
  const [sonificationEnabled, setSonificationEnabled] = useState(false);
  // View mode restores from the URL first (a shared link), then from the last
  // session, then defaults to Earth.
  const [viewMode, setViewMode] = useState<'earth' | 'solar'>(
    () => INITIAL_URL_STATE?.view ?? loadPersistedScene()?.view ?? 'earth'
  );
  const [isFocused, setIsFocused] = useState(INITIAL_URL_STATE?.focus ?? false);
  const [comparePicking, setComparePicking] = useState<'A' | 'B' | null>(null);
  const [comparePicked, setComparePicked] = useState<{ side: 'A' | 'B'; sat: SatData } | null>(null);

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
  // Each restores its scene toggles from the last session (but never its clock:
  // a stale warp or a time-travelled date from last Tuesday is a trap, so the
  // clock always starts real-time — unless a shared link pins a date).
  const [earthSettings, setEarthSettings] = useState<EarthSettings>(() => ({
    ...DEFAULT_EARTH_SETTINGS,
    ...(loadPersistedScene()?.earth ?? {}),
    // Clouds are a defining feature of the globe, not an opt-in: a persisted
    // `false` from an earlier session (when the layer defaulted off, or was
    // toggled off once) should not keep suppressing them. Force the default on
    // at load; the user can still turn them off again for the current session.
    showClouds: true,
    // Same reasoning for Run: a session that opens frozen looks broken, and a
    // stale `false` from one experiment last week is not a preference worth
    // restoring. The scene always starts moving.
    enableMovement: true,
    realTime: true,
    timeSpeed: 1,
  }));
  const [solarSettings, setSolarSettings] = useState<SolarSettings>(() => ({
    ...DEFAULT_SOLAR_SETTINGS,
    ...(loadPersistedScene()?.solar ?? {}),
    enableMovement: true,
    realTime: true,
    timeSpeed: 1,
  }));

  // ----- Gesture comfort, cinematic tour, postcard export -----
  // Read from storage during the initial render. Safe against hydration
  // mismatch because nothing that depends on it is rendered until `ready`
  // flips — the server and the first client paint both show only the splash.
  const [sensitivity, setSensitivity] = useState<Sensitivity>(readStoredSensitivity);
  const changeSensitivity = useCallback((next: Sensitivity) => {
    setSensitivity(next);
    try {
      window.localStorage.setItem(SENSITIVITY_KEY, next);
    } catch {
      // not persisting is a nuisance, not a failure — keep the live setting
    }
  }, []);

  const [tourActive, setTourActive] = useState(false);
  const [tourStop, setTourStop] = useState<(TourStop & { index: number; total: number }) | null>(null);
  const captureRef = useRef<CaptureFn | null>(null);

  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (ready) {
      try {
        const hasSeen = window.localStorage.getItem('pimxsats.seenHint');
        if (!hasSeen) {
          const t = setTimeout(() => setShowHint(true), 2500);
          return () => clearTimeout(t);
        }
      } catch {
        // Fallback for private browsing mode
      }
    }
  }, [ready]);

  const dismissHint = useCallback(() => {
    setShowHint(false);
    try {
      window.localStorage.setItem('pimxsats.seenHint', 'true');
    } catch {
      // Ignore storage errors
    }
  }, []);

  // Earth-view data filters, restored from the last session.
  const [selectedCategories, setSelectedCategories] = useState<string[]>(
    () => loadPersistedFilters()?.categories ?? []
  );
  const [selectedBands, setSelectedBands] = useState<OrbitBand[]>(
    () => (loadPersistedFilters()?.bands ?? []) as OrbitBand[]
  );

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
    // Catalog parse gets the first chunk of the bar; then textures, then the
    // live cloud composite (one step, the last one before reveal).
    const CATALOG_WEIGHT = 4;
    const totalSteps = CATALOG_WEIGHT + criticalTextures.length + 1;
    let doneSteps = CATALOG_WEIGHT;
    const bump = (phase: string) => {
      doneSteps++;
      if (!cancelled) setLoadState({ phase, done: doneSteps, total: totalSteps });
    };

    async function boot() {
      setConnectionError(false);
      setLoadState({ phase: 'Loading satellite catalog', done: 0, total: totalSteps });

      // Start the two slowest, most independent things immediately, so their
      // latency overlaps the catalog fetch and parse below instead of queueing
      // behind it:
      //
      //  - the 3D engine chunk (three.js + the r3f scene), and
      //  - the live cloud composite, which is the only asset that comes from
      //    outside this site: a ~7 MB global geostationary-imagery mosaic
      //    proxied by /api/clouds. It is fetched and decoded here, during the
      //    splash, so the globe's first painted frame already carries real
      //    current weather rather than the bundled fallback popping a second
      //    later. lib/clouds keeps the texture, and Earth.tsx reads it straight
      //    out of the module on mount — one download, whoever gets there first.
      const engine = import('./TrackerCanvas').catch(() => undefined);
      const clouds = import('@/lib/clouds')
        .then((m) => m.preloadCloudTexture())
        .then(() => bump('Fetching live cloud cover'))
        .catch(() => undefined);
      // Current space weather. Two kilobytes of JSON from NOAA, and the only
      // reason it is here rather than in the card that shows it: the card used to
      // fetch on mount, so the solar view opened onto a panel that said LINKING
      // for a second or two, every time. Fired and forgotten — it does NOT gate
      // the reveal (see preloadSpaceWeather), it only needs to be first in the
      // queue rather than last.
      void import('@/lib/space-weather')
        .then((m) => m.preloadSpaceWeather())
        .catch(() => undefined);

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

      // 2. Core Earth textures, the engine bundle and the live cloud map, in
      // parallel. Solar-view textures are warmed in the background (not awaited)
      // so they're already cached by the time the user switches views, without
      // delaying startup.
      bgTextures.forEach((url) => { void preloadImage(url); });
      await Promise.all([
        ...criticalTextures.map((url) => preloadImage(url).then(() => bump('Caching textures'))),
        engine,
        // Clouds gate the reveal, but only up to a deadline — see
        // CLOUD_DEADLINE_MS. Losing that race costs nothing except that the
        // first few seconds of globe show the bundled map.
        Promise.race([clouds, deadline(CLOUD_DEADLINE_MS)]),
      ]);

      if (!cancelled) {
        setLoadState({ phase: 'Ready', done: totalSteps, total: totalSteps });
        simulatedTimeRef.current = new Date(); // launch at real time

        // Restore a shared link's scene now that the catalog exists to look
        // objects up in. Runs once per successful boot, before reveal.
        const url = INITIAL_URL_STATE;
        if (url) {
          if (url.time) {
            simulatedTimeRef.current = new Date(url.time);
            const pin = { realTime: false };
            if (url.view === 'earth') setEarthSettings((s) => ({ ...s, ...pin }));
            else setSolarSettings((s) => ({ ...s, ...pin }));
          }
          if (url.sat) {
            const sat = sats.find((s) => s.satrec.satnum === url.sat) ?? null;
            if (sat) setSelectedSat(sat);
          }
          if (url.view === 'solar') {
            if (url.moon && url.planet) {
              const planet = PLANETS.find((p) => p.name === url.planet);
              const moon = planet?.moons.find((m) => m.name === url.moon);
              if (planet && moon) setSelectedBody({ kind: 'moon', planet, moon });
            } else if (url.planet) {
              const planet = PLANETS.find((p) => p.name === url.planet);
              if (planet) setSelectedBody({ kind: 'planet', planet });
            }
          }
        }

        setReady(true);
        setTimeout(() => { if (!cancelled) setSplashGone(true); }, 600);
      }
    }

    boot();
    return () => { cancelled = true; };
  }, [retryNonce]);

  // ----- Session persistence: scene toggles + filters survive a reload -----
  // Debounced so a burst of toggles writes once, and clock fields are
  // deliberately dropped (see the settings initialisers).
  useEffect(() => {
    const t = setTimeout(() => {
      persistScene({
        view: viewMode,
        earth: earthSettings as unknown as Record<string, unknown>,
        solar: solarSettings as unknown as Record<string, unknown>,
        sensitivity,
      });
    }, 400);
    return () => clearTimeout(t);
  }, [viewMode, earthSettings, solarSettings, sensitivity]);

  useEffect(() => {
    const t = setTimeout(() => {
      persistFilters({ categories: selectedCategories, bands: selectedBands });
    }, 400);
    return () => clearTimeout(t);
  }, [selectedCategories, selectedBands]);

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

  // History scrubber: jump the clock to 1 January of a chosen year (UTC), so
  // the era-filter shows only what had launched by then. Leaving real-time is
  // implicit — a historical year is by definition not "now".
  const setSimulatedYear = useCallback((year: number) => {
    setSimulatedTime(new Date(Date.UTC(year, 0, 1, 0, 0, 0)));
  }, [setSimulatedTime]);

  // RESET VIEW: each press bumps a nonce; the camera rig watches it and glides
  // back to the view's home pose (upright equatorial in Earth view, the whole
  // system in Solar view). It is the one control that always works, so it also
  // drops focus — otherwise the follow camera would immediately fight the glide
  // and the user would be stuck beside whatever they flew to.
  const [resetViewNonce, setResetViewNonce] = useState(0);
  const requestResetView = useCallback(() => {
    setIsFocused(false);
    setResetViewNonce((n) => n + 1);
  }, []);

  const handleSelectSat = useCallback((sat: SatData | null) => {
    if (comparePicking && sat) {
      setComparePicked({ side: comparePicking, sat });
      setComparePicking(null);
      return;
    }
    setSelectedSat(sat);
    if (sat) { setSelectedSolarSat(null); setSelectedBody(null); }
    setIsFocused(false);
  }, [comparePicking]);

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


  // ----- Cinematic tour -----
  // The tour drives the camera directly, so it takes the stage alone: any
  // selection (and its follow camera) is cleared first, and it only ever runs
  // in the Solar System view.
  const stopTour = useCallback(() => {
    setTourActive(false);
    setTourStop(null);
  }, []);

  // Starting to build a view means starting over from a blank canvas: the
  // scene for the other mode has to load its textures and meshes before the
  // first frame can draw. That is a real freeze — the tab stops being
  // interactive while the new world assembles — so the swap is gated behind a
  // brief loading overlay.
  //
  // The overlay is driven by a MINIMUM display time (the user asked for a
  // loading screen, and a 50 ms flash is worse than none) combined with a
  // render-handshake: the overlay only lifts once the new view's canvas has
  // actually painted at least one frame. That keeps the loading screen honest
  // — it never disappears over a still-frozen tab.
  // The overlay shows for AT LEAST this long — a loading screen that flashes
  // for 200 ms reads as a glitch, not as feedback — and stays up longer if the
  // new view takes longer to build (reportViewPainted re-arms the timer with
  // whatever floor remains). The user asked for ~3 s and that is the floor.
  const VIEW_SWITCH_MIN_MS = 3000 as const;
  const [switchOverlay, setSwitchOverlay] = useState(false);
  const switchHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const switchStartedAt = useRef(0);

  // Hide the overlay as soon as the MINIMUM floor has elapsed since the switch
  // began. Re-arming with the remaining floor (rather than a fixed delay) keeps
  // a fast rebuild from turning into a 3 s blank while a slow one still waits
  // out the whole promise.
  const armHideTimer = useCallback(() => {
    if (switchHideTimer.current) clearTimeout(switchHideTimer.current);
    const elapsed = performance.now() - switchStartedAt.current;
    const remaining = Math.max(0, VIEW_SWITCH_MIN_MS - elapsed);
    switchHideTimer.current = setTimeout(() => setSwitchOverlay(false), remaining);
  }, []);

  const switchRaf = useRef(0);
  useEffect(() => () => {
    cancelAnimationFrame(switchRaf.current);
    if (switchHideTimer.current) clearTimeout(switchHideTimer.current);
  }, []);

  const beginViewSwitch = useCallback((apply: () => void) => {
    setSwitchOverlay(true);
    switchStartedAt.current = performance.now();
    armHideTimer();
    // Apply the scene swap only AFTER the overlay has actually been composited.
    // Committing the overlay and the new viewMode in the SAME React update was
    // the whole bug: React renders both together, so the heavy Canvas rebuild
    // ran during that commit and blocked the main thread before the browser
    // ever painted the overlay — which is precisely the "page freezes for a
    // moment" being reported. Two nested rAFs: the first callback still runs
    // before the overlay's paint, the second runs after it.
    cancelAnimationFrame(switchRaf.current);
    switchRaf.current = requestAnimationFrame(() => {
      switchRaf.current = requestAnimationFrame(apply);
    });
  }, [armHideTimer]);

  const handleViewModeChange = useCallback((mode: 'earth' | 'solar') => {
    if (mode === viewMode) return;
    if (mode === 'earth') stopTour();
    beginViewSwitch(() => setViewMode(mode));
  }, [viewMode, stopTour, beginViewSwitch]);

  // The tour lives in the Solar System view, so starting it from the Earth view
  // triggers exactly the same heavy Canvas rebuild as the toggle does — it has
  // to go through beginViewSwitch too, or the tour button reintroduces the
  // freeze the overlay exists to cover. When the tour is started while already
  // in the solar view there is no rebuild, so the state flips immediately and
  // no overlay is shown.
  const startTour = useCallback(() => {
    const enter = () => {
      setViewMode('solar');
      setSelectedSat(null);
      setSelectedSolarSat(null);
      setSelectedBody(null);
      setIsFocused(false);
      setTourActive(true);
    };
    if (viewMode === 'solar') enter();
    else beginViewSwitch(enter);
  }, [viewMode, beginViewSwitch]);

  // Called from the canvas (earth or solar) once it paints its first frame
  // after a remount. Re-arms the hide timer with the remaining floor, so the
  // overlay never lifts over a still-frozen tab but also never overstays the
  // promised ~3 s once the scene is genuinely on screen.
  const reportViewPainted = useCallback(() => {
    armHideTimer();
  }, [armHideTimer]);


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

  // ----- Postcard export -----
  // Declared after the catalog memos so the caption can quote the count that
  // is genuinely on screen.
  const handleSnapshot = useCallback(async () => {
    const frame = captureRef.current?.();
    if (!frame) return;
    const title =
      selectedSat?.name ??
      selectedSolarSat?.name ??
      (selectedBody
        ? selectedBody.kind === 'moon' ? selectedBody.moon!.name : selectedBody.planet.name
        : viewMode === 'earth' ? 'Earth Orbit' : 'Solar System');
    const subtitle =
      selectedSat ? `${selectedSat.category} · ${selectedSat.band} · ${selectedSat.country}`
      : selectedSolarSat ? `${selectedSolarSat.type} · ${selectedSolarSat.planet}`
      : selectedBody ? (selectedBody.kind === 'moon' ? `Moon of ${selectedBody.planet.name}` : 'Planet')
      : viewMode === 'earth' ? `${displayedSatellites.length.toLocaleString()} objects tracked`
      : 'Planets, moons & deep-space probes';
    await downloadPostcard(frame, {
      title,
      subtitle,
      stamp: `${simulatedTimeRef.current.toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    });
  }, [selectedSat, selectedSolarSat, selectedBody, viewMode, displayedSatellites]);

  // ----- Shareable deep link -----
  // Encodes the current view, selection, focus and simulated date into a URL
  // and copies it. A copied link opens on exactly this scene.
  const [shareCopied, setShareCopied] = useState(false);
  const handleShare = useCallback(async () => {
    const body = selectedBody;
    const url = buildShareUrl({
      view: viewMode,
      sat: selectedSat ? selectedSat.satrec.satnum : null,
      planet: body ? body.planet.name : null,
      moon: body?.kind === 'moon' ? body.moon!.name : null,
      probe: selectedSolarSat ? selectedSolarSat.name : null,
      focus: isFocused,
      // Only pin a date when the user has actually time-travelled; otherwise
      // the link should open on whatever "now" is when it's opened.
      time: activeSettings.realTime ? null : new Date(simulatedTimeRef.current.getTime()),
    });
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      // Clipboard blocked (permissions, insecure context) — fall back to a
      // prompt so the link is still copyable rather than silently lost.
      window.prompt('Copy this link:', url);
    }
  }, [viewMode, selectedSat, selectedSolarSat, selectedBody, isFocused, activeSettings.realTime]);

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
          {/* Animated space background overlay */}
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(5,15,44,0.6)_0%,transparent_80%)] opacity-70 pointer-events-none" />
          <div className="absolute inset-0 overflow-hidden pointer-events-none">
            <div className="absolute top-[10%] left-[20%] w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse shadow-[0_0_8px_#22d3ee]"></div>
            <div className="absolute top-[40%] left-[80%] w-1 h-1 bg-blue-400 rounded-full animate-pulse delay-700 shadow-[0_0_6px_#60a5fa]"></div>
            <div className="absolute top-[75%] left-[15%] w-2 h-2 bg-indigo-400 rounded-full animate-pulse delay-300 shadow-[0_0_10px_#818cf8]"></div>
            <div className="absolute top-[25%] left-[65%] w-1 h-1 bg-purple-400 rounded-full animate-pulse delay-1000 shadow-[0_0_6px_#c084fc]"></div>
            <div className="absolute top-[85%] left-[70%] w-1.5 h-1.5 bg-teal-400 rounded-full animate-pulse delay-500 shadow-[0_0_8px_#2dd4bf]"></div>
          </div>

          <div className="orbit-spinner mb-8 z-10" />
          <div className="text-3xl font-bold font-mono tracking-[0.3em] mb-1 text-shimmer animate-fade-up z-10">
            PIMX<span>SATS</span>
          </div>
          <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mb-8 animate-fade-up z-10">
            Satellite &amp; Solar System Tracker
          </div>
          <div className="w-64 h-1 bg-white/10 rounded-full overflow-hidden mb-3 z-10">
            <div
              className="h-full rounded-full transition-all duration-300 progress-glow"
              style={{ width: `${Math.round((loadState.done / loadState.total) * 100)}%` }}
            />
          </div>
          <div className="text-xs font-mono text-gray-400 px-6 text-center max-w-md z-10" aria-live="polite">
            {loadState.phase}… {Math.round((loadState.done / loadState.total) * 100)}%
          </div>
        </div>
      )}

      {/* Onboarding hint card */}
      {showHint && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[45] w-[92vw] max-w-sm bg-black/90 backdrop-blur-2xl border border-blue-400/40 rounded-2xl p-4 shadow-2xl animate-fade-up text-white pointer-events-auto">
          <div className="flex items-start gap-3">
            <div className="bg-blue-500/20 p-2 rounded-xl border border-blue-400/30 text-blue-400 shrink-0">
              <Globe className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h4 className="text-xs font-bold font-mono text-blue-300 uppercase tracking-widest">Interactive Telemetry Tip</h4>
              <p className="text-[11px] font-mono text-gray-300 leading-relaxed">
                • <b>Rotate</b>: Drag with one finger<br />
                • <b>Zoom</b>: Pinch with two fingers<br />
                • <b>Details</b>: Tap any satellite, planet, or spacecraft dot to view real-time space dynamics tracking cards.
              </p>
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              onClick={dismissHint}
              className="px-4 py-1.5 rounded-lg text-[10px] font-mono font-bold bg-blue-600/80 hover:bg-blue-600 border border-blue-500/50 text-white btn-premium cursor-pointer"
            >
              GOT IT
            </button>
          </div>
        </div>
      )}

      {/* ---- View-switch overlay: covers the moment the scene swaps
               between Earth and Solar System. The target view is already
               mounted underneath; this overlay just keeps the swap from
               reading as a frozen tab. It lifts on the longer of: the
               minimum display time, or the first painted frame of the new
               view (both signalled above). ---- */}
      {switchOverlay && (
        <div className="fixed inset-0 z-[48] flex flex-col items-center justify-center bg-[#010204]">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(5,15,44,0.5)_0%,transparent_80%)] opacity-70 pointer-events-none" />
          <div className="orbit-spinner mb-6 z-10" />
          <div className="text-sm font-mono text-gray-300 tracking-widest uppercase z-10">
            {viewMode === 'solar' ? 'Entering Solar System' : 'Returning to Earth'}
          </div>
          <div className="text-[10px] font-mono text-gray-500 mt-1.5 z-10">
            Building scene…
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
            onViewModeChange={handleViewModeChange}
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
            sensitivity={sensitivity}
            onSensitivityChange={changeSensitivity}
            tourActive={tourActive}
            tourStop={tourStop}
            onStartTour={startTour}
            onStopTour={stopTour}
            onSnapshot={handleSnapshot}
            onShare={handleShare}
            shareCopied={shareCopied}
            sonificationEnabled={sonificationEnabled}
            onSonificationEnabledChange={setSonificationEnabled}
            fullCatalog={satellites}
            onSetSimulatedYear={setSimulatedYear}
            comparePicking={comparePicking}
            onComparePickingChange={setComparePicking}
            comparePicked={comparePicked}
            onComparePickedConsumed={() => setComparePicked(null)}
          />
          <OrbitalSonification
            enabled={sonificationEnabled}
            selectedSat={selectedSat}
            simulatedTimeRef={simulatedTimeRef}
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
              sensitivity={sensitivity}
              tourActive={tourActive}
              onTourStopChange={setTourStop}
              onTourFinish={stopTour}
              captureRef={captureRef}
              onFirstPaint={reportViewPainted}
            />
          </div>
        </>
      )}
    </>
  );
}
