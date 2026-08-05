// A camera controller built for fingers first.
//
// This replaces three-stdlib's TrackballControls, which cannot be made calm on
// a phone by tuning alone. Its three structural problems, and what is done
// here instead:
//
//  1. TrackballControls' update() calls panCamera() unconditionally — pan is
//     not gated by gesture state — and scales the pan by the camera-to-target
//     distance. Any two-finger gesture therefore zooms AND drags the pivot at
//     once, and the drag grows with how far out you are. (Earth view hid this
//     behind noPan; the Solar System view did not, which is exactly why it was
//     dramatically worse there.) Here a two-finger gesture ARBITRATES: it
//     commits to pinch or to pan, once, and never does both.
//
//  2. It has no dead zone, and with staticMoving=false it coasts whatever
//     rotation a stray 2 px of finger drift produced. Here a touch gesture
//     must clear a dead zone before it moves anything, and the baseline is
//     re-anchored at that moment so engaging costs nothing.
//
//  3. Zooming always pivots around the existing target. In the Solar System
//     view the target is the Sun, so pinching down onto Jupiter leaves the
//     camera swinging on an astronomical-radius arc — a few pixels of finger
//     travel whips the planet out of frame. Here zoom pulls the pivot toward
//     the point under the fingers, so the thing you zoom into becomes the
//     thing you orbit.
//
// Two further departures from trackball feel: rotation is ROLL-FREE (yaw about
// the camera's own up, pitch about screen-right, with up carried by the pitch
// only) so a diagonal swipe cannot tilt the horizon; and every input is
// accumulated as a PENDING delta that is drained exponentially in update(),
// so one noisy touch sample is spread over several frames instead of being
// applied whole. Pole crossing stays unrestricted — up is rotated with the
// pitch, so there is no gimbal lock and nothing to clamp.

import * as THREE from 'three';

type GesturePhase =
  | 'none'
  /** One pointer down, still inside the dead zone. */
  | 'pending-single'
  | 'rotate'
  | 'pan'
  /** Two pointers down, not yet committed to pinch or pan. */
  | 'pending-multi'
  | 'pinch';

interface TrackedPointer {
  id: number;
  /** Live position, CSS px — written by the event handler. */
  x: number;
  y: number;
  /** Position at the last frame that consumed motion from this pointer. */
  px: number;
  py: number;
  /** Where the CURRENT gesture began. Re-anchored when a second finger lands,
   *  when one lifts, and when the dead zone is cleared. */
  sx: number;
  sy: number;
  touch: boolean;
  button: number;
}

export interface SmoothControlsGains {
  /** Radians of rotation per SHORT viewport edge swiped. Normalising against
   *  the short edge is what makes a portrait phone behave like a landscape
   *  desktop; TrackballControls normalised both axes by width alone. */
  rotatePerEdge: number;
  /** Multiplier on the log-space pinch/wheel step. */
  zoom: number;
  /** Multiplier on pan. 1 = the scene tracks the finger exactly. */
  pan: number;
  /** Exponential drain rate, 1/s. Higher = snappier and stops sooner; lower =
   *  smoother and glides longer. */
  response: number;
  /** Backstop clamps on what a single frame may apply. */
  maxAnglePerFrame: number;
  maxZoomLogPerFrame: number;
  /** CSS px a touch must travel before the gesture engages at all. */
  deadZone: number;
}

const DEFAULT_GAINS: SmoothControlsGains = {
  rotatePerEdge: Math.PI * 0.75,
  zoom: 1,
  pan: 1,
  response: 26,
  maxAnglePerFrame: 0.3,
  maxZoomLogPerFrame: 0.25,
  deadZone: 0,
};

/** A two-finger gesture is read as a pinch unless the midpoint clearly
 *  out-travels the finger spread. Pinching is by far the more common intent,
 *  so the tie is broken in its favour. */
const PINCH_BIAS = 1.35;
/** Travel (px) either signal must accumulate before a two-finger gesture
 *  commits. Below this the fingers are still settling. */
const MULTI_DEAD_ZONE = 10;
/** How strongly zoom drags the pivot toward the point under the fingers.
 *  1 = that point is pinned exactly; slightly under keeps it from feeling
 *  like the scene is sliding. */
const ZOOM_TO_POINT = 0.85;
/** |eye · upReference| above which the yaw axis starts blending from the world
 *  vertical toward the camera's own up. ~0.86 ≈ 30° from the pole. */
const POLE_BLEND_START = 0.86;

