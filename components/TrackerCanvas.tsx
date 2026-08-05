'use client';

/* eslint-disable react-hooks/immutability -- react-three-fiber renders by
   mutating three.js objects (camera, materials) inside useFrame; that is the
   library's intended imperative API, not a React render-phase mutation. */

import { Canvas, useFrame, useThree, useLoader, type ThreeEvent } from '@react-three/fiber';
import { Stars, Line, Html } from '@react-three/drei';
import { CameraControls } from './CameraControls';
import { Earth } from './Earth';
import { Satellites } from './Satellites';

import { SolarSystemView } from './SolarSystemView';
import { SatelliteModel } from './SatelliteModel';
import {
  SatData, ScenePos, getOrbitEllipseFromSceneState, getSceneAnchor,
  getScenePositionCached, PROP_FAILED,
} from '@/lib/satellite';
import {
  SolarSat, SelectedBody, PLANETS, PLANET_BY_NAME, SUN_SCENE_RADIUS,
  getSolarSatScenePosition, getPlanetScenePosition, getMoonLocalPosition,
  getBodyScenePosition, getBodySceneRadius, earthSatSceneFactor, moonSceneRadius,
} from '@/lib/solar-system';
import { EarthSettings, SolarSettings } from '@/lib/settings';
import { getSunSceneDirection, getMoonGeocentric } from '@/lib/astronomy';
import { Sensitivity } from '@/lib/interaction';
import { useTapTracking, wasTap } from '@/lib/tap-gesture';
import type { SmoothControls } from '@/lib/orbit-controls';
import { TOUR_STOPS, TourStop, tourStandoff } from '@/lib/tour';
import * as THREE from 'three';
import { useState, useRef, useMemo, useEffect, useCallback, Suspense } from 'react';

/** Grabs a PNG data URL of the current frame. Null when capture is blocked. */
export type CaptureFn = () => string | null;

interface TrackerCanvasProps {
  satellites: SatData[];
  selectedSat: SatData | null;
  onSelectSat: (sat: SatData | null) => void;
  viewMode: 'earth' | 'solar';
  selectedSolarSat: SolarSat | null;
  onSelectSolarSat: (sat: SolarSat | null) => void;
  selectedBody: SelectedBody | null;
  onSelectBody: (body: SelectedBody | null) => void;
  simulatedTimeRef: React.MutableRefObject<Date>;
  earthSettings: EarthSettings;
  solarSettings: SolarSettings;
  isFocused?: boolean;
  /** Increment to request a LEVEL VIEW camera glide (Earth view only). */
  resetViewNonce?: number;
  /** Camera/gesture sensitivity preset chosen by the user. */
  sensitivity?: Sensitivity;
  /** Cinematic Solar System tour. */
  tourActive?: boolean;
  onTourStopChange?: (stop: (TourStop & { index: number; total: number }) | null) => void;
  onTourFinish?: () => void;
  /** Filled with a frame-capture function while the canvas is mounted. */
  captureRef?: React.MutableRefObject<CaptureFn | null>;
  /** Called once after the scene has painted its first frame. The app uses it
   *  to lift the view-switch loading overlay only when the new world is
   *  actually on screen, not a moment before. */
  onFirstPaint?: () => void;
}

// ---------------------------------------------------------------------------
// Orbit path of the selected satellite.
//
// The ellipse is derived from the SAME cached anchor state the moving dot is
// extrapolated from (getSceneAnchor), so the line passes through the dot's
// position by construction — no stale-baseMs offset. It is rebuilt only when
// the anchor is re-taken (anchorId changes, a few times per minute), never
// per frame, so warp/time-travel can't stall the frame loop.
// ---------------------------------------------------------------------------
const orbitScratch: ScenePos = { x: 0, y: 0, z: 0 };

function OrbitPath({ sat, simulatedTimeRef }: { sat: SatData | null; simulatedTimeRef: React.MutableRefObject<Date> }) {
  const [points, setPoints] = useState<[number, number, number][]>([]);
  const lastAnchorRef = useRef(-1);

  useEffect(() => {
    // New satellite selected: force a rebuild on the next frame.
    lastAnchorRef.current = -1;
    setPoints([]);
  }, [sat]);

  useFrame(() => {
    if (!sat) return;
    const simMs = simulatedTimeRef.current.getTime();
    if (simMs < sat.launchMs) {
      if (points.length) setPoints([]); // not launched yet at this sim time
      lastAnchorRef.current = -1;
      return;
    }
    // Ensure a fresh-enough anchor exists (cheap cache hit almost every frame;
    // a full SGP4 only when the previous anchor aged out), then read it back.
    getScenePositionCached(sat.satrec, simMs, orbitScratch, TRACKED_MAX_AGE_MS);
    const anchor = getSceneAnchor(sat.satrec);
    if (!anchor) return;
    if (anchor.anchorId === lastAnchorRef.current) return; // state unchanged
    lastAnchorRef.current = anchor.anchorId;
    const pts = getOrbitEllipseFromSceneState(anchor, 256);
    if (pts) setPoints(pts);
  });

  if (!sat || points.length === 0) return null;

  return <Line points={points} color={sat.color} lineWidth={1.5} transparent opacity={0.6} />;
}

// ---------------------------------------------------------------------------
// Selected satellite: detailed model + coverage footprint.
//
// The coverage cone and footprint ring use FIXED unit geometry created once;
// every frame only their position/quaternion/scale are updated imperatively.
// No geometry rebuilds, no React state, no allocations in the frame loop —
// this is what makes the coverage stable (no flicker) and cheap.
// ---------------------------------------------------------------------------
const UP = new THREE.Vector3(0, 1, 0);

// Shared output slot for cached propagation calls (frame loops are
// synchronous — every caller consumes the values before the next call).
const propScratch: ScenePos = { x: 0, y: 0, z: 0 };
// The tracked/selected satellite re-anchors its propagation cache at least
// every 5 s of simulated time: in focus mode the camera can sit ~15 km away,
// where the ~5 km re-anchor correction of the default accuracy window would
// read as a visible hop — after 5 s the correction is meters, invisible.
const TRACKED_MAX_AGE_MS = 5000;

function SelectedSatellite({
  sat, simulatedTimeRef, showCoverage,
}: {
  sat: SatData;
  simulatedTimeRef: React.MutableRefObject<Date>;
  showCoverage: boolean;
}) {
  const rootRef = useRef<THREE.Group>(null);
  const modelRef = useRef<THREE.Group>(null);
  const coneRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.LineLoop>(null);
  const dirScratch = useMemo(() => new THREE.Vector3(), []);

  // Unit footprint circle (radius 1, XZ plane) — scaled per frame
  const ringGeometry = useMemo(() => {
    const SEGMENTS = 256;
    const positions = new Float32Array(SEGMENTS * 3);
    for (let i = 0; i < SEGMENTS; i++) {
      const phi = (i / SEGMENTS) * Math.PI * 2;
      positions[i * 3] = Math.cos(phi);
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = Math.sin(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geo;
  }, []);
  useEffect(() => () => ringGeometry.dispose(), [ringGeometry]);

  useFrame(() => {
    const root = rootRef.current;
    if (!root) return;

    const nowMs = simulatedTimeRef.current.getTime();
    const alive = nowMs >= sat.launchMs &&
      getScenePositionCached(sat.satrec, nowMs, propScratch, TRACKED_MAX_AGE_MS) !== PROP_FAILED;
    if (!alive) {
      root.visible = false;
      return;
    }
    const p = propScratch;
    root.visible = true;

    if (modelRef.current) modelRef.current.position.set(p.x, p.y, p.z);

    const cone = coneRef.current;
    const ring = ringRef.current;
    if (!cone || !ring) return;

    const d = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
    const coverageOn = showCoverage && d > 1.002;
    cone.visible = coverageOn;
    ring.visible = coverageOn;
    if (!coverageOn) return;

    // Horizon geometry: footprint circle at angular radius θ = acos(1/d).
    // Everything that touches the surface is pushed onto a shell slightly
    // above the globe (LIFT): a rim resting exactly on the sphere grazes it
    // at a near-zero angle and shimmers/jitters along the circle edge as the
    // satellite moves. On the lifted shell the cone rim and the ring
    // coincide, ~25 km clear of the surface — no depth fighting possible.
    const LIFT = 1.004;
    const cosT = 1 / d;
    const sinT = Math.sin(Math.acos(Math.min(1, cosT)));
    const baseR = cosT * LIFT; // footprint plane distance, on the lifted shell
    const height = d - baseR;  // apex stays exactly at the satellite

    dirScratch.set(p.x / d, p.y / d, p.z / d);

    // Cone: unit cone scaled to (sinT·LIFT, height, sinT·LIFT), centered
    // between the satellite and the lifted footprint plane, axis radial.
    cone.quaternion.setFromUnitVectors(UP, dirScratch);
    cone.position.copy(dirScratch).multiplyScalar(baseR + height / 2);
    cone.scale.set(sinT * LIFT, height, sinT * LIFT);

    // Ring: unit circle on the same lifted shell, exactly on the cone rim.
    ring.quaternion.copy(cone.quaternion);
    ring.position.copy(dirScratch).multiplyScalar(baseR);
    ring.scale.set(sinT * LIFT, 1, sinT * LIFT);

    const altitudeKm = (d - 1) * 6371;
    (cone.material as THREE.MeshBasicMaterial).opacity =
      Math.max(0.08, Math.min(0.3, 1.0 / (altitudeKm / 800)));
  });

  return (
    <group ref={rootRef}>
      <group ref={modelRef}>
        <SatelliteModel category={sat.category} color={sat.color} />
      </group>

      {/* Horizon cone — unit geometry, transformed imperatively */}
      <mesh ref={coneRef} renderOrder={2} visible={false}>
        <coneGeometry args={[1, 1, 48, 1, true]} />
        <meshBasicMaterial
          color={sat.color}
          transparent
          opacity={0.2}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>

      {/* Footprint boundary — native line loop, no per-frame rebuilds */}
      <lineLoop ref={ringRef} geometry={ringGeometry} renderOrder={3} visible={false}>
        <lineBasicMaterial color={sat.color} transparent opacity={0.85} depthWrite={false} />
      </lineLoop>
    </group>
  );
}

// Sun light matching the real solar direction (Earth view)
function DynamicSunLight({ simulatedTimeRef }: { simulatedTimeRef: React.MutableRefObject<Date> }) {
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const scratch = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    if (!lightRef.current) return;
    getSunSceneDirection(simulatedTimeRef.current, scratch);
    lightRef.current.position.copy(scratch.multiplyScalar(10));
  });

  return <directionalLight ref={lightRef} intensity={2.5} color="#ffffff" />;
}

