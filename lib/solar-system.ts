// Solar-system catalog: planets, real moons, and every notable spacecraft
// operating (or historically famous) beyond low Earth orbit — plus the shared
// position math used by both the renderer and the tracking camera.
//
// Positions are driven by the simulated clock:
//  - Planets: JPL approximate Keplerian elements (lib/astronomy.ts) — real-time.
//  - Earth's Moon: low-precision lunar ephemeris — real-time direction & phase.
//  - Other moons: real orbital periods on circular orbits (phase referenced
//    to J2000; sub-degree epoch phases are approximated).
//  - Probes: class-appropriate motion (planetary orbiters use Kepler's third
//    law around their host, Lagrange craft ride with Earth, escape-trajectory
//    craft use published distance/direction + recession rate, cruising craft
//    interpolate between origin and destination by mission timeline).
//
// Radial distances are compressed for browsability (see lib/astronomy.ts);
// all angular positions stay true to the simulated date.

import * as THREE from 'three';
import {
  auToSceneRadius,
  daysSinceJ2000,
  eclipticToScene,
  getMoonGeocentric,
  getPlanetHeliocentric,
  solveKepler,
} from './astronomy';

// ---------------------------------------------------------------------------
// Body sizes: true relative scale between planets and moons (Jupiter is
// exactly 10.97× Earth, Ganymede 0.41× Earth, ...), boosted by a single
// shared factor so the planets are actually visible against the compressed
// (sqrt-scale) orbit distances. The Sun is NOT boosted and remains the
// largest body in the scene — at strict scale against boosted planets it
// would swallow Mercury's whole orbit.
// ---------------------------------------------------------------------------

export const SUN_SCENE_RADIUS = 0.5;
const SUN_RADIUS_KM = 696000;
const PLANET_SIZE_BOOST = 6;

/** Display radius in scene units for a real body radius in km. */
export function bodyRadiusToScene(radiusKm: number): number {
  return SUN_SCENE_RADIUS * (radiusKm / SUN_RADIUS_KM) * PLANET_SIZE_BOOST;
}

// ---------------------------------------------------------------------------
// Planets
// ---------------------------------------------------------------------------

export interface MoonInfo {
  name: string;
  radiusKm: number;
  orbitKm: number;       // semi-major axis from planet center
  periodDays: number;    // sidereal period (negative = retrograde)
  color: string;
  fact: string;
}

export interface PlanetInfo {
  name: string;
  radiusKm: number;
  sceneRadius: number;   // display: true relative scale — SUN_SCENE_RADIUS * radiusKm/696000
  color: string;
  textureUrl: string;
  hasRings?: boolean;
  moons: MoonInfo[];
  orbitAu: number;       // mean distance from the Sun, AU
  periodDays: number;    // sidereal orbital period, days
  fact: string;
}

const TEX = 'https://raw.githubusercontent.com/sanderblue/solar-system-threejs/gh-pages/src/assets/textures';

