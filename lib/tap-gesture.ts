// Tap vs. camera gesture — one arbiter for the whole scene.
//
// The problem, first seen on the globe and reported again in the solar view: the
// gesture that turns the camera STARTS by putting a finger (or a cursor) on
// something. In the Earth view that something was one of 10,000 satellite dots;
// in the solar view it is a planet's hit sphere, which is inflated to 1.5× the
// planet so tiny true-scale worlds stay clickable, or a moon's, at 2×. So every
// attempt to look around opened a detail card and re-aimed the camera.
//
// The rule: a press is a SELECTION only if it ends like a tap — released within
// `slop` px of where it started, inside TAP_MAX_MS, with no second pointer
// involved at any point. Anything else is a camera gesture and whatever was
// under the pointer is ignored.
//
// Two things need this, and they need it differently:
//
//   • r3f `onClick` handlers (planets, moons, probes, the Moon in the Earth
//     view). A native `click` still fires after a mouse drag whose press and
//     release both land on the canvas, so these handlers ask `wasTap()` — the
//     verdict on the release that just happened.
//   • instanced dot swarms (Satellites, EarthSwarm), which must remember WHICH
//     instance was pressed: the dots move, so by the time a slow tap is released
//     the pointer is no longer over the dot it pressed, and r3f's own hit test at
//     release would drop exactly those taps. Those use `useTapCandidate`, which
//     arms a payload on pointerdown and delivers it only if the release is a tap.
//
// Both are driven by ONE set of window listeners, in the capture phase, so the
// arbitration sees the raw gesture before r3f's canvas handlers do and cannot
// disagree with itself between two subsystems.

import { useEffect, useRef } from 'react';

/** Longer than this and it is a press, not a tap. */
export const TAP_MAX_MS = 450;
/** Mouse/trackpad: a few px of hand shake. */
export const TAP_SLOP_PX = 6;
/** Fingers and pens wobble far more, and a fingertip covers ~40 px. */
export const TAP_SLOP_PX_COARSE = 14;
/** How long a verdict stays answerable. A native `click` follows its `pointerup`
 *  within a frame or two; this is generous enough for a slow frame and far too
 *  short to let the next gesture inherit the last one's answer. */
const VERDICT_TTL_MS = 700;

function slopFor(pointerType: string): number {
  return pointerType === 'touch' || pointerType === 'pen' ? TAP_SLOP_PX_COARSE : TAP_SLOP_PX;
}

interface LivePointer {
  x: number;
  y: number;
  at: number;
  slop: number;
  /** Cleared the moment it drifts past slop — permanently. Re-entering the
   *  circle later must not resurrect a selection. */
  still: boolean;
}

const live = new Map<number, LivePointer>();
/** Any moment two pointers were down together, the whole gesture is a pinch and
 *  nothing in it may select. Latched until every pointer is up, so lifting the
 *  second finger first cannot turn the first one back into a tap. */
let sawMulti = false;
let verdict = { at: -Infinity, tap: false };

type ReleaseListener = (pointerId: number, tap: boolean) => void;
const releaseListeners = new Set<ReleaseListener>();

let refCount = 0;
let attached = false;

function onDown(e: PointerEvent) {
  live.set(e.pointerId, {
    x: e.clientX,
    y: e.clientY,
    at: performance.now(),
    slop: slopFor(e.pointerType),
    still: true,
  });
  if (live.size > 1) sawMulti = true;
}

function onMove(e: PointerEvent) {
  const p = live.get(e.pointerId);
  if (!p || !p.still) return;
  if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > p.slop) p.still = false;
}

function settle(pointerId: number, tap: boolean) {
  live.delete(pointerId);
  verdict = { at: performance.now(), tap };
  // Only once the hand is completely off the screen does a new gesture get a
  // clean slate.
  if (live.size === 0) sawMulti = false;
  for (const cb of releaseListeners) cb(pointerId, tap);
}

function onUp(e: PointerEvent) {
  const p = live.get(e.pointerId);
  if (!p) return;
  const tap =
    p.still &&
    !sawMulti &&
    performance.now() - p.at <= TAP_MAX_MS &&
    Math.hypot(e.clientX - p.x, e.clientY - p.y) <= p.slop;
  settle(e.pointerId, tap);
}

function onCancel(e: PointerEvent) {
  if (live.has(e.pointerId)) settle(e.pointerId, false);
}

function onBlur() {
  const ids = [...live.keys()];
  live.clear();
  sawMulti = false;
  verdict = { at: performance.now(), tap: false };
  for (const id of ids) for (const cb of releaseListeners) cb(id, false);
}

function attach() {
  if (attached || typeof window === 'undefined') return;
  attached = true;
  // Capture phase: this must see the gesture before r3f's handlers on the canvas.
  window.addEventListener('pointerdown', onDown, { passive: true, capture: true });
  window.addEventListener('pointermove', onMove, { passive: true, capture: true });
  window.addEventListener('pointerup', onUp, { passive: true, capture: true });
  window.addEventListener('pointercancel', onCancel, { passive: true, capture: true });
  window.addEventListener('blur', onBlur);
}

function detach() {
  if (!attached) return;
  attached = false;
  window.removeEventListener('pointerdown', onDown, { capture: true });
  window.removeEventListener('pointermove', onMove, { capture: true });
  window.removeEventListener('pointerup', onUp, { capture: true });
  window.removeEventListener('pointercancel', onCancel, { capture: true });
  window.removeEventListener('blur', onBlur);
  live.clear();
  sawMulti = false;
}

/** Keep the arbiter running for as long as this component is mounted.
 *  Ref-counted, so any number of scene components share one set of listeners. */
export function useTapTracking() {
  useEffect(() => {
    refCount++;
    attach();
    return () => {
      refCount--;
      if (refCount <= 0) {
        refCount = 0;
        detach();
      }
    };
  }, []);
}

/**
 * Did the pointer release that produced the event being handled qualify as a
 * tap? Call it first in any r3f `onClick` that selects something:
 *
 *   onClick={(e) => { e.stopPropagation(); if (!wasTap()) return; select(); }}
 *
 * `stopPropagation` stays OUTSIDE the guard on purpose: a camera drag over a
 * moon must still not fall through and select the planet behind it.
 */
export function wasTap(): boolean {
  return verdict.tap && performance.now() - verdict.at <= VERDICT_TTL_MS;
}

/**
 * For pickers that must capture WHAT was pressed at press time — instanced dot
 * swarms, whose instances have moved on by the time the finger lifts.
 *
 * Returns an `arm` function to call from `onPointerDown` with the payload to
 * deliver. `onTap` runs only if that same pointer's release is a tap; every
 * other outcome (drift, hold, second finger, cancel) silently drops it.
 */
export function useTapCandidate<T>(onTap: (payload: T) => void) {
  useTapTracking();
  const candidateRef = useRef<{ pointerId: number; payload: T } | null>(null);
  const onTapRef = useRef(onTap);
  onTapRef.current = onTap;

  useEffect(() => {
    const listener: ReleaseListener = (pointerId, tap) => {
      const c = candidateRef.current;
      if (!c || c.pointerId !== pointerId) return;
      candidateRef.current = null;
      if (tap) onTapRef.current(c.payload);
    };
    releaseListeners.add(listener);
    return () => { releaseListeners.delete(listener); };
  }, []);

  return function arm(e: { pointerId: number }, payload: T) {
    candidateRef.current = { pointerId: e.pointerId, payload };
  };
}
