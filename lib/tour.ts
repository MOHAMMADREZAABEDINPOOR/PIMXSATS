// Cinematic Solar System tour.
//
// A fixed itinerary from the Sun outward. Each stop names a body that already
// exists in the catalog, so the camera resolves its live position from the
// same ephemeris the renderer uses — the tour visits the planets exactly
// where they are at the simulated date, never a canned flight path.

import { PLANETS, PLANET_BY_NAME, SUN_SCENE_RADIUS } from './solar-system';

export interface TourStop {
  /** Body name, or 'Sun'. */
  body: string;
  title: string;
  caption: string;
  /** Scene radius used to size the camera standoff. */
  radius: number;
  /** How long to linger once the camera has arrived, ms. */
  holdMs: number;
}

const SUN_STOP: TourStop = {
  body: 'Sun',
  title: 'The Sun',
  caption:
    'Everything here orbits one star holding 99.8% of the system’s mass. Its light takes eight minutes to reach Earth.',
  radius: SUN_SCENE_RADIUS,
  holdMs: 4600,
};

const CAPTIONS: Record<string, string> = {
  Mercury: 'Closest to the Sun and barely larger than our Moon — a scorched, cratered world with almost no atmosphere.',
  Venus: 'Earth’s twin in size, and nothing like it: a crushing carbon-dioxide sky that traps enough heat to melt lead.',
  Earth: 'The only world we know that carries life — and, tonight, thousands of tracked satellites in the swarm around it.',
  Mars: 'The rust-red desert planet, host to more working robots than any world besides our own.',
  Jupiter: 'A gas giant so massive it could swallow every other planet, guarded by a storm wider than Earth.',
  Saturn: 'Rings of ice and rock, some particles the size of a grain of sand, others the size of a house.',
  Uranus: 'Tipped on its side by an ancient collision, this ice giant rolls around the Sun rather than spinning upright.',
  Neptune: 'The outermost planet, where supersonic winds tear through an atmosphere lit by a Sun 900× dimmer than ours.',
};

export const TOUR_STOPS: TourStop[] = [
  SUN_STOP,
  ...PLANETS.map((planet) => ({
    body: planet.name,
    title: planet.name,
    caption: CAPTIONS[planet.name] ?? planet.fact,
    radius: planet.sceneRadius,
    // The gas giants are worth a longer look than the rocky specks.
    holdMs: planet.radiusKm > 20000 ? 5000 : 4000,
  })),
];

/** Camera standoff distance for a stop — far enough that the whole body (and
 *  Saturn's rings) is comfortably in frame, with a floor so the tiny rocky
 *  planets are not approached to within a hair of their surface. */
export function tourStandoff(stop: TourStop): number {
  return Math.max(stop.radius * 5.5, 0.055);
}

/** Guard against a stop naming a body the catalog no longer defines. */
export function tourStopExists(stop: TourStop): boolean {
  return stop.body === 'Sun' || PLANET_BY_NAME.has(stop.body);
}
