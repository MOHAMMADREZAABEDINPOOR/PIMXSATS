// Gesture comfort settings.
//
// The camera controller itself lives in lib/orbit-controls.ts; this module
// only decides how hard it should respond, given the device the user actually
// has and the preset they picked.
//
// Historically this file patched three-stdlib's TrackballControls in place —
// scaling down its rotate/zoom/pan steps from a per-frame tuning record. That
// could only ever attenuate a badly-shaped signal: the underlying control still
// panned during every pinch and still orbited a pivot on the far side of the
// solar system. SmoothControls fixes the signal, so all that is left here is
// taste.
//
// FOUR device classes, not two. The old touch/mouse split was too coarse in both
// directions, and the symptom was zoom that was either useless or violent:
//
//   • phone vs tablet — the same swipe crosses a 390 px edge and a 1024 px one.
//     Rotation is normalised per edge so that part is handled, but a phone is
//     held in the hands it is being dragged by, so it needs a bigger dead zone,
//     a tighter per-frame cap and a calmer pinch than a tablet lying on a desk.
//   • laptop vs desktop — this is the big one, and it is a difference of INPUT
//     HARDWARE, not of screen size. A desktop mouse wheel emits discrete ~120 px
//     notches, a handful per second. A laptop trackpad emits a continuous stream
//     of small deltas at display rate, plus inertial momentum after the fingers
//     lift. Feeding both through one gain means whatever is comfortable on the
//     wheel makes the trackpad rocket in and out. So the laptop class runs a much
//     smaller zoom gain with a tight per-frame log cap, and compensates with a
//     higher response so it still feels immediate rather than sluggish.
//
// Rotation and zoom are tuned independently per class; nothing here scales one
// from the other. On top of the per-class tables there is a per-VIEW trim
// (VIEW_TRIM, near the bottom): the Earth view is the reference at 1.0 and the
// solar view runs slower, because the same degrees-per-swipe and the same log
// step per notch cover far more of what the user sees out there.

import type { SmoothControlsGains } from './orbit-controls';

export type Sensitivity = 'calm' | 'standard' | 'fast';

/** The four input systems. Not a screen-size taxonomy — a taxonomy of how the
 *  zoom and rotate signals physically arrive. */
export type DeviceClass = 'phone' | 'tablet' | 'laptop' | 'desktop';

export const SENSITIVITY_OPTIONS: { id: Sensitivity; label: string; hint: string }[] = [
  { id: 'calm', label: 'Calm', hint: 'Slowest, steadiest — best on small screens' },
  { id: 'standard', label: 'Standard', hint: 'Balanced default' },
  { id: 'fast', label: 'Fast', hint: 'Quick sweeps, less damping' },
];

export const DEFAULT_SENSITIVITY: Sensitivity = 'standard';

export const DEVICE_CLASS_LABEL: Record<DeviceClass, string> = {
  phone: 'Phone',
  tablet: 'Tablet',
  laptop: 'Laptop trackpad',
  desktop: 'Mouse + wheel',
};

/** True on phones/tablets — anything whose primary pointer is a fingertip. */
export function isCoarsePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

/** Largest screen edge, in CSS px. Used only as a tie-breaker. */
function screenLongEdge(): number {
  if (typeof window === 'undefined' || !window.screen) return 1920;
  return Math.max(window.screen.width, window.screen.height);
}

function screenShortEdge(): number {
  if (typeof window === 'undefined' || !window.screen) return 1080;
  return Math.min(window.screen.width, window.screen.height);
}

/**
 * Which of the four systems is in front of us.
 *
 * There is no browser API for "is this a laptop", so this is a best guess from
 * the signals that do exist — and it is deliberately built so that every wrong
 * answer is a mild one:
 *
 *   • coarse pointer → a fingertip. Split phone/tablet on the SHORT screen edge:
 *     under 600 px is a phone (the largest phones are ~430 px wide; the smallest
 *     tablets are ~600 px), at or above it a tablet.
 *   • fine pointer + a touchscreen → a touch-screen laptop or a 2-in-1 in laptop
 *     mode. Trackpad tuning.
 *   • fine pointer, no touch, screen no wider than ~1700 px → almost certainly a
 *     laptop panel (1366/1440/1536/1680 are laptop widths; desktops are 1920 and
 *     up). Trackpad tuning, which is the safer of the two to be wrong about: a
 *     mouse user on trackpad gains scrolls a little less per notch, whereas a
 *     trackpad user on wheel gains gets flung.
 *   • otherwise → a desktop with a wheel.
 */
