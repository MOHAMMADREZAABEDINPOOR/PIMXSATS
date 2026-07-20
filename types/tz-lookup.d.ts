declare module 'tz-lookup' {
  /** Returns the IANA timezone name for the given coordinates. Throws on out-of-range input. */
  export default function tzLookup(lat: number, lon: number): string;
}
