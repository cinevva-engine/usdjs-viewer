import * as THREE from 'three';
import { resolveAssetPath, type SdfPrimSpec } from '@cinevva/usdjs';

import { findPrimByPath } from './usdPaths';
import {
  alphaToGreenAlphaMap,
  applyUsdTransform2dToTexture,
  applyWrapMode,
  cloneTexturePreserveParams,
} from './materials/textureUtils';

export { alphaToGreenAlphaMap, applyUsdTransform2dToTexture, applyWrapMode, cloneTexturePreserveParams } from './materials/textureUtils';
export { createOmniPbrMaterial, extractOmniPbrInputs } from './materials/omniPbr';

import { createOmniPbrMaterial } from './materials/omniPbr';
export { createStandardSurfaceMaterial, extractStandardSurfaceInputs } from './materials/standardSurface';

import { createStandardSurfaceMaterial } from './materials/standardSurface';
export { createUsdPreviewSurfaceMaterial } from './materials/usdPreviewSurface';

import { createUsdPreviewSurfaceMaterial } from './materials/usdPreviewSurface';
import { createMdlSourceAssetMaterial } from './materials/mdlSourceAsset';

// Debug logging (opt-in): add `?usddebug=1` to the URL or set `localStorage.usddebug = "1"`.
// IMPORTANT: material binding/shader resolution is called per-prim and can dominate load time if noisy.
const USDDEBUG =
  (() => {
    try {
      if (typeof window === 'undefined') return false;
      const q = new URLSearchParams((window as any).location?.search ?? '');
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
  console.log('[usdjs-viewer:materials]', ...args);
};

export function resolveMaterialBinding(prim: SdfPrimSpec, root: SdfPrimSpec, prototypeRoot?: SdfPrimSpec): SdfPrimSpec | null {
  console.log('[MATERIALS] resolveMaterialBinding called for prim:', prim.path?.primPath, 'type:', prim.typeName);
  // USD material binding commonly inherits down namespace: a parent prim can bind a material
  // that applies to all descendant meshes. So we must walk up ancestors to find the nearest binding.
  //
  // Additionally, some files may author binding variants like `material:binding:preview`.
  const pickBindingProp = (p: SdfPrimSpec): { key: string; dv: any } | null => {
    const props = p.properties;
    if (!props) return null;

    const direct = props.get('material:binding');
    if (direct?.defaultValue !== undefined) return { key: 'material:binding', dv: direct.defaultValue as any };

    // Fallback: look for other material binding relationships (e.g. `material:binding:preview`).
    // Ignore property fields (anything after a dot) like `.connect` or `.timeSamples`.
    for (const [k, spec] of props.entries()) {
      if (k === 'material:binding') continue;
      if (!k.startsWith('material:binding')) continue;
      if (k.includes('.')) continue;
      if (spec.defaultValue === undefined) continue;
      return { key: k, dv: spec.defaultValue as any };
    }
    return null;
  };

  const extractFirstSdfPath = (dv: any): string | null => {
    if (!dv) return null;
    if (typeof dv === 'object' && dv.type === 'sdfpath' && typeof dv.value === 'string') return dv.value;
    // Relationships can be authored as arrays of sdfpaths (e.g. `rel prototypes = [</A>, </B>]`).
    if (typeof dv === 'object' && dv.type === 'array' && Array.isArray(dv.value)) {
      for (const el of dv.value) {
        const p = extractFirstSdfPath(el);
        if (p) return p;
      }
    }
    // Some dict/listOp representations can wrap a `value` field.
    if (typeof dv === 'object' && dv.type === 'dict' && dv.value && typeof dv.value === 'object' && 'value' in dv.value) {
      return extractFirstSdfPath((dv.value as any).value);
    }
    return null;
  };

  const stopAtPath = prototypeRoot?.path?.primPath ?? null;
  let cur: SdfPrimSpec | null = prim;
  let bindingPath: string | null = null;
  let bindingKey: string | null = null;

  while (cur) {
    const picked = pickBindingProp(cur);
    if (picked) {
      const p = extractFirstSdfPath(picked.dv);
      if (p) {
        bindingPath = p;
        bindingKey = picked.key;
        break;
      }
    }

    const curPath = cur.path?.primPath;
    if (!curPath || curPath === '/') break;
    if (stopAtPath && curPath === stopAtPath) break;

    const parts = curPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = parts.length ? '/' + parts.join('/') : '/';
    cur = findPrimByPath(root, parentPath);
  }

  if (!bindingPath) {
    console.log('[MATERIALS] No material binding found in ancestors, checking Omniverse ground fallback');
    // Omniverse-specific: some scene templates use custom `ground:material:path` metadata on the environment root
    // instead of a proper `rel material:binding = </Material>`. This still represents a real intended USD material.
    //
    // Example: `clean_cloudy_sky_and_floor.usd` authors:
    //   custom string ground:material:path = "/Environment/Looks/Brick_Pavers"
    // and leaves `rel material:binding` on the `ground` mesh empty.
    const primPath = prim.path?.primPath ?? '';
    const primName = primPath.split('/').filter(Boolean).slice(-1)[0] ?? '';
    console.log('[MATERIALS] Prim name:', primName);
    if (primName === 'ground') {
      let cur2: SdfPrimSpec | null = prim;
      while (cur2) {
        const dv: any = cur2.properties?.get('ground:material:path')?.defaultValue;
        if (typeof dv === 'string' && dv.startsWith('/')) {
          console.log('[MATERIALS] Found ground:material:path:', dv);
          bindingPath = dv;
          bindingKey = 'ground:material:path';
          break;
        }
        const p = cur2.path?.primPath;
        if (!p || p === '/') break;
        const parts = p.split('/').filter(Boolean);
        parts.pop();
        const parentPath = parts.length ? '/' + parts.join('/') : '/';
        cur2 = findPrimByPath(root, parentPath);
      }
      if (bindingPath) {
        // continue below with bindingPath populated
      } else if (USDDEBUG) {
        dbg(`[resolveMaterialBinding] prim=${prim.path?.primPath} -> NO material binding found (including Omni ground fallback)`);
        return null;
      }
    } else {
      if (USDDEBUG) dbg(`[resolveMaterialBinding] prim=${prim.path?.primPath} -> NO material binding found (including ancestors)`);
      return null;
    }
  }

  if (!bindingPath) {
    console.log('[MATERIALS] NO material binding found for prim:', prim.path?.primPath);
    if (USDDEBUG) dbg(`[resolveMaterialBinding] prim=${prim.path?.primPath} -> NO material binding found (including ancestors)`);
    return null;
  }

  const materialPath = bindingPath;
  console.log('[MATERIALS] Found material binding:', {
    prim: prim.path?.primPath,
    bindingKey,
    materialPath,
    prototypeRoot: prototypeRoot?.path?.primPath,
  });
  if (USDDEBUG) {
    dbg(
      `[resolveMaterialBinding] prim=${prim.path?.primPath}, bindingKey=${bindingKey}, materialPath=${materialPath}, prototypeRoot=${prototypeRoot?.path?.primPath}`,
    );
  }

  // If path is absolute (starts with /), try resolving from root first.
  // If that fails and we have a prototypeRoot, try resolving relative to prototype root
  // (for referenced files where paths like /root/Materials/tree_leaves should resolve relative to the reference root).
  if (materialPath.startsWith('/')) {
    const fromRoot = findPrimByPath(root, materialPath);
    console.log('[MATERIALS] Resolving material from root:', materialPath, '->', fromRoot?.path?.primPath ?? 'null');
    if (USDDEBUG) dbg(`[resolveMaterialBinding]   fromRoot(${materialPath})=${fromRoot?.path?.primPath ?? 'null'}`);
    if (fromRoot) {
      console.log('[MATERIALS] Material found!', fromRoot.path?.primPath, 'type:', fromRoot.typeName);
      return fromRoot;
    }

    // For referenced prototypes, try resolving relative to the prototype root.
    // Example: if prototypeRoot is at /World/trees/pointInstancer/asset and materialPath is /root/Materials/tree_leaves,
    // try /World/trees/pointInstancer/asset/Materials/tree_leaves (assuming /root maps to the prototype root).
    if (prototypeRoot) {
      // If material path starts with /root, replace /root with prototype root path
      if (materialPath.startsWith('/root')) {
        const relativePath = prototypeRoot.path.primPath + materialPath.substring('/root'.length);
        const fromPrototype = findPrimByPath(root, relativePath);
        if (USDDEBUG) dbg(`[resolveMaterialBinding]   fromPrototype(${relativePath})=${fromPrototype?.path?.primPath ?? 'null'}`);
        if (fromPrototype) return fromPrototype;
      }

      // Generic remap fallback for referenced subtrees:
      // If an absolute material path points at some root (e.g. /World/Looks/Mat) but the referenced
      // content has been mapped under `prototypeRoot` (e.g. /World/simple_mesh_sphere),
      // try replacing the first path element with prototypeRoot.
      const parts = materialPath.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const suffix = '/' + parts.slice(1).join('/');
        const remapped = prototypeRoot.path.primPath + suffix;
        const rem = findPrimByPath(root, remapped);
        if (USDDEBUG) dbg(`[resolveMaterialBinding]   remapFirstSeg(${remapped})=${rem?.path?.primPath ?? 'null'}`);
        if (rem) return rem;
      }

      // Also try appending the path (without leading /) to prototype root
      const appendedPath = prototypeRoot.path.primPath === '/' ? materialPath : prototypeRoot.path.primPath + materialPath;
      const appended = findPrimByPath(root, appendedPath);
      if (USDDEBUG) dbg(`[resolveMaterialBinding]   appended(${appendedPath})=${appended?.path?.primPath ?? 'null'}`);
      if (appended) return appended;
    }
  } else {
    // Relative path: resolve from prim's parent
    const parentPath = prim.path.primPath === '/' ? '/' : prim.path.primPath.split('/').slice(0, -1).join('/') || '/';
    const relativePath = parentPath === '/' ? '/' + materialPath : parentPath + '/' + materialPath;
    const result = findPrimByPath(root, relativePath);
    if (USDDEBUG) dbg(`[resolveMaterialBinding]   relative(${relativePath})=${result?.path?.primPath ?? 'null'}`);
    return result;
  }

  console.warn('[MATERIALS] FAILED to resolve material:', materialPath);
  if (USDDEBUG) dbg(`[resolveMaterialBinding]   FAILED to resolve material`);
  return null;
}

export function resolveShaderFromMaterial(material: SdfPrimSpec, root: SdfPrimSpec): SdfPrimSpec | null {
  console.log('[MATERIALS] resolveShaderFromMaterial called for material:', material.path?.primPath);
  // UsdShade commonly uses `outputs:surface.connect`, but MDL/Omniverse materials often use `outputs:mdl:surface.connect`,
  // and MaterialX uses `outputs:mtlx:surface.connect`.
  // We prioritize MaterialX outputs first since they provide more accurate native shader definitions
  // (UsdPreviewSurface outputs are often just fallbacks for MaterialX content).
  const outputKeys = [
    'outputs:mtlx:surface.connect',
    'outputs:mdl:surface.connect',
    'outputs:mdl:displacement.connect',
    'outputs:mdl:volume.connect',
    'outputs:surface.connect',
  ];

  let shaderPath: string | null = null;
  for (const k of outputKeys) {
    const prop = material.properties?.get(k);
    const dv = prop?.defaultValue as any;
    if (dv && typeof dv === 'object' && dv.type === 'sdfpath' && typeof dv.value === 'string') {
      shaderPath = dv.value;
      console.log('[MATERIALS] Found shader path from output:', k, '->', shaderPath);
      break;
    }
  }

  if (!shaderPath) {
    console.log('[MATERIALS] No shader path found in material outputs, trying fallback');
    return null;
  }

  const lastDot = shaderPath.lastIndexOf('.');
  if (lastDot > 0) {
    shaderPath = shaderPath.substring(0, lastDot);
  }

  // Extract the shader name (last path component) to look for it as a direct child of the material.
  // This handles referenced files where the absolute path (e.g. /root/Materials/tree_leaves/PBRShader)
  // doesn't exist in the composed stage but the shader is a direct child of the material prim.
  const followOutputsToShader = (start: SdfPrimSpec, depth = 0): SdfPrimSpec | null => {
    if (!start || depth > 8) return start ?? null;

    // If it's already a Shader (or looks like one), we're done.
    const infoId = start.properties?.get('info:id')?.defaultValue;
    if (typeof infoId === 'string' && infoId.length) return start;
    if (start.typeName === 'Shader') return start;

    // Common USD pattern: Material.outputs:surface.connect -> NodeGraph.outputs:surface -> Shader.outputs:surface
    // If we landed on a NodeGraph, follow its own outputs to the underlying shader.
    if (start.typeName === 'NodeGraph') {
      for (const k of outputKeys) {
        const prop = start.properties?.get(k);
        const dv = prop?.defaultValue as any;
        if (dv && typeof dv === 'object' && dv.type === 'sdfpath' && typeof dv.value === 'string') {
          let p = dv.value as string;
          const lastDot = p.lastIndexOf('.');
          if (lastDot > 0) p = p.substring(0, lastDot);
          const next = findPrimByPath(root, p);
          if (next) return followOutputsToShader(next, depth + 1);
        }
      }
    }

    return start;
  };

  const shaderName = shaderPath.split('/').pop();
  console.log('[MATERIALS] Looking for shader:', { shaderPath, shaderName });
  if (shaderName && material.children?.has(shaderName)) {
    const childShader = material.children.get(shaderName);
    if (childShader) {
      console.log('[MATERIALS] Found shader as child of material:', shaderName);
      if (USDDEBUG) dbg(`[resolveShaderFromMaterial] Found shader as child: ${shaderName}`);
      const resolved = followOutputsToShader(childShader);
      console.log('[MATERIALS] Resolved shader:', resolved?.path?.primPath, 'type:', resolved?.typeName);
      return resolved;
    }
  }

  // Fallback: try absolute path lookup (works for non-referenced materials)
  const result = findPrimByPath(root, shaderPath);
  console.log('[MATERIALS] Absolute path lookup:', shaderPath, '->', result?.path?.primPath ?? 'null');
  if (USDDEBUG) dbg(`[resolveShaderFromMaterial] shaderPath=${shaderPath}, shaderName=${shaderName}, foundByAbsPath=${result?.path?.primPath ?? 'null'}`);
  if (result) {
    const resolved = followOutputsToShader(result);
    console.log('[MATERIALS] Resolved shader from absolute path:', resolved?.path?.primPath, 'type:', resolved?.typeName);
    return resolved;
  }

  // Last-resort fallback: some composed stages lose/alter `outputs:surface.connect` targets.
  // In that case, try to find *any* Shader under the material prim and use it.
  // This prevents "fully gray" fallback materials when the material binding exists but the connect path doesn't resolve.
  console.log('[MATERIALS] Trying fallback: searching for any Shader under material');
  const stack: SdfPrimSpec[] = [];
  if (material.children) for (const c of material.children.values()) stack.push(c);
  while (stack.length) {
    const p = stack.pop()!;
    const infoId = p.properties?.get('info:id')?.defaultValue;
    if (p.typeName === 'Shader' || (typeof infoId === 'string' && infoId.length > 0)) {
      console.log('[MATERIALS] Fallback found shader:', p.path?.primPath, 'info:id:', infoId);
      if (USDDEBUG) {
        // eslint-disable-next-line no-console
        console.warn(
          `[resolveShaderFromMaterial] Fallback-picked shader under material: ${p.path?.primPath} (info:id=${String(infoId)})`,
        );
      }
      const resolved = followOutputsToShader(p);
      console.log('[MATERIALS] Resolved fallback shader:', resolved?.path?.primPath);
      return resolved;
    }
    if (p.children) for (const c of p.children.values()) stack.push(c);
  }
  console.warn('[MATERIALS] No shader found for material:', material.path?.primPath);
  return null;
}

export function resolveConnectedPrim(root: SdfPrimSpec, from: SdfPrimSpec, inputName: string): SdfPrimSpec | null {
  const prop = from.properties?.get(`${inputName}.connect`);
  const dv: any = prop?.defaultValue;
  if (!dv || typeof dv !== "object" || dv.type !== 'sdfpath' || typeof dv.value !== 'string') return null;

  let targetPath = dv.value;
  const lastDot = targetPath.lastIndexOf('.');
  if (lastDot > 0) targetPath = targetPath.substring(0, lastDot);

  return findPrimByPath(root, targetPath);
}

export function resolveConnectedPrimWithOutput(
  root: SdfPrimSpec,
  from: SdfPrimSpec,
  inputName: string,
): { prim: SdfPrimSpec; outputName: string | null } | null {
  const prop = from.properties?.get(`${inputName}.connect`);
  const dv: any = prop?.defaultValue;
  if (!dv || typeof dv !== 'object' || dv.type !== 'sdfpath' || typeof dv.value !== 'string') return null;

  const full = dv.value;
  const lastDot = full.lastIndexOf('.');
  const primPath = lastDot > 0 ? full.substring(0, lastDot) : full;
  const out = lastDot > 0 ? full.substring(lastDot + 1) : null;

  const prim = findPrimByPath(root, primPath);
  if (!prim) return null;
  return { prim, outputName: out };
}

export function resolveUsdPrimvarReaderFloat3(root: SdfPrimSpec, shader: SdfPrimSpec, inputName: string): { varname: string } | null {
  const conn = resolveConnectedPrimWithOutput(root, shader, inputName);
  if (!conn) return null;
  const id = conn.prim.properties?.get('info:id')?.defaultValue;
  if (id !== 'UsdPrimvarReader_float3') return null;
  const v = conn.prim.properties?.get('inputs:varname')?.defaultValue;
  if (typeof v !== 'string' || !v) return null;
  return { varname: v };
}

export function resolveUsdUvTextureInfo(
  root: SdfPrimSpec,
  texShader: SdfPrimSpec,
): {
  file: string;
  wrapS?: string;
  wrapT?: string;
  sourceColorSpace?: string;
  transform2d: SdfPrimSpec | null;
  // UsdUVTexture can apply `result = sample * scale + bias` (per-component).
  // We provide both THREE.Color (for diffuse/emissive) and raw arrays (for normals where values can be outside 0-1).
  scaleRgb?: THREE.Color;
  biasRgb?: THREE.Color;
  // Raw float arrays for scale/bias - can hold values outside 0-1 range (like scale=2, bias=-1 for normals)
  scaleRaw?: [number, number, number];
  biasRaw?: [number, number, number];
} | null {
  const infoId = texShader.properties?.get('info:id')?.defaultValue;
  if (infoId !== 'UsdUVTexture') return null;

  const fileDv: any = texShader.properties?.get('inputs:file')?.defaultValue;
  // Some layers may serialize asset paths as plain strings; support both.
  const filePathRaw =
    typeof fileDv === 'string'
      ? fileDv
      : fileDv && typeof fileDv === 'object' && fileDv.type === 'asset' && typeof fileDv.value === 'string'
        ? fileDv.value
        : fileDv && typeof fileDv === 'object' && fileDv.type === 'reference' && typeof fileDv.assetPath === 'string'
          ? fileDv.assetPath
          : null;
  const filePath =
    filePathRaw && fileDv && typeof fileDv === 'object' && typeof (fileDv as any).__fromIdentifier === 'string'
      ? (() => {
        const stripCorpusPrefix = (v: string): string => (v.startsWith('[corpus]') ? v.replace('[corpus]', '') : v);
        return resolveAssetPath(stripCorpusPrefix(filePathRaw), stripCorpusPrefix((fileDv as any).__fromIdentifier));
      })()
      : filePathRaw;
  if (!filePath) return null;

  const wrapS = texShader.properties?.get('inputs:wrapS')?.defaultValue;
  const wrapT = texShader.properties?.get('inputs:wrapT')?.defaultValue;
  const sourceColorSpace = texShader.properties?.get('inputs:sourceColorSpace')?.defaultValue;

  const readFloat4 = (name: string): [number, number, number] | undefined => {
    const dv: any = texShader.properties?.get(name)?.defaultValue;
    if (!dv || typeof dv !== 'object' || dv.type !== 'tuple') return undefined;
    const [r, g, b] = dv.value ?? [];
    if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') return undefined;
    return [r, g, b];
  };
  const scaleRaw = readFloat4('inputs:scale');
  const biasRaw = readFloat4('inputs:bias');

  // Create THREE.Color versions (note: these clamp to 0-1 range, so only useful for standard color textures)
  const scaleRgb = scaleRaw ? new THREE.Color(scaleRaw[0], scaleRaw[1], scaleRaw[2]) : undefined;
  const biasRgb = biasRaw ? new THREE.Color(biasRaw[0], biasRaw[1], biasRaw[2]) : undefined;

  // If `inputs:st` connects to a UsdTransform2d, we can at least apply scale/offset/rotation.
  const stSource = resolveConnectedPrim(root, texShader, 'inputs:st');
  const stInfoId = stSource?.properties?.get('info:id')?.defaultValue;
  const transform2d = stInfoId === 'UsdTransform2d' ? stSource : null;

  return {
    file: filePath,
    wrapS: typeof wrapS === 'string' ? wrapS : undefined,
    wrapT: typeof wrapT === 'string' ? wrapT : undefined,
    sourceColorSpace: typeof sourceColorSpace === 'string' ? sourceColorSpace : undefined,
    transform2d,
    scaleRgb,
    biasRgb,
    scaleRaw,
    biasRaw,
  };
}

export function extractShaderInputs(shader: SdfPrimSpec, materialPrim?: SdfPrimSpec): {
  diffuseColor?: THREE.Color;
  roughness?: number;
  metallic?: number;
  emissiveColor?: THREE.Color;
  opacity?: number;
  opacityThreshold?: number;
  ior?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
} {
  const result: any = {};

  // Helper to resolve connected value from material prim's interface inputs
  // This handles MaterialX patterns where shader inputs connect to material inputs
  const resolveConnectedColor3f = (inputName: string): THREE.Color | undefined => {
    const connectProp = shader.properties?.get(`${inputName}.connect`);
    const connDv: any = connectProp?.defaultValue;
    if (connDv && typeof connDv === 'object' && connDv.type === 'sdfpath' && typeof connDv.value === 'string') {
      // Check if it connects to a material input (e.g. </MaterialX/Materials/USD_Plastic.inputs:diffuseColor>)
      const targetPath = connDv.value;
      // Extract the input name from the path (e.g. "inputs:diffuseColor")
      const lastDot = targetPath.lastIndexOf('.');
      if (lastDot > 0) {
        const connectedInputName = targetPath.substring(lastDot + 1);
        // Look up the input on the material prim
        if (materialPrim) {
          const matProp = materialPrim.properties?.get(connectedInputName);
          const matDv: any = matProp?.defaultValue;
          if (matDv && typeof matDv === 'object' && matDv.type === 'tuple') {
            const tuple = matDv.value;
            if (tuple.length >= 3 && typeof tuple[0] === 'number' && typeof tuple[1] === 'number' && typeof tuple[2] === 'number') {
              return new THREE.Color(tuple[0], tuple[1], tuple[2]);
            }
          }
        }
      }
    }
    return undefined;
  };

  const resolveConnectedFloat = (inputName: string): number | undefined => {
    const connectProp = shader.properties?.get(`${inputName}.connect`);
    const connDv: any = connectProp?.defaultValue;
    if (connDv && typeof connDv === 'object' && connDv.type === 'sdfpath' && typeof connDv.value === 'string') {
      const targetPath = connDv.value;
      const lastDot = targetPath.lastIndexOf('.');
      if (lastDot > 0) {
        const connectedInputName = targetPath.substring(lastDot + 1);
        if (materialPrim) {
          const matProp = materialPrim.properties?.get(connectedInputName);
          if (matProp && typeof matProp.defaultValue === 'number') {
            return matProp.defaultValue;
          }
        }
      }
    }
    return undefined;
  };

  const getColor3f = (name: string): THREE.Color | undefined => {
    const prop = shader.properties?.get(name);
    const dv: any = prop?.defaultValue;
    if (!dv || typeof dv !== 'object' || dv.type !== 'tuple') {
      // Try connected value
      return resolveConnectedColor3f(name);
    }
    const tuple = dv.value;
    if (tuple.length >= 3 && typeof tuple[0] === 'number' && typeof tuple[1] === 'number' && typeof tuple[2] === 'number') {
      return new THREE.Color(tuple[0], tuple[1], tuple[2]);
    }
    return undefined;
  };

  const getFloat = (name: string): number | undefined => {
    const prop = shader.properties?.get(name);
    if (prop && typeof prop.defaultValue === 'number') return prop.defaultValue;
    // Try connected value
    return resolveConnectedFloat(name);
  };

  result.diffuseColor = getColor3f('inputs:diffuseColor');
  result.roughness = getFloat('inputs:roughness');
  result.metallic = getFloat('inputs:metallic');
  result.emissiveColor = getColor3f('inputs:emissiveColor');
  result.opacity = getFloat('inputs:opacity');
  result.opacityThreshold = getFloat('inputs:opacityThreshold');
  result.ior = getFloat('inputs:ior');
  result.clearcoat = getFloat('inputs:clearcoat');
  result.clearcoatRoughness = getFloat('inputs:clearcoatRoughness');

  return result;
}

export function createMaterialFromShader(
  shader: SdfPrimSpec,
  root: SdfPrimSpec,
  resolveAssetUrl?: (assetPath: string) => string | null,
  materialPrim?: SdfPrimSpec,
): THREE.Material {
  const infoId = shader.properties?.get('info:id');
  const shaderType = infoId?.defaultValue;

  // Handle both UsdPreviewSurface and MaterialX's ND_UsdPreviewSurface_surfaceshader
  const isUsdPreviewSurface = shaderType === 'UsdPreviewSurface' || shaderType === 'ND_UsdPreviewSurface_surfaceshader';
  if (isUsdPreviewSurface) {
    return createUsdPreviewSurfaceMaterial({
      shader,
      root,
      resolveAssetUrl,
      materialPrim,
      extractShaderInputs,
      resolveUsdPrimvarReaderFloat3,
      resolveConnectedPrim,
      resolveConnectedPrimWithOutput,
      resolveUsdUvTextureInfo,
    });
  }

  // Handle MaterialX Standard Surface shader (ND_standard_surface_surfaceshader)
  const isStandardSurface = shaderType === 'ND_standard_surface_surfaceshader';
  if (isStandardSurface) {
    return createStandardSurfaceMaterial({ shader, root, resolveAssetUrl, materialPrim });
  }

  const mdlSubIdProp = shader.properties?.get('info:mdl:sourceAsset:subIdentifier');
  const mdlSubId = mdlSubIdProp?.defaultValue;
  if (typeof mdlSubId === 'string' && mdlSubId === 'OmniPBR') {
    return createOmniPbrMaterial({ shader, resolveAssetUrl });
  }

  // Generic MDL `sourceAsset` (Omniverse content uses this for many library materials).
  // We can't execute MDL directly in WebGL, but we can often extract referenced textures and build a PBR approximation.
  const implProp = shader.properties?.get('info:implementationSource');
  const implDv: any = implProp?.defaultValue;
  // Extract string value from token type (usdjs parses tokens as { type: 'token', value: string })
  const impl = typeof implDv === 'string' ? implDv : (implDv && typeof implDv === 'object' && implDv.type === 'token' ? implDv.value : null);
  const mdlSourceProp = shader.properties?.get('info:mdl:sourceAsset');
  const mdlSourceDv: any = mdlSourceProp?.defaultValue;
  const mdlSource = typeof mdlSourceDv === 'string' ? mdlSourceDv : (mdlSourceDv && typeof mdlSourceDv === 'object' && mdlSourceDv.type === 'asset' ? mdlSourceDv.value : null);
  const isMdlSourceAsset = impl === 'sourceAsset' && typeof mdlSource === 'string' && mdlSource.length > 0;

  // Log material detection attempts
  console.log('[MATERIALS] createMaterialFromShader:', {
    shaderPath: shader.path?.primPath,
    shaderType,
    implProp: implProp ? { defaultValue: implDv, extracted: impl } : null,
    mdlSourceProp: mdlSourceProp ? { defaultValue: mdlSourceDv, extracted: mdlSource } : null,
    isMdlSourceAsset,
    isUsdPreviewSurface,
    isStandardSurface,
    mdlSubId,
  });

  if (isMdlSourceAsset) {
    console.log('[MATERIALS] Creating MDL sourceAsset material for:', shader.path?.primPath, 'MDL:', mdlSource);
    return createMdlSourceAssetMaterial({ shader, resolveAssetUrl: resolveAssetUrl as any });
  }

  console.log('[MATERIALS] Falling back to default gray material for:', shader.path?.primPath);
  return new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
}


