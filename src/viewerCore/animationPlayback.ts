import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import type { AnimatedObject } from './types';
import { getPrimPropAtTime } from './usdAnim';
import { parsePoint3ArrayToFloat32 } from './usdParse';
import { applyXformOps } from './threeXform';

export function advanceAnimationPlayback(opts: {
  timestamp: number;
  animationPlaying: boolean;
  animationCurrentTime: number;
  animationStartTime: number;
  animationEndTime: number;
  animationFps: number;
  lastAnimationFrameTime: number;
  animatedObjects: AnimatedObject[];
}): { animationCurrentTime: number; lastAnimationFrameTime: number } {
  let {
    timestamp,
    animationPlaying,
    animationCurrentTime,
    animationStartTime,
    animationEndTime,
    animationFps,
    lastAnimationFrameTime,
    animatedObjects,
  } = opts;

  // Animation playback
  if (animationPlaying && animatedObjects.length > 0) {
    // Calculate frame advancement based on real time
    if (lastAnimationFrameTime === 0) {
      lastAnimationFrameTime = timestamp;
    }
    const deltaMs = timestamp - lastAnimationFrameTime;
    lastAnimationFrameTime = timestamp;

    // Advance time based on FPS
    const deltaTime = (deltaMs / 1000) * animationFps;
    animationCurrentTime += deltaTime;

    // Loop animation
    if (animationCurrentTime > animationEndTime) {
      animationCurrentTime = animationStartTime + (animationCurrentTime - animationEndTime);
    }

    applyAnimatedObjectsAtTime({ animatedObjects, time: animationCurrentTime });
  } else {
    lastAnimationFrameTime = 0; // Reset when paused
  }

  return { animationCurrentTime, lastAnimationFrameTime };
}

export function applyAnimatedObjectsAtTime(opts: {
  animatedObjects: AnimatedObject[];
  time: number;
}): void {
  const { animatedObjects, time } = opts;

  // Update all animated objects immediately
  for (const a of animatedObjects) {
    if (a.kind === 'xform') {
      // Xform evaluation should not apply metersPerUnit scaling.
      applyXformOps(a.obj, a.prim as SdfPrimSpec, time, 1.0);
    } else if (a.kind === 'points') {
      const pts = parsePoint3ArrayToFloat32(getPrimPropAtTime(a.prim as SdfPrimSpec, 'points', time));
      if (!pts) continue;
      if (a.unitScale !== 1.0) {
        for (let i = 0; i < pts.length; i++) pts[i] = pts[i]! * a.unitScale;
      }
      for (const g of a.geoms) {
        const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!pos || !pos.array || pos.itemSize !== 3) continue;
        if (pos.array.length !== pts.length) continue;
        (pos.array as any).set(pts as any);
        pos.needsUpdate = true;
      }
    }
  }
}