// ---------------------------------------------------------------------------
// Camera rig.
//
// Unfocused Earth view: rotation is completely free. No auto-leveling, no
// angle clamps, no forced up-vector — the camera can tilt over the poles and
// roll to any orientation; only the collision guard (camera never inside the
// globe) constrains the pose.
//
// Focused on a satellite / probe / body: the camera is carried by the RIGID
// MOTION of the object around its host — rotated about the host center by the
// same angular step the object moved each frame (plus its radial drift). The
// viewing geometry the user picks stays fixed relative to the orbit, i.e. the
// camera keeps seeing the object from the same side of its path all the way
// around, so the host planet can never slide between camera and object.
// TrackballControls stays fully live on top — rotation and zoom are
// completely UNRESTRICTED — and a position-only collision guard keeps the
// camera from ever entering a planet.
// ---------------------------------------------------------------------------
const EARTH_MIN_CAM_DIST = 1.06;
// While tracking a satellite the camera may skim much closer to the globe
// (just above the cloud/atmosphere shells) so flying under a LEO bird works.
const EARTH_FOCUS_MIN_CAM_DIST = 1.03;
// Solar view: minimum camera clearance as a multiple of a planet's radius.
// Browsing keeps a wide berth (Saturn's rings); satellite tracking hugs the
// surface, since the Earth swarm sits at 1.02× the planet radius and up.
const PLANET_CLEARANCE = 1.3;
const PLANET_CLEARANCE_TRACKING = 1.02;
// The body you deliberately flew to is the one body you're allowed to get close
// to. Browsing keeps 1.3× so you never blunder into a planet you weren't
// looking at; GO TO PLANET is a request to inspect the surface, so the focused
// body drops to a hair above it. Without this the generic 1.3× berth and the
// focus guard both fired on the same planet and zoom died well short of it.
const BODY_CLEARANCE_FOCUS = 1.05;
// The Earth-view Moon (see MoonNodeEarth) is a solid body the browsing camera
// must not pass through. Its orbit radius and body radius live here so the
// collision guard and the render node cannot drift apart.
const EARTH_VIEW_MOON_ORBIT_R = 4.8;
const EARTH_VIEW_MOON_RADIUS = 0.272;
// --- Near plane -------------------------------------------------------------
// The camera's default near plane. Fine for browsing the whole system, and far
// too coarse up close: see applyNearPlane.
const BASE_NEAR = 0.01;
/** Absolute floor on `near`. Below this the log depth buffer starts to lose
 *  precision on the far end of the solar system. */
const MIN_NEAR = 0.00002;
/** Fraction of the clearance to the nearest surface the near plane may take.
 *  Well under 1 so the plane sits comfortably in front of the geometry rather
 *  than grazing it. */
const NEAR_GAP_FRACTION = 0.35;
// --- Proximity damping ------------------------------------------------------
/** The clearance (camera → nearest surface) at which input damping bottoms out,
 *  as a fraction of that body's radius. The controller eases gestures over
 *  PROGRESSIVE_OCTAVES doublings of clearance above this, so scaling it by the
 *  radius is what makes the deceleration band proportional to the body: hugging
 *  a 3 km moon calms down over metres, approaching Jupiter over thousands of km,
 *  and both feel the same to the hand.
 *
 *  It is also what delivers the Sun rule for free. Near the Sun's surface the
 *  clearance is a rounding error next to 0.05·R_sun, so gestures run at floor
 *  gain — tiny, controllable steps. Retreating to Neptune's orbit the clearance
 *  to the Sun grows by more than three doublings, so the same gesture moves the
 *  camera across the system. No separate distance-to-Sun term is needed. */
const CLEARANCE_FLOOR_FRACTION = 0.05;
// Per-frame rate of the camera glides (LEVEL VIEW straightening, OVERVIEW
// return) — ≈ settles in under half a second.
const LEVEL_RATE = 0.12;
/** Hard cap on the focus approach shot, in frames (≈1.3 s at 60 fps). The shot
 *  normally ends when it converges; this is the backstop for the case where it
 *  never can — chasing an object whose own motion outruns the glide — so a
 *  camera the user is no longer commanding cannot be driven indefinitely. */
const APPROACH_MAX_FRAMES = 80;
/** Per-frame rate at which the pivot walks home after focus is released. Faster
 *  than LEVEL_RATE because nothing is being *animated* here — the camera does not
 *  move at all, only what it is aimed at — so the sooner it is over the sooner the
 *  controls behave normally again. ~0.6 s from a pivot an Earth-radius out. */
const RELEASE_RATE = 0.18;
/**
 * How much closer to a body than to the Sun the camera has to be before that
 * body — rather than the Sun at the origin — is the right thing to orbit.
 *
 * Used to decide where the pivot belongs whenever nothing is focused in the
 * solar view. Being four times closer to Mercury than to the Sun means the
 * camera is *at* Mercury, and the point it swings around should be Mercury's
 * centre; drifting through open space between two orbits it is not at anything,
 * and the Sun is the honest pivot. The test is a pure ratio, so it means the
 * same thing at Mercury and at Neptune.
 */
const PIVOT_BODY_MARGIN = 4;
/**
 * The smallest clearance-to-pivot-distance ratio at which the camera can still
 * be turned, and therefore the condition that says the pivot is in the wrong
 * place. THIS is the "screen is locked" report, and it is arithmetic, not a bug
 * in the input path:
 *
 * rotating sweeps the camera along an arc of length `dist·angle`, and the
 * controller rate-limits that arc to a quarter of the clearance to the nearest
 * surface (ARC_CLEARANCE_FRACTION in lib/orbit-controls.ts) so a swipe cannot
 * fling the camera through a planet it is hugging. Park next to Mercury with
 * the pivot still on the Sun and those two numbers are 0.003 and 1.0 scene
 * units: every frame may turn 0.05°, i.e. nothing. Zooming in is pinned by the
 * collision guard at the same time, so only zoom-out answers — exactly what a
 * lock feels like.
 *
 * No rate-limit tuning can fix that, because the sweep really is violent: 1°
 * around the Sun translates the camera by an Earth radius. The pivot has to be
 * the body the camera is next to, and then the ratio is `gap/(gap+radius)` —
 * 0.23 even resting on the collision guard, so rotation is always usable.
 * 0.15 sits below that and above the values a wrong pivot produces.
 */
const PIVOT_SWING_MIN = 0.15;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Where OVERVIEW puts the camera: a high three-quarter view of the whole
 *  system, aimed at the Sun. Same pose the solar view opens on. */
const SOLAR_HOME_POS = new THREE.Vector3(0, 5, 10);
/**
 * The up vector that pose can actually HOLD — world up with the component along
 * its view ray removed.
 *
 * Not a nicety. SmoothControls re-orthogonalises camera.up against the view
 * direction on every update (see lib/orbit-controls.ts), so a camera looking
 * down on the system from (0, 5, 10) has up ≈ (0, 0.89, −0.45) and can never
 * have up = (0, 1, 0). The glide below used to wait for exactly that, which the
 * controller forbids: the wait never ended, so the glide re-ran every frame and
 * yanked the camera back the instant the user moved it. Pressing OVERVIEW
 * locked the view for the rest of the session.
 *
 * The Earth view's LEVEL VIEW glide tests against world up correctly, and that
 * is what hid this: its destination is ON the equatorial plane, where the view
 * ray is horizontal and the orthogonalised up IS world up.
 */
