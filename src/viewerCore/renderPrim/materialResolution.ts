import * as THREE from 'three';
import { resolveAssetPath, type SdfPrimSpec } from '@cinevva/usdjs';

import { findPrimByPath } from '../usdPaths';
import { extractAssetStrings, parseTuple3ArrayToFloat32 } from '../usdParse';
import { createMaterialFromShader, extractShaderInputs, resolveMaterialBinding, resolveShaderFromMaterial } from '../materials';

export function getBoolProp(prim: SdfPrimSpec, getPrimProp: (p: SdfPrimSpec, name: string) => any, name: string): boolean | null {
  const v = getPrimProp(prim, name);
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return null;
}

export function applySidedness(
  prim: SdfPrimSpec,
  getPrimProp: (p: SdfPrimSpec, name: string) => any,
  mat: THREE.Material | THREE.Material[],
) {
  // UsdGeomGprim `doubleSided` is the canonical control. Some exporters also author `singleSided`.
  const ds = getBoolProp(prim, getPrimProp, 'doubleSided');
  const ss = getBoolProp(prim, getPrimProp, 'singleSided');
  const wantDouble = ds === true || (ss === false && ds !== false);
  if (!wantDouble && ds !== false && ss !== true) return; // nothing authored => leave defaults

  const applyOne = (m: THREE.Material) => {
    if (!('side' in m)) return;
    (m as any).side = wantDouble ? THREE.DoubleSide : THREE.FrontSide;
    // Important: even if the surface is double-sided for shading, rendering both sides into the
    // shadow map tends to create self-shadowing artifacts on thin shells (like the ft-lab sample).
    // Prefer front-face shadow casting.
    if ('shadowSide' in (m as any)) (m as any).shadowSide = THREE.FrontSide;
    m.needsUpdate = true;
  };
  if (Array.isArray(mat)) mat.forEach(applyOne);
  else applyOne(mat);
}

export function findReferenceRootForMaterials(rootPrim: SdfPrimSpec, primPath: string): SdfPrimSpec | undefined {
  let cur = primPath;
  while (cur && cur !== '/') {
    const p = findPrimByPath(rootPrim, cur);
    if (p?.metadata?.references) return p;
    const parts = cur.split('/').filter(Boolean);
    parts.pop();
    cur = parts.length ? '/' + parts.join('/') : '/';
  }
  return undefined;
}

export function getAssetResolutionIdentifier(opts: {
  rootPrim: SdfPrimSpec;
  prim: SdfPrimSpec;
  currentIdentifier?: string;
}): string | undefined {
  const { rootPrim, prim, currentIdentifier } = opts;

  const USDDEBUG = typeof window !== 'undefined' && (
    new URLSearchParams(window.location.search).get('usddebug') === '1' ||
    window.localStorage?.getItem?.('usddebug') === '1'
  );

  if (USDDEBUG) {
    console.log('[TEXTURE:getAssetResolutionIdentifier] START', {
      primPath: prim.path?.primPath,
      currentIdentifier,
    });
  }

  // Find the reference root that contains this prim
  let cur = prim.path?.primPath ?? '';
  while (cur && cur !== '/') {
    const p = findPrimByPath(rootPrim, cur);
    if (p?.metadata?.references) {
      // Extract the asset path from the reference metadata
      const refs = extractAssetStrings(p.metadata.references);
      if (USDDEBUG) {
        console.log('[TEXTURE:getAssetResolutionIdentifier] Found reference', {
          path: cur,
          references: refs,
        });
      }
      if (refs.length > 0) {
        // Resolve the reference asset path to get the full identifier
        const refAssetPath = refs[0];
        try {
          // Resolve relative to the current identifier to get the full path
          const baseIdentifier = currentIdentifier ?? '<viewer>';
          const resolvedRef = resolveAssetPath(refAssetPath, baseIdentifier);
          if (USDDEBUG) {
            console.log('[TEXTURE:getAssetResolutionIdentifier] Resolved', {
              refAssetPath,
              baseIdentifier,
              resolvedRef,
            });
          }
          return resolvedRef;
        } catch (err) {
          if (USDDEBUG) {
            console.warn('[TEXTURE:getAssetResolutionIdentifier] Resolution failed', {
              refAssetPath,
              err,
            });
          }
          return refAssetPath;
        }
      }
    }
    const parts = cur.split('/').filter(Boolean);
    parts.pop();
    cur = parts.length ? '/' + parts.join('/') : '/';
  }
  
  if (USDDEBUG) {
    console.log('[TEXTURE:getAssetResolutionIdentifier] No reference found, returning undefined');
  }
  return undefined;
}

