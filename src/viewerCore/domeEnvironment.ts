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
    onSuccess?: () => void;
    onError?: (err: unknown) => void;
  }) => {
    const { assetPath, format, worldQuaternion, intensity, onSuccess, onError } = optsIn;
    // Only latlong is supported right now (matches ft-lab dome_light.usda).
    if (format && format !== 'latlong') {
      console.warn('[DomeLight] Unsupported format:', format, 'only latlong is supported');
      onError?.(new Error(`Unsupported format: ${format}`));
      return;
    }
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
        console.warn('[DomeLight] Texture load returned null:', assetPath);
        onError?.(new Error('Texture load returned null'));
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
      
      // Coordinate system conversion between OpenEXR/USD and Three.js:
      //
      // Three.js equirectUv(): u = atan(dir.z, dir.x) / (2π) + 0.5
      //   - dir = +X (1,0,0): u = 0.5 (center of texture)
      //   - dir = +Z (0,0,1): u = 0.75 (right of center)
      //   - Three.js longitude 0 (u=0.5) is at +X direction
      //
      // OpenEXR/USD latlong convention (from DomeLight spec):
      //   - Longitude 0 points into +Z direction (center of texture)
      //   - Longitude π/2 points into +X direction
      //   - OpenEXR longitude 0 is at +Z direction
      //
      // backgroundRotation/environmentRotation rotates the lookup direction BEFORE sampling.
      // To map: when looking at +X (Three.js center), sample +Z (OpenEXR center)
      // RotY(+90°): +X → +Z ✓
      //
      // TODO: The DomeLight's authored xform rotation (worldQuaternion) is currently ignored.
      // Many USD scenes author DomeLight rotations that expect specific HDRI orientations.
      // A proper implementation would compose: qCoordConv * qDomeInv (apply dome inverse first,
      // then coordinate conversion). However, the USD row-vector to Three.js column-vector
      // conversion and quaternion composition order needs careful verification.
      const qCoordConv = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
      const eFinal = new THREE.Euler().setFromQuaternion(qCoordConv, 'XYZ');
      scene.environmentRotation.copy(eFinal);
      scene.backgroundRotation.copy(eFinal);
      // USD intensity is luminance in nits (cd/m^2). Three.js Scene.environmentIntensity is a unitless scalar,
      // so we keep using the viewer calibration constant used for other nits-based lights.
      const USD_NITS_TO_THREE = 8000;
      scene.environmentIntensity = intensity / USD_NITS_TO_THREE;
      scene.backgroundIntensity = scene.environmentIntensity;
      console.log('[DomeLight] Environment texture loaded successfully:', assetPath);
      onSuccess?.();
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



