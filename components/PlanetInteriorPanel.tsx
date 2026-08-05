'use client';

// Interior cross-section explorer: a full-screen modal that pairs the 3D
// cutaway (components/PlanetCutaway.tsx) with the measured numbers behind it
// (lib/planet-interiors.ts).
//
// The two halves are one instrument, not a picture next to a table. Hovering or
// tapping a layer row spotlights that shell in the 3D view and fades the rest;
// the depth ruler down the side is drawn at the layer's TRUE fractional radius,
// so a glance at the ruler and a glance at the globe agree.
//
// Every figure shown here is sourced. Boundaries that are model estimates
// rather than measurements are marked MODEL, and the source line for the body
// is printed at the bottom — because "Mars's core is 1,830 km" is a real
// seismic measurement while "Venus's inner core is 1,200 km" is not.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { X, Layers, Thermometer, Gauge, Ruler, BookOpen, Hand } from 'lucide-react';
import { PlanetCutaway } from './PlanetCutaway';
import {
  PlanetInterior, InteriorLayer,
  layerFraction, layerThicknessKm, layerDepthKm, layerVolumeFraction,
  stateLabel, formatTempK, formatPressure,
} from '@/lib/planet-interiors';

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------

const CUTAWAY_RADIUS = 1;

/** Lighting rig for the cutaway. A key light off to one side is what makes the
 *  bump maps read as material; the fill keeps the deep shells from going black,
 *  and a dim point light INSIDE the wedge lights the exposed cross-sections
 *  from the cavity the way a real cut model on a stand would be lit. */
function CutawayLights() {
  return (
    <>
      <ambientLight intensity={0.34} />
      <hemisphereLight args={['#9fc4ff', '#2b1c14', 0.35]} />
      <directionalLight position={[3.2, 2.4, 3.6]} intensity={1.65} />
      <directionalLight position={[-3.4, -1.2, -2.2]} intensity={0.42} color="#7fa8ff" />
      <pointLight position={[0.9, 0.15, 0.9]} intensity={0.7} distance={4} decay={2} color="#ffd9a8" />
    </>
  );
}

