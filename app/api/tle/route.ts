import { NextRequest, NextResponse } from 'next/server';
import { FALLBACK_TLE } from '@/lib/fallback-tle';
import fs from 'fs';
import path from 'path';
import os from 'os';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Catalog strategy: ALWAYS return a full sky.
//
//   base    = bundled snapshot (public/tle-snapshot.txt, ~25k objects,
//             refreshed via scripts/fetch-tle-snapshot.mjs)
//   overlay = whatever live sources are reachable right now, merged on top
//             by NORAD id (fresher epochs win):
//               - CelesTrak (one request; 403-blocked on some networks)
//               - GitHub-hosted CelesTrak mirrors, refreshed daily by CI
//                 (satvisorcom/satvisor-data, astrion-tech/celestrak-mirror)
//               - tle.ivanstanojevic.me (paged; 500 req/window per-IP quota —
//                 the sweep stops INSTANTLY on the first 429 and keeps the
//                 pages it got)
//               - SatNOGS DB (~1.7k community-tracked objects, one request)
//
// So a rate-limited mirror or a blocked CDN can only reduce FRESHNESS,
// never the number of satellites.
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
  /** Do not call the paged mirror again before this time (429 backoff). */
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

const CACHE_DURATION_MS = 3 * 60 * 60 * 1000; // 3 h — TLE epochs stay valid far longer
const PARTIAL_CACHE_MS = 5 * 60 * 1000;
// Resolved lazily: a module-scope path.join(os.tmpdir(), ...) gets statically
// evaluated by Next's file tracer, which then tries to copy the temp dir into
// the standalone build output.
function diskCachePath(): string {
  return path.join(os.tmpdir(), 'pimxsats-tle-active.txt');
}
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// There are well over 12k tracked active objects; anything below this is a
// partial catalog and every fallback tier keeps being tried.
const FULL_CATALOG_MIN_SATS = 12000;

// ---------------------------------------------------------------------------
// TLE text helpers
// ---------------------------------------------------------------------------

type TleMap = Map<string, { name: string; line1: string; line2: string }>;

/** Parse TLE text into a NORAD-id-keyed map. */
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

/** TLE epoch (YYDDD.DDDDDDDD from line 1) — for freshness comparison. */
function tleEpoch(line1: string): number {
  return parseFloat(line1.substring(18, 32)) || 0;
}

/** Merge overlay onto base by NORAD id — the entry with the newer epoch wins. */
function mergeInto(base: TleMap, overlay: TleMap): void {
  for (const [id, e] of overlay) {
    const cur = base.get(id);
    if (!cur || tleEpoch(e.line1) > tleEpoch(cur.line1)) base.set(id, e);
  }
}

// ---------------------------------------------------------------------------
// Bundled snapshot (public/tle-snapshot.txt)
// ---------------------------------------------------------------------------

let snapshotCache: TleMap | null = null;

function loadSnapshot(): TleMap {
  // Only a REAL snapshot is cached. If the file was missing/unreadable once,
  // caching the tiny built-in fallback here would permanently cap the catalog
  // at ~100 objects for the lifetime of the server process — so the fallback
  // is returned uncached and the file is retried on the next request.
  if (snapshotCache) return snapshotCache;
  for (const p of [
    path.join(process.cwd(), 'public', 'tle-snapshot.txt'),
    path.join(process.cwd(), '..', '..', 'public', 'tle-snapshot.txt'), // standalone output layout
  ]) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      const map = tleTextToMap(text);
      if (map.size > 1000) {
        console.info(`TLE snapshot loaded: ${map.size} objects from ${p}`);
        snapshotCache = map;
        return map;
      }
    } catch { /* try next location */ }
  }
  console.info('TLE snapshot file not found — using built-in mini fallback (will retry)');
  return tleTextToMap(FALLBACK_TLE);
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

// GitHub-hosted mirrors, refreshed daily by their CI. raw.githubusercontent
// is reachable from networks where CelesTrak itself is blocked.
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
const IVAN_PAGE_SIZE = 100; // API max
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

/** Paged sweep that respects the per-IP quota: the FIRST 429 stops all
 *  workers immediately and whatever was collected so far is returned. */
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
            // one transient retry, then give up on this page
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
// Disk cache — survives dev-server restarts.
// ---------------------------------------------------------------------------

function readDiskCache(): { text: string; ageMs: number } | null {
  try {
    const stat = fs.statSync(diskCachePath());
    const text = fs.readFileSync(diskCachePath(), 'utf8');
    if (text.split('\n').length < FULL_CATALOG_MIN_SATS * 3) return null;
    return { text, ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

function writeDiskCache(text: string): void {
  try {
    fs.writeFileSync(diskCachePath(), text, 'utf8');
  } catch { /* read-only tmp is not fatal */ }
}

// ---------------------------------------------------------------------------

async function loadCatalog(): Promise<{ text: string; full: boolean }> {
  // Base: bundled snapshot — guarantees a full sky no matter what happens next.
  const merged: TleMap = new Map(loadSnapshot());
  let freshCount = 0;
  let sources = merged.size > 1000 ? 'snapshot' : 'bundled-mini';

  // CelesTrak: freshest and cheapest when reachable.
  for (const url of [
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
    'https://celestrak.com/NORAD/elements/gp.php?GROUP=active&FORMAT=tle',
  ]) {
    try {
      const m = await tryFetchCelestrak(url);
      mergeInto(merged, m);
      freshCount = m.size;
      sources += '+celestrak';
      break;
    } catch {
      console.info(`TLE source not accessible: ${url}`);
    }
  }

  // GitHub-hosted mirrors: near-full catalog, parallel, fast, no quota.
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

  // Paged mirror: only if everything above still left us short of a full sky
  // (its per-IP quota is precious — don't spend it when mirrors delivered).
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

  // SatNOGS: cheap freshness for the most-tracked objects.
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

  const disk = readDiskCache();
  if (disk && disk.ageMs < CACHE_DURATION_MS) {
    s.memoryCache = { text: disk.text, timestamp: now - disk.ageMs, full: true };
    return respond(disk.text, 'DISK');
  }

  // Concurrent requests (retry loops, double-mounted effects) share one assembly.
  if (!s.inflight) {
    s.inflight = loadCatalog().finally(() => {
      s.inflight = null;
    });
  }

  try {
    const { text, full } = await s.inflight;
    s.memoryCache = { text, timestamp: Date.now(), full };
    if (full) writeDiskCache(text);
    return respond(text, full ? 'MISS' : 'PARTIAL');
  } catch (err) {
    setTleProgress({ phase: 'error' });
    console.info(`Catalog assembly failed: ${err}`);
  }

  if (disk) return respond(disk.text, 'STALE');
  if (s.memoryCache) return respond(s.memoryCache.text, 'STALE');
  return respond(FALLBACK_TLE, 'FALLBACK');
}
