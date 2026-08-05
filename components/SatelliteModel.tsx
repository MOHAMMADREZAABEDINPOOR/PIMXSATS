'use client';

// High-detail procedural spacecraft models for the selected satellite.
// Geometry and materials are generated in code (solar-cell and MLI foil
// textures are painted onto canvases at runtime), so no external assets are
// needed. A model variant is chosen from the satellite's category so a
// Starlink bird, a GPS bird and the ISS all look like themselves.

import { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return { canvas, ctx: canvas.getContext('2d')! };
}

/** Blue photovoltaic cell grid with subtle sheen variation. */
function makeSolarPanelTexture(): THREE.Texture {
  const { canvas, ctx } = makeCanvas(256, 128);
  ctx.fillStyle = '#0a1f4d';
  ctx.fillRect(0, 0, 256, 128);

  const cw = 16, ch = 16;
  for (let y = 0; y < 128; y += ch) {
    for (let x = 0; x < 256; x += cw) {
      const v = 30 + Math.floor(Math.random() * 26);
      ctx.fillStyle = `rgb(${8 + v * 0.15}, ${18 + v * 0.6}, ${60 + v * 1.6})`;
      ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
      // diagonal cell sheen
      ctx.fillStyle = 'rgba(120, 170, 255, 0.10)';
      ctx.beginPath();
      ctx.moveTo(x + 1, y + ch - 1);
      ctx.lineTo(x + cw - 1, y + 1);
      ctx.lineTo(x + cw - 1, y + 5);
      ctx.lineTo(x + 5, y + ch - 1);
      ctx.closePath();
      ctx.fill();
    }
  }
  // bus bars
  ctx.strokeStyle = 'rgba(200, 210, 230, 0.5)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= 256; x += cw * 4) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 128); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = 4;
  return tex;
}

/** Crinkled gold multi-layer insulation foil. */
function makeGoldFoilTexture(): THREE.Texture {
  const { canvas, ctx } = makeCanvas(128, 128);
  ctx.fillStyle = '#a67810';
  ctx.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * 128, y = Math.random() * 128;
    const w = 2 + Math.random() * 9, h = 2 + Math.random() * 9;
    const g = 120 + Math.floor(Math.random() * 110);
    ctx.fillStyle = `rgba(${g + 60}, ${g}, ${Math.floor(g * 0.22)}, 0.5)`;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.random() * Math.PI);
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** White radiator panel with seams. */
function makeRadiatorTexture(): THREE.Texture {
  const { canvas, ctx } = makeCanvas(128, 128);
  ctx.fillStyle = '#e8eaec';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(140,150,160,0.6)';
  for (let x = 0; x <= 128; x += 16) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 128); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function useSatTextures() {
  return useMemo(() => ({
    panel: makeSolarPanelTexture(),
    foil: makeGoldFoilTexture(),
    radiator: makeRadiatorTexture(),
  }), []);
}

// ---------------------------------------------------------------------------
// Shared sub-assemblies
// ---------------------------------------------------------------------------

