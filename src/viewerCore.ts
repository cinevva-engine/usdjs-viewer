import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { LoopSubdivision } from 'three-subdivide';

import { UsdStage, type SdfPrimSpec, type SdfValue, resolveAssetPath } from '@cinevva/usdjs';

export type PrimeTreeNode = {
  key: string;
  label: string;
  children?: PrimeTreeNode[];
  data?: {
    path: string;
    typeName?: string;
  };
};

type SceneNode = {
  path: string;
  typeName?: string;
  prim: SdfPrimSpec;
  children: SceneNode[];
};

export type AnimationState = {
  playing: boolean;
  currentTime: number;
  startTime: number;
  endTime: number;
  framesPerSecond: number;
};

type AnimatedObject =
  | { kind: 'xform'; obj: THREE.Object3D; prim: SdfPrimSpec; unitScale: number }
  | { kind: 'points'; geoms: THREE.BufferGeometry[]; prim: SdfPrimSpec; unitScale: number };

export type ViewerCore = {
  getDefaultUsda(): string;
  getEntryKey(): string;
  getCompose(): boolean;
  getEntryOptions(): Array<{ label: string; value: string }>;
  getEntryText(entryKey: string): string | null;
  getReferenceImageUrl(): string | null;

  setTextarea(text: string): void;
  setEntryKey(key: string): void;
  setCompose(v: boolean): void;
  setSelectedPath(path: string | null): Promise<void>;

  loadLocalFiles(files: FileList): Promise<void>;
  /**
   * Programmatic alternative to `loadLocalFiles` intended for automation / headless rendering.
   * Paths should be the same strings you expect USD composition to resolve to (via `resolveAssetPath`).
   */
  loadTextFiles(files: Array<{ path: string; text: string }>): void;
  loadCorpusEntry(rel: string): Promise<void>;
  restoreLastOpened(): Promise<boolean>;

  run(): Promise<void>;
  dispose(): void;

  // Animation controls
  getAnimationState(): AnimationState;
  setAnimationTime(time: number): void;
  setAnimationPlaying(playing: boolean): void;
  hasAnimation(): boolean;
};

const DEFAULT_USDA = `#usda 1.0
(
  defaultPrim = "World"
  upAxis = "Y"
  metersPerUnit = 0.01
)
def Xform "World" {
  def Sphere "Ball" {
    double radius = 10
    double3 xformOp:translate = (0, 10, 0)
  }
  def Mesh "Cube" {
    # minimal mesh-ish data; viewer currently uses points to compute bounds
    point3f[] points = [(-10,-10,-10), (10,-10,-10), (10,10,-10), (-10,10,-10), (-10,-10,10), (10,-10,10), (10,10,10), (-10,10,10)]
    double3 xformOp:translate = (30, 10, 0)
  }
}
`;

function sdfToNumberTuple(v: SdfValue | undefined, n: number): number[] | null {
  if (!v || typeof v !== 'object') return null;
  if (v.type === 'tuple') {
    const arr = v.value.map((x) => (typeof x === 'number' ? x : 0));
    return arr.length === n ? arr : null;
  }
  return null;
}

function getPrimProp(prim: SdfPrimSpec, name: string): SdfValue | undefined {
  return prim.properties?.get(name)?.defaultValue;
}

/**
 * Get a property value at a specific time, with linear interpolation between keyframes.
 * Falls back to defaultValue if no timeSamples exist.
 */
function getPrimPropAtTime(prim: SdfPrimSpec, name: string, time: number): SdfValue | undefined {
  const prop = prim.properties?.get(name);
  if (!prop) return undefined;

  const timeSamples = prop.timeSamples;
  if (!timeSamples || timeSamples.size === 0) {
    return prop.defaultValue;
  }

  // Get sorted time keys
  const times = Array.from(timeSamples.keys()).sort((a, b) => a - b);

  // Handle edge cases
  if (time <= times[0]!) return timeSamples.get(times[0]!);
  if (time >= times[times.length - 1]!) return timeSamples.get(times[times.length - 1]!);

  // Find surrounding keyframes
  let lowerIdx = 0;
  for (let i = 0; i < times.length - 1; i++) {
    if (times[i]! <= time && time < times[i + 1]!) {
      lowerIdx = i;
      break;
    }
  }

  const t0 = times[lowerIdx]!;
  const t1 = times[lowerIdx + 1]!;
  const v0 = timeSamples.get(t0);
  const v1 = timeSamples.get(t1);

  // Calculate interpolation factor
  const alpha = (time - t0) / (t1 - t0);

  return interpolateSdfValue(v0, v1, alpha);
}

/**
 * Linear interpolation between two SdfValues.
 * Currently supports tuples (vec3, etc.) and numbers.
 */
function interpolateSdfValue(v0: SdfValue | undefined, v1: SdfValue | undefined, alpha: number): SdfValue | undefined {
  if (v0 === undefined || v1 === undefined) return v0;

  // Interpolate numbers
  if (typeof v0 === 'number' && typeof v1 === 'number') {
    return v0 + (v1 - v0) * alpha;
  }

  // Interpolate tuples (vec3, vec4, etc.)
  if (
    typeof v0 === 'object' && v0?.type === 'tuple' &&
    typeof v1 === 'object' && v1?.type === 'tuple' &&
    Array.isArray(v0.value) && Array.isArray(v1.value) &&
    v0.value.length === v1.value.length
  ) {
    const interpolated = v0.value.map((val, i) => {
      const a = typeof val === 'number' ? val : 0;
      const b = typeof v1.value[i] === 'number' ? v1.value[i] : 0;
      return a + (b - a) * alpha;
    });
    return { type: 'tuple', value: interpolated };
  }

  // For non-interpolatable types, use step interpolation (return v0 until we reach t1)
  return alpha < 1 ? v0 : v1;
}

/**
 * Check if a property has animation (timeSamples)
 */
function propHasAnimation(prim: SdfPrimSpec, name: string): boolean {
  const prop = prim.properties?.get(name);
  return !!(prop?.timeSamples && prop.timeSamples.size > 0);
}

function primHasAnimatedPoints(prim: SdfPrimSpec): boolean {
  return propHasAnimation(prim, 'points');
}

/**
 * Get the time range of all animated properties in a prim
 */
function getPrimAnimationTimeRange(prim: SdfPrimSpec): { start: number; end: number } | null {
  let minTime = Infinity;
  let maxTime = -Infinity;
  let hasAnimation = false;

  if (prim.properties) {
    for (const prop of prim.properties.values()) {
      if (prop.timeSamples && prop.timeSamples.size > 0) {
        hasAnimation = true;
        for (const time of prop.timeSamples.keys()) {
          minTime = Math.min(minTime, time);
          maxTime = Math.max(maxTime, time);
        }
      }
    }
  }

  return hasAnimation ? { start: minTime, end: maxTime } : null;
}

function findPrimByPath(root: SdfPrimSpec, path: string): SdfPrimSpec | null {
  if (path === '/') return root;
  const parts = path.split('/').filter(Boolean);
  let cur: SdfPrimSpec = root;
  for (const name of parts) {
    const next = cur.children?.get(name);
    if (!next) {
      // Fallback: some composed layers can end up with inconsistent child maps (especially around references).
      // If the fast map-walk fails, do a one-time DFS to find an exact path match.
      const target = path;
      const stack: SdfPrimSpec[] = [root];
      while (stack.length) {
        const p = stack.pop()!;
        if (p.path?.primPath === target) return p;
        if (p.children) {
          for (const child of p.children.values()) stack.push(child);
        }
      }
      return null;
    }
    cur = next;
  }
  return cur;
}

function findNearestSkelRootPrim(rootPrim: SdfPrimSpec, primPath: string): SdfPrimSpec | null {
  // Walk up the prim path and pick the first SkelRoot (preferred), otherwise the first prim
  // that has a skel:jointOrder authored.
  const parts = primPath.split('/').filter(Boolean);
  let best: SdfPrimSpec | null = null;
  for (let i = parts.length; i >= 1; i--) {
    const p = '/' + parts.slice(0, i).join('/');
    const prim = findPrimByPath(rootPrim, p);
    if (!prim) continue;
    if (prim.typeName === 'SkelRoot') return prim;
    if (!best && prim.properties?.has('skel:jointOrder')) best = prim;
  }
  return best;
}

function extractJointOrderNames(prim: SdfPrimSpec | null | undefined): string[] | null {
  if (!prim?.properties) return null;
  const v: any = prim.properties.get('skel:jointOrder')?.defaultValue;
  if (!v || typeof v !== 'object' || v.type !== 'array' || !Array.isArray(v.value)) return null;
  const names = v.value
    .map((x: any) => (typeof x === 'string' ? x : (x && typeof x === 'object' && x.type === 'token' ? x.value : null)))
    .filter((x: any) => typeof x === 'string') as string[];
  return names.length ? names : null;
}

function buildJointOrderIndexToBoneIndex(jointNames: string[], jointOrderNames: string[] | null): number[] | null {
  if (!jointOrderNames || jointOrderNames.length === 0) return null;
  const nameToIdx = new Map<string, number>();
  for (let i = 0; i < jointNames.length; i++) nameToIdx.set(jointNames[i]!, i);
  return jointOrderNames.map((n) => nameToIdx.get(n) ?? 0);
}

function resolveMaterialBinding(prim: SdfPrimSpec, root: SdfPrimSpec, prototypeRoot?: SdfPrimSpec): SdfPrimSpec | null {
  // USD material binding commonly inherits down namespace: a parent prim can bind a material
  // that applies to all descendant meshes. So we must walk up ancestors to find the nearest binding.
  //
  // Additionally, some files may author binding variants like `material:binding:preview`.
  const pickBindingProp = (p: SdfPrimSpec): { key: string; dv: any } | null => {
    const props = p.properties;
    if (!props) return null;

    const direct = props.get('material:binding');
    if (direct?.defaultValue !== undefined) return { key: 'material:binding', dv: direct.defaultValue as any };

    // Fallback: look for other material binding relationships (e.g. `material:binding:preview`).
    // Ignore property fields (anything after a dot) like `.connect` or `.timeSamples`.
    for (const [k, spec] of props.entries()) {
      if (k === 'material:binding') continue;
      if (!k.startsWith('material:binding')) continue;
      if (k.includes('.')) continue;
      if (spec.defaultValue === undefined) continue;
      return { key: k, dv: spec.defaultValue as any };
    }
    return null;
  };

  const extractFirstSdfPath = (dv: any): string | null => {
    if (!dv) return null;
    if (typeof dv === 'object' && dv.type === 'sdfpath' && typeof dv.value === 'string') return dv.value;
    // Relationships can be authored as arrays of sdfpaths (e.g. `rel prototypes = [</A>, </B>]`).
    if (typeof dv === 'object' && dv.type === 'array' && Array.isArray(dv.value)) {
      for (const el of dv.value) {
        const p = extractFirstSdfPath(el);
        if (p) return p;
      }
    }
    // Some dict/listOp representations can wrap a `value` field.
    if (typeof dv === 'object' && dv.type === 'dict' && dv.value && typeof dv.value === 'object' && 'value' in dv.value) {
      return extractFirstSdfPath((dv.value as any).value);
    }
    return null;
  };

  const stopAtPath = prototypeRoot?.path?.primPath ?? null;
  let cur: SdfPrimSpec | null = prim;
  let bindingPath: string | null = null;
  let bindingKey: string | null = null;

  while (cur) {
    const picked = pickBindingProp(cur);
    if (picked) {
      const p = extractFirstSdfPath(picked.dv);
      if (p) {
        bindingPath = p;
        bindingKey = picked.key;
        break;
      }
    }

    const curPath = cur.path?.primPath;
    if (!curPath || curPath === '/') break;
    if (stopAtPath && curPath === stopAtPath) break;

    const parts = curPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = parts.length ? '/' + parts.join('/') : '/';
    cur = findPrimByPath(root, parentPath);
  }

  if (!bindingPath) {
    console.log(`[resolveMaterialBinding] prim=${prim.path?.primPath} -> NO material binding found (including ancestors)`);
    return null;
  }

  const materialPath = bindingPath;
  console.log(
    `[resolveMaterialBinding] prim=${prim.path?.primPath}, bindingKey=${bindingKey}, materialPath=${materialPath}, prototypeRoot=${prototypeRoot?.path?.primPath}`,
  );

  // If path is absolute (starts with /), try resolving from root first.
  // If that fails and we have a prototypeRoot, try resolving relative to prototype root
  // (for referenced files where paths like /root/Materials/tree_leaves should resolve relative to the reference root).
  if (materialPath.startsWith('/')) {
    const fromRoot = findPrimByPath(root, materialPath);
    console.log(`[resolveMaterialBinding]   fromRoot(${materialPath})=${fromRoot?.path?.primPath ?? 'null'}`);
    if (fromRoot) return fromRoot;

    // For referenced prototypes, try resolving relative to the prototype root.
    // Example: if prototypeRoot is at /World/trees/pointInstancer/asset and materialPath is /root/Materials/tree_leaves,
    // try /World/trees/pointInstancer/asset/Materials/tree_leaves (assuming /root maps to the prototype root).
    if (prototypeRoot) {
      // If material path starts with /root, replace /root with prototype root path
      if (materialPath.startsWith('/root')) {
        const relativePath = prototypeRoot.path.primPath + materialPath.substring('/root'.length);
        const fromPrototype = findPrimByPath(root, relativePath);
        console.log(`[resolveMaterialBinding]   fromPrototype(${relativePath})=${fromPrototype?.path?.primPath ?? 'null'}`);
        if (fromPrototype) return fromPrototype;
      }

      // Generic remap fallback for referenced subtrees:
      // If an absolute material path points at some root (e.g. /World/Looks/Mat) but the referenced
      // content has been mapped under `prototypeRoot` (e.g. /World/simple_mesh_sphere),
      // try replacing the first path element with prototypeRoot.
      const parts = materialPath.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const suffix = '/' + parts.slice(1).join('/');
        const remapped = prototypeRoot.path.primPath + suffix;
        const rem = findPrimByPath(root, remapped);
        console.log(`[resolveMaterialBinding]   remapFirstSeg(${remapped})=${rem?.path?.primPath ?? 'null'}`);
        if (rem) return rem;
      }

      // Also try appending the path (without leading /) to prototype root
      const appendedPath = prototypeRoot.path.primPath === '/' ? materialPath : prototypeRoot.path.primPath + materialPath;
      const appended = findPrimByPath(root, appendedPath);
      console.log(`[resolveMaterialBinding]   appended(${appendedPath})=${appended?.path?.primPath ?? 'null'}`);
      if (appended) return appended;
    }
  } else {
    // Relative path: resolve from prim's parent
    const parentPath = prim.path.primPath === '/' ? '/' : prim.path.primPath.split('/').slice(0, -1).join('/') || '/';
    const relativePath = parentPath === '/' ? '/' + materialPath : parentPath + '/' + materialPath;
    const result = findPrimByPath(root, relativePath);
    console.log(`[resolveMaterialBinding]   relative(${relativePath})=${result?.path?.primPath ?? 'null'}`);
    return result;
  }

  console.log(`[resolveMaterialBinding]   FAILED to resolve material`);
  return null;
}

function resolveShaderFromMaterial(material: SdfPrimSpec, root: SdfPrimSpec): SdfPrimSpec | null {
  // UsdShade commonly uses `outputs:surface.connect`, but MDL/Omniverse materials often use `outputs:mdl:surface.connect`,
  // and MaterialX uses `outputs:mtlx:surface.connect`.
  // We prioritize MaterialX outputs first since they provide more accurate native shader definitions
  // (UsdPreviewSurface outputs are often just fallbacks for MaterialX content).
  const outputKeys = [
    'outputs:mtlx:surface.connect',
    'outputs:mdl:surface.connect',
    'outputs:mdl:displacement.connect',
    'outputs:mdl:volume.connect',
    'outputs:surface.connect',
  ];

  let shaderPath: string | null = null;
  for (const k of outputKeys) {
    const prop = material.properties?.get(k);
    const dv = prop?.defaultValue as any;
    if (dv && typeof dv === 'object' && dv.type === 'sdfpath' && typeof dv.value === 'string') {
      shaderPath = dv.value;
      break;
    }
  }

  if (!shaderPath) return null;

  const lastDot = shaderPath.lastIndexOf('.');
  if (lastDot > 0) {
    shaderPath = shaderPath.substring(0, lastDot);
  }

  // Extract the shader name (last path component) to look for it as a direct child of the material.
  // This handles referenced files where the absolute path (e.g. /root/Materials/tree_leaves/PBRShader)
  // doesn't exist in the composed stage but the shader is a direct child of the material prim.
  const followOutputsToShader = (start: SdfPrimSpec, depth = 0): SdfPrimSpec | null => {
    if (!start || depth > 8) return start ?? null;

    // If it's already a Shader (or looks like one), we're done.
    const infoId = start.properties?.get('info:id')?.defaultValue;
    if (typeof infoId === 'string' && infoId.length) return start;
    if (start.typeName === 'Shader') return start;

    // Common USD pattern: Material.outputs:surface.connect -> NodeGraph.outputs:surface -> Shader.outputs:surface
    // If we landed on a NodeGraph, follow its own outputs to the underlying shader.
    if (start.typeName === 'NodeGraph') {
      for (const k of outputKeys) {
        const prop = start.properties?.get(k);
        const dv = prop?.defaultValue as any;
        if (dv && typeof dv === 'object' && dv.type === 'sdfpath' && typeof dv.value === 'string') {
          let p = dv.value as string;
          const lastDot = p.lastIndexOf('.');
          if (lastDot > 0) p = p.substring(0, lastDot);
          const next = findPrimByPath(root, p);
          if (next) return followOutputsToShader(next, depth + 1);
        }
      }
    }

    return start;
  };

  const shaderName = shaderPath.split('/').pop();
  if (shaderName && material.children?.has(shaderName)) {
    const childShader = material.children.get(shaderName);
    if (childShader) {
      console.log(`[resolveShaderFromMaterial] Found shader as child: ${shaderName}`);
      return followOutputsToShader(childShader);
    }
  }

  // Fallback: try absolute path lookup (works for non-referenced materials)
  const result = findPrimByPath(root, shaderPath);
  console.log(`[resolveShaderFromMaterial] shaderPath=${shaderPath}, shaderName=${shaderName}, foundByAbsPath=${result?.path?.primPath ?? 'null'}`);
  if (result) return followOutputsToShader(result);

  // Last-resort fallback: some composed stages lose/alter `outputs:surface.connect` targets.
  // In that case, try to find *any* Shader under the material prim and use it.
  // This prevents "fully gray" fallback materials when the material binding exists but the connect path doesn't resolve.
  const stack: SdfPrimSpec[] = [];
  if (material.children) for (const c of material.children.values()) stack.push(c);
  while (stack.length) {
    const p = stack.pop()!;
    const infoId = p.properties?.get('info:id')?.defaultValue;
    if (p.typeName === 'Shader' || (typeof infoId === 'string' && infoId.length > 0)) {
      console.warn(`[resolveShaderFromMaterial] Fallback-picked shader under material: ${p.path?.primPath} (info:id=${String(infoId)})`);
      return followOutputsToShader(p);
    }
    if (p.children) for (const c of p.children.values()) stack.push(c);
  }
  return null;
}

function resolveConnectedPrim(root: SdfPrimSpec, from: SdfPrimSpec, inputName: string): SdfPrimSpec | null {
  const prop = from.properties?.get(`${inputName}.connect`);
  const dv: any = prop?.defaultValue;
  if (!dv || typeof dv !== "object" || dv.type !== 'sdfpath' || typeof dv.value !== 'string') return null;

  let targetPath = dv.value;
  const lastDot = targetPath.lastIndexOf('.');
  if (lastDot > 0) targetPath = targetPath.substring(0, lastDot);

  return findPrimByPath(root, targetPath);
}

function resolveConnectedPrimWithOutput(
  root: SdfPrimSpec,
  from: SdfPrimSpec,
  inputName: string,
): { prim: SdfPrimSpec; outputName: string | null } | null {
  const prop = from.properties?.get(`${inputName}.connect`);
  const dv: any = prop?.defaultValue;
  if (!dv || typeof dv !== 'object' || dv.type !== 'sdfpath' || typeof dv.value !== 'string') return null;

  const full = dv.value;
  const lastDot = full.lastIndexOf('.');
  const primPath = lastDot > 0 ? full.substring(0, lastDot) : full;
  const out = lastDot > 0 ? full.substring(lastDot + 1) : null;

  const prim = findPrimByPath(root, primPath);
  if (!prim) return null;
  return { prim, outputName: out };
}

function resolveUsdPrimvarReaderFloat3(root: SdfPrimSpec, shader: SdfPrimSpec, inputName: string): { varname: string } | null {
  const conn = resolveConnectedPrimWithOutput(root, shader, inputName);
  if (!conn) return null;
  const id = conn.prim.properties?.get('info:id')?.defaultValue;
  if (id !== 'UsdPrimvarReader_float3') return null;
  const v = conn.prim.properties?.get('inputs:varname')?.defaultValue;
  if (typeof v !== 'string' || !v) return null;
  return { varname: v };
}

function applyUsdTransform2dToTexture(tex: THREE.Texture, transform2d: SdfPrimSpec) {
  // Match the UsdPreviewSurface proposal definition of UsdTransform2d:
  //
  //   result = in * scale * rotate + translation
  //
  // (rotation is counter-clockwise in degrees around the origin).
  //
  // Three's `repeat/rotation/offset` helpers correspond to `rotate(scale(in)) + offset`,
  // which differs from the above when sx != sy depending on convention. To avoid ambiguity,
  // build the UV transform matrix explicitly.
  const readFloat2 = (name: string): [number, number] | null => {
    const dv: any = transform2d.properties?.get(name)?.defaultValue;
    if (!dv || typeof dv !== 'object' || dv.type !== 'tuple') return null;
    const [x, y] = dv.value ?? [];
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    return [x, y];
  };

  const s = readFloat2('inputs:scale') ?? [1, 1];
  const t = readFloat2('inputs:translation') ?? [0, 0];

  const rotDeg = transform2d.properties?.get('inputs:rotation')?.defaultValue;
  const theta = typeof rotDeg === 'number' ? THREE.MathUtils.degToRad(rotDeg) : 0;
  const c = Math.cos(theta);
  const sn = Math.sin(theta);

  const sx = s[0];
  const sy = s[1];
  const tx = t[0];
  const ty = t[1];

  // USD defines UsdTransform2d in row-vector form:
  //
  //   result = in * scale * rotate + translation
  //
  // For row-vectors, a CCW rotation by theta uses:
  //   [  c  s ]
  //   [ -s  c ]
  //
  // Converting to Three's column-vector shader convention yields:
  //   u' = (sx*c) * u + (-sy*s) * v + tx
  //   v' = (sx*s) * u + ( sy*c) * v + ty
  tex.matrixAutoUpdate = false;
  tex.matrix.set(
    sx * c,
    -sy * sn,
    tx,
    sx * sn,
    sy * c,
    ty,
    0,
    0,
    1,
  );
  tex.needsUpdate = true;
}

function applyWrapMode(tex: THREE.Texture, wrapS?: string, wrapT?: string) {
  const mapWrap = (v?: string) => {
    if (v === 'repeat') return THREE.RepeatWrapping;
    if (v === 'mirror') return THREE.MirroredRepeatWrapping;
    // USD default is "black" (clamp-to-border); Three doesn't support border color,
    // so clamp-to-edge is the closest approximation.
    return THREE.ClampToEdgeWrapping;
  };
  tex.wrapS = mapWrap(wrapS);
  tex.wrapT = mapWrap(wrapT);
}

function cloneTexturePreserveParams(src: THREE.Texture): THREE.Texture {
  const tex = new THREE.Texture(src.image);
  tex.colorSpace = src.colorSpace;
  tex.wrapS = src.wrapS;
  tex.wrapT = src.wrapT;
  tex.repeat.copy(src.repeat);
  tex.offset.copy(src.offset);
  tex.rotation = src.rotation;
  tex.center.copy(src.center);
  tex.flipY = src.flipY;
  tex.needsUpdate = true;
  return tex;
}

function alphaToGreenAlphaMap(src: THREE.Texture): THREE.Texture | null {
  // Three's alphaMap samples the GREEN channel. If our source texture carries the cutout
  // in its real alpha channel, convert it into green so alphaTest works as expected.
  const img: any = (src as any).image;
  if (!img) return null;

  // If the loader already produced ImageData, we can rewrite quickly.
  const w: number = img.width;
  const h: number = img.height;
  if (!w || !h) return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true } as any) as CanvasRenderingContext2D | null;
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h);
    const d = data.data;
    // Move alpha into green and set alpha to 255 (opaque); shader uses .g for alphaMap anyway.
    let hasNonOpaqueAlpha = false;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]!;
      if (a !== 255) hasNonOpaqueAlpha = true;
      d[i + 1] = a;
      d[i + 3] = 255;
    }
    // If there's no meaningful alpha channel, don't convert (keeps RGB-driven masks working).
    if (!hasNonOpaqueAlpha) return null;
    ctx.putImageData(data, 0, 0);
    const out = cloneTexturePreserveParams(src);
    (out as any).image = canvas;
    out.colorSpace = THREE.NoColorSpace;
    out.needsUpdate = true;
    return out;
  } catch {
    return null;
  }
}

function resolveUsdUvTextureInfo(
  root: SdfPrimSpec,
  texShader: SdfPrimSpec,
): {
  file: string;
  wrapS?: string;
  wrapT?: string;
  sourceColorSpace?: string;
  transform2d: SdfPrimSpec | null;
  // UsdUVTexture can apply `result = sample * scale + bias` (per-component).
  // We provide both THREE.Color (for diffuse/emissive) and raw arrays (for normals where values can be outside 0-1).
  scaleRgb?: THREE.Color;
  biasRgb?: THREE.Color;
  // Raw float arrays for scale/bias - can hold values outside 0-1 range (like scale=2, bias=-1 for normals)
  scaleRaw?: [number, number, number];
  biasRaw?: [number, number, number];
} | null {
  const infoId = texShader.properties?.get('info:id')?.defaultValue;
  if (infoId !== 'UsdUVTexture') return null;

  const fileDv: any = texShader.properties?.get('inputs:file')?.defaultValue;
  // Some layers may serialize asset paths as plain strings; support both.
  const filePath =
    typeof fileDv === 'string'
      ? fileDv
      : fileDv && typeof fileDv === 'object' && fileDv.type === 'asset' && typeof fileDv.value === 'string'
        ? fileDv.value
        : null;
  if (!filePath) return null;

  const wrapS = texShader.properties?.get('inputs:wrapS')?.defaultValue;
  const wrapT = texShader.properties?.get('inputs:wrapT')?.defaultValue;
  const sourceColorSpace = texShader.properties?.get('inputs:sourceColorSpace')?.defaultValue;

  const readFloat4 = (name: string): [number, number, number] | undefined => {
    const dv: any = texShader.properties?.get(name)?.defaultValue;
    if (!dv || typeof dv !== 'object' || dv.type !== 'tuple') return undefined;
    const [r, g, b] = dv.value ?? [];
    if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') return undefined;
    return [r, g, b];
  };
  const scaleRaw = readFloat4('inputs:scale');
  const biasRaw = readFloat4('inputs:bias');

  // Create THREE.Color versions (note: these clamp to 0-1 range, so only useful for standard color textures)
  const scaleRgb = scaleRaw ? new THREE.Color(scaleRaw[0], scaleRaw[1], scaleRaw[2]) : undefined;
  const biasRgb = biasRaw ? new THREE.Color(biasRaw[0], biasRaw[1], biasRaw[2]) : undefined;

  // If `inputs:st` connects to a UsdTransform2d, we can at least apply scale/offset/rotation.
  const stSource = resolveConnectedPrim(root, texShader, 'inputs:st');
  const stInfoId = stSource?.properties?.get('info:id')?.defaultValue;
  const transform2d = stInfoId === 'UsdTransform2d' ? stSource : null;

  return {
    file: filePath,
    wrapS: typeof wrapS === 'string' ? wrapS : undefined,
    wrapT: typeof wrapT === 'string' ? wrapT : undefined,
    sourceColorSpace: typeof sourceColorSpace === 'string' ? sourceColorSpace : undefined,
    transform2d,
    scaleRgb,
    biasRgb,
    scaleRaw,
    biasRaw,
  };
}