const SOLAR_HOME_UP = (() => {
  const eye = SOLAR_HOME_POS.clone().normalize(); // the pose looks at the origin
  return WORLD_UP.clone().addScaledVector(eye, -WORLD_UP.dot(eye)).normalize();
})();
/** Hard stop on the OVERVIEW glide, in frames (~1.5 s). The convergence test
 *  above is reachable now, but a camera the user is not commanding must have an
 *  end no matter what: this is the difference between a bug that misbehaves and
 *  one that takes the whole view hostage. */
const SOLAR_RESET_MAX_FRAMES = 90;

function CameraRig({
  selectedSat, selectedSolarSat, selectedBody, simulatedTimeRef, isFocused, viewMode, controlsRef, resetViewNonce,
}: {
  selectedSat: SatData | null;
  selectedSolarSat: SolarSat | null;
  selectedBody: SelectedBody | null;
  simulatedTimeRef: React.MutableRefObject<Date>;
  isFocused: boolean;
  viewMode: 'earth' | 'solar';
  controlsRef: React.MutableRefObject<SmoothControls | null>;
  resetViewNonce: number;
}) {
  const { camera } = useThree();
  const controlsMinDistance = useRef(0);
  const targetScratch = useMemo(() => new THREE.Vector3(), []);
  const centerScratch = useMemo(() => new THREE.Vector3(), []);
  const vecScratch = useMemo(() => new THREE.Vector3(), []);
  const moonScratch = useMemo(() => new THREE.Vector3(), []);
  const pushScratch = useMemo(() => new THREE.Vector3(), []);
  /** Scratch for the grazing slide in pushOutOf: the outward surface normal and
   *  the tangential direction that still makes progress toward the pivot. */
  const normScratch = useMemo(() => new THREE.Vector3(), []);
  const slideScratch = useMemo(() => new THREE.Vector3(), []);
  const eyeScratch = useMemo(() => new THREE.Vector3(), []);
  const relScratch = useMemo(() => new THREE.Vector3(), []);
  /** Clearance from the camera to the nearest body SURFACE, refreshed by
   *  enforceCollisions each frame and consumed by applyNearPlane and by the
   *  controller's proximity damping. */
  const nearestGapRef = useRef(Infinity);
  /** True radius of whichever body produced {@link nearestGapRef}. The damping
   *  band is scaled by it, so approaching a small moon decelerates over a
   *  proportionally small distance instead of over a planet-sized one. */
  const nearestRadiusRef = useRef(0);
  /** World centre of whichever body produced {@link nearestGapRef} — the point
   *  the camera should be orbiting while it is that close to it. See
   *  desiredPivot / PIVOT_SWING_MIN. */
  const nearestCenterRef = useRef(new THREE.Vector3());
  const pivotScratch = useMemo(() => new THREE.Vector3(), []);
  const prevRelScratch = useMemo(() => new THREE.Vector3(), []);
  const newRelScratch = useMemo(() => new THREE.Vector3(), []);
  const quatScratch = useMemo(() => new THREE.Quaternion(), []);
  // Orbit-locked follow camera: each frame the camera is moved by the rigid
  // transform that carried the focused object around its host (rotation about
  // the host center + radial drift), so whatever viewing angle the user has
  // chosen is preserved RELATIVE TO THE ORBIT while the object moves.
  // TrackballControls keeps processing input on top — free rotation and zoom.
  const followRef = useRef({
    prevTarget: new THREE.Vector3(),
    prevCenter: new THREE.Vector3(),
    hasPrev: false,
    approachDir: new THREE.Vector3(), // approach-shot direction (focus start)
  });
  // Focus bookkeeping.
  //
  // There is deliberately NO saved-view / fly-back state here any more. Focusing
  // used to snapshot the camera pose and, when focus ended, glide back to it over
  // ~90 frames — and that glide is what the user experienced as "the screen locks;
  // I move or zoom and it snaps back", because the cancel-on-input test could not
  // win reliably against a fly-back that re-ran every frame. Leaving the camera
  // exactly where the user left it is both simpler and what they expect: focus
  // ends, the camera stops following, and nothing else happens.
  const focusInitRef = useRef(false);
  const prevViewRef = useRef(viewMode);
  /** Frames spent in the focus approach shot, so it can never outstay its welcome. */
  const approachFramesRef = useRef(0);
  /**
   * Set the moment focus ends: the PIVOT has to come home.
   *
   * Deleting the fly-back was necessary but not sufficient, and this is the other
   * half of the same report ("I drop focus / close the planet / deselect and the
   * screen is still locked"). While focused, `controls.target` is glued to the
   * object every single frame. Nothing ever moved it back, so afterwards the
   * trackball was still orbiting a point sitting ON a surface:
   *
   *   • rotating swung the camera around a pivot 1.07 Earth-radii out, which puts
   *     most of that little sphere INSIDE the globe — every frame the collision
   *     guard shoved it back out, so the view juddered and went nowhere;
   *   • zooming in aimed at that same point, so it hit the guard immediately and
   *     did nothing at all.
   *
   * Nothing was "locking" the camera: the pivot was simply in a place where there
   * is no room to move. So on release the pivot walks to the point the camera can
   * actually swing around — the globe's centre in the Earth view, and in the solar
   * view the body it was just following rather than the Sun eight AU behind it
   * (see desiredPivot; aiming at the Sun from a planet's doorstep is the SAME bug
   * one step removed). The camera POSITION is left exactly where the user left it.
   * It always runs to completion; bailing out on a gesture would leave the pivot on
   * the surface, which is the bug itself.
   */
  const releasePivotRef = useRef(false);
  // LEVEL VIEW: glide back to an upright equatorial pose (Earth view only)
  const levelingRef = useRef(false);
  // OVERVIEW: glide back to the default whole-system pose (Solar view only)
  const solarResetRef = useRef(false);
  /** Frames the current OVERVIEW glide has run, against SOLAR_RESET_MAX_FRAMES. */
  const solarResetFramesRef = useRef(0);
  const prevResetNonceRef = useRef(resetViewNonce);

  // A reset request wins over everything: it is the user's escape hatch. It works
  // while focused too (the app drops focus in the same commit, and this effect's
  // isFocused dependency means it re-runs already unfocused).
  useEffect(() => {
    if (resetViewNonce !== prevResetNonceRef.current) {
      prevResetNonceRef.current = resetViewNonce;
      if (isFocused) return;
      if (viewMode === 'earth') levelingRef.current = true;
      else { solarResetRef.current = true; solarResetFramesRef.current = 0; }
    }
  }, [resetViewNonce, viewMode, isFocused]);

  // Reposition when switching views
  useEffect(() => {
    if (prevViewRef.current !== viewMode) {
      prevViewRef.current = viewMode;
      focusInitRef.current = false;
      levelingRef.current = false;
      solarResetRef.current = false;
      solarResetFramesRef.current = 0;
      releasePivotRef.current = false;
      if (viewMode === 'earth') camera.position.set(0, 0, 3);
      else camera.position.set(0, 5, 10);
      if (controlsRef.current) {
        controlsRef.current.target.set(0, 0, 0);
        controlsRef.current.update();
      }
    }
  }, [viewMode, camera, controlsRef]);

  // Focus transitions
  useEffect(() => {
    followRef.current.hasPrev = false;
    if (isFocused) {
      // Flying to something cancels an in-flight home glide — but LOSING focus
      // must not, because pressing the reset button is one of the ways focus is
      // lost. This effect runs after the reset-nonce effect in the same commit,
      // so clearing the flag unconditionally here used to swallow the request.
      levelingRef.current = false;
      focusInitRef.current = true;
      approachFramesRef.current = 0;
      releasePivotRef.current = false;
    } else {
      // Focus ended: stop driving the camera and hand it back untouched — except
      // for the pivot, which cannot stay welded to a surface. See releasePivotRef.
      focusInitRef.current = false;
      releasePivotRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused]);

  /** Current world position + body radius of whatever is focused, plus the
   *  center of the body it moves around (used for the perpendicular lock:
   *  the camera sits on the center→object line, outside the object). */
  const getFocusTarget = (): { pos: THREE.Vector3; bodyRadius: number; center: THREE.Vector3 } | null => {
    const t = simulatedTimeRef.current;
    if (viewMode === 'earth') {
      if (selectedSat) {
        if (t.getTime() < selectedSat.launchMs) return null;
        if (getScenePositionCached(selectedSat.satrec, t.getTime(), propScratch, TRACKED_MAX_AGE_MS) === PROP_FAILED) return null;
        return {
          pos: targetScratch.set(propScratch.x, propScratch.y, propScratch.z),
          bodyRadius: 0,
          center: centerScratch.set(0, 0, 0), // Earth center
        };
      }
    }
    if (viewMode === 'solar') {
      if (selectedSat) {
        // Earth satellite selected from the solar-view swarm: same compressed
        // radial mapping EarthSwarm uses to place the dot.
        if (t.getTime() < selectedSat.launchMs) return null;
        if (getScenePositionCached(selectedSat.satrec, t.getTime(), propScratch, TRACKED_MAX_AGE_MS) === PROP_FAILED) return null;
        const p = propScratch;
        const earth = PLANET_BY_NAME.get('Earth')!;
        getPlanetScenePosition('Earth', t, centerScratch);
        const len = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z) || 1;
        const dist = earth.sceneRadius * earthSatSceneFactor(len * 6371);
        targetScratch
          .set((p.x / len) * dist, (p.y / len) * dist, (p.z / len) * dist)
          .add(centerScratch);
        return { pos: targetScratch, bodyRadius: 0, center: centerScratch };
      }
      if (selectedSolarSat) {
        const pos = getSolarSatScenePosition(selectedSolarSat, t, targetScratch);
        // Host center: planet for orbiters, the Moon for lunar orbiters,
        // the Sun for everything else
        if (selectedSolarSat.kind === 'moon-orbiter') {
          const earth = PLANET_BY_NAME.get('Earth')!;
          getPlanetScenePosition('Earth', t, centerScratch);
          centerScratch.add(getMoonLocalPosition(earth, earth.moons[0], t, vecScratch));
        } else if (selectedSolarSat.kind === 'orbiter') {
          getPlanetScenePosition(selectedSolarSat.planet, t, centerScratch);
        } else {
          centerScratch.set(0, 0, 0);
        }
        return { pos, bodyRadius: 0, center: centerScratch };
      }
      if (selectedBody) {
        const pos = getBodyScenePosition(selectedBody, t, targetScratch);
        // A moon circles its planet; a planet circles the Sun
        if (selectedBody.kind === 'moon') getPlanetScenePosition(selectedBody.planet.name, t, centerScratch);
        else centerScratch.set(0, 0, 0);
        return { pos, bodyRadius: getBodySceneRadius(selectedBody), center: centerScratch };
      }
    }
    return null;
  };

  /** Push the camera radially out of a sphere it has entered, and record how
   *  close its SURFACE now is (used to size the near plane — see applyNearPlane —
   *  and the controller's proximity damping). `surfaceRadius` is the body's true
   *  radius; `minDist` is that radius times whatever clearance applies. */
  const pushOutOf = (center: THREE.Vector3, minDist: number, surfaceRadius: number) => {
    const d = camera.position.distanceTo(center);
    const gap = d - surfaceRadius;
    if (gap < nearestGapRef.current) {
      nearestGapRef.current = gap;
      nearestRadiusRef.current = surfaceRadius;
      nearestCenterRef.current.copy(center);
    }
    if (d >= minDist) return false;
    const penetration = minDist - d;
    if (d < 1e-6) {
      camera.position.copy(center).add(pushScratch.set(0, minDist, 0));
    } else {
      camera.position
        .sub(center)
        .multiplyScalar(minDist / d)
        .add(center);

      // Grazing slide.
      //
      // A body between the camera and the pivot used to be a dead stop: zooming
      // from Earth toward Mars on the far side of the Sun ran the camera into the
      // Sun's guard sphere, and every further notch was cancelled by this push —
      // the zoom simply stopped working, with no indication why.
      //
      // So the blocked RADIAL travel is re-spent TANGENTIALLY, in the direction
      // that still makes progress toward the pivot. The camera skims around the
      // obstacle instead of hitting a wall, which is also how it reads: you slide
      // past the Sun and keep going.
      //
      // Inert while focused on this very body, because then the pivot is its
      // centre and the tangential component is exactly zero — a close approach
      // still settles straight onto the surface.
      const target = controlsRef.current?.target;
      if (target) {
        normScratch.copy(camera.position).sub(center).divideScalar(minDist);
        slideScratch.copy(target).sub(camera.position);
        slideScratch.addScaledVector(normScratch, -slideScratch.dot(normScratch));
        const len = slideScratch.length();
        if (len > 1e-9) {
          camera.position.addScaledVector(slideScratch.divideScalar(len), penetration);
          // The tangential step left the sphere's surface (it is a chord, not an
          // arc), so re-seat on it — otherwise repeated slides would spiral out.
          const after = camera.position.distanceTo(center);
          if (after > 1e-9) {
            camera.position.sub(center).multiplyScalar(minDist / after).add(center);
          }
        }
      }
    }
    // The push moved the camera, so the recorded gap is now the clearance.
    const after = minDist - surfaceRadius;
    if (after < nearestGapRef.current) {
      nearestGapRef.current = after;
      nearestRadiusRef.current = surfaceRadius;
      nearestCenterRef.current.copy(center);
    }
    return true;
  };

  /**
   * Size the near plane to whatever the camera is closest to.
   *
   * This — not the material side, and not the collision guard — is why bodies
   * read as hollow. `near` was pinned at 0.01 scene units, but at the
   * collision floor the clearance to a planet's surface is far smaller than
   * that for most of them: Mercury 0.0032, Mars 0.0044, Venus 0.0078,
   * Earth 0.0082 (see bodyRadiusToScene — the whole system is compressed into
   * a 0.5-radius Sun). The near plane therefore cut through the sphere while
   * the camera was still legitimately outside it, and the front of the planet
   * was clipped away leaving a view of its inner surface: a hollow shell.
   *
   * A logarithmic depth buffer is already enabled, which is what makes a near
   * plane four orders of magnitude smaller than the far plane affordable.
   */
  const applyNearPlane = () => {
    const gap = nearestGapRef.current;
    const want = Number.isFinite(gap)
      ? Math.max(MIN_NEAR, Math.min(BASE_NEAR, gap * NEAR_GAP_FRACTION))
      : BASE_NEAR;
    // Hysteresis: reassigning near every frame would rebuild the projection
    // matrix constantly for sub-pixel gain.
    if (Math.abs(camera.near - want) > want * 0.08) {
      camera.near = want;
      camera.updateProjectionMatrix();
    }
  };

  /** Push the camera out of any body it has entered — the camera must NEVER
   *  be inside a planet, a moon or the Sun, in any mode. When something is
   *  focused, its own radius is enforced too, so zooming onto any object stops
   *  smoothly at its surface instead of clipping in. `tracking` means a
   *  satellite/probe is being followed: clearances shrink so the camera can
   *  skim just above the surface, but never through it. */
  const enforceCollisions = (focusPos?: THREE.Vector3, focusRadius = 0, tracking = false) => {
    nearestGapRef.current = Infinity;
    if (viewMode === 'earth') {
      const minR = tracking ? EARTH_FOCUS_MIN_CAM_DIST : EARTH_MIN_CAM_DIST;
      pushOutOf(centerScratch.set(0, 0, 0), minR, 1);
      // The Moon is a solid body in the Earth view too. It was previously only
      // guarded while focused, so a plain zoom could sail straight through it.
      {
        const { lon, lat } = getMoonGeocentric(simulatedTimeRef.current);
        const orbitR = EARTH_VIEW_MOON_ORBIT_R;
        moonScratch.set(
          orbitR * Math.cos(lat) * Math.cos(lon),
          orbitR * Math.sin(lat),
          -orbitR * Math.cos(lat) * Math.sin(lon)
        );
        pushOutOf(
          moonScratch,
          EARTH_VIEW_MOON_RADIUS * (tracking ? PLANET_CLEARANCE_TRACKING : BODY_CLEARANCE_FOCUS),
          EARTH_VIEW_MOON_RADIUS
        );
      }
      if (focusPos && focusRadius > 0) {
        pushOutOf(focusPos, focusRadius * 1.4, focusRadius);
      }
      applyNearPlane();
      return;
    }
    const t = simulatedTimeRef.current;
    // Sun
    pushOutOf(centerScratch.set(0, 0, 0), SUN_SCENE_RADIUS * 1.25, SUN_SCENE_RADIUS);
    // Planets (rings included for Saturn via the browsing clearance) and every
    // one of their moons. The focused body is exempt from the browsing berth —
    // see BODY_CLEARANCE_FOCUS — but everything else stays a hazard.
    // The guard applies in EVERY mode (focused or not): a plain zoom that
    // never selects anything must still never let the camera cross a surface.
    const clearance = tracking ? PLANET_CLEARANCE_TRACKING : PLANET_CLEARANCE;
    const focusedPlanet =
      focusRadius > 0 && selectedBody?.kind === 'planet' ? selectedBody.planet.name : null;
    const focusedMoon =
      focusRadius > 0 && selectedBody?.kind === 'moon' ? selectedBody.moon?.name ?? null : null;
    for (const planet of PLANETS) {
      getPlanetScenePosition(planet.name, t, vecScratch);
      pushOutOf(
        vecScratch,
        planet.sceneRadius * (planet.name === focusedPlanet ? BODY_CLEARANCE_FOCUS : clearance),
        planet.sceneRadius
      );
      // Moons orbit inside the planet's neighbourhood, so they are only ever a
      // hazard once the camera is already close — but that is exactly where the
      // user zooms, and an unguarded moon was fully enterable.
      for (const moon of planet.moons) {
        getMoonLocalPosition(planet, moon, t, moonScratch).add(vecScratch);
        const r = moonSceneRadius(planet, moon);
        pushOutOf(
          moonScratch,
          r * (moon.name === focusedMoon ? BODY_CLEARANCE_FOCUS : clearance),
          r
        );
      }
    }
    // Focused body last, so its (tighter) floor is the one that wins.
    if (focusPos && focusRadius > 0) {
      pushOutOf(focusPos, focusRadius * BODY_CLEARANCE_FOCUS, focusRadius);
    }
    applyNearPlane();
  };

  /**
   * Where the pivot belongs when nothing is focused.
   *
   * The Earth view has one answer: the globe's centre at the origin, which is
   * both the only body there and always the thing being orbited.
   *
   * The solar view has two, and picking the wrong one is what "the screen is
   * locked" means (see PIVOT_SWING_MIN). Sitting a few radii off a planet, that
   * planet's centre is the only point the camera has room to swing around; out
   * between the orbits it is not next to anything and the Sun is the natural
   * centre of the system. PIVOT_BODY_MARGIN decides which of the two this is,
   * using the body the collision pass measured as nearest last frame.
   *
   * Writes into `out` and returns it.
   */
  const desiredPivot = (out: THREE.Vector3) => {
    if (viewMode === 'earth') return out.set(0, 0, 0);
    if (
      Number.isFinite(nearestGapRef.current) &&
      nearestRadiusRef.current > 0 &&
      camera.position.distanceTo(nearestCenterRef.current) * PIVOT_BODY_MARGIN <
        camera.position.length()
    ) {
      return out.copy(nearestCenterRef.current);
    }
    return out.set(0, 0, 0);
  };

  /**
   * Zoom floor for the controller, computed EXACTLY along the current view ray.
   *
   * `SmoothControls.minDistance` bounds |camera − controls.target|, but what has
   * to be prevented is the camera entering a body — two different quantities
   * whenever the pivot is not at that body's centre, which in the solar view is
   * almost always. The old version published a surface-clearance distance
   * directly as minDistance, so the floor was simply wrong and a pinch could
   * walk the camera through a planet; the collision guard then teleported it
   * back out the following frame, which is the "hollow flash" being reported.
   *
   * Zooming moves the camera along the ray P(d) = target + eyeDir·d. For a body
   * at C with forbidden radius R this gives the quadratic
   *   d² + 2(V·e)d + |V|² − R² ≥ 0,   V = target − C
   * whose roots bracket the segment of the ray inside the sphere. When the
   * camera is currently beyond the far root, that root IS the closest distance
   * it may zoom to. Taking the max over every body gives the true floor, so the
   * controller's own near-floor easing settles the camera onto a surface
   * instead of the guard stopping it dead.
   */
  const computeZoomFloor = (
    controls: SmoothControls,
    focusedPlanet: string | null,
    focusedMoon: string | null,
    tracking: boolean,
  ): number => {
    const dist = camera.position.distanceTo(controls.target);
    if (dist < 1e-9) return 0;
    eyeScratch.copy(camera.position).sub(controls.target).divideScalar(dist);
    let floor = 0;

    const consider = (center: THREE.Vector3, R: number) => {
      relScratch.copy(controls.target).sub(center);
      const b = relScratch.dot(eyeScratch);
      const c = relScratch.lengthSq() - R * R;
      const disc = b * b - c;
      if (disc <= 0) return; // the ray misses this body entirely
      const root = Math.sqrt(disc);
      const far = -b + root;
      // Only a body the camera is currently OUTSIDE of, on the far side, can
      // constrain the zoom. (If it is between the pivot and the body, zooming
      // in moves it away.)
      if (far > floor && dist > far - 1e-9) floor = far;
    };

    const t = simulatedTimeRef.current;
    const clearance = tracking ? PLANET_CLEARANCE_TRACKING : PLANET_CLEARANCE;
    consider(centerScratch.set(0, 0, 0), SUN_SCENE_RADIUS * 1.25);
    for (const planet of PLANETS) {
      getPlanetScenePosition(planet.name, t, vecScratch);
      consider(
        vecScratch,
        planet.sceneRadius * (planet.name === focusedPlanet ? BODY_CLEARANCE_FOCUS : clearance)
      );
      for (const moon of planet.moons) {
        getMoonLocalPosition(planet, moon, t, moonScratch).add(vecScratch);
        const r = moonSceneRadius(planet, moon);
        consider(moonScratch, r * (moon.name === focusedMoon ? BODY_CLEARANCE_FOCUS : clearance));
      }
    }
    return floor;
  };

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    // Solar view: publish the true zoom floor every frame. Written here rather
    // than through the CameraControls prop because it depends on the live camera
    // ray and on planet positions that move with the simulated clock — a prop
    // could only carry a per-render constant, and its own effect would overwrite
    // this the moment any other prop changed.
    if (viewMode === 'solar') {
      // Three distinct camera numbers, each doing one job — conflating them was
      // the "planet-click lock":
      //
      //   minDistance — a HARD stop the camera may never cross.
      //   dampFloor   — a SOFT target used only to ease input near a surface.
      //   zoomScale   — the free space the camera has, so a zoom notch between
      //                 orbits moves a useful absolute distance.
      //
      // The ray-cast floor (computeZoomFloor) is the distance at which the view
      // ray touches a body. FOCUSED, it is both the hard stop (settle onto the
      // thing you flew to) and the ease target. UNFOCUSED it is published ONLY
      // as the soft dampFloor: enforceCollisions() still guarantees the camera
      // never enters a body, so the hard stop stays permissive and the camera
      // is always steerable — while a plain approach to a planet still slows
      // down gracefully instead of slamming or locking.
      const focusedPlanet =
        isFocused && selectedBody?.kind === 'planet' ? selectedBody.planet.name : null;
      const focusedMoon =
        isFocused && selectedBody?.kind === 'moon' ? selectedBody.moon?.name ?? null : null;
      // Tracking a satellite/probe: the tight clearance, so the camera can sit
      // just above the surface with its subject.
      const tracking = isFocused && !selectedBody;
      const floor = computeZoomFloor(controls, focusedPlanet, focusedMoon, tracking);

      const wantMin = isFocused ? Math.max(floor, 0.0005) : 0.0005;
      // Compared against the LIVE value, not a cached one: CameraControls has an
      // effect that reassigns controls.minDistance from its prop whenever any of
      // its deps change, and a cached comparison would then leave the stale prop
      // value in place indefinitely.
      if (Math.abs(wantMin - controls.minDistance) > 1e-7) {
        controlsMinDistance.current = wantMin;
        controls.minDistance = wantMin;
      }
      // Soft ease target: the ray floor even when unfocused, so the last stretch
      // onto a planet decelerates without pinning the camera.
      controls.dampFloor = Math.max(floor, 0.0005);
      // Free space to the nearest surface, refreshed by enforceCollisions last
      // frame. Sizing zoom against this lets crossing between orbits take a
      // handful of notches instead of dozens, while a close approach (where the
      // gap is small) keeps fine multiplicative control.
      const gap = nearestGapRef.current;
      controls.zoomScale = Number.isFinite(gap) && gap > 0 ? gap : 0;

      // Proximity measure for the input damping. The controller used to derive it
      // from the distance to the PIVOT, which in the solar view is unrelated to
      // how close anything actually is: parked next to Earth with the pivot on
      // the Sun, `dist/dampFloor` collapsed to ~0 octaves because the view ray
      // hits the Sun — so every gesture ran at floor gain in wide-open space,
      // which is exactly the "increments get so small it's infuriating" report.
      //
      // Clearance to the nearest SURFACE is the honest measure, and it answers
      // all three complaints with one number: small near any planet or moon,
      // small near the Sun, large out in the open.
      if (Number.isFinite(gap) && gap > 0 && nearestRadiusRef.current > 0) {
        controls.clearance = gap;
        controls.clearanceFloor = Math.max(
          CLEARANCE_FLOOR_FRACTION * nearestRadiusRef.current,
          1e-5
        );
      } else {
        // First frame, before enforceCollisions has measured anything: fall back
        // to the pivot-distance behaviour rather than claiming zero clearance.
        controls.clearance = 0;
        controls.clearanceFloor = 0;
      }
    } else {
      // Earth view: the classic multiplicative feel, no adaptive travel. The
      // pivot here IS the body being orbited, so pivot distance already measures
      // proximity correctly and the clearance path is left switched off.
      controls.dampFloor = 0;
      controls.zoomScale = 0;
      controls.clearance = 0;
      controls.clearanceFloor = 0;
      // The 1.06 hard floor is a distance from the GLOBE CENTRE, but minDistance
      // is measured from the pivot — the two only coincide when the pivot is at
      // the centre. While focus was held the pivot was welded to the satellite,
      // and while the release glide walks it home it is still out there, so
      // publishing 1.06 now would measure the floor from the wrong point and
      // shove the camera outward by up to an Earth radius as the pivot moves.
      // Keep the permissive focused floor until the pivot is actually home;
      // enforceCollisions() is what keeps the camera out of the Earth regardless,
      // and it measures from the centre. Written here rather than left to the
      // CameraControls prop for the same reason as the solar branch above: that
      // effect fires on any prop change and would stomp this.
      const wantMin =
        isFocused || releasePivotRef.current ? 0.002 : EARTH_MIN_CAM_DIST;
      if (Math.abs(wantMin - controls.minDistance) > 1e-7) {
        controlsMinDistance.current = wantMin;
        controls.minDistance = wantMin;
      }
    }

    if (isFocused) {
      const focus = getFocusTarget();
      if (focus) {
        const { pos: targetPos, bodyRadius, center } = focus;
        const F = followRef.current;
        const isBody = bodyRadius > 0;

        if (focusInitRef.current) {
          // Approach shot: glide toward a pose on the (body center → object)
          // line, then hand full control to the user.
          //
          // Two escape hatches, because this glide is the other half of what the
          // user experienced as a lock. It ends the instant a finger or the wheel
          // touches it — a gesture during the approach means "I'll take it from
          // here", not "fight me" — and it cannot outlive its cap even if the
          // convergence test never trips (a moving target it can't catch).
          approachFramesRef.current++;
          if (controls.isUserInteracting() || approachFramesRef.current > APPROACH_MAX_FRAMES) {
            focusInitRef.current = false;
            F.prevTarget.copy(targetPos);
            F.prevCenter.copy(center);
            F.hasPrev = true;
          }
        }

        if (focusInitRef.current) {
          F.approachDir.copy(targetPos).sub(center);
          if (F.approachDir.lengthSq() < 1e-12) F.approachDir.set(0, 0.35, 1);
          F.approachDir.normalize();
          const standoff = isBody
            ? Math.max(bodyRadius * 6, 0.02)
            : viewMode === 'earth' ? 0.25 : selectedSat ? 0.007 : 0.02;
          vecScratch.copy(F.approachDir).multiplyScalar(standoff).add(targetPos);
          camera.position.lerp(vecScratch, 0.09);
          controls.target.lerp(targetPos, 0.12);
          if (camera.position.distanceTo(vecScratch) < Math.max(0.004, standoff * 0.04)) {
            focusInitRef.current = false;
            F.prevTarget.copy(targetPos);
            F.prevCenter.copy(center);
            F.hasPrev = true;
          }
          controls.update();
          // The approach shot used to return without ever running the guard, so
          // a body crossed on the way in was enterable and the near plane kept
          // the browsing value while the camera was already metres from a
          // surface. The standoff itself is outside the focus body, so this
          // only ever corrects bodies passed en route.
          enforceCollisions(targetPos, bodyRadius, !isBody);
        } else {
          // Orbit-locked follow: move the camera by the rigid transform that
          // carried the object around its host this frame — a rotation about
          // the host center matching the object's angular step, plus its
          // radial in/out drift. The camera rides the orbit, so the view
          // stays side-on/perpendicular to the path exactly as the user set
          // it, and the host can never end up between camera and object.
          // User rotation and zoom go through the trackball with NO
          // restrictions — no angle clamps, no pose overwrite — so orbiting
          // all the way around the object (and over its poles) is seamless.
          if (F.hasPrev) {
            prevRelScratch.copy(F.prevTarget).sub(F.prevCenter);
            newRelScratch.copy(targetPos).sub(center);
            const prevLen = prevRelScratch.length();
            const newLen = newRelScratch.length();
            if (prevLen > 1e-9 && newLen > 1e-9) {
              prevRelScratch.divideScalar(prevLen);
              newRelScratch.divideScalar(newLen);
              quatScratch.setFromUnitVectors(prevRelScratch, newRelScratch);
              camera.position.sub(F.prevCenter).applyQuaternion(quatScratch);
              camera.up.applyQuaternion(quatScratch).normalize();
              camera.position.addScaledVector(newRelScratch, newLen - prevLen).add(center);
            } else {
              camera.position.add(vecScratch.copy(targetPos).sub(F.prevTarget));
            }
          }
          F.prevTarget.copy(targetPos);
          F.prevCenter.copy(center);
          F.hasPrev = true;
          controls.target.copy(targetPos);
          controls.update();
          // The camera may never enter a body: a focused planet/moon stops
          // the zoom at its surface; while tracking satellites/probes the
          // clearance is tight so the camera can skim just above the ground
          // — but never through it.
          enforceCollisions(targetPos, bodyRadius, !isBody);
        }
        return;
      }
    }

    // No post-focus fly-back. Dropping focus leaves the camera exactly where the
    // user left it — see the note on focusInitRef for why the old glide back to
    // the pre-focus pose was removed rather than repaired.
    //
    // What DOES have to be undone is the pivot. While focused, controls.target was
    // welded to the object every frame; left there, the trackball orbits a point
    // sitting on a surface and there is nowhere for the camera to go (see the note
    // on releasePivotRef). So walk the pivot to where it belongs while leaving
    // camera.position untouched: SmoothControls.update() re-derives its offset from
    // the target each frame, so moving the target only re-aims the camera.
    //
    // Where it belongs is NOT unconditionally the scene centre, and that was the
    // other half of the same report. In the Earth view the centre is the globe, so
    // walking home is right. In the solar view the centre is the SUN, and the
    // camera that just stopped following a planet is sitting a few radii off that
    // planet, eight AU from the Sun: aiming it at the origin leaves it orbiting a
    // point so far away that a single frame of rotation would sweep it clean
    // through the planet, which the arc rate limit then (correctly) refuses to do.
    // The pivot goes to the released body instead — see desiredPivot.
    //
    // The pivot is the ONLY thing restored. camera.up is deliberately left alone:
    // SmoothControls keeps up orthogonal to the view ray, so away from the
    // equatorial plane world up is not a pose the camera can even hold — chasing it
    // here would never converge and would fight the user's own rotation every
    // frame. Straightening up is what LEVEL VIEW / OVERVIEW are for.
    if (releasePivotRef.current) {
      if (levelingRef.current || solarResetRef.current || !controls.enabled) {
        // Those glides take the pivot to the origin themselves, and they move the
        // camera as well — let the bigger motion own the frame. The tour switches
        // the controller off entirely and drives the pivot itself.
        releasePivotRef.current = false;
      } else {
        desiredPivot(pivotScratch);
        controls.target.lerp(pivotScratch, RELEASE_RATE);
        if (controls.target.distanceToSquared(pivotScratch) < 1e-8) {
          controls.target.copy(pivotScratch);
          releasePivotRef.current = false;
        }
        controls.update();
      }
    } else if (
      viewMode === 'solar' &&
      controls.enabled &&
      !levelingRef.current &&
      !solarResetRef.current
    ) {
      // The same repair, applied continuously rather than only on release.
      //
      // Focus is not the only way to end up with a distant pivot and a surface in
      // your face: plain browsing does it too, because zooming toward a planet
      // from across the system moves the camera and never the pivot (and
      // zoom-to-point walks the pivot off to wherever the cursor was pointing).
      // Arriving that way is indistinguishable, to the controller, from arriving
      // by closing a planet card — so it locks the same way, and fixing only the
      // release path would have left a second door into the same dead end.
      //
      // The test is the ratio that governs it and nothing else (PIVOT_SWING_MIN),
      // so this is inert unless the camera genuinely cannot be turned. Once the
      // pivot reaches the body the ratio is healthy by construction and this
      // stops firing.
      const gap = nearestGapRef.current;
      const dist = camera.position.distanceTo(controls.target);
      if (Number.isFinite(gap) && gap > 0 && dist > 1e-9 && gap / dist < PIVOT_SWING_MIN) {
        controls.target.lerp(desiredPivot(pivotScratch), RELEASE_RATE);
        controls.update();
      }
    }

    // LEVEL VIEW (Earth view): glide the camera back to an upright pose —
    // onto the equatorial plane at its current distance and longitude, aimed
    // at the globe center with world up restored — then hand control back.
    // Rotation stays completely free; this only runs when the user asks.
    if (levelingRef.current && viewMode === 'earth') {
      const p = camera.position;
      const r = Math.max(p.length(), EARTH_MIN_CAM_DIST);
      const horiz = Math.hypot(p.x, p.z);
      // Looking straight down a pole there is no longitude to keep — pick +Z
      const hx = horiz > 1e-6 ? p.x / horiz : 0;
      const hz = horiz > 1e-6 ? p.z / horiz : 1;
      vecScratch.set(hx * r, 0, hz * r);
      p.lerp(vecScratch, LEVEL_RATE);
      camera.up.lerp(WORLD_UP, LEVEL_RATE).normalize();
      controls.target.multiplyScalar(1 - LEVEL_RATE);
      if (
        p.distanceTo(vecScratch) < 0.003 &&
        camera.up.distanceTo(WORLD_UP) < 0.003 &&
        controls.target.lengthSq() < 1e-8
      ) {
        p.copy(vecScratch);
        camera.up.copy(WORLD_UP);
        controls.target.set(0, 0, 0);
        levelingRef.current = false;
      }
      controls.update();
    }

    // OVERVIEW (Solar view): glide the camera back to the default whole-system
    // pose — high three-quarter angle on the Sun with the upright basis restored
    // — then hand control back. Rotation stays free; only runs when the user asks.
    //
    // It aims at SOLAR_HOME_UP, not at world up: world up is a pose this camera
    // cannot hold from up there, so waiting for it never finished and the glide
    // owned the camera for ever. See SOLAR_HOME_UP.
    if (solarResetRef.current && viewMode === 'solar') {
      camera.position.lerp(SOLAR_HOME_POS, LEVEL_RATE);
      controls.target.lerp(centerScratch.set(0, 0, 0), LEVEL_RATE);
      camera.up.lerp(SOLAR_HOME_UP, LEVEL_RATE).normalize();
      solarResetFramesRef.current++;
      if (
        (camera.position.distanceTo(SOLAR_HOME_POS) < 0.02 &&
          camera.up.distanceTo(SOLAR_HOME_UP) < 0.01) ||
        solarResetFramesRef.current > SOLAR_RESET_MAX_FRAMES
      ) {
        camera.position.copy(SOLAR_HOME_POS);
        controls.target.set(0, 0, 0);
        camera.up.copy(SOLAR_HOME_UP);
        solarResetRef.current = false;
        solarResetFramesRef.current = 0;
      }
      controls.update();
    }

    enforceCollisions();
  });

  return null;
}

