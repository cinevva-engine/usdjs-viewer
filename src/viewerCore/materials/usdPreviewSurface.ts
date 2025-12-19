import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import { alphaToGreenAlphaMap, applyUsdTransform2dToTexture, applyWrapMode } from './textureUtils';
import { guessSolidColorFromAssetPath } from './usdPreviewSurface/guessSolidColor';
import { applyUsdPreviewSurfaceNormalMap } from './usdPreviewSurface/normalMap';

export function createUsdPreviewSurfaceMaterial(opts: {
  shader: SdfPrimSpec;
  root: SdfPrimSpec;
  resolveAssetUrl?: (assetPath: string) => string | null;
  materialPrim?: SdfPrimSpec;
  extractShaderInputs: (shader: SdfPrimSpec, materialPrim?: SdfPrimSpec) => any;
  resolveUsdPrimvarReaderFloat3: (root: SdfPrimSpec, shader: SdfPrimSpec, inputName: string) => { varname: string } | null;
  resolveConnectedPrim: (root: SdfPrimSpec, from: SdfPrimSpec, inputName: string) => SdfPrimSpec | null;
  resolveConnectedPrimWithOutput: (
    root: SdfPrimSpec,
    from: SdfPrimSpec,
    inputName: string,
  ) => { prim: SdfPrimSpec; outputName: string | null } | null;
  resolveUsdUvTextureInfo: (root: SdfPrimSpec, texShader: SdfPrimSpec) => any;
}): THREE.Material {
  const {
    shader,
    root,
    resolveAssetUrl,
    materialPrim,
    extractShaderInputs,
    resolveUsdPrimvarReaderFloat3,
    resolveConnectedPrim,
    resolveConnectedPrimWithOutput,
    resolveUsdUvTextureInfo,
  } = opts;

  const inputs = extractShaderInputs(shader, materialPrim);
  console.log('[NormalBiasScale DEBUG] createMaterialFromShader inputs:', {
    diffuseColor: inputs.diffuseColor ? `rgb(${inputs.diffuseColor.r}, ${inputs.diffuseColor.g}, ${inputs.diffuseColor.b})` : 'none',
    roughness: inputs.roughness,
    metallic: inputs.metallic,
    shaderPath: shader.path?.primPath,
  });
  const mat = new THREE.MeshPhysicalMaterial();

  mat.color.setHex(0xffffff);
  mat.roughness = 0.5;
  mat.metalness = 0.0;
  // Default to double-sided rendering for UsdPreviewSurface materials.
  // Many USD files rely on double-sided rendering for thin surfaces (like planes) without
  // explicitly authoring `doubleSided = true` on the mesh.
  mat.side = THREE.DoubleSide;

  // If diffuseColor is driven by a vertex color primvar, prefer vertex colors over constant diffuse.
  // Example: UsdPreviewSurface_vertexColor.usda uses UsdPrimvarReader_float3 varname="colors".
  const pv = resolveUsdPrimvarReaderFloat3(root, shader, 'inputs:diffuseColor');
  if (pv) {
    // We only currently support mapping primvars:colors and primvars:displayColor into Three's `color` attribute.
    // (The mesh builder emits that attribute for these primvars.)
    (mat as any).vertexColors = true;
    mat.color.setHex(0xffffff);
    (mat as any).userData = { ...(mat as any).userData, usdDiffusePrimvar: pv.varname };
    console.log('[NormalBiasScale DEBUG] Using vertex colors from primvar:', pv.varname);
  } else {
    if (inputs.diffuseColor) {
      mat.color.copy(inputs.diffuseColor);
      console.log('[NormalBiasScale DEBUG] Set diffuseColor:', mat.color.getHexString());
    } else {
      console.log('[NormalBiasScale DEBUG] No diffuseColor input, keeping default white');
    }
  }
  if (inputs.roughness !== undefined) mat.roughness = inputs.roughness;
  if (inputs.metallic !== undefined) mat.metalness = inputs.metallic;

  // Ensure material is updated after setting properties
  mat.needsUpdate = true;
  if (inputs.emissiveColor) {
    mat.emissive = inputs.emissiveColor;
    mat.emissiveIntensity = 1.0;
  }
  if (inputs.opacity !== undefined) {
    mat.opacity = inputs.opacity;
    mat.transparent = inputs.opacity < 1.0;
  }
  // Cutout opacity threshold (alpha test). Example: UsdPreviewSurface_opacityThreshold.usda
  if (inputs.opacityThreshold !== undefined && inputs.opacityThreshold > 0) {
    mat.alphaTest = THREE.MathUtils.clamp(inputs.opacityThreshold, 0, 1);
    // Cutout should not behave like blended transparency.
    mat.transparent = false;
    mat.depthWrite = true;
  }
  // USD UsdPreviewSurface IOR handling:
  // - For non-metallic materials, IOR determines F0 (Fresnel reflectance at normal incidence)
  // - F0 = ((1-ior)/(1+ior))^2
  // - Default IOR = 1.5 → F0 = 0.04
  // - Three.js MeshPhysicalMaterial uses `ior` property to compute F0 the same way
  // - We also scale specularIntensity to 0 when IOR approaches 1.0 (no reflection)
  if (inputs.ior !== undefined) {
    mat.ior = THREE.MathUtils.clamp(inputs.ior, 1.0, 2.333);
    // When IOR = 1.0, there should be no specular reflection (matching air-to-air interface)
    // This helps materials with ior=1 to appear fully matte as intended
    if (inputs.ior <= 1.0) {
      mat.specularIntensity = 0;
    }
  }
  if (inputs.clearcoat !== undefined) {
    mat.clearcoat = THREE.MathUtils.clamp(inputs.clearcoat, 0, 1);
  }
  if (inputs.clearcoatRoughness !== undefined) {
    mat.clearcoatRoughness = THREE.MathUtils.clamp(inputs.clearcoatRoughness, 0, 1);
  }

  // Minimal UsdShade network support: allow `inputs:clearcoat.connect` to a UsdUVTexture.
  // Example: UsdPreviewSurface_clearcoat_with_texture.usda
  if (resolveAssetUrl) {
    // `inputs:diffuseColor.connect` to a UsdUVTexture (e.g. UsdPreviewSurface_multiply_texture.usda)
    const dcSource = resolveConnectedPrim(root, shader, 'inputs:diffuseColor');
    if (dcSource) {
      const info = resolveUsdUvTextureInfo(root, dcSource);
      if (info) {
        const url = resolveAssetUrl(info.file);
        if (url) {
          new THREE.TextureLoader().load(
            url,
            (tex: any) => {
              const cs = (info.sourceColorSpace ?? '').toLowerCase();
              // Many USDs omit `inputs:sourceColorSpace` for baseColor/diffuse textures; default those to sRGB.
              tex.colorSpace = (cs === 'srgb' || cs === '') ? THREE.SRGBColorSpace : THREE.NoColorSpace;
              applyWrapMode(tex, info.wrapS, info.wrapT);
              if (info.transform2d) applyUsdTransform2dToTexture(tex, info.transform2d);
              mat.map = tex;

              // Treat authored constant diffuseColor as a multiply tint (matches OmniPBR samples),
              // and also fold in UsdUVTexture's `inputs:scale` when present.
              // Note: we can't represent UsdUVTexture bias with MeshPhysicalMaterial, so we ignore it
              // unless it's effectively zero.
              const tint = inputs.diffuseColor ? inputs.diffuseColor.clone() : new THREE.Color(1, 1, 1);
              if (info.scaleRgb) tint.multiply(info.scaleRgb);
              mat.color.copy(tint);

              if (info.biasRgb && (info.biasRgb.r !== 0 || info.biasRgb.g !== 0 || info.biasRgb.b !== 0)) {
                console.warn('UsdUVTexture inputs:bias is not supported for MeshPhysicalMaterial baseColor; ignoring bias=', info.biasRgb);
              }

              mat.needsUpdate = true;
            },
            undefined,
            (err: unknown) => {
              console.error('Failed to load UsdPreviewSurface diffuse texture:', info.file, url, err);
              // Fallback: many corpora use flat color swatch textures; if those are missing (404),
              // infer a reasonable constant base color from the filename so the model isn't fully gray/white.
              const guessed = guessSolidColorFromAssetPath(info.file);
              if (guessed) {
                mat.map = null;
                mat.color.copy(guessed);
                mat.needsUpdate = true;
                console.warn('UsdPreviewSurface diffuse texture missing; using guessed baseColor from filename:', info.file, guessed.getHexString());
              }
            },
          );
        }
      }
    }

    applyUsdPreviewSurfaceNormalMap({
      root,
      shader,
      mat,
      resolveAssetUrl,
      resolveConnectedPrim,
      resolveUsdUvTextureInfo,
    });

    // `inputs:opacity.connect` to a UsdUVTexture (e.g. UsdPreviewSurface_opacityThreshold.usda)
    // Used together with `inputs:opacityThreshold` for cutout.
    const oConn = resolveConnectedPrimWithOutput(root, shader, 'inputs:opacity');
    if (oConn) {
      const info = resolveUsdUvTextureInfo(root, oConn.prim);
      if (info) {
        const url = resolveAssetUrl(info.file);
        if (url) {
          new THREE.TextureLoader().load(
            url,
            (tex: any) => {
              // Opacity is data; do not color-manage.
              tex.colorSpace = THREE.NoColorSpace;
              applyWrapMode(tex, info.wrapS, info.wrapT);
              if (info.transform2d) applyUsdTransform2dToTexture(tex, info.transform2d);
              // Three's alphaMap uses the GREEN channel. If USD connected `outputs:a` (alpha),
              // prefer the actual alpha channel by converting it into green.
              if (oConn.outputName === 'outputs:a') {
                const converted = alphaToGreenAlphaMap(tex);
                mat.alphaMap = converted ?? tex;
              } else {
                mat.alphaMap = tex;
              }
              // If threshold wasn't authored but an opacity map exists, default to a gentle cutout.
              if (mat.alphaTest === 0) mat.alphaTest = 0.5;
              mat.transparent = false;
              mat.depthWrite = true;
              mat.needsUpdate = true;

              if (info.biasRgb && (info.biasRgb.r !== 0 || info.biasRgb.g !== 0 || info.biasRgb.b !== 0)) {
                console.warn('UsdUVTexture inputs:bias is not supported for opacity; ignoring bias=', info.biasRgb);
              }
            },
            undefined,
            (err: unknown) => {
              console.error('Failed to load UsdPreviewSurface opacity texture:', info.file, url, err);
            },
          );
        }
      }
    }

    const ccSource = resolveConnectedPrim(root, shader, 'inputs:clearcoat');
    if (ccSource) {
      const info = resolveUsdUvTextureInfo(root, ccSource);
      if (info) {
        const url = resolveAssetUrl(info.file);
        if (url) {
          new THREE.TextureLoader().load(
            url,
            (tex: any) => {
              tex.colorSpace = THREE.NoColorSpace;
              applyWrapMode(tex, info.wrapS, info.wrapT);
              if (info.transform2d) applyUsdTransform2dToTexture(tex, info.transform2d);
              mat.clearcoatMap = tex;
              mat.needsUpdate = true;
            },
            undefined,
            (err: unknown) => {
              console.error('Failed to load UsdPreviewSurface clearcoat texture:', info.file, url, err);
            },
          );
          if (inputs.clearcoat === undefined) mat.clearcoat = 1.0;

          // When clearcoat is texture-driven, disable specular and environment reflections on the base layer.
          // This is critical for matching USD/Omniverse rendering where the base layer with roughness=0.7
          // appears completely matte/diffuse in areas where the clearcoat texture is dark (0).
          // The clearcoat layer itself (where texture is bright) provides all the glossy reflections.
          //
          // Three.js MeshPhysicalMaterial computes: final = base_diffuse + base_specular + clearcoat_specular
          // In USD, with roughness=0.7 and metallic=0, the base should be nearly purely diffuse.
          // Setting specularIntensity=0 and envMapIntensity=0 ensures the base layer shows only diffuse lighting.
          const isNonMetallic = inputs.metallic === undefined || inputs.metallic === 0;
          const isRough = mat.roughness >= 0.5;
          if (isNonMetallic && isRough) {
            // Completely disable specular reflections on the base layer.
            // Only the clearcoat layer (modulated by clearcoatMap) will produce glossy reflections.
            mat.specularIntensity = 0;
            mat.envMapIntensity = 0;
          }
        }
      }
    }

    // `inputs:emissiveColor.connect` to a UsdUVTexture (e.g. UsdPreviewSurface_emissive_texture.usda)
    const emSource = resolveConnectedPrim(root, shader, 'inputs:emissiveColor');
    if (emSource) {
      const info = resolveUsdUvTextureInfo(root, emSource);
      if (info) {
        const url = resolveAssetUrl(info.file);
        if (url) {
          new THREE.TextureLoader().load(
            url,
            (tex: any) => {
              const cs = (info.sourceColorSpace ?? '').toLowerCase();
              tex.colorSpace = (cs === 'srgb' || cs === '') ? THREE.SRGBColorSpace : THREE.NoColorSpace;
              applyWrapMode(tex, info.wrapS, info.wrapT);
              if (info.transform2d) applyUsdTransform2dToTexture(tex, info.transform2d);
              mat.emissiveMap = tex;

              // Ensure the emissive map actually contributes if no constant emissiveColor was authored.
              if (!inputs.emissiveColor) mat.emissive.setHex(0xffffff);
              mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 1.0);
              mat.needsUpdate = true;
            },
            undefined,
            (err: unknown) => {
              console.error('Failed to load UsdPreviewSurface emissive texture:', info.file, url, err);
            },
          );
        }
      }
    }
  }

  return mat;
}


