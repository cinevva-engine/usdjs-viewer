import * as THREE from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';

import { cloneTexturePreserveParams } from './materials/textureUtils';
import {
    clearIndexedDbBlobCache,
    deleteBlobFromIndexedDb,
    enableIndexedDbBlobCache,
    getBlobFromIndexedDb,
    getIndexedDbBlobCacheStats,
    putBlobInIndexedDb,
} from './indexedDbBlobCache';

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
const udimSetByPlaceholderUrl = new Map<string, Promise<UdimTextureSet | null>>();

// Introspection bookkeeping for the UI/debug panels.
const __urlByCacheKey = new Map<string, string>();
const __resolvedBaseTextureByKey = new Map<string, THREE.Texture>();
const __baseRequestsByKey = new Map<string, number>();
const __cloneRequestsByKey = new Map<string, number>();

// Debug helper: assign stable small IDs to Texture instances so logs can show actual instance reuse.
let __texIdSeq = 1;
const __texIds = new WeakMap<object, number>();
function getTextureDebugId(tex: THREE.Texture | null | undefined): number | null {
    if (!tex) return null;
    const key = tex as unknown as object;
    const existing = __texIds.get(key);
    if (existing) return existing;
    const id = __texIdSeq++;
    __texIds.set(key, id);
    return id;
}

type ProgressiveRecord = {
    url: string;
    baseTexture: THREE.Texture | null;
    clones: Set<THREE.Texture>;
    // Tracks whether we have swapped in a higher-res image.
    stage: 'init' | 'preview' | 'full' | 'failed';
    // Ensures full-res upgrade is only started once.
    fullUpgradePromise: Promise<void> | null;
    // Bookkeeping so we can close previous ImageBitmaps when we swap.
    previewBitmap: ImageBitmap | null;
    fullBitmap: ImageBitmap | null;
};

const progressiveByUrl = new Map<string, ProgressiveRecord>();

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

const USD_PROGRESSIVE_TEXTURES =
    (() => {
        try {
            if (typeof window === 'undefined') return false;
            const q = new URLSearchParams((window as any).location?.search ?? '');
            // Default ON in-browser unless explicitly disabled.
            if (q.get('usdprogressivetex') === '0') return false;
            if (typeof localStorage !== 'undefined' && localStorage.getItem('usdprogressivetex') === '0') return false;
            return true;
        } catch {
            return true;
        }
    })();

const USD_PROGRESSIVE_PREVIEW_MAX_SIZE =
    (() => {
        try {
            if (typeof window === 'undefined') return 512;
            const q = new URLSearchParams((window as any).location?.search ?? '');
            const v = q.get('usdprogressivePreview');
            if (v) {
                const n = Number(v);
                if (Number.isFinite(n) && n > 0) return Math.max(64, Math.min(2048, Math.floor(n)));
            }
            const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('usdprogressivePreview') : null;
            if (ls) {
                const n = Number(ls);
                if (Number.isFinite(n) && n > 0) return Math.max(64, Math.min(2048, Math.floor(n)));
            }
        } catch {
            // ignore
        }
        return 512;
    })();

// Texture apply throttling: queue material updates to avoid GPU upload bursts.
// Default is IMMEDIATE apply (no throttling) so we avoid showing "white" meshes when textures
// are already resolved.
// - Enable throttling: `usdtexapply=throttle` or `usdtexapply=1`
// - Force immediate: `usdtexapply=immediate` or `usdtexapply=0`
const USD_TEX_APPLY_THROTTLE =
    (() => {
        try {
            if (typeof window === 'undefined') return false;
            const q = new URLSearchParams((window as any).location?.search ?? '');
            const v = q.get('usdtexapply') ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('usdtexapply') : null);
            if (!v) return false;
            if (v === '1' || v === 'true' || v === 'throttle') return true;
            if (v === '0' || v === 'false' || v === 'immediate') return false;
        } catch {
            // ignore
        }
        return false;
    })();

const USD_IDB_TEXTURE_CACHE =
    (() => {
        try {
            if (typeof window === 'undefined') return false;
            const q = new URLSearchParams((window as any).location?.search ?? '');
            if (q.get('usdtexidb') === '1') return true;
            if (typeof localStorage !== 'undefined' && localStorage.getItem('usdtexidb') === '1') return true;
        } catch {
            // ignore
        }
        return false;
    })();

// Best-effort cache size limit (bytes). Default 256MB.
const USD_IDB_TEXTURE_CACHE_MAX_BYTES =
    (() => {
        try {
            if (typeof window === 'undefined') return 256 * 1024 * 1024;
            const q = new URLSearchParams((window as any).location?.search ?? '');
            const v = q.get('usdtexidbmax');
            if (v) {
                const n = Number(v);
                if (Number.isFinite(n) && n > 0) return Math.max(8 * 1024 * 1024, Math.floor(n));
            }
            const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('usdtexidbmax') : null;
            if (ls) {
                const n = Number(ls);
                if (Number.isFinite(n) && n > 0) return Math.max(8 * 1024 * 1024, Math.floor(n));
            }
        } catch {
            // ignore
        }
        return 256 * 1024 * 1024;
    })();

