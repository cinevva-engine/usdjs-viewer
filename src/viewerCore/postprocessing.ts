import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

export function ensurePost(opts: {
  composerRef: { value: EffectComposer | null };
  renderPassRef: { value: RenderPass | null };
  colorPassRef: { value: ShaderPass | null };
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  resize: () => void;
}) {
  const { composerRef, renderPassRef, colorPassRef, renderer, scene, camera, resize } = opts;

  if (composerRef.value) return;
  composerRef.value = new EffectComposer(renderer);
  renderPassRef.value = new RenderPass(scene, camera);
  composerRef.value.addPass(renderPassRef.value);

  // Minimal color-correction pass mapping RTX-ish settings approximately.
  colorPassRef.value = new ShaderPass({
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
  composerRef.value.addPass(colorPassRef.value);
  resize();
}

function setColorCorrUniform(opts: { colorPassRef: { value: ShaderPass | null }; key: string; v: any }) {
  const { colorPassRef, key, v } = opts;
  if (!colorPassRef.value) return;
  if (!v || typeof v !== 'object' || v.type !== 'tuple') return;
  const [x, y, z] = v.value;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return;
  const u = (colorPassRef.value.uniforms as any)[key];
  if (u?.value?.set) u.value.set(x, y, z);
}

export function applyRenderSettings(opts: {
  layer: any;
  scene: THREE.Scene;
  hemisphereLight: THREE.HemisphereLight;
  tupleToColor: (tuple: any) => THREE.Color | null;
  fogRef: { value: THREE.Fog | null };
  useComposerRef: { value: boolean };
  composerRef: { value: EffectComposer | null };
  renderPassRef: { value: RenderPass | null };
  colorPassRef: { value: ShaderPass | null };
  renderer: THREE.WebGLRenderer;
  camera: THREE.Camera;
  resize: () => void;
}) {
  const {
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
  } = opts;

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
      fogRef.value = new THREE.Fog(color, 50, 1000);
      scene.fog = fogRef.value;
    }
  } else {
    if (fogRef.value) {
      scene.fog = null;
      fogRef.value = null;
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
    ensurePost({ composerRef, renderPassRef, colorPassRef, renderer, scene, camera, resize });
    useComposerRef.value = true;
    setColorCorrUniform({ colorPassRef, key: 'uGain', v: settings?.['rtx:post:colorcorr:gain'] });
    setColorCorrUniform({ colorPassRef, key: 'uOffset', v: settings?.['rtx:post:colorcorr:offset'] });
    setColorCorrUniform({ colorPassRef, key: 'uGamma', v: settings?.['rtx:post:colorcorr:gamma'] });
    setColorCorrUniform({ colorPassRef, key: 'uContrast', v: settings?.['rtx:post:colorcorr:contrast'] });
    setColorCorrUniform({ colorPassRef, key: 'uSaturation', v: settings?.['rtx:post:colorcorr:saturation'] });
  } else {
    useComposerRef.value = false;
  }
}


