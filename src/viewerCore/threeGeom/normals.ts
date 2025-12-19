import * as THREE from 'three';

/**
 * Compute smooth vertex normals for de-indexed geometry.
 * Uses the _originalPointIndex attribute to average face normals across vertices
 * that came from the same original point, producing smooth shading.
 * Falls back to computeVertexNormals() (flat shading) if _originalPointIndex is missing.
 */
export function computeSmoothNormalsDeindexed(geom: THREE.BufferGeometry): void {
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    const origIdx = geom.getAttribute('_originalPointIndex') as THREE.BufferAttribute;
    if (!pos || !origIdx) {
        // Fallback to flat normals if we don't have original point indices
        geom.computeVertexNormals();
        return;
    }

    const numVerts = pos.count;
    const numTris = numVerts / 3;

    // Step 1: Compute face normals for each triangle
    const faceNormals = new Float32Array(numTris * 3);
    for (let t = 0; t < numTris; t++) {
        const i0 = t * 3;
        const i1 = t * 3 + 1;
        const i2 = t * 3 + 2;

        const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
        const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
        const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);

        // Edge vectors
        const abx = bx - ax, aby = by - ay, abz = bz - az;
        const acx = cx - ax, acy = cy - ay, acz = cz - az;

        // Cross product (face normal, not normalized - magnitude = face area for weighting)
        faceNormals[t * 3 + 0] = aby * acz - abz * acy;
        faceNormals[t * 3 + 1] = abz * acx - abx * acz;
        faceNormals[t * 3 + 2] = abx * acy - aby * acx;
    }

    // Step 2: Accumulate face normals per original point index
    // Find max original point index to size the accumulator
    let maxOrigIdx = 0;
    for (let i = 0; i < numVerts; i++) {
        const oi = origIdx.getX(i);
        if (oi > maxOrigIdx) maxOrigIdx = oi;
    }
    const pointNormals = new Float32Array((maxOrigIdx + 1) * 3);

    // Accumulate face normals for each original point
    for (let t = 0; t < numTris; t++) {
        const fnx = faceNormals[t * 3 + 0];
        const fny = faceNormals[t * 3 + 1];
        const fnz = faceNormals[t * 3 + 2];

        for (let corner = 0; corner < 3; corner++) {
            const vi = t * 3 + corner;
            const oi = origIdx.getX(vi);
            pointNormals[oi * 3 + 0] += fnx;
            pointNormals[oi * 3 + 1] += fny;
            pointNormals[oi * 3 + 2] += fnz;
        }
    }

    // Normalize accumulated normals
    for (let p = 0; p <= maxOrigIdx; p++) {
        const nx = pointNormals[p * 3 + 0];
        const ny = pointNormals[p * 3 + 1];
        const nz = pointNormals[p * 3 + 2];
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-10) {
            pointNormals[p * 3 + 0] = nx / len;
            pointNormals[p * 3 + 1] = ny / len;
            pointNormals[p * 3 + 2] = nz / len;
        } else {
            // Degenerate: default to up
            pointNormals[p * 3 + 0] = 0;
            pointNormals[p * 3 + 1] = 1;
            pointNormals[p * 3 + 2] = 0;
        }
    }

    // Step 3: Assign smooth normals to each vertex based on original point index
    const normals = new Float32Array(numVerts * 3);
    for (let i = 0; i < numVerts; i++) {
        const oi = origIdx.getX(i);
        normals[i * 3 + 0] = pointNormals[oi * 3 + 0];
        normals[i * 3 + 1] = pointNormals[oi * 3 + 1];
        normals[i * 3 + 2] = pointNormals[oi * 3 + 2];
    }

    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
}



