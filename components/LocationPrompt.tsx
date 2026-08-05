'use client';

// Shared "enable location" prompt.
//
// Passes and Overhead Alerts are both useless without an observer position, and
// both used to say so with a dead sentence ("Enable location to…") that gave the
// user nowhere to click. The browser only prompts on a user gesture anyway, so
// the fix is the same in both places: state what it unlocks, and put the button
// right there.

import { MapPin, Loader2, MapPinOff } from 'lucide-react';

export type LocationPermission = 'idle' | 'pending' | 'granted' | 'denied';

export function LocationPrompt({
  permission, onRequest, what,
}: {
  permission: LocationPermission;
  /** Omitted when the host has no way to ask — the prompt degrades to text. */
  onRequest?: () => void;
  /** One clause naming what location unlocks, e.g. "watch for passes over you". */
  what: string;
}) {
  if (permission === 'pending') {
    return (
      <div className="flex items-center gap-1.5 text-[10px] font-mono text-gray-400 bg-white/5 border border-white/5 rounded-xl px-3 py-2.5">
        <Loader2 className="w-3 h-3 animate-spin text-emerald-400 shrink-0" />
        Waiting for your location…
      </div>
    );
  }

  // A hard denial cannot be undone from JavaScript — the browser will not
  // re-prompt. Saying so is more useful than a button that silently does
  // nothing, so this branch points at the site settings instead.
  if (permission === 'denied') {
    return (
      <div className="bg-white/5 border border-white/5 rounded-xl px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[10px] font-mono font-bold text-amber-300">
          <MapPinOff className="w-3 h-3 shrink-0" /> Location blocked
        </div>
        <p className="text-[10px] font-mono text-gray-500 leading-relaxed mt-1">
          Your browser has location turned off for this site. Allow it from the padlock icon in the
          address bar, then press the button below.
        </p>
        {onRequest && (
          <button
            onClick={onRequest}
            className="mt-2 flex items-center justify-center gap-1.5 w-full py-1.5 rounded-lg bg-white/5 border border-white/15 text-[10px] font-mono font-bold tracking-widest text-gray-300 hover:border-emerald-400/40 hover:text-emerald-300 chip-btn"
          >
            <MapPin className="w-3 h-3" /> TRY AGAIN
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white/5 border border-white/5 rounded-xl px-3 py-2.5">
      <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
        Share your location to {what}. It stays on your device — nothing is uploaded.
      </p>
      {onRequest && (
        <button
          onClick={onRequest}
          className="mt-2 flex items-center justify-center gap-1.5 w-full py-2 rounded-lg bg-emerald-500/15 border border-emerald-400/40 text-[10px] font-mono font-bold tracking-widest text-emerald-200 hover:bg-emerald-500/25 chip-btn"
        >
          <MapPin className="w-3.5 h-3.5" /> USE MY LOCATION
        </button>
      )}
    </div>
  );
}
