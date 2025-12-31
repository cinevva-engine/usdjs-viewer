import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';

import { UsdStage, type SdfPrimSpec, type SdfValue, resolveAssetPath } from '@cinevva/usdjs';

import type { AnimatedObject, PrimeTreeNode, SceneNode, ThreeDebugInfo, ViewerCore } from './types';
import { DEFAULT_USDA, EMPTY_USDA } from './constants';
import { getPrimAnimationTimeRange, getPrimProp, getPrimPropAtTime, primHasAnimatedPoints, propHasAnimation, sdfToNumberTuple } from './usdAnim';
import { findNearestSkelRootPrim, findPrimByPath } from './usdPaths';
import { buildJointOrderIndexToBoneIndex, extractJointOrderNames } from './usdSkeleton';
import { buildTree, toPrimeTree } from './usdTree';
import { extractAssetStrings, getPropMetadataNumber, getPropMetadataString, parseNumberArray, parsePoint3ArrayToFloat32, parseTuple3ArrayToFloat32 } from './usdParse';
import { applyXformOps, parseMatrix4dArray, primHasAnimatedXform } from './threeXform';
import { buildUsdMeshGeometry, computePointsBounds, computeSmoothNormalsDeindexed, flipGeometryWinding } from './threeGeom';
import { createMaterialFromShader, extractShaderInputs, resolveMaterialBinding, resolveShaderFromMaterial } from './materials';
import { renderPrim } from './renderPrim';
import { createTextResolver } from './resolver';
import { createGetReferenceImageUrl, createResolveAssetUrl } from './assetUrls';
import { extractDependencies, fetchCorpusFile } from './corpus';
import { createCorpusHashHelpers } from './corpusHash';
import { applyCameraSettings as applyCameraSettingsExternal, frameToFit as frameToFitExternal } from './camera';
import { applyRenderSettings as applyRenderSettingsExternal, ensurePost as ensurePostExternal } from './postprocessing';
import { advanceAnimationPlayback, applyAnimatedObjectsAtTime } from './animationPlayback';
import { getThreeDebugInfo as getThreeDebugInfoExternal } from './threeDebug';
import { getGpuResourcesInfo as getGpuResourcesInfoExternal } from './gpuResources';
import { buildThreeSceneTree, findObjectByUuid, getObjectProperties, setObjectProperty, EDITABLE_PROPERTIES, parseMaterialKey, findMaterialByKey, getMaterialProperties, setMaterialProperty, parseTextureKey, findTextureByKey, getTextureProperties, setTextureProperty } from './threeSceneTree';
import { createDomeEnvironmentController } from './domeEnvironment';
import { loadCorpusEntryExternal } from './corpusEntry';
import { createRunPipeline } from './runPipeline';

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

