// URL state + local persistence.
//
// Two related but deliberately SEPARATE concerns, which the app used to
// collapse into nothing:
//
//  1. The URL is a *share contract*. Whatever makes this exact moment in the
//     app reproducible — the view, what's selected, the simulated date — goes
//     into the query string, so a copied link opens on the same scene. Only
//     the share-relevant slice lives here; clutter like sensitivity or scroll
//     position never does.
//
//  2. localStorage is *session memory*. Scene toggles and filters restore on
//     the next visit so a reload doesn't reset the app, but they're keyed
//     per-setting rather than bundled with the URL, because what you want
//     back after a reload is broader than what you'd want stamped onto a
//     link you send someone.
//
// Encoding choices: the state goes in the query string (not the hash) so it
// survives a server render and is trivially copyable; values are compact and
// human-guessable (`view=solar&time=2061-07-28`) because a URL a user can read
// is a URL they can trust and edit. Everything is encoded with
// URLSearchParams, so no hand-rolled escaping.

import type { Sensitivity } from './interaction';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UrlSceneState {
  view: 'earth' | 'solar';
  /** Identifiers for whatever is selected. Earth sats key on NORAD id
   *  (stable across sessions; names are not guaranteed unique). Solar
   *  selection keys on planet/moon/probe name. */
  sat: string | null;
  planet: string | null;
  moon: string | null;
  probe: string | null;
  /** Whether the focus/follow camera is engaged. */
  focus: boolean;
  /** Simulated time as an ISO instant. null = follow the real wall clock. */
  time: Date | null;
}

export interface Filters {
  categories: string[];
  bands: string[];
}

// ---------------------------------------------------------------------------
// URL encode / decode
// ---------------------------------------------------------------------------

const PARAM_VIEW = 'view';
const PARAM_SAT = 'sat';
const PARAM_PLANET = 'planet';
const PARAM_MOON = 'moon';
const PARAM_PROBE = 'probe';
const PARAM_FOCUS = 'focus';
const PARAM_TIME = 'time';

/** Parse the current location's query string into a scene state. Anything
 *  absent or malformed falls back to the live defaults — a bad link must
 *  never crash the app or blank the scene, it just restores less. */
export function parseUrlState(search: string): UrlSceneState {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const view = p.get(PARAM_VIEW) === 'solar' ? 'solar' : 'earth';

  const timeRaw = p.get(PARAM_TIME);
  let time: Date | null = null;
  if (timeRaw) {
    const ms = Date.parse(timeRaw);
    if (Number.isFinite(ms)) time = new Date(ms);
  }

  return {
    view,
    sat: clean(p.get(PARAM_SAT)),
    planet: clean(p.get(PARAM_PLANET)),
    moon: clean(p.get(PARAM_MOON)),
    probe: clean(p.get(PARAM_PROBE)),
    focus: p.get(PARAM_FOCUS) === '1' || p.get(PARAM_FOCUS) === 'true',
    time,
  };
}

function clean(v: string | null): string | null {
  const t = v?.trim();
  return t ? t : null;
}

/** Serialise a scene state to a query string (no leading '?'). Omits defaults
 *  and nulls so the everyday URL stays clean — only a non-default moment is
 *  worth stamping into a link. */
export function buildUrlState(state: UrlSceneState): string {
  const p = new URLSearchParams();
  if (state.view !== 'earth') p.set(PARAM_VIEW, state.view);
  if (state.sat) p.set(PARAM_SAT, state.sat);
  if (state.planet) p.set(PARAM_PLANET, state.planet);
  if (state.moon) p.set(PARAM_MOON, state.moon);
  if (state.probe) p.set(PARAM_PROBE, state.probe);
  if (state.focus) p.set(PARAM_FOCUS, '1');
  if (state.time) p.set(PARAM_TIME, state.time.toISOString());
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Build an absolute share URL for the given scene, against the current
 *  origin. Returns null on the server / when there is no location. */
export function buildShareUrl(state: UrlSceneState): string | null {
  if (typeof window === 'undefined') return null;
  const qs = buildUrlState(state);
  return `${window.location.origin}${window.location.pathname}${qs}`;
}

// ---------------------------------------------------------------------------
// localStorage persistence
// ---------------------------------------------------------------------------
//
// One namespaced key per concern, each holding a small JSON payload. Keys are
// versioned in their prefix so a future shape change can bump the key rather
// than migrate.

const KEY_SCENE = 'pimxsats.scene.v1';
const KEY_FILTERS = 'pimxsats.filters.v1';

export interface PersistedScene {
  view: 'earth' | 'solar';
  earth: Record<string, unknown>;
  solar: Record<string, unknown>;
  sensitivity: Sensitivity;
}

function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // private mode / disabled storage / corrupt payload
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A failed write must never break the app — the live setting stands.
  }
}

export function loadPersistedScene(): PersistedScene | null {
  return readJson<PersistedScene>(KEY_SCENE);
}

export function persistScene(scene: PersistedScene): void {
  writeJson(KEY_SCENE, scene);
}

export function loadPersistedFilters(): Filters | null {
  return readJson<Filters>(KEY_FILTERS);
}

export function persistFilters(filters: Filters): void {
  writeJson(KEY_FILTERS, filters);
}
