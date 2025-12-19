import type { SdfPrimSpec } from '@cinevva/usdjs';

import type { SceneNode } from '../../types';

export function buildPointInstancerProtoNode(prim: SdfPrimSpec, parentPath: string): SceneNode {
  const children: SceneNode[] = [];
  if (prim.children) {
    for (const [name, child] of prim.children) {
      const childPath = parentPath === '/' ? '/' + name : parentPath + '/' + name;
      children.push(buildPointInstancerProtoNode(child, childPath));
    }
  }
  return {
    path: parentPath,
    typeName: prim.typeName,
    prim,
    children,
  };
}


