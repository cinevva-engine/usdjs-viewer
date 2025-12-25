import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import { getPrimProp } from '../../usdAnim';
import { parseNumberArray } from '../../usdParse';
import { resolveMaterialBinding } from '../../materials';
import { extractToken } from '../../materials/valueExtraction';

export function applyGeomSubsetMaterials(opts: {
    meshPrim: SdfPrimSpec;
    rootPrim: SdfPrimSpec;
    bindingRootForMaterials?: SdfPrimSpec;
    geom: THREE.BufferGeometry;
    baseMaterial: THREE.Material;
    resolveMaterial: (prim: SdfPrimSpec) => THREE.Material;
    applySidedness: (prim: SdfPrimSpec, mat: THREE.Material | THREE.Material[]) => void;
}): { materials: THREE.Material[]; didApply: boolean } {
    const { meshPrim, rootPrim, bindingRootForMaterials, geom, baseMaterial, resolveMaterial, applySidedness } = opts;

    const subsets = Array.from(meshPrim.children?.values?.() ?? []).filter((c) => c?.typeName === 'GeomSubset');
    if (subsets.length === 0) return { materials: [baseMaterial], didApply: false };

    const usdFaceTriStart: any = (geom as any).userData?.usdFaceTriStart;
    const usdFaceTriCount: any = (geom as any).userData?.usdFaceTriCount;
    const usdTriangleCount: number | undefined = (geom as any).userData?.usdTriangleCount;
    const usdFaceCount: number | undefined = (geom as any).userData?.usdFaceCount;
    if (!usdFaceTriStart || !usdFaceTriCount || typeof usdTriangleCount !== 'number' || typeof usdFaceCount !== 'number') {
        return { materials: [baseMaterial], didApply: false };
    }

    type SubsetInfo = { prim: SdfPrimSpec; faceIndices: number[]; material: THREE.Material };
    const picked: SubsetInfo[] = [];
    for (const s of subsets) {
        // elementType should be "face"
        const etVal = extractToken(getPrimProp(s, 'elementType'));
        if (etVal && etVal !== 'face') continue;

        const idx = parseNumberArray(getPrimProp(s, 'indices'));
        if (!idx || idx.length === 0) continue;
        // We need a real JS array here because we do Set/dedup/sort operations.
        const faceIndices = Array.from(idx, (x) => x | 0);

        // Must have a resolvable material binding
        const bound = resolveMaterialBinding(s, rootPrim, bindingRootForMaterials);
        if (!bound) continue;

        const smat = resolveMaterial(s);
        applySidedness(meshPrim, smat);
        picked.push({ prim: s, faceIndices, material: smat });
    }
    if (picked.length === 0) return { materials: [baseMaterial], didApply: false };

    // Build groups based on USD face indices -> triangulated triangle ranges.
    const triCount = usdTriangleCount | 0;
    const covered = new Uint8Array(triCount);
    const materials: THREE.Material[] = [baseMaterial, ...picked.map((p) => p.material)];
    geom.clearGroups();

    const getStart = (f: number): number => {
        // handle both typed arrays and JS arrays
        return (usdFaceTriStart[f] ?? 0) | 0;
    };
    const getCount = (f: number): number => {
        return (usdFaceTriCount[f] ?? 0) | 0;
    };

    const addFaceRuns = (faces: number[], materialIndex: number) => {
        const sortedFaces = Array.from(new Set(faces.map((x) => x | 0))).filter((f) => f >= 0 && f < usdFaceCount).sort((a, b) => a - b);
        let runStart = -1;
        let runCount = 0;
        let runEnd = -1; // exclusive end (triangle index)

        for (const f of sortedFaces) {
            const s = getStart(f);
            const c = getCount(f);
            if (c <= 0) continue;
            if (s < 0 || s >= triCount) continue;
            const e = Math.min(triCount, s + c);
            const cc = e - s;
            if (cc <= 0) continue;

            if (runStart < 0) {
                runStart = s;
                runCount = cc;
                runEnd = s + cc;
            } else if (s === runEnd) {
                runCount += cc;
                runEnd += cc;
            } else {
                geom.addGroup(runStart * 3, runCount * 3, materialIndex);
                runStart = s;
                runCount = cc;
                runEnd = s + cc;
            }
        }

        if (runStart >= 0 && runCount > 0) {
            geom.addGroup(runStart * 3, runCount * 3, materialIndex);
        }
    };

    // Add subset groups
    for (let i = 0; i < picked.length; i++) {
        const faces = picked[i]!.faceIndices;
        for (const f0 of faces) {
            const f = f0 | 0;
            if (f < 0 || f >= usdFaceCount) continue;
            const s = getStart(f);
            const c = getCount(f);
            if (c <= 0) continue;
            const e = Math.min(triCount, s + c);
            for (let t = s; t < e; t++) covered[t] = 1;
        }
        addFaceRuns(faces, /* materialIndex */ i + 1);
    }

    // Add fallback group for uncovered faces (materialIndex 0)
    // Create contiguous runs over the triangle stream.
    let runStart = -1;
    for (let t = 0; t < triCount; t++) {
        if (covered[t]) {
            if (runStart >= 0) {
                geom.addGroup(runStart * 3, (t - runStart) * 3, 0);
                runStart = -1;
            }
        } else if (runStart < 0) {
            runStart = t;
        }
    }
    if (runStart >= 0) {
        geom.addGroup(runStart * 3, (triCount - runStart) * 3, 0);
    }

    return { materials, didApply: true };
}


