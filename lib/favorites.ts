// My Fleet — the user's own shortlist of satellites, kept on the device.
//
// A 15,000-object catalog is a haystack; almost everyone actually cares about
// five or six things (the station they can see from the garden, the weather
// bird their flight depends on, whatever they launched at work). Favourites are
// stored as NORAD catalog numbers rather than as SatData, because the catalog
// is rebuilt at every load and object identity never survives it — the number
// is the only stable handle.
//
// Everything here degrades to a no-op when storage is unavailable (private
// mode, disabled cookies). Losing the list is a nuisance; throwing in the
// middle of a click handler is a bug.

import type { SatData } from './satellite';

const KEY = 'pimxsats.favorites';

/** Hard cap. The fleet is a shortlist, not a second catalog: past this it
 *  stops being scannable and the alert scan stops being cheap. */
export const MAX_FAVORITES = 40;

/** NORAD catalog number, as it appears on the parsed record (a string). */
export type FavoriteId = string;

const EMPTY: FavoriteId[] = [];
const EMPTY_SATS: SatData[] = [];

function read(): FavoriteId[] {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    // Tolerate a legacy/corrupt file rather than wiping the user's list.
    // Older builds may have written numbers; normalise them to strings.
    return parsed
      .map((v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''))
      .filter((s) => s.length > 0)
      .slice(0, MAX_FAVORITES);
  } catch {
    return EMPTY;
  }
}

function write(ids: FavoriteId[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(ids.slice(0, MAX_FAVORITES)));
  } catch {
    // Storage full or blocked — the in-memory list stays correct for this
    // session, which is the part the user is actually looking at.
  }
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------
//
// The fleet is read in several places at once (the rail badge, the fleet panel,
// the alert scanner, the star on the info card). A tiny store keeps them in
// sync without threading state through the whole overlay, and gives
// useSyncExternalStore a stable snapshot to compare.

let cache: FavoriteId[] | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

/** Current fleet. The returned array is cached by identity, so it is safe to
 *  use directly as a useSyncExternalStore snapshot. */
export function getFavorites(): FavoriteId[] {
  if (cache === null) cache = read();
  return cache;
}

export function subscribeFavorites(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Server snapshot for useSyncExternalStore — always empty, since localStorage
 *  does not exist during SSR and a mismatch would hydrate wrong. */
export function getFavoritesServerSnapshot(): FavoriteId[] {
  return EMPTY;
}

export function isFavorite(id: FavoriteId): boolean {
  return getFavorites().includes(id);
}

/** Add or remove, returning the new membership state. Adding past
 *  MAX_FAVORITES is refused rather than silently dropping the oldest — the
 *  user picked these deliberately. */
export function toggleFavorite(id: FavoriteId): boolean {
  const current = getFavorites();
  const has = current.includes(id);
  if (has) {
    cache = current.filter((n) => n !== id);
  } else {
    if (current.length >= MAX_FAVORITES) return false;
    cache = [...current, id];
  }
  write(cache);
  emit();
  return !has;
}

export function clearFavorites(): void {
  cache = EMPTY;
  write(cache);
  emit();
}

/** Resolve the stored ids against the live catalog, preserving the order the
 *  user added them in. Ids with no match (an object that left the catalog) are
 *  dropped from the RESULT but kept in storage — a satellite missing from
 *  today's snapshot may be back in tomorrow's, and silently deleting someone's
 *  pick because of one bad fetch is not recoverable. */
export function resolveFavorites(satellites: SatData[]): SatData[] {
  const ids = getFavorites();
  if (ids.length === 0) return EMPTY_SATS;
  const byId = new Map<FavoriteId, SatData>();
  for (const sat of satellites) byId.set(sat.satrec.satnum, sat);
  const out: SatData[] = [];
  for (const id of ids) {
    const sat = byId.get(id);
    if (sat) out.push(sat);
  }
  return out;
}

/** satnum as stored on the parsed record. Kept as a helper so the rest of the
 *  app never has to know where the id lives. */
export function satId(sat: SatData): FavoriteId {
  return sat.satrec.satnum;
}
