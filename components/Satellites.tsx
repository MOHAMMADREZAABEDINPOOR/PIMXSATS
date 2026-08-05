'use client';

import { useFrame, ThreeEvent } from '@react-three/fiber';
import { useRef, useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import {
  SatData, ScenePos, PropResult,
  getScenePositionCached, PROP_FAILED, PROP_FULL,
} from '@/lib/satellite';
import { createCircleSpriteGeometry, createCircleSpriteMaterial } from '@/lib/circle-sprite';
import { useTapCandidate } from '@/lib/tap-gesture';
import { Html } from '@react-three/drei';

interface SatellitesProps {
  satellites: SatData[];
  onClick: (sat: SatData) => void;
  selectedSat: SatData | null;
  simulatedTimeRef: React.MutableRefObject<Date>;
  showConstellations?: boolean;
}

const SAT_SIZE = 0.0016;
// SGP4 propagation is the hot path with 10k+ satellites. Positions barely
// move within a couple of frames, so the workload is spread with a TIME
// BUDGET: each frame propagates satellites round-robin until the budget is
// spent, then resumes next frame. Frame rate stays stable no matter how many
// satellites are loaded or how far the clock jumped.
const FRAME_BUDGET_MS = 3.5;
const HOVER_THROTTLE_MS = 60;
// Angular pick radius (radians) for pointer hit-testing. With a mouse, a few
// pixels of slop around the dot is right; on touch screens ("coarse"
// pointers) a fingertip lands with ~10× less precision, so the target grows
// to a ~25 px tap circle — with the tiny 0.004 radius, taps on satellites
// simply never registered on phones.
const PICK_ANGULAR = 0.004;
const PICK_ANGULAR_COARSE = 0.014;
const isCoarsePointer = () =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------------------
// Tap vs. drag
//
// Selection used to fire on POINTER DOWN, which made the globe almost unusable
// on a phone: the same gesture that spins the Earth starts by putting a finger
// somewhere on it, and with 10,000 dots on screen and a 25 px tap circle,
// "somewhere" is usually on a satellite. Every rotation opened a detail card.
//
// The arbitration itself now lives in lib/tap-gesture.ts, shared with the solar
// view (which had the identical problem on planets and moons). What stays here
// is the reason it cannot be judged by the DOM event that lands on the mesh:
// satellites move, and a finger held still for 400 ms is no longer over the dot
// it pressed — so the instance is captured on press and delivered on release.
// ---------------------------------------------------------------------------

const tempColor = new THREE.Color();
const scratchPos: ScenePos = { x: 0, y: 0, z: 0 };

export function Satellites({ satellites, onClick, selectedSat, simulatedTimeRef, showConstellations = false }: SatellitesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const lineRef = useRef<THREE.LineSegments>(null);
  const cursorRef = useRef(0);
  const lastHoverRef = useRef(0);
  const selectedIndexRef = useRef(-1);
  const [hoveredSat, setHoveredSat] = useState<{ sat: SatData; index: number } | null>(null);

  // Billboarded perfect-circle sprite (same radius/colors as the old spheres)
  const dotGeometry = useMemo(() => createCircleSpriteGeometry(SAT_SIZE), []);
  const dotMaterial = useMemo(() => createCircleSpriteMaterial(), []);
  useEffect(() => () => { dotGeometry.dispose(); dotMaterial.dispose(); }, [dotGeometry, dotMaterial]);

  // Pre-allocated array for drawing constellations to avoid GC thrashing
  const maxLines = 1000;
  const linePositions = useMemo(() => new Float32Array(maxLines * 2 * 3), []);

  // World-space position of every instance, refreshed by the propagation
  // loop. NaN marks "not visible" (not yet launched / propagation failed).
  // This cache is what makes picking O(n) with a tiny constant — no matrix
  // inversions, no triangle tests.
  const posCache = useMemo(
    () => new Float32Array(satellites.length * 3).fill(NaN),
    [satellites]
  );

  useEffect(() => {
    selectedIndexRef.current = selectedSat ? satellites.indexOf(selectedSat) : -1;
  }, [selectedSat, satellites]);

  useEffect(() => setHoveredSat(null), [satellites]);

  // Colors never change per-frame — write them once per satellite list.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    satellites.forEach((sat, i) => {
      tempColor.set(sat.color);
      mesh.setColorAt(i, tempColor);
    });
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    cursorRef.current = 0;
  }, [satellites]);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh || satellites.length === 0) return;

    const nowMs = simulatedTimeRef.current.getTime();
    const total = satellites.length;
    const selIdx = selectedIndexRef.current;
    const matrices = mesh.instanceMatrix.array as Float32Array;

    // Time-budgeted round-robin: refresh as many satellites as fit in the
    // budget this frame, resume from the cursor next frame. Most iterations
    // are served from the extrapolation cache (a few flops each), so the
    // sweep normally covers the whole catalog every frame; the budget only
    // bites right after a time jump, when everything needs a full SGP4 pass.
    let wallNow = performance.now();
    const deadline = wallNow + FRAME_BUDGET_MS;
    let processed = 0;
    const start = cursorRef.current % total;
    let i = start;

    while (processed < total) {
      const sat = satellites[i];
      // Historical accuracy: don't render satellites before their launch date.
      let res: PropResult = PROP_FAILED;
      if (nowMs >= sat.launchMs) {
        res = getScenePositionCached(sat.satrec, nowMs, scratchPos, Infinity, wallNow);
        // A full propagation is the expensive path (a deep-space satellite
        // far from its TLE epoch costs milliseconds) — re-read the clock
        // after every one so a cluster of them cannot blow past the deadline.
        if (res === PROP_FULL) wallNow = performance.now();
      }
      // Only the translation and diagonal scale of an instance matrix are
      // ever non-identity (the sprite shader billboards in view space), so
      // the elements are written directly — no Object3D compose per dot.
      const base = i * 16;
      if (res !== PROP_FAILED) {
        const s = i === selIdx ? 0 : 1; // selected sat is drawn by its detailed model
        matrices[base] = s;
        matrices[base + 5] = s;
        matrices[base + 10] = s;
        matrices[base + 12] = scratchPos.x;
        matrices[base + 13] = scratchPos.y;
        matrices[base + 14] = scratchPos.z;
        posCache[i * 3] = scratchPos.x;
        posCache[i * 3 + 1] = scratchPos.y;
        posCache[i * 3 + 2] = scratchPos.z;
      } else {
        matrices[base] = 0;
        matrices[base + 5] = 0;
        matrices[base + 10] = 0;
        matrices[base + 12] = 0;
        matrices[base + 13] = 0;
        matrices[base + 14] = 0;
        posCache[i * 3] = NaN;
      }

      processed++;
      i = (i + 1) % total;
      // Cheap cache hits only re-read the clock every 64 satellites —
      // calling performance.now() per extrapolation would dominate its cost.
      if ((processed & 63) === 0) wallNow = performance.now();
      if (wallNow > deadline) break;
    }

    cursorRef.current = i;

    // Upload only the matrices touched this frame instead of the whole
    // 10k × 64-byte buffer (the round-robin span wraps → up to two ranges).
    const attr = mesh.instanceMatrix;
    attr.clearUpdateRanges();
    if (processed >= total) {
      attr.addUpdateRange(0, total * 16);
    } else if (i > start) {
      attr.addUpdateRange(start * 16, (i - start) * 16);
    } else {
      attr.addUpdateRange(start * 16, (total - start) * 16);
      if (i > 0) attr.addUpdateRange(0, i * 16);
    }
    attr.needsUpdate = true;

    // ----- Constellations connector logic -----
    if (showConstellations && lineRef.current) {
      // Spatial grid hashing to quickly find close nodes of the same category (O(N) search)
      const grid = new Map<string, number[]>();
      const cellSize = 0.16; // approx 1000km link distance
      const cellSizeSq = cellSize * cellSize;

      for (let idx = 0; idx < total; idx++) {
        const x = posCache[idx * 3];
        if (Number.isNaN(x)) continue;
        const y = posCache[idx * 3 + 1];
        const z = posCache[idx * 3 + 2];
        const cx = Math.floor(x / cellSize);
        const cy = Math.floor(y / cellSize);
        const cz = Math.floor(z / cellSize);
        const key = `${cx},${cy},${cz}`;
        let list = grid.get(key);
        if (!list) {
          list = [];
          grid.set(key, list);
        }
        list.push(idx);
      }

      let lineCount = 0;
      const positionsAttr = lineRef.current.geometry.attributes.position as THREE.BufferAttribute;
      const posArr = positionsAttr.array as Float32Array;

      // Scan each grid cell and its 27 neighbors for connecting pairs of same category
      for (const [key, cellIndices] of grid.entries()) {
        if (lineCount >= maxLines) break;
        const [cx, cy, cz] = key.split(',').map(Number);

        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dz = -1; dz <= 1; dz++) {
              if (lineCount >= maxLines) break;
              const nKey = `${cx + dx},${cy + dy},${cz + dz}`;
              const neighborIndices = grid.get(nKey);
              if (!neighborIndices) continue;

              for (const i of cellIndices) {
                if (lineCount >= maxLines) break;
                const ix = posCache[i * 3];
                const iy = posCache[i * 3 + 1];
                const iz = posCache[i * 3 + 2];
                const iCat = satellites[i].category;

                // Ignore debris / rocket bodies, only connect active satellites / constellations
                if (iCat === 'Debris' || iCat === 'Rocket Bodies') continue;

                for (const j of neighborIndices) {
                  if (i >= j) continue; // avoid duplicates
                  if (lineCount >= maxLines) break;

                  if (satellites[j].category !== iCat) continue;

                  const jx = posCache[j * 3];
                  const jy = posCache[j * 3 + 1];
                  const jz = posCache[j * 3 + 2];

                  const dx_val = jx - ix;
                  const dy_val = jy - iy;
                  const dz_val = jz - iz;
                  const distSq = dx_val * dx_val + dy_val * dy_val + dz_val * dz_val;

                  if (distSq < cellSizeSq) {
                    const offset = lineCount * 6;
                    posArr[offset] = ix;
                    posArr[offset + 1] = iy;
                    posArr[offset + 2] = iz;
                    posArr[offset + 3] = jx;
                    posArr[offset + 4] = jy;
                    posArr[offset + 5] = jz;
                    lineCount++;
                  }
                }
              }
            }
          }
        }
      }

      // Hide unused segments in the buffer
      for (let i = lineCount; i < maxLines; i++) {
        const offset = i * 6;
        posArr[offset] = 0; posArr[offset + 1] = 0; posArr[offset + 2] = 0;
        posArr[offset + 3] = 0; posArr[offset + 4] = 0; posArr[offset + 5] = 0;
      }
      positionsAttr.needsUpdate = true;
      lineRef.current.visible = true;
    } else if (lineRef.current) {
      lineRef.current.visible = false;
    }
  });

  // Analytic picking: nearest satellite whose cached position lies within a
  // small angular radius of the pointer ray. Replaces three.js's default
  // InstancedMesh raycast (per-instance matrix inversion + triangle tests
  // against every sphere — the source of frame stalls whenever the mouse
  // moved over the canvas with a full catalog loaded).
  const customRaycast = useMemo(() => {
    const hitPoint = new THREE.Vector3();
    const pickAngular = isCoarsePointer() ? PICK_ANGULAR_COARSE : PICK_ANGULAR;
    return function (this: THREE.InstancedMesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]) {
      const o = raycaster.ray.origin;
      const dir = raycaster.ray.direction;
      const n = posCache.length / 3;
      let bestI = -1;
      let bestT = Infinity;

      // Earth occlusion: satellites BEHIND the globe must not be pickable.
      // Distance along the ray where it enters the Earth sphere (radius
      // slightly under 1 so satellites skimming the horizon stay hoverable);
      // any candidate farther than that is hidden by the planet.
      const EARTH_R = 0.995;
      const B = o.x * dir.x + o.y * dir.y + o.z * dir.z;
      const C = o.x * o.x + o.y * o.y + o.z * o.z - EARTH_R * EARTH_R;
      const disc = B * B - C;
      let tEarth = Infinity;
      if (disc > 0) {
        const t0 = -B - Math.sqrt(disc);
        if (t0 > 0) tEarth = t0;
      }

      for (let i = 0; i < n; i++) {
        const px = posCache[i * 3];
        if (Number.isNaN(px)) continue;
        const vx = px - o.x;
        const vy = posCache[i * 3 + 1] - o.y;
        const vz = posCache[i * 3 + 2] - o.z;
        const t = vx * dir.x + vy * dir.y + vz * dir.z;
        if (t < 0 || t >= bestT || t > tEarth) continue;
        const cx = vx - t * dir.x;
        const cy = vy - t * dir.y;
        const cz = vz - t * dir.z;
        const r = Math.max(SAT_SIZE * 2, t * pickAngular);
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
  }, [posCache]);

  // Selection is decided on RELEASE, by the shared arbiter — a press that turns
  // into a camera drag, a hold, or a pinch never selects the dot it started on.
  const armTap = useTapCandidate<number>((index) => {
    const sat = satellites[index];
    if (!sat) return;
    onClick(sat);
    setHoveredSat(null);
  });

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (e.instanceId === undefined) return;
    armTap(e, e.instanceId);
  };

  const handlePointerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    // Hover is a mouse affordance. On touch it fired on the way through a drag
    // and left a tooltip stranded over the globe.
    if (e.pointerType === 'touch') return;
    const nowMs = performance.now();
    if (nowMs - lastHoverRef.current < HOVER_THROTTLE_MS) return;
    lastHoverRef.current = nowMs;
    if (e.instanceId !== undefined) {
      const sat = satellites[e.instanceId];
      if (hoveredSat?.sat === sat) return;
      if (!Number.isNaN(posCache[e.instanceId * 3])) {
        setHoveredSat({ sat, index: e.instanceId });
      }
    }
  };

  const handlePointerOut = () => setHoveredSat(null);

  return (
    <>
      <instancedMesh
        key={satellites.length}
        ref={meshRef}
        args={[dotGeometry, dotMaterial, Math.max(1, satellites.length)]}
        frustumCulled={false}
        raycast={customRaycast}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
      />

      <lineSegments ref={lineRef} frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[linePositions, 3]}
          />
        </bufferGeometry>
        <lineBasicMaterial
          color="#00e1ff"
          transparent
          opacity={0.3}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </lineSegments>

      {hoveredSat && <SatelliteTooltip sat={hoveredSat.sat} index={hoveredSat.index} posCache={posCache} />}
    </>
  );
}

