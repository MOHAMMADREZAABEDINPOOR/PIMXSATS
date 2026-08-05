// Live radio & SATCOM — what you could actually hear.
//
// A satellite is not just a dot; most of them are transmitters, and a surprising
// number are receivable with hardware people already own (a handheld scanner, an
// RTL-SDR dongle, sometimes a bare handheld radio for the ISS repeater). This
// module pairs catalog objects with their published downlink frequencies and
// modes, and computes the one thing a receiver actually needs that a frequency
// table cannot give you: the Doppler-shifted frequency right now.
//
// Frequencies are the published amateur/space-tracking values. They are stable
// over years but not guaranteed current — the panel says so rather than
// implying a live database.

import * as satellite from 'satellite.js';
import type { SatData } from './satellite';
import type { Observer } from './passes';

export type RadioMode = 'FM' | 'SSB' | 'CW' | 'APT' | 'LRPT' | 'BPSK' | 'AFSK' | 'Digital';

export interface RadioChannel {
  /** Downlink centre frequency, MHz. */
  downlinkMhz: number;
  mode: RadioMode;
  /** What you would hear / decode. */
  label: string;
  /** Receiving hardware needed, in plain terms. */
  gear: string;
}

export interface RadioProfile {
  /** Substring matched case-insensitively against the catalog name. */
  match: string;
  /** Display name for the profile. */
  name: string;
  channels: RadioChannel[];
  /** One line on what this signal is for. */
  note: string;
}

// Ordered from most specific to least: the first match wins, so "ISS (ZARYA)"
// hits the ISS profile and not a generic one.
const PROFILES: RadioProfile[] = [
  {
    match: 'ZARYA',
    name: 'International Space Station',
    note: 'The station carries an amateur radio station and a cross-band FM repeater; SSTV images are transmitted during special events.',
    channels: [
      { downlinkMhz: 145.800, mode: 'FM', label: 'Voice / SSTV downlink', gear: 'Any 2 m handheld radio — no licence needed to listen' },
      { downlinkMhz: 437.800, mode: 'FM', label: 'Cross-band repeater output', gear: '70 cm handheld or SDR' },
      { downlinkMhz: 145.825, mode: 'AFSK', label: 'APRS digipeater', gear: 'SDR plus a soundcard TNC' },
    ],
  },
  {
    match: 'NOAA 15',
    name: 'NOAA 15 weather imager',
    note: 'Continuously transmits analogue weather images of whatever it is flying over — decodable into a picture on a laptop.',
    channels: [
      { downlinkMhz: 137.620, mode: 'APT', label: 'Automatic Picture Transmission', gear: 'RTL-SDR + V-dipole antenna' },
    ],
  },
  {
    match: 'NOAA 18',
    name: 'NOAA 18 weather imager',
    note: 'Same APT downlink as its siblings — point a simple antenna up during a pass and you get your own satellite image.',
    channels: [
      { downlinkMhz: 137.9125, mode: 'APT', label: 'Automatic Picture Transmission', gear: 'RTL-SDR + V-dipole antenna' },
    ],
  },
  {
    match: 'NOAA 19',
    name: 'NOAA 19 weather imager',
    note: 'The youngest of the APT birds and usually the strongest signal of the three.',
    channels: [
      { downlinkMhz: 137.100, mode: 'APT', label: 'Automatic Picture Transmission', gear: 'RTL-SDR + V-dipole antenna' },
    ],
  },
  {
    match: 'METEOR-M',
    name: 'Meteor-M weather imager',
    note: 'Digital successor to APT: higher resolution images at the cost of needing a soft-decoder.',
    channels: [
      { downlinkMhz: 137.100, mode: 'LRPT', label: 'Low Rate Picture Transmission', gear: 'RTL-SDR + turnstile antenna' },
    ],
  },
  {
    match: 'AO-91',
    name: 'AO-91 (RadFxSat)',
    note: 'An FM "easy sat" — one of the simplest satellites in orbit to work with a handheld.',
    channels: [
      { downlinkMhz: 145.960, mode: 'FM', label: 'FM voice transponder downlink', gear: '2 m handheld with a directional antenna' },
    ],
  },
  {
    match: 'SO-50',
    name: 'SO-50 (SaudiSat 1C)',
    note: 'A veteran FM transponder still busy with contacts every pass.',
    channels: [
      { downlinkMhz: 436.795, mode: 'FM', label: 'FM voice transponder downlink', gear: '70 cm handheld with a Yagi' },
    ],
  },
  {
    match: 'FUNCUBE',
    name: 'FUNcube-1 (AO-73)',
    note: 'Educational spacecraft transmitting telemetry designed for school groups to decode.',
    channels: [
      { downlinkMhz: 145.935, mode: 'BPSK', label: 'Telemetry beacon', gear: 'SDR + the FUNcube dashboard' },
      { downlinkMhz: 145.950, mode: 'SSB', label: 'Linear transponder downlink', gear: 'SSB receiver' },
    ],
  },
  {
    match: 'GOES',
    name: 'GOES geostationary imager',
    note: 'Parked over one longitude, so once your dish is aimed it never has to move — full-disc Earth images around the clock.',
    channels: [
      { downlinkMhz: 1694.100, mode: 'Digital', label: 'HRIT full-disc imagery', gear: 'Grid dish + LNA + SDR' },
    ],
  },
  {
    match: 'STARLINK',
    name: 'Starlink user downlink',
    note: 'Ku-band phased-array downlink — far outside consumer receiver range and heavily encrypted; listed for completeness, not as something to tune.',
    channels: [
      { downlinkMhz: 10700, mode: 'Digital', label: 'Ku-band user downlink (not receivable)', gear: 'Not practically receivable' },
    ],
  },
];

