import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'edge';

// ---------------------------------------------------------------------------
// Live global cloud cover — Edge-compatible (no fs/path/os).
//
// Source: clouds.matteason.co.uk — a free equirectangular cloud map built from
// real EUMETSAT/NOAA geostationary imagery and rebuilt roughly every 3 hours.
//
// The design goal here is that the layer is REAL, not merely that it is
// present. Three things work against that, and each has an answer below:
//
//   1. The 4096×2048 composite is ~7 MB. On a slow or lossy link that request
//      is the one most likely to die, and dying meant falling all the way back
//      to a bundled PNG from months ago. So the origin's smaller renditions are
//      tried in turn — a 1024×512 real cloud map beats a perfect fake one.
//   2. A stale-but-real composite was being withheld for up to 30 s while a
//      refresh was attempted. Now a stale cache is served IMMEDIATELY and the
//      refresh runs behind the response, so the visible layer is always real
//      imagery and merely a few hours old at worst.
//   3. Only a total cold-start failure (nothing cached, every rendition down)
//      redirects to the bundled texture, and the client labels that honestly as
//      an offline map rather than as live.
// ---------------------------------------------------------------------------

/** Origin renditions, largest first. Same imagery, decreasing resolution — so
 *  walking down the list trades sharpness for the odds of the transfer actually
 *  completing. The timeout shrinks with the payload: waiting 30 s for a 400 KB
 *  file only delays the next candidate. */
const SOURCES: { url: string; label: string; timeoutMs: number }[] = [
  { url: 'https://clouds.matteason.co.uk/images/4096x2048/clouds-alpha.png', label: '4096', timeoutMs: 25000 },
  { url: 'https://clouds.matteason.co.uk/images/2048x1024/clouds-alpha.png', label: '2048', timeoutMs: 12000 },
  { url: 'https://clouds.matteason.co.uk/images/1024x512/clouds-alpha.png', label: '1024', timeoutMs: 8000 },
];

const REFRESH_MS = 3 * 60 * 60 * 1000;

/** How long a served-stale composite may keep being served before we stop
 *  calling it usable at all. Three days of drift is still real weather from a
 *  real satellite; three weeks is a picture. */
const MAX_STALE_MS = 3 * 24 * 60 * 60 * 1000;

interface Composite {
  data: ArrayBuffer;
  /** Epoch ms these bytes were pulled from the origin. */
  timestamp: number;
  /** Epoch ms of the imagery itself, when the origin says. */
  captured: number | null;
  etag: string | null;
  /** Which rendition in {@link SOURCES} produced it. */
  variant: string;
}

interface CloudsGlobalState {
  cache: Composite | null;
  inflight: Promise<Composite | null> | null;
}

function state(): CloudsGlobalState {
  const g = globalThis as unknown as { __cloudsState?: CloudsGlobalState };
  if (!g.__cloudsState) g.__cloudsState = { cache: null, inflight: null };
  return g.__cloudsState;
}

async function fetchOne(src: (typeof SOURCES)[number]): Promise<Composite | null> {
  try {
    const res = await fetch(src.url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(src.timeoutMs),
      headers: { Accept: 'image/png,image/*;q=0.8' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    // A truncated transfer often still resolves with a short body. Anything
    // this small is not a cloud map, and handing it to createImageBitmap on the
    // client would surface as a broken layer rather than as a failed fetch.
    if (data.byteLength < 10000) throw new Error(`payload too small (${data.byteLength} B)`);
    // When the composite was actually built. The origin sits behind a CDN that
    // currently strips Last-Modified, so this is usually null — and in that case
    // the UI says when the map was FETCHED and never invents a capture time,
    // because "captured 10 minutes ago" would be a straight-up lie about
    // imagery that is rebuilt every three hours.
    const lastModified = res.headers.get('Last-Modified');
    const captured = lastModified ? Date.parse(lastModified) : NaN;
    return {
      data,
      timestamp: Date.now(),
      captured: Number.isFinite(captured) ? captured : null,
      // The origin's content fingerprint. Passed through so the client can tell
      // a genuinely new composite from a refresh that returned the same pixels.
      etag: res.headers.get('ETag'),
      variant: src.label,
    };
  } catch (err) {
    console.info(`Cloud map ${src.label} failed: ${err}`);
    return null;
  }
}

/** Walk the renditions until one lands. Each gets two attempts — a single
 *  dropped connection on a multi-megabyte PNG is common enough that giving up
 *  on the sharp version after one try would quietly cost resolution forever. */
async function fetchLiveClouds(): Promise<Composite | null> {
  for (const src of SOURCES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const got = await fetchOne(src);
      if (got) return got;
    }
  }
  return null;
}

/** Single-flight refresh. Concurrent requests share one upstream transfer;
 *  without this, ten viewers on a cold edge would each pull 7 MB. */
function refresh(s: CloudsGlobalState): Promise<Composite | null> {
  if (!s.inflight) {
    s.inflight = fetchLiveClouds()
      .then((got) => {
        if (got) s.cache = got;
        return got;
      })
      .finally(() => { s.inflight = null; });
  }
  return s.inflight;
}

export async function GET(request: Request) {
  const s = state();
  const now = Date.now();

  const respond = (c: Composite, source: string) =>
    new NextResponse(c.data, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'X-Cloud-Source': source,
        'X-Cloud-Fetched': String(c.timestamp),
        'X-Cloud-Variant': c.variant,
        ...(c.captured ? { 'X-Cloud-Captured': String(c.captured) } : {}),
        ...(c.etag ? { 'X-Cloud-Etag': c.etag } : {}),
      },
    });

  const cache = s.cache;

  // Fresh enough — nothing to do.
  if (cache && now - cache.timestamp < REFRESH_MS) {
    return respond(cache, 'LIVE-CACHED');
  }

  // Stale but real: serve it NOW and revalidate behind the response. The old
  // code awaited the refresh here, so every viewer who happened to arrive after
  // the 3-hour mark paid the full upstream transfer before seeing any clouds at
  // all — with a perfectly good composite sitting in memory the whole time.
  if (cache && now - cache.timestamp < MAX_STALE_MS) {
    void refresh(s);
    return respond(cache, 'STALE');
  }

  const live = await refresh(s);
  if (live) return respond(live, 'LIVE');

  // Every rendition failed. A cache older than MAX_STALE_MS is still closer to
  // the truth than a bundled PNG, so it is preferred — just labelled loudly.
  if (cache) return respond(cache, 'STALE');

  // Cold start with the origin down: redirect to the static bundled texture so
  // the cloud layer is never completely missing. The client detects this case
  // from the absent X-Cloud-Source on the final response and labels the layer
  // as an offline map rather than live.
  return NextResponse.redirect(new URL('/textures/earth_clouds.png', request.url), 302);
}
