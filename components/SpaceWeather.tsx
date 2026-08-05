'use client';

// Space weather — the radiation and geomagnetic environment the satellites on
// screen are actually flying through.
//
// Every figure comes from a named NOAA SWPC product through /api/space-weather.
// Nothing here is derived from anything unrelated and nothing is invented: when
// a product is down its field renders as "—" and the badge stops saying LIVE.
// The previous version filled gaps with `Math.random()` behind a "LIVE NOAA"
// label, which made the panel decoration rather than instrumentation.
//
// The request itself is NOT owned here — it belongs to lib/space-weather, which
// the splash screen kicks off. This file is presentation: it reads the module's
// snapshot on mount and keeps it current.
//
// This is a STANDALONE card (it supplies its own header and border), because in
// solar view it sits alone at the top-left rather than nested under a list.

import { useEffect, useState } from 'react';
import { Activity, Sun, ShieldAlert, Magnet, Zap } from 'lucide-react';
import { getSpaceWeather, loadSpaceWeather, SW_REFRESH_MS } from '@/lib/space-weather';

/** NOAA's own G-scale wording, keyed off Kp. Below G1 the service uses the
 *  quiet / unsettled / active vocabulary instead — which is why this is a lookup
 *  and not arithmetic on the index. */
function kpLabel(kp: number): string {
  if (kp >= 8.5) return 'Extreme storm (G5)';
  if (kp >= 8) return 'Severe storm (G4)';
  if (kp >= 7) return 'Strong storm (G3)';
  if (kp >= 6) return 'Moderate storm (G2)';
  if (kp >= 5) return 'Minor storm (G1)';
  if (kp >= 4) return 'Active';
  if (kp >= 3) return 'Unsettled';
  return 'Quiet';
}

function kpColor(kp: number): string {
  if (kp >= 7) return 'text-red-400';
  if (kp >= 5) return 'text-orange-400';
  if (kp >= 4) return 'text-amber-400';
  return 'text-emerald-400';
}

/** Colour by flare letter. A/B/C are background to routine, M is the level that
 *  starts causing radio blackouts, X is the top of the scale. */