// Name tag pinned a fixed few PIXELS above the dot: anchored at the
// satellite's exact position (updated every frame so it rides along), with
// the vertical offset applied in screen space. No scene-unit offset and no
// distance scaling — the label hugs the circle at every zoom level instead
// of floating hundreds of km above it.
function SatelliteTooltip({ sat, index, posCache }: { sat: SatData; index: number; posCache: Float32Array }) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    const j = index * 3;
    if (groupRef.current && !Number.isNaN(posCache[j])) {
      groupRef.current.position.set(posCache[j], posCache[j + 1], posCache[j + 2]);
    }
  });

  return (
    <group ref={groupRef} position={[posCache[index * 3], posCache[index * 3 + 1], posCache[index * 3 + 2]]}>
      <Html center style={{ pointerEvents: 'none', userSelect: 'none' }} zIndexRange={[100, 0]}>
        <div
          style={{ transform: 'translateY(calc(-50% - 12px))' }}
          className="scene-label bg-black/90 backdrop-blur-sm px-2.5 py-1 rounded-md border border-white/20 shadow-lg animate-fade-in"
        >
          <div className="text-xs font-mono font-semibold whitespace-nowrap" style={{ color: sat.color }}>
            {sat.name}
          </div>
        </div>
      </Html>
    </group>
  );
}
