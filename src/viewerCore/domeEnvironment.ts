import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

// Omniverse CDN base URL for fallback when local corpus assets are missing
const OMNIVERSE_CDN_BASE = 'http://omniverse-content-production.s3-us-west-2.amazonaws.com/';

/**
 * Try to extract a CDN fallback URL from a corpus URL.
 * If the corpus URL points to nvidia-omniverse-scene-templates, extract the relative path
 * and construct an Omniverse CDN URL.
 */
function getCdnFallbackUrl(corpusUrl: string): string | null {
  // Check if this is a corpus URL
  if (!corpusUrl.includes('/__usdjs_corpus?file=')) {
    return null;
  }

  // Decode the file parameter
  try {
    const url = new URL(corpusUrl, 'http://localhost');
    const filePath = url.searchParams.get('file');
    if (!filePath) return null;

    const decoded = decodeURIComponent(filePath);
    
    // Look for nvidia-omniverse-scene-templates and extract the path after Assets/
    const marker = 'nvidia-omniverse-scene-templates/Assets/';
    const idx = decoded.indexOf(marker);
    if (idx === -1) return null;

    const relativePath = decoded.substring(idx + marker.length);
    const cdnUrl = OMNIVERSE_CDN_BASE + 'Assets/' + relativePath;
    
    // Return as proxy URL to avoid CORS issues
    return '/__usdjs_proxy?url=' + encodeURIComponent(cdnUrl);
  } catch {
    return null;
  }
}

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
      // DomeLight intensity/exposure acts as a multiplier for emitted environment lighting.
      //
      // Three.js Scene.environmentIntensity is a unitless scalar applied to IBL lighting.
      // Since the absolute radiometric calibration of HDR/EXR pixel values is generally unknown
      // (and USD assets also vary across pipelines), there is no universally "correct" physical
      // conversion from a real-world luminance (cd/m^2) to this scalar without additional metadata.
      //
      // What we *can* do correctly and consistently is: treat USD intensity/exposure as the intended
      // authored multiplier and apply it directly, without any viewer-specific calibration constant.
      scene.environmentIntensity = intensity;
      // IMPORTANT: backgroundIntensity controls the visual brightness of the skybox/backdrop.
      // Unlike environmentIntensity (which scales IBL contribution to object lighting),
      // the background should NOT be dimmed by scene lighting calibration.
      // Per USD DomeLight spec and Three.js design: the background is a backdrop, not an illuminated
      // object. It should display at natural HDR brightness and let the tonemapper handle it.
      // Setting to 1.0 means "display HDR as-is" before tonemapping.
      scene.backgroundIntensity = 1.0;
      console.log('[DomeLight] Environment texture loaded successfully:', assetPath);
      onSuccess?.();
    };

    // Helper to load with CDN fallback
    const loadWithFallback = (
      url: string,
      Loader: typeof HDRLoader | typeof EXRLoader,
      onFail: (err: unknown) => void,
    ) => {
      new Loader().load(
        url,
        (tex: THREE.DataTexture) => handleTexture(tex),
        undefined,
        (err: unknown) => {
          // Check if we can try CDN fallback
          const fallbackUrl = getCdnFallbackUrl(url);
          if (fallbackUrl) {
            console.log('[DomeLight] Local corpus asset not found, trying CDN fallback:', fallbackUrl);
            new Loader().load(
              fallbackUrl,
              (tex: THREE.DataTexture) => handleTexture(tex),
              undefined,
              (err2: unknown) => {
                console.error('[DomeLight] CDN fallback also failed:', fallbackUrl, err2);
                onFail(err2);
              },
            );
          } else {
            onFail(err);
          }
        },
      );
    };

    if (isHDR) {
      // Use HDRLoader for HDR files
      loadWithFallback(assetPath, HDRLoader, (err) => {
        console.error('[DomeLight] HDR load failed:', assetPath, err);
        onError?.(err);
      });
    } else if (isEXR) {
      // Use EXRLoader for EXR files
      loadWithFallback(assetPath, EXRLoader, (err) => {
        console.error('[DomeLight] EXR load failed:', assetPath, err);
        onError?.(err);
      });
    } else {
      // Try EXR first (default), fall back to HDR
      loadWithFallback(assetPath, EXRLoader, () => {
        // If EXR fails, try HDR (also with CDN fallback)
        console.warn('[DomeLight] EXR load failed, trying HDR:', assetPath);
        loadWithFallback(assetPath, HDRLoader, (err2) => {
          console.error('[DomeLight] HDR load also failed:', assetPath, err2);
          onError?.(err2);
        });
      });
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



