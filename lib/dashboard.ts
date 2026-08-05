// Space situational awareness — the state of orbit, as one page of numbers.
//
// Every other view in the app answers a question about ONE object. This answers
// questions about the population: how crowded is LEO, how much of what's up
// there is junk, who owns the sky, and which shell is filling up fastest. The
// same TLE set that drives the 3D scene already carries all of it — nothing
// here needs a network call.
//
// All of it is derived in a single pass over the catalog, because the catalog is
// ~15,000 objects and the panel re-renders on filter changes. One pass, plain
// arithmetic, no propagation: the summary is a property of the orbital
// elements, not of where anything happens to be right now.

import type { SatData, OrbitBand } from './satellite';

const MU = 398600.4418; // km^3/s^2
const R_EARTH = 6371;

/** Debris and spent hardware, by the naming conventions the public catalog
 *  actually uses. Not exhaustive — nothing public is — but it captures the
 *  bulk of non-functional mass. */
const JUNK_PATTERNS = [
  /\bDEB\b/i, /DEBRIS/i, /\bR\/B\b/i, /ROCKET BODY/i,
  /\bAKM\b/i, /\bPKM\b/i, /COOLANT/i, /SHROUD/i, /FRAGMENT/i,
];

export interface ShellStats {
  band: OrbitBand;
  count: number;
  /** Share of the whole catalog, 0..1. */
  share: number;
  /** Mean altitude across the shell, km. */
  meanAltitudeKm: number;
  /** Debris/rocket-body share within this shell, 0..1. */
  junkShare: number;
}

export interface OwnerStats {
  country: string;
  count: number;
  share: number;
}

export interface DecadeStats {
  /** 1960, 1970, … — the decade's first year. */
  decade: number;
  count: number;
}

export interface AltitudeBin {
  /** Bin's lower edge, km. */
  fromKm: number;
  toKm: number;
  count: number;
}

export interface SituationalSummary {
  total: number;
  /** Objects matching the debris/rocket-body naming conventions. */
  junk: number;
  junkShare: number;
  /** Active-payload estimate: everything that isn't junk. The public catalog
   *  carries no operational-status flag, so this is a floor, not a census. */
  payloads: number;
  shells: ShellStats[];
  /** Owners by object count, busiest first. */
  owners: OwnerStats[];
  /** Launch-decade histogram from the international designators. */
  decades: DecadeStats[];
  /** LEO altitude histogram in 100 km bins — where the crowding actually is. */
  leoBins: AltitudeBin[];
  /** The single most crowded 100 km slab of LEO. */
  busiestShellKm: { fromKm: number; toKm: number; count: number } | null;
  /** Mean orbital period across the catalog, minutes. */
  meanPeriodMin: number;
  /** Objects whose mean altitude is under 300 km — decaying within years. */
  decayingSoon: number;
}

function isJunk(name: string): boolean {
  return JUNK_PATTERNS.some((re) => re.test(name));
}

/** Mean altitude from mean motion, km. */
function altitudeKm(no: number): number {
  if (no <= 0) return NaN;
  const periodSec = (2 * Math.PI / no) * 60;
  const a = Math.cbrt(MU * (periodSec / (2 * Math.PI)) ** 2);
  return a - R_EARTH;
}

const LEO_BIN_KM = 100;
const LEO_TOP_KM = 2000;
const OWNER_LIMIT = 8;

/**
 * Everything the dashboard shows, in one pass.
 *
 * Objects with an unusable mean motion are counted in `total` but excluded from
 * altitude-derived figures — dropping them from the total instead would make
 * the shares disagree with the catalog size shown elsewhere in the app.
 */
export function summarize(satellites: SatData[]): SituationalSummary {
  const total = satellites.length;
  let junk = 0;
  let periodSum = 0;
  let periodCount = 0;
  let decayingSoon = 0;

  const bandCount: Record<string, number> = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
  const bandAltSum: Record<string, number> = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
  const bandAltCount: Record<string, number> = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
  const bandJunk: Record<string, number> = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };

  const owners = new Map<string, number>();
  const decades = new Map<number, number>();
  const binCounts = new Array<number>(Math.ceil(LEO_TOP_KM / LEO_BIN_KM)).fill(0);

  for (const sat of satellites) {
    const junkThis = isJunk(sat.name);
    if (junkThis) junk++;

    const band = sat.band;
    bandCount[band] = (bandCount[band] ?? 0) + 1;
    if (junkThis) bandJunk[band] = (bandJunk[band] ?? 0) + 1;

    const no = sat.satrec.no;
    if (no > 0) {
      const periodMin = (2 * Math.PI) / no;
      periodSum += periodMin;
      periodCount++;
      const alt = altitudeKm(no);
      if (Number.isFinite(alt)) {
        bandAltSum[band] += alt;
        bandAltCount[band]++;
        if (alt < 300) decayingSoon++;
        if (alt >= 0 && alt < LEO_TOP_KM) {
          binCounts[Math.floor(alt / LEO_BIN_KM)]++;
        }
      }
    }

    const country = sat.country || 'Unknown';
    owners.set(country, (owners.get(country) ?? 0) + 1);

    const y = sat.launchYear ? parseInt(sat.launchYear, 10) : NaN;
    if (Number.isFinite(y)) {
      const d = Math.floor(y / 10) * 10;
      decades.set(d, (decades.get(d) ?? 0) + 1);
    }
  }

  const bands: OrbitBand[] = ['LEO', 'MEO', 'GEO', 'HEO'];
  const shells: ShellStats[] = bands.map((band) => {
    const count = bandCount[band] ?? 0;
    return {
      band,
      count,
      share: total > 0 ? count / total : 0,
      meanAltitudeKm: bandAltCount[band] > 0 ? bandAltSum[band] / bandAltCount[band] : 0,
      junkShare: count > 0 ? (bandJunk[band] ?? 0) / count : 0,
    };
  });

  const ownerStats: OwnerStats[] = Array.from(owners.entries())
    .map(([country, count]) => ({ country, count, share: total > 0 ? count / total : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, OWNER_LIMIT);

  const decadeStats: DecadeStats[] = Array.from(decades.entries())
    .map(([decade, count]) => ({ decade, count }))
    .sort((a, b) => a.decade - b.decade);

  const leoBins: AltitudeBin[] = binCounts.map((count, i) => ({
    fromKm: i * LEO_BIN_KM,
    toKm: (i + 1) * LEO_BIN_KM,
    count,
  }));

  let busiest: AltitudeBin | null = null;
  for (const bin of leoBins) {
    if (!busiest || bin.count > busiest.count) busiest = bin;
  }

  return {
    total,
    junk,
    junkShare: total > 0 ? junk / total : 0,
    payloads: total - junk,
    shells,
    owners: ownerStats,
    decades: decadeStats,
    leoBins,
    busiestShellKm: busiest && busiest.count > 0
      ? { fromKm: busiest.fromKm, toKm: busiest.toKm, count: busiest.count }
      : null,
    meanPeriodMin: periodCount > 0 ? periodSum / periodCount : 0,
    decayingSoon,
  };
}

/** "12.3%" — shares are displayed, never compared, so one decimal is right. */
export function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}
