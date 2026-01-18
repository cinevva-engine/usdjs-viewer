import * as THREE from 'three';

import { deferTextureApply, getOrLoadTextureClone, getOrLoadUdimTextureSet } from '../textureCache';
import { applyUdimTextureSampling, type UdimMaterialSlot } from './udim';

function isUdimUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return url.includes('<UDIM>') || lower.includes('%3cudim%3e');
}

/**
 * Load a texture into a MeshStandard/Physical material slot.
 *
 * - If url is `<UDIM>` placeholder, loads tile set and patches shader for correct UDIM sampling.
 * - Otherwise loads a single texture and assigns it normally.
 *
 * This is the generic entry point so call sites don't need to special-case UDIM.
 */
export async function loadTextureToMaterialSlot(opts: {
  mat: THREE.MeshStandardMaterial;
  slot: UdimMaterialSlot;
  url: string;
  configure?: (tex: THREE.Texture) => void;
  debugName?: string;
}): Promise<void> {
  const { mat, slot, url, configure, debugName } = opts;

  if (!url) return;

  if (isUdimUrl(url)) {
    const set = await getOrLoadUdimTextureSet(url, configure);
    if (!set || set.tiles.length === 0) {
      // Fall back to single texture behavior (will likely 404 if url is still placeholder).
      const tex = await getOrLoadTextureClone(url, configure);
      deferTextureApply(() => {
        (mat as any)[slot] = tex;
        mat.needsUpdate = true;
      });
      return;
    }

    deferTextureApply(() => {
      applyUdimTextureSampling(mat, slot, set, { debugName });
      mat.needsUpdate = true;
    });
    return;
  }

  const tex = await getOrLoadTextureClone(url, configure);
  console.log(`[loadTextureToMaterialSlot] Loaded texture for slot ${slot}:`, tex ? 'success' : 'failed', 'url:', url);
  deferTextureApply(() => {
    console.log(`[loadTextureToMaterialSlot] Applying texture to mat.${slot}, texture:`, tex);
    (mat as any)[slot] = tex;
    mat.needsUpdate = true;
    console.log(`[loadTextureToMaterialSlot] Applied, mat.${slot}:`, (mat as any)[slot]);
  });
}




