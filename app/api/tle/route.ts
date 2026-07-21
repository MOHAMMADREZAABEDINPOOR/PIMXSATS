import { NextRequest, NextResponse } from 'next/server';
import { FALLBACK_TLE } from '@/lib/fallback-tle';

export const dynamic = 'force-dynamic';
export const runtime = 'edge';

// ---------------------------------------------------------------------------
// Catalog strategy: ALWAYS return a full sky.
//
//   base    = FALLBACK_TLE (built-in ~100-object mini-catalog, always present)
//   overlay = whatever live sources are reachable right now, merged on top
//             by NORAD id (fresher epochs win):
//               - CelesTrak (one request; 403-blocked on some networks)
//               - GitHub-hosted CelesTrak mirrors, refreshed daily by CI
//               - tle.ivanstanojevic.me (paged, per-IP quota — stops on 429)
//               - SatNOGS DB (~1.7k community-tracked objects)
//
// Disk caching is intentionally absent: on Cloudflare Workers there is no
// writable filesystem. Memory caching on globalThis survives within one
// Worker isolate and covers the common case of repeated browser requests
// within the cache window.
// ---------------------------------------------------------------------------

interface TleProgress {
  phase: 'idle' | 'catalog' | 'done' | 'error';
  done: number;
  total: number;
  source: string;
}

interface TleGlobalState {
  progress: TleProgress;
  memoryCache: { text: string; timestamp: number; full: boolean } | null;
  inflight: Promise<{ text: string; full: boolean }> | null;
  ivanBlockedUntil: number;
}

function state(): TleGlobalState {
  const g = globalThis as unknown as { __tleState?: TleGlobalState };
  if (!g.__tleState) {
    g.__tleState = {
      progress: { phase: 'idle', done: 0, total: 0, source: '' },
      memoryCache: null,
      inflight: null,
      ivanBlockedUntil: 0,
    };
  }
  return g.__tleState;
}

function setTleProgress(p: Partial<TleProgress>): void {
  Object.assign(state().progress, p);
}

const CACHE_DURATION_MS = 3 * 60 * 60 * 1000;
const PARTIAL_CACHE_MS = 5 * 60 * 1000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FULL_CATALOG_MIN_SATS = 12000;

// ---------------------------------------------------------------------------
// TLE text helpers
// ---------------------------------------------------------------------------

type TleMap = Map<string, { name: string; line1: string; line2: string }>;

function tleTextToMap(text: string): TleMap {
  const map: TleMap = new Map();
  const lines = text.split('\n').map((l) => l.trim());
  for (let i = 0; i + 2 < lines.length + 1; i++) {
    if (!lines[i + 1]?.startsWith('1 ') || !lines[i + 2]?.startsWith('2 ')) continue;
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!name || name.startsWith('1 ') || name.startsWith('2 ')) continue;
    const id = line1.substring(2, 7).trim();
    if (id) map.set(id, { name, line1, line2 });
    i += 2;
  }
  return map;
}

function tleMapToText(map: TleMap): string {
  const parts: string[] = [];
  for (const e of map.values()) parts.push(`${e.name}\n${e.line1}\n${e.line2}`);
  return parts.join('\n') + '\n';
}

function tleEpoch(line1: string): number {
  return parseFloat(line1.substring(18, 32)) || 0;
}

function mergeInto(base: TleMap, overlay: TleMap): void {
  for (const [id, e] of overlay) {
    const cur = base.get(id);
    if (!cur || tleEpoch(e.line1) > tleEpoch(cur.line1)) base.set(id, e);
  }
}

// ---------------------------------------------------------------------------
// Live sources
// ---------------------------------------------------------------------------

