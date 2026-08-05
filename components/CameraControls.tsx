'use client';

/* eslint-disable react-hooks/immutability -- the controller is a three.js-style
   imperative object; configuring it means assigning to its fields. */

import { useThree, useFrame } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo } from 'react';
import * as THREE from 'three';
import { SmoothControls } from '@/lib/orbit-controls';
import { Sensitivity, GestureView, gainsFor, detectDeviceClass } from '@/lib/interaction';

export interface CameraControlsProps {
  controlsRef: React.MutableRefObject<SmoothControls | null>;
  sensitivity: Sensitivity;
  /** Which scene is being driven. Selects the per-view gain trim: the solar
   *  view rotates and zooms slower than the Earth view from the same gesture
   *  (see VIEW_TRIM in lib/interaction.ts). */
  view?: GestureView;
  noPan?: boolean;
  noRotate?: boolean;
  noZoom?: boolean;
  minDistance?: number;
  maxDistance?: number;
}

/**
 * Mounts SmoothControls into the r3f frame loop.
 *
 * Runs at priority -1, the slot drei's TrackballControls used, so the camera
 * rig (priority 0) still sees a settled pose and can override it for focus
 * tracking, collision push-out and the cinematic tour.
 */
export function CameraControls({
  controlsRef,
  sensitivity,
  view = 'earth',
  noPan = false,
  noRotate = false,
  noZoom = false,
  minDistance = 0,
  maxDistance = Infinity,
}: CameraControlsProps) {
  const { camera, gl, invalidate, size } = useThree();
  // Which of the four input systems (phone / tablet / laptop trackpad / mouse
  // wheel) we are driving. Detected once: it depends on the pointer type and the
  // physical screen, neither of which changes while the tab is open — a window
  // resize or an orientation flip is not a change of device.
  const device = useMemo(() => detectDeviceClass(), []);
  const controls = useMemo(
    () => new SmoothControls(camera as THREE.PerspectiveCamera),
    [camera]
  );
  // Layout effect, so the instance is published before any sibling's effects
  // run — the camera rig reads controlsRef during its own mount.
  useLayoutEffect(() => {
    controls.connect(gl.domElement);
    controlsRef.current = controls;
    return () => {
      controls.dispose();
      if (controlsRef.current === controls) controlsRef.current = null;
    };
  }, [controls, gl, controlsRef]);

  useEffect(() => {
    const onChange = () => invalidate();
    controls.addChangeListener(onChange);
    return () => controls.removeChangeListener(onChange);
  }, [controls, invalidate]);

  // The gesture geometry is measured in CSS px against the canvas rect, so it
  // has to be re-read on every resize — including the orientation flip, which
  // is the one that matters on a phone.
  useEffect(() => {
    controls.handleResize();
  }, [controls, size.width, size.height]);

  useEffect(() => {
    controls.gains = gainsFor(sensitivity, device, view);
  }, [controls, sensitivity, device, view]);

  useEffect(() => {
    controls.noPan = noPan;
    controls.noRotate = noRotate;
    controls.noZoom = noZoom;
    controls.minDistance = minDistance;
    controls.maxDistance = maxDistance;
  }, [controls, noPan, noRotate, noZoom, minDistance, maxDistance]);

  useFrame(() => {
    if (controls.enabled) controls.update();
  }, -1);

  return null;
}
