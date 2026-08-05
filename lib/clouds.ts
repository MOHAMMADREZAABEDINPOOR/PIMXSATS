// ---------------------------------------------------------------------------
// Live cloud layer: loading, refreshing, and — the part that matters to the
// user — SAYING which of the two it is looking at.
//
// The globe has always shown real clouds: /api/clouds proxies a global
// equirectangular composite built from EUMETSAT/GOES/Himawari geostationary
// imagery, rebuilt roughly every three hours. `public/textures/earth_clouds.png`
// is only the offline fallback, painted for the first few hundred milliseconds
// and kept if the network or the origin is down.
//
// That was invisible from the UI, which is a real flaw: a globe that quietly
// falls back to a picture of clouds from an unknown date is indistinguishable
// from one that never had live data at all. So this module fetches through
// `fetch()` rather than THREE.TextureLoader — the point being that the response
// headers are readable — and publishes the provenance (live vs offline, and
// when the imagery was captured) to a store any component can subscribe to.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

const LIVE_CLOUDS_URL = '/api/clouds';
/** How often to re-check for a newer composite while the tab is open. The
 *  origin rebuilds every ~3 h; polling a little more often costs one 304 and
 *  means a long-lived session (a wall display) never goes stale. */
export const CLOUD_REFRESH_MS = 30 * 60 * 1000;

export type CloudProvenance =
  /** Nothing attempted yet — the bundled map is on screen. */
  | 'pending'
  /** Real imagery, fetched from the origin (possibly via the edge memory cache). */
  | 'live'
  /** Real imagery, but the origin was unreachable on the last attempt, so this
   *  is the last good composite the edge still had. */
  | 'stale'
  /** The bundled texture: the origin is unreachable and nothing was cached. */
  | 'offline';

export interface CloudStatus {
  provenance: CloudProvenance;
  /** Epoch ms the imagery was captured, when the origin reported it. Usually
   *  null: the origin's CDN strips Last-Modified. Never guessed. */
  capturedMs: number | null;
  /** Epoch ms these exact pixels were pulled from the origin. */
  fetchedMs: number | null;
  /** Epoch ms this client last successfully loaded a map. */
  loadedMs: number | null;
  /** Origin content fingerprint — a change means genuinely new imagery. */
  etag: string | null;
  /** Raw `X-Cloud-Source` value, for the tooltip. */
  sourceHeader: string | null;
}

// --- Store ------------------------------------------------------------------
// Deliberately a module-level store rather than React state: the producer lives
// inside the r3f canvas and the consumer is a chip in the DOM overlay, and
// threading a status object between them through the app root would add a prop
// to four components that do not otherwise care about clouds.

let status: CloudStatus = {
  provenance: 'pending',
  capturedMs: null,
  fetchedMs: null,
  loadedMs: null,
  etag: null,
  sourceHeader: null,
};
const listeners = new Set<() => void>();

export function getCloudStatus(): CloudStatus {
  return status;
}

export function subscribeCloudStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function publish(next: CloudStatus) {
  status = next;
  for (const fn of listeners) fn();
}

// --- Loading ----------------------------------------------------------------

/** Result of one load attempt. `texture` is null when the map could not be
 *  decoded at all, in which case the caller keeps whatever it already had. */
export interface CloudLoad {
  texture: THREE.Texture | null;
  status: CloudStatus;
}

// The composite that is currently on the globe. Owned by this module rather
// than by the component, for two reasons:
//
//  - Startup prefetches the map during the splash screen and the renderer
//    adopts it, so the first painted frame already has live weather on it.
//    Two owners would mean two 7 MB downloads for one picture.
//  - Switching to the Solar System and back unmounts the globe. If the
//    component owned (and therefore disposed) the texture, coming back would
//    re-download it every time.
let currentTexture: THREE.Texture | null = null;

/** Free a composite that has just been replaced. Deferred, because the render
 *  loop can still draw one more frame with the old uniform before React commits
 *  the swap, and disposing under a live draw call costs a re-upload. */
function retire(texture: THREE.Texture | null) {
  if (!texture) return;
  setTimeout(() => {
    // The decoded bitmap is the expensive half (4096×2048 RGBA ≈ 32 MB), and it
    // is not released by dispose() alone.
    const image = texture.image as { close?: () => void } | undefined;
    image?.close?.();
    texture.dispose();
  }, 4000);
}

/** The live cloud composite, if one has been loaded in this session. */
export function getCloudTexture(): THREE.Texture | null {
  return currentTexture;
}

