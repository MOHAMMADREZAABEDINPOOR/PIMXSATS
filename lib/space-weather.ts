// Space-weather client: one fetch per session start, shared by everything.
//
// The numbers themselves come from NOAA SWPC through /api/space-weather (which
// keeps its own short cache and never invents a value). What lives here is the
// BROWSER side of that: the last payload read, and the promise for the read that
// is in flight.
//
// It exists because the panel used to own the request. Mounting SpaceWeather
// scheduled an idle callback, the callback fetched, and NOAA answered a second or
// two later — so switching to the solar view meant watching a card say LINKING,
// every single time, including the very first time the site opened. Starting the
// same request during the splash screen costs nothing (the boot sequence is
// already waiting on the catalog, the textures and a 7 MB cloud composite) and by
// the time anything is on screen the answer is usually already here.
//
// Same shape as lib/clouds' preloadCloudTexture, and for the same reason: two
// callers, one download, whoever asks first.

/** Client re-check cadence. The route caches for a minute and revalidates behind
 *  a 10-minute stale window, so asking more often just gets the same bytes. */
export const SW_REFRESH_MS = 5 * 60 * 1000;

export interface SpaceWeatherPayload {
  kp: { value: number; timeTag: string | null } | null;
  wind: { speedKmS: number; timeTag: string | null } | null;
  mag: { bt: number | null; bz: number | null; timeTag: string | null } | null;
  flare: { cls: string; timeTag: string | null } | null;
  scales: { r: number; s: number; g: number; gText: string } | null;
  fetchedMs: number;
  sources: string[];
}

/** `pending` only ever means "no answer yet, and none has failed either" — the
 *  card must not claim a link it does not have, in either direction. */
export type SpaceWeatherProvenance = 'pending' | 'live' | 'stale' | 'offline';

export interface SpaceWeatherState {
  payload: SpaceWeatherPayload | null;
  provenance: SpaceWeatherProvenance;
  /** When the last SUCCESSFUL read landed, for the refresh cadence. */
  okMs: number;
}

const state: SpaceWeatherState = { payload: null, provenance: 'pending', okMs: 0 };
let inflight: Promise<SpaceWeatherState> | null = null;

/** The current snapshot. Synchronous, so a card mounting later in the session
 *  renders real numbers on its first frame instead of dashes. */
export function getSpaceWeather(): SpaceWeatherState {
  return state;
}

/**
 * Read the current conditions, or join the read already in flight.
 *
 * Called by the startup sequence (to get the latency out of the way while the
 * splash is up) and by the card on mount. Never rejects: a failure leaves the
 * last good payload in place and downgrades the provenance, because numbers that
 * were measured ten minutes ago are still measurements — they just are not live
 * any more, and the badge says so.
 */
export function loadSpaceWeather(): Promise<SpaceWeatherState> {
  inflight ??= (async () => {
    try {
      const res = await fetch('/api/space-weather', {
        cache: 'no-cache',
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as SpaceWeatherPayload;
      if (!json || typeof json.fetchedMs !== 'number') throw new Error('malformed payload');
      state.payload = json;
      state.provenance = res.headers.get('X-SW-Source') === 'STALE' ? 'stale' : 'live';
      state.okMs = Date.now();
    } catch {
      state.provenance = state.payload ? 'stale' : 'offline';
    } finally {
      inflight = null;
    }
    return state;
  })();
  return inflight;
}

/**
 * Start the session's FIRST read, during the splash screen.
 *
 * Distinct from loadSpaceWeather only in intent: this one is fire-and-forget from
 * boot, and it is deliberately NOT awaited by the reveal. Startup already refuses
 * to put an external API on its critical path — the catalog is bundled with the
 * site for exactly that reason — and gating the reveal on NOAA would make the
 * whole site as slow as its slowest upstream to fix one card. Being first in the
 * queue is what the card actually needs.
 */
export function preloadSpaceWeather(): void {
  void loadSpaceWeather();
}