// Quick UDIM support (milestone 1):
// If a texture path contains `<UDIM>`, fall back to tile 1001.
// This makes corpora with UDIM-authored materials render without full UDIM sampling.
const UDIM_FALLBACK_TILE = 1001;
let loggedUdimFallback = false;

function applyUdimFallbackUrl(url: string): string {
    // Handle both raw and URL-encoded `<UDIM>` placeholders.
    if (!url) return url;
    const lower = url.toLowerCase();
    if (!url.includes('<UDIM>') && !lower.includes('%3cudim%3e')) return url;

    const out = url
        .replaceAll('<UDIM>', String(UDIM_FALLBACK_TILE))
        .replaceAll('%3CUDIM%3E', String(UDIM_FALLBACK_TILE))
        .replaceAll('%3cudim%3e', String(UDIM_FALLBACK_TILE));

    if (USDDEBUG && !loggedUdimFallback) {
        loggedUdimFallback = true;
        // eslint-disable-next-line no-console
        console.log('[usdjs-viewer:textureCache] UDIM fallback enabled (replacing <UDIM> with 1001).');
    }
    return out;
}

function getUrlPathnameLower(url: string): string {
    try {
        return new URL(url, 'http://local/').pathname.toLowerCase();
    } catch {
        return url.toLowerCase();
    }
}

/**
 * Many of our asset URLs are served via internal endpoints like:
 * - `/__usdjs_corpus?file=.../foo.exr`
 * - `/__usdjs_proxy?url=https%3A%2F%2F...%2Ffoo.png`
 *
 * In those cases, the URL pathname does NOT contain the real extension, so we need to
 * peek into query params to determine the underlying asset type.
 */
function getUnderlyingAssetHint(url: string): string {
    try {
        const u = new URL(url, 'http://local/');
        if (u.pathname.includes('/__usdjs_corpus')) {
            const f = u.searchParams.get('file');
            if (f) return f;
        }
        if (u.pathname.includes('/__usdjs_proxy')) {
            const inner = u.searchParams.get('url');
            if (inner) return inner;
        }
        return url;
    } catch {
        return url;
    }
}

function getTextureCacheKey(url: string): string {
    // Canonicalize cache keys so we don't miss due to different URL encodings
    // (e.g. `@` vs `%40`) or query param ordering.
    try {
        const u = new URL(url, 'http://local/');
        const pathname = u.pathname;
        const entries = Array.from(u.searchParams.entries());
        const normalizeExtras = (excludeKey: string): string => {
            const extras = entries
                .filter(([k]) => k !== excludeKey)
                .sort(([aK, aV], [bK, bV]) => (aK === bK ? aV.localeCompare(bV) : aK.localeCompare(bK)))
                .map(([k, v]) => `${k}=${v}`);
            return extras.length ? `?${extras.join('&')}` : '';
        };

        if (pathname.includes('/__usdjs_corpus')) {
            const file = u.searchParams.get('file') ?? '';
            return `__usdjs_corpus:file=${file}${normalizeExtras('file')}`;
        }

        if (pathname.includes('/__usdjs_proxy')) {
            const inner = u.searchParams.get('url') ?? '';
            return `__usdjs_proxy:url=${inner}${normalizeExtras('url')}`;
        }

        // For plain URLs, normalize the full URL with sorted params.
        if (!entries.length) return url;
        const sorted = entries
            .slice()
            .sort(([aK, aV], [bK, bV]) => (aK === bK ? aV.localeCompare(bV) : aK.localeCompare(bK)))
            .map(([k, v]) => `${k}=${v}`)
            .join('&');
        return `${pathname}?${sorted}`;
    } catch {
        return url;
    }
}

function getLowerExt(url: string): string {
    const hint = getUnderlyingAssetHint(url);
    const lower = hint.toLowerCase();
    const q = lower.indexOf('?');
    const h = lower.indexOf('#');
    const cut = Math.min(...[q, h].filter((n) => n >= 0), lower.length);
    const base = lower.slice(0, cut);
    const i = base.lastIndexOf('.');
    if (i === -1) return '';
    return base.slice(i);
}

function isExrUrl(url: string): boolean {
    return getLowerExt(url) === '.exr';
}

