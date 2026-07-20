'use client';

// Solar System view: every planet, moon and spacecraft is placed at its
// real-time position for the simulated clock (see lib/solar-system.ts for the
// ephemeris details). Radial distances are compressed for browsability;
// angular positions are astronomically correct.
//
// Labels are hidden by default: hovering a body shows its name, clicking it
// opens the details panel.

import { useFrame, useLoader, ThreeEvent } from '@react-three/fiber';
import { Line, Html } from '@react-three/drei';
import { useRef, useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';
import { Earth } from './Earth';
import {
  SatData, ScenePos, PropResult,
  getScenePositionCached, PROP_FAILED, PROP_FULL,
} from '@/lib/satellite';
import { SolarSettings } from '@/lib/settings';
import {
  PLANETS, PlanetInfo, MoonInfo, SelectedBody,
  SUN_SCENE_RADIUS, SUN_TEXTURE_URL,
  SOLAR_SATELLITES, SolarSat, solarSatVisibleAt,
  getPlanetScenePosition, getMoonLocalPosition, getSolarSatScenePosition,
  moonOrbitSceneRadius, moonSceneRadius, earthSatSceneFactor,
} from '@/lib/solar-system';
import { auToSceneRadius } from '@/lib/astronomy';
import { createCircleSpriteGeometry, createCircleSpriteMaterial } from '@/lib/circle-sprite';

// Sidereal rotation period of each planet, hours (negative = retrograde spin)
const DAY_HOURS: Record<string, number> = {
  Mercury: 1407.6, Venus: -5832.5, Earth: 23.93, Mars: 24.62,
  Jupiter: 9.93, Saturn: 10.66, Uranus: -17.24, Neptune: 16.11,
};

function HoverLabel({ text, color, y }: { text: string; color: string; y: number }) {
  return (
    <Html center position={[0, y, 0]} style={{ pointerEvents: 'none' }} zIndexRange={[10, 0]}>
      <span
        className="text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap select-none animate-fade-in"
        style={{ color, backgroundColor: 'rgba(0,0,0,0.6)' }}
      >
        {text}
      </span>
    </Html>
  );
}

/** Name tag pinned a fixed few PIXELS above a satellite dot (screen space, so
 *  it hugs the dot at every zoom level instead of floating far above it). */
function DotTooltip({ name, color, position }: { name: string; color: string; position: THREE.Vector3 }) {
  return (
    <group position={position}>
      <Html center style={{ pointerEvents: 'none', userSelect: 'none' }} zIndexRange={[100, 0]}>
        <div
          style={{ transform: 'translateY(calc(-50% - 12px))' }}
          className="bg-black/90 backdrop-blur-sm px-2 py-1 rounded-md border border-white/20 shadow-lg animate-fade-in"
        >
          <div className="text-[10px] font-mono font-semibold whitespace-nowrap" style={{ color }}>
            {name}
          </div>
        </div>
      </Html>
    </group>
  );
}

/** Raycast for a generous invisible hit sphere that reports its hit at the
 *  distance of the BODY CENTER rather than the sphere's near surface.
 *
 *  Satellite dots and orbiting probes sit INSIDE these inflated spheres
 *  (Earth's LEO swarm rides at ~1.02× the planet radius, Mars orbiters at
 *  ~1.25×, lunar orbiters at ~1.6× the Moon), so with the default raycast
 *  the sphere's near surface was always the closest hit and the body
 *  swallowed every click on them — their detail cards never appeared.
 *  Ordered by center distance instead, anything in front of the body wins
 *  the click, while clicks on the empty disc still select the body. */
function useCenterDistanceRaycast(radius: number) {
  return useMemo(() => {
    const center = new THREE.Vector3();
    const toCenter = new THREE.Vector3();
    return function (this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
      this.getWorldPosition(center);
      const o = raycaster.ray.origin;
      const dir = raycaster.ray.direction;
      toCenter.copy(center).sub(o);
      const t = toCenter.dot(dir);
      if (t < 0) return;
      const d2 = toCenter.lengthSq() - t * t;
      if (d2 > radius * radius) return;
      intersects.push({
        distance: t,
        point: center.clone(),
        object: this,
      } as THREE.Intersection);
    };
  }, [radius]);
}

interface SolarSystemViewProps {
  satellites: SatData[];
  selectedSolarSat: SolarSat | null;
  onSelectSolarSat: (sat: SolarSat | null) => void;
  selectedSat: SatData | null;
  onSelectSat: (sat: SatData | null) => void;
  selectedBody: SelectedBody | null;
  onSelectBody: (body: SelectedBody | null) => void;
  simulatedTimeRef: React.MutableRefObject<Date>;
  settings: SolarSettings;
}

export function SolarSystemView({
  satellites,
  selectedSolarSat,
  onSelectSolarSat,
  selectedSat,
  onSelectSat,
  selectedBody,
  onSelectBody,
  simulatedTimeRef,
  settings,
}: SolarSystemViewProps) {
  const textures = useLoader(
    THREE.TextureLoader,
    [...PLANETS.map((p) => p.textureUrl), SUN_TEXTURE_URL]
  );
  const sunMap = textures[PLANETS.length];
  const sunRef = useRef<THREE.Mesh>(null);
  const [sunHovered, setSunHovered] = useState(false);

  // Probes present at the simulated date (time travel hides future launches).
  // Re-evaluated at most twice per second.
  const [visibleProbes, setVisibleProbes] = useState<SolarSat[]>(SOLAR_SATELLITES);
  const lastVisCheckRef = useRef(0);

  useFrame(() => {
    if (sunRef.current) {
      // Sun rotates once every ~25 days
      const days = simulatedTimeRef.current.getTime() / 86400000;
      sunRef.current.rotation.y = (2 * Math.PI * days) / 25.4;
    }
    const nowMs = performance.now();
    if (nowMs - lastVisCheckRef.current > 500) {
      lastVisCheckRef.current = nowMs;
      const t = simulatedTimeRef.current;
      const vis = SOLAR_SATELLITES.filter((s) => solarSatVisibleAt(s, t));
      setVisibleProbes((prev) => (prev.length === vis.length ? prev : vis));
    }
  });

  return (
    <group>
      {/* Sun */}
      <mesh
        ref={sunRef}
        onPointerOver={(e) => { e.stopPropagation(); setSunHovered(true); }}
        onPointerOut={() => setSunHovered(false)}
      >
        <sphereGeometry args={[SUN_SCENE_RADIUS, 32, 32]} />
        <meshBasicMaterial map={sunMap} toneMapped={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[SUN_SCENE_RADIUS * 1.18, 32, 32]} />
        <meshBasicMaterial color="#ff7700" transparent opacity={0.35} blending={THREE.AdditiveBlending} side={THREE.BackSide} />
      </mesh>
      {sunHovered && <HoverLabel text="Sun" color="#ffcc66" y={SUN_SCENE_RADIUS * 1.6} />}
      <pointLight position={[0, 0, 0]} intensity={3} distance={0} decay={0} color="#fff4e0" />

      {PLANETS.map((planet, idx) => (
        <PlanetNode
          key={planet.name}
          planet={planet}
          texture={textures[idx]}
          simulatedTimeRef={simulatedTimeRef}
          settings={settings}
          satellites={satellites}
          selectedSat={selectedSat}
          selectedBody={selectedBody}
          onSelectSat={onSelectSat}
          onSelectSolarSat={onSelectSolarSat}
          onSelectBody={onSelectBody}
        />
      ))}

      {settings.showProbes && visibleProbes.map((probe) => (
        <ProbeNode
          key={probe.name}
          probe={probe}
          simulatedTimeRef={simulatedTimeRef}
          isSelected={selectedSolarSat === probe}
          onSelect={(p) => { onSelectSat(null); onSelectBody(null); onSelectSolarSat(p); }}
        />
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Planets
// ---------------------------------------------------------------------------

function PlanetNode({
  planet, texture, simulatedTimeRef, settings,
  satellites, selectedSat, selectedBody, onSelectSat, onSelectSolarSat, onSelectBody,
}: {
  planet: PlanetInfo;
  texture: THREE.Texture;
  simulatedTimeRef: React.MutableRefObject<Date>;
  settings: SolarSettings;
  satellites: SatData[];
  selectedSat: SatData | null;
  selectedBody: SelectedBody | null;
  onSelectSat: (sat: SatData | null) => void;
  onSelectSolarSat: (sat: SolarSat | null) => void;
  onSelectBody: (body: SelectedBody | null) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const sphereRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);
  const isSelected = selectedBody?.kind === 'planet' && selectedBody.planet.name === planet.name;
  // Generous hit area — at true relative scale the rocky planets are tiny.
  // Center-distance ordering keeps satellites/probes above the surface
  // clickable even though they sit inside this inflated sphere.
  const hitRadius = Math.max(planet.sceneRadius * 1.5, 0.02);
  const hitRaycast = useCenterDistanceRaycast(hitRadius);

  // Perfect concentric circle at the planet's mean distance — exactly the
  // curve getPlanetScenePosition() moves along.
  const orbitPoints = useMemo(() => {
    const R = auToSceneRadius(planet.orbitAu);
    const pts: THREE.Vector3[] = [];
    for (let s = 0; s <= 180; s++) {
      const a = (s / 180) * 2 * Math.PI;
      pts.push(new THREE.Vector3(R * Math.cos(a), 0, -R * Math.sin(a)));
    }
    return pts;
  }, [planet.orbitAu]);

  useFrame(() => {
    const time = simulatedTimeRef.current;
    if (groupRef.current) {
      getPlanetScenePosition(planet.name, time, groupRef.current.position);
    }
    if (sphereRef.current) {
      const hours = time.getTime() / 3600000;
      sphereRef.current.rotation.y = (2 * Math.PI * hours) / DAY_HOURS[planet.name];
    }
  });

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelectSat(null);
    onSelectSolarSat(null);
    onSelectBody({ kind: 'planet', planet });
  };

  return (
    <group>
      {settings.showOrbits && orbitPoints.length > 0 && (
        <Line points={orbitPoints} color="#ffffff" lineWidth={1} transparent opacity={0.35} />
      )}

      <group ref={groupRef}>
        {/* Generous invisible hit area — at true relative scale the rocky
            planets are tiny, so the sphere itself is too small to click */}
        <mesh
          raycast={hitRaycast}
          onClick={handleClick}
          onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
          onPointerOut={() => setHovered(false)}
        >
          <sphereGeometry args={[hitRadius, 12, 12]} />
          <meshBasicMaterial visible={false} />
        </mesh>
        {planet.name === 'Earth' ? (
          // The REAL Earth — the same component the Earth view renders
          // (day/night shader, clouds, atmosphere, GMST rotation), scaled to
          // the planet's scene radius. Zooming onto Earth in the solar view
          // shows exactly what the dedicated Earth section shows.
          <group scale={[planet.sceneRadius, planet.sceneRadius, planet.sceneRadius]}>
            <Earth simulatedTimeRef={simulatedTimeRef} />
          </group>
        ) : (
          <mesh ref={sphereRef} onClick={handleClick}>
            <sphereGeometry args={[planet.sceneRadius, 32, 32]} />
            <meshStandardMaterial map={texture} roughness={0.85} metalness={0.05} />
          </mesh>
        )}

        {planet.hasRings && (
          <mesh rotation={[Math.PI / 2.35, 0, 0]}>
            <ringGeometry args={[planet.sceneRadius * 1.35, planet.sceneRadius * 2.1, 64]} />
            <meshStandardMaterial color="#d9c090" transparent opacity={0.75} side={THREE.DoubleSide} roughness={0.9} />
          </mesh>
        )}

        {isSelected && (
          <mesh>
            <sphereGeometry args={[Math.max(planet.sceneRadius * 1.3, 0.012), 24, 24]} />
            <meshBasicMaterial color={planet.color} transparent opacity={0.18} blending={THREE.AdditiveBlending} side={THREE.BackSide} />
          </mesh>
        )}

        {(hovered || isSelected) && (
          <HoverLabel text={planet.name} color="#ffffff" y={Math.max(planet.sceneRadius * 2.2, 0.035)} />
        )}

        {settings.showMoons && planet.moons.map((moon) => (
          <MoonNode
            key={moon.name}
            planet={planet}
            moon={moon}
            simulatedTimeRef={simulatedTimeRef}
            settings={settings}
            isSelected={selectedBody?.kind === 'moon' && selectedBody.moon?.name === moon.name}
            onSelect={() => {
              onSelectSat(null);
              onSelectSolarSat(null);
              onSelectBody({ kind: 'moon', planet, moon });
            }}
          />
        ))}

        {/* Real Earth satellites (TLE-propagated) around Earth */}
        {planet.name === 'Earth' && settings.showEarthSats && satellites.length > 0 && (
          <EarthSwarm
            planet={planet}
            satellites={satellites}
            selectedSat={selectedSat}
            simulatedTimeRef={simulatedTimeRef}
            onSelectSat={(s) => { onSelectSolarSat(null); onSelectBody(null); onSelectSat(s); }}
          />
        )}
      </group>
    </group>
  );
}

function MoonNode({
  planet, moon, simulatedTimeRef, settings, isSelected, onSelect,
}: {
  planet: PlanetInfo;
  moon: MoonInfo;
  simulatedTimeRef: React.MutableRefObject<Date>;
  settings: SolarSettings;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const moonRef = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);
  const orbitR = moonOrbitSceneRadius(planet, moon);
  const radius = moonSceneRadius(planet, moon);
  // Center-distance ordering so lunar orbiters (which ride inside this
  // inflated hit sphere) stay clickable — see useCenterDistanceRaycast.
  const hitRadius = Math.max(radius * 2, 0.006);
  const hitRaycast = useCenterDistanceRaycast(hitRadius);

  // Trace the actual path the position function follows over one period, so
  // the drawn orbit always matches where the moon really moves (for Earth's
  // Moon this includes the ephemeris inclination). The trace start date is a
  // fixed epoch: over a single period the path shape is the same closed curve.
  const orbitLinePoints = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const periodMs = Math.abs(moon.periodDays) * 86400000;
    const base = Date.UTC(2026, 0, 1);
    for (let i = 0; i <= 96; i++) {
      const d = new Date(base + (i / 96) * periodMs);
      pts.push(getMoonLocalPosition(planet, moon, d));
    }
    pts.push(pts[0].clone());
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planet.name, moon.name, orbitR]);

  useFrame(() => {
    if (moonRef.current) {
      getMoonLocalPosition(planet, moon, simulatedTimeRef.current, moonRef.current.position);
    }
  });

  return (
    <group>
      {settings.showMoonOrbits && (
        <Line points={orbitLinePoints} color="#ffffff" lineWidth={0.5} transparent opacity={0.1} />
      )}
      <group ref={moonRef}>
        {/* invisible hit area — true-scale moons are far too small to click */}
        <mesh
          raycast={hitRaycast}
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
          onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
          onPointerOut={() => setHovered(false)}
        >
          <sphereGeometry args={[hitRadius, 8, 8]} />
          <meshBasicMaterial visible={false} />
        </mesh>
        <mesh onClick={(e) => { e.stopPropagation(); onSelect(); }}>
          <sphereGeometry args={[radius, 12, 12]} />
          <meshStandardMaterial color={moon.color} roughness={0.95} metalness={0.0} />
        </mesh>
        {isSelected && (
          <mesh>
            <sphereGeometry args={[Math.max(radius * 1.6, 0.005), 12, 12]} />
            <meshBasicMaterial color={moon.color} transparent opacity={0.25} blending={THREE.AdditiveBlending} side={THREE.BackSide} />
          </mesh>
        )}
        {(hovered || isSelected) && (
          <HoverLabel text={moon.name} color="#dddddd" y={Math.max(radius * 3, 0.012)} />
        )}
      </group>
    </group>
  );
}

// ---------------------------------------------------------------------------
// Real Earth satellites rendered around Earth in the solar view.
// ---------------------------------------------------------------------------

const SWARM_BUDGET_MS = 2.0;
// Angular pick radius (radians) — a few pixels at a typical FOV, so the tiny
// proportional dots stay clickable. Coarse (touch) pointers get a much wider
// target, matching Satellites.tsx — fingertip taps never landed otherwise.
const SWARM_PICK_ANGULAR = 0.004;
const SWARM_PICK_ANGULAR_COARSE = 0.014;
const isCoarsePointer = () =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
// Same dot-to-planet proportion as the dedicated Earth view (SAT_SIZE 0.0016
// against Earth radius 1), so satellites look exactly as big relative to
// Earth here as they do there.
const SWARM_DOT_FRACTION = 0.0016;
const swarmColor = new THREE.Color();
const swarmScratch: ScenePos = { x: 0, y: 0, z: 0 };

function EarthSwarm({
  planet, satellites, selectedSat, simulatedTimeRef, onSelectSat,
}: {
  planet: PlanetInfo;
  satellites: SatData[];
  selectedSat: SatData | null;
  simulatedTimeRef: React.MutableRefObject<Date>;
  onSelectSat: (sat: SatData) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const cursorRef = useRef(0);
  const lastHoverRef = useRef(0);
  const [hovered, setHovered] = useState<{ sat: SatData; position: THREE.Vector3 } | null>(null);

  useEffect(() => setHovered(null), [satellites]);

  const satSize = planet.sceneRadius * SWARM_DOT_FRACTION;
  const dotGeometry = useMemo(() => createCircleSpriteGeometry(satSize), [satSize]);
  const dotMaterial = useMemo(() => createCircleSpriteMaterial({ opacity: 0.9 }), []);
  useEffect(() => () => { dotGeometry.dispose(); dotMaterial.dispose(); }, [dotGeometry, dotMaterial]);

  // Analytic picking against the cached instance matrices — billboard quads
  // are too small for triangle raycasts, and this is far cheaper anyway.
  const customRaycast = useMemo(() => {
    const worldPos = new THREE.Vector3();
    const hitPoint = new THREE.Vector3();
    const pickAngular = isCoarsePointer() ? SWARM_PICK_ANGULAR_COARSE : SWARM_PICK_ANGULAR;
    return function (this: THREE.InstancedMesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
      const o = raycaster.ray.origin;
      const dir = raycaster.ray.direction;
      const arr = this.instanceMatrix.array as Float32Array;
      const n = this.count;
      let bestI = -1;
      let bestT = Infinity;
      for (let i = 0; i < n; i++) {
        const base = i * 16;
        if (arr[base] === 0) continue; // hidden (scale 0)
        worldPos.set(arr[base + 12], arr[base + 13], arr[base + 14]).applyMatrix4(this.matrixWorld);
        const vx = worldPos.x - o.x;
        const vy = worldPos.y - o.y;
        const vz = worldPos.z - o.z;
        const t = vx * dir.x + vy * dir.y + vz * dir.z;
        if (t < 0 || t >= bestT) continue;
        const cx = vx - t * dir.x;
        const cy = vy - t * dir.y;
        const cz = vz - t * dir.z;
        const r = Math.max(satSize * 2, t * pickAngular);
        if (cx * cx + cy * cy + cz * cz < r * r) {
          bestI = i;
          bestT = t;
        }
      }
      if (bestI >= 0) {
        hitPoint.copy(dir).multiplyScalar(bestT).add(o);
        intersects.push({
          distance: bestT,
          point: hitPoint.clone(),
          object: this,
          instanceId: bestI,
        } as THREE.Intersection);
      }
    };
  }, [satSize]);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    satellites.forEach((sat, i) => {
      swarmColor.set(sat.color);
      mesh.setColorAt(i, swarmColor);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    cursorRef.current = 0;
  }, [satellites]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh || satellites.length === 0) return;
    const nowMs = simulatedTimeRef.current.getTime();
    const total = satellites.length;
    const matrices = mesh.instanceMatrix.array as Float32Array;

    // Time-budgeted round-robin (see Satellites.tsx) — stable frame rate
    // regardless of fleet size or time jumps. Most iterations are cache
    // hits (extrapolation); full SGP4 runs are the expensive path and get
    // an immediate deadline re-check each.
    let wallNow = performance.now();
    const deadline = wallNow + SWARM_BUDGET_MS;
    let processed = 0;
    let i = cursorRef.current % total;

    while (processed < total) {
      const sat = satellites[i];
      // Time travel: hide satellites that had not been launched yet.
      let res: PropResult = PROP_FAILED;
      if (nowMs >= sat.launchMs) {
        res = getScenePositionCached(sat.satrec, nowMs, swarmScratch, Infinity, wallNow);
        if (res === PROP_FULL) wallNow = performance.now();
      }
      const base = i * 16;
      if (res !== PROP_FAILED) {
        const len = Math.sqrt(
          swarmScratch.x * swarmScratch.x + swarmScratch.y * swarmScratch.y + swarmScratch.z * swarmScratch.z
        ) || 1;
        const rKm = len * 6371;
        const dist = planet.sceneRadius * earthSatSceneFactor(rKm);
        const s = sat === selectedSat ? 4 : 1;
        matrices[base] = s;
        matrices[base + 5] = s;
        matrices[base + 10] = s;
        matrices[base + 12] = (swarmScratch.x / len) * dist;
        matrices[base + 13] = (swarmScratch.y / len) * dist;
        matrices[base + 14] = (swarmScratch.z / len) * dist;
      } else {
        matrices[base] = 0;
        matrices[base + 5] = 0;
        matrices[base + 10] = 0;
        matrices[base + 12] = 0;
        matrices[base + 13] = 0;
        matrices[base + 14] = 0;
      }

      processed++;
      i = (i + 1) % total;
      if ((processed & 63) === 0) wallNow = performance.now();
      if (wallNow > deadline) break;
    }

    cursorRef.current = i;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh
        key={satellites.length}
        ref={meshRef}
        args={[dotGeometry, dotMaterial, Math.max(1, satellites.length)]}
        frustumCulled={false}
        raycast={customRaycast}
        onPointerDown={(e) => {
          e.stopPropagation();
          setHovered(null);
          if (e.instanceId !== undefined) onSelectSat(satellites[e.instanceId]);
        }}
        // Swallow the click so it can't fall through to the planet's hit
        // sphere behind the dot and replace the satellite selection.
        onClick={(e) => e.stopPropagation()}
        onPointerMove={(e) => {
          e.stopPropagation();
          const nowMs = performance.now();
          if (nowMs - lastHoverRef.current < 60) return;
          lastHoverRef.current = nowMs;
          const mesh = meshRef.current;
          if (e.instanceId === undefined || !mesh) return;
          const sat = satellites[e.instanceId];
          if (hovered?.sat === sat) return;
          const arr = mesh.instanceMatrix.array as Float32Array;
          const base = e.instanceId * 16;
          if (arr[base] === 0) return; // hidden
          setHovered({ sat, position: new THREE.Vector3(arr[base + 12], arr[base + 13], arr[base + 14]) });
        }}
        onPointerOut={() => setHovered(null)}
      />
      {hovered && <DotTooltip name={hovered.sat.name} color={hovered.sat.color} position={hovered.position} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Spacecraft — name appears on hover or selection only
// ---------------------------------------------------------------------------

function ProbeNode({
  probe, simulatedTimeRef, isSelected, onSelect,
}: {
  probe: SolarSat;
  simulatedTimeRef: React.MutableRefObject<Date>;
  isSelected: boolean;
  onSelect: (probe: SolarSat) => void;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const [hovered, setHovered] = useState(false);

  useFrame(() => {
    if (groupRef.current) {
      getSolarSatScenePosition(probe, simulatedTimeRef.current, groupRef.current.position);
    }
  });

  // Dot size by regime: deep-space craft get visible dots, but craft hugging
  // a true-scale (tiny) planet or moon must not dwarf their host.
  const dotSize =
    probe.kind === 'escape' ? 0.012
    : probe.kind === 'heliocentric' || probe.kind === 'cruise' ? 0.006
    : probe.kind === 'l1' || probe.kind === 'l2' ? 0.0025
    : 0.0008; // orbiter / moon-orbiter

  return (
    <group ref={groupRef}>
      <mesh
        onClick={(e) => { e.stopPropagation(); onSelect(probe); }}
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true); }}
        onPointerOut={() => setHovered(false)}
      >
        {/* generous invisible hit area */}
        <sphereGeometry args={[Math.max(dotSize * 3, 0.004), 8, 8]} />
        <meshBasicMaterial visible={false} />
      </mesh>
      <mesh>
        <sphereGeometry args={[dotSize, 24, 16]} />
        <meshBasicMaterial color={probe.color} toneMapped={false} transparent opacity={probe.active ? 1 : 0.55} />
      </mesh>
      {(isSelected || hovered) && (
        <>
          <mesh>
            <sphereGeometry args={[dotSize * 2.2, 24, 16]} />
            <meshBasicMaterial color={probe.color} transparent opacity={0.35} blending={THREE.AdditiveBlending} />
          </mesh>
          <HoverLabel text={probe.name} color={probe.color} y={dotSize * 4 + 0.02} />
        </>
      )}
    </group>
  );
}
