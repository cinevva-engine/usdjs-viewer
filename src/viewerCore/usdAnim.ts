import type { SdfPrimSpec, SdfValue } from '@cinevva/usdjs';

export function sdfToNumberTuple(v: SdfValue | undefined, n: number): number[] | null {
    if (!v || typeof v !== 'object') return null;
    // USD values can arrive in multiple representations depending on parser + authored type:
    // - `{ type: 'tuple', value: number[] }` (common)
    // - `{ type: 'vec2f'|'vec3f'|'vec4f', value: number[] }` (common for xform ops in USDA)
    // - `{ type: 'typedArray', value: Float32Array/Float64Array/... }` (packed USDC)
    const t = (v as any).type;
    const raw = (v as any).value;

    // Typed arrays
    if (t === 'typedArray' && raw && typeof raw.length === 'number') {
        if (raw.length !== n) return null;
        const out = new Array<number>(n);
        for (let i = 0; i < n; i++) out[i] = typeof raw[i] === 'number' ? raw[i] : 0;
        return out;
    }

    // tuple / vec*f
    if (t === 'tuple' || (typeof t === 'string' && t.startsWith('vec'))) {
        if (!raw || typeof raw.length !== 'number' || raw.length !== n) return null;
        const out = new Array<number>(n);
        for (let i = 0; i < n; i++) out[i] = typeof raw[i] === 'number' ? raw[i] : 0;
        return out;
    }

    return null;
}

export function getPrimProp(prim: SdfPrimSpec, name: string): SdfValue | undefined {
    return prim.properties?.get(name)?.defaultValue;
}

/**
 * Get a property value at a specific time, with linear interpolation between keyframes.
 * Falls back to defaultValue if no timeSamples exist.
 */
export function getPrimPropAtTime(prim: SdfPrimSpec, name: string, time: number): SdfValue | undefined {
    const prop = prim.properties?.get(name);
    if (!prop) return undefined;

    const timeSamples = prop.timeSamples;
    if (!timeSamples || timeSamples.size === 0) {
        return prop.defaultValue;
    }

    // Get sorted time keys
    const times = Array.from(timeSamples.keys()).sort((a, b) => a - b);

    // Handle edge cases
    if (time <= times[0]!) return timeSamples.get(times[0]!);
    if (time >= times[times.length - 1]!) return timeSamples.get(times[times.length - 1]!);

    // Find surrounding keyframes
    let lowerIdx = 0;
    for (let i = 0; i < times.length - 1; i++) {
        if (times[i]! <= time && time < times[i + 1]!) {
            lowerIdx = i;
            break;
        }
    }

    const t0 = times[lowerIdx]!;
    const t1 = times[lowerIdx + 1]!;
    const v0 = timeSamples.get(t0);
    const v1 = timeSamples.get(t1);

    // Calculate interpolation factor
    const alpha = (time - t0) / (t1 - t0);

    return interpolateSdfValue(v0, v1, alpha);
}

/**
 * Linear interpolation between two SdfValues.
 * Currently supports tuples (vec3, etc.) and numbers.
 */
export function interpolateSdfValue(v0: SdfValue | undefined, v1: SdfValue | undefined, alpha: number): SdfValue | undefined {
    if (v0 === undefined || v1 === undefined) return v0;

    // Interpolate numbers
    if (typeof v0 === 'number' && typeof v1 === 'number') {
        return v0 + (v1 - v0) * alpha;
    }

    // Interpolate tuples (vec3, vec4, etc.)
    if (
        typeof v0 === 'object' && v0?.type === 'tuple' &&
        typeof v1 === 'object' && v1?.type === 'tuple' &&
        Array.isArray(v0.value) && Array.isArray(v1.value) &&
        v0.value.length === v1.value.length
    ) {
        const interpolated = v0.value.map((val, i) => {
            const a = typeof val === 'number' ? val : 0;
            const b = typeof v1.value[i] === 'number' ? v1.value[i] : 0;
            return a + (b - a) * alpha;
        });
        return { type: 'tuple', value: interpolated };
    }

    // For non-interpolatable types, use step interpolation (return v0 until we reach t1)
    return alpha < 1 ? v0 : v1;
}

/**
 * Check if a property has animation (timeSamples)
 */
export function propHasAnimation(prim: SdfPrimSpec, name: string): boolean {
    const prop = prim.properties?.get(name);
    return !!(prop?.timeSamples && prop.timeSamples.size > 0);
}

export function primHasAnimatedPoints(prim: SdfPrimSpec): boolean {
    return propHasAnimation(prim, 'points');
}

/**
 * Get the time range of all animated properties in a prim
 */
export function getPrimAnimationTimeRange(prim: SdfPrimSpec): { start: number; end: number } | null {
    let minTime = Infinity;
    let maxTime = -Infinity;
    let hasAnimation = false;

    if (prim.properties) {
        for (const prop of prim.properties.values()) {
            if (prop.timeSamples && prop.timeSamples.size > 0) {
                hasAnimation = true;
                for (const time of prop.timeSamples.keys()) {
                    minTime = Math.min(minTime, time);
                    maxTime = Math.max(maxTime, time);
                }
            }
        }
    }

    return hasAnimation ? { start: minTime, end: maxTime } : null;
}


