'use client';

import { SatData, OrbitBand, getSatelliteRealtimeInfo, SatelliteRealtimeInfo } from '@/lib/satellite';
import { SOLAR_SATELLITES, SolarSat, SelectedBody } from '@/lib/solar-system';
import {
  EarthSettings, SolarSettings,
  EARTH_SPEED_PRESETS, SOLAR_SPEED_PRESETS, formatSpeed,
} from '@/lib/settings';
import { useUserLocation } from '@/hooks/use-location';
import {
  Search, X, Globe, Calendar, Rocket, Orbit, Compass, Radio,
  Navigation, Menu, Clock, MapPin, RotateCcw, Sun,
  SlidersHorizontal, Check, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useState, useMemo, useEffect, useRef, memo } from 'react';

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
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** Labeled pill switch (replaces the bare checkboxes of the old UI). */
function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] font-mono text-gray-300 cursor-pointer select-none group">
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

function TimeAndScenePanel({
  viewMode, now, offsetMs, timeZone, locationSource,
  earthSettings, onEarthSettingsChange, solarSettings, onSolarSettingsChange,
  onSetSimulatedTime, onJumpSimulatedTime, onResetSimulatedTime,
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
      {/* Clock */}
      <div className="text-xs font-mono text-gray-400 space-y-1">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> SIM TIME</span>
          <span className="text-blue-400 font-bold tracking-wider" suppressHydrationWarning>
            {now
              ? now.toLocaleString('en-US', {
                  timeZone,
                  year: 'numeric', month: '2-digit', day: '2-digit',
                  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
                })
              : 'Syncing...'}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4 text-[10px]">
          <span className="flex items-center gap-1 text-gray-500" suppressHydrationWarning>
            <MapPin className="w-3 h-3" />
            {timeZone}
            {locationSource === 'gps' && (
              <span className="text-green-400 border border-green-500/40 rounded px-1 ml-1">GPS</span>
            )}
          </span>
          {timeTravelling && (
            <span className="text-amber-400 border border-amber-500/40 rounded px-1">
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
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
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
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// View switcher
// ---------------------------------------------------------------------------

// Segmented control for the two sections, each with its own identity: Earth
// keeps the app's blue/cyan; the Solar System glows warm like the Sun. The
// active segment is a filled gradient card with an icon roundel; inactive
// segments stay quiet glass until hovered.
const VIEW_OPTIONS = [
  {
    id: 'earth' as const,
    icon: Orbit,
    title: 'Earth Orbit',
    subtitle: 'Live satellite swarm',
    active:
      'bg-gradient-to-br from-blue-600/85 via-blue-500/60 to-cyan-500/45 border-blue-300/40 text-white ' +
      'shadow-[0_0_24px_-6px_rgba(59,130,246,0.85),inset_0_1px_0_rgba(255,255,255,0.18)]',
    iconOn: 'bg-white/15 text-white',
    iconOff: 'bg-blue-500/10 text-blue-400/80 group-hover:bg-blue-500/20 group-hover:text-blue-300',
  },
  {
    id: 'solar' as const,
    icon: Sun,
    title: 'Solar System',
    subtitle: 'Planets & probes',
    active:
      'bg-gradient-to-br from-amber-500/85 via-orange-500/60 to-orange-600/45 border-amber-300/40 text-white ' +
      'shadow-[0_0_24px_-6px_rgba(245,158,11,0.8),inset_0_1px_0_rgba(255,255,255,0.18)]',
    iconOn: 'bg-white/15 text-white',
    iconOff: 'bg-amber-500/10 text-amber-400/80 group-hover:bg-amber-500/20 group-hover:text-amber-300',
  },
];

function ViewSwitcher({
  viewMode, onSwitch,
}: { viewMode: 'earth' | 'solar'; onSwitch: (mode: 'earth' | 'solar') => void }) {
  return (
    <div
      role="tablist"
      aria-label="Tracker section"
      className="grid grid-cols-2 gap-1.5 p-1.5 bg-white/[0.04] rounded-2xl border border-white/10"
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
            className={`group flex items-center gap-2.5 px-2.5 py-2 rounded-xl border text-left btn-premium min-w-0 ${
              isOn ? opt.active : 'border-transparent text-gray-400 hover:text-white hover:bg-white/[0.06]'
            }`}
          >
            <span
              className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors duration-300 ${
                isOn ? opt.iconOn : opt.iconOff
              }`}
            >
              <Icon className="w-4 h-4" />
            </span>
            <span className="flex flex-col min-w-0">
              <span className="text-xs font-bold leading-tight truncate">{opt.title}</span>
              <span
                className={`text-[9px] font-mono leading-tight truncate transition-colors ${
                  isOn ? 'text-white/75' : 'text-gray-600 group-hover:text-gray-500'
                }`}
              >
                {opt.subtitle}
              </span>
            </span>
          </button>
        );
      })}
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
    <div className="flex flex-col gap-3">
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

      {/* Categories */}
      <div>
        <div className="text-[9px] font-mono text-gray-500 uppercase tracking-widest mb-1.5 flex items-center justify-between">
          <span>Categories</span>
          <span className="text-gray-600">{categories.length}</span>
        </div>
        <div className="space-y-1">
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
    <div className="flex flex-col gap-1">
      <div className="text-xs font-bold text-gray-300 uppercase tracking-widest mb-1 flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <Navigation className="w-3.5 h-3.5 text-blue-400" /> Spacecraft
        </span>
        <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-white/5 text-gray-500 font-mono">{total}</span>
      </div>
      {total === 0 && (
        <div className="text-[10px] font-mono text-gray-500 px-1 py-1">
          No spacecraft launched yet at the simulated time.
        </div>
      )}
      {groups.map(([planet, probes]) => (
        <div key={planet} className="mb-1">
          <div className="text-[9px] font-mono text-gray-500 uppercase tracking-widest px-1 py-0.5 flex items-center gap-1.5">
            {planet}
            <span className="flex-1 border-t border-white/5" />
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
              {!probe.active && <span className="text-[8px] font-mono text-gray-600 uppercase">silent</span>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Detail card for the selected satellite / spacecraft / body.
//
// Desktop: fixed 384px card, bottom right, always fully expanded.
// Mobile: compact bottom sheet — header, three quick stats and the action
// row only (≈ a quarter of the screen), with a MORE toggle that expands the
// full data sections. The globe and orbit stay visible behind it.
// ---------------------------------------------------------------------------

function InfoCard({
  selectedSat, selectedSolarSat, selectedBody,
  realtimeInfo, notYetLaunched, isFocused, onIsFocusedChange, onClose,
}: {
  selectedSat: SatData | null;
  selectedSolarSat: SolarSat | null;
  selectedBody: SelectedBody | null;
  realtimeInfo: SatelliteRealtimeInfo | null;
  notYetLaunched: boolean;
  isFocused: boolean;
  onIsFocusedChange: (focus: boolean) => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const selectedItem = selectedSat ?? selectedSolarSat;

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

  // Focus / go-to-body camera action
  const focusLabel = isFocused
    ? selectedBody
      ? 'RETURN TO SYSTEM VIEW'
      : 'DISABLE CAMERA FOCUS'
    : selectedBody
      ? selectedBody.kind === 'planet' ? 'GO TO PLANET' : 'GO TO MOON'
      : 'FOCUS TRACKING CAMERA';
  const FocusIcon = selectedBody && !isFocused ? Rocket : Compass;

  // Mobile quick stats — the essentials visible without expanding
  const quick: { label: string; value: string }[] = selectedSat
    ? [
        { label: 'Alt', value: realtimeInfo ? `${realtimeInfo.altitude.toFixed(0)} km` : notYetLaunched ? '—' : '…' },
        { label: 'Speed', value: realtimeInfo ? `${realtimeInfo.speed.toFixed(1)} km/s` : notYetLaunched ? '—' : '…' },
        { label: 'Regime', value: selectedSat.band },
      ]
    : selectedSolarSat
      ? [
          { label: 'Dist', value: formatKm(selectedSolarSat.altitude) },
          { label: 'Speed', value: `${selectedSolarSat.speed} km/s` },
          { label: 'Since', value: selectedSolarSat.launchYear },
        ]
      : selectedBody
        ? (() => {
            const isMoon = selectedBody.kind === 'moon';
            const p = Math.abs(isMoon ? selectedBody.moon!.periodDays : selectedBody.planet.periodDays);
            return [
              { label: 'Radius', value: formatKm(isMoon ? selectedBody.moon!.radiusKm : selectedBody.planet.radiusKm) },
              { label: 'Period', value: p >= 365 ? `${(p / 365.25).toFixed(1)} y` : `${p.toFixed(1)} d` },
              isMoon
                ? { label: 'Orbit', value: formatKm(selectedBody.moon!.orbitKm) }
                : { label: 'Moons', value: `${selectedBody.planet.moons.length}` },
            ];
          })()
        : [];

  return (
    <div className="absolute md:bottom-6 md:right-6 md:left-auto md:top-auto md:w-80 lg:w-96 bottom-0 inset-x-0 md:inset-x-auto pointer-events-auto">
      <div className="bg-black/85 md:bg-black/65 backdrop-blur-2xl border border-white/10 md:rounded-2xl rounded-t-2xl p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:p-5 shadow-2xl glass-panel animate-fade-up flex flex-col max-h-[48vh] md:max-h-[70vh]">

        {/* Header */}
        <div className="flex justify-between items-start gap-2 mb-2 shrink-0">
          <div className="space-y-0.5 min-w-0">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full animate-pulse shrink-0"
                style={{ backgroundColor: headerColor, boxShadow: `0 0 10px ${headerColor}` }}
              />
              <span className="text-[9px] md:text-[10px] font-bold tracking-widest uppercase font-mono truncate" style={{ color: headerColor }}>
                {headerTag}
              </span>
            </div>
            <h2 className="text-base md:text-2xl font-bold text-white font-mono leading-tight truncate">
              {headerName}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-colors shrink-0"
            aria-label="Close details"
          >
            <X className="w-4 h-4 md:w-5 md:h-5" />
          </button>
        </div>

        {/* Quick stats — mobile only; desktop shows the full sections below */}
        {quick.length > 0 && (
          <div className="md:hidden grid grid-cols-3 gap-1.5 mb-2 shrink-0">
            {quick.map((q) => (
              <div key={q.label} className="bg-white/5 border border-white/5 rounded-lg px-2 py-1.5 min-w-0">
                <div className="text-[8px] font-mono text-gray-500 uppercase tracking-widest">{q.label}</div>
                <div className="text-[11px] font-mono font-bold text-gray-100 truncate">{q.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 mb-2 md:mb-3 shrink-0">
          <button
            onClick={() => onIsFocusedChange(!isFocused)}
            className={`flex-1 py-2 px-3 rounded-xl font-mono text-[10px] md:text-xs font-bold flex items-center justify-center gap-2 border btn-premium ${
              isFocused
                ? 'bg-red-500/20 border-red-500/50 text-red-400 hover:bg-red-500/30'
                : 'bg-blue-600/80 border-blue-500 text-white hover:bg-blue-600'
            }`}
          >
            <FocusIcon className={`w-3.5 h-3.5 md:w-4 md:h-4 ${isFocused ? 'animate-pulse' : ''}`} />
            {focusLabel}
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="md:hidden px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-gray-300 text-[10px] font-mono font-bold flex items-center gap-1 active:bg-white/10"
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            {expanded ? 'LESS' : 'MORE'}
          </button>
        </div>

        {/* Full details — always on desktop, expandable on mobile */}
        <div className={`${expanded ? 'block' : 'hidden'} md:block overflow-y-auto custom-scrollbar min-h-0 space-y-3`}>
          <p className="text-xs text-gray-300 font-mono leading-relaxed bg-white/5 p-3 rounded-xl border border-white/5">
            {headerFact}
          </p>

          {/* Celestial body details */}
          {selectedBody && (
            <div className="bg-white/5 rounded-xl p-3 md:p-4 border border-white/5 space-y-2.5 font-mono">
              <div className="text-xs font-bold text-gray-400 uppercase tracking-widest border-b border-white/5 pb-2 flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-blue-400" /> Physical Data
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-gray-400">RADIUS</span>
                  <span className="text-white font-bold">
                    {(selectedBody.kind === 'moon' ? selectedBody.moon!.radiusKm : selectedBody.planet.radiusKm).toLocaleString()} km
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-400">{selectedBody.kind === 'moon' ? 'DIST FROM PLANET' : 'DIST FROM SUN'}</span>
                  <span className="text-white font-bold">
                    {selectedBody.kind === 'moon'
                      ? `${selectedBody.moon!.orbitKm.toLocaleString()} km`
                      : `${selectedBody.planet.orbitAu} AU`}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-400">ORBITAL PERIOD</span>
                  <span className="text-white font-bold">
                    {(() => {
                      const p = Math.abs(selectedBody.kind === 'moon' ? selectedBody.moon!.periodDays : selectedBody.planet.periodDays);
                      return p >= 365 ? `${(p / 365.25).toFixed(1)} years` : `${p.toFixed(1)} days`;
                    })()}
                  </span>
                </div>
                {selectedBody.kind === 'moon' && (selectedBody.moon!.periodDays < 0) && (
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">DIRECTION</span>
                    <span className="text-amber-400 font-bold">RETROGRADE</span>
                  </div>
                )}
                {selectedBody.kind === 'planet' && (
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">MOONS SHOWN</span>
                    <span className="text-white font-bold">{selectedBody.planet.moons.length}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Spacecraft / satellite details */}
          {selectedItem && (
            <>
              <div className="grid grid-cols-2 gap-2 md:gap-3 font-mono">
                <div className="bg-white/5 rounded-xl p-2.5 md:p-3 border border-white/5 space-y-1">
                  <span className="text-[9px] text-gray-400 uppercase tracking-widest flex items-center gap-1">
                    <Radio className="w-3 h-3 text-blue-400" /> Country / Org
                  </span>
                  <div className="text-xs font-bold text-gray-100 truncate">
                    {selectedSat ? selectedSat.country : selectedSolarSat!.country}
                  </div>
                </div>
                <div className="bg-white/5 rounded-xl p-2.5 md:p-3 border border-white/5 space-y-1">
                  <span className="text-[9px] text-gray-400 uppercase tracking-widest flex items-center gap-1">
                    <Calendar className="w-3 h-3 text-green-400" /> Launch Year
                  </span>
                  <div className="text-xs font-bold text-gray-100">
                    {selectedSat ? selectedSat.launchYear : selectedSolarSat!.launchYear}
                  </div>
                </div>
              </div>

              <div className="bg-white/5 rounded-xl p-3 md:p-4 border border-white/5 space-y-2.5 font-mono">
                <div className="text-xs font-bold text-gray-400 uppercase tracking-widest border-b border-white/5 pb-2 flex items-center gap-1.5">
                  <Rocket className="w-3.5 h-3.5 text-blue-400" /> Live Space Dynamics
                </div>

                <div className="space-y-1.5 text-xs">
                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">ALTITUDE</span>
                    <span className="text-white font-bold text-right">
                      {selectedSat
                        ? (realtimeInfo ? `${realtimeInfo.altitude.toFixed(0)} km` : notYetLaunched ? '—' : 'Propagating...')
                        : `${selectedSolarSat!.altitude.toLocaleString()} km`}
                    </span>
                  </div>

                  <div className="flex justify-between items-center">
                    <span className="text-gray-400">SPEED</span>
                    <span className="text-white font-bold text-right">
                      {selectedSat
                        ? (realtimeInfo
                          ? `${realtimeInfo.speed.toFixed(2)} km/s (~${(realtimeInfo.speed * 3600).toLocaleString(undefined, { maximumFractionDigits: 0 })} km/h)`
                          : notYetLaunched ? '—' : 'Propagating...')
                        : `${selectedSolarSat!.speed.toLocaleString()} km/s`}
                    </span>
                  </div>

                  {selectedSat && realtimeInfo && (
                    <>
                      <div className="flex justify-between items-center">
                        <span className="text-gray-400">FOOTPRINT RADIUS</span>
                        <span className="text-white font-bold text-right">{realtimeInfo.coverageRadius.toFixed(0)} km</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-gray-400">COVERED AREA</span>
                        <span className="text-white font-bold text-right">
                          {realtimeInfo.coverageArea.toLocaleString(undefined, { maximumFractionDigits: 0 })} km²
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-gray-400">GLOBE COVERAGE</span>
                        <span className="text-blue-400 font-bold text-right">
                          {((realtimeInfo.coverageArea / 510072000) * 100).toFixed(1)}% of Earth
                        </span>
                      </div>
                    </>
                  )}

                  {selectedSat && notYetLaunched && (
                    <div className="flex justify-between items-center">
                      <span className="text-gray-400">STATUS</span>
                      <span className="text-amber-400 font-bold text-right">NOT YET LAUNCHED AT SIM TIME</span>
                    </div>
                  )}

                  {selectedSolarSat && (
                    <div className="flex justify-between items-center">
                      <span className="text-gray-400">STATUS</span>
                      <span className={`font-bold text-right ${selectedSolarSat.active ? 'text-green-400' : 'text-gray-500'}`}>
                        {selectedSolarSat.active ? 'ACTIVE' : 'MISSION ENDED'}
                      </span>
                    </div>
                  )}

                  <div className="flex flex-col gap-1 pt-1 border-t border-white/5">
                    <span className="text-gray-400 text-[10px] uppercase">OPERATIONAL MISSION</span>
                    <span className="text-gray-200 text-xs font-semibold">
                      {selectedSat ? selectedSat.purpose : selectedSolarSat!.purpose}
                    </span>
                  </div>
                </div>
              </div>
            </>
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
}: UIOverlayProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const [offsetMs, setOffsetMs] = useState(0);
  const location = useUserLocation();
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  const switchView = (mode: 'earth' | 'solar') => {
    onViewModeChange(mode);
    onSelectSat(null);
    onSelectSolarSat(null);
    onSelectBody(null);
    setSearchTerm('');
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
    />
  );

  const sidePanel = viewMode === 'earth' ? (
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

  return (
    <div className="absolute inset-0 pointer-events-none z-10 text-white font-sans">

      {/* ================= MOBILE TOP BAR ================= */}
      <div className="md:hidden absolute top-0 inset-x-0 flex items-center gap-2 p-2 pt-[max(0.5rem,env(safe-area-inset-top))] pointer-events-auto bg-gradient-to-b from-black/70 to-transparent">
        <button
          onClick={() => setDrawerOpen(true)}
          className="p-2.5 rounded-xl bg-black/60 border border-white/10 backdrop-blur-md active:bg-white/10"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2 bg-black/60 border border-white/10 backdrop-blur-md rounded-xl px-3 py-1.5 min-w-0">
          <Globe className="w-4 h-4 text-blue-400 shrink-0" />
          <span className="font-bold text-sm truncate text-shimmer">PIMX<span>SATS</span></span>
        </div>
        <div className="ml-auto shrink-0 bg-black/60 border border-white/10 backdrop-blur-md rounded-xl px-2.5 py-1.5 text-[10px] font-mono text-blue-400" suppressHydrationWarning>
          {now
            ? now.toLocaleTimeString('en-US', { timeZone: location.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
            : '--:--:--'}
        </div>
      </div>

      {/* ================= MOBILE DRAWER ================= */}
      {drawerOpen && (
        <div
          className="md:hidden absolute inset-0 bg-black/60 pointer-events-auto z-30"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <div
        className={`md:hidden absolute top-0 left-0 h-full w-[86vw] max-w-sm bg-[#05070d]/95 backdrop-blur-2xl border-r border-white/10 z-40 pointer-events-auto transform transition-transform duration-300 flex flex-col ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between p-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <Globe className="w-5 h-5 text-blue-400" />
            <div>
              <div className="font-bold text-shimmer">PIMX<span>SATS</span></div>
              <div className="text-[10px] text-gray-400 font-mono">
                {isLoading ? 'Loading TLE data...' : `${satellites.length.toLocaleString()} tracked objects`}
              </div>
            </div>
          </div>
          <button onClick={() => setDrawerOpen(false)} className="p-2 rounded-full hover:bg-white/10">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] space-y-4 overflow-y-auto custom-scrollbar flex-1">
          <ViewSwitcher viewMode={viewMode} onSwitch={switchView} />
          <div className="space-y-2">
            {searchBox}
            {searchResults}
          </div>
          <div className="bg-white/5 rounded-xl p-3 border border-white/5">{timePanel}</div>
          <div className="bg-white/5 rounded-xl p-3 border border-white/5">{sidePanel}</div>
        </div>
      </div>

      {/* ================= DESKTOP LAYOUT ================= */}
      <div className="hidden md:flex flex-col justify-between h-full p-4 lg:p-6">
        <div className="flex flex-row justify-between items-start gap-4 w-full">

          {/* Title & view switcher */}
          <div className="space-y-3 bg-black/40 backdrop-blur-md p-3 lg:p-4 rounded-2xl border border-white/5 shadow-2xl pointer-events-auto shrink-0 glass-panel animate-fade-up">
            <div className="flex items-center gap-3">
              <div className="bg-blue-600/30 p-2 rounded-xl border border-blue-400/20 transition-all duration-300 hover:border-blue-400/50 hover:shadow-[0_0_18px_rgba(59,130,246,0.4)]">
                <Globe className="w-6 h-6 text-blue-400" />
              </div>
              <div>
                <h1 className="text-xl lg:text-2xl font-bold tracking-tight text-shimmer">PIMX<span>SATS</span></h1>
                <p className="text-xs text-gray-400 font-mono">
                  {isLoading ? 'Bootstrapping TLE elements...' : `Active Track: ${satellites.length.toLocaleString()} objects`}
                </p>
              </div>
            </div>
            <ViewSwitcher viewMode={viewMode} onSwitch={switchView} />
          </div>

          {/* Search — top center */}
          <div className="flex flex-col gap-2 w-full min-w-0 max-w-sm lg:max-w-md mx-auto pointer-events-auto">
            {searchBox}
            {searchResults}
          </div>

          {/* Clock, warp, time travel, per-view filters — top right, directly
              above the detail card (same width, same right edge) */}
          <div className="bg-black/40 backdrop-blur-md p-3 lg:p-4 rounded-2xl border border-white/5 shadow-2xl pointer-events-auto w-80 lg:w-96 max-h-[48vh] overflow-y-auto custom-scrollbar shrink-0 glass-panel animate-fade-up">
            {timePanel}
          </div>
        </div>

        {/* Bottom row */}
        <div className="flex flex-row justify-between items-end mt-auto gap-6 w-full min-h-0">
          <div className="flex flex-col gap-2 bg-black/55 backdrop-blur-xl p-3 lg:p-4 rounded-2xl border border-white/10 w-64 lg:w-72 shadow-2xl pointer-events-auto max-h-[46vh] overflow-y-auto custom-scrollbar glass-panel animate-fade-up">
            {sidePanel}
          </div>
        </div>
      </div>

      {/* ================= LEVEL VIEW (Earth view only) =================
          Straightens the free-rotation camera: back over the equator, north
          up. Hidden while focus-tracking (the camera is satellite-locked)
          and, on mobile, while the info sheet covers the bottom edge. */}
      {viewMode === 'earth' && !isFocused && (
        <div
          className={`absolute bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 pointer-events-auto ${
            hasSelection ? 'hidden md:block' : ''
          }`}
        >
          <button
            onClick={onResetView}
            title="Straighten the view — back over the equator, north up"
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-full bg-black/55 backdrop-blur-xl border border-white/10 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:text-white hover:border-white/30 chip-btn shadow-2xl"
          >
            <Compass className="w-3.5 h-3.5 text-blue-400" />
            LEVEL VIEW
          </button>
        </div>
      )}

      {/* ================= INFO CARD (responsive) ================= */}
      {hasSelection && (
        <InfoCard
          key={selectionKey}
          selectedSat={selectedSat}
          selectedSolarSat={selectedSolarSat}
          selectedBody={selectedBody}
          realtimeInfo={realtimeInfo}
          notYetLaunched={notYetLaunched}
          isFocused={isFocused}
          onIsFocusedChange={onIsFocusedChange}
          onClose={() => { onSelectSat(null); onSelectSolarSat(null); onSelectBody(null); }}
        />
      )}
    </div>
  );
}
