'use client';

// "When can I actually see it?" — the next passes of the selected satellite
// over the user's own position, graded and counted down.
//
// The scan is thousands of SGP4 propagations, so it runs through the chunked
// predictor and is kicked off only when this panel is actually on screen. A
// superseded request (new satellite, big time jump) is cancelled rather than
// left to finish.

import { useEffect, useState } from 'react';
import { Eye, EyeOff, MapPin, Radar, Loader2 } from 'lucide-react';
import { SatData } from '@/lib/satellite';
import { LocationPrompt } from './LocationPrompt';
import {
  SatellitePass, predictPassesAsync, compassPoint, formatDuration, formatCountdown, passQuality,
} from '@/lib/passes';

const QUALITY_STYLE: Record<ReturnType<typeof passQuality>, string> = {
  excellent: 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40',
  good: 'bg-blue-500/20 text-blue-300 border-blue-400/40',
  fair: 'bg-white/10 text-gray-400 border-white/15',
};

export function PassesPanel({
  sat, observer, timeZone, now, compact = false, compactLimit = Infinity,
  locationPermission = 'idle', onRequestLocation,
}: {
  sat: SatData;
  observer: { lat: number; lon: number } | null;
  timeZone: string;
  /** Simulated clock — passes are predicted forward from here, so time
   *  travel shows the sky of whatever date is loaded. */
  now: Date;
  /** Two dense lines per pass instead of a full card. Used by the info card,
   *  whose pass pane is a scrolling region inside a fixed-height panel — the
   *  tighter row keeps several passes in view before you have to scroll. */
  compact?: boolean;
  /** How many rows compact mode shows. Unlimited by default now that the info
   *  card's pass pane scrolls; pass a number to cap it, and the "+N more" line
   *  below counts whatever is left over so the cap is never silent. */
  compactLimit?: number;
  /** State of the browser geolocation grant, so the "no location" branch can
   *  offer the button in place instead of a dead instruction. */
  locationPermission?: 'idle' | 'pending' | 'granted' | 'denied';
  onRequestLocation?: () => void;
}) {
  // Quantised to 5 minutes: the panel's clock ticks 4×/s, and re-running a
  // 24 h scan on every tick would be absurd. Passes drift by seconds over
  // five minutes, which is well inside the reported resolution.
  const fromBucket = Math.floor(now.getTime() / 300000);
  const requestKey = observer ? `${sat.name}|${observer.lat}|${observer.lon}|${fromBucket}` : '';

  // The completed scan is stamped with the request it answers, so "still
  // working" is DERIVED rather than tracked with a second state flag that
  // would have to be flipped synchronously on every input change.
  const [result, setResult] = useState<{ key: string; passes: SatellitePass[] } | null>(null);
  const busy = Boolean(observer) && result?.key !== requestKey;
  const passes = result?.key === requestKey ? result.passes : null;

  useEffect(() => {
    if (!observer) return;
    let cancelled = false;

    predictPassesAsync(
      sat.satrec,
      observer,
      new Date(fromBucket * 300000),
      { horizonHours: 24, maxPasses: 5 },
      () => cancelled
    )
      .then((found) => {
        if (cancelled || found === null) return;
        setResult({ key: requestKey, passes: found });
      })
      .catch(() => {
        if (!cancelled) setResult({ key: requestKey, passes: [] });
      });

    return () => { cancelled = true; };
  }, [sat, observer, fromBucket, requestKey]);

  if (!observer) {
    return (
      <div className="bg-white/5 rounded-xl p-3 border border-white/5">
        <div className="flex items-center gap-1.5 text-[11px] font-mono text-gray-300 mb-1.5">
          <MapPin className="w-3.5 h-3.5 text-emerald-400" /> Location needed
        </div>
        <LocationPrompt
          permission={locationPermission}
          onRequest={onRequestLocation}
          what={compact
            ? 'get rise time, direction to look and naked-eye visibility'
            : `work out exactly when ${sat.name} next crosses your sky`}
        />
      </div>
    );
  }

  const shown = compact ? passes?.slice(0, compactLimit) : passes;

  return (
    <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
      <div className="flex items-center justify-between text-[9px] font-mono uppercase tracking-widest text-gray-500">
        <span className="flex items-center gap-1.5">
          <Radar className="w-3.5 h-3.5 text-emerald-400" /> Next passes over you
        </span>
        <span className="text-gray-600">
          {observer.lat.toFixed(2)}°, {observer.lon.toFixed(2)}°
        </span>
      </div>

      {busy && (
        <div className="flex items-center gap-2 text-[11px] font-mono text-gray-400 px-1 py-3">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-400" />
          Propagating 24 hours of orbit…
        </div>
      )}

      {!busy && passes && passes.length === 0 && (
        <div className="text-[11px] font-mono text-gray-400 leading-relaxed bg-white/5 rounded-xl p-3 border border-white/5">
          {compact ? (
            <>No pass above 10° in the next 24 h — this orbit rarely reaches your latitude.</>
          ) : (
            <>
              {sat.name} does not rise more than 10° above your horizon in the next 24 hours — its
              orbit simply doesn&apos;t reach your latitude often enough. Try a satellite in a higher
              inclination orbit, such as the ISS.
            </>
          )}
        </div>
      )}

      {/* Compact: one pass per two dense lines. Everything the full card shows
          is still here — time, countdown, peak elevation, grade, naked-eye
          visibility, rise/set bearings, duration — just written tighter. */}
      {!busy && compact && shown?.map((pass) => {
        const quality = passQuality(pass);
        return (
          <div
            key={pass.start.getTime()}
            className="bg-white/5 rounded-lg border border-white/5 px-2 py-1.5 font-mono"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold text-white truncate">
                {pass.start.toLocaleString('en-US', {
                  timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
                })}
              </span>
              <span className="text-[10px] text-amber-300 shrink-0">{formatCountdown(pass.start, now)}</span>
            </div>
            <div className="flex items-center gap-1.5 mt-1 text-[9px] text-gray-400">
              <span className={`font-bold uppercase px-1 py-px rounded border shrink-0 ${QUALITY_STYLE[quality]}`}>
                {pass.maxElevationDeg.toFixed(0)}° {quality}
              </span>
              <span
                className={`shrink-0 flex items-center gap-1 ${pass.visible ? 'text-amber-300' : 'text-gray-500'}`}
                title={pass.visible
                  ? 'Sunlit satellite over a dark sky — visible to the naked eye'
                  : 'Above the horizon, but not lit against a dark sky'}
              >
                {pass.visible ? <Eye className="w-2.5 h-2.5" /> : <EyeOff className="w-2.5 h-2.5" />}
                {pass.visible ? 'eye' : 'radio'}
              </span>
              <span className="ml-auto truncate" title={`Rises ${compassPoint(pass.startAzimuthDeg)}, peaks ${compassPoint(pass.peakAzimuthDeg)}, sets ${compassPoint(pass.endAzimuthDeg)}`}>
                {compassPoint(pass.startAzimuthDeg)}→{compassPoint(pass.endAzimuthDeg)} · {formatDuration(pass.durationSec)}
              </span>
            </div>
          </div>
        );
      })}

      {!busy && compact && passes && passes.length > compactLimit && (
        <div className="text-[9px] font-mono text-gray-500 text-center">
          +{passes.length - compactLimit} more in the next 24 h
        </div>
      )}

      {!busy && !compact && passes && passes.map((pass) => {
        const quality = passQuality(pass);
        return (
          <div
            key={pass.start.getTime()}
            className="bg-white/5 rounded-xl border border-white/5 p-2.5 space-y-1.5 font-mono"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-white">
                {pass.start.toLocaleString('en-US', {
                  timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
                })}
              </span>
              <span className="text-[10px] text-amber-300">{formatCountdown(pass.start, now)}</span>
            </div>

            <div className="flex items-center gap-1.5 flex-wrap">
              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-md border ${QUALITY_STYLE[quality]}`}>
                {pass.maxElevationDeg.toFixed(0)}° max · {quality}
              </span>
              <span
                className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-md border flex items-center gap-1 ${
                  pass.visible
                    ? 'bg-amber-400/15 text-amber-300 border-amber-400/40'
                    : 'bg-white/5 text-gray-500 border-white/10'
                }`}
                title={
                  pass.visible
                    ? 'Sunlit satellite over a dark sky — visible to the naked eye'
                    : 'Above the horizon, but not lit against a dark sky'
                }
              >
                {pass.visible ? <Eye className="w-2.5 h-2.5" /> : <EyeOff className="w-2.5 h-2.5" />}
                {pass.visible ? 'naked eye' : 'radio only'}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-1.5 text-[10px]">
              <div>
                <div className="text-gray-500 text-[8px] uppercase tracking-widest">Rises</div>
                <div className="text-gray-200">{compassPoint(pass.startAzimuthDeg)}</div>
              </div>
              <div>
                <div className="text-gray-500 text-[8px] uppercase tracking-widest">Peaks</div>
                <div className="text-gray-200">{compassPoint(pass.peakAzimuthDeg)}</div>
              </div>
              <div>
                <div className="text-gray-500 text-[8px] uppercase tracking-widest">Sets</div>
                <div className="text-gray-200">{compassPoint(pass.endAzimuthDeg)}</div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-x-2 gap-y-0.5 flex-wrap text-[10px] text-gray-400 pt-1 border-t border-white/5">
              <span>Visible for {formatDuration(pass.durationSec)}</span>
              <span>{pass.peakRangeKm.toFixed(0)} km at closest</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
