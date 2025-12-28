import * as THREE from 'three';

import type { PrimeTreeNode } from './types';

function objectLabel(o: THREE.Object3D): string {
  const type = (o as any)?.type ? String((o as any).type) : 'Object3D';
  const name = typeof o.name === 'string' && o.name.trim().length ? o.name.trim() : '(unnamed)';
  const hidden = o.visible === false ? ' [hidden]' : '';
  return `${name} <${type}>${hidden}`;
}

// Common texture map names in Three.js materials
const TEXTURE_MAP_NAMES = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap',
  'aoMap', 'bumpMap', 'displacementMap', 'alphaMap', 'envMap',
  'lightMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap',
  'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap',
  'transmissionMap', 'thicknessMap', 'iridescenceMap', 'iridescenceThicknessMap',
  'anisotropyMap',
];

function textureNode(tex: THREE.Texture, mapName: string, materialKey: string): PrimeTreeNode {
  const name = tex.name?.trim() || mapName;
  const sourceInfo = tex.image ? 
    (tex.image.src ? ` [${tex.image.width}×${tex.image.height}]` : ` [${tex.image.width || '?'}×${tex.image.height || '?'}]`) : 
    '';
  return {
    key: `${materialKey}:texture:${mapName}`,
    label: `${name} <Texture>${sourceInfo}`,
    data: { isTexture: true, mapName, materialKey, textureUuid: tex.uuid },
  };
}

function materialNode(mat: THREE.Material, parentUuid: string, index?: number): PrimeTreeNode {
  const type = (mat as any)?.type ?? 'Material';
  const name = mat.name?.trim() || (index !== undefined ? `Material[${index}]` : 'Material');
  const materialKey = `${parentUuid}:material${index !== undefined ? `:${index}` : ''}`;
  
  // Collect texture children
  const textureChildren: PrimeTreeNode[] = [];
  const m = mat as any;
  for (const mapName of TEXTURE_MAP_NAMES) {
    const tex = m[mapName];
    if (tex && tex.isTexture) {
      textureChildren.push(textureNode(tex, mapName, materialKey));
    }
  }
  
  // Debug: log texture detection
  // eslint-disable-next-line no-console
  console.log('[SceneTree] Material:', name, 'textures found:', textureChildren.map(t => t.label));
  
  return {
    key: materialKey,
    label: `${name} <${type}>`,
    data: { isMaterial: true, materialUuid: mat.uuid, parentUuid },
    children: textureChildren.length ? textureChildren : undefined,
  };
}

function geometryNode(geom: THREE.BufferGeometry, parentUuid: string): PrimeTreeNode {
  const name = geom.name?.trim() || 'Geometry';
  const type = (geom as any)?.type ?? 'BufferGeometry';
  const posAttr = geom.getAttribute('position');
  const vertCount = posAttr ? posAttr.count : 0;
  const indexCount = geom.index ? geom.index.count : 0;
  const info = indexCount ? `[${vertCount} verts, ${indexCount / 3} tris]` : `[${vertCount} verts]`;
  
  return {
    key: `${parentUuid}:geometry`,
    label: `${name} <${type}> ${info}`,
    data: { isGeometry: true, geometryUuid: geom.uuid, parentUuid },
  };
}

function boneNode(bone: THREE.Bone, skeletonKey: string): PrimeTreeNode {
  const name = bone.name?.trim() || 'Bone';
  const childBones: PrimeTreeNode[] = [];
  
  // Recursively add child bones
  for (const child of bone.children) {
    if ((child as any).isBone) {
      childBones.push(boneNode(child as THREE.Bone, skeletonKey));
    }
  }
  
  return {
    key: `${skeletonKey}:bone:${bone.uuid}`,
    label: `${name} <Bone>`,
    data: { isBone: true, boneUuid: bone.uuid, skeletonKey },
    children: childBones.length ? childBones : undefined,
  };
}

