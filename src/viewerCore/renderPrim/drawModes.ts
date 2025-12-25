import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import { getPrimProp } from '../usdAnim';
import { extractToken } from '../materials/valueExtraction';

export function applyUsdGeomModelApiDrawMode(opts: {
    container: THREE.Object3D;
    prim: SdfPrimSpec;
    primPath: string;
    prototypeRootForMaterials?: SdfPrimSpec | null;
}): void {
    const { container, prim, primPath, prototypeRootForMaterials } = opts;

    // Minimal support for UsdGeomModelAPI draw modes (used by Teapot/DrawModes.usd).
    // We currently don't evaluate `extentsHint`, so we derive bounds from the rendered subtree,
    // then hide the full geometry and replace it with a proxy representation.
    //
    // Supported:
    // - model:drawMode = "bounds"  -> wireframe bbox
    // - model:drawMode = "origin"  -> axes at model origin
    // - model:drawMode = "cards"   -> simple card planes (cross/box) using model:cardGeometry
    const drawMode = extractToken(getPrimProp(prim, 'model:drawMode'));

    if (drawMode && drawMode !== 'default' && drawMode !== 'inherited' && drawMode !== 'none') {
        // Don't apply to PointInstancer prototype rendering; those nodes re-use renderPrim() internally.
        if (!prototypeRootForMaterials) {
            container.updateMatrixWorld(true);

            // Compute bounds in container-local space.
            // NOTE: converting only worldBox.min/max back to local space is incorrect for rotated/scaled containers
            // (min/max corners are not preserved under rotation). Instead, transform all 8 world AABB corners.
            const worldBox = new THREE.Box3().setFromObject(container);
            if (!worldBox.isEmpty()) {
                const corners: THREE.Vector3[] = [
                    new THREE.Vector3(worldBox.min.x, worldBox.min.y, worldBox.min.z),
                    new THREE.Vector3(worldBox.min.x, worldBox.min.y, worldBox.max.z),
                    new THREE.Vector3(worldBox.min.x, worldBox.max.y, worldBox.min.z),
                    new THREE.Vector3(worldBox.min.x, worldBox.max.y, worldBox.max.z),
                    new THREE.Vector3(worldBox.max.x, worldBox.min.y, worldBox.min.z),
                    new THREE.Vector3(worldBox.max.x, worldBox.min.y, worldBox.max.z),
                    new THREE.Vector3(worldBox.max.x, worldBox.max.y, worldBox.min.z),
                    new THREE.Vector3(worldBox.max.x, worldBox.max.y, worldBox.max.z),
                ];

                const localBox = new THREE.Box3();
                for (const c of corners) {
                    localBox.expandByPoint(container.worldToLocal(c));
                }
                if (localBox.isEmpty()) return;

                const size = new THREE.Vector3();
                const center = new THREE.Vector3();
                localBox.getSize(size);
                localBox.getCenter(center);
                const localMin = localBox.min.clone();
                const localMax = localBox.max.clone();

                // Snapshot existing children before adding proxy, then hide them.
                const existingChildren = container.children.slice();

                const proxy = new THREE.Object3D();
                proxy.name = `${primPath}/__drawModeProxy`;

                if (drawMode === 'bounds') {
                    const geo = new THREE.BoxGeometry(Math.max(1e-6, size.x), Math.max(1e-6, size.y), Math.max(1e-6, size.z));
                    const edges = new THREE.EdgesGeometry(geo);
                    const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
                    const lines = new THREE.LineSegments(edges, mat);
                    lines.position.copy(center);
                    proxy.add(lines);
                } else if (drawMode === 'origin') {
                    const len = Math.max(0.25, Math.max(size.x, size.y, size.z) * 0.35);
                    const axes = new THREE.AxesHelper(len);
                    proxy.add(axes);
                } else if (drawMode === 'cards') {
                    const cardGeometry = extractToken(getPrimProp(prim, 'model:cardGeometry')) ?? 'cross';

                    const mat = new THREE.MeshBasicMaterial({
                        color: 0x66ccff,
                        transparent: true,
                        opacity: 0.35,
                        side: THREE.DoubleSide,
                        depthWrite: false,
                    });

                    const makePlane = (w: number, h: number) => new THREE.PlaneGeometry(Math.max(1e-6, w), Math.max(1e-6, h));

                    if (cardGeometry === 'box') {
                        // 6 planes on bbox faces.
                        const sx = size.x, sy = size.y, sz = size.z;
                        const cx = center.x, cy = center.y, cz = center.z;

                        const px = new THREE.Mesh(makePlane(sz, sy), mat.clone());
                        px.position.set(localMax.x, cy, cz);
                        px.rotation.y = -Math.PI / 2;
                        proxy.add(px);

                        const nx = new THREE.Mesh(makePlane(sz, sy), mat.clone());
                        nx.position.set(localMin.x, cy, cz);
                        nx.rotation.y = Math.PI / 2;
                        proxy.add(nx);

                        const pz = new THREE.Mesh(makePlane(sx, sy), mat.clone());
                        pz.position.set(cx, cy, localMax.z);
                        pz.rotation.y = Math.PI;
                        proxy.add(pz);

                        const nz = new THREE.Mesh(makePlane(sx, sy), mat.clone());
                        nz.position.set(cx, cy, localMin.z);
                        nz.rotation.y = 0;
                        proxy.add(nz);

                        const py = new THREE.Mesh(makePlane(sx, sz), mat.clone());
                        py.position.set(cx, localMax.y, cz);
                        py.rotation.x = -Math.PI / 2;
                        proxy.add(py);

                        const ny = new THREE.Mesh(makePlane(sx, sz), mat.clone());
                        ny.position.set(cx, localMin.y, cz);
                        ny.rotation.x = Math.PI / 2;
                        proxy.add(ny);
                    } else {
                        // "cross" (default): 2 vertical planes crossing at center.
                        const p1 = new THREE.Mesh(makePlane(size.x, size.y), mat.clone());
                        p1.position.copy(center);
                        p1.rotation.y = 0;
                        proxy.add(p1);

                        const p2 = new THREE.Mesh(makePlane(size.z, size.y), mat.clone());
                        p2.position.copy(center);
                        p2.rotation.y = Math.PI / 2;
                        proxy.add(p2);
                    }
                }

                if (proxy.children.length > 0) {
                    // Hide the full geometry and show proxy instead.
                    for (const ch of existingChildren) ch.visible = false;
                    container.add(proxy);
                }
            }
        }
    }
}


