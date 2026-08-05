// Live overhead alerts — "look up in 4 minutes".
//
// The pass list already answers "when can I see this?", but only while you are
// staring at the pass list. This turns the same prediction into something that
// reaches the user when it matters: a scan over the fleet (or a chosen few),
// the single nearest pass surfaced as a countdown, and — if the user opted in —
// a system notification a few minutes before the satellite clears the horizon.
//
// Design constraints that shape the whole file:
//   * The scan is EXPENSIVE (SGP4 over 24 h per satellite), so it runs rarely
//     and always through the chunked async predictor, never on a timer tick.
//     The countdown itself is pure arithmetic against a cached result.
//   * Notifications must never surprise anyone: permission is requested only
//     from an explicit user gesture, and each pass fires at most once, tracked
//     by a stable key so a re-scan cannot re-notify for the same event.
//   * Everything degrades: no Notification API, denied permission, or no
//     observer coordinates all reduce the feature to an in-app countdown.

import type { SatData } from './satellite';
import { predictPassesAsync, Observer, SatellitePass } from './passes';

export interface OverheadAlert {
  sat: SatData;
  pass: SatellitePass;
  /** Stable identity for a pass, so we notify once per real event rather than
   *  once per scan. Second precision is plenty — a re-scan lands on the same
   *  rise time to well within a second. */
  key: string;
}

export interface AlertScanOptions {
  /** Only report passes rising within this many hours. */
  horizonHours?: number;
  /** Ignore passes that never get higher than this — a horizon graze behind a
   *  neighbour's roof is not worth a notification. */
  minElevationDeg?: number;
  /** Only report naked-eye passes (sunlit satellite, dark sky). */
  visibleOnly?: boolean;
  /** Cap on the returned list. */
  maxAlerts?: number;
}

const DEFAULT_HORIZON_HOURS = 12;
const DEFAULT_MIN_ELEVATION = 15;
const DEFAULT_MAX_ALERTS = 8;
/** How long before the rise the notification fires. Long enough to walk
 *  outside and let your eyes adjust, short enough to still be relevant. */
export const LEAD_TIME_MS = 4 * 60_000;

function passKey(sat: SatData, pass: SatellitePass): string {
  return `${sat.satrec.satnum}@${Math.floor(pass.start.getTime() / 1000)}`;
}

/**
 * Scan a (small) list of satellites for upcoming passes over the observer.
 *
 * Intended for the user's fleet, not the whole catalog: each satellite costs a
 * full 24 h SGP4 walk. `isCancelled` is polled between satellites so a scan
 * superseded by a fleet edit or a location change stops promptly.
 */
export async function scanForAlerts(
  satellites: SatData[],
  observer: Observer,
  from: Date,
  options: AlertScanOptions = {},
  isCancelled: () => boolean = () => false
): Promise<OverheadAlert[] | null> {
  const {
    horizonHours = DEFAULT_HORIZON_HOURS,
    minElevationDeg = DEFAULT_MIN_ELEVATION,
    visibleOnly = false,
    maxAlerts = DEFAULT_MAX_ALERTS,
  } = options;

  const out: OverheadAlert[] = [];
  for (const sat of satellites) {
    if (isCancelled()) return null;
    const passes = await predictPassesAsync(
      sat.satrec,
      observer,
      from,
      { horizonHours, maxPasses: 3, minElevationDeg },
      isCancelled
    );
    if (passes === null) return null; // cancelled mid-satellite
    for (const pass of passes) {
      if (visibleOnly && !pass.visible) continue;
      out.push({ sat, pass, key: passKey(sat, pass) });
    }
  }

  out.sort((a, b) => a.pass.start.getTime() - b.pass.start.getTime());
  return out.slice(0, maxAlerts);
}

/** The next pass that has not already ended, or null. Pure arithmetic — safe to
 *  call on every clock tick. */
export function nextAlert(alerts: OverheadAlert[], now: Date): OverheadAlert | null {
  const t = now.getTime();
  for (const a of alerts) {
    if (a.pass.end.getTime() > t) return a;
  }
  return null;
}

/** True while the satellite is actually above the horizon — the countdown flips
 *  to a "visible now" state rather than counting to a moment already past. */
export function isOverheadNow(alert: OverheadAlert, now: Date): boolean {
  const t = now.getTime();
  return t >= alert.pass.start.getTime() && t <= alert.pass.end.getTime();
}

// ---------------------------------------------------------------------------
// System notifications
// ---------------------------------------------------------------------------

export type NotifyPermission = 'unsupported' | 'default' | 'granted' | 'denied';

export function notifyPermission(): NotifyPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as NotifyPermission;
}

/** Ask for notification permission. MUST be called from a user gesture — some
 *  browsers reject the request outright otherwise, and silently, which would
 *  leave the toggle stuck in an inexplicable off state. */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  try {
    return (await Notification.requestPermission()) as NotifyPermission;
  } catch {
    return 'denied';
  }
}

// Passes already announced, by key. In-memory only: a reload legitimately
// re-arms the alarm, and persisting it would mean a stale key list outliving
// the event it referred to.
const fired = new Set<string>();

/**
 * Fire a notification for any pass whose lead time has arrived. Returns the
 * alerts that were announced, so the caller can also surface them in-app.
 *
 * Idempotent per pass key: calling this every second is the intended usage.
 */
export function fireDueNotifications(alerts: OverheadAlert[], now: Date): OverheadAlert[] {
  if (notifyPermission() !== 'granted') return [];
  const t = now.getTime();
  const announced: OverheadAlert[] = [];

  for (const alert of alerts) {
    if (fired.has(alert.key)) continue;
    const riseMs = alert.pass.start.getTime();
    // Inside the lead window and not yet risen. A pass already underway when
    // the scan lands is not announced — telling someone to go outside for
    // something halfway across the sky is worse than saying nothing.
    if (riseMs - t > LEAD_TIME_MS || riseMs < t) continue;

    fired.add(alert.key);
    announced.push(alert);
    const mins = Math.max(0, Math.round((riseMs - t) / 60_000));
    try {
      new Notification(`${alert.sat.name} passes overhead`, {
        body: [
          mins <= 0 ? 'Rising now' : `Rising in ${mins} min`,
          `peak ${alert.pass.maxElevationDeg.toFixed(0)}° elevation`,
          alert.pass.visible ? 'naked-eye visible' : 'radio only (in shadow)',
        ].join(' · '),
        tag: alert.key, // collapses duplicates at the OS level too
        icon: '/icon-192.png',
      });
    } catch {
      // A blocked or throttled notification must not break the tick loop.
    }
  }

  return announced;
}

/** Forget the fired set — used when the observer or the fleet changes enough
 *  that previously-announced passes are no longer the same events. */
export function resetFiredAlerts(): void {
  fired.clear();
}
