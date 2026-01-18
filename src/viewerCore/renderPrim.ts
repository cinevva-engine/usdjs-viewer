import * as THREE from 'three';
import { resolveAssetPath, type SdfPrimSpec } from '@cinevva/usdjs';

import type { AnimatedObject, SceneNode } from './types';
import { getPrimProp, getPrimPropAtTime, propHasAnimation } from './usdAnim';
import { getPropMetadataNumber, getPropMetadataString, parseNumberArray, parsePoint3ArrayToFloat32, parseTuple3ArrayToFloat32 } from './usdParse';
import { applyXformOps, parseMatrix4dArray, primHasAnimatedXform } from './threeXform';
import { renderPointsPrim } from './renderPrim/points';
import { renderBasisCurvesPrim } from './renderPrim/curves';
import { trackAnimatedMeshPoints } from './renderPrim/animatedMeshPoints';
import { renderUsdMeshPrim } from './renderPrim/mesh';
import { renderPointInstancerPrim } from './renderPrim/pointInstancer';
import { renderUsdLightPrim } from './renderPrim/lights';
import { applyNativeUsdInstancingExpansion } from './renderPrim/nativeInstancing';
import { renderUsdSkeletonPrim } from './renderPrim/skeleton';
import { applyUsdGeomModelApiDrawMode } from './renderPrim/drawModes';
import { renderBasicUsdPrimitive } from './renderPrim/basicPrims';
import { applyPrimitiveDefaults as applyPrimitiveDefaultsExternal, applySidedness as applySidednessExternal, createResolveMaterial, findReferenceRootForMaterials } from './renderPrim/materialResolution';

// Debug logging (opt-in): add `?usddebug=1` to the URL or set `localStorage.usddebug = "1"`.
// IMPORTANT: keep this opt-in because logging per-prim/material/mesh can dominate load time
// (and can massively slow traces when DevTools is recording).
const USDDEBUG =
  (() => {
    try {
      if (typeof window === 'undefined') return false;
      const q = new URLSearchParams(window.location?.search ?? '');
      if (q.get('usddebug') === '1') return true;
      if (typeof localStorage !== 'undefined' && localStorage.getItem('usddebug') === '1') return true;
    } catch {
      // ignore
    }
    return false;
  })();

const dbg = (...args: any[]) => {
  if (!USDDEBUG) return;
  // eslint-disable-next-line no-console
  console.log('[usdjs-viewer:renderPrim]', ...args);
};