export const PLANETS: PlanetInfo[] = [
  {
    name: 'Mercury', radiusKm: 2440, sceneRadius: bodyRadiusToScene(2440), color: '#9c9488',
    orbitAu: 0.387, periodDays: 87.97,
    fact: 'The smallest planet and closest to the Sun — a cratered world where a single day lasts two of its years.',
    textureUrl: `${TEX}/mercury.jpg`, moons: [],
  },
  {
    name: 'Venus', radiusKm: 6052, sceneRadius: bodyRadiusToScene(6052), color: '#e3bb76',
    orbitAu: 0.723, periodDays: 224.7,
    fact: 'The hottest planet, wrapped in crushing CO2 clouds; it spins backwards, so the Sun rises in the west.',
    textureUrl: `${TEX}/venus.jpg`, moons: [],
  },
  {
    name: 'Earth', radiusKm: 6371, sceneRadius: bodyRadiusToScene(6371), color: '#2b82c9',
    orbitAu: 1.0, periodDays: 365.26,
    fact: 'The only known world with liquid-water oceans and life — and over 10,000 active artificial satellites.',
    textureUrl: '/textures/earth_day.jpg',
    moons: [
      { name: 'Moon', radiusKm: 1737, orbitKm: 384400, periodDays: 27.3217, color: '#b8b8b8', fact: 'Position computed from a real lunar ephemeris — its phase angle matches the actual sky.' },
    ],
  },
  {
    name: 'Mars', radiusKm: 3390, sceneRadius: bodyRadiusToScene(3390), color: '#c1440e',
    orbitAu: 1.524, periodDays: 686.98,
    fact: 'The red planet, home to the tallest volcano in the Solar System (Olympus Mons) and a small fleet of orbiters and rovers.',
    textureUrl: `${TEX}/mars.jpg`,
    moons: [
      { name: 'Phobos', radiusKm: 11, orbitKm: 9376, periodDays: 0.3189, color: '#8b7a6f', fact: 'Orbits Mars three times per Martian day.' },
      { name: 'Deimos', radiusKm: 6, orbitKm: 23463, periodDays: 1.2624, color: '#a89f91', fact: 'The smaller and outermost Martian moon.' },
    ],
  },
  {
    name: 'Jupiter', radiusKm: 69911, sceneRadius: bodyRadiusToScene(69911), color: '#b07f35',
    orbitAu: 5.203, periodDays: 4332.6,
    fact: 'A gas giant more massive than all other planets combined; its Great Red Spot is a storm larger than Earth.',
    textureUrl: `${TEX}/jupiter.jpg`,
    moons: [
      { name: 'Io', radiusKm: 1822, orbitKm: 421800, periodDays: 1.7691, color: '#ffdf00', fact: 'The most volcanically active body in the Solar System.' },
      { name: 'Europa', radiusKm: 1561, orbitKm: 671100, periodDays: 3.5512, color: '#cfc0a0', fact: 'Hides a global liquid-water ocean beneath its ice shell.' },
      { name: 'Ganymede', radiusKm: 2634, orbitKm: 1070400, periodDays: 7.1546, color: '#a09080', fact: 'The largest moon in the Solar System — bigger than Mercury.' },
      { name: 'Callisto', radiusKm: 2410, orbitKm: 1882700, periodDays: 16.689, color: '#706050', fact: 'The most heavily cratered object known.' },
    ],
  },
  {
    name: 'Saturn', radiusKm: 58232, sceneRadius: bodyRadiusToScene(58232), color: '#e2bf7d',
    orbitAu: 9.537, periodDays: 10759.2,
    fact: 'Famous for its magnificent ice rings — hundreds of thousands of kilometers wide yet only tens of meters thick.',
    textureUrl: `${TEX}/saturn.jpg`, hasRings: true,
    moons: [
      { name: 'Mimas', radiusKm: 198, orbitKm: 185539, periodDays: 0.942, color: '#aaaaaa', fact: 'Its giant Herschel crater gives it a Death Star look.' },
      { name: 'Enceladus', radiusKm: 252, orbitKm: 238042, periodDays: 1.3702, color: '#ffffff', fact: 'Vents water geysers from a subsurface ocean at its south pole.' },
      { name: 'Tethys', radiusKm: 531, orbitKm: 294672, periodDays: 1.8878, color: '#d8d8d8', fact: 'An icy moon scarred by the vast Ithaca Chasma canyon.' },
      { name: 'Dione', radiusKm: 561, orbitKm: 377415, periodDays: 2.7369, color: '#cccccc', fact: 'Shows bright "wispy terrain" — ice cliffs hundreds of meters tall.' },
      { name: 'Rhea', radiusKm: 764, orbitKm: 527068, periodDays: 4.5175, color: '#bbbbbb', fact: "Saturn's second-largest moon.", },
      { name: 'Titan', radiusKm: 2575, orbitKm: 1221870, periodDays: 15.945, color: '#ffcc77', fact: 'The only moon with a thick atmosphere and surface lakes (of methane).' },
      { name: 'Iapetus', radiusKm: 735, orbitKm: 3560840, periodDays: 79.33, color: '#997755', fact: 'Two-toned: one hemisphere is coal-dark, the other bright ice.' },
    ],
  },
  {
    name: 'Uranus', radiusKm: 25362, sceneRadius: bodyRadiusToScene(25362), color: '#4b70dd',
    orbitAu: 19.19, periodDays: 30688.5,
    fact: 'An ice giant tipped on its side — it rolls around the Sun with its poles pointing at it.',
    textureUrl: `${TEX}/uranus.jpg`,
    moons: [
      { name: 'Miranda', radiusKm: 236, orbitKm: 129900, periodDays: 1.4135, color: '#999999', fact: 'Has the tallest known cliff in the Solar System, Verona Rupes.' },
      { name: 'Ariel', radiusKm: 579, orbitKm: 190900, periodDays: 2.520, color: '#cccccc', fact: 'The brightest of the Uranian moons.' },
      { name: 'Umbriel', radiusKm: 585, orbitKm: 266000, periodDays: 4.144, color: '#888888', fact: 'The darkest of the large Uranian moons.' },
      { name: 'Titania', radiusKm: 789, orbitKm: 436300, periodDays: 8.7059, color: '#b0c0d0', fact: 'The largest moon of Uranus.' },
      { name: 'Oberon', radiusKm: 761, orbitKm: 583500, periodDays: 13.463, color: '#90a0b0', fact: 'The outermost major Uranian moon.' },
    ],
  },
  {
    name: 'Neptune', radiusKm: 24622, sceneRadius: bodyRadiusToScene(24622), color: '#274687',
    orbitAu: 30.07, periodDays: 60182.0,
    fact: 'The windiest world known, with supersonic storms; discovered by mathematics before it was seen in a telescope.',
    textureUrl: `${TEX}/neptune.jpg`,
    moons: [
      { name: 'Proteus', radiusKm: 210, orbitKm: 117646, periodDays: 1.1223, color: '#88a8cc', fact: 'One of the darkest objects in the Solar System.' },
      { name: 'Triton', radiusKm: 1353, orbitKm: 354759, periodDays: -5.8769, color: '#ccddff', fact: 'Orbits backwards — a captured Kuiper Belt object with nitrogen geysers.' },
      { name: 'Nereid', radiusKm: 170, orbitKm: 5513818, periodDays: 360.13, color: '#557799', fact: 'Has one of the most eccentric orbits of any moon.' },
    ],
  },
];

export const PLANET_BY_NAME = new Map(PLANETS.map((p) => [p.name, p]));

export const SUN_TEXTURE_URL = `${TEX}/sun.jpg`;

