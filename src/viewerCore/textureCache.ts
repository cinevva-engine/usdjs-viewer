import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

import { cloneTexturePreserveParams } from './materials/textureUtils';

/**
 * Texture loading + caching helper.
 *
 * Goals:
 * - Avoid loading/decoding the same URL multiple times (common source of "Decode Image" storms).
 * - Keep per-material texture params isolated by returning clones by default.
 * - Optionally throttle concurrent loads to reduce main-thread decode hitches.
 */

const baseTextureByUrl = new Map<string, Promise<THREE.Texture>>();
const imageBitmapByUrl = new Map<string, Promise<ImageBitmap>>();

// Simple async semaphore to limit concurrent texture loads.
let activeLoads = 0;
const pending: Array<() => void> = [];

// Conservative default. If you want higher parallelism, we can expose this.
const MAX_CONCURRENT_TEXTURE_LOADS = 4;

async function withLoadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeLoads >= MAX_CONCURRENT_TEXTURE_LOADS) {
    await new Promise<void>((resolve) => pending.push(resolve));
  }
  activeLoads++;
  try {
    return await fn();
  } finally {
    activeLoads--;
    const next = pending.shift();
    if (next) next();
  }
}

const loader = new THREE.TextureLoader();
const exrLoader = new EXRLoader();

function getUrlPathnameLower(url: string): string {
  try {
    return new URL(url, 'http://local/').pathname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function isExrUrl(url: string): boolean {
  return getUrlPathnameLower(url).endsWith('.exr');
}

const USDDEBUG =
  (() => {
    try {
      if (typeof window === 'undefined') return false;
      const q = new URLSearchParams((window as any).location?.search ?? '');
      if (q.get('usddebug') === '1') return true;
      if (typeof localStorage !== 'undefined' && localStorage.getItem('usddebug') === '1') return true;
    } catch {
      // ignore
    }
    return false;
  })();

type TextureDecodeStats = {
  workerEnabled: boolean;
  workerCreated: number;
  workerAttempts: number;
  workerSuccess: number;
  workerFailures: number;
  workerFallbackToTextureLoader: number;
  baseTextureCacheHits: number;
  imageBitmapCacheHits: number;
};

function getStats(): TextureDecodeStats | null {
  if (typeof window === 'undefined') return null;
  const w = window as any;
  w.__usdjsTextureDecodeStats ??= {
    // Whether the feature flag is enabled, not whether debug logging is enabled.
    workerEnabled: USD_IMAGE_BITMAP_DECODE,
    workerCreated: 0,
    workerAttempts: 0,
    workerSuccess: 0,
    workerFailures: 0,
    workerFallbackToTextureLoader: 0,
    baseTextureCacheHits: 0,
    imageBitmapCacheHits: 0,
  } satisfies TextureDecodeStats;
  return w.__usdjsTextureDecodeStats as TextureDecodeStats;
}

const USD_IMAGE_BITMAP_DECODE =
  (() => {
    try {
      if (typeof window === 'undefined') return false;
      const q = new URLSearchParams((window as any).location?.search ?? '');
      if (q.get('usdimgbitmap') === '1') return true;
      if (typeof localStorage !== 'undefined' && localStorage.getItem('usdimgbitmap') === '1') return true;
    } catch {
      // ignore
    }
    return false;
  })();

/**
 * TODO(perf): move more texture decoding off the main thread.
 *
 * Today, our optional worker path uses `createImageBitmap(blob)` which relies on the browser’s native
 * image decoders and therefore only works for formats the browser can decode (png/jpg/webp/…).
 *
 * For other formats, we’ll need format-specific worker pipelines:
 * - EXR: decode in worker via `EXRLoader`-style parsing and return raw pixel buffers (Float32/Uint16),
 *   then construct `THREE.DataTexture` on the main thread for GPU upload.
 * - KTX2/Basis: prefer `KTX2Loader` which already supports worker-based transcoding in Three.js.
 * - General: unify these behind a single `getOrLoadTexture*` API with per-format strategies, keeping URL
 *   caching + concurrency limits so we avoid “decode storms” and duplicate work.
 */

type WorkerReq = { id: number; url: string };
type WorkerRes = { id: number; ok: true; bitmap: ImageBitmap } | { id: number; ok: false; error: string };

let decodeWorker: Worker | null = null;
let decodeSeq = 0;
const decodePending = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: any) => void }>();
let loggedWorkerEnabled = false;

function getDecodeWorker(): Worker {
  if (decodeWorker) return decodeWorker;
  // Vite module worker.
  decodeWorker = new Worker(new URL('./imageBitmapDecodeWorker.ts', import.meta.url), {
    type: 'module',
    // Supported in modern browsers; shows up as a friendly thread name in DevTools.
    name: 'usdjs-image-decode',
  } as any);
  const s = getStats();
  if (s) {
    s.workerEnabled = USD_IMAGE_BITMAP_DECODE;
    s.workerCreated++;
  }
  decodeWorker.onmessage = (ev: MessageEvent<WorkerRes>) => {
    const msg = ev.data as any;
    const p = decodePending.get(msg?.id);
    if (!p) return;
    decodePending.delete(msg.id);
    if (msg.ok) p.resolve(msg.bitmap);
    else p.reject(new Error(msg.error || 'ImageBitmap decode failed'));
  };
  decodeWorker.onerror = (err) => {
    // Fail all pending requests; worker will be recreated on next request.
    for (const [, p] of decodePending) p.reject(err);
    decodePending.clear();
    try {
      decodeWorker?.terminate();
    } catch {
      // ignore
    }
    decodeWorker = null;
  };

  if (USDDEBUG && USD_IMAGE_BITMAP_DECODE && !loggedWorkerEnabled) {
    loggedWorkerEnabled = true;
    const s = getStats();
    if (s) s.workerEnabled = true;
    // eslint-disable-next-line no-console
    console.log('[usdjs-viewer:textureCache] ImageBitmap worker decode enabled (usdimgbitmap=1)');
  }
  return decodeWorker;
}

