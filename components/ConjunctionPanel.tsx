'use client';

// Conjunction radar — close approaches to the selected satellite.
//
// The honest framing matters here and is stated in the panel itself: a public
// TLE has no covariance, so this is a geometric miss-distance search, not a
// collision probability. What it CAN tell you is real and interesting: which
// tracked objects thread the same piece of sky as this one, how close, how fast,
// and when.
//
// The search is expensive (an altitude-gated sweep over the whole catalog), so
// it is explicitly user-triggered rather than automatic, runs through the
// chunked async variant with a live progress bar, and is cancelled if the
// selection changes underneath it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Radar, Loader2, AlertTriangle, Zap, Play, X } from 'lucide-react';
import type { SatData } from '@/lib/satellite';
import { Conjunction, findConjunctionsAsync, formatMiss } from '@/lib/conjunctions';

/** Colour by how close the approach is. These thresholds are presentational —
 *  under 1 km is genuinely notable, over 5 km is routine traffic. */
function tone(missKm: number): string {
  if (missKm < 1) return 'bg-red-500/20 text-red-300 border-red-400/40';
  if (missKm < 5) return 'bg-amber-500/20 text-amber-300 border-amber-400/40';
  return 'bg-white/10 text-gray-300 border-white/15';
}

export function ConjunctionPanel({
  sat, catalog, now, timeZone, onSelectSat,
}: {
  sat: SatData;
  catalog: SatData[];
  /** Simulated clock — the search runs forward from here. */
  now: Date;
  timeZone: string;
  onSelectSat: (sat: SatData) => void;
}) {
  const [results, setResults] = useState<Conjunction[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const cancelRef = useRef(false);

  // A new selection invalidates whatever is on screen, and cancels a running
  // search — the results belong to the satellite that was selected when they
  // were requested.
  useEffect(() => {
    cancelRef.current = true;
    setResults(null);
    setBusy(false);
    setProgress(0);
  }, [sat.satrec.satnum]);

  const run = useCallback(async () => {
    cancelRef.current = false;
    setBusy(true);
    setProgress(0);
    const found = await findConjunctionsAsync(
      sat,
      catalog,
      now,
      { thresholdKm: 10, horizonHours: 6 },
      () => cancelRef.current,
      (done, total) => setProgress(total > 0 ? done / total : 0)
    );
    if (cancelRef.current) return; // superseded — leave state to the new owner
    setResults(found ?? []);
    setBusy(false);
  }, [sat, catalog, now]);

  // Stop a running sweep when the panel unmounts, so a closed card does not
  // keep burning main-thread slices.
  useEffect(() => () => { cancelRef.current = true; }, []);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] font-mono font-bold text-gray-300 uppercase tracking-widest flex items-center gap-1.5">
          <Radar className="w-3 h-3 text-cyan-400" /> Close approaches · next 6 h
        </span>
        {busy ? (
          <button
            onClick={() => { cancelRef.current = true; setBusy(false); }}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-mono font-bold bg-white/5 border border-white/15 text-gray-300 hover:border-white/30"
          >
            <X className="w-2.5 h-2.5" /> STOP
          </button>
        ) : (
          <button
            onClick={run}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[9px] font-mono font-bold bg-cyan-600/30 border border-cyan-400/40 text-cyan-200 hover:bg-cyan-600/50"
          >
            <Play className="w-2.5 h-2.5" /> {results ? 'RESCAN' : 'SCAN'}
          </button>
        )}
      </div>

      {busy && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-gray-400">
            <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
            Sweeping co-altitude objects… {Math.round(progress * 100)}%
          </div>
          <div className="h-0.5 w-full bg-white/10 rounded-full overflow-hidden">
            <div className="h-full bg-cyan-400 rounded-full transition-all" style={{ width: `${progress * 100}%` }} />
          </div>
        </div>
      )}

      {!busy && results === null && (
        <p className="text-[10px] font-mono text-gray-500 leading-relaxed bg-white/5 border border-white/5 rounded-lg px-2.5 py-2">
          Searches the catalog for objects passing within 10 km of {sat.name} in the next
          six hours. This is a geometric miss distance from public orbital elements — not a
          collision probability, which needs tracking uncertainty the public data does not carry.
        </p>
      )}

      {!busy && results !== null && results.length === 0 && (
        <p className="text-[10px] font-mono text-gray-400 bg-white/5 border border-white/5 rounded-lg px-2.5 py-2">
          Nothing comes within 10 km in the next six hours. Its shell is quiet.
        </p>
      )}

      {!busy && results !== null && results.length > 0 && (
        <div className="space-y-1 min-w-0">
          {results.map((c) => (
            // Read-only rows. Earlier these were buttons that reselected the
            // radar's target — which silently threw away the current selection
            // and its whole panel of readouts. A close-approach list is a report,
            // not a navigator; clicking a row now does nothing. `overflow-hidden`
            // + `min-w-0` keep a long object name from pushing the panel wider
            // than its column and summoning a horizontal scrollbar on hover.
            <div
              key={`${c.other.satrec.satnum}-${c.time.getTime()}`}
              className="w-full min-w-0 overflow-hidden text-left px-2.5 py-1.5 rounded-lg bg-white/5 border border-white/5"
            >
              <div className="flex items-center justify-between gap-2 min-w-0">
                <span className="font-mono text-[11px] text-white truncate min-w-0">{c.other.name}</span>
                <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md border shrink-0 ${tone(c.missKm)}`}>
                  {formatMiss(c.missKm)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[9px] font-mono text-gray-500 mt-0.5 min-w-0">
                <span className="shrink-0">
                  {c.time.toLocaleTimeString('en-US', {
                    timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
                  })}
                </span>
                <span className="flex items-center gap-0.5 truncate min-w-0">
                  <Zap className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                  {c.relSpeedKmS.toFixed(2)} km/s relative
                </span>
              </div>
            </div>
          ))}
          <p className="flex items-start gap-1.5 text-[9px] font-mono text-gray-500 leading-relaxed pt-1">
            <AlertTriangle className="w-3 h-3 text-amber-500 shrink-0 mt-px" />
            Miss distances from public TLEs carry kilometre-scale error. Operators use tracking
            data with uncertainty estimates to make real avoidance decisions.
          </p>
        </div>
      )}
    </div>
  );
}
