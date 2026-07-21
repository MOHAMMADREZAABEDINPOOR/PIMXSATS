'use client';

/* eslint-disable react-hooks/immutability -- react-three-fiber renders by
   mutating three.js objects (textures, materials) inside effects/useFrame;
   that is the library's intended imperative API. */

import { useLoader, useFrame, useThree } from '@react-three/fiber';
import { useRef, useMemo, useEffect, useState } from 'react';
import * as THREE from 'three';
import * as satellite from 'satellite.js';
import { getSunSceneDirection } from '@/lib/astronomy';

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

// The cloud layer is live data (refreshed a few times a day). It loads OFF the
// critical path: the bundled static map shows instantly, then the live map
// from /api/clouds silently replaces it when/if it arrives. A weak connection
// never delays or breaks startup — the static clouds simply stay.
const STATIC_CLOUDS_URL = '/textures/earth_clouds.png';
const LIVE_CLOUDS_URL = '/api/clouds';

interface EarthProps {
  simulatedTimeRef?: React.MutableRefObject<Date>;
  showClouds?: boolean;
  showAtmosphere?: boolean;
  showNightLights?: boolean;
  enableMovement?: boolean;
}

export function Earth({
  simulatedTimeRef,
  showClouds = true,
  showAtmosphere = true,
  showNightLights = true,
  enableMovement = true
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

  // Cloud map shown on the mesh: starts as the bundled static one, upgraded to
  // the live map in the background without ever blocking the render.
  const [cloudsMap, setCloudsMap] = useState<THREE.Texture>(staticCloudsMap);
  useEffect(() => { setCloudsMap((c) => (c === staticCloudsMap ? staticCloudsMap : c)); }, [staticCloudsMap]);

  // Max anisotropic filtering: the single biggest sharpness win when the
  // globe is viewed at an angle or zoomed in (mipmap blur otherwise).
  const { gl } = useThree();
  useEffect(() => {
    const maxAniso = gl.capabilities.getMaxAnisotropy();
    for (const t of [...surfaceTextures, staticCloudsMap]) {
      t.anisotropy = maxAniso;
      t.needsUpdate = true;
    }
  }, [surfaceTextures, staticCloudsMap, gl]);

  // Background upgrade to the live cloud map. Fully non-blocking: on any
  // failure or a weak connection the static clouds simply remain.
  useEffect(() => {
    let cancelled = false;
    const maxAniso = gl.capabilities.getMaxAnisotropy();
    new THREE.TextureLoader().load(
      LIVE_CLOUDS_URL,
      (tex) => {
        if (cancelled) { tex.dispose(); return; }
        tex.anisotropy = maxAniso;
        tex.colorSpace = staticCloudsMap.colorSpace;
        tex.needsUpdate = true;
        setCloudsMap(tex);
      },
      undefined,
      () => { /* keep the bundled static clouds */ }
    );
    return () => { cancelled = true; };
  }, [gl, staticCloudsMap]);

  const uniforms = useMemo(() => ({
    uDayTexture: { value: colorMap },
    uNightTexture: { value: lightsMap },
    uSpecularTexture: { value: specularMap },
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uShowAtmosphere: { value: 1.0 },
    uShowNightLights: { value: 1.0 },
  }), [colorMap, lightsMap, specularMap]);

  const outerAtmosphereUniforms = useMemo(() => ({
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uShowAtmosphere: { value: 1.0 },
  }), []);

  const earthMaterialRef = useRef<THREE.ShaderMaterial>(null);
  const atmosphereMaterialRef = useRef<THREE.ShaderMaterial>(null);
  const sunDirScratch = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const time = simulatedTimeRef?.current ?? new Date();

    // Physically accurate sun direction (low-precision solar ephemeris, ~0.01°),
    // expressed in the same world/ECI-mapped frame the satellites live in.
    // The shader works entirely in world space, so the terminator is exactly
    // 90° from the subsolar point — no offset.
    getSunSceneDirection(time, sunDirScratch);

    if (earthMaterialRef.current) {
      const u = earthMaterialRef.current.uniforms;
      u.uShowAtmosphere.value = showAtmosphere ? 1.0 : 0.0;
      u.uShowNightLights.value = showNightLights ? 1.0 : 0.0;
      u.uSunDirection.value.copy(sunDirScratch);
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
      cloudsRef.current.rotation.y = gmst + (enableMovement ? 0.05 : 0);
    }
  });

  return (
    <group>
      {/* Earth with day/night shader evaluated in world space */}
      <mesh ref={earthRef}>
        <sphereGeometry args={[1, 128, 128]} />
        <shaderMaterial
          ref={earthMaterialRef}
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
            uniform vec3 uSunDirection;
            uniform float uShowAtmosphere;
            uniform float uShowNightLights;

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
              vec3 daySide = dayColor.rgb * diffuse;

              // Ocean specular
              vec3 viewDir = normalize(vViewDir);
              vec3 reflectDir = reflect(-sunDir, normal);
              float specAngle = max(dot(reflectDir, viewDir), 0.0);
              float specularFactor = pow(specAngle, 32.0) * specularColor.r;
              daySide += vec3(0.6, 0.8, 1.0) * specularFactor * max(dotSun, 0.0) * 0.5;

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

      {/* Cloud layer */}
      <mesh ref={cloudsRef} visible={showClouds}>
        <sphereGeometry args={[1.006, 96, 96]} />
        <meshStandardMaterial
          map={cloudsMap}
          transparent={true}
          opacity={0.55}
          roughness={0.9}
          metalness={0.0}
          blending={THREE.NormalBlending}
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
