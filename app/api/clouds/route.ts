import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'edge';

// ---------------------------------------------------------------------------
// Live global cloud cover — Edge-compatible (no fs/path/os).
//
// Source: clouds.matteason.co.uk — free equirectangular cloud map from real
// EUMETSAT geostationary imagery, updated ~every 3 hours.
//
// On Cloudflare Workers there is no writable filesystem, so only memory
// caching on globalThis is used. If the upstream is unreachable the client
// falls back to the bundled static cloud texture served directly from
// /textures/earth_clouds.png (handled by the browser, not this route).
// ---------------------------------------------------------------------------

const LIVE_URL = 'https://clouds.matteason.co.uk/images/4096x2048/clouds-alpha.png';
const REFRESH_MS = 3 * 60 * 60 * 1000;

interface CloudsGlobalState {
  cache: { data: ArrayBuffer; timestamp: number } | null;
  inflight: Promise<ArrayBuffer | null> | null;
}

function state(): CloudsGlobalState {
  const g = globalThis as unknown as { __cloudsState?: CloudsGlobalState };
  if (!g.__cloudsState) g.__cloudsState = { cache: null, inflight: null };
  return g.__cloudsState;
}

async function fetchLiveClouds(): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(LIVE_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
      headers: { Accept: 'image/png,image/*;q=0.8' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.arrayBuffer();
    if (data.byteLength < 10000) throw new Error('payload too small');
    return data;
  } catch (err) {
    console.info(`Live cloud map not accessible: ${err}`);
    return null;
  }
}

export async function GET(request: Request) {
  const s = state();
  const now = Date.now();

  const respond = (data: ArrayBuffer, cacheHeader: string) =>
    new NextResponse(data, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'X-Cloud-Source': cacheHeader,
      },
    });

  if (s.cache && now - s.cache.timestamp < REFRESH_MS) {
    return respond(s.cache.data, 'LIVE-CACHED');
  }

  if (!s.inflight) {
    s.inflight = fetchLiveClouds().finally(() => { s.inflight = null; });
  }
  const live = await s.inflight;

  if (live) {
    s.cache = { data: live, timestamp: Date.now() };
    return respond(live, 'LIVE');
  }

  if (s.cache) return respond(s.cache.data, 'STALE');

  // Upstream down and no memory cache: redirect the browser to the static
  // bundled texture so the cloud layer is never completely missing.
  return NextResponse.redirect(new URL('/textures/earth_clouds.png', request.url), 302);
}