// Gravitational parameters, km^3/s^2 (for real orbital periods of probes)
const GM: Record<string, number> = {
  Mercury: 22032, Venus: 324859, Earth: 398600, Moon: 4903,
  Mars: 42828, Jupiter: 126686534, Saturn: 37931187,
  Uranus: 5793939, Neptune: 6836529,
};

// ---------------------------------------------------------------------------
// Display-scale compression helpers
// ---------------------------------------------------------------------------

/** Moon orbital radius in scene units (compressed, ordering preserved). */
export function moonOrbitSceneRadius(planet: PlanetInfo, moon: MoonInfo): number {
  const ratio = Math.max(1.5, moon.orbitKm / planet.radiusKm);
  return planet.sceneRadius * (1.5 + 1.7 * (Math.log(ratio) / Math.log(60)));
}

/** Moon display radius in scene units — the TRUE size ratio to its planet
 *  (clamped so tiny moons like Phobos remain visible at all). */
export function moonSceneRadius(planet: PlanetInfo, moon: MoonInfo): number {
  return Math.max(0.0006, planet.sceneRadius * (moon.radiusKm / planet.radiusKm));
}

/** Compressed radius (multiple of planet scene radius) for an Earth satellite at real distance rKm from Earth's center. */
export function earthSatSceneFactor(rKm: number): number {
  const alt = Math.max(0, rKm - 6371);
  return 1.02 + 0.8 * Math.log1p(alt / 6000);
}

// ---------------------------------------------------------------------------
// Spacecraft catalog
// ---------------------------------------------------------------------------

export type SolarSatKind =
  | 'orbiter'        // orbits a planet
  | 'moon-orbiter'   // orbits Earth's Moon
  | 'l1' | 'l2'      // Sun-Earth Lagrange points
  | 'heliocentric'   // own orbit around the Sun
  | 'cruise'         // in transit between two bodies
  | 'escape';        // leaving the Solar System

export interface SolarSat {
  name: string;
  planet: string;        // grouping label shown in UI ("Deep Space", "Mars", ...)
  operator: string;
  purpose: string;
  country: string;
  launchYear: string;
  altitude: number;      // representative altitude/distance, km
  speed: number;         // representative speed, km/s
  fact: string;
  color: string;
  type: string;
  kind: SolarSatKind;
  active: boolean;
  // orbiter / moon-orbiter
  orbitAltKm?: number;
  inclinationDeg?: number;
  // heliocentric
  helio?: { aAu: number; e: number; periodDays: number; lon0Deg: number };
  // cruise
  cruise?: { from: string; to: string; departMs: number; arriveMs: number };
  // escape
  esc?: { distAu2026: number; auPerYear: number; eclLonDeg: number; eclLatDeg: number };
}

const Y = (y: number, m = 0, d = 1) => Date.UTC(y, m, d);