// ---------------------------------------------------------------------------
// Cinematic tour: an automated flight from the Sun outward to Neptune.
//
// While running, the trackball is switched off and the camera is driven
// directly — otherwise damped user input would fight the glide. Positions come
// from the same live ephemeris the renderer uses, so the tour visits each
// planet where it genuinely is at the simulated date.
// ---------------------------------------------------------------------------
const TOUR_GLIDE_RATE = 0.035;
const TOUR_TARGET_RATE = 0.07;

function SolarTour({
  active, controlsRef, simulatedTimeRef, onStopChange, onFinish,
}: {
  active: boolean;
  controlsRef: React.MutableRefObject<SmoothControls | null>;
  simulatedTimeRef: React.MutableRefObject<Date>;
  onStopChange: (stop: (TourStop & { index: number; total: number }) | null) => void;
  onFinish: () => void;
}) {
  const { camera } = useThree();
  const bodyScratch = useMemo(() => new THREE.Vector3(), []);
  const wantScratch = useMemo(() => new THREE.Vector3(), []);
  const dirScratch = useMemo(() => new THREE.Vector3(), []);
  const progress = useRef({ index: 0, arrivedAt: 0, announced: -1 });
  const wasActive = useRef(false);
  // Held in a ref so a caller that re-creates the callback each render cannot
  // restart the tour by invalidating this effect.
  const stopChangeRef = useRef(onStopChange);
  useEffect(() => { stopChangeRef.current = onStopChange; });

  useEffect(() => {
    const controls = controlsRef.current;
    if (active) {
      progress.current = { index: 0, arrivedAt: 0, announced: -1 };
      wasActive.current = true;
      if (controls) {
        // Drop any in-flight gesture as well as disabling input, so a pending
        // flick can't be applied the moment the tour hands the camera back.
        controls.reset();
        controls.enabled = false;
      }
    } else if (wasActive.current) {
      wasActive.current = false;
      // Hand the pose back to the trackball exactly where the tour left it,
      // so releasing the tour doesn't snap the camera anywhere.
      if (controls) {
        controls.target.copy(bodyScratch);
        controls.enabled = true;
        controls.update();
      }
      stopChangeRef.current(null);
    }
    return () => { if (controls) controls.enabled = true; };
  }, [active, controlsRef, bodyScratch]);

  useFrame(() => {
    if (!active) return;
    const controls = controlsRef.current;
    if (!controls) return;

    const P = progress.current;
    const stop = TOUR_STOPS[P.index];
    if (!stop) { onFinish(); return; }

    if (P.announced !== P.index) {
      P.announced = P.index;
      stopChangeRef.current({ ...stop, index: P.index, total: TOUR_STOPS.length });
    }

    // Live position of the stop.
    if (stop.body === 'Sun') bodyScratch.set(0, 0, 0);
    else getPlanetScenePosition(stop.body, simulatedTimeRef.current, bodyScratch);

    // Viewpoint: outward from the Sun and slightly above the ecliptic, so the
    // body is lit from behind the camera and its orbit reads as a curve.
    const standoff = tourStandoff(stop);
    dirScratch.copy(bodyScratch);
    if (dirScratch.lengthSq() < 1e-12) dirScratch.set(0, 0.4, 1);
    dirScratch.normalize();
    dirScratch.y += 0.42; // lift above the ecliptic so the orbit reads as a curve
    dirScratch.normalize();
    wantScratch.copy(dirScratch).multiplyScalar(standoff).add(bodyScratch);

    camera.position.lerp(wantScratch, TOUR_GLIDE_RATE);
    controls.target.lerp(bodyScratch, TOUR_TARGET_RATE);
    camera.up.lerp(WORLD_UP, 0.05).normalize();
    camera.lookAt(controls.target);

    const wall = performance.now();
    if (camera.position.distanceTo(wantScratch) < standoff * 0.22) {
      if (P.arrivedAt === 0) P.arrivedAt = wall;
      if (wall - P.arrivedAt > stop.holdMs) {
        P.arrivedAt = 0;
        P.index++;
        if (P.index >= TOUR_STOPS.length) onFinish();
      }
    }
  });

  return null;
}

