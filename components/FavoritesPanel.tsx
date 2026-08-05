'use client';

// My Fleet — the user's saved shortlist, as a live panel.
//
// The fleet is a handful of NORAD ids in localStorage (see lib/favorites).
// This resolves them against the live catalog every render, shows each one with
// enough telemetry to be useful at a glance, and lets the user jump to one or
// drop it. It is deliberately quiet when empty: a first-time user sees how to
// start a fleet, not a broken-looking blank box.

import { useMemo } from 'react';
import { Star, Crosshair, Trash2 } from 'lucide-react';
import type { SatData } from '@/lib/satellite';
import {
  getFavorites, resolveFavorites, toggleFavorite, satId, MAX_FAVORITES,
} from '@/lib/favorites';
import { useFavorites } from '@/hooks/use-favorites';

export function FavoritesPanel({
  satellites, selectedSat, onSelectSat, onTrackSat,
}: {
  satellites: SatData[];
  selectedSat: SatData | null;
  onSelectSat: (sat: SatData) => void;
  /** Select AND fly the camera onto the object. The crosshair button is the
   *  only control in the panel that promises a camera move, so it is the only
   *  one that gets this — tapping the name still just opens the card, which is
   *  what you want when you are reading down the list. */
  onTrackSat?: (sat: SatData) => void;
}) {
  // Subscribe so an add/remove anywhere (the info-card star, another panel)
  // re-renders this list immediately.
  useFavorites();
  const ids = getFavorites();
  const fleet = useMemo(() => resolveFavorites(satellites), [satellites, ids]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <span className="text-xs font-bold text-gray-300 uppercase tracking-widest flex items-center gap-1.5 min-w-0">
          <Star className="w-3.5 h-3.5 text-amber-400 shrink-0" /> My Fleet
        </span>
        <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-white/5 text-gray-500 font-mono shrink-0 whitespace-nowrap">
          {ids.length} / {MAX_FAVORITES}
        </span>
      </div>

      {ids.length === 0 ? (
        <div className="text-[11px] font-mono text-gray-500 leading-relaxed bg-white/5 border border-white/5 rounded-xl px-3 py-2.5">
          Your fleet is empty. Open any satellite and tap the{' '}
          <Star className="w-3 h-3 inline text-amber-400 -mt-0.5" /> star to pin it here —
          the ones you actually care about, kept on this device.
        </div>
      ) : fleet.length === 0 ? (
        <div className="text-[11px] font-mono text-gray-500 leading-relaxed bg-white/5 border border-white/5 rounded-xl px-3 py-2.5">
          Your {ids.length} pinned object{ids.length === 1 ? '' : 's'} {ids.length === 1 ? 'is' : 'are'} not in
          the current catalog snapshot — they may return in a later update. Nothing has been deleted.
        </div>
      ) : (
        /* Desktop-only cap and inner scroll — same reason as the alerts list:
           in the mobile drawer a `40vh` self-scrolling box inside a scrolling
           drawer means a drag on a fleet row never moves the drawer. */
        <div className="space-y-1 lg:max-h-[40vh] lg:overflow-y-auto custom-scrollbar pr-1 -mr-1">
          {fleet.map((sat) => {
            const isSelected = sat === selectedSat;
            return (
              <div
                key={satId(sat)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border row-hover ${
                  isSelected ? 'bg-blue-600/25 border-blue-500/40' : 'border-transparent hover:bg-white/5'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: sat.color, boxShadow: `0 0 6px ${sat.color}` }}
                />
                <button
                  onClick={() => onSelectSat(sat)}
                  className="flex flex-col min-w-0 flex-1 text-left"
                  title={`Open ${sat.name}`}
                >
                  <span className="font-mono text-xs text-white truncate">{sat.name}</span>
                  <span className="text-[9px] font-mono text-gray-500 truncate">
                    {sat.category} · {sat.band}
                  </span>
                </button>
                <button
                  onClick={() => (onTrackSat ?? onSelectSat)(sat)}
                  title="Fly the camera onto this object"
                  aria-label={`Fly the camera to ${sat.name}`}
                  className="p-1 rounded-md text-gray-400 hover:text-blue-300 hover:bg-white/10 shrink-0"
                >
                  <Crosshair className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => toggleFavorite(satId(sat))}
                  title="Remove from fleet"
                  className="p-1 rounded-md text-gray-400 hover:text-red-300 hover:bg-white/10 shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The pin/unpin star for the info card. Compact and self-contained: it reads
 *  and writes the fleet store directly, so it never needs the parent to thread
 *  favorite state down. */
export function FavoriteStar({ sat }: { sat: SatData }) {
  useFavorites();
  const id = satId(sat);
  const pinned = getFavorites().includes(id);
  const full = getFavorites().length >= MAX_FAVORITES;
  const disabled = !pinned && full;

  return (
    <button
      onClick={() => toggleFavorite(id)}
      disabled={disabled}
      title={
        pinned ? 'Remove from My Fleet'
          : disabled ? `Fleet is full (${MAX_FAVORITES} max)`
          : 'Add to My Fleet'
      }
      aria-pressed={pinned}
      className={`p-1.5 rounded-full transition-colors shrink-0 ${
        pinned
          ? 'text-amber-400 hover:bg-amber-400/10'
          : disabled
            ? 'text-gray-600 cursor-not-allowed'
            : 'text-gray-400 hover:text-amber-300 hover:bg-white/10'
      }`}
    >
      <Star className={`w-4 h-4 ${pinned ? 'fill-amber-400' : ''}`} />
    </button>
  );
}
