import * as THREE from 'three';
import { UsdStage } from '@cinevva/usdjs';

import type { AnimatedObject, PrimeTreeNode, SceneNode } from './types';
import { getPrimAnimationTimeRange } from './usdAnim';
import { buildTree, toPrimeTree } from './usdTree';
import { createTextResolver } from './resolver';

export function createRunPipeline(opts: {
  dbg: (...args: any[]) => void;
  perfMark: (name: string) => void;
  perfMeasure: (name: string, startMark: string, endMark: string) => void;
  onStatus: (msg: string) => void;
  onTree: (nodes: PrimeTreeNode[], selectedPath: string | null) => void;

  externalFiles: Map<string, { name: string; text: string; binary?: ArrayBuffer }>;
  getEntryKey: () => string;
  getTextareaText: () => string;
  getCompose: () => boolean;
  getSelectedPath: () => string | null;

  setCurrentIdentifier: (id: string) => void;
  getCurrentIdentifier: () => string;
  setStageUnitScale: (s: number) => void;
  getStageUnitScale: () => number;

  domeEnvResetForNewSample: () => void;
  applyCameraSettings: (layer: any) => boolean;
  applyRenderSettings: (layer: any) => void;
  clearThreeRoot: () => void;

  contentRoot: THREE.Object3D;
  scene: THREE.Scene;
  resolveAssetUrl?: (assetPath: string, fromIdentifier?: string) => string | null;
  renderPrim: (
    objParent: THREE.Object3D,
    helpersParent: THREE.Object3D,
    node: SceneNode,
    selectionPath: string | null,
    helpers: Map<string, THREE.Object3D>,
    rootPrim: any,
    sceneRef: THREE.Scene,
    hasUsdLightsRef: { value: boolean },
    hasUsdDomeLightRef: { value: boolean },
    resolveAssetUrl?: (assetPath: string, fromIdentifier?: string) => string | null,
    unitScale?: number,
    dynamicHelperUpdates?: Array<() => void>,
    skeletonsToUpdate?: Array<{ skeleton: THREE.Skeleton; boneRoot: THREE.Object3D }>,
    domeEnv?: { setFromDomeLight: (opts: any) => void },
    currentIdentifier?: string,
    animatedObjects?: AnimatedObject[],
  ) => void;

  dynamicHelperUpdates: Array<() => void>;
  skeletonsToUpdate: Array<{ skeleton: THREE.Skeleton; boneRoot: THREE.Object3D }>;
  animatedObjects: AnimatedObject[];
  domeEnvSetFromDomeLight: (opts: any) => void;

  defaultEnvTex: THREE.Texture;
  hemisphereLight: THREE.HemisphereLight;
  defaultDir: THREE.DirectionalLight;

  frameToFit: () => void;
  listPrimCount: (root: any) => number;
  setCorpusHash: (rel: string | null) => void;

  runSeqRef: { value: number };

  // animation setters (mutate outer state)
  getAnimationStartTime: () => number;
  getAnimationEndTime: () => number;
  getAnimationFps: () => number;
  setAnimationStartTime: (t: number) => void;
  setAnimationEndTime: (t: number) => void;
  setAnimationFps: (fps: number) => void;
  setAnimationCurrentTime: (t: number) => void;
}) {
  const {
    dbg,
    perfMark,
    perfMeasure,
    onStatus,
    onTree,
    externalFiles,
    getEntryKey,
    getTextareaText,
    getCompose,
    getSelectedPath,
    setCurrentIdentifier,
    getCurrentIdentifier,
    setStageUnitScale,
    getStageUnitScale,
    domeEnvResetForNewSample,
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
    domeEnvSetFromDomeLight,
    defaultEnvTex,
    hemisphereLight,
    defaultDir,
    frameToFit,
    listPrimCount,
    setCorpusHash,
    runSeqRef,
    getAnimationStartTime,
    getAnimationEndTime,
    getAnimationFps,
    setAnimationStartTime,
    setAnimationEndTime,
    setAnimationFps,
    setAnimationCurrentTime,
  } = opts;

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
      const runId = ++runSeqRef.value;
      const perf = (phase: string) => `usdjs:run#${runId}:${phase}`;
      dbg('run start', { entryKey: getEntryKey(), compose: getCompose(), selectedPath: getSelectedPath() });
      perfMark(perf('start'));
      onStatus('Parsing…');
      const resolver = createTextResolver({ externalFiles, dbg });

      const entryKey = getEntryKey();
      const textareaText = getTextareaText();
      const entryFile = entryKey === '<textarea>'
        ? { text: textareaText, binary: undefined }
        : externalFiles.get(entryKey) ?? { text: textareaText, binary: undefined };
      const entryId = entryKey === '<textarea>' ? '<viewer>' : entryKey;

      let stage: UsdStage;
      try {
        const t0 = performance.now();
        perfMark(perf('stageOpen:start'));

        // Check if entry file is binary (USDC/USDZ)
        if (entryFile.binary) {
          // Native binary loading - parse directly without conversion
          const data = new Uint8Array(entryFile.binary);
          const { isUsdzContent } = await import('@cinevva/usdjs');

          if (isUsdzContent(data)) {
            // USDZ file - use async parser
            stage = await UsdStage.openUSDZ(data, entryId);
          } else {
            // USDC file - use sync parser
            stage = UsdStage.open(data, entryId);
          }
        } else {
          // Text file (USDA) - use existing text-based loading
          const entryText = entryFile.text ?? textareaText;
          stage =
            entryKey === '<textarea>'
              ? UsdStage.openUSDA(entryText, entryId)
              : await UsdStage.openUSDAWithResolver(entryText, resolver, entryId);
        }

        perfMark(perf('stageOpen:end'));
        perfMeasure(perf('stageOpen'), perf('stageOpen:start'), perf('stageOpen:end'));
        dbg('stage open ok', { ms: +(performance.now() - t0).toFixed(1), entryId, isBinary: !!entryFile.binary });
      } catch (err) {
        // If composition fails due to invalid external references, log and continue
        // This allows the scene to render even if some external assets are invalid
        console.warn('USD composition failed (some external references may be invalid):', err);
        // Fall back to non-composed stage
        if (entryFile.binary) {
          const data = new Uint8Array(entryFile.binary);
          const { isUsdzContent } = await import('@cinevva/usdjs');
          if (isUsdzContent(data)) {
            stage = await UsdStage.openUSDZ(data, entryId);
          } else {
            stage = UsdStage.open(data, entryId);
          }
        } else {
          const entryText = entryFile.text ?? textareaText;
          stage = UsdStage.openUSDA(entryText, entryId);
        }
      }

      // Use the entry layer identifier for relative asset resolution (textures, etc.).
      // Note: in the viewer UI, corpus files are keyed as `[corpus]...`; strip that prefix so
      // resolveAssetPath works against real corpus-relative paths.
      setCurrentIdentifier(
        stage.rootLayer.identifier.startsWith('[corpus]')
          ? stage.rootLayer.identifier.replace('[corpus]', '')
          : stage.rootLayer.identifier,
      );

      let rootLayerToRender: any;
      if (getCompose()) {
        const t0 = performance.now();
        onStatus('Composing…');
        dbg('compose start');
        perfMark(perf('compose:start'));
        rootLayerToRender = await stage.composePrimIndexWithResolver(resolver);
        perfMark(perf('compose:end'));
        perfMeasure(perf('compose'), perf('compose:start'), perf('compose:end'));
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
      setStageUnitScale(typeof mpu === 'number' && Number.isFinite(mpu) && mpu > 0 ? mpu : 1.0);

      domeEnvResetForNewSample();
      const hasAuthoredCamera = applyCameraSettings(layerForSettings);
      applyRenderSettings(layerForSettings);

      perfMark(perf('buildTree:start'));
      const tree = buildTree(rootLayerToRender.root);
      perfMark(perf('buildTree:end'));
      perfMeasure(perf('buildTree'), perf('buildTree:start'), perf('buildTree:end'));
      onTree([toPrimeTree(tree)], getSelectedPath());

      clearThreeRoot();
      dynamicHelperUpdates.length = 0;
      const hasUsdLightsRef = { value: false };
      const hasUsdDomeLightRef = { value: false };
      const helpers = new Map<string, THREE.Object3D>();

      // Keep helper gizmos under an identity root so helper.update() (which uses world transforms)
      // doesn't get double-transformed by the USD Xform containers.
      const debugRoot = new THREE.Object3D();
      contentRoot.add(debugRoot);

      perfMark(perf('renderPrim:start'));
      renderPrim(
        contentRoot,
        debugRoot,
        tree,
        getSelectedPath(),
        helpers,
        rootLayerToRender.root,
        scene,
        hasUsdLightsRef,
        hasUsdDomeLightRef,
        resolveAssetUrl,
        getStageUnitScale(),
        dynamicHelperUpdates,
        skeletonsToUpdate,
        { setFromDomeLight: domeEnvSetFromDomeLight },
        getCurrentIdentifier(),
        animatedObjects,
      );
      perfMark(perf('renderPrim:end'));
      perfMeasure(perf('renderPrim'), perf('renderPrim:start'), perf('renderPrim:end'));

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
        setAnimationStartTime(stageStartTime as number);
        setAnimationEndTime(stageEndTime as number);
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
          setAnimationStartTime(minTime);
          setAnimationEndTime(maxTime);
        }
      } else if (hasStageRange) {
        // Fallback: use authored stage range even if degenerate (some files are intentionally single-frame).
        setAnimationStartTime(stageStartTime as number);
        setAnimationEndTime(stageEndTime as number);
      }

      if (typeof stageFps === 'number' && stageFps > 0) {
        setAnimationFps(stageFps);
      }

      // Reset animation to start
      setAnimationCurrentTime(getAnimationStartTime());

      dbg('animation detected', {
        animatedObjects: animatedObjects.length,
        start: getAnimationStartTime(),
        end: getAnimationEndTime(),
        fps: getAnimationFps(),
      });

      if (hasUsdLightsRef.value) {
        // Authored lights present: disable viewer defaults to respect scene author's lighting design.
        hemisphereLight.visible = false;
        defaultDir.visible = false;
        // If a DomeLight successfully loaded its texture, keep the environment for IBL.
        // Otherwise, clear the environment to avoid any unintended ambient lighting.
        if (!hasUsdDomeLightRef.value) {
          scene.environment = null;
        }
      } else {
        // No authored lights: enable viewer defaults.
        // Keep intensities low since RoomEnvironment IBL provides ambient fill.
        // Historically, very low default lighting made some corpus assets look "empty" (nearly black),
        // especially with physically-correct lights + ACES tonemapping. Use a slightly brighter baseline
        // so unlit samples remain visible without needing authored lights.
        hemisphereLight.visible = true;
        defaultDir.visible = true;
        hemisphereLight.intensity = 0.6;
        defaultDir.intensity = 1.2;
        scene.environment = defaultEnvTex;
        scene.environmentIntensity = 0.3;
      }

      const primCount = getCompose() ? listPrimCount(rootLayerToRender.root) : stage.listPrimPaths().length;
      onStatus(`OK: prims=${primCount}`);
      dbg('run ok', { ms: +(performance.now() - tRun0).toFixed(1), primCount });

      // If no authored camera settings, auto-frame to fit content
      if (!hasAuthoredCamera) {
        // Use setTimeout to ensure all geometry is fully added to the scene
        setTimeout(() => {
          perfMark(perf('frameToFit:start'));
          frameToFit();
          perfMark(perf('frameToFit:end'));
          perfMeasure(perf('frameToFit'), perf('frameToFit:start'), perf('frameToFit:end'));
        }, 0);
      }

      const isCorpus = entryKey.startsWith('[corpus]');
      setCorpusHash(isCorpus ? entryKey.replace('[corpus]', '') : null);
      perfMark(perf('end'));
      perfMeasure(perf('runTotal'), perf('start'), perf('end'));
    } catch (e) {
      onStatus(String((e as any)?.message ?? e));
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

  return { run };
}


