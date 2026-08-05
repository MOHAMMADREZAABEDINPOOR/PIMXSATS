'use client';

import { SatData, OrbitBand, getSatelliteRealtimeInfo, SatelliteRealtimeInfo } from '@/lib/satellite';
import { SOLAR_SATELLITES, SolarSat, SelectedBody, PLANETS } from '@/lib/solar-system';
import {
  EarthSettings, SolarSettings,
  EARTH_SPEED_PRESETS, SOLAR_SPEED_PRESETS, formatSpeed,
} from '@/lib/settings';
import {
  Sensitivity, SENSITIVITY_OPTIONS,
  DeviceClass, DEVICE_CLASS_LABEL, detectDeviceClass,
} from '@/lib/interaction';
import { TourStop } from '@/lib/tour';
import { INTERIOR_BY_PLANET, PlanetInterior } from '@/lib/planet-interiors';
import { resolveFavorites } from '@/lib/favorites';
import { briefingSeenToday } from '@/lib/briefing';
import { PLAY_START_YEAR } from '@/lib/history';
import { useFavorites } from '@/hooks/use-favorites';
import { useUserLocation } from '@/hooks/use-location';
import { GroundTrack } from './GroundTrack';
import { PassesPanel } from './PassesPanel';
import { RadioPanel } from './RadioPanel';
import { FavoritesPanel, FavoriteStar } from './FavoritesPanel';
import { OverheadAlertsPanel } from './OverheadAlertsPanel';

import {
  Search, X, Globe, Rocket, Orbit, Compass, Radio,
  Navigation, Menu, Clock, MapPin, RotateCcw, Sun,
  SlidersHorizontal, Check,
  // `Map` is aliased: importing it bare would shadow the global Map
  // constructor used by the category/probe grouping below.
  Hand, Camera, Film, Map as MapIcon, Radar, Square, Share2, Link2,
  Volume2, VolumeX, Calendar, RadioTower, Layers,
  Activity, Newspaper, History, Ruler, Telescope, Columns2, Maximize2, Minimize2,
  Heart,
} from 'lucide-react';
import { useState, useMemo, useEffect, useRef, memo } from 'react';
import dynamic from 'next/dynamic';
import { SpaceWeather } from './SpaceWeather';
import { UpcomingLaunches } from './UpcomingLaunches';

// The interior explorer carries its own WebGL canvas and the procedural
// material generator, so it is only pulled down when a planet's cutaway is
// actually opened — it must never sit on the startup path.
const PlanetInteriorPanel = dynamic(
  () => import('./PlanetInteriorPanel').then((m) => ({ default: m.PlanetInteriorPanel })),
  { ssr: false }
);

// Same reasoning for the rest of the full-screen features: each is a modal the
// user opens deliberately, so none of them belong in the first bundle.
const DashboardPanel = dynamic(
  () => import('./DashboardPanel').then((m) => ({ default: m.DashboardPanel })),
  { ssr: false }
);
const BriefingPanel = dynamic(
  () => import('./BriefingPanel').then((m) => ({ default: m.BriefingPanel })),
  { ssr: false }
);
const ComparePanel = dynamic(
  () => import('./ComparePanel').then((m) => ({ default: m.ComparePanel })),
  { ssr: false }
);
const SkyView = dynamic(
  () => import('./SkyView').then((m) => ({ default: m.SkyView })),
  { ssr: false }
);
const HistoryScrubber = dynamic(
  () => import('./HistoryScrubber').then((m) => ({ default: m.HistoryScrubber })),
  { ssr: false }
);
const ScalePanel = dynamic(
  () => import('./ScalePanel').then((m) => ({ default: m.ScalePanel })),
  { ssr: false }
);

const ORBIT_BANDS: { id: OrbitBand; label: string; hint: string }[] = [
  { id: 'LEO', label: 'LEO', hint: '< 2,000 km' },
  { id: 'MEO', label: 'MEO', hint: '2,000–35,000 km' },
  { id: 'GEO', label: 'GEO', hint: '~35,786 km' },
  { id: 'HEO', label: 'HEO', hint: 'elliptical / high' },
];

interface UIOverlayProps {
  satellites: SatData[];
  selectedSat: SatData | null;
  onSelectSat: (sat: SatData | null) => void;
  viewMode: 'earth' | 'solar';
  onViewModeChange: (mode: 'earth' | 'solar') => void;
  selectedSolarSat: SolarSat | null;
  onSelectSolarSat: (sat: SolarSat | null) => void;
  selectedBody: SelectedBody | null;
  onSelectBody: (body: SelectedBody | null) => void;
  simulatedTimeRef: React.MutableRefObject<Date>;
  isLoading: boolean;

  earthSettings: EarthSettings;
  onEarthSettingsChange: (s: EarthSettings) => void;
  solarSettings: SolarSettings;
  onSolarSettingsChange: (s: SolarSettings) => void;

  isFocused: boolean;
  onIsFocusedChange: (focus: boolean) => void;
  selectedCategories: string[];
  onSelectedCategoriesChange: (categories: string[]) => void;
  selectedBands: OrbitBand[];
  onSelectedBandsChange: (bands: OrbitBand[]) => void;

  onSetSimulatedTime: (date: Date) => void;
  onJumpSimulatedTime: (deltaMs: number) => void;
  onResetSimulatedTime: () => void;
  /** Straighten the Earth-view camera (equator, north up) */
  onResetView: () => void;

