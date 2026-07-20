// Perfectly round satellite dots.
//
// The old instanced low-poly spheres (4–5 segments — the cheapest thing that
// renders at 10k+ instances) read as jagged, "incomplete" circles. Instead of
// paying for high-poly spheres, each satellite is now a tiny 2-triangle quad
// that is billboarded toward the camera in the vertex shader and clipped to a
// mathematically exact disc in the fragment shader — a perfect circle from
// every angle, at a fraction of the old vertex cost.
//
// Works with InstancedMesh exactly like the sphere version did:
//  - three defines USE_INSTANCING / USE_INSTANCING_COLOR for the program, so
//    instanceMatrix / instanceColor attributes are available in the shader;
//  - per-instance color via setColorAt, per-instance hide via scale 0;
//  - log-depth chunks included so depth testing against the globe (which uses
//    the renderer-wide logarithmic depth buffer) stays exact.

import * as THREE from 'three';

/** Quad geometry spanning ±radius, matching the visual size of the sphere
 *  geometry it replaces (sphere radius == circle radius). */
export function createCircleSpriteGeometry(radius: number): THREE.PlaneGeometry {
  return new THREE.PlaneGeometry(radius * 2, radius * 2);
}

export function createCircleSpriteMaterial(opts?: { opacity?: number }): THREE.ShaderMaterial {
  const opacity = opts?.opacity ?? 1.0;
  return new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: opacity },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vColor;

      void main() {
        vUv = uv;
        #ifdef USE_INSTANCING_COLOR
          vColor = instanceColor;
        #else
          vColor = vec3(1.0);
        #endif

        // Billboard: place the instance center in view space, then offset the
        // quad corners in the view plane (scaled by the instance's uniform
        // scale — 0 hides it, matching the old sphere behavior).
        #ifdef USE_INSTANCING
          vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float s = length(instanceMatrix[0].xyz);
        #else
          vec4 mvPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float s = 1.0;
        #endif
        mvPosition.xy += position.xy * s;
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      varying vec2 vUv;
      varying vec3 vColor;
      uniform float uOpacity;

      void main() {
        #include <logdepthbuf_fragment>
        // Exact disc: discard fragments outside radius 0.5 in UV space
        vec2 d = vUv - 0.5;
        if (dot(d, d) > 0.25) discard;
        gl_FragColor = vec4(vColor, uOpacity);
      }
    `,
    transparent: opacity < 1.0,
    toneMapped: false,
  });
}
