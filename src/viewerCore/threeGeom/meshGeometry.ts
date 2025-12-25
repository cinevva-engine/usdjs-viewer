import * as THREE from 'three';
import { LoopSubdivision } from 'three-subdivide';
import type { SdfPrimSpec } from '@cinevva/usdjs';
import { getPrimProp } from '../usdAnim';
import { getPropMetadataString, parseNumberArray, parsePoint3ArrayToFloat32, parseTuple2ArrayToFloat32, parseTuple3ArrayToFloat32 } from '../usdParse';
import { extractToken } from '../materials/valueExtraction';

import { computeSmoothNormalsDeindexed } from './normals';
import { flipGeometryWinding } from './winding';
import { buildUsdMeshGeometryDeindexed } from './meshGeometryDeindexed';

export function buildUsdMeshGeometry(prim: SdfPrimSpec, unitScale = 1.0): THREE.BufferGeometry | null {
    const points = parsePoint3ArrayToFloat32(getPrimProp(prim, 'points'));
    const faceVertexCounts = parseNumberArray(getPrimProp(prim, 'faceVertexCounts'));
    const faceVertexIndices = parseNumberArray(getPrimProp(prim, 'faceVertexIndices'));
    if (!points || !faceVertexCounts || !faceVertexIndices) return null;

    // USD orientation attribute: determines face winding order
    // - rightHanded (default): counter-clockwise winding when viewed from front
    // - leftHanded: clockwise winding when viewed from front
    // Three.js uses counter-clockwise for front faces, so leftHanded meshes need winding flipped
    const orientation = extractToken(getPrimProp(prim, 'orientation')) ?? 'rightHanded';
    const isLeftHanded = orientation === 'leftHanded';

    // USD subdivision surface support
    // Check for subdivisionScheme (catmullClark, loop, bilinear, none)
    const subdivisionScheme = extractToken(getPrimProp(prim, 'subdivisionScheme'));

    // refinementLevel determines how many subdivision iterations to apply
    const refinementLevelProp = getPrimProp(prim, 'refinementLevel');
    const refinementLevel = typeof refinementLevelProp === 'number'
        ? refinementLevelProp
        : 0;

    // refinementEnableOverride must be true to enable subdivision
    const refinementEnableProp = getPrimProp(prim, 'refinementEnableOverride');
    const refinementEnabled =
        refinementEnableProp === true ||
        refinementEnableProp === 1 ||
        (typeof refinementEnableProp === 'object' &&
            refinementEnableProp !== null &&
            typeof (refinementEnableProp as any).type === 'string' &&
            (refinementEnableProp as any).value === true);

    // Determine if we should apply subdivision
    const shouldSubdivide = !!(refinementEnabled
        && refinementLevel > 0
        && subdivisionScheme
        && subdivisionScheme !== 'none'
        && subdivisionScheme !== 'bilinear');

    // Apply stage unit scale (metersPerUnit) so lighting/camera behave consistently.
    // Example: many ft-lab samples author `metersPerUnit = 0.01` (centimeters).
    if (unitScale !== 1.0) {
        for (let i = 0; i < points.length; i++) points[i] = points[i]! * unitScale;
    }

    // UVs (primvars:st)
    // Note: some exporters (notably 3ds Max) author UVs as `primvars:map1` instead of `primvars:st`.
    const uvPrimvarName =
        prim.properties?.has('primvars:st')
            ? 'primvars:st'
            : prim.properties?.has('primvars:map1')
                ? 'primvars:map1'
                : prim.properties?.has('primvars:uv')
                    ? 'primvars:uv'
                    : prim.properties?.has('primvars:st0')
                        ? 'primvars:st0'
                        : null;
    const stProp = uvPrimvarName ? prim.properties?.get(uvPrimvarName) : undefined;
    const stInterp = getPropMetadataString(stProp, 'interpolation');
    const st = (() => {
        return parseTuple2ArrayToFloat32(stProp?.defaultValue);
    })();
    const stIndices = uvPrimvarName ? parseNumberArray(getPrimProp(prim, `${uvPrimvarName}:indices`)) : null;

    // primvars:displayColor support (common "viewport color" in USD)
    const displayColorProp = prim.properties?.get('primvars:displayColor');
    const displayColorInterp = getPropMetadataString(displayColorProp, 'interpolation');
    const displayColor = parseTuple3ArrayToFloat32(displayColorProp?.defaultValue);
    const displayColorIndices = parseNumberArray(getPrimProp(prim, 'primvars:displayColor:indices'));

    // General vertex color primvar support (e.g. UsdPreviewSurface_vertexColor.usda uses primvars:colors)
    // Note: we only attach ONE color attribute (Three's standard `color`) and prefer displayColor.
    const colorsProp = prim.properties?.get('primvars:colors');
    const colorsInterp = getPropMetadataString(colorsProp, 'interpolation');
    const colors = parseTuple3ArrayToFloat32(colorsProp?.defaultValue);
    const colorsIndices = parseNumberArray(getPrimProp(prim, 'primvars:colors:indices'));

    // Authored normals support
    // Canonical USD Mesh normals are the `normals` attribute, but some exporters author them as a primvar:
    // `primvars:normals` (often faceVarying for hard edges).
    const normalsName =
        prim.properties?.has('normals') ? 'normals' : prim.properties?.has('primvars:normals') ? 'primvars:normals' : null;
    const normalsProp = normalsName ? prim.properties?.get(normalsName) : undefined;
    let normalsInterp = getPropMetadataString(normalsProp, 'interpolation');
    const normals = parseTuple3ArrayToFloat32(normalsProp?.defaultValue);
    const normalsIndices = normalsName ? parseNumberArray(getPrimProp(prim, `${normalsName}:indices`)) : null;
    const hasNormals = !!(normals && normals.length > 0);

    let triCount = 0;
    for (const c of faceVertexCounts) {
        const n = c | 0;
        if (n >= 3) triCount += n - 2;
    }
    if (triCount <= 0) return null;

    const numVerts = points.length / 3;
    const numTris = triCount;
    if (numVerts > 500_000 || numTris > 1_000_000) return null;

    // Infer normals interpolation if not authored explicitly.
    //
    // IMPORTANT: Many USD exporters author indexed normals:
    // - `normals` holds a unique table of normal vectors
    // - `normals:indices` maps each element (vertex / faceVarying corner / face) into that table
    //
    // In those cases, looking only at `normals.length` can misclassify interpolation (and produce
    // overly-smooth shading). Prefer inferring from the *indices* array length when present.
    if (hasNormals && !normalsInterp) {
        const idxCount = normalsIndices?.length ?? 0;
        if (idxCount === 1) normalsInterp = 'constant';
        else if (idxCount === numVerts) normalsInterp = 'vertex';
        else if (idxCount === faceVertexIndices.length) normalsInterp = 'faceVarying';
        else if (idxCount === faceVertexCounts.length) normalsInterp = 'uniform';
        else {
            // Fallback heuristic based on the authored normal element count (unindexed case).
            const nCount = normals.length / 3;
            if (nCount === 1) normalsInterp = 'constant';
            else if (nCount === numVerts) normalsInterp = 'vertex';
            else if (nCount === faceVertexIndices.length) normalsInterp = 'faceVarying';
            else if (nCount === faceVertexCounts.length) normalsInterp = 'uniform';
        }
    }

    // Normal handling:
    // - If normals are authored, prefer them. USD assets (including ft-lab samples) often rely on authored
    //   vertex normals for smooth shading even when `subdivisionScheme = "none"`.
    // - If normals are missing and subdivision is off, fall back to flat normals.
    //   (When we de-index geometry, computeVertexNormals() becomes per-face; for smooth shading we use
    //   computeSmoothNormalsDeindexed() in the non-flat case.)
    const useAuthoredNormals = hasNormals;
    const wantFlatNormals = subdivisionScheme === 'none' && !hasNormals;

    const vtxColor = displayColor ?? colors;
    let vtxColorInterp = displayColor ? displayColorInterp : colorsInterp;
    const vtxColorIndices = displayColor ? displayColorIndices : colorsIndices;

    // USD primvar interpolation defaults to "constant" when not authored.
    // Many simple samples omit the `interpolation` metadata, so infer it from element count.
    if (vtxColor && !vtxColorInterp) {
        const cCount = vtxColor.length / 3;
        if (cCount === 1) vtxColorInterp = 'constant';
        else if (cCount === numVerts) vtxColorInterp = 'vertex';
        else if (cCount === faceVertexIndices.length) vtxColorInterp = 'faceVarying';
        else if (cCount === faceVertexCounts.length) vtxColorInterp = 'uniform';
    }

    // When subdivision is enabled, we MUST use indexed geometry with shared vertices.
    // De-indexed geometry (each triangle has its own vertices) prevents proper edge smoothing.
    // Trade-off: per-face/per-corner colors are lost when subdivision is applied.
    const needsDeindex =
        !shouldSubdivide && (
            wantFlatNormals ||
            (vtxColor && (vtxColorInterp === 'faceVarying' || vtxColorInterp === 'uniform')) ||
            (useAuthoredNormals && (normalsInterp === 'faceVarying' || normalsInterp === 'uniform')) ||
            (st && stInterp === 'faceVarying')
        );

    // If displayColor or normals are per-corner/per-face, we need to de-index.
    if (needsDeindex) {
        return buildUsdMeshGeometryDeindexed({
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
        });
    }

    // Default: indexed geometry
    // NOTE: Fan triangulation (0,k,k+1) is incorrect for concave polygons and can create overlapping
    // triangles ("extra triangle" / z-fighting). Use Earcut via THREE.ShapeUtils for n-gons.
    const indicesOut: number[] = [];
    let idxRead = 0;
    // Record USD face index -> triangulated triangle range mapping (see de-indexed path above).
    const usdFaceTriStart = new Uint32Array(faceVertexCounts.length);
    const usdFaceTriCount = new Uint32Array(faceVertexCounts.length);
    let faceIdx = 0;

    const triangulatePolygon = (poly: number[]): number[] => {
        // Compute a stable projection plane for this polygon using Newell's method.
        // Then triangulate in 2D with ShapeUtils (Earcut).
        let nx = 0,
            ny = 0,
            nz = 0;
        const n = poly.length;
        for (let i = 0; i < n; i++) {
            const a = poly[i]!;
            const b = poly[(i + 1) % n]!;
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
        // Drop the dominant normal axis (largest component).
        let drop: 'x' | 'y' | 'z' = 'z';
        if (anx >= any && anx >= anz) drop = 'x';
        else if (any >= anx && any >= anz) drop = 'y';

        const contour: THREE.Vector2[] = new Array(n);
        for (let i = 0; i < n; i++) {
            const pi = poly[i]!;
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
            let ia = poly[t[0]!]!;
            let ib = poly[t[1]!]!;
            let ic = poly[t[2]!]!;
            if (wantLenSq > 1e-18) {
                const ax = points[ia * 3 + 0] ?? 0;
                const ay = points[ia * 3 + 1] ?? 0;
                const az = points[ia * 3 + 2] ?? 0;
                const bx = points[ib * 3 + 0] ?? 0;
                const by = points[ib * 3 + 1] ?? 0;
                const bz = points[ib * 3 + 2] ?? 0;
                const cx = points[ic * 3 + 0] ?? 0;
                const cy = points[ic * 3 + 1] ?? 0;
                const cz = points[ic * 3 + 2] ?? 0;
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
                    const tmp = ib;
                    ib = ic;
                    ic = tmp;
                }
            }
            out.push(ia, ib, ic);
        }
        return out;
    };

    for (const c of faceVertexCounts) {
        const n = c | 0;
        if (n < 3) {
            usdFaceTriStart[faceIdx] = (indicesOut.length / 3) | 0;
            usdFaceTriCount[faceIdx] = 0;
            idxRead += Math.max(0, n);
            faceIdx++;
            continue;
        }

        const faceTriStart = (indicesOut.length / 3) | 0;
        if (n === 3) {
            const i0 = faceVertexIndices[idxRead + 0]!;
            const i1 = faceVertexIndices[idxRead + 1]!;
            const i2 = faceVertexIndices[idxRead + 2]!;
            indicesOut.push(i0, i1, i2);
            idxRead += 3;
            usdFaceTriStart[faceIdx] = faceTriStart;
            usdFaceTriCount[faceIdx] = 1;
            faceIdx++;
            continue;
        }

        const poly: number[] = [];
        for (let k = 0; k < n; k++) poly.push(faceVertexIndices[idxRead + k]!);

        const tris = triangulatePolygon(poly);
        if (tris.length) {
            indicesOut.push(...tris);
        } else {
            // Fallback: fan triangulation (may be incorrect for concave faces)
            const i0 = poly[0]!;
            for (let k = 1; k < n - 1; k++) indicesOut.push(i0, poly[k]!, poly[k + 1]!);
        }

        idxRead += n;
        usdFaceTriStart[faceIdx] = faceTriStart;
        usdFaceTriCount[faceIdx] = ((indicesOut.length / 3) | 0) - faceTriStart;
        faceIdx++;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(points, 3));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indicesOut), 1));
    (geom as any).userData = {
        ...(geom as any).userData,
        usdFaceTriStart,
        usdFaceTriCount,
        usdTriangleCount: (indicesOut.length / 3) | 0,
        usdFaceCount: faceVertexCounts.length,
    };

    // Attach vertex colors per point (keep indices) when interpolation allows it.
    // - vertex: per point
    // - constant: one value for the whole mesh (replicated per point for Three)
    if (vtxColor && (vtxColorInterp === 'vertex' || vtxColorInterp === 'constant')) {
        const col = new Float32Array(numVerts * 3);
        for (let i = 0; i < numVerts; i++) {
            const src = vtxColorInterp === 'constant' ? 0 : vtxColorIndices ? vtxColorIndices[i] ?? i : i;
            const sOff = src * 3;
            col[i * 3 + 0] = vtxColor[sOff + 0] ?? 1;
            col[i * 3 + 1] = vtxColor[sOff + 1] ?? 1;
            col[i * 3 + 2] = vtxColor[sOff + 2] ?? 1;
        }
        geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }

    // Vertex UVs (keep indices)
    if (st && stInterp === 'vertex' && st.length === numVerts * 2) {
        const out = new Float32Array(numVerts * 2);
        for (let i = 0; i < numVerts; i++) {
            const src = stIndices ? stIndices[i] ?? i : i;
            const sOff = src * 2;
            out[i * 2 + 0] = st[sOff + 0] ?? 0;
            out[i * 2 + 1] = st[sOff + 1] ?? 0;
        }
        geom.setAttribute('uv', new THREE.BufferAttribute(out, 2));
        // Three.js AO/light maps expect a secondary UV set (`uv2`). Many USD assets only author one UV set (primvars:st).
        // To support common packed maps (like OmniPBR ORM where AO uses the red channel), alias uv -> uv2 when missing.
        if (!(geom as any).getAttribute?.('uv2')) {
            geom.setAttribute('uv2', new THREE.BufferAttribute(out.slice(), 2));
        }
    }

    // If normals are vertex-interpolated and match point count, attach them directly.
    // Track if we have authored normals (needed for leftHanded flip decision)
    let hasAuthoredNormals = false;
    if (useAuthoredNormals && normalsInterp === 'vertex' && normals.length === points.length) {
        const out = new Float32Array(points.length);
        for (let i = 0; i < numVerts; i++) {
            const src = normalsIndices ? normalsIndices[i] ?? i : i;
            const sOff = src * 3;
            out[i * 3 + 0] = normals[sOff + 0] ?? 0;
            out[i * 3 + 1] = normals[sOff + 1] ?? 1;
            out[i * 3 + 2] = normals[sOff + 2] ?? 0;
        }
        geom.setAttribute('normal', new THREE.BufferAttribute(out, 3));
        hasAuthoredNormals = true;
    } else {
        geom.computeVertexNormals();
    }
    geom.computeBoundingSphere();

    // Apply subdivision surface if specified (catmullClark or loop)
    // NOTE: We use Loop subdivision (for triangles) as an approximation of Catmull-Clark (for quads).
    // Loop subdivision on indexed geometry with shared vertices produces smooth results.
    if (shouldSubdivide) {
        const subdivided = LoopSubdivision.modify(geom, refinementLevel, {
            split: false,       // Keep shared vertices for smooth shading
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
    if (isLeftHanded) flipGeometryWinding(geom, !hasAuthoredNormals);
    return geom;
}



