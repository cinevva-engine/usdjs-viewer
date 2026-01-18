import * as THREE from 'three';

import type { UdimTextureSet } from '../textureCache';

function isWebgl1LikeDynamicSamplerIndexingProblem(): boolean {
    // We avoid sampler array indexing entirely (use if/else chain), so this is always safe.
    return false;
}

function wrapOnBeforeCompile(mat: THREE.Material, fn: (shader: any) => void) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader: any, renderer: any) => {
        try {
            // Some materials expect `this` to be bound to the material.
            prev?.call(mat as any, shader, renderer);
        } finally {
            fn(shader);
        }
    };
}

/**
 * Patch a MeshStandardMaterial's albedo `map` sampling to correctly sample UDIM tiles.
 *
 * Requirements:
 * - `mat.map` should be set (to any tile) so Three defines USE_MAP and provides vMapUv.
 * - `set.tiles` must contain loaded textures for each UDIM id.
 *
 * Implementation:
 * - Inject N sampler2D uniforms (one per tile).
 * - Replace `<map_fragment>` with code that:
 *   - computes udim from uv tile (floor)
 *   - samples correct tile with fract(uv)
 *   - falls back to tile 1001 if missing
 */
export function applyUdimMapSampling(
    mat: THREE.MeshStandardMaterial,
    set: UdimTextureSet,
    opts?: { debugName?: string },
) {
    applyUdimTextureSampling(mat, 'map', set, opts);
}

/**
 * Patch a MeshStandardMaterial to sample a *packed* ORM UDIM texture set once, and use it for:
 * - `roughnessMap` (G)
 * - `metalnessMap` (B)
 * - `aoMap` (R)
 *
 * This avoids allocating separate UDIM sampler uniforms per channel, which can easily exceed
 * WebGL's MAX_TEXTURE_IMAGE_UNITS(16) on real scenes (env/shadow/light maps also consume units).
 */
export function applyUdimPackedOrmSampling(
    mat: THREE.MeshStandardMaterial,
    set: UdimTextureSet,
    opts?: { debugName?: string },
) {
    if (!set.tiles.length) return;

    // Enable relevant USE_* defines + UV varyings by assigning something to the slots.
    // We'll *not* sample these built-in uniforms in our injected code, so GLSL should
    // optimize them away (leaving only the UDIM tile samplers).
    (mat as any).roughnessMap = set.tiles[0]!.tex;
    (mat as any).metalnessMap = set.tiles[0]!.tex;
    (mat as any).aoMap = set.tiles[0]!.tex;

    const tileKey = set.tiles.map((t) => t.udim).join(',');
    const key = `udim:ormPacked:${tileKey}`;
    const prevKeyFn = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () => `${prevKeyFn ? prevKeyFn.call(mat as any) : 'std'}|${key}`;

    wrapOnBeforeCompile(mat, (shader) => {
        const fnName = makeUdimSamplerWithId(shader, 'orm', set).fnName;

        const roughCfg = slotConfig('roughnessMap');
        const metalCfg = slotConfig('metalnessMap');
        const aoCfg = slotConfig('aoMap');

        shader.fragmentShader = shader.fragmentShader.replace(roughCfg.include, roughCfg.replacement(fnName));
        shader.fragmentShader = shader.fragmentShader.replace(metalCfg.include, metalCfg.replacement(fnName));
        shader.fragmentShader = shader.fragmentShader.replace(aoCfg.include, aoCfg.replacement(fnName));

        if (opts?.debugName) (mat.userData as any).__usdjsUdimDebugName = opts.debugName;
    });

    mat.needsUpdate = true;
}

export type UdimMaterialSlot =
    | 'map'
    | 'emissiveMap'
    | 'normalMap'
    | 'roughnessMap'
    | 'metalnessMap'
    | 'aoMap'
    | 'alphaMap';