// -- Progressive proximity damping ------------------------------------------
//
// Input is applied at FULL gain far out, and eased down smoothly as the camera
// closes on the nearest distance it is allowed to reach, so the last stretch
// onto a surface settles instead of slamming — and, just as importantly, so a
// scroll or pinch produces PROGRESSIVELY SMALLER steps the deeper you already
// are. That is the behaviour the user asked for: zooming from far out in the
// Solar System onto Earth used to overshoot the satellite shell in one notch;
// now each notch shrinks as you approach, so you can settle onto the shell.
//
// The measure is OCTAVES above the floor — `log2(dist / minDistance)` — not a
// fraction of the scene. A ratio (let alone a log ratio) has no scene scale in
// it, so orbiting a moon decelerates exactly like orbiting the whole solar
// system. The previous version normalised against the scene-wide `maxDistance`
// (60 in the Solar System view), so being 0.02 units from a planet read as
// "0.03 % of the way out" and throttled everything to a crawl; and it eased
// over a fixed 6× window, too narrow to feel like a gradual slow-down.
/** Gain for ROTATION at the floor itself. Not zero — the camera must still be
 *  steerable while it rests against a surface. */
const FLOOR_GAIN = 0.3;
/** Gain for ZOOM at the floor. Lower than rotation's: an over-eager zoom is
 *  what the user feels as "it zoomed in too much", so the step is trimmed
 *  harder as you approach. Trimmed further here — each notch shrinks more
 *  aggressively the closer you already are, which is the stronger progressive
 *  damping the user asked for. */
const ZOOM_FLOOR_GAIN = 0.12;
/** Octaves above the floor at which easing ends and gain is full. ~6 octaves
 *  = 64× the closest distance — a WIDER, gentler deceleration band than before
 *  (was 4), so the slow-down is felt earlier and the last stretch onto a
 *  surface is finer. Far-out travel is many octaves up, so crossing the
 *  system stays at full gain — only the final approach is damped. */
const PROGRESSIVE_OCTAVES = 6;

// -- Clearance rate limiting -------------------------------------------------
//
// Damping decides how much of an input to apply; this decides how much of it may
// land in a SINGLE FRAME. They are different problems, and only the second one
// answers "when I am next to a planet, don't let the view transform completely".
//
// The failure it fixes: the pivot and the nearest surface are unrelated in the
// solar view. Skimming 0.01 units above Mars while the pivot is still the Sun
// 2.4 units away, one damped zoom frame moved the camera ~0.4 units — forty
// times its clearance — and Mars simply vanished. Same for rotation: a small
// angle about a distant pivot is an enormous arc where the camera actually is.
//
// So a frame may move the camera by at most this fraction of its clearance to
// the nearest surface, whatever the pivot happens to be. It is a RATE limit, not
// a reduction: the part that does not fit is refunded to the pending buffer and
// arrives over the following frames, so a gesture still travels its full
// distance — it just cannot teleport.
const ARC_CLEARANCE_FRACTION = 0.25;

/** Ceilings on the pending buffers. Only reachable via the refunds above: an
 *  input that keeps being rate-limited would otherwise accumulate into seconds
 *  of coasting after the finger has stopped. */
const PEND_ANGLE_MAX = Math.PI;
const PEND_ZOOM_MAX = 1.5;

const EPS = 1e-6;

export class SmoothControls {
  readonly object: THREE.PerspectiveCamera;
  domElement: HTMLElement | null = null;

  /** The point the camera orbits. Written by the camera rig in focus mode. */
  readonly target = new THREE.Vector3();

  enabled = true;
  noRotate = false;
  noZoom = false;
  /** When true, pan is impossible: two-finger gestures always resolve to a
   *  pinch, and zoom keeps the existing pivot instead of walking it toward the
   *  fingers (the Earth view wants the globe centre to stay the centre). */
  noPan = false;

  minDistance = 0;
  maxDistance = Infinity;

  /**
   * Distance-adaptive zoom scale, in scene units. 0 disables it.
   *
   * Zoom is multiplicative by nature — a notch changes |camera − target| by a
   * fixed RATIO — which is exactly right when the pivot is the thing you are
   * looking at. It falls apart when the pivot is glued to a small nearby body
   * while the camera is crossing open space: the ratio is taken against a tiny
   * `dist`, so every notch moves a tiny ABSOLUTE amount and travelling from
   * Earth to Mars on the far side of the Sun takes dozens of notches.
   *
   * The rig publishes the clearance to the nearest body SURFACE here each
   * frame, i.e. how much empty space the camera actually has. The zoom step is
   * then sized against `max(dist, zoomScale)`: unchanged when the pivot is the
   * nearest thing (fine control on a surface, near the Sun's centre), and
   * scaled up to the free space available when it is not (fast travel between
   * orbits). Increments therefore grow with where you are in the system and
   * shrink again as you close on a body — with no scene-specific constants in
   * the controller itself.
   */
  zoomScale = 0;