export function createResolveMaterial(opts: {
  rootPrim: SdfPrimSpec;
  bindingRootForMaterials?: SdfPrimSpec;
  prototypeRootForMaterials?: SdfPrimSpec;
  referenceRootForMaterials?: SdfPrimSpec;
  currentIdentifier?: string;
  resolveAssetUrl?: (assetPath: string, fromIdentifier?: string) => string | null;
  USDDEBUG: boolean;
  dbg: (...args: any[]) => void;
}): (prim: SdfPrimSpec) => THREE.Material {
  const {
    rootPrim,
    bindingRootForMaterials,
    prototypeRootForMaterials,
    referenceRootForMaterials,
    currentIdentifier,
    resolveAssetUrl,
    USDDEBUG,
    dbg,
  } = opts;

  return (prim: SdfPrimSpec): THREE.Material => {
    if (USDDEBUG) {
      dbg(
        `[resolveMaterial] prim=${prim.path?.primPath}, prototypeRootForMaterials=${prototypeRootForMaterials?.path?.primPath}, referenceRootForMaterials=${referenceRootForMaterials?.path?.primPath}`,
      );
    }
    const materialPrim = resolveMaterialBinding(prim, rootPrim, bindingRootForMaterials);
    if (USDDEBUG) {
      dbg(`[resolveMaterial]   materialPrim=${materialPrim?.path?.primPath ?? 'null'}`);
      console.log('[TEXTURE:MaterialResolution] Material binding resolved', {
        primPath: prim.path?.primPath,
        materialPath: materialPrim?.path?.primPath,
      });
    }
    if (materialPrim) {
      const shaderPrim = resolveShaderFromMaterial(materialPrim, rootPrim);
      if (USDDEBUG) {
        dbg(`[resolveMaterial]   shaderPrim=${shaderPrim?.path?.primPath ?? 'null'}`);
        console.log('[TEXTURE:MaterialResolution] Shader resolved', {
          materialPath: materialPrim?.path?.primPath,
          shaderPath: shaderPrim?.path?.primPath,
        });
      }
      if (shaderPrim) {
        // Get the identifier for resolving textures - use the reference root's identifier if available
        const baseIdentifier = currentIdentifier ?? '<viewer>';
        const assetIdentifier = getAssetResolutionIdentifier({ rootPrim, prim: shaderPrim, currentIdentifier }) ?? baseIdentifier;
        if (USDDEBUG) {
          console.log('[TEXTURE:MaterialResolution] Asset identifier for textures', {
            baseIdentifier,
            assetIdentifier,
            shaderPath: shaderPrim?.path?.primPath,
          });
        }
        const mat = createMaterialFromShader(shaderPrim, rootPrim, (path: string) => {
          const resolved = resolveAssetUrl?.(path, assetIdentifier) ?? null;
          if (USDDEBUG && path) {
            console.log('[TEXTURE:MaterialResolution] Resolving texture path', {
              path,
              assetIdentifier,
              resolved,
            });
          }
          return resolved;
        }, materialPrim);
        // Debug: log material creation for UsdPreviewSurface samples
        const shaderType = shaderPrim.properties?.get('info:id')?.defaultValue;
        if (USDDEBUG) dbg(`[resolveMaterial]   shaderType=${shaderType}`);
        const isUsdPreviewSurface = shaderType === 'UsdPreviewSurface' || shaderType === 'ND_UsdPreviewSurface_surfaceshader';
        if (isUsdPreviewSurface) {
          const inputs = extractShaderInputs(shaderPrim, materialPrim);
          if (USDDEBUG) {
            dbg(`[resolveMaterial]   UsdPreviewSurface inputs:`, {
              diffuseColor: inputs.diffuseColor
                ? `rgb(${inputs.diffuseColor.r.toFixed(4)}, ${inputs.diffuseColor.g.toFixed(4)}, ${inputs.diffuseColor.b.toFixed(4)})`
                : 'none',
              roughness: inputs.roughness,
              metallic: inputs.metallic,
            });
            dbg(`[resolveMaterial]   mat.color=${(mat as any).color?.getHexString?.()}`);
          }
        }
        return mat;
      }
    }
    if (USDDEBUG) dbg(`[resolveMaterial]   returning default material`);
    return new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
  };
}

export function applyPrimitiveDefaults(opts: {
  prim: SdfPrimSpec;
  rootPrim: SdfPrimSpec;
  bindingRootForMaterials?: SdfPrimSpec;
  mat: THREE.Material;
}) {
  const { prim, rootPrim, bindingRootForMaterials, mat } = opts;
  const hasBoundMaterial = !!resolveMaterialBinding(prim, rootPrim, bindingRootForMaterials);
  if (!hasBoundMaterial) {
    (mat as THREE.MeshStandardMaterial).color.setHex(0x888888);
    (mat as THREE.MeshStandardMaterial).roughness = 0.8;
    (mat as THREE.MeshStandardMaterial).metalness = 0.0;
    const dcProp = prim.properties?.get('primvars:displayColor');
    const dc = parseTuple3ArrayToFloat32(dcProp?.defaultValue);
    if (dc && dc.length >= 3) {
      (mat as THREE.MeshStandardMaterial).color.setRGB(dc[0] ?? 1, dc[1] ?? 1, dc[2] ?? 1);
    }
  }
}






