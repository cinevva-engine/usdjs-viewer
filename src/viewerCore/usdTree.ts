import type { SdfPrimSpec } from '@cinevva/usdjs';
import type { PrimeTreeNode, SceneNode } from './types';

export function buildTree(root: SdfPrimSpec): SceneNode {
    const isActiveLocal = (p: SdfPrimSpec): boolean => (p.metadata as any)?.active !== false;
    const isInternalPrototype = (p: SdfPrimSpec): boolean => {
        const path = p.path?.toString?.() ?? '';
        return path.startsWith('/__usdjs_prototypes');
    };

    const walk = (p: SdfPrimSpec, ancestorsActive: boolean): SceneNode | null => {
        // Internal implementation detail: prototypes materialized for instanceable external references.
        // These should not appear in the scene tree or be rendered as top-level prims; instances reference
        // them via internal sdfpath arcs and are expanded/rendered under the instance prim.
        if (isInternalPrototype(p)) return null;
        const selfActive = ancestorsActive && isActiveLocal(p);
        if (!selfActive) return null;
        const children = Array.from(p.children?.values() ?? [])
            .map((c) => walk(c, selfActive))
            .filter((x): x is SceneNode => !!x);
        return { path: p.path.toString(), typeName: p.typeName, prim: p, children };
    };

    // Pseudo-root should always exist; if authored data somehow marks it inactive, just render an empty tree.
    return walk(root, true) ?? { path: root.path.toString(), typeName: root.typeName, prim: root, children: [] };
}

export function toPrimeTree(node: SceneNode): PrimeTreeNode {
    const displayName = node.prim.metadata?.displayName;
    const label =
        typeof displayName === 'string' ? displayName : node.path === '/' ? '/' : node.path.split('/').pop() || node.path;
    return {
        key: node.path,
        label,
        data: { path: node.path, typeName: node.typeName },
        children: node.children.map(toPrimeTree),
    };
}