function SolarWing({
  panelTex, length, width, x, segments = 3,
}: { panelTex: THREE.Texture; length: number; width: number; x: number; segments?: number }) {
  const dir = Math.sign(x);
  const segLen = length / segments;
  return (
    <group position={[x, 0, 0]}>
      {/* yoke boom */}
      <mesh position={[-dir * length / 2 - dir * 0.012, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.0022, 0.0022, 0.024, 8]} />
        <meshStandardMaterial color="#888c92" metalness={0.9} roughness={0.35} />
      </mesh>
      {Array.from({ length: segments }, (_, i) => {
        const cx = -length / 2 + segLen * (i + 0.5);
        return (
          <group key={i} position={[cx, 0, 0]}>
            {/* cell face */}
            <mesh>
              <boxGeometry args={[segLen * 0.96, 0.0016, width]} />
              <meshStandardMaterial
                map={panelTex} metalness={0.65} roughness={0.32}
                emissive="#0a1e45" emissiveIntensity={0.35}
              />
            </mesh>
            {/* frame */}
            <mesh position={[0, -0.0012, 0]}>
              <boxGeometry args={[segLen * 0.99, 0.0008, width * 1.03]} />
              <meshStandardMaterial color="#3a3f46" metalness={0.7} roughness={0.5} />
            </mesh>
            {/* hinge */}
            {i < segments - 1 && (
              <mesh position={[segLen / 2, 0, 0]} rotation={[Math.PI / 2, 0, 0]}>
                <cylinderGeometry args={[0.0018, 0.0018, width * 0.9, 6]} />
                <meshStandardMaterial color="#666a70" metalness={0.85} roughness={0.4} />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

function HighGainDish({
  position, rotation = [0, 0, 0] as [number, number, number], radius = 0.014, mount = 0.01,
}: { position: [number, number, number]; rotation?: [number, number, number]; radius?: number; mount?: number }) {
  return (
    <group position={position} rotation={rotation}>
      {/* support gimbal — a stalk running from the dish back (local -y) toward
          the bus, plus a pivot knuckle. Without it the reflector looks like a
          detached dome floating off the spacecraft. */}
      <mesh position={[0, -mount / 2, 0]}>
        <cylinderGeometry args={[0.0016, 0.0016, mount, 8]} />
        <meshStandardMaterial color="#6a6e74" metalness={0.85} roughness={0.4} />
      </mesh>
      <mesh position={[0, -mount * 0.15, 0]}>
        <sphereGeometry args={[0.0026, 12, 10]} />
        <meshStandardMaterial color="#7d818a" metalness={0.8} roughness={0.4} />
      </mesh>
      {/* parabolic reflector (open hemisphere) */}
      <mesh>
        <sphereGeometry args={[radius, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2.6]} />
        <meshStandardMaterial color="#e6e6e2" metalness={0.35} roughness={0.4} side={THREE.DoubleSide} />
      </mesh>
      {/* rim */}
      <mesh position={[0, radius * 0.42, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[radius * 0.9, 0.0008, 8, 32]} />
        <meshStandardMaterial color="#b9b9b4" metalness={0.7} roughness={0.35} />
      </mesh>
      {/* feed horn on tripod */}
      <mesh position={[0, radius * 1.15, 0]}>
        <cylinderGeometry args={[0.0016, 0.003, radius * 0.5, 8]} />
        <meshStandardMaterial color="#55585e" metalness={0.8} roughness={0.4} />
      </mesh>
      {[0, 2.09, 4.19].map((a) => (
        <mesh
          key={a}
          position={[Math.cos(a) * radius * 0.45, radius * 0.62, Math.sin(a) * radius * 0.45]}
          rotation={[Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5]}
        >
          <cylinderGeometry args={[0.0005, 0.0005, radius * 1.15, 4]} />
          <meshStandardMaterial color="#9a9da2" metalness={0.85} roughness={0.35} />
        </mesh>
      ))}
    </group>
  );
}

function Antenna({ position, height = 0.02, tip = true }: { position: [number, number, number]; height?: number; tip?: boolean }) {
  return (
    <group position={position}>
      <mesh position={[0, height / 2, 0]}>
        <cylinderGeometry args={[0.0006, 0.0009, height, 6]} />
        <meshStandardMaterial color="#c8ccd2" metalness={0.9} roughness={0.25} />
      </mesh>
      {tip && (
        <mesh position={[0, height, 0]}>
          <sphereGeometry args={[0.0014, 8, 8]} />
          <meshStandardMaterial color="#dddddd" metalness={0.6} roughness={0.3} />
        </mesh>
      )}
    </group>
  );
}

function Thruster({ position, rotation = [0, 0, 0] as [number, number, number] }: { position: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <mesh position={position} rotation={rotation}>
      <cylinderGeometry args={[0.0035, 0.0018, 0.006, 12, 1, true]} />
      <meshStandardMaterial color="#3c3b39" metalness={0.9} roughness={0.35} side={THREE.DoubleSide} />
    </mesh>
  );
}

function StarTracker({ position, rotation = [0, 0, 0] as [number, number, number] }: { position: [number, number, number]; rotation?: [number, number, number] }) {
  return (
    <group position={position} rotation={rotation}>
      <mesh>
        <cylinderGeometry args={[0.0022, 0.0028, 0.005, 10]} />
        <meshStandardMaterial color="#17181c" metalness={0.5} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.0026, 0]}>
        <cylinderGeometry args={[0.0018, 0.0018, 0.0004, 10]} />
        <meshStandardMaterial color="#223" metalness={0.2} roughness={0.2} emissive="#112" />
      </mesh>
    </group>
  );
}

function Beacon({ color }: { color: string }) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (ref.current) {
      const mat = ref.current.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.55 + 0.45 * Math.sin(clock.elapsedTime * 4);
    }
  });
  return (
    <mesh ref={ref} position={[0, 0.014, 0]}>
      <sphereGeometry args={[0.002, 8, 8]} />
      <meshBasicMaterial color={color} transparent toneMapped={false} />
    </mesh>
  );
}

// ---------------------------------------------------------------------------
// Model variants
// ---------------------------------------------------------------------------

function GenericCommSat({ tex, color }: { tex: ReturnType<typeof useSatTextures>; color: string }) {
  return (
    <group>
      {/* MLI-wrapped bus */}
      <mesh>
        <boxGeometry args={[0.02, 0.018, 0.026]} />
        <meshStandardMaterial map={tex.foil} color="#d8a028" metalness={0.85} roughness={0.35} />
      </mesh>
      {/* radiator faces */}
      <mesh position={[0, 0, 0.0132]}>
        <boxGeometry args={[0.018, 0.016, 0.0006]} />
        <meshStandardMaterial map={tex.radiator} metalness={0.3} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0, -0.0132]}>
        <boxGeometry args={[0.018, 0.016, 0.0006]} />
        <meshStandardMaterial map={tex.radiator} metalness={0.3} roughness={0.5} />
      </mesh>
      <SolarWing panelTex={tex.panel} length={0.055} width={0.016} x={0.04} />
      <SolarWing panelTex={tex.panel} length={0.055} width={0.016} x={-0.04} />
      <HighGainDish position={[0, -0.014, 0.004]} rotation={[Math.PI, 0, 0]} />
      <Antenna position={[0.006, 0.009, -0.008]} height={0.016} />
      <Antenna position={[-0.006, 0.009, -0.008]} height={0.012} />
      <StarTracker position={[0.007, 0.0095, 0.006]} rotation={[0.4, 0, -0.3]} />
      <Thruster position={[0, 0, -0.0155]} rotation={[Math.PI / 2, 0, 0]} />
      <Beacon color={color} />
    </group>
  );
}

// Starlink V2 Mini silhouette: a flat rectangular bus flying "face down"
// (white phased-array dishes on the Earth-facing side, dark avionics on top)
// with TWO large blue solar wings spread symmetrically on lattice booms —
// the classic, instantly recognizable satellite shape.
function StarlinkSat({ tex, color }: { tex: ReturnType<typeof useSatTextures>; color: string }) {
  return (
    <group>
      {/* main bus — flat rectangular chassis */}
      <mesh>
        <boxGeometry args={[0.022, 0.0045, 0.032]} />
        <meshStandardMaterial color="#c7ccd4" metalness={0.85} roughness={0.3} />
      </mesh>
      {/* dark top plate (avionics / star-tracker side) */}
      <mesh position={[0, 0.0026, 0]}>
        <boxGeometry args={[0.0205, 0.0009, 0.0305]} />
        <meshStandardMaterial color="#2b2f36" metalness={0.6} roughness={0.45} />
      </mesh>
      {/* nadir face: four white phased-array antenna discs */}
      {[[-0.0052, -0.009], [0.0052, -0.009], [-0.0052, 0.001], [0.0052, 0.001]].map(([x, z]) => (
        <group key={`${x}:${z}`} position={[x, -0.0028, z]}>
          <mesh>
            <cylinderGeometry args={[0.0042, 0.0042, 0.0012, 24]} />
            <meshStandardMaterial color="#eceff3" metalness={0.35} roughness={0.4} />
          </mesh>
          <mesh position={[0, -0.0008, 0]}>
            <cylinderGeometry args={[0.0034, 0.0034, 0.0004, 24]} />
            <meshStandardMaterial color="#d4d9e0" metalness={0.3} roughness={0.35} />
          </mesh>
        </group>
      ))}
      {/* gold MLI foil band around the aft equipment bay */}
      <mesh position={[0, 0, 0.0135]}>
        <boxGeometry args={[0.0205, 0.004, 0.0045]} />
        <meshStandardMaterial map={tex.foil} color="#d8a028" metalness={0.85} roughness={0.35} />
      </mesh>
      {/* twin solar wings on booms — the identifying Starlink V2 feature */}
      <SolarWing panelTex={tex.panel} length={0.062} width={0.02} x={0.045} segments={4} />
      <SolarWing panelTex={tex.panel} length={0.062} width={0.02} x={-0.045} segments={4} />
      {/* inter-satellite laser terminals (fore/aft turrets) */}
      {[-0.0145, 0.0145].map((z) => (
        <group key={z} position={[0, 0.0038, z]}>
          <mesh>
            <cylinderGeometry args={[0.0018, 0.0022, 0.0022, 12]} />
            <meshStandardMaterial color="#565b63" metalness={0.8} roughness={0.35} />
          </mesh>
          <mesh position={[0, 0.0016, 0]}>
            <sphereGeometry args={[0.0014, 16, 12]} />
            <meshStandardMaterial color="#1a2030" metalness={0.4} roughness={0.2} emissive="#101828" />
          </mesh>
        </group>
      ))}
      <Antenna position={[0.0075, 0.003, -0.0135]} height={0.011} />
      <StarTracker position={[-0.0068, 0.0035, -0.011]} rotation={[0.35, 0, 0.35]} />
      {/* argon ion thruster with a faint glow */}
      <group position={[0, 0, 0.017]} rotation={[Math.PI / 2, 0, 0]}>
        <mesh>
          <cylinderGeometry args={[0.0028, 0.0018, 0.0045, 16, 1, true]} />
          <meshStandardMaterial color="#3a3d42" metalness={0.9} roughness={0.3} side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[0, -0.0012, 0]}>
          <sphereGeometry args={[0.0015, 12, 8]} />
          <meshBasicMaterial color="#7fd4ff" transparent opacity={0.55} toneMapped={false} />
        </mesh>
      </group>
      <Beacon color={color} />
    </group>
  );
}

function NavigationSat({ tex, color }: { tex: ReturnType<typeof useSatTextures>; color: string }) {
  return (
    <group>
      <mesh>
        <boxGeometry args={[0.018, 0.02, 0.018]} />
        <meshStandardMaterial map={tex.foil} color="#c8c8cc" metalness={0.7} roughness={0.4} />
      </mesh>
      <SolarWing panelTex={tex.panel} length={0.05} width={0.018} x={0.038} segments={2} />
      <SolarWing panelTex={tex.panel} length={0.05} width={0.018} x={-0.038} segments={2} />
      {/* L-band helical antenna array (nadir face) */}
      <group position={[0, -0.012, 0]}>
        {[[0, 0], [0.005, 0.003], [-0.005, 0.003], [0.005, -0.003], [-0.005, -0.003], [0, 0.006], [0, -0.006]].map(([x, z], i) => (
          <mesh key={i} position={[x, -0.0025, z]}>
            <coneGeometry args={[0.0016, 0.007, 8]} />
            <meshStandardMaterial color="#8d939c" metalness={0.75} roughness={0.35} />
          </mesh>
        ))}
        <mesh position={[0, 0.0005, 0]}>
          <boxGeometry args={[0.016, 0.001, 0.016]} />
          <meshStandardMaterial color="#55585e" metalness={0.7} roughness={0.45} />
        </mesh>
      </group>
      <StarTracker position={[0.006, 0.0105, -0.005]} rotation={[0.3, 0, -0.4]} />
      <Antenna position={[-0.006, 0.01, 0.006]} height={0.012} />
      <Beacon color={color} />
    </group>
  );
}

function ScienceSat({ tex, color }: { tex: ReturnType<typeof useSatTextures>; color: string }) {
  return (
    <group>
      {/* instrument bus */}
      <mesh>
        <cylinderGeometry args={[0.011, 0.011, 0.026, 16]} />
        <meshStandardMaterial map={tex.foil} color="#cfae4a" metalness={0.8} roughness={0.4} />
      </mesh>
      {/* telescope / sensor barrel */}
      <mesh position={[0, 0.017, 0]}>
        <cylinderGeometry args={[0.008, 0.0095, 0.012, 16]} />
        <meshStandardMaterial color="#23252a" metalness={0.5} roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.0232, 0]}>
        <cylinderGeometry args={[0.0072, 0.0072, 0.0006, 16]} />
        <meshStandardMaterial color="#05070d" metalness={0.2} roughness={0.25} emissive="#020308" />
      </mesh>
      <SolarWing panelTex={tex.panel} length={0.045} width={0.015} x={0.035} segments={2} />
      <SolarWing panelTex={tex.panel} length={0.045} width={0.015} x={-0.035} segments={2} />
      <HighGainDish position={[0, -0.017, 0.006]} rotation={[Math.PI, 0, 0]} radius={0.011} />
      {/* magnetometer boom */}
      <group position={[0, -0.004, -0.012]} rotation={[-Math.PI / 2.2, 0, 0]}>
        <mesh position={[0, 0.014, 0]}>
          <cylinderGeometry args={[0.0007, 0.0007, 0.028, 6]} />
          <meshStandardMaterial color="#9aa0a8" metalness={0.85} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0.029, 0]}>
          <boxGeometry args={[0.003, 0.003, 0.003]} />
          <meshStandardMaterial color="#c33" metalness={0.4} roughness={0.5} />
        </mesh>
      </group>
      <StarTracker position={[0.008, 0.006, 0.005]} rotation={[0.5, 0, -0.5]} />
      <Beacon color={color} />
    </group>
  );
}

