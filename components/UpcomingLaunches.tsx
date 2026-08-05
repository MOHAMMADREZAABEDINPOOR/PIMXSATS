'use client';

// Upcoming Launches — Countdown Panel
//
// Shows the next upcoming rocket launches with live countdown timers, mission
// details, and status badges. Fetches from the Launch Library 2 API on the same
// 30-minute cadence as the cloud composite and the TLE catalog, and falls back
// to curated static data.
//
// The whole list is always visible — there is no collapse toggle. A five-item
// list behind a chevron is a puzzle, not a feature.

import { useState, useEffect, useRef, useCallback } from 'react';
import { Rocket, Clock, MapPin, Radio } from 'lucide-react';

/** Refresh cadence. Matches CLOUD_REFRESH_MS in lib/clouds.ts on purpose: the
 *  user's model is "the live parts of this app all re-check every half hour". */
const LAUNCH_REFRESH_MS = 30 * 60 * 1000;

/** How many launches to ask for. The list is never collapsed, so this is also
 *  how tall the panel gets. */
const LAUNCH_LIMIT = 8;

interface Launch {
  id: string;
  name: string;
  rocket: string;
  net: string; // ISO date
  pad: string;
  location: string;
  status: 'Go' | 'TBD' | 'Hold' | 'TBC';
  image?: string;
}

// Curated fallback data — real upcoming launches
const FALLBACK_LAUNCHES: Launch[] = [
  {
    id: 'f1',
    name: 'Starlink Group 12-7',
    rocket: 'Falcon 9',
    net: new Date(Date.now() + 2 * 86400000 + 7 * 3600000).toISOString(),
    pad: 'SLC-40',
    location: 'Cape Canaveral, FL',
    status: 'Go',
  },
  {
    id: 'f2',
    name: 'Crew Dragon Rotation',
    rocket: 'Falcon 9',
    net: new Date(Date.now() + 5 * 86400000 + 14 * 3600000).toISOString(),
    pad: 'LC-39A',
    location: 'Kennedy Space Center, FL',
    status: 'Go',
  },
  {
    id: 'f3',
    name: 'OneWeb Batch 20',
    rocket: 'Falcon 9',
    net: new Date(Date.now() + 8 * 86400000).toISOString(),
    pad: 'SLC-4E',
    location: 'Vandenberg SFB, CA',
    status: 'TBD',
  },
  {
    id: 'f4',
    name: 'Artemis III',
    rocket: 'SLS Block 1',
    net: new Date(Date.now() + 45 * 86400000).toISOString(),
    pad: 'LC-39B',
    location: 'Kennedy Space Center, FL',
    status: 'TBC',
  },
  {
    id: 'f5',
    name: 'Starship Flight 10',
    rocket: 'Starship',
    net: new Date(Date.now() + 12 * 86400000 + 3 * 3600000).toISOString(),
    pad: 'Starbase',
    location: 'Boca Chica, TX',
    status: 'TBD',
  },
];

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'LAUNCHED';
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function statusColor(status: string): { bg: string; text: string; border: string } {
  switch (status) {
    case 'Go': return { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: 'border-emerald-500/40' };
    case 'TBD': return { bg: 'bg-amber-500/20', text: 'text-amber-400', border: 'border-amber-500/40' };
    case 'Hold': return { bg: 'bg-red-500/20', text: 'text-red-400', border: 'border-red-500/40' };
    default: return { bg: 'bg-blue-500/20', text: 'text-blue-400', border: 'border-blue-500/40' };
  }
}

/** One launch row. `nowMs` is handed down rather than each card running its own
 *  clock: eight cards each with a 1 s interval meant eight React renders per
 *  second for a panel nobody is staring at. One tick in the parent, one render. */
function LaunchCard({ launch, nowMs }: { launch: Launch; nowMs: number }) {
  const remaining = new Date(launch.net).getTime() - nowMs;
  const sc = statusColor(launch.status);

  return (
    <div className="bg-white/5 border border-white/5 rounded-xl p-2 sm:p-2.5 space-y-1.5 hover:border-white/15 transition-colors shrink-0 w-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-mono font-bold text-white truncate">{launch.name}</div>
          <div className="text-[9px] font-mono text-gray-500 flex items-center gap-1 truncate">
            <Rocket className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate">{launch.rocket}</span>
          </div>
        </div>
        <span className={`text-[8px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border shrink-0 ${sc.bg} ${sc.text} ${sc.border}`}>
          {launch.status}
        </span>
      </div>

      {/* Countdown */}
      <div className="flex items-center gap-1.5 bg-black/40 rounded-lg px-2 py-1 border border-white/5">
        <Clock className="w-3 h-3 text-blue-400 shrink-0" />
        <span className={`text-[11px] font-mono font-bold tabular-nums ${remaining <= 0 ? 'text-emerald-400' : 'text-blue-300'}`}>
          T-{formatCountdown(remaining)}
        </span>
      </div>

      {/* Location */}
      {launch.location && (
        <div className="text-[9px] font-mono text-gray-500 flex items-center gap-1 min-w-0">
          <MapPin className="w-2.5 h-2.5 shrink-0" />
          <span className="truncate">{launch.location}</span>
        </div>
      )}
    </div>
  );
}

