// Daily space briefing — one glanceable card, generated fresh each day.
//
// The app holds a lot of computable facts; a newcomer does not know which are
// interesting today. The briefing picks a handful and writes them as sentences:
// the state of the catalog, the standout naked-eye pass tonight (if the user's
// location is known), a "this day in space history" entry, and a rotating
// did-you-know. It is assembled from data already in memory plus a small curated
// almanac — no network, so it works offline and loads instantly.
//
// Determinism matters: the same day yields the same briefing, so it reads as a
// daily edition rather than a slot machine. The day-of-year seeds every choice.

import type { SatData } from './satellite';
import { summarize, formatShare } from './dashboard';

export interface BriefingItem {
  /** Short heading. */
  title: string;
  /** One or two sentences. */
  body: string;
}

/** A single headline number for the stat strip at the top of the card. */
export interface BriefingStat {
  label: string;
  value: string;
  /** Optional one-line gloss shown under the number. */
  hint?: string;
}

export interface Briefing {
  /** The date this briefing is for (local midnight). */
  date: Date;
  /** Human dateline, e.g. "Tuesday, 4 August 2026". */
  dateline: string;
  /** Glanceable numbers — read before any prose. */
  stats: BriefingStat[];
  items: BriefingItem[];
  /** Orbit-shell census: the population split, ready to render as bars. */
  shells: { band: string; count: number; share: number; meanAltitudeKm: number }[];
  /** Who owns the sky, busiest first. */
  owners: { country: string; count: number; share: number }[];
  /** Launch cadence by decade — the shape of the space age. */
  decades: { decade: number; count: number }[];
}