function StationModel({ tex, color }: { tex: ReturnType<typeof useSatTextures>; color: string }) {
  return (
    <group>
      {/* central truss */}
      <mesh rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.003, 0.003, 0.09, 6]} />
        <meshStandardMaterial color="#b8bcc4" metalness={0.8} roughness={0.4} />
      </mesh>
      {/* truss segments (boxy lattice look) */}
      {[-0.032, -0.016, 0.016, 0.032].map((x) => (
        <mesh key={x} position={[x, 0, 0]}>
          <boxGeometry args={[0.005, 0.006, 0.006]} />
          <meshStandardMaterial color="#8f949c" metalness={0.75} roughness={0.45} />
        </mesh>
      ))}
      {/* pressurized modules along the flight axis */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.006, 0.006, 0.05, 16]} />
        <meshStandardMaterial map={tex.radiator} metalness={0.4} roughness={0.45} />
      </mesh>
      <mesh position={[0, 0, 0.028]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.0045, 0.006, 0.008, 16]} />
        <meshStandardMaterial color="#d3d6da" metalness={0.5} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.008, -0.01]} rotation={[0, 0, 0]}>
        <cylinderGeometry args={[0.004, 0.004, 0.014, 12]} />
        <meshStandardMaterial map={tex.foil} color="#d8b060" metalness={0.7} roughness={0.45} />
      </mesh>
      {/* four twin panel pairs on the truss */}
      {[-0.042, -0.026, 0.026, 0.042].map((x) => (
        <group key={x} position={[x, 0, 0]} rotation={[0.35, 0, 0]}>
          <mesh position={[0, 0, 0.017]}>
            <boxGeometry args={[0.011, 0.0012, 0.03]} />
            <meshStandardMaterial map={tex.panel} metalness={0.6} roughness={0.3} emissive="#0a1e45" emissiveIntensity={0.4} />
          </mesh>
          <mesh position={[0, 0, -0.017]}>
            <boxGeometry args={[0.011, 0.0012, 0.03]} />
            <meshStandardMaterial map={tex.panel} metalness={0.6} roughness={0.3} emissive="#0a1e45" emissiveIntensity={0.4} />
          </mesh>
        </group>
      ))}
      {/* thermal radiators */}
      <group position={[0.008, -0.006, 0]} rotation={[0, 0, -0.5]}>
        <mesh>
          <boxGeometry args={[0.02, 0.0008, 0.012]} />
          <meshStandardMaterial map={tex.radiator} metalness={0.3} roughness={0.5} side={THREE.DoubleSide} />
        </mesh>
      </group>
      <HighGainDish position={[0, -0.009, 0.02]} rotation={[Math.PI, 0.3, 0]} radius={0.006} />
      <Beacon color={color} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function SatelliteModel({
  category, color, scale = 1, spin = true,
}: { category: string; color: string; scale?: number; spin?: boolean }) {
  const groupRef = useRef<THREE.Group>(null);
  const tex = useSatTextures();

  useFrame((_, delta) => {
    if (groupRef.current && spin) {
      groupRef.current.rotation.y += delta * 0.35;
      groupRef.current.rotation.z += delta * 0.06;
    }
  });

  let Model = GenericCommSat;
  if (category === 'Space Station') Model = StationModel;
  else if (category === 'Starlink' || category === 'OneWeb') Model = StarlinkSat;
  else if (category === 'Navigation') Model = NavigationSat;
  else if (category === 'Science' || category === 'Weather') Model = ScienceSat;

  return (
    <group ref={groupRef} scale={scale}>
      <Model tex={tex} color={color} />
    </group>
  );
}