function flareColor(cls: string): string {
  const c = cls.trim().toUpperCase()[0];
  if (c === 'X') return 'text-red-400';
  if (c === 'M') return 'text-orange-400';
  if (c === 'C') return 'text-amber-400';
  return 'text-emerald-400';
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

/** One readout. `value` is null when its upstream product did not answer, and a
 *  dash is the honest rendering of that. */
function Metric({
  label, value, unit, icon, color = 'text-gray-100', title,
}: {
  label: string;
  value: string | number | null;
  unit?: string;
  icon: React.ReactNode;
  color?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <div className="text-[8px] font-mono text-gray-500 uppercase tracking-widest truncate">{label}</div>
      <div className={`flex items-center gap-1 font-mono text-[11px] font-bold ${value === null ? 'text-gray-600' : color}`}>
        <span className="shrink-0">{icon}</span>
        <span className="truncate tabular-nums">
          {value === null ? '—' : value}
          {value !== null && unit ? <span className="text-gray-500 font-normal">{unit}</span> : null}
        </span>
      </div>
    </div>
  );
}

export function SpaceWeather() {
  // Seeded from the module, which the startup sequence has already filled in (see
  // lib/space-weather). That is the whole point of the split: this card used to
  // schedule its own fetch on mount, so opening the solar view meant watching it
  // say LINKING for a second or two — every time, because switching views
  // unmounts and remounts it. Now the first frame it paints already has numbers.
  const [snap, setSnap] = useState(() => getSpaceWeather());
  const { payload: data, provenance: prov } = snap;

  useEffect(() => {
    let cancelled = false;
    // Join whatever boot started (or start it, if this card is somehow up first —
    // the module keeps one promise, so there is no second request either way).
    const sync = () => { void loadSpaceWeather().then((s) => { if (!cancelled) setSnap({ ...s }); }); };
    sync();

    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      sync();
    }, SW_REFRESH_MS);

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - getSpaceWeather().okMs < SW_REFRESH_MS) return;
      sync();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const kp = data?.kp?.value ?? null;
  const bz = data?.mag?.bz ?? null;

  const badge =
    prov === 'live' ? { text: 'LIVE NOAA', cls: 'bg-emerald-500/20 text-emerald-400' }
      : prov === 'stale' ? { text: 'DELAYED', cls: 'bg-amber-500/20 text-amber-400' }
        : prov === 'pending' ? { text: 'LINKING', cls: 'bg-white/10 text-gray-400' }
          : { text: 'NO LINK', cls: 'bg-red-500/20 text-red-400' };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-1.5">
        <span className="flex items-center gap-1.5 min-w-0 text-[10px] font-mono font-bold text-gray-300 uppercase tracking-widest">
          <Activity className="w-3.5 h-3.5 text-orange-400 shrink-0" />
          <span className="truncate">Space weather</span>
        </span>
        <span
          className={`text-[8px] font-mono font-bold px-1.5 py-0.5 rounded-md tracking-widest shrink-0 ${badge.cls}`}
          title={
            data
              ? `NOAA SWPC · ${data.sources.length} product${data.sources.length === 1 ? '' : 's'}: ${data.sources.join(', ')} · read ${ago(data.fetchedMs)} · re-checks every ${SW_REFRESH_MS / 60000} min`
              : 'Waiting for NOAA SWPC'
          }
        >
          {badge.text}
        </span>
      </div>

      {/* Two columns at 300 px, four from `sm`. Every cell is independently
          sourced, so a partial outage leaves a dash rather than a hole. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-2 gap-y-2">
        <Metric
          label="Kp index"
          value={kp === null ? null : kp.toFixed(1)}
          icon={<Activity className="w-3 h-3" />}
          color={kp === null ? undefined : kpColor(kp)}
          title={kp === null ? 'Planetary K index unavailable' : `${kpLabel(kp)} · NOAA 1-minute estimate`}
        />
        <Metric
          label="Solar wind"
          value={data?.wind?.speedKmS ?? null}
          unit=" km/s"
          icon={<Sun className="w-3 h-3 text-amber-400" />}
          color="text-cyan-300"
          title="Bulk solar wind speed measured at L1"
        />
        <Metric
          label="IMF Bz"
          value={bz === null ? null : bz.toFixed(1)}
          unit=" nT"
          icon={<Magnet className="w-3 h-3" />}
          color={bz !== null && bz <= -10 ? 'text-orange-400' : 'text-gray-100'}
          title={
            bz === null
              ? 'Interplanetary magnetic field unavailable'
              : bz <= -10
                ? 'Strongly southward — the solar wind is coupling efficiently into the magnetosphere'
                : 'North-south component of the interplanetary magnetic field at L1'
          }
        />
        <Metric
          label="X-ray flare"
          value={data?.flare?.cls ?? null}
          icon={<Zap className="w-3 h-3" />}
          color={data?.flare ? flareColor(data.flare.cls) : undefined}
          title={
            data?.flare?.timeTag
              ? `Largest GOES flare in the current report · peak ${data.flare.timeTag} UTC`
              : 'Largest GOES X-ray flare in the current report'
          }
        />
      </div>

      {/* The interpretation line. It only ever states what the measured values
          imply — with no data it says exactly that. */}
      <div className="flex items-start gap-1.5 border-t border-white/5 pt-1.5 text-[9px] font-mono leading-snug text-gray-400">
        <ShieldAlert
          className={`w-3 h-3 shrink-0 mt-px ${
            kp !== null && kp >= 5 ? 'text-orange-400' : kp === null ? 'text-gray-600' : 'text-emerald-500'
          }`}
        />
        <span className="min-w-0">
          {kp === null ? (
            'No live NOAA link — no geomagnetic assessment shown rather than a guessed one.'
          ) : kp >= 7 ? (
            <>
              {kpLabel(kp)}. Expect satellite drag increases in LEO, GPS degradation and
              HF blackouts at high latitudes.
            </>
          ) : kp >= 5 ? (
            <>{kpLabel(kp)}. Increased drag on low orbits; aurora visible at mid latitudes.</>
          ) : (
            <>{kpLabel(kp)} geomagnetic field. Normal radiation environment in low Earth orbit.</>
          )}
          {data?.scales && (data.scales.r > 0 || data.scales.s > 0) ? (
            <span className="text-gray-500">
              {' '}NOAA scales today: R{data.scales.r} · S{data.scales.s} · G{data.scales.g}.
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
