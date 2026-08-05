// Making orbital numbers mean something.
//
// "408 km altitude" and "7.66 km/s" are true and almost entirely useless: both
// are outside the range of distances and speeds a person has ever physically
// experienced. This module converts a figure into a comparison that lands —
// the ISS is one Paris-to-London hop straight up; a LEO satellite crosses a
// city faster than you can read this sentence.
//
// Two rules keep it honest:
//   1. Comparisons are chosen so the RATIO is close to 1 (between ~0.5 and ~20).
//      "35,786 km is 0.09 times the distance to the Moon" tells you nothing;
//      "roughly a tenth of the way to the Moon" does.
//   2. Every reference is a real measured figure, listed with its value, so a
//      curious user can check the arithmetic rather than trusting a vibe.

export interface Reference {
  /** How the thing is named in the sentence. */
  label: string;
  /** The measured value, in the unit of its family. */
  value: number;
  /** Optional detail shown as a tooltip / secondary line. */
  note?: string;
}

// --- Distance references, km ------------------------------------------------
// Spanning eight orders of magnitude so something is always within a factor of
// ~20 of the query, from a tall building to interplanetary space.
const DISTANCES: Reference[] = [
  { label: 'the height of Burj Khalifa', value: 0.828, note: 'the tallest building on Earth, 828 m' },
  { label: 'the depth of the Mariana Trench', value: 10.9, note: 'the deepest point of the ocean' },
  { label: 'the cruising altitude of an airliner', value: 11, note: 'about 36,000 ft' },
  { label: 'the width of Greater London', value: 60 },
  { label: 'the Channel crossing, Dover to Calais', value: 34 },
  { label: 'the drive from Paris to London', value: 460 },
  { label: 'the length of Italy', value: 1200 },
  { label: 'the width of Australia', value: 4000 },
  { label: 'the flight from London to New York', value: 5570 },
  { label: "Earth's radius", value: 6371 },
  { label: 'a trip around the equator', value: 40075 },
  { label: "the Moon's distance", value: 384400, note: 'centre to centre, on average' },
  { label: 'the distance to Mars at its closest', value: 54600000 },
  { label: 'the distance to the Sun', value: 149597870, note: 'one astronomical unit' },
];

// --- Speed references, km/s -------------------------------------------------
const SPEEDS: Reference[] = [
  { label: 'a person walking', value: 0.0014 },
  { label: 'a car on the motorway', value: 0.031 },
  { label: 'a high-speed train', value: 0.083 },
  { label: 'an airliner at cruise', value: 0.25 },
  { label: 'the speed of sound at sea level', value: 0.343 },
  { label: 'a rifle bullet', value: 0.9 },
  { label: 'Concorde at Mach 2', value: 0.68 },
  { label: "the Earth's spin at the equator", value: 0.465 },
  { label: 'the Earth orbiting the Sun', value: 29.8 },
];

/** Pick the reference whose ratio to `value` is closest to 1 in log space —
 *  that is the one that reads as a comparison rather than as long division. */
function best(refs: Reference[], value: number): Reference | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  let bestRef: Reference | null = null;
  let bestScore = Infinity;
  for (const ref of refs) {
    const score = Math.abs(Math.log(value / ref.value));
    if (score < bestScore) { bestScore = score; bestRef = ref; }
  }
  return bestRef;
}

/** "about 1.4×" / "roughly two thirds of" / "almost exactly" — the multiplier
 *  as a phrase, because "1.03×" is noise where "almost exactly" is a fact. */
