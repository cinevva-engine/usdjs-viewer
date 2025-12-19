import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import type { AnimatedObject, SceneNode } from '../types';
import { findPrimByPath } from '../usdPaths';

// Cache rendered prototype Object3Ds keyed by prototype prim path.
// This is critical for scenes like usd-wg-assets `simpleAssetScene.usd` which author hundreds of
// instanceable prims referencing the same external asset. Our composition pipeline rewrites those
// external references into internal prototype prims under `/__usdjs_prototypes/*`.
//
// Without caching, we end up re-rendering the full prototype subtree for every instance, which is
// extremely slow and defeats the point of instancing.
const prototypeObjectCache = new Map<string, THREE.Object3D>();

function cloneObjectShared(obj: THREE.Object3D): THREE.Object3D {
  // Create a shallow clone of the scene graph while SHARING geometries/materials.
  // This is much cheaper than re-running renderPrim and avoids duplicating GPU resources.
  const anyObj: any = obj as any;
  let out: THREE.Object3D;
  if (anyObj.isMesh) {
    out = new THREE.Mesh(anyObj.geometry, anyObj.material);
    (out as any).castShadow = anyObj.castShadow;
    (out as any).receiveShadow = anyObj.receiveShadow;
  } else if (anyObj.isSkinnedMesh) {
    // Fallback: SkinnedMesh cloning is non-trivial; keep slow path if we ever hit it.
    // (simpleAssetScene is static meshes.)
    out = obj.clone(true);
    return out;
  } else if (anyObj.isPoints) {
    out = new THREE.Points(anyObj.geometry, anyObj.material);
  } else if (anyObj.isLineSegments) {
    out = new THREE.LineSegments(anyObj.geometry, anyObj.material);
  } else if (anyObj.isLine) {
    out = new THREE.Line(anyObj.geometry, anyObj.material);
  } else {
    out = new THREE.Object3D();
  }

  out.name = obj.name;
  out.visible = obj.visible;
  out.frustumCulled = (obj as any).frustumCulled ?? true;
  out.position.copy(obj.position);
  out.quaternion.copy(obj.quaternion);
  out.scale.copy(obj.scale);
  out.matrixAutoUpdate = obj.matrixAutoUpdate;
  if (!obj.matrixAutoUpdate) out.matrix.copy(obj.matrix);

  for (const child of obj.children) {
    out.add(cloneObjectShared(child));
  }
  return out;
}

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
  domeEnv?: any,
  currentIdentifier?: string,
  animatedObjects?: AnimatedObject[],
) => void;

export function applyNativeUsdInstancingExpansion(opts: {
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
  prototypeRootForMaterials?: SdfPrimSpec | null;
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
    prototypeRootForMaterials,
    renderPrim,
  } = opts;

  // Native USD instancing (instanceable + internal references), e.g. samples/instance/instance_test.usda
  // In this viewer we don't have full USD prototype instancing; instead, for simple internal references
  // like `prepend references = </World/Group>`, we expand the referenced prim subtree under the instance prim.
  // This fixes cases where an instanceable prim would otherwise appear empty.
  if (node.children.length === 0) {
    const md = node.prim.metadata ?? {};
    const instanceable = (md as any)['instanceable'];
    const refs = (md as any)['references'];
    const isInstanceable = instanceable === true || (typeof instanceable === 'number' && instanceable !== 0);

    const extractRefPaths = (v: any): string[] => {
      if (!v) return [];
      // listOp dict: { op, value }
      if (typeof v === 'object' && v.type === 'dict' && v.value && typeof v.value === 'object' && 'value' in v.value) {
        return extractRefPaths((v.value as any).value);
      }
      // single sdfpath
      if (typeof v === 'object' && v.type === 'sdfpath' && typeof v.value === 'string') return [v.value];
      // array of sdfpaths
      if (typeof v === 'object' && v.type === 'array' && Array.isArray(v.value)) {
        const out: string[] = [];
        for (const el of v.value) {
          if (el && typeof el === 'object' && el.type === 'sdfpath' && typeof el.value === 'string') out.push(el.value);
        }
        return out;
      }
      return [];
    };

    if (isInstanceable && refs) {
      const refPaths = extractRefPaths(refs);
      if (refPaths.length > 0) {
        // Pick the first internal reference that resolves to a prim.
        let targetPrim: SdfPrimSpec | null = null;
        let targetPath = '';
        for (const p of refPaths) {
          const prim = findPrimByPath(rootPrim, p);
          if (prim) {
            targetPrim = prim;
            targetPath = p;
            break;
          }
        }

        if (targetPrim) {
          // Fast path: our composer rewrites external instanceable references into a prototype prim
          // under `/__usdjs_prototypes/*`. In that case, render the prototype ONCE and then
          // attach cheap shared-geometry clones for each instance.
          if (targetPath.startsWith('/__usdjs_prototypes/')) {
            let protoObj = prototypeObjectCache.get(targetPath);
            if (!protoObj) {
              const safeRefName = targetPath.replaceAll('/', '_');
              const refRootPath = `${targetPath}.__render__${safeRefName}`;
              const buildRefNode = (prim: SdfPrimSpec, curPath: string): SceneNode => {
                const children: SceneNode[] = [];
                if (prim.children) {
                  for (const [name, child] of prim.children) {
                    const childPath = curPath === '/' ? '/' + name : curPath + '/' + name;
                    children.push(buildRefNode(child, childPath));
                  }
                }
                return { path: curPath, typeName: prim.typeName, prim, children };
              };
              const protoContainer = new THREE.Object3D();
              const refNode = buildRefNode(targetPrim, refRootPath);
              (refNode as any).__prototypeRoot = prototypeRootForMaterials;
              renderPrim(
                protoContainer,
                helpersParent,
                refNode,
                null,
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
              );
              protoObj = protoContainer;
              prototypeObjectCache.set(targetPath, protoObj);
            }

            container.add(cloneObjectShared(protoObj));
            return;
          }

          const safeRefName = targetPath.replaceAll('/', '_');
          const refRootPath = `${node.path}.__ref__${safeRefName}`;

          const buildRefNode = (prim: SdfPrimSpec, curPath: string): SceneNode => {
            const children: SceneNode[] = [];
            if (prim.children) {
              for (const [name, child] of prim.children) {
                const childPath = curPath === '/' ? '/' + name : curPath + '/' + name;
                children.push(buildRefNode(child, childPath));
              }
            }
            return { path: curPath, typeName: prim.typeName, prim, children };
          };

          // Render the referenced prim subtree under this instance prim's container.
          // Pass the instance's prototype root (if any) through for material resolution consistency.
          const refNode = buildRefNode(targetPrim, refRootPath);
          (refNode as any).__prototypeRoot = prototypeRootForMaterials;
          renderPrim(
            container,
            helpersParent,
            refNode,
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
          );
        }
      }
    }
  }
}