  /**
   * Distance at which the progressive damping is considered "at the floor",
   * in scene units. 0 = fall back to `minDistance`.
   *
   * Damping and CLAMPING are two different jobs and they need two different
   * numbers. `minDistance` is a hard stop — the camera may not cross it — so
   * publishing a proximity-derived value there pins the camera in place. This
   * is the soft counterpart: the distance the camera is *approaching*, used
   * only to decide how much of each input to apply. The rig can therefore say
   * "there is a surface 0.01 away, ease off" while leaving the camera free to
   * move wherever the user drags it.
   */
  dampFloor = 0;

  /**
   * Distance from the CAMERA to the nearest body surface, in scene units.
   * 0 = unknown, and everything below falls back to the pivot-distance measure.
   *
   * This is the honest measure of "how close am I to something", and it replaces
   * pivot distance as the damping measure whenever the rig can supply it. The
   * two disagree constantly in the solar view, and the disagreement was the bug:
   *
   *   Standing near Earth with Mars on the far side of the Sun, the view ray
   *   passes through the Sun, so the ray-cast floor lands almost on top of the
   *   camera and `log2(dist / dampFloor)` collapsed to ~0 octaves. Every input
   *   was then damped to its floor gain — in wide-open space, with nothing within
   *   an astronomical unit. That is precisely the "zoom becomes so small the user
   *   gives up" report.
   *
   * Measured as clearance instead, that same position reads as ~1.1 units of free
   * space and gets full gain, while a camera genuinely 0.01 above a surface still
   * gets the floor. It also satisfies the Sun rule for free: clearance to the Sun
   * grows from ~1.1 at Earth's orbit to ~8.3 out past Neptune, so increments grow
   * with distance from the Sun and shrink again on approach to any body — with no
   * scene-specific constants in the controller.
   */
  clearance = 0;

  /**
   * The clearance at which damping is considered "at the floor", in scene units.
   * 0 = unknown (disables the clearance measure along with {@link clearance}).
   *
   * The rig sets this from the radius of whichever body is nearest, so the
   * deceleration band is proportional to the thing being approached: a moon
   * 3 000 km across slows the camera over a proportionally smaller distance than
   * the Sun does. That is what keeps the feel identical at every scale.
   */
  clearanceFloor = 0;

  gains: SmoothControlsGains = { ...DEFAULT_GAINS };

  /** The "vertical" the horizon is kept level against. World up by default;
   *  the scene's own up in both views. */
  readonly upReference = new THREE.Vector3(0, 1, 0);

  /** Viewport size in CSS px, refreshed by handleResize(). */
  readonly screen = { left: 0, top: 0, width: 1, height: 1 };

  private pointers = new Map<number, TrackedPointer>();
  private phase: GesturePhase = 'none';
  private lastSpread = 0;
  private lastMidX = 0;
  private lastMidY = 0;

  // Pending input, drained exponentially by update().
  private pendYaw = 0;
  private pendPitch = 0;
  private pendZoomLog = 0;
  private pendPanX = 0;
  private pendPanY = 0;
  /** NDC point the pending zoom should pull the pivot toward. */
  private zoomNdcX = 0;
  private zoomNdcY = 0;

  private lastTime = 0;
  /** Remembered yaw sign to prevent oscillation at the exact 180° flip. */
  private lastYawSign = 1;

  // Scratch — this runs every frame, so it allocates nothing.
  private readonly offset = new THREE.Vector3();
  private readonly eyeDir = new THREE.Vector3();
  private readonly upDir = new THREE.Vector3();
  private readonly rightDir = new THREE.Vector3();
  private readonly yawAxis = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly vec = new THREE.Vector3();

  private readonly listeners = new Set<() => void>();

  constructor(object: THREE.PerspectiveCamera, domElement?: HTMLElement) {
    this.object = object;
    if (domElement) this.connect(domElement);
  }

  /** Fired whenever the camera pose actually changed (drives r3f invalidate). */
  addChangeListener(fn: () => void) { this.listeners.add(fn); }
  removeChangeListener(fn: () => void) { this.listeners.delete(fn); }
  private emitChange() { for (const fn of this.listeners) fn(); }

  // -- Wiring ---------------------------------------------------------------