async function tryFetchCelestrak(url: string): Promise<TleMap> {
  const res = await fetch(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': UA, Accept: 'text/plain,*/*;q=0.8' },
  });
  if (!res.ok) throw new Error(`HTTP status ${res.status}`);
  const map = tleTextToMap(await res.text());
  if (map.size < 1000) throw new Error('payload too small');
  return map;
}

const GITHUB_MIRRORS = [
  { url: 'https://raw.githubusercontent.com/satvisorcom/satvisor-data/master/celestrak/tle/active.tle', min: 5000 },
  { url: 'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/starlink.tle', min: 2000 },
  { url: 'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/geo.tle', min: 100 },
  { url: 'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/oneweb.tle', min: 100 },
  { url: 'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/stations.tle', min: 5 },
  { url: 'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/weather.tle', min: 10 },
  { url: 'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/science.tle', min: 10 },
  { url: 'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/resource.tle', min: 10 },
  { url: 'https://raw.githubusercontent.com/astrion-tech/celestrak-mirror/main/tle/military.tle', min: 5 },
];

async function fetchGithubMirrors(): Promise<TleMap> {
  const merged: TleMap = new Map();
  await Promise.all(
    GITHUB_MIRRORS.map(async ({ url, min }) => {
      try {
        const res = await fetch(url, {
          cache: 'no-store',
          signal: AbortSignal.timeout(30000),
          headers: { 'User-Agent': UA, Accept: 'text/plain,*/*;q=0.8' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const map = tleTextToMap(await res.text());
        if (map.size < min) throw new Error('too small');
        mergeInto(merged, map);
      } catch {
        console.info(`Mirror not accessible: ${url}`);
      }
    })
  );
  return merged;
}

interface SatnogsEntry { tle0: string; tle1: string; tle2: string }