// --- "This day in space history" almanac ------------------------------------
// Keyed "MM-DD". Curated, not exhaustive — one strong entry per listed day.
const ON_THIS_DAY: Record<string, string> = {
  '01-02': 'In 1959, Luna 1 became the first spacecraft to leave Earth\'s gravity well, passing the Moon and entering solar orbit.',
  '01-16': 'In 2003, Columbia lifted off on STS-107; the damage to its wing on ascent would destroy it on re-entry sixteen days later.',
  '01-27': 'In 1967, a cabin fire during a launch-pad test killed the Apollo 1 crew and forced a redesign of the command module.',
  '01-31': 'In 1958, Explorer 1 — the first U.S. satellite — reached orbit and discovered the Van Allen radiation belts.',
  '02-01': 'In 2003, Columbia broke up over Texas during re-entry, killing all seven crew.',
  '02-06': 'In 2018, the first Falcon Heavy flew, sending a Tesla Roadster onto a heliocentric orbit past Mars.',
  '02-18': 'In 1930, Clyde Tombaugh discovered Pluto from Lowell Observatory.',
  '02-20': 'In 1962, John Glenn became the first American to orbit the Earth, circling three times aboard Friendship 7.',
  '03-02': 'In 1972, Pioneer 10 launched — the first spacecraft to cross the asteroid belt and fly past Jupiter.',
  '03-16': 'In 1926, Robert Goddard launched the first liquid-fuelled rocket — it flew for 2.5 seconds.',
  '03-18': 'In 1965, Alexei Leonov left his Voskhod 2 capsule for the first spacewalk; his suit stiffened so badly he barely got back in.',
  '04-12': 'In 1961, Yuri Gagarin became the first human in space, completing one orbit aboard Vostok 1.',
  '04-13': 'In 1970, an oxygen tank ruptured aboard Apollo 13, turning a Moon landing into a survival problem.',
  '04-19': 'In 1971, Salyut 1 became the first space station, opening sixty years of continuous station-building.',
  '04-24': 'In 1990, the Hubble Space Telescope was launched aboard Space Shuttle Discovery.',
  '05-05': 'In 1961, Alan Shepard became the first American in space on a 15-minute suborbital flight.',
  '05-14': 'In 1973, Skylab — the first American space station — reached orbit, losing its sunshield on the way up.',
  '05-25': 'In 1961, President Kennedy committed the U.S. to landing a man on the Moon before the decade was out.',
  '05-30': 'In 2020, Crew Dragon Demo-2 launched, returning crewed spaceflight to American soil after nine years.',
  '06-03': 'In 1965, Ed White made the first American spacewalk, drifting outside Gemini 4 for twenty-one minutes.',
  '06-16': 'In 1963, Valentina Tereshkova became the first woman in space, orbiting Earth 48 times aboard Vostok 6.',
  '06-18': 'In 1983, Sally Ride became the first American woman in space aboard Challenger.',
  '07-04': 'In 1997, Mars Pathfinder landed and deployed Sojourner, the first rover on another planet.',
  '07-14': 'In 2015, New Horizons flew past Pluto at 14 km/s, turning a smudge into a world with mountains of water ice.',
  '07-16': 'In 1969, Apollo 11 launched from Kennedy Space Center on the first crewed mission to land on the Moon.',
  '07-20': 'In 1969, Apollo 11 landed on the Moon and Neil Armstrong stepped onto its surface.',
  '07-24': 'In 1969, Apollo 11 splashed down in the Pacific, completing the first round trip to another world.',
  '08-06': 'In 2012, the Curiosity rover touched down in Gale Crater after its "seven minutes of terror" descent.',
  '08-12': 'In 1960, Echo 1 — a 30-metre aluminised balloon — became the first communications satellite, bouncing radio signals off its skin.',
  '08-20': 'In 1977, Voyager 2 launched; it remains the only spacecraft to have visited Uranus and Neptune.',
  '08-25': 'In 2012, Voyager 1 crossed the heliopause, becoming the first human-made object in interstellar space.',
  '09-05': 'In 1977, Voyager 1 launched; it is now the most distant human-made object from Earth.',
  '09-12': 'In 1962, Kennedy told a Rice University crowd "we choose to go to the Moon" — the speech that sold Apollo to the public.',
  '10-04': 'In 1957, Sputnik 1 opened the space age — the first artificial satellite of Earth.',
  '10-11': 'In 1968, Apollo 7 flew the first crewed test of the redesigned command module after the Apollo 1 fire.',
  '10-15': 'In 1997, the Cassini–Huygens mission launched toward Saturn.',
  '11-02': 'In 2000, the first resident crew arrived at the International Space Station, beginning a continuous human presence in orbit.',
  '11-03': 'In 1957, Sputnik 2 carried Laika into orbit — the first animal to orbit Earth, and the first to die there.',
  '11-09': 'In 1967, the first Saturn V flew on Apollo 4, an unmanned test of the most powerful rocket then built.',
  '11-20': 'In 1998, Zarya — the first ISS module — launched, starting a station that would take a decade to assemble.',
  '11-26': 'In 2011, the Curiosity rover launched toward Mars.',
  '12-11': 'In 1972, Apollo 17 landed in Taurus–Littrow, the last crewed landing on the Moon.',
  '12-14': 'In 1972, Apollo 17 left the Moon — the last time humans stood on another world.',
  '12-21': 'In 1968, Apollo 8 launched, carrying the first humans to orbit the Moon.',
  '12-24': 'In 1968, Apollo 8\'s crew read from Genesis in lunar orbit and photographed Earthrise.',
  '12-25': 'In 2021, the James Webb Space Telescope launched from French Guiana.',
};