  connect(domElement: HTMLElement) {
    this.disconnect();
    this.domElement = domElement;
    // Pointer events only. TrackballControls registered pointer* AND touch*
    // handlers on the same element; that is survivable only because it filters
    // pointerType, and it is the reason its touch path is a second, less
    // careful implementation. One path, one set of rules.
    domElement.addEventListener('pointerdown', this.onPointerDown, { passive: false });
    domElement.addEventListener('wheel', this.onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this.onContextMenu);
    // Move/up go on the window so a gesture that leaves the canvas — or ends
    // over an overlay panel — is still tracked and still released.
    window.addEventListener('pointermove', this.onPointerMove, { passive: false });
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    this.handleResize();
  }

  private disconnect() {
    const el = this.domElement;
    if (!el) return;
    el.removeEventListener('pointerdown', this.onPointerDown);
    el.removeEventListener('wheel', this.onWheel);
    el.removeEventListener('contextmenu', this.onContextMenu);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.domElement = null;
  }

  dispose() {
    this.disconnect();
    this.pointers.clear();
    this.listeners.clear();
  }

  handleResize() {
    const el = this.domElement;
    if (!el) return;
    const box = el.getBoundingClientRect();
    this.screen.left = box.left;
    this.screen.top = box.top;
    this.screen.width = Math.max(1, box.width);
    this.screen.height = Math.max(1, box.height);
  }

  /** Drop all input and in-flight motion — used when something else (the
   *  cinematic tour) takes the camera. */
  reset() {
    this.pointers.clear();
    this.phase = 'none';
    this.pendYaw = this.pendPitch = this.pendZoomLog = 0;
    this.pendPanX = this.pendPanY = 0;
  }

  // -- Input ----------------------------------------------------------------

  private shortEdge() { return Math.min(this.screen.width, this.screen.height); }

  private onContextMenu = (e: Event) => { e.preventDefault(); };

  private onPointerDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    const touch = e.pointerType !== 'mouse' && e.pointerType !== 'pen';
    // Prevent the browser from starting its own scroll/zoom gesture for touch
    // events. Without this, iOS Safari and some Android browsers may begin a
    // pan or pinch-to-zoom at the document level in the same frame our pointer
    // handler fires, which reads as a page jump — especially in the Solar
    // System view where the orbit pivot is far from the screen centre.
    if (touch) e.preventDefault();
    // A third finger is ignored rather than allowed to redefine the gesture
    // mid-flight; the first two keep control until everything is lifted.
    if (this.pointers.size >= 2) return;

    this.pointers.set(e.pointerId, {
      id: e.pointerId,
      x: e.clientX, y: e.clientY,
      px: e.clientX, py: e.clientY,
      sx: e.clientX, sy: e.clientY,
      touch,
      button: e.button,
    });

