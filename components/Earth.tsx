'use client';

import { useLoader, useFrame, useThree } from '@react-three/fiber';
import { useRef, useMemo, useEffect, useState } from 'react';
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { getSunSceneDirection } from '@/lib/astronomy';
import {
  loadCloudTexture, preloadCloudTexture, getCloudTexture, getCloudStatus, CLOUD_REFRESH_MS,
} from '@/lib/clouds';

// Locally hosted high-resolution textures (see public/textures/):
//   day    8192×4096  NASA Blue Marble
//   night  13500×6750 NASA Black Marble (VIIRS city lights)
//   spec   2048×1024  ocean specular mask
// Clouds are REAL: /api/clouds proxies a 4096×2048 global cloud map built
// from live EUMETSAT/GOES/Himawari imagery (refreshed ~every 3 h), falling
// back to the bundled static texture if the source is unreachable.
// Bundled with the site — these three never touch the network at runtime
// beyond the browser's own cache, so the globe paints immediately.
export const EARTH_TEXTURE_URLS = [
  '/textures/earth_day.jpg',
  '/textures/earth_night.jpg',
  '/textures/earth_specular.jpg',
];

// The cloud layer is live data (see lib/clouds.ts). The composite is fetched
// during the loading screen — SatelliteApp waits for /api/clouds before the
// globe is revealed — so this component normally mounts with the live map
// already decoded and shows real, current weather on its first painted frame.
// The bundled static map below is the fallback for the two cases where that
// does not happen: a link too slow to beat the splash timeout, or an
// unreachable origin. A re-check runs every half hour so a session left open
// does not drift hours behind reality.
const STATIC_CLOUDS_URL = '/textures/earth_clouds.png';

/** How far the latitude-dependent SHEAR is allowed to be carried, in hours.
 *  This term moves each latitude circle at its own physical rate, so left
 *  unbounded a long time-warp would smear the map into ribbons; "yesterday's
 *  clouds blown forward" also stops meaning anything after about three days.
 *  The visible bulk roll (below) is separate and deliberately NOT clamped. */
const MAX_DRIFT_HOURS = 72;

/** Bulk eastward roll of the whole cloud field, in degrees of longitude per
 *  hour of SIMULATED time — the true mean zonal wind, roughly. Uniform across
 *  latitude, so unlike the shear term it cannot distort the imagery, and
 *  unbounded/wrapped, so it never saturates and freezes the way the old single
 *  clamped drift did. */
const CLOUD_BULK_DEG_PER_HOUR = 18;

/** Visibility boost applied to the bulk roll.
 *
 *  Honest about what this is: 18°/hour is ~0.005°/s, which at 1× is far below
 *  what the eye can pick up — that is why the deck read as frozen. The roll is
 *  therefore exaggerated by this factor so it is perceptible in real time
 *  (~0.25°/s, one revolution per ≈24 min) while still being driven ENTIRELY by
 *  the simulated clock, so the Earth-view Warp scales it and Pause stops it.
 *  The physical, latitude-dependent shear term is NOT exaggerated — the
 *  circulation pattern stays true, only the overall pace is theatrical. */
const CLOUD_VISIBILITY_BOOST = 10;

/** Ceiling on the roll, degrees of longitude per REAL second. Past roughly a
 *  revolution every twenty seconds the layer is a strobing blur that says nothing
 *  about the weather, so the high warp presets share this rate. */
const CLOUD_MAX_DEG_PER_SEC = 18;

interface EarthProps {
  simulatedTimeRef?: React.MutableRefObject<Date>;
  showClouds?: boolean;
  showAtmosphere?: boolean;
  showNightLights?: boolean;
  enableMovement?: boolean;
}