export const SOLAR_SATELLITES: SolarSat[] = [
  // --- Inner system / heliophysics ---
  {
    name: 'Parker Solar Probe', planet: 'Deep Space', operator: 'NASA / JHUAPL',
    purpose: 'Heliophysics & Solar Corona Study', country: 'USA', launchYear: '2018',
    altitude: 6900000, speed: 163, color: '#ff8800', type: 'Solar Probe', kind: 'heliocentric', active: true,
    helio: { aAu: 0.388, e: 0.88, periodDays: 88, lon0Deg: 10 },
    fact: 'The fastest human-made object in history, repeatedly flying through the Sun\'s corona at up to 690,000 km/h.',
  },
  {
    name: 'Solar Orbiter', planet: 'Deep Space', operator: 'ESA / NASA',
    purpose: 'Solar Poles & Inner Heliosphere Imaging', country: 'Europe', launchYear: '2020',
    altitude: 42000000, speed: 30, color: '#ffbb33', type: 'Solar Probe', kind: 'heliocentric', active: true,
    helio: { aAu: 0.60, e: 0.52, periodDays: 168, lon0Deg: 150 },
    fact: 'Takes the closest-ever images of the Sun and is tilting its orbit to photograph the solar poles for the first time.',
  },
  {
    name: 'STEREO-A', planet: 'Deep Space', operator: 'NASA',
    purpose: 'Stereoscopic Solar Observation', country: 'USA', launchYear: '2006',
    altitude: 149000000, speed: 30, color: '#ffcc66', type: 'Solar Observatory', kind: 'heliocentric', active: true,
    helio: { aAu: 0.96, e: 0.006, periodDays: 346, lon0Deg: 230 },
    fact: 'Drifts around the Sun slightly faster than Earth, giving scientists a side-view of solar eruptions heading our way.',
  },
  {
    name: 'SOHO', planet: 'Deep Space', operator: 'ESA / NASA',
    purpose: 'Solar & Heliospheric Observatory', country: 'International', launchYear: '1995',
    altitude: 1500000, speed: 30, color: '#ffaa44', type: 'Solar Observatory', kind: 'l1', active: true,
    fact: 'Watching the Sun from the L1 point for 30 years; has discovered over 5,000 comets as a side job.',
  },
  {
    name: 'ACE', planet: 'Deep Space', operator: 'NASA',
    purpose: 'Solar Wind & Space Weather Monitoring', country: 'USA', launchYear: '1997',
    altitude: 1500000, speed: 30, color: '#ddaa66', type: 'Space Weather Monitor', kind: 'l1', active: true,
    fact: 'Gives Earth about a one-hour warning before solar storms arrive by sampling the solar wind upstream at L1.',
  },
  {
    name: 'DSCOVR', planet: 'Deep Space', operator: 'NOAA / NASA',
    purpose: 'Space Weather & Full-Disk Earth Imaging', country: 'USA', launchYear: '2015',
    altitude: 1500000, speed: 30, color: '#66ccff', type: 'Space Weather Monitor', kind: 'l1', active: true,
    fact: 'Photographs the entire sunlit face of Earth every two hours from the L1 point, 1.5 million km sunward.',
  },
  // --- Sun-Earth L2 observatories ---
  {
    name: 'James Webb Space Telescope', planet: 'Deep Space', operator: 'NASA / ESA / CSA',
    purpose: 'Deep Space Infrared Observatory', country: 'International', launchYear: '2021',
    altitude: 1500000, speed: 30, color: '#ffd700', type: 'Space Telescope', kind: 'l2', active: true,
    fact: 'Orbits the Sun-Earth L2 point with a 6.5 m golden mirror, capturing light from the first galaxies ever formed.',
  },
  {
    name: 'Euclid', planet: 'Deep Space', operator: 'ESA',
    purpose: 'Dark Matter & Dark Energy Survey', country: 'Europe', launchYear: '2023',
    altitude: 1500000, speed: 30, color: '#c0c8ff', type: 'Space Telescope', kind: 'l2', active: true,
    fact: 'Mapping billions of galaxies from L2 to chart the invisible dark-matter skeleton of the Universe.',
  },
  // --- Mercury & Venus ---
  {
    name: 'BepiColombo', planet: 'Mercury', operator: 'ESA / JAXA',
    purpose: 'Mercury Orbital Survey', country: 'Europe / Japan', launchYear: '2018',
    altitude: 480, speed: 3.0, color: '#cc99ff', type: 'Planetary Orbiter', kind: 'cruise', active: true,
    cruise: { from: 'Venus', to: 'Mercury', departMs: Y(2020, 9), arriveMs: Y(2026, 10, 30) },
    fact: 'A twin-spacecraft mission finishing a seven-year spiral toward Mercury orbit insertion in late 2026.',
  },
  {
    name: 'Akatsuki', planet: 'Venus', operator: 'JAXA',
    purpose: 'Venusian Climate & Atmosphere', country: 'Japan', launchYear: '2010',
    altitude: 80000, speed: 3.7, color: '#ff6600', type: 'Planetary Orbiter', kind: 'orbiter', active: false,
    orbitAltKm: 80000, inclinationDeg: 3,
    fact: 'Studied Venus\'s super-rotating winds for a decade; contact was lost in 2024 after an extraordinary extended mission.',
  },
  {
    name: 'Magellan', planet: 'Venus', operator: 'NASA / JPL',
    purpose: 'Radar Mapping of Venus Surface', country: 'USA', launchYear: '1989',
    altitude: 290, speed: 7.2, color: '#ffbb00', type: 'Historical Orbiter', kind: 'orbiter', active: false,
    orbitAltKm: 290, inclinationDeg: 85,
    fact: 'Mapped 98% of Venus through its clouds with radar before being deliberately plunged into the atmosphere in 1994.',
  },
  // --- Moon ---
  {
    name: 'Lunar Reconnaissance Orbiter', planet: 'Earth', operator: 'NASA',
    purpose: 'Lunar Mapping & Landing-Site Survey', country: 'USA', launchYear: '2009',
    altitude: 50, speed: 1.6, color: '#ffffff', type: 'Lunar Orbiter', kind: 'moon-orbiter', active: true,
    orbitAltKm: 50, inclinationDeg: 90,
    fact: 'Has mapped the Moon in such detail it can photograph the Apollo landing sites — flags and rover tracks included.',
  },
  {
    name: 'Danuri (KPLO)', planet: 'Earth', operator: 'KARI',
    purpose: 'Lunar Science & Technology Demo', country: 'South Korea', launchYear: '2022',
    altitude: 100, speed: 1.6, color: '#88ffcc', type: 'Lunar Orbiter', kind: 'moon-orbiter', active: true,
    orbitAltKm: 100, inclinationDeg: 90,
    fact: 'South Korea\'s first deep-space mission, peering into permanently shadowed lunar craters with its ShadowCam.',
  },
  {
    name: 'Chandrayaan-2 Orbiter', planet: 'Earth', operator: 'ISRO',
    purpose: 'Lunar Remote Sensing', country: 'India', launchYear: '2019',
    altitude: 100, speed: 1.6, color: '#ff9933', type: 'Lunar Orbiter', kind: 'moon-orbiter', active: true,
    orbitAltKm: 100, inclinationDeg: 90,
    fact: 'Carries the highest-resolution camera ever sent to lunar orbit and helped confirm water ice at the poles.',
  },
  {
    name: 'CAPSTONE', planet: 'Earth', operator: 'NASA / Advanced Space',
    purpose: 'Lunar Gateway Orbit Pathfinder', country: 'USA', launchYear: '2022',
    altitude: 3000, speed: 1.2, color: '#aaddff', type: 'CubeSat Pathfinder', kind: 'moon-orbiter', active: true,
    orbitAltKm: 3000, inclinationDeg: 60,
    fact: 'A microwave-oven-sized CubeSat testing the unique halo orbit planned for the Lunar Gateway station.',
  },
  // --- Mars ---
  {
    name: 'Mars Reconnaissance Orbiter', planet: 'Mars', operator: 'NASA / JPL',
    purpose: 'High-Resolution Imagery & Data Relay', country: 'USA', launchYear: '2005',
    altitude: 300, speed: 3.4, color: '#ff3333', type: 'Mars Orbiter', kind: 'orbiter', active: true,
    orbitAltKm: 300, inclinationDeg: 93,
    fact: 'Its HiRISE camera resolves objects the size of a desk on the Martian surface, and it relays most rover data home.',
  },
  {
    name: 'MAVEN', planet: 'Mars', operator: 'NASA / LASP',
    purpose: 'Atmospheric Escape & Solar Wind Study', country: 'USA', launchYear: '2013',
    altitude: 4500, speed: 4.1, color: '#ff6666', type: 'Mars Aeronomy Orbiter', kind: 'orbiter', active: true,
    orbitAltKm: 4500, inclinationDeg: 75,
    fact: 'Revealed how the solar wind stripped away the Martian atmosphere, turning a wet world into a desert.',
  },
  {
    name: 'Mars Express', planet: 'Mars', operator: 'ESA',
    purpose: 'Mars Surface & Subsurface Science', country: 'Europe', launchYear: '2003',
    altitude: 10000, speed: 3.0, color: '#ff8855', type: 'Mars Orbiter', kind: 'orbiter', active: true,
    orbitAltKm: 10000, inclinationDeg: 86,
    fact: 'Europe\'s first planetary mission found buried lakes of liquid water beneath the Martian south pole.',
  },
  {
    name: '2001 Mars Odyssey', planet: 'Mars', operator: 'NASA / JPL',
    purpose: 'Mineral Mapping & Relay', country: 'USA', launchYear: '2001',
    altitude: 400, speed: 3.4, color: '#ffaa77', type: 'Mars Orbiter', kind: 'orbiter', active: true,
    orbitAltKm: 400, inclinationDeg: 93,
    fact: 'The longest-serving spacecraft at another planet, orbiting Mars continuously since 2001.',
  },
  {
    name: 'ExoMars TGO', planet: 'Mars', operator: 'ESA / Roscosmos',
    purpose: 'Trace Gas & Methane Detection', country: 'Europe', launchYear: '2016',
    altitude: 400, speed: 3.4, color: '#ffcc88', type: 'Mars Orbiter', kind: 'orbiter', active: true,
    orbitAltKm: 400, inclinationDeg: 74,
    fact: 'Sniffs the Martian atmosphere for trace gases like methane that could hint at geological or biological activity.',
  },
  {
    name: 'Tianwen-1', planet: 'Mars', operator: 'CNSA',
    purpose: 'Global Mars Survey & Relay', country: 'China', launchYear: '2020',
    altitude: 10700, speed: 3.0, color: '#ff5544', type: 'Mars Orbiter', kind: 'orbiter', active: true,
    orbitAltKm: 10700, inclinationDeg: 87,
    fact: 'China\'s first independent Mars mission delivered an orbiter, lander and the Zhurong rover in one shot.',
  },
  {
    name: 'Hope (Al-Amal)', planet: 'Mars', operator: 'UAESA / MBRSC',
    purpose: 'Global Martian Weather Mapping', country: 'UAE', launchYear: '2020',
    altitude: 30000, speed: 2.5, color: '#ff7788', type: 'Mars Orbiter', kind: 'orbiter', active: true,
    orbitAltKm: 30000, inclinationDeg: 25,
    fact: 'The Arab world\'s first interplanetary mission watches entire Martian weather systems from a huge elliptical orbit.',
  },
  // --- Small bodies / cruising ---
  {
    name: 'Psyche', planet: 'Deep Space', operator: 'NASA / JPL',
    purpose: 'Metal Asteroid Exploration', country: 'USA', launchYear: '2023',
    altitude: 435000000, speed: 25, color: '#c0c0c0', type: 'Asteroid Probe', kind: 'heliocentric', active: true,
    helio: { aAu: 2.0, e: 0.35, periodDays: 1033, lon0Deg: 200 },
    fact: 'Cruising to 16 Psyche, a metal-rich asteroid that may be the exposed core of a shattered protoplanet.',
  },
  {
    name: 'Lucy', planet: 'Deep Space', operator: 'NASA',
    purpose: 'Jupiter Trojan Asteroid Tour', country: 'USA', launchYear: '2021',
    altitude: 700000000, speed: 20, color: '#ccaa88', type: 'Asteroid Probe', kind: 'cruise', active: true,
    cruise: { from: 'Earth', to: 'Jupiter', departMs: Y(2021, 9), arriveMs: Y(2027, 7) },
    fact: 'On a 12-year tour of the Trojan asteroids — pristine fossils of planet formation sharing Jupiter\'s orbit.',
  },
  {
    name: 'Hayabusa2', planet: 'Deep Space', operator: 'JAXA',
    purpose: 'Extended Asteroid Sample Mission', country: 'Japan', launchYear: '2014',
    altitude: 180000000, speed: 27, color: '#88ddaa', type: 'Asteroid Probe', kind: 'heliocentric', active: true,
    helio: { aAu: 1.19, e: 0.19, periodDays: 474, lon0Deg: 300 },
    fact: 'Returned samples of asteroid Ryugu to Earth in 2020 and is now cruising to tiny asteroid 1998 KY26.',
  },
  {
    name: 'OSIRIS-APEX', planet: 'Deep Space', operator: 'NASA',
    purpose: 'Apophis Rendezvous', country: 'USA', launchYear: '2016',
    altitude: 150000000, speed: 28, color: '#99ccff', type: 'Asteroid Probe', kind: 'heliocentric', active: true,
    helio: { aAu: 1.05, e: 0.2, periodDays: 393, lon0Deg: 60 },
    fact: 'After delivering samples of asteroid Bennu, it was retargeted to meet asteroid Apophis during its 2029 Earth flyby.',
  },
  // --- Outer planets ---
  {
    name: 'Juno', planet: 'Jupiter', operator: 'NASA / JPL',
    purpose: 'Jupiter Interior & Magnetosphere', country: 'USA', launchYear: '2011',
    altitude: 4300, speed: 58, color: '#ffd700', type: 'Jupiter Polar Orbiter', kind: 'orbiter', active: true,
    orbitAltKm: 80000, inclinationDeg: 85,
    fact: 'Skims 4,000 km above Jupiter\'s clouds on a polar orbit, staring into the core and photographing polar cyclones.',
  },
  {
    name: 'Europa Clipper', planet: 'Jupiter', operator: 'NASA / JPL',
    purpose: 'Europa Ocean Habitability Survey', country: 'USA', launchYear: '2024',
    altitude: 700000000, speed: 22, color: '#aaddff', type: 'Icy Moon Probe', kind: 'cruise', active: true,
    cruise: { from: 'Earth', to: 'Jupiter', departMs: Y(2024, 9, 14), arriveMs: Y(2030, 3, 11) },
    fact: 'The largest planetary spacecraft NASA has ever built, en route to scan Europa\'s hidden ocean for habitability.',
  },
  {
    name: 'JUICE', planet: 'Jupiter', operator: 'ESA',
    purpose: 'Jupiter Icy Moons Explorer', country: 'Europe', launchYear: '2023',
    altitude: 700000000, speed: 20, color: '#88bbff', type: 'Icy Moon Probe', kind: 'cruise', active: true,
    cruise: { from: 'Earth', to: 'Jupiter', departMs: Y(2023, 3, 14), arriveMs: Y(2031, 6) },
    fact: 'Will become the first spacecraft ever to orbit another planet\'s moon when it settles around Ganymede in 2034.',
  },
  {
    name: 'Cassini', planet: 'Saturn', operator: 'NASA / ESA / ASI',
    purpose: 'Saturn System Exploration', country: 'International', launchYear: '1997',
    altitude: 1600, speed: 32, color: '#ddaa00', type: 'Historical Orbiter', kind: 'orbiter', active: false,
    orbitAltKm: 300000, inclinationDeg: 30,
    fact: 'Discovered Enceladus\'s water geysers and Titan\'s methane seas before its 2017 Grand Finale plunge into Saturn.',
  },
  // --- Escaping the Solar System ---
  {
    name: 'New Horizons', planet: 'Deep Space', operator: 'NASA / JHUAPL',
    purpose: 'Kuiper Belt Exploration', country: 'USA', launchYear: '2006',
    altitude: 9200000000, speed: 13.8, color: '#66ffee', type: 'Kuiper Belt Probe', kind: 'escape', active: true,
    esc: { distAu2026: 61.5, auPerYear: 2.9, eclLonDeg: 293, eclLatDeg: -2 },
    fact: 'Gave humanity its first close look at Pluto in 2015 and is now sailing through the Kuiper Belt, 60+ AU out.',
  },
  {
    name: 'Voyager 1', planet: 'Deep Space', operator: 'NASA / JPL',
    purpose: 'Interstellar Medium Exploration', country: 'USA', launchYear: '1977',
    altitude: 25000000000, speed: 17.0, color: '#00ffff', type: 'Interstellar Probe', kind: 'escape', active: true,
    esc: { distAu2026: 167.5, auPerYear: 3.57, eclLonDeg: 255, eclLatDeg: 35 },
    fact: 'The most distant human-made object — nearly a light-day away, still whispering home through interstellar space.',
  },
  {
    name: 'Voyager 2', planet: 'Deep Space', operator: 'NASA / JPL',
    purpose: 'Outer Planet Flybys & Interstellar Study', country: 'USA', launchYear: '1977',
    altitude: 21000000000, speed: 15.4, color: '#00aaff', type: 'Interstellar Probe', kind: 'escape', active: true,
    esc: { distAu2026: 139.7, auPerYear: 3.1, eclLonDeg: 302, eclLatDeg: -32 },
    fact: 'The only spacecraft to visit Uranus and Neptune, now exploring interstellar space south of the ecliptic.',
  },
  {
    name: 'Pioneer 10', planet: 'Deep Space', operator: 'NASA',
    purpose: 'First Jupiter Flyby (silent)', country: 'USA', launchYear: '1972',
    altitude: 20000000000, speed: 12.0, color: '#8899aa', type: 'Historical Probe', kind: 'escape', active: false,
    esc: { distAu2026: 137, auPerYear: 2.5, eclLonDeg: 68, eclLatDeg: 3 },
    fact: 'The first spacecraft to cross the asteroid belt and fly past Jupiter; it fell silent in 2003 but drifts on toward Aldebaran.',
  },
  {
    name: 'Pioneer 11', planet: 'Deep Space', operator: 'NASA',
    purpose: 'First Saturn Flyby (silent)', country: 'USA', launchYear: '1973',
    altitude: 17000000000, speed: 11.1, color: '#7788aa', type: 'Historical Probe', kind: 'escape', active: false,
    esc: { distAu2026: 117, auPerYear: 2.4, eclLonDeg: 295, eclLatDeg: 14 },
    fact: 'Humanity\'s first visitor to Saturn, now coasting silently toward the constellation Aquila.',
  },
];