function createAxisLabelSprite(opts: { text: string; color: string }): THREE.Sprite {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    const mat = new THREE.SpriteMaterial({ color: 0xffffff });
    const sprite = new THREE.Sprite(mat);
    sprite.center.set(0.5, 0.5);
    sprite.scale.setScalar(0.2);
    return sprite;
  }

  ctx.clearRect(0, 0, size, size);
  ctx.font = 'bold 84px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 12;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.strokeText(opts.text, size / 2, size / 2);
  ctx.fillStyle = opts.color;
  ctx.fillText(opts.text, size / 2, size / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.center.set(0.5, 0.5);
  // Base scale; will be adjusted dynamically each frame.
  sprite.scale.setScalar(0.2);
  return sprite;
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

  // Perf instrumentation (always-on, very low overhead).
  // Produces `performance.measure()` entries visible in Chrome DevTools Performance panel, e.g.:
  // - usdjs:run#12:stageOpen
  // - usdjs:run#12:compose
  // - usdjs:run#12:buildTree
  // - usdjs:run#12:renderPrim
  // - usdjs:run#12:frameToFit
  let runSeq = 0;
  const perfMark = (name: string) => {
    try {
      performance.mark(name);
    } catch {
      // ignore
    }
  };
  const perfMeasure = (name: string, startMark: string, endMark: string) => {
    try {
      performance.measure(name, startMark, endMark);
    } catch {
      // ignore
    }
  };

  const HASH_PREFIX_CORPUS = '#corpus=';
  const CORPUS_PATH_PREFIX = 'packages/usdjs/';
  const { normalizeCorpusPathForHash, normalizeCorpusPathForFetch, setCorpusHash, readCorpusHash } =
    createCorpusHashHelpers({ corpusPathPrefix: CORPUS_PATH_PREFIX, hashPrefixCorpus: HASH_PREFIX_CORPUS });

  const externalFiles = new Map<string, { name: string; text: string; binary?: ArrayBuffer }>();
  let textareaText = DEFAULT_USDA;
  let entryKey = '<textarea>';
  let compose = true;
  let selectedPath: string | null = null;
  let currentIdentifier = '<viewer>';
  let stageUnitScale = 1.0; // metersPerUnit (defaults to 1m per unit)

  const resolveAssetUrl = createResolveAssetUrl({ getCurrentIdentifier: () => currentIdentifier });
  const getReferenceImageUrl = createGetReferenceImageUrl({ getEntryKey: () => entryKey });

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
  const composerRef: { value: EffectComposer | null } = { value: null };
  const renderPassRef: { value: RenderPass | null } = { value: null };
  const colorPassRef: { value: ShaderPass | null } = { value: null };
  const useComposerRef: { value: boolean } = { value: false };

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f0f1a);

  // Default IBL environment (keeps background solid, but enables reflections for PBR / clearcoat).
  // This makes texture-driven clearcoat effects visible (e.g. UsdPreviewSurface_clearcoat_with_texture.usda).
  // Use default sigma (0.04) for environment map blur.
  const pmremGen = new THREE.PMREMGenerator(renderer);
  const envRt = pmremGen.fromScene(new RoomEnvironment(), 0.04);
  const defaultEnvTex = envRt.texture;
  scene.environment = null;
  const domeEnv = createDomeEnvironmentController({ scene, pmremGen });

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1_000_000);
  camera.position.set(80, 60, 120);
  let controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 15, 0);
  controls.update();

  function recreateOrbitControls(): void {
    // OrbitControls computes an internal basis quaternion in the constructor:
    //   _quat = setFromUnitVectors(object.up, (0,1,0))
    // If we change camera.up after construction (e.g. for Z-up stages), orbit/pan become incorrect.
    // Recreate controls after updating camera.up so the internal basis is recomputed correctly.
    const old = controls;
    const oldTarget = old.target.clone();
    const oldEnabled = old.enabled;
    const oldEnableDamping = old.enableDamping;
    const oldDampingFactor = old.dampingFactor;
    const oldRotateSpeed = old.rotateSpeed;
    const oldZoomSpeed = old.zoomSpeed;
    const oldPanSpeed = old.panSpeed;
    const oldScreenSpacePanning = old.screenSpacePanning;
    const oldKeyPanSpeed = (old as any).keyPanSpeed;
    const oldMinDistance = old.minDistance;
    const oldMaxDistance = old.maxDistance;
    const oldMinPolarAngle = old.minPolarAngle;
    const oldMaxPolarAngle = old.maxPolarAngle;
    const oldMinAzimuthAngle = old.minAzimuthAngle;
    const oldMaxAzimuthAngle = old.maxAzimuthAngle;

    old.dispose();

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enabled = oldEnabled;
    controls.enableDamping = oldEnableDamping;
    controls.dampingFactor = oldDampingFactor;
    controls.rotateSpeed = oldRotateSpeed;
    controls.zoomSpeed = oldZoomSpeed;
    controls.panSpeed = oldPanSpeed;
    controls.screenSpacePanning = oldScreenSpacePanning;
    if (typeof oldKeyPanSpeed === 'number') (controls as any).keyPanSpeed = oldKeyPanSpeed;
    controls.minDistance = oldMinDistance;
    controls.maxDistance = oldMaxDistance;
    controls.minPolarAngle = oldMinPolarAngle;
    controls.maxPolarAngle = oldMaxPolarAngle;
    controls.minAzimuthAngle = oldMinAzimuthAngle;
    controls.maxAzimuthAngle = oldMaxAzimuthAngle;

    controls.target.copy(oldTarget);
    controls.update();
  }

  // Grid helper: render after content, enable z-test but disable z-write
  const gridHelper = new THREE.GridHelper(200, 20, 0x333333, 0x222222);
  gridHelper.name = 'GridHelper';
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
  axesHelper.name = 'AxesHelper';
  // Always keep axes at world origin (do not follow orbit target).
  axesHelper.position.set(0, 0, 0);
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

  // Axis labels (X/Y/Z) - small sprites at the ends of the axes.
  // Keep these readable regardless of model overlap by disabling depthTest.
  const axisLen = 20;
  const labelOffset = 1.5;
  const xLabel = createAxisLabelSprite({ text: 'X', color: '#ff4d4d' });
  const yLabel = createAxisLabelSprite({ text: 'Y', color: '#4dff4d' });
  const zLabel = createAxisLabelSprite({ text: 'Z', color: '#4d7dff' });
  xLabel.name = 'AxisLabelX';
  yLabel.name = 'AxisLabelY';
  zLabel.name = 'AxisLabelZ';
  xLabel.position.set(axisLen + labelOffset, 0, 0);
  yLabel.position.set(0, axisLen + labelOffset, 0);
  zLabel.position.set(0, 0, axisLen + labelOffset);
  xLabel.renderOrder = 3;
  yLabel.renderOrder = 3;
  zLabel.renderOrder = 3;
  // Add labels as children of axesHelper so they follow when axesHelper moves
  axesHelper.add(xLabel, yLabel, zLabel);
  const axisLabelSprites: Array<{ sprite: THREE.Sprite; dir: THREE.Vector3 }> = [
    { sprite: xLabel, dir: new THREE.Vector3(1, 0, 0) },
    { sprite: yLabel, dir: new THREE.Vector3(0, 1, 0) },
    { sprite: zLabel, dir: new THREE.Vector3(0, 0, 1) },
  ];

  // Default lights: kept low since RoomEnvironment IBL provides ambient fill.
  // These add subtle directionality without over-lighting the scene.
  const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x222222, 0.2);
  scene.add(hemisphereLight);
  const defaultDir = new THREE.DirectionalLight(0xffffff, 0.4);
  defaultDir.position.set(100, 200, 100);
  scene.add(defaultDir);

  const fogRef: { value: THREE.Fog | null } = { value: null };

  const contentRoot = new THREE.Object3D();
  scene.add(contentRoot);

  // Stage configuration
  // Three.js defaults to Y-up, but USD stages can be authored Y-up or Z-up (and sometimes X-up).
  // We keep geometry in authored coordinates and adapt camera controls + helpers (grid) to the stage's up axis.
  let stageUpAxis: 'X' | 'Y' | 'Z' = 'Y';
  function setStageUpAxis(axis: string) {
    const a = (typeof axis === 'string' ? axis.toUpperCase() : '') as string;
    const nextAxis: 'X' | 'Y' | 'Z' = (a === 'X' || a === 'Y' || a === 'Z' ? (a as any) : 'Y');

    // IMPORTANT: OrbitControls can support arbitrary up vectors, but if we only change `camera.up`
    // we can end up with a "rolled" camera (especially when switching Y-up <-> Z-up). That roll
    // makes orbit/pan feel broken. So we rotate the camera *around the current target* to align
    // the old up direction to the new one while preserving view direction.
    const oldUp = camera.up.clone().normalize();
    const newUp =
      nextAxis === 'X'
        ? new THREE.Vector3(1, 0, 0)
        : nextAxis === 'Z'
          ? new THREE.Vector3(0, 0, 1)
          : new THREE.Vector3(0, 1, 0);

    // Only do the expensive reorientation when the up direction actually changes.
    if (oldUp.distanceTo(newUp) > 1e-6) {
      const q = new THREE.Quaternion().setFromUnitVectors(oldUp, newUp);
      const target = controls.target.clone();
      const offset = camera.position.clone().sub(target);
      offset.applyQuaternion(q);
      camera.up.copy(newUp);
      camera.position.copy(target).add(offset);
      camera.lookAt(target);
    } else {
      camera.up.copy(newUp);
    }

    stageUpAxis = nextAxis;

    // Critical: OrbitControls caches a basis quaternion derived from object.up at construction time.
    // After changing camera.up, we must recreate controls so orbit/pan behave correctly in Z-up/X-up worlds.
    recreateOrbitControls();

    // Grid helper plane: Three's GridHelper is XZ by default (normal +Y).
    // For Z-up stages, show XY "ground". For X-up stages, show YZ "ground".
    gridHelper.rotation.set(0, 0, 0);
    if (stageUpAxis === 'Z') gridHelper.rotation.x = Math.PI / 2;
    else if (stageUpAxis === 'X') gridHelper.rotation.z = -Math.PI / 2;

    // Ensure OrbitControls recomputes internal state after up changes.
    controls.update();
  }

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
    composerRef.value?.setSize(w, h);
  }
  const onResize = () => resize();
  window.addEventListener('resize', onResize);
  resize();

  let raf = 0;
  function renderLoop(timestamp: number) {
    controls.update();
    // Axes helper is pinned to world origin (0,0,0).

    // Keep axis label sprites at a consistent on-screen size (in pixels).
    // Labels are children of axesHelper, so positions are in local coordinates.
    if (axisLabelSprites.length) {
      const viewportH = Math.max(1, renderer.domElement.clientHeight || opts.viewportEl.clientHeight || 1);
      const fovRad = THREE.MathUtils.degToRad(camera.fov);
      const desiredPx = 20; // 2x bigger

      for (const { sprite, dir } of axisLabelSprites) {
        const tMax = axisLen + labelOffset;
        // Position in local coordinates (relative to axesHelper)
        sprite.position.set(dir.x * tMax, dir.y * tMax, dir.z * tMax);

        // Keep constant on-screen size: compute world scale from pixel size + camera FOV + distance.
        // Get world position for distance calculation
        const worldPos = new THREE.Vector3();
        sprite.getWorldPosition(worldPos);
        const distToCam = camera.position.distanceTo(worldPos);
        const worldHeightAtDist = 2 * distToCam * Math.tan(fovRad * 0.5);
        const worldSize = (desiredPx * worldHeightAtDist) / viewportH;
        sprite.scale.setScalar(worldSize);
      }
    }

    ({ animationCurrentTime, lastAnimationFrameTime } = advanceAnimationPlayback({
      timestamp,
      animationPlaying,
      animationCurrentTime,
      animationStartTime,
      animationEndTime,
      animationFps,
      lastAnimationFrameTime,
      animatedObjects,
    }));

    // Use dirty checking instead of forcing full update every frame
    // Three.js automatically marks objects dirty when position/quaternion/scale change,
    // and controls.update() marks the camera dirty, so this is safe and much faster
    scene.updateMatrixWorld(false);
    // Update all skeletons for SkinnedMesh - this must happen every frame
    // First update the bone hierarchy, then update the skeleton matrices
    for (const { skeleton, boneRoot } of skeletonsToUpdate) {
      // Bone roots are already updated by scene.updateMatrixWorld above if they're dirty
      // Using false here avoids redundant updates while still ensuring bones are current
      boneRoot.updateMatrixWorld(false);
      // Update skeleton's bone matrices for skinning
      skeleton.update();
    }
    for (const fn of dynamicHelperUpdates) fn();
    if (useComposerRef.value && composerRef.value) composerRef.value.render();
    else renderer.render(scene, camera);
    raf = requestAnimationFrame(renderLoop);
  }
  raf = requestAnimationFrame(renderLoop);

  function clearThreeRoot() {
    while (contentRoot.children.length) contentRoot.remove(contentRoot.children[0]!);
    skeletonsToUpdate.length = 0; // Clear skeletons list when clearing scene
    animatedObjects.length = 0; // Clear animated objects list when clearing scene
  }



  const ensurePost = () =>
    ensurePostExternal({
      composerRef,
      renderPassRef,
      colorPassRef,
      renderer,
      scene,
      camera,
      resize,
    });

  const applyRenderSettings = (layer: any) =>
    applyRenderSettingsExternal({
      layer,
      scene,
      hemisphereLight,
      tupleToColor,
      fogRef,
      useComposerRef,
      composerRef,
      renderPassRef,
      colorPassRef,
      renderer,
      camera,
      resize,
    });

  // Default camera position and target
  // These are expressed in "viewer coordinates", so we adapt them to the stage up axis.
  const DEFAULT_CAMERA_DISTANCE = { x: 80, up: 60, depth: 120 };
  const DEFAULT_CAMERA_TARGET_UP = 15;

  function getDefaultCameraPoseForUpAxis(axis: 'X' | 'Y' | 'Z') {
    // Keep the same "feel" as the Y-up default: (x=80, up=60, depth=120).
    // We treat "depth" as the axis that isn't X or Up.
    if (axis === 'Z') {
      // Up is Z, depth is Y
      return {
        pos: { x: DEFAULT_CAMERA_DISTANCE.x, y: DEFAULT_CAMERA_DISTANCE.depth, z: DEFAULT_CAMERA_DISTANCE.up },
        target: { x: 0, y: 0, z: DEFAULT_CAMERA_TARGET_UP },
      };
    }
    if (axis === 'X') {
      // Up is X, depth is Z
      return {
        pos: { x: DEFAULT_CAMERA_DISTANCE.up, y: DEFAULT_CAMERA_DISTANCE.x, z: DEFAULT_CAMERA_DISTANCE.depth },
        target: { x: DEFAULT_CAMERA_TARGET_UP, y: 0, z: 0 },
      };
    }
    // Y-up
    return {
      pos: { x: DEFAULT_CAMERA_DISTANCE.x, y: DEFAULT_CAMERA_DISTANCE.up, z: DEFAULT_CAMERA_DISTANCE.depth },
      target: { x: 0, y: DEFAULT_CAMERA_TARGET_UP, z: 0 },
    };
  }

  function resetCameraToDefault() {
    const p = getDefaultCameraPoseForUpAxis(stageUpAxis);
    camera.position.set(p.pos.x, p.pos.y, p.pos.z);
    controls.target.set(p.target.x, p.target.y, p.target.z);
    controls.update();
  }

  const frameToFit = () => frameToFitExternal({ scene, contentRoot, camera, controls, upAxis: stageUpAxis });

  const applyCameraSettings = (layer: any): boolean =>
    applyCameraSettingsExternal({ layer, camera, controls, stageUnitScale });

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
    await loadCorpusEntryExternal({
      rel,
      CORPUS_PATH_PREFIX,
      normalizeCorpusPathForFetch,
      normalizeCorpusPathForHash,
      fetchCorpusFile,
      extractDependencies,
      externalFiles,
      setEntryKey: (k) => (entryKey = k),
      setTextareaText: (t) => (textareaText = t),
      setCorpusHash,
      dbg,
    });
  }

  const runSeqRef: { value: number } = { value: 0 };

  // Store the USD scene tree for prim property lookups
  let lastSceneTree: SceneNode | null = null;

  // Map from prim path to Three.js object(s)
  const primToObjectMap = new Map<string, THREE.Object3D[]>();

  // Helper to find a prim by path in the scene tree
  function findSceneNodeByPath(path: string): SceneNode | null {
    if (!lastSceneTree) return null;

    function search(node: SceneNode): SceneNode | null {
      if (node.path === path) return node;
      for (const child of node.children) {
        const found = search(child);
        if (found) return found;
      }
      return null;
    }

    return search(lastSceneTree);
  }

  // Build prim→object mapping by traversing the Three.js scene
  // Only map the container (transform node) for each prim, not child meshes/lights
  function buildPrimToObjectMap() {
    primToObjectMap.clear();
    let count = 0;
    contentRoot.traverse((obj) => {
      if (obj.name && obj.name.startsWith('/')) {
        const path = obj.name;
        // Skip if parent has the same name - this is a child mesh/light, not the container
        // The container is the Object3D that holds the transform, child objects shouldn't be transformed directly
        if (obj.parent && obj.parent.name === path) {
          return; // Skip child objects that share the prim path name
        }
        const existing = primToObjectMap.get(path);
        if (existing) {
          existing.push(obj);
        } else {
          primToObjectMap.set(path, [obj]);
        }
        count++;
      }
    });
    dbg('[buildPrimToObjectMap] Built map with', primToObjectMap.size, 'prim paths,', count, 'total objects');
  }

  // Find Three.js objects for a prim path
  function findObjectsForPrim(path: string): THREE.Object3D[] {
    return primToObjectMap.get(path) ?? [];
  }

  // Set a USD prim property and update the Three.js object(s) incrementally
  function setPrimPropertyIncremental(path: string, propName: string, value: any): boolean {
    dbg('[setPrimProperty] path:', path, 'propName:', propName, 'value:', value);
    const node = findSceneNodeByPath(path);
    if (!node) {
      dbg('[setPrimProperty] Node not found for path:', path);
      return false;
    }

    const prim = node.prim;
    const objects = findObjectsForPrim(path);
    dbg('[setPrimProperty] Found', objects.length, 'objects for path:', path);

    // Helper to ensure prim.properties exists
    const ensureProperties = () => {
      if (!prim.properties) (prim as any).properties = new Map();
      return prim.properties!;
    };

    // Handle transform properties
    if (propName === 'xformOp:translate' || propName === 'translate') {
      // Update the prim property
      const props = ensureProperties();
      const prop = props.get('xformOp:translate');
      if (prop) {
        prop.defaultValue = { type: 'tuple', value: [value.x, value.y, value.z] };
      } else {
        props.set('xformOp:translate', {
          defaultValue: { type: 'tuple', value: [value.x, value.y, value.z] },
        } as any);
      }

      // Update Three.js objects
      for (const obj of objects) {
        obj.position.set(value.x * stageUnitScale, value.y * stageUnitScale, value.z * stageUnitScale);
      }
      return true;
    }

    if (propName === 'xformOp:rotateXYZ' || propName === 'rotation') {
      // Update the prim property (stored in degrees)
      const props = ensureProperties();
      const prop = props.get('xformOp:rotateXYZ');
      if (prop) {
        prop.defaultValue = { type: 'tuple', value: [value.x, value.y, value.z] };
      } else {
        props.set('xformOp:rotateXYZ', {
          defaultValue: { type: 'tuple', value: [value.x, value.y, value.z] },
        } as any);
      }

      // Update Three.js objects (convert degrees to radians)
      const rx = THREE.MathUtils.degToRad(value.x);
      const ry = THREE.MathUtils.degToRad(value.y);
      const rz = THREE.MathUtils.degToRad(value.z);
      for (const obj of objects) {
        obj.rotation.set(rx, ry, rz, 'XYZ');
      }
      return true;
    }

    if (propName === 'xformOp:scale' || propName === 'scale') {
      // Update the prim property
      const props = ensureProperties();
      const prop = props.get('xformOp:scale');
      if (prop) {
        prop.defaultValue = { type: 'tuple', value: [value.x, value.y, value.z] };
      } else {
        props.set('xformOp:scale', {
          defaultValue: { type: 'tuple', value: [value.x, value.y, value.z] },
        } as any);
      }

      // Update Three.js objects
      for (const obj of objects) {
        obj.scale.set(value.x, value.y, value.z);
      }
      return true;
    }

    // Handle visibility property
    if (propName === 'visibility') {
      const props = ensureProperties();
      const prop = props.get('visibility');
      if (prop) {
        prop.defaultValue = { type: 'token', value };
      } else {
        props.set('visibility', {
          defaultValue: { type: 'token', value },
        } as any);
      }

      // Update Three.js objects
      const isVisible = value !== 'invisible';
      for (const obj of objects) {
        obj.visible = isVisible;
      }
      return true;
    }

    // Handle light intensity
    if (propName === 'intensity') {
      const props = ensureProperties();
      const prop = props.get('intensity');
      if (prop) {
        prop.defaultValue = value;
      } else {
        props.set('intensity', { defaultValue: value } as any);
      }

      // Update Three.js light objects
      for (const obj of objects) {
        // Find any lights under this container
        obj.traverse((child) => {
          if ((child as any).isLight) {
            const light = child as THREE.Light;
            // USD intensity needs conversion based on light type
            const typeName = node.typeName;
            if (typeName === 'DistantLight') {
              light.intensity = value / 1000;
            } else if (typeName === 'SphereLight' || typeName === 'RectAreaLight') {
              // Approximate conversion for point/spot/area lights
              const exposureProp = prim.properties?.get('exposure')?.defaultValue;
              const exposureVal = typeof exposureProp === 'number' ? exposureProp : 0;
              const intensityBase = value * Math.pow(2, exposureVal);
              light.intensity = intensityBase / 8000;
            } else {
              light.intensity = value / 1000;
            }
          }
        });
      }
      return true;
    }

    // Handle light color
    if (propName === 'color') {
      const props = ensureProperties();
      const prop = props.get('color');
      if (prop) {
        prop.defaultValue = { type: 'tuple', value: [value.r, value.g, value.b] };
      } else {
        props.set('color', {
          defaultValue: { type: 'tuple', value: [value.r, value.g, value.b] },
        } as any);
      }

      // Update Three.js light objects
      for (const obj of objects) {
        obj.traverse((child) => {
          if ((child as any).isLight) {
            const light = child as THREE.Light;
            light.color.setRGB(value.r, value.g, value.b);
          }
        });
      }
      return true;
    }

    // Handle light angle (for DistantLight/SpotLight)
    if (propName === 'angle') {
      const props = ensureProperties();
      const prop = props.get('angle');
      if (prop) {
        prop.defaultValue = value;
      } else {
        props.set('angle', { defaultValue: value } as any);
      }

      // Update Three.js spot light angle
      for (const obj of objects) {
        obj.traverse((child) => {
          if ((child as any).isSpotLight) {
            const spot = child as THREE.SpotLight;
            spot.angle = THREE.MathUtils.degToRad(value);
          }
        });
      }
      return true;
    }

    // Handle sphere light radius
    if (propName === 'radius') {
      const props = ensureProperties();
      const prop = props.get('radius');
      if (prop) {
        prop.defaultValue = value;
      } else {
        props.set('radius', { defaultValue: value } as any);
      }
      // Note: radius affects intensity calculation in Three.js point lights
      // A full re-render would be needed to properly apply this
      return true;
    }

    // Handle RectAreaLight width/height
    if (propName === 'width' || propName === 'height') {
      const props = ensureProperties();
      const prop = props.get(propName);
      if (prop) {
        prop.defaultValue = value;
      } else {
        props.set(propName, { defaultValue: value } as any);
      }

      for (const obj of objects) {
        obj.traverse((child) => {
          if ((child as any).isRectAreaLight) {
            const rect = child as THREE.RectAreaLight;
            if (propName === 'width') rect.width = value * stageUnitScale;
            if (propName === 'height') rect.height = value * stageUnitScale;
          }
        });
      }
      return true;
    }

    // Handle mesh doubleSided
    if (propName === 'doubleSided') {
      const props = ensureProperties();
      const prop = props.get('doubleSided');
      if (prop) {
        prop.defaultValue = value;
      } else {
        props.set('doubleSided', { defaultValue: value } as any);
      }

      // Update material side on mesh objects
      for (const obj of objects) {
        obj.traverse((child) => {
          if ((child as any).isMesh) {
            const mesh = child as THREE.Mesh;
            if (mesh.material) {
              const mat = mesh.material as THREE.Material;
              mat.side = value ? THREE.DoubleSide : THREE.FrontSide;
              mat.needsUpdate = true;
            }
          }
        });
      }
      return true;
    }

    // Handle light exposure
    if (propName === 'exposure') {
      const props = ensureProperties();
      const prop = props.get('exposure');
      if (prop) {
        prop.defaultValue = value;
      } else {
        props.set('exposure', { defaultValue: value } as any);
      }

      // Recalculate intensity with new exposure
      const intensityProp = prim.properties?.get('intensity')?.defaultValue;
      const baseIntensity = typeof intensityProp === 'number' ? intensityProp : 1.0;
      const newIntensity = baseIntensity * Math.pow(2, value);

      for (const obj of objects) {
        obj.traverse((child) => {
          if ((child as any).isLight) {
            const light = child as THREE.Light;
            const typeName = node.typeName;
            if (typeName === 'DistantLight') {
              light.intensity = newIntensity / 1000;
            } else {
              light.intensity = newIntensity / 8000;
            }
          }
        });
      }
      return true;
    }

    // Handle spotlight shaping cone angle
    if (propName === 'shaping:cone:angle') {
      const props = ensureProperties();
      const prop = props.get('shaping:cone:angle');
      if (prop) {
        prop.defaultValue = value;
      } else {
        props.set('shaping:cone:angle', { defaultValue: value } as any);
      }

      for (const obj of objects) {
        obj.traverse((child) => {
          if ((child as any).isSpotLight) {
            const spot = child as THREE.SpotLight;
            // USD cone angle is half-angle in degrees
            spot.angle = THREE.MathUtils.degToRad(value);
          }
        });
      }
      return true;
    }

    // Handle spotlight shaping cone softness (penumbra)
    if (propName === 'shaping:cone:softness') {
      const props = ensureProperties();
      const prop = props.get('shaping:cone:softness');
      if (prop) {
        prop.defaultValue = value;
      } else {
        props.set('shaping:cone:softness', { defaultValue: value } as any);
      }

      for (const obj of objects) {
        obj.traverse((child) => {
          if ((child as any).isSpotLight) {
            const spot = child as THREE.SpotLight;
            // USD softness 0-1 maps to Three.js penumbra 0-1
            spot.penumbra = THREE.MathUtils.clamp(value, 0, 1);
          }
        });
      }
      return true;
    }

    // Handle basic primitive geometry properties (requires geometry recreation)
    // Helper to recreate geometry for basic primitives
    const recreatePrimitiveGeometry = (typeName: string) => {
      const props = prim.properties ?? new Map();
      const getNum = (name: string, def: number) => {
        const p = props.get(name)?.defaultValue;
        if (typeof p === 'number') return p;
        // Handle wrapped numeric types
        if (p && typeof p === 'object' && 'value' in p && typeof p.value === 'number') {
          return p.value;
        }
        return def;
      };
      const getAxis = (name: string) => {
        const p = props.get(name)?.defaultValue;
        if (typeof p === 'string') return p;
        if (p && typeof p === 'object' && 'type' in p && p.type === 'token') return p.value as string;
        return 'Y';
      };

      let newGeom: THREE.BufferGeometry | null = null;
      let axisRotation: THREE.Euler | null = null;

      if (typeName === 'Sphere') {
        const r = getNum('radius', 1) * stageUnitScale;
        newGeom = new THREE.SphereGeometry(r, 24, 16);
      } else if (typeName === 'Cube') {
        const s = getNum('size', 2) * stageUnitScale;
        newGeom = new THREE.BoxGeometry(s, s, s);
      } else if (typeName === 'Cylinder') {
        const r = getNum('radius', 1) * stageUnitScale;
        const h = getNum('height', 2) * stageUnitScale;
        const axis = getAxis('axis');
        newGeom = new THREE.CylinderGeometry(r, r, h, 24, 1);
        if (axis === 'X') axisRotation = new THREE.Euler(0, 0, -Math.PI / 2);
        else if (axis === 'Z') axisRotation = new THREE.Euler(Math.PI / 2, 0, 0);
      } else if (typeName === 'Cone') {
        const r = getNum('radius', 1) * stageUnitScale;
        const h = getNum('height', 2) * stageUnitScale;
        const axis = getAxis('axis');
        newGeom = new THREE.ConeGeometry(r, h, 24, 1);
        if (axis === 'X') axisRotation = new THREE.Euler(0, 0, -Math.PI / 2);
        else if (axis === 'Z') axisRotation = new THREE.Euler(Math.PI / 2, 0, 0);
      } else if (typeName === 'Capsule') {
        const r = getNum('radius', 0.5) * stageUnitScale;
        const h = getNum('height', 1) * stageUnitScale;
        const axis = getAxis('axis');
        newGeom = new THREE.CapsuleGeometry(r, h, 8, 16);
        if (axis === 'X') axisRotation = new THREE.Euler(0, 0, -Math.PI / 2);
        else if (axis === 'Z') axisRotation = new THREE.Euler(Math.PI / 2, 0, 0);
      }

      if (newGeom) {
        for (const obj of objects) {
          obj.traverse((child) => {
            if ((child as any).isMesh) {
              const mesh = child as THREE.Mesh;
              mesh.geometry.dispose();
              mesh.geometry = newGeom!;
              if (axisRotation) {
                mesh.rotation.copy(axisRotation);
              } else {
                mesh.rotation.set(0, 0, 0);
              }
            }
          });
        }
        return true;
      }
      return false;
    };

    // Sphere radius
    if (propName === 'radius' && (node.typeName === 'Sphere' || node.typeName === 'Cylinder' || node.typeName === 'Cone' || node.typeName === 'Capsule')) {
      const props = ensureProperties();
      props.set('radius', { defaultValue: value } as any);
      return recreatePrimitiveGeometry(node.typeName!);
    }

    // Cube size
    if (propName === 'size' && node.typeName === 'Cube') {
      const props = ensureProperties();
      props.set('size', { defaultValue: value } as any);
      return recreatePrimitiveGeometry('Cube');
    }

    // Cylinder/Cone/Capsule height
    if (propName === 'height' && (node.typeName === 'Cylinder' || node.typeName === 'Cone' || node.typeName === 'Capsule')) {
      const props = ensureProperties();
      props.set('height', { defaultValue: value } as any);
      return recreatePrimitiveGeometry(node.typeName!);
    }

    // Axis for Cylinder/Cone/Capsule
    if (propName === 'axis' && (node.typeName === 'Cylinder' || node.typeName === 'Cone' || node.typeName === 'Capsule')) {
      const props = ensureProperties();
      props.set('axis', { type: 'token', value } as any);
      return recreatePrimitiveGeometry(node.typeName!);
    }

    return false;
  }

  const { run } = createRunPipeline({
    dbg,
    perfMark,
    perfMeasure,
    onStatus: opts.onStatus,
    onTree: opts.onTree,
    onSceneTree: (tree) => {
      lastSceneTree = tree;
      // Build prim→object mapping after scene is rendered
      buildPrimToObjectMap();
    },
    externalFiles,
    getEntryKey: () => entryKey,
    getTextareaText: () => textareaText,
    getCompose: () => compose,
    getSelectedPath: () => selectedPath,
    setCurrentIdentifier: (id) => (currentIdentifier = id),
    getCurrentIdentifier: () => currentIdentifier,
    setStageUnitScale: (s) => (stageUnitScale = s),
    getStageUnitScale: () => stageUnitScale,
    setStageUpAxis,
    domeEnvResetForNewSample: () => domeEnv.resetForNewSample(),
    applyCameraSettings,
    applyRenderSettings,
    clearThreeRoot,
    contentRoot,
    scene,
    resolveAssetUrl,
    renderPrim,
    dynamicHelperUpdates,
    skeletonsToUpdate,
    animatedObjects,
    domeEnvSetFromDomeLight: domeEnv.setFromDomeLight,
    defaultEnvTex,
    hemisphereLight,
    defaultDir,
    frameToFit,
    listPrimCount,
    setCorpusHash,
    runSeqRef,
    getAnimationStartTime: () => animationStartTime,
    getAnimationEndTime: () => animationEndTime,
    getAnimationFps: () => animationFps,
    setAnimationStartTime: (t) => (animationStartTime = t),
    setAnimationEndTime: (t) => (animationEndTime = t),
    setAnimationFps: (fps) => (animationFps = fps),
    setAnimationCurrentTime: (t) => (animationCurrentTime = t),
  });

  // `run` is provided by runPipeline (see above)

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
    return false;
  }

  function dispose() {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    controls.dispose();
    envRt.dispose();
    domeEnv.dispose();
    pmremGen.dispose();
    renderer.dispose();
    renderer.domElement.remove();

    // Dispose axis label sprites (CanvasTexture + SpriteMaterial)
    for (const { sprite: spr } of axisLabelSprites) {
      axesHelper.remove(spr);
      const mat = spr.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.dispose();
    }
  }

  return {
    getDefaultUsda: () => DEFAULT_USDA,
    getEmptyUsda: () => EMPTY_USDA,
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
      applyAnimatedObjectsAtTime({ animatedObjects, time: animationCurrentTime });
    },
    setAnimationPlaying: (playing: boolean) => {
      animationPlaying = playing;
      if (playing) {
        lastAnimationFrameTime = 0; // Reset timing for smooth playback
      }
    },
    hasAnimation: () => animatedObjects.length > 0,

    getThreeDebugInfo: () => {
      return getThreeDebugInfoExternal({ contentRoot, renderer, scene, camera, controls });
    },

    getGpuResourcesInfo: () => {
      return getGpuResourcesInfoExternal({ renderer, scene });
    },

    getThreeSceneTree: () => {
      return buildThreeSceneTree(scene);
    },

    findThreeObjectByUuid: (uuid: string) => {
      return findObjectByUuid(scene, uuid);
    },

    getThreeObjectProperties: (uuid: string) => {
      const obj = findObjectByUuid(scene, uuid);
      if (!obj) return null;
      return getObjectProperties(obj);
    },

    setThreeObjectProperty: (uuid: string, path: string, value: any) => {
      const obj = findObjectByUuid(scene, uuid);
      if (!obj) return false;
      return setObjectProperty(obj, path, value);
    },

    isPropertyEditable: (path: string) => {
      return path in EDITABLE_PROPERTIES;
    },

    // Material support
    isMaterialKey: (key: string) => {
      return parseMaterialKey(key) !== null;
    },

    getMaterialProperties: (key: string) => {
      const mat = findMaterialByKey(scene, key);
      if (!mat) return null;
      return getMaterialProperties(mat);
    },

    setMaterialProperty: (key: string, path: string, value: any) => {
      const mat = findMaterialByKey(scene, key);
      if (!mat) return false;
      return setMaterialProperty(mat, path, value);
    },

    // Texture support
    isTextureKey: (key: string) => {
      return parseTextureKey(key) !== null;
    },

    getTextureProperties: (key: string) => {
      const tex = findTextureByKey(scene, key);
      if (!tex) return null;
      return getTextureProperties(tex);
    },

    setTextureProperty: (key: string, path: string, value: any) => {
      const tex = findTextureByKey(scene, key);
      if (!tex) return false;
      return setTextureProperty(tex, path, value);
    },

    raycastAtNDC: (ndcX: number, ndcY: number): string | null => {
      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2(ndcX, ndcY);
      raycaster.setFromCamera(pointer, camera);

      // Only raycast against contentRoot children (the actual scene content, not helpers/grid/axes)
      const intersects = raycaster.intersectObjects(contentRoot.children, true);

      if (intersects.length > 0) {
        // Return the first hit object's UUID
        return intersects[0]!.object.uuid;
      }
      return null;
    },

    getAncestorUuids: (uuid: string): string[] => {
      const obj = findObjectByUuid(scene, uuid);
      if (!obj) return [];

      const ancestors: string[] = [];
      let current = obj.parent;
      while (current) {
        ancestors.unshift(current.uuid); // Add to front to maintain root-to-parent order
        current = current.parent;
      }
      return ancestors;
    },

    getPrimProperties: (path: string): Record<string, any> | null => {
      const node = findSceneNodeByPath(path);
      if (!node) return null;

      const prim = node.prim;
      const result: Record<string, any> = {
        path: node.path,
        typeName: node.typeName ?? '(none)',
      };

      // Extract transform values (for editable properties)
      const extractVec3 = (propName: string): { x: number; y: number; z: number } | null => {
        const prop = prim.properties?.get(propName);
        const dv = prop?.defaultValue;
        if (dv && typeof dv === 'object' && 'type' in dv && dv.type === 'tuple' && Array.isArray(dv.value) && dv.value.length >= 3) {
          const [x, y, z] = dv.value;
          if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
            return { x, y, z };
          }
        }
        return null;
      };

      // Add raw transform values for editing
      const translate = extractVec3('xformOp:translate');
      const rotate = extractVec3('xformOp:rotateXYZ');
      const scale = extractVec3('xformOp:scale');

      if (translate) result['_translate'] = translate;
      if (rotate) result['_rotate'] = rotate;
      if (scale) result['_scale'] = scale;

      // Extract scalar values
      // Note: USD values may be raw numbers or wrapped in { type: 'double'|'float', value: ... }
      const extractNumber = (propName: string): number | null => {
        const prop = prim.properties?.get(propName);
        const dv = prop?.defaultValue;
        if (typeof dv === 'number') return dv;
        // Handle wrapped numeric types (double, float, int, etc.)
        if (dv && typeof dv === 'object' && 'value' in dv && typeof dv.value === 'number') {
          return dv.value;
        }
        return null;
      };

      // Extract color (RGB tuple)
      const extractColor = (propName: string): { r: number; g: number; b: number } | null => {
        const prop = prim.properties?.get(propName);
        const dv = prop?.defaultValue;
        if (dv && typeof dv === 'object' && 'type' in dv && dv.type === 'tuple' && Array.isArray(dv.value) && dv.value.length >= 3) {
          const [r, g, b] = dv.value;
          if (typeof r === 'number' && typeof g === 'number' && typeof b === 'number') {
            return { r, g, b };
          }
        }
        return null;
      };

      // Extract visibility (token)
      const visibilityProp = prim.properties?.get('visibility');
      if (visibilityProp?.defaultValue) {
        const v = visibilityProp.defaultValue;
        if (typeof v === 'string') {
          result['_visibility'] = v;
        } else if (typeof v === 'object' && 'type' in v && v.type === 'token') {
          result['_visibility'] = v.value;
        }
      }

      // Extract axis token
      const extractAxis = (propName: string): string | null => {
        const prop = prim.properties?.get(propName);
        const dv = prop?.defaultValue;
        if (typeof dv === 'string') return dv;
        if (dv && typeof dv === 'object' && 'type' in dv && dv.type === 'token') {
          return dv.value as string;
        }
        return null;
      };

      // Light-specific editable properties
      const typeName = node.typeName;
      if (typeName === 'DistantLight' || typeName === 'SphereLight' || typeName === 'RectLight' || typeName === 'RectAreaLight' || typeName === 'DomeLight') {
        const intensity = extractNumber('intensity');
        if (intensity !== null) result['_intensity'] = intensity;

        const exposure = extractNumber('exposure');
        if (exposure !== null) result['_exposure'] = exposure;

        const color = extractColor('color');
        if (color) result['_color'] = color;

        if (typeName === 'DistantLight') {
          const angle = extractNumber('angle');
          if (angle !== null) result['_angle'] = angle;
        }

        if (typeName === 'SphereLight') {
          const radius = extractNumber('radius');
          if (radius !== null) result['_radius'] = radius;
          // Spotlight shaping properties
          const coneAngle = extractNumber('shaping:cone:angle');
          if (coneAngle !== null) result['_shapingConeAngle'] = coneAngle;
          const coneSoftness = extractNumber('shaping:cone:softness');
          if (coneSoftness !== null) result['_shapingConeSoftness'] = coneSoftness;
        }

        if (typeName === 'RectLight' || typeName === 'RectAreaLight') {
          const width = extractNumber('width');
          const height = extractNumber('height');
          if (width !== null) result['_width'] = width;
          if (height !== null) result['_height'] = height;
        }
      }

      // Basic primitive properties (Sphere, Cube, Cylinder, Cone, Capsule)
      if (typeName === 'Sphere') {
        const radius = extractNumber('radius');
        result['_radius'] = radius ?? 1; // USD default is 1
      }

      if (typeName === 'Cube') {
        const size = extractNumber('size');
        result['_size'] = size ?? 2; // USD default is 2
      }

      if (typeName === 'Cylinder') {
        const radius = extractNumber('radius');
        const height = extractNumber('height');
        const axis = extractAxis('axis');
        result['_radius'] = radius ?? 1;
        result['_height'] = height ?? 2;
        result['_axis'] = axis ?? 'Y';
      }

      if (typeName === 'Cone') {
        const radius = extractNumber('radius');
        const height = extractNumber('height');
        const axis = extractAxis('axis');
        result['_radius'] = radius ?? 1;
        result['_height'] = height ?? 2;
        result['_axis'] = axis ?? 'Y';
      }

      if (typeName === 'Capsule') {
        const radius = extractNumber('radius');
        const height = extractNumber('height');
        const axis = extractAxis('axis');
        result['_radius'] = radius ?? 0.5;
        result['_height'] = height ?? 1;
        result['_axis'] = axis ?? 'Y';
      }

      // Mesh-specific editable properties
      if (typeName === 'Mesh') {
        const doubleSidedProp = prim.properties?.get('doubleSided');
        if (doubleSidedProp?.defaultValue !== undefined) {
          result['_doubleSided'] = !!doubleSidedProp.defaultValue;
        }
      }

      // Add prim metadata
      if (prim.metadata) {
        for (const [key, value] of Object.entries(prim.metadata)) {
          result[`metadata:${key}`] = value;
        }
      }

      // Add properties
      if (prim.properties) {
        for (const [name, prop] of prim.properties.entries()) {
          // Format the value for display
          let displayValue = prop.defaultValue;
          if (displayValue !== undefined) {
            if (typeof displayValue === 'object' && displayValue !== null) {
              if ('type' in displayValue && 'value' in displayValue) {
                // Handle typed values like { type: 'tuple', value: [1, 2, 3] }
                const v = displayValue.value;
                if (Array.isArray(v)) {
                  displayValue = `(${v.join(', ')})`;
                } else {
                  displayValue = String(v);
                }
              } else if (Array.isArray(displayValue)) {
                displayValue = `[${displayValue.length} items]`;
              } else {
                displayValue = JSON.stringify(displayValue);
              }
            }
          }
          result[name] = displayValue;

          // If property has time samples, indicate it
          if (prop.timeSamples && prop.timeSamples.size > 0) {
            result[`${name} (animated)`] = `${prop.timeSamples.size} keyframes`;
          }
        }
      }

      return result;
    },

    setPrimProperty: (path: string, propName: string, value: any): boolean => {
      return setPrimPropertyIncremental(path, propName, value);
    },
  };
}