async function tryFetchSatnogs(): Promise<TleMap> {
  const res = await fetch('https://db.satnogs.org/api/tle/?format=json', {
    cache: 'no-store',
    signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP status ${res.status}`);
  const data = (await res.json()) as SatnogsEntry[];
  const map: TleMap = new Map();
  for (const e of data) {
    if (!e?.tle0 || !e.tle1 || !e.tle2) continue;
    const id = e.tle1.substring(2, 7).trim();
    if (id) map.set(id, { name: e.tle0.trim(), line1: e.tle1.trim(), line2: e.tle2.trim() });
  }
  if (map.size < 300) throw new Error('SatNOGS payload too small');
  return map;
}

const IVAN_API = 'https://tle.ivanstanojevic.me/api/tle/';
const IVAN_PAGE_SIZE = 100;
const IVAN_CONCURRENCY = 4;
const IVAN_429_BACKOFF_MS = 20 * 60 * 1000;

interface IvanMember { satelliteId: number; name: string; line1: string; line2: string }
interface IvanPage { totalItems: number; member: IvanMember[] }

class QuotaError extends Error {
  constructor() { super('429'); }
}

async function fetchIvanPage(page: number): Promise<IvanPage> {
  const res = await fetch(`${IVAN_API}?page=${page}&page-size=${IVAN_PAGE_SIZE}`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (res.status === 429) throw new QuotaError();
  if (!res.ok) throw new Error(`HTTP status ${res.status}`);
  return (await res.json()) as IvanPage;
}

async function fetchIvanCatalog(): Promise<TleMap> {
  const s = state();
  const map: TleMap = new Map();
  if (Date.now() < s.ivanBlockedUntil) return map;

  const add = (list: IvanMember[]) => {
    for (const m of list ?? []) {
      if (m?.line1 && m?.line2) {
        const id = m.line1.substring(2, 7).trim();
        if (id) map.set(id, { name: m.name.trim(), line1: m.line1.trim(), line2: m.line2.trim() });
      }
    }
  };

  let quotaHit = false;
  const onQuota = () => {
    quotaHit = true;
    s.ivanBlockedUntil = Date.now() + IVAN_429_BACKOFF_MS;
  };

  try {
    const first = await fetchIvanPage(1);
    add(first.member);
    const total = first.totalItems;
    const pages = Math.ceil(total / IVAN_PAGE_SIZE);
    setTleProgress({ phase: 'catalog', done: map.size, total, source: 'tle.ivanstanojevic.me' });

    const queue: number[] = [];
    for (let p = 2; p <= pages; p++) queue.push(p);

    await Promise.all(
      Array.from({ length: IVAN_CONCURRENCY }, async () => {
        for (;;) {
          if (quotaHit) return;
          const page = queue.shift();
          if (page === undefined) return;
          try {
            add((await fetchIvanPage(page)).member);
            setTleProgress({ done: map.size });
          } catch (err) {
            if (err instanceof QuotaError) { onQuota(); return; }
            try {
              if (quotaHit) return;
              await new Promise((r) => setTimeout(r, 800));
              add((await fetchIvanPage(page)).member);
              setTleProgress({ done: map.size });
            } catch (err2) {
              if (err2 instanceof QuotaError) { onQuota(); return; }
            }
          }
        }
      })
    );
  } catch (err) {
    if (err instanceof QuotaError) onQuota();
    else if (map.size === 0) throw err;
  }

  if (quotaHit) console.info(`ivanstanojevic quota hit; keeping ${map.size} objects, backing off`);
  return map;
}

// ---------------------------------------------------------------------------

async function loadCatalog(): Promise<{ text: string; full: boolean }> {
  // Base: built-in mini fallback — guarantees something even if all live
  // sources fail. The live sweep typically replaces this entirely.
  const merged: TleMap = tleTextToMap(FALLBACK_TLE);
  let freshCount = 0;
  let sources = 'fallback-mini';

  for (const url of [
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
    'https://celestrak.com/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
  ]) {
    try {
      const m = await tryFetchCelestrak(url);
      mergeInto(merged, m);
      freshCount = m.size;
      sources = 'celestrak';
      break;
    } catch {
      console.info(`TLE source not accessible: ${url}`);
    }
  }

  if (freshCount < FULL_CATALOG_MIN_SATS) {
    try {
      const m = await fetchGithubMirrors();
      if (m.size > 0) {
        mergeInto(merged, m);
        freshCount += m.size;
        sources += `+gh-mirrors(${m.size})`;
      }
    } catch (err) {
      console.info(`GitHub mirrors failed: ${err}`);
    }
  }

  if (freshCount < FULL_CATALOG_MIN_SATS) {
    try {
      const m = await fetchIvanCatalog();
      if (m.size > 0) {
        mergeInto(merged, m);
        freshCount += m.size;
        sources += `+ivan(${m.size})`;
      }
    } catch (err) {
      console.info(`Paged mirror failed: ${err}`);
    }
  }

  if (freshCount < FULL_CATALOG_MIN_SATS) {
    try {
      const m = await tryFetchSatnogs();
      mergeInto(merged, m);
      freshCount += m.size;
      sources += `+satnogs(${m.size})`;
    } catch (err) {
      console.info(`SatNOGS failed: ${err}`);
    }
  }

  const full = merged.size >= FULL_CATALOG_MIN_SATS;
  setTleProgress({ phase: 'done', source: sources, done: merged.size, total: merged.size });
  console.info(`TLE catalog assembled: ${merged.size} objects (${sources})`);
  return { text: tleMapToText(merged), full };
}

export async function GET(_request: NextRequest) {
  const s = state();
  const now = Date.now();

  const respond = (text: string, cacheHeader: string) =>
    new NextResponse(text, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
        'X-Cache': cacheHeader,
      },
    });

  const cacheFor = (full: boolean) => (full ? CACHE_DURATION_MS : PARTIAL_CACHE_MS);

  if (s.memoryCache && now - s.memoryCache.timestamp < cacheFor(s.memoryCache.full)) {
    return respond(s.memoryCache.text, 'HIT');
  }

  if (!s.inflight) {
    s.inflight = loadCatalog().finally(() => { s.inflight = null; });
  }

  try {
    const { text, full } = await s.inflight;
    s.memoryCache = { text, timestamp: Date.now(), full };
    return respond(text, full ? 'MISS' : 'PARTIAL');
  } catch (err) {
    setTleProgress({ phase: 'error' });
    console.info(`Catalog assembly failed: ${err}`);
  }

  if (s.memoryCache) return respond(s.memoryCache.text, 'STALE');
  return respond(FALLBACK_TLE, 'FALLBACK');
}