// ---------------------------------------------------------------------------
// Position functions (shared by renderer and camera tracker)
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const _helio = new THREE.Vector3();

// Index of each craft within its sibling group (same kind + host), used only
// to de-overlap co-located craft visually. Precomputed so the renderer and
// the camera tracker always agree.
const GROUP_INDEX = new Map<string, number>();
{
  const counters = new Map<string, number>();
  for (const s of SOLAR_SATELLITES) {
    const key = `${s.kind}:${s.planet}`;
    const i = counters.get(key) ?? 0;
    GROUP_INDEX.set(s.name, i);
    counters.set(key, i + 1);
  }
}

/** Scene-space position of a planet at the given simulated time.
 *
 *  Display orbits are perfect circles: the planet rides a circle at its mean
 *  distance (compressed to scene units), in the ecliptic plane. The ANGLE is
 *  the real heliocentric longitude for the date, so positions, seasons and
 *  synodic alignments stay astronomically correct while every orbit renders
 *  as a clean concentric circle. */
export function getPlanetScenePosition(name: string, date: Date, target?: THREE.Vector3): THREE.Vector3 {
  const out = target ?? new THREE.Vector3();
  const planet = PLANET_BY_NAME.get(name);
  const h = getPlanetHeliocentric(name, date);
  if (!planet || !h) return out.set(0, 0, 0);
  const R = auToSceneRadius(planet.orbitAu);
  return out.set(R * Math.cos(h.lon), 0, -R * Math.sin(h.lon));
}

