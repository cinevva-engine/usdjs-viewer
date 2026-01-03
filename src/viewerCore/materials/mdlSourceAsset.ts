import * as THREE from 'three';
import { resolveAssetPath, type SdfPrimSpec } from '@cinevva/usdjs';

import { deferTextureApply, getOrLoadTextureClone, getOrLoadUdimTextureSet } from '../textureCache';
import { extractToken, extractColor3f, extractFloat, extractAssetPath as extractAssetPathUtil } from './valueExtraction';
import { applyUdimPackedOrmSampling, applyUdimTextureSampling } from './udim';
import { loadTextureToMaterialSlot } from './udimLoader';
import { findPrimByPath } from '../usdPaths';

type MdlResolved = {
    mdlUrl: string;
    subIdentifier: string | null;
    // Extracted texture paths from the MDL module (absolute URLs where possible).
    textures: {
        baseColor?: string;
        normal?: string;
        orm?: string;
        roughness?: string;
        metallic?: string;
        emissive?: string;
        opacity?: string;
        // Best-effort environment candidate for dome/background.
        environment?: string;
    };
    constants: {
        diffuseColor?: THREE.Color;
        roughness?: number;
        metallic?: number;
    };
};

function stripCorpusPrefix(v: string): string {
    return v.startsWith('[corpus]') ? v.replace('[corpus]', '') : v;
}

function getStringProp(shader: SdfPrimSpec, name: string): string | null {
    const dv = shader.properties?.get(name)?.defaultValue;
    const token = extractToken(dv);
    return token ? stripCorpusPrefix(token) : null;
}

