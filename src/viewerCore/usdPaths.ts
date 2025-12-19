import type { SdfPrimSpec } from '@cinevva/usdjs';

export function findPrimByPath(root: SdfPrimSpec, path: string): SdfPrimSpec | null {
    if (path === '/') return root;
    const parts = path.split('/').filter(Boolean);
    let cur: SdfPrimSpec = root;
    for (const name of parts) {
        const next = cur.children?.get(name);
        if (!next) {
            // Fallback: some composed layers can end up with inconsistent child maps (especially around references).
            // If the fast map-walk fails, do a one-time DFS to find an exact path match.
            const target = path;
            const stack: SdfPrimSpec[] = [root];
            while (stack.length) {
                const p = stack.pop()!;
                if (p.path?.primPath === target) return p;
                if (p.children) {
                    for (const child of p.children.values()) stack.push(child);
                }
            }
            return null;
        }
        cur = next;
    }
    return cur;
}

export function findNearestSkelRootPrim(rootPrim: SdfPrimSpec, primPath: string): SdfPrimSpec | null {
    // Walk up the prim path and pick the first SkelRoot (preferred), otherwise the first prim
    // that has a skel:jointOrder authored.
    const parts = primPath.split('/').filter(Boolean);
    let best: SdfPrimSpec | null = null;
    for (let i = parts.length; i >= 1; i--) {
        const p = '/' + parts.slice(0, i).join('/');
        const prim = findPrimByPath(rootPrim, p);
        if (!prim) continue;
        if (prim.typeName === 'SkelRoot') return prim;
        if (!best && prim.properties?.has('skel:jointOrder')) best = prim;
    }
    return best;
}


