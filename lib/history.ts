// Space history scrubber — the catalog as a timeline you can drag.
//
// Every TLE carries an international designator, and the designator carries a
// launch year. Filtering the catalog by "launched on or before year Y" and
// sweeping Y from 1963 to now turns the tracker into a time machine: a handful
// of Cold War payloads, then the comsat boom, then the megaconstellation wall
// arriving all at once after 2019.
//
// Note the honest limitation, which the UI states rather than hides: this shows
// objects that are in TODAY'S catalog and were launched by year Y — not the
// catalog as it stood in year Y. Everything that has since re-entered is
// missing, and each object's orbit is propagated from a modern TLE, not a
// historical one. It is a view of surviving hardware over time, and that is
// still a genuinely useful thing to see.

import type { SatData } from './satellite';

/** Sputnik 1. Nothing in the catalog predates it. Kept as the factual lower
 *  bound for parsing launch years — it is NOT where the scrubber starts. */
export const SPACE_AGE_START_YEAR = 1957;

/** Where the timeline itself begins — the left end of the scrubber, the floor of
 *  the year clamp, and the first point on the sparkline.
 *
 *  1957–1962 was cut deliberately. Those years hold a handful of objects that
 *  have all long since re-entered, so anywhere in that range the scene is empty
 *  and the tracker looks broken rather than historic. 1963 is where the
 *  SURVIVING catalog first has something to draw, so that is where the timeline
 *  starts. The launches before it are not lost — they stay folded into the
 *  cumulative total, see launchHistory().
 *
 *  It lives here rather than in the scrubber component because UIOverlay needs
 *  it to park the clock before playback starts, and the scrubber itself is a
 *  `next/dynamic` chunk — importing a constant from it would drag the whole
 *  component back into the main bundle. */
export const TIMELINE_START_YEAR = 1963;

/** Where the scrubber's PLAY button starts from — the start of the timeline. */
export const PLAY_START_YEAR = TIMELINE_START_YEAR;

/** Playback cadence: one year of history per this many real milliseconds. */
export const PLAY_YEAR_STEP_MS = 3000;

export interface Era {
  year: number;
  label: string;
  /** What was happening — the caption under the scrubber. */
  caption: string;
}

/** Hand-written milestones. The scrubber snaps its caption to the latest era at
 *  or before the selected year, so the text always describes what the user is
 *  looking at rather than an arbitrary decade boundary. */
export const ERAS: Era[] = [
  { year: 1957, label: 'Sputnik', caption: 'The space age opens with a 58 cm aluminium sphere and a radio beep. Orbit contains one object.' },
  { year: 1961, label: 'First crew', caption: 'Gagarin orbits once. Both superpowers are launching, and the catalog is still small enough to name from memory.' },
  { year: 1965, label: 'Comsats begin', caption: 'Early Bird carries the first commercial traffic. Geostationary orbit starts to fill.' },
  { year: 1972, label: 'Remote sensing', caption: 'Landsat starts photographing the planet systematically. Polar sun-synchronous orbits become valuable real estate.' },
  { year: 1978, label: 'Navigation', caption: 'The first GPS satellites go up. Medium Earth orbit gains its defining constellation.' },
  { year: 1981, label: 'Shuttle era', caption: 'Reusable launch begins. Payload mass to LEO climbs, and so does the debris population.' },
  { year: 1990, label: 'Hubble & the boom', caption: 'Great observatories launch and commercial LEO takes off. The catalog passes several thousand tracked objects.' },
  { year: 1998, label: 'Station assembly', caption: 'The ISS begins as two modules. It becomes the largest structure ever assembled off Earth.' },
  { year: 2007, label: 'Debris shock', caption: 'An anti-satellite test creates thousands of fragments in a single event — the fastest the catalog has ever grown from one act.' },
  { year: 2009, label: 'Iridium–Kosmos', caption: 'Two intact satellites collide at 11.7 km/s. Collision avoidance stops being theoretical.' },
  { year: 2013, label: 'Smallsat wave', caption: 'CubeSats industrialise. Dozens of objects ride a single launch, mostly into low, short-lived orbits.' },
  { year: 2019, label: 'Megaconstellations', caption: 'Starlink begins deploying in batches of sixty. Within a few years one operator holds more than half of all active satellites.' },
  { year: 2024, label: 'Crowded shells', caption: 'The 500–600 km shell holds thousands of active spacecraft, with more filed than have ever flown. Traffic management becomes the central problem of orbit.' },
];

/** The era describing a given year — the latest milestone at or before it. */
export function eraForYear(year: number): Era {
  let current = ERAS[0];
  for (const era of ERAS) {
    if (era.year <= year) current = era;
    else break;
  }
  return current;
}

/** Objects in today's catalog launched on or before `year`. */
export function filterByYear(satellites: SatData[], year: number): SatData[] {
  return satellites.filter((s) => {
    const y = s.launchYear ? parseInt(s.launchYear, 10) : NaN;
    // An object with no usable designator is kept once the scrubber reaches the
    // present — dropping it entirely would quietly shrink the live catalog.
    if (!Number.isFinite(y)) return year >= new Date().getUTCFullYear();
    return y <= year;
  });
}

export interface YearPoint {
  year: number;
  /** Objects launched in this year alone. */
  launched: number;
  /** Objects launched in this year or any earlier one. */
  cumulative: number;
}

/** Per-year launch counts plus the running total — the sparkline under the
 *  scrubber, and the thing that makes the post-2019 wall visible.
 *
 *  The series starts at TIMELINE_START_YEAR, but the running total does NOT start
 *  at zero: everything launched before then is counted first and carried in as the
 *  opening balance, so `cumulative` still means "objects launched in this year or
 *  any earlier one" and the curve does not lie about where it came from. */
export function launchHistory(satellites: SatData[]): YearPoint[] {
  const thisYear = new Date().getUTCFullYear();
  const byYear = new Map<number, number>();
  let beforeTimeline = 0;
  for (const s of satellites) {
    const y = s.launchYear ? parseInt(s.launchYear, 10) : NaN;
    if (!Number.isFinite(y) || y < SPACE_AGE_START_YEAR || y > thisYear) continue;
    if (y < TIMELINE_START_YEAR) { beforeTimeline++; continue; }
    byYear.set(y, (byYear.get(y) ?? 0) + 1);
  }
  const out: YearPoint[] = [];
  let running = beforeTimeline;
  for (let y = TIMELINE_START_YEAR; y <= thisYear; y++) {
    const launched = byYear.get(y) ?? 0;
    running += launched;
    out.push({ year: y, launched, cumulative: running });
  }
  return out;
}
