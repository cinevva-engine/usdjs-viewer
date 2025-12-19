import * as THREE from 'three';

import { computeSmoothNormalsDeindexed } from './normals';

/**
 * Flip triangle winding order for a geometry.
 * This converts between leftHanded and rightHanded orientation.
 * For indexed geometry, swaps indices. For non-indexed, swaps vertex positions.
 * @param recomputeNormals - If true, recompute vertex normals after flipping (use when normals aren't authored)
 * @param smoothNormals - If true, recompute smooth normals for de-indexed geometry when possible
 */
export function flipGeometryWinding(geom: THREE.BufferGeometry, recomputeNormals = false, smoothNormals = true): void {
    const index = geom.getIndex();
    if (index) {
        // Indexed geometry: swap second and third vertex of each triangle
        const arr = index.array;
        for (let i = 0; i < arr.length; i += 3) {
            const tmp = arr[i + 1];
            arr[i + 1] = arr[i + 2];
            arr[i + 2] = tmp;
        }
        index.needsUpdate = true;
    } else {
        // Non-indexed geometry: swap vertex attributes for each triangle
        const pos = geom.getAttribute('position') as THREE.BufferAttribute;
        if (!pos) return;
        const numVerts = pos.count;
        const swapTriVerts = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null, itemSize: number) => {
            if (!attr) return;
            const a = attr.array;
            for (let tri = 0; tri < numVerts; tri += 3) {
                const v1Start = (tri + 1) * itemSize;
                const v2Start = (tri + 2) * itemSize;
                for (let j = 0; j < itemSize; j++) {
                    const tmp = a[v1Start + j];
                    a[v1Start + j] = a[v2Start + j];
                    a[v2Start + j] = tmp;
                }
            }
            attr.needsUpdate = true;
        };
        swapTriVerts(pos, 3);
        if (!recomputeNormals) swapTriVerts(geom.getAttribute('normal') as THREE.BufferAttribute, 3);
        swapTriVerts(geom.getAttribute('uv') as THREE.BufferAttribute, 2);
        swapTriVerts(geom.getAttribute('color') as THREE.BufferAttribute, 3);
        swapTriVerts(geom.getAttribute('_originalPointIndex') as THREE.BufferAttribute, 1);
    }
    if (recomputeNormals) {
        // For non-indexed geometry with _originalPointIndex, optionally use smooth normal computation.
        // When smoothNormals=false, fall back to flat normals (computeVertexNormals on de-indexed geometry).
        if (!index && smoothNormals && geom.getAttribute('_originalPointIndex')) {
            computeSmoothNormalsDeindexed(geom);
        } else {
            geom.computeVertexNormals();
        }
    }
}