export function detectDeviceClass(): DeviceClass {
  if (isCoarsePointer()) {
    return screenShortEdge() < 600 ? 'phone' : 'tablet';
  }
  const touchCapable =
    typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0;
  if (touchCapable) return 'laptop';
  return screenLongEdge() <= 1700 ? 'laptop' : 'desktop';
}

/** Rotation, expressed as how far a swipe across the SHORT viewport edge turns
 *  the camera. Thinking in "degrees per full swipe" is the only way to keep
 *  this honest across a 390 px phone and a 2560 px monitor.
 *
 *  Touch classes sit below the pointer classes: a finger IS the cursor, so the
 *  scene rotating much further than the finger travelled reads as the camera
 *  outrunning the hand. A mouse has no such expectation — the cursor is already
 *  an abstraction — so it can afford a longer throw and wants one, since a mouse
 *  drag is limited by desk space. Laptop sits just under desktop because a
 *  trackpad drag is limited by the pad, which is smaller than a desk.
 *
 *  The PHONE row is doubled from what that reasoning first produced. Reported as
 *  "very, very annoying": on a 390 px screen a 42°/swipe throw means turning the
 *  camera a quarter turn takes three separate drags, each of which has to start
 *  outside a 10 px dead zone. The finger-tracking argument is real but it was
 *  being applied to a screen so small that "the same as the finger" is barely any
 *  rotation at all. A phone now gets the longest throw per swipe of any class,
 *  which is the honest conclusion: it has the least room to swipe in. */
const DEGREES_PER_SWIPE: Record<Sensitivity, Record<DeviceClass, number>> = {
  calm: { phone: 52, tablet: 32, laptop: 46, desktop: 55 },
  standard: { phone: 84, tablet: 50, laptop: 68, desktop: 78 },
  fast: { phone: 128, tablet: 76, laptop: 96, desktop: 110 },
};

/** Zoom gain — the multiplier on the log-space step from a pinch or a wheel/
 *  trackpad notch. Below 1 the camera moves less than the input suggests, which
 *  reads as control rather than as the scene being yanked.
 *
 *  The laptop row is the small one ON PURPOSE, and it is the point of this whole
 *  table: a trackpad delivers roughly an order of magnitude more zoom events per
 *  second than a wheel, so it needs a much smaller step per event to end up at
 *  the same speed under the hand.
 *
 *  The phone row is doubled for the same reason as the rotation row above — a
 *  pinch on a 390 px screen has perhaps 150 px of finger separation to work with,
 *  so a gain under 1 spends that whole travel going almost nowhere. */
const ZOOM_GAIN: Record<Sensitivity, Record<DeviceClass, number>> = {
  calm: { phone: 1.1, tablet: 0.45, laptop: 0.26, desktop: 0.7 },
  standard: { phone: 1.5, tablet: 0.62, laptop: 0.38, desktop: 0.95 },
  fast: { phone: 2.0, tablet: 0.85, laptop: 0.55, desktop: 1.25 },
};

/** Drain rate of the input smoother, 1/s. Lower = smoother and more glide.
 *  Touch gets the slowest response because finger data is far noisier than a
 *  pointer's and a released gesture should settle rather than sail on. Laptop
 *  sits between touch and desktop: it needs real smoothing to absorb trackpad
 *  momentum, but not so much that the small per-event steps feel laggy. */
const RESPONSE: Record<Sensitivity, Record<DeviceClass, number>> = {
  calm: { phone: 8, tablet: 9, laptop: 13, desktop: 20 },
  standard: { phone: 13, tablet: 15, laptop: 19, desktop: 26 },
  fast: { phone: 19, tablet: 21, laptop: 26, desktop: 32 },
};

/** Backstops, per class. Neither should ever be reached in normal use — they
 *  exist so that one absurd input sample (a touch driver glitch, a wheel that
 *  reports a whole page, a trackpad momentum spike) cannot throw the camera
 *  across the scene in a single frame.
 *
 *  The phone caps are doubled alongside the phone gains, and they HAD to be:
 *  neither of these two clamps is refunded to the pending buffer (see
 *  SmoothControls.update — the angle backstop is explicitly not refunded, and the
 *  zoom clamp is a plain min/max), so a doubled gain feeding an unchanged cap is
 *  not a faster camera, it is the same camera plus half the input thrown away.
 *  Doubling both keeps the same headroom ratio the other classes have, which is
 *  what makes them backstops rather than the thing setting the speed. */
const MAX_ANGLE_PER_FRAME: Record<DeviceClass, number> = {
  phone: 0.1, tablet: 0.07, laptop: 0.16, desktop: 0.25,
};