function slotConfig(slot: UdimMaterialSlot): {
    include: string;
    uvVar: string;
    replacement: (sampleFn: string) => string;
} {
    switch (slot) {
        case 'map':
            return {
                include: '#include <map_fragment>',
                uvVar: 'vMapUv',
                replacement: (fn) => `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = ${fn}( ${'vMapUv'} );
  diffuseColor *= sampledDiffuseColor;
#endif
`,
            };
        case 'emissiveMap':
            return {
                include: '#include <emissivemap_fragment>',
                uvVar: 'vEmissiveMapUv',
                replacement: (fn) => `
#ifdef USE_EMISSIVEMAP
  vec4 emissiveColor = ${fn}( vEmissiveMapUv );
  #ifdef DECODE_VIDEO_TEXTURE_EMISSIVE
    emissiveColor = sRGBTransferEOTF( emissiveColor );
  #endif
  totalEmissiveRadiance *= emissiveColor.rgb;
#endif
`,
            };
        case 'normalMap':
            return {
                include: '#include <normal_fragment_maps>',
                uvVar: 'vNormalMapUv',
                replacement: (fn) => `
#ifdef USE_NORMALMAP_OBJECTSPACE
  normal = ${fn}( vNormalMapUv ).xyz * 2.0 - 1.0; // overrides both flatShading and attribute normals
  #ifdef FLIP_SIDED
    normal = - normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
  vec3 mapN = ${fn}( vNormalMapUv ).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale;
  normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
  normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif
`,
            };
        case 'roughnessMap':
            return {
                include: '#include <roughnessmap_fragment>',
                uvVar: 'vRoughnessMapUv',
                replacement: (fn) => `
float roughnessFactor = roughness;

#ifdef USE_ROUGHNESSMAP
  vec4 texelRoughness = ${fn}( vRoughnessMapUv );
  // reads channel G, compatible with a combined OcclusionRoughnessMetallic (RGB) texture
  roughnessFactor *= texelRoughness.g;
#endif
`,
            };
        case 'metalnessMap':
            return {
                include: '#include <metalnessmap_fragment>',
                uvVar: 'vMetalnessMapUv',
                replacement: (fn) => `
float metalnessFactor = metalness;

#ifdef USE_METALNESSMAP
  vec4 texelMetalness = ${fn}( vMetalnessMapUv );
  // reads channel B, compatible with a combined OcclusionRoughnessMetallic (RGB) texture
  metalnessFactor *= texelMetalness.b;
#endif
`,
            };
        case 'aoMap':
            return {
                include: '#include <aomap_fragment>',
                uvVar: 'vAoMapUv',
                replacement: (fn) => `
#ifdef USE_AOMAP
  // reads channel R, compatible with a combined OcclusionRoughnessMetallic (RGB) texture
  float ambientOcclusion = ( ${fn}( vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
  #if defined( USE_CLEARCOAT )
    clearcoatSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_SHEEN )
    sheenSpecularIndirect *= ambientOcclusion;
  #endif
  #if defined( USE_ENVMAP ) && defined( STANDARD )
    float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
  #endif
#endif
`,
            };
        case 'alphaMap':
            return {
                include: '#include <alphamap_fragment>',
                uvVar: 'vAlphaMapUv',
                replacement: (fn) => `
#ifdef USE_ALPHAMAP
  diffuseColor.a *= ${fn}( vAlphaMapUv ).g;
#endif
`,
            };
    }
}

export function injectUdimSamplerFunction(
    shader: any,
    slot: UdimMaterialSlot,
    set: UdimTextureSet,
): string {
    return makeUdimSampler(shader, slot, set).fnName;
}

function makeUdimSampler(
    shader: any,
    slot: UdimMaterialSlot,
    set: UdimTextureSet,
): { fnName: string } {
    return makeUdimSamplerWithId(shader, slot, set);
}

function makeUdimSamplerWithId(
    shader: any,
    id: string,
    set: UdimTextureSet,
): { fnName: string } {
    const safeId = id.replace(/[^A-Za-z0-9_]/g, '_');
    const fnName = `usdjsSampleUdim_${safeId}`;
    const uniformPrefix = `usdjsUdim_${safeId}_`;

    // Add uniforms
    for (const t of set.tiles) {
        const uname = `${uniformPrefix}${t.udim}`;
        (shader.uniforms as any)[uname] = { value: t.tex };
    }

    const samplerDecl = set.tiles.map((t) => `uniform sampler2D ${uniformPrefix}${t.udim};`).join('\n');
    const fallbackUdim = set.tiles[0]!.udim;
    const ifChain = set.tiles
        .map((t, i) => {
            const cond = `tile == ${t.udim}`;
            const stmt = `return texture2D( ${uniformPrefix}${t.udim}, uvLocal );`;
            return i === 0 ? `if (${cond}) { ${stmt} }` : `else if (${cond}) { ${stmt} }`;
        })
        .join('\n');

    const udimFn = `
${samplerDecl}

vec4 ${fnName}(vec2 uv) {
  int u = int(floor(uv.x));
  int v = int(floor(uv.y));
  int tile = 1001 + u + 10 * v;
  vec2 uvLocal = fract(uv);
  ${ifChain}
  return texture2D( ${uniformPrefix}${fallbackUdim}, uvLocal );
}
`;

    if (!shader.fragmentShader.includes(fnName)) {
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>\n${udimFn}\n`);
    }
    return { fnName };
}

export function applyUdimTextureSampling(
    mat: THREE.MeshStandardMaterial,
    slot: UdimMaterialSlot,
    set: UdimTextureSet,
    opts?: { debugName?: string },
) {
    if (!set.tiles.length) return;
    if (isWebgl1LikeDynamicSamplerIndexingProblem()) {
        // no-op (kept for future)
    }

    // Ensure the corresponding USE_* define is enabled by assigning the slot texture.
    // Three will create the appropriate UV varyings automatically.
    (mat as any)[slot] = set.tiles[0]!.tex;

    const key = `udim:${slot}:${set.tiles.map((t) => t.udim).join(',')}`;
    const prevKeyFn = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () => `${prevKeyFn ? prevKeyFn.call(mat as any) : 'std'}|${key}`;

    wrapOnBeforeCompile(mat, (shader) => {
        const fnName = injectUdimSamplerFunction(shader, slot, set);
        const cfg = slotConfig(slot);
        shader.fragmentShader = shader.fragmentShader.replace(cfg.include, cfg.replacement(fnName));
        if (opts?.debugName) (mat.userData as any).__usdjsUdimDebugName = opts.debugName;
    });

    mat.needsUpdate = true;
}