function skeletonNode(skeleton: THREE.Skeleton, parentUuid: string): PrimeTreeNode {
  const skeletonKey = `${parentUuid}:skeleton`;
  const boneCount = skeleton.bones.length;
  
  // Find root bones (bones without a parent bone)
  const rootBones: PrimeTreeNode[] = [];
  for (const bone of skeleton.bones) {
    const parentIsBone = bone.parent && (bone.parent as any).isBone;
    if (!parentIsBone) {
      rootBones.push(boneNode(bone, skeletonKey));
    }
  }
  
  return {
    key: skeletonKey,
    label: `Skeleton [${boneCount} bones]`,
    data: { isSkeleton: true, parentUuid },
    children: rootBones.length ? rootBones : undefined,
  };
}

// Check if an Object3D is a USD-only structural prim (shader, texture, reader, skeleton internals)
// that doesn't render anything in Three.js
function isUsdStructuralPrim(o: THREE.Object3D): boolean {
  const name = o.name?.toLowerCase() ?? '';
  // USD shader/texture prims typically have these patterns in their names
  const usdPatterns = ['shader', 'texture', 'reader', 'primvar', 'transform2d', 'uvmap'];
  // USD skeleton-related structural prims
  const skelPatterns = ['skeleton_root', 'skelanim', 'previewskelanim'];
  // Only filter if it's a plain Object3D with no geometry/material and matches pattern
  if ((o as any).isMesh || (o as any).isLight || (o as any).isCamera) return false;
  if (o.children?.some((c: any) => c.isMesh || c.isLight || c.isCamera)) return false;
  
  // Check standard USD patterns
  if (usdPatterns.some(p => name.includes(p))) return true;
  // Check skeleton patterns
  if (skelPatterns.some(p => name.includes(p))) return true;
  
  return false;
}

// Check if an Object3D is a visual bone Xform (not a real Bone, just USD transform hierarchy)
// These are redundant when we have a proper Skeleton view
function isVisualBoneXform(o: THREE.Object3D): boolean {
  // If it's an actual Bone, it will be filtered by the isBone check
  if ((o as any).isBone) return false;
  // If it has meshes/lights/cameras, it's not just a bone transform
  if ((o as any).isMesh || (o as any).isLight || (o as any).isCamera) return false;
  
  // Recursively check if this object or any descendant has meaningful content
  function hasMeaningfulContent(obj: THREE.Object3D): boolean {
    if ((obj as any).isMesh || (obj as any).isLight || (obj as any).isCamera) return true;
    if ((obj as any).isSkinnedMesh) return true;
    for (const child of obj.children || []) {
      if (hasMeaningfulContent(child)) return true;
    }
    return false;
  }
  
  // If this subtree has any meshes/lights/cameras, don't filter it
  if (hasMeaningfulContent(o)) return false;
  
  // Check if this looks like a bone transform chain (all children are also just transforms)
  const name = o.name?.toLowerCase() ?? '';
  // Only filter if name contains "bone" or "joint" (but NOT "skeleton" which may contain meshes)
  if (name.includes('bone') || name.includes('joint')) {
    return true;
  }
  
  return false;
}

function toNode(o: THREE.Object3D, filterUsdPrims = true): PrimeTreeNode {
  const childNodes: PrimeTreeNode[] = [];
  
  // Add regular children first (filter out USD structural prims and Bones if requested)
  if (o.children?.length) {
    for (const child of o.children) {
      if (filterUsdPrims && isUsdStructuralPrim(child)) continue;
      // Skip Bone objects - they're shown in the Skeleton node instead
      if ((child as any).isBone) continue;
      // Skip visual bone Xforms (USD transform hierarchies that represent bones)
      if (filterUsdPrims && isVisualBoneXform(child)) continue;
      childNodes.push(toNode(child, filterUsdPrims));
    }
  }
  
  // Add geometry and material nodes for meshes
  if ((o as any).isMesh) {
    const mesh = o as THREE.Mesh;
    
    // Add geometry node
    if (mesh.geometry) {
      childNodes.push(geometryNode(mesh.geometry, o.uuid));
    }
    
    // Add material nodes
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((mat, i) => {
          childNodes.push(materialNode(mat, o.uuid, i));
        });
      } else {
        childNodes.push(materialNode(mesh.material, o.uuid));
      }
    }
    
    // Add skeleton for SkinnedMesh
    if ((o as any).isSkinnedMesh) {
      const skinnedMesh = o as THREE.SkinnedMesh;
      if (skinnedMesh.skeleton) {
        childNodes.push(skeletonNode(skinnedMesh.skeleton, o.uuid));
      }
    }
  }
  
  return {
    key: o.uuid,
    label: objectLabel(o),
    styleClass: o.visible === false ? 'tree-node-hidden' : undefined,
    children: childNodes.length ? childNodes : undefined,
  };
}

