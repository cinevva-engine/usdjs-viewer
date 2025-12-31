import * as THREE from 'three';

import type { GpuResourcesInfo } from './types';
import { listTextureCacheEntries, getTextureUrlFromCache } from './textureCache';

function safeByteLength(arr: any): number {
    try {
        const n = arr?.byteLength;
        return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
    } catch {
        return 0;
    }
}

function getTextureSourceUrl(tex: THREE.Texture): string | null {
    const img: any = (tex as any).image;
    
    // First, try to get URL from texture cache (works for cached textures)
    const cacheUrl = getTextureUrlFromCache(tex);
    if (cacheUrl) return cacheUrl;
    
    if (!img) return null;

    // HTMLImageElement has src property
    if (typeof img.src === 'string' && img.src.length) {
        return img.src;
    }

    // HTMLCanvasElement - prefer cache URL, but can convert to data URL as fallback
    if (img instanceof HTMLCanvasElement) {
        // Data URL is less useful but better than nothing
        try {
            return img.toDataURL('image/png');
        } catch {
            // Security error if canvas is tainted
            return null;
        }
    }

    // ImageBitmap - no src property, rely on cache lookup (already tried above)
    // Could convert to data URL, but that's expensive and not very useful
    return null;
}

function estimateTextureBytes(tex: THREE.Texture): { width: number | null; height: number | null; estimatedBytes: number | null } {
    const img: any = (tex as any).image;
    const w = typeof img?.width === 'number' ? img.width : null;
    const h = typeof img?.height === 'number' ? img.height : null;

    // If we have a typed array (DataTexture / DataArrayTexture / etc), prefer its real size.
    const data = img?.data;
    const dataBytes = safeByteLength(data);
    if (dataBytes > 0) {
        return { width: w, height: h, estimatedBytes: dataBytes };
    }

    // Fallback heuristic for common 8-bit RGBA textures.
    if (w && h) {
        const bpp = 4; // assume RGBA8
        return { width: w, height: h, estimatedBytes: w * h * bpp };
    }
    return { width: w, height: h, estimatedBytes: null };
}

// Common texture map names in Three.js materials (same as threeSceneTree.ts)
const TEXTURE_MAP_NAMES = [
    'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
    'aoMap', 'bumpMap', 'displacementMap', 'alphaMap', 'envMap',
    'lightMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap',
    'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
    'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap',
    'anisotropyMap',
];

function extractFilenameFromUrl(url: string | null): string | null {
    if (!url) return null;
    try {
        // Decode proxy/corpus URLs first
        let decoded = url;
        try {
            const u = new URL(url, 'http://local/');
            if (u.pathname.includes('/__usdjs_proxy')) {
                const inner = u.searchParams.get('url');
                if (inner) decoded = decodeURIComponent(inner);
            } else if (u.pathname.includes('/__usdjs_corpus')) {
                const file = u.searchParams.get('file');
                if (file) decoded = decodeURIComponent(file);
            }
        } catch {
            // If URL parsing fails, use original
        }
        
        // Extract filename from path
        const pathParts = decoded.split('/').filter(Boolean);
        if (pathParts.length > 0) {
            const filename = pathParts[pathParts.length - 1];
            // Remove query params and hash
            const clean = filename.split('?')[0]?.split('#')[0];
            if (clean && clean.length > 0) return clean;
        }
    } catch {
        // ignore
    }
    return null;
}

function collectSceneTextures(scene: THREE.Scene): {
    textures: Set<THREE.Texture>;
    textureUsage: Map<string, { mapName: string; materialName: string }[]>;
} {
    const textures = new Set<THREE.Texture>();
    const textureUsage = new Map<string, { mapName: string; materialName: string }[]>();
    
    const add = (t: any, mapName?: string, materialName?: string) => {
        if (t && t.isTexture) {
            textures.add(t as THREE.Texture);
            if (mapName && materialName) {
                const uuid = (t as THREE.Texture).uuid;
                if (!textureUsage.has(uuid)) {
                    textureUsage.set(uuid, []);
                }
                textureUsage.get(uuid)!.push({ mapName, materialName });
            }
        }
    };

    const bg: any = (scene as any).background;
    const env: any = (scene as any).environment;
    add(bg, 'background', 'Scene');
    add(env, 'environment', 'Scene');

    scene.traverse((o: any) => {
        const mats = o?.material;
        const arr = Array.isArray(mats) ? mats : mats ? [mats] : [];
        for (const m of arr) {
            if (!m) continue;
            const materialName = m.name?.trim() || m.type || 'Material';
            
            // Check known texture map properties first
            for (const mapName of TEXTURE_MAP_NAMES) {
                const tex = (m as any)[mapName];
                if (tex && tex.isTexture) {
                    add(tex, mapName, materialName);
                }
            }
            
            // Also scan other enumerable properties for any Texture instances we might have missed
            for (const k of Object.keys(m)) {
                if (!TEXTURE_MAP_NAMES.includes(k)) {
                    const tex = (m as any)[k];
                    if (tex && tex.isTexture) {
                        add(tex, k, materialName);
                    }
                }
            }
        }
    });

    return { textures, textureUsage };
}