// ---------------------------------------------------------------------------
// Frame capture for the postcard export.
//
// The drawing buffer is preserved on the Canvas, but a fresh render is forced
// anyway so the PNG matches exactly what is on screen at the moment the button
// is pressed rather than whatever survived the last compositor swap.
// ---------------------------------------------------------------------------
function CaptureBridge({ captureRef }: { captureRef?: React.MutableRefObject<CaptureFn | null> }) {
  const { gl, scene, camera } = useThree();

  useEffect(() => {
    if (!captureRef) return;
    captureRef.current = () => {
      try {
        gl.render(scene, camera);
        return gl.domElement.toDataURL('image/png');
      } catch {
        return null; // tainted canvas (a cross-origin texture slipped in)
      }
    };
    return () => { captureRef.current = null; };
  }, [gl, scene, camera, captureRef]);

  return null;
}

function FirstPaintBridge({ onFirstPaint }: { onFirstPaint?: () => void }) {
  const { gl } = useThree();
  const reported = useRef(false);
  const onFirstPaintRef = useRef(onFirstPaint);
  useEffect(() => { onFirstPaintRef.current = onFirstPaint; });

  useEffect(() => {
    const canvas = gl.domElement;
    let raf = 0;
    let check = 0;
    const arm = () => {
      cancelAnimationFrame(check);
      check = requestAnimationFrame(() => {
        // The frame loop has run at least once if the canvas has a size.
        if (canvas.width > 0 && canvas.height > 0) {
          if (!reported.current) {
            reported.current = true;
            onFirstPaintRef.current?.();
          }
        } else {
          check = requestAnimationFrame(arm);
        }
      });
    };
    raf = requestAnimationFrame(arm);
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(check); };
  }, [gl]);

  return null;
}

