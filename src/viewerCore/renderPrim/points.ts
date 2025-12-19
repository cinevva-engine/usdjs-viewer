import * as THREE from 'three';

import type { SceneNode } from '../types';
import { getPrimProp } from '../usdAnim';
import { parsePoint3ArrayToFloat32, parseTuple3ArrayToFloat32 } from '../usdParse';

export function renderPointsPrim(opts: {
    container: THREE.Object3D;
    node: SceneNode;
    unitScale: number;
}): void {
    const { container, node, unitScale } = opts;

    const points = parsePoint3ArrayToFloat32(getPrimProp(node.prim, 'points'));
    if (!points || points.length < 3) {
        console.warn('Points prim missing points:', node.path);
    } else {
        // Apply unit scale
        if (unitScale !== 1.0) {
            for (let i = 0; i < points.length; i++) points[i] = points[i]! * unitScale;
        }

        // Parse per-point colors (primvars:displayColor)
        const displayColorProp = node.prim.properties?.get('primvars:displayColor');
        const displayColors = parseTuple3ArrayToFloat32(displayColorProp?.defaultValue);

        // Parse per-point widths
        const widthsProp = getPrimProp(node.prim, 'widths');
        let widths: Float32Array | null = null;
        if (widthsProp && typeof widthsProp === 'object' && (widthsProp as any).type === 'array') {
            const arr = (widthsProp as any).value as unknown[];
            widths = new Float32Array(arr.length);
            for (let i = 0; i < arr.length; i++) {
                widths[i] = typeof arr[i] === 'number' ? (arr[i] as number) : 1.0;
            }
        }

        const numPoints = points.length / 3;

        // Create BufferGeometry for points
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(points, 3));

        // Add colors if present
        if (displayColors && displayColors.length >= numPoints * 3) {
            geom.setAttribute('color', new THREE.BufferAttribute(displayColors, 3));
        }

        // Check if we have per-point varying widths
        const hasVaryingWidths = widths && widths.length >= numPoints && new Set(widths).size > 1;

        // Create circular point texture (disc instead of square)
        const circleCanvas = document.createElement('canvas');
        circleCanvas.width = 64;
        circleCanvas.height = 64;
        const ctx = circleCanvas.getContext('2d');
        if (ctx) {
            ctx.beginPath();
            ctx.arc(32, 32, 30, 0, Math.PI * 2);
            ctx.fillStyle = 'white';
            ctx.fill();
        }
        const circleTexture = new THREE.CanvasTexture(circleCanvas);

        const hasColors = !!(displayColors && displayColors.length >= numPoints * 3);
        let pointsObj: THREE.Points;

        if (hasVaryingWidths) {
            // Use custom ShaderMaterial for per-point sizes
            // Apply unit scale to widths. USD widths are diameters, but Three.js's sizeAttenuation
            // formula produces points that appear as radius-sized, so we multiply by 2.
            const scaledWidths = new Float32Array(widths!.length);
            for (let i = 0; i < widths!.length; i++) {
                scaledWidths[i] = widths![i]! * unitScale * 2.0;
            }
            geom.setAttribute('size', new THREE.BufferAttribute(scaledWidths, 1));

            // Use the exact same formula as THREE.PointsMaterial with sizeAttenuation:
            // gl_PointSize = size * (scale / -mvPosition.z)
            // where scale = canvasHeight / 2.0 (set dynamically via onBeforeRender)
            const vertexShader = `
          uniform float scale;
          attribute float size;
          ${hasColors ? 'attribute vec3 color;' : ''}
          ${hasColors ? 'varying vec3 vColor;' : ''}
          void main() {
            ${hasColors ? 'vColor = color;' : ''}
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            // Exact THREE.js PointsMaterial sizeAttenuation formula
            gl_PointSize = size * (scale / -mvPosition.z);
            gl_Position = projectionMatrix * mvPosition;
          }
        `;

            const fragmentShader = `
          uniform sampler2D pointTexture;
          ${hasColors ? 'varying vec3 vColor;' : ''}
          void main() {
            vec4 texColor = texture2D(pointTexture, gl_PointCoord);
            if (texColor.a < 0.5) discard;
            ${hasColors ? 'gl_FragColor = vec4(vColor, 1.0) * texColor;' : 'gl_FragColor = vec4(1.0, 0.62, 0.29, 1.0) * texColor;'}
          }
        `;

            const shaderMat = new THREE.ShaderMaterial({
                uniforms: {
                    pointTexture: { value: circleTexture },
                    scale: { value: 1.0 }, // Will be updated in onBeforeRender
                },
                vertexShader,
                fragmentShader,
                transparent: true,
            });

            pointsObj = new THREE.Points(geom, shaderMat);

            // Update scale uniform before each render using the exact THREE.js formula:
            // scale = renderer.getDrawingBufferSize().height / 2
            pointsObj.onBeforeRender = (renderer: THREE.WebGLRenderer) => {
                const size = renderer.getDrawingBufferSize(new THREE.Vector2());
                shaderMat.uniforms.scale!.value = size.height / 2.0;
            };
        } else {
            // Use standard PointsMaterial for uniform sizes
            // USD widths are diameters, but Three.js's sizeAttenuation formula produces points
            // that appear as radius-sized, so we multiply by 2.
            let pointSize = 2.0; // default size in world units (diameter)
            if (widths && widths.length > 0) {
                pointSize = widths[0]! * unitScale * 2.0;
            }

            const mat = new THREE.PointsMaterial({
                size: pointSize,
                sizeAttenuation: true,
                vertexColors: hasColors,
                color: hasColors ? 0xffffff : 0xff9f4a,
                map: circleTexture,
                alphaTest: 0.5,
                transparent: true,
            });

            pointsObj = new THREE.Points(geom, mat);
        }

        container.add(pointsObj);
    }
}


