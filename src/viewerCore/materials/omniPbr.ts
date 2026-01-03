import * as THREE from 'three';
import { type SdfPrimSpec } from '@cinevva/usdjs';

import { alphaToGreenAlphaMap } from './textureUtils';
import { deferTextureApply, getOrLoadTextureClone, getOrLoadUdimTextureSet } from '../textureCache';
import { createPropertyGetters, type AssetInfo } from './valueExtraction';
import { applyUdimMapSampling, applyUdimPackedOrmSampling } from './udim';
import { loadTextureToMaterialSlot } from './udimLoader';

const isExr = (url: string) => /\.exr(\?|#|$)/i.test(url);

export function extractOmniPbrInputs(shader: SdfPrimSpec): {
    diffuseColor?: THREE.Color;
    diffuseTexture?: AssetInfo;
    diffuseTint?: THREE.Color;
    roughness?: number;
    roughnessTextureInfluence?: number;
    specularLevel?: number;
    emissiveColor?: THREE.Color;
    emissiveColorTexture?: AssetInfo;
    emissiveIntensity?: number;
    enableEmission?: boolean;
    enableNormalmapTexture?: boolean;
    normalmapTexture?: AssetInfo;
    enableOrmTexture?: boolean;
    ormTexture?: AssetInfo;
    metallicTextureInfluence?: number;
    enableOpacity?: boolean;
    opacityConstant?: number;
    enableOpacityTexture?: boolean;
    opacityTexture?: AssetInfo;
    opacityThreshold?: number;
    opacityMode?: number;
} {
    const { getColor3f, getFloat, getBool, getAssetPath } = createPropertyGetters(shader);

    return {
        diffuseColor: getColor3f('inputs:diffuse_color_constant'),
        diffuseTexture: getAssetPath('inputs:diffuse_texture'),
        diffuseTint: getColor3f('inputs:diffuse_tint'),
        roughness: getFloat('inputs:reflection_roughness_constant'),
        roughnessTextureInfluence: getFloat('inputs:reflection_roughness_texture_influence'),
        specularLevel: getFloat('inputs:specular_level'),
        emissiveColor: getColor3f('inputs:emissive_color'),
        emissiveColorTexture: getAssetPath('inputs:emissive_color_texture'),
        emissiveIntensity: getFloat('inputs:emissive_intensity'),
        enableEmission: getBool('inputs:enable_emission'),
        enableNormalmapTexture: getBool('inputs:enable_normalmap_texture'),
        normalmapTexture: getAssetPath('inputs:normalmap_texture'),
        enableOrmTexture: getBool('inputs:enable_ORM_texture'),
        ormTexture: getAssetPath('inputs:ORM_texture'),
        metallicTextureInfluence: getFloat('inputs:metallic_texture_influence'),
        enableOpacity: getBool('inputs:enable_opacity'),
        opacityConstant: getFloat('inputs:opacity_constant'),
        enableOpacityTexture: getBool('inputs:enable_opacity_texture'),
        opacityTexture: getAssetPath('inputs:opacity_texture'),
        opacityThreshold: getFloat('inputs:opacity_threshold'),
        opacityMode: getFloat('inputs:opacity_mode'),
    };
}

export function createOmniPbrMaterial(opts: {
    shader: SdfPrimSpec;
    resolveAssetUrl?: (assetPath: string, fromIdentifier?: string) => string | null;
}): THREE.MeshStandardMaterial {
    const { shader, resolveAssetUrl } = opts;

    const USDDEBUG = typeof window !== 'undefined' && (
        new URLSearchParams(window.location.search).get('usddebug') === '1' ||
        window.localStorage?.getItem?.('usddebug') === '1'
    );

    if (USDDEBUG) {
        console.log('[TEXTURE:OmniPBR] Creating material', {
            shaderPath: shader.path?.primPath,
            shaderType: shader.typeName,
            hasResolveAssetUrl: !!resolveAssetUrl,
        });
    }

    const inputs = extractOmniPbrInputs(shader);

    if (USDDEBUG) {
        console.log('[TEXTURE:OmniPBR] Extracted inputs', {
            diffuseTexture: inputs.diffuseTexture,
            normalmapTexture: inputs.normalmapTexture,
            ormTexture: inputs.ormTexture,
            opacityTexture: inputs.opacityTexture,
            emissiveColorTexture: inputs.emissiveColorTexture,
        });
    }

    const mat = new THREE.MeshStandardMaterial();

    mat.color.setHex(0xffffff);
    // Default to fully rough (no specular) unless authored. OmniPBR materials without
    // authored roughness (especially emissive-only) should not show distracting specular highlights.
    mat.roughness = 1.0;
    mat.metalness = 0.0;
    // Default to double-sided rendering for OmniPBR materials since USD files
    // often don't author doubleSided but expect visibility from both sides.
    mat.side = THREE.DoubleSide;

    if (inputs.diffuseColor) mat.color.copy(inputs.diffuseColor);
    if (inputs.diffuseTint) mat.color.copy(inputs.diffuseTint);

    const configureRepeat = (tex: THREE.Texture) => {
        // OmniPBR expects repeating UVs in many corpora (e.g. pallets have U up to ~2.0).
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
    };

    // Albedo map (the "multiply texture" samples use a diffuse texture and a tint multiplier)
    if (inputs.diffuseTexture && resolveAssetUrl) {
        if (USDDEBUG) {
            console.log('[TEXTURE:OmniPBR] Resolving diffuse texture', {
                path: inputs.diffuseTexture.path,
                fromIdentifier: inputs.diffuseTexture.fromIdentifier,
            });
        }
        const url = resolveAssetUrl(inputs.diffuseTexture.path, inputs.diffuseTexture.fromIdentifier ?? undefined);
        if (url) {
            if (USDDEBUG) {
                console.log('[TEXTURE:OmniPBR] Diffuse texture resolved', { url });
            }
            const configure = (tex: THREE.Texture) => {
                tex.colorSpace = isExr(url) ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
                configureRepeat(tex);
            };

            // UDIM: load tile set + patch shader for correct sampling.
            if (url.includes('<UDIM>') || url.toLowerCase().includes('%3cudim%3e')) {
                void getOrLoadUdimTextureSet(url, configure).then(
                    (set) => {
                        if (!set || set.tiles.length === 0) {
                            // Fallback to old behavior (will likely 404 unless the path is already a real tile).
                            return getOrLoadTextureClone(url, configure).then((tex) => {
                                deferTextureApply(() => {
                                    mat.map = tex;
                                    mat.needsUpdate = true;
                                });
                            });
                        }
                        deferTextureApply(() => {
                            // Apply UDIM shader sampling (also assigns mat.map to first tile to enable USE_MAP).
                            applyUdimMapSampling(mat, set, { debugName: 'OmniPBR:diffuse' });
                            mat.needsUpdate = true;
                        });
                    },
                    (err: unknown) => {
                        console.error('Failed to load OmniPBR UDIM diffuse textures:', inputs.diffuseTexture, url, err);
                    },
                );
            } else {
                void getOrLoadTextureClone(url, configure).then(
                    (tex) => {
                        deferTextureApply(() => {
                            mat.map = tex;
                            mat.needsUpdate = true;
                        });
                    },
                    (err: unknown) => {
                        console.error('[TEXTURE:OmniPBR] Failed to load diffuse texture:', inputs.diffuseTexture, url, err);
                    },
                );
            }
        } else {
            if (USDDEBUG) {
                console.warn('[TEXTURE:OmniPBR] Diffuse texture URL resolution returned null', {
                    path: inputs.diffuseTexture.path,
                    fromIdentifier: inputs.diffuseTexture.fromIdentifier,
                });
            }
        }
    } else {
        if (USDDEBUG) {
            console.log('[TEXTURE:OmniPBR] No diffuse texture input', {
                hasDiffuseTexture: !!inputs.diffuseTexture,
                hasResolveAssetUrl: !!resolveAssetUrl,
            });
        }
    }

    if (inputs.roughness !== undefined) mat.roughness = THREE.MathUtils.clamp(inputs.roughness, 0, 1);
    if (inputs.specularLevel !== undefined) mat.metalness = THREE.MathUtils.clamp(inputs.specularLevel * 0.1, 0, 1);

    // Normal map
    if ((inputs.enableNormalmapTexture ?? true) && inputs.normalmapTexture && resolveAssetUrl) {
        if (USDDEBUG) {
            console.log('[TEXTURE:OmniPBR] Resolving normal texture', {
                path: inputs.normalmapTexture.path,
                fromIdentifier: inputs.normalmapTexture.fromIdentifier,
            });
        }
        const url = resolveAssetUrl(inputs.normalmapTexture.path, inputs.normalmapTexture.fromIdentifier ?? undefined);
        if (url) {
            if (USDDEBUG) {
                console.log('[TEXTURE:OmniPBR] Normal texture resolved', { url });
            }
            void loadTextureToMaterialSlot({
                mat,
                slot: 'normalMap',
                url,
                debugName: 'OmniPBR:normal',
                configure: (tex) => {
                    tex.colorSpace = THREE.NoColorSpace;
                    configureRepeat(tex);
                },
            }).catch((err: unknown) => {
                console.error('Failed to load OmniPBR normal texture:', inputs.normalmapTexture, url, err);
            });
        }
    }

    // ORM map (Occlusion/Roughness/Metallic in RGB)
    if ((inputs.enableOrmTexture ?? true) && inputs.ormTexture && resolveAssetUrl) {
        if (USDDEBUG) {
            console.log('[TEXTURE:OmniPBR] Resolving ORM texture', {
                path: inputs.ormTexture.path,
                fromIdentifier: inputs.ormTexture.fromIdentifier,
            });
        }
        const url = resolveAssetUrl(inputs.ormTexture.path, inputs.ormTexture.fromIdentifier ?? undefined);
        if (url) {
            if (USDDEBUG) {
                console.log('[TEXTURE:OmniPBR] ORM texture resolved', { url });
            }
            // Three multiplies roughnessFactor/metalnessFactor by map channels, so set scalar factors to the authored influences.
            const roughInf = inputs.roughnessTextureInfluence ?? 1.0;
            const metalInf = inputs.metallicTextureInfluence ?? 1.0;
            const configure = (tex: THREE.Texture) => {
                tex.colorSpace = THREE.NoColorSpace;
                configureRepeat(tex);
            };

            const isUdim = url.includes('<UDIM>') || url.toLowerCase().includes('%3cudim%3e');
            if (isUdim) {
                void getOrLoadUdimTextureSet(url, configure).then(
                    (set) => {
                        if (!set || set.tiles.length === 0) return;
                        deferTextureApply(() => {
                            // Apply packed ORM UDIM sampling once (shared sampler set for R/G/B usage).
                            applyUdimPackedOrmSampling(mat, set, { debugName: 'OmniPBR:ormPacked' });
                            mat.roughness = THREE.MathUtils.clamp(roughInf, 0, 1);
                            mat.metalness = THREE.MathUtils.clamp(metalInf, 0, 1);
                            mat.aoMapIntensity = 1.0;
                            mat.needsUpdate = true;
                        });
                    },
                    (err: unknown) => {
                        console.error('Failed to load OmniPBR UDIM ORM textures:', inputs.ormTexture, url, err);
                    },
                );
            } else {
                void getOrLoadTextureClone(url, configure).then(
                    (tex) => {
                        deferTextureApply(() => {
                            // Single packed ORM texture: share it across the three slots.
                            mat.roughnessMap = tex;
                            mat.metalnessMap = tex;
                            mat.aoMap = tex;
                            mat.roughness = THREE.MathUtils.clamp(roughInf, 0, 1);
                            mat.metalness = THREE.MathUtils.clamp(metalInf, 0, 1);
                            mat.aoMapIntensity = 1.0;
                            mat.needsUpdate = true;
                        });
                    },
                    (err: unknown) => {
                        console.error('Failed to load OmniPBR ORM texture:', inputs.ormTexture, url, err);
                    },
                );
            }
        }
    }

    const enable = inputs.enableEmission ?? false;
    if (enable) {
        if (inputs.emissiveColor) mat.emissive.copy(inputs.emissiveColor);
        else mat.emissive.setHex(0xffffff);

        if (inputs.emissiveColorTexture && resolveAssetUrl) {
            const url = resolveAssetUrl(inputs.emissiveColorTexture.path, inputs.emissiveColorTexture.fromIdentifier ?? undefined);
            if (url) {
                void loadTextureToMaterialSlot({
                    mat,
                    slot: 'emissiveMap',
                    url,
                    debugName: 'OmniPBR:emissive',
                    configure: (tex) => {
                        tex.colorSpace = isExr(url) ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
                        configureRepeat(tex);
                    },
                }).catch((err: unknown) => {
                    console.error('Failed to load OmniPBR emissive texture:', inputs.emissiveColorTexture, url, err);
                });
            }
        }

        const ei = inputs.emissiveIntensity ?? 0;
        mat.emissiveIntensity = Math.max(0, ei / 1000);
    } else {
        mat.emissive.setHex(0x000000);
        mat.emissiveIntensity = 0;
    }

    // Cutout/fractional opacity support (minimal): if enabled, drive material.opacity.
    // OmniPBR's `enable_opacity` is described as "cutout opacity" in the sample, but the constant values
    // (0.75/0.5/0.25) look like fractional opacity. We'll treat it as alpha blending for now.
    if (inputs.enableOpacity && inputs.opacityConstant !== undefined) {
        const a = THREE.MathUtils.clamp(inputs.opacityConstant, 0, 1);
        mat.opacity = a;
        mat.transparent = a < 1;
        // Avoid sorting artifacts being too extreme for now.
        mat.depthWrite = a >= 1;
    }

    // Texture cutout opacity with threshold (OmniPBR_opacityThreshold.usda)
    if (inputs.enableOpacity && inputs.enableOpacityTexture && inputs.opacityTexture && resolveAssetUrl) {
        const thr = inputs.opacityThreshold ?? 0;
        if (thr > 0) {
            const url = resolveAssetUrl(inputs.opacityTexture.path, inputs.opacityTexture.fromIdentifier ?? undefined);
            if (url) {
                void getOrLoadTextureClone(url, (tex) => {
                    // Opacity map should be treated as data, not color-managed.
                    tex.colorSpace = THREE.NoColorSpace;
                    configureRepeat(tex);
                }).then(
                    (tex) => {
                        deferTextureApply(() => {
                            // Three's alphaMap samples GREEN; if this texture has a meaningful alpha channel
                            // (common for cutout leaves), convert alpha->green for correct masking.
                            mat.alphaMap = alphaToGreenAlphaMap(tex) ?? tex;
                            mat.alphaTest = THREE.MathUtils.clamp(thr, 0, 1);
                            mat.transparent = false; // cutout/discard, not blending
                            mat.depthWrite = true;
                            mat.needsUpdate = true;
                        });

                        const mode = inputs.opacityMode ?? 0;
                        if (mode !== 0) {
                            // 0=mono_alpha; others are RGB-derived in OmniPBR (average/luminance/max).
                            console.warn('OmniPBR opacity_mode not fully supported (expected alpha channel). opacity_mode=', mode);
                        }
                    },
                    (err: unknown) => {
                        console.error('Failed to load OmniPBR opacity texture:', inputs.opacityTexture, url, err);
                    },
                );
            }
        }
    }

    return mat;
}