function MoonNodeEarth({
  simulatedTimeRef,
  onSelectBody,
  selectedBody,
}: {
  simulatedTimeRef: React.MutableRefObject<Date>;
  onSelectBody: (body: SelectedBody | null) => void;
  selectedBody: SelectedBody | null;
}) {
  const moonRef = useRef<THREE.Group>(null);
  const sphereRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const moonTexture = useLoader(THREE.TextureLoader, '/textures/planets/moon.png');
  useTapTracking();

  const isSelected = selectedBody?.kind === 'moon' && selectedBody.moon?.name === 'Moon';

  // Trace the Moon's orbit around Earth in Earth-view scale (radius 4.8)
  const orbitPoints = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const periodMs = 27.3217 * 86400000;
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i <= 96; i++) {
      const d = new Date(base + (i / 96) * periodMs);
      const { lon, lat } = getMoonGeocentric(d);
      const orbitR = EARTH_VIEW_MOON_ORBIT_R;
      pts.push(new THREE.Vector3(
        orbitR * Math.cos(lat) * Math.cos(lon),
        orbitR * Math.sin(lat),
        -orbitR * Math.cos(lat) * Math.sin(lon)
      ));
    }
    pts.push(pts[0].clone());
    return pts;
  }, []);

  useFrame(() => {
    if (moonRef.current) {
      const t = simulatedTimeRef.current;
      const { lon, lat } = getMoonGeocentric(t);
      const orbitR = EARTH_VIEW_MOON_ORBIT_R;
      moonRef.current.position.set(
        orbitR * Math.cos(lat) * Math.cos(lon),
        orbitR * Math.sin(lat),
        -orbitR * Math.cos(lat) * Math.sin(lon)
      );
      // Tidally locked: face the Earth at (0, 0, 0)
      moonRef.current.lookAt(0, 0, 0);
      moonRef.current.rotateY(Math.PI); // adjust front face direction
    }
  });

  const handleSelect = (e: ThreeEvent<MouseEvent>) => {
    // Never on a camera gesture: this hit sphere is 0.55 units across, so a
    // swipe that starts anywhere near the Moon used to open its card.
    e.stopPropagation();
    if (!wasTap()) return;
    const earth = PLANET_BY_NAME.get('Earth')!;
    const moon = earth.moons[0];
    onSelectBody({ kind: 'moon', planet: earth, moon });
  };

  const radius = EARTH_VIEW_MOON_RADIUS; // Moon radius is 27.2% of Earth (radius 1.0)
  const hitRadius = 0.55;

  return (
    <group>
      {/* Orbit path */}
      <Line points={orbitPoints} color="#ffffff" lineWidth={0.5} transparent opacity={0.12} />

      <group ref={moonRef}>
        {/* Invisible hit box */}
        <mesh
          onClick={handleSelect}
          onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
          onPointerOut={() => setHovered(false)}
        >
          <sphereGeometry args={[hitRadius, 8, 8]} />
          <meshBasicMaterial visible={false} />
        </mesh>

        {/* Moon body with high quality texture */}
        <mesh ref={sphereRef} onClick={handleSelect}>
          <sphereGeometry args={[radius, 32, 32]} />
          {/* DoubleSide: the Moon must read solid, never a hollow shell. */}
          <meshStandardMaterial map={moonTexture} roughness={0.9} metalness={0.05} side={THREE.DoubleSide} />
        </mesh>

        {isSelected && (
          <mesh>
            <sphereGeometry args={[radius * 1.4, 16, 16]} />
            <meshBasicMaterial color="#b8b8b8" transparent opacity={0.25} blending={THREE.AdditiveBlending} side={THREE.BackSide} />
          </mesh>
        )}

        {(hovered || isSelected) && (
          <Html center position={[0, radius * 2.5, 0]} style={{ pointerEvents: 'none' }} zIndexRange={[10, 0]}>
            <span
              className="scene-label text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap select-none animate-fade-in"
              style={{ color: '#ffffff', backgroundColor: 'rgba(0,0,0,0.6)' }}
            >
              Moon
            </span>
          </Html>
        )}
      </group>
    </group>
  );
}