// ---------------------------------------------------------------------------
// Cloud advection
//
// The composite is a real snapshot of a moving fluid, and the old layer pinned
// it to the crust at exactly the surface's GMST — so the atmosphere was welded
// to the ground and never moved relative to it, which is the one thing an
// atmosphere demonstrably does not do.
//
// This is the fix, and it is a physical one rather than a fudged spin: clouds
// are carried along latitude circles by the mean zonal wind, which is the
// three-cell circulation out of any atmospheric-dynamics text — easterly trades
// either side of the equator, strong mid-latitude westerlies, weak polar
// easterlies. Converting m/s to degrees of longitude per hour needs the
// shrinking circumference of each latitude circle, which is why the same wind
// moves clouds much further per hour at 60° than at the equator.
//
// Honest about magnitude: this is 0.5–2° of longitude per hour, so at 1× the
// motion is real but slow — it is the time controls that make it obvious, and
// the simulated clock drives it exactly as it drives the satellites.
// ---------------------------------------------------------------------------
const CLOUD_ADVECTION_GLSL = /* glsl */ `
  /** Mean zonal wind at cloud level, m/s, eastward-positive. */
  float cloudZonalWind(float absLat) {
    float trades     = -7.0 * exp(-pow((absLat -  8.0) / 16.0, 2.0));
    float westerlies = 14.0 * exp(-pow((absLat - 45.0) / 18.0, 2.0));
    float polar      = -3.5 * exp(-pow((absLat - 78.0) / 12.0, 2.0));
    return trades + westerlies + polar;
  }

  /** Equirectangular UV of the air that is over \`uv\` given \`shearHours\` of
   *  latitude-dependent advection plus \`bulkDeg\` of uniform eastward roll.
   *
   *  Two terms with different jobs:
   *   - bulkDeg    a rigid eastward roll of the whole field. Unbounded and
   *                wrapped, this is the motion you actually SEE — continuous at
   *                every warp level and free of distortion (a uniform shift
   *                cannot shear the image).
   *   - shearHours the physical three-cell circulation, which moves each
   *                latitude circle at its own rate. Kept BOUNDED by the caller
   *                so the differential cannot smear the map into ribbons over a
   *                long time-warp; it adds realistic texture on top of the roll. */
  vec2 cloudUv(vec2 uv, float shearHours, float bulkDeg) {
    float latDeg = (uv.y - 0.5) * 180.0;
    // 111320 m per degree of longitude at the equator, shrinking with cos(lat).
    // Clamped so the pole singularity cannot produce an infinite shear.
    float metresPerDeg = 111320.0 * max(cos(radians(latDeg)), 0.16);
    float degPerHour = cloudZonalWind(abs(latDeg)) * 3600.0 / metresPerDeg;
    float shiftDeg = degPerHour * shearHours + bulkDeg;
    // Clouds moving east means sampling air that was further west.
    return vec2(uv.x - shiftDeg / 360.0, uv.y);
  }

  /** Cloud opacity at \`uv\`, tolerant of both encodings the source can use:
   *  white-on-alpha (the live composite) and bright-on-black (the fallback). */
  float cloudDensity(sampler2D map, vec2 uv) {
    vec4 c = texture2D(map, uv);
    return clamp(c.a * max(max(c.r, c.g), c.b), 0.0, 1.0);
  }
`;

