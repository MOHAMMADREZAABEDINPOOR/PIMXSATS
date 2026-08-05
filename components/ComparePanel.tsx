'use client';

// Split-screen compare — two objects, the same numbers, side by side.
//
// The info card answers "what is this?" one object at a time, which makes
// comparison a memory exercise: you read ISS's altitude, close it, open
// Starlink, and try to remember. This puts both columns on screen with a shared
// row for each quantity, so the difference is a glance rather than a recall.
//
// Deliberately NOT two 3D viewports. A second WebGL context doubles the GPU
// cost of the heaviest thing the app does, and the comparison people actually
// want is numeric — altitude, speed, period, inclination — not two pictures of
// a dot. The delta column is the feature.

import { useEffect, useMemo, useState } from 'react';
import { Columns2, X, Search, ArrowLeftRight, Globe2 } from 'lucide-react';
import { SatData, getSatelliteRealtimeInfo } from '@/lib/satellite';
import { compareDistance, compareSpeed } from '@/lib/storytelling';

/** One comparable quantity, resolved for both columns. */
interface Row {
  label: string;
  a: string;
  b: string;
  /** Signed difference, pre-formatted. Null when the quantity isn't numeric. */
  delta: string | null;
  /** True when B is the larger of the two — drives which side is highlighted. */
  bWins?: boolean;
}

function periodMin(sat: SatData): number | null {
  return sat.satrec.no > 0 ? (2 * Math.PI) / sat.satrec.no : null;
}