/** Deterministic per-name phase offset (radians) for bodies whose epoch phase is unknown. */
function namePhase(name: string): number {
  let acc = 0;
  for (let i = 0; i < name.length; i++) acc = (acc * 31 + name.charCodeAt(i)) % 100000;
  return (acc % 360) * DEG;
}

/** Moon position relative to its planet, scene units. Earth's Moon uses the real ephemeris. */
export function getMoonLocalPosition(
  planet: PlanetInfo, moon: MoonInfo, date: Date, target?: THREE.Vector3
): THREE.Vector3 {
  const out = target ?? new THREE.Vector3();
  const orbitR = moonOrbitSceneRadius(planet, moon);

  if (planet.name === 'Earth' && moon.name === 'Moon') {
    const { lon, lat } = getMoonGeocentric(date);
    // Ecliptic direction -> scene (Y up)
    return out.set(
      orbitR * Math.cos(lat) * Math.cos(lon),
      orbitR * Math.sin(lat),
      -orbitR * Math.cos(lat) * Math.sin(lon)
    );
  }

  const n = daysSinceJ2000(date);
  const dir = Math.sign(moon.periodDays) || 1;
  const theta = namePhase(moon.name) + dir * (2 * Math.PI * (n / Math.abs(moon.periodDays)));
  return out.set(orbitR * Math.cos(theta), 0, -orbitR * Math.sin(theta));
}

