import type { SdfValue } from '@cinevva/usdjs';
import { extractToken } from './materials/valueExtraction';

export type NumberArrayLike = ArrayLike<number> & Iterable<number>;

function isTypedNumberArrayValue(a: any): a is Float32Array | Float64Array | Int32Array | Uint32Array {
    return a instanceof Float32Array || a instanceof Float64Array || a instanceof Int32Array || a instanceof Uint32Array;
}

export function parseNumberArray(v: SdfValue | undefined): NumberArrayLike | null {
    if (!v || typeof v !== 'object') return null;
    if (v.type === 'typedArray' && isTypedNumberArrayValue((v as any).value)) {
        return (v as any).value as NumberArrayLike;
    }
    if (v.type !== 'array') return null;
    // For non-packed arrays: coerce non-numbers to 0 to keep array length stable.
    const src = (v as any).value as unknown[];
    if (src.length === 0) return null;
    const out = new Array<number>(src.length);
    for (let i = 0; i < src.length; i++) out[i] = typeof src[i] === 'number' ? (src[i] as number) : 0;
    return out;
}

export function parsePoint3ArrayToFloat32(v: SdfValue | undefined): Float32Array | null {
    if (!v || typeof v !== 'object') return null;
    // Fast path: packed typed array from parser (flat xyzxyz...)
    if ((v as any).type === 'typedArray') {
        const elType = (v as any).elementType;
        const data = (v as any).value;
        if ((elType === 'point3f' || elType === 'vector3f' || elType === 'normal3f' || elType === 'color3f') && data instanceof Float32Array) {
            // Return a copy so callers can scale/mutate without mutating stage data.
            return data.slice();
        }
    }
    if (v.type !== 'array') return null;
    const pts = (v as any).value as unknown[];
    const arr = new Float32Array(pts.length * 3);
    let w = 0;
    for (const el of pts) {
        if (!el || typeof el !== 'object') return null;
        let x: any, y: any, z: any;
        if ((el as any).type === 'tuple') {
            [x, y, z] = (el as any).value ?? [];
        } else if ((el as any).type === 'vec3f') {
            [x, y, z] = (el as any).value ?? [];
        } else {
            return null;
        }
        if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
        arr[w++] = x;
        arr[w++] = y;
        arr[w++] = z;
    }
    return arr;
}

export function parseTuple3ArrayToFloat32(v: SdfValue | undefined): Float32Array | null {
    // For arrays of tuples with 3 numeric components (e.g. color3f[], normal3f[]).
    if (!v || typeof v !== 'object') return null;
    if ((v as any).type === 'typedArray') {
        const elType = (v as any).elementType;
        const data = (v as any).value;
        // Packed arrays may use elementType like `point3f`, `normal3f`, `vec3f`, or sometimes `float3`.
        // Accept both `*3f` and `*3` when the underlying storage is Float32Array.
        if (data instanceof Float32Array && elType) {
            const t = String(elType);
            if (t.endsWith('3f') || t.endsWith('3')) return data.slice();
        }
    }
    if (v.type !== 'array') return null;
    const pts = (v as any).value as unknown[];
    const arr = new Float32Array(pts.length * 3);
    let w = 0;
    for (const el of pts) {
        if (!el || typeof el !== 'object') return null;
        let x: any, y: any, z: any;
        if ((el as any).type === 'tuple') {
            [x, y, z] = (el as any).value ?? [];
        } else if ((el as any).type === 'vec3f') {
            [x, y, z] = (el as any).value ?? [];
        } else {
            return null;
        }
        if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
        arr[w++] = x;
        arr[w++] = y;
        arr[w++] = z;
    }
    return arr;
}

export function parseTuple2ArrayToFloat32(v: SdfValue | undefined): Float32Array | null {
    // For arrays of tuples with 2 numeric components (e.g. texCoord2f[]).
    if (!v || typeof v !== 'object') return null;
    if ((v as any).type === 'typedArray') {
        const elType = (v as any).elementType;
        const data = (v as any).value;
        // Packed arrays may use elementType like `texCoord2f`, `vec2f`, or sometimes `float2`.
        // Accept both `*2f` and `*2` when the underlying storage is Float32Array.
        if (data instanceof Float32Array && elType) {
            const t = String(elType);
            if (t.endsWith('2f') || t.endsWith('2')) return data.slice();
        }
    }
    if (v.type !== 'array') return null;
    const pts = (v as any).value as unknown[];
    const arr = new Float32Array(pts.length * 2);
    let w = 0;
    for (const el of pts) {
        if (!el || typeof el !== 'object') return null;
        let x: any, y: any;
        if ((el as any).type === 'tuple') {
            [x, y] = (el as any).value ?? [];
        } else if ((el as any).type === 'vec2f') {
            [x, y] = (el as any).value ?? [];
        } else {
            return null;
        }
        if (typeof x !== 'number' || typeof y !== 'number') return null;
        arr[w++] = x;
        arr[w++] = y;
    }
    return arr;
}

export function getPropMetadataString(prop: { metadata?: Record<string, SdfValue> } | undefined, key: string): string | null {
    const v = prop?.metadata?.[key];
    return extractToken(v) ?? null;
}

export function getPropMetadataNumber(prop: { metadata?: Record<string, SdfValue> } | undefined, key: string): number | null {
    const v = prop?.metadata?.[key];
    if (typeof v === 'number') return v;
    return null;
}

export function extractAssetStrings(v: any): string[] {
    if (!v) return [];
    if (typeof v === 'object' && v.type === 'asset') return [v.value];
    // Handle references with target paths: @./file.usd@</Target>
    if (typeof v === 'object' && v.type === 'reference') return [v.assetPath];
    if (typeof v === 'object' && v.type === 'array') {
        return v.value.flatMap((x: any) => {
            if (x && typeof x === 'object' && x.type === 'asset') return [x.value];
            if (x && typeof x === 'object' && x.type === 'reference') return [x.assetPath];
            return [];
        });
    }
    if (typeof v === 'object' && v.type === 'dict' && v.value && typeof v.value === 'object' && 'value' in v.value) {
        return extractAssetStrings((v.value as any).value);
    }
    return [];
}