/**
 * Fetch the current cloud composite and decode it into a texture.
 *
 * Resolves rather than rejects on failure — the cloud layer is decoration on
 * top of a globe that must keep rendering, so no failure here is allowed to
 * become an unhandled rejection or an error boundary.
 */
export async function loadCloudTexture(signal?: AbortSignal): Promise<CloudLoad> {
  const loadedMs = Date.now();
  try {
    // `cache: 'no-cache'` (not 'no-store'): revalidate with the server so a
    // refresh is a cheap 304 when the composite has not been rebuilt, but never
    // silently reuse a browser-cached copy that is hours old.
    const res = await fetch(LIVE_CLOUDS_URL, { cache: 'no-cache', signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const sourceHeader = res.headers.get('X-Cloud-Source');
    const capturedRaw = res.headers.get('X-Cloud-Captured');
    const captured = capturedRaw ? Number(capturedRaw) : NaN;
    const fetchedRaw = res.headers.get('X-Cloud-Fetched');
    const fetched = fetchedRaw ? Number(fetchedRaw) : NaN;

    // No provenance header means the route gave up and redirected us to the
    // bundled PNG (see app/api/clouds/route.ts). The pixels are real clouds,
    // but from whenever the file was bundled — not live, and labelled as such.
    const provenance: CloudProvenance = !sourceHeader
      ? 'offline'
      : sourceHeader === 'STALE'
        ? 'stale'
        : 'live';

    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const texture = new THREE.Texture(bitmap);
    texture.colorSpace = THREE.SRGBColorSpace;
    // The layer is sampled at a time-varying longitude offset (the atmospheric
    // advection in Earth.tsx), so u must wrap or the seam smears a column of
    // pixels across the Pacific.
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;

    const previous = currentTexture;
    currentTexture = texture;
    if (previous !== texture) retire(previous);

    const next: CloudStatus = {
      provenance,
      capturedMs: Number.isFinite(captured) ? captured : null,
      fetchedMs: Number.isFinite(fetched) ? fetched : null,
      loadedMs,
      etag: res.headers.get('X-Cloud-Etag'),
      sourceHeader,
    };
    publish(next);
    return { texture, status: next };
  } catch {
    // Aborts are routine (unmount, view switch) and must not be reported as a
    // data problem, so the status is left exactly as it was.
    if (signal?.aborted) return { texture: null, status };
    // A failed REFRESH does not undo a successful first load: the live composite
    // is still the one on screen, so it is reported as the last good imagery
    // rather than demoted to the bundled map, which is not what is rendering.
    const next: CloudStatus = {
      ...status,
      provenance: status.loadedMs && status.provenance !== 'offline' ? 'stale' : 'offline',
      sourceHeader: null,
    };
    publish(next);
    return { texture: null, status: next };
  }
}

// --- Startup prefetch -------------------------------------------------------

let firstLoad: Promise<CloudLoad> | null = null;

/**
 * Start (or join) the session's FIRST cloud load.
 *
 * Called twice by design: once by the startup sequence, which awaits it behind
 * a timeout so the globe is revealed with real weather already on it, and once
 * by the globe itself on mount. Both get the same promise, so the 7 MB
 * composite is fetched exactly once however the race turns out.
 */
export function preloadCloudTexture(): Promise<CloudLoad> {
  firstLoad ??= loadCloudTexture();
  return firstLoad;
}

// --- Formatting -------------------------------------------------------------

/** "just now" / "2h ago" / "3d ago". Coarse on purpose: the composite is only
 *  rebuilt every few hours, so minute precision would imply accuracy it
 *  does not have. */
export function formatCloudAge(sinceMs: number | null, nowMs: number): string | null {
  if (!sinceMs) return null;
  const age = nowMs - sinceMs;
  if (age < 0) return 'just now'; // clock skew between client and origin
  const minutes = Math.floor(age / 60000);
  if (minutes < 10) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * What the chip should say about freshness, and how confident it is entitled to
 * be. Capture time is used when the origin gives one; otherwise the fetch time
 * is reported AS a fetch time. There is no third branch that dresses one up as
 * the other.
 */
export function describeCloudFreshness(
  s: CloudStatus,
  nowMs: number,
): { label: string; verb: 'captured' | 'fetched' } | null {
  if (s.capturedMs) {
    const age = formatCloudAge(s.capturedMs, nowMs);
    return age ? { label: age, verb: 'captured' } : null;
  }
  const age = formatCloudAge(s.fetchedMs, nowMs);
  return age ? { label: age, verb: 'fetched' } : null;
}
