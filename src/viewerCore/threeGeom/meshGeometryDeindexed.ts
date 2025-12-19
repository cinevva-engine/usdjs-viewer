import * as THREE from 'three';
import { LoopSubdivision } from 'three-subdivide';

import { computeSmoothNormalsDeindexed } from './normals';
import { flipGeometryWinding } from './winding';

export function buildUsdMeshGeometryDeindexed(opts: {
    points: Float32Array;
    faceVertexCounts: number[];
    faceVertexIndices: number[];
    numTris: number;
    vtxColor: Float32Array | null;
    vtxColorInterp: string | null | undefined;
    vtxColorIndices: number[] | null;
    useAuthoredNormals: boolean;
    normals: Float32Array | null;
    normalsInterp: string | null | undefined;
    normalsIndices: number[] | null;
    st: Float32Array | null;
    stInterp: string | null | undefined;
    stIndices: number[] | null;
    wantFlatNormals: boolean;
    shouldSubdivide: boolean;
    refinementLevel: number;
    isLeftHanded: boolean;
}): THREE.BufferGeometry | null {
    const {
        points,
        faceVertexCounts,
        faceVertexIndices,
        numTris,
        vtxColor,
        vtxColorInterp,
        vtxColorIndices,
        useAuthoredNormals,
        normals,
        normalsInterp,
        normalsIndices,
        st,
        stInterp,
        stIndices,
        wantFlatNormals,
        shouldSubdivide,
        refinementLevel,
        isLeftHanded,
    } = opts;

    // Record a mapping from USD "face index" -> (triangle start, triangle count) in the *final*
    // triangulated geometry. This is required to apply UsdGeomSubset face indices as Three.js groups.
    //
    // Note: USD GeomSubset indices are "face indices" (not faceVertexIndices indices, and not triangle indices).
    // After triangulation, each face becomes 1+ triangles; we keep a compact mapping so subsets can be applied.
    const usdFaceTriStart = new Uint32Array(faceVertexCounts.length);
    const usdFaceTriCount = new Uint32Array(faceVertexCounts.length);

    const vCount = numTris * 3;
    const pos = new Float32Array(vCount * 3);
    const col = vtxColor ? new Float32Array(vCount * 3) : null;
    const nor = useAuthoredNormals ? new Float32Array(vCount * 3) : null;
    const uv = st ? new Float32Array(vCount * 2) : null;
    // Track original point index for each de-indexed vertex (needed for skinning)
    const originalPointIndex = new Uint32Array(vCount);

    let idxRead = 0; // faceVertexIndices cursor (also the faceVarying element cursor)
    let vWrite = 0;
    let faceIdx = 0;
    let triWrite = 0; // triangle cursor in the final triangulated stream

    const triangulateFaceLocal = (polyPoints: number[]): number[] => {
        // polyPoints are global point indices in face-vertex order.
        // Return local triangle corner indices [a,b,c, a,b,c, ...] into the face corner list.
        const n = polyPoints.length;
        if (n < 3) return [];
        if (n === 3) return [0, 1, 2];

        // Newell normal to choose a stable projection plane.
        let nx = 0,
            ny = 0,
            nz = 0;
        for (let i = 0; i < n; i++) {
            const a = polyPoints[i]!;
            const b = polyPoints[(i + 1) % n]!;
            const ax = points[a * 3 + 0] ?? 0;
            const ay = points[a * 3 + 1] ?? 0;
            const az = points[a * 3 + 2] ?? 0;
            const bx = points[b * 3 + 0] ?? 0;
            const by = points[b * 3 + 1] ?? 0;
            const bz = points[b * 3 + 2] ?? 0;
            nx += (ay - by) * (az + bz);
            ny += (az - bz) * (ax + bx);
            nz += (ax - bx) * (ay + by);
        }
        const anx = Math.abs(nx);
        const any = Math.abs(ny);
        const anz = Math.abs(nz);
        let drop: 'x' | 'y' | 'z' = 'z';
        if (anx >= any && anx >= anz) drop = 'x';
        else if (any >= anx && any >= anz) drop = 'y';

        const contour: THREE.Vector2[] = new Array(n);
        for (let i = 0; i < n; i++) {
            const pi = polyPoints[i]!;
            const x = points[pi * 3 + 0] ?? 0;
            const y = points[pi * 3 + 1] ?? 0;
            const z = points[pi * 3 + 2] ?? 0;
            if (drop === 'x') contour[i] = new THREE.Vector2(y, z);
            else if (drop === 'y') contour[i] = new THREE.Vector2(x, z);
            else contour[i] = new THREE.Vector2(x, y);
        }

        const tris2d = THREE.ShapeUtils.triangulateShape(contour, []);
        if (!tris2d || tris2d.length === 0) return [];
        const out: number[] = [];
        // IMPORTANT: ShapeUtils/Earcut does not guarantee preserving the original 3D winding.
        // Ensure each emitted triangle matches the face's original winding (Newell normal direction).
        const wantNx = nx,
            wantNy = ny,
            wantNz = nz;
        const wantLenSq = wantNx * wantNx + wantNy * wantNy + wantNz * wantNz;
        for (const t of tris2d) {
            let aL = t[0]!,
                bL = t[1]!,
                cL = t[2]!;
            if (wantLenSq > 1e-18) {
                const a = polyPoints[aL]!;
                const b = polyPoints[bL]!;
                const c = polyPoints[cL]!;
                const ax = points[a * 3 + 0] ?? 0;
                const ay = points[a * 3 + 1] ?? 0;
                const az = points[a * 3 + 2] ?? 0;
                const bx = points[b * 3 + 0] ?? 0;
                const by = points[b * 3 + 1] ?? 0;
                const bz = points[b * 3 + 2] ?? 0;
                const cx = points[c * 3 + 0] ?? 0;
                const cy = points[c * 3 + 1] ?? 0;
                const cz = points[c * 3 + 2] ?? 0;
                const abx = bx - ax,
                    aby = by - ay,
                    abz = bz - az;
                const acx = cx - ax,
                    acy = cy - ay,
                    acz = cz - az;
                const tnx = aby * acz - abz * acy;
                const tny = abz * acx - abx * acz;
                const tnz = abx * acy - aby * acx;
                const dot = tnx * wantNx + tny * wantNy + tnz * wantNz;
                if (dot < 0) {
                    // Flip winding
                    const tmp = bL;
                    bL = cL;
                    cL = tmp;
                }
            }
            out.push(aL, bL, cL);
        }
        return out;
    };

    for (const c of faceVertexCounts) {
        const n = c | 0;
        if (n < 3) {
            usdFaceTriStart[faceIdx] = triWrite;
            usdFaceTriCount[faceIdx] = 0;
            idxRead += Math.max(0, n);
            faceIdx++;
            continue;
        }

        const faceCornerPoints: number[] = new Array(n);
        for (let i = 0; i < n; i++) faceCornerPoints[i] = faceVertexIndices[idxRead + i]!;
        const triLocal = triangulateFaceLocal(faceCornerPoints);
        const faceTriStart = triWrite;

        const writeVertex = (pointIndex: number, fvIndex: number) => {
            const pOff = pointIndex * 3;
            pos[vWrite * 3 + 0] = points[pOff + 0]!;
            pos[vWrite * 3 + 1] = points[pOff + 1]!;
            pos[vWrite * 3 + 2] = points[pOff + 2]!;

            if (vtxColor && col) {
                // Primvar element indexing depends on interpolation:
                // - constant: single element for whole mesh (always index 0)
                // - vertex: per point
                // - faceVarying: per corner (fv index)
                // - uniform: per face
                const elemIndex =
                    vtxColorInterp === 'constant'
                        ? 0
                        : vtxColorInterp === 'vertex'
                            ? pointIndex
                            : vtxColorInterp === 'uniform'
                                ? faceIdx
                                : fvIndex;
                const cIdx = vtxColorIndices ? vtxColorIndices[elemIndex] ?? elemIndex : elemIndex;
                const cOff = cIdx * 3;
                // guard: if out of range, default to white
                col[vWrite * 3 + 0] = vtxColor[cOff + 0] ?? 1;
                col[vWrite * 3 + 1] = vtxColor[cOff + 1] ?? 1;
                col[vWrite * 3 + 2] = vtxColor[cOff + 2] ?? 1;
            }

            if (useAuthoredNormals && normals && nor) {
                let nIdx: number | null = null;
                if (normalsInterp === 'vertex') nIdx = pointIndex;
                else if (normalsInterp === 'faceVarying') nIdx = fvIndex;
                else if (normalsInterp === 'uniform') nIdx = faceIdx;
                else nIdx = null;

                if (nIdx !== null) {
                    const resolved = normalsIndices ? normalsIndices[nIdx] ?? nIdx : nIdx;
                    const nOff = resolved * 3;
                    nor[vWrite * 3 + 0] = normals[nOff + 0] ?? 0;
                    nor[vWrite * 3 + 1] = normals[nOff + 1] ?? 1;
                    nor[vWrite * 3 + 2] = normals[nOff + 2] ?? 0;
                }
            }

            if (st && uv) {
                // primvars:st is commonly faceVarying; if it's vertex, index by pointIndex.
                const tIdx = stInterp === 'vertex' ? pointIndex : fvIndex;
                const resolved = stIndices ? stIndices[tIdx] ?? tIdx : tIdx;
                const tOff = resolved * 2;
                uv[vWrite * 2 + 0] = st[tOff + 0] ?? 0;
                uv[vWrite * 2 + 1] = st[tOff + 1] ?? 0;
            }

            // Store original point index for skinning attribute lookup
            originalPointIndex[vWrite] = pointIndex;

            vWrite++;
        };

        if (triLocal.length) {
            // Earcut-based triangulation (correct for concave polygons)
            for (let i = 0; i < triLocal.length; i += 3) {
                const a = triLocal[i + 0]!;
                const b = triLocal[i + 1]!;
                const c = triLocal[i + 2]!;
                writeVertex(faceCornerPoints[a]!, idxRead + a);
                writeVertex(faceCornerPoints[b]!, idxRead + b);
                writeVertex(faceCornerPoints[c]!, idxRead + c);
                triWrite++;
            }
        } else {
            // Fallback: fan triangulation (may be incorrect for concave faces)
            const corner0Point = faceCornerPoints[0]!;
            const fv0 = idxRead;
            for (let k = 1; k < n - 1; k++) {
                const corner1Point = faceCornerPoints[k]!;
                const corner2Point = faceCornerPoints[k + 1]!;
                const fv1 = idxRead + k;
                const fv2 = idxRead + k + 1;
                writeVertex(corner0Point, fv0);
                writeVertex(corner1Point, fv1);
                writeVertex(corner2Point, fv2);
                triWrite++;
            }
        }

        usdFaceTriStart[faceIdx] = faceTriStart;
        usdFaceTriCount[faceIdx] = triWrite - faceTriStart;
        idxRead += n;
        faceIdx++;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (col) geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (nor) geom.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (uv) geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    // Store original point indices for skinning (vertex-interpolated attributes)
    geom.setAttribute('_originalPointIndex', new THREE.BufferAttribute(originalPointIndex, 1));
    // Store face->triangle mapping for GeomSubset material application.
    (geom as any).userData = {
        ...(geom as any).userData,
        usdFaceTriStart,
        usdFaceTriCount,
        usdTriangleCount: triWrite,
        usdFaceCount: faceVertexCounts.length,
    };

    // Track if we have authored normals (needed for leftHanded flip decision)
    const hasAuthoredNormals = !!nor;

    // Compute smooth normals if not authored.
    // Use computeSmoothNormalsDeindexed to get smooth shading by averaging
    // face normals for vertices that share the same original point.
    if (!nor) {
        if (wantFlatNormals) geom.computeVertexNormals();
        else computeSmoothNormalsDeindexed(geom);
    }
    geom.computeBoundingSphere();

    // Apply subdivision surface if specified (catmullClark or loop)
    // NOTE: This path is only reached when shouldSubdivide is false (due to needsDeindex check).
    // Subdivision for de-indexed geometry is kept for reference but won't produce smooth results.
    if (shouldSubdivide) {
        const subdivided = LoopSubdivision.modify(geom, refinementLevel, {
            split: false,
            uvSmooth: false,
            preserveEdges: false,
            flatOnly: false,
        });
        subdivided.computeVertexNormals();
        subdivided.computeBoundingSphere();
        // Subdivision always recomputes normals, so recompute after flip
        if (isLeftHanded) flipGeometryWinding(subdivided, true);
        return subdivided;
    }
    // Recompute normals after flip only if they weren't authored
    if (isLeftHanded) flipGeometryWinding(geom, !hasAuthoredNormals, !wantFlatNormals);
    return geom;
}


