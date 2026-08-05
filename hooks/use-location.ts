import { useCallback, useEffect, useState } from 'react';
import tzLookup from 'tz-lookup';

export interface UserLocation {
  /** IANA timezone finally used by the clock. */
  timeZone: string;
  /** Physical coordinates from the browser Geolocation API. */
  coords: { lat: number; lon: number } | null;
  /** Where the timezone came from:
   *  'gps'    — derived from real device coordinates (VPN-proof, most accurate)
   *  'device' — the OS timezone setting (also VPN-independent) */
  source: 'gps' | 'device';
  /** Progress of the geolocation request, for driving an in-place button:
   *  'idle'    — not yet asked (or unsupported)
   *  'pending' — a request is in flight
   *  'granted' — coordinates obtained
   *  'denied'  — the user (or the OS) refused */
  permission: 'idle' | 'pending' | 'granted' | 'denied';
  /** Ask the browser for location now. Safe to call repeatedly; a denied
   *  request can be retried (the browser decides whether to re-prompt). */
  request: () => void;
}

/**
 * Determine the user's REAL local time context, immune to VPNs.
 *
 * IP-based lookups are never used (they see the VPN exit node, e.g. a UK IP
 * for a user physically in Iran). Instead:
 *  1. Geolocation API → physical lat/lon from GPS/Wi-Fi positioning →
 *     mapped to an IANA timezone with tz-lookup. This reflects where the
 *     device actually is, regardless of network routing.
 *  2. Fallback: the OS timezone (Intl API) — set on the device itself,
 *     also unaffected by the network.
 *
 * The request fires once automatically on mount (so nothing changes for users
 * who have already granted it), but `request()` is also exposed so a panel can
 * offer an explicit "enable location" button when permission was never granted
 * or was dismissed.
 */
export function useUserLocation(): UserLocation {
  const [location, setLocation] = useState<Omit<UserLocation, 'request'>>(() => ({
    timeZone:
      typeof window === 'undefined'
        ? 'UTC'
        : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    coords: null,
    source: 'device',
    permission: 'idle',
  }));

  const request = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return;
    setLocation((prev) => (prev.permission === 'pending' ? prev : { ...prev, permission: 'pending' }));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        let timeZone: string | null = null;
        try {
          timeZone = tzLookup(lat, lon);
        } catch {
          // out-of-range coords — keep device timezone
        }
        setLocation((prev) => ({
          timeZone: timeZone ?? prev.timeZone,
          coords: { lat, lon },
          source: timeZone ? 'gps' : prev.source,
          permission: 'granted',
        }));
      },
      () => {
        // permission denied — device timezone still applies
        setLocation((prev) => ({ ...prev, permission: 'denied' }));
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
    );
  }, []);

  // Fire once on mount so existing (already-granted) users see no change.
  useEffect(() => { request(); }, [request]);

  return { ...location, request };
}
