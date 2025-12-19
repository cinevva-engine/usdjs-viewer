import * as THREE from 'three';
import type { SdfPrimSpec } from '@cinevva/usdjs';

import { findPrimByPath } from '../usdPaths';

/**
 * Extract material inputs from a MaterialX Standard Surface shader (ND_standard_surface_surfaceshader).
 * Standard Surface has different input names than UsdPreviewSurface.
 */
export function extractStandardSurfaceInputs(
    shader: SdfPrimSpec,
    materialPrim?: SdfPrimSpec,
    root?: SdfPrimSpec,
): {
    baseColor?: THREE.Color;
    metalness?: number;
    roughness?: number;
    emissiveColor?: THREE.Color;
    emissiveIntensity?: number;
    clearcoat?: number;
    clearcoatRoughness?: number;
    diffuseTextureFile?: string;
    roughnessTextureFile?: string;
    normalTextureFile?: string;
    transmission?: number;
    transmissionColor?: THREE.Color;
} {
    const result: any = {};

    // Helper to resolve connected value from material prim's interface inputs or NodeGraph constant colors
    // This handles MaterialX patterns where shader inputs connect to material inputs or nodegraphs
    const resolveConnectedColor3f = (inputName: string): THREE.Color | undefined => {
        const connectProp = shader.properties?.get(`${inputName}.connect`);
        const connDv: any = connectProp?.defaultValue;
        if (connDv && typeof connDv === 'object' && connDv.type === 'sdfpath' && typeof connDv.value === 'string') {
            const targetPath = connDv.value;
            const lastDot = targetPath.lastIndexOf('.');
            if (lastDot > 0) {
                const connectedInputName = targetPath.substring(lastDot + 1);
                // First, try resolving from material interface inputs
                if (materialPrim) {
                    const matProp = materialPrim.properties?.get(connectedInputName);
                    const matDv: any = matProp?.defaultValue;
                    if (matDv && typeof matDv === 'object' && matDv.type === 'tuple') {
                        const tuple = matDv.value;
                        if (tuple.length >= 3 && typeof tuple[0] === 'number' && typeof tuple[1] === 'number' && typeof tuple[2] === 'number') {
                            return new THREE.Color(tuple[0], tuple[1], tuple[2]);
                        }
                    }
                }
                // Second, try resolving from NodeGraph constant color nodes
                if (root) {
                    const primPath = targetPath.substring(0, lastDot);
                    const prim = findPrimByPath(root, primPath);
                    if (prim) {
                        // Check if this is a NodeGraph - follow its output connection
                        if (prim.typeName === 'NodeGraph') {
                            const ngOutputProp = prim.properties?.get(`${connectedInputName}.connect`);
                            const ngOutputDv: any = ngOutputProp?.defaultValue;
                            if (ngOutputDv && typeof ngOutputDv === 'object' && ngOutputDv.type === 'sdfpath' && typeof ngOutputDv.value === 'string') {
                                const innerPath = ngOutputDv.value;
                                const innerLastDot = innerPath.lastIndexOf('.');
                                if (innerLastDot > 0) {
                                    const innerPrimPath = innerPath.substring(0, innerLastDot);
                                    const innerPrim = findPrimByPath(root, innerPrimPath);
                                    if (innerPrim) {
                                        // Check if it's a constant color node (ND_constant_color3 or similar)
                                        const infoId = innerPrim.properties?.get('info:id')?.defaultValue;
                                        if (typeof infoId === 'string' && infoId.includes('constant')) {
                                            const valueProp = innerPrim.properties?.get('inputs:value');
                                            const valueDv: any = valueProp?.defaultValue;
                                            if (valueDv && typeof valueDv === 'object' && valueDv.type === 'tuple') {
                                                const tuple = valueDv.value;
                                                if (tuple.length >= 3 && typeof tuple[0] === 'number' && typeof tuple[1] === 'number' && typeof tuple[2] === 'number') {
                                                    return new THREE.Color(tuple[0], tuple[1], tuple[2]);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        // Check if this is a constant color shader directly
                        const infoId = prim.properties?.get('info:id')?.defaultValue;
                        if (typeof infoId === 'string' && infoId.includes('constant')) {
                            const valueProp = prim.properties?.get('inputs:value');
                            const valueDv: any = valueProp?.defaultValue;
                            if (valueDv && typeof valueDv === 'object' && valueDv.type === 'tuple') {
                                const tuple = valueDv.value;
                                if (tuple.length >= 3 && typeof tuple[0] === 'number' && typeof tuple[1] === 'number' && typeof tuple[2] === 'number') {
                                    return new THREE.Color(tuple[0], tuple[1], tuple[2]);
                                }
                            }
                        }
                    }
                }
            }
        }
        return undefined;
    };

    const resolveConnectedFloat = (inputName: string): number | undefined => {
        const connectProp = shader.properties?.get(`${inputName}.connect`);
        const connDv: any = connectProp?.defaultValue;
        if (connDv && typeof connDv === 'object' && connDv.type === 'sdfpath' && typeof connDv.value === 'string') {
            const targetPath = connDv.value;
            const lastDot = targetPath.lastIndexOf('.');
            if (lastDot > 0) {
                const connectedInputName = targetPath.substring(lastDot + 1);
                if (materialPrim) {
                    const matProp = materialPrim.properties?.get(connectedInputName);
                    if (matProp && typeof matProp.defaultValue === 'number') {
                        return matProp.defaultValue;
                    }
                }
            }
        }
        return undefined;
    };

    // Helper to resolve a texture file from a connected nodegraph
    // Standard Surface often connects to nodegraphs like: inputs:base_color.connect = </Mat/Brass/NG_brass1.outputs:out_color>
    const resolveConnectedTextureFile = (inputName: string): string | undefined => {
        console.log(`[resolveConnectedTextureFile] inputName=${inputName}, shader properties:`, Array.from(shader.properties?.keys() ?? []));
        const connectProp = shader.properties?.get(`${inputName}.connect`);
        console.log(`[resolveConnectedTextureFile] connectProp for ${inputName}.connect:`, connectProp);
        const connDv: any = connectProp?.defaultValue;
        if (connDv && typeof connDv === 'object' && connDv.type === 'sdfpath' && typeof connDv.value === 'string') {
            const targetPath = connDv.value; // e.g. </Mat/Brass/NG_brass1.outputs:out_color>
            console.log(`[resolveConnectedTextureFile] targetPath=${targetPath}`);
            // Extract the prim path (before the last dot)
            const lastDot = targetPath.lastIndexOf('.');
            if (lastDot > 0 && root) {
                const nodegraphPath = targetPath.substring(0, lastDot);
                const outputName = targetPath.substring(lastDot + 1); // e.g. "outputs:out_color"
                console.log(`[resolveConnectedTextureFile] nodegraphPath=${nodegraphPath}, outputName=${outputName}`);
                const nodegraphPrim = findPrimByPath(root, nodegraphPath);
                console.log(`[resolveConnectedTextureFile] nodegraphPrim=${nodegraphPrim?.path?.primPath}, typeName=${nodegraphPrim?.typeName}`);
                if (nodegraphPrim && nodegraphPrim.typeName === 'NodeGraph') {
                    // Find what the nodegraph output connects to
                    console.log(`[resolveConnectedTextureFile] nodegraph properties:`, Array.from(nodegraphPrim.properties?.keys() ?? []));
                    const ngOutputProp = nodegraphPrim.properties?.get(`${outputName}.connect`);
                    console.log(`[resolveConnectedTextureFile] ngOutputProp for ${outputName}.connect:`, ngOutputProp);
                    const ngOutputDv: any = ngOutputProp?.defaultValue;
                    if (ngOutputDv && typeof ngOutputDv === 'object' && ngOutputDv.type === 'sdfpath' && typeof ngOutputDv.value === 'string') {
                        // Follow the connection to the image shader
                        const imageShaderPath = ngOutputDv.value;
                        console.log(`[resolveConnectedTextureFile] imageShaderPath=${imageShaderPath}`);
                        const imageLastDot = imageShaderPath.lastIndexOf('.');
                        if (imageLastDot > 0) {
                            const imageShaderPrimPath = imageShaderPath.substring(0, imageLastDot);
                            const imageShaderPrim = findPrimByPath(root, imageShaderPrimPath);
                            console.log(`[resolveConnectedTextureFile] imageShaderPrim=${imageShaderPrim?.path?.primPath}`);
                            if (imageShaderPrim) {
                                // Get the file input from the image shader (ND_tiledimage_*)
                                console.log(`[resolveConnectedTextureFile] imageShader properties:`, Array.from(imageShaderPrim.properties?.keys() ?? []));
                                const fileProp = imageShaderPrim.properties?.get('inputs:file');
                                const fileDv: any = fileProp?.defaultValue;
                                console.log(`[resolveConnectedTextureFile] fileDv:`, fileDv);
                                if (fileDv && typeof fileDv === 'object' && fileDv.type === 'asset' && typeof fileDv.value === 'string') {
                                    console.log(`[resolveConnectedTextureFile] FOUND texture file: ${fileDv.value}`);
                                    return fileDv.value;
                                }

                                // For normal maps, the nodegraph output may connect to a normalmap node,
                                // which then connects to an image node. Follow the chain one more level.
                                // Check for inputs:in.connect (normalmap node) or similar intermediate nodes
                                const inProp = imageShaderPrim.properties?.get('inputs:in.connect');
                                const inDv: any = inProp?.defaultValue;
                                console.log(`[resolveConnectedTextureFile] checking for intermediate node (normalmap), inputs:in.connect:`, inDv);
                                if (inDv && typeof inDv === 'object' && inDv.type === 'sdfpath' && typeof inDv.value === 'string') {
                                    const intermediateTargetPath = inDv.value;
                                    const intermediateLastDot = intermediateTargetPath.lastIndexOf('.');
                                    if (intermediateLastDot > 0) {
                                        const realImagePrimPath = intermediateTargetPath.substring(0, intermediateLastDot);
                                        const realImagePrim = findPrimByPath(root, realImagePrimPath);
                                        console.log(`[resolveConnectedTextureFile] real image prim path=${realImagePrimPath}, found=${realImagePrim?.path?.primPath}`);
                                        if (realImagePrim) {
                                            const realFileProp = realImagePrim.properties?.get('inputs:file');
                                            const realFileDv: any = realFileProp?.defaultValue;
                                            console.log(`[resolveConnectedTextureFile] real image file:`, realFileDv);
                                            if (realFileDv && typeof realFileDv === 'object' && realFileDv.type === 'asset' && typeof realFileDv.value === 'string') {
                                                console.log(`[resolveConnectedTextureFile] FOUND texture file via intermediate node: ${realFileDv.value}`);
                                                return realFileDv.value;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        console.log(`[resolveConnectedTextureFile] No texture found for ${inputName}`);
        return undefined;
    };

    const getColor3f = (name: string): THREE.Color | undefined => {
        const prop = shader.properties?.get(name);
        const dv: any = prop?.defaultValue;
        if (!dv || typeof dv !== 'object') {
            return resolveConnectedColor3f(name);
        }
        // Handle tuple type (used for color3f values)
        if (dv.type === 'tuple' || dv.type === 'vec3f') {
            const tuple = dv.value;
            if (Array.isArray(tuple) && tuple.length >= 3 && typeof tuple[0] === 'number' && typeof tuple[1] === 'number' && typeof tuple[2] === 'number') {
                return new THREE.Color(tuple[0], tuple[1], tuple[2]);
            }
        }
        // Handle raw array format (some USD files might use this)
        if (Array.isArray(dv) && dv.length >= 3 && typeof dv[0] === 'number' && typeof dv[1] === 'number' && typeof dv[2] === 'number') {
            return new THREE.Color(dv[0], dv[1], dv[2]);
        }
        return resolveConnectedColor3f(name);
    };

    const getFloat = (name: string): number | undefined => {
        const prop = shader.properties?.get(name);
        if (prop && typeof prop.defaultValue === 'number') return prop.defaultValue;
        return resolveConnectedFloat(name);
    };

    // Standard Surface uses different input names than UsdPreviewSurface
    // base_color is the primary diffuse color (multiplied by base intensity)
    result.baseColor = getColor3f('inputs:base_color');
    result.metalness = getFloat('inputs:metalness');
    // Standard Surface uses specular_roughness for overall roughness
    result.roughness = getFloat('inputs:specular_roughness');
    // Emission: emission intensity * emission_color
    result.emissiveIntensity = getFloat('inputs:emission');
    result.emissiveColor = getColor3f('inputs:emission_color');
    // Clearcoat (coat in Standard Surface)
    result.clearcoat = getFloat('inputs:coat');
    result.clearcoatRoughness = getFloat('inputs:coat_roughness');

    // Transmission (glass-like materials)
    result.transmission = getFloat('inputs:transmission');
    result.transmissionColor = getColor3f('inputs:transmission_color');

    // Try to resolve texture files from connected nodegraphs
    // Standard Surface often uses base_color connected to a nodegraph for diffuse texture
    // And coat_color or coat_roughness connected to nodegraphs for other textures
    result.diffuseTextureFile = resolveConnectedTextureFile('inputs:base_color');
    if (!result.diffuseTextureFile) {
        // Some materials use coat_color for the visible color (like brass)
        result.diffuseTextureFile = resolveConnectedTextureFile('inputs:coat_color');
    }
    result.roughnessTextureFile = resolveConnectedTextureFile('inputs:specular_roughness');
    if (!result.roughnessTextureFile) {
        result.roughnessTextureFile = resolveConnectedTextureFile('inputs:coat_roughness');
    }
    result.normalTextureFile = resolveConnectedTextureFile('inputs:normal');

    return result;
}

export function createStandardSurfaceMaterial(opts: {
    shader: SdfPrimSpec;
    root: SdfPrimSpec;
    resolveAssetUrl?: (assetPath: string) => string | null;
    materialPrim?: SdfPrimSpec;
}): THREE.Material {
    const { shader, root, resolveAssetUrl, materialPrim } = opts;

    const inputs = extractStandardSurfaceInputs(shader, materialPrim, root);
    console.warn('[StandardSurface] inputs:', JSON.stringify({
        baseColor: inputs.baseColor?.getHexString(),
        diffuseTextureFile: inputs.diffuseTextureFile,
        roughnessTextureFile: inputs.roughnessTextureFile,
        metalness: inputs.metalness,
        roughness: inputs.roughness,
        transmission: inputs.transmission,
        transmissionColor: inputs.transmissionColor?.getHexString(),
    }));
    const mat = new THREE.MeshPhysicalMaterial();

    mat.color.setHex(0xffffff);
    mat.roughness = 0.5;
    mat.metalness = 0.0;
    mat.side = THREE.DoubleSide;

    if (inputs.baseColor) {
        mat.color.copy(inputs.baseColor);
    }
    if (inputs.roughness !== undefined) mat.roughness = inputs.roughness;
    if (inputs.metalness !== undefined) mat.metalness = inputs.metalness;

    if (inputs.emissiveColor) {
        mat.emissive = inputs.emissiveColor;
        mat.emissiveIntensity = inputs.emissiveIntensity ?? 1.0;
    }

    if (inputs.clearcoat !== undefined) {
        mat.clearcoat = THREE.MathUtils.clamp(inputs.clearcoat, 0, 1);
    }
    if (inputs.clearcoatRoughness !== undefined) {
        mat.clearcoatRoughness = THREE.MathUtils.clamp(inputs.clearcoatRoughness, 0, 1);
    }

    // Transmission (glass-like materials)
    // Standard Surface uses transmission=1 for fully transparent glass
    if (inputs.transmission !== undefined && inputs.transmission > 0) {
        mat.transmission = THREE.MathUtils.clamp(inputs.transmission, 0, 1);
        // For transmissive materials, we need a thickness value for refraction
        mat.thickness = 0.5; // Reasonable default for small objects
        // transmission_color maps to attenuationColor in Three.js
        if (inputs.transmissionColor) {
            mat.attenuationColor = inputs.transmissionColor;
            // Use a small attenuation distance so the color is visible
            mat.attenuationDistance = 0.1;
        }
    }

    // Load diffuse texture from nodegraph connection
    console.warn('[StandardSurface] diffuseTextureFile:', inputs.diffuseTextureFile, 'resolveAssetUrl:', !!resolveAssetUrl);
    if (inputs.diffuseTextureFile && resolveAssetUrl) {
        const url = resolveAssetUrl(inputs.diffuseTextureFile);
        console.warn('[StandardSurface] resolved diffuse URL:', url);
        if (url) {
            new THREE.TextureLoader().load(
                url,
                (tex: any) => {
                    console.warn('[StandardSurface] Diffuse texture LOADED successfully:', inputs.diffuseTextureFile);
                    tex.colorSpace = THREE.SRGBColorSpace;
                    mat.map = tex;
                    mat.needsUpdate = true;
                },
                undefined,
                (err: unknown) => {
                    console.error('Failed to load Standard Surface diffuse texture:', inputs.diffuseTextureFile, url, err);
                },
            );
        }
    }

    // Load roughness texture from nodegraph connection
    if (inputs.roughnessTextureFile && resolveAssetUrl) {
        const url = resolveAssetUrl(inputs.roughnessTextureFile);
        if (url) {
            new THREE.TextureLoader().load(
                url,
                (tex: any) => {
                    tex.colorSpace = THREE.NoColorSpace;
                    mat.roughnessMap = tex;
                    mat.needsUpdate = true;
                },
                undefined,
                (err: unknown) => {
                    console.error('Failed to load Standard Surface roughness texture:', inputs.roughnessTextureFile, url, err);
                },
            );
        }
    }

    // Load normal texture from nodegraph connection
    if (inputs.normalTextureFile && resolveAssetUrl) {
        const url = resolveAssetUrl(inputs.normalTextureFile);
        if (url) {
            new THREE.TextureLoader().load(
                url,
                (tex: any) => {
                    tex.colorSpace = THREE.NoColorSpace;
                    mat.normalMap = tex;
                    mat.needsUpdate = true;
                    console.log('[StandardSurface] Normal texture loaded successfully:', inputs.normalTextureFile);
                },
                undefined,
                (err: unknown) => {
                    console.error('Failed to load Standard Surface normal texture:', inputs.normalTextureFile, url, err);
                },
            );
        }
    }

    mat.needsUpdate = true;
    return mat;
}