function getAssetProp(shader: SdfPrimSpec, name: string, root?: SdfPrimSpec): string | null {
    const USDDEBUG = typeof window !== 'undefined' && (
        new URLSearchParams(window.location.search).get('usddebug') === '1' ||
        window.localStorage?.getItem?.('usddebug') === '1'
    );

    // First check for a direct asset property
    const dv: any = shader.properties?.get(name)?.defaultValue;
    if (typeof dv === 'string') {
        if (USDDEBUG) console.log(`[MATERIALS:MDL] getAssetProp(${name}): direct string`, dv);
        return stripCorpusPrefix(dv);
    }
    if (dv && typeof dv === 'object' && dv.type === 'asset' && typeof dv.value === 'string') {
        const fromId = typeof (dv as any).__fromIdentifier === 'string' ? (dv as any).__fromIdentifier : null;
        const normFromId = typeof fromId === 'string' ? stripCorpusPrefix(fromId) : null;
        const normVal = stripCorpusPrefix(dv.value);
        const result = normFromId ? resolveAssetPath(normVal, normFromId) : normVal;
        if (USDDEBUG) console.log(`[MATERIALS:MDL] getAssetProp(${name}): asset type`, { value: dv.value, fromId, result });
        return result;
    }
    // usdjs sometimes encodes @path@ values as 'reference' SdfValue.
    if (dv && typeof dv === 'object' && dv.type === 'reference' && typeof dv.assetPath === 'string') {
        const fromId = typeof (dv as any).__fromIdentifier === 'string' ? (dv as any).__fromIdentifier : null;
        const normFromId = typeof fromId === 'string' ? stripCorpusPrefix(fromId) : null;
        const normVal = stripCorpusPrefix(dv.assetPath);
        const result = normFromId ? resolveAssetPath(normVal, normFromId) : normVal;
        if (USDDEBUG) console.log(`[MATERIALS:MDL] getAssetProp(${name}): reference type`, { assetPath: dv.assetPath, fromId, result });
        return result;
    }

    // Check for a connection (e.g., inputs:diffuse_texture.connect = </path/to/textureShader.outputs:rgb>)
    const connectPropName = `${name}.connect`;
    const connectProp = shader.properties?.get(connectPropName);
    
    if (USDDEBUG) {
        console.log(`[MATERIALS:MDL] getAssetProp(${name}): checking connection`, {
            connectPropName,
            hasConnectProp: !!connectProp,
            hasRoot: !!root,
            connectPropValue: connectProp?.defaultValue,
        });
    }
    
    if (connectProp && root) {
        const connDv: any = connectProp.defaultValue;
        if (USDDEBUG) {
            console.log(`[MATERIALS:MDL] getAssetProp(${name}): connection value`, {
                connDv,
                type: typeof connDv,
                isObject: typeof connDv === 'object',
                hasType: connDv?.type,
                hasValue: typeof connDv?.value === 'string',
            });
        }
        if (connDv && typeof connDv === 'object' && connDv.type === 'sdfpath' && typeof connDv.value === 'string') {
            const targetPath = connDv.value; // e.g., </Environment/riser/Looks/riser_m/diffuseColorTex.outputs:rgb>
            const lastDot = targetPath.lastIndexOf('.');
            const shaderPath = lastDot > 0 ? targetPath.substring(0, lastDot) : targetPath;
            
            if (USDDEBUG) {
                console.log(`[MATERIALS:MDL] getAssetProp(${name}): found connection`, {
                    targetPath,
                    shaderPath,
                });
            }

            // Find the connected shader prim
            const texShader = findPrimByPath(root, shaderPath);
            if (texShader) {
                // Try to get the file from the texture shader (UsdUVTexture convention)
                const fileProp = texShader.properties?.get('inputs:file');
                if (fileProp) {
                    const fileDv: any = fileProp.defaultValue;
                    if (typeof fileDv === 'string') {
                        if (USDDEBUG) console.log(`[MATERIALS:MDL] getAssetProp(${name}): found file in connected shader`, fileDv);
                        return stripCorpusPrefix(fileDv);
                    }
                    if (fileDv && typeof fileDv === 'object' && fileDv.type === 'asset' && typeof fileDv.value === 'string') {
                        const fromId = typeof fileDv.__fromIdentifier === 'string' ? fileDv.__fromIdentifier : null;
                        const normFromId = typeof fromId === 'string' ? stripCorpusPrefix(fromId) : null;
                        const normVal = stripCorpusPrefix(fileDv.value);
                        const result = normFromId ? resolveAssetPath(normVal, normFromId) : normVal;
                        if (USDDEBUG) console.log(`[MATERIALS:MDL] getAssetProp(${name}): found asset in connected shader`, { value: fileDv.value, fromId, result });
                        return result;
                    }
                }
                if (USDDEBUG) {
                    console.warn(`[MATERIALS:MDL] getAssetProp(${name}): connected shader found but no file property`, {
                        shaderPath,
                        properties: Array.from(texShader.properties?.keys() ?? []),
                    });
                }
            } else {
                if (USDDEBUG) {
                    console.warn(`[MATERIALS:MDL] getAssetProp(${name}): connected shader not found`, shaderPath);
                }
            }
        }
    }

    if (USDDEBUG && !dv && !connectProp) {
        console.log(`[MATERIALS:MDL] getAssetProp(${name}): not found`);
    }
    return null;
}

function parseColor3(maybe: string | null): THREE.Color | null {
    if (!maybe) return null;
    // MDL: color(0.2f, 0.2f, 0.2f)
    const m = maybe.match(/color\s*\(\s*([0-9.+-eE]+)f?\s*,\s*([0-9.+-eE]+)f?\s*,\s*([0-9.+-eE]+)f?\s*\)/);
    if (!m) return null;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    return new THREE.Color(r, g, b);
}

