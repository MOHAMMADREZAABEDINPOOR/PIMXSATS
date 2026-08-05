import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'edge';

// ---------------------------------------------------------------------------
// Live space weather — real NOAA SWPC measurements, proxied.
//
// This route exists because the panel used to fetch NOAA straight from the
// browser and, when that failed, filled the gaps with `Math.random()` while
// still displaying a "LIVE NOAA" badge. Inventing a Kp index is worse than
// showing nothing: the whole point of the readout is that it describes the real
// radiation environment the satellites on screen are flying through.
//
// So: every number below comes from a named SWPC product, each product is
// independent (a dead endpoint blanks its own field and nothing else), and the
// payload carries which upstreams actually answered plus how old the data is.
// The client renders "—" for anything missing. Nothing is ever fabricated.
//
// Proxying rather than calling NOAA directly also fixes the real cause of the
// old failures: services.swpc.noaa.gov does not send permissive CORS headers
// for every product, so some of those browser fetches could never have worked.
// ---------------------------------------------------------------------------

/** Server-side freshness. SWPC publishes Kp and solar wind on a 1-minute
 *  cadence, but nothing in this panel changes meaningfully inside five minutes,
 *  and a shared edge cache keeps the origin traffic proportional to the number
 *  of edges rather than the number of viewers. */
const REFRESH_MS = 5 * 60 * 1000;

/** Past this, a cached payload stops being described as current. Kp from an hour
 *  ago is still a fact; it is just labelled as an hour old. */
const MAX_STALE_MS = 6 * 60 * 60 * 1000;

const TIMEOUT_MS = 7000;

export interface SpaceWeatherPayload {
  /** Planetary K index, 0-9. NOAA's 1-minute estimate. */
  kp: { value: number; timeTag: string | null } | null;
  /** Bulk solar wind speed at L1, km/s (DSCOVR/ACE via SWPC summary). */
  wind: { speedKmS: number; timeTag: string | null } | null;
  /** Interplanetary magnetic field at L1: total field and the north-south
   *  component, nT. Bz is the one that matters — a strongly southward Bz is what
   *  lets the solar wind couple into the magnetosphere. */
  mag: { bt: number | null; bz: number | null; timeTag: string | null } | null;
  /** Largest GOES X-ray flare in the current reporting window, e.g. "M1.2". */
  flare: { cls: string; timeTag: string | null } | null;
  /** Today's NOAA R/S/G scales (radio blackout / radiation storm / geomagnetic
   *  storm), 0-5, with NOAA's own wording for G. */
  scales: { r: number; s: number; g: number; gText: string } | null;
  /** Epoch ms these values were pulled from NOAA. */
  fetchedMs: number;
  /** Which upstream products answered — shown in the panel's tooltip. */
  sources: string[];
}

interface SWGlobalState {
  cache: SpaceWeatherPayload | null;
  inflight: Promise<SpaceWeatherPayload | null> | null;
}

function state(): SWGlobalState {
  const g = globalThis as unknown as { __spaceWeatherState?: SWGlobalState };
  if (!g.__spaceWeatherState) g.__spaceWeatherState = { cache: null, inflight: null };
  return g.__spaceWeatherState;
}

/** Fetch and parse one product. Returns null on any failure — a bad endpoint
 *  must cost its own field and nothing else. */
async function grab<T>(url: string, parse: (json: unknown) => T | null): Promise<T | null> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parse(await res.json());
  } catch (err) {
    console.info(`Space weather ${url} failed: ${err}`);
    return null;
  }
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : null;

