'use client';

// Space situational dashboard — the state of orbit on one screen.
//
// A full-screen modal rather than a side panel: the whole point is the shape of
// the population, and a 100 km-binned LEO histogram plus four shell cards plus
// an owner table does not fit in a rail. Everything is derived from the catalog
// already in memory (lib/dashboard), so opening it costs one pass over an array
// and no network at all.

import { useMemo } from 'react';
import {
  X, Activity, Trash2, Globe2, TrendingUp, Layers, AlertTriangle,
} from 'lucide-react';
import type { SatData } from '@/lib/satellite';
import { summarize, formatShare } from '@/lib/dashboard';

const BAND_TONE: Record<string, string> = {
  LEO: 'from-blue-500/30 to-blue-700/10 border-blue-400/40 text-blue-200',
  MEO: 'from-violet-500/30 to-violet-700/10 border-violet-400/40 text-violet-200',
  GEO: 'from-amber-500/30 to-amber-700/10 border-amber-400/40 text-amber-200',
  HEO: 'from-rose-500/30 to-rose-700/10 border-rose-400/40 text-rose-200',
};

function BigStat({
  icon: Icon, tone, label, value, sub,
}: {
  icon: typeof Activity;
  tone: string;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 min-w-0">
      <div className="flex items-center gap-1.5 text-[9px] font-mono text-gray-500 uppercase tracking-widest">
        <Icon className={`w-3 h-3 shrink-0 ${tone}`} />
        <span className="truncate">{label}</span>
      </div>
      <div className="text-lg font-mono font-bold text-white mt-0.5 truncate">{value}</div>
      {sub && <div className="text-[9px] font-mono text-gray-500 truncate">{sub}</div>}
    </div>
  );
}