function extractShaderInputs(shader: SdfPrimSpec, materialPrim?: SdfPrimSpec): {
  diffuseColor?: THREE.Color;
  roughness?: number;
  metallic?: number;
  emissiveColor?: THREE.Color;
  opacity?: number;
  opacityThreshold?: number;
  ior?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
} {
  const result: any = {};

  // Helper to resolve connected value from material prim's interface inputs
  // This handles MaterialX patterns where shader inputs connect to material inputs
  const resolveConnectedColor3f = (inputName: string): THREE.Color | undefined => {
    const connectProp = shader.properties?.get(`${inputName}.connect`);
    const connDv: any = connectProp?.defaultValue;
    if (connDv && typeof connDv === 'object' && connDv.type === 'sdfpath' && typeof connDv.value === 'string') {
      // Check if it connects to a material input (e.g. </MaterialX/Materials/USD_Plastic.inputs:diffuseColor>)
      const targetPath = connDv.value;
      // Extract the input name from the path (e.g. "inputs:diffuseColor")
      const lastDot = targetPath.lastIndexOf('.');
      if (lastDot > 0) {
        const connectedInputName = targetPath.substring(lastDot + 1);
        // Look up the input on the material prim
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

  const getColor3f = (name: string): THREE.Color | undefined => {
    const prop = shader.properties?.get(name);
    const dv: any = prop?.defaultValue;
    if (!dv || typeof dv !== 'object' || dv.type !== 'tuple') {
      // Try connected value
      return resolveConnectedColor3f(name);
    }
    const tuple = dv.value;
    if (tuple.length >= 3 && typeof tuple[0] === 'number' && typeof tuple[1] === 'number' && typeof tuple[2] === 'number') {
      return new THREE.Color(tuple[0], tuple[1], tuple[2]);
    }
    return undefined;
  };

  const getFloat = (name: string): number | undefined => {
    const prop = shader.properties?.get(name);
    if (prop && typeof prop.defaultValue === 'number') return prop.defaultValue;
    // Try connected value
    return resolveConnectedFloat(name);
  };

  result.diffuseColor = getColor3f('inputs:diffuseColor');
  result.roughness = getFloat('inputs:roughness');
  result.metallic = getFloat('inputs:metallic');
  result.emissiveColor = getColor3f('inputs:emissiveColor');
  result.opacity = getFloat('inputs:opacity');
  result.opacityThreshold = getFloat('inputs:opacityThreshold');
  result.ior = getFloat('inputs:ior');
  result.clearcoat = getFloat('inputs:clearcoat');
  result.clearcoatRoughness = getFloat('inputs:clearcoatRoughness');

  return result;
}

function extractOmniPbrInputs(shader: SdfPrimSpec): {
  diffuseColor?: THREE.Color;
  diffuseTexture?: string;
  diffuseTint?: THREE.Color;
  roughness?: number;
  specularLevel?: number;
  emissiveColor?: THREE.Color;
  emissiveColorTexture?: string;
  emissiveIntensity?: number;
  enableEmission?: boolean;
  enableOpacity?: boolean;
  opacityConstant?: number;
  enableOpacityTexture?: boolean;
  opacityTexture?: string;
  opacityThreshold?: number;
  opacityMode?: number;
} {
  const result: any = {};

  const getColor3f = (name: string): THREE.Color | undefined => {
    const prop = shader.properties?.get(name);
    const dv: any = prop?.defaultValue;
    if (!dv || typeof dv !== 'object' || dv.type !== 'tuple') return undefined;
    const tuple = dv.value;
    if (tuple.length >= 3 && typeof tuple[0] === 'number' && typeof tuple[1] === 'number' && typeof tuple[2] === 'number') {
      return new THREE.Color(tuple[0], tuple[1], tuple[2]);
    }
    return undefined;
  };

  const getFloat = (name: string): number | undefined => {
    const prop = shader.properties?.get(name);
    const dv: any = prop?.defaultValue;
    if (typeof dv === 'number') return dv;
    return undefined;
  };

  const getBool = (name: string): boolean | undefined => {
    const prop = shader.properties?.get(name);
    const dv: any = prop?.defaultValue;
    if (typeof dv === 'boolean') return dv;
    if (typeof dv === 'number') return dv !== 0;
    return undefined;
  };

  result.diffuseColor = getColor3f('inputs:diffuse_color_constant');
  const dt = shader.properties?.get('inputs:diffuse_texture')?.defaultValue;
  if (dt && typeof dt === 'object' && dt.type === 'asset' && typeof dt.value === 'string') result.diffuseTexture = dt.value;
  result.diffuseTint = getColor3f('inputs:diffuse_tint');
  result.roughness = getFloat('inputs:reflection_roughness_constant');
  result.specularLevel = getFloat('inputs:specular_level');
  result.emissiveColor = getColor3f('inputs:emissive_color');
  const ect = shader.properties?.get('inputs:emissive_color_texture')?.defaultValue;
  if (ect && typeof ect === 'object' && ect.type === 'asset' && typeof ect.value === 'string') result.emissiveColorTexture = ect.value;
  result.emissiveIntensity = getFloat('inputs:emissive_intensity');
  result.enableEmission = getBool('inputs:enable_emission');

  result.enableOpacity = getBool('inputs:enable_opacity');
  result.opacityConstant = getFloat('inputs:opacity_constant');
  result.enableOpacityTexture = getBool('inputs:enable_opacity_texture');
  const ot = shader.properties?.get('inputs:opacity_texture')?.defaultValue;
  if (ot && typeof ot === 'object' && ot.type === 'asset' && typeof ot.value === 'string') result.opacityTexture = ot.value;
  result.opacityThreshold = getFloat('inputs:opacity_threshold');
  result.opacityMode = getFloat('inputs:opacity_mode');

  return result;
}

/**
 * Extract material inputs from a MaterialX Standard Surface shader (ND_standard_surface_surfaceshader).
 * Standard Surface has different input names than UsdPreviewSurface.
 */
function extractStandardSurfaceInputs(
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

function createMaterialFromShader(
  shader: SdfPrimSpec,
  root: SdfPrimSpec,
  resolveAssetUrl?: (assetPath: string) => string | null,
  materialPrim?: SdfPrimSpec,
): THREE.Material {
  const infoId = shader.properties?.get('info:id');
  const shaderType = infoId?.defaultValue;

  // Handle both UsdPreviewSurface and MaterialX's ND_UsdPreviewSurface_surfaceshader
  const isUsdPreviewSurface = shaderType === 'UsdPreviewSurface' || shaderType === 'ND_UsdPreviewSurface_surfaceshader';
  if (isUsdPreviewSurface) {
    const guessSolidColorFromAssetPath = (assetPath: string): THREE.Color | null => {
      const p = (assetPath ?? '').replace(/\\/g, '/').toLowerCase();
      const base = p.split('/').pop() ?? '';
      const stem = base.replace(/\.[^.]+$/, '');
      // These corpora often use "global-colors/<name>.jpg" for flat color swatches.
      const named: Record<string, number> = {
        red: 0xcc2a2a,
        blue: 0x2a61cc,
        green: 0x2ecc71,
        white: 0xffffff,
        black: 0x111111,
        grey: 0x808080,
        gray: 0x808080,
        greylight: 0xc7c7c7,
        graylight: 0xc7c7c7,
        greymedium: 0x7f7f7f,
        graymedium: 0x7f7f7f,
        mediumgrey: 0x7f7f7f,
        mediumgray: 0x7f7f7f,
        lightgrey: 0xc7c7c7,
        lightgray: 0xc7c7c7,
      };
      if (stem in named) return new THREE.Color(named[stem]!);

      // Heuristics for common swatch naming
      if (stem.includes('grey') || stem.includes('gray')) {
        if (stem.includes('light')) return new THREE.Color(0xc7c7c7);
        if (stem.includes('dark')) return new THREE.Color(0x404040);
        if (stem.includes('medium')) return new THREE.Color(0x7f7f7f);
        return new THREE.Color(0x808080);
      }
      if (stem.includes('red')) return new THREE.Color(0xcc2a2a);
      if (stem.includes('blue')) return new THREE.Color(0x2a61cc);
      if (stem.includes('green')) return new THREE.Color(0x2ecc71);

      // For other missing textures (window/frontlight/backlight), keep default behavior.
      return null;
    };

    const inputs = extractShaderInputs(shader, materialPrim);
    console.log('[NormalBiasScale DEBUG] createMaterialFromShader inputs:', {
      diffuseColor: inputs.diffuseColor ? `rgb(${inputs.diffuseColor.r}, ${inputs.diffuseColor.g}, ${inputs.diffuseColor.b})` : 'none',
      roughness: inputs.roughness,
      metallic: inputs.metallic,
      shaderPath: shader.path?.primPath,
    });
    const mat = new THREE.MeshPhysicalMaterial();

    mat.color.setHex(0xffffff);
    mat.roughness = 0.5;
    mat.metalness = 0.0;
    // Default to double-sided rendering for UsdPreviewSurface materials.
    // Many USD files rely on double-sided rendering for thin surfaces (like planes) without
    // explicitly authoring `doubleSided = true` on the mesh.
    mat.side = THREE.DoubleSide;

    // If diffuseColor is driven by a vertex color primvar, prefer vertex colors over constant diffuse.
    // Example: UsdPreviewSurface_vertexColor.usda uses UsdPrimvarReader_float3 varname="colors".
    const pv = resolveUsdPrimvarReaderFloat3(root, shader, 'inputs:diffuseColor');
    if (pv) {
      // We only currently support mapping primvars:colors and primvars:displayColor into Three's `color` attribute.
      // (The mesh builder emits that attribute for these primvars.)
      (mat as any).vertexColors = true;
      mat.color.setHex(0xffffff);
      (mat as any).userData = { ...(mat as any).userData, usdDiffusePrimvar: pv.varname };
      console.log('[NormalBiasScale DEBUG] Using vertex colors from primvar:', pv.varname);
    } else {
      if (inputs.diffuseColor) {
        mat.color.copy(inputs.diffuseColor);
        console.log('[NormalBiasScale DEBUG] Set diffuseColor:', mat.color.getHexString());
      } else {
        console.log('[NormalBiasScale DEBUG] No diffuseColor input, keeping default white');
      }
    }
    if (inputs.roughness !== undefined) mat.roughness = inputs.roughness;
    if (inputs.metallic !== undefined) mat.metalness = inputs.metallic;

    // Ensure material is updated after setting properties
    mat.needsUpdate = true;
    if (inputs.emissiveColor) {
      mat.emissive = inputs.emissiveColor;
      mat.emissiveIntensity = 1.0;
    }
    if (inputs.opacity !== undefined) {
      mat.opacity = inputs.opacity;
      mat.transparent = inputs.opacity < 1.0;
    }
    // Cutout opacity threshold (alpha test). Example: UsdPreviewSurface_opacityThreshold.usda
    if (inputs.opacityThreshold !== undefined && inputs.opacityThreshold > 0) {
      mat.alphaTest = THREE.MathUtils.clamp(inputs.opacityThreshold, 0, 1);
      // Cutout should not behave like blended transparency.
      mat.transparent = false;
      mat.depthWrite = true;
    }
    // USD UsdPreviewSurface IOR handling:
    // - For non-metallic materials, IOR determines F0 (Fresnel reflectance at normal incidence)
    // - F0 = ((1-ior)/(1+ior))^2
    // - Default IOR = 1.5 → F0 = 0.04
    // - Three.js MeshPhysicalMaterial uses `ior` property to compute F0 the same way
    // - We also scale specularIntensity to 0 when IOR approaches 1.0 (no reflection)
    if (inputs.ior !== undefined) {
      mat.ior = THREE.MathUtils.clamp(inputs.ior, 1.0, 2.333);
      // When IOR = 1.0, there should be no specular reflection (matching air-to-air interface)
      // This helps materials with ior=1 to appear fully matte as intended
      if (inputs.ior <= 1.0) {
        mat.specularIntensity = 0;
      }
    }
    if (inputs.clearcoat !== undefined) {
      mat.clearcoat = THREE.MathUtils.clamp(inputs.clearcoat, 0, 1);
    }
    if (inputs.clearcoatRoughness !== undefined) {
      mat.clearcoatRoughness = THREE.MathUtils.clamp(inputs.clearcoatRoughness, 0, 1);
    }

    // Minimal UsdShade network support: allow `inputs:clearcoat.connect` to a UsdUVTexture.
    // Example: UsdPreviewSurface_clearcoat_with_texture.usda
    if (resolveAssetUrl) {
      // `inputs:diffuseColor.connect` to a UsdUVTexture (e.g. UsdPreviewSurface_multiply_texture.usda)
      const dcSource = resolveConnectedPrim(root, shader, 'inputs:diffuseColor');
      if (dcSource) {
        const info = resolveUsdUvTextureInfo(root, dcSource);
        if (info) {
          const url = resolveAssetUrl(info.file);
          if (url) {
            new THREE.TextureLoader().load(
              url,
              (tex: any) => {
                const cs = (info.sourceColorSpace ?? '').toLowerCase();
                // Many USDs omit `inputs:sourceColorSpace` for baseColor/diffuse textures; default those to sRGB.
                tex.colorSpace = (cs === 'srgb' || cs === '') ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                applyWrapMode(tex, info.wrapS, info.wrapT);
                if (info.transform2d) applyUsdTransform2dToTexture(tex, info.transform2d);
                mat.map = tex;

                // Treat authored constant diffuseColor as a multiply tint (matches OmniPBR samples),
                // and also fold in UsdUVTexture's `inputs:scale` when present.
                // Note: we can't represent UsdUVTexture bias with MeshPhysicalMaterial, so we ignore it
                // unless it's effectively zero.
                const tint = inputs.diffuseColor ? inputs.diffuseColor.clone() : new THREE.Color(1, 1, 1);
                if (info.scaleRgb) tint.multiply(info.scaleRgb);
                mat.color.copy(tint);

                if (info.biasRgb && (info.biasRgb.r !== 0 || info.biasRgb.g !== 0 || info.biasRgb.b !== 0)) {
                  console.warn('UsdUVTexture inputs:bias is not supported for MeshPhysicalMaterial baseColor; ignoring bias=', info.biasRgb);
                }

                mat.needsUpdate = true;
              },
              undefined,
              (err: unknown) => {
                console.error('Failed to load UsdPreviewSurface diffuse texture:', info.file, url, err);
                // Fallback: many corpora use flat color swatch textures; if those are missing (404),
                // infer a reasonable constant base color from the filename so the model isn't fully gray/white.
                const guessed = guessSolidColorFromAssetPath(info.file);
                if (guessed) {
                  mat.map = null;
                  mat.color.copy(guessed);
                  mat.needsUpdate = true;
                  console.warn('UsdPreviewSurface diffuse texture missing; using guessed baseColor from filename:', info.file, guessed.getHexString());
                }
              },
            );
          }
        }
      }

      // `inputs:normal.connect` to a UsdUVTexture (e.g. UsdPreviewSurface_opacityThreshold.usda)
      const nSource = resolveConnectedPrim(root, shader, 'inputs:normal');
      console.log('[NormalBiasScale DEBUG] nSource:', nSource?.path?.primPath ?? 'null');
      if (nSource) {
        const info = resolveUsdUvTextureInfo(root, nSource);
        console.log('[NormalBiasScale DEBUG] texture info:', info ? {
          file: info.file,
          scaleRaw: info.scaleRaw,
          biasRaw: info.biasRaw,
        } : 'null');
        if (info) {
          const url = resolveAssetUrl?.(info.file);
          console.log('[NormalBiasScale DEBUG] resolved URL:', url);
          if (url) {
            // USD's UsdUVTexture applies: result = sample * scale + bias (per-component)
            // Default values are scale=(1,1,1,1) and bias=(0,0,0,0), but for normal maps
            // the typical convention is scale=(2,2,2,2) and bias=(-1,-1,-1,-1) to convert
            // from [0,1] texture range to [-1,1] normal range.
            const scale = info.scaleRaw ?? [2, 2, 2];
            const bias = info.biasRaw ?? [-1, -1, -1];

            // Check if this is the standard Three.js normal map convention
            const isStandardThreeJs = (
              scale[0] === 2 && scale[1] === 2 && scale[2] === 2 &&
              bias[0] === -1 && bias[1] === -1 && bias[2] === -1
            );

            // Store scale/bias for shader customization
            const usdNormalScale = new THREE.Vector3(scale[0], scale[1], scale[2]);
            const usdNormalBias = new THREE.Vector3(bias[0], bias[1], bias[2]);

            // Set up onBeforeCompile to inject custom normal map transformation
            // Only needed if not using standard Three.js convention
            console.log('[NormalBiasScale DEBUG] isStandardThreeJs:', isStandardThreeJs, 'scale:', scale, 'bias:', bias);
            if (!isStandardThreeJs) {
              mat.userData.usdNormalScale = usdNormalScale;
              mat.userData.usdNormalBias = usdNormalBias;
              console.log('[NormalBiasScale DEBUG] Setting up onBeforeCompile for custom scale/bias');

              mat.onBeforeCompile = (shader) => {
                console.log('[NormalBiasScale DEBUG] onBeforeCompile called');
                // Add uniforms for USD normal scale/bias
                shader.uniforms.usdNormalScale = { value: usdNormalScale };
                shader.uniforms.usdNormalBias = { value: usdNormalBias };

                // Add uniform declarations after normalmap_pars_fragment
                shader.fragmentShader = shader.fragmentShader.replace(
                  '#include <normalmap_pars_fragment>',
                  `#include <normalmap_pars_fragment>
uniform vec3 usdNormalScale;
uniform vec3 usdNormalBias;`
                );

                // Three.js includes are NOT expanded at onBeforeCompile time.
                // We need to replace the #include <normal_fragment_maps> directive with our own code.
                // The original normal_fragment_maps.glsl.js contains:
                //   vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
                //   mapN.xy *= normalScale;
                //   normal = normalize( tbn * mapN );
                // We replace the entire include with custom code that uses USD's scale/bias.
                const customNormalFragmentMaps = `
#ifdef USE_NORMALMAP_OBJECTSPACE
  normal = texture2D( normalMap, vNormalMapUv ).xyz * usdNormalScale + usdNormalBias;
  #ifdef FLIP_SIDED
    normal = - normal;
  #endif
  #ifdef DOUBLE_SIDED
    normal = normal * faceDirection;
  #endif
  normal = normalize( normalMatrix * normal );
#elif defined( USE_NORMALMAP_TANGENTSPACE )
  vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * usdNormalScale + usdNormalBias;
  mapN.xy *= normalScale;
  normal = normalize( tbn * mapN );
#elif defined( USE_BUMPMAP )
  normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );
#endif
`;
                const hasInclude = shader.fragmentShader.includes('#include <normal_fragment_maps>');
                shader.fragmentShader = shader.fragmentShader.replace(
                  '#include <normal_fragment_maps>',
                  customNormalFragmentMaps
                );
                const replaced = !shader.fragmentShader.includes('#include <normal_fragment_maps>');
                console.log('[NormalBiasScale DEBUG] normal_fragment_maps include found:', hasInclude, 'replaced:', replaced);
              };

              // Ensure shader gets recompiled
              mat.customProgramCacheKey = () => `usd_normal_${scale.join('_')}_${bias.join('_')}`;
            } else {
              console.log('[NormalBiasScale DEBUG] Using standard Three.js normal map handling');
            }

            new THREE.TextureLoader().load(
              url,
              (tex: any) => {
                console.log('[NormalBiasScale DEBUG] Normal texture loaded successfully:', info.file);
                tex.colorSpace = THREE.NoColorSpace;
                applyWrapMode(tex, info.wrapS, info.wrapT);
                if (info.transform2d) applyUsdTransform2dToTexture(tex, info.transform2d);
                mat.normalMap = tex;

                // For standard Three.js convention, we don't need custom shader
                // normalScale is left at default (1,1)
                mat.needsUpdate = true;
                console.log('[NormalBiasScale DEBUG] Material after normal map:', {
                  color: mat.color.getHexString(),
                  normalMap: !!mat.normalMap,
                  roughness: mat.roughness,
                  metalness: mat.metalness,
                });
              },
              undefined,
              (err: unknown) => {
                console.error('Failed to load UsdPreviewSurface normal texture:', info.file, url, err);
              },
            );
          }
        }
      }

      // `inputs:opacity.connect` to a UsdUVTexture (e.g. UsdPreviewSurface_opacityThreshold.usda)
      // Used together with `inputs:opacityThreshold` for cutout.
      const oConn = resolveConnectedPrimWithOutput(root, shader, 'inputs:opacity');
      if (oConn) {
        const info = resolveUsdUvTextureInfo(root, oConn.prim);
        if (info) {
          const url = resolveAssetUrl(info.file);
          if (url) {
            new THREE.TextureLoader().load(
              url,
              (tex: any) => {
                // Opacity is data; do not color-manage.
                tex.colorSpace = THREE.NoColorSpace;
                applyWrapMode(tex, info.wrapS, info.wrapT);
                if (info.transform2d) applyUsdTransform2dToTexture(tex, info.transform2d);
                // Three's alphaMap uses the GREEN channel. If USD connected `outputs:a` (alpha),
                // prefer the actual alpha channel by converting it into green.
                if (oConn.outputName === 'outputs:a') {
                  const converted = alphaToGreenAlphaMap(tex);
                  mat.alphaMap = converted ?? tex;
                } else {
                  mat.alphaMap = tex;
                }
                // If threshold wasn't authored but an opacity map exists, default to a gentle cutout.
                if (mat.alphaTest === 0) mat.alphaTest = 0.5;
                mat.transparent = false;
                mat.depthWrite = true;
                mat.needsUpdate = true;

                if (info.biasRgb && (info.biasRgb.r !== 0 || info.biasRgb.g !== 0 || info.biasRgb.b !== 0)) {
                  console.warn('UsdUVTexture inputs:bias is not supported for opacity; ignoring bias=', info.biasRgb);
                }
              },
              undefined,
              (err: unknown) => {
                console.error('Failed to load UsdPreviewSurface opacity texture:', info.file, url, err);
              },
            );
          }
        }
      }

      const ccSource = resolveConnectedPrim(root, shader, 'inputs:clearcoat');
      if (ccSource) {
        const info = resolveUsdUvTextureInfo(root, ccSource);
        if (info) {
          const url = resolveAssetUrl(info.file);
          if (url) {
            new THREE.TextureLoader().load(
              url,
              (tex: any) => {
                tex.colorSpace = THREE.NoColorSpace;
                applyWrapMode(tex, info.wrapS, info.wrapT);
                if (info.transform2d) applyUsdTransform2dToTexture(tex, info.transform2d);
                mat.clearcoatMap = tex;
                mat.needsUpdate = true;
              },
              undefined,
              (err: unknown) => {
                console.error('Failed to load UsdPreviewSurface clearcoat texture:', info.file, url, err);
              },
            );
            if (inputs.clearcoat === undefined) mat.clearcoat = 1.0;

            // When clearcoat is texture-driven, disable specular and environment reflections on the base layer.
            // This is critical for matching USD/Omniverse rendering where the base layer with roughness=0.7
            // appears completely matte/diffuse in areas where the clearcoat texture is dark (0).
            // The clearcoat layer itself (where texture is bright) provides all the glossy reflections.
            //
            // Three.js MeshPhysicalMaterial computes: final = base_diffuse + base_specular + clearcoat_specular
            // In USD, with roughness=0.7 and metallic=0, the base should be nearly purely diffuse.
            // Setting specularIntensity=0 and envMapIntensity=0 ensures the base layer shows only diffuse lighting.
            const isNonMetallic = inputs.metallic === undefined || inputs.metallic === 0;
            const isRough = mat.roughness >= 0.5;
            if (isNonMetallic && isRough) {
              // Completely disable specular reflections on the base layer.
              // Only the clearcoat layer (modulated by clearcoatMap) will produce glossy reflections.
              mat.specularIntensity = 0;
              mat.envMapIntensity = 0;
            }
          }
        }
      }

      // `inputs:emissiveColor.connect` to a UsdUVTexture (e.g. UsdPreviewSurface_emissive_texture.usda)
      const emSource = resolveConnectedPrim(root, shader, 'inputs:emissiveColor');
      if (emSource) {
        const info = resolveUsdUvTextureInfo(root, emSource);
        if (info) {
          const url = resolveAssetUrl(info.file);
          if (url) {
            new THREE.TextureLoader().load(
              url,
              (tex: any) => {
                const cs = (info.sourceColorSpace ?? '').toLowerCase();
                tex.colorSpace = (cs === 'srgb' || cs === '') ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                applyWrapMode(tex, info.wrapS, info.wrapT);
                if (info.transform2d) applyUsdTransform2dToTexture(tex, info.transform2d);
                mat.emissiveMap = tex;

                // Ensure the emissive map actually contributes if no constant emissiveColor was authored.
                if (!inputs.emissiveColor) mat.emissive.setHex(0xffffff);
                mat.emissiveIntensity = Math.max(mat.emissiveIntensity, 1.0);
                mat.needsUpdate = true;
              },
              undefined,
              (err: unknown) => {
                console.error('Failed to load UsdPreviewSurface emissive texture:', info.file, url, err);
              },
            );
          }
        }
      }
    }

    return mat;
  }

  // Handle MaterialX Standard Surface shader (ND_standard_surface_surfaceshader)
  const isStandardSurface = shaderType === 'ND_standard_surface_surfaceshader';
  if (isStandardSurface) {
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

  const mdlSubIdProp = shader.properties?.get('info:mdl:sourceAsset:subIdentifier');
  const mdlSubId = mdlSubIdProp?.defaultValue;
  if (typeof mdlSubId === 'string' && mdlSubId === 'OmniPBR') {
    const inputs = extractOmniPbrInputs(shader);
    const mat = new THREE.MeshStandardMaterial();

    mat.color.setHex(0xffffff);
    // Default to fully rough (no specular) unless authored. OmniPBR materials without
    // authored roughness (especially emissive-only) should not show distracting specular highlights.
    mat.roughness = 1.0;
    mat.metalness = 0.0;
    // Default to double-sided rendering for OmniPBR materials since USD files
    // often don't author doubleSided but expect visibility from both sides.
    mat.side = THREE.DoubleSide;

    if (inputs.diffuseColor) mat.color.copy(inputs.diffuseColor);
    if (inputs.diffuseTint) mat.color.copy(inputs.diffuseTint);

    // Albedo map (the "multiply texture" samples use a diffuse texture and a tint multiplier)
    if (inputs.diffuseTexture && resolveAssetUrl) {
      const url = resolveAssetUrl(inputs.diffuseTexture);
      if (url) {
        const tex = new THREE.TextureLoader().load(url);
        tex.colorSpace = THREE.SRGBColorSpace;
        mat.map = tex;
      }
    }

    if (inputs.roughness !== undefined) mat.roughness = THREE.MathUtils.clamp(inputs.roughness, 0, 1);
    if (inputs.specularLevel !== undefined) mat.metalness = THREE.MathUtils.clamp(inputs.specularLevel * 0.1, 0, 1);

    const enable = inputs.enableEmission ?? false;
    if (enable) {
      if (inputs.emissiveColor) mat.emissive.copy(inputs.emissiveColor);
      else mat.emissive.setHex(0xffffff);

      if (inputs.emissiveColorTexture && resolveAssetUrl) {
        const url = resolveAssetUrl(inputs.emissiveColorTexture);
        if (url) {
          const tex = new THREE.TextureLoader().load(url);
          tex.colorSpace = THREE.SRGBColorSpace;
          mat.emissiveMap = tex;
        }
      }

      const ei = inputs.emissiveIntensity ?? 0;
      mat.emissiveIntensity = Math.max(0, ei / 1000);
    } else {
      mat.emissive.setHex(0x000000);
      mat.emissiveIntensity = 0;
    }

    // Cutout/fractional opacity support (minimal): if enabled, drive material.opacity.
    // OmniPBR's `enable_opacity` is described as "cutout opacity" in the sample, but the constant values
    // (0.75/0.5/0.25) look like fractional opacity. We'll treat it as alpha blending for now.
    if (inputs.enableOpacity && inputs.opacityConstant !== undefined) {
      const a = THREE.MathUtils.clamp(inputs.opacityConstant, 0, 1);
      mat.opacity = a;
      mat.transparent = a < 1;
      // Avoid sorting artifacts being too extreme for now.
      mat.depthWrite = a >= 1;
    }

    // Texture cutout opacity with threshold (OmniPBR_opacityThreshold.usda)
    if (inputs.enableOpacity && inputs.enableOpacityTexture && inputs.opacityTexture && resolveAssetUrl) {
      const thr = inputs.opacityThreshold ?? 0;
      if (thr > 0) {
        const url = resolveAssetUrl(inputs.opacityTexture);
        if (url) {
          new THREE.TextureLoader().load(
            url,
            (tex: any) => {
              // Opacity map should be treated as data, not color-managed.
              tex.colorSpace = THREE.NoColorSpace;

              // Three's alphaMap samples GREEN; if this texture has a meaningful alpha channel
              // (common for cutout leaves), convert alpha->green for correct masking.
              mat.alphaMap = alphaToGreenAlphaMap(tex) ?? tex;
              mat.alphaTest = THREE.MathUtils.clamp(thr, 0, 1);
              mat.transparent = false; // cutout/discard, not blending
              mat.depthWrite = true;
              mat.needsUpdate = true;

              const mode = inputs.opacityMode ?? 0;
              if (mode !== 0) {
                // 0=mono_alpha; others are RGB-derived in OmniPBR (average/luminance/max).
                console.warn('OmniPBR opacity_mode not fully supported (expected alpha channel). opacity_mode=', mode);
              }
            },
            undefined,
            (err: unknown) => {
              console.error('Failed to load OmniPBR opacity texture:', inputs.opacityTexture, url, err);
            },
          );
        }
      }
    }

    return mat;
  }

  return new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
}

function buildTree(root: SdfPrimSpec): SceneNode {
  const walk = (p: SdfPrimSpec): SceneNode => {
    const children = Array.from(p.children?.values() ?? []).map(walk);
    return { path: p.path.toString(), typeName: p.typeName, prim: p, children };
  };
  return walk(root);
}

function toPrimeTree(node: SceneNode): PrimeTreeNode {
  const displayName = node.prim.metadata?.displayName;
  const label =
    typeof displayName === 'string' ? displayName : node.path === '/' ? '/' : node.path.split('/').pop() || node.path;
  return {
    key: node.path,
    label,
    data: { path: node.path, typeName: node.typeName },
    children: node.children.map(toPrimeTree),
  };
}

function computePointsBounds(points: SdfValue | undefined): THREE.Box3 | null {
  if (!points || typeof points !== 'object' || points.type !== 'array') return null;
  const b = new THREE.Box3();
  let any = false;
  for (const el of points.value) {
    if (!el || typeof el !== 'object' || el.type !== 'tuple') continue;
    const [x, y, z] = el.value;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') continue;
    b.expandByPoint(new THREE.Vector3(x, y, z));
    any = true;
  }
  return any ? b : null;
}

function parseNumberArray(v: SdfValue | undefined): number[] | null {
  if (!v || typeof v !== 'object' || v.type !== 'array') return null;
  const out: number[] = [];
  for (const el of v.value) {
    if (typeof el === 'number') out.push(el);
  }
  return out.length ? out : null;
}

/**
 * Parse USD matrix4d[] array into THREE.Matrix4 array.
 * USD matrices are stored as nested tuples in row-major order:
 * matrix4d[] = [( (r0c0, r0c1, r0c2, r0c3), (r1c0, r1c1, r1c2, r1c3), (r2c0, r2c1, r2c2, r2c3), (r3c0, r3c1, r3c2, r3c3) ), ...]
 * 
 * USD uses row-vector convention where transforms are applied as v' = v * M.
 * Translation is stored in row 4 (indices 12-15 in flattened row-major).
 * Three.js uses column-vector convention where transforms are applied as v' = M * v.
 * Translation is stored in column 4 (indices 12-14 in column-major storage).
 * 
 * To convert, we transpose the USD matrix.
 */
function parseMatrix4dArray(v: SdfValue | undefined): THREE.Matrix4[] | null {
  if (!v || typeof v !== 'object' || v.type !== 'array') return null;
  const matrices: THREE.Matrix4[] = [];
  for (const mat of v.value) {
    if (!mat || typeof mat !== 'object' || mat.type !== 'tuple' || mat.value.length !== 4) continue;
    // Each mat.value is 4 rows, each row is a tuple of 4 numbers
    const rows: number[][] = [];
    for (const row of mat.value) {
      if (!row || typeof row !== 'object' || row.type !== 'tuple' || row.value.length !== 4) {
        rows.push([0, 0, 0, 0]);
        continue;
      }
      const nums = row.value.map((n: any) => (typeof n === 'number' ? n : 0));
      rows.push(nums);
    }
    // Transpose: USD row becomes Three.js column
    // Matrix4.set takes row-by-row in its arguments, so we pass columns from USD as rows
    const m = new THREE.Matrix4();
    m.set(
      rows[0]![0]!, rows[1]![0]!, rows[2]![0]!, rows[3]![0]!,  // Column 0 of USD -> Row 1 of set()
      rows[0]![1]!, rows[1]![1]!, rows[2]![1]!, rows[3]![1]!,  // Column 1 of USD -> Row 2 of set()
      rows[0]![2]!, rows[1]![2]!, rows[2]![2]!, rows[3]![2]!,  // Column 2 of USD -> Row 3 of set()
      rows[0]![3]!, rows[1]![3]!, rows[2]![3]!, rows[3]![3]!   // Column 3 of USD -> Row 4 of set()
    );
    matrices.push(m);
  }
  return matrices.length ? matrices : null;
}

function parsePoint3ArrayToFloat32(v: SdfValue | undefined): Float32Array | null {
  if (!v || typeof v !== 'object' || v.type !== 'array') return null;
  const pts = v.value;
  const arr = new Float32Array(pts.length * 3);
  let w = 0;
  for (const el of pts) {
    if (!el || typeof el !== 'object' || el.type !== 'tuple') return null;
    const [x, y, z] = el.value;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
    arr[w++] = x;
    arr[w++] = y;
    arr[w++] = z;
  }
  return arr;
}

function parseTuple3ArrayToFloat32(v: SdfValue | undefined): Float32Array | null {
  // For arrays of tuples with 3 numeric components (e.g. color3f[], normal3f[]).
  if (!v || typeof v !== 'object' || v.type !== 'array') return null;
  const pts = v.value;
  const arr = new Float32Array(pts.length * 3);
  let w = 0;
  for (const el of pts) {
    if (!el || typeof el !== 'object' || el.type !== 'tuple') return null;
    const [x, y, z] = el.value;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
    arr[w++] = x;
    arr[w++] = y;
    arr[w++] = z;
  }
  return arr;
}

function getPropMetadataString(prop: { metadata?: Record<string, SdfValue> } | undefined, key: string): string | null {
  const v = prop?.metadata?.[key];
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && v.type === 'token') return v.value;
  return null;
}

function getPropMetadataNumber(prop: { metadata?: Record<string, SdfValue> } | undefined, key: string): number | null {
  const v = prop?.metadata?.[key];
  if (typeof v === 'number') return v;
  return null;
}

/**
 * Flip triangle winding order for a geometry.
 * This converts between leftHanded and rightHanded orientation.
 * For indexed geometry, swaps indices. For non-indexed, swaps vertex positions.
 * @param recomputeNormals - If true, recompute vertex normals after flipping (use when normals aren't authored)
 * @param smoothNormals - If true, recompute smooth normals for de-indexed geometry when possible
 */
function flipGeometryWinding(geom: THREE.BufferGeometry, recomputeNormals = false, smoothNormals = true): void {
  const index = geom.getIndex();
  if (index) {
    // Indexed geometry: swap second and third vertex of each triangle
    const arr = index.array;
    for (let i = 0; i < arr.length; i += 3) {
      const tmp = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = tmp;
    }
    index.needsUpdate = true;
  } else {
    // Non-indexed geometry: swap vertex attributes for each triangle
    const pos = geom.getAttribute('position') as THREE.BufferAttribute;
    if (!pos) return;
    const numVerts = pos.count;
    const swapTriVerts = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null, itemSize: number) => {
      if (!attr) return;
      const a = attr.array;
      for (let tri = 0; tri < numVerts; tri += 3) {
        const v1Start = (tri + 1) * itemSize;
        const v2Start = (tri + 2) * itemSize;
        for (let j = 0; j < itemSize; j++) {
          const tmp = a[v1Start + j];
          a[v1Start + j] = a[v2Start + j];
          a[v2Start + j] = tmp;
        }
      }
      attr.needsUpdate = true;
    };
    swapTriVerts(pos, 3);
    if (!recomputeNormals) swapTriVerts(geom.getAttribute('normal') as THREE.BufferAttribute, 3);
    swapTriVerts(geom.getAttribute('uv') as THREE.BufferAttribute, 2);
    swapTriVerts(geom.getAttribute('color') as THREE.BufferAttribute, 3);
    swapTriVerts(geom.getAttribute('_originalPointIndex') as THREE.BufferAttribute, 1);
  }
  if (recomputeNormals) {
    // For non-indexed geometry with _originalPointIndex, optionally use smooth normal computation.
    // When smoothNormals=false, fall back to flat normals (computeVertexNormals on de-indexed geometry).
    if (!index && smoothNormals && geom.getAttribute('_originalPointIndex')) {
      computeSmoothNormalsDeindexed(geom);
    } else {
      geom.computeVertexNormals();
    }
  }
}

/**
 * Compute smooth vertex normals for de-indexed geometry.
 * Uses the _originalPointIndex attribute to average face normals across vertices
 * that came from the same original point, producing smooth shading.
 * Falls back to computeVertexNormals() (flat shading) if _originalPointIndex is missing.
 */
function computeSmoothNormalsDeindexed(geom: THREE.BufferGeometry): void {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute;
  const origIdx = geom.getAttribute('_originalPointIndex') as THREE.BufferAttribute;
  if (!pos || !origIdx) {
    // Fallback to flat normals if we don't have original point indices
    geom.computeVertexNormals();
    return;
  }

  const numVerts = pos.count;
  const numTris = numVerts / 3;

  // Step 1: Compute face normals for each triangle
  const faceNormals = new Float32Array(numTris * 3);
  for (let t = 0; t < numTris; t++) {
    const i0 = t * 3;
    const i1 = t * 3 + 1;
    const i2 = t * 3 + 2;

    const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
    const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
    const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);

    // Edge vectors
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;

    // Cross product (face normal, not normalized - magnitude = face area for weighting)
    faceNormals[t * 3 + 0] = aby * acz - abz * acy;
    faceNormals[t * 3 + 1] = abz * acx - abx * acz;
    faceNormals[t * 3 + 2] = abx * acy - aby * acx;
  }

  // Step 2: Accumulate face normals per original point index
  // Find max original point index to size the accumulator
  let maxOrigIdx = 0;
  for (let i = 0; i < numVerts; i++) {
    const oi = origIdx.getX(i);
    if (oi > maxOrigIdx) maxOrigIdx = oi;
  }
  const pointNormals = new Float32Array((maxOrigIdx + 1) * 3);

  // Accumulate face normals for each original point
  for (let t = 0; t < numTris; t++) {
    const fnx = faceNormals[t * 3 + 0];
    const fny = faceNormals[t * 3 + 1];
    const fnz = faceNormals[t * 3 + 2];

    for (let corner = 0; corner < 3; corner++) {
      const vi = t * 3 + corner;
      const oi = origIdx.getX(vi);
      pointNormals[oi * 3 + 0] += fnx;
      pointNormals[oi * 3 + 1] += fny;
      pointNormals[oi * 3 + 2] += fnz;
    }
  }

  // Normalize accumulated normals
  for (let p = 0; p <= maxOrigIdx; p++) {
    const nx = pointNormals[p * 3 + 0];
    const ny = pointNormals[p * 3 + 1];
    const nz = pointNormals[p * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-10) {
      pointNormals[p * 3 + 0] = nx / len;
      pointNormals[p * 3 + 1] = ny / len;
      pointNormals[p * 3 + 2] = nz / len;
    } else {
      // Degenerate: default to up
      pointNormals[p * 3 + 0] = 0;
      pointNormals[p * 3 + 1] = 1;
      pointNormals[p * 3 + 2] = 0;
    }
  }

  // Step 3: Assign smooth normals to each vertex based on original point index
  const normals = new Float32Array(numVerts * 3);
  for (let i = 0; i < numVerts; i++) {
    const oi = origIdx.getX(i);
    normals[i * 3 + 0] = pointNormals[oi * 3 + 0];
    normals[i * 3 + 1] = pointNormals[oi * 3 + 1];
    normals[i * 3 + 2] = pointNormals[oi * 3 + 2];
  }

  geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
}

function buildUsdMeshGeometry(prim: SdfPrimSpec, unitScale = 1.0): THREE.BufferGeometry | null {
  const points = parsePoint3ArrayToFloat32(getPrimProp(prim, 'points'));
  const faceVertexCounts = parseNumberArray(getPrimProp(prim, 'faceVertexCounts'));
  const faceVertexIndices = parseNumberArray(getPrimProp(prim, 'faceVertexIndices'));
  if (!points || !faceVertexCounts || !faceVertexIndices) return null;

  // USD orientation attribute: determines face winding order
  // - rightHanded (default): counter-clockwise winding when viewed from front
  // - leftHanded: clockwise winding when viewed from front
  // Three.js uses counter-clockwise for front faces, so leftHanded meshes need winding flipped
  const orientationProp = getPrimProp(prim, 'orientation');
  const orientation = typeof orientationProp === 'object' && orientationProp?.type === 'token'
    ? orientationProp.value
    : typeof orientationProp === 'string'
      ? orientationProp
      : 'rightHanded'; // USD default
  const isLeftHanded = orientation === 'leftHanded';

  // USD subdivision surface support
  // Check for subdivisionScheme (catmullClark, loop, bilinear, none)
  const subdivisionSchemeProp = getPrimProp(prim, 'subdivisionScheme');
  const subdivisionScheme = typeof subdivisionSchemeProp === 'object' && subdivisionSchemeProp?.type === 'token'
    ? subdivisionSchemeProp.value
    : typeof subdivisionSchemeProp === 'string'
      ? subdivisionSchemeProp
      : null;

  // refinementLevel determines how many subdivision iterations to apply
  const refinementLevelProp = getPrimProp(prim, 'refinementLevel');
  const refinementLevel = typeof refinementLevelProp === 'number'
    ? refinementLevelProp
    : 0;

  // refinementEnableOverride must be true to enable subdivision
  const refinementEnableProp = getPrimProp(prim, 'refinementEnableOverride');
  const refinementEnabled =
    refinementEnableProp === true ||
    refinementEnableProp === 1 ||
    (typeof refinementEnableProp === 'object' &&
      refinementEnableProp !== null &&
      typeof (refinementEnableProp as any).type === 'string' &&
      (refinementEnableProp as any).value === true);

  // Determine if we should apply subdivision
  const shouldSubdivide = refinementEnabled
    && refinementLevel > 0
    && subdivisionScheme
    && subdivisionScheme !== 'none'
    && subdivisionScheme !== 'bilinear';

  // Apply stage unit scale (metersPerUnit) so lighting/camera behave consistently.
  // Example: many ft-lab samples author `metersPerUnit = 0.01` (centimeters).
  if (unitScale !== 1.0) {
    for (let i = 0; i < points.length; i++) points[i] = points[i]! * unitScale;
  }

  // UVs (primvars:st)
  // Note: some exporters (notably 3ds Max) author UVs as `primvars:map1` instead of `primvars:st`.
  const uvPrimvarName =
    prim.properties?.has('primvars:st')
      ? 'primvars:st'
      : prim.properties?.has('primvars:map1')
        ? 'primvars:map1'
        : prim.properties?.has('primvars:uv')
          ? 'primvars:uv'
          : prim.properties?.has('primvars:st0')
            ? 'primvars:st0'
            : null;
  const stProp = uvPrimvarName ? prim.properties?.get(uvPrimvarName) : undefined;
  const stInterp = getPropMetadataString(stProp, 'interpolation');
  const st = (() => {
    const dv: any = stProp?.defaultValue;
    if (!dv || typeof dv !== 'object' || dv.type !== 'array') return null;
    const arr = new Float32Array(dv.value.length * 2);
    let w = 0;
    for (const el of dv.value) {
      if (!el || typeof el !== 'object' || el.type !== 'tuple') return null;
      const [u, v] = el.value;
      if (typeof u !== 'number' || typeof v !== 'number') return null;
      arr[w++] = u;
      arr[w++] = v;
    }
    return arr;
  })();
  const stIndices = uvPrimvarName ? parseNumberArray(getPrimProp(prim, `${uvPrimvarName}:indices`)) : null;

  // primvars:displayColor support (common "viewport color" in USD)
  const displayColorProp = prim.properties?.get('primvars:displayColor');
  const displayColorInterp = getPropMetadataString(displayColorProp, 'interpolation');
  const displayColor = parseTuple3ArrayToFloat32(displayColorProp?.defaultValue);
  const displayColorIndices = parseNumberArray(getPrimProp(prim, 'primvars:displayColor:indices'));

  // General vertex color primvar support (e.g. UsdPreviewSurface_vertexColor.usda uses primvars:colors)
  // Note: we only attach ONE color attribute (Three's standard `color`) and prefer displayColor.
  const colorsProp = prim.properties?.get('primvars:colors');
  const colorsInterp = getPropMetadataString(colorsProp, 'interpolation');
  const colors = parseTuple3ArrayToFloat32(colorsProp?.defaultValue);
  const colorsIndices = parseNumberArray(getPrimProp(prim, 'primvars:colors:indices'));

  // Authored normals support
  // Canonical USD Mesh normals are the `normals` attribute, but some exporters author them as a primvar:
  // `primvars:normals` (often faceVarying for hard edges).
  const normalsName =
    prim.properties?.has('normals') ? 'normals' : prim.properties?.has('primvars:normals') ? 'primvars:normals' : null;
  const normalsProp = normalsName ? prim.properties?.get(normalsName) : undefined;
  let normalsInterp = getPropMetadataString(normalsProp, 'interpolation');
  const normals = parseTuple3ArrayToFloat32(normalsProp?.defaultValue);
  const normalsIndices = normalsName ? parseNumberArray(getPrimProp(prim, `${normalsName}:indices`)) : null;
  const hasNormals = !!(normals && normals.length > 0);

  let triCount = 0;
  for (const c of faceVertexCounts) {
    const n = c | 0;
    if (n >= 3) triCount += n - 2;
  }
  if (triCount <= 0) return null;

  const numVerts = points.length / 3;
  const numTris = triCount;
  if (numVerts > 500_000 || numTris > 1_000_000) return null;

  // Infer normals interpolation if not authored explicitly.
  //
  // IMPORTANT: Many USD exporters author indexed normals:
  // - `normals` holds a unique table of normal vectors
  // - `normals:indices` maps each element (vertex / faceVarying corner / face) into that table
  //
  // In those cases, looking only at `normals.length` can misclassify interpolation (and produce
  // overly-smooth shading). Prefer inferring from the *indices* array length when present.
  if (hasNormals && !normalsInterp) {
    const idxCount = normalsIndices?.length ?? 0;
    if (idxCount === 1) normalsInterp = 'constant';
    else if (idxCount === numVerts) normalsInterp = 'vertex';
    else if (idxCount === faceVertexIndices.length) normalsInterp = 'faceVarying';
    else if (idxCount === faceVertexCounts.length) normalsInterp = 'uniform';
    else {
      // Fallback heuristic based on the authored normal element count (unindexed case).
      const nCount = normals.length / 3;
      if (nCount === 1) normalsInterp = 'constant';
      else if (nCount === numVerts) normalsInterp = 'vertex';
      else if (nCount === faceVertexIndices.length) normalsInterp = 'faceVarying';
      else if (nCount === faceVertexCounts.length) normalsInterp = 'uniform';
    }
  }

  // For polygonal (non-subdiv) meshes, many assets expect hard edges.
  // If normals are missing we generate flat normals.
  // If normals are authored as vertex-interpolated on a polygonal mesh, they often produce
  // overly-smooth shading (typical exporter behavior for hard-surface assets). In that case,
  // prefer recomputing flat normals.
  const forceFlatNormals = subdivisionScheme === 'none' && hasNormals && normalsInterp === 'vertex';
  const useAuthoredNormals = hasNormals && !forceFlatNormals;
  const wantFlatNormals = subdivisionScheme === 'none' && (!hasNormals || forceFlatNormals);

  const vtxColor = displayColor ?? colors;
  let vtxColorInterp = displayColor ? displayColorInterp : colorsInterp;
  const vtxColorIndices = displayColor ? displayColorIndices : colorsIndices;

  // USD primvar interpolation defaults to "constant" when not authored.
  // Many simple samples omit the `interpolation` metadata, so infer it from element count.
  if (vtxColor && !vtxColorInterp) {
    const cCount = vtxColor.length / 3;
    if (cCount === 1) vtxColorInterp = 'constant';
    else if (cCount === numVerts) vtxColorInterp = 'vertex';
    else if (cCount === faceVertexIndices.length) vtxColorInterp = 'faceVarying';
    else if (cCount === faceVertexCounts.length) vtxColorInterp = 'uniform';
  }

  // When subdivision is enabled, we MUST use indexed geometry with shared vertices.
  // De-indexed geometry (each triangle has its own vertices) prevents proper edge smoothing.
  // Trade-off: per-face/per-corner colors are lost when subdivision is applied.
  const needsDeindex =
    !shouldSubdivide && (
      wantFlatNormals ||
      (vtxColor && (vtxColorInterp === 'faceVarying' || vtxColorInterp === 'uniform')) ||
      (useAuthoredNormals && (normalsInterp === 'faceVarying' || normalsInterp === 'uniform')) ||
      (st && stInterp === 'faceVarying')
    );

  // If displayColor or normals are per-corner/per-face, we need to de-index.
  if (needsDeindex) {
    // Record a mapping from USD "face index" -> (triangle start, triangle count) in the *final*
    // triangulated geometry. This is required to apply UsdGeomSubset face indices as Three.js groups.
    //
    // Note: USD GeomSubset indices are "face indices" (not faceVertexIndices indices, and not triangle indices).
    // After triangulation, each face becomes 1+ triangles; we keep a compact mapping so subsets can be applied.
    const usdFaceTriStart = new Uint32Array(faceVertexCounts.length);
    const usdFaceTriCount = new Uint32Array(faceVertexCounts.length);

    const vCount = numTris * 3;
    const pos = new Float32Array(vCount * 3);
    const col = vtxColor ? new Float32Array(vCount * 3) : null;
    const nor = useAuthoredNormals ? new Float32Array(vCount * 3) : null;
    const uv = st ? new Float32Array(vCount * 2) : null;
    // Track original point index for each de-indexed vertex (needed for skinning)
    const originalPointIndex = new Uint32Array(vCount);

    let idxRead = 0; // faceVertexIndices cursor (also the faceVarying element cursor)
    let vWrite = 0;
    let faceIdx = 0;
    let triWrite = 0; // triangle cursor in the final triangulated stream

    const triangulateFaceLocal = (polyPoints: number[]): number[] => {
      // polyPoints are global point indices in face-vertex order.
      // Return local triangle corner indices [a,b,c, a,b,c, ...] into the face corner list.
      const n = polyPoints.length;
      if (n < 3) return [];
      if (n === 3) return [0, 1, 2];

      // Newell normal to choose a stable projection plane.
      let nx = 0,
        ny = 0,
        nz = 0;
      for (let i = 0; i < n; i++) {
        const a = polyPoints[i]!;
        const b = polyPoints[(i + 1) % n]!;
        const ax = points[a * 3 + 0] ?? 0;
        const ay = points[a * 3 + 1] ?? 0;
        const az = points[a * 3 + 2] ?? 0;
        const bx = points[b * 3 + 0] ?? 0;
        const by = points[b * 3 + 1] ?? 0;
        const bz = points[b * 3 + 2] ?? 0;
        nx += (ay - by) * (az + bz);
        ny += (az - bz) * (ax + bx);
        nz += (ax - bx) * (ay + by);
      }
      const anx = Math.abs(nx);
      const any = Math.abs(ny);
      const anz = Math.abs(nz);
      let drop: 'x' | 'y' | 'z' = 'z';
      if (anx >= any && anx >= anz) drop = 'x';
      else if (any >= anx && any >= anz) drop = 'y';

      const contour: THREE.Vector2[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const pi = polyPoints[i]!;
        const x = points[pi * 3 + 0] ?? 0;
        const y = points[pi * 3 + 1] ?? 0;
        const z = points[pi * 3 + 2] ?? 0;
        if (drop === 'x') contour[i] = new THREE.Vector2(y, z);
        else if (drop === 'y') contour[i] = new THREE.Vector2(x, z);
        else contour[i] = new THREE.Vector2(x, y);
      }

      const tris2d = THREE.ShapeUtils.triangulateShape(contour, []);
      if (!tris2d || tris2d.length === 0) return [];
      const out: number[] = [];
      // IMPORTANT: ShapeUtils/Earcut does not guarantee preserving the original 3D winding.
      // Ensure each emitted triangle matches the face's original winding (Newell normal direction).
      const wantNx = nx,
        wantNy = ny,
        wantNz = nz;
      const wantLenSq = wantNx * wantNx + wantNy * wantNy + wantNz * wantNz;
      for (const t of tris2d) {
        let aL = t[0]!,
          bL = t[1]!,
          cL = t[2]!;
        if (wantLenSq > 1e-18) {
          const a = polyPoints[aL]!;
          const b = polyPoints[bL]!;
          const c = polyPoints[cL]!;
          const ax = points[a * 3 + 0] ?? 0;
          const ay = points[a * 3 + 1] ?? 0;
          const az = points[a * 3 + 2] ?? 0;
          const bx = points[b * 3 + 0] ?? 0;
          const by = points[b * 3 + 1] ?? 0;
          const bz = points[b * 3 + 2] ?? 0;
          const cx = points[c * 3 + 0] ?? 0;
          const cy = points[c * 3 + 1] ?? 0;
          const cz = points[c * 3 + 2] ?? 0;
          const abx = bx - ax,
            aby = by - ay,
            abz = bz - az;
          const acx = cx - ax,
            acy = cy - ay,
            acz = cz - az;
          const tnx = aby * acz - abz * acy;
          const tny = abz * acx - abx * acz;
          const tnz = abx * acy - aby * acx;
          const dot = tnx * wantNx + tny * wantNy + tnz * wantNz;
          if (dot < 0) {
            // Flip winding
            const tmp = bL;
            bL = cL;
            cL = tmp;
          }
        }
        out.push(aL, bL, cL);
      }
      return out;
    };

    for (const c of faceVertexCounts) {
      const n = c | 0;
      if (n < 3) {
        usdFaceTriStart[faceIdx] = triWrite;
        usdFaceTriCount[faceIdx] = 0;
        idxRead += Math.max(0, n);
        faceIdx++;
        continue;
      }

      const faceCornerPoints: number[] = new Array(n);
      for (let i = 0; i < n; i++) faceCornerPoints[i] = faceVertexIndices[idxRead + i]!;
      const triLocal = triangulateFaceLocal(faceCornerPoints);
      const faceTriStart = triWrite;

      const writeVertex = (pointIndex: number, fvIndex: number) => {
        const pOff = pointIndex * 3;
        pos[vWrite * 3 + 0] = points[pOff + 0]!;
        pos[vWrite * 3 + 1] = points[pOff + 1]!;
        pos[vWrite * 3 + 2] = points[pOff + 2]!;

        if (vtxColor && col) {
          // Primvar element indexing depends on interpolation:
          // - constant: single element for whole mesh (always index 0)
          // - vertex: per point
          // - faceVarying: per corner (fv index)
          // - uniform: per face
          const elemIndex =
            vtxColorInterp === 'constant'
              ? 0
              : vtxColorInterp === 'vertex'
                ? pointIndex
                : vtxColorInterp === 'uniform'
                  ? faceIdx
                  : fvIndex;
          const cIdx = vtxColorIndices ? vtxColorIndices[elemIndex] ?? elemIndex : elemIndex;
          const cOff = cIdx * 3;
          // guard: if out of range, default to white
          col[vWrite * 3 + 0] = vtxColor[cOff + 0] ?? 1;
          col[vWrite * 3 + 1] = vtxColor[cOff + 1] ?? 1;
          col[vWrite * 3 + 2] = vtxColor[cOff + 2] ?? 1;
        }

        if (useAuthoredNormals && normals && nor) {
          let nIdx: number | null = null;
          if (normalsInterp === 'vertex') nIdx = pointIndex;
          else if (normalsInterp === 'faceVarying') nIdx = fvIndex;
          else if (normalsInterp === 'uniform') nIdx = faceIdx;
          else nIdx = null;

          if (nIdx !== null) {
            const resolved = normalsIndices ? normalsIndices[nIdx] ?? nIdx : nIdx;
            const nOff = resolved * 3;
            nor[vWrite * 3 + 0] = normals[nOff + 0] ?? 0;
            nor[vWrite * 3 + 1] = normals[nOff + 1] ?? 1;
            nor[vWrite * 3 + 2] = normals[nOff + 2] ?? 0;
          }
        }

        if (st && uv) {
          // primvars:st is commonly faceVarying; if it's vertex, index by pointIndex.
          const tIdx = stInterp === 'vertex' ? pointIndex : fvIndex;
          const resolved = stIndices ? stIndices[tIdx] ?? tIdx : tIdx;
          const tOff = resolved * 2;
          uv[vWrite * 2 + 0] = st[tOff + 0] ?? 0;
          uv[vWrite * 2 + 1] = st[tOff + 1] ?? 0;
        }

        // Store original point index for skinning attribute lookup
        originalPointIndex[vWrite] = pointIndex;

        vWrite++;
      };

      if (triLocal.length) {
        // Earcut-based triangulation (correct for concave polygons)
        for (let i = 0; i < triLocal.length; i += 3) {
          const a = triLocal[i + 0]!;
          const b = triLocal[i + 1]!;
          const c = triLocal[i + 2]!;
          writeVertex(faceCornerPoints[a]!, idxRead + a);
          writeVertex(faceCornerPoints[b]!, idxRead + b);
          writeVertex(faceCornerPoints[c]!, idxRead + c);
          triWrite++;
        }
      } else {
        // Fallback: fan triangulation (may be incorrect for concave faces)
        const corner0Point = faceCornerPoints[0]!;
        const fv0 = idxRead;
        for (let k = 1; k < n - 1; k++) {
          const corner1Point = faceCornerPoints[k]!;
          const corner2Point = faceCornerPoints[k + 1]!;
          const fv1 = idxRead + k;
          const fv2 = idxRead + k + 1;
          writeVertex(corner0Point, fv0);
          writeVertex(corner1Point, fv1);
          writeVertex(corner2Point, fv2);
          triWrite++;
        }
      }

      usdFaceTriStart[faceIdx] = faceTriStart;
      usdFaceTriCount[faceIdx] = triWrite - faceTriStart;
      idxRead += n;
      faceIdx++;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (col) geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (nor) geom.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (uv) geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    // Store original point indices for skinning (vertex-interpolated attributes)
    geom.setAttribute('_originalPointIndex', new THREE.BufferAttribute(originalPointIndex, 1));
    // Store face->triangle mapping for GeomSubset material application.
    (geom as any).userData = {
      ...(geom as any).userData,
      usdFaceTriStart,
      usdFaceTriCount,
      usdTriangleCount: triWrite,
      usdFaceCount: faceVertexCounts.length,
    };

    // Track if we have authored normals (needed for leftHanded flip decision)
    const hasAuthoredNormals = !!nor;

    // Compute smooth normals if not authored.
    // Use computeSmoothNormalsDeindexed to get smooth shading by averaging
    // face normals for vertices that share the same original point.
    if (!nor) {
      if (wantFlatNormals) geom.computeVertexNormals();
      else computeSmoothNormalsDeindexed(geom);
    }
    geom.computeBoundingSphere();

    // Apply subdivision surface if specified (catmullClark or loop)
    // NOTE: This path is only reached when shouldSubdivide is false (due to needsDeindex check).
    // Subdivision for de-indexed geometry is kept for reference but won't produce smooth results.
    if (shouldSubdivide) {
      const subdivided = LoopSubdivision.modify(geom, refinementLevel, {
        split: false,
        uvSmooth: false,
        preserveEdges: false,
        flatOnly: false,
      });
      subdivided.computeVertexNormals();
      subdivided.computeBoundingSphere();
      // Subdivision always recomputes normals, so recompute after flip
      if (isLeftHanded) flipGeometryWinding(subdivided, true);
      return subdivided;
    }
    // Recompute normals after flip only if they weren't authored
    if (isLeftHanded) flipGeometryWinding(geom, !hasAuthoredNormals, !wantFlatNormals);
    return geom;
  }

  // Default: indexed geometry
  // NOTE: Fan triangulation (0,k,k+1) is incorrect for concave polygons and can create overlapping
  // triangles ("extra triangle" / z-fighting). Use Earcut via THREE.ShapeUtils for n-gons.
  const indicesOut: number[] = [];
  let idxRead = 0;
  // Record USD face index -> triangulated triangle range mapping (see de-indexed path above).
  const usdFaceTriStart = new Uint32Array(faceVertexCounts.length);
  const usdFaceTriCount = new Uint32Array(faceVertexCounts.length);
  let faceIdx = 0;

  const triangulatePolygon = (poly: number[]): number[] => {
    // Compute a stable projection plane for this polygon using Newell's method.
    // Then triangulate in 2D with ShapeUtils (Earcut).
    let nx = 0,
      ny = 0,
      nz = 0;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % n]!;
      const ax = points[a * 3 + 0] ?? 0;
      const ay = points[a * 3 + 1] ?? 0;
      const az = points[a * 3 + 2] ?? 0;
      const bx = points[b * 3 + 0] ?? 0;
      const by = points[b * 3 + 1] ?? 0;
      const bz = points[b * 3 + 2] ?? 0;
      nx += (ay - by) * (az + bz);
      ny += (az - bz) * (ax + bx);
      nz += (ax - bx) * (ay + by);
    }
    const anx = Math.abs(nx);
    const any = Math.abs(ny);
    const anz = Math.abs(nz);
    // Drop the dominant normal axis (largest component).
    let drop: 'x' | 'y' | 'z' = 'z';
    if (anx >= any && anx >= anz) drop = 'x';
    else if (any >= anx && any >= anz) drop = 'y';

    const contour: THREE.Vector2[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const pi = poly[i]!;
      const x = points[pi * 3 + 0] ?? 0;
      const y = points[pi * 3 + 1] ?? 0;
      const z = points[pi * 3 + 2] ?? 0;
      if (drop === 'x') contour[i] = new THREE.Vector2(y, z);
      else if (drop === 'y') contour[i] = new THREE.Vector2(x, z);
      else contour[i] = new THREE.Vector2(x, y);
    }

    const tris2d = THREE.ShapeUtils.triangulateShape(contour, []);
    if (!tris2d || tris2d.length === 0) return [];

    const out: number[] = [];
    // IMPORTANT: ShapeUtils/Earcut does not guarantee preserving the original 3D winding.
    // Ensure each emitted triangle matches the face's original winding (Newell normal direction).
    const wantNx = nx,
      wantNy = ny,
      wantNz = nz;
    const wantLenSq = wantNx * wantNx + wantNy * wantNy + wantNz * wantNz;
    for (const t of tris2d) {
      let ia = poly[t[0]!]!;
      let ib = poly[t[1]!]!;
      let ic = poly[t[2]!]!;
      if (wantLenSq > 1e-18) {
        const ax = points[ia * 3 + 0] ?? 0;
        const ay = points[ia * 3 + 1] ?? 0;
        const az = points[ia * 3 + 2] ?? 0;
        const bx = points[ib * 3 + 0] ?? 0;
        const by = points[ib * 3 + 1] ?? 0;
        const bz = points[ib * 3 + 2] ?? 0;
        const cx = points[ic * 3 + 0] ?? 0;
        const cy = points[ic * 3 + 1] ?? 0;
        const cz = points[ic * 3 + 2] ?? 0;
        const abx = bx - ax,
          aby = by - ay,
          abz = bz - az;
        const acx = cx - ax,
          acy = cy - ay,
          acz = cz - az;
        const tnx = aby * acz - abz * acy;
        const tny = abz * acx - abx * acz;
        const tnz = abx * acy - aby * acx;
        const dot = tnx * wantNx + tny * wantNy + tnz * wantNz;
        if (dot < 0) {
          const tmp = ib;
          ib = ic;
          ic = tmp;
        }
      }
      out.push(ia, ib, ic);
    }
    return out;
  };

  for (const c of faceVertexCounts) {
    const n = c | 0;
    if (n < 3) {
      usdFaceTriStart[faceIdx] = (indicesOut.length / 3) | 0;
      usdFaceTriCount[faceIdx] = 0;
      idxRead += Math.max(0, n);
      faceIdx++;
      continue;
    }

    const faceTriStart = (indicesOut.length / 3) | 0;
    if (n === 3) {
      const i0 = faceVertexIndices[idxRead + 0]!;
      const i1 = faceVertexIndices[idxRead + 1]!;
      const i2 = faceVertexIndices[idxRead + 2]!;
      indicesOut.push(i0, i1, i2);
      idxRead += 3;
      usdFaceTriStart[faceIdx] = faceTriStart;
      usdFaceTriCount[faceIdx] = 1;
      faceIdx++;
      continue;
    }

    const poly: number[] = [];
    for (let k = 0; k < n; k++) poly.push(faceVertexIndices[idxRead + k]!);

    const tris = triangulatePolygon(poly);
    if (tris.length) {
      indicesOut.push(...tris);
    } else {
      // Fallback: fan triangulation (may be incorrect for concave faces)
      const i0 = poly[0]!;
      for (let k = 1; k < n - 1; k++) indicesOut.push(i0, poly[k]!, poly[k + 1]!);
    }

    idxRead += n;
    usdFaceTriStart[faceIdx] = faceTriStart;
    usdFaceTriCount[faceIdx] = ((indicesOut.length / 3) | 0) - faceTriStart;
    faceIdx++;
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(points, 3));
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indicesOut), 1));
  (geom as any).userData = {
    ...(geom as any).userData,
    usdFaceTriStart,
    usdFaceTriCount,
    usdTriangleCount: (indicesOut.length / 3) | 0,
    usdFaceCount: faceVertexCounts.length,
  };

  // Attach vertex colors per point (keep indices) when interpolation allows it.
  // - vertex: per point
  // - constant: one value for the whole mesh (replicated per point for Three)
  if (vtxColor && (vtxColorInterp === 'vertex' || vtxColorInterp === 'constant')) {
    const col = new Float32Array(numVerts * 3);
    for (let i = 0; i < numVerts; i++) {
      const src = vtxColorInterp === 'constant' ? 0 : vtxColorIndices ? vtxColorIndices[i] ?? i : i;
      const sOff = src * 3;
      col[i * 3 + 0] = vtxColor[sOff + 0] ?? 1;
      col[i * 3 + 1] = vtxColor[sOff + 1] ?? 1;
      col[i * 3 + 2] = vtxColor[sOff + 2] ?? 1;
    }
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }

  // Vertex UVs (keep indices)
  if (st && stInterp === 'vertex' && st.length === numVerts * 2) {
    const out = new Float32Array(numVerts * 2);
    for (let i = 0; i < numVerts; i++) {
      const src = stIndices ? stIndices[i] ?? i : i;
      const sOff = src * 2;
      out[i * 2 + 0] = st[sOff + 0] ?? 0;
      out[i * 2 + 1] = st[sOff + 1] ?? 0;
    }
    geom.setAttribute('uv', new THREE.BufferAttribute(out, 2));
  }

  // If normals are vertex-interpolated and match point count, attach them directly.
  // Track if we have authored normals (needed for leftHanded flip decision)
  let hasAuthoredNormals = false;
  if (useAuthoredNormals && normalsInterp === 'vertex' && normals.length === points.length) {
    const out = new Float32Array(points.length);
    for (let i = 0; i < numVerts; i++) {
      const src = normalsIndices ? normalsIndices[i] ?? i : i;
      const sOff = src * 3;
      out[i * 3 + 0] = normals[sOff + 0] ?? 0;
      out[i * 3 + 1] = normals[sOff + 1] ?? 1;
      out[i * 3 + 2] = normals[sOff + 2] ?? 0;
    }
    geom.setAttribute('normal', new THREE.BufferAttribute(out, 3));
    hasAuthoredNormals = true;
  } else {
    geom.computeVertexNormals();
  }
  geom.computeBoundingSphere();

  // Apply subdivision surface if specified (catmullClark or loop)
  // NOTE: We use Loop subdivision (for triangles) as an approximation of Catmull-Clark (for quads).
  // Loop subdivision on indexed geometry with shared vertices produces smooth results.
  if (shouldSubdivide) {
    const subdivided = LoopSubdivision.modify(geom, refinementLevel, {
      split: false,       // Keep shared vertices for smooth shading
      uvSmooth: false,
      preserveEdges: false,
      flatOnly: false,
    });
    subdivided.computeVertexNormals();
    subdivided.computeBoundingSphere();
    // Subdivision always recomputes normals, so recompute after flip
    if (isLeftHanded) flipGeometryWinding(subdivided, true);
    return subdivided;
  }
  // Recompute normals after flip only if they weren't authored
  if (isLeftHanded) flipGeometryWinding(geom, !hasAuthoredNormals);
  return geom;
}

