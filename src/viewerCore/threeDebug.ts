import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import type { ThreeDebugInfo } from './types';

export function getThreeDebugInfo(opts: {
    contentRoot: THREE.Object3D;
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
}): ThreeDebugInfo {
    const { contentRoot, renderer, scene, camera, controls } = opts;

    let objectCount = 0;
    let meshCount = 0;
    let skinnedMeshCount = 0;
    let pointsCount = 0;
    let lineCount = 0;
    const meshes: ThreeDebugInfo['content']['meshes'] = [];
    contentRoot.traverse((o) => {
        objectCount++;
        if ((o as any).isSkinnedMesh) {
            skinnedMeshCount++;
        } else if ((o as any).isMesh) {
            meshCount++;
            const anyO: any = o as any;
            const g: any = anyO.geometry;
            const pos = g?.getAttribute?.('position');
            const idx = g?.index;
            meshes.push({
                name: anyO.name ?? '',
                visible: !!anyO.visible,
                frustumCulled: 'frustumCulled' in anyO ? !!anyO.frustumCulled : true,
                materialType: anyO.material?.type ?? typeof anyO.material,
                geometry: {
                    positionCount: typeof pos?.count === 'number' ? pos.count : 0,
                    indexCount: typeof idx?.count === 'number' ? idx.count : 0,
                    drawRange: {
                        start: typeof g?.drawRange?.start === 'number' ? g.drawRange.start : 0,
                        count: typeof g?.drawRange?.count === 'number' ? g.drawRange.count : 0,
                    },
                    groups: Array.isArray(g?.groups) ? g.groups.length : 0,
                    boundingSphereRadius:
                        typeof g?.boundingSphere?.radius === 'number' ? g.boundingSphere.radius : null,
                },
            });
        } else if ((o as any).isPoints) {
            pointsCount++;
        } else if ((o as any).isLine || (o as any).isLineSegments) {
            lineCount++;
        }
    });

    const r: any = (renderer as any).info?.render ?? {};
    const bg: any = (scene as any).background;
    const backgroundType =
        bg == null ? 'none' : bg?.isColor ? 'Color' : bg?.isTexture ? 'Texture' : typeof bg;

    return {
        content: { objectCount, meshCount, skinnedMeshCount, pointsCount, lineCount, meshes },
        render: {
            calls: typeof r.calls === 'number' ? r.calls : 0,
            triangles: typeof r.triangles === 'number' ? r.triangles : 0,
            points: typeof r.points === 'number' ? r.points : 0,
            lines: typeof r.lines === 'number' ? r.lines : 0,
        },
        camera: {
            position: [camera.position.x, camera.position.y, camera.position.z],
            target: [controls.target.x, controls.target.y, controls.target.z],
            near: camera.near,
            far: camera.far,
            fov: camera.fov,
        },
        scene: {
            backgroundType,
            hasEnvironment: !!scene.environment,
            environmentIntensity:
                typeof (scene as any).environmentIntensity === 'number'
                    ? (scene as any).environmentIntensity
                    : null,
        },
    };
}



