// Per-view display settings. Earth view and Solar System view each keep their
// own independent copy — changing warp speed or toggles in one view never
// affects the other.

export interface EarthSettings {
  showClouds: boolean;
  showAtmosphere: boolean;
  showNightLights: boolean;
  showOrbitPath: boolean;
  showCoverage: boolean;
  showConstellations: boolean;
  enableMovement: boolean;
  /** Locked to the real wall clock. Warp/time-travel turns this off. */
  realTime: boolean;
  timeSpeed: number;
}

export interface SolarSettings {
  showOrbits: boolean;
  showMoons: boolean;
  showMoonOrbits: boolean;
  showProbes: boolean;
  showEarthSats: boolean;
  enableMovement: boolean;
  /** Locked to the real wall clock. Warp/time-travel turns this off. */
  realTime: boolean;
  timeSpeed: number;
}

export const DEFAULT_EARTH_SETTINGS: EarthSettings = {
  showClouds: true,
  showAtmosphere: true,
  showNightLights: true,
  showOrbitPath: true,
  showCoverage: true,
  showConstellations: false,
  enableMovement: true,
  realTime: true,
  timeSpeed: 1,
};

export const DEFAULT_SOLAR_SETTINGS: SolarSettings = {
  showOrbits: true,
  showMoons: true,
  showMoonOrbits: true,
  showProbes: true,
  showEarthSats: true,
  enableMovement: true,
  realTime: true,
  timeSpeed: 1, // real astronomical time by default
};

/** Warp presets. Earth view stays in satellite-friendly ranges; the Solar
 *  System view offers day/month/year scale warps. */
export const EARTH_SPEED_PRESETS = [1, 10, 60, 300, 1800, 3600] as const;
export const SOLAR_SPEED_PRESETS = [1, 3600, 86400, 604800, 2592000, 31536000] as const;

export function formatSpeed(speed: number): string {
  const abs = Math.abs(speed);
  let label: string;
  if (abs < 60) label = abs === 1 ? '1x' : `${abs}x`;
  else if (abs < 3600) label = `${Math.round(abs / 60)}m/s`;
  else if (abs < 86400) label = `${Math.round(abs / 3600)}h/s`;
  else if (abs < 2592000) label = `${Math.round(abs / 86400)}d/s`;
  else if (abs < 31536000) label = `${Math.round(abs / 2592000)}mo/s`;
  else label = `${Math.round(abs / 31536000)}y/s`;
  return speed < 0 ? `-${label}` : label;
}