/**
 * Parse a single USD matrix4d value into THREE.Matrix4.
 * USD matrices are stored as nested tuples in row-major order:
 * matrix4d = ( (r0c0, r0c1, r0c2, r0c3), (r1c0, r1c1, r1c2, r1c3), (r2c0, r2c1, r2c2, r2c3), (r3c0, r3c1, r3c2, r3c3) )
 * 
 * USD uses row-vector convention where transforms are applied as v' = v * M.
 * Three.js uses column-vector convention where transforms are applied as v' = M * v.
 * To convert, we transpose the USD matrix.
 */
function parseMatrix4d(v: SdfValue | undefined): THREE.Matrix4 | null {
  if (!v || typeof v !== 'object' || v.type !== 'tuple' || v.value.length !== 4) return null;

  // Each v.value element is a row (tuple of 4 numbers)
  const rows: number[][] = [];
  for (const row of v.value) {
    if (!row || typeof row !== 'object' || row.type !== 'tuple' || row.value.length !== 4) {
      rows.push([0, 0, 0, 0]);
      continue;
    }
    const nums = row.value.map((n: any) => (typeof n === 'number' ? n : 0));
    rows.push(nums);
  }

  // Transpose: USD row becomes Three.js column
  // Matrix4.set takes row-by-row in its arguments, so we pass columns from USD as rows
  const m = new THREE.Matrix4();
  m.set(
    rows[0]![0]!, rows[1]![0]!, rows[2]![0]!, rows[3]![0]!,  // Column 0 of USD -> Row 1 of set()
    rows[0]![1]!, rows[1]![1]!, rows[2]![1]!, rows[3]![1]!,  // Column 1 of USD -> Row 2 of set()
    rows[0]![2]!, rows[1]![2]!, rows[2]![2]!, rows[3]![2]!,  // Column 2 of USD -> Row 3 of set()
    rows[0]![3]!, rows[1]![3]!, rows[2]![3]!, rows[3]![3]!   // Column 3 of USD -> Row 4 of set()
  );
  return m;
}

