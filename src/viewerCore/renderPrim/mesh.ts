import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import type { SceneNode } from '../types';
import { getPrimProp } from '../usdAnim';
import { extractAssetStrings, getPropMetadataNumber, getPropMetadataString, parseNumberArray, parseTuple3ArrayToFloat32 } from '../usdParse';
import { buildUsdMeshGeometry, computePointsBounds } from '../threeGeom';
import { resolveMaterialBinding } from '../materials';
import { applyGeomSubsetMaterials } from './mesh/geomSubsetMaterials';
import { renderUsdSkinnedMesh } from './mesh/skinning';

export function renderUsdMeshPrim(opts: {
    container: THREE.Object3D;
    node: SceneNode;
    rootPrim: SdfPrimSpec;
    bindingRootForMaterials?: SdfPrimSpec;
    sceneRef: THREE.Scene;
    unitScale: number;
    resolveMaterial: (prim: SdfPrimSpec) => THREE.Material;
    applySidedness: (prim: SdfPrimSpec, mat: THREE.Material | THREE.Material[]) => void;
    USDDEBUG: boolean;
    dbg: (...args: any[]) => void;
}) {
    const {
        container,
        node,
        rootPrim,
        bindingRootForMaterials,
        sceneRef,
        unitScale,
        resolveMaterial,
        applySidedness,
        USDDEBUG,
        dbg,
    } = opts;

    if (USDDEBUG) dbg(`[Mesh] Rendering mesh: ${node.path}, prototypeRootForMaterials=${bindingRootForMaterials?.path?.primPath}`);

    // USD-WG corpus: invalid/degenerate authored extents should result in empty imaging (usdrecord).
    // In practice, some renderers use `extent` for culling and/or imaging bounds; if it's invalid
    // (inverse order) or zero-sized, the prim may be treated as not renderable.
    const extent = getPrimProp(node.prim, 'extent');
    if (extent && typeof extent === 'object' && extent.type === 'array') {
        const a0 = extent.value?.[0];
        const a1 = extent.value?.[1];
        const isTuple3 = (v: any): v is { type: 'tuple'; value: any[] } =>
            !!v && typeof v === 'object' && v.type === 'tuple' && Array.isArray(v.value) && v.value.length >= 3;
        if (isTuple3(a0) && isTuple3(a1)) {
            const [minX, minY, minZ] = a0.value;
            const [maxX, maxY, maxZ] = a1.value;
            if (
                typeof minX === 'number' && typeof minY === 'number' && typeof minZ === 'number' &&
                typeof maxX === 'number' && typeof maxY === 'number' && typeof maxZ === 'number'
            ) {
                const inverse = (minX > maxX) || (minY > maxY) || (minZ > maxZ);
                const zero = (minX === maxX) && (minY === maxY) && (minZ === maxZ);
                if (inverse || zero) {
                    if (USDDEBUG) dbg(`[Mesh] ${node.path}: skipping render due to invalid extent (inverse=${inverse}, zero=${zero})`);
                    return;
                }
            }
        }
    }

    const mat = resolveMaterial(node.prim);
    applySidedness(node.prim, mat);
    // USD commonly binds materials via GeomSubsets (per-face material assignment). In that case, the Mesh itself
    // often has no `material:binding`, and we should not fall back to default gray / displayColor-only rendering.
    const subsetChildren = Array.from(node.prim.children?.values?.() ?? []).filter((c) => c?.typeName === 'GeomSubset');
    const hasGeomSubsetBindings = subsetChildren.some((s) => !!resolveMaterialBinding(s, rootPrim, bindingRootForMaterials));

    const hasBoundMaterial = !!resolveMaterialBinding(node.prim, rootPrim, bindingRootForMaterials) || hasGeomSubsetBindings;
    if (USDDEBUG) dbg(`[Mesh] ${node.path}: hasBoundMaterial=${hasBoundMaterial}, mat.color=${(mat as any).color?.getHexString?.()}, mat.vertexColors=${(mat as any).vertexColors}`);
    if (!hasBoundMaterial) {
        // Viewer fallback for meshes with no bound material and no authored displayColor.
        // Keep this neutral so it doesn't look like an authored "yellow" material.
        (mat as THREE.MeshStandardMaterial).color.setHex(0x888888);
        (mat as THREE.MeshStandardMaterial).roughness = 0.9;
        if (USDDEBUG) dbg(`[Mesh] ${node.path}: No bound material -> set default gray color`);
    }

    // If there's no bound material, prefer USD viewport color primvar (primvars:displayColor) for base color.
    // This covers common cases like displayColor.usda where displayColor is authored as a single constant value.
    if (!hasBoundMaterial && mat instanceof THREE.MeshStandardMaterial) {
        const dcProp = node.prim.properties?.get('primvars:displayColor');
        const dc = parseTuple3ArrayToFloat32(dcProp?.defaultValue);
        const dcInterp = getPropMetadataString(dcProp, 'interpolation') ?? 'constant';
        if (dc && dc.length >= 3 && (dcInterp === 'constant' || dcInterp === 'uniform')) {
            mat.color.setRGB(dc[0] ?? 1, dc[1] ?? 1, dc[2] ?? 1);
            if (USDDEBUG) dbg(`[Mesh] ${node.path}: Applied displayColor rgb(${dc[0]}, ${dc[1]}, ${dc[2]})`);
        }
    }

    const realGeom = buildUsdMeshGeometry(node.prim, unitScale);
    if (realGeom) {
        // Vertex colors are commonly authored as primvars:displayColor for viewport fallback.
        // IMPORTANT: do NOT automatically enable them when a material is bound; that would multiply-tint
        // authored materials (e.g. PointInstancer simpleTree leaves would become brown).
        const hasColors = !!realGeom.getAttribute('color');
        if (USDDEBUG) dbg(`[Mesh] ${node.path}: hasColors=${hasColors}, hasBoundMaterial=${hasBoundMaterial}`);
        if (hasColors && (mat as any)) {
            if (!hasBoundMaterial) {
                // No bound material: use vertex colors as the primary appearance.
                (mat as any).vertexColors = true;
                if ((mat as any).color?.setHex) (mat as any).color.setHex(0xffffff);
                if (USDDEBUG) dbg(`[Mesh] ${node.path}: Enabled vertexColors (no bound material)`);
            } else if ((mat as any).vertexColors) {
                // Material explicitly requested vertex colors (e.g. UsdPreviewSurface driven by PrimvarReader_float3).
                if ((mat as any).color?.setHex) (mat as any).color.setHex(0xffffff);
                if (USDDEBUG) dbg(`[Mesh] ${node.path}: Kept vertexColors (explicitly requested by material)`);
            } else {
                if (USDDEBUG) dbg(`[Mesh] ${node.path}: NOT enabling vertexColors (has bound material)`);
            }
        }
        if (USDDEBUG) dbg(`[Mesh] ${node.path}: FINAL mat.color=${(mat as any).color?.getHexString?.()}, mat.vertexColors=${(mat as any).vertexColors}`);

        // Check for skeleton binding
        const skelSkeletonRel = node.prim.properties?.get('skel:skeleton');
        const skelSkeletonVal: any = skelSkeletonRel?.defaultValue;
        const skelSkeletonPath =
            (skelSkeletonVal && typeof skelSkeletonVal === 'object' && skelSkeletonVal.type === 'sdfpath')
                ? skelSkeletonVal.value as string
                : null;

        if (skelSkeletonPath) {
            renderUsdSkinnedMesh({ container, node, rootPrim, sceneRef, geom: realGeom, mat, USDDEBUG, dbg });
        } else {
            // Regular mesh without skinning. Apply GeomSubset material bindings (USD's per-face materials)
            // when present by creating geometry groups + a multi-material array.
            const subsetApplied = applyGeomSubsetMaterials({
                meshPrim: node.prim,
                rootPrim,
                bindingRootForMaterials,
                geom: realGeom,
                baseMaterial: mat,
                resolveMaterial,
                applySidedness,
            });
            // IMPORTANT: Three.js only renders multi-material meshes when geometry.groups is populated.
            // If we pass `[mat]` (array) but have zero groups, WebGLRenderer will draw *no triangles*.
            // So only pass an array when we actually applied GeomSubset groups.
            const materialForMesh: THREE.Material | THREE.Material[] = subsetApplied.didApply
                ? subsetApplied.materials
                : subsetApplied.materials[0]!;
            const mesh = new THREE.Mesh(realGeom, materialForMesh);
            mesh.name = node.path;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            container.add(mesh);
        }
    } else {
        const b = computePointsBounds(getPrimProp(node.prim, 'points'));
        if (b) {
            if (unitScale !== 1.0) {
                b.min.multiplyScalar(unitScale);
                b.max.multiplyScalar(unitScale);
            }
            const g = new THREE.BoxGeometry(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
            const mesh = new THREE.Mesh(g, mat);
            mesh.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            container.add(mesh);
        }
    }
}



