import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import type { SceneNode } from '../../types';
import { findNearestSkelRootPrim, findPrimByPath } from '../../usdPaths';
import { buildJointOrderIndexToBoneIndex, extractJointOrderNames } from '../../usdSkeleton';
import { getPropMetadataNumber, parseNumberArray } from '../../usdParse';
import { parseMatrix4d } from '../../threeXform';

// Baseline mode: get correct static deformation in rest/original pose first.
// (We’ll re-enable animation once bind-space is verified.)
const ENABLE_USD_SKEL_ANIM = false;

type PendingSkinnedMesh = {
    container: THREE.Object3D;
    placeholder: THREE.Object3D;
    geom: THREE.BufferGeometry;
    mat: THREE.Material;
    skelSkeletonPath: string;
    jointIndices: ArrayLike<number>;
    jointWeights: ArrayLike<number>;
    elementSize: number;
    jointOrderNames: string[] | null;
};

export function renderUsdSkinnedMesh(opts: {
    container: THREE.Object3D;
    node: SceneNode;
    rootPrim: SdfPrimSpec;
    sceneRef: THREE.Scene;
    geom: THREE.BufferGeometry;
    mat: THREE.Material;
    USDDEBUG: boolean;
    dbg: (...args: any[]) => void;
}): void {
    const { container, node, rootPrim, sceneRef, geom: realGeom, mat, USDDEBUG, dbg } = opts;

    // Check for skeleton binding
    const skelSkeletonRel = node.prim.properties?.get('skel:skeleton');
    const skelSkeletonVal: any = skelSkeletonRel?.defaultValue;
    const skelSkeletonPath = (skelSkeletonVal && typeof skelSkeletonVal === 'object' && skelSkeletonVal.type === 'sdfpath')
        ? skelSkeletonVal.value as string
        : null;

    if (!skelSkeletonPath) {
        // caller decides non-skinning path
        return;
    }

    // This mesh is bound to a skeleton - use SkinnedMesh
    if (USDDEBUG) dbg(`[Mesh] ${node.path}: Has skel:skeleton binding to ${skelSkeletonPath}`);

    // Parse joint indices and weights
    const jointIndicesProp = node.prim.properties?.get('primvars:skel:jointIndices');
    const jointWeightsProp = node.prim.properties?.get('primvars:skel:jointWeights');
    const jointIndicesVal = jointIndicesProp?.defaultValue;
    const jointWeightsVal = jointWeightsProp?.defaultValue;
    const elementSize = getPropMetadataNumber(jointIndicesProp, 'elementSize') ?? 4;

    let jointIndices: ArrayLike<number> | null = null;
    let jointWeights: ArrayLike<number> | null = null;

    jointIndices = parseNumberArray(jointIndicesVal as any);
    jointWeights = parseNumberArray(jointWeightsVal as any);

    // Find the skeleton in the scene graph
    // Walk up to find SkelRoot, then find the Skeleton container with __usdSkeleton
    let skelContainer: THREE.Object3D | null = null;
    const skelPrim = findPrimByPath(rootPrim, skelSkeletonPath);
    if (skelPrim) {
        // Find the container for the skeleton prim by walking up the tree
        const findContainer = (obj: THREE.Object3D, primPath: string): THREE.Object3D | null => {
            if (obj.name === primPath || obj.name.endsWith(primPath)) {
                return obj;
            }
            for (const child of obj.children) {
                const found = findContainer(child, primPath);
                if (found) return found;
            }
            return null;
        };
        skelContainer = findContainer(sceneRef, skelSkeletonPath);
    }

    const skeleton = skelContainer ? (skelContainer as any).__usdSkeleton as THREE.Skeleton | undefined : undefined;
    const jointNames = skelContainer ? (skelContainer as any).__usdJointNames as string[] | undefined : undefined;

    // Compute joint order now (independent of whether the Skeleton has been rendered yet).
    const skelRootPrim = findNearestSkelRootPrim(rootPrim, node.path);
    const jointOrderNames =
        extractJointOrderNames(skelRootPrim) ??
        extractJointOrderNames(node.prim) ??
        extractJointOrderNames(skelPrim);

    if (skeleton && jointIndices && jointWeights && jointNames) {
        if (USDDEBUG) dbg(`[Mesh] ${node.path}: Found skeleton with ${skeleton.bones.length} bones`);

        // Create skinning attributes
        // IMPORTANT: skinIndex MUST use Uint16Array (unsigned integers), not Float32Array!
        // Three.js requires integer types for bone indices to work with the skinning shader
        const vertexCount = realGeom.getAttribute('position').count;
        const skinIndices = new Uint16Array(vertexCount * 4);
        const skinWeights = new Float32Array(vertexCount * 4);

        // Check if geometry was de-indexed (has _originalPointIndex attribute)
        // If so, use it to look up skinning data per original point
        const origPointIdxAttr = realGeom.getAttribute('_originalPointIndex');
        const origPointIndices = origPointIdxAttr ? origPointIdxAttr.array as Uint32Array : null;

        // USD joint indices are indexed in skel:jointOrder space (when authored). Remap them to
        // the skeleton's joint order so the correct bones influence vertices.
        const jointIndexRemap = buildJointOrderIndexToBoneIndex(jointNames, jointOrderNames);

        // USD joint indices are stored with elementSize per vertex (original points)
        // We need to map them to our de-indexed vertices using originalPointIndex
        for (let v = 0; v < vertexCount; v++) {
            // Get the original point index (before de-indexing), or use v for indexed geometry
            const origPtIdx = origPointIndices ? origPointIndices[v]! : v;

            for (let j = 0; j < 4; j++) {
                const srcIdx = origPtIdx * elementSize + j;
                if (srcIdx < jointIndices.length) {
                    const ji = jointIndices[srcIdx] ?? 0;
                    const mapped = jointIndexRemap ? (jointIndexRemap[ji] ?? 0) : ji;
                    skinIndices[v * 4 + j] = mapped;
                } else {
                    skinIndices[v * 4 + j] = 0;
                }
                if (srcIdx < jointWeights.length) {
                    skinWeights[v * 4 + j] = jointWeights[srcIdx] ?? 0;
                } else {
                    skinWeights[v * 4 + j] = 0;
                }
            }

            // Normalize weights (exporters sometimes don't normalize or include padding influences).
            const w0 = skinWeights[v * 4 + 0]!;
            const w1 = skinWeights[v * 4 + 1]!;
            const w2 = skinWeights[v * 4 + 2]!;
            const w3 = skinWeights[v * 4 + 3]!;
            const sum = w0 + w1 + w2 + w3;
            if (sum > 0 && Math.abs(sum - 1.0) > 1e-4) {
                const inv = 1.0 / sum;
                skinWeights[v * 4 + 0] = w0 * inv;
                skinWeights[v * 4 + 1] = w1 * inv;
                skinWeights[v * 4 + 2] = w2 * inv;
                skinWeights[v * 4 + 3] = w3 * inv;
            }
        }

        realGeom.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndices, 4));
        realGeom.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeights, 4));

        // Create SkinnedMesh
        // IMPORTANT: built-in Three.js materials require `material.skinning = true` to actually deform.
        (mat as any).skinning = true;
        (mat as any).needsUpdate = true;
        const skinnedMesh = new THREE.SkinnedMesh(realGeom, mat);
        skinnedMesh.castShadow = true;
        skinnedMesh.receiveShadow = true;
        // Add to scene graph before binding so matrixWorld is valid.
        container.add(skinnedMesh);

        // Find the skeleton root object (the object containing the bones)
        // Important: use the ORIGINAL bones, not clones, because skeleton.bones references them
        const skelRoot = skelContainer?.children.find(c => c.name.includes('skeleton_root'));
        if (skelRoot) {
            // Read skel:geomBindTransform if present
            const geomBindTransformProp = node.prim.properties?.get('skel:geomBindTransform');
            const geomBindTransform = parseMatrix4d(geomBindTransformProp?.defaultValue);
            
            // Do NOT reparent bones under the mesh; it changes bone world transforms and can distort skinning.
            skinnedMesh.updateMatrixWorld(true);
            skelRoot.updateMatrixWorld(true);
            
            // USD uses geomBindTransform to transform mesh vertices to skeleton space before skinning
            // If not present, use identity (mesh is assumed to be in skeleton space)
            let bindMatrix: THREE.Matrix4;
            if (geomBindTransform) {
                bindMatrix = geomBindTransform.clone();
            } else {
                // Default: identity (mesh is in skeleton space)
                bindMatrix = new THREE.Matrix4();
            }
            skinnedMesh.bind(skeleton, bindMatrix);
            if (USDDEBUG) dbg(`[Mesh] ${node.path}: Bound SkinnedMesh to skeleton, bones:`, skeleton.bones.length);

            // Debug: log skinning attributes
            const skinIdxAttr = realGeom.getAttribute('skinIndex');
            const skinWtAttr = realGeom.getAttribute('skinWeight');
            if (USDDEBUG) {
                dbg(`[Mesh] ${node.path}: skinIndex count=${skinIdxAttr?.count}, skinWeight count=${skinWtAttr?.count}`);
                dbg(
                    `[Mesh] ${node.path}: First few skinIndex:`,
                    skinIdxAttr ? Array.from(skinIdxAttr.array.slice(0, 16)) : 'none',
                );
                dbg(
                    `[Mesh] ${node.path}: First few skinWeight:`,
                    skinWtAttr ? Array.from(skinWtAttr.array.slice(0, 16)) : 'none',
                );
            }

            // Count non-zero bone indices and find which bones are used
            if (skinIdxAttr && skinWtAttr) {
                const idxArr = skinIdxAttr.array as Uint16Array;
                const wtArr = skinWtAttr.array as Float32Array;
                const boneCounts = new Map<number, number>();
                for (let i = 0; i < idxArr.length; i++) {
                    const boneIdx = idxArr[i]!;
                    boneCounts.set(boneIdx, (boneCounts.get(boneIdx) || 0) + 1);
                }
                if (USDDEBUG) dbg(`[Mesh] ${node.path}: Bone index distribution:`, Object.fromEntries(boneCounts));

                // Find vertices influenced by bone 1 (should bend)
                const posAttr = realGeom.getAttribute('position');
                let bone1Vertices = 0;
                let maxWeight1 = 0;
                for (let v = 0; v < vertexCount; v++) {
                    for (let j = 0; j < 4; j++) {
                        if (idxArr[v * 4 + j] === 1 && wtArr[v * 4 + j]! > 0.01) {
                            bone1Vertices++;
                            maxWeight1 = Math.max(maxWeight1, wtArr[v * 4 + j]!);
                            // Log a few details
                            if (bone1Vertices <= 5) {
                                const y = posAttr ? posAttr.getY(v) : 0;
                                if (USDDEBUG) {
                                    dbg(
                                        `[Mesh] Vertex ${v} (y=${y.toFixed(3)}): skinIdx=[${idxArr[v * 4]},${idxArr[v * 4 + 1]},${idxArr[v * 4 + 2]},${idxArr[v * 4 + 3]}] skinWt=[${wtArr[v * 4]?.toFixed(2)},${wtArr[v * 4 + 1]?.toFixed(2)},${wtArr[v * 4 + 2]?.toFixed(2)},${wtArr[v * 4 + 3]?.toFixed(2)}]`,
                                    );
                                }
                            }
                            break;
                        }
                    }
                }
                if (USDDEBUG) dbg(`[Mesh] ${node.path}: Vertices influenced by bone 1: ${bone1Vertices}, max weight: ${maxWeight1.toFixed(3)}`);

                // Log original point index distribution
                if (origPointIndices) {
                    if (USDDEBUG) dbg(`[Mesh] ${node.path}: origPointIndices sample (first 20):`, Array.from(origPointIndices.slice(0, 20)));
                    const midPt = Math.floor(origPointIndices.length / 2);
                    if (USDDEBUG) dbg(`[Mesh] ${node.path}: origPointIndices sample (mid ${midPt}):`, Array.from(origPointIndices.slice(midPt, midPt + 20)));
                }

                // Log skeleton bone inverses
                if (USDDEBUG) {
                    dbg(
                        `[Mesh] ${node.path}: skeleton.boneInverses:`,
                        skeleton.boneInverses.map((m, i) => {
                            const pos = new THREE.Vector3();
                            const rot = new THREE.Quaternion();
                            const scale = new THREE.Vector3();
                            m.decompose(pos, rot, scale);
                            return `bone${i}: pos=(${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)})`;
                        }),
                    );
                }
            }

            if (ENABLE_USD_SKEL_ANIM) {
                // (intentionally disabled for now — baseline first)
            }
        } else {
            console.warn(`[Mesh] ${node.path}: Could not find skeleton_root`);
        }

    } else {
        // Skeleton may not have been rendered yet due to traversal order.
        // Create a regular Mesh placeholder now and defer actual SkinnedMesh creation/binding until the Skeleton prim shows up.
        console.warn(`[Mesh] ${node.path}: Could not find skeleton for ${skelSkeletonPath}`);

        const placeholder = new THREE.Mesh(realGeom, mat);
        placeholder.castShadow = true;
        placeholder.receiveShadow = true;
        placeholder.name = node.path;
        container.add(placeholder);

        const pendingMap: Map<string, PendingSkinnedMesh[]> =
            ((sceneRef as any).__usdPendingSkins ??= new Map());
        const arr = pendingMap.get(skelSkeletonPath) ?? [];
        arr.push({
            container,
            placeholder,
            geom: realGeom,
            mat,
            skelSkeletonPath,
            jointIndices: jointIndices ?? new Uint16Array(),
            jointWeights: jointWeights ?? new Float32Array(),
            elementSize,
            jointOrderNames,
        });
        pendingMap.set(skelSkeletonPath, arr);
    }
}