export function TrackerCanvas({
  satellites,
  selectedSat,
  onSelectSat,
  viewMode,
  selectedSolarSat,
  onSelectSolarSat,
  selectedBody,
  onSelectBody,
  simulatedTimeRef,
  earthSettings,
  solarSettings,
  isFocused = false,
  resetViewNonce = 0,
  sensitivity = 'standard',
  tourActive = false,
  onTourStopChange,
  onTourFinish,
  captureRef,
  onFirstPaint,
}: TrackerCanvasProps) {
  const orbitControlsRef = useRef<SmoothControls | null>(null);

  const noopStop = useCallback(() => {}, []);
  const handleTourStop = onTourStopChange ?? noopStop;
  const handleTourFinish = onTourFinish ?? noopStop;

  return (
    <Canvas
      // tracker-surface pins touch-action/selection on the WebGL surface, so
      // a drag or pinch is consumed here instead of scrolling the document.
      className="tracker-surface"
      // near 0.01 + logarithmic depth buffer: enough depth precision that the
      // coverage ring hugging the globe cannot z-fight/shimmer, while still
      // allowing close zooms and the huge solar-system scene.
      camera={{ position: [0, 0, 3], fov: 45, near: 0.01, far: 400 }}
      // preserveDrawingBuffer keeps the frame readable after compositing,
      // which is what makes the postcard export possible.
      gl={{ logarithmicDepthBuffer: true, preserveDrawingBuffer: true }}
      dpr={[1, 2]}
    >
      <color attach="background" args={['#010204']} />
      <Suspense fallback={null}>

        {/* Camera controls: purpose-built for touch. Rotation is free in
            every axis — no polar clamp, no locked up-vector — but roll-free,
            so a diagonal swipe on a phone never tilts the horizon. A
            two-finger gesture resolves to EITHER a pinch or a pan, never
            both, which is what stopped the Solar System view from lurching
            sideways every time it was zoomed. While focused, the minimum
            distance drops so the camera can close in on the tracked object
            (distances are measured from the controls TARGET, which is the
            satellite in focus mode, not the Earth). */}
        <CameraControls
          controlsRef={orbitControlsRef}
          sensitivity={sensitivity}
          // Same preset, slower response out here. The solar view orbits a pivot
          // that is usually NOT the body you are looking at, and it sizes zoom
          // against free space rather than pivot distance, so identical gains move
          // the view much further than they do around the globe. The Earth view
          // stays at the untrimmed tables — see VIEW_TRIM in lib/interaction.ts.
          view={viewMode}
          // Earth view orbits the globe centre and never pans: a pinch there
          // is always a pinch, and zoom keeps the globe centred.
          noPan={viewMode === 'earth'}
          // Earth view only. The solar view's floor cannot be expressed as a
          // per-render constant — it depends on the live view ray and on planet
          // positions that move with the simulated clock — so CameraRig writes
          // controls.minDistance itself every frame (see computeZoomFloor).
          // Passing anything but the permissive base here would let this
          // component's own effect stomp that value whenever a prop changed.
          minDistance={
            viewMode === 'earth'
              ? isFocused ? 0.002 : EARTH_MIN_CAM_DIST
              : 0.0005
          }
          maxDistance={viewMode === 'earth' ? 15 : 60}
        />
        <CaptureBridge captureRef={captureRef} />
        <FirstPaintBridge onFirstPaint={onFirstPaint} />
        {viewMode === 'solar' && (
          <SolarTour
            active={tourActive}
            controlsRef={orbitControlsRef}
            simulatedTimeRef={simulatedTimeRef}
            onStopChange={handleTourStop}
            onFinish={handleTourFinish}
          />
        )}

        <ambientLight intensity={viewMode === 'earth' ? 0.15 : 0.22} />
        {viewMode === 'earth' && (
          <>
            <DynamicSunLight simulatedTimeRef={simulatedTimeRef} />
            <directionalLight position={[-2, 0, 0]} intensity={0.2} color="#4488cc" />
          </>
        )}

        <Stars radius={150} depth={60} count={5000} factor={4.5} saturation={0.5} fade speed={1.2} />

        <CameraRig
          selectedSat={selectedSat}
          selectedSolarSat={selectedSolarSat}
          selectedBody={selectedBody}
          simulatedTimeRef={simulatedTimeRef}
          isFocused={isFocused}
          viewMode={viewMode}
          controlsRef={orbitControlsRef}
          resetViewNonce={resetViewNonce}
        />

        {viewMode === 'earth' ? (
          <group>
            <Earth
              simulatedTimeRef={simulatedTimeRef}
              showClouds={earthSettings.showClouds}
              showAtmosphere={earthSettings.showAtmosphere}
              showNightLights={earthSettings.showNightLights}
              enableMovement={earthSettings.enableMovement}
            />



            <Satellites
              satellites={satellites}
              onClick={onSelectSat}
              selectedSat={selectedSat}
              simulatedTimeRef={simulatedTimeRef}
              showConstellations={false}
            />

            {selectedSat && (
              <SelectedSatellite
                sat={selectedSat}
                simulatedTimeRef={simulatedTimeRef}
                showCoverage={earthSettings.showCoverage}
              />
            )}

            {earthSettings.showOrbitPath && (
              <OrbitPath sat={selectedSat} simulatedTimeRef={simulatedTimeRef} />
            )}
          </group>
        ) : (
          <SolarSystemView
            satellites={satellites}
            selectedSolarSat={selectedSolarSat}
            onSelectSolarSat={onSelectSolarSat}
            selectedSat={selectedSat}
            onSelectSat={onSelectSat}
            selectedBody={selectedBody}
            onSelectBody={onSelectBody}
            simulatedTimeRef={simulatedTimeRef}
            settings={solarSettings}
          />
        )}

      </Suspense>
    </Canvas>
  );
}
