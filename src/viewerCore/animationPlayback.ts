import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import type { AnimatedObject, SkelAnimationData } from './types';
import { getPrimPropAtTime } from './usdAnim';
import { parsePoint3ArrayToFloat32 } from './usdParse';
import { applyXformOps } from './threeXform';
import { skeletonDebugSettings } from './renderPrim/skeleton';

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
    } else if (a.kind === 'skeleton') {
      applySkeletonAnimationAtTime(a, time);
    }
  }
}

/**
 * Apply SkelAnimation to skeleton bones at a given time.
 * SkelAnimation provides rotations (quatf[]), translations (float3[]), and scales (half3[])
 * as time-sampled arrays indexed by joint.
 */
function applySkeletonAnimationAtTime(
  anim: Extract<AnimatedObject, { kind: 'skeleton' }>,
  time: number
): void {
  const { skeleton, bones, animData, unitScale, bindTransforms } = anim;
  const { animPrim, jointToBoneIndex } = animData;

  // Get animated transforms at current time
  const rotations = getPrimPropAtTime(animPrim, 'rotations', time);
  const translations = getPrimPropAtTime(animPrim, 'translations', time);
  const scales = getPrimPropAtTime(animPrim, 'scales', time);

  // Parse rotation quaternions (quatf[] = 4 floats per joint: x, y, z, w)
  const rotArr = rotations?.type === 'typedArray' ? rotations.value as Float32Array : null;
  // Parse translations (float3[] = 3 floats per joint)
  const transArr = translations?.type === 'typedArray' ? translations.value as Float32Array : null;
  // Parse scales (half3[] stored as float = 3 floats per joint)
  const scaleArr = scales?.type === 'typedArray' ? scales.value as Float32Array : null;

  const numAnimJoints = animData.joints.length;

  // For each animated joint, compute the world-space transform and convert to local
  // SkelAnimation transforms are local-space (relative to parent joint)
  const animWorldTransforms: THREE.Matrix4[] = [];

  for (let animJointIdx = 0; animJointIdx < numAnimJoints; animJointIdx++) {
    const boneIdx = jointToBoneIndex[animJointIdx];
    if (boneIdx === undefined || boneIdx < 0 || boneIdx >= bones.length) continue;

    const bone = bones[boneIdx]!;

    // Get animated local transform components
    const pos = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    const scale = new THREE.Vector3(1, 1, 1);

    if (transArr && animJointIdx * 3 + 2 < transArr.length) {
      pos.set(
        transArr[animJointIdx * 3]! * unitScale,
        transArr[animJointIdx * 3 + 1]! * unitScale,
        transArr[animJointIdx * 3 + 2]! * unitScale
      );
    }

    if (rotArr && animJointIdx * 4 + 3 < rotArr.length) {
      // USD quaternions from our parser are stored as (w, x, y, z) - USDA text format
      // Three.js Quaternion expects (x, y, z, w)
      const w = rotArr[animJointIdx * 4]!;
      const x = rotArr[animJointIdx * 4 + 1]!;
      const y = rotArr[animJointIdx * 4 + 2]!;
      const z = rotArr[animJointIdx * 4 + 3]!;
      rot.set(x, y, z, w);
    }

    if (scaleArr && animJointIdx * 3 + 2 < scaleArr.length) {
      scale.set(
        scaleArr[animJointIdx * 3]!,
        scaleArr[animJointIdx * 3 + 1]!,
        scaleArr[animJointIdx * 3 + 2]!
      );
    }

    // Apply local transform to bone
    bone.position.copy(pos);
    bone.quaternion.copy(rot);
    bone.scale.copy(scale);
    bone.updateMatrix();
  }

  // Find bone root (parent of root bones) and update all world matrices
  // This ensures bone.matrixWorld is current when computing bone matrices
  const rootBones = bones.filter(b => !(b.parent instanceof THREE.Bone));
  for (const rootBone of rootBones) {
    const boneRoot = rootBone.parent;
    if (boneRoot) {
      boneRoot.updateMatrixWorld(true);
    } else {
      rootBone.updateMatrixWorld(true);
    }
  }

  // Apply debug synthetic rotation if enabled
  if (skeletonDebugSettings.syntheticBoneRotation !== 0) {
    const syntheticRot = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      skeletonDebugSettings.syntheticBoneRotation
    );
    for (const bone of bones) {
      bone.quaternion.multiply(syntheticRot);
      bone.updateMatrix();
    }
    // Re-update world matrices after applying synthetic rotation
    for (const rootBone of rootBones) {
      const boneRoot = rootBone.parent;
      if (boneRoot) {
        boneRoot.updateMatrixWorld(true);
      } else {
        rootBone.updateMatrixWorld(true);
      }
    }
  }

  // Update skeleton's bone matrices for skinning
  skeleton.update();
}

/**
 * Apply synthetic debug rotation to all skeleton animated objects.
 * Stores base pose quaternions and applies rotation on top of them to avoid accumulation.
 */
export function applySyntheticRotationToSkeletons(animatedObjects: AnimatedObject[]): void {
  for (const a of animatedObjects) {
    if (a.kind !== 'skeleton') continue;
    
    const { skeleton, bones } = a;
    
    // Store base pose quaternions if not already stored
    const stored = (a as any).__basePoseQuaternions as THREE.Quaternion[] | undefined;
    if (!stored) {
      (a as any).__basePoseQuaternions = bones.map(b => b.quaternion.clone());
    }
    const baseQuaternions = (a as any).__basePoseQuaternions as THREE.Quaternion[];
    
    // Apply base pose + synthetic rotation
    const syntheticRot = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      skeletonDebugSettings.syntheticBoneRotation
    );
    
    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i]!;
      // Start from base pose, then apply synthetic rotation
      bone.quaternion.copy(baseQuaternions[i]!).multiply(syntheticRot);
      bone.updateMatrix();
    }
    
    // Update world matrices
    const rootBones = bones.filter(b => !(b.parent instanceof THREE.Bone));
    for (const rootBone of rootBones) {
      const boneRoot = rootBone.parent;
      if (boneRoot) {
        boneRoot.updateMatrixWorld(true);
      } else {
        rootBone.updateMatrixWorld(true);
      }
    }
    
    skeleton.update();
  }
}

