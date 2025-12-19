import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import type { SceneNode } from '../../types';
import { findNearestSkelRootPrim, findPrimByPath } from '../../usdPaths';
import { buildJointOrderIndexToBoneIndex, extractJointOrderNames } from '../../usdSkeleton';
import { getPropMetadataNumber } from '../../usdParse';

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

    let jointIndices: number[] | null = null;
    let jointWeights: number[] | null = null;

    if (jointIndicesVal && typeof jointIndicesVal === 'object' && (jointIndicesVal as any).type === 'array') {
        jointIndices = (jointIndicesVal as any).value.map((x: any) => typeof x === 'number' ? x : 0);
    }
    if (jointWeightsVal && typeof jointWeightsVal === 'object' && (jointWeightsVal as any).type === 'array') {
        jointWeights = (jointWeightsVal as any).value.map((x: any) => typeof x === 'number' ? x : 0);
    }

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
        const skelRootPrim = findNearestSkelRootPrim(rootPrim, node.path);
        const jointOrderNames =
            extractJointOrderNames(skelRootPrim) ??
            extractJointOrderNames(node.prim) ??
            extractJointOrderNames(skelPrim);
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
            // Do NOT reparent bones under the mesh; it changes bone world transforms and can distort skinning.
            // Bind using the mesh's current world matrix so bind space matches the scene graph.
            skinnedMesh.updateMatrixWorld(true);
            skelRoot.updateMatrixWorld(true);
            skinnedMesh.bind(skeleton, skinnedMesh.matrixWorld.clone());
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

            // Check for animation source and apply rotations
            // First check mesh's skel:animationSource, then fallback to skeleton's
            const meshAnimSourceRel = node.prim.properties?.get('skel:animationSource');
            const meshAnimSourceVal: any = meshAnimSourceRel?.defaultValue;
            const skelAnimSourceVal: any = skelPrim?.properties?.get('skel:animationSource')?.defaultValue;

            // Helper to extract path from sdfpath or string
            const getPath = (val: any): string | null => {
                if (val && typeof val === 'object' && val.type === 'sdfpath') return val.value as string;
                if (typeof val === 'string') return val;
                return null;
            };

            // Try mesh's animation source first, then skeleton's (verify prim exists)
            let animPrim: SdfPrimSpec | null = null;
            for (const val of [meshAnimSourceVal, skelAnimSourceVal]) {
                const path = getPath(val);
                if (path) {
                    const prim = findPrimByPath(rootPrim, path);
                    if (prim) {
                        animPrim = prim;
                        if (USDDEBUG) dbg(`[Mesh] ${node.path}: Found animation at ${path}`);
                        break;
                    }
                }
            }

            if (animPrim) {
                // Parse SkelAnimation rotations
                const rotationsProp = animPrim.properties?.get('rotations');
                const rotationsVal = rotationsProp?.defaultValue;
                if (rotationsVal && typeof rotationsVal === 'object' && (rotationsVal as any).type === 'array') {
                    const rotations = (rotationsVal as any).value;
                    if (USDDEBUG) dbg(`[Mesh] ${node.path}: Found SkelAnimation with ${rotations.length} rotations`);

                    // Apply rotations to bones
                    for (let i = 0; i < rotations.length && i < skeleton.bones.length; i++) {
                        const rot = rotations[i];
                        if (rot && rot.type === 'tuple' && rot.value.length >= 4) {
                            // USD quaternions are stored as (w, x, y, z), Three.js expects (x, y, z, w)
                            const [w, x, y, z] = rot.value;
                            skeleton.bones[i]!.quaternion.set(x, y, z, w);
                            // Update bone's local matrix after changing quaternion
                            skeleton.bones[i]!.updateMatrix();
                            if (USDDEBUG) dbg(`[Mesh] Bone ${skeleton.bones[i]!.name} rotation: (${x}, ${y}, ${z}, ${w})`);
                        }
                    }

                    // Traverse bone hierarchy to update world matrices (starting from root bone)
                    // skelRoot contains all bones, so we traverse from there
                    skelRoot.updateMatrixWorld(true);

                    // Update skeleton's bone matrices for skinning
                    skeleton.update();

                    // Debug: log bone world positions after animation
                    for (const bone of skeleton.bones) {
                        const worldPos = new THREE.Vector3();
                        bone.getWorldPosition(worldPos);
                        if (USDDEBUG) dbg(`[Mesh] Bone ${bone.name} worldPos after anim:`, worldPos.toArray());
                    }

                    // Debug: log bone matrices from skeleton (these are what's used for skinning)
                    if (USDDEBUG) dbg(`[Mesh] ${node.path}: skeleton.boneMatrices length:`, skeleton.boneMatrices?.length);
                    if (skeleton.boneMatrices) {
                        for (let i = 0; i < skeleton.bones.length; i++) {
                            const mat = new THREE.Matrix4();
                            mat.fromArray(skeleton.boneMatrices, i * 16);
                            const pos = new THREE.Vector3();
                            const rot = new THREE.Quaternion();
                            const scale = new THREE.Vector3();
                            mat.decompose(pos, rot, scale);
                            if (USDDEBUG) {
                                dbg(
                                    `[Mesh] Bone matrix ${i} (${skeleton.bones[i]!.name}): pos=(${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)}), rot=(${rot.x.toFixed(3)}, ${rot.y.toFixed(3)}, ${rot.z.toFixed(3)}, ${rot.w.toFixed(3)})`,
                                );
                            }
                        }
                    }
                }
            }
        } else {
            console.warn(`[Mesh] ${node.path}: Could not find skeleton_root`);
        }

    } else {
        console.warn(`[Mesh] ${node.path}: Could not find skeleton for ${skelSkeletonPath}`);
        const mesh = new THREE.Mesh(realGeom, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        container.add(mesh);
    }
}


