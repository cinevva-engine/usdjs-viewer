import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import type { SceneNode } from '../../types';
import { buildPointInstancerProtoNode } from './protoNode';

export function extractPointInstancerPrototypeMeshes(opts: {
  protoPrim: SdfPrimSpec;
  protoPath: string;
  renderPrim: (
    objParent: THREE.Object3D,
    helpersParent: THREE.Object3D,
    node: SceneNode,
    selectionPath: string | null,
    helpers: Map<string, THREE.Object3D>,
    rootPrim: SdfPrimSpec,
    sceneRef: THREE.Scene,
    hasUsdLightsRef: { value: boolean },
    hasUsdDomeLightRef: { value: boolean },
    resolveAssetUrl?: (assetPath: string, fromIdentifier?: string) => string | null,
    unitScale?: number,
    dynamicHelperUpdates?: Array<() => void>,
    skeletonsToUpdate?: Array<{ skeleton: THREE.Skeleton; boneRoot: THREE.Object3D }>,
    domeEnv?: {
      setFromDomeLight: (opts: {
        assetPath: string;
        format: string | null;
        worldQuaternion: THREE.Quaternion;
        intensity: number;
      }) => void;
    },
    currentIdentifier?: string,
    animatedObjects?: any,
  ) => void;
  helpersParent: THREE.Object3D;
  selectionPath: string | null;
  helpers: Map<string, THREE.Object3D>;
  rootPrim: SdfPrimSpec;
  sceneRef: THREE.Scene;
  hasUsdLightsRef: { value: boolean };
  hasUsdDomeLightRef: { value: boolean };
  resolveAssetUrl?: (assetPath: string, fromIdentifier?: string) => string | null;
  unitScale: number;
  dynamicHelperUpdates: Array<() => void>;
  skeletonsToUpdate: Array<{ skeleton: THREE.Skeleton; boneRoot: THREE.Object3D }>;
  domeEnv?: any;
  currentIdentifier?: string;
  animatedObjects?: any;
}): Array<{ geom: THREE.BufferGeometry; mat: THREE.Material }> {
  const {
    protoPrim,
    protoPath,
    renderPrim,
    helpersParent,
    selectionPath,
    helpers,
    rootPrim,
    sceneRef,
    hasUsdLightsRef,
    hasUsdDomeLightRef,
    resolveAssetUrl,
    unitScale,
    dynamicHelperUpdates,
    skeletonsToUpdate,
    domeEnv,
    currentIdentifier,
    animatedObjects,
  } = opts;

  const protoNode = buildPointInstancerProtoNode(protoPrim, protoPath);

  // Render prototype into a temporary container to extract geometry/material.
  // Mark the prototype node so material bindings can resolve relative to the prototype root.
  // This is needed because referenced files use absolute paths like /root/Materials/tree_leaves
  // which should resolve relative to the prototype, not the stage root.
  const tempContainer = new THREE.Object3D();
  (protoNode as any).__prototypeRoot = protoPrim; // Pass prototype root for material resolution
  console.log(`[PointInstancer] Setting __prototypeRoot=${protoPrim.path?.primPath} for protoNode=${protoNode.path}`);
  console.log(`[PointInstancer] protoNode children:`, protoNode.children.map((c) => c.path));
  renderPrim(
    tempContainer,
    helpersParent,
    protoNode,
    selectionPath,
    helpers,
    rootPrim, // Use main stage root - references should be merged into it
    sceneRef,
    hasUsdLightsRef,
    hasUsdDomeLightRef,
    resolveAssetUrl,
    unitScale,
    dynamicHelperUpdates,
    skeletonsToUpdate,
    domeEnv,
    currentIdentifier,
    animatedObjects,
  );
  delete (protoNode as any).__prototypeRoot; // Clean up

  // Extract all meshes from the prototype container.
  const meshesForThisProto: Array<{ geom: THREE.BufferGeometry; mat: THREE.Material }> = [];
  tempContainer.traverse((obj: THREE.Object3D) => {
    if (obj instanceof THREE.Mesh && obj.geometry && obj.material) {
      const originalMat = Array.isArray(obj.material) ? obj.material[0]! : obj.material;
      const clonedMat = originalMat.clone();
      // Ensure material properties are properly copied (Three.js clone should handle this, but ensure needsUpdate is set)
      clonedMat.needsUpdate = true;
      // Debug: verify material color is preserved (especially for tree_leaves green color)
      if ('color' in clonedMat && (clonedMat as any).color) {
        const matColor = (clonedMat as any).color as THREE.Color;
        // Log if we see a green-ish color (for debugging tree_leaves)
        if (matColor.g > 0.2 && matColor.r < 0.1 && matColor.b < 0.1) {
          console.log(`PointInstancer prototype mesh material color: r=${matColor.r}, g=${matColor.g}, b=${matColor.b}, obj.name=${obj.name}`);
        }
      }
      meshesForThisProto.push({
        geom: (obj.geometry as THREE.BufferGeometry).clone(),
        mat: clonedMat,
      });
    }
  });

  return meshesForThisProto;
}