function ratioPhrase(ratio: number): string {
  if (ratio > 0.95 && ratio < 1.05) return 'almost exactly';
  if (ratio > 0.7 && ratio < 0.78) return 'about three quarters of';
  if (ratio > 0.6 && ratio < 0.7) return 'about two thirds of';
  if (ratio > 0.45 && ratio < 0.55) return 'about half';
  if (ratio > 0.3 && ratio < 0.37) return 'about a third of';
  if (ratio > 0.22 && ratio < 0.28) return 'about a quarter of';
  if (ratio < 0.22) return `about ${(1 / ratio).toFixed(0)} times smaller than`;
  if (ratio < 1) return `about ${ratio.toFixed(1)}×`;
  return `about ${ratio.toFixed(ratio < 10 ? 1 : 0)}×`;
}

export interface Comparison {
  /** Ready-to-display sentence fragment. */
  text: string;
  reference: Reference;
  ratio: number;
}

/** Compare a distance in km to something human. */
export function compareDistance(km: number): Comparison | null {
  const ref = best(DISTANCES, km);
  if (!ref) return null;
  const ratio = km / ref.value;
  return { text: `${ratioPhrase(ratio)} ${ref.label}`, reference: ref, ratio };
}

/** Compare a speed in km/s to something human. */
export function compareSpeed(kmPerSec: number): Comparison | null {
  const ref = best(SPEEDS, kmPerSec);
  if (!ref) return null;
  const ratio = kmPerSec / ref.value;
  return { text: `${ratioPhrase(ratio)} ${ref.label}`, reference: ref, ratio };
}

/** How long light takes to cover a distance — the one figure that makes deep
 *  space feel deep. */
export function lightTime(km: number): { seconds: number; text: string } {
  const seconds = km / 299792.458;
  let text: string;
  if (seconds < 0.001) text = `${(seconds * 1e6).toFixed(0)} µs`;
  else if (seconds < 1) text = `${(seconds * 1000).toFixed(0)} ms`;
  else if (seconds < 90) text = `${seconds.toFixed(1)} s`;
  else if (seconds < 5400) text = `${(seconds / 60).toFixed(1)} min`;
  else if (seconds < 172800) text = `${(seconds / 3600).toFixed(1)} h`;
  else text = `${(seconds / 86400).toFixed(1)} days`;
  return { seconds, text };
}

/**
 * The headline storytelling line for a satellite: how far up it is, how fast,
 * and what that means in ground terms.
 *
 * `groundSpeedKmS` is the sub-point's speed across the surface, which is what
 * "crosses a country in N seconds" should be measured against — the orbital
 * speed is faster than the ground track sweeps.
 */