export function buildThreeSceneTree(scene: THREE.Scene, filterUsdPrims = true): PrimeTreeNode[] {
  // PrimeVue Tree expects an array of root nodes.
  // Make the root label nicer than "(unnamed) <Scene>".
  let childNodes: PrimeTreeNode[] | undefined;
  if (scene.children?.length) {
    childNodes = [];
    for (const child of scene.children) {
      if (filterUsdPrims && isUsdStructuralPrim(child)) continue;
      // Skip Bone objects - they're shown in the Skeleton node instead
      if ((child as any).isBone) continue;
      // Skip visual bone Xforms
      if (filterUsdPrims && isVisualBoneXform(child)) continue;
      childNodes.push(toNode(child, filterUsdPrims));
    }
    if (childNodes.length === 0) childNodes = undefined;
  }
  const root: PrimeTreeNode = {
    key: scene.uuid,
    label: `Scene <${(scene as any)?.type ?? 'Scene'}>`,
    children: childNodes,
  };
  return [root];
}

export function findObjectByUuid(scene: THREE.Scene, uuid: string): THREE.Object3D | null {
  if (scene.uuid === uuid) return scene;
  let found: THREE.Object3D | null = null;
  scene.traverse((obj) => {
    if (obj.uuid === uuid) {
      found = obj;
    }
  });
  return found;
}

// Parse material key format: "parentUuid:material" or "parentUuid:material:index"
export function parseMaterialKey(key: string): { parentUuid: string; index?: number } | null {
  const match = key.match(/^(.+):material(?::(\d+))?$/);
  if (!match) return null;
  return {
    parentUuid: match[1]!,
    index: match[2] !== undefined ? parseInt(match[2], 10) : undefined,
  };
}

export function findMaterialByKey(scene: THREE.Scene, key: string): THREE.Material | null {
  const parsed = parseMaterialKey(key);
  if (!parsed) return null;
  
  const obj = findObjectByUuid(scene, parsed.parentUuid);
  if (!obj || !(obj as any).isMesh) return null;
  
  const mesh = obj as THREE.Mesh;
  if (!mesh.material) return null;
  
  if (Array.isArray(mesh.material)) {
    return parsed.index !== undefined ? mesh.material[parsed.index] ?? null : null;
  }
  return mesh.material;
}

export function getMaterialProperties(mat: THREE.Material): Record<string, any> {
  const m = mat as any;
  return {
    name: mat.name || '(unnamed)',
    type: m.type ?? 'Material',
    uuid: mat.uuid,
    color: m.color?.getHex?.() ?? null,
    opacity: mat.opacity ?? 1,
    transparent: mat.transparent ?? false,
    metalness: m.metalness ?? null,
    roughness: m.roughness ?? null,
    emissive: m.emissive?.getHex?.() ?? null,
    emissiveIntensity: m.emissiveIntensity ?? null,
    wireframe: m.wireframe ?? false,
    side: mat.side === 0 ? 'FrontSide' : mat.side === 1 ? 'BackSide' : mat.side === 2 ? 'DoubleSide' : mat.side,
    depthTest: mat.depthTest ?? true,
    depthWrite: mat.depthWrite ?? true,
    visible: mat.visible ?? true,
  };
}