async function decodeImageBitmapInWorker(url: string): Promise<ImageBitmap> {
  const s = getStats();
  if (s) s.workerAttempts++;
  const t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
  const w = getDecodeWorker();
  const id = ++decodeSeq;
  const req: WorkerReq = { id, url };
  const p = new Promise<ImageBitmap>((resolve, reject) => {
    decodePending.set(id, { resolve, reject });
  });
  w.postMessage(req);
  try {
    const bm = await p;
    if (s) s.workerSuccess++;
    if (USDDEBUG && typeof performance !== 'undefined' && performance.now) {
      const ms = performance.now() - t0;
      // eslint-disable-next-line no-console
      console.log('[usdjs-viewer:textureCache] worker decoded image', { url, ms: +ms.toFixed(1) });
    }
    return bm;
  } catch (e) {
    if (s) s.workerFailures++;
    throw e;
  }
}

// Apply throttling: when many textures resolve at once, updating materials immediately can
// cause visible "waves" of texture pops (and GPU upload bursts). Queue and apply a few per frame.
const applyQueue: Array<() => void> = [];
let applyScheduled = false;
const MAX_APPLIES_PER_FRAME = 6;

export function deferTextureApply(fn: () => void) {
  // In non-browser contexts, just run synchronously.
  if (typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') {
    fn();
    return;
  }
  applyQueue.push(fn);
  if (applyScheduled) return;
  applyScheduled = true;
  requestAnimationFrame(() => {
    applyScheduled = false;
    const n = Math.min(MAX_APPLIES_PER_FRAME, applyQueue.length);
    for (let i = 0; i < n; i++) {
      const f = applyQueue.shift();
      try {
        f?.();
      } catch {
        // ignore
      }
    }
    // If there is more work, schedule another frame.
    if (applyQueue.length) deferTextureApply(() => {});
  });
}

export async function getOrLoadTexture(url: string): Promise<THREE.Texture> {
  if (!url) throw new Error('getOrLoadTexture: url is empty');

  const cached = baseTextureByUrl.get(url);
  if (cached) {
    const s = getStats();
    if (s) s.baseTextureCacheHits++;
    return cached;
  }

  const p = withLoadSlot(async () => {
    // EXR: must use EXRLoader (DataTexture). Skip ImageBitmap worker path.
    if (isExrUrl(url)) {
      const tex = (await exrLoader.loadAsync(url)) as unknown as THREE.Texture;
      tex.needsUpdate = true;
      return tex;
    }

    // Optional: decode in worker via ImageBitmap, then create a Three texture from it.
    // Fallback: TextureLoader.loadAsync (HTMLImageElement decode on main).
    if (USD_IMAGE_BITMAP_DECODE && typeof createImageBitmap !== 'undefined') {
      try {
        const existingBm = imageBitmapByUrl.get(url);
        const s = getStats();
        if (existingBm && s) s.imageBitmapCacheHits++;

        const bitmapPromise = existingBm ?? (async () => await decodeImageBitmapInWorker(url))();
        imageBitmapByUrl.set(url, bitmapPromise);
        const bitmap = await bitmapPromise;

        // Construct a base texture from ImageBitmap. We keep flipY=false because the worker
        // requested imageOrientation=flipY where supported (matching Three's ImageBitmapLoader convention).
        const tex = new THREE.Texture(bitmap as any);
        tex.flipY = false;
        tex.needsUpdate = true;
        return tex;
      } catch {
        // allow retry later + fall back
        imageBitmapByUrl.delete(url);
        const s = getStats();
        if (s) s.workerFallbackToTextureLoader++;
      }
    }

    // TextureLoader.loadAsync caches at the browser/network layer, but not decode.
    // Sharing the base texture avoids duplicate decodes for identical URLs.
    const tex = await loader.loadAsync(url);
    tex.needsUpdate = true;
    return tex;
  });

  // Store promise immediately to dedupe in-flight loads.
  baseTextureByUrl.set(url, p);

  try {
    return await p;
  } catch (e) {
    // If the load failed, allow future retries.
    baseTextureByUrl.delete(url);
    throw e;
  }
}

/**
 * Most callers should use this instead of mutating the shared base texture.
 * The clone shares the underlying image, so decoding is still deduped by URL.
 */
export async function getOrLoadTextureClone(
  url: string,
  configure?: (tex: THREE.Texture) => void,
): Promise<THREE.Texture> {
  const base = await getOrLoadTexture(url);
  const tex = cloneTexturePreserveParams(base);
  configure?.(tex);
  tex.needsUpdate = true;
  return tex;
}

export function clearTextureCache() {
  baseTextureByUrl.clear();
  imageBitmapByUrl.clear();
}


