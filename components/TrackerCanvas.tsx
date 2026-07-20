'use client';

/* eslint-disable react-hooks/immutability -- react-three-fiber renders by
   mutating three.js objects (camera, materials) inside useFrame; that is the
   library's intended imperative API, not a React render-phase mutation. */

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { TrackballControls, Stars, Line } from '@react-three/drei';
import { Earth } from './Earth';
import { Satellites } from './Satellites';
import { SolarSystemView } from './SolarSystemView';
import { SatelliteModel } from './SatelliteModel';
import {
  SatData, ScenePos, getOrbitEllipsePoints,
  getScenePositionCached, PROP_FAILED,
} from '@/lib/satellite';
import {
  SolarSat, SelectedBody, PLANETS, PLANET_BY_NAME, SUN_SCENE_RADIUS,
  getSolarSatScenePosition, getPlanetScenePosition, getMoonLocalPosition,
  getBodyScenePosition, getBodySceneRadius, earthSatSceneFactor,
} from '@/lib/solar-system';
import { EarthSettings, SolarSettings } from '@/lib/settings';
import { getSunSceneDirection } from '@/lib/astronomy';
import * as THREE from 'three';
import { useState, useRef, useMemo, useEffect, Suspense } from 'react';

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
}

// ---------------------------------------------------------------------------
// Orbit path of the selected satellite.
//
// Recomputation is throttled by WALL time (min 1.5 s between rebuilds), not
// simulated time — during million-x warp the sim clock races but the path is
// still rebuilt at most ~0.7 Hz, so time travel cannot stall the frame loop.
// ---------------------------------------------------------------------------
function OrbitPath({ sat, simulatedTimeRef }: { sat: SatData | null; simulatedTimeRef: React.MutableRefObject<Date> }) {
  const [baseMs, setBaseMs] = useState(0);
  const lastWallRef = useRef(0);
  const lastSimRef = useRef(0);

  useFrame(() => {
    const simMs = simulatedTimeRef.current.getTime();
    const wall = performance.now();
    const simMoved = Math.abs(simMs - lastSimRef.current);
    // Rebuild when the sim clock drifted > 1 min, but never more often than
    // every 1.5 s of real time.
    if (simMoved > 60000 && wall - lastWallRef.current > 1500) {
      lastWallRef.current = wall;
      lastSimRef.current = simMs;
      setBaseMs(simMs);
    }
  });

  const points = useMemo(() => {
    if (!sat || baseMs === 0) return [];
    if (baseMs < sat.launchMs) return []; // not launched yet at this sim time
    // Osculating ellipse from the current state vector: a perfectly CLOSED
    // loop (start and end coincide exactly), valid for LEO through GEO and
    // highly elliptical orbits alike.
    return getOrbitEllipsePoints(sat.satrec, new Date(baseMs), 256) ?? [];
  }, [sat, baseMs]);

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
// Per-frame rate of the camera glides (post-focus up-vector restore, LEVEL
// VIEW straightening) — ≈ settles in under half a second.
const LEVEL_RATE = 0.12;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function CameraRig({
  selectedSat, selectedSolarSat, selectedBody, simulatedTimeRef, isFocused, viewMode, controlsRef, resetViewNonce,
}: {
  selectedSat: SatData | null;
  selectedSolarSat: SolarSat | null;
  selectedBody: SelectedBody | null;
  simulatedTimeRef: React.MutableRefObject<Date>;
  isFocused: boolean;
  viewMode: 'earth' | 'solar';
  controlsRef: React.RefObject<any>;
  resetViewNonce: number;
}) {
  const { camera } = useThree();
  const targetScratch = useMemo(() => new THREE.Vector3(), []);
  const centerScratch = useMemo(() => new THREE.Vector3(), []);
  const vecScratch = useMemo(() => new THREE.Vector3(), []);
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
  // Saved view state for smooth return after focus ends
  const savedViewRef = useRef<{ pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } | null>(null);
  const returningRef = useRef(false);
  const focusInitRef = useRef(false);
  const prevViewRef = useRef(viewMode);
  // LEVEL VIEW: glide back to an upright equatorial pose (Earth view only)
  const levelingRef = useRef(false);
  const prevResetNonceRef = useRef(resetViewNonce);

  useEffect(() => {
    if (resetViewNonce !== prevResetNonceRef.current) {
      prevResetNonceRef.current = resetViewNonce;
      if (viewMode === 'earth' && !isFocused) levelingRef.current = true;
    }
  }, [resetViewNonce, viewMode, isFocused]);

  // Reposition when switching views
  useEffect(() => {
    if (prevViewRef.current !== viewMode) {
      prevViewRef.current = viewMode;
      savedViewRef.current = null;
      returningRef.current = false;
      focusInitRef.current = false;
      levelingRef.current = false;
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
    levelingRef.current = false;
    if (isFocused) {
      // Save the view to return to, and flag that the approach shot is needed
      savedViewRef.current = {
        pos: camera.position.clone(),
        target: controlsRef.current ? controlsRef.current.target.clone() : new THREE.Vector3(),
        up: camera.up.clone(),
      };
      returningRef.current = false;
      focusInitRef.current = true;
    } else if (savedViewRef.current) {
      returningRef.current = true;
      focusInitRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused]);

  /** Current world position + body radius of whatever is focused, plus the
   *  center of the body it moves around (used for the perpendicular lock:
   *  the camera sits on the center→object line, outside the object). */
  const getFocusTarget = (): { pos: THREE.Vector3; bodyRadius: number; center: THREE.Vector3 } | null => {
    const t = simulatedTimeRef.current;
    if (viewMode === 'earth' && selectedSat) {
      if (t.getTime() < selectedSat.launchMs) return null;
      if (getScenePositionCached(selectedSat.satrec, t.getTime(), propScratch, TRACKED_MAX_AGE_MS) === PROP_FAILED) return null;
      return {
        pos: targetScratch.set(propScratch.x, propScratch.y, propScratch.z),
        bodyRadius: 0,
        center: centerScratch.set(0, 0, 0), // Earth center
      };
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

  /** Push the camera out of any body it has entered — the camera must NEVER
   *  be inside a planet, in any mode. When something is focused, its own
   *  radius is enforced too (moons included), so zooming onto any object
   *  stops smoothly at its surface instead of clipping in. `tracking` means
   *  a satellite/probe is being followed: clearances shrink so the camera
   *  can skim just above the surface, but never through it. */
  const enforceCollisions = (focusPos?: THREE.Vector3, focusRadius = 0, tracking = false) => {
    if (viewMode === 'earth') {
      const minR = tracking ? EARTH_FOCUS_MIN_CAM_DIST : EARTH_MIN_CAM_DIST;
      const len = camera.position.length();
      if (len < minR) {
        camera.position.multiplyScalar(minR / Math.max(len, 1e-6));
      }
      return;
    }
    const t = simulatedTimeRef.current;
    // Sun
    const sunMin = SUN_SCENE_RADIUS * 1.25;
    if (camera.position.length() < sunMin) {
      camera.position.normalize().multiplyScalar(sunMin);
    }
    // Planets (rings included for Saturn via the browsing clearance)
    const clearance = tracking ? PLANET_CLEARANCE_TRACKING : PLANET_CLEARANCE;
    for (const planet of PLANETS) {
      getPlanetScenePosition(planet.name, t, vecScratch);
      const minDist = planet.sceneRadius * clearance;
      const d = camera.position.distanceTo(vecScratch);
      if (d < minDist) {
        camera.position
          .sub(vecScratch)
          .normalize()
          .multiplyScalar(minDist)
          .add(vecScratch);
      }
    }
    // Focused body (covers moons, which are not in the planet loop)
    if (focusPos && focusRadius > 0) {
      const minDist = focusRadius * 1.4;
      const d = camera.position.distanceTo(focusPos);
      if (d < minDist && d > 1e-9) {
        camera.position
          .sub(focusPos)
          .multiplyScalar(minDist / d)
          .add(focusPos);
      }
    }
  };

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    if (isFocused) {
      const focus = getFocusTarget();
      if (focus) {
        const { pos: targetPos, bodyRadius, center } = focus;
        const F = followRef.current;
        const isBody = bodyRadius > 0;

        if (focusInitRef.current) {
          // Approach shot: glide toward a pose on the (body center → object)
          // line, then hand full control to the user.
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

    if (returningRef.current && savedViewRef.current) {
      // Smoothly glide back to the pre-focus view
      const saved = savedViewRef.current;
      camera.position.lerp(saved.pos, 0.06);
      controls.target.lerp(saved.target, 0.06);
      // Un-roll any orbit-follow tilt back to the exact pre-focus orientation
      camera.up.lerp(saved.up, LEVEL_RATE).normalize();
      if (camera.position.distanceTo(saved.pos) < 0.01) {
        camera.position.copy(saved.pos);
        controls.target.copy(saved.target);
        camera.up.copy(saved.up).normalize();
        returningRef.current = false;
        savedViewRef.current = null;
      }
      controls.update();
      enforceCollisions();
      return;
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

    enforceCollisions();
  });

  return null;
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
}: TrackerCanvasProps) {
  const orbitControlsRef = useRef<any>(null);

  return (
    <Canvas
      // near 0.01 + logarithmic depth buffer: enough depth precision that the
      // coverage ring hugging the globe cannot z-fight/shimmer, while still
      // allowing close zooms and the huge solar-system scene.
      camera={{ position: [0, 0, 3], fov: 45, near: 0.01, far: 400 }}
      gl={{ logarithmicDepthBuffer: true }}
      dpr={[1, 2]}
    >
      <color attach="background" args={['#010204']} />
      <Suspense fallback={null}>

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

        {/* Trackball-style controls: rotation is fully free in every axis —
            no polar-angle clamp, no locked "up" vector, so the view never
            jams when the camera passes over the poles. While focused, the
            min distance drops so the camera can get close to the tracked
            object (distances are measured from the controls TARGET, which is
            the satellite in focus mode, not the Earth). */}
        <TrackballControls
          ref={orbitControlsRef}
          noPan={viewMode === 'earth'}
          minDistance={
            isFocused ? (viewMode === 'earth' ? 0.002 : 0.0005)
            : viewMode === 'earth' ? EARTH_MIN_CAM_DIST : 0.005
          }
          maxDistance={viewMode === 'earth' ? 15 : 60}
          zoomSpeed={0.6}
          rotateSpeed={0.8}
          panSpeed={0.6}
          staticMoving={false}
          dynamicDampingFactor={0.15}
        />
      </Suspense>
    </Canvas>
  );
}