/** Local orbit radius (scene units) for a probe orbiting a planet. The
 *  de-overlap spacing scales with the planet's (true-scale, tiny) radius. */
export function probeOrbitSceneRadius(planet: PlanetInfo, sat: SolarSat, idx = 0): number {
  const altRatio = Math.min(3, (sat.orbitAltKm ?? 500) / planet.radiusKm);
  return planet.sceneRadius * (1.25 + 0.5 * Math.sqrt(altRatio) + idx * 0.25);
}

/** Real orbital period (days) for a circular orbit at rKm around body with GM mu. */
function circularPeriodDays(mu: number, rKm: number): number {
  return (2 * Math.PI * Math.sqrt((rKm * rKm * rKm) / mu)) / 86400;
}

/** World scene-space position of any catalog spacecraft at the simulated time. */
export function getSolarSatScenePosition(
  sat: SolarSat, date: Date, target?: THREE.Vector3
): THREE.Vector3 {
  const out = target ?? new THREE.Vector3();
  const n = daysSinceJ2000(date);
  const idx = GROUP_INDEX.get(sat.name) ?? 0;

  switch (sat.kind) {
    case 'orbiter': {
      const planet = PLANET_BY_NAME.get(sat.planet);
      if (!planet) return out.set(0, 0, 0);
      getPlanetScenePosition(planet.name, date, out);
      const r = probeOrbitSceneRadius(planet, sat, idx);
      const mu = GM[planet.name] ?? 398600;
      const period = circularPeriodDays(mu, planet.radiusKm + (sat.orbitAltKm ?? 500));
      const theta = namePhase(sat.name) + 2 * Math.PI * (n / period);
      const inc = (sat.inclinationDeg ?? 20) * DEG;
      // Circular inclined orbit around the planet
      const lx = r * Math.cos(theta);
      const lz = -r * Math.sin(theta) * Math.cos(inc);
      const ly = r * Math.sin(theta) * Math.sin(inc);
      return out.add(_helio.set(lx, ly, lz));
    }

    case 'moon-orbiter': {
      const earth = PLANET_BY_NAME.get('Earth')!;
      const moon = earth.moons[0];
      getPlanetScenePosition('Earth', date, out);
      out.add(getMoonLocalPosition(earth, moon, date, _helio));
      const mR = moonSceneRadius(earth, moon);
      const mu = GM.Moon;
      const period = circularPeriodDays(mu, 1737 + (sat.orbitAltKm ?? 100));
      const theta = namePhase(sat.name) + 2 * Math.PI * (n / period);
      const r = mR * (1.6 + idx * 0.35);
      const inc = (sat.inclinationDeg ?? 90) * DEG;
      return out.add(_helio.set(
        r * Math.cos(theta),
        r * Math.sin(theta) * Math.sin(inc),
        -r * Math.sin(theta) * Math.cos(inc)
      ));
    }

    case 'l1':
    case 'l2': {
      // Ride with Earth on its circular display orbit, offset radially
      // sunward (L1) or anti-sunward (L2), just beyond the Moon's display orbit.
      getPlanetScenePosition('Earth', date, out);
      const len = out.length() || 1;
      // Just beyond the Moon's display orbit (~0.088), clearly off the globe
      const offset = sat.kind === 'l1' ? -0.12 : 0.12;
      out.multiplyScalar((len + offset) / len);
      // Halo-orbit wobble so co-located craft don't overlap
      const wob = 0.012 + idx * 0.006;
      const wt = namePhase(sat.name) + 2 * Math.PI * (n / 178); // ~6-month halo period
      return out.add(_helio.set(wob * Math.cos(wt), wob * 0.5 * Math.sin(wt), wob * Math.sin(wt)));
    }

    case 'heliocentric': {
      const el = sat.helio!;
      const M = namePhase(sat.name) + 2 * Math.PI * (n / el.periodDays);
      const E = solveKepler(M, el.e);
      const xp = el.aAu * (Math.cos(E) - el.e);
      const yp = el.aAu * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
      const lon0 = el.lon0Deg * DEG;
      const x = xp * Math.cos(lon0) - yp * Math.sin(lon0);
      const y = xp * Math.sin(lon0) + yp * Math.cos(lon0);
      return eclipticToScene(x, y, 0, out);
    }

    case 'cruise': {
      const c = sat.cruise!;
      const t = Math.min(1, Math.max(0, (date.getTime() - c.departMs) / (c.arriveMs - c.departMs)));
      const from = getPlanetScenePosition(c.from, date, _helio);
      getPlanetScenePosition(c.to, date, out);
      // Ease along an arc between the two bodies, lifted slightly off the plane
      out.lerpVectors(from, out, t);
      out.y += 0.15 * Math.sin(Math.PI * t);
      return out;
    }

    case 'escape': {
      const e = sat.esc!;
      const years = (date.getTime() - Y(2026)) / (365.25 * 86400000);
      const distAu = Math.max(1.5, e.distAu2026 + e.auPerYear * years);
      const lon = e.eclLonDeg * DEG;
      const lat = e.eclLatDeg * DEG;
      return eclipticToScene(
        distAu * Math.cos(lat) * Math.cos(lon),
        distAu * Math.cos(lat) * Math.sin(lon),
        distAu * Math.sin(lat),
        out
      );
    }
  }
}