function collectSceneGeometries(scene: THREE.Scene): {
    geometries: Set<THREE.BufferGeometry>;
    geometryUsage: Map<string, { objectName: string; objectType: string }[]>;
} {
    const geometries = new Set<THREE.BufferGeometry>();
    const geometryUsage = new Map<string, { objectName: string; objectType: string }[]>();
    
    scene.traverse((o: any) => {
        const g = o?.geometry;
        if (g && g.isBufferGeometry) {
            geometries.add(g as THREE.BufferGeometry);
            
            // Track which objects use this geometry
            const uuid = g.uuid;
            if (!geometryUsage.has(uuid)) {
                geometryUsage.set(uuid, []);
            }
            const objectName = o.name?.trim() || '(unnamed)';
            const objectType = (o as any)?.type || 'Object3D';
            geometryUsage.get(uuid)!.push({ objectName, objectType });
        }
    });
    
    return { geometries, geometryUsage };
}

export function getGpuResourcesInfo(opts: { renderer: THREE.WebGLRenderer; scene: THREE.Scene }): GpuResourcesInfo {
    const { renderer, scene } = opts;

    const info: any = (renderer as any).info ?? {};
    const mem: any = info.memory ?? {};
    const r: any = info.render ?? {};
    const programsRaw: any = info.programs;
    const programs = Array.isArray(programsRaw) ? programsRaw.length : null;

    const { textures: texturesSet, textureUsage } = collectSceneTextures(scene);
    const texturesList: GpuResourcesInfo['textures']['list'] = [];
    let texBytesTotal = 0;
    
    // Build a map of cache entries by texture UUID for name resolution
    const cacheEntries = listTextureCacheEntries();
    const cacheByUuid = new Map<string, typeof cacheEntries[0]>();
    // Note: We can't directly map cache entries to textures by UUID, but we can match by dimensions/URL
    
    for (const t of texturesSet) {
        const est = estimateTextureBytes(t);
        if (typeof est.estimatedBytes === 'number') texBytesTotal += est.estimatedBytes;
        
        const sourceUrl = getTextureSourceUrl(t);
        
        // Resolve name with fallbacks:
        // 1. Explicit texture.name
        // 2. Material property name (mapName) from usage
        // 3. Filename from URL
        // 4. "(unnamed)"
        let resolvedName = t.name?.trim();
        
        if (!resolvedName || resolvedName.length === 0) {
            // Try to get name from material usage
            const usage = textureUsage.get(t.uuid);
            if (usage && usage.length > 0) {
                // Use the first mapName, or combine if multiple
                const mapNames = [...new Set(usage.map(u => u.mapName))];
                resolvedName = mapNames.length === 1 
                    ? mapNames[0]!
                    : mapNames.join(', ');
            }
        }
        
        if (!resolvedName || resolvedName.length === 0) {
            // Try filename from URL
            const filename = extractFilenameFromUrl(sourceUrl);
            if (filename) {
                resolvedName = filename;
            }
        }
        
        texturesList.push({
            uuid: t.uuid,
            name: resolvedName || '(unnamed)',
            width: est.width,
            height: est.height,
            estimatedBytes: est.estimatedBytes,
            sourceUrl,
        });
    }
    texturesList.sort((a, b) => (b.estimatedBytes ?? 0) - (a.estimatedBytes ?? 0));

    const { geometries: geomsSet, geometryUsage } = collectSceneGeometries(scene);
    const geomList: GpuResourcesInfo['geometries']['list'] = [];
    let geomBytesTotal = 0;
    for (const g of geomsSet) {
        const attrs: any = (g as any).attributes ?? {};
        let attributesBytes = 0;
        for (const name of Object.keys(attrs)) {
            const a = attrs[name];
            attributesBytes += safeByteLength(a?.array);
        }
        const indexBytes = safeByteLength((g as any).index?.array);
        const totalBytes = attributesBytes + indexBytes;
        geomBytesTotal += totalBytes;
        
        // Resolve name with fallbacks:
        // 1. Explicit geometry.name
        // 2. Parent object name(s) that use this geometry
        // 3. "(unnamed)"
        let resolvedName = g.name?.trim();
        
        if (!resolvedName || resolvedName.length === 0) {
            const usage = geometryUsage.get(g.uuid);
            if (usage && usage.length > 0) {
                // Use the first object name, or combine if multiple
                const objectNames = [...new Set(usage.map(u => u.objectName))];
                resolvedName = objectNames.length === 1
                    ? objectNames[0]!
                    : objectNames.join(', ');
            }
        }
        
        geomList.push({
            uuid: g.uuid,
            name: resolvedName || '(unnamed)',
            attributesBytes,
            indexBytes,
            totalBytes,
        });
    }
    geomList.sort((a, b) => b.totalBytes - a.totalBytes);

    return {
        renderer: {
            memory: {
                textures: typeof mem.textures === 'number' ? mem.textures : 0,
                geometries: typeof mem.geometries === 'number' ? mem.geometries : 0,
            },
            render: {
                calls: typeof r.calls === 'number' ? r.calls : 0,
                triangles: typeof r.triangles === 'number' ? r.triangles : 0,
                points: typeof r.points === 'number' ? r.points : 0,
                lines: typeof r.lines === 'number' ? r.lines : 0,
            },
            programs,
        },
        textures: {
            totalUnique: texturesSet.size,
            totalEstimatedBytes: texBytesTotal,
            list: texturesList,
        },
        geometries: {
            totalUnique: geomsSet.size,
            totalBytes: geomBytesTotal,
            list: geomList,
        },
        textureCache: {
            entries: listTextureCacheEntries(),
        },
    };
}


