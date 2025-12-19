import type { SdfPrimSpec } from '@cinevva/usdjs';
import type { PrimeTreeNode, SceneNode } from './types';

export function buildTree(root: SdfPrimSpec): SceneNode {
    const walk = (p: SdfPrimSpec): SceneNode => {
        const children = Array.from(p.children?.values() ?? []).map(walk);
        return { path: p.path.toString(), typeName: p.typeName, prim: p, children };
    };
    return walk(root);
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