export function setMaterialProperty(mat: THREE.Material, path: string, value: any): boolean {
  try {
    const m = mat as any;
    
    if (path === 'color' || path === 'emissive') {
      // Handle color as hex
      let colorValue: number;
      if (typeof value === 'number') {
        colorValue = value;
      } else {
        const strVal = String(value).trim();
        if (strVal.startsWith('#')) {
          colorValue = parseInt(strVal.slice(1), 16);
        } else if (strVal.startsWith('0x')) {
          colorValue = parseInt(strVal, 16);
        } else {
          colorValue = parseInt(strVal, 10);
        }
      }
      if (isNaN(colorValue)) return false;
      m[path]?.setHex?.(colorValue);
      return true;
    }
    
    if (['opacity', 'metalness', 'roughness', 'emissiveIntensity'].includes(path)) {
      const num = parseFloat(value);
      if (isNaN(num)) return false;
      m[path] = num;
      mat.needsUpdate = true;
      return true;
    }
    
    if (['transparent', 'wireframe', 'depthTest', 'depthWrite', 'visible'].includes(path)) {
      m[path] = value === true || value === 'true' || value === '1';
      mat.needsUpdate = true;
      return true;
    }
    
    if (path === 'name') {
      mat.name = String(value);
      return true;
    }
    
    // Handle side
    if (path === 'side') {
      const sides: Record<string, THREE.Side> = {
        'FrontSide': THREE.FrontSide,
        'BackSide': THREE.BackSide,
        'DoubleSide': THREE.DoubleSide,
      };
      const side = sides[value];
      if (side === undefined) return false;
      mat.side = side;
      mat.needsUpdate = true;
      return true;
    }
    
    return false;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`Failed to set material property "${path}":`, e);
    return false;
  }
}

// Parse texture key format: "materialKey:texture:mapName"
export function parseTextureKey(key: string): { materialKey: string; mapName: string } | null {
  const match = key.match(/^(.+):texture:(\w+)$/);
  if (!match) return null;
  return {
    materialKey: match[1]!,
    mapName: match[2]!,
  };
}

export function findTextureByKey(scene: THREE.Scene, key: string): THREE.Texture | null {
  const parsed = parseTextureKey(key);
  if (!parsed) return null;
  
  const mat = findMaterialByKey(scene, parsed.materialKey);
  if (!mat) return null;
  
  const tex = (mat as any)[parsed.mapName];
  return tex?.isTexture ? tex : null;
}