  /** Gesture sensitivity preset, persisted per device. */
  sensitivity: Sensitivity;
  onSensitivityChange: (s: Sensitivity) => void;
  /** Cinematic Solar System tour. */
  tourActive: boolean;
  tourStop: (TourStop & { index: number; total: number }) | null;
  onStartTour: () => void;
  onStopTour: () => void;
  /** Export the current frame as a captioned PNG. */
  onSnapshot: () => void;
  /** Copy a deep link to the current scene. */
  onShare: () => void;
  /** True briefly after a share link is copied (drives the button feedback). */
  shareCopied: boolean;
  /** Sonification sound active. */
  sonificationEnabled: boolean;
  /** Setter for sonification. */
  onSonificationEnabledChange: (enabled: boolean) => void;
  /** The FULL Earth catalog (pre era/category filtering) — favourites and the
   *  split-screen compare search across all of it, not just what is currently
   *  drawn. */
  fullCatalog: SatData[];
  /** Jump the simulated clock to 1 Jan of the given year (history scrubber). */
  onSetSimulatedYear: (year: number) => void;
  /** Which split-screen column (if any) is currently waiting for a globe click.
   *  Owned by the app root, because that is where the 3D click lands. */
  comparePicking: 'A' | 'B' | null;
  onComparePickingChange: (side: 'A' | 'B' | null) => void;
  /** The object the user clicked on the globe, for the column that asked. */
  comparePicked: { side: 'A' | 'B'; sat: SatData } | null;
  onComparePickedConsumed: () => void;
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** Labeled pill switch (replaces the bare checkboxes of the old UI). */
function ToggleRow({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label
      title={title}
      className="flex items-center justify-between gap-2 text-[11px] font-mono text-gray-300 cursor-pointer select-none group"
    >
      <span className="truncate transition-colors group-hover:text-white">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="ui-switch"
      />
    </label>
  );
}

function formatOffset(ms: number): string {
  const abs = Math.abs(ms);
  const sign = ms >= 0 ? '+' : '-';
  if (abs < 90000) return `${sign}${Math.round(abs / 1000)}s`;
  if (abs < 5400000) return `${sign}${Math.round(abs / 60000)}m`;
  if (abs < 129600000) return `${sign}${(abs / 3600000).toFixed(1)}h`;
  if (abs < 63072000000) return `${sign}${(abs / 86400000).toFixed(1)}d`;
  return `${sign}${(abs / 31536000000).toFixed(1)}y`;
}

/** Compact display for the huge km figures of deep-space probes. */
function formatKm(km: number): string {
  if (km >= 1e9) return `${(km / 1e9).toFixed(1)}B km`;
  if (km >= 1e6) return `${(km / 1e6).toFixed(1)}M km`;
  return `${km.toLocaleString()} km`;
}

// ---------------------------------------------------------------------------
// Time & scene control panel (shared desktop panel / drawer section)
// ---------------------------------------------------------------------------

/** Gesture comfort. Lives next to the scene toggles because that is where a
 *  user goes when the view feels wrong, and it is the first thing worth
 *  reaching for on a phone.
 *
 *  The three presets sit on top of a per-device tuning: phone, tablet, laptop
 *  trackpad and mouse wheel each get their own rotate/zoom/damping numbers, so
 *  "Calm" means something different (and correct) on each. The detected class is
 *  shown because it is otherwise invisible, and because a wrong guess — a mouse
 *  on a small laptop screen, say — is then explainable rather than mysterious. */
function SensitivityControl({
  sensitivity, onChange,
}: { sensitivity: Sensitivity; onChange: (s: Sensitivity) => void }) {
  // Detected on the client only: it reads the pointer type and the screen.
  const [device, setDevice] = useState<DeviceClass | null>(null);
  useEffect(() => { setDevice(detectDeviceClass()); }, []);
  return (
    <div className="space-y-1.5 pt-2 border-t border-white/5">
      <span className="text-[9px] font-mono text-gray-500 uppercase tracking-widest flex items-center justify-between gap-1.5">
        <span className="flex items-center gap-1.5">
          <Hand className="w-3 h-3 text-cyan-400" /> Gesture sensitivity
        </span>
        {device && (
          <span
            className="text-cyan-300/70 normal-case tracking-normal shrink-0"
            title="Rotation, zoom and damping are tuned separately for phone, tablet, laptop trackpad and mouse wheel. This is the one detected for your device."
          >
            {DEVICE_CLASS_LABEL[device]}
          </span>
        )}
      </span>
      <div className="grid grid-cols-3 gap-1.5">
        {SENSITIVITY_OPTIONS.map((opt) => {
          const isOn = sensitivity === opt.id;
          return (
            <button
              key={opt.id}
              onClick={() => onChange(opt.id)}
              title={opt.hint}
              aria-pressed={isOn}
              className={`px-2 py-1 rounded-lg text-[10px] font-mono font-bold border chip-btn ${
                isOn
                  ? 'bg-gradient-to-b from-cyan-600/60 to-cyan-800/40 border-cyan-400/60 text-white shadow-[0_0_16px_-4px_rgba(34,211,238,0.6)]'
                  : 'bg-white/[0.04] border-white/10 text-gray-400 hover:border-white/25'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TimeAndScenePanel({
  viewMode, now, offsetMs, timeZone, locationSource,
  earthSettings, onEarthSettingsChange, solarSettings, onSolarSettingsChange,
  onSetSimulatedTime, onJumpSimulatedTime, onResetSimulatedTime,
  sensitivity, onSensitivityChange,
}: {
  viewMode: 'earth' | 'solar';
  now: Date | null;
  offsetMs: number;
  timeZone: string;
  locationSource: 'gps' | 'device';
  earthSettings: EarthSettings;
  onEarthSettingsChange: (s: EarthSettings) => void;
  solarSettings: SolarSettings;
  onSolarSettingsChange: (s: SolarSettings) => void;
  onSetSimulatedTime: (date: Date) => void;
  onJumpSimulatedTime: (deltaMs: number) => void;
  onResetSimulatedTime: () => void;
  sensitivity: Sensitivity;
  onSensitivityChange: (s: Sensitivity) => void;
}) {
  const dtInputRef = useRef<HTMLInputElement>(null);
  const isEarth = viewMode === 'earth';
  const settings = isEarth ? earthSettings : solarSettings;
  const presets = isEarth ? EARTH_SPEED_PRESETS : SOLAR_SPEED_PRESETS;

  const setSpeed = (speed: number) => {
    // Picking a warp speed leaves Real Time mode
    if (isEarth) onEarthSettingsChange({ ...earthSettings, timeSpeed: speed, realTime: false });
    else onSolarSettingsChange({ ...solarSettings, timeSpeed: speed, realTime: false });
  };
  const setMovement = (v: boolean) => {
    if (isEarth) onEarthSettingsChange({ ...earthSettings, enableMovement: v });
    else onSolarSettingsChange({ ...solarSettings, enableMovement: v });
  };
  const setRealTime = (v: boolean) => {
    if (isEarth) onEarthSettingsChange({ ...earthSettings, realTime: v, ...(v ? { timeSpeed: 1 } : {}) });
    else onSolarSettingsChange({ ...solarSettings, realTime: v, ...(v ? { timeSpeed: 1 } : {}) });
  };

  const timeTravelling = Math.abs(offsetMs) > 5000;

  const applyDateTime = () => {
    const v = dtInputRef.current?.value;
    if (!v) return;
    const d = new Date(v);
    if (!isNaN(d.getTime())) onSetSimulatedTime(d);
  };

  return (
    <div className="space-y-3">
      {/* Clock.
          Both rows WRAP and the variable-length parts are allowed to shrink. In
          the drawer this card is only ~230 px wide inside its padding (86vw of a
          320 px phone, less the drawer's and the card's own padding), and a
          `justify-between gap-4` row with a 20-character timestamp on one side
          needs more than that — so the card grew past the drawer and the drawer
          scrolled sideways, which is what "not fully visible" was. A long IANA
          zone name ("America/Argentina/Buenos_Aires") did the same thing on its
          own. Wrapping costs one line on the narrowest screens; overflowing costs
          the whole card. */}
      <div className="text-xs font-mono text-gray-400 space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
          <span className="flex items-center gap-1 shrink-0"><Clock className="w-3 h-3" /> SIM TIME</span>
          <span className="text-blue-400 font-bold tracking-wider tabular-nums" suppressHydrationWarning>
            {now
              ? now.toLocaleString('en-US', {
                  timeZone,
                  year: 'numeric', month: '2-digit', day: '2-digit',
                  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
                })
              : 'Syncing...'}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[10px]">
          <span className="flex items-center gap-1 text-gray-500 min-w-0" suppressHydrationWarning>
            <MapPin className="w-3 h-3 shrink-0" />
            <span className="truncate">{timeZone}</span>
            {locationSource === 'gps' && (
              <span className="shrink-0 text-green-400 border border-green-500/40 rounded px-1 ml-1">GPS</span>
            )}
          </span>
          {timeTravelling && (
            <span className="shrink-0 text-amber-400 border border-amber-500/40 rounded px-1">
              {formatOffset(offsetMs)} vs now
            </span>
          )}
        </div>
      </div>

      {/* Warp presets (independent per view) */}
      <div className="space-y-1.5">
        <span className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">
          Warp — {isEarth ? 'Earth view' : 'Solar view'}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => setRealTime(!settings.realTime)}
            className={`px-2 py-0.5 rounded-md text-[10px] font-mono font-bold chip-btn border ${
              settings.realTime
                ? 'bg-green-500/80 text-white border-green-400 shadow-[0_0_12px_-2px_rgba(34,197,94,0.6)]'
                : 'bg-white/5 text-gray-400 border-white/5 hover:border-white/20'
            }`}
          >
            ● REAL TIME
          </button>
          {presets.map((speed) => (
            <button
              key={speed}
              onClick={() => setSpeed(speed)}
              className={`px-2 py-0.5 rounded-md text-[10px] font-mono chip-btn border ${
                !settings.realTime && settings.timeSpeed === speed
                  ? 'bg-blue-500 text-white border-blue-400 shadow-[0_0_12px_-2px_rgba(59,130,246,0.6)]'
                  : 'bg-white/5 text-gray-400 border-white/5 hover:border-white/20'
              }`}
            >
              {formatSpeed(speed)}
            </button>
          ))}
          <ToggleRow label="Run" checked={settings.enableMovement} onChange={setMovement} />
        </div>
      </div>

      {/* Time travel */}
      <div className="space-y-1.5 pt-2 border-t border-white/5">
        <span className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">Time Travel</span>
        <div className="flex flex-wrap gap-1">
          {[
            { label: '-1y', ms: -31536000000 }, { label: '-30d', ms: -2592000000 },
            { label: '-1d', ms: -86400000 }, { label: '-1h', ms: -3600000 },
            { label: '+1h', ms: 3600000 }, { label: '+1d', ms: 86400000 },
            { label: '+30d', ms: 2592000000 }, { label: '+1y', ms: 31536000000 },
          ].map((j) => (
            <button
              key={j.label}
              onClick={() => onJumpSimulatedTime(j.ms)}
              className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-white/5 text-gray-300 border border-white/5 hover:border-white/25 chip-btn"
            >
              {j.label}
            </button>
          ))}
          <button
            onClick={onResetSimulatedTime}
            className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-amber-500/20 text-amber-300 border border-amber-500/40 hover:bg-amber-500/30 chip-btn flex items-center gap-1"
          >
            <RotateCcw className="w-2.5 h-2.5" /> NOW
          </button>
        </div>
        <div className="flex gap-1.5">
          <input
            ref={dtInputRef}
            type="datetime-local"
            className="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-[11px] font-mono text-gray-200 focus:outline-none focus:border-blue-500/70 focus:shadow-[0_0_0_3px_rgba(59,130,246,0.12)] transition-all [color-scheme:dark]"
          />
          <button
            onClick={applyDateTime}
            className="px-3 py-1 rounded-lg text-[10px] font-mono font-bold bg-blue-600/80 text-white border border-blue-500 hover:bg-blue-600 btn-premium"
          >
            GO
          </button>
        </div>
      </div>

      {/* Scene toggles — separate sets per view */}
      <div className="flex flex-col gap-1.5 pt-2 border-t border-white/5">
        <span className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">
          {isEarth ? 'Earth Scene' : 'Solar System Scene'}
        </span>
        {isEarth ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <ToggleRow label="Clouds" checked={earthSettings.showClouds}
              onChange={(v) => onEarthSettingsChange({ ...earthSettings, showClouds: v })} />
            <ToggleRow label="Atmosphere" checked={earthSettings.showAtmosphere}
              onChange={(v) => onEarthSettingsChange({ ...earthSettings, showAtmosphere: v })} />
            <ToggleRow label="Night Lights" checked={earthSettings.showNightLights}
              onChange={(v) => onEarthSettingsChange({ ...earthSettings, showNightLights: v })} />
            <ToggleRow label="Orbit Path" checked={earthSettings.showOrbitPath}
              onChange={(v) => onEarthSettingsChange({ ...earthSettings, showOrbitPath: v })} />
            <ToggleRow label="Coverage" checked={earthSettings.showCoverage}
              onChange={(v) => onEarthSettingsChange({ ...earthSettings, showCoverage: v })} />
            <ToggleRow label="Movement" checked={earthSettings.enableMovement}
              onChange={(v) => onEarthSettingsChange({ ...earthSettings, enableMovement: v })} />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <ToggleRow label="Orbit Lines" checked={solarSettings.showOrbits}
              onChange={(v) => onSolarSettingsChange({ ...solarSettings, showOrbits: v })} />
            <ToggleRow label="Moons" checked={solarSettings.showMoons}
              onChange={(v) => onSolarSettingsChange({ ...solarSettings, showMoons: v })} />
            <ToggleRow label="Moon Orbits" checked={solarSettings.showMoonOrbits}
              onChange={(v) => onSolarSettingsChange({ ...solarSettings, showMoonOrbits: v })} />
            <ToggleRow label="Spacecraft" checked={solarSettings.showProbes}
              onChange={(v) => onSolarSettingsChange({ ...solarSettings, showProbes: v })} />
            <ToggleRow label="Earth Sats" checked={solarSettings.showEarthSats}
              onChange={(v) => onSolarSettingsChange({ ...solarSettings, showEarthSats: v })} />
            <ToggleRow label="Movement" checked={solarSettings.enableMovement}
              onChange={(v) => onSolarSettingsChange({ ...solarSettings, enableMovement: v })} />
          </div>
        )}
      </div>

      <SensitivityControl sensitivity={sensitivity} onChange={onSensitivityChange} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// View switcher
// ---------------------------------------------------------------------------

// Compact segmented control for the two sections, sized to sit under the search
// field without competing with it. Each section keeps its identity by accent
// only: Earth in the app's blue/cyan, the Solar System warm like the Sun. The
// active pill is a filled gradient; inactive stays quiet until hovered.
const VIEW_OPTIONS = [
  {
    id: 'earth' as const,
    icon: Orbit,
    title: 'Earth Orbit',
    active:
      'bg-gradient-to-r from-blue-600/90 to-cyan-500/70 text-white ' +
      'shadow-[0_0_18px_-6px_rgba(59,130,246,0.9),inset_0_1px_0_rgba(255,255,255,0.2)]',
    iconOff: 'text-blue-400/70 group-hover:text-blue-300',
  },
  {
    id: 'solar' as const,
    icon: Sun,
    title: 'Solar System',
    active:
      'bg-gradient-to-r from-amber-500/90 to-orange-500/70 text-white ' +
      'shadow-[0_0_18px_-6px_rgba(245,158,11,0.85),inset_0_1px_0_rgba(255,255,255,0.2)]',
    iconOff: 'text-amber-400/70 group-hover:text-amber-300',
  },
];

// ---------------------------------------------------------------------------
// Site wordmark + donate.
//
// The old header was a lucide `Globe` glyph — a circle with a few lines on it —
// next to the name. At 16 px it read as a generic "internet" icon and said
// nothing this app doesn't already say with a 3D Earth filling the screen, so it
// is gone everywhere. The name carries the header on its own, set in the display
// face (see `.font-display` in globals.css).
// ---------------------------------------------------------------------------

/** Where the donate button goes. Kept as a constant so the URL exists once. */
const DONATE_URL = 'https://pimxsupport.pages.dev';

function SiteWordmark({ className = '' }: { className?: string }) {
  return (
    // `select-none` because this sits over a drag surface on mobile: a long
    // press on a heading otherwise starts a text selection instead of a spin.
    <span className={`font-display text-shimmer select-none whitespace-nowrap ${className}`}>
      PIMXSATS
    </span>
  );
}

function DonateButton({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href={DONATE_URL}
      target="_blank"
      rel="noopener noreferrer"
      title="Support PIMXSATS"
      className={`inline-flex items-center gap-1.5 rounded-full border border-pink-400/40 bg-pink-500/15 text-pink-200 font-mono font-bold uppercase tracking-widest hover:bg-pink-500/25 hover:text-white chip-btn whitespace-nowrap ${
        compact ? 'px-2 py-1 text-[9px]' : 'px-3 py-1.5 text-[10px]'
      }`}
    >
      <Heart className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} />
      Donate
    </a>
  );
}

function ViewSwitcher({
  viewMode, onSwitch,
}: { viewMode: 'earth' | 'solar'; onSwitch: (mode: 'earth' | 'solar') => void }) {
  return (
    <div
      role="tablist"
      aria-label="Tracker section"
      className="inline-flex items-center gap-1 p-1 bg-black/50 rounded-full border border-white/10 backdrop-blur-xl shadow-lg max-w-full"
    >
      {VIEW_OPTIONS.map((opt) => {
        const isOn = viewMode === opt.id;
        const Icon = opt.icon;
        return (
          <button
            key={opt.id}
            role="tab"
            aria-selected={isOn}
            onClick={() => onSwitch(opt.id)}
            className={`group flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-full chip-btn whitespace-nowrap min-w-0 ${
              isOn ? opt.active : 'text-gray-400 hover:text-white hover:bg-white/[0.07]'
            }`}
          >
            <Icon className={`w-3.5 h-3.5 shrink-0 transition-colors ${isOn ? 'text-white' : opt.iconOff}`} />
            <span className="text-[10px] sm:text-[11px] font-semibold tracking-wide leading-none truncate">{opt.title}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Solar System quick-nav dock.
//
// At true relative scale the planets are specks separated by compressed but
// still enormous distances, and reaching one by pinch-and-drag on a phone is
// hopeless: zoom pulls the camera toward the Sun, not toward whatever you were
// looking at. This rail is the answer — one tap selects a planet and hands it
// to the follow camera, which flies there.
//
// It WRAPS; it does not scroll sideways. Nine chips need ~430 px and a phone rail
// is ~280 px, so the old `overflow-x-auto no-scrollbar` row put Uranus and
// Neptune outside the dock with nothing on screen to say they were there — a
// horizontal scroll area with no scrollbar, inside a layer that also swallows
// horizontal drags for the camera. Wrapping is what the action rail below it
// already does, so on a narrow screen this becomes two visible rows instead of
// one row with a hidden half.
// ---------------------------------------------------------------------------

function SolarDock({
  selectedBody, onSelectBody, onIsFocusedChange, onClearSelection,
}: {
  selectedBody: SelectedBody | null;
  onSelectBody: (body: SelectedBody) => void;
  onIsFocusedChange: (focus: boolean) => void;
  onClearSelection: () => void;
}) {
  return (
    <div className="pointer-events-auto max-w-full">
      <div className="flex flex-wrap items-center justify-center gap-1 px-1.5 py-1.5 rounded-2xl bg-black/60 backdrop-blur-2xl border border-white/10 shadow-2xl">
        <button
          onClick={onClearSelection}
          title="Back to the whole system"
          className="flex flex-col items-center gap-1 px-2 sm:px-2.5 py-1 rounded-xl shrink-0 chip-btn border border-transparent text-gray-400 hover:text-white hover:bg-white/[0.07]"
        >
          <Sun className="w-4 h-4 text-amber-400" />
          <span className="text-[8px] font-mono uppercase tracking-widest">System</span>
        </button>

        {/* Only a separator, and in a wrapping row it can land at the end of a
            line where it means nothing — so it is spent only where there is room
            for the whole dock to read as one strip. */}
        <span className="hidden sm:block w-px self-stretch bg-white/10 mx-0.5 shrink-0" />

        {PLANETS.map((planet) => {
          const isOn = selectedBody?.kind === 'planet' && selectedBody.planet.name === planet.name;
          return (
            <button
              key={planet.name}
              onClick={() => { onSelectBody({ kind: 'planet', planet }); onIsFocusedChange(true); }}
              title={`Fly to ${planet.name}`}
              aria-pressed={isOn}
              className={`flex flex-col items-center gap-1 px-2 sm:px-2.5 py-1 rounded-xl shrink-0 chip-btn border ${
                isOn
                  ? 'bg-white/10 border-white/25 text-white'
                  : 'border-transparent text-gray-400 hover:text-white hover:bg-white/[0.07]'
              }`}
            >
              <span
                className="w-3.5 h-3.5 rounded-full"
                style={{
                  backgroundColor: planet.color,
                  boxShadow: isOn ? `0 0 12px ${planet.color}` : `0 0 6px ${planet.color}66`,
                }}
              />
              <span className="text-[8px] font-mono uppercase tracking-widest">
                {planet.name.slice(0, 4)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cinematic tour banner — caption + progress + a way out.
// ---------------------------------------------------------------------------

function TourBanner({
  stop, onStop,
}: { stop: (TourStop & { index: number; total: number }) | null; onStop: () => void }) {
  return (
    <div className="absolute inset-x-0 top-0 flex justify-center px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pointer-events-none z-40">
      <div className="pointer-events-auto w-full max-w-lg bg-black/75 backdrop-blur-2xl border border-white/10 rounded-2xl px-4 py-3 shadow-2xl animate-fade-up">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[9px] font-mono uppercase tracking-widest text-amber-400 flex items-center gap-1.5">
              <Film className="w-3 h-3" />
              Guided tour
              {stop && <span className="text-gray-500">· {stop.index + 1} / {stop.total}</span>}
            </div>
            <h3 className="text-lg font-bold text-white leading-tight truncate">
              {stop ? stop.title : 'Preparing flight…'}
            </h3>
          </div>
          <button
            onClick={onStop}
            className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border border-white/15 bg-white/5 text-[10px] font-mono font-bold text-gray-200 hover:bg-white/10 chip-btn"
          >
            <Square className="w-3 h-3" /> END
          </button>
        </div>
        {stop && (
          <p className="text-[11px] md:text-xs text-gray-300 font-mono leading-relaxed mt-1.5">
            {stop.caption}
          </p>
        )}
        {stop && (
          <div className="mt-2 h-0.5 w-full bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full progress-glow rounded-full transition-all duration-700"
              style={{ width: `${((stop.index + 1) / stop.total) * 100}%` }}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Earth category & orbit-band filters
// ---------------------------------------------------------------------------

// Memoized: the overlay re-renders 4×/s for the clock, but this panel only
// depends on the (era-filtered) catalog and the filter selections — skipping
// its reconciliation keeps the clock tick nearly free.
const CategoriesPanel = memo(function CategoriesPanel({
  satellites, selectedCategories, onSelectedCategoriesChange, selectedBands, onSelectedBandsChange,
}: {
  satellites: SatData[];
  selectedCategories: string[];
  onSelectedCategoriesChange: (c: string[]) => void;
  selectedBands: OrbitBand[];
  onSelectedBandsChange: (b: OrbitBand[]) => void;
}) {
  const categories = useMemo(() => {
    const counts = new Map<string, { count: number; color: string }>();
    satellites.forEach((sat) => {
      if (!counts.has(sat.category)) counts.set(sat.category, { count: 0, color: sat.color });
      counts.get(sat.category)!.count++;
    });
    return Array.from(counts.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.count - a.count);
  }, [satellites]);

  const bandCounts = useMemo(() => {
    const counts: Record<string, number> = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
    satellites.forEach((s) => { counts[s.band] = (counts[s.band] ?? 0) + 1; });
    return counts;
  }, [satellites]);

  const activeCount = selectedCategories.length + selectedBands.length;

  return (
    // Fills the card it is given and scrolls the LIST inside it, the same shape
    // as ProbesPanel next door. It used to be a natural-height column with the
    // list capped at `32vh`, which was independent of the card: once the card
    // became a fixed share of the column (so that it matches the detail card
    // opposite), a short window could hand this panel less room than 32vh of
    // list plus its header asked for, and the card's `overflow-hidden` would cut
    // the bottom rows off with nothing able to scroll to them.
    <div className="flex flex-col gap-3 min-h-0 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-gray-300 uppercase tracking-widest flex items-center gap-1.5">
          <SlidersHorizontal className="w-3.5 h-3.5 text-blue-400" /> Filters
        </span>
        {activeCount > 0 && (
          <button
            onClick={() => { onSelectedCategoriesChange([]); onSelectedBandsChange([]); }}
            className="text-[9px] font-mono font-bold px-2 py-0.5 rounded-full bg-blue-500/15 border border-blue-400/30 text-blue-300 hover:bg-blue-500/25 chip-btn"
          >
            CLEAR ({activeCount})
          </button>
        )}
      </div>

      {/* Orbit altitude bands */}
      <div>
        <div className="text-[9px] font-mono text-gray-500 uppercase tracking-widest mb-1.5">Orbit Regime</div>
        <div className="grid grid-cols-4 gap-1.5">
          {ORBIT_BANDS.map((band) => {
            const isOn = selectedBands.includes(band.id);
            return (
              <button
                key={band.id}
                title={band.hint}
                onClick={() =>
                  onSelectedBandsChange(isOn ? selectedBands.filter((b) => b !== band.id) : [...selectedBands, band.id])
                }
                className={`flex flex-col items-center gap-0.5 px-1 py-1.5 rounded-xl border font-mono chip-btn ${
                  isOn
                    ? 'bg-gradient-to-b from-blue-600/60 to-blue-800/40 border-blue-400/60 text-white shadow-[0_0_16px_-4px_rgba(59,130,246,0.6)]'
                    : 'bg-white/[0.04] border-white/10 text-gray-400 hover:border-white/25 hover:bg-white/[0.08]'
                }`}
              >
                <span className="text-[10px] font-bold">{band.label}</span>
                <span className={`text-[9px] ${isOn ? 'text-blue-200' : 'text-gray-600'}`}>
                  {(bandCounts[band.id] ?? 0).toLocaleString()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Categories — the list scrolls on its own so Orbit Regime above stays
          pinned in view no matter how long the catalog gets. It takes the room
          the card has left rather than a `32vh` slice of the viewport: the card's
          height is now a share of its column, and a list measured against the
          window instead of its container is exactly how rows end up clipped. */}
      <div className="flex flex-col min-h-0 flex-1">
        <div className="text-[9px] font-mono text-gray-500 uppercase tracking-widest mb-1.5 flex items-center justify-between">
          <span>Categories</span>
          <span className="text-gray-600">{categories.length}</span>
        </div>
        <div className="space-y-1 flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1 -mr-1 overscroll-contain">
          {categories.map((cat) => {
            const isSelected = selectedCategories.includes(cat.name);
            return (
              <button
                key={cat.name}
                onClick={() => {
                  const next = isSelected
                    ? selectedCategories.filter((c) => c !== cat.name)
                    : [...selectedCategories, cat.name];
                  onSelectedCategoriesChange(next);
                }}
                className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono row-hover ${
                  isSelected ? 'bg-blue-600/25 border-blue-500/40 text-white' : 'border-transparent text-gray-300 hover:bg-white/5'
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: cat.color, boxShadow: `0 0 8px ${cat.color}` }}
                />
                <span className="truncate flex-1 text-left">{cat.name}</span>
                <span className={`text-[9px] px-1.5 py-0.5 rounded-md font-bold ${
                  isSelected ? 'bg-blue-500/30 text-blue-200' : 'bg-white/5 text-gray-500'
                }`}>
                  {cat.count.toLocaleString()}
                </span>
                <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 transition-colors ${
                  isSelected ? 'bg-blue-500 border-blue-400' : 'border-white/20 bg-white/5'
                }`}>
                  {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Solar-system spacecraft list, grouped by host
// ---------------------------------------------------------------------------

const ProbesPanel = memo(function ProbesPanel({
  selectedSolarSat, onSelectSolarSat, onSelectSat, simYear,
}: {
  selectedSolarSat: SolarSat | null;
  onSelectSolarSat: (s: SolarSat | null) => void;
  onSelectSat: (s: SatData | null) => void;
  /** UTC year of the simulated clock — spacecraft launched later are hidden */
  simYear: number | null;
}) {
  const { groups, total } = useMemo(() => {
    const m = new Map<string, SolarSat[]>();
    let total = 0;
    SOLAR_SATELLITES.forEach((s) => {
      const y = parseInt(s.launchYear, 10);
      if (simYear !== null && !isNaN(y) && y > simYear) return; // not launched yet at sim time
      if (!m.has(s.planet)) m.set(s.planet, []);
      m.get(s.planet)!.push(s);
      total++;
    });
    return { groups: Array.from(m.entries()), total };
  }, [simYear]);

  return (
    // The header stays put and the LIST scrolls. Thirty-five spacecraft across
    // eight hosts is longer than any card this sits in, and when the whole panel
    // scrolled together the "Spacecraft · 35" title and the host you were
    // reading under both slid away, leaving an unlabelled column of names.
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 text-xs font-bold text-gray-300 uppercase tracking-widest pb-1.5 mb-1 border-b border-white/10 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 min-w-0">
          <Navigation className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          <span className="truncate">Spacecraft</span>
        </span>
        <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-white/5 text-gray-500 font-mono shrink-0">{total}</span>
      </div>

      {total === 0 ? (
        <div className="text-[10px] font-mono text-gray-500 px-1 py-1">
          No spacecraft launched yet at the simulated time.
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1 -mr-1">
          {groups.map(([planet, probes]) => (
            <div key={planet} className="mb-1">
              {/* Sticky host label: scrolling past "Deep Space" into a run of
                  twelve probes must not leave you wondering whose they are.

                  A LIGHT translucent strip, and deliberately no backdrop-filter.
                  Two attempts at this read as a black bar across the card's
                  glass: first a near-opaque `bg-[#05070d]/95` fill, then
                  `backdrop-blur-md` with no fill at all — which is worse than it
                  looks in the markup, because this card is itself
                  `backdrop-blur-xl`, and a backdrop-filter nested inside another
                  one samples an empty backdrop root in Chrome and paints it as
                  black. The only fill that cannot go dark is one made of white.
                  It costs a little: a name crossing under the strip stays faintly
                  visible instead of being smeared out. That is the trade the
                  "glassy like the rest" requirement asks for. */}
              <div className="sticky top-0 z-10 -mx-1 px-2 py-1 bg-white/[0.07] text-[9px] font-mono text-gray-300 uppercase tracking-widest flex items-center gap-1.5">
                {planet}
                <span className="flex-1 border-t border-white/10" />
              </div>
              {probes.map((probe) => (
                <button
                  key={probe.name}
                  onClick={() => {
                    onSelectSolarSat(selectedSolarSat === probe ? null : probe);
                    onSelectSat(null);
                  }}
                  className={`w-full flex items-center gap-2 text-xs px-2 py-1 rounded-lg row-hover border ${
                    selectedSolarSat === probe ? 'bg-blue-600/40 border-blue-500/30' : 'hover:bg-white/5 border-transparent'
                  }`}
                >
                  <div className={`w-2 h-2 rounded-full shrink-0 ${probe.active ? '' : 'opacity-40'}`} style={{ backgroundColor: probe.color }} />
                  <span className={`font-mono truncate text-left flex-1 ${probe.active ? 'text-gray-100' : 'text-gray-500'}`}>
                    {probe.name}
                  </span>
                  {!probe.active && <span className="text-[8px] font-mono text-gray-600 uppercase shrink-0">silent</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Detail card for the selected satellite / spacecraft / body.
//
// The card is a FIXED HEIGHT and the three sections (Data / Track / Passes) are
// TABS rather than a stack, so its height is the tallest single section instead
// of the sum of all three. Within a tab, the pane scrolls if its content is
// taller than the budget — the Data figures and the 24 h pass list both run past
// it, and truncating them was worse than a scrollbar.
//
// Data tab layout: two provenance cards (country, launch year) as headline facts
// on top, then the live figures as flush rows inside one titled panel. The
// earlier version made every figure its own bordered tile, which spent a lot of
// vertical space on borders and read as a pile of unrelated chips.
// ---------------------------------------------------------------------------

/** One figure in the telemetry panel. `wide` puts the value on its own line
 *  beneath the label, for prose-length values that would otherwise be crushed
 *  against it. */
interface Stat {
  label: string;
  value: string;
  /** Tailwind text colour for the value, when the value means something. */
  tone?: string;
  /** Full text, for values that may be truncated at narrow widths. */
  title?: string;
  wide?: boolean;
}

/** One provenance fact — the pair of cards above the telemetry. These read as
 *  headline facts rather than table rows: small icon-led caption, value on its
 *  own line beneath it. */
function FactCard({
  icon: Icon, iconTone, label, value, title,
}: {
  icon: typeof Globe;
  iconTone: string;
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div
      title={title ?? value}
      className="flex-1 min-w-0 bg-white/5 border border-white/5 rounded-xl px-2.5 py-2"
    >
      <div className="flex items-center gap-1.5 text-[9px] font-mono text-gray-500 uppercase tracking-widest">
        <Icon className={`w-3 h-3 shrink-0 ${iconTone}`} />
        <span className="truncate">{label}</span>
      </div>
      <div className="text-[13px] font-mono font-bold text-white mt-1 truncate">
        {value}
      </div>
    </div>
  );
}

/** The telemetry block: one titled panel with the figures as flush label/value
 *  rows separated by hairlines, rather than a stack of individually-bordered
 *  tiles. Rows that carry a `wide` value (prose, not a figure) break onto their
 *  own line so they are not squeezed against the label. */
function StatPanel({ title, icon: Icon, stats }: { title: string; icon: typeof Globe; stats: Stat[] }) {
  return (
    <div className="bg-white/5 border border-white/5 rounded-xl overflow-hidden">
      <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-1.5 text-[9px] font-mono font-bold text-gray-300 uppercase tracking-widest">
        <Icon className="w-3 h-3 text-blue-400 shrink-0" />
        <span className="truncate">{title}</span>
      </div>
      <div className="divide-y divide-white/5 border-t border-white/5">
        {stats.map((s) => (
          <div
            key={s.label}
            title={s.title ?? s.value}
            className={s.wide
              ? 'px-2.5 py-1.5 min-w-0'
              : 'px-2.5 py-1.5 min-w-0 flex items-center justify-between gap-3'}
          >
            <div className="text-[10px] font-mono text-gray-400 uppercase tracking-wider shrink-0">
              {s.label}
            </div>
            <div className={`text-[11px] font-mono font-bold ${
              s.wide ? 'mt-0.5 text-white break-words' : 'text-right whitespace-nowrap'
            } ${s.tone ?? (s.wide ? 'text-white' : 'text-gray-100')}`}>
              {s.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Light bouncing between Earth and a deep-space probe, at 1:1 with the real
 *  round-trip time. Six pixels tall, and it makes the latency figures above it
 *  land in a way the numbers alone do not. */
function SignalStrip({ oneWaySeconds }: { oneWaySeconds: number }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[8px] font-mono text-gray-500 uppercase tracking-widest">
        <span>Earth</span>
        <span>Spacecraft</span>
      </div>
      <div className="h-1.5 bg-white/10 rounded-full relative overflow-hidden">
        <div
          className="absolute top-0 bottom-0 w-2 rounded-full bg-orange-400 animate-signal-ping"
          // The photon takes as long to cross as the signal really does, capped
          // so a 6-hour Voyager round trip does not look like a stationary dot.
          style={{ animationDuration: `${Math.min(Math.max(oneWaySeconds * 2, 1.2), 12)}s` }}
        />
      </div>
    </div>
  );
}

// The conjunction ("Radar") tab used to live here between Passes and Radio. It
// was removed: answering "what comes close to this object" means propagating the
// whole catalog against the selected satellite over a forward window, which is by
// far the heaviest thing the client can be asked to do, and it ran simply because
// a tab was open. The panel component is still in the tree (components/
// ConjunctionPanel.tsx) if it is ever wanted behind an explicit action.
type InfoTab = 'data' | 'track' | 'passes' | 'radio';

const INFO_TABS: { id: InfoTab; label: string; icon: typeof Globe }[] = [
  { id: 'data', label: 'Data', icon: Rocket },
  { id: 'track', label: 'Track', icon: MapIcon },
  { id: 'passes', label: 'Passes', icon: Radar },
  { id: 'radio', label: 'Radio', icon: RadioTower },
];

const EARTH_SURFACE_KM2 = 510072000;

function InfoCard({
  selectedSat, selectedSolarSat, selectedBody,
  realtimeInfo, notYetLaunched, isFocused, onIsFocusedChange, onClose,
  observerCoords, timeZone, now,
  planetInterior, onExploreInterior,
  onCompare,
  locationPermission = 'idle', onRequestLocation,
  desktopMode = false,
}: {
  selectedSat: SatData | null;
  selectedSolarSat: SolarSat | null;
  selectedBody: SelectedBody | null;
  realtimeInfo: SatelliteRealtimeInfo | null;
  notYetLaunched: boolean;
  isFocused: boolean;
  onIsFocusedChange: (focus: boolean) => void;
  onClose: () => void;
  observerCoords: { lat: number; lon: number } | null;
  timeZone: string;
  now: Date | null;
  /** Interior dataset for the selected planet, if one exists. */
  planetInterior: PlanetInterior | null;
  onExploreInterior: () => void;
  /** Open the split-screen compare with this satellite pre-loaded. */
  onCompare: () => void;
  /** Geolocation grant state + requester, threaded into the Passes tab. */
  locationPermission?: 'idle' | 'pending' | 'granted' | 'denied';
  onRequestLocation?: () => void;
  desktopMode?: boolean;
}) {
  const [tab, setTab] = useState<InfoTab>('data');
  const selectedItem = selectedSat ?? selectedSolarSat;
  // Tabs exist for Earth satellites and deep space probes; a planet or moon has
  // no ground track and no passes, so its card is data-only. The radio tab is
  // Earth-orbit-only — a deep-space probe has no modelled amateur downlink here.
  const tabs = useMemo(
    () => (selectedSat
      ? INFO_TABS
      : selectedSolarSat
        ? INFO_TABS.filter((t) => t.id === 'data' || t.id === 'track' || t.id === 'passes')
        : []),
    [selectedSat, selectedSolarSat]
  );
  const hasTabs = tabs.length > 0;
  // Guard against a stale tab when the selection type changes under it.
  const activeTab: InfoTab = hasTabs && tabs.some((t) => t.id === tab) ? tab : 'data';

  const headerColor = selectedItem?.color ?? selectedBody?.planet.color ?? '#ffffff';
  const headerName = selectedItem?.name
    ?? (selectedBody?.kind === 'moon' ? selectedBody.moon!.name : selectedBody?.planet.name)
    ?? '';
  const headerTag = selectedSat
    ? `${selectedSat.category} · ${selectedSat.band}`
    : selectedSolarSat
      ? `Solar System · ${selectedSolarSat.planet}`
      : selectedBody?.kind === 'moon'
        ? `Moon of ${selectedBody.planet.name}`
        : 'Planet';
  const headerFact = selectedSat?.fact
    ?? selectedSolarSat?.fact
    ?? (selectedBody?.kind === 'moon' ? selectedBody.moon!.fact : selectedBody?.planet.fact)
    ?? '';
  // The operator line under the name. Country, launch year and mission now have
  // dedicated cards at the top of the Data tab, so repeating them here would be
  // three-way duplication; the operator is the one piece of provenance that has
  // no home of its own.
  const headerMeta = selectedItem ? selectedItem.operator : '';

  // Focus / go-to-body camera action
  const focusLabel = isFocused
    ? selectedBody
      ? 'RETURN TO SYSTEM VIEW'
      : 'DISABLE CAMERA FOCUS'
    : selectedBody
      ? selectedBody.kind === 'planet' ? 'GO TO PLANET' : 'GO TO MOON'
      : 'FOCUS TRACKING CAMERA';
  const FocusIcon = selectedBody && !isFocused ? Rocket : Compass;

  // --- The figures -----------------------------------------------------------
  // Everything the old stacked layout showed, at a precision a person can read
  // at a glance. `pending` is a single character, not "Propagating…", because a
  // 14-character placeholder in a tile is what forced the old row layout.
  const pending = notYetLaunched ? '—' : '…';
  const stats: Stat[] = selectedSat
    ? [
        { label: 'Altitude', value: realtimeInfo ? `${realtimeInfo.altitude.toFixed(0)} km` : pending,
          title: realtimeInfo ? `${realtimeInfo.altitude.toFixed(3)} km above mean sea level` : undefined },
        { label: 'Speed', value: realtimeInfo
            ? `${realtimeInfo.speed.toFixed(2)} km/s (~${(realtimeInfo.speed * 3600).toLocaleString(undefined, { maximumFractionDigits: 0 })} km/h)`
            : pending,
          title: realtimeInfo ? `${realtimeInfo.speed.toFixed(5)} km/s` : undefined },
        { label: 'Period', value: selectedSat.satrec.no > 0
            ? `${((2 * Math.PI) / selectedSat.satrec.no).toFixed(0)} min` : '—',
          title: selectedSat.satrec.no > 0
            ? `One lap of the planet every ${((2 * Math.PI) / selectedSat.satrec.no).toFixed(1)} minutes — ${(1440 / ((2 * Math.PI) / selectedSat.satrec.no)).toFixed(1)} orbits a day`
            : undefined },
        { label: 'Sub-point', value: realtimeInfo ? `${realtimeInfo.lat.toFixed(1)}°, ${realtimeInfo.lng.toFixed(1)}°` : pending,
          title: realtimeInfo ? `Currently directly above ${realtimeInfo.lat.toFixed(4)}°, ${realtimeInfo.lng.toFixed(4)}°` : undefined },
        { label: 'Footprint radius', value: realtimeInfo ? `${realtimeInfo.coverageRadius.toFixed(0)} km` : pending,
          title: realtimeInfo ? `Radio horizon radius ${realtimeInfo.coverageRadius.toFixed(2)} km` : undefined },
        { label: 'Covered area', value: realtimeInfo
            ? `${realtimeInfo.coverageArea.toLocaleString(undefined, { maximumFractionDigits: 0 })} km²`
            : pending,
          title: realtimeInfo ? 'Ground area with this satellite above the horizon' : undefined },
        { label: 'Globe coverage', value: realtimeInfo ? `${((realtimeInfo.coverageArea / EARTH_SURFACE_KM2) * 100).toFixed(1)}% of Earth` : pending,
          tone: 'text-blue-300',
          title: realtimeInfo ? `Sees ${((realtimeInfo.coverageArea / EARTH_SURFACE_KM2) * 100).toFixed(4)}% of the planet's surface at once` : undefined },
        { label: 'Operational mission', value: selectedSat.purpose, wide: true },
        ...(notYetLaunched
          ? [{ label: 'Status', value: 'NOT YET LAUNCHED', tone: 'text-amber-400',
              title: 'The simulated clock is set before this object went up' } as Stat]
          : []),
      ]
    : selectedSolarSat
      ? (() => {
          const delay = selectedSolarSat.altitude / 299792.458; // km / (km/s)
          const fmt = (sec: number) => {
            if (sec < 60) return `${sec.toFixed(1)} s`;
            const m = Math.floor(sec / 60);
            if (m < 60) return `${m}m ${Math.floor(sec % 60)}s`;
            return `${Math.floor(m / 60)}h ${m % 60}m`;
          };
          return [
            { label: 'Distance', value: formatKm(selectedSolarSat.altitude),
              title: `${selectedSolarSat.altitude.toLocaleString()} km from Earth — ${(selectedSolarSat.altitude / 384400).toFixed(2)}× the distance to the Moon, or ${(selectedSolarSat.altitude / 40075).toLocaleString(undefined, { maximumFractionDigits: 0 })} trips around the equator` },
            { label: 'Speed', value: `${selectedSolarSat.speed.toLocaleString()} km/s` },
            { label: 'Status', value: selectedSolarSat.active ? 'ACTIVE' : 'MISSION ENDED',
              tone: selectedSolarSat.active ? 'text-green-400' : 'text-gray-500' },
            { label: 'Signal one-way', value: fmt(delay), tone: 'text-orange-300',
              title: `Light itself needs ${fmt(delay)} to reach this spacecraft` },
            { label: 'Round trip', value: fmt(delay * 2), tone: 'text-orange-300',
              title: `A command sent now is acknowledged no sooner than ${fmt(delay * 2)} from now` },
          ] as Stat[];
        })()
      : selectedBody
        ? (() => {
            const isMoon = selectedBody.kind === 'moon';
            const body = isMoon ? selectedBody.moon! : selectedBody.planet;
            const p = Math.abs(body.periodDays);
            return [
              { label: 'Radius', value: `${body.radiusKm.toLocaleString()} km`,
                title: `${(body.radiusKm / 6371).toFixed(2)}× Earth's radius` },
              { label: isMoon ? 'From planet' : 'From Sun',
                value: isMoon ? formatKm(selectedBody.moon!.orbitKm) : `${selectedBody.planet.orbitAu} AU`,
                title: isMoon
                  ? `${selectedBody.moon!.orbitKm.toLocaleString()} km orbital radius`
                  : `${selectedBody.planet.orbitAu} astronomical units — ${(selectedBody.planet.orbitAu * 149.6).toFixed(1)} million km` },
              { label: 'Orbital period',
                value: p >= 365 ? `${(p / 365.25).toFixed(1)} yr` : `${p.toFixed(1)} d`,
                title: `${p.toLocaleString(undefined, { maximumFractionDigits: 2 })} Earth days per orbit` },
              isMoon
                ? { label: 'Direction', value: body.periodDays < 0 ? 'RETROGRADE' : 'PROGRADE',
                    tone: body.periodDays < 0 ? 'text-amber-400' : undefined,
                    title: body.periodDays < 0
                      ? 'Orbits against its planet’s rotation — a captured body, most likely'
                      : 'Orbits the same way its planet turns' }
                : { label: 'Moons shown', value: String(selectedBody.planet.moons.length) },
            ] as Stat[];
          })()
        : [];

  return (
    <div className={desktopMode
      ? "w-full h-full min-h-0 pointer-events-auto"
      : "absolute bottom-0 inset-x-0 pointer-events-auto z-20"
    }>
      {/* No overflow-y anywhere below this line — see the note above. The card
          is as tall as its tallest single tab and no taller.

          On the desktop it is `h-full`: the right-hand column is a two-row grid
          and this fills its row, which is the whole point — that row is exactly
          as tall as the filters/spacecraft card in the left column, so the two
          bottom cards match. It used to be a fixed `min(430px,52dvh)`, which
          agreed with the card opposite it only by accident, and on a short window
          with a deep action rail overflowed the column it sits in.

          The mobile sheet keeps its own height, because it is not in a column at
          all — it is a sheet pinned to the bottom edge. Its `min(430px,62dvh)` is
          also what the bottom action rail offsets itself by on tablets, and what
          the drawer's own bottom card is now sized to so the two agree there —
          keep all three in step. */}
      <div className={desktopMode
        ? "h-full bg-black/65 backdrop-blur-2xl border border-white/10 rounded-2xl p-3.5 shadow-2xl glass-panel flex flex-col gap-2 overflow-hidden"
        : "h-[min(430px,62dvh)] bg-black/85 backdrop-blur-2xl border border-white/10 rounded-t-2xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-2xl glass-panel animate-fade-up flex flex-col gap-2 overflow-hidden"
      }>

        {/* Header */}
        <div className="flex justify-between items-start gap-2 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full animate-pulse shrink-0"
                style={{ backgroundColor: headerColor, boxShadow: `0 0 10px ${headerColor}` }}
              />
              <span className="text-[9px] font-bold tracking-widest uppercase font-mono truncate" style={{ color: headerColor }}>
                {headerTag}
              </span>
            </div>
            <h2 className="text-base md:text-xl font-bold text-white font-mono leading-tight truncate">
              {headerName}
            </h2>
            {headerMeta && (
              <div className="text-[10px] font-mono text-gray-400 truncate" title={headerMeta}>
                {headerMeta}
              </div>
            )}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {selectedSat && <FavoriteStar sat={selectedSat} />}
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-colors"
              aria-label="Close details"
            >
              <X className="w-4 h-4 md:w-5 md:h-5" />
            </button>
          </div>
        </div>

        {/* Section tabs. These are what make the no-scroll rule affordable: the
            ground track and the pass list are full-size features, and stacking
            them under the figures is what used to overflow. */}
        {hasTabs && (
          <div
            className="grid gap-1 p-1 bg-white/[0.04] rounded-xl border border-white/10 shrink-0"
            style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
          >
            {tabs.map((t) => {
              const isOn = activeTab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  aria-pressed={isOn}
                  aria-label={t.label}
                  title={t.label}
                  className={`flex items-center justify-center gap-1 px-1.5 py-1.5 rounded-lg text-[10px] font-mono font-bold chip-btn border ${
                    isOn
                      ? 'bg-blue-600/70 border-blue-400/50 text-white shadow-[0_0_14px_-4px_rgba(59,130,246,0.7)]'
                      : 'border-transparent text-gray-400 hover:text-white hover:bg-white/[0.06]'
                  }`}
                >
                  <Icon className="w-3 h-3 shrink-0" />
                  {/* Five tabs across a 300 px phone leaves ~30 px per label,
                      which truncates every one of them to two characters — worse
                      than no label at all. So above four tabs the row goes
                      icon-only below `sm`; the name is still on the tooltip and
                      on aria-label. */}
                  <span className={tabs.length > 3 ? 'truncate hidden sm:inline' : 'truncate'}>{t.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {activeTab === 'data' && (
          <div className="space-y-2 min-h-0 flex-1 overflow-y-auto custom-scrollbar pr-0.5">
            {/* Provenance first, as a pair of headline cards: who owns it and
                when it went up are the two things you want before any of the
                live numbers mean anything. These were previously a single 10 px
                grey line under the title, which was easy to miss entirely. */}
            {selectedItem && (
              <div className="flex gap-1.5">
                <FactCard
                  icon={RadioTower}
                  iconTone="text-blue-400"
                  label="Country / Org"
                  value={selectedItem.country}
                />
                <FactCard
                  icon={Calendar}
                  iconTone="text-emerald-400"
                  label="Launch year"
                  value={selectedItem.launchYear ?? 'Unknown'}
                  title={selectedItem.launchYear
                    ? `Launch year ${selectedItem.launchYear}, from the international designator in this object's TLE`
                    : 'This object’s TLE carries no international designator, so its launch year is unknown'}
                />
              </div>
            )}

            <StatPanel
              title={selectedSat ? 'Live space dynamics'
                : selectedSolarSat ? 'Mission telemetry'
                : selectedBody?.kind === 'moon' ? 'Moon characteristics'
                : 'Planetary characteristics'}
              icon={selectedItem ? Rocket : Orbit}
              stats={stats}
            />

            {selectedSolarSat && (
              <SignalStrip oneWaySeconds={selectedSolarSat.altitude / 299792.458} />
            )}

            {/* Full text now that the pane scrolls. This used to be clamped to
                two lines precisely to avoid a scrollbar; with one available,
                truncating the description buys nothing. */}
            {headerFact && (
              <p className="text-[11px] text-gray-400 font-mono leading-snug bg-white/5 px-2.5 py-2 rounded-lg border border-white/5">
                {headerFact}
              </p>
            )}
          </div>
        )}

        {activeTab === 'track' && (
          <div className="min-h-0 flex-1 overflow-hidden flex flex-col items-center justify-center">
            {selectedSat && now && (
              <GroundTrack sat={selectedSat} now={now} observer={observerCoords} />
            )}
            {selectedSolarSat && (
              <div className="bg-white/5 border border-white/5 rounded-xl p-3 text-center font-mono space-y-1.5">
                <MapIcon className="w-6 h-6 text-gray-500 mx-auto" />
                <h4 className="text-[11px] font-bold text-gray-300">GROUND TRACK N/A</h4>
                <p className="text-[10px] text-gray-400 leading-snug">
                  Ground tracks exist only for Earth orbit. This spacecraft is at{' '}
                  {selectedSolarSat.planet} or in deep space.
                </p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'passes' && (
          <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar pr-0.5">
            {selectedSat && now && (
              // No compactLimit: the pane scrolls now, so every pass in the next
              // 24 h is reachable instead of three plus a "+N more" stub.
              <PassesPanel
                sat={selectedSat} observer={observerCoords} timeZone={timeZone} now={now}
                compact
                locationPermission={locationPermission}
                onRequestLocation={onRequestLocation}
              />
            )}
            {selectedSolarSat && (
              <div className="bg-white/5 border border-white/5 rounded-xl p-3 text-center font-mono space-y-1.5">
                <Radar className="w-6 h-6 text-gray-500 mx-auto" />
                <h4 className="text-[11px] font-bold text-gray-300">OVERHEAD PASSES N/A</h4>
                <p className="text-[10px] text-gray-400 leading-snug">
                  Passes are computed for Earth-orbiting objects. This one is far outside
                  Earth&apos;s orbit.
                </p>
              </div>
            )}
          </div>
        )}

        {activeTab === 'radio' && (
          <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar pr-0.5">
            {selectedSat && now && (
              <RadioPanel sat={selectedSat} observer={observerCoords} now={now} />
            )}
          </div>
        )}

        {/* Camera action last: it is the one control that changes the view
            behind the card, so it sits closest to the thumb. A planet also
            gets a cutaway button — the one thing you can do with a planet that
            you can't with a satellite. */}
        <div className="flex gap-1.5 shrink-0">
          <button
            onClick={() => onIsFocusedChange(!isFocused)}
            className={`flex-1 min-w-0 py-2 px-3 rounded-xl font-mono text-[10px] md:text-xs font-bold flex items-center justify-center gap-2 border btn-premium ${
              isFocused
                ? 'bg-red-500/20 border-red-500/50 text-red-400 hover:bg-red-500/30'
                : 'bg-blue-600/80 border-blue-500 text-white hover:bg-blue-600'
            }`}
          >
            <FocusIcon className={`w-3.5 h-3.5 md:w-4 md:h-4 shrink-0 ${isFocused ? 'animate-pulse' : ''}`} />
            <span className="truncate">{focusLabel}</span>
          </button>
          {planetInterior && (
            <button
              onClick={onExploreInterior}
              title={`See inside ${planetInterior.planet} — a to-scale cutaway of its real interior layers`}
              className="flex-1 min-w-0 py-2 px-3 rounded-xl font-mono text-[10px] md:text-xs font-bold flex items-center justify-center gap-2 border btn-premium bg-cyan-600/25 border-cyan-400/50 text-cyan-200 hover:bg-cyan-600/40"
            >
              <Layers className="w-3.5 h-3.5 md:w-4 md:h-4 shrink-0" />
              <span className="truncate">SEE INSIDE</span>
            </button>
          )}
          {selectedSat && (
            <button
              onClick={onCompare}
              title="Compare this satellite with another, side by side"
              className="shrink-0 py-2 px-3 rounded-xl font-mono text-[10px] md:text-xs font-bold flex items-center justify-center gap-2 border btn-premium bg-white/5 border-white/15 text-gray-200 hover:bg-white/10"
            >
              <Columns2 className="w-3.5 h-3.5 md:w-4 md:h-4 shrink-0" />
              <span className="hidden sm:inline">COMPARE</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main overlay
// ---------------------------------------------------------------------------

export function UIOverlay({
  satellites,
  selectedSat,
  onSelectSat,
  viewMode,
  onViewModeChange,
  selectedSolarSat,
  onSelectSolarSat,
  selectedBody,
  onSelectBody,
  simulatedTimeRef,
  isLoading,
  earthSettings,
  onEarthSettingsChange,
  solarSettings,
  onSolarSettingsChange,
  isFocused,
  onIsFocusedChange,
  selectedCategories,
  onSelectedCategoriesChange,
  selectedBands,
  onSelectedBandsChange,
  onSetSimulatedTime,
  onJumpSimulatedTime,
  onResetSimulatedTime,
  onResetView,
  sensitivity,
  onSensitivityChange,
  tourActive,
  tourStop,
  onStartTour,
  onStopTour,
  onSnapshot,
  onShare,
  shareCopied,
  sonificationEnabled,
  onSonificationEnabledChange,
  fullCatalog,
  onSetSimulatedYear,
  comparePicking,
  onComparePickingChange,
  comparePicked,
  onComparePickedConsumed,
}: UIOverlayProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const location = useUserLocation();
  const searchInputRef = useRef<HTMLInputElement>(null);

  // How tall the floating bottom action rail actually is, in px, measured.
  //
  // The desktop columns have to keep clear of it, and its height is genuinely not
  // knowable ahead of time: the chips wrap to a different number of rows at every
  // window width and in each view, and HISTORY / SCALE / the solar dock each add a
  // whole panel above them. The reserve used to be a fixed `pb-32 xl:pb-24`, which
  // was right for two rows of chips and wrong for everything else — on a
  // tablet-width lg window with the history scrubber open the rail stood ~250 px
  // tall and sat straight on top of the detail card and the categories card.
  // Measuring costs one ResizeObserver and cannot drift out of agreement with the
  // rail, which is exactly what a hand-tuned constant did.
  //
  // The node is held in state rather than a ref so that the observer is re-attached
  // if the rail is unmounted and remounted (kiosk mode does exactly that).
  const [railEl, setRailEl] = useState<HTMLDivElement | null>(null);
  const [railHeight, setRailHeight] = useState(0);
  useEffect(() => {
    if (!railEl || typeof ResizeObserver === 'undefined') return;
    // offsetHeight, not contentRect: the rail's own padding counts as space the
    // columns must stay out of.
    const measure = () => setRailHeight(railEl.offsetHeight);
    const ro = new ResizeObserver(measure);
    ro.observe(railEl);
    measure();
    return () => ro.disconnect();
  }, [railEl]);

  const issSatellite = useMemo(() => {
    return satellites.find(s => s.name.toUpperCase().includes('ISS') || s.name.toUpperCase().includes('ZARYA'));
  }, [satellites]);

  useEffect(() => {
    // The overlay clock ticks locally from the mutable time ref — the 3D
    // scene and app tree are not re-rendered by this.
    const id = setInterval(() => {
      const t = simulatedTimeRef.current;
      setNow(new Date(t));
      setOffsetMs(t.getTime() - Date.now());
    }, 250);
    return () => clearInterval(id);
  }, [simulatedTimeRef]);

  // "/" focuses the search from anywhere (desktop convenience)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const typing = el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Closing the card must also end the follow, not just drop the selection.
  // Focus with nothing selected is a dead state: the rig has nothing to track,
  // so it just leaves the camera parked wherever the flight ended.
  const clearSelection = () => {
    onSelectSat(null);
    onSelectSolarSat(null);
    onSelectBody(null);
    onIsFocusedChange(false);
  };

  const switchView = (mode: 'earth' | 'solar') => {
    onViewModeChange(mode);
    clearSelection();
    setSearchTerm('');
  };

  // "Track" is a camera promise, so it has to arm the follow as well as the
  // selection. Selecting alone only opens the detail card — which is why the
  // fleet's crosshair button used to do nothing visible on the globe.
  //
  // The order matters: `onSelectSat` clears focus (selecting a new object must
  // never leave the rig following the previous one), so focus is set after it.
  const trackSat = (sat: SatData) => {
    onSelectSat(sat);
    onIsFocusedChange(true);
  };

  const filteredItems = useMemo(() => {
    if (!searchTerm) return [];
    const term = searchTerm.toLowerCase();
    if (viewMode === 'earth') {
      return satellites
        .filter((sat) => {
          const matchCat = selectedCategories.length === 0 || selectedCategories.includes(sat.category);
          return matchCat && sat.name.toLowerCase().includes(term);
        })
        .slice(0, 50);
    }
    return SOLAR_SATELLITES
      .filter((sat) => sat.name.toLowerCase().includes(term) || sat.planet.toLowerCase().includes(term))
      .slice(0, 30);
  }, [satellites, searchTerm, selectedCategories, viewMode]);

  // Whether the selected satellite exists at the simulated time — SGP4 happily
  // propagates backwards past the launch date, so this must be checked here
  // or the table would show plausible-looking but historically wrong numbers.
  const notYetLaunched = Boolean(selectedSat && now && now.getTime() < selectedSat.launchMs);

  const realtimeInfo = useMemo(() => {
    if (!selectedSat || !now) return null;
    if (now.getTime() < selectedSat.launchMs) return null;
    return getSatelliteRealtimeInfo(selectedSat.satrec, now);
  }, [selectedSat, now]);

  const hasSelection = Boolean(selectedSat || selectedSolarSat || selectedBody);
  const selectionKey = selectedSat?.name
    ?? selectedSolarSat?.name
    ?? (selectedBody ? (selectedBody.kind === 'moon' ? selectedBody.moon!.name : selectedBody.planet.name) : '');

  // The interior explorer is only offered for a selected PLANET (not a moon or
  // a satellite), and only for the eight it has measured data for — which is
  // all of them. Opening it is a separate action from selecting the planet.
  const planetInterior = useMemo(
    () => (selectedBody?.kind === 'planet'
      ? INTERIOR_BY_PLANET.get(selectedBody.planet.name) ?? null
      : null),
    [selectedBody]
  );
  const planetTextureUrl = selectedBody?.kind === 'planet' ? selectedBody.planet.textureUrl : undefined;
  const [interiorOpen, setInteriorOpen] = useState(false);
  // Close the explorer whenever the selection changes out from under it.
  useEffect(() => { setInteriorOpen(false); }, [selectionKey]);

  // ----- The opt-in feature surfaces -----
  // ONE piece of state for all of them, because they are genuinely exclusive:
  // every one of these either fills the screen or sits in the same slot above
  // the rail, so two open at once is never useful and — as the SCALE-then-
  // HISTORY case showed — actively broken-looking. Opening any of them closes
  // whichever was open. The boolean/setter pairs below keep every call site a
  // one-liner, exactly as when each had its own useState.
  type PanelId = 'dashboard' | 'briefing' | 'compare' | 'sky' | 'scrubber' | 'scale';
  const [panel, setPanel] = useState<PanelId | null>(null);
  /** `set(true)` makes `id` the one open panel; `set(false)` closes it, but only
   *  if it is still the open one — so a stale close from an unmounting panel
   *  can't shut the surface that replaced it. */
  const openPanel = (id: PanelId) => (open: boolean) =>
    setPanel((cur) => (open ? id : cur === id ? null : cur));

  const dashboardOpen = panel === 'dashboard';
  const briefingOpen = panel === 'briefing';
  const compareOpen = panel === 'compare';
  const skyOpen = panel === 'sky';
  const scrubberOpen = panel === 'scrubber';
  const scaleOpen = panel === 'scale';
  const setDashboardOpen = openPanel('dashboard');
  const setBriefingOpen = openPanel('briefing');
  const setCompareOpen = openPanel('compare');
  const setSkyOpen = openPanel('sky');
  const setScrubberOpen = openPanel('scrubber');
  const setScaleOpen = openPanel('scale');

  // Split-screen "pick from the globe": while a side is active, a satellite
  // click on the 3D scene feeds THAT column instead of changing the app's
  // selection. The picking state lives in the app root (that is where the globe
  // click is handled), and is threaded in through props; here we only drive the
  // panel and clear a half-finished pick when compare closes.
  const requestComparePick = (side: 'A' | 'B') =>
    onComparePickingChange(comparePicking === side ? null : side);
  useEffect(() => {
    if (!compareOpen) { onComparePickingChange(null); onComparePickedConsumed(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareOpen]);
  // Planetarium/kiosk mode: hide every chrome layer and let the scene fill the
  // screen. Nothing unmounts — the overlay is simply not rendered — so leaving
  // kiosk mode restores the exact same panels, selection and scroll positions.
  const [kiosk, setKiosk] = useState(false);

  // The daily briefing offers itself once per day, on a delay so it never
  // competes with the startup animation. Storage decides; see lib/briefing.
  useEffect(() => {
    if (!now) return;
    if (briefingSeenToday(now)) return;
    const t = setTimeout(() => setBriefingOpen(true), 4000);
    return () => clearTimeout(t);
    // Deliberately keyed on nothing but mount: `now` ticks 4×/s and would
    // otherwise restart this timer forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape leaves kiosk mode. Without this the only exit on a desktop with no
  // visible chrome would be a page reload.
  useEffect(() => {
    if (!kiosk) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setKiosk(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kiosk]);

  // The Earth-only surfaces (sky chart, orbit dashboard, split compare, history
  // scrubber) are launched from rail buttons that only exist in Earth view. If
  // one is open when the user switches to the Solar System, close it — otherwise
  // it would hang around with no matching control to dismiss it from.
  useEffect(() => {
    if (viewMode === 'earth') return;
    setPanel((cur) =>
      cur === 'sky' || cur === 'dashboard' || cur === 'compare' || cur === 'scrubber'
        ? null
        : cur
    );
  }, [viewMode]);

  // The user's fleet, resolved against the live catalog. resolveFavorites reads
  // the fleet store directly, so the subscription snapshot (favoriteIds) is what
  // makes this recompute on a pin/unpin — hence it is a real dependency even
  // though the eslint rule cannot see it used in the body.
  const favoriteIds = useFavorites();
  const fleet = useMemo(
    () => resolveFavorites(fullCatalog),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fullCatalog, favoriteIds]
  );

  const searchBox = (
    <div className="relative group">
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 group-focus-within:text-blue-400 transition-colors pointer-events-none" />
      <input
        ref={searchInputRef}
        type="text"
        placeholder={viewMode === 'earth' ? 'Search satellites, stations, debris…' : 'Search probes & spacecraft…'}
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setSearchTerm('');
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-full bg-black/50 border border-white/10 rounded-full py-2.5 pl-11 pr-12 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500/70 focus:bg-black/70 focus:shadow-[0_0_0_3px_rgba(59,130,246,0.12),0_8px_32px_-8px_rgba(59,130,246,0.5)] hover:border-white/25 transition-all duration-300 backdrop-blur-xl"
      />
      {searchTerm ? (
        <button
          onClick={() => setSearchTerm('')}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white p-1 rounded-full hover:bg-white/10 transition-colors"
          aria-label="Clear search"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      ) : (
        <kbd className="hidden md:flex absolute right-4 top-1/2 -translate-y-1/2 items-center justify-center w-5 h-5 text-[10px] font-mono text-gray-500 border border-white/15 rounded bg-white/5 pointer-events-none">
          /
        </kbd>
      )}
    </div>
  );

  const searchResults = searchTerm && (
    <div className="bg-black/90 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-2xl shadow-2xl z-20 animate-fade-up">
      <div className="px-4 py-2 border-b border-white/5 flex items-center justify-between text-[9px] font-mono uppercase tracking-widest text-gray-500">
        <span>
          {filteredItems.length === 0
            ? 'No matches'
            : `${filteredItems.length} result${filteredItems.length === 1 ? '' : 's'}`}
        </span>
        <span>{viewMode === 'earth' ? 'Earth orbit' : 'Solar system'}</span>
      </div>
      <div className="max-h-64 overflow-y-auto custom-scrollbar">
        {filteredItems.length === 0 ? (
          <div className="p-4 text-sm text-gray-400 font-mono">No objects match &ldquo;{searchTerm}&rdquo;.</div>
        ) : (
          filteredItems.map((item) => {
            const isEarth = 'satrec' in item;
            return (
              <button
                key={item.name}
                onClick={() => {
                  if (isEarth) {
                    onSelectSat(item as SatData);
                    onSelectSolarSat(null);
                  } else {
                    onSelectSolarSat(item as SolarSat);
                    onSelectSat(null);
                  }
                  setSearchTerm('');
                  setDrawerOpen(false);
                }}
                className="w-full text-left px-4 py-2.5 text-sm hover:bg-white/10 flex items-center justify-between gap-2 row-hover border-b border-white/5 last:border-0"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: item.color, boxShadow: `0 0 6px ${item.color}` }}
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="font-mono text-white font-medium truncate">{item.name}</span>
                    <span className="text-[10px] text-gray-500 truncate">
                      {isEarth
                        ? `${(item as SatData).band} · ${(item as SatData).type}`
                        : (item as SolarSat).type}
                    </span>
                  </div>
                </div>
                <span
                  className="text-[9px] font-bold uppercase px-2 py-0.5 rounded-md whitespace-nowrap tracking-wider font-mono shrink-0"
                  style={{
                    backgroundColor: `${item.color}22`,
                    color: item.color,
                    border: `1px solid ${item.color}44`,
                  }}
                >
                  {isEarth ? (item as SatData).category : (item as SolarSat).planet}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  const timePanel = (
    <TimeAndScenePanel
      viewMode={viewMode}
      now={now}
      offsetMs={offsetMs}
      timeZone={location.timeZone}
      locationSource={location.source}
      earthSettings={earthSettings}
      onEarthSettingsChange={onEarthSettingsChange}
      solarSettings={solarSettings}
      onSolarSettingsChange={onSolarSettingsChange}
      onSetSimulatedTime={onSetSimulatedTime}
      onJumpSimulatedTime={onJumpSimulatedTime}
      onResetSimulatedTime={onResetSimulatedTime}
      sensitivity={sensitivity}
      onSensitivityChange={onSensitivityChange}
    />
  );

  // ---- LEFT COLUMN, TOP CARD ----
  // Earth view: the user's OWN data, and the most perishable thing on screen.
  // Solar view: space weather, alone in its own card. It used to be tacked on
  // under the spacecraft list, where a live readout about *right now* sat below
  // thirty-five rows of hardware and was never seen.
  const topLeftPanel = viewMode === 'earth' ? (
    <div className="space-y-4">
      {/* The fleet and its alerts lead: they are the user's OWN data, and the
          next pass over their head is the most perishable thing on screen.
          Filters used to sit at the bottom of this same column, which buried
          three short, personal sections under a long scrolling list. They now
          live in the card below this one. */}
      <OverheadAlertsPanel
        fleet={fleet}
        observer={location.coords}
        onSelectSat={(sat) => { onSelectSat(sat); setDrawerOpen(false); }}
        locationPermission={location.permission}
        onRequestLocation={location.request}
      />
      <div className="border-t border-white/5 pt-3">
        <FavoritesPanel
          satellites={fullCatalog}
          selectedSat={selectedSat}
          onSelectSat={(sat) => { onSelectSat(sat); setDrawerOpen(false); }}
          onTrackSat={(sat) => { trackSat(sat); setDrawerOpen(false); }}
        />
      </div>
      <div className="border-t border-white/5 pt-3">
        <UpcomingLaunches />
      </div>
    </div>
  ) : (
    <SpaceWeather />
  );

  // ---- LEFT COLUMN, BOTTOM CARD ----
  // Earth view: the catalog filters. Solar view: the spacecraft list.
  //
  // Both scroll INTERNALLY (CategoriesPanel caps its own list, ProbesPanel is a
  // flex column with a sticky header), so this card can sit against the bottom
  // edge of the viewport without ever pushing the top card off screen.
  const bottomLeftPanel = viewMode === 'earth' ? (
    <CategoriesPanel
      satellites={satellites}
      selectedCategories={selectedCategories}
      onSelectedCategoriesChange={onSelectedCategoriesChange}
      selectedBands={selectedBands}
      onSelectedBandsChange={onSelectedBandsChange}
    />
  ) : (
    <ProbesPanel
      selectedSolarSat={selectedSolarSat}
      onSelectSolarSat={onSelectSolarSat}
      onSelectSat={onSelectSat}
      simYear={now ? now.getUTCFullYear() : null}
    />
  );

  // Kiosk / planetarium mode: nothing but the scene and a single way back.
  // A short-lived hint fades out so an unattended display ends up completely
  // clean, while a person who just pressed the button still sees the exit.
  if (kiosk) {
    return (
      <div className="absolute inset-0 pointer-events-none z-10 text-white font-sans">
        <button
          onClick={() => setKiosk(false)}
          title="Leave planetarium mode (Esc)"
          className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-3 pointer-events-auto p-2.5 rounded-full bg-black/40 backdrop-blur-md border border-white/10 text-gray-400 hover:text-white hover:border-white/30 opacity-30 hover:opacity-100 transition-opacity"
          aria-label="Leave planetarium mode"
        >
          <Minimize2 className="w-4 h-4" />
        </button>
        <div className="absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 text-[10px] font-mono text-gray-500 tracking-widest uppercase animate-kiosk-hint">
          Planetarium mode · Esc to exit
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 pointer-events-none z-10 text-white font-sans">

      {/* While the tour flies, everything else steps aside — the point of the
          tour is the view, not the instrumentation. */}
      {tourActive && <TourBanner stop={tourStop} onStop={onStopTour} />}

      {!tourActive && (
      <>

      {/* ================= MOBILE / TABLET TOP BAR =================
          Everything below `lg` uses the drawer layout, not just phones. The
          three-column desktop layout needs ~1024 px to fit (256 px of filters +
          320 px of detail card + a usable search box between them); at the old
          `md` breakpoint a portrait tablet got all three crushed together with
          a 130 px search field. The drawer layout has no such floor — it works
          at any width — so the whole md range now gets it.

          The floor for THIS bar is 300 px. At that width the clock and the donate
          button drop out (both are one tap away in the drawer) and only the menu
          and the wordmark survive. The wordmark sits on bare gradient with no card
          behind it, and Home is NOT duplicated here — it lives on the bottom
          action rail only. */}
      <div className="lg:hidden absolute top-0 inset-x-0 flex items-center gap-1.5 sm:gap-2 p-2 pt-[max(0.5rem,env(safe-area-inset-top))] pointer-events-auto bg-gradient-to-b from-black/70 to-transparent">
        <button
          onClick={() => setDrawerOpen(true)}
          className="shrink-0 p-2 sm:p-2.5 rounded-xl bg-black/60 border border-white/10 backdrop-blur-md active:bg-white/10"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center min-w-0 flex-1 px-0.5 overflow-hidden">
          <SiteWordmark className="text-[13px] sm:text-sm" />
        </div>
        <div className="hidden sm:block shrink-0">
          <DonateButton compact />
        </div>
        <div className="hidden sm:block shrink-0 bg-black/60 border border-white/10 backdrop-blur-md rounded-xl px-2.5 py-1.5 text-[10px] font-mono text-blue-400" suppressHydrationWarning>
          {now
            ? now.toLocaleTimeString('en-US', { timeZone: location.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            : '--:--:--'}
        </div>
      </div>

      {/* ================= MOBILE / TABLET DRAWER ================= */}
      {drawerOpen && (
        <div
          className="lg:hidden absolute inset-0 bg-black/60 pointer-events-auto z-30"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <div
        className={`lg:hidden absolute top-0 left-0 h-full w-[86vw] max-w-sm bg-[#05070d]/95 backdrop-blur-2xl border-r border-white/10 z-40 pointer-events-auto transform transition-transform duration-300 flex flex-col ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between gap-2 p-3 sm:p-4 border-b border-white/10 shrink-0">
          <div className="min-w-0">
            <SiteWordmark className="text-sm" />
            <div className="flex items-center gap-1.5 mt-1">
              <span className="relative flex h-1.5 w-1.5 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500"></span>
              </span>
              <span className="text-[9px] text-gray-400 font-mono uppercase tracking-wider whitespace-nowrap">
                {isLoading ? 'LOADING TLE...' : `${satellites.length.toLocaleString()} ACTIVE`}
              </span>
            </div>
          </div>
          <button onClick={() => setDrawerOpen(false)} className="shrink-0 p-2 rounded-full hover:bg-white/10" aria-label="Close menu">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-3 sm:p-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-3 sm:space-y-4 overflow-y-auto custom-scrollbar flex-1">
          <div className="space-y-2">
            {searchBox}
            {searchResults}
          </div>
          <div className="flex justify-center">
            <ViewSwitcher viewMode={viewMode} onSwitch={switchView} />
          </div>
          {/* Donate lives here on phones, where the top bar has no room for it
              below 640 px. */}
          <div className="flex justify-center sm:hidden">
            <DonateButton />
          </div>
          {/* The time card and the alerts/fleet card, each at its own content
              height.

              These two used to be a `grid grid-rows-2`, forcing both to the
              height of the taller one. That was the right shape for the desktop
              columns, where the two cards sit side by side and the eye compares
              them. It is the wrong shape HERE: nothing is beside anything in a
              one-column drawer, so the only thing equal heights bought was a
              block of dead space inside whichever card was shorter — which is
              exactly the "this card is far too tall" report, since the time panel
              is the shorter one whenever the alerts list has anything in it.

              `min-w-0` on both: they are flex items in the drawer's column, and
              without it a card whose content has an intrinsic minimum width can
              push past the drawer instead of being the thing that adapts. */}
          <div className="space-y-3 sm:space-y-4">
            <div className="bg-white/5 rounded-xl p-3 border border-white/5 min-w-0">{timePanel}</div>
            <div className="bg-white/5 rounded-xl p-3 border border-white/5 min-w-0">{topLeftPanel}</div>
          </div>
          {/* The filters / spacecraft card, sized to the detail sheet exactly.
              `min(430px,62dvh)` is the mobile sheet's height in InfoCard — the two
              are what the user compares, and on a phone they are never side by
              side (the sheet is at the bottom edge, this is in the drawer over it),
              so matching the number is the only way they can agree. It was
              `max-h-[70vh]`, a cap nothing else in the app shared. Fixed rather
              than capped, so a short list (solar view's handful of spacecraft)
              gives the same card as a long one. */}
          <div className="bg-white/5 rounded-xl p-3 border border-white/5 h-[min(430px,62dvh)] overflow-hidden flex flex-col">
            {bottomLeftPanel}
          </div>
        </div>
      </div>

      {/* ================= DESKTOP LAYOUT =================
          `lg` and up only — see the top-bar note for why the tablet range gets
          the drawer instead.
          The bottom padding is not cosmetic: the action rail floats over this
          same bottom edge, and without reserved space the right column's detail
          card slid underneath it (FOCUS TRACKING CAMERA disappearing behind the
          chips).

          The reserve is the rail's MEASURED height plus its own bottom offset and
          a small gap. A constant cannot do this job: the chips wrap to two rows at
          1024 px and one at 1600, the rail also hosts the history scrubber, the
          scale panel and the solar dock, and each of those is a full panel that
          appears above the chips. `pb-32 xl:pb-24` was tuned for the bare
          two-row case, so opening HISTORY on a tablet-width window pushed the rail
          up over the detail card and the categories card — the exact overlap this
          replaces. The Tailwind classes stay as the value for the first frame,
          before the observer has reported. */}
      <div
        className="hidden lg:flex flex-col justify-between h-full p-4 lg:p-6 pb-32 xl:pb-24"
        style={
          railHeight
            ? { paddingBottom: `calc(${railHeight}px + max(1rem, env(safe-area-inset-bottom)) + 0.75rem)` }
            : undefined
        }
      >
        <div className="flex flex-row justify-between items-start gap-4 w-full h-full min-h-0">

          {/* ---- LEFT COLUMN ----
              Two cards splitting the column 46 / 54, top and bottom. The bottom
              slot is where the catalog filters live in Earth view and the
              spacecraft list in solar view — both were on the right before, which
              put the longest lists in the same column as the detail card and
              pushed it off screen.

              A GRID with `fr` rows rather than a flex column, and this is what
              makes the right-hand column able to match it card for card: `fr`
              divides the space that is left AFTER the gap, so 46fr / 54fr with the
              same gap in both columns produces the same two heights on both sides
              of the screen — the time card exactly as tall as the alerts card, the
              detail card exactly as tall as the filters. As `max-h` percentages on
              a flex column (what this was) each card was content-height CAPPED at
              its share, so the two columns only agreed when both happened to be
              at their cap, which in the solar view — a short space-weather
              readout against a full time panel — they never were.
              The cost is that the shorter card of a pair now has empty space at
              the bottom instead of shrink-wrapping its content; that is the
              literal price of the two columns lining up.

              The fractions themselves are of the COLUMN, not of the viewport.
              They were `46vh`/`46vh`, which ignores the space the action rail is
              holding at the bottom: on a 820 px-tall tablet window with the rail
              three rows deep, 46vh of top card left the filters ~100 px. Each card
              scrolls INSIDE itself, so neither can ever grow the column. */}
          <div className="grid grid-rows-[46fr_54fr] gap-3 w-64 lg:w-72 shrink-0 h-full min-h-0 pointer-events-auto">
            {/* `self-start` in the solar view: the row is still 46 % (so the card
                below it stays level with the detail card opposite), but a short
                space-weather readout is not STRETCHED to fill it — it was one
                small panel in a very tall pane of glass. In Earth view the card
                does fill its row, because that is the one the time card has to
                match. */}
            <div className={`bg-black/55 backdrop-blur-xl p-3 lg:p-4 rounded-2xl border border-white/10 shadow-2xl min-h-0 overflow-y-auto custom-scrollbar glass-panel animate-fade-up ${
              viewMode === 'solar' ? 'self-start max-h-full' : ''
            }`}>
              {topLeftPanel}
            </div>
            <div className="bg-black/55 backdrop-blur-xl p-3 lg:p-4 rounded-2xl border border-white/10 shadow-2xl glass-panel animate-fade-up min-h-0 flex flex-col overflow-hidden">
              {bottomLeftPanel}
            </div>
          </div>

          {/* Wordmark and donate on top, section switcher under it, search
              beneath that. Results drop from the search box downward over empty
              sky, so nothing below has to move while you type and neither the
              switcher nor the wordmark ever shifts. */}
          <div className="flex flex-col items-center gap-2.5 w-full min-w-0 max-w-sm lg:max-w-md mx-auto pointer-events-auto">
            <div className="flex items-center gap-3 max-w-full">
              <SiteWordmark className="text-base lg:text-lg" />
              <DonateButton compact />
            </div>
            <ViewSwitcher viewMode={viewMode} onSwitch={switchView} />
            <div className="relative w-full">
              {searchBox}
              {searchResults && (
                <div className="absolute top-full left-0 right-0 mt-2 z-20">{searchResults}</div>
              )}
            </div>
          </div>

          {/* Right Side: timePanel and InfoCard vertically stacked.

              Row 1 is `auto`: the time card is sized by its CONTENT, so it never
              scrolls — the whole panel (SIM TIME, warp, time travel) is always
              visible at once. That is a deliberate trade against the 46fr row it
              used to have, which made it exactly as tall as the alerts card
              opposite but gave it an internal scrollbar to pay for it. Row 2
              takes what is left, so the detail card still cannot fall off the
              bottom edge. */}
          <div className="grid grid-rows-[auto_1fr] gap-3 w-80 lg:w-96 h-full min-h-0 shrink-0 pointer-events-auto">
            <div className="bg-black/40 backdrop-blur-md p-3 lg:p-4 rounded-2xl border border-white/5 shadow-2xl glass-panel animate-fade-up">
              {timePanel}
            </div>
            {hasSelection && (
              <div className="w-full min-h-0">
                <InfoCard
                  key={selectionKey}
                  selectedSat={selectedSat}
                  selectedSolarSat={selectedSolarSat}
                  selectedBody={selectedBody}
                  realtimeInfo={realtimeInfo}
                  notYetLaunched={notYetLaunched}
                  isFocused={isFocused}
                  onIsFocusedChange={onIsFocusedChange}
                  onClose={clearSelection}
                  observerCoords={location.coords}
                  timeZone={location.timeZone}
                  now={now}
                  planetInterior={planetInterior}
                  onExploreInterior={() => setInteriorOpen(true)}
                  onCompare={() => setCompareOpen(true)}
                  locationPermission={location.permission}
                  onRequestLocation={location.request}
                  desktopMode={true}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ================= BOTTOM ACTION RAIL =================
          Quick-nav dock (Solar view) stacked over the camera actions.

          Three different arrangements, because the bottom edge is contested by
          the info sheet and there is a different amount of room in each range:
            • phone, sheet up      → the rail steps aside entirely. A 430 px sheet
              plus a three-row rail does not fit above a phone's keyboardless
              600-odd px, and the sheet is what the user just asked for.
            • tablet, sheet up     → the rail moves ABOVE the sheet rather than
              across it: the sheet is at most 62dvh tall, so offsetting the rail by
              exactly that leaves both fully visible and reachable. This is the case
              that was broken — HISTORY and its neighbours landed across the
              satellite detail card and the categories list. The 430px/62dvh in the
              offset below must stay in step with the sheet's own height in
              InfoCard; Tailwind only sees literal class names, so the two cannot
              share a constant.
            • lg and up            → the sheet is gone (the detail card moves into
              the right column) and the rail returns to the bottom edge, where the
              desktop layout reserves its measured height.

          The width is deliberately non-monotonic. In the md range the drawer
          layout leaves the entire viewport free, so the rail (and the scrubber
          / scale panel it hosts) may spread out and the chips fit in fewer
          rows; from lg up the desktop columns flank this same bottom edge, so
          it goes back to 44rem to stay clear of them.

          Its height is measured (see railEl above) and handed to the desktop
          layout as reserved padding, because everything in here is optional and
          wraps: how tall it ends up is a runtime fact, not a design constant. */}
      <div
        ref={setRailEl}
        className={`absolute left-1/2 -translate-x-1/2 w-[min(96vw,44rem)] md:w-[min(94vw,54rem)] lg:w-[min(96vw,44rem)] flex flex-col items-center gap-2 pointer-events-none ${
          hasSelection
            ? 'hidden md:flex md:bottom-[calc(min(430px,62dvh)_+_0.75rem)] lg:bottom-[max(1rem,env(safe-area-inset-bottom))]'
            : 'flex bottom-[max(1rem,env(safe-area-inset-bottom))]'
        }`}
      >
        {viewMode === 'earth' && scrubberOpen && now && (
          <HistoryScrubber
            satellites={fullCatalog}
            simYear={now.getUTCFullYear()}
            onSetYear={onSetSimulatedYear}
            onPlay={() => {
              // "Play" hands the year over to the scrubber's own wall-clock
              // ticker (one year per PLAY_YEAR_STEP_MS — 3 s), so the app
              // clock stays at 1x and SGP4 keeps propagating honestly inside
              // each year. Cranking `timeSpeed` to the ~10,500,000x that a
              // year-per-3-seconds warp would need steps the propagator by
              // months per frame, which is not a fast movie — it is noise.
              onSetSimulatedYear(PLAY_START_YEAR);
              onEarthSettingsChange({ ...earthSettings, realTime: false, enableMovement: true, timeSpeed: 1 });
            }}
            onClose={() => setScrubberOpen(false)}
          />
        )}

        {scaleOpen && (
          <ScalePanel
            view={viewMode}
            selectedSat={selectedSat}
            now={now ?? new Date()}
            onClose={() => setScaleOpen(false)}
          />
        )}

        {viewMode === 'solar' && (
          <SolarDock
            selectedBody={selectedBody}
            onSelectBody={onSelectBody}
            onIsFocusedChange={onIsFocusedChange}
            onClearSelection={() => {
              onSelectSat(null);
              onSelectSolarSat(null);
              onSelectBody(null);
              onIsFocusedChange(false);
            }}
          />
        )}

        {/* The chips wrap, so the rail grows upward rather than overflowing. At
            300 px that is three rows: only the actions whose icon is ambiguous
            keep a label below `sm` (OVERVIEW / ISS / TOUR), everything
            else goes icon-only, and the horizontal padding halves. Vertical
            padding is deliberately NOT reduced — these are touch targets. */}
        <div className="flex flex-wrap items-center justify-center gap-1 sm:gap-1.5 pointer-events-auto">
          {viewMode === 'earth' && (
            <button
              onClick={onResetView}
              title="Overview — back over the equator, north up"
              className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full bg-black/60 backdrop-blur-xl border border-white/10 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:text-white hover:border-white/30 chip-btn shadow-2xl"
            >
              <Compass className="w-3.5 h-3.5 text-blue-400" />
              OVERVIEW
            </button>
          )}

          {viewMode === 'solar' && (
            <button
              onClick={onResetView}
              title="Fly back to the whole solar system overview"
              className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full bg-black/60 backdrop-blur-xl border border-white/10 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:text-white hover:border-white/30 chip-btn shadow-2xl"
            >
              <Orbit className="w-3.5 h-3.5 text-amber-400" />
              OVERVIEW
            </button>
          )}

          {viewMode === 'earth' && issSatellite && (
            <button
              onClick={() => {
                onSelectSat(issSatellite);
                onIsFocusedChange(true);
              }}
              title="Quickfind: Track the International Space Station (ISS)"
              className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full bg-gradient-to-r from-blue-600/80 to-indigo-600/80 hover:brightness-110 backdrop-blur-xl border border-blue-400/50 text-[10px] font-mono font-bold tracking-widest text-white chip-btn shadow-2xl"
            >
              <Radio className="w-3.5 h-3.5 text-blue-300 animate-pulse" />
              ISS
            </button>
          )}

          <button
            onClick={() => onSonificationEnabledChange(!sonificationEnabled)}
            title={sonificationEnabled ? "Mute ambient space music" : "Enable ambient space music (Music of the Spheres)"}
            className={`flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full backdrop-blur-xl border text-[10px] font-mono font-bold tracking-widest chip-btn shadow-2xl transition-colors ${
              sonificationEnabled
                ? 'bg-fuchsia-500/20 border-fuchsia-400/50 text-fuchsia-300 animate-pulse'
                : 'bg-black/60 border-white/10 text-gray-300 hover:text-white hover:border-fuchsia-400/40'
            }`}
          >
            {sonificationEnabled ? (
              <Volume2 className="w-3.5 h-3.5 text-fuchsia-400" />
            ) : (
              <VolumeX className="w-3.5 h-3.5 text-gray-500" />
            )}
            <span className="hidden sm:inline">MUSIC</span>
          </button>

          <button
            onClick={onStartTour}
            title="Fly a guided tour from the Sun out to Neptune"
            className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full bg-black/60 backdrop-blur-xl border border-white/10 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:text-white hover:border-amber-400/40 chip-btn shadow-2xl"
          >
            <Film className="w-3.5 h-3.5 text-amber-400" />
            TOUR
          </button>

          <button
            onClick={onSnapshot}
            title="Save this view as a captioned PNG"
            className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full bg-black/60 backdrop-blur-xl border border-white/10 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:text-white hover:border-cyan-400/40 chip-btn shadow-2xl"
          >
            <Camera className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">POSTCARD</span>
          </button>

          {viewMode === 'earth' && (
            <button
              onClick={() => setSkyOpen(true)}
              title="What's above you right now — a live chart of your own sky"
              className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full bg-black/60 backdrop-blur-xl border border-white/10 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:text-white hover:border-indigo-400/40 chip-btn shadow-2xl"
            >
              <Telescope className="w-3.5 h-3.5 text-indigo-400" />
              <span className="hidden sm:inline">MY SKY</span>
            </button>
          )}

          {viewMode === 'earth' && (
            <button
              onClick={() => setDashboardOpen(true)}
              title="The state of Earth orbit on one screen — population, shells, owners, debris"
              className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full bg-black/60 backdrop-blur-xl border border-white/10 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:text-white hover:border-violet-400/40 chip-btn shadow-2xl"
            >
              <Activity className="w-3.5 h-3.5 text-violet-400" />
              <span className="hidden sm:inline">DASHBOARD</span>
            </button>
          )}

          {viewMode === 'earth' && (
            <button
              onClick={() => setScrubberOpen(!scrubberOpen)}
              title="Drag through the space age, 1957 to today"
              className={`flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full backdrop-blur-xl border text-[10px] font-mono font-bold tracking-widest chip-btn shadow-2xl transition-colors ${
                scrubberOpen
                  ? 'bg-orange-500/20 border-orange-400/50 text-orange-200'
                  : 'bg-black/60 border-white/10 text-gray-300 hover:text-white hover:border-orange-400/40'
              }`}
            >
              <History className="w-3.5 h-3.5 text-orange-400" />
              <span className="hidden sm:inline">HISTORY</span>
            </button>
          )}

          <button
            onClick={() => setScaleOpen(!scaleOpen)}
            title="How much this view exaggerates, and what the distances actually mean"
            className={`flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full backdrop-blur-xl border text-[10px] font-mono font-bold tracking-widest chip-btn shadow-2xl transition-colors ${
              scaleOpen
                ? 'bg-cyan-500/20 border-cyan-400/50 text-cyan-200'
                : 'bg-black/60 border-white/10 text-gray-300 hover:text-white hover:border-cyan-400/40'
            }`}
          >
            <Ruler className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">SCALE</span>
          </button>

          <button
            onClick={() => setBriefingOpen(true)}
            title="Today's space briefing"
            className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full bg-black/60 backdrop-blur-xl border border-white/10 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:text-white hover:border-blue-400/40 chip-btn shadow-2xl"
          >
            <Newspaper className="w-3.5 h-3.5 text-blue-400" />
            <span className="hidden sm:inline">BRIEFING</span>
          </button>

          {viewMode === 'earth' && (
            <button
              onClick={() => setCompareOpen(true)}
              title="Compare two satellites side by side"
              className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full bg-black/60 backdrop-blur-xl border border-white/10 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:text-white hover:border-white/30 chip-btn shadow-2xl"
            >
              <Columns2 className="w-3.5 h-3.5 text-gray-300" />
              <span className="hidden sm:inline">COMPARE</span>
            </button>
          )}

          <button
            onClick={() => setKiosk(true)}
            title="Planetarium mode — hide everything but the scene"
            className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full bg-black/60 backdrop-blur-xl border border-white/10 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:text-white hover:border-white/30 chip-btn shadow-2xl"
          >
            <Maximize2 className="w-3.5 h-3.5 text-gray-300" />
            <span className="hidden sm:inline">KIOSK</span>
          </button>

          <button
            onClick={onShare}
            title="Copy a link that opens on exactly this scene"
            className={`flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-2 rounded-full backdrop-blur-xl border text-[10px] font-mono font-bold tracking-widest chip-btn shadow-2xl transition-colors ${
              shareCopied
                ? 'bg-emerald-500/20 border-emerald-400/50 text-emerald-300'
                : 'bg-black/60 border-white/10 text-gray-300 hover:text-white hover:border-emerald-400/40'
            }`}
          >
            {shareCopied
              ? <Link2 className="w-3.5 h-3.5 text-emerald-300" />
              : <Share2 className="w-3.5 h-3.5 text-emerald-400" />}
            <span className="hidden sm:inline">{shareCopied ? 'COPIED' : 'SHARE'}</span>
          </button>
        </div>
      </div>

      {/* ================= INFO CARD (bottom sheet — below lg) ================= */}
      {hasSelection && (
        <div className="lg:hidden">
          <InfoCard
            key={selectionKey}
            selectedSat={selectedSat}
            selectedSolarSat={selectedSolarSat}
            selectedBody={selectedBody}
            realtimeInfo={realtimeInfo}
            notYetLaunched={notYetLaunched}
            isFocused={isFocused}
            onIsFocusedChange={onIsFocusedChange}
            onClose={clearSelection}
            observerCoords={location.coords}
            timeZone={location.timeZone}
            now={now}
            planetInterior={planetInterior}
            onExploreInterior={() => setInteriorOpen(true)}
            onCompare={() => setCompareOpen(true)}
            locationPermission={location.permission}
            onRequestLocation={location.request}
            desktopMode={false}
          />
        </div>
      )}

      {/* ================= PLANET INTERIOR EXPLORER =================
          Full-screen cutaway modal, shared by both layouts. Lazy-loaded, so
          its WebGL canvas and material generator never touch startup. */}
      {interiorOpen && planetInterior && (
        <PlanetInteriorPanel
          interior={planetInterior}
          textureUrl={planetTextureUrl}
          onClose={() => setInteriorOpen(false)}
        />
      )}

      {/* ================= OPT-IN FEATURE MODALS =================
          Each is lazy-loaded and mounted only while open, so none of them ever
          touches startup and closing one frees it. */}
      {dashboardOpen && (
        <DashboardPanel satellites={fullCatalog} onClose={() => setDashboardOpen(false)} />
      )}

      {briefingOpen && now && (
        <BriefingPanel
          satellites={fullCatalog}
          now={now}
          observer={location.coords}
          issSat={issSatellite ?? null}
          onClose={() => setBriefingOpen(false)}
        />
      )}

      {compareOpen && (
        <ComparePanel
          satellites={fullCatalog}
          initialSat={selectedSat}
          now={now ?? new Date()}
          pickingSide={comparePicking}
          onRequestPick={requestComparePick}
          picked={comparePicked}
          onPickedConsumed={onComparePickedConsumed}
          onClose={() => setCompareOpen(false)}
        />
      )}

      {skyOpen && (
        <SkyView
          satellites={fullCatalog}
          selectedSat={selectedSat}
          onSelectSat={onSelectSat}
          observer={location.coords}
          simulatedTimeRef={simulatedTimeRef}
          onClose={() => setSkyOpen(false)}
        />
      )}

      </>
      )}
    </div>
  );
}
