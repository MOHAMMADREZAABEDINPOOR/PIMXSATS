import { useEffect, useState } from 'react';
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
 */
export function useUserLocation(): UserLocation {
  const [location, setLocation] = useState<UserLocation>(() => ({
    timeZone:
      typeof window === 'undefined'
        ? 'UTC'
        : Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    coords: null,
    source: 'device',
  }));

  useEffect(() => {
    if (!('geolocation' in navigator)) return;
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
        }));
      },
      () => { /* permission denied — device timezone still applies */ },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 }
    );
  }, []);

  return location;
}