export function getTextureProperties(tex: THREE.Texture): Record<string, any> {
  const t = tex as any;
  
  // Try to get image source URL
  let imageUrl: string | null = null;
  let imageWidth: number | null = null;
  let imageHeight: number | null = null;
  
  if (tex.image) {
    if (tex.image.src) {
      // HTMLImageElement
      imageUrl = tex.image.src;
    } else if (tex.image instanceof HTMLCanvasElement) {
      // Canvas - convert to data URL
      try {
        imageUrl = tex.image.toDataURL('image/png');
      } catch {
        // Security error if canvas is tainted
      }
    } else if (typeof ImageBitmap !== 'undefined' && tex.image instanceof ImageBitmap) {
      // ImageBitmap - need to draw to canvas first
      try {
        const canvas = document.createElement('canvas');
        canvas.width = tex.image.width;
        canvas.height = tex.image.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(tex.image, 0, 0);
          imageUrl = canvas.toDataURL('image/png');
        }
      } catch {
        // Ignore errors
      }
    }
    imageWidth = tex.image.width ?? null;
    imageHeight = tex.image.height ?? null;
  }
  
  // Get wrap mode strings
  const wrapModes: Record<number, string> = {
    [THREE.RepeatWrapping]: 'RepeatWrapping',
    [THREE.ClampToEdgeWrapping]: 'ClampToEdgeWrapping',
    [THREE.MirroredRepeatWrapping]: 'MirroredRepeatWrapping',
  };
  
  // Get filter mode strings
  const filterModes: Record<number, string> = {
    [THREE.NearestFilter]: 'NearestFilter',
    [THREE.NearestMipmapNearestFilter]: 'NearestMipmapNearest',
    [THREE.NearestMipmapLinearFilter]: 'NearestMipmapLinear',
    [THREE.LinearFilter]: 'LinearFilter',
    [THREE.LinearMipmapNearestFilter]: 'LinearMipmapNearest',
    [THREE.LinearMipmapLinearFilter]: 'LinearMipmapLinear',
  };
  
  // Get color space string
  const colorSpaces: Record<string, string> = {
    'srgb': 'sRGB',
    'srgb-linear': 'Linear sRGB',
    '': 'None',
  };
  
  return {
    name: tex.name || '(unnamed)',
    uuid: tex.uuid,
    type: t.type ?? 'Texture',
    // Image info
    imageUrl,
    imageWidth,
    imageHeight,
    // Texture settings
    wrapS: wrapModes[tex.wrapS] ?? tex.wrapS,
    wrapT: wrapModes[tex.wrapT] ?? tex.wrapT,
    repeat: { x: tex.repeat.x, y: tex.repeat.y },
    offset: { x: tex.offset.x, y: tex.offset.y },
    rotation: tex.rotation,
    center: { x: tex.center.x, y: tex.center.y },
    // Filtering
    magFilter: filterModes[tex.magFilter] ?? tex.magFilter,
    minFilter: filterModes[tex.minFilter] ?? tex.minFilter,
    anisotropy: tex.anisotropy,
    // Color space
    colorSpace: colorSpaces[tex.colorSpace] ?? tex.colorSpace,
    // Flags
    flipY: tex.flipY,
    generateMipmaps: tex.generateMipmaps,
    premultiplyAlpha: tex.premultiplyAlpha,
  };
}

export function setTextureProperty(tex: THREE.Texture, path: string, value: any): boolean {
  try {
    // Handle vector2 properties (repeat, offset, center)
    if (path.startsWith('repeat.') || path.startsWith('offset.') || path.startsWith('center.')) {
      const [vecName, component] = path.split('.');
      const vec = (tex as any)[vecName!] as THREE.Vector2;
      if (!vec || !(component === 'x' || component === 'y')) return false;
      const num = parseFloat(value);
      if (isNaN(num)) return false;
      vec[component] = num;
      tex.needsUpdate = true;
      return true;
    }
    
    // Handle rotation (single number)
    if (path === 'rotation') {
      const num = parseFloat(value);
      if (isNaN(num)) return false;
      tex.rotation = num;
      tex.needsUpdate = true;
      return true;
    }
    
    // Handle anisotropy
    if (path === 'anisotropy') {
      const num = parseInt(value, 10);
      if (isNaN(num) || num < 1) return false;
      tex.anisotropy = num;
      tex.needsUpdate = true;
      return true;
    }
    
    // Handle boolean flags that affect GPU upload
    if (['flipY', 'generateMipmaps', 'premultiplyAlpha'].includes(path)) {
      const boolVal = value === true || value === 'true' || value === '1';
      (tex as any)[path] = boolVal;
      // These properties affect how texture is uploaded to GPU - need to dispose and re-upload
      tex.dispose();
      tex.needsUpdate = true;
      return true;
    }
    
    // Handle name
    if (path === 'name') {
      tex.name = String(value);
      return true;
    }
    
    // Handle wrap modes
    if (path === 'wrapS' || path === 'wrapT') {
      const wrapModes: Record<string, number> = {
        'RepeatWrapping': THREE.RepeatWrapping,
        'ClampToEdgeWrapping': THREE.ClampToEdgeWrapping,
        'MirroredRepeatWrapping': THREE.MirroredRepeatWrapping,
      };
      const mode = wrapModes[value];
      if (mode === undefined) return false;
      (tex as any)[path] = mode;
      tex.needsUpdate = true;
      return true;
    }
    
    // Handle mag filter
    if (path === 'magFilter') {
      const filterModes: Record<string, THREE.MagnificationTextureFilter> = {
        'NearestFilter': THREE.NearestFilter,
        'LinearFilter': THREE.LinearFilter,
      };
      const mode = filterModes[value];
      if (mode === undefined) return false;
      tex.magFilter = mode;
      tex.needsUpdate = true;
      return true;
    }
    
    // Handle min filter
    if (path === 'minFilter') {
      const filterModes: Record<string, THREE.MinificationTextureFilter> = {
        'NearestFilter': THREE.NearestFilter,
        'NearestMipmapNearest': THREE.NearestMipmapNearestFilter,
        'NearestMipmapLinear': THREE.NearestMipmapLinearFilter,
        'LinearFilter': THREE.LinearFilter,
        'LinearMipmapNearest': THREE.LinearMipmapNearestFilter,
        'LinearMipmapLinear': THREE.LinearMipmapLinearFilter,
      };
      const mode = filterModes[value];
      if (mode === undefined) return false;
      tex.minFilter = mode;
      tex.needsUpdate = true;
      return true;
    }
    
    // Handle color space
    if (path === 'colorSpace') {
      const colorSpaces: Record<string, string> = {
        'sRGB': 'srgb',
        'Linear sRGB': 'srgb-linear',
        'None': '',
      };
      const cs = colorSpaces[value];
      if (cs === undefined) return false;
      tex.colorSpace = cs as THREE.ColorSpace;
      tex.needsUpdate = true;
      return true;
    }
    
    return false;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`Failed to set texture property "${path}":`, e);
    return false;
  }
}

