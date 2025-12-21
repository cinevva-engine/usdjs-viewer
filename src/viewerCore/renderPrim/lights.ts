import * as THREE from 'three';
import { resolveAssetPath, type SdfPrimSpec } from '@cinevva/usdjs';

import { getPrimProp } from '../usdAnim';
import { resolveMaterialBinding, resolveShaderFromMaterial } from '../materials';
import { getMdlEnvironmentAsset } from '../materials/mdlSourceAsset';

export function renderUsdLightPrim(opts: {
  typeName: string;
  container: THREE.Object3D;
  helpersParent: THREE.Object3D;
  prim: SdfPrimSpec;
  rootPrim: SdfPrimSpec;
  unitScale: number;
  dynamicHelperUpdates: Array<() => void>;
  hasUsdLightsRef: { value: boolean };
  hasUsdDomeLightRef: { value: boolean };
  resolveAssetUrl?: (assetPath: string, fromIdentifier?: string) => string | null;
  domeEnv?: {
    setFromDomeLight: (opts: {
      assetPath: string;
      format: string | null;
      worldQuaternion: THREE.Quaternion;
      intensity: number;
    }) => void;
  };
}): boolean {
  const {
    typeName,
    container,
    helpersParent,
    prim,
    rootPrim,
    unitScale,
    dynamicHelperUpdates,
    hasUsdLightsRef,
    hasUsdDomeLightRef,
    resolveAssetUrl,
    domeEnv,
  } = opts;

  // Lights (same mapping as before)
  if (typeName === 'DistantLight' || typeName === 'SphereLight' || typeName === 'RectLight' || typeName === 'DomeLight') {
    const getNumber = (names: string[], fallback: number): number => {
      for (const n of names) {
        const v = getPrimProp(prim, n);
        if (typeof v === 'number') return v;
      }
      return fallback;
    };
    const getBool = (names: string[], fallback: boolean): boolean => {
      for (const n of names) {
        const v = getPrimProp(prim, n);
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

    const colorProp = getPrimProp(prim, 'inputs:color') ?? getPrimProp(prim, 'color');
    let lightColor = new THREE.Color(0xffffff);
    if (colorProp && typeof colorProp === 'object' && (colorProp as any).type === 'tuple' && (colorProp as any).value.length >= 3) {
      const [r, g, b] = (colorProp as any).value;
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
      (light.shadow.camera as any).left = -shadowSize;
      (light.shadow.camera as any).right = shadowSize;
      (light.shadow.camera as any).top = shadowSize;
      (light.shadow.camera as any).bottom = -shadowSize;
      (light.shadow.camera as any).near = 0.1;
      (light.shadow.camera as any).far = 1000;

      // DirectionalLight direction is defined by (position -> target).
      //
      // USD DistantLight is documented as: "light from a distant source, along the -Z axis".
      //
      // In practice (and to match reference renders), treat that as the *incoming* light direction
      // (vector from the shaded point toward the light source) being -Z in the light's local space.
      //
      // Three.js DirectionalLight uses (position -> target) as the *ray travel* direction
      // (from light toward the scene), which is the opposite of incoming direction.
      //
      // Therefore, to represent incoming local -Z, we set travel to local +Z.
      //
      // Keep both light and target under the prim container so authored xforms apply.
      light.position.set(0, 0, 0);
      // Start from local +Z travel (see comment above about incoming-vs-travel).
      light.target.position.set(0, 0, 1);
      container.add(light.target);
      container.add(light);

      // Empirical correction: reference renders for ft-lab expect a 180° yaw relative to our computed travel dir.
      // Apply a world-space Y rotation by π to the computed direction, then convert back into container-local target.
      // This preserves authored pitch (top-down) while matching azimuth.
      requestAnimationFrame(() => {
        container.updateMatrixWorld(true);
        light.updateMatrixWorld(true);
        light.target.updateMatrixWorld(true);

        const lightWorldPos = new THREE.Vector3();
        const targetWorldPos = new THREE.Vector3();
        light.getWorldPosition(lightWorldPos);
        light.target.getWorldPosition(targetWorldPos);

        const worldDir = new THREE.Vector3().subVectors(targetWorldPos, lightWorldPos).normalize();
        const correctedWorldDir = new THREE.Vector3(-worldDir.x, worldDir.y, -worldDir.z); // RotY(π)
        const correctedTargetWorld = lightWorldPos.clone().add(correctedWorldDir);

        // Convert corrected target position back into container-local space.
        const correctedTargetLocal = container.worldToLocal(correctedTargetWorld.clone());
        light.target.position.copy(correctedTargetLocal);
        light.target.updateMatrixWorld(true);
      });

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

        // USD SpotLight emits in local -Z direction by default.
        // Our xform conversion (row-vector -> Three) negates angles, which effectively flips direction.
        // Compensate by setting the target at +Z, so the negated container rotation produces the correct world dir.
        light.target.position.set(0, 0, 1);
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
      const threeIntensity = L / USD_NITS_TO_THREE_NITS;
      console.log('[RectLight]', prim.path?.primPath, {
        usdIntensity: intensityBase,
        normalize,
        area,
        L,
        threeIntensity,
        width: widthVal,
        height: heightVal,
        color: lightColor.getHexString(),
      });
      const light = new THREE.RectAreaLight(lightColor, threeIntensity, widthVal, heightVal);
      // RectAreaLight emits in local -Z. Our xform conversion negates angles, which flips the emission direction.
      // Compensate by rotating the light 180° around Y (flip -Z to +Z), so negated container rotation gives correct world dir.
      light.rotation.set(0, Math.PI, 0);
      container.add(light);
      hasUsdLightsRef.value = true;
    } else if (typeName === 'DomeLight') {
      // DomeLight is environment lighting. If a latlong texture is provided, load it and set scene.environment.
      // Otherwise, fall back to a simple hemispherical ambient approximation.
      const texVal = getPrimProp(prim, 'inputs:texture:file') ?? getPrimProp(prim, 'texture:file');
      console.log('[DomeLight] Raw texture property:', {
        primPath: prim.path?.primPath,
        texVal,
        hasInputsTextureFile: !!getPrimProp(prim, 'inputs:texture:file'),
        hasTextureFile: !!getPrimProp(prim, 'texture:file'),
      });
      const texAsset =
        texVal && typeof texVal === 'object' && (texVal as any).type === 'asset' && typeof (texVal as any).value === 'string'
          ? (() => {
            const stripCorpusPrefix = (v: string): string => (v.startsWith('[corpus]') ? v.replace('[corpus]', '') : v);
            const raw = (texVal as any).value as string;
            const fromId = typeof (texVal as any).__fromIdentifier === 'string' ? ((texVal as any).__fromIdentifier as string) : null;
            const normFromId = typeof fromId === 'string' ? stripCorpusPrefix(fromId) : null;
            const normRaw = stripCorpusPrefix(raw);
            const resolved = normFromId ? resolveAssetPath(normRaw, normFromId) : normRaw;
            console.log('[DomeLight] Texture asset resolution steps:', {
              raw,
              fromId,
              normFromId,
              normRaw,
              resolved,
            });
            return resolved;
          })()
          : null;
      const fmtVal = getPrimProp(prim, 'inputs:texture:format') ?? getPrimProp(prim, 'texture:format');
      const fmt =
        typeof fmtVal === 'string'
          ? fmtVal
          : fmtVal && typeof fmtVal === 'object' && (fmtVal as any).type === 'token'
            ? ((fmtVal as any).value as string)
            : null;

      const isProbablyFileUrl = (u: string): boolean => {
        try {
          const x = new URL(u, 'http://local/');
          const p = x.pathname;
          if (!p) return false;
          if (p.endsWith('/')) return false;
          const last = p.split('/').pop() ?? '';
          // If there's no dot at all, it's very likely a directory or bare name.
          return last.includes('.');
        } catch {
          if (u.endsWith('/')) return false;
          const last = u.split('/').pop() ?? '';
          return last.includes('.');
        }
      };

      if (texAsset && resolveAssetUrl && domeEnv) {
        hasUsdDomeLightRef.value = true;
        const url = resolveAssetUrl(texAsset);
        // Check the original texAsset URL for file extension, not the proxy URL
        // (proxy URLs like /__usdjs_proxy?url=... don't have extensions in their pathname)
        const isFile = isProbablyFileUrl(texAsset);
        console.log('[DomeLight] Texture asset resolution:', {
          primPath: prim.path?.primPath,
          texAsset,
          resolvedUrl: url,
          isFileUrl: isFile,
          format: fmt,
        });
        // Some assets (Omniverse templates) incorrectly resolve to a directory; skip to avoid 404 spam.
        if (url && isFile) {
          const q = new THREE.Quaternion();
          container.getWorldQuaternion(q);
          domeEnv.setFromDomeLight({
            assetPath: url,
            format: fmt,
            worldQuaternion: q,
            intensity: intensityBase,
          });
        } else {
          // Allow MDL environment fallback below (or hemisphere).
          console.warn('[DomeLight] Skipping texture load - not a file URL:', {
            url,
            texAsset,
            reason: url ? 'does not look like a file (no extension or ends with /)' : 'resolveAssetUrl returned null',
          });
          hasUsdDomeLightRef.value = false;
        }
      } else {
        // Fallback: if this DomeLight is bound to an MDL "sourceAsset" sky material, try to extract an HDR/EXR
        // referenced by that MDL module and use it as the environment.
        if (resolveAssetUrl && domeEnv) {
          try {
            const matPrim = resolveMaterialBinding(prim, rootPrim);
            const shaderPrim = matPrim ? resolveShaderFromMaterial(matPrim, rootPrim) : null;
            if (shaderPrim) {
              void (async () => {
                const envAsset = await getMdlEnvironmentAsset({
                  shader: shaderPrim,
                  resolveAssetUrl: (p) => resolveAssetUrl(p),
                });
                if (!envAsset) return;
                const url = resolveAssetUrl(envAsset);
                if (!url) return;
                const q = new THREE.Quaternion();
                container.getWorldQuaternion(q);
                hasUsdDomeLightRef.value = true;
                domeEnv.setFromDomeLight({
                  assetPath: url,
                  format: fmt ?? 'latlong',
                  worldQuaternion: q,
                  intensity: intensityBase,
                });
              })();
              hasUsdLightsRef.value = true;
              return true;
            }
          } catch {
            // ignore; fall back to hemisphere below
          }
        }

        const light = new THREE.HemisphereLight(lightColor, new THREE.Color(0x000000), intensityBase / 1000);
        container.add(light);
      }
      hasUsdLightsRef.value = true;
    }
    return true;
  }

  return false;
}


