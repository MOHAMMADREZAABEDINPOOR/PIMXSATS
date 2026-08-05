declare module 'satellite.js' {
    export interface SatRec {
        error: number;
        satnum: string;
        epochyr: number;
        epochdays: number;
        /** Julian date of the TLE epoch */
        jdsatepoch: number;
        ndot: number;
        nddot: number;
        bstar: number;
        inclo: number;
        nodeo: number;
        ecco: number;
        argpo: number;
        mo: number;
        no: number;

        // --- Initialised secular rates -------------------------------------
        // Written by twoline2satrec's sgp4init, not present in the TLE itself.
        // Useful for advancing an orbit plane without propagating it: a fixed
        // orbit normal is ~1400 km wrong after three days, and these two terms
        // bring that down to single-digit km.

        /** dΩ/dt — secular RAAN rate (nodal regression), rad/min. */
        nodedot: number;
        /** Drag-coupled quadratic RAAN term, rad/min². */
        nodecf: number;
        /** Which SGP4 branch was selected: 'n' near-Earth, 'd' deep-space.
         *  Deep-space planes are moved by luni-solar terms the two terms above
         *  do not describe. */
        method: 'n' | 'd';
    }

    export interface EciVec3<T> {
        x: T;
        y: T;
        z: T;
    }

    export interface PositionAndVelocity {
        position: EciVec3<number> | boolean;
        velocity: EciVec3<number> | boolean;
    }

    export interface GeodeticLocation {
        longitude: number;
        latitude: number;
        height: number;
    }

    /** Earth-centred, Earth-fixed cartesian position (km). */
    export interface EcfVec3<T> {
        x: T;
        y: T;
        z: T;
    }

    /** Topocentric look angles from an observer to a satellite. */
    export interface LookAngles {
        /** Compass bearing, radians clockwise from north. */
        azimuth: number;
        /** Angle above the local horizon, radians. */
        elevation: number;
        /** Slant range, km. */
        rangeSat: number;
    }

    export function twoline2satrec(line1: string, line2: string): SatRec;
    export function propagate(satrec: SatRec, date: Date): PositionAndVelocity;
    /** Raw SGP4: minutes since the TLE epoch (may be negative). */
    export function sgp4(satrec: SatRec, tsinceMinutes: number): PositionAndVelocity;
    export function gstime(date: Date): number;
    export function eciToGeodetic(eci: EciVec3<number>, gmst: number): GeodeticLocation;
    export function degreesLat(radians: number): number;
    export function degreesLong(radians: number): number;
    export function degreesToRadians(degrees: number): number;
    export function radiansToDegrees(radians: number): number;
    export function eciToEcf(eci: EciVec3<number>, gmst: number): EcfVec3<number>;
    export function ecfToEci(ecf: EcfVec3<number>, gmst: number): EciVec3<number>;
    export function geodeticToEcf(geodetic: GeodeticLocation): EcfVec3<number>;
    export function ecfToLookAngles(
        observerGeodetic: GeodeticLocation,
        satelliteEcf: EcfVec3<number>
    ): LookAngles;
}
