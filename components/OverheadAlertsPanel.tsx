'use client';

// Live overhead alerts — a standing watch over the user's fleet.
//
// This is the fleet's payoff: instead of opening each satellite to check its
// passes, the user gets one countdown to the next thing crossing their sky, and
// — if they opt in — a system notification a few minutes before it rises, even
// with the tab in the background.
//
// The scan is expensive, so it is rate-limited hard: it runs when the fleet or
// the location changes, and otherwise at most every few minutes. The countdown
// ticks locally against the cached scan and costs nothing.
//
// This panel deliberately runs on the REAL wall clock and ignores the app's
// simulated time. Everything else in the app follows the time-travel clock,
// which is the point of it — but an alert is a promise about the sky you can
// walk outside and look at. Driven by the simulated clock it would count down to
// a pass in 1994, or fire a system notification for one, which is worse than
// useless. So `now` is not a prop here: the panel keeps its own one-second
// ticker.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, BellOff, BellRing, Loader2, Eye, Crosshair } from 'lucide-react';
import { LocationPrompt } from './LocationPrompt';
import type { SatData } from '@/lib/satellite';
import type { Observer } from '@/lib/passes';
import { compassPoint, formatCountdown } from '@/lib/passes';
import {
  OverheadAlert, scanForAlerts, nextAlert, isOverheadNow,
  fireDueNotifications, notifyPermission, requestNotifyPermission,
  resetFiredAlerts, NotifyPermission,
} from '@/lib/alerts';

/** Re-scan no more often than this even if inputs churn. */
const MIN_RESCAN_MS = 5 * 60_000;

