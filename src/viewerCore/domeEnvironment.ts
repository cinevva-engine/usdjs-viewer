import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

export function createDomeEnvironmentController(opts: {
  scene: THREE.Scene;
  pmremGen: THREE.PMREMGenerator;
}) {
  const { scene, pmremGen } = opts;

  let domeEnvRt: THREE.WebGLRenderTarget | null = null;
  let domeLoadToken = 0;

  const setFromDomeLight = (optsIn: {
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

  function resetForNewSample() {
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

  function dispose() {
    domeLoadToken++;
    domeEnvRt?.dispose();
    domeEnvRt = null;
  }

  return { setFromDomeLight, resetForNewSample, dispose };
}



