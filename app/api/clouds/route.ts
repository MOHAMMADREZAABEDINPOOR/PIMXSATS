import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Live global cloud cover.
//
// Source: clouds.matteason.co.uk — a free equirectangular cloud map rendered
// from real EUMETSAT (Meteosat + GOES + Himawari) geostationary imagery,
// republished roughly every 3 hours. The transparent-alpha PNG drops straight
// onto the existing cloud sphere as a texture.
//
// The image is proxied (browser-cacheable, one origin) and cached in memory
// and on disk so the upstream is hit at most once per REFRESH window per
// server process. If the upstream is unreachable the bundled static cloud
// texture is served instead — the globe never loses its cloud layer.
// ---------------------------------------------------------------------------

const LIVE_URL = 'https://clouds.matteason.co.uk/images/4096x2048/clouds-alpha.png';
const REFRESH_MS = 3 * 60 * 60 * 1000; // upstream updates ~every 3 h

interface CloudsGlobalState {
  cache: { data: Buffer; timestamp: number } | null;
  inflight: Promise<Buffer | null> | null;
}

function state(): CloudsGlobalState {
  const g = globalThis as unknown as { __cloudsState?: CloudsGlobalState };
  if (!g.__cloudsState) g.__cloudsState = { cache: null, inflight: null };
  return g.__cloudsState;
}

// Lazily resolved (see the TLE route for why this can't be module scope)
function diskCachePath(): string {
  return path.join(os.tmpdir(), 'pimxsats-clouds.png');
}

function readDiskCache(): { data: Buffer; ageMs: number } | null {
  try {
    const stat = fs.statSync(diskCachePath());
    const data = fs.readFileSync(diskCachePath());
    if (data.length < 10000) return null;
    return { data, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

function readBundledFallback(): Buffer | null {
  for (const p of [
    path.join(process.cwd(), 'public', 'textures', 'earth_clouds.png'),
    path.join(process.cwd(), '..', '..', 'public', 'textures', 'earth_clouds.png'),
  ]) {
    try {
      return fs.readFileSync(p);
    } catch { /* try next location */ }
  }
  return null;
}

async function fetchLiveClouds(): Promise<Buffer | null> {
  try {
    const res = await fetch(LIVE_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
      headers: { Accept: 'image/png,image/*;q=0.8' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < 10000) throw new Error('payload too small');
    return data;
  } catch (err) {
    console.info(`Live cloud map not accessible: ${err}`);
    return null;
  }
}

export async function GET() {
  const s = state();
  const now = Date.now();

  const respond = (data: Buffer, cacheHeader: string) =>
    new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': 'image/png',
        // Browser may keep it for an hour; upstream only changes every ~3 h
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'X-Cloud-Source': cacheHeader,
      },
    });

  if (s.cache && now - s.cache.timestamp < REFRESH_MS) {
    return respond(s.cache.data, 'LIVE-CACHED');
  }

  const disk = readDiskCache();
  if (disk && disk.ageMs < REFRESH_MS) {
    s.cache = { data: disk.data, timestamp: now - disk.ageMs };
    return respond(disk.data, 'LIVE-DISK');
  }

  // Concurrent first requests share one upstream download
  if (!s.inflight) {
    s.inflight = fetchLiveClouds().finally(() => { s.inflight = null; });
  }
  const live = await s.inflight;

  if (live) {
    s.cache = { data: live, timestamp: Date.now() };
    try { fs.writeFileSync(diskCachePath(), live); } catch { /* read-only tmp is not fatal */ }
    return respond(live, 'LIVE');
  }

  // Upstream down: stale live data beats the static texture
  if (disk) return respond(disk.data, 'STALE');
  if (s.cache) return respond(s.cache.data, 'STALE');

  const bundled = readBundledFallback();
  if (bundled) return respond(bundled, 'FALLBACK-STATIC');
  return new NextResponse('cloud texture unavailable', { status: 503 });
}