export function OverheadAlertsPanel({
  fleet, observer, onSelectSat, locationPermission = 'idle', onRequestLocation,
}: {
  /** The satellites to watch — the user's fleet. */
  fleet: SatData[];
  observer: { lat: number; lon: number } | null;
  onSelectSat: (sat: SatData) => void;
  /** State of the browser geolocation grant, so the panel can offer the button
   *  in place rather than telling the user to find a setting. */
  locationPermission?: 'idle' | 'pending' | 'granted' | 'denied';
  /** Ask for location now. Omitted when the host cannot request it. */
  onRequestLocation?: () => void;
}) {
  const [alerts, setAlerts] = useState<OverheadAlert[]>([]);
  const [busy, setBusy] = useState(false);
  const [perm, setPerm] = useState<NotifyPermission>('default');
  const cancelRef = useRef(false);
  const lastScanRef = useRef(0);
  // Key of the last inputs scanned, so a fleet/location change forces a rescan
  // while a mere clock tick does not.
  const scanKeyRef = useRef('');

  // Real time, once a second — the only clock this panel knows about.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { setPerm(notifyPermission()); }, []);

  const runScan = useCallback(async (obs: Observer) => {
    cancelRef.current = false;
    setBusy(true);
    resetFiredAlerts(); // inputs changed — previous "fired" keys are stale
    const found = await scanForAlerts(
      // Sampled at scan time, not from the render-time `now` state: a scan
      // started from a second-old timestamp would be minutely wrong for no
      // reason, and this must be the real instant regardless of app time.
      fleet, obs, new Date(),
      { horizonHours: 12, minElevationDeg: 15, maxAlerts: 8 },
      () => cancelRef.current
    );
    if (cancelRef.current) return;
    setAlerts(found ?? []);
    setBusy(false);
    lastScanRef.current = Date.now();
  }, [fleet]);

  // Scan when the fleet or observer changes. The clock is deliberately absent
  // from the deps: this effect's cleanup cancels an in-flight scan, so ticking it
  // every second would kill every scan before it could finish. Staleness is
  // handled by the separate interval below.
  useEffect(() => {
    if (!observer || fleet.length === 0) {
      setAlerts([]);
      return;
    }
    const key = `${fleet.map((s) => s.satrec.satnum).join(',')}|${observer.lat.toFixed(2)}|${observer.lon.toFixed(2)}`;
    if (key !== scanKeyRef.current) {
      scanKeyRef.current = key;
      runScan({ lat: observer.lat, lon: observer.lon });
    }
    return () => { cancelRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, observer]);

  // Keep the cached scan fresh as real time advances past it. Its own interval,
  // for the reason given above.
  useEffect(() => {
    if (!observer || fleet.length === 0) return;
    const lat = observer.lat, lon = observer.lon;
    const id = setInterval(() => {
      if (Date.now() - lastScanRef.current > MIN_RESCAN_MS) runScan({ lat, lon });
    }, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, observer, runScan]);

  // Fire due notifications on each tick. Cheap: pure arithmetic over the cached
  // list, and idempotent per pass in lib/alerts.
  useEffect(() => {
    if (perm === 'granted' && alerts.length > 0) {
      fireDueNotifications(alerts, now);
    }
  }, [now, alerts, perm]);

  const enableNotifications = useCallback(async () => {
    const result = await requestNotifyPermission();
    setPerm(result);
  }, []);

  const upcoming = nextAlert(alerts, now);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-gray-300 uppercase tracking-widest flex items-center gap-1.5">
          <BellRing className="w-3.5 h-3.5 text-emerald-400" /> Overhead Alerts
        </span>
        {perm === 'granted' ? (
          <span className="flex items-center gap-1 text-[9px] font-mono text-emerald-300 border border-emerald-400/30 rounded-md px-1.5 py-0.5">
            <Bell className="w-2.5 h-2.5" /> ON
          </span>
        ) : perm === 'unsupported' ? null : (
          <button
            onClick={enableNotifications}
            className="flex items-center gap-1 text-[9px] font-mono font-bold text-gray-300 border border-white/15 rounded-md px-1.5 py-0.5 hover:border-emerald-400/40 hover:text-emerald-300"
          >
            <BellOff className="w-2.5 h-2.5" /> {perm === 'denied' ? 'BLOCKED' : 'NOTIFY ME'}
          </button>
        )}
      </div>

      {!observer ? (
        <LocationPrompt
          permission={locationPermission}
          onRequest={onRequestLocation}
          what="watch for your fleet passing over your position"
        />
      ) : fleet.length === 0 ? (
        <p className="text-[11px] font-mono text-gray-500 leading-relaxed bg-white/5 border border-white/5 rounded-xl px-3 py-2.5">
          Add satellites to My Fleet and their next passes over you will appear here — with a
          countdown, and an optional heads-up a few minutes before each one rises.
        </p>
      ) : busy && alerts.length === 0 ? (
        <div className="flex items-center gap-1.5 text-[10px] font-mono text-gray-400 px-1 py-2">
          <Loader2 className="w-3 h-3 animate-spin text-emerald-400" /> Scanning your fleet…
        </div>
      ) : alerts.length === 0 ? (
        <p className="text-[11px] font-mono text-gray-500 bg-white/5 border border-white/5 rounded-xl px-3 py-2.5">
          No passes above 15° in the next 12 hours for your fleet.
        </p>
      ) : (
        <>
          {/* The headline countdown — the single next thing over your head. */}
          {upcoming && (
            <div className={`rounded-xl border px-3 py-2.5 ${
              isOverheadNow(upcoming, now)
                ? 'bg-emerald-500/20 border-emerald-400/50 animate-pulse'
                : 'bg-gradient-to-b from-emerald-500/10 to-transparent border-emerald-400/25'
            }`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sm font-bold text-white truncate">{upcoming.sat.name}</span>
                {upcoming.pass.visible && (
                  <span className="flex items-center gap-0.5 text-[9px] font-mono text-amber-300 border border-amber-400/40 rounded px-1 shrink-0">
                    <Eye className="w-2.5 h-2.5" /> VISIBLE
                  </span>
                )}
              </div>
              <div className="text-2xl font-mono font-bold text-emerald-300 tabular-nums mt-0.5">
                {isOverheadNow(upcoming, now) ? 'OVERHEAD NOW' : formatCountdown(upcoming.pass.start, now)}
              </div>
              <div className="text-[10px] font-mono text-gray-400 mt-0.5">
                rises {compassPoint(upcoming.pass.startAzimuthDeg)} · peak {upcoming.pass.maxElevationDeg.toFixed(0)}° · {upcoming.pass.visible ? 'naked-eye' : 'radio only'}
              </div>
            </div>
          )}

          {/* The rest of the queue. */}
          <div className="space-y-1 max-h-[28vh] overflow-y-auto custom-scrollbar pr-1 -mr-1">
            {alerts.filter((a) => a !== upcoming).map((a) => (
              <button
                key={a.key}
                onClick={() => onSelectSat(a.sat)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg border border-transparent hover:bg-white/5 row-hover text-left"
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: a.sat.color }} />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="font-mono text-[11px] text-white truncate">{a.sat.name}</span>
                  <span className="text-[9px] font-mono text-gray-500">
                    {compassPoint(a.pass.startAzimuthDeg)} · {a.pass.maxElevationDeg.toFixed(0)}°
                    {a.pass.visible && <span className="text-amber-400"> · visible</span>}
                  </span>
                </div>
                <span className="font-mono text-[10px] text-emerald-300 tabular-nums shrink-0">
                  {formatCountdown(a.pass.start, now)}
                </span>
                <Crosshair className="w-3 h-3 text-gray-500 shrink-0" />
              </button>
            ))}
          </div>
          {busy && (
            <div className="flex items-center gap-1.5 text-[9px] font-mono text-gray-500 px-1">
              <Loader2 className="w-2.5 h-2.5 animate-spin" /> refreshing…
            </div>
          )}
        </>
      )}
    </div>
  );
}
