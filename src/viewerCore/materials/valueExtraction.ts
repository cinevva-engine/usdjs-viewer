/**
 * Utility functions for extracting values from USD property defaultValue objects.
 * 
 * The USD parser returns values in different formats:
 * - Tokens: `{ type: 'token', value: string }` or plain strings
 * - Colors/Vectors: `{ type: 'vec3f', value: number[] }` or `{ type: 'tuple', value: number[] }`
 * - Assets: `{ type: 'asset', value: string }` or `{ type: 'reference', assetPath: string }`
 * - Numbers: plain numbers
 * - Booleans: plain booleans or numbers (0/1)
 * 
 * These utilities handle all these formats consistently.
 */

import * as THREE from 'three';

/**
 * Extract a string value from a token property.
 * Handles both plain strings and `{ type: 'token', value: string }` objects.
 */
export function extractToken(dv: any): string | undefined {
    if (typeof dv === 'string') return dv;
    if (dv && typeof dv === 'object' && dv.type === 'token' && typeof dv.value === 'string') {
        return dv.value;
    }
    return undefined;
}

/**
 * Extract a THREE.Color from a color3f/vec3f property.
 * Handles:
 * - `{ type: 'tuple', value: number[] }`
 * - `{ type: 'vec3f', value: number[] | Float32Array }`
 * - Plain arrays
 */
export function extractColor3f(dv: any): THREE.Color | undefined {
    if (!dv || typeof dv !== 'object') return undefined;

    // Handle tuple or vec3f type
    if (dv.type === 'tuple' || dv.type === 'vec3f') {
        const tuple = dv.value;
        // Handle both regular arrays and typed arrays (Float32Array, etc.)
        if (tuple && typeof tuple.length === 'number' && tuple.length >= 3) {
            const r = tuple[0];
            const g = tuple[1];
            const b = tuple[2];
            if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number') {
                return new THREE.Color(r, g, b);
            }
        }
        return undefined;
    }

    // Handle raw array format
    if (dv && typeof dv.length === 'number' && dv.length >= 3) {
        const r = dv[0];
        const g = dv[1];
        const b = dv[2];
        if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number') {
            return new THREE.Color(r, g, b);
        }
    }

    return undefined;
}

/**
 * Extract a number from a float property.
 */
export function extractFloat(dv: any): number | undefined {
    if (typeof dv === 'number') return dv;
    return undefined;
}

/**
 * Extract a boolean from a bool property.
 * Handles both booleans and numbers (0 = false, non-0 = true).
 */
export function extractBool(dv: any): boolean | undefined {
    if (typeof dv === 'boolean') return dv;
    if (typeof dv === 'number') return dv !== 0;
    return undefined;
}

/**
 * Extract an asset path from an asset property.
 * Handles:
 * - Plain strings
 * - `{ type: 'asset', value: string }`
 * - `{ type: 'reference', assetPath: string }`
 * 
 * Returns both the asset path and the fromIdentifier (if present) for relative path resolution.
 */
export function extractAssetPath(dv: any): { path: string; fromIdentifier: string | null } | undefined {
    const stripCorpusPrefix = (v: string): string => 
        v.startsWith('[corpus]') ? v.replace('[corpus]', '') : v;

    if (typeof dv === 'string') {
        return { path: stripCorpusPrefix(dv), fromIdentifier: null };
    }
    
    if (dv && typeof dv === 'object' && dv.type === 'asset' && typeof dv.value === 'string') {
        const fromId = typeof dv.__fromIdentifier === 'string' ? stripCorpusPrefix(dv.__fromIdentifier) : null;
        return { path: stripCorpusPrefix(dv.value), fromIdentifier: fromId };
    }
    
    // usdjs may parse `@path@`-style authored values as a 'reference' SdfValue
    if (dv && typeof dv === 'object' && dv.type === 'reference' && typeof dv.assetPath === 'string') {
        const fromId = typeof dv.__fromIdentifier === 'string' ? stripCorpusPrefix(dv.__fromIdentifier) : null;
        return { path: stripCorpusPrefix(dv.assetPath), fromIdentifier: fromId };
    }
    
    return undefined;
}

/**
 * Extract an SdfPath value from a path property.
 * Handles:
 * - Plain strings
 * - `{ type: 'sdfpath', value: string }`
 */
export function extractSdfPath(dv: any): string | undefined {
    if (typeof dv === 'string') return dv;
    if (dv && typeof dv === 'object' && dv.type === 'sdfpath' && typeof dv.value === 'string') {
        return dv.value;
    }
    return undefined;
}

export type AssetInfo = { path: string; fromIdentifier: string | null };

/**
 * Create property getter functions for a shader prim.
 * Returns a set of typed getters that handle all USD value formats.
 */
export function createPropertyGetters(shader: { properties?: Map<string, { defaultValue?: any }> }) {
    const getProperty = (name: string) => shader.properties?.get(name);
    const getDefaultValue = (name: string) => getProperty(name)?.defaultValue;

    return {
        getToken: (name: string): string | undefined => extractToken(getDefaultValue(name)),
        getColor3f: (name: string): THREE.Color | undefined => extractColor3f(getDefaultValue(name)),
        getFloat: (name: string): number | undefined => extractFloat(getDefaultValue(name)),
        getBool: (name: string): boolean | undefined => extractBool(getDefaultValue(name)),
        /** Returns asset path and fromIdentifier for relative path resolution */
        getAssetPath: (name: string): AssetInfo | undefined => extractAssetPath(getDefaultValue(name)),
        getSdfPath: (name: string): string | undefined => extractSdfPath(getDefaultValue(name)),
        getProperty,
        getDefaultValue,
    };
}