export function getObjectProperties(obj: THREE.Object3D): Record<string, any> {
  const props: Record<string, any> = {
    name: obj.name || '(unnamed)',
    type: (obj as any)?.type ?? 'Object3D',
    uuid: obj.uuid,
    visible: obj.visible,
    castShadow: (obj as any).castShadow ?? false,
    receiveShadow: (obj as any).receiveShadow ?? false,
    frustumCulled: obj.frustumCulled,
    renderOrder: obj.renderOrder,
    position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
    rotation: { x: obj.rotation.x, y: obj.rotation.y, z: obj.rotation.z },
    scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
    children: obj.children.length,
  };

  // Add type-specific properties
  if ((obj as any).isMesh) {
    const mesh = obj as THREE.Mesh;
    const mat = mesh.material as any;
    props.material = mat ? {
      type: mat.type ?? typeof mat,
      color: mat.color?.getHex?.() ?? null,
      opacity: mat.opacity ?? 1,
      transparent: mat.transparent ?? false,
      metalness: mat.metalness ?? null,
      roughness: mat.roughness ?? null,
      emissive: mat.emissive?.getHex?.() ?? null,
      wireframe: mat.wireframe ?? false,
      side: mat.side === 0 ? 'FrontSide' : mat.side === 1 ? 'BackSide' : mat.side === 2 ? 'DoubleSide' : mat.side,
      depthTest: mat.depthTest ?? true,
      depthWrite: mat.depthWrite ?? true,
    } : null;
    if (mesh.geometry) {
      const geom = mesh.geometry;
      const pos = geom.getAttribute('position');
      const idx = geom.index;
      props.geometry = {
        type: geom.type,
        positionCount: pos?.count ?? 0,
        indexCount: idx?.count ?? 0,
        drawRange: {
          start: geom.drawRange.start,
          count: geom.drawRange.count,
        },
        groups: geom.groups.length,
        boundingSphere: geom.boundingSphere ? {
          center: {
            x: geom.boundingSphere.center.x,
            y: geom.boundingSphere.center.y,
            z: geom.boundingSphere.center.z,
          },
          radius: geom.boundingSphere.radius,
        } : null,
      };
    }
  } else if ((obj as any).isLight) {
    const light = obj as THREE.Light;
    const l = light as any;
    
    // Base light properties
    props.color = light.color.getHex();
    props.intensity = light.intensity;
    
    // SpotLight specific properties
    if (l.isSpotLight) {
      props.angle = l.angle;
      props.penumbra = l.penumbra;
      props.decay = l.decay;
      props.distance = l.distance;
      if (l.target) {
        props.target = { x: l.target.position.x, y: l.target.position.y, z: l.target.position.z };
      }
    }
    
    // PointLight specific properties
    if (l.isPointLight) {
      props.decay = l.decay;
      props.distance = l.distance;
    }
    
    // DirectionalLight specific properties
    if (l.isDirectionalLight) {
      if (l.target) {
        props.target = { x: l.target.position.x, y: l.target.position.y, z: l.target.position.z };
      }
    }
    
    // RectAreaLight specific properties
    if (l.isRectAreaLight) {
      props.width = l.width;
      props.height = l.height;
    }
    
    // HemisphereLight specific properties
    if (l.isHemisphereLight) {
      props.groundColor = l.groundColor?.getHex?.() ?? null;
    }
    
    // Shadow properties (for lights that support shadows)
    if (l.castShadow !== undefined) {
      props.castShadow = l.castShadow;
    }
    if (l.shadow) {
      props.shadowBias = l.shadow.bias;
      props.shadowNormalBias = l.shadow.normalBias;
      props.shadowRadius = l.shadow.radius;
      if (l.shadow.mapSize) {
        props.shadowMapSize = { x: l.shadow.mapSize.x, y: l.shadow.mapSize.y };
      }
      // Shadow camera properties for DirectionalLight
      if (l.isDirectionalLight && l.shadow.camera) {
        props.shadowCamera = {
          left: l.shadow.camera.left,
          right: l.shadow.camera.right,
          top: l.shadow.camera.top,
          bottom: l.shadow.camera.bottom,
          near: l.shadow.camera.near,
          far: l.shadow.camera.far,
        };
      }
      // Shadow camera properties for SpotLight/PointLight
      if ((l.isSpotLight || l.isPointLight) && l.shadow.camera) {
        props.shadowCamera = {
          near: l.shadow.camera.near,
          far: l.shadow.camera.far,
          fov: l.shadow.camera.fov,
        };
      }
    }
  } else if ((obj as any).isCamera) {
    const cam = obj as THREE.Camera;
    props.camera = {
      type: cam.type,
      near: (cam as any).near ?? null,
      far: (cam as any).far ?? null,
      fov: (cam as any).fov ?? null,
    };
  }

  return props;
}

