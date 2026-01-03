import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import { getPrimProp } from '../usdAnim';
import { parseMatrix4dArray } from '../threeXform';
import { buildJointOrderIndexToBoneIndex } from '../usdSkeleton';

// Baseline: match authored mesh pose first.
// For most USD assets, authored mesh points are in bind pose.
const BASELINE_POSE: 'bind' | 'rest' = 'bind';

// Debug: force identity bone matrices to test if issue is in bone transforms or inverses
const FORCE_IDENTITY_BONE_MATRICES = false;

// Correct USD interpretation:
// - bindTransforms are WORLD-SPACE joint transforms at bind pose
// - restTransforms are LOCAL-SPACE joint transforms at rest pose
// - boneInverses = inverse of bindTransforms (world-space)
const USD_CORRECT_BIND_WORLD_SPACE = true;

// IMPORTANT: For skinning to show correct mesh at current pose, bones must be posed
// to the BIND pose (not rest pose) when boneInverses come from bindTransforms.
// Set this to true to pose bones to bind pose for correct skinning display.
const POSE_BONES_TO_BIND = true;

export function renderUsdSkeletonPrim(opts: {
  typeName: string;
  container: THREE.Object3D;
  helpersParent: THREE.Object3D;
  helpers: Map<string, THREE.Object3D>;
  sceneRef: THREE.Scene;
  prim: SdfPrimSpec;
  primPath: string;
  unitScale: number;
  skeletonsToUpdate: Array<{ skeleton: THREE.Skeleton; boneRoot: THREE.Object3D }>;
}): boolean {
  const { typeName, container, helpersParent, helpers, sceneRef, prim, primPath, unitScale, skeletonsToUpdate } = opts;

  // USD Skeleton support - create Three.js Skeleton and SkeletonHelper visualization
  if (typeName === 'Skeleton') {
    // Parse joint names and transforms from USD
    const jointsProp = getPrimProp(prim, 'joints');
    const bindTransformsProp = getPrimProp(prim, 'bindTransforms');
    const restTransformsProp = getPrimProp(prim, 'restTransforms');

    if (jointsProp && typeof jointsProp === 'object' && (jointsProp as any).type === 'array') {
      const jointNames: string[] = (jointsProp as any).value
        .filter((j: any) => typeof j === 'string')
        .map((j: string) => j);

      // Parse bind transforms (4x4 matrices)
      const bindTransforms = parseMatrix4dArray(bindTransformsProp);
      // Parse rest transforms (local space, relative to parent)
      const restTransforms = parseMatrix4dArray(restTransformsProp);

      if (jointNames.length > 0 && (bindTransforms || restTransforms)) {
        // Build joint hierarchy and create Bones
        const bones: THREE.Bone[] = [];
        const boneByName = new Map<string, THREE.Bone>();

        // Create all bones first
        for (let i = 0; i < jointNames.length; i++) {
          const bone = new THREE.Bone();
          bone.name = jointNames[i]!;
          bones.push(bone);
          boneByName.set(jointNames[i]!, bone);
        }

        // Build parent index array (for converting world-space bindTransforms to local-space)
        const parents: number[] = [];
        for (let i = 0; i < jointNames.length; i++) {
          const name = jointNames[i]!;
          const parts = name.split('/');
          if (parts.length > 1) {
            parts.pop();
            const parentName = parts.join('/');
            const parentIdx = jointNames.indexOf(parentName);
            parents.push(parentIdx >= 0 ? parentIdx : -1);
          } else {
            parents.push(-1);
          }
        }

        // Set up parent-child relationships based on joint path hierarchy
        // USD joint names are paths like "boneA", "boneA/boneB", "boneA/boneB/boneC"
        for (let i = 0; i < jointNames.length; i++) {
          const name = jointNames[i]!;
          const bone = bones[i]!;
          const parts = name.split('/');
          if (parts.length > 1) {
            parts.pop();
            const parentName = parts.join('/');
            const parentBone = boneByName.get(parentName);
            if (parentBone) {
              parentBone.add(bone);
            }
          }
        }

        // Apply local transforms to bones
        const applyLocalTransforms = (mats: THREE.Matrix4[] | null) => {
          if (!mats || mats.length !== jointNames.length) return false;
          const pos = new THREE.Vector3();
          const rot = new THREE.Quaternion();
          const scale = new THREE.Vector3();
          for (let i = 0; i < jointNames.length; i++) {
            const m = mats[i];
            if (!m) continue;
            // Apply unit scale to translation component.
            m.decompose(pos, rot, scale);
            pos.multiplyScalar(unitScale);
            bones[i]!.position.copy(pos);
            bones[i]!.quaternion.copy(rot);
            bones[i]!.scale.copy(scale);
            bones[i]!.updateMatrix();
          }
          return true;
        };

        // Apply world-space transforms to bones (for bindTransforms which are world-space)
        const applyWorldTransforms = (mats: THREE.Matrix4[] | null) => {
          if (!mats || mats.length !== jointNames.length) return false;
          const pos = new THREE.Vector3();
          const rot = new THREE.Quaternion();
          const scale = new THREE.Vector3();
          for (let i = 0; i < jointNames.length; i++) {
            const worldMat = mats[i];
            if (!worldMat) continue;
            
            // Convert world-space to local-space
            // local = parentWorld^-1 * boneWorld
            const parentIdx = parents[i];
            let localMat: THREE.Matrix4;
            if (parentIdx >= 0 && mats[parentIdx]) {
              const parentWorldInv = mats[parentIdx]!.clone().invert();
              localMat = parentWorldInv.clone().multiply(worldMat);
            } else {
              // Root bone: local = world
              localMat = worldMat.clone();
            }
            
            localMat.decompose(pos, rot, scale);
            pos.multiplyScalar(unitScale);
            bones[i]!.position.copy(pos);
            bones[i]!.quaternion.copy(rot);
            bones[i]!.scale.copy(scale);
            bones[i]!.updateMatrix();
          }
          return true;
        };

        // Pose skeleton to bind pose if POSE_BONES_TO_BIND is true, otherwise use rest pose
        if (POSE_BONES_TO_BIND && bindTransforms && bindTransforms.length === jointNames.length) {
          // bindTransforms are world-space, convert to local and apply
          applyWorldTransforms(bindTransforms);
        } else {
          // Use rest pose (local transforms)
          applyLocalTransforms(restTransforms ?? bindTransforms);
        }

        // Find the root bone(s) - bones that don't have a parent bone
        // (their parent is either null or not a Bone type)
        const rootBones = bones.filter((b) => !(b.parent instanceof THREE.Bone));

        // Create a wrapper object to hold the bone hierarchy
        const skelRoot = new THREE.Object3D();
        skelRoot.name = `${primPath}/skeleton_root`;
        for (const root of rootBones) {
          skelRoot.add(root);
        }
        container.add(skelRoot);

        // Debug: force identity bone matrices to test if issue is in bone transforms or inverses
        if (FORCE_IDENTITY_BONE_MATRICES) {
          for (const bone of bones) {
            bone.position.set(0, 0, 0);
            bone.quaternion.set(0, 0, 0, 1);
            bone.scale.set(1, 1, 1);
            bone.updateMatrix();
          }
          container.updateWorldMatrix(true, false);
          skelRoot.updateWorldMatrix(true);
        }

        // --- Compute bone inverses (baseline) ---
        // Mesh vertices are authored in bind pose. We need to compute boneInverses from bind pose,
        // but keep skeleton in rest pose for visualization (SkeletonHelper).
        // 1. Temporarily pose bones to bind pose
        // 2. Compute inverses from bind pose
        // 3. Restore rest pose for visualization

        // Keep USD-authored transforms around (used for deferred binding and future bind-pose support).
        (container as any).__usdBindTransforms = bindTransforms ?? null;
        (container as any).__usdRestTransforms = restTransforms ?? null;

        const skeleton = new THREE.Skeleton(bones);

        // Convert bindTransforms from world-space to local-space if needed
        // USD bindTransforms are typically world-space (absolute transforms in bind pose)
        const convertBindToLocal = (bind: THREE.Matrix4[] | null): THREE.Matrix4[] | null => {
          if (!bind || bind.length !== jointNames.length) return null;
          const bindLocal: THREE.Matrix4[] = [];
          for (let i = 0; i < jointNames.length; i++) {
            const bindWorld = bind[i]!;
            const parentIdx = parents[i];
            if (parentIdx >= 0 && parentIdx < bind.length) {
              // Convert world-space to local-space: local = parentWorld^-1 * boneWorld
              const parentWorldInv = bind[parentIdx]!.clone().invert();
              bindLocal.push(parentWorldInv.multiply(bindWorld));
            } else {
              // Root bone: world-space = local-space
              bindLocal.push(bindWorld.clone());
            }
          }
          return bindLocal;
        };

        // Compute bone inverses
        if (FORCE_IDENTITY_BONE_MATRICES) {
          // Identity case: inverses computed from identity pose (already set above)
          container.updateWorldMatrix(true, false);
          skelRoot.updateWorldMatrix(true);
          skeleton.calculateInverses();
        } else if (USD_CORRECT_BIND_WORLD_SPACE && bindTransforms && bindTransforms.length === jointNames.length) {
          // Correct USD interpretation:
          // bindTransforms are WORLD-SPACE joint transforms at bind pose
          // boneInverses = inverse of bindTransforms directly
          // This is what Pixar's USD does: inverseBindTransforms = invert(bindTransforms)
          const boneInverses: THREE.Matrix4[] = [];
          for (let i = 0; i < bindTransforms.length; i++) {
            // Apply unit scale to the translation component of bindTransforms
            const bindWorld = bindTransforms[i]!.clone();
            const pos = new THREE.Vector3();
            const rot = new THREE.Quaternion();
            const scale = new THREE.Vector3();
            bindWorld.decompose(pos, rot, scale);
            pos.multiplyScalar(unitScale);
            const scaledBind = new THREE.Matrix4().compose(pos, rot, scale);
            
            // Invert to get boneInverse (same as USD's inverseBindTransforms)
            boneInverses.push(scaledBind.clone().invert());
          }
          skeleton.boneInverses = boneInverses;
          
          // Skeleton stays in rest pose for visualization (already set above)
        } else if (bindTransforms && bindTransforms.length === jointNames.length) {
          // Try bindTransforms as world-space matrices directly
          // USD bindTransforms are typically world-space (absolute transforms in bind pose)
          // Set bone world matrices directly from bindTransforms, then compute inverses
          for (let i = 0; i < bones.length; i++) {
            const bindWorld = bindTransforms[i]!;
            // Set bone's world matrix directly (this requires setting local transform relative to parent)
            const parentIdx = parents[i];
            if (parentIdx >= 0 && parentIdx < bindTransforms.length) {
              // Convert world-space to local-space: local = parentWorld^-1 * boneWorld
              const parentWorldInv = bindTransforms[parentIdx]!.clone().invert();
              const bindLocal = parentWorldInv.multiply(bindWorld);
              const pos = new THREE.Vector3();
              const rot = new THREE.Quaternion();
              const scale = new THREE.Vector3();
              bindLocal.decompose(pos, rot, scale);
              pos.multiplyScalar(unitScale);
              bones[i]!.position.copy(pos);
              bones[i]!.quaternion.copy(rot);
              bones[i]!.scale.copy(scale);
              bones[i]!.updateMatrix();
            } else {
              // Root bone: world-space = local-space
              const pos = new THREE.Vector3();
              const rot = new THREE.Quaternion();
              const scale = new THREE.Vector3();
              bindWorld.decompose(pos, rot, scale);
              pos.multiplyScalar(unitScale);
              bones[i]!.position.copy(pos);
              bones[i]!.quaternion.copy(rot);
              bones[i]!.scale.copy(scale);
              bones[i]!.updateMatrix();
            }
          }
          container.updateWorldMatrix(true, false);
          skelRoot.updateWorldMatrix(true);
          
          // Manually compute boneInverses from bind pose world matrices
          const boneInverses: THREE.Matrix4[] = [];
          for (const bone of bones) {
            boneInverses.push(bone.matrixWorld.clone().invert());
          }
          skeleton.boneInverses = boneInverses;
          
          // Restore rest pose for visualization
          applyLocalTransforms(restTransforms ?? bindTransforms);
          container.updateWorldMatrix(true, false);
          skelRoot.updateWorldMatrix(true);
        } else {
          // Fallback: compute inverses from current pose (rest or identity)
          container.updateWorldMatrix(true, false);
          skelRoot.updateWorldMatrix(true);
          skeleton.calculateInverses();
        }

        // Store the skeleton on the container for later binding with SkinnedMesh
        (container as any).__usdSkeleton = skeleton;
        (container as any).__usdJointNames = jointNames;

        // Add skeleton and bone root to the update list so it's updated every frame for SkinnedMesh
        skeletonsToUpdate.push({ skeleton, boneRoot: skelRoot });

        // Create and add SkeletonHelper - it draws lines between bones
        const skelHelper = new THREE.SkeletonHelper(skelRoot);
        skelHelper.name = `${primPath}/skeleton_helper`;
        // SkeletonHelper.material is a LineBasicMaterial
        const helperMat = skelHelper.material as THREE.LineBasicMaterial;
        helperMat.linewidth = 2;
        helperMat.color.setHex(0xff6b35); // Orange-red color like reference
        helperMat.depthTest = false;
        helperMat.depthWrite = false;
        skelHelper.renderOrder = 999; // Render on top
        helpersParent.add(skelHelper);

        // Store helper reference for later access
        helpers.set(primPath + '/skeleton_helper', skelHelper);

        // If any meshes referenced this skeleton before it was rendered, bind them now.
        const pendingMap: Map<string, any[]> | undefined = (sceneRef as any).__usdPendingSkins;
        const pending = pendingMap?.get(primPath);
        if (pending && pending.length) {
          for (const p of pending) {
            try {
              const geom: THREE.BufferGeometry = p.geom;
              const meshContainer: THREE.Object3D = p.container;
              const placeholder: THREE.Object3D = p.placeholder;
              const mat: THREE.Material = p.mat;
              const elementSize: number = p.elementSize ?? 4;
              const jointIndices: ArrayLike<number> = p.jointIndices;
              const jointWeights: ArrayLike<number> = p.jointWeights;
              const jointOrderNames: string[] | null = p.jointOrderNames ?? null;

              // Rewrite skinIndex using remap now that we know skeleton jointNames.
              const jointIndexRemap = buildJointOrderIndexToBoneIndex(jointNames, jointOrderNames);
              const vertexCount = geom.getAttribute('position').count;
              const skinIndices = new Uint16Array(vertexCount * 4);
              const skinWeights = new Float32Array(vertexCount * 4);

              const origPointIdxAttr = geom.getAttribute('_originalPointIndex');
              const origPointIndices = origPointIdxAttr ? (origPointIdxAttr.array as Uint32Array) : null;

              for (let v = 0; v < vertexCount; v++) {
                const origPtIdx = origPointIndices ? origPointIndices[v]! : v;
                for (let j = 0; j < 4; j++) {
                  const srcIdx = origPtIdx * elementSize + j;
                  const ji = srcIdx < jointIndices.length ? (jointIndices[srcIdx] ?? 0) : 0;
                  const mapped = jointIndexRemap ? (jointIndexRemap[ji] ?? 0) : ji;
                  skinIndices[v * 4 + j] = mapped;
                  skinWeights[v * 4 + j] = srcIdx < jointWeights.length ? (jointWeights[srcIdx] ?? 0) : 0;
                }
              }

              geom.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
              geom.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));

              // Swap placeholder Mesh -> real SkinnedMesh (Three.js cannot render a SkinnedMesh without a bound Skeleton).
              (mat as any).skinning = true;
              (mat as any).needsUpdate = true;
              const skinnedMesh = new THREE.SkinnedMesh(geom, mat);
              skinnedMesh.castShadow = true;
              skinnedMesh.receiveShadow = true;
              skinnedMesh.name = placeholder?.name ?? '';

              if (meshContainer && placeholder) meshContainer.remove(placeholder);
              if (meshContainer) meshContainer.add(skinnedMesh);

              // Try mesh's transform relative to skeleton root as bindMatrix
              meshContainer?.updateMatrixWorld(true);
              skinnedMesh.updateMatrixWorld(true);
              skelRoot.updateMatrixWorld(true);
              const meshToSkel = skelRoot.matrixWorld.clone().invert().multiply(skinnedMesh.matrixWorld);
              skinnedMesh.bind(skeleton, meshToSkel);
              skeleton.update();
            } catch (e) {
              // eslint-disable-next-line no-console
              console.warn(`[Skeleton] Failed to bind pending skinned mesh for ${primPath}`, e);
            }
          }
          pendingMap?.delete(primPath);
        }
      }
    }
    return true;
  }

  return false;
}