/** Spacecraft grouped by the planet they belong to (for rendering). */
export function probesOfPlanet(planetName: string): SolarSat[] {
  return SOLAR_SATELLITES.filter(
    (s) => s.planet === planetName && (s.kind === 'orbiter' || s.kind === 'moon-orbiter')
  );
}

/** UTC ms when the craft launched (Jan 1 of launch year). */
export function solarSatLaunchMs(sat: SolarSat): number {
  const yr = parseInt(sat.launchYear, 10);
  return isNaN(yr) ? 0 : Date.UTC(yr, 0, 1);
}

/** True if the craft existed at the simulated date (time-travel filter). */
export function solarSatVisibleAt(sat: SolarSat, date: Date): boolean {
  return date.getTime() >= solarSatLaunchMs(sat);
}

/** A clicked planet or moon in the Solar System view. */
export interface SelectedBody {
  kind: 'planet' | 'moon';
  planet: PlanetInfo;
  moon?: MoonInfo;
}

const _local = new THREE.Vector3();

/** World scene-space position of a selected planet/moon. */
export function getBodyScenePosition(body: SelectedBody, date: Date, target?: THREE.Vector3): THREE.Vector3 {
  const out = target ?? new THREE.Vector3();
  getPlanetScenePosition(body.planet.name, date, out);
  if (body.kind === 'moon' && body.moon) {
    out.add(getMoonLocalPosition(body.planet, body.moon, date, _local));
  }
  return out;
}

/** Display radius (scene units) of a selected body — used for camera limits. */
export function getBodySceneRadius(body: SelectedBody): number {
  if (body.kind === 'moon' && body.moon) return moonSceneRadius(body.planet, body.moon);
  return body.planet.sceneRadius;
}