export function Earth({
  simulatedTimeRef,
  showClouds = true,
  showAtmosphere = true,
  showNightLights = true,
  enableMovement = true,
}: EarthProps) {
  const earthRef = useRef<THREE.Mesh>(null);
  const cloudsRef = useRef<THREE.Mesh>(null);

  // Surface maps + the bundled static cloud map: all local, load instantly.
  const [colorMap, lightsMap, specularMap, staticCloudsMap] = useLoader(
    THREE.TextureLoader,
    [...EARTH_TEXTURE_URLS, STATIC_CLOUDS_URL]
  );
  const surfaceTextures = useMemo(
    () => [colorMap, lightsMap, specularMap],
    [colorMap, lightsMap, specularMap]
  );

  // Cloud map shown on the mesh. Normally live on the very FIRST frame: startup
  // fetches the composite behind the splash screen and lib/clouds keeps it, so
  // this reads it straight out of the module instead of painting the bundled
  // fallback and popping a second later. The fallback is only what you get when
  // the prefetch did not finish in time or failed outright.
  //
  // `epochMs` is when the composite was captured (or, failing that, fetched) —
  // the anchor the advection integrates from. Null for the bundled fallback,
  // whose real capture date is unknown; that case anchors to UTC midnight of the
  // displayed day, so the layer still circulates without implying it is a
  // nowcast of any particular hour.
  const [clouds, setClouds] = useState<{ map: THREE.Texture; epochMs: number | null }>(() => {
    const live = getCloudTexture();
    if (!live) return { map: staticCloudsMap, epochMs: null };
    const s = getCloudStatus();
    return { map: live, epochMs: s.capturedMs ?? s.fetchedMs ?? null };
  });

  // Max anisotropic filtering: the single biggest sharpness win when the
  // globe is viewed at an angle or zoomed in (mipmap blur otherwise).
  const { gl } = useThree();
  useEffect(() => {
    const maxAniso = gl.capabilities.getMaxAnisotropy();
    for (const t of [...surfaceTextures, staticCloudsMap]) {
      t.anisotropy = maxAniso;
      t.needsUpdate = true;
    }
    // The cloud layer is sampled at a longitude offset that grows with time, so
    // its u coordinate has to wrap: clamping would smear the last column of
    // pixels right across the Pacific.
    staticCloudsMap.wrapS = THREE.RepeatWrapping;
    staticCloudsMap.wrapT = THREE.ClampToEdgeWrapping;
  }, [surfaceTextures, staticCloudsMap, gl]);

  // Keep the live map current: join the startup prefetch, then re-check
  // periodically while the tab is visible. Fully non-blocking — on any failure
  // whatever is already on the mesh simply stays, and the drift anchor falls
  // back to UTC midnight instead of pretending to know a capture time.
  //
  // Textures are owned by lib/clouds, not by this component: the globe unmounts
  // every time the user visits the Solar System, and disposing on unmount would
  // mean re-downloading 7 MB on every trip back.
  useEffect(() => {
    const controller = new AbortController();
    const maxAniso = gl.capabilities.getMaxAnisotropy();
    let inflight = false;
    let first = true;

    const refresh = async () => {
      if (inflight) return; // the interval and the visibility handler can coincide
      inflight = true;
      // The first load JOINS the session's prefetch rather than starting a
      // second request for the same picture; only later refreshes issue their
      // own (abortable) fetch.
      const load = first ? preloadCloudTexture() : loadCloudTexture(controller.signal);
      first = false;
      const { texture, status } = await load.finally(() => { inflight = false; });
      if (!texture || controller.signal.aborted) return;
      texture.anisotropy = maxAniso;
      texture.needsUpdate = true;
      setClouds({ map: texture, epochMs: status.capturedMs ?? status.fetchedMs ?? null });
    };

    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, CLOUD_REFRESH_MS);
    // Coming back to a tab that slept through several rebuilds should catch up
    // immediately rather than waiting out the rest of the interval.
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const loaded = getCloudStatus().loadedMs;
      if (!loaded || Date.now() - loaded > CLOUD_REFRESH_MS) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [gl]);

  const uniforms = useMemo(() => ({
    uDayTexture: { value: colorMap },
    uNightTexture: { value: lightsMap },
    uSpecularTexture: { value: specularMap },
    uCloudTexture: { value: null as THREE.Texture | null },
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uShowAtmosphere: { value: 1.0 },
    uShowNightLights: { value: 1.0 },
    // Cloud shadows cast onto the surface. Zero when the cloud layer is hidden,
    // so the two toggles never disagree about whether there are clouds.
    uCloudShadow: { value: 1.0 },
    uDriftHours: { value: 0.0 },
    uBulkDeg: { value: 0.0 },
  }), [colorMap, lightsMap, specularMap]);

  const cloudUniforms = useMemo(() => ({
    uCloudTexture: { value: null as THREE.Texture | null },
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uDriftHours: { value: 0.0 },
    uBulkDeg: { value: 0.0 },
  }), []);

  // The map arrives (and is later replaced) asynchronously; both materials read
  // the same texture so the shadow always matches the cloud that casts it.
  useEffect(() => {
    uniforms.uCloudTexture.value = clouds.map;
    cloudUniforms.uCloudTexture.value = clouds.map;
  }, [clouds, uniforms, cloudUniforms]);

  const outerAtmosphereUniforms = useMemo(() => ({
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uShowAtmosphere: { value: 1.0 },
  }), []);

  const earthMaterialRef = useRef<THREE.ShaderMaterial>(null);
  const atmosphereMaterialRef = useRef<THREE.ShaderMaterial>(null);
  const cloudMaterialRef = useRef<THREE.ShaderMaterial>(null);
  const sunDirScratch = useMemo(() => new THREE.Vector3(), []);

  // Last drift value applied, in hours. Held (not advanced) while Run is off so
  // the deck freezes with everything else, and reused as the value to fall back
  // on rather than snapping to zero.
  const lastDriftRef = useRef(0);
  // Accumulated bulk roll (degrees, wrapped) and the simulated time of the
  // previous frame — the roll is INTEGRATED per frame rather than derived from
  // total elapsed time, which is what lets its real-world rate be capped.
  const bulkDegRef = useRef(0);
  const prevSimMsRef = useRef<number | null>(null);

  useFrame((_state, delta) => {
    const time = simulatedTimeRef?.current ?? new Date();

    // Physically accurate sun direction (low-precision solar ephemeris, ~0.01°),
    // expressed in the same world/ECI-mapped frame the satellites live in.
    // The shader works entirely in world space, so the terminator is exactly
    // 90° from the subsolar point — no offset.
    getSunSceneDirection(time, sunDirScratch);

    // Two coupled cloud motions, both driven ENTIRELY by the simulated clock —
    // so the Earth-view Warp scales them and Pause stops them:
    //
    //  driftHours — the physical three-cell circulation, anchored to the
    //    imagery's capture time so the first hours are a genuine persistence
    //    nowcast. CLAMPED to ±MAX_DRIFT_HOURS: this term shears (each latitude
    //    circle moves at its own rate) and would ribbon the map over a long warp.
    //  bulkDeg — a uniform eastward roll of the whole field, integrated frame by
    //    frame. This is the motion the eye follows. Unbounded and wrapped, so it
    //    never saturates and freezes the way the old single clamped drift did.
    const simMs = time.getTime();
    const prevSimMs = prevSimMsRef.current;
    prevSimMsRef.current = simMs;

    const anchorMs = clouds.epochMs
      ?? Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate());
    const elapsedHours = (simMs - anchorMs) / 3600000;
    const driftHours = enableMovement
      ? Math.max(-MAX_DRIFT_HOURS, Math.min(MAX_DRIFT_HOURS, elapsedHours))
      : lastDriftRef.current;
    lastDriftRef.current = driftHours;

    if (enableMovement && prevSimMs !== null) {
      const simHours = (simMs - prevSimMs) / 3600000;
      let step = simHours * CLOUD_BULK_DEG_PER_HOUR * CLOUD_VISIBILITY_BOOST;
      // Rate cap, in degrees per REAL second: keeps the top warp presets (and
      // any time-travel jump) from turning the deck into a strobe.
      const maxStep = CLOUD_MAX_DEG_PER_SEC * Math.max(delta, 1 / 240);
      if (step > maxStep) step = maxStep;
      else if (step < -maxStep) step = -maxStep;
      // Wrapped: the sampler repeats in u, and keeping the accumulator small
      // preserves float precision over a long session.
      bulkDegRef.current = (bulkDegRef.current + step) % 360;
    }
    const bulkDeg = bulkDegRef.current;

    if (earthMaterialRef.current) {
      const u = earthMaterialRef.current.uniforms;
      u.uShowAtmosphere.value = showAtmosphere ? 1.0 : 0.0;
      u.uShowNightLights.value = showNightLights ? 1.0 : 0.0;
      u.uCloudShadow.value = showClouds ? 1.0 : 0.0;
      u.uDriftHours.value = driftHours;
      u.uBulkDeg.value = bulkDeg;
      u.uSunDirection.value.copy(sunDirScratch);
      // Bind the cloud composite through the live material uniform, exactly like
      // every other uniform here. Setting it only on the memoized `uniforms`
      // object (in an effect) silently missed: r3f does not keep
      // `material.uniforms` referentially identical to that object, so the
      // sampler stayed null on the GPU and the shadow term read as zero.
      u.uCloudTexture.value = clouds.map;
    }
    if (cloudMaterialRef.current) {
      const u = cloudMaterialRef.current.uniforms;
      u.uDriftHours.value = driftHours;
      u.uBulkDeg.value = bulkDeg;
      u.uSunDirection.value.copy(sunDirScratch);
      // The reason the cloud LAYER was invisible: same detached-uniform issue.
      // Written through the material ref, the sampler is bound and the deck
      // renders on the very next frame.
      u.uCloudTexture.value = clouds.map;
    }
    if (atmosphereMaterialRef.current) {
      const u = atmosphereMaterialRef.current.uniforms;
      u.uShowAtmosphere.value = showAtmosphere ? 1.0 : 0.0;
      u.uSunDirection.value.copy(sunDirScratch);
    }

    // Earth rotation from GMST (Greenwich Mean Sidereal Time), computed from
    // the UTC timestamp — the user's local timezone plays no part in this.
    //
    // Alignment derivation: three.js SphereGeometry places texture u=0.5
    // (longitude 0°, Greenwich) on the +X model axis. GMST is the eastward
    // angle from the vernal equinox (ECI +X) to the Greenwich meridian, and
    // our ECI→scene mapping sends an ECI angle α to scene (cos α, 0, −sin α),
    // which is exactly what rotation.y = α produces for model +X. Therefore
    // rotation.y = gmst — with no offset. Combined with the ephemeris sun
    // vector (also ECI), the terminator falls exactly 90° from the subsolar
    // point over the correct geography.
    const gmst = satellite.gstime(time);
    if (earthRef.current) {
      earthRef.current.rotation.y = gmst;
    }
    if (cloudsRef.current) {
      // The MESH still rides the crust's GMST: that is what keeps the composite
      // geographically registered. The relative motion of the air lives in the
      // shader's uv offset instead, where it can vary with latitude — a solid
      // extra spin here would shear the whole atmosphere as one rigid shell,
      // which is exactly the thing real circulation does not do.
      cloudsRef.current.rotation.y = gmst;
    }
  });

  return (
    <group>
      {/* Earth with day/night shader evaluated in world space.
          DoubleSide: the globe must never read as a hollow shell. From any
          camera position — including inside, which the collision guard
          prevents but a fast zoom can momentarily reach — the surface is
          drawn, so the planet always looks solid. */}
      <mesh ref={earthRef}>
        <sphereGeometry args={[1, 128, 128]} />
        <shaderMaterial
          ref={earthMaterialRef}
          side={THREE.DoubleSide}
          uniforms={uniforms}
          vertexShader={`
            precision highp float;
            #include <common>
            #include <logdepthbuf_pars_vertex>
            varying vec2 vUv;
            varying vec3 vWorldNormal;
            varying vec3 vViewDir;

            void main() {
              vUv = uv;
              // World-space normal: rotates with the globe so lighting stays
              // fixed relative to the Sun, not the texture.
              vWorldNormal = normalize(mat3(modelMatrix) * normal);
              vec4 worldPosition = modelMatrix * vec4(position, 1.0);
              vViewDir = normalize(cameraPosition - worldPosition.xyz);
              gl_Position = projectionMatrix * viewMatrix * worldPosition;
              #include <logdepthbuf_vertex>
            }
          `}
          fragmentShader={`
            precision highp float;
            #include <common>
            #include <logdepthbuf_pars_fragment>
            varying vec2 vUv;
            varying vec3 vWorldNormal;
            varying vec3 vViewDir;

            uniform sampler2D uDayTexture;
            uniform sampler2D uNightTexture;
            uniform sampler2D uSpecularTexture;
            uniform sampler2D uCloudTexture;
            uniform vec3 uSunDirection;
            uniform float uShowAtmosphere;
            uniform float uShowNightLights;
            uniform float uCloudShadow;
            uniform float uDriftHours;
            uniform float uBulkDeg;

            ${CLOUD_ADVECTION_GLSL}

            void main() {
              #include <logdepthbuf_fragment>
              vec3 normal = normalize(vWorldNormal);
              vec3 sunDir = normalize(uSunDirection);
              float dotSun = dot(normal, sunDir);

              vec4 dayColor = texture2D(uDayTexture, vUv);
              vec4 nightColor = texture2D(uNightTexture, vUv);
              vec4 specularColor = texture2D(uSpecularTexture, vUv);

              // Terminator: soft twilight band around dotSun == 0 (the true
              // great circle 90° from the subsolar point).
              float dayFactor = smoothstep(-0.08, 0.08, dotSun);

              float diffuse = max(dotSun, 0.0) * 1.4 + 0.08;

              // Cloud shadow. The same advected sample the cloud mesh draws, so
              // the shadow is always under the cloud that casts it — and because
              // it darkens the SURFACE rather than tinting the cloud, the layer
              // reads as something with thickness floating above the ground
              // instead of a decal printed on it.
              float shade = uCloudShadow > 0.5
                ? cloudDensity(uCloudTexture, cloudUv(vUv, uDriftHours, uBulkDeg))
                : 0.0;

              vec3 daySide = dayColor.rgb * diffuse * (1.0 - 0.45 * shade);

              // Ocean specular
              vec3 viewDir = normalize(vViewDir);
              vec3 reflectDir = reflect(-sunDir, normal);
              float specAngle = max(dot(reflectDir, viewDir), 0.0);
              float specularFactor = pow(specAngle, 32.0) * specularColor.r;
              // Sun glint does not survive a cloud deck.
              daySide += vec3(0.6, 0.8, 1.0) * specularFactor * max(dotSun, 0.0) * 0.5
                * (1.0 - shade);

              // Night side stays visibly SOLID: city lights plus a faint
              // moonlit rendering of the day texture, so the dark hemisphere
              // never reads as a hole against the starfield.
              vec3 nightSide = nightColor.rgb * 1.35 * uShowNightLights
                + dayColor.rgb * vec3(0.028, 0.032, 0.045)
                + vec3(0.006, 0.008, 0.013);

              vec3 finalColor = mix(nightSide, daySide, dayFactor);

              if (uShowAtmosphere > 0.5) {
                float rim = 1.0 - max(dot(normal, viewDir), 0.0);
                rim = pow(rim, 3.0);
                vec3 atmosphereGlow = vec3(0.30, 0.50, 0.90) * rim * 0.25;
                float glowMask = smoothstep(-0.2, 0.3, dotSun);
                finalColor += atmosphereGlow * glowMask;
              }

              gl_FragColor = vec4(finalColor, 1.0);
            }
          `}
        />
      </mesh>

      {/* Cloud layer.
          A shader rather than meshStandardMaterial for two reasons: the uv
          offset that carries the air along its latitude circle has to happen
          per-fragment, and the surface below is lit by an ephemeris sun vector
          that no scene light knows about — so a standard material would have
          left the clouds lit from a different direction than the ground. */}
      <mesh ref={cloudsRef} visible={showClouds}>
        <sphereGeometry args={[1.006, 96, 96]} />
        <shaderMaterial
          ref={cloudMaterialRef}
          side={THREE.DoubleSide}
          uniforms={cloudUniforms}
          vertexShader={`
            precision highp float;
            #include <common>
            #include <logdepthbuf_pars_vertex>
            varying vec2 vUv;
            varying vec3 vWorldNormal;
            varying vec3 vViewDir;
            void main() {
              vUv = uv;
              vWorldNormal = normalize(mat3(modelMatrix) * normal);
              vec4 worldPosition = modelMatrix * vec4(position, 1.0);
              vViewDir = normalize(cameraPosition - worldPosition.xyz);
              gl_Position = projectionMatrix * viewMatrix * worldPosition;
              #include <logdepthbuf_vertex>
            }
          `}
          fragmentShader={`
            precision highp float;
            #include <common>
            #include <logdepthbuf_pars_fragment>
            varying vec2 vUv;
            varying vec3 vWorldNormal;
            varying vec3 vViewDir;

            uniform sampler2D uCloudTexture;
            uniform vec3 uSunDirection;
            uniform float uDriftHours;
            uniform float uBulkDeg;

            ${CLOUD_ADVECTION_GLSL}

            void main() {
              #include <logdepthbuf_fragment>
              float density = cloudDensity(uCloudTexture, cloudUv(vUv, uDriftHours, uBulkDeg));
              if (density < 0.004) discard;

              vec3 normal = normalize(vWorldNormal);
              vec3 viewDir = normalize(vViewDir);
              vec3 sunDir = normalize(uSunDirection);
              float dotSun = dot(normal, sunDir);
              float day = smoothstep(-0.14, 0.14, dotSun);

              // Sunlit cloud tops.
              vec3 color = vec3(1.0) * (0.15 + 1.0 * max(dotSun, 0.0));
              // Sunrise/sunset reddening: the light reaching cloud tops at the
              // terminator has been through a long slant path of atmosphere.
              float grazing = smoothstep(0.26, 0.0, abs(dotSun));
              color = mix(color, vec3(1.0, 0.68, 0.46) * (0.30 + max(dotSun, 0.0)), grazing * 0.6);
              // Night side: faint, so the deck stays legible over the city lights
              // without washing them out.
              color = mix(vec3(0.052, 0.066, 0.10), color, day);

              // Limb thickening: a cloud seen edge-on is a longer path through
              // the same layer, which is why the deck looks denser at the rim.
              float mu = max(dot(normal, viewDir), 0.0);
              float slant = clamp(1.0 / max(mu, 0.34), 1.0, 2.1);

              float alpha = clamp(density * 0.92 * slant, 0.0, 0.96);
              gl_FragColor = vec4(color, alpha);
            }
          `}
          transparent={true}
          depthWrite={false}
        />
      </mesh>

      {/* Outer atmospheric haze */}
      <mesh visible={showAtmosphere}>
        <sphereGeometry args={[1.035, 48, 48]} />
        <shaderMaterial
          ref={atmosphereMaterialRef}
          uniforms={outerAtmosphereUniforms}
          vertexShader={`
            precision highp float;
            #include <common>
            #include <logdepthbuf_pars_vertex>
            varying vec3 vWorldNormal;
            varying vec3 vViewDir;
            void main() {
              vWorldNormal = normalize(mat3(modelMatrix) * normal);
              vec4 worldPosition = modelMatrix * vec4(position, 1.0);
              vViewDir = normalize(cameraPosition - worldPosition.xyz);
              gl_Position = projectionMatrix * viewMatrix * worldPosition;
              #include <logdepthbuf_vertex>
            }
          `}
          fragmentShader={`
            precision highp float;
            #include <common>
            #include <logdepthbuf_pars_fragment>
            varying vec3 vWorldNormal;
            varying vec3 vViewDir;
            uniform vec3 uSunDirection;
            uniform float uShowAtmosphere;
            void main() {
              #include <logdepthbuf_fragment>
              if (uShowAtmosphere < 0.5) discard;
              vec3 normal = normalize(vWorldNormal);
              vec3 viewDir = normalize(vViewDir);

              float rim = 1.0 - max(dot(normal, viewDir), 0.0);
              rim = pow(rim, 3.5);

              float glowMask = smoothstep(-0.4, 0.2, dot(normal, normalize(uSunDirection)));
              vec3 color = vec3(0.32, 0.55, 0.95) * rim * 1.5 * glowMask;
              gl_FragColor = vec4(color, rim * 0.4 * glowMask);
            }
          `}
          transparent={true}
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