function resolveRelativeToMdlUrl(mdlUrl: string, relPath: string): string {
    try {
        // Absolute URL already.
        if (/^[a-z]+:\/\//i.test(relPath)) return relPath;
        const base = new URL(mdlUrl);
        // Resolve relative to the MDL module directory.
        const dir = base.pathname.split('/').slice(0, -1).join('/') + '/';
        const u = new URL(base.origin + dir + relPath.replace(/^\.\//, ''));
        return u.toString();
    } catch {
        return relPath;
    }
}

function extractMdlTextureArgs(mdlText: string): Array<{ key: string; path: string }> {
    // Match `foo: texture_2d("path/to/file.png" ... )`
    const out: Array<{ key: string; path: string }> = [];
    const re = /([A-Za-z0-9_]+)\s*:\s*texture_2d\s*\(\s*"([^"]+)"\s*/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(mdlText))) {
        out.push({ key: m[1]!, path: m[2]! });
    }
    return out;
}

function chooseByName(candidates: string[], want: RegExp, avoid?: RegExp): string | undefined {
    const filtered = candidates.filter((p) => want.test(p) && (!avoid || !avoid.test(p)));
    if (!filtered.length) return undefined;
    // Prefer longer paths (often more specific), but it's heuristic.
    return filtered.sort((a, b) => b.length - a.length)[0];
}

function extractEnvCandidate(candidates: string[]): string | undefined {
    // Prefer HDR/EXR.
    const hdr = candidates.find((p) => /\.hdr(\?|#|$)/i.test(p));
    if (hdr) return hdr;
    const exr = candidates.find((p) => /\.exr(\?|#|$)/i.test(p));
    if (exr) return exr;
    return undefined;
}

async function fetchMdlText(mdlUrl: string, resolveAssetUrl?: (assetPath: string) => string | null): Promise<string> {
    const url = resolveAssetUrl ? resolveAssetUrl(mdlUrl) : mdlUrl;
    if (!url) throw new Error(`MDL fetch: could not resolve URL for ${mdlUrl}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MDL fetch failed (${res.status} ${res.statusText}): ${mdlUrl}`);
    return await res.text();
}

/**
 * Check if this looks like a built-in MDL material (e.g., OmniPBR.mdl, OmniGlass.mdl).
 * Built-in materials are just filenames without paths.
 */
function isBuiltInMdl(mdlAsset: string): boolean {
    // Built-in materials are typically just "Name.mdl" without any path separators or URLs
    const isSimpleFilename = !mdlAsset.includes('/') && !mdlAsset.includes('\\') && !mdlAsset.includes(':');
    const knownBuiltins = ['OmniPBR.mdl', 'OmniGlass.mdl', 'OmniSurface.mdl', 'OmniSurfaceBase.mdl', 'OmniEmissive.mdl', 'OmniHairBase.mdl'];
    return isSimpleFilename || knownBuiltins.some(b => mdlAsset.endsWith(b));
}

/**
 * For built-in MDL materials (like OmniPBR), read shader inputs directly from USD.
 * OmniPBR uses inputs like:
 *   - inputs:diffuse_color_constant (color)
 *   - inputs:diffuse_texture (asset)
 *   - inputs:reflection_roughness_constant (float)
 *   - inputs:metallic_constant (float)
 *   - inputs:normalmap_texture (asset)
 *   - inputs:ORM_texture (asset)
 */
function resolveFromUsdShaderInputs(
    shader: SdfPrimSpec,
    mdlAsset: string,
    root?: SdfPrimSpec,
): MdlResolved {
    console.log('[MATERIALS:MDL] Resolving built-in MDL from USD shader inputs:', mdlAsset);

    const USDDEBUG = typeof window !== 'undefined' && (
        new URLSearchParams(window.location.search).get('usddebug') === '1' ||
        window.localStorage?.getItem?.('usddebug') === '1'
    );

    if (USDDEBUG) {
        console.log('[MATERIALS:MDL] Shader properties:', {
            shaderPath: shader.path?.primPath,
            propertyKeys: Array.from(shader.properties?.keys() ?? []),
            children: Array.from(shader.children?.keys() ?? []),
            hasRoot: !!root,
            rootPath: root?.path?.primPath,
        });
        
        // Log all input properties
        const inputProps = Array.from(shader.properties?.keys() ?? []).filter(k => k.startsWith('inputs:'));
        console.log('[MATERIALS:MDL] Input properties:', inputProps);
        
        // Log all properties (including .connect properties)
        const allProps = Array.from(shader.properties?.keys() ?? []);
        const connectProps = allProps.filter(k => k.includes('.connect'));
        console.log('[MATERIALS:MDL] All .connect properties found:', connectProps);
        for (const connectPropName of connectProps) {
            const connectProp = shader.properties?.get(connectPropName);
            console.log(`[MATERIALS:MDL]   ${connectPropName}:`, connectProp?.defaultValue);
        }
        
        for (const propName of inputProps) {
            const prop = shader.properties?.get(propName);
            const defaultValue = prop?.defaultValue;
            console.log(`[MATERIALS:MDL]   ${propName}:`, defaultValue);
        }
    }

    const subId = getStringProp(shader, 'info:mdl:sourceAsset:subIdentifier');

    // Read texture inputs using OmniPBR naming convention
    // First try direct properties and connections
    let textures: MdlResolved['textures'] = {
        baseColor: getAssetProp(shader, 'inputs:diffuse_texture', root) ?? undefined,
        normal: getAssetProp(shader, 'inputs:normalmap_texture', root) ?? undefined,
        orm: getAssetProp(shader, 'inputs:ORM_texture', root) ?? undefined,
        roughness: getAssetProp(shader, 'inputs:reflectionroughness_texture', root) ?? undefined,
        metallic: getAssetProp(shader, 'inputs:metallic_texture', root) ?? undefined,
        emissive: getAssetProp(shader, 'inputs:emissive_mask_texture', root) ?? undefined,
        opacity: getAssetProp(shader, 'inputs:opacity_texture', root) ?? undefined,
    };

    // If textures weren't found via connections, try finding texture shaders by name pattern
    // Some USD files store textures as child shader prims with predictable names
    if (root && (!textures.baseColor || !textures.normal || !textures.metallic || !textures.roughness)) {
        // Find the material prim (parent of the shader)
        const shaderPath = shader.path?.primPath;
        if (shaderPath) {
            const parts = shaderPath.split('/').filter(Boolean);
            if (parts.length >= 2) {
                // Material should be parent of shader: /Material/Shader -> /Material
                const materialPath = '/' + parts.slice(0, -1).join('/');
                const materialPrim = findPrimByPath(root, materialPath);
                
                if (USDDEBUG) {
                    console.log('[MATERIALS:MDL] Looking for texture shaders in material', {
                        materialPath,
                        materialPrim: materialPrim?.path?.primPath,
                        children: Array.from(materialPrim?.children?.keys() ?? []),
                    });
                }

                if (materialPrim && materialPrim.children) {
                    // Common texture shader naming patterns in Omniverse
                    const textureShaderMap: Record<string, string[]> = {
                        baseColor: ['diffuseColorTex', 'diffuseTex', 'diffuse_texture', 'albedoTex'],
                        normal: ['normalTex', 'normalmapTex', 'normal_texture'],
                        metallic: ['metallicTex', 'metallic_texture'],
                        roughness: ['roughnessTex', 'roughness_texture'],
                        orm: ['ormTex', 'ORM_texture', 'orm_texture'],
                        opacity: ['opacityTex', 'opacity_texture'],
                    };

                    // Search for texture shaders by name
                    for (const [textureType, namePatterns] of Object.entries(textureShaderMap)) {
                        if (textures[textureType as keyof typeof textures]) continue; // Already found

                        for (const pattern of namePatterns) {
                            const texShader = materialPrim.children.get(pattern);
                            if (texShader) {
                                if (USDDEBUG) {
                                    console.log(`[MATERIALS:MDL] Found texture shader by name: ${pattern} for ${textureType}`);
                                }
                                // Extract file from texture shader
                                const fileProp = texShader.properties?.get('inputs:file');
                                if (fileProp) {
                                    const fileDv: any = fileProp.defaultValue;
                                    let filePath: string | null = null;
                                    
                                    if (typeof fileDv === 'string') {
                                        filePath = stripCorpusPrefix(fileDv);
                                    } else if (fileDv && typeof fileDv === 'object' && fileDv.type === 'asset' && typeof fileDv.value === 'string') {
                                        const fromId = typeof fileDv.__fromIdentifier === 'string' ? fileDv.__fromIdentifier : null;
                                        const normFromId = typeof fromId === 'string' ? stripCorpusPrefix(fromId) : null;
                                        const normVal = stripCorpusPrefix(fileDv.value);
                                        filePath = normFromId ? resolveAssetPath(normVal, normFromId) : normVal;
                                    } else if (fileDv && typeof fileDv === 'object' && fileDv.type === 'reference' && typeof fileDv.assetPath === 'string') {
                                        const fromId = typeof fileDv.__fromIdentifier === 'string' ? fileDv.__fromIdentifier : null;
                                        const normFromId = typeof fromId === 'string' ? stripCorpusPrefix(fromId) : null;
                                        const normVal = stripCorpusPrefix(fileDv.assetPath);
                                        filePath = normFromId ? resolveAssetPath(normVal, normFromId) : normVal;
                                    }

                                    if (filePath) {
                                        if (USDDEBUG) {
                                            console.log(`[MATERIALS:MDL] Extracted texture path for ${textureType}:`, filePath);
                                        }
                                        textures[textureType as keyof typeof textures] = filePath;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (USDDEBUG) {
        console.log('[MATERIALS:MDL] Extracted textures:', textures);
    }

    // Read constant values using utility functions
    const constants: MdlResolved['constants'] = {};

    // diffuse_color_constant
    const diffuseColor = extractColor3f(shader.properties?.get('inputs:diffuse_color_constant')?.defaultValue);
    if (diffuseColor) constants.diffuseColor = diffuseColor;

    // reflection_roughness_constant
    const roughness = extractFloat(shader.properties?.get('inputs:reflection_roughness_constant')?.defaultValue);
    if (roughness !== undefined) constants.roughness = roughness;

    // metallic_constant
    const metallic = extractFloat(shader.properties?.get('inputs:metallic_constant')?.defaultValue);
    if (metallic !== undefined) constants.metallic = metallic;

    console.log('[MATERIALS:MDL] Built-in MDL resolved from USD inputs:', { textures, constants });

    return {
        mdlUrl: mdlAsset,
        subIdentifier: typeof subId === 'string' ? subId : null,
        textures,
        constants,
    };
}

async function resolveMdlSourceAsset(
    shader: SdfPrimSpec,
    resolveAssetUrl?: (assetPath: string) => string | null,
    root?: SdfPrimSpec,
): Promise<MdlResolved | null> {
    console.log('[MATERIALS:MDL] resolveMdlSourceAsset called for:', shader.path?.primPath);
    const impl = getStringProp(shader, 'info:implementationSource');
    const mdlAsset = getAssetProp(shader, 'info:mdl:sourceAsset');
    console.log('[MATERIALS:MDL] Extracted values:', { impl, mdlAsset });
    if (impl !== 'sourceAsset' || !mdlAsset) {
        console.warn('[MATERIALS:MDL] Not an MDL sourceAsset shader:', { impl, mdlAsset });
        return null;
    }

    const subId = getStringProp(shader, 'info:mdl:sourceAsset:subIdentifier');

    // Check if this is a built-in MDL material
    if (isBuiltInMdl(mdlAsset)) {
        console.log('[MATERIALS:MDL] Detected built-in MDL material:', mdlAsset);
        return resolveFromUsdShaderInputs(shader, mdlAsset, root);
    }

    // Try to fetch the MDL file
    let mdlText: string;
    try {
        console.log('[MATERIALS:MDL] Fetching MDL text from:', mdlAsset);
        mdlText = await fetchMdlText(mdlAsset, resolveAssetUrl);
        console.log('[MATERIALS:MDL] MDL text fetched, length:', mdlText.length);
    } catch (err) {
        // Fetch failed - fall back to reading USD shader inputs
        console.warn('[MATERIALS:MDL] MDL fetch failed, falling back to USD shader inputs:', err);
        return resolveFromUsdShaderInputs(shader, mdlAsset, root);
    }

    const args = extractMdlTextureArgs(mdlText);
    const texCandidates = args.map((x) => resolveRelativeToMdlUrl(mdlAsset, x.path));

    // Also pick up any obvious file refs (fallback).
    const fileRe = /"([^"]+\.(?:png|jpe?g|exr|hdr|tga|tif{1,2}|webp))"/gi;
    let mm: RegExpExecArray | null;
    while ((mm = fileRe.exec(mdlText))) texCandidates.push(resolveRelativeToMdlUrl(mdlAsset, mm[1]!));

    const unique = Array.from(new Set(texCandidates));
    console.log('[MATERIALS:MDL] Extracted texture candidates:', { args, unique });

    // MDL OmniPBR convention uses explicit keys; use them when present.
    const byKey = new Map(args.map((a) => [a.key, resolveRelativeToMdlUrl(mdlAsset, a.path)]));
    console.log('[MATERIALS:MDL] Texture keys map:', Array.from(byKey.entries()));

    const textures: MdlResolved['textures'] = {
        baseColor: byKey.get('diffuse_texture') ?? chooseByName(unique, /(basecolor|albedo|diffuse|color)/i, /(normal|rough|metal|orm|ao|occlusion)/i),
        normal: byKey.get('normalmap_texture') ?? chooseByName(unique, /(normal|_n(\.|_))/i),
        orm: byKey.get('ORM_texture') ?? chooseByName(unique, /(orm)/i),
        roughness: byKey.get('reflectionroughness_texture') ?? chooseByName(unique, /(rough)/i),
        metallic: byKey.get('metallic_texture') ?? chooseByName(unique, /(metal)/i),
        emissive: byKey.get('emissive_mask_texture') ?? chooseByName(unique, /(emissive|emit)/i),
        opacity: byKey.get('opacity_texture') ?? chooseByName(unique, /(opacity|alpha)/i),
        environment: extractEnvCandidate(unique),
    };
    console.log('[MATERIALS:MDL] Resolved textures:', textures);

    // Extract a couple of simple constants (best-effort).
    const constants: MdlResolved['constants'] = {};
    const col = mdlText.match(/diffuse_color_constant\s*:\s*(color\s*\([^)]+\))/);
    const c = parseColor3(col?.[1] ?? null);
    if (c) constants.diffuseColor = c;
    const rough = mdlText.match(/reflection_roughness_constant\s*:\s*([0-9.+-eE]+)f?/);
    if (rough) {
        const v = Number(rough[1]);
        if (Number.isFinite(v)) constants.roughness = v;
    }
    const met = mdlText.match(/metallic_constant\s*:\s*([0-9.+-eE]+)f?/);
    if (met) {
        const v = Number(met[1]);
        if (Number.isFinite(v)) constants.metallic = v;
    }

    return { mdlUrl: mdlAsset, subIdentifier: typeof subId === 'string' ? subId : null, textures, constants };
}

function configureColorTexture(tex: THREE.Texture) {
    // Prefer SRGB for baseColor/emissive.
    (tex as any).colorSpace = (THREE as any).SRGBColorSpace ?? (tex as any).colorSpace;
}

function configureLinearTexture(tex: THREE.Texture) {
    (tex as any).colorSpace = (THREE as any).LinearSRGBColorSpace ?? (tex as any).colorSpace;
}

export function createMdlSourceAssetMaterial(opts: {
    shader: SdfPrimSpec;
    resolveAssetUrl?: (assetPath: string, fromIdentifier?: string) => string | null;
    root?: SdfPrimSpec;
}): THREE.MeshStandardMaterial {
    const { shader, resolveAssetUrl } = opts;

    const shaderPath = shader.path?.primPath ?? 'unknown';
    console.log('[MATERIALS:MDL] createMdlSourceAssetMaterial called for shader:', shaderPath);

    // Placeholder material with OmniPBR defaults (per NVIDIA docs):
    // - diffuse_color_constant default: (0.2, 0.2, 0.2)
    // - reflection_roughness_constant default: 0.5
    // - metallic_constant default: 0.0
    const DEFAULT_OMNIPBR_COLOR = 0x333333; // RGB(51,51,51) ≈ (0.2, 0.2, 0.2)
    const mat = new THREE.MeshStandardMaterial({ color: DEFAULT_OMNIPBR_COLOR, roughness: 0.5, metalness: 0.0 });
    console.log('[MATERIALS:MDL] Created material with default color:', mat.color.getHexString());
    mat.side = THREE.DoubleSide;
    mat.name = `MDL_${shaderPath}`;
    console.log('[MATERIALS:MDL] Created material instance:', mat.name, mat.uuid);

    // Kick off async MDL parsing + texture application.
    void (async () => {
        console.log('[MATERIALS:MDL] Starting async MDL resolution for:', shader.path?.primPath);
        const mdl = await resolveMdlSourceAsset(shader, resolveAssetUrl ? (p) => resolveAssetUrl(p) : undefined, opts.root);
        if (!mdl) {
            console.warn('[MATERIALS:MDL] Failed to resolve MDL for:', shader.path?.primPath);
            return;
        }
        console.log('[MATERIALS:MDL] MDL resolved successfully:', {
            mdlUrl: mdl.mdlUrl,
            subIdentifier: mdl.subIdentifier,
            textures: mdl.textures,
            constants: mdl.constants,
        });

        // Only apply diffuseColor constant if there's no texture (texture will override it)
        if (mdl.constants.diffuseColor && !mdl.textures.baseColor) {
            console.log('[MATERIALS:MDL] Applying diffuseColor constant:', mdl.constants.diffuseColor.getHexString());
            deferTextureApply(() => {
                mat.color.copy(mdl.constants.diffuseColor!);
                mat.needsUpdate = true;
            });
        } else {
            if (mdl.textures.baseColor) {
                console.log('[MATERIALS:MDL] Skipping diffuseColor constant because baseColor texture is present');
            } else {
                console.log('[MATERIALS:MDL] No diffuseColor constant found, keeping default:', mat.color.getHexString());
            }
        }

        const loadTex = async (asset: string, cfg?: (t: THREE.Texture) => void): Promise<THREE.Texture | null> => {
            if (!resolveAssetUrl) {
                console.warn('[MATERIALS:MDL] No resolveAssetUrl function provided');
                return null;
            }
            const url = resolveAssetUrl(asset);
            if (!url) {
                console.warn('[MATERIALS:MDL] Failed to resolve asset URL for:', asset);
                return null;
            }
            console.log('[MATERIALS:MDL] Resolved texture URL:', asset, '->', url);
            try {
                console.log('[MATERIALS:MDL] Calling getOrLoadTextureClone for:', url);
                const tex = await getOrLoadTextureClone(url, cfg);
                console.log('[MATERIALS:MDL] getOrLoadTextureClone returned:', tex ? 'texture' : 'null', 'for:', url);
                if (!tex) {
                    console.warn('[MATERIALS:MDL] getOrLoadTextureClone returned null for:', url);
                }
                return tex;
            } catch (err) {
                console.error('[MATERIALS:MDL] Error loading texture:', url, err);
                return null;
            }
        };

        // Base color
        if (mdl.textures.baseColor) {
            console.log('[MATERIALS:MDL] Loading baseColor texture:', mdl.textures.baseColor);
            const url = resolveAssetUrl(mdl.textures.baseColor);
            console.log('[MATERIALS:MDL] Resolved baseColor URL:', url);
            if (url) {
                console.log('[MATERIALS:MDL] Calling loadTextureToMaterialSlot for baseColor');
                await loadTextureToMaterialSlot({
                    mat,
                    slot: 'map',
                    url,
                    debugName: 'MDL:baseColor',
                    configure: (t) => {
                        console.log('[MATERIALS:MDL] Configuring baseColor texture:', t);
                        configureColorTexture(t);
                        t.wrapS = THREE.RepeatWrapping;
                        t.wrapT = THREE.RepeatWrapping;
                    },
                });
                console.log('[MATERIALS:MDL] loadTextureToMaterialSlot completed for baseColor, mat.map:', mat.map);
                deferTextureApply(() => {
                    console.log('[MATERIALS:MDL] Applying baseColor texture, setting color to white, mat.map:', mat.map);
                    mat.color.setHex(0xffffff);
                    mat.needsUpdate = true;
                    console.log('[MATERIALS:MDL] After texture apply, mat.map:', mat.map, 'mat.color:', mat.color.getHexString());
                });
            } else {
                console.warn('[MATERIALS:MDL] Failed to resolve baseColor URL');
            }
        } else {
            console.log('[MATERIALS:MDL] No baseColor texture found');
        }

        // Normal map
        if (mdl.textures.normal) {
            const url = resolveAssetUrl(mdl.textures.normal);
            if (url) {
                await loadTextureToMaterialSlot({
                    mat,
                    slot: 'normalMap',
                    url,
                    debugName: 'MDL:normal',
                    configure: (t) => {
                        configureLinearTexture(t);
                        t.wrapS = THREE.RepeatWrapping;
                        t.wrapT = THREE.RepeatWrapping;
                    },
                });
            }
        }

        // ORM: Three uses G for roughness, B for metalness, R for AO.
        if (mdl.textures.orm) {
            const url = resolveAssetUrl(mdl.textures.orm);
            if (url) {
                const isUdim = url.includes('<UDIM>') || url.toLowerCase().includes('%3cudim%3e');
                if (isUdim) {
                    const set = await getOrLoadUdimTextureSet(url, (t) => {
                        configureLinearTexture(t);
                        t.wrapS = THREE.RepeatWrapping;
                        t.wrapT = THREE.RepeatWrapping;
                    });
                    if (set && set.tiles.length) {
                        deferTextureApply(() => {
                            mat.roughness = 1.0;
                            mat.metalness = 1.0;
                            // IMPORTANT: packed ORM (R=AO, G=Roughness, B=Metalness). Sample UDIM tiles once.
                            applyUdimPackedOrmSampling(mat, set, { debugName: 'MDL:ormPacked' });
                            mat.aoMapIntensity = 1.0;
                            mat.needsUpdate = true;
                        });
                    }
                } else {
                    const tex = await getOrLoadTextureClone(url, (t) => {
                        configureLinearTexture(t);
                        t.wrapS = THREE.RepeatWrapping;
                        t.wrapT = THREE.RepeatWrapping;
                    });
                    deferTextureApply(() => {
                        mat.roughness = 1.0;
                        mat.metalness = 1.0;
                        mat.roughnessMap = tex;
                        mat.metalnessMap = tex;
                        // NOTE: aoMap requires uv2; we patch geometry to alias uv->uv2 when present.
                        mat.aoMap = tex;
                        mat.aoMapIntensity = 1.0;
                        mat.needsUpdate = true;
                    });
                }
            }
        } else {
            // If no ORM, apply scalar constants if present.
            if (typeof mdl.constants.roughness === 'number') {
                console.log('[MATERIALS:MDL] Applying roughness constant:', mdl.constants.roughness);
                deferTextureApply(() => {
                    mat.roughness = THREE.MathUtils.clamp(mdl.constants.roughness!, 0, 1);
                    mat.needsUpdate = true;
                });
            }
            if (typeof mdl.constants.metallic === 'number') {
                console.log('[MATERIALS:MDL] Applying metallic constant:', mdl.constants.metallic);
                deferTextureApply(() => {
                    mat.metalness = THREE.MathUtils.clamp(mdl.constants.metallic!, 0, 1);
                    mat.needsUpdate = true;
                });
            }
        }
    })().catch(() => {
        // ignore (fallback material stays)
    });

    return mat;
}

// Used by DomeLight: attempt to extract an HDR/EXR from an MDL material module.
const envByMdlUrl = new Map<string, Promise<string | null>>();

export async function getMdlEnvironmentAsset(opts: {
    shader: SdfPrimSpec;
    resolveAssetUrl?: (assetPath: string) => string | null;
}): Promise<string | null> {
    const { shader, resolveAssetUrl } = opts;
    const mdlAsset = getAssetProp(shader, 'info:mdl:sourceAsset');
    const impl = getStringProp(shader, 'info:implementationSource');
    if (impl !== 'sourceAsset' || !mdlAsset) return null;

    const cached = envByMdlUrl.get(mdlAsset);
    if (cached) return await cached;

    const p = (async () => {
        const mdlText = await fetchMdlText(mdlAsset, resolveAssetUrl);
        const args = extractMdlTextureArgs(mdlText);
        const texCandidates = args.map((x) => resolveRelativeToMdlUrl(mdlAsset, x.path));
        const fileRe = /"([^"]+\.(?:exr|hdr))"/gi;
        let mm: RegExpExecArray | null;
        while ((mm = fileRe.exec(mdlText))) texCandidates.push(resolveRelativeToMdlUrl(mdlAsset, mm[1]!));
        const unique = Array.from(new Set(texCandidates));
        return extractEnvCandidate(unique) ?? null;
    })().catch(() => null);

    envByMdlUrl.set(mdlAsset, p);
    return await p;
}