// Define which properties are editable and their types
export const EDITABLE_PROPERTIES: Record<string, 'string' | 'number' | 'boolean' | 'vector3' | 'color'> = {
  name: 'string',
  visible: 'boolean',
  castShadow: 'boolean',
  receiveShadow: 'boolean',
  frustumCulled: 'boolean',
  renderOrder: 'number',
  'position.x': 'number',
  'position.y': 'number',
  'position.z': 'number',
  'rotation.x': 'number',
  'rotation.y': 'number',
  'rotation.z': 'number',
  'scale.x': 'number',
  'scale.y': 'number',
  'scale.z': 'number',
  // Light properties (common)
  'color': 'color',
  'intensity': 'number',
  'castShadow': 'boolean',
  // SpotLight properties
  'angle': 'number',
  'penumbra': 'number',
  'decay': 'number',
  'distance': 'number',
  // RectAreaLight properties
  'width': 'number',
  'height': 'number',
  // HemisphereLight properties
  'groundColor': 'color',
  // Shadow properties
  'shadowBias': 'number',
  'shadowNormalBias': 'number',
  'shadowRadius': 'number',
  'shadowMapSize.x': 'number',
  'shadowMapSize.y': 'number',
  'shadowCamera.left': 'number',
  'shadowCamera.right': 'number',
  'shadowCamera.top': 'number',
  'shadowCamera.bottom': 'number',
  'shadowCamera.near': 'number',
  'shadowCamera.far': 'number',
  'shadowCamera.fov': 'number',
  // Light target
  'target.x': 'number',
  'target.y': 'number',
  'target.z': 'number',
  // Material properties
  'material.color': 'color',
  'material.opacity': 'number',
  'material.metalness': 'number',
  'material.roughness': 'number',
  'material.emissive': 'color',
  'material.wireframe': 'boolean',
  'material.transparent': 'boolean',
  'material.depthTest': 'boolean',
  'material.depthWrite': 'boolean',
};

