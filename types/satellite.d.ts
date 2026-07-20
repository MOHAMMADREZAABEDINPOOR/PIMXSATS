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

    export function twoline2satrec(line1: string, line2: string): SatRec;
    export function propagate(satrec: SatRec, date: Date): PositionAndVelocity;
    /** Raw SGP4: minutes since the TLE epoch (may be negative). */
    export function sgp4(satrec: SatRec, tsinceMinutes: number): PositionAndVelocity;
    export function gstime(date: Date): number;
    export function eciToGeodetic(eci: EciVec3<number>, gmst: number): GeodeticLocation;
    export function degreesLat(radians: number): number;
    export function degreesLong(radians: number): number;
}
