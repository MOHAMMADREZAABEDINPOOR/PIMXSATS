'use client';

// Subscription hook for the fleet store.
//
// The store in lib/favorites is a plain subscribe/emit box so it can be read
// from non-React code (the alert scanner) as well as components. This is the
// React edge of it: useSyncExternalStore gives every consumer a consistent
// snapshot within a render pass, and the server snapshot is a stable empty array
// so SSR and the first client paint agree — localStorage does not exist during
// the server render, and returning a fresh [] each call would loop.

import { useSyncExternalStore } from 'react';
import {
  getFavorites, subscribeFavorites, getFavoritesServerSnapshot, FavoriteId,
} from '@/lib/favorites';

/** The current fleet, re-rendering the caller whenever it changes. */
export function useFavorites(): FavoriteId[] {
  return useSyncExternalStore(
    subscribeFavorites,
    getFavorites,
    getFavoritesServerSnapshot
  );
}