/** Shape of one Launch Library 2 record, as far as we care. Everything is
 *  optional because the API is free and its `mode=list` payload is not
 *  contractual — a missing nested object must degrade, never throw. */
function mapLaunch(r: Record<string, unknown>): Launch | null {
  const obj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

  const net = String(r.net || '');
  if (!net || Number.isNaN(new Date(net).getTime())) return null;

  const rocket = obj(r.rocket);
  const config = rocket ? obj(rocket.configuration) : null;
  const pad = obj(r.pad);
  const loc = pad ? obj(pad.location) : null;
  const status = obj(r.status);
  const abbrev = status ? String(status.abbrev || 'TBD') : 'TBD';

  return {
    id: String(r.id ?? net),
    name: String(r.name || 'Unnamed mission'),
    rocket: config ? String(config.name || 'Unknown') : 'Unknown',
    net,
    pad: pad ? String(pad.name || '') : '',
    location: loc ? String(loc.name || '') : '',
    status:
      abbrev === 'Go' ? 'Go'
        : abbrev === 'Hold' ? 'Hold'
        : abbrev === 'TBC' ? 'TBC'
        : 'TBD',
  };
}

export function UpcomingLaunches() {
  const [launches, setLaunches] = useState<Launch[]>(FALLBACK_LAUNCHES);
  const [live, setLive] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);

  // One clock for every countdown in the panel.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // In-flight guard. A refresh landing while the previous one is still open
  // would double the request rate against a free, rate-limited API.
  const inflightRef = useRef(false);
  const lastOkRef = useRef(0);

  const refresh = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      // `mode=list` is the cheap projection. The timeout is what keeps a stalled
      // upstream from holding the guard closed until the next tick.
      const res = await fetch(
        `https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=${LAUNCH_LIMIT}&mode=list`,
        { signal: AbortSignal.timeout(8000), cache: 'no-store' }
      );
      if (!res.ok) return;
      const data = await res.json();
      const rows: unknown[] = Array.isArray(data?.results) ? data.results : [];
      const mapped = rows
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map(mapLaunch)
        .filter((l): l is Launch => l !== null)
        // The API returns them in NET order already, but a mis-sorted list with
        // a T-minus on every row is confusing enough to be worth the sort.
        .sort((a, b) => new Date(a.net).getTime() - new Date(b.net).getTime());
      if (mapped.length > 0) {
        setLaunches(mapped);
        setLive(true);
        lastOkRef.current = Date.now();
        setFetchedAt(lastOkRef.current);
      }
    } catch {
      // Keep whatever we already have — the curated fallback on a cold start,
      // the previous live payload otherwise. The badge stays honest either way.
    } finally {
      inflightRef.current = false;
    }
  }, []);

  useEffect(() => {
    // The first load is deferred to idle time. On mount the app is still
    // compiling shaders and building the first frame of a 10,000-object scene;
    // adding a fetch + JSON parse to that critical path is exactly the kind of
    // thing that shows up as a hitch. `requestIdleCallback` is not in Safari, so
    // a short timeout stands in.
    const idle = (fn: () => void) => {
      const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback;
      if (ric) { ric(fn, { timeout: 4000 }); return; }
      setTimeout(fn, 1200);
    };
    idle(() => { void refresh(); });

    const id = setInterval(() => {
      // A hidden tab gets no work: browsers throttle its timers anyway, and
      // burning a rate-limited request for a panel nobody can see is waste. The
      // visibility listener below picks the refresh up on return.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh();
    }, LAUNCH_REFRESH_MS);

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastOkRef.current < LAUNCH_REFRESH_MS) return;
      void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-[9px] font-mono uppercase tracking-widest">
        <span className="flex items-center gap-1.5 text-gray-400 min-w-0">
          <Rocket className="w-3 h-3 text-orange-400 shrink-0" />
          <span className="truncate">Upcoming launches</span>
        </span>
        {/* Provenance, not decoration: a curated fallback must not look live. */}
        <span
          className={`flex items-center gap-1 shrink-0 ${live ? 'text-emerald-400' : 'text-gray-600'}`}
          title={
            live && fetchedAt
              ? `Live from Launch Library 2 · checked ${new Date(fetchedAt).toLocaleTimeString()} · re-checks every ${LAUNCH_REFRESH_MS / 60000} min`
              : 'Upstream unavailable — showing curated reference launches'
          }
        >
          <Radio className="w-2.5 h-2.5" />
          {live ? 'LIVE' : 'CACHED'}
        </span>
      </div>

      <div className="space-y-1.5">
        {launches.map((launch) => (
          <LaunchCard key={launch.id} launch={launch} nowMs={nowMs} />
        ))}
      </div>
    </div>
  );
}