function applyXformOps(obj: THREE.Object3D, prim: SdfPrimSpec, time?: number) {
  // Helper to get property value, optionally at a specific time
  const getVal = time !== undefined
    ? (name: string) => getPrimPropAtTime(prim, name, time)
    : (name: string) => getPrimProp(prim, name);

  // Prefer matrix transform ops when present.
  // Many real-world USDs author matrix ops with a suffix (e.g. `xformOp:transform:edit7`)
  // and list them in `xformOpOrder`. If we only look for the unsuffixed `xformOp:transform`,
  // transforms are silently ignored (e.g. all wheels stack at origin and look like "one wheel").
  const readXformOpOrder = (): string[] => {
    const dv: any = getVal('xformOpOrder');
    if (!dv || typeof dv !== 'object' || dv.type !== 'array' || !Array.isArray(dv.value)) return [];
    const out: string[] = [];
    for (const el of dv.value) {
      if (typeof el === 'string') out.push(el);
      else if (el && typeof el === 'object' && el.type === 'token' && typeof el.value === 'string') out.push(el.value);
    }
    return out;
  };

  const tryApplyMatrixOp = (opName: string): boolean => {
    const m = parseMatrix4d(getVal(opName));
    if (!m) return false;
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    m.decompose(pos, quat, scale);
    obj.position.copy(pos);
    obj.quaternion.copy(quat);
    obj.scale.copy(scale);
    return true;
  };

  const order = readXformOpOrder();
  for (const opName of order) {
    if (opName.startsWith('xformOp:transform') && tryApplyMatrixOp(opName)) return;
  }

  // Fallback: try any authored xformOp:transform* even if xformOpOrder is missing.
  if (tryApplyMatrixOp('xformOp:transform')) return;
  if (prim.properties) {
    for (const k of prim.properties.keys()) {
      if (k.startsWith('xformOp:transform') && tryApplyMatrixOp(k)) return;
    }
  }

  // Fallback: apply translate, rotate, scale in Three.js default order (T * R * S)
  // Note: USD xformOpOrder can specify different orders, but Three.js always uses T * R * S
  // For most USD files, this matches the common ["xformOp:translate", "xformOp:rotateXYZ", "xformOp:scale"] order
  // Support suffixed ops too (e.g. `xformOp:translate:foo`) by consulting xformOpOrder first.
  const findOpName = (prefix: string, fallback: string): string => {
    for (const opName of order) if (opName.startsWith(prefix)) return opName;
    return fallback;
  };

  const tName = findOpName('xformOp:translate', 'xformOp:translate');
  const rName = findOpName('xformOp:rotateXYZ', 'xformOp:rotateXYZ');
  const sName = findOpName('xformOp:scale', 'xformOp:scale');

  const t = sdfToNumberTuple(getVal(tName), 3);
  const s = sdfToNumberTuple(getVal(sName), 3);

  if (t) obj.position.set(t[0]!, t[1]!, t[2]!);
  if (s) obj.scale.set(s[0]!, s[1]!, s[2]!);

  // Rotation:
  // - Prefer rotateXYZ if authored.
  // - Otherwise, support common separate rotate ops (rotateX/Y/Z), including suffixed ones listed in xformOpOrder.
  //
  // This is required for real-world samples like usd-wg-assets teapot camera:
  //   xformOpOrder = ["xformOp:translate:zoomedIn", "xformOp:rotateY:zoomedIn", "xformOp:rotateX:zoomedIn"]
  const rXYZ = sdfToNumberTuple(getVal(rName), 3);
  if (rXYZ) {
    obj.rotation.set(
      THREE.MathUtils.degToRad(rXYZ[0]!),
      THREE.MathUtils.degToRad(rXYZ[1]!),
      THREE.MathUtils.degToRad(rXYZ[2]!)
    );
    return;
  }

  // Apply ordered Euler rotations via quaternion multiplication.
  // Note: USD applies ops in the listed order; we approximate by multiplying quaternions sequentially.
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisY = new THREE.Vector3(0, 1, 0);
  const axisZ = new THREE.Vector3(0, 0, 1);
  const q = new THREE.Quaternion();
  let anyRot = false;

  const applyAxis = (axis: THREE.Vector3, degrees: number) => {
    const qq = new THREE.Quaternion();
    qq.setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees));
    q.multiply(qq);
    anyRot = true;
  };

  for (const opName of order) {
    if (!opName.startsWith('xformOp:rotate')) continue;
    if (opName.startsWith('xformOp:rotateX')) {
      const v = getVal(opName);
      if (typeof v === 'number') applyAxis(axisX, v);
    } else if (opName.startsWith('xformOp:rotateY')) {
      const v = getVal(opName);
      if (typeof v === 'number') applyAxis(axisY, v);
    } else if (opName.startsWith('xformOp:rotateZ')) {
      const v = getVal(opName);
      if (typeof v === 'number') applyAxis(axisZ, v);
    } else if (opName.startsWith('xformOp:rotateXYZ')) {
      const vv = sdfToNumberTuple(getVal(opName), 3);
      if (vv) {
        const e = new THREE.Euler(
          THREE.MathUtils.degToRad(vv[0]!),
          THREE.MathUtils.degToRad(vv[1]!),
          THREE.MathUtils.degToRad(vv[2]!),
          'XYZ'
        );
        const qq = new THREE.Quaternion().setFromEuler(e);
        q.multiply(qq);
        anyRot = true;
      }
    }
  }

  if (anyRot) {
    obj.quaternion.copy(q);
  }
}

/**
 * Check if a prim has any animated xform properties
 */
function primHasAnimatedXform(prim: SdfPrimSpec): boolean {
  if (
    propHasAnimation(prim, 'xformOp:translate') ||
    propHasAnimation(prim, 'xformOp:rotateXYZ') ||
    propHasAnimation(prim, 'xformOp:scale') ||
    propHasAnimation(prim, 'xformOp:transform')
  ) return true;

  // Catch any animated xformOp, including suffixed ops like:
  // - `xformOp:translate:foo.timeSamples`
  // - `xformOp:rotateX:zoomedIn.timeSamples` (usd-wg-assets teapot camera)
  // - `xformOp:transform:edit7.timeSamples`
  if (prim.properties) {
    for (const [k, spec] of prim.properties.entries()) {
      if (!k.startsWith('xformOp:')) continue;
      if (k === 'xformOpOrder') continue;
      if (spec.timeSamples && spec.timeSamples.size > 0) return true;
    }
  }
  return false;
}

function extractAssetStrings(v: any): string[] {
  if (!v) return [];
  if (typeof v === 'object' && v.type === 'asset') return [v.value];
  // Handle references with target paths: @./file.usd@</Target>
  if (typeof v === 'object' && v.type === 'reference') return [v.assetPath];
  if (typeof v === 'object' && v.type === 'array') {
    return v.value.flatMap((x: any) => {
      if (x && typeof x === 'object' && x.type === 'asset') return [x.value];
      if (x && typeof x === 'object' && x.type === 'reference') return [x.assetPath];
      return [];
    });
  }
  if (typeof v === 'object' && v.type === 'dict' && v.value && typeof v.value === 'object' && 'value' in v.value) {
    return extractAssetStrings((v.value as any).value);
  }
  return [];
}

