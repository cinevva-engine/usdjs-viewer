import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import { getPrimProp } from '../usdAnim';
import { parseMatrix4dArray } from '../threeXform';

export function renderUsdSkeletonPrim(opts: {
  typeName: string;
  container: THREE.Object3D;
  helpersParent: THREE.Object3D;
  helpers: Map<string, THREE.Object3D>;
  prim: SdfPrimSpec;
  primPath: string;
  unitScale: number;
  skeletonsToUpdate: Array<{ skeleton: THREE.Skeleton; boneRoot: THREE.Object3D }>;
}): boolean {
  const { typeName, container, helpersParent, helpers, prim, primPath, unitScale, skeletonsToUpdate } = opts;

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

        // Apply rest transforms (local transforms for each bone)
        if (restTransforms && restTransforms.length === jointNames.length) {
          for (let i = 0; i < jointNames.length; i++) {
            const matrix = restTransforms[i];
            if (matrix) {
              // Apply unit scale to the translation component
              const scaledMatrix = matrix.clone();
              const pos = new THREE.Vector3();
              const rot = new THREE.Quaternion();
              const scale = new THREE.Vector3();
              scaledMatrix.decompose(pos, rot, scale);
              pos.multiplyScalar(unitScale);
              bones[i]!.position.copy(pos);
              bones[i]!.quaternion.copy(rot);
              bones[i]!.scale.copy(scale);
            }
          }
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

        // Update matrices for the bone hierarchy
        skelRoot.updateMatrixWorld(true);

        // Create Skeleton with bind matrices (inverse bind matrices for skinning)
        const boneInverses: THREE.Matrix4[] = [];
        if (bindTransforms && bindTransforms.length === jointNames.length) {
          for (let i = 0; i < jointNames.length; i++) {
            const bindMatrix = bindTransforms[i];
            if (bindMatrix) {
              // Apply unit scale to bind transform translation
              const scaledBind = bindMatrix.clone();
              const pos = new THREE.Vector3();
              const rot = new THREE.Quaternion();
              const scale = new THREE.Vector3();
              scaledBind.decompose(pos, rot, scale);
              pos.multiplyScalar(unitScale);
              scaledBind.compose(pos, rot, scale);
              // Bind inverse = inverse of world-space bind pose
              boneInverses.push(scaledBind.clone().invert());
            } else {
              boneInverses.push(new THREE.Matrix4());
            }
          }
        }

        const skeleton = new THREE.Skeleton(bones, boneInverses.length ? boneInverses : undefined);

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
      }
    }
    return true;
  }

  return false;
}


