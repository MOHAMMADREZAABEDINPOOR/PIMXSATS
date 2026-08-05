'use client';

// Daily space briefing — the app's front page.
//
// A calm, readable card that offers itself once per day (see lib/briefing for
// the once-a-day gate) and can be reopened any time from the rail. It is pure
// presentation over buildBriefing's output; the one piece it computes itself is
// the "look up tonight" line, because that needs the observer's location and a
// pass prediction, which the pure briefing module intentionally does not do.

import { useEffect, useMemo, useState } from 'react';
import { Newspaper, X, Sparkles, Telescope, Clock3, Globe2, BarChart3, Users, TrendingUp } from 'lucide-react';
import type { SatData } from '@/lib/satellite';
import { buildBriefing, markBriefingSeen } from '@/lib/briefing';
import { predictPassesAsync, compassPoint, Observer } from '@/lib/passes';
import { formatShare } from '@/lib/dashboard';

const ICONS = [Globe2, Telescope, Clock3, Sparkles];

export function BriefingPanel({
  satellites, now, observer, issSat, onClose,
}: {
  satellites: SatData[];
  now: Date;
  observer: { lat: number; lon: number } | null;
  /** The ISS, if found in the catalog — its pass is the "tonight" headline. */
  issSat: SatData | null;
  onClose: () => void;
}) {
  const [passLine, setPassLine] = useState<string | null>(null);

  // Compute the best ISS pass in the next 24 h for the "tonight" item. Runs
  // once when the panel opens; the chunked predictor keeps it off the frame.
  useEffect(() => {
    if (!issSat || !observer) return;
    let cancelled = false;
    const obs: Observer = { lat: observer.lat, lon: observer.lon };
    predictPassesAsync(
      issSat.satrec, obs, now,
      { horizonHours: 24, maxPasses: 5, minElevationDeg: 20 },
      () => cancelled
    ).then((passes) => {
      if (cancelled || !passes || passes.length === 0) return;
      // Prefer a visible (naked-eye) pass; fall back to the highest one.
      const visible = passes.filter((p) => p.visible);
      const pick = (visible.length > 0 ? visible : passes)
        .sort((a, b) => b.maxElevationDeg - a.maxElevationDeg)[0];
      const t = pick.start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      setPassLine(
        `The ISS makes ${pick.visible ? 'a naked-eye' : 'an'} pass starting ${t}, `
        + `rising in the ${compassPoint(pick.startAzimuthDeg)} and reaching ${pick.maxElevationDeg.toFixed(0)}° above the horizon.`
      );
    });
    return () => { cancelled = true; };
  }, [issSat, observer, now]);

  const briefing = useMemo(
    () => buildBriefing(satellites, now, passLine),
    [satellites, now, passLine]
  );

  // Opening the briefing counts as seeing today's edition.
  useEffect(() => { markBriefingSeen(now); }, [now]);

  return (
    <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-md pointer-events-auto flex items-center justify-center p-2 sm:p-3 md:p-6">
      <div className="w-full max-w-2xl max-h-full bg-[#05070d]/95 border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-fade-up">
        <div className="flex items-center justify-between gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3 border-b border-white/10 shrink-0">
          <div className="min-w-0">
            <div className="text-[9px] font-mono uppercase tracking-widest text-blue-300 flex items-center gap-1.5">
              <Newspaper className="w-3 h-3 shrink-0" /> Daily briefing
            </div>
            <h2 className="text-base sm:text-lg font-bold text-white leading-tight truncate">{briefing.dateline}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-white/10 shrink-0"
            aria-label="Close briefing"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2.5 sm:p-4 space-y-3">
          {/* Stat strip. Two up at 300 px — four would give each figure 60 px,
              and these are four-digit counts. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {briefing.stats.map((stat) => (
              <div key={stat.label} className="bg-white/5 border border-white/10 rounded-lg px-2.5 py-2">
                <div className="text-[9px] font-mono uppercase tracking-widest text-gray-500">{stat.label}</div>
                <div className="text-lg font-bold font-mono text-white tabular-nums mt-0.5">{stat.value}</div>
                {stat.hint && <div className="text-[9px] font-mono text-gray-600 leading-tight mt-0.5">{stat.hint}</div>}
              </div>
            ))}
          </div>

          {/* Prose items */}
          {briefing.items.map((item, i) => {
            const Icon = ICONS[i % ICONS.length];
            return (
              <div key={item.title} className="bg-white/5 border border-white/5 rounded-xl p-3">
                <div className="text-[9px] font-mono uppercase tracking-widest text-gray-400 flex items-center gap-1.5">
                  <Icon className="w-3 h-3 text-blue-400" /> {item.title}
                </div>
                <p className="text-[11px] font-mono text-gray-200 leading-relaxed mt-1.5">{item.body}</p>
              </div>
            );
          })}

          {/* Orbital shells bar chart */}
          {briefing.shells.length > 0 && (
            <div className="bg-white/5 border border-white/5 rounded-xl p-3">
              <div className="text-[9px] font-mono uppercase tracking-widest text-gray-400 flex items-center gap-1.5 mb-2">
                <BarChart3 className="w-3 h-3 text-emerald-400" /> Orbital shells
              </div>
              <div className="space-y-1.5">
                {briefing.shells.map((sh) => (
                  <div key={sh.band}>
                    <div className="flex items-center justify-between text-[10px] font-mono mb-0.5">
                      <span className="text-gray-300">{sh.band}</span>
                      <span className="text-gray-500 tabular-nums">{sh.count.toLocaleString()} · {formatShare(sh.share)}</span>
                    </div>
                    <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-400 rounded-full" style={{ width: `${sh.share * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Top owners */}
          {briefing.owners.length > 0 && (
            <div className="bg-white/5 border border-white/5 rounded-xl p-3">
              <div className="text-[9px] font-mono uppercase tracking-widest text-gray-400 flex items-center gap-1.5 mb-2">
                <Users className="w-3 h-3 text-violet-400" /> Top operators
              </div>
              <div className="space-y-1.5">
                {briefing.owners.map((o) => (
                  <div key={o.country}>
                    <div className="flex items-center justify-between text-[10px] font-mono mb-0.5">
                      <span className="text-gray-300 truncate">{o.country}</span>
                      <span className="text-gray-500 tabular-nums shrink-0">{o.count.toLocaleString()} · {formatShare(o.share)}</span>
                    </div>
                    <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
                      <div className="h-full bg-violet-400 rounded-full" style={{ width: `${o.share * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Launch decades histogram */}
          {briefing.decades.length > 0 && (
            <div className="bg-white/5 border border-white/5 rounded-xl p-3">
              <div className="text-[9px] font-mono uppercase tracking-widest text-gray-400 flex items-center gap-1.5 mb-2">
                <TrendingUp className="w-3 h-3 text-cyan-400" /> Launch decades
              </div>
              <div className="flex items-end justify-between gap-1 h-20">
                {briefing.decades.map((d) => {
                  const maxCount = Math.max(...briefing.decades.map((x) => x.count));
                  const heightPct = maxCount > 0 ? (d.count / maxCount) * 100 : 0;
                  return (
                    <div key={d.decade} className="flex-1 flex flex-col items-center gap-1">
                      <div className="text-[9px] font-mono text-gray-500 tabular-nums">{d.count}</div>
                      <div className="w-full bg-cyan-400/30 rounded-t" style={{ height: `${heightPct}%` }} />
                      <div className="text-[9px] font-mono text-gray-600">{d.decade}s</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!observer && (
            <p className="text-[9px] font-mono text-gray-600 leading-relaxed px-1">
              Enable location to get tonight&apos;s visible-pass forecast in this briefing.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