export function orbitStory(altitudeKm: number, speedKmS: number): string[] {
  const lines: string[] = [];

  const dist = compareDistance(altitudeKm);
  if (dist) {
    lines.push(`Straight up, that's ${dist.text} — ${altitudeKm.toFixed(0)} km.`);
  }

  const spd = compareSpeed(speedKmS);
  if (spd) {
    lines.push(`It's moving ${spd.text} ${spd.ratio >= 1 ? 'faster than' : ''} ${spd.reference.label}.`.replace('  ', ' '));
  }

  if (speedKmS > 0) {
    // London is ~60 km across; at orbital speed that is a handful of seconds.
    const londonSec = 60 / speedKmS;
    lines.push(`At that speed it crosses a city the size of London in ${londonSec.toFixed(1)} seconds.`);
    const equatorMin = 40075 / speedKmS / 60;
    lines.push(`One lap of the equator would take it ${equatorMin.toFixed(0)} minutes.`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Scale reference
// ---------------------------------------------------------------------------
//
// The 3D scene necessarily lies about size: at true scale a satellite is
// sub-pixel next to the Earth, and the solar system is almost entirely empty
// space. This states the lie plainly rather than letting it pass as fact.

export interface ScaleNote {
  title: string;
  body: string;
}

/** What the current view is exaggerating, and by how much. Honest captions for
 *  the scale panel — each one names the real figure alongside the drawn one. */
export function scaleNotes(view: 'earth' | 'solar'): ScaleNote[] {
  if (view === 'earth') {
    return [
      {
        title: 'Satellites are drawn far too big',
        body: 'The ISS is about 109 m across and Earth is 12,742 km — a ratio of roughly 1 to 117,000. At true scale it would be far smaller than one pixel, so every object here is enlarged thousands of times to be clickable at all.',
      },
      {
        title: 'Orbit altitudes are true',
        body: 'Distances from the surface are drawn to scale. LEO really does hug the planet: at 400 km the ISS orbits at about 6% of an Earth radius above the surface — the thin shell just above the atmosphere, not the wide-open space diagrams usually suggest.',
      },
      {
        title: 'The sky is emptier than it looks',
        body: 'Even with every tracked object shown at once, the average separation between two LEO objects is hundreds of kilometres. The crowding you see is the drawn size of the dots, not the density of the traffic.',
      },
      {
        title: 'The shells, to scale',
        body: 'If Earth were a 30 cm globe, the ISS would orbit less than 1 cm above its surface — a coat of paint. Starlink at 550 km sits about 1.3 cm up; GPS at 20,200 km would be nearly half a metre out; and the geostationary belt at 35,786 km would circle 84 cm from the globe. LEO, MEO and GEO are not neighbours — they are wildly different distances.',
      },
      {
        title: 'How fast is a satellite, really',
        body: 'To stay in low orbit an object must travel about 7.8 km/s sideways — roughly 28,000 km/h, or Mach 23. That is why launch is so hard: reaching space is minutes of climbing, but staying there means being flung sideways fast enough to keep missing the ground as you fall.',
      },
      {
        title: 'Where the horizon ends',
        body: 'A satellite is only "overhead" for a few minutes. From the ground the ISS clears the horizon, crosses the sky and sets again in under ten minutes, because at 400 km its horizon-to-horizon arc is only a couple of thousand kilometres wide — and it covers that at eight kilometres a second.',
      },
      {
        title: 'This many objects, this small a shell',
        body: 'Tens of thousands of tracked objects share a band of space only about 1,600 km thick wrapped around a planet 12,742 km wide. It sounds packed, but that shell still has a surface area larger than every continent combined at each altitude — the density is low, the closing speeds are not.',
      },
    ];
  }
  return [
    {
      title: 'Planets are enlarged; distances are compressed',
      body: 'At a scale where Earth is one pixel, the Sun would be 110 pixels across and sit 12,000 pixels away. Nothing would be visible on one screen, so body radii here are exaggerated relative to orbit radii.',
    },
    {
      title: 'The solar system is mostly nothing',
      body: 'If the Sun were a football at the centre circle, Earth would be a peppercorn 26 m away and Neptune a small pea 780 m off — with nothing but vacuum in between. Every solar-system illustration you have seen, including this one, compresses that emptiness.',
    },
    {
      title: 'Orbits are drawn as circles',
      body: 'Most planetary orbits are very nearly circular — Earth varies by only 3% over a year — but Mercury and Pluto are noticeably elliptical, and comet paths far more so. The rings here are idealised.',
    },
    {
      title: 'Light itself is slow out here',
      body: 'Sunlight takes 8 minutes to reach Earth, 43 minutes to reach Jupiter and over 4 hours to reach Neptune. The Sun you see is always a few minutes old; the outer planets you see are hours old. Distance in the solar system is measured in how long light has been travelling.',
    },
    {
      title: 'The Sun holds almost all the mass',
      body: 'The Sun is 99.86% of the entire solar system by mass. Everything else — all eight planets, every moon, asteroid and comet — is rounding error in the remaining 0.14%, and Jupiter alone is most of that. The planets do not so much orbit the Sun as get dragged along by it.',
    },
    {
      title: 'The gaps grow as you go out',
      body: 'The inner planets are crowded together; the outer ones are flung far apart. Mars to Jupiter is a bigger jump than the Sun to Mars, and Saturn to Uranus doubles the distance again. This is why crossing from the inner system to the outer feels like the scene suddenly opens up — because it does.',
    },
  ];
}
