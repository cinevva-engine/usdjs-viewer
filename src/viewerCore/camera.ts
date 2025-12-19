import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export function frameToFit(opts: {
  scene: THREE.Scene;
  contentRoot: THREE.Object3D;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
}): void {
  const { scene, contentRoot, camera, controls } = opts;

  // Ensure all transforms are up to date
  // Use dirty checking - Three.js will update objects that need it (including newly added ones)
  // This is much faster than forcing a full traversal, especially for large scenes
  scene.updateMatrixWorld(false);

  const box = new THREE.Box3();

  const isAxisHelper = (obj: THREE.Object3D): boolean => {
    // usd-wg-assets transform samples commonly reference `_common/axis.usda` under an `axis` prim:
    //   over "axis" ( references = @.../axis.usda@ ) { }
    //
    // Those axis bars are debug helpers; including them in auto-framing can dramatically zoom out
    // and make the actual content look "moved far away" compared to usdrecord reference images.
    // We treat anything under a prim path segment `/axis` as a helper and exclude it from bounds.
    let cur: THREE.Object3D | null = obj;
    while (cur) {
      const n = cur.name ?? '';
      if (typeof n === 'string' && (n === '/World/axis' || n.endsWith('/axis') || n.includes('/axis/'))) return true;
      cur = cur.parent;
    }
    return false;
  };

  // Compute bounding box of all geometry in contentRoot
  contentRoot.traverse((obj) => {
    if (obj instanceof THREE.Mesh || obj instanceof THREE.SkinnedMesh ||
      obj instanceof THREE.Points || obj instanceof THREE.Line ||
      obj instanceof THREE.LineSegments) {
      if (isAxisHelper(obj)) return;
      const geometry = (obj as any).geometry as THREE.BufferGeometry | undefined;
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

export function applyCameraSettings(opts: {
  layer: any;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  stageUnitScale: number;
}): boolean {
  const { layer, camera, controls, stageUnitScale } = opts;

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