function CutawayScene({
  interior, surfaceTexture, highlightIndex, spin, orientRef, cutDeg,
}: {
  interior: PlanetInterior;
  surfaceTexture: THREE.Texture | null;
  highlightIndex: number | null;
  spin: boolean;
  orientRef: React.MutableRefObject<{ yaw: number; pitch: number }>;
  cutDeg: number;
}) {
  return (
    <>
      <CutawayLights />
      <PlanetCutaway
        interior={interior}
        radius={CUTAWAY_RADIUS}
        surfaceTexture={surfaceTexture}
        cutDeg={cutDeg}
        highlightIndex={highlightIndex}
        spin={spin}
        orientRef={orientRef}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Depth ruler — layers at true fractional radius
// ---------------------------------------------------------------------------

/** Vertical scale bar: the planet's radius from centre (bottom) to surface
 *  (top), with each layer drawn at the exact fraction of the radius it really
 *  occupies. This is the piece that makes "Earth's crust is a rounding error"
 *  and "Mercury's core is most of the planet" visible at a glance. */
function DepthRuler({
  interior, highlightIndex, onSelect,
}: {
  interior: PlanetInterior;
  highlightIndex: number | null;
  /** Click, never hover — see the note on the panel's `selected` state. */
  onSelect: (i: number) => void;
}) {
  return (
    <div className="flex items-stretch gap-1.5 h-full">
      <div className="relative w-4 rounded-full overflow-hidden border border-white/15 bg-black/50 shrink-0">
        {interior.layers.map((layer, i) => {
          const top = 1 - layerFraction(interior, layer);
          const bottom = 1 - (i === 0 ? 0 : layerFraction(interior, interior.layers[i - 1]));
          const dim = highlightIndex !== null && highlightIndex !== i;
          return (
            <button
              key={layer.name}
              onClick={() => onSelect(i)}
              aria-label={`${layer.name} — ${(layerFraction(interior, layer) * 100).toFixed(1)}% of radius`}
              aria-pressed={highlightIndex === i}
              className="absolute inset-x-0 transition-opacity cursor-pointer"
              style={{
                top: `${top * 100}%`,
                height: `${(bottom - top) * 100}%`,
                backgroundColor: layer.color,
                opacity: dim ? 0.3 : 1,
                boxShadow: highlightIndex === i ? `0 0 10px ${layer.color}` : undefined,
              }}
            />
          );
        })}
      </div>
      <div className="relative w-9 shrink-0 text-[7px] font-mono text-gray-500 leading-none">
        <span className="absolute top-0 left-0">SURFACE</span>
        <span className="absolute bottom-0 left-0">CENTRE</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One layer row
// ---------------------------------------------------------------------------

function LayerRow({
  interior, layer, index, active, dimmed, onToggle,
}: {
  interior: PlanetInterior;
  layer: InteriorLayer;
  index: number;
  active: boolean;
  dimmed: boolean;
  onToggle: (i: number) => void;
}) {
  const thickness = layerThicknessKm(interior, index);
  const depth = layerDepthKm(interior, index);
  const radiusPct = layerFraction(interior, layer) * 100;
  const volumePct = layerVolumeFraction(interior, index) * 100;

  return (
    <div
      onClick={() => onToggle(index)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(index); } }}
      aria-pressed={active}
      className={`rounded-xl border p-2.5 transition-all cursor-pointer ${
        active
          ? 'bg-white/[0.09] border-white/25 shadow-[0_0_18px_-6px_rgba(255,255,255,0.35)]'
          : dimmed
            ? 'bg-white/[0.02] border-white/5 opacity-55'
            : 'bg-white/[0.04] border-white/10 hover:bg-white/[0.07] hover:border-white/20'
      }`}
      style={active ? { borderColor: `${layer.color}88` } : undefined}
    >
      {/* Name, state, and the swatch that ties the row to the shell */}
      <div className="flex items-start gap-2">
        <span
          className="w-3 h-3 rounded-sm mt-0.5 shrink-0 border border-white/25"
          style={{ backgroundColor: layer.color, boxShadow: active ? `0 0 8px ${layer.color}` : undefined }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <h4 className="text-[11px] font-bold font-mono text-white leading-tight">{layer.name}</h4>
            <span className="text-[8px] font-mono uppercase tracking-widest text-gray-500">
              {stateLabel(layer.state)}
            </span>
            {layer.estimated && (
              <span
                className="text-[7px] font-mono uppercase tracking-widest text-amber-400/90 border border-amber-400/30 rounded px-1 py-px"
                title="This boundary comes from an interior model, not a direct measurement"
              >
                MODEL
              </span>
            )}
          </div>
          <p className="text-[9.5px] font-mono text-gray-400 leading-snug mt-0.5">{layer.composition}</p>
        </div>
        <span className="text-[9px] font-mono text-gray-500 shrink-0 tabular-nums">
          {radiusPct.toFixed(1)}% R
        </span>
      </div>

      {/* The numbers. Thickness and depth answer "where is it", temperature and
          pressure answer "what is it like there". */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-1 mt-2 text-[9px] font-mono">
        <div className="flex items-center gap-1 text-gray-300">
          <Ruler className="w-2.5 h-2.5 text-cyan-400 shrink-0" />
          <span className="text-gray-500">Thick</span>
          <span className="tabular-nums">{thickness.toLocaleString(undefined, { maximumFractionDigits: 0 })} km</span>
        </div>
        <div className="flex items-center gap-1 text-gray-300">
          <Layers className="w-2.5 h-2.5 text-violet-400 shrink-0" />
          <span className="text-gray-500">Vol</span>
          <span className="tabular-nums">{volumePct < 0.1 ? '<0.1' : volumePct.toFixed(1)}%</span>
        </div>
        <div className="flex items-center gap-1 text-gray-300">
          <Thermometer className="w-2.5 h-2.5 text-orange-400 shrink-0" />
          <span className="tabular-nums" title={`${layer.tempK[0].toLocaleString()} K at the base, ${layer.tempK[1].toLocaleString()} K at the top`}>
            {formatTempK(layer.tempK[1])} → {formatTempK(layer.tempK[0])}
          </span>
        </div>
        <div className="flex items-center gap-1 text-gray-300">
          <Gauge className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
          <span className="tabular-nums" title="Pressure at the top and base of this layer">
            {formatPressure(layer.pressureGPa[1])} → {formatPressure(layer.pressureGPa[0])}
          </span>
        </div>
        <div className="col-span-2 flex items-center gap-1 text-gray-400">
          <span className="text-gray-500">Boundary depth</span>
          <span className="tabular-nums">
            {depth === 0 ? 'the surface' : `${depth.toLocaleString(undefined, { maximumFractionDigits: 0 })} km down`}
          </span>
        </div>
      </div>

      {/* The physics note — only for the layer being inspected, so the list
          stays scannable until you ask for depth on one row. */}
      {active && (
        <p className="text-[9.5px] font-mono text-gray-300 leading-relaxed mt-2 pt-2 border-t border-white/10">
          {layer.note}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function PlanetInteriorPanel({
  interior, textureUrl, onClose,
}: {
  interior: PlanetInterior;
  /** The planet's real surface photo, painted on the outermost shell. */
  textureUrl?: string;
  onClose: () => void;
}) {
  // Selection is CLICK-ONLY. It used to preview on hover as well, which read as
  // the panel choosing for you: sliding the mouse across the sidebar on the way
  // to the close button re-highlighted a different shell on every row it
  // crossed, and the 3D cutaway re-lit each time. Nothing hovers itself into
  // selection now — one click selects, clicking the same row again clears.
  const [selected, setSelected] = useState<number | null>(null);
  const highlightIndex = selected;
  const toggleLayer = (i: number) => setSelected((p) => (p === i ? null : i));
  const [spin, setSpin] = useState(true);
  const [cutDeg, setCutDeg] = useState(95);

  // Drag-to-rotate, written straight into a ref: the cutaway reads it every
  // frame, so a drag never re-renders this panel or its 6 shells.
  const orientRef = useRef({ yaw: 0, pitch: 0.18 });
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const surfaceTexture = useMemo(() => {
    if (!textureUrl) return null;
    const t = new THREE.TextureLoader().load(textureUrl);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, [textureUrl]);

  const measured = interior.layers.filter((l) => !l.estimated).length;

  // While this panel is up, silence the floating scene name tags. The planet you
  // opened it from stays selected, so its label stays mounted out in the main
  // canvas — and because those labels are DOM rather than WebGL, the translucent
  // scrim below does not hide them: the planet's name read straight through the
  // panel, right next to the same name printed in this header. See the
  // .scene-labels-hidden rule in app/globals.css.
  //
  // A body class rather than a prop threaded down to every label: the labels sit
  // in a different React tree from this modal (drei portals them into the canvas
  // wrapper), so the DOM is where the two actually meet.
  useEffect(() => {
    document.body.classList.add('scene-labels-hidden');
    return () => document.body.classList.remove('scene-labels-hidden');
  }, []);

  return (
    <div className="fixed inset-0 z-[55] flex items-center justify-center p-2 sm:p-4 pointer-events-auto">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />

      <div className="relative w-full max-w-5xl h-[min(92dvh,52rem)] bg-black/85 backdrop-blur-2xl border border-white/15 rounded-2xl shadow-2xl glass-panel flex flex-col overflow-hidden animate-fade-up">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-3 sm:p-4 border-b border-white/10 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span className="text-[9px] font-mono font-bold uppercase tracking-widest text-cyan-400">
                Interior cross-section
              </span>
            </div>
            <h2 className="text-lg sm:text-2xl font-bold font-mono text-white leading-tight">
              {interior.planet}
            </h2>
            <p className="text-[9.5px] font-mono text-gray-400 mt-0.5">
              {interior.layers.length} layers · radius {interior.radiusKm.toLocaleString()} km ·{' '}
              {measured === 0
                ? 'every boundary is a model estimate'
                : `${measured} of ${interior.layers.length} boundaries measured`}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close interior view"
            className="text-gray-400 hover:text-white p-1.5 rounded-full hover:bg-white/10 transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body: 3D on the left, the layer stack on the right. Stacks on
            mobile, where the canvas takes a fixed slice of the height. */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row">

          {/* --- 3D cutaway --- */}
          <div className="relative h-[38%] md:h-auto md:flex-1 min-h-0 border-b md:border-b-0 md:border-r border-white/10">
            <div
              className={`absolute inset-0 ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
              onPointerDown={(e) => {
                dragRef.current = { x: e.clientX, y: e.clientY };
                setDragging(true);
                setSpin(false);
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              }}
              onPointerMove={(e) => {
                const d = dragRef.current;
                if (!d) return;
                const o = orientRef.current;
                o.yaw += (e.clientX - d.x) * 0.008;
                // Clamped so the model can't be tipped past the poles, where a
                // cutaway stops reading as a cutaway.
                o.pitch = Math.max(-1.2, Math.min(1.2, o.pitch + (e.clientY - d.y) * 0.006));
                dragRef.current = { x: e.clientX, y: e.clientY };
              }}
              onPointerUp={() => { dragRef.current = null; setDragging(false); }}
              onPointerLeave={() => { dragRef.current = null; setDragging(false); }}
            >
              <Canvas
                camera={{ position: [0, 0.55, 2.75], fov: 42 }}
                dpr={[1, 2]}
                gl={{ antialias: true, alpha: true }}
              >
                <CutawayScene
                  interior={interior}
                  surfaceTexture={surfaceTexture}
                  highlightIndex={highlightIndex}
                  spin={spin}
                  orientRef={orientRef}
                  cutDeg={cutDeg}
                />
              </Canvas>
            </div>

            {/* Depth ruler, overlaid on the canvas so the scale sits beside the
                thing it measures. */}
            <div className="absolute left-2 top-3 bottom-14 pointer-events-auto">
              <DepthRuler interior={interior} highlightIndex={highlightIndex} onSelect={toggleLayer} />
            </div>

            {/* Viewer controls */}
            <div className="absolute bottom-2 left-2 right-2 flex items-center gap-2 flex-wrap pointer-events-auto">
              <button
                onClick={() => setSpin((s) => !s)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[9px] font-mono font-bold tracking-widest border chip-btn ${
                  spin
                    ? 'bg-cyan-500/20 border-cyan-400/45 text-cyan-300'
                    : 'bg-black/60 border-white/15 text-gray-400 hover:text-white'
                }`}
              >
                {spin ? 'SPINNING' : 'PAUSED'}
              </button>
              <label className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-black/60 border border-white/15 text-[9px] font-mono text-gray-400">
                CUT
                <input
                  type="range"
                  min={35}
                  max={170}
                  step={5}
                  value={cutDeg}
                  onChange={(e) => setCutDeg(Number(e.target.value))}
                  className="w-16 sm:w-24 accent-cyan-400"
                  aria-label="Size of the wedge cut out of the planet"
                />
                <span className="tabular-nums text-gray-300">{cutDeg}°</span>
              </label>
              <span className="hidden sm:flex items-center gap-1 text-[8px] font-mono text-gray-500">
                <Hand className="w-2.5 h-2.5" /> drag to rotate
              </span>
            </div>
          </div>

          {/* --- Layer stack --- */}
          <div className="flex-1 md:flex-none md:w-[22rem] lg:w-[25rem] min-h-0 overflow-y-auto custom-scrollbar p-2.5 sm:p-3 space-y-1.5">
            <p className="text-[9px] font-mono text-gray-500 uppercase tracking-widest px-0.5">
              Surface → centre · tap a layer for the physics
            </p>
            {/* Outermost first: this is the order you'd meet the layers if you
                drilled down, which is how everyone reads a cross-section. */}
            {interior.layers
              .map((layer, index) => ({ layer, index }))
              .reverse()
              .map(({ layer, index }) => (
                <LayerRow
                  key={layer.name}
                  interior={interior}
                  layer={layer}
                  index={index}
                  active={highlightIndex === index}
                  dimmed={highlightIndex !== null && highlightIndex !== index}
                  onToggle={toggleLayer}
                />
              ))}

            {/* Provenance. A cross-section without its source is decoration. */}
            <div className="flex gap-1.5 items-start bg-white/[0.03] border border-white/5 rounded-xl p-2.5 mt-1">
              <BookOpen className="w-3 h-3 text-gray-500 shrink-0 mt-0.5" />
              <div>
                <div className="text-[8px] font-mono uppercase tracking-widest text-gray-500">Sources</div>
                <p className="text-[9px] font-mono text-gray-400 leading-snug mt-0.5">{interior.source}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
