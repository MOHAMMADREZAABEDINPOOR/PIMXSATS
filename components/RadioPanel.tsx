'use client';

// Live radio — the selected satellite's downlink, Doppler-corrected right now.
//
// Shown only for objects we have published frequency data for, which is a small
// minority of the catalog. That is deliberate: inventing a frequency for an
// object whose downlink is not public would be worse than showing nothing.
//
// The Doppler figure updates on a 1 s tick because that is the timescale on
// which it actually matters — during a high pass the shift sweeps through its
// whole range in a couple of minutes, and a static number would be wrong for
// most of the pass.

import { useEffect, useMemo, useState } from 'react';
import { Radio, Antenna, Waves, Info } from 'lucide-react';
import type { SatData } from '@/lib/satellite';
import { radioProfile, dopplerMhz, formatMhz, formatShift } from '@/lib/radio';

const MODE_TONE: Record<string, string> = {
  FM: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40',
  SSB: 'bg-blue-500/20 text-blue-300 border-blue-400/40',
  CW: 'bg-white/10 text-gray-300 border-white/15',
  APT: 'bg-amber-500/20 text-amber-300 border-amber-400/40',
  LRPT: 'bg-orange-500/20 text-orange-300 border-orange-400/40',
  BPSK: 'bg-violet-500/20 text-violet-300 border-violet-400/40',
  AFSK: 'bg-cyan-500/20 text-cyan-300 border-cyan-400/40',
  Digital: 'bg-white/10 text-gray-400 border-white/15',
};

export function RadioPanel({
  sat, observer, now,
}: {
  sat: SatData;
  observer: { lat: number; lon: number } | null;
  /** Simulated clock, sampled by the parent. Used as the seed instant; the
   *  panel re-reads it on its own tick so the shift stays live. */
  now: Date;
}) {
  const profile = radioProfile(sat);
  const [tick, setTick] = useState(0);

  // Doppler changes meaningfully second to second during a pass.
  useEffect(() => {
    if (!profile || !observer) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [profile, observer]);

  // Shifted frequencies for every channel, recomputed each tick. `tick` and
  // `now` are both dependencies: the interval drives the live update, and a
  // time-travel jump re-seeds it.
  const shifts = useMemo(() => {
    if (!profile || !observer) return null;
    const at = new Date();
    return profile.channels.map((ch) =>
      dopplerMhz(ch.downlinkMhz, sat.satrec, { lat: observer.lat, lon: observer.lon }, at)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, observer, sat.satrec, tick, now]);

  if (!profile) {
    return (
      <div className="bg-white/5 border border-white/5 rounded-xl p-3 text-center font-mono space-y-1.5">
        <Radio className="w-6 h-6 text-gray-500 mx-auto" />
        <h4 className="text-[11px] font-bold text-gray-300">NO PUBLISHED DOWNLINK</h4>
        <p className="text-[10px] text-gray-400 leading-snug">
          No public frequency data for this object. Most of the catalog is debris, rocket
          bodies, or payloads whose downlinks are not published.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[9px] font-mono font-bold text-gray-300 uppercase tracking-widest">
        <Antenna className="w-3 h-3 text-emerald-400" /> {profile.name}
      </div>

      <p className="text-[10px] font-mono text-gray-400 leading-relaxed bg-white/5 border border-white/5 rounded-lg px-2.5 py-2">
        {profile.note}
      </p>

      <div className="space-y-1.5">
        {profile.channels.map((ch, i) => {
          const shifted = shifts ? shifts[i] : null;
          return (
            <div key={`${ch.downlinkMhz}-${ch.mode}`} className="bg-white/5 border border-white/5 rounded-xl px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-mono font-bold text-white truncate">{ch.label}</span>
                <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded-md border shrink-0 ${
                  MODE_TONE[ch.mode] ?? 'bg-white/10 text-gray-400 border-white/15'
                }`}>
                  {ch.mode}
                </span>
              </div>

              <div className="flex items-baseline justify-between gap-2 mt-1">
                <span className="text-[9px] font-mono text-gray-500 uppercase tracking-wider">Nominal</span>
                <span className="text-[11px] font-mono text-gray-200">{formatMhz(ch.downlinkMhz)}</span>
              </div>

              {shifted !== null ? (
                <div className="flex items-baseline justify-between gap-2 mt-0.5">
                  <span className="text-[9px] font-mono text-cyan-400 uppercase tracking-wider flex items-center gap-1">
                    <Waves className="w-2.5 h-2.5" /> Tune to
                  </span>
                  <span className="text-[11px] font-mono font-bold text-cyan-300">
                    {formatMhz(shifted)}
                    <span className="text-gray-500 ml-1.5">{formatShift(ch.downlinkMhz, shifted)}</span>
                  </span>
                </div>
              ) : (
                <div className="text-[9px] font-mono text-gray-500 mt-0.5">
                  Doppler needs your location — enable it to get the tuned frequency.
                </div>
              )}

              <div className="text-[9px] font-mono text-gray-500 mt-1 leading-snug">{ch.gear}</div>
            </div>
          );
        })}
      </div>

      <p className="flex items-start gap-1.5 text-[9px] font-mono text-gray-500 leading-relaxed">
        <Info className="w-3 h-3 text-blue-400 shrink-0 mt-px" />
        Frequencies are published values and change occasionally. Listening is unlicensed in
        most countries; transmitting is not — that needs an amateur licence.
      </p>
    </div>
  );
}