export function DashboardPanel({
  satellites, onClose,
}: {
  satellites: SatData[];
  onClose: () => void;
}) {
  const s = useMemo(() => summarize(satellites), [satellites]);

  // Histogram scaling: the busiest bin sets the full bar height, so the shape
  // is readable regardless of catalog size.
  const maxBin = useMemo(
    () => s.leoBins.reduce((m, b) => Math.max(m, b.count), 0),
    [s.leoBins]
  );
  const maxDecade = useMemo(
    () => s.decades.reduce((m, d) => Math.max(m, d.count), 0),
    [s.decades]
  );

  return (
    // The 300 px floor: the backdrop's own padding is what steals width from the
    // card, so it starts at 8 px and only opens up once there is room.
    <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-md pointer-events-auto flex items-center justify-center p-2 sm:p-3 md:p-6">
      <div className="w-full max-w-4xl max-h-full bg-[#05070d]/95 border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-fade-up">

        {/* Header */}
        <div className="flex items-center justify-between gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3 border-b border-white/10 shrink-0">
          <div className="min-w-0">
            <div className="text-[9px] font-mono uppercase tracking-widest text-cyan-400 flex items-center gap-1.5">
              <Activity className="w-3 h-3 shrink-0" /> <span className="truncate">Space situational awareness</span>
            </div>
            <h2 className="text-base sm:text-lg font-bold text-white leading-tight truncate">The state of orbit</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-white/10 shrink-0"
            aria-label="Close dashboard"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2.5 sm:p-4 space-y-3 sm:space-y-4">

          {/* Headline figures */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <BigStat
              icon={Globe2} tone="text-blue-400" label="Tracked objects"
              value={s.total.toLocaleString()}
              sub="in the current catalog"
            />
            <BigStat
              icon={Layers} tone="text-emerald-400" label="Intact payloads"
              value={s.payloads.toLocaleString()}
              sub={`${formatShare(1 - s.junkShare)} of the catalog`}
            />
            <BigStat
              icon={Trash2} tone="text-rose-400" label="Debris & rocket bodies"
              value={s.junk.toLocaleString()}
              sub={`${formatShare(s.junkShare)} — a floor, by naming`}
            />
            <BigStat
              icon={TrendingUp} tone="text-amber-400" label="Mean orbital period"
              value={`${s.meanPeriodMin.toFixed(0)} min`}
              sub={`${s.decayingSoon.toLocaleString()} below 300 km`}
            />
          </div>

          {/* Shells */}
          <section className="space-y-2">
            <h3 className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">Orbital shells</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {s.shells.map((shell) => (
                <div
                  key={shell.band}
                  className={`bg-gradient-to-b border rounded-xl px-3 py-2.5 ${BAND_TONE[shell.band] ?? 'border-white/10'}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono font-bold">{shell.band}</span>
                    <span className="text-[9px] font-mono opacity-70">{formatShare(shell.share)}</span>
                  </div>
                  <div className="text-base font-mono font-bold text-white mt-0.5">
                    {shell.count.toLocaleString()}
                  </div>
                  <div className="text-[9px] font-mono opacity-70 mt-0.5 space-y-px">
                    <div>mean {shell.meanAltitudeKm.toFixed(0)} km</div>
                    <div>{formatShare(shell.junkShare)} junk</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* LEO altitude histogram — the crowding, as a shape */}
          <section className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">
                Low Earth orbit, by altitude
              </h3>
              {s.busiestShellKm && (
                <span className="text-[9px] font-mono text-amber-300">
                  busiest: {s.busiestShellKm.fromKm}–{s.busiestShellKm.toKm} km
                  · {s.busiestShellKm.count.toLocaleString()} objects
                </span>
              )}
            </div>
            <div className="bg-white/5 border border-white/5 rounded-xl p-3">
              <div className="flex items-end gap-px h-32">
                {s.leoBins.map((bin) => {
                  const h = maxBin > 0 ? (bin.count / maxBin) * 100 : 0;
                  const hot = s.busiestShellKm?.fromKm === bin.fromKm;
                  return (
                    <div
                      key={bin.fromKm}
                      title={`${bin.fromKm}–${bin.toKm} km · ${bin.count.toLocaleString()} objects`}
                      className="flex-1 min-w-0 flex flex-col justify-end h-full group"
                    >
                      <div
                        className={`w-full rounded-t transition-colors ${
                          hot ? 'bg-amber-400' : 'bg-blue-500/70 group-hover:bg-blue-400'
                        }`}
                        style={{ height: `${Math.max(h, bin.count > 0 ? 1.5 : 0)}%` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-between text-[8px] font-mono text-gray-600 mt-1.5">
                <span>0 km</span><span>500</span><span>1,000</span><span>1,500</span><span>2,000 km</span>
              </div>
            </div>
          </section>

          <div className="grid md:grid-cols-2 gap-4">
            {/* Owners */}
            <section className="space-y-2">
              <h3 className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">
                Who owns the sky
              </h3>
              <div className="bg-white/5 border border-white/5 rounded-xl divide-y divide-white/5">
                {s.owners.map((o) => (
                  <div key={o.country} className="px-3 py-1.5">
                    <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
                      <span className="text-gray-200 truncate">{o.country}</span>
                      <span className="text-gray-400 shrink-0">
                        {o.count.toLocaleString()} · {formatShare(o.share)}
                      </span>
                    </div>
                    <div className="h-0.5 w-full bg-white/10 rounded-full overflow-hidden mt-1">
                      <div
                        className="h-full bg-cyan-400/80 rounded-full"
                        style={{ width: `${Math.min(o.share * 100, 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Launch decades */}
            <section className="space-y-2">
              <h3 className="text-[9px] font-mono text-gray-500 uppercase tracking-widest">
                Surviving hardware, by launch decade
              </h3>
              <div className="bg-white/5 border border-white/5 rounded-xl p-3">
                <div className="flex items-end gap-1 h-28">
                  {s.decades.map((d) => {
                    const h = maxDecade > 0 ? (d.count / maxDecade) * 100 : 0;
                    return (
                      <div
                        key={d.decade}
                        title={`${d.decade}s · ${d.count.toLocaleString()} objects still tracked`}
                        className="flex-1 min-w-0 flex flex-col justify-end h-full group"
                      >
                        <div
                          className="w-full rounded-t bg-violet-500/70 group-hover:bg-violet-400 transition-colors"
                          style={{ height: `${Math.max(h, d.count > 0 ? 2 : 0)}%` }}
                        />
                        <span className="text-[7px] font-mono text-gray-600 text-center mt-1">
                          {String(d.decade).slice(2)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </section>
          </div>

          <p className="flex items-start gap-1.5 text-[9px] font-mono text-gray-500 leading-relaxed">
            <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0 mt-px" />
            Derived entirely from the public two-line element set in memory. Debris counts come
            from naming conventions (DEB, R/B and similar), so they are a floor rather than a
            census, and the catalog only lists objects large enough to track — roughly 10 cm in
            LEO. Millions of smaller fragments are up there and are not in any of these numbers.
          </p>
        </div>
      </div>
    </div>
  );
}
