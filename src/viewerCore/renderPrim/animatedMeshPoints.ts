import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import type { AnimatedObject } from '../types';
import { primHasAnimatedPoints } from '../usdAnim';

export function trackAnimatedMeshPoints(opts: {
    typeName: string;
    container: THREE.Object3D;
    prim: SdfPrimSpec;
    unitScale: number;
    animatedObjects?: AnimatedObject[];
}): void {
    const { typeName, container, prim, unitScale, animatedObjects } = opts;

    // Points (point cloud) support (e.g. PointClouds.usda)
    // IMPORTANT: Some USD samples (notably usd-wg-assets teapot animCycle) animate meshes by authoring
    // `points.timeSamples` (vertex deformation) rather than xformOp time samples. Track those meshes here so
    // playback can update vertex positions.
    if (typeName === 'Mesh' && animatedObjects && primHasAnimatedPoints(prim)) {
        const geoms: THREE.BufferGeometry[] = [];
        container.traverse((o) => {
            const anyO: any = o as any;
            const g = anyO?.geometry;
            if (g && g instanceof THREE.BufferGeometry) {
                const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
                if (pos && pos.array && pos.itemSize === 3) {
                    geoms.push(g);
                    // Animated vertex data can move outside original bounds; avoid accidental culling.
                    if ('frustumCulled' in anyO) anyO.frustumCulled = false;
                }
            }
        });
        if (geoms.length > 0) {
            animatedObjects.push({ kind: 'points', geoms, prim, unitScale });
        }
    }
}


