import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import type { AnimatedObject, SceneNode } from '../../types';
import { getPrimProp } from '../../usdAnim';
import { findPrimByPath } from '../../usdPaths';
import { parseNumberArray, parsePoint3ArrayToFloat32, parseTuple3ArrayToFloat32 } from '../../usdParse';

import { buildInstancesByProto } from './instances';
import { extractPointInstancerPrototypeMeshes } from './extractPrototypeMeshes';
import { resolvePointInstancerPrototypePaths } from './prototypes';

export type RenderPrimLike = (
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
  animatedObjects?: AnimatedObject[],
) => void;

export function renderPointInstancerPrim(opts: {
  container: THREE.Object3D;
  node: SceneNode;
  rootPrim: SdfPrimSpec;
  helpersParent: THREE.Object3D;
  selectionPath: string | null;
  helpers: Map<string, THREE.Object3D>;
  sceneRef: THREE.Scene;
  hasUsdLightsRef: { value: boolean };
  hasUsdDomeLightRef: { value: boolean };
  resolveAssetUrl?: (assetPath: string, fromIdentifier?: string) => string | null;
  unitScale: number;
  dynamicHelperUpdates: Array<() => void>;
  skeletonsToUpdate: Array<{ skeleton: THREE.Skeleton; boneRoot: THREE.Object3D }>;
  domeEnv?: any;
  currentIdentifier?: string;
  animatedObjects?: AnimatedObject[];
  renderPrim: RenderPrimLike;
}): void {
  const {
    container,
    node,
    rootPrim,
    helpersParent,
    selectionPath,
    helpers,
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
    renderPrim,
  } = opts;

  const positions = parsePoint3ArrayToFloat32(getPrimProp(node.prim, 'positions'));
  const protoIndices = parseNumberArray(getPrimProp(node.prim, 'protoIndices'));
  const orientations = (() => {
    const oriProp = getPrimProp(node.prim, 'orientations');
    if (!oriProp || typeof oriProp !== 'object') return null;

    // Fast path: packed typed array (flat wxyz per instance)
    if ((oriProp as any).type === 'typedArray' && ((oriProp as any).elementType === 'quath' || (oriProp as any).elementType === 'quatf' || (oriProp as any).elementType === 'quatd')) {
      const data: any = (oriProp as any).value;
      if (!(data instanceof Float32Array) && !(data instanceof Float64Array)) return null;
      if (data.length % 4 !== 0) return null;
      const quats: THREE.Quaternion[] = [];
      for (let i = 0; i < data.length; i += 4) {
        const w = data[i + 0]!, x = data[i + 1]!, y = data[i + 2]!, z = data[i + 3]!;
        if (Number.isFinite(w) && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
          const q = new THREE.Quaternion(x, y, z, w);
          if (q.x === 0 && q.y === 0 && q.z === 0 && q.w === 0) q.set(0, 0, 0, 1);
          quats.push(q);
        } else {
          quats.push(new THREE.Quaternion());
        }
      }
      return quats.length > 0 ? quats : null;
    }

    if ((oriProp as any).type !== 'array') return null;
    const quats: THREE.Quaternion[] = [];
    for (const el of (oriProp as any).value) {
      if (!el || typeof el !== 'object' || el.type !== 'tuple' || el.value.length < 4) {
        quats.push(new THREE.Quaternion()); // identity fallback
        continue;
      }
      // USD `quat*` is authored as (w, x, y, z). Three.js expects (x, y, z, w).
      const [w, x, y, z] = el.value;
      if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number' && typeof w === 'number') {
        const q = new THREE.Quaternion(x, y, z, w);
        if (q.x === 0 && q.y === 0 && q.z === 0 && q.w === 0) q.set(0, 0, 0, 1);
        quats.push(q);
      } else {
        quats.push(new THREE.Quaternion());
      }
    }
    return quats.length > 0 ? quats : null;
  })();
  const scales = parseTuple3ArrayToFloat32(getPrimProp(node.prim, 'scales'));

  if (!positions || positions.length < 3) {
    console.warn('PointInstancer missing positions:', node.path);
    return;
  }

  const numInstances = positions.length / 3;
  if (!protoIndices || protoIndices.length !== numInstances) {
    console.warn('PointInstancer protoIndices length mismatch:', node.path);
    return;
  }

  const prototypePaths = resolvePointInstancerPrototypePaths({ prim: node.prim, primPath: node.path });

  if (prototypePaths.length === 0) {
    console.warn('PointInstancer has no prototypes:', node.path);
    return;
  }

  // Render each prototype once to get its geometry/material, then instance it.
  // Each prototype can have multiple meshes (e.g., trunk + leaves), so store as array of arrays.
  const prototypeMeshes: Array<Array<{ geom: THREE.BufferGeometry; mat: THREE.Material }>> = [];
  for (const protoPath of prototypePaths) {
    const protoPrim = findPrimByPath(rootPrim, protoPath);
    if (!protoPrim) {
      console.warn('PointInstancer prototype not found:', protoPath);
      prototypeMeshes.push([]); // Push empty array to maintain index alignment
      continue;
    }

    const meshesForThisProto = extractPointInstancerPrototypeMeshes({
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
    });
    prototypeMeshes.push(meshesForThisProto);
  }

  if (prototypeMeshes.length === 0 || prototypeMeshes.every((m) => m.length === 0)) {
    console.warn('PointInstancer prototype produced no meshes:', node.path);
    return;
  }

  const instancesByProto = buildInstancesByProto({
    positions,
    protoIndices,
    orientations,
    scales,
    unitScale,
    prototypeCount: prototypeMeshes.length,
  });

  // Create InstancedMesh (or regular Mesh) for each mesh in each prototype group.
  // Each prototype can have multiple meshes (e.g., trunk + leaves), so we need to instance each separately.
  for (const [protoIdx, instances] of instancesByProto) {
    const meshes = prototypeMeshes[protoIdx];
    if (!meshes || meshes.length === 0) {
      console.warn(`PointInstancer prototype ${protoIdx} has no meshes`);
      continue;
    }

    // For each mesh in this prototype (e.g., trunk, leaves), create instances.
    for (const { geom, mat } of meshes) {
      if (instances.length === 1) {
        // Single instance: just clone the mesh.
        const mesh = new THREE.Mesh(geom, mat);
        const inst = instances[0]!;
        mesh.position.copy(inst.pos);
        mesh.quaternion.copy(inst.rot);
        mesh.scale.copy(inst.scale);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        container.add(mesh);
      } else {
        // Multiple instances: use InstancedMesh.
        const instancedMesh = new THREE.InstancedMesh(geom, mat, instances.length);
        instancedMesh.castShadow = true;
        instancedMesh.receiveShadow = true;

        const matrix = new THREE.Matrix4();
        for (let i = 0; i < instances.length; i++) {
          const inst = instances[i]!;
          matrix.compose(inst.pos, inst.rot, inst.scale);
          instancedMesh.setMatrixAt(i, matrix);
        }
        instancedMesh.instanceMatrix.needsUpdate = true;
        container.add(instancedMesh);
      }
    }
  }
}