export function renderPrim(
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
  unitScale = 1.0,
  dynamicHelperUpdates: Array<() => void> = [],
  skeletonsToUpdate: Array<{ skeleton: THREE.Skeleton; boneRoot: THREE.Object3D }> = [],
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
) {
  // USD prim metadata: `active = false` means the prim and its subtree are not traversed/rendered.
  // We also prune these in `buildTree()`, but keep this guard as defense-in-depth.
  if ((node.prim.metadata as any)?.active === false) return;

  const container = new THREE.Object3D();
  container.name = node.path;
  // Xform evaluation should not apply metersPerUnit scaling.
  applyXformOps(container, node.prim, undefined, 1.0);
  objParent.add(container);

  // Track animated objects for animation playback
  if (animatedObjects && primHasAnimatedXform(node.prim)) {
    animatedObjects.push({ kind: 'xform', obj: container, prim: node.prim, unitScale: 1.0 });
  }

  const typeName = node.typeName ?? '';

  const applySidedness = (prim: SdfPrimSpec, mat: THREE.Material | THREE.Material[]) =>
    applySidednessExternal(prim, getPrimProp, mat);

  // For PointInstancer prototypes, we need to resolve material bindings relative to the prototype root.
  // This is passed down from the PointInstancer handler.
  const prototypeRootForMaterials = (node as any).__prototypeRoot as SdfPrimSpec | undefined;
  if (USDDEBUG) {
    dbg(
      `[renderPrim] node=${node.path}, typeName=${typeName}, __prototypeRoot=${prototypeRootForMaterials?.path?.primPath ?? 'undefined'}`,
    );
  }

  // Native USD references can map a referenced layer's defaultPrim subtree under an arbitrary prim path.
  // Some corpora still author absolute material binding targets like </World/Looks/Mat>. If our composed stage
  // didn't remap those targets, try resolving them relative to the nearest ancestor prim that has `metadata.references`.
  const referenceRootForMaterials = findReferenceRootForMaterials(rootPrim, node.prim.path?.primPath ?? node.path);
  const bindingRootForMaterials = prototypeRootForMaterials ?? referenceRootForMaterials;
  const resolveMaterial = createResolveMaterial({
    rootPrim,
    bindingRootForMaterials,
    prototypeRootForMaterials,
    referenceRootForMaterials,
    currentIdentifier,
    resolveAssetUrl,
    USDDEBUG,
    dbg,
  });

  // Helper to apply default material/displayColor for built-in primitives
  const applyPrimitiveDefaults = (mat: THREE.Material, prim: SdfPrimSpec) =>
    applyPrimitiveDefaultsExternal({ prim, rootPrim, bindingRootForMaterials, mat });

  const handledBasicPrim = renderBasicUsdPrimitive({
    typeName,
    prim: node.prim,
    container,
    unitScale,
    getPrimProp,
    resolveMaterial,
    applyPrimitiveDefaults,
  });

  if (!handledBasicPrim && typeName === 'Mesh') {
    renderUsdMeshPrim({
      container,
      node,
      rootPrim,
      bindingRootForMaterials,
      sceneRef,
      unitScale,
      resolveMaterial,
      applySidedness,
      USDDEBUG,
      dbg,
    });
  }

  // BasisCurves support (e.g. curves/basisCurves.usda)
  // Notes/limitations:
  // - We support `type = "linear"` and `type = "cubic"` (bezier via piecewise cubic segments).
  // - USD `widths` can be varying; Three's built-in TubeGeometry can't vary radius along the curve without a custom shader,
  //   so we approximate by using a single radius per-curve (first relevant width).
  if (typeName === 'BasisCurves') {
    renderBasisCurvesPrim({ container, node, unitScale, resolveMaterial, applySidedness });
  }

  trackAnimatedMeshPoints({ typeName, container, prim: node.prim, unitScale, animatedObjects });

  if (typeName === 'Points') {
    renderPointsPrim({ container, node, unitScale });
  }

  // PointInstancer support (e.g. point_instancer_01.usda)
  if (typeName === 'PointInstancer') {
    renderPointInstancerPrim({
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
    });
  }

  renderUsdLightPrim({
    typeName,
    container,
    helpersParent,
    prim: node.prim,
    rootPrim,
    unitScale,
    dynamicHelperUpdates,
    hasUsdLightsRef,
    hasUsdDomeLightRef,
    resolveAssetUrl,
    domeEnv,
  });

  if (selectionPath && node.path === selectionPath) {
    const box = new THREE.Box3().setFromObject(container);
    const helper = new THREE.Box3Helper(box, 0x99ff99);
    helpers.set(node.path, helper);
    objParent.add(helper);
  }

  applyNativeUsdInstancingExpansion({
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
  });

  // For PointInstancer, skip rendering children normally - prototypes are only rendered as instances.
  // The PointInstancer code already extracts and instances the prototype geometry/materials.
  if (typeName === 'PointInstancer') {
    return;
  }

  renderUsdSkeletonPrim({
    typeName,
    container,
    helpersParent,
    helpers,
    sceneRef,
    prim: node.prim,
    primPath: node.path,
    unitScale,
    skeletonsToUpdate,
    animatedObjects: animatedObjects ?? [],
    rootPrim,
  });

  for (const child of node.children) {
    // Propagate prototype root to children so material bindings resolve correctly
    // for referenced prototypes (e.g. PointInstancer simpleTree).
    if (prototypeRootForMaterials) {
      (child as any).__prototypeRoot = prototypeRootForMaterials;
    }
    renderPrim(
      container,
      helpersParent,
      child,
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

  applyUsdGeomModelApiDrawMode({
    container,
    prim: node.prim,
    primPath: node.path,
    prototypeRootForMaterials,
  });
}

