'use client';

// Space history scrubber — drag through the space age.
//
// A single slider from 1957 to this year, bound to the app's simulated clock:
// moving it sets the simulated time to 1 January of the chosen year, and the
// existing era-filter in SatelliteApp (which hides objects launched after the
// simulated time) does the rest. So this control does not need its own filtered
// catalog — it steers the clock, and the scene it already drives responds.
//
// Under the slider: the milestone caption for the selected year, and a launch
// sparkline built from the live catalog that makes the post-2019
// megaconstellation wall impossible to miss.

import { useEffect, useMemo, useRef, useState } from 'react';
import { History, Pause, Play, X } from 'lucide-react';
import type { SatData } from '@/lib/satellite';
import {
  TIMELINE_START_YEAR, PLAY_START_YEAR, PLAY_YEAR_STEP_MS,
  eraForYear, launchHistory,
} from '@/lib/history';

export function HistoryScrubber({
  satellites, simYear, onSetYear, onPlay, onClose,
}: {
  satellites: SatData[];
  /** The simulated clock's current UTC year. */
  simYear: number;
  /** Jump the simulated clock to 1 Jan of `year`. */
  onSetYear: (year: number) => void;
  /** Prepare the app clock for playback — the caller drops real-time mode and
   *  parks the year at {@link PLAY_START_YEAR}. The stepping itself happens
   *  here. */
  onPlay: () => void;
  onClose: () => void;
}) {
  const thisYear = new Date().getUTCFullYear();
  const history = useMemo(() => launchHistory(satellites), [satellites]);
  const maxLaunched = useMemo(
    () => history.reduce((m, p) => Math.max(m, p.launched), 0),
    [history]
  );
  const year = Math.min(Math.max(simYear, TIMELINE_START_YEAR), thisYear);
  const era = eraForYear(year);
  const point = history.find((p) => p.year === year);

  // Playback runs HERE, on a wall-clock interval, rather than by cranking the
  // app's time-warp up to ~10,000,000x. A warp that large would step the SGP4
  // propagator by months between frames, which is not a fast movie of the space
  // age — it is numerical garbage. One interval tick = one year is exact, and
  // the scene keeps propagating at 1x inside each year.
  const [playing, setPlaying] = useState(false);
  const yearRef = useRef(year);
  yearRef.current = year;

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const next = yearRef.current + 1;
      if (next > thisYear) { setPlaying(false); return; }
      onSetYear(next);
    }, PLAY_YEAR_STEP_MS);
    return () => clearInterval(id);
  }, [playing, thisYear, onSetYear]);

  // Dragging the slider (or clicking a bar) while playing is a takeover, not a
  // fight: stop the playback and let the user scrub.
  const setYearManually = (y: number) => {
    setPlaying(false);
    onSetYear(y);
  };

  return (
    <div className="pointer-events-auto w-[min(96vw,40rem)] bg-black/80 backdrop-blur-2xl border border-white/10 rounded-2xl px-3 sm:px-4 py-3 shadow-2xl animate-fade-up">
      <div className="flex items-start justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          <div className="text-[9px] font-mono uppercase tracking-widest text-violet-300 flex items-center gap-1.5 truncate">
            <History className="w-3 h-3 shrink-0" /> <span className="truncate">Space history · {era.label}</span>
          </div>
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-xl sm:text-2xl font-mono font-bold text-white tabular-nums shrink-0">{year}</span>
            {point && (
              <span className="text-[10px] font-mono text-gray-400 truncate">
                {point.cumulative.toLocaleString()} objects up · {point.launched.toLocaleString()} launched this year
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
          <button
            onClick={() => {
              if (playing) { setPlaying(false); return; }
              // Always restart from the beginning of the playable era — PLAY is
              // "watch the space age happen", not "resume from wherever I left
              // the slider".
              onPlay();
              setPlaying(true);
            }}
            title={playing ? 'Pause the timeline' : `Play the timeline from ${PLAY_START_YEAR} — one year every ${PLAY_YEAR_STEP_MS / 1000} s`}
            aria-pressed={playing}
            className={`flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-xl border text-[10px] font-mono font-bold chip-btn ${
              playing
                ? 'border-violet-300/60 bg-violet-400/30 text-white'
                : 'border-violet-400/40 bg-violet-500/20 text-violet-200 hover:bg-violet-500/30'
            }`}
          >
            {playing
              ? <><Pause className="w-3 h-3" /> PAUSE</>
              : <><Play className="w-3 h-3" /> PLAY</>}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-white/10"
            aria-label="Close history scrubber"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Launch sparkline. Each bar is a year; the current year is highlighted.
          Clicking a bar jumps there — the slider is for sweeping, the bars for
          pouncing on a specific spike. */}
      <div className="mt-3 flex items-end gap-px h-12 sm:h-16">
        {history.map((p) => {
          const h = maxLaunched > 0 ? (p.launched / maxLaunched) * 100 : 0;
          const isNow = p.year === year;
          return (
            <button
              key={p.year}
              onClick={() => setYearManually(p.year)}
              title={`${p.year} · ${p.launched.toLocaleString()} launched · ${p.cumulative.toLocaleString()} total`}
              className="flex-1 min-w-0 h-full flex flex-col justify-end group"
            >
              <div
                className={`w-full rounded-t transition-colors ${
                  isNow ? 'bg-violet-300' : 'bg-violet-500/50 group-hover:bg-violet-400'
                }`}
                style={{ height: `${Math.max(h, p.launched > 0 ? 2 : 0)}%` }}
              />
            </button>
          );
        })}
      </div>

      {/* The slider itself */}
      <input
        type="range"
        min={TIMELINE_START_YEAR}
        max={thisYear}
        value={year}
        onChange={(e) => setYearManually(parseInt(e.target.value, 10))}
        className="w-full mt-2 accent-violet-400 cursor-pointer"
        aria-label="Year"
      />
      <div className="flex justify-between text-[8px] font-mono text-gray-600">
        <span>{TIMELINE_START_YEAR}</span>
        <span>{thisYear}</span>
      </div>

      <p className="text-[10px] font-mono text-gray-400 leading-relaxed mt-2 bg-white/5 border border-white/5 rounded-lg px-2.5 py-2">
        {era.caption}
      </p>
      <p className="text-[8px] font-mono text-gray-600 leading-relaxed mt-1.5">
        Shows objects in today&apos;s catalog launched by the selected year — surviving hardware
        over time, not the catalog as it stood then. Re-entered objects are absent.
      </p>
    </div>
  );
}