// --- Rotating "did you know" pool -------------------------------------------
const DID_YOU_KNOW: string[] = [
  'The ISS orbits Earth about every 92 minutes — its crew sees roughly 16 sunrises and sunsets a day.',
  'Geostationary satellites orbit at 35,786 km, where one lap takes exactly one day, so they appear to hang over a fixed spot on the equator.',
  'A satellite in low Earth orbit is not weightless because gravity is absent — gravity there is nearly as strong as on the ground. It is in free fall, perpetually missing the Earth.',
  'The oldest satellite still in orbit is Vanguard 1, launched in 1958. It went silent in 1964 but will keep circling for centuries.',
  'Kessler syndrome is the nightmare scenario in which debris collisions cascade, generating more debris, until parts of orbit become unusable.',
  'Objects in very low orbits below ~300 km re-enter within months to years, dragged down by the wisp of atmosphere still present there.',
  'Sunlight reflecting off a flat satellite panel can briefly outshine every star in the sky — an "iridium flare", named for the constellation that first produced them.',
  'A geostationary belt slot is a genuinely scarce resource, allocated internationally like radio spectrum.',
  'Most satellites you can see with the naked eye are in low orbit and only visible near dusk or dawn, when they are sunlit but the ground below is dark.',
  'GPS satellites carry atomic clocks corrected for relativity: time runs measurably faster for them than for you, by about 38 microseconds a day.',
  'To stay in low orbit you need about 7.8 km/s sideways — roughly Mach 23. Going up is the easy part; going sideways fast enough is the expensive part.',
  'A TLE — two-line element set — encodes a whole orbit in 138 characters, a format designed in the 1960s for punched cards and still used today.',
  'TLE accuracy decays with age: a fresh element set is good to about a kilometre, but a week-old one can be tens of kilometres off along the track.',
  'Sun-synchronous orbits are tilted slightly past the pole so that Earth\'s equatorial bulge drags the orbital plane around once a year — letting the satellite cross every latitude at the same local time.',
  'The Molniya orbit is a deliberately lopsided ellipse: it loiters for hours over high latitudes that geostationary satellites can barely see.',
  'Space begins, by convention, at the Kármán line 100 km up — but nothing can orbit there. Atmospheric drag brings you down within hours.',
  'The 2009 Iridium 33 / Kosmos 2251 collision was the first accidental crash between two intact satellites, and it created over 2,000 trackable fragments.',
  'A 1 cm paint fleck at orbital velocity carries roughly the energy of a hand grenade — which is why sub-centimetre debris is the real hazard.',
  'Satellites in low orbit are re-boosted periodically: the ISS loses altitude constantly to drag and is pushed back up several times a year.',
  'A "graveyard orbit" a few hundred kilometres above the geostationary belt is where retired GEO satellites are pushed to free up their slot.',
  'The moment a rocket stage separates it becomes a tracked object of its own — which is why spent boosters dominate the debris catalogue by mass.',
  'Radio signals reach a geostationary satellite and return in about a quarter of a second, which is why satellite phone calls feel slightly delayed.',
  'Objects in the same orbital shell but opposite planes close on each other at up to 15 km/s — twice orbital speed.',
  'The international designator on every object encodes its launch: year, launch number of that year, and a letter for which piece it was.',
];

/** Local day of year, 0-based — the deterministic seed. */
function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86400000);
}