function isBrowserImageUrl(url: string): boolean {
    const ext = getLowerExt(url);
    return (
        ext === '.png' ||
        ext === '.jpg' ||
        ext === '.jpeg' ||
        ext === '.webp' ||
        ext === '.gif' ||
        ext === '.bmp' ||
        ext === '.avif'
    );
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

const dbgTexture = (...args: any[]) => {
    if (!USDDEBUG) return;
    // eslint-disable-next-line no-console
    console.log(...args);
};

type TextureDecodeStats = {
    workerEnabled: boolean;
    workerCreated: number;
    workerAttempts: number;
    workerSuccess: number;
    workerFailures: number;
    workerFallbackToTextureLoader: number;
    baseTextureCacheHits: number;
    imageBitmapCacheHits: number;
    idbEnabled: boolean;
    idbHits: number;
    idbMisses: number;
    idbPuts: number;
    idbEvictions: number;
    idbErrors: number;
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
        idbEnabled: USD_IDB_TEXTURE_CACHE,
        idbHits: 0,
        idbMisses: 0,
        idbPuts: 0,
        idbEvictions: 0,
        idbErrors: 0,
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
let loggedIdbEnabled = false;

function syncIdbStatsToGlobal() {
    const s = getStats();
    if (!s) return;
    const st = getIndexedDbBlobCacheStats();
    s.idbEnabled = st.enabled;
    s.idbHits = st.hits;
    s.idbMisses = st.misses;
    s.idbPuts = st.puts;
    s.idbEvictions = st.evictions;
    s.idbErrors = st.errors;
}

function expectedMimeForUrl(url: string): string | null {
    const ext = getLowerExt(url);
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.bmp') return 'image/bmp';
    if (ext === '.avif') return 'image/avif';
    return null;
}

async function getOrFetchTextureBlob(url: string, cacheKey: string = url): Promise<Blob> {
    // If IDB cache is enabled, try it first. If cache miss, fetch and store.
    if (USD_IDB_TEXTURE_CACHE) {
        enableIndexedDbBlobCache(true);
        const cached = await getBlobFromIndexedDb(cacheKey);
        syncIdbStatsToGlobal();
        if (cached) {
            // Sanity-check cached blobs: sometimes IDB can end up with a bad entry (partial/empty/wrong type).
            // If it looks suspicious, evict and re-fetch.
            const exp = expectedMimeForUrl(url);
            const type = (cached as any)?.type ? String((cached as any).type) : '';
            const size = (cached as any)?.size ?? 0;
            const bad =
                !size ||
                (exp && type && type !== exp) ||
                // If it's an image URL but stored type is empty, treat as suspect.
                (isBrowserImageUrl(url) && !type);
            if (!bad) return cached;

            if (USDDEBUG) {
                // eslint-disable-next-line no-console
                console.warn('[usdjs-viewer:textureCache] IDB blob looks invalid; evicting and refetching', {
                    url,
                    size,
                    type,
                    expected: exp,
                });
            }
            await deleteBlobFromIndexedDb(cacheKey);
            syncIdbStatsToGlobal();
        }
    }

    const fetchBlob = async (init?: RequestInit): Promise<Blob> => {
        const res = await fetch(url, init);
        if (!res.ok) throw new Error(`Texture fetch failed (${res.status} ${res.statusText}): ${url}`);
        // Use arrayBuffer+Blob to preserve/force content-type more reliably than Response.blob() in edge cases.
        const ct = res.headers.get('content-type') || '';
        const buf = await res.arrayBuffer();
        return new Blob([buf], { type: ct });
    };

    // Fetch-only strategy with a small retry. We've observed cases where `fetch()` can reject due
    // to transient stream/connection issues even when a navigation to the same URL succeeds.
    let blob: Blob | null = null;
    let lastErr: any = null;
    for (const init of [undefined, { cache: 'no-store' as RequestCache }]) {
        try {
            // eslint-disable-next-line no-await-in-loop
            blob = await fetchBlob(init as any);
            break;
        } catch (e) {
            lastErr = e;
            if (USDDEBUG) {
                // eslint-disable-next-line no-console
                console.warn('[usdjs-viewer:textureCache] fetch() failed for texture, retrying', { url, init, error: e });
            }
        }
    }
    if (!blob) throw lastErr ?? new Error(`Texture fetch failed: ${url}`);

    if (USD_IDB_TEXTURE_CACHE) {
        void putBlobInIndexedDb(cacheKey, blob, { maxBytes: USD_IDB_TEXTURE_CACHE_MAX_BYTES }).then(() => {
            syncIdbStatsToGlobal();
        });
    }
    return blob;
}

async function loadTextureFromBlob(url: string, blob: Blob): Promise<THREE.Texture> {
    // EXR: parse from ArrayBuffer (avoids network when bytes are cached).
    if (isExrUrl(url)) {
        const buf = await blob.arrayBuffer();
        const texData = exrLoader.parse(buf);
        const tex = new THREE.DataTexture();

        if ((texData as any).image !== undefined) {
            (tex as any).image = (texData as any).image;
        } else if ((texData as any).data !== undefined) {
            (tex as any).image.width = (texData as any).width;
            (tex as any).image.height = (texData as any).height;
            (tex as any).image.data = (texData as any).data;
        }

        if ((texData as any).wrapS !== undefined) tex.wrapS = (texData as any).wrapS;
        if ((texData as any).wrapT !== undefined) tex.wrapT = (texData as any).wrapT;
        if ((texData as any).magFilter !== undefined) tex.magFilter = (texData as any).magFilter;
        if ((texData as any).minFilter !== undefined) tex.minFilter = (texData as any).minFilter;
        if ((texData as any).anisotropy !== undefined) tex.anisotropy = (texData as any).anisotropy;
        if ((texData as any).colorSpace !== undefined) (tex as any).colorSpace = (texData as any).colorSpace;
        if ((texData as any).flipY !== undefined) (tex as any).flipY = (texData as any).flipY;
        if ((texData as any).format !== undefined) (tex as any).format = (texData as any).format;
        if ((texData as any).type !== undefined) (tex as any).type = (texData as any).type;
        if ((texData as any).mipmaps !== undefined) (tex as any).mipmaps = (texData as any).mipmaps;
        if ((texData as any).generateMipmaps !== undefined) (tex as any).generateMipmaps = (texData as any).generateMipmaps;

        tex.needsUpdate = true;
        return tex as unknown as THREE.Texture;
    }

    // Common image formats: prefer ImageBitmap for fast decode + GPU upload.
    if (typeof createImageBitmap !== 'undefined') {
        let bitmap: ImageBitmap;
        try {
            bitmap = await (createImageBitmap as any)(blob, { imageOrientation: 'flipY' as any });
        } catch {
            bitmap = await (createImageBitmap as any)(blob);
        }

        const tex = new THREE.Texture(bitmap as any);
        tex.flipY = false;
        tex.needsUpdate = true;
        return tex;
    }

    // Fallback: create an object URL and let TextureLoader decode it (no network).
    const objectUrl = URL.createObjectURL(blob);
    try {
        const tex = await loader.loadAsync(objectUrl);
        tex.needsUpdate = true;
        return tex;
    } finally {
        try {
            URL.revokeObjectURL(objectUrl);
        } catch {
            // ignore
        }
    }
}

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
    // If throttling is disabled, apply immediately.
    if (!USD_TEX_APPLY_THROTTLE) {
        fn();
        return;
    }
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
        if (applyQueue.length) deferTextureApply(() => { });
    });
}

