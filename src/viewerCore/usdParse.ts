import type { SdfValue } from '@cinevva/usdjs';

export function parseNumberArray(v: SdfValue | undefined): number[] | null {
    if (!v || typeof v !== 'object' || v.type !== 'array') return null;
    const out: number[] = [];
    for (const el of v.value) {
        if (typeof el === 'number') out.push(el);
    }
    return out.length ? out : null;
}

export function parsePoint3ArrayToFloat32(v: SdfValue | undefined): Float32Array | null {
    if (!v || typeof v !== 'object' || v.type !== 'array') return null;
    const pts = v.value;
    const arr = new Float32Array(pts.length * 3);
    let w = 0;
    for (const el of pts) {
        if (!el || typeof el !== 'object') return null;
        // Our parser may represent point3f elements as either:
        // - { type: 'tuple', value: [x,y,z] }
        // - { type: 'vec3f', value: [x,y,z] }
        // Accept both to avoid silently dropping geometry.
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
    if (!v || typeof v !== 'object' || v.type !== 'array') return null;
    const pts = v.value;
    const arr = new Float32Array(pts.length * 3);
    let w = 0;
    for (const el of pts) {
        if (!el || typeof el !== 'object') return null;
        // Similar to points, tuple3 arrays may be represented as tuple or vec3f.
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

export function getPropMetadataString(prop: { metadata?: Record<string, SdfValue> } | undefined, key: string): string | null {
    const v = prop?.metadata?.[key];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && v.type === 'token') return v.value;
    return null;
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