function mmdd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}-${dd}`;
}

/**
 * Build the day's briefing. `satellites` is the live catalog (drives the
 * population line); `visiblePassLine`, if provided by the caller, is folded in
 * as the "tonight" item — the caller owns the pass prediction because it needs
 * the observer's location, which this pure module deliberately does not touch.
 */
export function buildBriefing(
  satellites: SatData[],
  now: Date,
  visiblePassLine?: string | null
): Briefing {
  const doy = dayOfYear(now);
  const items: BriefingItem[] = [];

  const s = summarize(satellites);

  // --- The stat strip: four numbers, readable in a second. -------------------
  const stats: BriefingStat[] = [
    { label: 'Tracked', value: s.total.toLocaleString(), hint: 'objects in the catalog' },
    { label: 'Payloads', value: s.payloads.toLocaleString(), hint: 'not debris or spent stages' },
    { label: 'Junk', value: formatShare(s.junkShare), hint: 'debris & rocket bodies' },
    { label: 'Mean lap', value: `${s.meanPeriodMin.toFixed(0)} min`, hint: 'average orbital period' },
  ];

  // 1. The catalog, today.
  items.push({
    title: 'The sky right now',
    body: `${s.total.toLocaleString()} objects are being tracked — about ${formatShare(s.junkShare)} of them spent rocket bodies and debris. `
      + (s.busiestShellKm
        ? `The most crowded slice of low orbit is ${s.busiestShellKm.fromKm}–${s.busiestShellKm.toKm} km up, holding ${s.busiestShellKm.count.toLocaleString()} objects.`
        : `Low Earth orbit holds the bulk of them.`),
  });

  // 2. Where everything actually is — the shell split in words.
  const leo = s.shells.find((sh) => sh.band === 'LEO');
  const geo = s.shells.find((sh) => sh.band === 'GEO');
  if (leo && geo) {
    items.push({
      title: 'Where it all is',
      body: `Low Earth orbit carries ${formatShare(leo.share)} of everything tracked, averaging ${leo.meanAltitudeKm.toFixed(0)} km up and circling every ninety minutes or so. `
        + `The geostationary belt holds a further ${formatShare(geo.share)} at roughly ${geo.meanAltitudeKm.toFixed(0)} km, where a lap takes exactly one day — which is why those satellites appear to hang motionless above the equator.`,
    });
  }

  // 3. Who owns the sky.
  if (s.owners.length >= 3) {
    const [o1, o2, o3] = s.owners;
    items.push({
      title: 'Who owns the sky',
      body: `${o1.country} accounts for ${formatShare(o1.share)} of tracked objects, ahead of ${o2.country} at ${formatShare(o2.share)} and ${o3.country} at ${formatShare(o3.share)}. `
        + `${s.owners.length} operators or nations make up the visible bulk; the long tail runs to dozens more.`,
    });
  }

  // 4. Decay pressure — the part of the catalog that will not be here long.
  if (s.decayingSoon > 0) {
    items.push({
      title: 'Coming down',
      body: `${s.decayingSoon.toLocaleString()} tracked objects sit below 300 km, where the last wisps of atmosphere still bite. `
        + `Without a re-boost they re-enter within months to a few years — the one mechanism that clears low orbit for free.`,
    });
  }

  // 5. The shape of the space age, from the launch-decade histogram.
  if (s.decades.length >= 2) {
    const peak = s.decades.reduce((a, b) => (b.count > a.count ? b : a));
    const first = s.decades[0];
    items.push({
      title: 'The space age in numbers',
      body: `Objects still tracked date back to the ${first.decade}s. The ${peak.decade}s dominate the catalog with ${peak.count.toLocaleString()} of them — `
        + `a launch rate no earlier decade came close to, driven mostly by large commercial constellations.`,
    });
  }

  // 6. Tonight — only if the caller computed a pass.
  if (visiblePassLine) {
    items.push({ title: 'Look up tonight', body: visiblePassLine });
  }

  // 7. This day in space history.
  const history = ON_THIS_DAY[mmdd(now)];
  if (history) {
    items.push({ title: 'On this day', body: history });
  }

  // 8. Two rotating did-you-knows, seeded by the day so they are stable within
  //    it. Offset by a prime so the pair does not repeat as a pair year to year.
  items.push({
    title: 'Did you know',
    body: DID_YOU_KNOW[doy % DID_YOU_KNOW.length],
  });
  items.push({
    title: 'One more thing',
    body: DID_YOU_KNOW[(doy + 7) % DID_YOU_KNOW.length],
  });

  return {
    date: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    dateline: now.toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }),
    stats,
    items,
    shells: s.shells
      .filter((sh) => sh.count > 0)
      .map((sh) => ({
        band: sh.band, count: sh.count, share: sh.share, meanAltitudeKm: sh.meanAltitudeKm,
      })),
    owners: s.owners.slice(0, 6),
    decades: s.decades,
  };
}

const SEEN_KEY = 'pimxsats.briefing.lastSeen';

/** The local date as "YYYY-MM-DD" — the stamp used to show the briefing once
 *  per day automatically. */
export function todayStamp(now: Date): string {
  return `${now.getFullYear()}-${mmdd(now)}`;
}

/** Whether today's briefing has already been shown on this device. Any storage
 *  failure returns false — showing it again is a far smaller sin than
 *  suppressing it forever. */
export function briefingSeenToday(now: Date): boolean {
  if (typeof window === 'undefined') return true; // never auto-open during SSR
  try {
    return window.localStorage.getItem(SEEN_KEY) === todayStamp(now);
  } catch {
    return false;
  }
}

export function markBriefingSeen(now: Date): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SEEN_KEY, todayStamp(now));
  } catch {
    // A missed stamp just means the briefing offers itself again — harmless.
  }
}