export async function getOrLoadTexture(url: string): Promise<THREE.Texture> {
    if (!url) throw new Error('getOrLoadTexture: url is empty');

    const normalizedUrl = applyUdimFallbackUrl(url);
    const cacheKey = getTextureCacheKey(normalizedUrl);
    __urlByCacheKey.set(cacheKey, normalizedUrl);
    __baseRequestsByKey.set(cacheKey, (__baseRequestsByKey.get(cacheKey) ?? 0) + 1);

    if (USD_IDB_TEXTURE_CACHE && USDDEBUG && !loggedIdbEnabled) {
        loggedIdbEnabled = true;
        // eslint-disable-next-line no-console
        console.log('[usdjs-viewer:textureCache] IndexedDB texture byte cache enabled (usdtexidb=1)', {
            maxBytes: USD_IDB_TEXTURE_CACHE_MAX_BYTES,
        });
    }

    const cached = baseTextureByUrl.get(cacheKey);
    if (cached) {
        dbgTexture('[TEXTURE] Using cached promise for:', normalizedUrl);
        const s = getStats();
        if (s) s.baseTextureCacheHits++;
        if (USDDEBUG) {
            void cached.then((t) => {
                // eslint-disable-next-line no-console
                console.log('[usdjs-viewer:textureCache] base texture reused', {
                    url: normalizedUrl,
                    cacheKey,
                    baseId: getTextureDebugId(t),
                });
            });
        }
        return cached;
    }

    dbgTexture('[TEXTURE] Creating new texture load promise for:', normalizedUrl);
    const p = withLoadSlot(async () => {
        dbgTexture('[TEXTURE] Starting texture load for:', normalizedUrl);
        // EXR: must use EXRLoader (DataTexture). If IDB caching is enabled, load bytes from Blob.
        if (isExrUrl(normalizedUrl)) {
            if (USD_IDB_TEXTURE_CACHE && typeof fetch !== 'undefined') {
                const blob = await getOrFetchTextureBlob(normalizedUrl, cacheKey);
                const tex = await loadTextureFromBlob(normalizedUrl, blob);
                if (USDDEBUG) {
                    // eslint-disable-next-line no-console
                    console.log('[usdjs-viewer:textureCache] base texture created', {
                        url: normalizedUrl,
                        cacheKey,
                        baseId: getTextureDebugId(tex),
                        format: 'exr',
                        source: 'blob(idb-or-network)',
                    });
                }
                __resolvedBaseTextureByKey.set(cacheKey, tex);
                return tex;
            }
            const tex = (await exrLoader.loadAsync(normalizedUrl)) as unknown as THREE.Texture;
            tex.needsUpdate = true;
            if (USDDEBUG) {
                // eslint-disable-next-line no-console
                console.log('[usdjs-viewer:textureCache] base texture created', {
                    url: normalizedUrl,
                    cacheKey,
                    baseId: getTextureDebugId(tex),
                    format: 'exr',
                    source: 'network(exrLoader)',
                });
            }
            __resolvedBaseTextureByKey.set(cacheKey, tex);
            return tex;
        }

        // Progressive path: load a downscaled preview ImageBitmap first, return it,
        // and upgrade to full-res in the background (updating clones too).
        //
        // NOTE: This still downloads the full image bytes once; it mainly reduces initial GPU upload
        // cost and enables the scene to render sooner with acceptable quality.
        const canProgressive =
            USD_PROGRESSIVE_TEXTURES &&
            typeof fetch !== 'undefined' &&
            typeof createImageBitmap !== 'undefined' &&
            isBrowserImageUrl(normalizedUrl);

        // Optional: decode in worker via ImageBitmap, then create a Three texture from it.
        // Fallback: TextureLoader.loadAsync (HTMLImageElement decode on main).
        // Some browsers/environments are finicky about fetch+ImageBitmap in workers for our proxy endpoint.
        // Since TextureLoader is robust here (and already same-origin), skip the worker path for __usdjs_proxy.
        const isProxyUrl = (() => {
            try {
                const u = new URL(normalizedUrl, 'http://local/');
                return u.pathname.includes('/__usdjs_proxy');
            } catch {
                return normalizedUrl.includes('/__usdjs_proxy');
            }
        })();

        if (canProgressive && !isProxyUrl) {
            const existing = progressiveByUrl.get(cacheKey);
            if (existing && existing.baseTexture) {
                if (USDDEBUG) {
                    // eslint-disable-next-line no-console
                    console.log('[usdjs-viewer:textureCache] progressive base texture reused', {
                        url: normalizedUrl,
                        cacheKey,
                        baseId: getTextureDebugId(existing.baseTexture),
                        stage: existing.stage,
                    });
                }
                __resolvedBaseTextureByKey.set(cacheKey, existing.baseTexture);
                return existing.baseTexture;
            }

            // Fetch once, decode twice (preview + full) from the same Blob.
            const blob = await getOrFetchTextureBlob(normalizedUrl, cacheKey);

            const mkBitmap = async (opts?: ImageBitmapOptions): Promise<ImageBitmap> => {
                try {
                    return await (createImageBitmap as any)(blob, {
                        ...(opts ?? {}),
                        // Match Three.js ImageBitmapLoader convention.
                        imageOrientation: 'flipY',
                    });
                } catch {
                    // Fallback for browsers that reject ImageBitmapOptions.
                    return await (createImageBitmap as any)(blob);
                }
            };

            const previewMax = USD_PROGRESSIVE_PREVIEW_MAX_SIZE;
            // Prefer aspect-ratio preserving resize (many browsers will preserve aspect when only one is provided).
            let preview: ImageBitmap;
            try {
                preview = await mkBitmap({ resizeWidth: previewMax, resizeQuality: 'low' } as any);
            } catch {
                preview = await mkBitmap({ resizeWidth: previewMax, resizeHeight: previewMax, resizeQuality: 'low' } as any);
            }

            const tex = new THREE.Texture(preview as any);
            tex.flipY = false;
            tex.needsUpdate = true;
            if (USDDEBUG) {
                // eslint-disable-next-line no-console
                console.log('[usdjs-viewer:textureCache] base texture created (progressive preview)', {
                    url: normalizedUrl,
                    cacheKey,
                    baseId: getTextureDebugId(tex),
                    stage: 'preview',
                });
            }
            __resolvedBaseTextureByKey.set(cacheKey, tex);

            // Register progressive record.
            const rec: ProgressiveRecord = {
                url: normalizedUrl,
                baseTexture: tex,
                clones: new Set(),
                stage: 'preview',
                fullUpgradePromise: null,
                previewBitmap: preview,
                fullBitmap: null,
            };
            progressiveByUrl.set(cacheKey, rec);

            // Start full-res upgrade in the background with throttling.
            rec.fullUpgradePromise = withLoadSlot(async () => {
                if (rec.stage === 'full') return;
                const full = await mkBitmap();

                // Swap base + all known clones to full bitmap.
                const prev = rec.previewBitmap;
                rec.fullBitmap = full;
                rec.previewBitmap = null;
                rec.stage = 'full';

                deferTextureApply(() => {
                    try {
                        // IMPORTANT (WebGL2/ANGLE): Three.js may allocate textures via texStorage2D and then
                        // upload via texSubImage2D. If we change the image dimensions on an existing Texture,
                        // the underlying GPU storage might still be the *preview* size, causing:
                        //   GL_INVALID_VALUE: glTexSubImage2D... Offset overflows texture dimensions.
                        //
                        // To force reallocation, dispose the texture first when dimensions change.
                        const prevW = (rec.baseTexture as any)?.image?.width ?? null;
                        const prevH = (rec.baseTexture as any)?.image?.height ?? null;
                        const nextW = (full as any)?.width ?? null;
                        const nextH = (full as any)?.height ?? null;
                        const dimsChanged =
                            prevW != null &&
                            prevH != null &&
                            nextW != null &&
                            nextH != null &&
                            (prevW !== nextW || prevH !== nextH);

                        // Update base texture
                        if (rec.baseTexture) {
                            if (dimsChanged) {
                                try {
                                    rec.baseTexture.dispose();
                                } catch {
                                    // ignore
                                }
                            }
                            (rec.baseTexture as any).image = full as any;
                            rec.baseTexture.needsUpdate = true;
                        }
                        // Update clones so they don't stay on the preview bitmap forever.
                        for (const t of rec.clones) {
                            try {
                                if (dimsChanged) {
                                    try {
                                        t.dispose();
                                    } catch {
                                        // ignore
                                    }
                                }
                                (t as any).image = full as any;
                                t.needsUpdate = true;
                            } catch {
                                // ignore
                            }
                        }
                    } finally {
                        try {
                            // Close the preview bitmap after swap (free memory).
                            prev?.close?.();
                        } catch {
                            // ignore
                        }
                    }
                });
            }).catch(() => {
                // Keep preview; allow future retries by leaving stage=preview.
            });

            return tex;
        }

        // If IndexedDB caching is enabled, always prefer Blob-based loading so we can reuse bytes
        // across sessions and avoid repeat network GETs (including for `/__usdjs_proxy?...` URLs).
        if (USD_IDB_TEXTURE_CACHE && typeof fetch !== 'undefined') {
            const blob = await getOrFetchTextureBlob(normalizedUrl, cacheKey);
            const tex = await loadTextureFromBlob(normalizedUrl, blob);
            if (USDDEBUG) {
                // eslint-disable-next-line no-console
                console.log('[usdjs-viewer:textureCache] base texture created', {
                    url: normalizedUrl,
                    cacheKey,
                    baseId: getTextureDebugId(tex),
                    source: 'blob(idb-or-network)',
                });
            }
            return tex;
        }

        if (!isProxyUrl && USD_IMAGE_BITMAP_DECODE && typeof createImageBitmap !== 'undefined') {
            try {
                const existingBm = imageBitmapByUrl.get(cacheKey);
                const s = getStats();
                if (existingBm && s) s.imageBitmapCacheHits++;

                const bitmapPromise = existingBm ?? (async () => await decodeImageBitmapInWorker(normalizedUrl))();
                imageBitmapByUrl.set(cacheKey, bitmapPromise);
                const bitmap = await bitmapPromise;

                // Construct a base texture from ImageBitmap. We keep flipY=false because the worker
                // requested imageOrientation=flipY where supported (matching Three's ImageBitmapLoader convention).
                const tex = new THREE.Texture(bitmap as any);
                tex.flipY = false;
                tex.needsUpdate = true;
                if (USDDEBUG) {
                    // eslint-disable-next-line no-console
                    console.log('[usdjs-viewer:textureCache] base texture created', {
                        url: normalizedUrl,
                        cacheKey,
                        baseId: getTextureDebugId(tex),
                        source: 'worker(ImageBitmap)',
                    });
                }
                __resolvedBaseTextureByKey.set(cacheKey, tex);
                return tex;
            } catch {
                // allow retry later + fall back
                imageBitmapByUrl.delete(cacheKey);
                const s = getStats();
                if (s) s.workerFallbackToTextureLoader++;
            }
        }

        // TextureLoader.loadAsync caches at the browser/network layer, but not decode.
        // Sharing the base texture avoids duplicate decodes for identical URLs.
        dbgTexture('[TEXTURE] Calling loader.loadAsync for:', normalizedUrl);
        const tex = await loader.loadAsync(normalizedUrl);
        dbgTexture('[TEXTURE] loader.loadAsync completed for:', normalizedUrl, 'texture:', tex);
        tex.needsUpdate = true;
        if (USDDEBUG) {
            // eslint-disable-next-line no-console
            console.log('[usdjs-viewer:textureCache] base texture created', {
                url: normalizedUrl,
                cacheKey,
                baseId: getTextureDebugId(tex),
                source: 'network(TextureLoader)',
            });
        }
        __resolvedBaseTextureByKey.set(cacheKey, tex);
        return tex;
    });

    // Store promise immediately to dedupe in-flight loads.
    baseTextureByUrl.set(cacheKey, p);

    try {
        const t = await p;
        __resolvedBaseTextureByKey.set(cacheKey, t);
        return t;
    } catch (e) {
        // If the load failed, allow future retries.
        baseTextureByUrl.delete(cacheKey);
        __resolvedBaseTextureByKey.delete(cacheKey);
        throw e;
    }
}