/** Radio profile for a catalog object, or null if we have no published data for
 *  it. Most of the catalog is debris and classified payloads, so null is the
 *  normal answer and the UI treats it as such. */
export function radioProfile(sat: SatData): RadioProfile | null {
  const name = sat.name.toUpperCase();
  for (const p of PROFILES) {
    if (name.includes(p.match.toUpperCase())) return p;
  }
  return null;
}

const C_KM_S = 299792.458;

/**
 * Doppler-shifted receive frequency, MHz.
 *
 * A LEO satellite closes at up to ~7 km/s, which shifts 145 MHz by about
 * ±3.4 kHz — more than an FM channel's width, and the reason a beginner hears
 * nothing while pointing at the right frequency. Positive range rate (receding)
 * lowers the frequency.
 */
export function dopplerMhz(
  downlinkMhz: number,
  satrec: satellite.SatRec,
  observer: Observer,
  when: Date
): number | null {
  const pv = satellite.propagate(satrec, when);
  if (!pv || typeof pv.position === 'boolean' || typeof pv.velocity === 'boolean') return null;
  const position = pv.position as satellite.EciVec3<number>;
  const velocity = pv.velocity as satellite.EciVec3<number>;

  const gmst = satellite.gstime(when);
  const observerGd = {
    latitude: satellite.degreesToRadians(observer.lat),
    longitude: satellite.degreesToRadians(observer.lon),
    height: observer.heightKm ?? 0.1,
  };
  const observerEcf = satellite.geodeticToEcf(observerGd);
  const positionEcf = satellite.eciToEcf(position, gmst);
  const velocityEcf = satellite.eciToEcf(velocity, gmst);

  // Range vector observer → satellite, and the component of velocity along it.
  const rx = positionEcf.x - observerEcf.x;
  const ry = positionEcf.y - observerEcf.y;
  const rz = positionEcf.z - observerEcf.z;
  const range = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (range <= 0) return null;

  // The observer's own frame rotates with Earth; eciToEcf on the velocity
  // already accounts for that, so this range rate is what the receiver sees.
  const rangeRate = (rx * velocityEcf.x + ry * velocityEcf.y + rz * velocityEcf.z) / range;

  return downlinkMhz * (1 - rangeRate / C_KM_S);
}

/** "145.8034 MHz" — four decimals is 100 Hz, the resolution that matters for
 *  tuning a narrowband signal. */
export function formatMhz(mhz: number): string {
  return `${mhz.toFixed(4)} MHz`;
}

/** Shift from nominal, in kHz — the figure an operator actually dials in. */
export function formatShift(nominalMhz: number, shiftedMhz: number): string {
  const khz = (shiftedMhz - nominalMhz) * 1000;
  const sign = khz >= 0 ? '+' : '';
  return `${sign}${khz.toFixed(2)} kHz`;
}
