import * as THREE from 'three';
import { resolveAssetPath, type SdfPrimSpec } from '@cinevva/usdjs';

import { alphaToGreenAlphaMap } from './textureUtils';
import { deferTextureApply, getOrLoadTextureClone } from '../textureCache';

const isExr = (url: string) => /\.exr(\?|#|$)/i.test(url);

export function extractOmniPbrInputs(shader: SdfPrimSpec): {
    diffuseColor?: THREE.Color;
    diffuseTexture?: string;
    diffuseTint?: THREE.Color;
    roughness?: number;
    specularLevel?: number;
    emissiveColor?: THREE.Color;
    emissiveColorTexture?: string;
    emissiveIntensity?: number;
    enableEmission?: boolean;
    enableOpacity?: boolean;
    opacityConstant?: number;
    enableOpacityTexture?: boolean;
    opacityTexture?: string;
    opacityThreshold?: number;
    opacityMode?: number;
} {
    const result: any = {};

    const getAssetPath = (name: string): string | undefined => {
        const prop = shader.properties?.get(name);
        const dv: any = prop?.defaultValue;
        // Some layers serialize asset paths as plain strings; support both.
        if (typeof dv === 'string') return dv;
        if (dv && typeof dv === 'object' && dv.type === 'asset' && typeof dv.value === 'string') {
            const fromId = typeof (dv as any).__fromIdentifier === 'string' ? (dv as any).__fromIdentifier : null;
            return fromId ? resolveAssetPath(dv.value, fromId) : dv.value;
        }
        // usdjs may parse `@path@`-style authored values as a 'reference' SdfValue (with extra metadata fields).
        // OmniPBR MDL inputs frequently use this encoding.
        if (dv && typeof dv === 'object' && dv.type === 'reference' && typeof dv.assetPath === 'string') {
            const fromId = typeof (dv as any).__fromIdentifier === 'string' ? (dv as any).__fromIdentifier : null;
            return fromId ? resolveAssetPath(dv.assetPath, fromId) : dv.assetPath;
        }
        return undefined;
    };

    const getColor3f = (name: string): THREE.Color | undefined => {
        const prop = shader.properties?.get(name);
        const dv: any = prop?.defaultValue;
        if (!dv || typeof dv !== 'object' || dv.type !== 'tuple') return undefined;
        const tuple = dv.value;
        if (tuple.length >= 3 && typeof tuple[0] === 'number' && typeof tuple[1] === 'number' && typeof tuple[2] === 'number') {
            return new THREE.Color(tuple[0], tuple[1], tuple[2]);
        }
        return undefined;
    };

    const getFloat = (name: string): number | undefined => {
        const prop = shader.properties?.get(name);
        const dv: any = prop?.defaultValue;
        if (typeof dv === 'number') return dv;
        return undefined;
    };

    const getBool = (name: string): boolean | undefined => {
        const prop = shader.properties?.get(name);
        const dv: any = prop?.defaultValue;
        if (typeof dv === 'boolean') return dv;
        if (typeof dv === 'number') return dv !== 0;
        return undefined;
    };

    result.diffuseColor = getColor3f('inputs:diffuse_color_constant');
    result.diffuseTexture = getAssetPath('inputs:diffuse_texture');
    result.diffuseTint = getColor3f('inputs:diffuse_tint');
    result.roughness = getFloat('inputs:reflection_roughness_constant');
    result.specularLevel = getFloat('inputs:specular_level');
    result.emissiveColor = getColor3f('inputs:emissive_color');
    result.emissiveColorTexture = getAssetPath('inputs:emissive_color_texture');
    result.emissiveIntensity = getFloat('inputs:emissive_intensity');
    result.enableEmission = getBool('inputs:enable_emission');

    result.enableOpacity = getBool('inputs:enable_opacity');
    result.opacityConstant = getFloat('inputs:opacity_constant');
    result.enableOpacityTexture = getBool('inputs:enable_opacity_texture');
    result.opacityTexture = getAssetPath('inputs:opacity_texture');
    result.opacityThreshold = getFloat('inputs:opacity_threshold');
    result.opacityMode = getFloat('inputs:opacity_mode');

    return result;
}

export function createOmniPbrMaterial(opts: {
    shader: SdfPrimSpec;
    resolveAssetUrl?: (assetPath: string, fromIdentifier?: string) => string | null;
}): THREE.MeshStandardMaterial {
    const { shader, resolveAssetUrl } = opts;

    const inputs = extractOmniPbrInputs(shader);
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

    // Albedo map (the "multiply texture" samples use a diffuse texture and a tint multiplier)
    if (inputs.diffuseTexture && resolveAssetUrl) {
        const url = resolveAssetUrl(inputs.diffuseTexture);
        // Debug: OmniPBR texture resolution
        try {
            const q = new URLSearchParams((window as any)?.location?.search ?? '');
            const USDDEBUG = q.get('usddebug') === '1' || (window as any)?.localStorage?.getItem?.('usddebug') === '1';
            if (USDDEBUG) {
                // eslint-disable-next-line no-console
                console.log('[usdjs-viewer][OmniPBR] diffuse_texture', {
                    shader: shader.path?.primPath,
                    asset: inputs.diffuseTexture,
                    url,
                });
            }
        } catch {
            // ignore
        }
        if (url) {
            void getOrLoadTextureClone(url, (tex) => {
                tex.colorSpace = isExr(url) ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
            }).then(
                (tex) => {
                    deferTextureApply(() => {
                        mat.map = tex;
                        mat.needsUpdate = true;
                    });
                },
                (err: unknown) => {
                    console.error('Failed to load OmniPBR diffuse texture:', inputs.diffuseTexture, url, err);
                },
            );
        }
    }

    if (inputs.roughness !== undefined) mat.roughness = THREE.MathUtils.clamp(inputs.roughness, 0, 1);
    if (inputs.specularLevel !== undefined) mat.metalness = THREE.MathUtils.clamp(inputs.specularLevel * 0.1, 0, 1);

    const enable = inputs.enableEmission ?? false;
    if (enable) {
        if (inputs.emissiveColor) mat.emissive.copy(inputs.emissiveColor);
        else mat.emissive.setHex(0xffffff);

        if (inputs.emissiveColorTexture && resolveAssetUrl) {
            const url = resolveAssetUrl(inputs.emissiveColorTexture);
            try {
                const q = new URLSearchParams((window as any)?.location?.search ?? '');
                const USDDEBUG = q.get('usddebug') === '1' || (window as any)?.localStorage?.getItem?.('usddebug') === '1';
                if (USDDEBUG) {
                    // eslint-disable-next-line no-console
                    console.log('[usdjs-viewer][OmniPBR] emissive_color_texture', {
                        shader: shader.path?.primPath,
                        asset: inputs.emissiveColorTexture,
                        url,
                    });
                }
            } catch {
                // ignore
            }
            if (url) {
                void getOrLoadTextureClone(url, (tex) => {
                    tex.colorSpace = isExr(url) ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
                }).then(
                    (tex) => {
                        deferTextureApply(() => {
                            mat.emissiveMap = tex;
                            mat.needsUpdate = true;
                        });
                    },
                    (err: unknown) => {
                        console.error('Failed to load OmniPBR emissive texture:', inputs.emissiveColorTexture, url, err);
                    },
                );
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
            const url = resolveAssetUrl(inputs.opacityTexture);
            if (url) {
                void getOrLoadTextureClone(url, (tex) => {
                    // Opacity map should be treated as data, not color-managed.
                    tex.colorSpace = THREE.NoColorSpace;
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