export type UdimTileTexture = { udim: number; url: string; tex: THREE.Texture };
export type UdimTextureSet = {
    placeholderUrl: string;
    tiles: UdimTileTexture[];
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
};

function isUdimPlaceholderUrl(url: string): boolean {
    if (!url) return false;
    const lower = url.toLowerCase();
    return url.includes('<UDIM>') || lower.includes('%3cudim%3e');
}

function replaceUdim(url: string, udim: number): string {
    return url
        .replaceAll('<UDIM>', String(udim))
        .replaceAll('%3CUDIM%3E', String(udim))
        .replaceAll('%3cudim%3e', String(udim));
}

async function urlExistsHead(url: string): Promise<boolean> {
    try {
        const res = await fetch(url, { method: 'HEAD' });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Discover and load UDIM tiles for a `<UDIM>` placeholder.
 *
 * - Preserves the placeholder url for caching/identity.
 * - Discovery is done via HEAD probes against a bounded UDIM grid.
 * - Tile textures are loaded via getOrLoadTextureClone so per-material params remain isolated.
 *
 * NOTE: This is the "correct sampling" building block. Sampling itself is implemented
 * via shader patching in materials (see `materials/udim.ts`).
 */
export async function getOrLoadUdimTextureSet(
    placeholderUrl: string,
    configure?: (tex: THREE.Texture) => void,
): Promise<UdimTextureSet | null> {
    if (!isUdimPlaceholderUrl(placeholderUrl)) return null;

    const setKey = getTextureCacheKey(placeholderUrl);
    const cached = udimSetByPlaceholderUrl.get(setKey);
    if (cached) return await cached;

    const p = (async () => {

        // Heuristic discovery:
        // Scan UDIM grid up to 10x10 (1001..1100). Most assets use a tiny subset (1-8 tiles).
        // We stop scanning rows after we find an empty row *after* having found some tiles.
        const found: number[] = [];

        let seenAny = false;
        for (let v = 0; v < 10; v++) {
            let rowAny = false;
            for (let u = 0; u < 10; u++) {
                const udim = 1001 + u + 10 * v;
                const url = replaceUdim(placeholderUrl, udim);
                // Use HEAD first (fast), only load actual textures for found tiles.
                // eslint-disable-next-line no-await-in-loop
                const ok = await urlExistsHead(url);
                if (!ok) continue;
                rowAny = true;
                seenAny = true;
                found.push(udim);
            }
            if (seenAny && !rowAny) break;
        }

        if (!found.length) return null;

        // Compute bounds (min/max tile coords)
        const coords = found.map((udim) => {
            const idx = udim - 1001;
            return { udim, u: idx % 10, v: Math.floor(idx / 10) };
        });
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const c of coords) {
            uMin = Math.min(uMin, c.u);
            uMax = Math.max(uMax, c.u);
            vMin = Math.min(vMin, c.v);
            vMax = Math.max(vMax, c.v);
        }

        // Load tile textures (sequentially throttled via internal loader caching + our semaphore).
        const tiles: UdimTileTexture[] = [];
        for (const c of coords) {
            const url = replaceUdim(placeholderUrl, c.udim);
            // eslint-disable-next-line no-await-in-loop
            const tex = await getOrLoadTextureClone(url, configure);
            tiles.push({ udim: c.udim, url, tex });
        }

        // Strongly prefer tile 1001 first for deterministic behavior.
        tiles.sort((a, b) => a.udim - b.udim);

        return { placeholderUrl, tiles, uMin, uMax, vMin, vMax };
    })();

    udimSetByPlaceholderUrl.set(setKey, p);
    try {
        return await p;
    } catch (e) {
        udimSetByPlaceholderUrl.delete(setKey);
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
    const normalizedUrl = applyUdimFallbackUrl(url);
    const cacheKey = getTextureCacheKey(normalizedUrl);
    __urlByCacheKey.set(cacheKey, normalizedUrl);
    __cloneRequestsByKey.set(cacheKey, (__cloneRequestsByKey.get(cacheKey) ?? 0) + 1);
    dbgTexture('[TEXTURE] getOrLoadTextureClone called for:', normalizedUrl);
    const base = await getOrLoadTexture(normalizedUrl);
    dbgTexture('[TEXTURE] getOrLoadTexture returned for:', normalizedUrl, 'base texture:', base);
    const tex = cloneTexturePreserveParams(base);
    if (USDDEBUG) {
        // eslint-disable-next-line no-console
        console.log('[usdjs-viewer:textureCache] clone created', {
            url: normalizedUrl,
            cacheKey,
            baseId: getTextureDebugId(base),
            cloneId: getTextureDebugId(tex),
        });
    }
    // If this URL is being loaded progressively, register the clone so it gets upgraded.
    const rec = progressiveByUrl.get(cacheKey);
    if (rec) {
        rec.clones.add(tex);
        if (USDDEBUG) {
            // eslint-disable-next-line no-console
            console.log('[usdjs-viewer:textureCache] clone registered for progressive updates', {
                url: normalizedUrl,
                cacheKey,
                cloneId: getTextureDebugId(tex),
                stage: rec.stage,
            });
        }
        // If full-res already arrived, swap immediately.
        if (rec.stage === 'full' && rec.fullBitmap) {
            (tex as any).image = rec.fullBitmap as any;
        }
    }
    configure?.(tex);
    tex.needsUpdate = true;
    dbgTexture('[TEXTURE] getOrLoadTextureClone returning texture for:', normalizedUrl);
    return tex;
}

function tryGetTextureWH(tex: THREE.Texture | null): { width: number | null; height: number | null } {
    try {
        const img: any = (tex as any)?.image;
        const width = typeof img?.width === 'number' ? img.width : null;
        const height = typeof img?.height === 'number' ? img.height : null;
        return { width, height };
    } catch {
        return { width: null, height: null };
    }
}

function estimateTextureBytes(tex: THREE.Texture | null): number | null {
    if (!tex) return null;
    try {
        const img: any = (tex as any).image;
        const data = img?.data;
        const dataBytes = typeof data?.byteLength === 'number' ? data.byteLength : 0;
        if (dataBytes > 0) return dataBytes;
        const w = typeof img?.width === 'number' ? img.width : 0;
        const h = typeof img?.height === 'number' ? img.height : 0;
        if (w > 0 && h > 0) return w * h * 4; // best-effort default RGBA8
        return null;
    } catch {
        return null;
    }
}

/**
 * Get the URL for a texture if it's in the cache.
 * Returns null if the texture is not found in the cache.
 */
export function getTextureUrlFromCache(tex: THREE.Texture): string | null {
    if (typeof window === 'undefined' || !tex) return null;
    
    // Search through resolved base textures to find a match by UUID
    for (const [cacheKey, resolvedTex] of __resolvedBaseTextureByKey.entries()) {
        if (resolvedTex === tex || resolvedTex.uuid === tex.uuid) {
            return __urlByCacheKey.get(cacheKey) ?? null;
        }
    }
    
    // Also check progressive records (they may have baseTexture set)
    for (const [cacheKey, rec] of progressiveByUrl.entries()) {
        if (rec.baseTexture && (rec.baseTexture === tex || rec.baseTexture.uuid === tex.uuid)) {
            return __urlByCacheKey.get(cacheKey) ?? null;
        }
        // Check clones too
        if (rec.clones.has(tex)) {
            return __urlByCacheKey.get(cacheKey) ?? null;
        }
    }
    
    return null;
}

export function listTextureCacheEntries(): Array<import('./types').TextureCacheEntryInfo> {
    if (typeof window === 'undefined') return [];

    const keys = new Set<string>();
    for (const k of baseTextureByUrl.keys()) keys.add(k);
    for (const k of progressiveByUrl.keys()) keys.add(k);
    for (const k of __urlByCacheKey.keys()) keys.add(k);
    for (const k of __baseRequestsByKey.keys()) keys.add(k);
    for (const k of __cloneRequestsByKey.keys()) keys.add(k);

    const out: Array<import('./types').TextureCacheEntryInfo> = [];
    for (const cacheKey of keys) {
        const rec = progressiveByUrl.get(cacheKey) ?? null;
        const resolved = rec?.baseTexture ?? __resolvedBaseTextureByKey.get(cacheKey) ?? null;
        const { width, height } = tryGetTextureWH(resolved);
        const estimatedBytes = estimateTextureBytes(resolved);
        out.push({
            cacheKey,
            url: __urlByCacheKey.get(cacheKey) ?? cacheKey,
            baseRequests: __baseRequestsByKey.get(cacheKey) ?? 0,
            cloneRequests: __cloneRequestsByKey.get(cacheKey) ?? 0,
            progressiveStage: rec?.stage ?? null,
            progressiveClonesLive: rec ? rec.clones.size : null,
            resolved: !!resolved,
            baseId: getTextureDebugId(resolved),
            width,
            height,
            estimatedBytes,
        });
    }

    out.sort((a, b) => (b.estimatedBytes ?? 0) - (a.estimatedBytes ?? 0));
    return out;
}

export function clearTextureCache(opts?: { clearIndexedDb?: boolean }) {
    baseTextureByUrl.clear();
    imageBitmapByUrl.clear();
    udimSetByPlaceholderUrl.clear();
    __urlByCacheKey.clear();
    __resolvedBaseTextureByKey.clear();
    __baseRequestsByKey.clear();
    __cloneRequestsByKey.clear();
    // Close any ImageBitmaps we own.
    for (const [, rec] of progressiveByUrl) {
        try { rec.previewBitmap?.close?.(); } catch { /* ignore */ }
        try { rec.fullBitmap?.close?.(); } catch { /* ignore */ }
    }
    progressiveByUrl.clear();

    // Optional: also clear the persistent IndexedDB blob cache.
    // This is best-effort and intentionally fire-and-forget to keep this API synchronous.
    if (opts?.clearIndexedDb) {
        void clearIndexedDbBlobCache()
            .then(() => syncIdbStatsToGlobal())
            .catch(() => { /* ignore */ });
    }
}

/**
 * Clears the persistent IndexedDB blob cache (if enabled).
 * This is intentionally separate from `clearTextureCache()` (which is in-memory only).
 */
export async function clearTextureBlobIndexedDbCache(): Promise<void> {
    await clearIndexedDbBlobCache();
    syncIdbStatsToGlobal();
}


