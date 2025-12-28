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
    const USDDEBUG =
        typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('usddebug');

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
        if (widthsProp && typeof widthsProp === 'object') {
            if ((widthsProp as any).type === 'typedArray' && (widthsProp as any).value instanceof Float32Array) {
                widths = ((widthsProp as any).value as Float32Array).slice();
            } else if ((widthsProp as any).type === 'array') {
                const arr = (widthsProp as any).value as unknown[];
                widths = new Float32Array(arr.length);
                for (let i = 0; i < arr.length; i++) {
                    widths[i] = typeof arr[i] === 'number' ? (arr[i] as number) : 1.0;
                }
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

        // Point sprite texture (circle alpha mask) + alpha-test in fragment shader.
        // This matches the typical "point sprite" look and avoids hard square edges.
        const SPRITE_FILL_SCALE = 1.0;
        const spriteCanvas = document.createElement('canvas');
        spriteCanvas.width = 64;
        spriteCanvas.height = 64;
        const ctx = spriteCanvas.getContext('2d');
        if (ctx) {
            ctx.clearRect(0, 0, spriteCanvas.width, spriteCanvas.height);
            ctx.fillStyle = 'white';
            ctx.beginPath();
            // Leave a small margin so the circle is cleanly antialiased.
            ctx.arc(spriteCanvas.width / 2, spriteCanvas.height / 2, 30, 0, Math.PI * 2, false);
            ctx.closePath();
            ctx.fill();
        }
        const spriteTexture = new THREE.CanvasTexture(spriteCanvas);

        const hasColors = !!(displayColors && displayColors.length >= numPoints * 3);

        // Always use custom ShaderMaterial so behavior is consistent (per-point size/color support),
        // like three.js webgl_custom_attributes_points.
        //
        // Fill per-point `size` attribute:
        // - if widths are authored per-point, use them
        // - if a single width is authored, broadcast it
        // - if unauthored, use the historical default (2.0)
        const scaledSizes = new Float32Array(numPoints);
        const defaultWidth = 1.0;
        const fallbackSize = defaultWidth * unitScale * 2.0 * SPRITE_FILL_SCALE;
        if (widths && widths.length >= numPoints) {
            for (let i = 0; i < numPoints; i++) scaledSizes[i] = widths[i]! * unitScale * 2.0 * SPRITE_FILL_SCALE;
        } else if (widths && widths.length > 0) {
            const s = widths[0]! * unitScale * 2.0 * SPRITE_FILL_SCALE;
            scaledSizes.fill(s);
        } else {
            scaledSizes.fill(fallbackSize);
        }
        geom.setAttribute('size', new THREE.BufferAttribute(scaledSizes, 1));

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
            // Alpha-test: discard fragments outside the sprite mask.
            if (texColor.a < 0.5) discard;
            ${hasColors ? 'gl_FragColor = vec4(vColor, 1.0) * texColor;' : 'gl_FragColor = vec4(1.0, 0.62, 0.29, 1.0) * texColor;'}
          }
        `;

        const shaderMat = new THREE.ShaderMaterial({
            uniforms: {
                pointTexture: { value: spriteTexture },
                scale: { value: 1.0 }, // Will be updated in onBeforeRender
            },
            vertexShader,
            fragmentShader,
            transparent: true,
        });

        const pointsObj = new THREE.Points(geom, shaderMat);

        // Update scale uniform before each render using the exact THREE.js formula:
        // scale = renderer.getDrawingBufferSize().height / 2
        pointsObj.onBeforeRender = (renderer: THREE.WebGLRenderer, _scene, camera) => {
            const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
            const scale = buf.height / 2.0;
            shaderMat.uniforms.scale!.value = scale;

            // One-shot debug: print the exact computed sprite size numbers for the first point.
            // Restrict to points1 to keep output deterministic.
            if (USDDEBUG && node.path.endsWith('/points1') && !(pointsObj as any).__usdjsLoggedPointSize) {
                (pointsObj as any).__usdjsLoggedPointSize = true;

                const posAttr = geom.getAttribute('position') as THREE.BufferAttribute | undefined;
                const sizeAttr = geom.getAttribute('size') as THREE.BufferAttribute | undefined;
                if (posAttr && sizeAttr && posAttr.count > 0 && sizeAttr.count > 0) {
                    const localP = new THREE.Vector3(
                        posAttr.getX(0),
                        posAttr.getY(0),
                        posAttr.getZ(0),
                    );
                    const worldP = localP.clone().applyMatrix4(pointsObj.matrixWorld);
                    const viewP = worldP.clone().applyMatrix4(camera.matrixWorldInverse);

                    // This is exactly what the vertex shader uses:
                    // gl_PointSize = size * (scale / -mvPosition.z)
                    const size0 = sizeAttr.getX(0);
                    const mvZ = viewP.z; // equals mvPosition.z for this vertex
                    const glPointSizePx = size0 * (scale / -mvZ);

                    // Our sprite mask is a 64x64 texture with a circle of radius 30px (diameter 60px),
                    // centered, leaving 2px transparent margin on each side.
                    const texSize = 64;
                    const circleRadiusPx = 30;
                    const circleDiameterPx = 60;
                    const marginPx = (texSize - circleDiameterPx) / 2; // 2

                    const visibleRadiusPx = glPointSizePx * (circleRadiusPx / texSize);
                    const visibleDiameterPx = glPointSizePx * (circleDiameterPx / texSize);
                    const visibleMarginPx = glPointSizePx * (marginPx / texSize);

                    const payload = {
                        node: node.path,
                        unitScale,
                        widths0: widths?.[0] ?? null,
                        sizeAttr0_worldUnits: size0,
                        drawingBuffer: { w: buf.width, h: buf.height },
                        scale_halfHeight: scale,
                        mvPositionZ: mvZ,
                        gl_PointSize_px: glPointSizePx,
                        spriteMask: {
                            texSize,
                            circleRadiusPx,
                            circleDiameterPx,
                            marginPx,
                            visibleRadiusPx,
                            visibleDiameterPx,
                            visibleMarginPx,
                        },
                    };
                    // eslint-disable-next-line no-console
                    console.log('[usdjs-viewer:points] points1[0] size math ' + JSON.stringify(payload));
                }
            }
        };

        container.add(pointsObj);
    }
}


