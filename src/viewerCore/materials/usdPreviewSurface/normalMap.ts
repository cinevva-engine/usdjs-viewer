import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import { applyUsdTransform2dToTexture, applyWrapMode } from '../textureUtils';

// Debug logging (opt-in): add `?usddebug=1` to the URL or set `localStorage.usddebug = "1"`.
// IMPORTANT: normal map resolution runs during scene load and can spam / slow traces.
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
  console.log('[usdjs-viewer:UsdPreviewSurfaceNormalMap]', ...args);
};

const dbgError = (...args: any[]) => {
  if (!USDDEBUG) return;
  // eslint-disable-next-line no-console
  console.error('[usdjs-viewer:UsdPreviewSurfaceNormalMap]', ...args);
};

export function applyUsdPreviewSurfaceNormalMap(opts: {
  root: SdfPrimSpec;
  shader: SdfPrimSpec;
  mat: THREE.MeshPhysicalMaterial;
  resolveAssetUrl: (assetPath: string) => string | null;
  resolveConnectedPrim: (root: SdfPrimSpec, from: SdfPrimSpec, inputName: string) => SdfPrimSpec | null;
  resolveUsdUvTextureInfo: (root: SdfPrimSpec, texShader: SdfPrimSpec) => any;
}): void {
  const { root, shader, mat, resolveAssetUrl, resolveConnectedPrim, resolveUsdUvTextureInfo } = opts;

  // `inputs:normal.connect` to a UsdUVTexture (e.g. UsdPreviewSurface_opacityThreshold.usda)
  const nSource = resolveConnectedPrim(root, shader, 'inputs:normal');
  if (USDDEBUG) dbg('[NormalBiasScale DEBUG] nSource:', nSource?.path?.primPath ?? 'null');
  if (nSource) {
    const info = resolveUsdUvTextureInfo(root, nSource);
    if (USDDEBUG) {
      dbg('[NormalBiasScale DEBUG] texture info:', info ? {
        file: info.file,
        scaleRaw: info.scaleRaw,
        biasRaw: info.biasRaw,
      } : 'null');
    }
    if (info) {
      const url = resolveAssetUrl?.(info.file);
      if (USDDEBUG) dbg('[NormalBiasScale DEBUG] resolved URL:', url);
      if (url) {
        // USD's UsdUVTexture applies: result = sample * scale + bias (per-component)
        // Default values are scale=(1,1,1,1) and bias=(0,0,0,0), but for normal maps
        // the typical convention is scale=(2,2,2,2) and bias=(-1,-1,-1,-1) to convert
        // from [0,1] texture range to [-1,1] normal range.
        const scale = info.scaleRaw ?? [2, 2, 2];
        const bias = info.biasRaw ?? [-1, -1, -1];

        // Check if this is the standard Three.js normal map convention
        const isStandardThreeJs = (
          scale[0] === 2 && scale[1] === 2 && scale[2] === 2 &&
          bias[0] === -1 && bias[1] === -1 && bias[2] === -1
        );

        // Store scale/bias for shader customization
        const usdNormalScale = new THREE.Vector3(scale[0], scale[1], scale[2]);
        const usdNormalBias = new THREE.Vector3(bias[0], bias[1], bias[2]);

        // Set up onBeforeCompile to inject custom normal map transformation
        // Only needed if not using standard Three.js convention
        if (USDDEBUG) dbg('[NormalBiasScale DEBUG] isStandardThreeJs:', isStandardThreeJs, 'scale:', scale, 'bias:', bias);
        if (!isStandardThreeJs) {
          mat.userData.usdNormalScale = usdNormalScale;
          mat.userData.usdNormalBias = usdNormalBias;
          if (USDDEBUG) dbg('[NormalBiasScale DEBUG] Setting up onBeforeCompile for custom scale/bias');

          mat.onBeforeCompile = (shader) => {
            if (USDDEBUG) dbg('[NormalBiasScale DEBUG] onBeforeCompile called');
            // Add uniforms for USD normal scale/bias
            shader.uniforms.usdNormalScale = { value: usdNormalScale };
            shader.uniforms.usdNormalBias = { value: usdNormalBias };

            // Add uniform declarations after normalmap_pars_fragment
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <normalmap_pars_fragment>',
              `#include <normalmap_pars_fragment>
uniform vec3 usdNormalScale;
uniform vec3 usdNormalBias;`
            );

            // Three.js includes are NOT expanded at onBeforeCompile time.
            // We need to replace the #include <normal_fragment_maps> directive with our own code.
            // The original normal_fragment_maps.glsl.js contains:
            //   vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
            //   mapN.xy *= normalScale;
            //   normal = normalize( tbn * mapN );
            // We replace the entire include with custom code that uses USD's scale/bias.
            const customNormalFragmentMaps = `
#ifdef USE_NORMALMAP_OBJECTSPACE
  normal = texture2D( normalMap, vNormalMapUv ).xyz * usdNormalScale + usdNormalBias;
  #ifdef FLIP_SIDED
    normal = - normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
  vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * usdNormalScale + usdNormalBias;
  mapN.xy *= normalScale;
  normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
  normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif
`;
            const hasInclude = shader.fragmentShader.includes('#include <normal_fragment_maps>');
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <normal_fragment_maps>',
              customNormalFragmentMaps
            );
            const replaced = !shader.fragmentShader.includes('#include <normal_fragment_maps>');
            if (USDDEBUG) dbg('[NormalBiasScale DEBUG] normal_fragment_maps include found:', hasInclude, 'replaced:', replaced);
          };

          // Ensure shader gets recompiled
          mat.customProgramCacheKey = () => `usd_normal_${scale.join('_')}_${bias.join('_')}`;
        } else {
          if (USDDEBUG) dbg('[NormalBiasScale DEBUG] Using standard Three.js normal map handling');
        }

        new THREE.TextureLoader().load(
          url,
          (tex: any) => {
            if (USDDEBUG) dbg('[NormalBiasScale DEBUG] Normal texture loaded successfully:', info.file);
            tex.colorSpace = THREE.NoColorSpace;
            applyWrapMode(tex, info.wrapS, info.wrapT);
            if (info.transform2d) applyUsdTransform2dToTexture(tex, info.transform2d);
            mat.normalMap = tex;

            // For standard Three.js convention, we don't need custom shader
            // normalScale is left at default (1,1)
            mat.needsUpdate = true;
            if (USDDEBUG) {
              dbg('[NormalBiasScale DEBUG] Material after normal map:', {
                color: mat.color.getHexString(),
                normalMap: !!mat.normalMap,
                roughness: mat.roughness,
                metalness: mat.metalness,
              });
            }
          },
          undefined,
          (err: unknown) => {
            dbgError('Failed to load UsdPreviewSurface normal texture:', info.file, url, err);
          },
        );
      }
    }
  }
}