const MAX_ZOOM_LOG_PER_FRAME: Record<DeviceClass, number> = {
  phone: 0.14, tablet: 0.09, laptop: 0.1, desktop: 0.25,
};

/** Finger travel, in CSS px, before a one-finger gesture engages at all. Big
 *  enough that a tap — or the wobble of holding the phone — moves nothing. A
 *  tablet is usually steadier (propped, or held two-handed) so it can be a
 *  little more eager. Pointer classes never consult this: SmoothControls only
 *  applies the dead zone to touch pointers. */
const DEAD_ZONE: Record<DeviceClass, number> = {
  phone: 10, tablet: 8, laptop: 0, desktop: 0,
};

/** Every device opens on Standard.
 *
 *  This used to hand touch devices Calm, on the theory that a small screen needs
 *  the gentlest preset out of the box. That theory was a workaround for gains
 *  that were wrong per class: now that phone and tablet have their own rotate,
 *  zoom, damping, cap and dead-zone rows, Standard on a phone already IS the
 *  calm-for-a-phone setting — the row exists precisely so the preset name means
 *  the same thing everywhere. Opening on Calm on top of that just made touch
 *  feel sluggish and, worse, made the preset the user picked mean something
 *  different from device to device.
 *
 *  Kept as a function rather than inlining DEFAULT_SENSITIVITY at the call site,
 *  because "what does a fresh visitor get" is a product decision that belongs
 *  here next to the tables, not in a component's useState initialiser. */
export function defaultSensitivityForDevice(): Sensitivity {
  return DEFAULT_SENSITIVITY;
}

/** Which scene the gesture is driving. Not a cosmetic distinction: the two views
 *  put the camera in geometrically different situations, so the same gain reads
 *  as two different speeds. */
export type GestureView = 'earth' | 'solar';

/** Per-view trim on rotation and zoom, multiplied onto the tables below.
 *
 *  The Earth view is the reference and is pinned at exactly 1 — the tables ARE
 *  the Earth tuning, and it is the one the user calls perfect. Only the solar
 *  row is a judgement call.
 *
 *  Why the solar view needs less from identical numbers:
 *
 *   • ROTATION. In the Earth view the pivot is the globe you are looking at, so
 *     a 78° swipe turns you 78° around the thing in frame — it stays in frame the
 *     whole way. In the solar view the pivot is usually the Sun (or empty space)
 *     while the subject is a planet somewhere off to one side, so the same 78°
 *     swings the camera along a huge arc and whatever you were looking at leaves
 *     the frame entirely. Same degrees, a completely different amount of "the
 *     view changed".
 *   • ZOOM. The Earth view sizes each step against the pivot distance, i.e. a
 *     fixed percentage of the way to the globe. The solar view sizes it against
 *     `max(dist, zoomScale)` where zoomScale is the free space ahead of the
 *     camera (SmoothControls.zoomScale — it exists because a pivot in open space
 *     otherwise makes every notch microscopic). That reference is by construction
 *     never smaller than the Earth view's and is usually much larger, so one
 *     wheel notch covers more ground.
 *
 *  Only the two gains are trimmed. maxAnglePerFrame / maxZoomLogPerFrame are left
 *  alone on purpose: they are per-frame backstops against one absurd input sample
 *  and they are NOT refunded to the pending buffer, so shrinking them would eat
 *  real input from a fast swipe rather than merely slow it. With smaller gains
 *  feeding them they simply bind less often, which is the correct outcome. */
const VIEW_TRIM: Record<GestureView, { rotate: number; zoom: number }> = {
  earth: { rotate: 1, zoom: 1 },
  solar: { rotate: 0.55, zoom: 0.45 },
};

export function gainsFor(
  sensitivity: Sensitivity,
  device: DeviceClass,
  view: GestureView = 'earth'
): SmoothControlsGains {
  const trim = VIEW_TRIM[view];
  return {
    rotatePerEdge:
      (DEGREES_PER_SWIPE[sensitivity][device] * trim.rotate * Math.PI) / 180,
    zoom: ZOOM_GAIN[sensitivity][device] * trim.zoom,
    // Panning that tracks the finger exactly is the least surprising thing it
    // can do; the trackball's distance-scaled guesswork is gone.
    pan: 1,
    response: RESPONSE[sensitivity][device],
    maxAnglePerFrame: MAX_ANGLE_PER_FRAME[device],
    maxZoomLogPerFrame: MAX_ZOOM_LOG_PER_FRAME[device],
    deadZone: DEAD_ZONE[device],
  };
}
