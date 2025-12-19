import type { SdfPrimSpec } from '@cinevva/usdjs';

export function resolvePointInstancerPrototypePaths(opts: {
    prim: SdfPrimSpec;
    primPath: string;
}): string[] {
    const { prim, primPath } = opts;

    // Resolve prototypes relationship. USD allows `rel prototypes = <path>` (single) or `rel prototypes = [<path>, ...]` (array).
    const prototypesProp = prim.properties?.get('prototypes');
    const prototypesDv: any = prototypesProp?.defaultValue;
    let prototypePaths: string[] = [];
    if (prototypesDv) {
        if (typeof prototypesDv === 'object' && prototypesDv.type === 'sdfpath' && typeof prototypesDv.value === 'string') {
            prototypePaths = [prototypesDv.value];
        } else if (typeof prototypesDv === 'object' && prototypesDv.type === 'array') {
            for (const el of prototypesDv.value) {
                if (el && typeof el === 'object' && el.type === 'sdfpath' && typeof el.value === 'string') {
                    prototypePaths.push(el.value);
                }
            }
        }
    }

    if (prototypePaths.length === 0) {
        // Fallback: look for prototype children directly under the PointInstancer prim.
        // In the sample, `asset` is a child of the PointInstancer.
        if (prim.children) {
            for (const [name, child] of prim.children) {
                // Build absolute path from root.
                const absPath = primPath === '/' ? '/' + name : primPath + '/' + name;
                prototypePaths.push(absPath);
            }
        }
    }

    return prototypePaths;
}


