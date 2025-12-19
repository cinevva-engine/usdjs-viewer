import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import type { SceneNode } from '../types';
import { getPrimProp } from '../usdAnim';
import { getPropMetadataString, parseNumberArray, parsePoint3ArrayToFloat32 } from '../usdParse';

export function renderBasisCurvesPrim(opts: {
    container: THREE.Object3D;
    node: SceneNode;
    unitScale: number;
    resolveMaterial: (prim: SdfPrimSpec) => THREE.Material;
    applySidedness: (prim: SdfPrimSpec, mat: THREE.Material | THREE.Material[]) => void;
}): void {
    const { container, node, unitScale, resolveMaterial, applySidedness } = opts;

    const points = parsePoint3ArrayToFloat32(getPrimProp(node.prim, 'points'));
    const curveVertexCounts = parseNumberArray(getPrimProp(node.prim, 'curveVertexCounts'));
    if (!points || points.length < 3 || !curveVertexCounts || curveVertexCounts.length === 0) {
        console.warn('BasisCurves prim missing points or curveVertexCounts:', node.path);
    } else {
        // Apply unit scale
        if (unitScale !== 1.0) {
            for (let i = 0; i < points.length; i++) points[i] = points[i]! * unitScale;
        }

        const tokenOrString = (v: any): string | null => {
            if (typeof v === 'string') return v;
            if (v && typeof v === 'object' && typeof v.value === 'string') return v.value;
            return null;
        };

        const basis = tokenOrString(getPrimProp(node.prim, 'basis')) ?? 'bezier';
        const curveType = tokenOrString(getPrimProp(node.prim, 'type')) ?? 'linear';
        const wrap = tokenOrString(getPrimProp(node.prim, 'wrap')) ?? 'nonperiodic';
        const closed = wrap === 'periodic';

        // Widths: constant or varying. We'll pick a single width per curve.
        const widthsProp = node.prim.properties?.get('widths');
        const widthsInterp = getPropMetadataString(widthsProp, 'interpolation') ?? 'constant';
        let widths: number[] | null = null;
        const widthsVal = getPrimProp(node.prim, 'widths');
        if (widthsVal && typeof widthsVal === 'object' && (widthsVal as any).type === 'array') {
            const arr = (widthsVal as any).value as unknown[];
            widths = arr.map((x) => (typeof x === 'number' ? x : 0));
        }

        // Resolve appearance: prefer bound material color if present, otherwise default orange.
        const boundMat = resolveMaterial(node.prim);
        const boundColorHex =
            (boundMat as any)?.color?.isColor && typeof (boundMat as any).color.getHex === 'function'
                ? (boundMat as any).color.getHex()
                : 0xff9f4a;

        const curvesGroup = new THREE.Object3D();
        curvesGroup.name = `${node.path}__BasisCurves`;

        // Walk the flat points array with curveVertexCounts.
        let cursor = 0;
        for (let curveIdx = 0; curveIdx < curveVertexCounts.length; curveIdx++) {
            const n = curveVertexCounts[curveIdx] ?? 0;
            if (n <= 1) {
                cursor += Math.max(0, n) * 3;
                continue;
            }

            const pts: THREE.Vector3[] = [];
            for (let i = 0; i < n; i++) {
                const x = points[cursor + i * 3 + 0] ?? 0;
                const y = points[cursor + i * 3 + 1] ?? 0;
                const z = points[cursor + i * 3 + 2] ?? 0;
                pts.push(new THREE.Vector3(x, y, z));
            }
            cursor += n * 3;

            // Pick an approximate width for this curve.
            let width = 0;
            if (widths && widths.length > 0) {
                if (widthsInterp === 'constant' || widthsInterp === 'uniform') {
                    width = widths[0] ?? 0;
                } else if (widthsInterp === 'varying') {
                    // Many exporters put 2 values per curve (start/end), with zeros used for tapering.
                    // Use the first non-zero value among the curve's "slot" if present, else fall back.
                    const a = widths[curveIdx * 2] ?? widths[curveIdx] ?? widths[0] ?? 0;
                    const b = widths[curveIdx * 2 + 1] ?? 0;
                    width = Math.max(a, b);
                } else {
                    width = widths[0] ?? 0;
                }
            }

            const wantTube = width > 0;

            if (curveType === 'cubic' && basis === 'bezier') {
                // Piecewise cubic bezier: first segment uses 4 control points, subsequent segments add 3 points.
                // Segment count is typically (n - 1) / 3 for nonperiodic.
                const path = new THREE.CurvePath<THREE.Vector3>();
                for (let i = 0; i + 3 < pts.length; i += 3) {
                    const c = new THREE.CubicBezierCurve3(pts[i]!, pts[i + 1]!, pts[i + 2]!, pts[i + 3]!);
                    path.add(c);
                }

                if (wantTube) {
                    const radius = Math.max(1e-6, (width * unitScale) * 0.5);
                    const tubularSegments = Math.max(32, pts.length * 8);
                    const geo = new THREE.TubeGeometry(path, tubularSegments, radius, 8, closed);
                    const mat = new THREE.MeshStandardMaterial({ color: boundColorHex, roughness: 0.9, metalness: 0.0 });
                    applySidedness(node.prim, mat);
                    const mesh = new THREE.Mesh(geo, mat);
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    curvesGroup.add(mesh);
                } else {
                    // Sample the curve into a polyline.
                    const sampled: THREE.Vector3[] = [];
                    for (const c of path.curves) {
                        const segPts = c.getPoints(24);
                        for (let i = 0; i < segPts.length; i++) {
                            // Avoid duplicating the shared endpoint between segments.
                            if (sampled.length > 0 && i === 0) continue;
                            sampled.push(segPts[i]!);
                        }
                    }
                    const geo = new THREE.BufferGeometry().setFromPoints(sampled);
                    const mat = new THREE.LineBasicMaterial({ color: boundColorHex });
                    (mat as any).linewidth = Math.max(1, width); // most platforms ignore >1, but keep it
                    const line = new THREE.Line(geo, mat);
                    curvesGroup.add(line);
                }
            } else if (curveType === 'cubic') {
                // Fallback cubic: use Catmull-Rom to get a smooth curve.
                const cr = new THREE.CatmullRomCurve3(pts, closed, 'centripetal', 0.5);
                if (wantTube) {
                    const radius = Math.max(1e-6, (width * unitScale) * 0.5);
                    const tubularSegments = Math.max(32, pts.length * 8);
                    const geo = new THREE.TubeGeometry(cr, tubularSegments, radius, 8, closed);
                    const mat = new THREE.MeshStandardMaterial({ color: boundColorHex, roughness: 0.9, metalness: 0.0 });
                    applySidedness(node.prim, mat);
                    const mesh = new THREE.Mesh(geo, mat);
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    curvesGroup.add(mesh);
                } else {
                    const geo = new THREE.BufferGeometry().setFromPoints(cr.getPoints(Math.max(32, pts.length * 8)));
                    const mat = new THREE.LineBasicMaterial({ color: boundColorHex });
                    (mat as any).linewidth = Math.max(1, width);
                    curvesGroup.add(new THREE.Line(geo, mat));
                }
            } else {
                // Linear: polyline between authored points
                if (wantTube) {
                    // Use a CurvePath of straight segments so thickness is visible.
                    const path = new THREE.CurvePath<THREE.Vector3>();
                    for (let i = 0; i + 1 < pts.length; i++) {
                        path.add(new THREE.LineCurve3(pts[i]!, pts[i + 1]!));
                    }
                    if (closed && pts.length > 2) path.add(new THREE.LineCurve3(pts[pts.length - 1]!, pts[0]!));
                    const radius = Math.max(1e-6, (width * unitScale) * 0.5);
                    const tubularSegments = Math.max(16, pts.length * 4);
                    const geo = new THREE.TubeGeometry(path, tubularSegments, radius, 8, closed);
                    const mat = new THREE.MeshStandardMaterial({ color: boundColorHex, roughness: 0.9, metalness: 0.0 });
                    applySidedness(node.prim, mat);
                    const mesh = new THREE.Mesh(geo, mat);
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    curvesGroup.add(mesh);
                } else {
                    const geo = new THREE.BufferGeometry().setFromPoints(pts);
                    const mat = new THREE.LineBasicMaterial({ color: boundColorHex });
                    (mat as any).linewidth = Math.max(1, width);
                    curvesGroup.add(new THREE.Line(geo, mat));
                }
            }
        }

        container.add(curvesGroup);
    }
}