async function fetchAll(): Promise<SpaceWeatherPayload | null> {
  const sources: string[] = [];

  const [kp, wind, mag, flare, scales] = await Promise.all([
    // 1-minute estimated planetary K index. The array is chronological; the last
    // row is now. `kp_index` is the numeric estimate, `estimated_kp` the
    // fractional one — the fractional value is preferred and rounded for display
    // by the client, so "Kp 4.67" is not silently reported as 4.
    grab('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json', (j) => {
      if (!Array.isArray(j) || j.length === 0) return null;
      for (let i = j.length - 1; i >= 0; i--) {
        const r = rec(j[i]);
        if (!r) continue;
        const v = num(r.estimated_kp) ?? num(r.kp_index) ?? num(r.kp);
        if (v === null) continue;
        return { value: Math.min(9, Math.max(0, v)), timeTag: r.time_tag ? String(r.time_tag) : null };
      }
      return null;
    }),

    grab('https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json', (j) => {
      const r = rec(j);
      const v = r ? num(r.WindSpeed) : null;
      if (v === null) return null;
      return { speedKmS: Math.round(v), timeTag: r?.TimeStamp ? String(r.TimeStamp) : null };
    }),

    grab('https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json', (j) => {
      const r = rec(j);
      if (!r) return null;
      const bt = num(r.Bt);
      const bz = num(r.Bz);
      if (bt === null && bz === null) return null;
      return { bt, bz, timeTag: r.TimeStamp ? String(r.TimeStamp) : null };
    }),

    // Largest GOES X-ray flare in the latest report. `max_class` is already in
    // the conventional A/B/C/M/X notation, so it is passed through verbatim
    // rather than being derived from anything — the old code guessed a flare
    // class from the Kp index, which are unrelated quantities.
    grab('https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json', (j) => {
      const r = Array.isArray(j) ? rec(j[0]) : rec(j);
      if (!r) return null;
      const cls = r.max_class ?? r.current_class;
      if (!cls) return null;
      return {
        cls: String(cls),
        timeTag: r.max_time ? String(r.max_time) : r.begin_time ? String(r.begin_time) : null,
      };
    }),

    // NOAA's own R/S/G scale summary, keyed by day offset ("0" is today).
    grab('https://services.swpc.noaa.gov/products/noaa-scales.json', (j) => {
      const today = rec(rec(j)?.['0']);
      if (!today) return null;
      const scale = (k: string) => num(rec(today[k])?.Scale) ?? 0;
      const g = rec(today.G);
      return {
        r: scale('R'),
        s: scale('S'),
        g: scale('G'),
        gText: g?.Text ? String(g.Text) : 'none',
      };
    }),
  ]);

  if (kp) sources.push('planetary_k_index_1m');
  if (wind) sources.push('solar-wind-speed');
  if (mag) sources.push('solar-wind-mag-field');
  if (flare) sources.push('xray-flares-latest');
  if (scales) sources.push('noaa-scales');

  // Every product failed: report nothing rather than a payload of nulls that
  // would overwrite a good cached one.
  if (sources.length === 0) return null;

  return { kp, wind, mag, flare, scales, fetchedMs: Date.now(), sources };
}

function refresh(s: SWGlobalState): Promise<SpaceWeatherPayload | null> {
  if (!s.inflight) {
    s.inflight = fetchAll()
      .then((got) => {
        if (got) s.cache = got;
        return got;
      })
      .finally(() => { s.inflight = null; });
  }
  return s.inflight;
}

export async function GET() {
  const s = state();
  const now = Date.now();

  const respond = (p: SpaceWeatherPayload, source: string) =>
    NextResponse.json(p, {
      headers: {
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=600',
        'X-SW-Source': source,
      },
    });

  const cache = s.cache;
  if (cache && now - cache.fetchedMs < REFRESH_MS) return respond(cache, 'LIVE-CACHED');

  // Serve the cached measurements immediately and revalidate behind the
  // response: five upstream requests must never be something the panel waits on.
  if (cache && now - cache.fetchedMs < MAX_STALE_MS) {
    void refresh(s);
    return respond(cache, 'STALE');
  }

  const live = await refresh(s);
  if (live) return respond(live, 'LIVE');
  if (cache) return respond(cache, 'STALE');

  // Nothing real to show. An explicit 503 with no body is what tells the client
  // to render dashes and say the link is down, instead of inventing numbers.
  return NextResponse.json({ error: 'space weather upstream unavailable' }, { status: 503 });
}