/** Picker column, used for whichever side is still empty. */
function Picker({
  satellites, exclude, onPick, side, onPickFromGlobe,
}: {
  satellites: SatData[];
  exclude: SatData | null;
  onPick: (sat: SatData) => void;
  side: 'A' | 'B';
  /** Offered only when the host can hand the globe over. */
  onPickFromGlobe?: () => void;
}) {
  const [term, setTerm] = useState('');

  const results = useMemo(() => {
    if (!term.trim()) return [];
    const q = term.toLowerCase();
    return satellites
      .filter((s) => s !== exclude && s.name.toLowerCase().includes(q))
      .slice(0, 40);
  }, [satellites, term, exclude]);

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="text-[9px] font-mono uppercase tracking-widest text-gray-500">
        Object {side}
      </div>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
        <input
          type="text"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search the catalog…"
          className="w-full bg-black/50 border border-white/10 rounded-lg py-2 pl-8 pr-2 text-[11px] font-mono text-white placeholder-gray-600 focus:outline-none focus:border-blue-500/60"
        />
      </div>
      {/* Search only works if you already know the name. This is the way in for
          everyone who doesn't: hand the globe back and let them click the dot. */}
      {onPickFromGlobe && (
        <button
          onClick={onPickFromGlobe}
          className="flex items-center justify-center gap-1.5 w-full py-2 rounded-lg bg-blue-500/15 border border-blue-400/40 text-[10px] font-mono font-bold tracking-widest text-blue-200 hover:bg-blue-500/25 chip-btn"
        >
          <Globe2 className="w-3.5 h-3.5" /> PICK FROM GLOBE
        </button>
      )}
      <div className="max-h-48 overflow-y-auto custom-scrollbar space-y-0.5">
        {term.trim() && results.length === 0 && (
          <div className="text-[10px] font-mono text-gray-600 px-1 py-2">No matches.</div>
        )}
        {results.map((s) => (
          <button
            key={s.satrec.satnum}
            onClick={() => onPick(s)}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/10 text-left row-hover"
          >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: s.color }} />
            <span className="font-mono text-[11px] text-white truncate flex-1">{s.name}</span>
            <span className="text-[9px] font-mono text-gray-500 shrink-0">{s.band}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ComparePanel({
  satellites, initialSat, now, onClose,
  pickingSide = null, onRequestPick, picked = null, onPickedConsumed,
}: {
  satellites: SatData[];
  /** Pre-fills column A — usually whatever the user already had selected. */
  initialSat: SatData | null;
  now: Date;
  onClose: () => void;
  /** Non-null while the user is choosing that column's object off the globe.
   *  The panel collapses to a hint bar so the globe underneath is clickable. */
  pickingSide?: 'A' | 'B' | null;
  /** Ask the host to hand the globe over for a pick on this column. Called with
   *  the side that is ALREADY picking to cancel — the host toggles. */
  onRequestPick?: (side: 'A' | 'B') => void;
  /** The result of a globe pick, handed back by the host. */
  picked?: { side: 'A' | 'B'; sat: SatData } | null;
  /** Called once `picked` has been applied, so the host can clear it. */
  onPickedConsumed?: () => void;
}) {
  const [a, setA] = useState<SatData | null>(initialSat);
  const [b, setB] = useState<SatData | null>(null);

  // A globe pick arrives from the host (the click happens on the 3D scene, not
  // in here) and is applied to whichever column asked for it. The panel stays
  // mounted throughout — only hidden — so both columns survive the round trip.
  useEffect(() => {
    if (!picked) return;
    if (picked.side === 'A') setA(picked.sat);
    else setB(picked.sat);
    onPickedConsumed?.();
  }, [picked, onPickedConsumed]);

  // A 1 s tick for the live rows. The parent's `now` already moves, but it can
  // be paused (time-travel with movement off), and a stalled comparison looks
  // broken rather than paused.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const rows = useMemo<Row[]>(() => {
    if (!a || !b) return [];
    const nowMs = now.getTime();
    const infoA = nowMs >= a.launchMs ? getSatelliteRealtimeInfo(a.satrec, now) : null;
    const infoB = nowMs >= b.launchMs ? getSatelliteRealtimeInfo(b.satrec, now) : null;
    const out: Row[] = [];

    const num = (
      label: string,
      va: number | null | undefined,
      vb: number | null | undefined,
      fmt: (v: number) => string,
      unit: string
    ) => {
      const has = typeof va === 'number' && typeof vb === 'number';
      out.push({
        label,
        a: typeof va === 'number' ? fmt(va) : '—',
        b: typeof vb === 'number' ? fmt(vb) : '—',
        delta: has ? `${vb! - va! >= 0 ? '+' : '−'}${fmt(Math.abs(vb! - va!))}${unit ? '' : ''}` : null,
        bWins: has ? vb! > va! : undefined,
      });
    };

    num('Altitude', infoA?.altitude, infoB?.altitude, (v) => `${v.toFixed(0)} km`, 'km');
    num('Speed', infoA?.speed, infoB?.speed, (v) => `${v.toFixed(2)} km/s`, 'km/s');
    num('Orbital period', periodMin(a), periodMin(b), (v) => `${v.toFixed(1)} min`, 'min');
    num('Laps per day', periodMin(a) ? 1440 / periodMin(a)! : null, periodMin(b) ? 1440 / periodMin(b)! : null,
      (v) => v.toFixed(2), '');
    num('Inclination', (a.satrec.inclo * 180) / Math.PI, (b.satrec.inclo * 180) / Math.PI,
      (v) => `${v.toFixed(2)}°`, '°');
    num('Eccentricity', a.satrec.ecco, b.satrec.ecco, (v) => v.toFixed(5), '');

    // Non-numeric provenance rows: no delta, just the two values.
    out.push({ label: 'Orbit band', a: a.band, b: b.band, delta: null });
    out.push({ label: 'Category', a: a.category, b: b.category, delta: null });
    out.push({ label: 'Country / org', a: a.country, b: b.country, delta: null });
    out.push({
      label: 'Launch year',
      a: a.launchYear ? String(a.launchYear) : 'Unknown',
      b: b.launchYear ? String(b.launchYear) : 'Unknown',
      delta: null,
    });
    out.push({ label: 'NORAD id', a: a.satrec.satnum, b: b.satrec.satnum, delta: null });

    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b, now, tick]);

  // One human-scale sentence per column, so the table isn't the only takeaway.
  const stories = useMemo(() => {
    const line = (sat: SatData | null): string | null => {
      if (!sat || now.getTime() < sat.launchMs) return null;
      const info = getSatelliteRealtimeInfo(sat.satrec, now);
      if (!info) return null;
      const d = compareDistance(info.altitude);
      const s = compareSpeed(info.speed);
      const parts: string[] = [];
      if (d) parts.push(d.text);
      if (s) parts.push(s.text);
      return parts.length > 0 ? parts.join(' ') : null;
    };
    return { a: line(a), b: line(b) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b, now, tick]);

  const swap = () => { setA(b); setB(a); };

  // While a globe pick is in flight the modal gets out of the way entirely —
  // a backdrop covering the scene would swallow the very click we are waiting
  // for. It is hidden, not unmounted, so both columns are still there after.
  if (pickingSide) {
    return (
      // Below `lg` the drawer layout puts a hamburger + search bar across the
      // very top, so the banner is pushed clear of it; from lg up that bar is
      // gone and it can sit at the top edge.
      <div className="absolute inset-x-0 top-0 z-50 flex justify-center px-2 sm:px-3 pt-[calc(env(safe-area-inset-top)+3.5rem)] lg:pt-[max(0.75rem,env(safe-area-inset-top))] pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-2 sm:gap-3 max-w-full rounded-full bg-black/85 backdrop-blur-xl border border-blue-400/40 px-3 sm:px-4 py-2 shadow-2xl animate-fade-up">
          <Globe2 className="w-4 h-4 text-blue-300 shrink-0" />
          <span className="text-[10px] font-mono tracking-widest text-blue-100 truncate">
            TAP A SATELLITE FOR OBJECT {pickingSide}
          </span>
          <button
            onClick={() => onRequestPick?.(pickingSide)}
            className="p-1 rounded-full text-gray-400 hover:text-white hover:bg-white/10 shrink-0"
            aria-label="Cancel globe pick"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-50 bg-black/85 backdrop-blur-md pointer-events-auto flex items-center justify-center p-2 sm:p-3 md:p-6">
      <div className="w-full max-w-3xl max-h-full bg-[#05070d]/95 border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden animate-fade-up">

        <div className="flex items-center justify-between gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3 border-b border-white/10 shrink-0">
          <div className="text-[9px] font-mono uppercase tracking-widest text-blue-300 flex items-center gap-1.5 min-w-0">
            <Columns2 className="w-3.5 h-3.5 shrink-0" /> <span className="truncate">Split-screen compare</span>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            {a && b && (
              <button
                onClick={swap}
                title="Swap the two columns"
                className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-white/10"
              >
                <ArrowLeftRight className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-white/10"
              aria-label="Close compare"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2.5 sm:p-4">
          {/* Column headers / pickers. Two columns even at 300 px — a
              side-by-side comparison stacked into one column is not one. */}
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            {[
              { sat: a, set: setA, other: b, side: 'A' as const },
              { sat: b, set: setB, other: a, side: 'B' as const },
            ].map(({ sat, set, other, side }) => (
              <div key={side} className="min-w-0">
                {sat ? (
                  <div className="bg-white/5 border border-white/10 rounded-xl px-3 py-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: sat.color }} />
                          <span className="text-[9px] font-mono uppercase tracking-widest" style={{ color: sat.color }}>
                            {side} · {sat.band}
                          </span>
                        </div>
                        <div className="font-mono text-sm font-bold text-white truncate mt-0.5">{sat.name}</div>
                        <div className="text-[9px] font-mono text-gray-500 truncate">{sat.operator}</div>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {onRequestPick && (
                          <button
                            onClick={() => onRequestPick(side)}
                            title="Replace by picking from the globe"
                            className="p-1 rounded-md text-blue-300/80 hover:text-blue-200 hover:bg-white/10"
                          >
                            <Globe2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => set(null)}
                          title="Choose a different object"
                          className="p-1 rounded-md text-gray-500 hover:text-white hover:bg-white/10"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <Picker
                    satellites={satellites}
                    exclude={other}
                    onPick={set}
                    side={side}
                    onPickFromGlobe={onRequestPick ? () => onRequestPick(side) : undefined}
                  />
                )}
              </div>
            ))}
          </div>

          {a && b ? (
            <>
              <div className="mt-4 rounded-xl border border-white/10 overflow-hidden">
                {rows.map((r, i) => (
                  <div
                    key={r.label}
                    className={`grid grid-cols-[1fr_auto_1fr] items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 ${
                      i % 2 === 0 ? 'bg-white/[0.03]' : ''
                    }`}
                  >
                    <div className={`font-mono text-[11px] tabular-nums truncate text-right ${
                      r.bWins === false ? 'text-white font-bold' : 'text-gray-300'
                    }`}>
                      {r.a}
                    </div>
                    <div className="text-center min-w-0">
                      <div className="text-[9px] font-mono uppercase tracking-widest text-gray-500 whitespace-nowrap">
                        {r.label}
                      </div>
                      {r.delta && (
                        <div className="text-[9px] font-mono text-blue-300 tabular-nums">{r.delta}</div>
                      )}
                    </div>
                    <div className={`font-mono text-[11px] tabular-nums truncate ${
                      r.bWins === true ? 'text-white font-bold' : 'text-gray-300'
                    }`}>
                      {r.b}
                    </div>
                  </div>
                ))}
              </div>

              {(stories.a || stories.b) && (
                <div className="grid grid-cols-2 gap-2 sm:gap-3 mt-3">
                  {[stories.a, stories.b].map((line, i) => (
                    <p key={i} className="text-[10px] font-mono text-gray-400 leading-relaxed bg-white/5 border border-white/5 rounded-xl px-2 sm:px-3 py-2">
                      {line ?? '—'}
                    </p>
                  ))}
                </div>
              )}

              <p className="text-[9px] font-mono text-gray-600 leading-relaxed mt-3 px-1">
                Altitude and speed are propagated live for the simulated time; period, inclination and
                eccentricity come from each object&apos;s current TLE. The delta column reads B minus A.
              </p>
            </>
          ) : (
            <p className="text-[11px] font-mono text-gray-500 leading-relaxed mt-4 bg-white/5 border border-white/5 rounded-xl px-3 py-2.5">
              Pick two objects to compare them row by row — altitude, speed, period, inclination and
              provenance, with the difference between them in the middle.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