    if (this.pointers.size === 1) {
      this.phase = 'pending-single';
    } else {
      this.beginMulti();
    }
  };

  /** Re-anchor both pointers and start arbitrating a two-finger gesture. */
  private beginMulti() {
    const [a, b] = this.twoPointers();
    if (!a || !b) return;
    for (const p of [a, b]) { p.sx = p.px = p.x; p.sy = p.py = p.y; }
    this.lastSpread = Math.hypot(a.x - b.x, a.y - b.y);
    this.lastMidX = (a.x + b.x) / 2;
    this.lastMidY = (a.y + b.y) / 2;
    this.phase = 'pending-multi';
  }

  private twoPointers(): [TrackedPointer | undefined, TrackedPointer | undefined] {
    const it = this.pointers.values();
    return [it.next().value, it.next().value];
  }

  // Event handlers do nothing but record where the fingers are. All gesture
  // logic happens once per frame in processGesture().
  //
  // This is not a stylistic choice. The browser delivers one pointermove per
  // pointer, so during a two-finger drag there is always an instant where one
  // finger has moved and the other has not — and to any code looking at the
  // pair right then, a translation is indistinguishable from a pinch. Deciding
  // inside the handler reliably mis-committed fast two-finger drags to zoom.
  // Deferring to the frame guarantees both positions are from the same moment.
  private onPointerMove = (e: PointerEvent) => {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.enabled) return;
    p.x = e.clientX;
    p.y = e.clientY;
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size === 1) {
      // Two fingers down to one: restart as a fresh single gesture anchored at
      // the survivor's CURRENT position, so lifting a finger never snaps.
      const [p] = this.twoPointers();
      if (p) { p.sx = p.px = p.x; p.sy = p.py = p.y; }
      this.phase = 'pending-single';
    } else if (this.pointers.size === 0) {
      this.phase = 'none';
    }
  };

  /** Turn this frame's finger positions into pending camera motion. */
  private processGesture() {
    if (!this.enabled) return;
    const n = this.pointers.size;
    if (n === 1) this.processSingle();
    else if (n >= 2) this.processMulti();
  }

  private processSingle() {
    const [p] = this.twoPointers();
    if (!p) return;

    if (this.phase === 'pending-single') {
      const dz = p.touch ? this.gains.deadZone : 0;
      if (Math.hypot(p.x - p.sx, p.y - p.sy) < dz) return;
      // Clearing the dead zone re-anchors to HERE, so engaging costs no
      // motion — the camera starts from rest under the finger rather than
      // jumping by the distance already travelled.
      p.px = p.x;
      p.py = p.y;
      // Right/middle mouse button drags the scene; everything else orbits.
      this.phase = !p.touch && (p.button === 1 || p.button === 2) && !this.noPan ? 'pan' : 'rotate';
    }

    const dx = p.x - p.px;
    const dy = p.y - p.py;
    if (dx === 0 && dy === 0) return;
    p.px = p.x;
    p.py = p.y;

    const edge = this.shortEdge();
    if (this.phase === 'rotate' && !this.noRotate) {
      const perPx = this.gains.rotatePerEdge / edge;
      this.pendYaw -= dx * perPx;
      this.pendPitch -= dy * perPx;
    } else if (this.phase === 'pan' && !this.noPan) {
      this.pendPanX -= dx / edge;
      this.pendPanY += dy / edge;
    }
  }

  private processMulti() {
    const [a, b] = this.twoPointers();
    if (!a || !b) return;
    const spread = Math.hypot(a.x - b.x, a.y - b.y);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;

    if (this.phase === 'pending-multi') {
      // Arbitrate on each finger's displacement since the gesture began, not
      // on the instantaneous pair geometry. Translating together gives a big
      // mean displacement and near-zero separation; pinching gives the
      // reverse; a pivot pinch (one finger anchored) gives both equally, and
      // PINCH_BIAS breaks that tie in favour of zoom, which is the intent.
      const d1x = a.x - a.sx, d1y = a.y - a.sy;
      const d2x = b.x - b.sx, d2y = b.y - b.sy;
      const dMid = Math.hypot((d1x + d2x) / 2, (d1y + d2y) / 2);
      const dSep = Math.hypot(d1x - d2x, d1y - d2y) / 2;
      if (Math.max(dMid, dSep) < MULTI_DEAD_ZONE) return;
      // Commit, once, for the life of the gesture. Doing both at once is what
      // made every pinch drag the whole solar system sideways.
      this.phase = this.noPan || dSep * PINCH_BIAS >= dMid ? 'pinch' : 'pan';
      this.lastSpread = spread;
      this.lastMidX = midX;
      this.lastMidY = midY;
      return;
    }

    if (this.phase === 'pinch' && !this.noZoom) {
      if (spread > EPS && this.lastSpread > EPS) {
        // Log space: pinching is naturally multiplicative, and it makes the
        // per-frame clamp a clean bound on "how many times closer".
        this.pendZoomLog -= Math.log(spread / this.lastSpread) * this.gains.zoom;
        this.setZoomAnchor(midX, midY);
      }
    } else if (this.phase === 'pan' && !this.noPan) {
      const edge = this.shortEdge();
      this.pendPanX -= (midX - this.lastMidX) / edge;
      this.pendPanY += (midY - this.lastMidY) / edge;
    }
    // Both baselines advance either way: a committed pinch never consumes the
    // midpoint, and a committed pan never consumes the spread.
    this.lastSpread = spread;
    this.lastMidX = midX;
    this.lastMidY = midY;
  }

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled || this.noZoom) return;
    e.preventDefault();
    // deltaMode: 0 = px, 1 = lines, 2 = pages.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.screen.height : 1;
    this.pendZoomLog += e.deltaY * unit * 0.0008 * this.gains.zoom;
    this.setZoomAnchor(e.clientX, e.clientY);
  };

  /** Record where a zoom should pull the pivot toward, in NDC. */
  private setZoomAnchor(clientX: number, clientY: number) {
    this.zoomNdcX = ((clientX - this.screen.left) / this.screen.width) * 2 - 1;
    this.zoomNdcY = -(((clientY - this.screen.top) / this.screen.height) * 2 - 1);
  }

  isUserInteracting(): boolean {
    return (
      this.pointers.size > 0 ||
      Math.abs(this.pendYaw) > 1e-5 ||
      Math.abs(this.pendPitch) > 1e-5 ||
      Math.abs(this.pendZoomLog) > 1e-5 ||
      Math.abs(this.pendPanX) > 1e-5 ||
      Math.abs(this.pendPanY) > 1e-5
    );
  }

  // -- Frame ----------------------------------------------------------------

  /**
   * Advance the camera. Safe to call more than once per frame — the second
   * call sees dt ≈ 0, applies nothing, and simply re-derives the pose from
   * wherever the caller has moved the camera to. That is what lets the camera
   * rig move the camera imperatively and then hand it back.
   */
  update(dtOverride?: number) {
    const cam = this.object;
    this.processGesture();
    const now = performance.now();
    let dt = dtOverride ?? (this.lastTime ? (now - this.lastTime) / 1000 : 0);
    this.lastTime = now;
    // A backgrounded tab returns with a huge dt; clamp so the first frame back
    // doesn't apply the whole pending buffer at once.
    dt = Math.min(Math.max(dt, 0), 0.1);

    this.offset.copy(cam.position).sub(this.target);
    let dist = this.offset.length();
    if (dist < EPS) {
      this.offset.set(0, 0, Math.max(this.minDistance, EPS));
      dist = this.offset.length();
    }
    this.eyeDir.copy(this.offset).divideScalar(dist);

    // Keep the up vector honest: orthogonalise it against the view direction
    // every frame. The rig rotates camera.up imperatively while following an
    // orbit, and a basis that drifts toward parallel is what makes a control
    // scheme feel like it is fighting you.
    this.upDir.copy(cam.up);
    this.upDir.addScaledVector(this.eyeDir, -this.upDir.dot(this.eyeDir));
    if (this.upDir.lengthSq() < EPS) {
      // Looking straight along up — any perpendicular will do.
      this.upDir.set(0, 0, 1).addScaledVector(this.eyeDir, -this.eyeDir.z);
      if (this.upDir.lengthSq() < EPS) this.upDir.set(1, 0, 0);
    }
    this.upDir.normalize();
    // right = up × eye, with eye pointing FROM the target TO the camera. For a
    // camera on +Z looking at the origin with up = +Y this gives +X, i.e. the
    // direction the user sees as "right" on screen.
    this.rightDir.crossVectors(this.upDir, this.eyeDir).normalize();

    // Drain a fixed FRACTION of the pending input. Because the fraction is
    // computed from dt this is frame-rate independent, it never loses input
    // (the remainder stays pending), and it spreads a single jittery sample
    // over ~1/response seconds — which is the whole trick to feeling calm.
    const k = dt > 0 ? 1 - Math.exp(-this.gains.response * dt) : 0;

    let moved = false;

    // --- Progressive proximity damping -------------------------------------
    // Scale-invariant: measured in octaves above the closest allowed distance,
    // never as a fraction of the scene. Full gain beyond PROGRESSIVE_OCTAVES,
    // then a smoothstep down to the floor gains, so each successive zoom notch
    // (and each degree of orbit) is smaller than the last as you close in. One
    // log and a handful of flops per frame — nothing per-pointer, nothing
    // allocated, which is what keeps it free on a phone.
    //
    // The measure is the camera's CLEARANCE to the nearest surface when the rig
    // publishes one (see `clearance`), and pivot distance otherwise. Pivot
    // distance is only a good proxy for proximity when the pivot is the thing you
    // are approaching, which in the solar view it usually is not.
    let octaves: number;
    if (this.clearance > 0 && this.clearanceFloor > 0) {
      octaves = Math.log2(this.clearance / this.clearanceFloor);
    } else {
      const floor = Math.max(this.dampFloor > 0 ? this.dampFloor : this.minDistance, EPS);
      octaves = Math.log2(dist / floor);
    }
    const p = octaves <= 0 ? 0 : octaves >= PROGRESSIVE_OCTAVES ? 1 : octaves / PROGRESSIVE_OCTAVES;
    const ease = p * p * (3 - 2 * p);
    const distDamp = FLOOR_GAIN + (1 - FLOOR_GAIN) * ease;
    const zoomDamp = ZOOM_FLOOR_GAIN + (1 - ZOOM_FLOOR_GAIN) * ease;

    // How far the camera may travel this frame, in scene units. Infinity when the
    // rig has not published a clearance (the Earth view, whose pivot IS the body
    // it orbits, so pivot distance already measures proximity correctly).
    const arcBudget = this.clearance > 0 ? ARC_CLEARANCE_FRACTION * this.clearance : Infinity;

    // --- Rotation ---------------------------------------------------------
    if (k > 0 && (this.pendYaw !== 0 || this.pendPitch !== 0)) {
      // Drain the pending buffer at the full rate…
      const rawYaw = this.pendYaw * k;
      const rawPitch = this.pendPitch * k;
      this.pendYaw -= rawYaw;
      this.pendPitch -= rawPitch;

      // …but only *apply* a dampened fraction to the camera.
      let yaw = rawYaw * distDamp;
      let pitch = rawPitch * distDamp;
      const maxA = this.gains.maxAnglePerFrame * distDamp;
      let mag = Math.hypot(yaw, pitch);
      // Hard per-frame backstop. Deliberately NOT refunded: it exists to swallow
      // absurd single samples, and giving them back would replay the absurdity.
      if (mag > maxA) { const s = maxA / mag; yaw *= s; pitch *= s; mag = maxA; }
      // Clearance rate limit, in scene units of arc travel. Refunded, so the
      // rotation still happens — over more frames, staying in frame throughout.
      const maxArcAngle = arcBudget / Math.max(dist, EPS);
      if (mag > maxArcAngle) {
        const s = maxArcAngle / mag;
        if (distDamp > EPS) {
          this.pendYaw += (yaw - yaw * s) / distDamp;
          this.pendPitch += (pitch - pitch * s) / distDamp;
        }
        yaw *= s;
        pitch *= s;
      }
      this.pendYaw = Math.max(-PEND_ANGLE_MAX, Math.min(PEND_ANGLE_MAX, this.pendYaw));
      this.pendPitch = Math.max(-PEND_ANGLE_MAX, Math.min(PEND_ANGLE_MAX, this.pendPitch));
      if (Math.abs(this.pendYaw) < 1e-7) this.pendYaw = 0;
      if (Math.abs(this.pendPitch) < 1e-7) this.pendPitch = 0;

      if (yaw !== 0) {
        const upDot = this.upDir.dot(this.upReference);
        const sign = upDot < -0.01 ? -1 : upDot > 0.01 ? 1 : this.lastYawSign;
        this.lastYawSign = sign;
        const align = Math.abs(this.eyeDir.dot(this.upReference));
        const blend = align <= POLE_BLEND_START
          ? 0
          : (align - POLE_BLEND_START) / (1 - POLE_BLEND_START);
        this.yawAxis
          .copy(this.upReference).multiplyScalar(sign)
          .lerp(this.upDir, blend);
        const yawLen = this.yawAxis.lengthSq();
        if (yawLen < 1e-4) this.yawAxis.copy(this.upDir);
        else this.yawAxis.divideScalar(Math.sqrt(yawLen));

        this.quat.setFromAxisAngle(this.yawAxis, yaw);
        this.offset.applyQuaternion(this.quat);
        this.upDir.applyQuaternion(this.quat).normalize();
      }
      if (pitch !== 0) {
        this.quat.setFromAxisAngle(this.rightDir, pitch);
        this.offset.applyQuaternion(this.quat);
        this.upDir.applyQuaternion(this.quat).normalize();
      }
      this.eyeDir.copy(this.offset).normalize();
      this.rightDir.crossVectors(this.upDir, this.eyeDir).normalize();
      moved = true;
    }

    // --- Zoom -------------------------------------------------------------
    if (k > 0 && this.pendZoomLog !== 0) {
      // Drain fully, apply dampened.
      const rawStep = this.pendZoomLog * k;
      this.pendZoomLog -= rawStep;
      if (Math.abs(this.pendZoomLog) < 1e-7) this.pendZoomLog = 0;

      // Zooming IN is progressively damped; zooming OUT is not. Escaping a
      // close-up must never be slow — that is the trap the old scene-relative
      // damping created.
      const gain = rawStep < 0 ? zoomDamp : 1;
      let step = rawStep * gain;
      const maxZ = this.gains.maxZoomLogPerFrame * gain;
      step = Math.min(maxZ, Math.max(-maxZ, step));

      // Distance-adaptive step. `dist` is the ratio's natural reference, but
      // when the pivot is floating in open space — which zoom-to-point does as
      // soon as you aim between two orbits — it makes every notch microscopic
      // (see zoomScale). Sizing the step against the free space the camera
      // actually has restores useful travel without touching the feel of a
      // close approach, where `dist` is the larger of the two anyway.
      const ref = this.zoomScale > 0 ? Math.max(dist, this.zoomScale) : dist;
      const wantedRaw = dist + ref * (Math.exp(step) - 1);
      // Inward guard. With a reference much larger than `dist` the absolute step
      // can exceed the whole remaining distance and slam the camera onto the
      // pivot in one frame. Capping a single commit at 30 % of the gap keeps the
      // approach smooth; when ref === dist this is inert (the multiplicative
      // step is already bounded by maxZoomLogPerFrame ≈ 22 %).
      let wanted = Math.max(EPS, step < 0 ? Math.max(wantedRaw, dist * 0.7) : wantedRaw);
      // Clearance rate limit. The guard above is relative to the PIVOT, which
      // says nothing about the surface the camera is actually next to: skimming a
      // planet with the Sun as pivot, 30 % of the gap was ~40× the clearance and
      // one frame swallowed the whole approach. Inward only — escaping a close-up
      // must never be throttled.
      if (wanted < dist && Number.isFinite(arcBudget)) {
        const floorDist = dist - arcBudget;
        if (wanted < floorDist) {
          // Refund the part that did not fit, converted back out of log space, so
          // the zoom continues over the next frames instead of being discarded.
          const applied = Math.log(floorDist / dist);
          if (gain > EPS) this.pendZoomLog += (step - applied) / gain;
          wanted = floorDist;
        }
      }
      this.pendZoomLog = Math.max(-PEND_ZOOM_MAX, Math.min(PEND_ZOOM_MAX, this.pendZoomLog));
      const next = Math.min(this.maxDistance, Math.max(this.minDistance, wanted));
      const factor = next / dist;

      if (!this.noPan && factor !== 1) {
        const tanHalf = Math.tan((cam.fov * Math.PI) / 360);
        const scale = tanHalf * dist * (1 - factor) * ZOOM_TO_POINT;
        this.vec
          .copy(this.rightDir).multiplyScalar(this.zoomNdcX * cam.aspect * scale)
          .addScaledVector(this.upDir, this.zoomNdcY * scale);
        this.target.add(this.vec);
      }

      this.offset.setLength(next);
      dist = next;
      moved = true;
    }

    // --- Pan --------------------------------------------------------------
    if (k > 0 && (this.pendPanX !== 0 || this.pendPanY !== 0)) {
      let px = this.pendPanX * k;
      let py = this.pendPanY * k;
      this.pendPanX -= px;
      this.pendPanY -= py;

      // True perspective pan: one short-edge of finger travel moves the scene
      // by exactly one short-edge of the focal plane, so it tracks the finger.
      const worldPerEdge = 2 * Math.tan((cam.fov * Math.PI) / 360) * dist * this.gains.pan;
      // Pan translates the camera one-for-one, so the clearance rate limit applies
      // to it most directly of all: with a distant pivot, `worldPerEdge` is scaled
      // by that distance and a single frame of two-finger drag next to a moon
      // moved the camera many times its own clearance. Refunded like the others.
      const travel = Math.hypot(px, py) * worldPerEdge;
      if (travel > arcBudget) {
        const s = arcBudget / travel;
        this.pendPanX += px * (1 - s);
        this.pendPanY += py * (1 - s);
        px *= s;
        py *= s;
      }
      if (Math.abs(this.pendPanX) < 1e-9) this.pendPanX = 0;
      if (Math.abs(this.pendPanY) < 1e-9) this.pendPanY = 0;

      this.vec
        .copy(this.rightDir).multiplyScalar(px * worldPerEdge)
        .addScaledVector(this.upDir, py * worldPerEdge);
      this.target.add(this.vec);
      moved = true;
    }

    // --- Commit -----------------------------------------------------------
    const clamped = Math.min(this.maxDistance, Math.max(this.minDistance, dist));
    if (clamped !== dist) { this.offset.setLength(clamped); moved = true; }

    cam.position.copy(this.target).add(this.offset);
    cam.up.copy(this.upDir);
    cam.lookAt(this.target);

    // NaN guard: if quaternion drift or degenerate input produced NaN in the
    // camera pose, reset to a safe fallback instead of freezing forever.
    if (!isFinite(cam.position.x) || !isFinite(cam.position.y) || !isFinite(cam.position.z) ||
        !isFinite(cam.up.x) || !isFinite(cam.up.y) || !isFinite(cam.up.z)) {
      cam.position.set(0, 5, 10);
      cam.up.set(0, 1, 0);
      this.target.set(0, 0, 0);
      this.offset.set(0, 5, 10);
      this.pendYaw = 0;
      this.pendPitch = 0;
      this.pendZoomLog = 0;
      this.pendPanX = 0;
      this.pendPanY = 0;
      cam.lookAt(this.target);
    }

    if (moved) this.emitChange();
  }
}