function renderPrim(
  objParent: THREE.Object3D,
  helpersParent: THREE.Object3D,
  node: SceneNode,
  selectionPath: string | null,
  helpers: Map<string, THREE.Object3D>,
  rootPrim: SdfPrimSpec,
  sceneRef: THREE.Scene,
  hasUsdLightsRef: { value: boolean },
  hasUsdDomeLightRef: { value: boolean },
  resolveAssetUrl?: (assetPath: string, fromIdentifier?: string) => string | null,
  unitScale = 1.0,
  dynamicHelperUpdates: Array<() => void> = [],
  skeletonsToUpdate: Array<{ skeleton: THREE.Skeleton; boneRoot: THREE.Object3D }> = [],
  domeEnv?: {
    setFromDomeLight: (opts: {
      assetPath: string;
      format: string | null;
      worldQuaternion: THREE.Quaternion;
      intensity: number;
    }) => void;
  },
  currentIdentifier?: string,
  animatedObjects?: AnimatedObject[],
) {
  const container = new THREE.Object3D();
  container.name = node.path;
  applyXformOps(container, node.prim);
  if (unitScale !== 1.0) {
    // Scale authored translations into meters; leave rotation/scale unchanged.
    container.position.multiplyScalar(unitScale);
  }
  objParent.add(container);

  // Track animated objects for animation playback
  if (animatedObjects && primHasAnimatedXform(node.prim)) {
    animatedObjects.push({ kind: 'xform', obj: container, prim: node.prim, unitScale });
  }

  const typeName = node.typeName ?? '';

  const getBoolProp = (prim: SdfPrimSpec, name: string): boolean | null => {
    const v = getPrimProp(prim, name);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    return null;
  };

  const applySidedness = (prim: SdfPrimSpec, mat: THREE.Material | THREE.Material[]) => {
    // UsdGeomGprim `doubleSided` is the canonical control. Some exporters also author `singleSided`.
    const ds = getBoolProp(prim, 'doubleSided');
    const ss = getBoolProp(prim, 'singleSided');
    const wantDouble = ds === true || (ss === false && ds !== false);
    if (!wantDouble && ds !== false && ss !== true) return; // nothing authored => leave defaults

    const applyOne = (m: THREE.Material) => {
      if (!('side' in m)) return;
      (m as any).side = wantDouble ? THREE.DoubleSide : THREE.FrontSide;
      // Important: even if the surface is double-sided for shading, rendering both sides into the
      // shadow map tends to create self-shadowing artifacts on thin shells (like the ft-lab sample).
      // Prefer front-face shadow casting.
      if ('shadowSide' in (m as any)) (m as any).shadowSide = THREE.FrontSide;
      m.needsUpdate = true;
    };
    if (Array.isArray(mat)) mat.forEach(applyOne);
    else applyOne(mat);
  };

  // For PointInstancer prototypes, we need to resolve material bindings relative to the prototype root.
  // This is passed down from the PointInstancer handler.
  const prototypeRootForMaterials = (node as any).__prototypeRoot as SdfPrimSpec | undefined;
  console.log(`[renderPrim] node=${node.path}, typeName=${typeName}, __prototypeRoot=${prototypeRootForMaterials?.path?.primPath ?? 'undefined'}`);

  // Native USD references can map a referenced layer's defaultPrim subtree under an arbitrary prim path.
  // Some corpora still author absolute material binding targets like </World/Looks/Mat>. If our composed stage
  // didn't remap those targets, try resolving them relative to the nearest ancestor prim that has `metadata.references`.
  const findReferenceRootForMaterials = (primPath: string): SdfPrimSpec | undefined => {
    let cur = primPath;
    while (cur && cur !== '/') {
      const p = findPrimByPath(rootPrim, cur);
      if (p?.metadata?.references) return p;
      const parts = cur.split('/').filter(Boolean);
      parts.pop();
      cur = parts.length ? '/' + parts.join('/') : '/';
    }
    return undefined;
  };

  const referenceRootForMaterials = findReferenceRootForMaterials(node.prim.path?.primPath ?? node.path);
  const bindingRootForMaterials = prototypeRootForMaterials ?? referenceRootForMaterials;

  // Get the identifier for asset resolution from the reference root, if available
  const getAssetResolutionIdentifier = (prim: SdfPrimSpec): string | undefined => {
    // Find the reference root that contains this prim
    let cur = prim.path?.primPath ?? '';
    while (cur && cur !== '/') {
      const p = findPrimByPath(rootPrim, cur);
      if (p?.metadata?.references) {
        // Extract the asset path from the reference metadata
        const refs = extractAssetStrings(p.metadata.references);
        if (refs.length > 0) {
          // Resolve the reference asset path to get the full identifier
          const refAssetPath = refs[0];
          try {
            // Resolve relative to the current identifier to get the full path
            const baseIdentifier = currentIdentifier ?? '<viewer>';
            const resolvedRef = resolveAssetPath(refAssetPath, baseIdentifier);
            return resolvedRef;
          } catch {
            return refAssetPath;
          }
        }
      }
      const parts = cur.split('/').filter(Boolean);
      parts.pop();
      cur = parts.length ? '/' + parts.join('/') : '/';
    }
    return undefined;
  };

  const resolveMaterial = (prim: SdfPrimSpec): THREE.Material => {
    console.log(
      `[resolveMaterial] prim=${prim.path?.primPath}, prototypeRootForMaterials=${prototypeRootForMaterials?.path?.primPath}, referenceRootForMaterials=${referenceRootForMaterials?.path?.primPath}`,
    );
    const materialPrim = resolveMaterialBinding(prim, rootPrim, bindingRootForMaterials);
    console.log(`[resolveMaterial]   materialPrim=${materialPrim?.path?.primPath ?? 'null'}`);
    if (materialPrim) {
      const shaderPrim = resolveShaderFromMaterial(materialPrim, rootPrim);
      console.log(`[resolveMaterial]   shaderPrim=${shaderPrim?.path?.primPath ?? 'null'}`);
      if (shaderPrim) {
        // Get the identifier for resolving textures - use the reference root's identifier if available
        const baseIdentifier = currentIdentifier ?? '<viewer>';
        const assetIdentifier = getAssetResolutionIdentifier(shaderPrim) ?? baseIdentifier;
        const mat = createMaterialFromShader(shaderPrim, rootPrim, (path: string) => resolveAssetUrl?.(path, assetIdentifier) ?? null, materialPrim);
        // Debug: log material creation for UsdPreviewSurface samples
        const shaderType = shaderPrim.properties?.get('info:id')?.defaultValue;
        console.log(`[resolveMaterial]   shaderType=${shaderType}`);
        const isUsdPreviewSurface = shaderType === 'UsdPreviewSurface' || shaderType === 'ND_UsdPreviewSurface_surfaceshader';
        if (isUsdPreviewSurface) {
          const inputs = extractShaderInputs(shaderPrim, materialPrim);
          console.log(`[resolveMaterial]   UsdPreviewSurface inputs:`, {
            diffuseColor: inputs.diffuseColor ? `rgb(${inputs.diffuseColor.r.toFixed(4)}, ${inputs.diffuseColor.g.toFixed(4)}, ${inputs.diffuseColor.b.toFixed(4)})` : 'none',
            roughness: inputs.roughness,
            metallic: inputs.metallic,
          });
          console.log(`[resolveMaterial]   mat.color=${(mat as any).color?.getHexString?.()}`);
        }
        return mat;
      }
    }
    console.log(`[resolveMaterial]   returning default material`);
    return new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.8 });
  };

  // Helper to apply default material/displayColor for built-in primitives
  const applyPrimitiveDefaults = (mat: THREE.Material, prim: SdfPrimSpec) => {
    const hasBoundMaterial = !!resolveMaterialBinding(prim, rootPrim, bindingRootForMaterials);
    if (!hasBoundMaterial) {
      (mat as THREE.MeshStandardMaterial).color.setHex(0x888888);
      (mat as THREE.MeshStandardMaterial).roughness = 0.8;
      (mat as THREE.MeshStandardMaterial).metalness = 0.0;
      const dcProp = prim.properties?.get('primvars:displayColor');
      const dc = parseTuple3ArrayToFloat32(dcProp?.defaultValue);
      if (dc && dc.length >= 3) {
        (mat as THREE.MeshStandardMaterial).color.setRGB(dc[0] ?? 1, dc[1] ?? 1, dc[2] ?? 1);
      }
    }
  };

  // Helper to get axis rotation for USD primitives (default axis is Y)
  const getAxisRotation = (prim: SdfPrimSpec): THREE.Euler => {
    const axisVal = getPrimProp(prim, 'axis');
    const axis = typeof axisVal === 'string' ? axisVal : 'Y';
    // Three.js primitives are oriented along Y by default
    if (axis === 'X') return new THREE.Euler(0, 0, -Math.PI / 2);
    if (axis === 'Z') return new THREE.Euler(Math.PI / 2, 0, 0);
    return new THREE.Euler(0, 0, 0); // Y axis (default)
  };

  if (typeName === 'Sphere') {
    const radiusVal = getPrimProp(node.prim, 'radius');
    const radius = (typeof radiusVal === 'number' ? radiusVal : 1) * unitScale;
    const geo = new THREE.SphereGeometry(radius, 24, 16);
    const mat = resolveMaterial(node.prim);
    applyPrimitiveDefaults(mat, node.prim);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    container.add(mesh);
  } else if (typeName === 'Cube') {
    const sizeVal = getPrimProp(node.prim, 'size');
    const size = (typeof sizeVal === 'number' ? sizeVal : 1) * unitScale;
    const geo = new THREE.BoxGeometry(size, size, size);
    const mat = resolveMaterial(node.prim);
    applyPrimitiveDefaults(mat, node.prim);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    container.add(mesh);
  } else if (typeName === 'Cylinder') {
    const radiusVal = getPrimProp(node.prim, 'radius');
    const heightVal = getPrimProp(node.prim, 'height');
    const radius = (typeof radiusVal === 'number' ? radiusVal : 1) * unitScale;
    const height = (typeof heightVal === 'number' ? heightVal : 2) * unitScale;
    const geo = new THREE.CylinderGeometry(radius, radius, height, 24, 1);
    const mat = resolveMaterial(node.prim);
    applyPrimitiveDefaults(mat, node.prim);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Apply axis rotation
    const axisRotation = getAxisRotation(node.prim);
    mesh.rotation.copy(axisRotation);
    container.add(mesh);
  } else if (typeName === 'Cone') {
    const radiusVal = getPrimProp(node.prim, 'radius');
    const heightVal = getPrimProp(node.prim, 'height');
    const radius = (typeof radiusVal === 'number' ? radiusVal : 1) * unitScale;
    const height = (typeof heightVal === 'number' ? heightVal : 2) * unitScale;
    const geo = new THREE.ConeGeometry(radius, height, 24, 1);
    const mat = resolveMaterial(node.prim);
    applyPrimitiveDefaults(mat, node.prim);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Apply axis rotation
    const axisRotation = getAxisRotation(node.prim);
    mesh.rotation.copy(axisRotation);
    container.add(mesh);
  } else if (typeName === 'Capsule') {
    const radiusVal = getPrimProp(node.prim, 'radius');
    const heightVal = getPrimProp(node.prim, 'height');
    const radius = (typeof radiusVal === 'number' ? radiusVal : 0.5) * unitScale;
    const height = (typeof heightVal === 'number' ? heightVal : 1) * unitScale;
    // Three.js CapsuleGeometry: (radius, length, capSegments, radialSegments)
    // Note: Three.js 'length' is the cylinder portion, USD 'height' is also cylinder portion
    const geo = new THREE.CapsuleGeometry(radius, height, 8, 16);
    const mat = resolveMaterial(node.prim);
    applyPrimitiveDefaults(mat, node.prim);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Apply axis rotation
    const axisRotation = getAxisRotation(node.prim);
    mesh.rotation.copy(axisRotation);
    container.add(mesh);
  } else if (typeName === 'Mesh') {
    console.log(`[Mesh] Rendering mesh: ${node.path}, prototypeRootForMaterials=${prototypeRootForMaterials?.path?.primPath}`);
    const mat = resolveMaterial(node.prim);
    applySidedness(node.prim, mat);
    // USD commonly binds materials via GeomSubsets (per-face material assignment). In that case, the Mesh itself
    // often has no `material:binding`, and we should not fall back to default gray / displayColor-only rendering.
    const subsetChildren = Array.from(node.prim.children?.values?.() ?? []).filter((c) => c?.typeName === 'GeomSubset');
    const hasGeomSubsetBindings = subsetChildren.some((s) => !!resolveMaterialBinding(s, rootPrim, bindingRootForMaterials));

    const hasBoundMaterial = !!resolveMaterialBinding(node.prim, rootPrim, bindingRootForMaterials) || hasGeomSubsetBindings;
    console.log(`[Mesh] ${node.path}: hasBoundMaterial=${hasBoundMaterial}, mat.color=${(mat as any).color?.getHexString?.()}, mat.vertexColors=${(mat as any).vertexColors}`);
    if (!hasBoundMaterial) {
      // Viewer fallback for meshes with no bound material and no authored displayColor.
      // Keep this neutral so it doesn't look like an authored "yellow" material.
      (mat as THREE.MeshStandardMaterial).color.setHex(0x888888);
      (mat as THREE.MeshStandardMaterial).roughness = 0.9;
      console.log(`[Mesh] ${node.path}: No bound material -> set default gray color`);
    }

    // If there's no bound material, prefer USD viewport color primvar (primvars:displayColor) for base color.
    // This covers common cases like displayColor.usda where displayColor is authored as a single constant value.
    if (!hasBoundMaterial && mat instanceof THREE.MeshStandardMaterial) {
      const dcProp = node.prim.properties?.get('primvars:displayColor');
      const dc = parseTuple3ArrayToFloat32(dcProp?.defaultValue);
      const dcInterp = getPropMetadataString(dcProp, 'interpolation') ?? 'constant';
      if (dc && dc.length >= 3 && (dcInterp === 'constant' || dcInterp === 'uniform')) {
        mat.color.setRGB(dc[0] ?? 1, dc[1] ?? 1, dc[2] ?? 1);
        console.log(`[Mesh] ${node.path}: Applied displayColor rgb(${dc[0]}, ${dc[1]}, ${dc[2]})`);
      }
    }

    const realGeom = buildUsdMeshGeometry(node.prim, unitScale);
    if (realGeom) {
      // Vertex colors are commonly authored as primvars:displayColor for viewport fallback.
      // IMPORTANT: do NOT automatically enable them when a material is bound; that would multiply-tint
      // authored materials (e.g. PointInstancer simpleTree leaves would become brown).
      const hasColors = !!realGeom.getAttribute('color');
      console.log(`[Mesh] ${node.path}: hasColors=${hasColors}, hasBoundMaterial=${hasBoundMaterial}`);
      if (hasColors && (mat as any)) {
        if (!hasBoundMaterial) {
          // No bound material: use vertex colors as the primary appearance.
          (mat as any).vertexColors = true;
          if ((mat as any).color?.setHex) (mat as any).color.setHex(0xffffff);
          console.log(`[Mesh] ${node.path}: Enabled vertexColors (no bound material)`);
        } else if ((mat as any).vertexColors) {
          // Material explicitly requested vertex colors (e.g. UsdPreviewSurface driven by PrimvarReader_float3).
          if ((mat as any).color?.setHex) (mat as any).color.setHex(0xffffff);
          console.log(`[Mesh] ${node.path}: Kept vertexColors (explicitly requested by material)`);
        } else {
          console.log(`[Mesh] ${node.path}: NOT enabling vertexColors (has bound material)`);
        }
      }
      console.log(`[Mesh] ${node.path}: FINAL mat.color=${(mat as any).color?.getHexString?.()}, mat.vertexColors=${(mat as any).vertexColors}`);

      // Check for skeleton binding
      const skelSkeletonRel = node.prim.properties?.get('skel:skeleton');
      const skelSkeletonVal: any = skelSkeletonRel?.defaultValue;
      const skelSkeletonPath = (skelSkeletonVal && typeof skelSkeletonVal === 'object' && skelSkeletonVal.type === 'sdfpath')
        ? skelSkeletonVal.value as string
        : null;

      if (skelSkeletonPath) {
        // This mesh is bound to a skeleton - use SkinnedMesh
        console.log(`[Mesh] ${node.path}: Has skel:skeleton binding to ${skelSkeletonPath}`);

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
          console.log(`[Mesh] ${node.path}: Found skeleton with ${skeleton.bones.length} bones`);

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
            console.log(`[Mesh] ${node.path}: Bound SkinnedMesh to skeleton, bones:`, skeleton.bones.length);

            // Debug: log skinning attributes
            const skinIdxAttr = realGeom.getAttribute('skinIndex');
            const skinWtAttr = realGeom.getAttribute('skinWeight');
            console.log(`[Mesh] ${node.path}: skinIndex count=${skinIdxAttr?.count}, skinWeight count=${skinWtAttr?.count}`);
            console.log(`[Mesh] ${node.path}: First few skinIndex:`,
              skinIdxAttr ? Array.from(skinIdxAttr.array.slice(0, 16)) : 'none');
            console.log(`[Mesh] ${node.path}: First few skinWeight:`,
              skinWtAttr ? Array.from(skinWtAttr.array.slice(0, 16)) : 'none');

            // Count non-zero bone indices and find which bones are used
            if (skinIdxAttr && skinWtAttr) {
              const idxArr = skinIdxAttr.array as Uint16Array;
              const wtArr = skinWtAttr.array as Float32Array;
              const boneCounts = new Map<number, number>();
              for (let i = 0; i < idxArr.length; i++) {
                const boneIdx = idxArr[i]!;
                boneCounts.set(boneIdx, (boneCounts.get(boneIdx) || 0) + 1);
              }
              console.log(`[Mesh] ${node.path}: Bone index distribution:`, Object.fromEntries(boneCounts));

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
                      console.log(`[Mesh] Vertex ${v} (y=${y.toFixed(3)}): skinIdx=[${idxArr[v * 4]},${idxArr[v * 4 + 1]},${idxArr[v * 4 + 2]},${idxArr[v * 4 + 3]}] skinWt=[${wtArr[v * 4]?.toFixed(2)},${wtArr[v * 4 + 1]?.toFixed(2)},${wtArr[v * 4 + 2]?.toFixed(2)},${wtArr[v * 4 + 3]?.toFixed(2)}]`);
                    }
                    break;
                  }
                }
              }
              console.log(`[Mesh] ${node.path}: Vertices influenced by bone 1: ${bone1Vertices}, max weight: ${maxWeight1.toFixed(3)}`);

              // Log original point index distribution
              if (origPointIndices) {
                console.log(`[Mesh] ${node.path}: origPointIndices sample (first 20):`, Array.from(origPointIndices.slice(0, 20)));
                const midPt = Math.floor(origPointIndices.length / 2);
                console.log(`[Mesh] ${node.path}: origPointIndices sample (mid ${midPt}):`, Array.from(origPointIndices.slice(midPt, midPt + 20)));
              }

              // Log skeleton bone inverses
              console.log(`[Mesh] ${node.path}: skeleton.boneInverses:`, skeleton.boneInverses.map((m, i) => {
                const pos = new THREE.Vector3();
                const rot = new THREE.Quaternion();
                const scale = new THREE.Vector3();
                m.decompose(pos, rot, scale);
                return `bone${i}: pos=(${pos.x.toFixed(3)},${pos.y.toFixed(3)},${pos.z.toFixed(3)})`;
              }));
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
                  console.log(`[Mesh] ${node.path}: Found animation at ${path}`);
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
                console.log(`[Mesh] ${node.path}: Found SkelAnimation with ${rotations.length} rotations`);

                // Apply rotations to bones
                for (let i = 0; i < rotations.length && i < skeleton.bones.length; i++) {
                  const rot = rotations[i];
                  if (rot && rot.type === 'tuple' && rot.value.length >= 4) {
                    // USD quaternions are stored as (w, x, y, z), Three.js expects (x, y, z, w)
                    const [w, x, y, z] = rot.value;
                    skeleton.bones[i]!.quaternion.set(x, y, z, w);
                    // Update bone's local matrix after changing quaternion
                    skeleton.bones[i]!.updateMatrix();
                    console.log(`[Mesh] Bone ${skeleton.bones[i]!.name} rotation: (${x}, ${y}, ${z}, ${w})`);
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
                  console.log(`[Mesh] Bone ${bone.name} worldPos after anim:`, worldPos.toArray());
                }

                // Debug: log bone matrices from skeleton (these are what's used for skinning)
                console.log(`[Mesh] ${node.path}: skeleton.boneMatrices length:`, skeleton.boneMatrices?.length);
                if (skeleton.boneMatrices) {
                  for (let i = 0; i < skeleton.bones.length; i++) {
                    const mat = new THREE.Matrix4();
                    mat.fromArray(skeleton.boneMatrices, i * 16);
                    const pos = new THREE.Vector3();
                    const rot = new THREE.Quaternion();
                    const scale = new THREE.Vector3();
                    mat.decompose(pos, rot, scale);
                    console.log(`[Mesh] Bone matrix ${i} (${skeleton.bones[i]!.name}): pos=(${pos.x.toFixed(3)}, ${pos.y.toFixed(3)}, ${pos.z.toFixed(3)}), rot=(${rot.x.toFixed(3)}, ${rot.y.toFixed(3)}, ${rot.z.toFixed(3)}, ${rot.w.toFixed(3)})`);
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
      } else {
        // Regular mesh without skinning. Apply GeomSubset material bindings (USD's per-face materials)
        // when present by creating geometry groups + a multi-material array.
        const applyGeomSubsetMaterials = (): { materials: THREE.Material[]; didApply: boolean } => {
          const subsets = Array.from(node.prim.children?.values?.() ?? []).filter((c) => c?.typeName === 'GeomSubset');
          if (subsets.length === 0) return { materials: [mat], didApply: false };

          const usdFaceTriStart: any = (realGeom as any).userData?.usdFaceTriStart;
          const usdFaceTriCount: any = (realGeom as any).userData?.usdFaceTriCount;
          const usdTriangleCount: number | undefined = (realGeom as any).userData?.usdTriangleCount;
          const usdFaceCount: number | undefined = (realGeom as any).userData?.usdFaceCount;
          if (!usdFaceTriStart || !usdFaceTriCount || typeof usdTriangleCount !== 'number' || typeof usdFaceCount !== 'number') {
            return { materials: [mat], didApply: false };
          }

          type SubsetInfo = { prim: SdfPrimSpec; faceIndices: number[]; material: THREE.Material };
          const picked: SubsetInfo[] = [];
          for (const s of subsets) {
            // elementType should be "face"
            const et: any = getPrimProp(s, 'elementType');
            const etVal = typeof et === 'string' ? et : (et && typeof et === 'object' && et.type === 'token' ? et.value : null);
            if (etVal && etVal !== 'face') continue;

            const idx = parseNumberArray(getPrimProp(s, 'indices'));
            if (!idx || idx.length === 0) continue;

            // Must have a resolvable material binding
            const bound = resolveMaterialBinding(s, rootPrim, bindingRootForMaterials);
            if (!bound) continue;

            const smat = resolveMaterial(s);
            applySidedness(node.prim, smat);
            picked.push({ prim: s, faceIndices: idx, material: smat });
          }
          if (picked.length === 0) return { materials: [mat], didApply: false };

          // Build groups based on USD face indices -> triangulated triangle ranges.
          const triCount = usdTriangleCount | 0;
          const covered = new Uint8Array(triCount);
          const materials: THREE.Material[] = [mat, ...picked.map((p) => p.material)];
          realGeom.clearGroups();

          const getStart = (f: number): number => {
            // handle both typed arrays and JS arrays
            return (usdFaceTriStart[f] ?? 0) | 0;
          };
          const getCount = (f: number): number => {
            return (usdFaceTriCount[f] ?? 0) | 0;
          };

          const addFaceRuns = (faces: number[], materialIndex: number) => {
            const sortedFaces = Array.from(new Set(faces.map((x) => x | 0))).filter((f) => f >= 0 && f < usdFaceCount).sort((a, b) => a - b);
            let runStart = -1;
            let runCount = 0;
            let runEnd = -1; // exclusive end (triangle index)

            for (const f of sortedFaces) {
              const s = getStart(f);
              const c = getCount(f);
              if (c <= 0) continue;
              if (s < 0 || s >= triCount) continue;
              const e = Math.min(triCount, s + c);
              const cc = e - s;
              if (cc <= 0) continue;

              if (runStart < 0) {
                runStart = s;
                runCount = cc;
                runEnd = s + cc;
              } else if (s === runEnd) {
                runCount += cc;
                runEnd += cc;
              } else {
                realGeom.addGroup(runStart * 3, runCount * 3, materialIndex);
                runStart = s;
                runCount = cc;
                runEnd = s + cc;
              }
            }

            if (runStart >= 0 && runCount > 0) {
              realGeom.addGroup(runStart * 3, runCount * 3, materialIndex);
            }
          };

          // Add subset groups
          for (let i = 0; i < picked.length; i++) {
            const faces = picked[i]!.faceIndices;
            for (const f0 of faces) {
              const f = f0 | 0;
              if (f < 0 || f >= usdFaceCount) continue;
              const s = getStart(f);
              const c = getCount(f);
              if (c <= 0) continue;
              const e = Math.min(triCount, s + c);
              for (let t = s; t < e; t++) covered[t] = 1;
            }
            addFaceRuns(faces, /* materialIndex */ i + 1);
          }

          // Add fallback group for uncovered faces (materialIndex 0)
          // Create contiguous runs over the triangle stream.
          let runStart = -1;
          for (let t = 0; t < triCount; t++) {
            if (covered[t]) {
              if (runStart >= 0) {
                realGeom.addGroup(runStart * 3, (t - runStart) * 3, 0);
                runStart = -1;
              }
            } else if (runStart < 0) {
              runStart = t;
            }
          }
          if (runStart >= 0) {
            realGeom.addGroup(runStart * 3, (triCount - runStart) * 3, 0);
          }

          return { materials, didApply: true };
        };

        const subsetApplied = applyGeomSubsetMaterials();
        const mesh = new THREE.Mesh(realGeom, subsetApplied.materials);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        container.add(mesh);
      }
    } else {
      const b = computePointsBounds(getPrimProp(node.prim, 'points'));
      if (b) {
        if (unitScale !== 1.0) {
          b.min.multiplyScalar(unitScale);
          b.max.multiplyScalar(unitScale);
        }
        const g = new THREE.BoxGeometry(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
        const mesh = new THREE.Mesh(g, mat);
        mesh.position.set((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        container.add(mesh);
      }
    }
  }

  // BasisCurves support (e.g. curves/basisCurves.usda)
  // Notes/limitations:
  // - We support `type = "linear"` and `type = "cubic"` (bezier via piecewise cubic segments).
  // - USD `widths` can be varying; Three's built-in TubeGeometry can't vary radius along the curve without a custom shader,
  //   so we approximate by using a single radius per-curve (first relevant width).
  if (typeName === 'BasisCurves') {
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

  // Points (point cloud) support (e.g. PointClouds.usda)
  // IMPORTANT: Some USD samples (notably usd-wg-assets teapot animCycle) animate meshes by authoring
  // `points.timeSamples` (vertex deformation) rather than xformOp time samples. Track those meshes here so
  // playback can update vertex positions.
  if (typeName === 'Mesh' && animatedObjects && primHasAnimatedPoints(node.prim)) {
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
      animatedObjects.push({ kind: 'points', geoms, prim: node.prim, unitScale });
    }
  }

  if (typeName === 'Points') {
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

  // PointInstancer support (e.g. point_instancer_01.usda)
  if (typeName === 'PointInstancer') {
    const positions = parsePoint3ArrayToFloat32(getPrimProp(node.prim, 'positions'));
    const protoIndices = parseNumberArray(getPrimProp(node.prim, 'protoIndices'));
    const orientations = (() => {
      const oriProp = getPrimProp(node.prim, 'orientations');
      if (!oriProp || typeof oriProp !== 'object' || oriProp.type !== 'array') return null;
      const quats: THREE.Quaternion[] = [];
      for (const el of oriProp.value) {
        if (!el || typeof el !== 'object' || el.type !== 'tuple' || el.value.length < 4) {
          quats.push(new THREE.Quaternion()); // identity fallback
          continue;
        }
        const [x, y, z, w] = el.value;
        // USD quath (half-precision) identity is often (0,0,0,0) or (0,0,0,1). Normalize to Three.js format.
        if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number' && typeof w === 'number') {
          const q = new THREE.Quaternion(x, y, z, w);
          // If all components are 0, treat as identity.
          if (q.x === 0 && q.y === 0 && q.z === 0 && q.w === 0) q.set(0, 0, 0, 1);
          quats.push(q);
        } else {
          quats.push(new THREE.Quaternion());
        }
      }
      return quats.length > 0 ? quats : null;
    })();
    const scales = parseTuple3ArrayToFloat32(getPrimProp(node.prim, 'scales'));

    if (!positions || positions.length < 3) {
      console.warn('PointInstancer missing positions:', node.path);
      return;
    }

    const numInstances = positions.length / 3;
    if (!protoIndices || protoIndices.length !== numInstances) {
      console.warn('PointInstancer protoIndices length mismatch:', node.path);
      return;
    }

    // Resolve prototypes relationship. USD allows `rel prototypes = <path>` (single) or `rel prototypes = [<path>, ...]` (array).
    const prototypesProp = node.prim.properties?.get('prototypes');
    const prototypesDv: any = prototypesProp?.defaultValue;
    let prototypePaths: string[] = [];
    if (prototypesDv) {
      if (typeof prototypesDv === 'object' && prototypesDv.type === 'sdfpath' && typeof prototypesDv.value === 'string') {
        prototypePaths = [prototypesDv.value];
      } else if (typeof prototypesDv === 'object' && prototypesDv.type === 'array') {
        for (const el of prototypesDv.value) {
          if (el && typeof el === 'object' && el.type === 'sdfpath' && typeof el.value === 'string') {
            prototypePaths.push(el.value);
          }
        }
      }
    }

    if (prototypePaths.length === 0) {
      // Fallback: look for prototype children directly under the PointInstancer prim.
      // In the sample, `asset` is a child of the PointInstancer.
      if (node.prim.children) {
        for (const [name, child] of node.prim.children) {
          // Build absolute path from root.
          const absPath = node.path === '/' ? '/' + name : node.path + '/' + name;
          prototypePaths.push(absPath);
        }
      }
    }

    if (prototypePaths.length === 0) {
      console.warn('PointInstancer has no prototypes:', node.path);
      return;
    }

    // Render each prototype once to get its geometry/material, then instance it.
    // Each prototype can have multiple meshes (e.g., trunk + leaves), so store as array of arrays.
    const prototypeMeshes: Array<Array<{ geom: THREE.BufferGeometry; mat: THREE.Material }>> = [];
    for (const protoPath of prototypePaths) {
      const protoPrim = findPrimByPath(rootPrim, protoPath);
      if (!protoPrim) {
        console.warn('PointInstancer prototype not found:', protoPath);
        prototypeMeshes.push([]); // Push empty array to maintain index alignment
        continue;
      }

      // Build a temporary scene node for the prototype so we can render it.
      // Recursively build the entire subtree (like buildTree does).
      const buildProtoNode = (prim: SdfPrimSpec, parentPath: string): SceneNode => {
        const children: SceneNode[] = [];
        if (prim.children) {
          for (const [name, child] of prim.children) {
            const childPath = parentPath === '/' ? '/' + name : parentPath + '/' + name;
            children.push(buildProtoNode(child, childPath));
          }
        }
        return {
          path: parentPath,
          typeName: prim.typeName,
          prim,
          children,
        };
      };
      const protoNode = buildProtoNode(protoPrim, protoPath);

      // Render prototype into a temporary container to extract geometry/material.
      // Mark the prototype node so material bindings can resolve relative to the prototype root.
      // This is needed because referenced files use absolute paths like /root/Materials/tree_leaves
      // which should resolve relative to the prototype, not the stage root.
      const tempContainer = new THREE.Object3D();
      (protoNode as any).__prototypeRoot = protoPrim; // Pass prototype root for material resolution
      console.log(`[PointInstancer] Setting __prototypeRoot=${protoPrim.path?.primPath} for protoNode=${protoNode.path}`);
      console.log(`[PointInstancer] protoNode children:`, protoNode.children.map(c => c.path));
      renderPrim(
        tempContainer,
        helpersParent,
        protoNode,
        selectionPath,
        helpers,
        rootPrim, // Use main stage root - references should be merged into it
        sceneRef,
        hasUsdLightsRef,
        hasUsdDomeLightRef,
        resolveAssetUrl,
        unitScale,
        dynamicHelperUpdates,
        skeletonsToUpdate,
        domeEnv,
        currentIdentifier,
        animatedObjects,
      );
      delete (protoNode as any).__prototypeRoot; // Clean up

      // Extract all meshes from the prototype container.
      const meshesForThisProto: Array<{ geom: THREE.BufferGeometry; mat: THREE.Material }> = [];
      tempContainer.traverse((obj: THREE.Object3D) => {
        if (obj instanceof THREE.Mesh && obj.geometry && obj.material) {
          const originalMat = Array.isArray(obj.material) ? obj.material[0]! : obj.material;
          const clonedMat = originalMat.clone();
          // Ensure material properties are properly copied (Three.js clone should handle this, but ensure needsUpdate is set)
          clonedMat.needsUpdate = true;
          // Debug: verify material color is preserved (especially for tree_leaves green color)
          if ('color' in clonedMat && clonedMat.color) {
            const matColor = clonedMat.color as THREE.Color;
            // Log if we see a green-ish color (for debugging tree_leaves)
            if (matColor.g > 0.2 && matColor.r < 0.1 && matColor.b < 0.1) {
              console.log(`PointInstancer prototype mesh material color: r=${matColor.r}, g=${matColor.g}, b=${matColor.b}, obj.name=${obj.name}`);
            }
          }
          meshesForThisProto.push({
            geom: obj.geometry.clone(),
            mat: clonedMat,
          });
        }
      });
      prototypeMeshes.push(meshesForThisProto);
    }

    if (prototypeMeshes.length === 0 || prototypeMeshes.every(m => m.length === 0)) {
      console.warn('PointInstancer prototype produced no meshes:', node.path);
      return;
    }

    // Group instances by prototype index to use InstancedMesh when possible.
    const instancesByProto: Map<number, Array<{ pos: THREE.Vector3; rot: THREE.Quaternion; scale: THREE.Vector3 }>> = new Map();
    for (let i = 0; i < numInstances; i++) {
      const protoIdx = protoIndices[i] ?? 0;
      if (protoIdx < 0 || protoIdx >= prototypeMeshes.length) {
        console.warn(`PointInstancer protoIndices[${i}] = ${protoIdx} out of range [0, ${prototypeMeshes.length})`);
        continue;
      }

      const pos = new THREE.Vector3(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
      if (unitScale !== 1.0) pos.multiplyScalar(unitScale);

      const rot = orientations && orientations[i] ? orientations[i]!.clone() : new THREE.Quaternion();
      const scale = scales && scales.length >= (i + 1) * 3
        ? new THREE.Vector3(scales[i * 3]!, scales[i * 3 + 1]!, scales[i * 3 + 2]!)
        : new THREE.Vector3(1, 1, 1);

      if (!instancesByProto.has(protoIdx)) instancesByProto.set(protoIdx, []);
      instancesByProto.get(protoIdx)!.push({ pos, rot, scale });
    }

    // Create InstancedMesh (or regular Mesh) for each mesh in each prototype group.
    // Each prototype can have multiple meshes (e.g., trunk + leaves), so we need to instance each separately.
    for (const [protoIdx, instances] of instancesByProto) {
      const meshes = prototypeMeshes[protoIdx];
      if (!meshes || meshes.length === 0) {
        console.warn(`PointInstancer prototype ${protoIdx} has no meshes`);
        continue;
      }

      // For each mesh in this prototype (e.g., trunk, leaves), create instances.
      for (const { geom, mat } of meshes) {
        if (instances.length === 1) {
          // Single instance: just clone the mesh.
          const mesh = new THREE.Mesh(geom, mat);
          const inst = instances[0]!;
          mesh.position.copy(inst.pos);
          mesh.quaternion.copy(inst.rot);
          mesh.scale.copy(inst.scale);
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          container.add(mesh);
        } else {
          // Multiple instances: use InstancedMesh.
          const instancedMesh = new THREE.InstancedMesh(geom, mat, instances.length);
          instancedMesh.castShadow = true;
          instancedMesh.receiveShadow = true;

          const matrix = new THREE.Matrix4();
          for (let i = 0; i < instances.length; i++) {
            const inst = instances[i]!;
            matrix.compose(inst.pos, inst.rot, inst.scale);
            instancedMesh.setMatrixAt(i, matrix);
          }
          instancedMesh.instanceMatrix.needsUpdate = true;
          container.add(instancedMesh);
        }
      }
    }
  }

  // Lights (same mapping as before)
  if (typeName === 'DistantLight' || typeName === 'SphereLight' || typeName === 'RectLight' || typeName === 'DomeLight') {
    const getNumber = (names: string[], fallback: number): number => {
      for (const n of names) {
        const v = getPrimProp(node.prim, n);
        if (typeof v === 'number') return v;
      }
      return fallback;
    };
    const getBool = (names: string[], fallback: boolean): boolean => {
      for (const n of names) {
        const v = getPrimProp(node.prim, n);
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
      }
      return fallback;
    };

    // UsdLux attributes are typically authored as `intensity`, `color`, `angle` (no inputs: prefix).
    // Some pipelines may author as `inputs:intensity` etc. Support both.
    const intensityVal = getNumber(['inputs:intensity', 'intensity'], 1.0);
    const exposureVal = getNumber(['inputs:exposure', 'exposure'], 0.0);
    const intensityBase = intensityVal * Math.pow(2, exposureVal);

    const colorProp = getPrimProp(node.prim, 'inputs:color') ?? getPrimProp(node.prim, 'color');
    let lightColor = new THREE.Color(0xffffff);
    if (colorProp && typeof colorProp === 'object' && colorProp.type === 'tuple' && colorProp.value.length >= 3) {
      const [r, g, b] = colorProp.value;
      if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number') {
        lightColor = new THREE.Color(r, g, b);
      }
    }

    if (typeName === 'DistantLight') {
      const light = new THREE.DirectionalLight(lightColor, intensityBase / 1000);

      const angleVal = getNumber(['inputs:angle', 'angle'], 0.53);

      light.castShadow = true;
      // Shadow-map acne guard (USD reference renderers are ray/path traced; WebGL shadow maps need bias).
      // NOTE: bias values are in world units. Since geometry is already converted to meters by unitScale,
      // we use constant values that work well for the resulting meter-scale scene.
      // The normalBias is the key to preventing planar self-shadowing ("shadow acne") - it pushes
      // the shadow sampling point along the surface normal during lookup.
      light.shadow.bias = -0.0001;
      light.shadow.normalBias = 0.02;
      // Softer, less "razor sharp" shadows by default:
      // - lower map resolution
      // - larger PCF blur radius
      // - larger shadow camera frustum (reduces texel density)
      light.shadow.mapSize.set(2048, 2048);
      // PCFSoftShadowMap blur radius (in shadow texels).
      light.shadow.radius = 14;
      // USD `angle` is about light angular diameter, not shadow-map frustum size. For small angles we still
      // need a sufficiently large frustum to avoid ultra-crisp texel density in cm-authored scenes.
      const shadowSize = Math.max(5, Math.tan(THREE.MathUtils.degToRad(angleVal)) * 500);
      light.shadow.camera.left = -shadowSize;
      light.shadow.camera.right = shadowSize;
      light.shadow.camera.top = shadowSize;
      light.shadow.camera.bottom = -shadowSize;
      light.shadow.camera.near = 0.1;
      light.shadow.camera.far = 1000;

      // DirectionalLight direction is defined by (position -> target). To match USD's convention
      // ("identity" points along -Z in local space), keep both under the prim container and aim at -Z.
      // Keep a small separation between light and target so the directional shadow camera
      // has a stable transform (position affects shadow projection).
      light.position.set(0, 0, 1);
      light.target.position.set(0, 0, 0);
      container.add(light.target);
      container.add(light);
      // Important: do NOT also `scene.add(light)` here; it would detach from `container` and lose authored xforms.
      hasUsdLightsRef.value = true;

      // Visible gizmo (DirectionalLight is otherwise invisible).
      // Put the helper under the identity `helpersParent` so it reads the light's world transform correctly.
      const helperSize = Math.max(1, 10 * unitScale);
      const helper = new THREE.DirectionalLightHelper(light, helperSize, 0xffff00);
      helpersParent.add(helper);
      dynamicHelperUpdates.push(() => helper.update());
    } else if (typeName === 'SphereLight') {
      const radiusVal = getNumber(['inputs:radius', 'radius'], 0.0) * unitScale;
      const coneAngleVal = getNumber(['inputs:shaping:cone:angle', 'shaping:cone:angle'], 180.0);
      const coneSoftnessVal = getNumber(['inputs:shaping:cone:softness', 'shaping:cone:softness'], 0.0);
      const normalize = getBool(['inputs:normalize', 'normalize'], false);

      // USD LightAPI defines intensity/exposure as emitted luminance in nits (cd/m^2):
      //   L = intensity * 2^exposure   (see OpenUSD `UsdLuxLightAPI`)
      // Three.js (physically-correct lights) expects PointLight/SpotLight intensity in candela (cd).
      // A practical approximation for a uniformly-emitting sphere is:
      //   I_cd ≈ L * A_proj, where A_proj = π r^2 (projected area).
      //
      // Note: OpenUSD `inputs:normalize` (if enabled) divides luminance by world-space surface area.
      // For SphereLight, that means L /= (4πr^2), making the total power invariant w.r.t. radius.
      //
      // We keep a single empirical scaling constant so the ft-lab sample corpus fits within the
      // viewer's exposure/tonemapping without blowing out.
      //
      // NOTE: Earlier versions of this viewer effectively behaved like:
      //   I ≈ (intensity * r^2) / K
      // Switching to A_proj (= π r^2) introduces an extra factor of π and makes the corpus look too bright.
      // Fold that π into the scale constant so we preserve the intended brightness.
      const GLOBAL_NITS_TO_THREE = 8000 * Math.PI; // empirical scale for this viewer (tuned for ft-lab light samples)
      const r = Math.max(0, radiusVal);
      const surfaceArea = 4 * Math.PI * r * r;
      const L = normalize && surfaceArea > 0 ? intensityBase / surfaceArea : intensityBase; // nits (cd/m^2)
      const Aproj = Math.PI * r * r;
      const sphereIntensity = (L * Aproj) / GLOBAL_NITS_TO_THREE; // candela-ish

      // If shaping cone is less than 180°, approximate with a SpotLight.
      if (coneAngleVal < 179.9) {
        const light = new THREE.SpotLight(lightColor, sphereIntensity, 1000);
        // IMPORTANT: Three.js SpotLight defaults to position (0,1,0).
        // In USD, the light is located at the prim origin; leaving the default introduces an unintended
        // offset which makes the light appear to "tilt" (direction becomes from (0,1,0) → target).
        light.position.set(0, 0, 0);
        // OpenUSD ShapingAPI `shaping:cone:angle` is a *half-angle* in degrees (from axis to cone edge).
        // Three.js SpotLight.angle uses the same half-angle convention (in radians).
        const halfAngleRad = THREE.MathUtils.degToRad(coneAngleVal);
        // Three.js spotlight shader expects angle in [0, PI/2]; clamp to avoid undefined behavior for very wide cones.
        light.angle = THREE.MathUtils.clamp(halfAngleRad, 0, Math.PI / 2 - 1e-4);
        // Cone edge softness (spec-correct):
        // OpenUSD UsdLux ShapingAPI defines:
        //   smoothStart = lerp(coneSoftness, cutoff, 0)  with lerp(t,a,b) = (1-t)a + tb
        // => smoothStart = (1 - coneSoftness) * cutoff
        // Three.js uses:
        //   inner = outer * (1 - penumbra)
        // So, penumbra maps 1:1 to USD `shaping:cone:softness` in [0,1].
        const s = THREE.MathUtils.clamp(coneSoftnessVal, 0, 1);
        light.penumbra = s;
        // USD lights have no finite range cutoff; Three's `distance=0` means infinite.
        (light as any).distance = 0;
        (light as any).decay = 2;
        light.castShadow = true;
        // Shadow-map acne guard (constant values for meter-scale geometry).
        light.shadow.bias = -0.0001;
        light.shadow.normalBias = 0.02;
        light.shadow.mapSize.set(1024, 1024);
        // With distance=0, Three's SpotLightShadow uses `camera.far` (defaults ~500), which makes
        // shadows "fade out" with distance. Keep shadows valid over large scenes.
        (light.shadow.camera as any).near = 0.1;
        (light.shadow.camera as any).far = 1_000_000;
        (light.shadow.camera as any).updateProjectionMatrix?.();
        // Shadow blur is not the same as cone-edge softness, but helps match the "pathtraced" look.
        light.shadow.radius = Math.max(4, THREE.MathUtils.clamp(radiusVal / 10 + s * 8, 0, 15));

        // Default direction: -Z in local space.
        light.target.position.set(0, 0, -1);
        container.add(light.target);
        container.add(light);

        // Visible gizmo (lights are otherwise invisible).
        const helper = new THREE.SpotLightHelper(light, 0xffff00);
        helpersParent.add(helper);
        dynamicHelperUpdates.push(() => helper.update());
      } else {
        const light = new THREE.PointLight(lightColor, sphereIntensity, 1000);
        light.position.set(0, 0, 0);
        // USD lights have no finite range cutoff; Three's `distance=0` means infinite.
        (light as any).distance = 0;
        (light as any).decay = 2;
        light.castShadow = true;
        // Shadow-map acne guard (constant values for meter-scale geometry).
        light.shadow.bias = -0.0001;
        light.shadow.normalBias = 0.02;
        light.shadow.mapSize.set(1024, 1024);
        // Same story for PointLightShadow: keep shadow camera range large when we model USD lights as infinite-range.
        (light.shadow.camera as any).near = 0.1;
        (light.shadow.camera as any).far = 1_000_000;
        (light.shadow.camera as any).updateProjectionMatrix?.();
        light.shadow.radius = Math.max(4, THREE.MathUtils.clamp(radiusVal / 10, 0, 15));
        container.add(light);

        // Visible gizmo (approx. "radius" as helper size).
        const helperSize = Math.max(1, radiusVal || 1);
        const helper = new THREE.PointLightHelper(light, helperSize, 0xffff00);
        helpersParent.add(helper);
        dynamicHelperUpdates.push(() => helper.update());
      }
      hasUsdLightsRef.value = true;
    } else if (typeName === 'RectLight') {
      // RectAreaLight exists in Three.js (a "square light" is just width == height).
      // Three's RectAreaLight intensity is in nits (see RectAreaLight.power getter/setter),
      // matching USD LightAPI's intensity/exposure being luminance in nits (cd/m^2).
      const widthVal = getNumber(['inputs:width', 'width'], 1.0) * unitScale;
      const heightVal = getNumber(['inputs:height', 'height'], 1.0) * unitScale;
      const normalize = getBool(['inputs:normalize', 'normalize'], false);
      const area = Math.max(0, widthVal) * Math.max(0, heightVal);
      const L = normalize && area > 0 ? intensityBase / area : intensityBase; // nits (cd/m^2)
      const USD_NITS_TO_THREE_NITS = 8000; // viewer calibration constant (keep consistent with SphereLight mapping)
      const light = new THREE.RectAreaLight(lightColor, L / USD_NITS_TO_THREE_NITS, widthVal, heightVal);
      light.position.set(0, 0, 0);
      light.lookAt(0, 0, -1);
      container.add(light);
      // Important: keep it parented under `container` so authored xforms apply.
      hasUsdLightsRef.value = true;
    } else if (typeName === 'DomeLight') {
      // DomeLight is environment lighting. If a latlong texture is provided, load it and set scene.environment.
      // Otherwise, fall back to a simple hemispherical ambient approximation.
      const texVal = getPrimProp(node.prim, 'inputs:texture:file') ?? getPrimProp(node.prim, 'texture:file');
      const texAsset = (texVal && typeof texVal === 'object' && (texVal as any).type === 'asset')
        ? ((texVal as any).value as string)
        : null;
      const fmtVal = getPrimProp(node.prim, 'inputs:texture:format') ?? getPrimProp(node.prim, 'texture:format');
      const fmt =
        typeof fmtVal === 'string'
          ? fmtVal
          : fmtVal && typeof fmtVal === 'object' && (fmtVal as any).type === 'token'
            ? ((fmtVal as any).value as string)
            : null;

      if (texAsset && resolveAssetUrl && domeEnv) {
        hasUsdDomeLightRef.value = true;
        const url = resolveAssetUrl(texAsset);
        if (url) {
          const q = new THREE.Quaternion();
          container.getWorldQuaternion(q);
          domeEnv.setFromDomeLight({
            assetPath: url,
            format: fmt,
            worldQuaternion: q,
            intensity: intensityBase,
          });
        }
      } else {
        const light = new THREE.HemisphereLight(lightColor, new THREE.Color(0x000000), intensityBase / 1000);
        container.add(light);
      }
      hasUsdLightsRef.value = true;
    }
  }

  if (selectionPath && node.path === selectionPath) {
    const box = new THREE.Box3().setFromObject(container);
    const helper = new THREE.Box3Helper(box, 0x99ff99);
    helpers.set(node.path, helper);
    objParent.add(helper);
  }

  // Native USD instancing (instanceable + internal references), e.g. samples/instance/instance_test.usda
  // In this viewer we don't have full USD prototype instancing; instead, for simple internal references
  // like `prepend references = </World/Group>`, we expand the referenced prim subtree under the instance prim.
  // This fixes cases where an instanceable prim would otherwise appear empty.
  if (node.children.length === 0) {
    const md = node.prim.metadata ?? {};
    const instanceable = md['instanceable'];
    const refs = md['references'];
    const isInstanceable = instanceable === true || (typeof instanceable === 'number' && instanceable !== 0);

    const extractRefPaths = (v: any): string[] => {
      if (!v) return [];
      // listOp dict: { op, value }
      if (typeof v === 'object' && v.type === 'dict' && v.value && typeof v.value === 'object' && 'value' in v.value) {
        return extractRefPaths((v.value as any).value);
      }
      // single sdfpath
      if (typeof v === 'object' && v.type === 'sdfpath' && typeof v.value === 'string') return [v.value];
      // array of sdfpaths
      if (typeof v === 'object' && v.type === 'array' && Array.isArray(v.value)) {
        const out: string[] = [];
        for (const el of v.value) {
          if (el && typeof el === 'object' && el.type === 'sdfpath' && typeof el.value === 'string') out.push(el.value);
        }
        return out;
      }
      return [];
    };

    if (isInstanceable && refs) {
      const refPaths = extractRefPaths(refs);
      if (refPaths.length > 0) {
        // Pick the first internal reference that resolves to a prim.
        let targetPrim: SdfPrimSpec | null = null;
        let targetPath = '';
        for (const p of refPaths) {
          const prim = findPrimByPath(rootPrim, p);
          if (prim) {
            targetPrim = prim;
            targetPath = p;
            break;
          }
        }

        if (targetPrim) {
          const safeRefName = targetPath.replaceAll('/', '_');
          const refRootPath = `${node.path}.__ref__${safeRefName}`;

          const buildRefNode = (prim: SdfPrimSpec, curPath: string): SceneNode => {
            const children: SceneNode[] = [];
            if (prim.children) {
              for (const [name, child] of prim.children) {
                const childPath = curPath === '/' ? '/' + name : curPath + '/' + name;
                children.push(buildRefNode(child, childPath));
              }
            }
            return { path: curPath, typeName: prim.typeName, prim, children };
          };

          // Render the referenced prim subtree under this instance prim's container.
          // Pass the instance's prototype root (if any) through for material resolution consistency.
          const refNode = buildRefNode(targetPrim, refRootPath);
          (refNode as any).__prototypeRoot = prototypeRootForMaterials;
          renderPrim(
            container,
            helpersParent,
            refNode,
            selectionPath,
            helpers,
            rootPrim,
            sceneRef,
            hasUsdLightsRef,
            hasUsdDomeLightRef,
            resolveAssetUrl,
            unitScale,
            dynamicHelperUpdates,
            skeletonsToUpdate,
            domeEnv,
            currentIdentifier,
            animatedObjects,
          );
        }
      }
    }
  }

  // For PointInstancer, skip rendering children normally - prototypes are only rendered as instances.
  // The PointInstancer code already extracts and instances the prototype geometry/materials.
  if (typeName === 'PointInstancer') {
    return;
  }

  // USD Skeleton support - create Three.js Skeleton and SkeletonHelper visualization
  if (typeName === 'Skeleton') {
    // Parse joint names and transforms from USD
    const jointsProp = getPrimProp(node.prim, 'joints');
    const bindTransformsProp = getPrimProp(node.prim, 'bindTransforms');
    const restTransformsProp = getPrimProp(node.prim, 'restTransforms');


    if (jointsProp && typeof jointsProp === 'object' && jointsProp.type === 'array') {
      const jointNames: string[] = jointsProp.value
        .filter((j: any) => typeof j === 'string')
        .map((j: string) => j);

      // Parse bind transforms (4x4 matrices)
      const bindTransforms = parseMatrix4dArray(bindTransformsProp);
      // Parse rest transforms (local space, relative to parent)
      const restTransforms = parseMatrix4dArray(restTransformsProp);


      if (jointNames.length > 0 && (bindTransforms || restTransforms)) {
        // Build joint hierarchy and create Bones
        const bones: THREE.Bone[] = [];
        const boneByName = new Map<string, THREE.Bone>();

        // Create all bones first
        for (let i = 0; i < jointNames.length; i++) {
          const bone = new THREE.Bone();
          bone.name = jointNames[i]!;
          bones.push(bone);
          boneByName.set(jointNames[i]!, bone);
        }

        // Set up parent-child relationships based on joint path hierarchy
        // USD joint names are paths like "boneA", "boneA/boneB", "boneA/boneB/boneC"
        for (let i = 0; i < jointNames.length; i++) {
          const name = jointNames[i]!;
          const bone = bones[i]!;
          const parts = name.split('/');
          if (parts.length > 1) {
            parts.pop();
            const parentName = parts.join('/');
            const parentBone = boneByName.get(parentName);
            if (parentBone) {
              parentBone.add(bone);
            }
          }
        }

        // Apply rest transforms (local transforms for each bone)
        if (restTransforms && restTransforms.length === jointNames.length) {
          for (let i = 0; i < jointNames.length; i++) {
            const matrix = restTransforms[i];
            if (matrix) {
              // Apply unit scale to the translation component
              const scaledMatrix = matrix.clone();
              const pos = new THREE.Vector3();
              const rot = new THREE.Quaternion();
              const scale = new THREE.Vector3();
              scaledMatrix.decompose(pos, rot, scale);
              pos.multiplyScalar(unitScale);
              bones[i]!.position.copy(pos);
              bones[i]!.quaternion.copy(rot);
              bones[i]!.scale.copy(scale);
            }
          }
        }

        // Find the root bone(s) - bones that don't have a parent bone
        // (their parent is either null or not a Bone type)
        const rootBones = bones.filter((b) => !(b.parent instanceof THREE.Bone));

        // Create a wrapper object to hold the bone hierarchy
        const skelRoot = new THREE.Object3D();
        skelRoot.name = `${node.path}/skeleton_root`;
        for (const root of rootBones) {
          skelRoot.add(root);
        }
        container.add(skelRoot);

        // Update matrices for the bone hierarchy
        skelRoot.updateMatrixWorld(true);

        // Create Skeleton with bind matrices (inverse bind matrices for skinning)
        const boneInverses: THREE.Matrix4[] = [];
        if (bindTransforms && bindTransforms.length === jointNames.length) {
          for (let i = 0; i < jointNames.length; i++) {
            const bindMatrix = bindTransforms[i];
            if (bindMatrix) {
              // Apply unit scale to bind transform translation
              const scaledBind = bindMatrix.clone();
              const pos = new THREE.Vector3();
              const rot = new THREE.Quaternion();
              const scale = new THREE.Vector3();
              scaledBind.decompose(pos, rot, scale);
              pos.multiplyScalar(unitScale);
              scaledBind.compose(pos, rot, scale);
              // Bind inverse = inverse of world-space bind pose
              boneInverses.push(scaledBind.clone().invert());
            } else {
              boneInverses.push(new THREE.Matrix4());
            }
          }
        }

        const skeleton = new THREE.Skeleton(bones, boneInverses.length ? boneInverses : undefined);

        // Store the skeleton on the container for later binding with SkinnedMesh
        (container as any).__usdSkeleton = skeleton;
        (container as any).__usdJointNames = jointNames;

        // Add skeleton and bone root to the update list so it's updated every frame for SkinnedMesh
        skeletonsToUpdate.push({ skeleton, boneRoot: skelRoot });

        // Create and add SkeletonHelper - it draws lines between bones
        const skelHelper = new THREE.SkeletonHelper(skelRoot);
        skelHelper.name = `${node.path}/skeleton_helper`;
        // SkeletonHelper.material is a LineBasicMaterial
        const helperMat = skelHelper.material as THREE.LineBasicMaterial;
        helperMat.linewidth = 2;
        helperMat.color.setHex(0xff6b35); // Orange-red color like reference
        helperMat.depthTest = false;
        helperMat.depthWrite = false;
        skelHelper.renderOrder = 999; // Render on top
        helpersParent.add(skelHelper);

        // Store helper reference for later access
        helpers.set(node.path + '/skeleton_helper', skelHelper);
      }
    }
  }

  for (const child of node.children) {
    // Propagate prototype root to children so material bindings resolve correctly
    // for referenced prototypes (e.g. PointInstancer simpleTree).
    if (prototypeRootForMaterials) {
      (child as any).__prototypeRoot = prototypeRootForMaterials;
    }
    renderPrim(
      container,
      helpersParent,
      child,
      selectionPath,
      helpers,
      rootPrim,
      sceneRef,
      hasUsdLightsRef,
      hasUsdDomeLightRef,
      resolveAssetUrl,
      unitScale,
      dynamicHelperUpdates,
      skeletonsToUpdate,
      domeEnv,
      currentIdentifier,
      animatedObjects,
    );
  }

  // Minimal support for UsdGeomModelAPI draw modes (used by Teapot/DrawModes.usd).
  // We currently don't evaluate `extentsHint`, so we derive bounds from the rendered subtree,
  // then hide the full geometry and replace it with a proxy representation.
  //
  // Supported:
  // - model:drawMode = "bounds"  -> wireframe bbox
  // - model:drawMode = "origin"  -> axes at model origin
  // - model:drawMode = "cards"   -> simple card planes (cross/box) using model:cardGeometry
  const drawModeVal = getPrimProp(node.prim, 'model:drawMode');
  const drawMode =
    typeof drawModeVal === 'string'
      ? drawModeVal
      : drawModeVal && typeof drawModeVal === 'object' && (drawModeVal as any).type === 'token'
        ? (drawModeVal as any).value
        : null;

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
        proxy.name = `${node.path}/__drawModeProxy`;

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
          const cardGeomVal = getPrimProp(node.prim, 'model:cardGeometry');
          const cardGeometry =
            typeof cardGeomVal === 'string'
              ? cardGeomVal
              : cardGeomVal && typeof cardGeomVal === 'object' && (cardGeomVal as any).type === 'token'
                ? (cardGeomVal as any).value
                : 'cross';

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

function tupleToColor(tuple: any): THREE.Color | null {
  if (!tuple || tuple.type !== 'tuple' || tuple.value.length < 3) return null;
  const [r, g, b] = tuple.value;
  if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') return null;
  return new THREE.Color(Math.max(0, Math.min(1, r)), Math.max(0, Math.min(1, g)), Math.max(0, Math.min(1, b)));
}

function listPrimCount(root: any): number {
  let n = 0;
  const walk = (p: any) => {
    n++;
    if (!p.children) return;
    for (const c of p.children.values()) walk(c);
  };
  walk(root);
  return n;
}

export function createViewerCore(opts: {
  viewportEl: HTMLElement;
  onStatus: (msg: string) => void;
  onTree: (nodes: PrimeTreeNode[], selectedPath: string | null) => void;
}): ViewerCore {
  // Debug logging (opt-in): add `?usddebug=1` to the URL or set `localStorage.usddebug = "1"`.
  // Keep logs throttled so huge scenes don't spam the console.
  const USDDEBUG =
    (() => {
      try {
        const q = new URLSearchParams(window.location.search ?? '');
        if (q.get('usddebug') === '1') return true;
        if (localStorage.getItem('usddebug') === '1') return true;
      } catch {
        // ignore
      }
      return false;
    })();
  const dbg = (...args: any[]) => {
    if (!USDDEBUG) return;
    // Use console.log (not console.debug) so it shows up even when DevTools filters out "Verbose".
    // eslint-disable-next-line no-console
    console.log('[usdjs-viewer]', ...args);
  };
  if (USDDEBUG) {
    // eslint-disable-next-line no-console
    console.log('[usdjs-viewer] debug enabled (usddebug=1)');
  }

  const LS_KEY_LAST_STATE = 'usdjs-viewer:lastState:v1';
  type LastViewerState = {
    entryKey?: string;
    textarea?: string;
    compose?: boolean;
    corpusRel?: string;
    selectedPath?: string | null;
  };

  const HASH_PREFIX_CORPUS = '#corpus=';
  const CORPUS_PATH_PREFIX = 'packages/usdjs/';

  function normalizeCorpusPathForHash(rel: string): string {
    // Ensure path starts with packages/usdjs/ for hash storage
    if (rel.startsWith(CORPUS_PATH_PREFIX)) {
      return rel;
    }
    return `${CORPUS_PATH_PREFIX}${rel}`;
  }

  function normalizeCorpusPathForFetch(rel: string): string {
    // Strip packages/usdjs/ prefix if present, since fetchCorpusFile expects relative paths
    if (rel.startsWith(CORPUS_PATH_PREFIX)) {
      return rel.slice(CORPUS_PATH_PREFIX.length);
    }
    return rel;
  }

  function setCorpusHash(rel: string | null) {
    try {
      const nextHash = rel ? `${HASH_PREFIX_CORPUS}${normalizeCorpusPathForHash(rel)}` : '';
      const url = new URL(window.location.href);
      url.hash = nextHash;
      history.replaceState(null, '', url);
    } catch {
      // ignore
    }
  }

  function readCorpusHash(): string | null {
    const h = window.location.hash ?? '';
    if (!h.startsWith(HASH_PREFIX_CORPUS)) return null;
    const raw = h.slice(HASH_PREFIX_CORPUS.length);
    if (!raw) return null;
    let decoded = raw;
    if (raw.includes('%')) {
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        decoded = raw;
      }
    }
    // Return the full path as stored in hash (may or may not have packages/usdjs/ prefix for backward compatibility)
    return decoded;
  }

  function readLastState(): LastViewerState | null {
    try {
      const raw = localStorage.getItem(LS_KEY_LAST_STATE);
      if (!raw) return null;
      return JSON.parse(raw) as LastViewerState;
    } catch {
      return null;
    }
  }

  function writeLastState(next: LastViewerState) {
    try {
      localStorage.setItem(LS_KEY_LAST_STATE, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  const externalFiles = new Map<string, { name: string; text: string }>();
  let textareaText = DEFAULT_USDA;
  let entryKey = '<textarea>';
  let compose = true;
  let selectedPath: string | null = null;
  let currentIdentifier = '<viewer>';
  let stageUnitScale = 1.0; // metersPerUnit (defaults to 1m per unit)

  // Animation state
  let animationPlaying = false;
  let animationCurrentTime = 0;
  let animationStartTime = 0;
  let animationEndTime = 0;
  let animationFps = 24; // Default USD timeCodesPerSecond
  let lastAnimationFrameTime = 0;
  // Track animated objects: { object, prim, unitScale } for updating transforms each frame
  const animatedObjects: AnimatedObject[] = [];

  // Three.js setup
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  // Stable selector for automation (Playwright) and debugging.
  (renderer.domElement as any).dataset ??= {};
  (renderer.domElement as any).dataset.testid = 'usdjs-canvas';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  // Use PCFShadowMap so `light.shadow.radius` actually softens edges.
  // (PCFSoftShadowMap has a fixed kernel and tends to stay crisp unless resolution is very high.)
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.6;
  // Required for correct RectAreaLight shading in WebGLRenderer (LTC uniforms).
  RectAreaLightUniformsLib.init();
  // Prefer physically-based light calculations when available. Recent Three versions use
  // `useLegacyLights`; older versions used `physicallyCorrectLights`.
  if ('useLegacyLights' in renderer) (renderer as any).useLegacyLights = false;
  else if ('physicallyCorrectLights' in renderer) (renderer as any).physicallyCorrectLights = true;
  opts.viewportEl.append(renderer.domElement);

  // Optional post-processing (enabled when renderSettings ask for it)
  let composer: EffectComposer | null = null;
  let renderPass: RenderPass | null = null;
  let colorPass: ShaderPass | null = null;
  let useComposer = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f0f1a);

  // Default IBL environment (keeps background solid, but enables reflections for PBR / clearcoat).
  // This makes texture-driven clearcoat effects visible (e.g. UsdPreviewSurface_clearcoat_with_texture.usda).
  // Use default sigma (0.04) for environment map blur.
  const pmremGen = new THREE.PMREMGenerator(renderer);
  const envRt = pmremGen.fromScene(new RoomEnvironment(), 0.04);
  const defaultEnvTex = envRt.texture;
  scene.environment = null;
  let domeEnvRt: THREE.WebGLRenderTarget | null = null;
  let domeLoadToken = 0;

  const setDomeEnvironmentFromUrl = (optsIn: {
    assetPath: string;
    format: string | null;
    worldQuaternion: THREE.Quaternion;
    intensity: number;
  }) => {
    const { assetPath, format, worldQuaternion, intensity } = optsIn;
    // Only latlong is supported right now (matches ft-lab dome_light.usda).
    if (format && format !== 'latlong') return;
    const token = ++domeLoadToken;

    // Determine loader based on file extension
    const isHDR = assetPath.toLowerCase().endsWith('.hdr');
    const isEXR = assetPath.toLowerCase().endsWith('.exr');

    const handleTexture = (tex: THREE.DataTexture | null) => {
      if (token !== domeLoadToken) {
        if (tex) tex.dispose();
        return;
      }
      if (!tex) {
        console.warn('DomeLight texture load returned null:', assetPath);
        return;
      }

      tex.mapping = THREE.EquirectangularReflectionMapping;
      // EXR/HDR textures are linear; keep in linear space for PMREM.
      (tex as any).colorSpace = (THREE as any).LinearSRGBColorSpace ?? (tex as any).colorSpace;
      domeEnvRt?.dispose();
      domeEnvRt = pmremGen.fromEquirectangular(tex);
      tex.dispose();
      scene.environment = domeEnvRt.texture;
      // Also show the dome as background (otherwise the viewer keeps a solid background color).
      scene.background = domeEnvRt.texture;
      // Orientation (spec-based, no guessing):
      // - OpenUSD DomeLight follows the OpenEXR latlong convention:
      //     longitude 0 points +Z, longitude π/2 points +X (DomeLight.md).
      // - Three.js equirectangular sampling uses longitude 0 at +X (atan2(z,x)), so we need a fixed -90° yaw.
      // - Three applies `environmentRotation`/`backgroundRotation` by rotating the lookup vector, so to
      //   "rotate the dome" by R we must apply R^{-1} to the lookup.
      const qInv = worldQuaternion.clone().invert();
      // OpenUSD DomeLight latlong follows the OpenEXR convention (DomeLight.md).
      // Three samples latlong using `equirectUv(dir)`:
      //   u = atan(dir.z, dir.x) / (2π) + 0.5
      // OpenEXR latlong defines longitude such that:
      //   longitude 0 points +Z; longitude π/2 points +X.
      // This corresponds to longitude = atan2(x, z) (note the swapped args), and OpenEXR's x axis runs
      // from +π at min.x to -π at max.x (i.e. u ∝ -longitude).
      //
      // The exact direction-space mapping that makes Three's `atan(dir.z, dir.x)` match OpenEXR's
      // `-atan2(x,z)` is:
      //   dir' = RotY(+π/2) * dir   (x' = z, z' = -x)
      //
      // Finally, DomeLight xform rotates the dome in world; to sample in dome-local space we apply R^{-1}.
      const qCorr = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), +Math.PI / 2);
      const qFinal = qInv.multiply(qCorr); // first OpenEXR→Three basis correction (world), then inverse dome rotation
      const eFinal = new THREE.Euler().setFromQuaternion(qFinal, 'XYZ');
      scene.environmentRotation.copy(eFinal);
      scene.backgroundRotation.copy(eFinal);
      // USD intensity is luminance in nits (cd/m^2). Three.js Scene.environmentIntensity is a unitless scalar,
      // so we keep using the viewer calibration constant used for other nits-based lights.
      const USD_NITS_TO_THREE = 8000;
      scene.environmentIntensity = intensity / USD_NITS_TO_THREE;
      scene.backgroundIntensity = scene.environmentIntensity;
    };

    if (isHDR) {
      // Use HDRLoader for HDR files
      new HDRLoader().load(
        assetPath,
        (tex: THREE.DataTexture) => handleTexture(tex),
        undefined,
        (err: unknown) => {
          console.error('DomeLight HDR load failed:', assetPath, err);
        },
      );
    } else if (isEXR) {
      // Use EXRLoader for EXR files
      new EXRLoader().load(
        assetPath,
        (tex: THREE.DataTexture) => handleTexture(tex),
        undefined,
        (err: unknown) => {
          console.error('DomeLight EXR load failed:', assetPath, err);
        },
      );
    } else {
      // Try EXR first (default), fall back gracefully
      new EXRLoader().load(
        assetPath,
        (tex: THREE.DataTexture) => handleTexture(tex),
        undefined,
        (err: unknown) => {
          // If EXR fails, try HDR
          console.warn('DomeLight EXR load failed, trying HDR:', assetPath, err);
          new HDRLoader().load(
            assetPath,
            (tex: THREE.DataTexture) => handleTexture(tex),
            undefined,
            (err2: unknown) => {
              console.error('DomeLight HDR load also failed:', assetPath, err2);
            },
          );
        },
      );
    }
  };

  function resetEnvironmentAndBackgroundForNewSample() {
    // Cancel in-flight dome loads and dispose previous PMREM targets so the previous sample
    // can't "stick" its environment/background into the next sample.
    domeLoadToken++;
    domeEnvRt?.dispose();
    domeEnvRt = null;

    scene.environment = null;
    scene.environmentIntensity = 1;
    scene.environmentRotation.set(0, 0, 0);

    // Viewer default background. `applyRenderSettings()` may override this if authored.
    scene.background = new THREE.Color(0x0f0f1a);
    scene.backgroundIntensity = 1;
    scene.backgroundRotation.set(0, 0, 0);
  }

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1_000_000);
  camera.position.set(80, 60, 120);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 15, 0);
  controls.update();

  // Grid helper: render after content, enable z-test but disable z-write
  const gridHelper = new THREE.GridHelper(200, 20, 0x333333, 0x222222);
  gridHelper.renderOrder = 1; // Render after content (default renderOrder is 0)
  gridHelper.traverse((child) => {
    const anyChild = child as any;
    if (anyChild?.isLine && anyChild?.material) {
      const mats: THREE.Material[] = Array.isArray(anyChild.material) ? anyChild.material : [anyChild.material];
      for (const m of mats) {
        (m as any).depthTest = true; // Enable z-test (occlusion by model)
        (m as any).depthWrite = false; // Disable z-write (don't modify depth buffer)
      }
    }
  });
  scene.add(gridHelper);

  // Axes helper: render last, enable z-test but disable z-write
  const axesHelper = new THREE.AxesHelper(20);
  axesHelper.renderOrder = 2; // Render last (after grid and content)
  axesHelper.traverse((child) => {
    const anyChild = child as any;
    if (anyChild?.isLine && anyChild?.material) {
      const mats: THREE.Material[] = Array.isArray(anyChild.material) ? anyChild.material : [anyChild.material];
      for (const m of mats) {
        (m as any).depthTest = true; // Enable z-test (occlusion by model)
        (m as any).depthWrite = false; // Disable z-write (don't modify depth buffer)
      }
    }
  });
  scene.add(axesHelper);

  // Default lights: kept low since RoomEnvironment IBL provides ambient fill.
  // These add subtle directionality without over-lighting the scene.
  const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x222222, 0.2);
  scene.add(hemisphereLight);
  const defaultDir = new THREE.DirectionalLight(0xffffff, 0.4);
  defaultDir.position.set(100, 200, 100);
  scene.add(defaultDir);

  let fog: THREE.Fog | null = null;

  const contentRoot = new THREE.Object3D();
  scene.add(contentRoot);

  // Some Three.js helpers (e.g. PointLightHelper/SpotLightHelper) require manual update after transforms change.
  const dynamicHelperUpdates: Array<() => void> = [];

  // Track all skeletons that need to be updated every frame for SkinnedMesh
  const skeletonsToUpdate: Array<{ skeleton: THREE.Skeleton; boneRoot: THREE.Object3D }> = [];

  function resize() {
    const w = opts.viewportEl.clientWidth;
    const h = opts.viewportEl.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    composer?.setSize(w, h);
  }
  const onResize = () => resize();
  window.addEventListener('resize', onResize);
  resize();

  let raf = 0;
  function renderLoop(timestamp: number) {
    controls.update();

    // Animation playback
    if (animationPlaying && animatedObjects.length > 0) {
      // Calculate frame advancement based on real time
      if (lastAnimationFrameTime === 0) {
        lastAnimationFrameTime = timestamp;
      }
      const deltaMs = timestamp - lastAnimationFrameTime;
      lastAnimationFrameTime = timestamp;

      // Advance time based on FPS
      const deltaTime = (deltaMs / 1000) * animationFps;
      animationCurrentTime += deltaTime;

      // Loop animation
      if (animationCurrentTime > animationEndTime) {
        animationCurrentTime = animationStartTime + (animationCurrentTime - animationEndTime);
      }

      // Update all animated objects
      for (const a of animatedObjects) {
        if (a.kind === 'xform') {
          applyXformOps(a.obj, a.prim, animationCurrentTime);
          if (a.unitScale !== 1.0) {
            a.obj.position.multiplyScalar(a.unitScale);
          }
        } else if (a.kind === 'points') {
          const pts = parsePoint3ArrayToFloat32(getPrimPropAtTime(a.prim, 'points', animationCurrentTime));
          if (!pts) continue;
          if (a.unitScale !== 1.0) {
            for (let i = 0; i < pts.length; i++) pts[i] = pts[i]! * a.unitScale;
          }
          for (const g of a.geoms) {
            const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
            if (!pos || !pos.array || pos.itemSize !== 3) continue;
            if (pos.array.length !== pts.length) continue;
            (pos.array as any).set(pts as any);
            pos.needsUpdate = true;
          }
        }
      }
    } else {
      lastAnimationFrameTime = 0; // Reset when paused
    }

    scene.updateMatrixWorld(true);
    // Update all skeletons for SkinnedMesh - this must happen every frame
    // First update the bone hierarchy, then update the skeleton matrices
    for (const { skeleton, boneRoot } of skeletonsToUpdate) {
      // Ensure bone hierarchy matrices are up to date
      boneRoot.updateMatrixWorld(true);
      // Update skeleton's bone matrices for skinning
      skeleton.update();
    }
    for (const fn of dynamicHelperUpdates) fn();
    if (useComposer && composer) composer.render();
    else renderer.render(scene, camera);
    raf = requestAnimationFrame(renderLoop);
  }
  raf = requestAnimationFrame(renderLoop);

  function clearThreeRoot() {
    while (contentRoot.children.length) contentRoot.remove(contentRoot.children[0]!);
    skeletonsToUpdate.length = 0; // Clear skeletons list when clearing scene
    animatedObjects.length = 0; // Clear animated objects list when clearing scene
  }

  function makeResolver() {
    const textCache = new Map<string, { identifier: string; text: string }>();
    const readHits = new Map<string, number>();
    return {
      async readText(assetPath: string, fromIdentifier?: string) {
        // Important: corpus entries are keyed as `[corpus]...` in the viewer, but the USD resolver
        // should operate on the real path. If we keep `[corpus]` in the identifier, resolveAssetPath()
        // will produce unstable/incorrect results and composition may repeatedly reload the same layer
        // under different identifiers (breaking expandArcsInLayer cycle guards).
        const fromId =
          typeof fromIdentifier === 'string' && fromIdentifier.startsWith('[corpus]')
            ? fromIdentifier.replace('[corpus]', '')
            : fromIdentifier;

        const resolved = resolveAssetPath(assetPath, fromId);

        // Fast path: avoid repeated string lookups / parsing cascades for the same layer
        const cached = textCache.get(resolved);
        if (cached) return cached;

        // Debug: track resolver churn (re-reading same resolved path is a strong signal of a loop)
        const n = (readHits.get(resolved) ?? 0) + 1;
        readHits.set(resolved, n);
        if (n === 1 || n === 2 || n === 5 || n === 10 || n % 25 === 0) {
          dbg('readText', { n, assetPath, fromIdentifier, fromId, resolved });
        }

        // Check if it's an external URL (http:// or https://)
        const isExternalUrl = resolved.match(/^https?:\/\//);
        if (isExternalUrl) {
          // For external URLs, use the Vite proxy endpoint to avoid CORS issues
          try {
            const proxyUrl = `/__usdjs_proxy?url=${encodeURIComponent(resolved)}`;
            const response = await fetch(proxyUrl);
            if (response.ok) {
              const contentType = response.headers.get('content-type') || '';
              // The proxy endpoint converts binary USD files to USDA text, so if we get text/plain, trust it
              // Only skip if content-type explicitly indicates binary AND it's not text/plain (proxy didn't convert)
              const isBinaryContentType = contentType.includes('application/octet-stream') && !contentType.includes('text/plain');
              if (isBinaryContentType) {
                console.warn(`Skipping external binary USD file (not supported): ${resolved}`);
                return { identifier: resolved, text: '#usda 1.0\n' };
              }

              const text = await response.text();

              // Validate that it looks like valid USDA text
              // Check for binary data (non-printable characters in first few bytes)
              const preview = text.substring(0, Math.min(100, text.length));
              const hasBinaryChars = Array.from(preview).some((ch, i) => {
                const code = ch.charCodeAt(0);
                // Allow common text characters: printable ASCII, tabs, newlines, carriage returns
                return code < 32 && code !== 9 && code !== 10 && code !== 13;
              });

              if (hasBinaryChars) {
                console.warn(`Skipping external reference (appears to be binary data): ${resolved}`);
                return { identifier: resolved, text: '#usda 1.0\n' };
              }

              // Check if this is MaterialX XML (valid format, not an error page)
              const { isMaterialXContent } = await import('@cinevva/usdjs');
              const isMaterialX = isMaterialXContent(text);

              // Check for HTML error pages (but not MaterialX XML)
              if (!isMaterialX && text.trim().startsWith('<') && text.includes('<html')) {
                console.warn(`Skipping external reference (error page instead of USD): ${resolved}`);
                return { identifier: resolved, text: '#usda 1.0\n' };
              }

              // Validate format: should be USDA or MaterialX
              if (text.trim().length > 0 && !text.trim().startsWith('#usda') && !text.trim().startsWith('#USD') && !isMaterialX) {
                console.warn(`Skipping external reference (doesn't look like USDA or MaterialX): ${resolved}`);
                return { identifier: resolved, text: '#usda 1.0\n' };
              }

              // For USDA files, check for malformed @path@ references
              if (!isMaterialX) {
                // Check for malformed @path@ references (unterminated @)
                // Count @ characters - should be even (pairs)
                const atCount = (text.match(/@/g) || []).length;
                if (atCount % 2 !== 0) {
                  console.warn(`Skipping external reference (malformed @path@ references): ${resolved}`);
                  return { identifier: resolved, text: '#usda 1.0\n' };
                }

                // Try a quick parse to catch syntax errors early
                try {
                  // Import parseUsdaToLayer dynamically to avoid circular deps
                  const { parseUsdaToLayer } = await import('@cinevva/usdjs');
                  parseUsdaToLayer(text.substring(0, Math.min(1000, text.length)), { identifier: resolved });
                } catch (parseErr: any) {
                  // If quick parse fails, the full parse will likely fail too
                  console.warn(`Skipping external reference (parse validation failed): ${resolved}`, parseErr?.message || parseErr);
                  return { identifier: resolved, text: '#usda 1.0\n' };
                }
              }

              return { identifier: resolved, text };
            }
            // If fetch succeeded but response wasn't ok, return empty file
            console.warn(`Skipping external reference (HTTP ${response.status}): ${resolved}`);
            return { identifier: resolved, text: '#usda 1.0\n' };
          } catch (err) {
            // External URL not accessible - this is common for Omniverse samples.
            // Log a warning but don't throw - the scene can still render without the referenced asset.
            console.warn(`Skipping external reference (not accessible): ${resolved}`, err);
            // Return empty USD file so composition doesn't fail
            return { identifier: resolved, text: '#usda 1.0\n' };
          }
        }

        // For local/corpus files, check our externalFiles map
        // Try exact matches for both raw and `[corpus]`-prefixed keys.
        const exact = externalFiles.get(resolved) ?? externalFiles.get(`[corpus]${resolved}`);
        if (exact) {
          const out = { identifier: resolved, text: exact.text };
          textCache.set(resolved, out);
          return out;
        }
        for (const [k, v] of externalFiles.entries()) {
          // Be tolerant of corpus prefix and varying absolute-ish identifiers.
          if (k.endsWith('/' + resolved) || k.endsWith(resolved) || k.endsWith(`/[corpus]${resolved}`) || k.endsWith(`[corpus]${resolved}`)) {
            const out = { identifier: resolved, text: v.text };
            textCache.set(resolved, out);
            return out;
          }
        }

        // Only throw errors for local files that should exist
        throw new Error(`Resolver missing: ${assetPath} (resolved=${resolved})`);
      },
    };
  }

  function resolveAssetUrl(assetPath: string, fromIdentifier?: string): string | null {
    try {
      // If it's an external URL (http:// or https://), use the proxy endpoint
      if (assetPath.match(/^https?:\/\//)) {
        return `/__usdjs_proxy?url=${encodeURIComponent(assetPath)}`;
      }
      // Use the provided identifier, or fall back to currentIdentifier
      const identifier = fromIdentifier ?? currentIdentifier;
      const resolved = resolveAssetPath(assetPath, identifier);

      // If the resolved path is an external URL (e.g., when resolving relative to an external USD file),
      // use the proxy endpoint instead of corpus endpoint
      if (resolved.match(/^https?:\/\//)) {
        return `/__usdjs_proxy?url=${encodeURIComponent(resolved)}`;
      }

      // The endpoint expects paths relative to packages/usdjs/, but resolveAssetPath returns
      // paths starting with packages/usdjs/. Strip the prefix if present.
      let relPath = resolved;
      if (resolved.startsWith('packages/usdjs/')) {
        relPath = resolved.slice('packages/usdjs/'.length);
      }

      return `/__usdjs_corpus?file=${encodeURIComponent(relPath)}`;
    } catch {
      return null;
    }
  }

  function getReferenceImageUrl(): string | null {
    // Only show reference images for corpus entries
    if (!entryKey.startsWith('[corpus]')) return null;

    // Extract the corpus path (remove [corpus] prefix)
    const corpusPath = entryKey.replace('[corpus]', '');

    // Normalize the path (handle packages/usdjs/ prefix)
    let relPath = corpusPath;
    if (relPath.startsWith('packages/usdjs/')) {
      relPath = relPath.slice('packages/usdjs/'.length);
    }

    const extensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

    // Handle ft-lab sample_usd corpus
    const FTLAB_PREFIX = 'test/corpus/external/ft-lab-sample-usd/sample_usd-main/';
    if (relPath.startsWith(FTLAB_PREFIX)) {
      const sampleRel = relPath.slice(FTLAB_PREFIX.length);
      const baseName = sampleRel.replace(/\.(usda|usd|usdc|usdz)$/i, '');
      const lastSlash = baseName.lastIndexOf('/');
      if (lastSlash === -1) return null;
      const dir = baseName.slice(0, lastSlash);
      const fileName = baseName.slice(lastSlash + 1);
      // ft-lab uses images/ subfolder
      for (const ext of extensions) {
        const refImageRel = `${FTLAB_PREFIX}${dir}/images/${fileName}${ext}`;
        return `/__usdjs_corpus?file=${encodeURIComponent(refImageRel)}`;
      }
      return null;
    }

    // Handle usd-wg/assets corpus
    const USDWG_PREFIX = 'test/corpus/external/usd-wg-assets/assets-main/';
    if (relPath.startsWith(USDWG_PREFIX)) {
      const sampleRel = relPath.slice(USDWG_PREFIX.length);
      const baseName = sampleRel.replace(/\.(usda|usd|usdc|usdz)$/i, '');
      const lastSlash = baseName.lastIndexOf('/');
      if (lastSlash === -1) return null;
      const dir = baseName.slice(0, lastSlash);
      const fileName = baseName.slice(lastSlash + 1);

      // usd-wg uses thumbnails/ and screenshots/ subfolders
      // Priority: thumbnails (cleaner), then screenshots (with _usdrecord suffix)
      // Pattern 1: dir/thumbnails/fileName.png
      // Pattern 2: dir/screenshots/fileName_usdrecord_22.08.png
      // Pattern 3: dir/screenshots/fileName.png (some don't have suffix)
      const candidates: string[] = [];

      // Try thumbnails first
      for (const ext of extensions) {
        candidates.push(`${USDWG_PREFIX}${dir}/thumbnails/${fileName}${ext}`);
      }
      // Then screenshots with usdrecord suffix
      for (const ext of extensions) {
        candidates.push(`${USDWG_PREFIX}${dir}/screenshots/${fileName}_usdrecord_22.08${ext}`);
      }
      // Then screenshots without suffix
      for (const ext of extensions) {
        candidates.push(`${USDWG_PREFIX}${dir}/screenshots/${fileName}${ext}`);
      }
      // Also try cards/ folder (used by some test assets)
      for (const ext of extensions) {
        candidates.push(`${USDWG_PREFIX}${dir}/cards/${fileName}_XPos${ext}`);
      }

      // Return first candidate - browser will handle 404 gracefully
      if (candidates.length > 0) {
        return `/__usdjs_corpus?file=${encodeURIComponent(candidates[0])}`;
      }
      return null;
    }

    return null;
  }


  function extractDependencies(layer: any): string[] {
    const out: string[] = [];
    const sub = layer.metadata?.subLayers;
    out.push(...extractAssetStrings(sub));

    const prims: any[] = [];
    const walk = (p: any) => {
      prims.push(p);
      if (p.children) {
        for (const c of p.children.values()) walk(c);
      }
      // Also walk into variantSets - they contain variant-specific prims with their own references
      if (p.variantSets) {
        for (const variantSet of p.variantSets.values()) {
          if (variantSet.variants) {
            for (const variantPrim of variantSet.variants.values()) {
              walk(variantPrim);
            }
          }
        }
      }
    };
    walk(layer.root);

    for (const p of prims) {
      if (!p.metadata) continue;
      out.push(...extractAssetStrings(p.metadata.references));
      out.push(...extractAssetStrings(p.metadata.payload));
    }
    return out.filter(Boolean);
  }

  async function fetchCorpusFile(rel: string): Promise<string> {
    const url = `/__usdjs_corpus?file=${encodeURIComponent(rel)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Corpus fetch failed (${res.status} ${res.statusText}): ${rel} - ${text}`);
    }
    return await res.text();
  }

  function ensurePost() {
    if (composer) return;
    composer = new EffectComposer(renderer);
    renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    // Minimal color-correction pass mapping RTX-ish settings approximately.
    colorPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
        uOffset: { value: new THREE.Vector3(0, 0, 0) },
        uGamma: { value: new THREE.Vector3(1, 1, 1) },
        uContrast: { value: new THREE.Vector3(1, 1, 1) },
        uSaturation: { value: new THREE.Vector3(1, 1, 1) },
      },
      vertexShader: `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
      `,
      fragmentShader: `
uniform sampler2D tDiffuse;
uniform vec3 uGain;
uniform vec3 uOffset;
uniform vec3 uGamma;
uniform vec3 uContrast;
uniform vec3 uSaturation;
varying vec2 vUv;

vec3 applySaturation(vec3 c, float sat) {
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(vec3(luma), c, sat);
}

void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;

  // offset/gain
  c = c * uGain + uOffset;

  // contrast (around 0.5)
  c = (c - 0.5) * uContrast + 0.5;

  // saturation (use average to approximate per-channel values)
  float sat = (uSaturation.x + uSaturation.y + uSaturation.z) / 3.0;
  c = applySaturation(c, sat);

  // gamma: treat uGamma as display gamma; apply pow with inverse
  vec3 g = max(uGamma, vec3(1e-6));
  c = pow(max(c, vec3(0.0)), vec3(1.0) / g);

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
      `,
    });
    composer.addPass(colorPass);
    resize();
  }

  function setColorCorrUniform(key: string, v: any) {
    if (!colorPass) return;
    if (!v || typeof v !== 'object' || v.type !== 'tuple') return;
    const [x, y, z] = v.value;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return;
    const u = (colorPass.uniforms as any)[key];
    if (u?.value?.set) u.value.set(x, y, z);
  }

  function applyRenderSettings(layer: any) {
    const customLayerData = layer.metadata?.customLayerData;
    if (!customLayerData || customLayerData.type !== 'dict') return;

    const renderSettings = customLayerData.value?.renderSettings;
    if (!renderSettings || renderSettings.type !== 'dict') return;

    const settings = renderSettings.value;
    const bgColor = settings?.['rtx:post:backgroundZeroAlpha:backgroundDefaultColor'];
    if (bgColor && bgColor.type === 'tuple') {
      const color = tupleToColor(bgColor);
      if (color) scene.background = color;
    }

    const ambientColor = settings?.['rtx:sceneDb:ambientLightColor'];
    if (ambientColor && ambientColor.type === 'tuple') {
      const color = tupleToColor(ambientColor);
      if (color) hemisphereLight.color.copy(color);
    }

    const fogColor = settings?.['rtx:fog:fogColor'];
    if (fogColor && fogColor.type === 'tuple') {
      const color = tupleToColor(fogColor);
      if (color) {
        fog = new THREE.Fog(color, 50, 1000);
        scene.fog = fog;
      }
    } else {
      if (fog) {
        scene.fog = null;
        fog = null;
      }
    }

    // Approximate some RTX post color correction settings via an optional post pass.
    // If these keys exist, enable composer; otherwise keep fast direct renderer path.
    const hasColorCorr =
      settings?.['rtx:post:colorcorr:gain'] ||
      settings?.['rtx:post:colorcorr:offset'] ||
      settings?.['rtx:post:colorcorr:gamma'] ||
      settings?.['rtx:post:colorcorr:contrast'] ||
      settings?.['rtx:post:colorcorr:saturation'];

    if (hasColorCorr) {
      ensurePost();
      useComposer = true;
      setColorCorrUniform('uGain', settings?.['rtx:post:colorcorr:gain']);
      setColorCorrUniform('uOffset', settings?.['rtx:post:colorcorr:offset']);
      setColorCorrUniform('uGamma', settings?.['rtx:post:colorcorr:gamma']);
      setColorCorrUniform('uContrast', settings?.['rtx:post:colorcorr:contrast']);
      setColorCorrUniform('uSaturation', settings?.['rtx:post:colorcorr:saturation']);
    } else {
      useComposer = false;
    }
  }

  // Default camera position and target
  const DEFAULT_CAMERA_POSITION = { x: 80, y: 60, z: 120 };
  const DEFAULT_CAMERA_TARGET = { x: 0, y: 15, z: 0 };

  function resetCameraToDefault() {
    camera.position.set(DEFAULT_CAMERA_POSITION.x, DEFAULT_CAMERA_POSITION.y, DEFAULT_CAMERA_POSITION.z);
    controls.target.set(DEFAULT_CAMERA_TARGET.x, DEFAULT_CAMERA_TARGET.y, DEFAULT_CAMERA_TARGET.z);
    controls.update();
  }

  /**
   * Frame the camera to fit the content in view.
   * Computes the bounding box of all visible geometry and positions the camera to see it all.
   */
  function frameToFit() {
    // Ensure all transforms are up to date
    scene.updateMatrixWorld(true);

    const box = new THREE.Box3();

    // Compute bounding box of all geometry in contentRoot
    contentRoot.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.SkinnedMesh ||
        obj instanceof THREE.Points || obj instanceof THREE.Line ||
        obj instanceof THREE.LineSegments) {
        const geometry = obj.geometry;
        if (geometry) {
          geometry.computeBoundingBox();
          if (geometry.boundingBox) {
            const meshBox = geometry.boundingBox.clone();
            meshBox.applyMatrix4(obj.matrixWorld);
            box.union(meshBox);
          }
        }
      }
    });

    // If no valid bounding box, skip framing
    if (box.isEmpty()) {
      console.warn('[frameToFit] No geometry found to frame');
      return;
    }

    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim <= 0 || !Number.isFinite(maxDim)) {
      console.warn('[frameToFit] Invalid bounding box size:', size);
      return;
    }

    // Position camera to fit the content with some margin
    // Use the FOV to calculate proper distance
    const fov = camera.fov * (Math.PI / 180);
    const distance = (maxDim / 2) / Math.tan(fov / 2) * 1.5; // 1.5x for some margin

    // Position camera at an angle (similar to default view angle)
    const cameraOffset = new THREE.Vector3(0.5, 0.4, 0.75).normalize().multiplyScalar(distance);
    camera.position.copy(center).add(cameraOffset);
    controls.target.copy(center);

    // Update near/far planes based on content size
    camera.near = Math.max(0.001, distance * 0.001);
    camera.far = Math.max(10000, distance * 100);
    camera.updateProjectionMatrix();

    controls.update();

    console.log(`[frameToFit] Framed to center=(${center.x.toFixed(4)}, ${center.y.toFixed(4)}, ${center.z.toFixed(4)}), size=(${size.x.toFixed(4)}, ${size.y.toFixed(4)}, ${size.z.toFixed(4)}), distance=${distance.toFixed(4)}`);
  }

  /**
   * Apply camera settings from USD layer metadata.
   * @returns true if authored camera settings were found and applied, false otherwise
   */
  function applyCameraSettings(layer: any): boolean {
    const customLayerData = layer?.metadata?.customLayerData;
    const cameraSettings =
      customLayerData?.type === 'dict' ? customLayerData.value?.cameraSettings : undefined;

    // If no camera settings, return false (caller should use frameToFit)
    if (!cameraSettings || cameraSettings.type !== 'dict') {
      return false;
    }

    const perspective = cameraSettings.value?.Perspective;
    if (perspective && perspective.type === 'dict') {
      const pos = perspective.value?.position;
      const target = perspective.value?.target;
      let hasPos = false;
      let hasTarget = false;
      if (pos && pos.type === 'tuple' && pos.value.length >= 3) {
        const [x, y, z] = pos.value;
        if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
          camera.position.set(x * stageUnitScale, y * stageUnitScale, z * stageUnitScale);
          hasPos = true;
        }
      }
      if (target && target.type === 'tuple' && target.value.length >= 3) {
        const [x, y, z] = target.value;
        if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
          controls.target.set(x * stageUnitScale, y * stageUnitScale, z * stageUnitScale);
          hasTarget = true;
        }
      }
      controls.update();
      return hasPos || hasTarget;
    } else {
      // Perspective section missing
      return false;
    }
  }

  function getEntryOptions(): Array<{ label: string; value: string }> {
    const optsOut: Array<{ label: string; value: string }> = [{ label: '<textarea>', value: '<textarea>' }];
    for (const key of Array.from(externalFiles.keys()).sort()) {
      const label = key.startsWith('[corpus]') ? key.replace('[corpus]', '').split('/').pop() ?? key : key;
      optsOut.push({ label, value: key });
    }
    return optsOut;
  }

  function getEntryText(key: string): string | null {
    if (key === '<textarea>') return textareaText;
    const f = externalFiles.get(key);
    return f?.text ?? null;
  }

  async function loadLocalFiles(files: FileList) {
    for (const f of Array.from(files)) {
      const key = (f as any).webkitRelativePath ? (f as any).webkitRelativePath : f.name;
      const text = await f.text();
      externalFiles.set(key, { name: f.name, text });
    }
  }

  function loadTextFiles(files: Array<{ path: string; text: string }>) {
    for (const f of files) {
      const key = f.path;
      const name = key.split('/').pop() ?? key;
      externalFiles.set(key, { name, text: f.text });
    }
  }

  async function loadCorpusEntry(rel: string) {
    // Normalize path for fetching (strip packages/usdjs/ if present)
    const fetchRel = normalizeCorpusPathForFetch(rel);
    const fetched = await fetchCorpusFile(fetchRel);
    // Use the full path for the corpus key and hash
    const fullPath = normalizeCorpusPathForHash(rel);
    const corpusKey = `[corpus]${fullPath}`;
    externalFiles.set(corpusKey, { name: fullPath.split('/').pop() ?? fullPath, text: fetched });
    entryKey = corpusKey;
    textareaText = fetched;

    setCorpusHash(fullPath);
    writeLastState({ entryKey: corpusKey, corpusRel: fullPath, compose, selectedPath });

    // Prefetch dependencies for composition.
    const queue: Array<{ identifier: string; text: string }> = [{ identifier: rel, text: fetched }];
    const seen = new Set<string>([rel]);

    // Import MaterialX detection function
    const { isMaterialXContent } = await import('@cinevva/usdjs');

    while (queue.length) {
      const cur = queue.shift()!;
      try {
        // Skip dependency extraction for MaterialX files (they don't have USD-style references)
        if (isMaterialXContent(cur.text)) {
          continue;
        }
        const stage = UsdStage.openUSDA(cur.text, cur.identifier);
        const layer = stage.rootLayer;
        const deps = extractDependencies(layer);
        for (const dep of deps) {
          const resolved = resolveAssetPath(dep, cur.identifier);
          if (seen.has(resolved)) continue;
          // Check for both prefixed and non-prefixed paths since identifiers may vary
          const isCorpusExternal = resolved.startsWith('test/corpus/external/') ||
            resolved.startsWith(`${CORPUS_PATH_PREFIX}test/corpus/external/`);
          if (!isCorpusExternal) continue;
          try {
            // Normalize the path for fetching (server expects paths without packages/usdjs/ prefix)
            const fetchPath = normalizeCorpusPathForFetch(resolved);
            const text = await fetchCorpusFile(fetchPath);
            const fullPath = normalizeCorpusPathForHash(resolved);
            const depKey = `[corpus]${fullPath}`;
            externalFiles.set(depKey, { name: fullPath.split('/').pop() ?? fullPath, text });
            seen.add(resolved);
            queue.push({ identifier: resolved, text });
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }
  }

  async function run() {
    try {
      // Prevent accidental re-entrancy (e.g. UI events firing while a heavy compose is still running).
      // Without this, big corpus scenes can look like an "infinite loop" because we keep starting over.
      if ((run as any)._running) {
        (run as any)._rerun = true;
        dbg('run re-entered -> coalescing rerun');
        return;
      }
      (run as any)._running = true;
      const tRun0 = performance.now();
      dbg('run start', { entryKey, compose, selectedPath });
      opts.onStatus('Parsing…');
      const resolver = makeResolver();

      const entryText = entryKey === '<textarea>' ? textareaText : externalFiles.get(entryKey)?.text ?? textareaText;
      const entryId = entryKey === '<textarea>' ? '<viewer>' : entryKey;

      let stage: UsdStage;
      try {
        const t0 = performance.now();
        stage =
          entryKey === '<textarea>'
            ? UsdStage.openUSDA(entryText, entryId)
            : await UsdStage.openUSDAWithResolver(entryText, resolver, entryId);
        dbg('stage open ok', { ms: +(performance.now() - t0).toFixed(1), entryId });
      } catch (err) {
        // If composition fails due to invalid external references, log and continue
        // This allows the scene to render even if some external assets are invalid
        console.warn('USD composition failed (some external references may be invalid):', err);
        // Fall back to non-composed stage
        stage = UsdStage.openUSDA(entryText, entryId);
      }

      // Use the entry layer identifier for relative asset resolution (textures, etc.).
      // Note: in the viewer UI, corpus files are keyed as `[corpus]...`; strip that prefix so
      // resolveAssetPath works against real corpus-relative paths.
      currentIdentifier = stage.rootLayer.identifier.startsWith('[corpus]')
        ? stage.rootLayer.identifier.replace('[corpus]', '')
        : stage.rootLayer.identifier;

      let rootLayerToRender: any;
      if (compose) {
        const t0 = performance.now();
        opts.onStatus('Composing…');
        dbg('compose start');
        rootLayerToRender = await stage.composePrimIndexWithResolver(resolver);
        dbg('compose done', { ms: +(performance.now() - t0).toFixed(1) });
      } else {
        rootLayerToRender = stage.rootLayer;
      }

      // Important: some composition paths may return a "composed" layer that doesn't carry the
      // original root layer's metadata/customLayerData. Camera/render settings are typically authored
      // on the root layer, so prefer stage.rootLayer for settings, and fall back to composed layer.
      const layerForSettings = stage.rootLayer?.metadata?.customLayerData ? stage.rootLayer : rootLayerToRender;

      // USD stage unit scale (metersPerUnit). If authored in centimeters (0.01), we scale authored
      // translations/points/camera settings so Three's physically-based lighting behaves as expected.
      const mpu = layerForSettings?.metadata?.metersPerUnit;
      stageUnitScale = typeof mpu === 'number' && Number.isFinite(mpu) && mpu > 0 ? mpu : 1.0;

      resetEnvironmentAndBackgroundForNewSample();
      const hasAuthoredCamera = applyCameraSettings(layerForSettings);
      applyRenderSettings(layerForSettings);

      const tree = buildTree(rootLayerToRender.root);
      opts.onTree([toPrimeTree(tree)], selectedPath);

      clearThreeRoot();
      dynamicHelperUpdates.length = 0;
      const hasUsdLightsRef = { value: false };
      const hasUsdDomeLightRef = { value: false };
      const helpers = new Map<string, THREE.Object3D>();

      // Keep helper gizmos under an identity root so helper.update() (which uses world transforms)
      // doesn't get double-transformed by the USD Xform containers.
      const debugRoot = new THREE.Object3D();
      contentRoot.add(debugRoot);

      renderPrim(
        contentRoot,
        debugRoot,
        tree,
        selectedPath,
        helpers,
        rootLayerToRender.root,
        scene,
        hasUsdLightsRef,
        hasUsdDomeLightRef,
        resolveAssetUrl,
        stageUnitScale,
        dynamicHelperUpdates,
        skeletonsToUpdate,
        { setFromDomeLight: setDomeEnvironmentFromUrl },
        currentIdentifier,
        animatedObjects,
      );

      // Detect animation time range from stage metadata or animated objects
      const stageStartTime = layerForSettings?.metadata?.startTimeCode;
      const stageEndTime = layerForSettings?.metadata?.endTimeCode;
      const stageFps = layerForSettings?.metadata?.timeCodesPerSecond ?? layerForSettings?.metadata?.framesPerSecond;

      // Prefer authored stage range when it is meaningful (non-degenerate).
      // Some real-world samples (including usd-wg-assets teapotScene) author start=end=1 while still having
      // real animated timeSamples in referenced layers; in that case we should derive the range from animation data.
      const hasStageRange = typeof stageStartTime === 'number' && typeof stageEndTime === 'number';
      const stageRangeIsMeaningful = hasStageRange && stageEndTime > stageStartTime;

      if (stageRangeIsMeaningful) {
        animationStartTime = stageStartTime as number;
        animationEndTime = stageEndTime as number;
      } else if (animatedObjects.length > 0) {
        // Scan animated objects for time range
        let minTime = Infinity;
        let maxTime = -Infinity;
        for (const a of animatedObjects) {
          const range = getPrimAnimationTimeRange(a.prim);
          if (range) {
            minTime = Math.min(minTime, range.start);
            maxTime = Math.max(maxTime, range.end);
          }
        }
        if (minTime < Infinity && maxTime > -Infinity) {
          animationStartTime = minTime;
          animationEndTime = maxTime;
        }
      } else if (hasStageRange) {
        // Fallback: use authored stage range even if degenerate (some files are intentionally single-frame).
        animationStartTime = stageStartTime as number;
        animationEndTime = stageEndTime as number;
      }

      if (typeof stageFps === 'number' && stageFps > 0) {
        animationFps = stageFps;
      }

      // Reset animation to start
      animationCurrentTime = animationStartTime;

      dbg('animation detected', {
        animatedObjects: animatedObjects.length,
        start: animationStartTime,
        end: animationEndTime,
        fps: animationFps,
      });

      if (hasUsdLightsRef.value) {
        // Authored lights present: disable viewer defaults (including IBL) to avoid double-lighting.
        hemisphereLight.visible = false;
        defaultDir.visible = false;
        // Keep authored DomeLight environment; otherwise disable IBL to avoid double-lighting.
        if (!hasUsdDomeLightRef.value) scene.environment = null;
      } else {
        // No authored lights: enable viewer defaults.
        // Keep intensities low since RoomEnvironment IBL provides ambient fill.
        // Very low environment intensity (0.15) minimizes reflections on rough surfaces
        // while still enabling visible clearcoat/specular effects for smoother materials.
        hemisphereLight.visible = true;
        defaultDir.visible = true;
        hemisphereLight.intensity = 0.3;
        defaultDir.intensity = 0.6;
        scene.environment = defaultEnvTex;
        scene.environmentIntensity = 0.15;
      }

      const primCount = compose ? listPrimCount(rootLayerToRender.root) : stage.listPrimPaths().length;
      opts.onStatus(`OK: prims=${primCount}`);
      dbg('run ok', { ms: +(performance.now() - tRun0).toFixed(1), primCount });

      // If no authored camera settings, auto-frame to fit content
      if (!hasAuthoredCamera) {
        // Use setTimeout to ensure all geometry is fully added to the scene
        setTimeout(() => {
          frameToFit();
        }, 0);
      }

      const isCorpus = entryKey.startsWith('[corpus]');
      writeLastState({
        entryKey,
        textarea: entryKey === '<textarea>' ? textareaText : undefined,
        corpusRel: isCorpus ? entryKey.replace('[corpus]', '') : undefined,
        compose,
        selectedPath,
      });
      setCorpusHash(isCorpus ? entryKey.replace('[corpus]', '') : null);
    } catch (e) {
      opts.onStatus(String((e as any)?.message ?? e));
      console.error(e);
    } finally {
      (run as any)._running = false;
      if ((run as any)._rerun) {
        (run as any)._rerun = false;
        // Fire-and-forget: if multiple triggers arrived while running, we coalesce into one rerun.
        dbg('run rerun firing');
        void run();
      }
    }
  }

  async function restoreLastOpened(): Promise<boolean> {
    const hashCorpusRel = readCorpusHash();
    if (hashCorpusRel) {
      try {
        // loadCorpusEntry handles both formats (with or without packages/usdjs/ prefix)
        await loadCorpusEntry(hashCorpusRel);
        return true;
      } catch {
        // fall through
      }
    }

    const st = readLastState();
    if (!st) return false;

    if (typeof st.compose === 'boolean') compose = st.compose;
    if (typeof st.selectedPath === 'string' || st.selectedPath === null) selectedPath = st.selectedPath ?? null;

    if (st.corpusRel && typeof st.corpusRel === 'string') {
      try {
        await loadCorpusEntry(st.corpusRel);
        return true;
      } catch {
        // fall through
      }
    }

    if (st.entryKey === '<textarea>' && typeof st.textarea === 'string') {
      entryKey = '<textarea>';
      textareaText = st.textarea;
      return true;
    }

    return false;
  }

  function dispose() {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    controls.dispose();
    envRt.dispose();
    pmremGen.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    getDefaultUsda: () => DEFAULT_USDA,
    getEntryKey: () => entryKey,
    getCompose: () => compose,
    getEntryOptions,
    getEntryText,
    getReferenceImageUrl,
    setTextarea: (t) => (textareaText = t),
    setEntryKey: (k) => (entryKey = k),
    setCompose: (v) => (compose = v),
    setSelectedPath: async (p) => {
      selectedPath = p;
    },
    loadLocalFiles,
    loadTextFiles,
    loadCorpusEntry,
    restoreLastOpened,
    run,
    dispose,

    // Animation controls
    getAnimationState: () => ({
      playing: animationPlaying,
      currentTime: animationCurrentTime,
      startTime: animationStartTime,
      endTime: animationEndTime,
      framesPerSecond: animationFps,
    }),
    setAnimationTime: (time: number) => {
      animationCurrentTime = Math.max(animationStartTime, Math.min(animationEndTime, time));
      // Update all animated objects immediately
      for (const a of animatedObjects) {
        if (a.kind === 'xform') {
          applyXformOps(a.obj, a.prim, animationCurrentTime);
          if (a.unitScale !== 1.0) {
            a.obj.position.multiplyScalar(a.unitScale);
          }
        } else if (a.kind === 'points') {
          const pts = parsePoint3ArrayToFloat32(getPrimPropAtTime(a.prim, 'points', animationCurrentTime));
          if (!pts) continue;
          if (a.unitScale !== 1.0) {
            for (let i = 0; i < pts.length; i++) pts[i] = pts[i]! * a.unitScale;
          }
          for (const g of a.geoms) {
            const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
            if (!pos || !pos.array || pos.itemSize !== 3) continue;
            if (pos.array.length !== pts.length) continue;
            (pos.array as any).set(pts as any);
            pos.needsUpdate = true;
          }
        }
      }
    },
    setAnimationPlaying: (playing: boolean) => {
      animationPlaying = playing;
      if (playing) {
        lastAnimationFrameTime = 0; // Reset timing for smooth playback
      }
    },
    hasAnimation: () => animatedObjects.length > 0,
  };
}


