'use client';

// Realistic 3D interior cutaway for any planet.
//
// A wedge is removed from the globe (an azimuthal slice), exposing every
// interior shell at its TRUE fractional radius — the core of Mercury really
// does reach 83% of the way out, and Earth's crust really is thinner than the
// line used to draw it. Nothing is scaled "for clarity".
//
// The surfaces are not flat colours: each layer is painted with a procedural
// material generated from fractal value noise — mottled rock, granular hot
// metal, turbulent melt, fractured superionic ice, banded fluid envelopes —
// with a matching bump map so the shells catch light like material rather than
// like a pie chart. The outermost layer uses the planet's real photographic
// texture when one is supplied.

import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { PlanetInterior, InteriorLayer, LayerTexture } from '@/lib/planet-interiors';

// ---------------------------------------------------------------------------
// Procedural material generation
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tiling value-noise sampler on a `size`×`size` lattice. Because every octave
 *  frequency is a multiple of `size`, the result wraps seamlessly — no visible
 *  seam where the texture meets itself around the sphere. */
function makeNoise(size: number, rnd: () => number) {
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const i0 = ((xi % size) + size) % size;
    const i1 = (i0 + 1) % size;
    const j0 = ((yi % size) + size) % size;
    const j1 = (j0 + 1) % size;
    const a = g[j0 * size + i0];
    const b = g[j0 * size + i1];
    const c = g[j1 * size + i0];
    const d = g[j1 * size + i1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

type Sampler = (x: number, y: number) => number;

/** Fractal Brownian motion — the standard "natural material" noise stack. */
function fbm(n: Sampler, x: number, y: number, octaves: number, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * n(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= 2;
  }
  return sum / norm;
}

/** Ridged noise — sharp creases. Fractures, cracks, veins. */
function ridged(n: Sampler, x: number, y: number, octaves: number): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const r = 1 - Math.abs(2 * n(x * freq, y * freq) - 1);
    sum += amp * r * r;
    norm += amp;
    amp *= 0.55;
    freq *= 2;
  }
  return sum / norm;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

interface LayerMaterialSet {
  map: THREE.Texture;
  bump: THREE.Texture;
}

const MAT_CACHE = new Map<string, LayerMaterialSet>();

const TEX_W = 512;
const TEX_H = 256;
const LATTICE = 8;

/** Paint one layer's colour + bump texture. Everything is derived from the
 *  layer's own base colour, so each planet keeps its real palette. */
function buildLayerTexture(kind: LayerTexture, baseHex: string): LayerMaterialSet {
  const key = `${kind}|${baseHex}`;
  const cached = MAT_CACHE.get(key);
  if (cached) return cached;

  const base = new THREE.Color(baseHex);
  // Deterministic seed from the colour so the same layer always looks the same
  // between renders (and between the panel and the in-scene cutaway).
  let seed = 0;
  for (let i = 0; i < key.length; i++) seed = (seed * 31 + key.charCodeAt(i)) >>> 0;
  const rnd = mulberry32(seed);
  const n1 = makeNoise(LATTICE, rnd);
  const n2 = makeNoise(LATTICE, rnd);

  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(TEX_W, TEX_H);
  const px = img.data;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = TEX_W;
  bumpCanvas.height = TEX_H;
  const bctx = bumpCanvas.getContext('2d')!;
  const bimg = bctx.createImageData(TEX_W, TEX_H);
  const bpx = bimg.data;

  for (let y = 0; y < TEX_H; y++) {
    // Latitude compression: squeeze noise toward the poles so features don't
    // smear into radial streaks where the UV mapping pinches.
    const v = y / TEX_H;
    for (let x = 0; x < TEX_W; x++) {
      const u = x / TEX_W;
      const nx = u * LATTICE;
      const ny = v * LATTICE;

      let r = base.r;
      let g = base.g;
      let b = base.b;
      let bump = 0.5;

      switch (kind) {
        case 'rock': {
          // Mottled mineral grain with a network of darker fractures.
          const m = fbm(n1, nx * 2, ny * 2, 5);
          const cracks = ridged(n2, nx * 1.5, ny * 1.5, 4);
          const crackMask = clamp01((cracks - 0.72) * 4);
          const shade = 0.62 + 0.72 * m;
          const dark = 1 - 0.55 * crackMask;
          r *= shade * dark;
          g *= shade * dark;
          b *= shade * dark;
          // occasional bright mineral speckle
          const spec = fbm(n2, nx * 9, ny * 9, 2);
          if (spec > 0.86) {
            const k = (spec - 0.86) * 5;
            r += k * 0.22; g += k * 0.2; b += k * 0.17;
          }
          bump = clamp01(m * 0.85 + crackMask * -0.4 + 0.2);
          break;
        }
        case 'metal': {
          // Incandescent crystalline iron: fine granular structure, bright
          // grain boundaries, a hot white-yellow bias.
          const grain = fbm(n1, nx * 5, ny * 5, 4, 0.55);
          const bounds = ridged(n2, nx * 4, ny * 4, 3);
          const bMask = clamp01((bounds - 0.6) * 3);
          const glow = 0.7 + 0.55 * grain + 0.55 * bMask;
          r = clamp01(r * glow + 0.14 * bMask);
          g = clamp01(g * glow + 0.10 * bMask);
          b = clamp01(b * glow * 0.94);
          bump = clamp01(0.35 + grain * 0.5 + bMask * 0.3);
          break;
        }
        case 'molten': {
          // Turbulent melt: dark crust plates torn apart by glowing channels.
          const warp = fbm(n2, nx * 1.4, ny * 1.4, 3);
          const flow = fbm(n1, nx * 3 + warp * 3, ny * 2.2 + warp * 2, 5, 0.55);
          const hot = clamp01((flow - 0.42) * 2.3);
          const cool = 1 - hot;
          r = clamp01(r * (0.45 + 0.9 * hot) + 0.55 * hot * hot);
          g = clamp01(g * (0.32 + 0.85 * hot) + 0.30 * hot * hot * hot);
          b = clamp01(b * (0.28 + 0.5 * hot) + 0.06 * hot * hot * hot);
          r *= 0.55 + 0.45 * (1 - cool * 0.6);
          bump = clamp01(0.3 + flow * 0.6);
          break;
        }
        case 'ice': {
          // Superionic / high-pressure ice: glassy body shot through with
          // bright crystalline fracture planes.
          const body = fbm(n1, nx * 2.2, ny * 2.2, 5);
          const frac = ridged(n2, nx * 3.2, ny * 3.2, 4);
          const fMask = clamp01((frac - 0.66) * 3.4);
          const shade = 0.68 + 0.6 * body;
          r = clamp01(r * shade + 0.42 * fMask);
          g = clamp01(g * shade + 0.5 * fMask);
          b = clamp01(b * shade + 0.55 * fMask);
          bump = clamp01(0.4 + body * 0.35 + fMask * 0.45);
          break;
        }
        case 'fluid': {
          // Convecting envelope: latitudinal bands smeared by turbulence.
          const turb = fbm(n2, nx * 1.8, ny * 1.6, 4) - 0.5;
          const bands = Math.sin((v * 13 + turb * 1.9) * Math.PI * 2) * 0.5 + 0.5;
          const detail = fbm(n1, nx * 4 + turb * 2, ny * 3, 4);
          const shade = 0.66 + 0.42 * bands + 0.34 * detail;
          r = clamp01(r * shade);
          g = clamp01(g * shade);
          b = clamp01(b * shade);
          bump = clamp01(0.35 + bands * 0.3 + detail * 0.3);
          break;
        }
        case 'gas': {
          // Soft cloud decks — wide bands, gentle turbulence, no hard edges.
          const turb = fbm(n2, nx * 1.2, ny * 1.1, 4) - 0.5;
          const bands = Math.sin((v * 8 + turb * 1.2) * Math.PI * 2) * 0.5 + 0.5;
          const wisp = fbm(n1, nx * 3.4 + turb * 1.4, ny * 1.6, 3);
          const shade = 0.74 + 0.3 * bands + 0.24 * wisp;
          r = clamp01(r * shade + 0.06 * bands);
          g = clamp01(g * shade + 0.05 * bands);
          b = clamp01(b * shade + 0.04 * bands);
          bump = clamp01(0.45 + bands * 0.18 + wisp * 0.2);
          break;
        }
      }

      const o = (y * TEX_W + x) * 4;
      px[o] = clamp01(r) * 255;
      px[o + 1] = clamp01(g) * 255;
      px[o + 2] = clamp01(b) * 255;
      px[o + 3] = 255;

      const bv = bump * 255;
      bpx[o] = bv;
      bpx[o + 1] = bv;
      bpx[o + 2] = bv;
      bpx[o + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  bctx.putImageData(bimg, 0, 0);

  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.anisotropy = 4;
  map.colorSpace = THREE.SRGBColorSpace;

  const bump = new THREE.CanvasTexture(bumpCanvas);
  bump.wrapS = THREE.RepeatWrapping;
  bump.wrapT = THREE.ClampToEdgeWrapping;

  const set = { map, bump };
  MAT_CACHE.set(key, set);
  return set;
}

/** Surface finish per material class — what actually sells "rock" vs "metal". */
const FINISH: Record<LayerTexture, { roughness: number; metalness: number; bumpScale: number }> = {
  rock:  { roughness: 0.95, metalness: 0.04, bumpScale: 0.055 },
  metal: { roughness: 0.34, metalness: 0.85, bumpScale: 0.030 },
  molten:{ roughness: 0.52, metalness: 0.30, bumpScale: 0.040 },
  ice:   { roughness: 0.28, metalness: 0.08, bumpScale: 0.035 },
  fluid: { roughness: 0.60, metalness: 0.14, bumpScale: 0.025 },
  gas:   { roughness: 0.88, metalness: 0.00, bumpScale: 0.015 },
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** One interior shell: the spherical band of its outer boundary, plus the two
 *  flat annular faces where the wedge cut it open. */
function LayerShell({
  layer, innerR, outerR, phiStart, phiLength, surfaceMap, dim, highlight,
}: {
  layer: InteriorLayer;
  innerR: number;
  outerR: number;
  phiStart: number;
  phiLength: number;
  surfaceMap: THREE.Texture | null;
  dim: boolean;
  highlight: boolean;
}) {
  const tex = useMemo(() => buildLayerTexture(layer.texture, layer.color), [layer.texture, layer.color]);
  const finish = FINISH[layer.texture];

  // Cut faces sit in the two half-planes bounding the removed wedge. A ring in
  // the XY plane spanning theta ∈ [-π/2, π/2] is the pole-to-pole half-annulus;
  // rotating it about Y by (π + φ) lands its local +X on the sphere's φ edge.
  const faceInner = Math.max(innerR, 1e-4);

  const emissive = new THREE.Color(layer.color);
  const emissiveIntensity =
    (layer.emissive ?? 0) * (highlight ? 1.55 : 1) + (highlight ? 0.28 : 0);
  const opacity = dim ? 0.28 : 1;

  return (
    <group>
      {/* Outer spherical boundary of this layer. DoubleSide so the inside of
          the shell is drawn when you look into the wedge. */}
      <mesh>
        <sphereGeometry args={[outerR, 96, 64, phiStart, phiLength]} />
        <meshStandardMaterial
          map={surfaceMap ?? tex.map}
          bumpMap={surfaceMap ? undefined : tex.bump}
          bumpScale={finish.bumpScale}
          roughness={finish.roughness}
          metalness={finish.metalness}
          emissive={emissive}
          emissiveIntensity={emissiveIntensity}
          transparent={dim}
          opacity={opacity}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* The two exposed cross-sections. These are the whole point of a
          cutaway — the flat faces where you read the layering off directly. */}
      {[phiStart, phiStart + phiLength].map((phi, i) => (
        <mesh key={i} rotation={[0, Math.PI + phi, 0]}>
          <ringGeometry args={[faceInner, outerR, 64, 1, -Math.PI / 2, Math.PI]} />
          <meshStandardMaterial
            map={tex.map}
            bumpMap={tex.bump}
            bumpScale={finish.bumpScale * 0.6}
            roughness={Math.min(1, finish.roughness + 0.08)}
            metalness={finish.metalness * 0.8}
            emissive={emissive}
            emissiveIntensity={emissiveIntensity * 0.9 + 0.06}
            transparent={dim}
            opacity={opacity}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface PlanetCutawayProps {
  interior: PlanetInterior;
  /** Radius to draw the whole planet at, in scene units. */
  radius: number;
  /** Real photographic texture for the outermost layer, if available. */
  surfaceTexture?: THREE.Texture | null;
  /** Azimuthal wedge removed, degrees. 90° shows a clean quarter cut. */
  cutDeg?: number;
  /** Index of the layer to spotlight; every other layer fades back. */
  highlightIndex?: number | null;
  /** Auto-rotate. */
  spin?: boolean;
  spinSpeed?: number;
  /** Extra orientation applied by the host (drag-to-rotate). Read every frame
   *  from a ref so dragging never re-renders the React tree. */
  orientRef?: React.MutableRefObject<{ yaw: number; pitch: number }>;
  /** Static fallback when no ref is supplied. */
  yaw?: number;
  pitch?: number;
}

export function PlanetCutaway({
  interior,
  radius,
  surfaceTexture = null,
  cutDeg = 95,
  highlightIndex = null,
  spin = true,
  spinSpeed = 0.16,
  orientRef,
  yaw = 0,
  pitch = 0,
}: PlanetCutawayProps) {
  const groupRef = useRef<THREE.Group>(null);
  const spinRef = useRef(0);

  const cut = (cutDeg * Math.PI) / 180;
  const phiLength = Math.PI * 2 - cut;
  // Start the visible span so the removed wedge faces the default camera.
  const phiStart = cut / 2;

  const shells = useMemo(() => {
    const scale = radius / interior.radiusKm;
    return interior.layers.map((layer, i) => ({
      layer,
      index: i,
      innerR: (i === 0 ? 0 : interior.layers[i - 1].outerKm) * scale,
      outerR: layer.outerKm * scale,
    }));
  }, [interior, radius]);

  useFrame((_state, delta) => {
    const g = groupRef.current;
    if (!g) return;
    if (spin) spinRef.current += delta * spinSpeed;
    const o = orientRef?.current;
    g.rotation.set(o ? o.pitch : pitch, spinRef.current + (o ? o.yaw : yaw), 0);
  });

  return (
    <group ref={groupRef}>
      {shells.map(({ layer, index, innerR, outerR }) => (
        <LayerShell
          key={layer.name}
          layer={layer}
          innerR={innerR}
          outerR={outerR}
          phiStart={phiStart}
          phiLength={phiLength}
          // Only the outermost shell wears the real planet photo.
          surfaceMap={index === shells.length - 1 ? surfaceTexture : null}
          dim={highlightIndex !== null && highlightIndex !== index}
          highlight={highlightIndex === index}
        />
      ))}
    </group>
  );
}