export function setObjectProperty(obj: THREE.Object3D, path: string, value: any): boolean {
  try {
    const propType = EDITABLE_PROPERTIES[path];
    if (!propType) {
      // eslint-disable-next-line no-console
      console.warn(`Property "${path}" is not editable`);
      return false;
    }

    // Parse value based on type
    let parsedValue: any;
    if (propType === 'boolean') {
      parsedValue = value === true || value === 'true' || value === '1';
    } else if (propType === 'number') {
      parsedValue = parseFloat(value);
      if (isNaN(parsedValue)) {
        // eslint-disable-next-line no-console
        console.warn(`Invalid number value for "${path}": ${value}`);
        return false;
      }
    } else if (propType === 'color') {
      // Handle color as hex number (e.g. 16777215 or "0xffffff" or "#ffffff")
      let colorValue: number;
      if (typeof value === 'number') {
        colorValue = value;
      } else {
        const strVal = String(value).trim();
        if (strVal.startsWith('#')) {
          colorValue = parseInt(strVal.slice(1), 16);
        } else if (strVal.startsWith('0x')) {
          colorValue = parseInt(strVal, 16);
        } else {
          colorValue = parseInt(strVal, 10);
        }
      }
      if (isNaN(colorValue)) {
        // eslint-disable-next-line no-console
        console.warn(`Invalid color value for "${path}": ${value}`);
        return false;
      }
      parsedValue = colorValue;
    } else {
      parsedValue = String(value);
    }

    // Handle nested paths like position.x or light.color
    const parts = path.split('.');
    if (parts.length === 1) {
      // Special handling for color properties (use setHex)
      if (propType === 'color' && (obj as any)[path]?.setHex) {
        (obj as any)[path].setHex(parsedValue);
      }
      // Special handling for shadow properties
      else if (path.startsWith('shadow') && (obj as any).shadow) {
        const shadowProp = path.replace('shadow', '').toLowerCase();
        if (shadowProp === 'bias') (obj as any).shadow.bias = parsedValue;
        else if (shadowProp === 'normalbias') (obj as any).shadow.normalBias = parsedValue;
        else if (shadowProp === 'radius') (obj as any).shadow.radius = parsedValue;
      }
      else {
        (obj as any)[path] = parsedValue;
      }
    } else if (parts.length === 2) {
      const [parent, child] = parts;
      if (parent && child) {
        // Special handling for light properties which are on the object directly
        if (parent === 'light' && (obj as any).isLight) {
          if (child === 'color' && (obj as any).color) {
            (obj as any).color.setHex(parsedValue);
          } else {
            (obj as any)[child] = parsedValue;
          }
        }
        // Special handling for light target position
        else if (parent === 'target' && (obj as any).target?.position) {
          (obj as any).target.position[child] = parsedValue;
          (obj as any).target.updateMatrixWorld();
        }
        // Special handling for shadow map size
        else if (parent === 'shadowMapSize' && (obj as any).shadow?.mapSize) {
          (obj as any).shadow.mapSize[child] = parsedValue;
          // Shadow map needs to be recreated
          if ((obj as any).shadow.map) {
            (obj as any).shadow.map.dispose();
            (obj as any).shadow.map = null;
          }
        }
        // Special handling for shadow camera
        else if (parent === 'shadowCamera' && (obj as any).shadow?.camera) {
          (obj as any).shadow.camera[child] = parsedValue;
          (obj as any).shadow.camera.updateProjectionMatrix();
        }
        else if ((obj as any)[parent]) {
          (obj as any)[parent][child] = parsedValue;
        }
      }
    }

    // Mark object as needing matrix update
    obj.updateMatrix();
    obj.updateMatrixWorld(true);

    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`Failed to set property "${path}":`, e);
    return false;
  }
}

