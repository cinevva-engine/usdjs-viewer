import * as THREE from 'three';
import type { SdfValue } from '@cinevva/usdjs';

export function computePointsBounds(points: SdfValue | undefined): THREE.Box3 | null {
    if (!points || typeof points !== 'object' || points.type !== 'array') return null;
    const b = new THREE.Box3();
    let any = false;
    for (const el of points.value) {
        if (!el || typeof el !== 'object' || el.type !== 'tuple') continue;
        const [x, y, z] = el.value;
        if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') continue;
        b.expandByPoint(new THREE.Vector3(x, y, z));
        any = true;
    }
    return any ? b : null;
}



