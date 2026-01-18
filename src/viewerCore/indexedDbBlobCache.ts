/**
 * Minimal IndexedDB Blob cache (URL -> Blob) for textures and other binary assets.
 *
 * Notes:
 * - This caches *bytes*, not GPU textures. We still need to decode to ImageBitmap / upload to GPU each session.
 * - Designed to be safe to call in non-browser contexts (will no-op).
 * - Eviction is best-effort (LRU-ish via lastAccess). Actual browser quota policies vary.
 */
export type IndexedDbBlobCacheStats = {
    enabled: boolean;
    hits: number;
    misses: number;
    puts: number;
    evictions: number;
    errors: number;
};

type BlobRecord = {
    url: string;
    blob: Blob;
    size: number;
    contentType: string | null;
    createdAt: number;
    lastAccess: number;
};

const DB_NAME = 'usdjs-viewer-blob-cache';
const DB_VERSION = 1;
const STORE = 'blobs';
const IDX_LAST_ACCESS = 'lastAccess';

let openPromise: Promise<IDBDatabase> | null = null;
let disabledForSession = false;

const stats: IndexedDbBlobCacheStats = {
    enabled: false,
    hits: 0,
    misses: 0,
    puts: 0,
    evictions: 0,
    errors: 0,
};

function hasIndexedDb(): boolean {
    // IndexedDB is present in window and workers, but we only use it from the main thread here.
    return typeof indexedDB !== 'undefined' && typeof IDBDatabase !== 'undefined';
}

function nowMs(): number {
    return Date.now();
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
    });
}

function txDone(tx: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction error'));
    });
}

async function openDb(): Promise<IDBDatabase> {
    if (disabledForSession) throw new Error('IndexedDB cache disabled for session');
    if (!hasIndexedDb()) throw new Error('IndexedDB not available');
    if (openPromise) return await openPromise;

    openPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            const store = db.createObjectStore(STORE, { keyPath: 'url' });
            store.createIndex(IDX_LAST_ACCESS, 'lastAccess', { unique: false });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });

    return await openPromise;
}

export function getIndexedDbBlobCacheStats(): IndexedDbBlobCacheStats {
    return { ...stats };
}

export function enableIndexedDbBlobCache(enabled: boolean) {
    stats.enabled = enabled;
    if (!enabled) return;
    // Best-effort warmup so we fail fast if IndexedDB is blocked (Safari private mode, etc.)
    void openDb().catch(() => {
        // If open fails repeatedly, disable for this session.
        disabledForSession = true;
        stats.errors++;
    });
}

export async function getBlobFromIndexedDb(url: string): Promise<Blob | null> {
    if (!stats.enabled || disabledForSession) return null;
    if (!url) return null;
    try {
        const db = await openDb();
        const tx = db.transaction(STORE, 'readonly');
        const store = tx.objectStore(STORE);
        const rec = (await reqToPromise(store.get(url))) as BlobRecord | undefined;
        await txDone(tx);
        if (!rec?.blob) {
            stats.misses++;
            return null;
        }
        stats.hits++;
        // Update lastAccess asynchronously (best-effort).
        void touch(url).catch(() => { /* ignore */ });
        return rec.blob;
    } catch {
        stats.errors++;
        return null;
    }
}

async function touch(url: string): Promise<void> {
    if (!stats.enabled || disabledForSession) return;
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const rec = (await reqToPromise(store.get(url))) as BlobRecord | undefined;
    if (rec) {
        rec.lastAccess = nowMs();
        store.put(rec);
    }
    await txDone(tx);
}

export async function putBlobInIndexedDb(url: string, blob: Blob, opts?: { maxBytes?: number }): Promise<void> {
    if (!stats.enabled || disabledForSession) return;
    if (!url || !blob) return;
    try {
        const maxBytes = opts?.maxBytes ?? 256 * 1024 * 1024; // 256MB default cap (best-effort)
        const db = await openDb();
        const t = nowMs();
        const rec: BlobRecord = {
            url,
            blob,
            size: blob.size ?? 0,
            contentType: (blob as any).type ?? null,
            createdAt: t,
            lastAccess: t,
        };
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(rec);
        await txDone(tx);
        stats.puts++;
        await enforceMaxBytes(maxBytes);
    } catch {
        stats.errors++;
    }
}

async function estimateTotalBytes(db: IDBDatabase): Promise<number> {
    const tx = db.transaction(STORE, 'readonly');
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    const total = await new Promise<number>((resolve, reject) => {
        let sum = 0;
        req.onsuccess = () => {
            const cursor = req.result as IDBCursorWithValue | null;
            if (!cursor) {
                resolve(sum);
                return;
            }
            const v = cursor.value as BlobRecord | undefined;
            sum += v?.size ?? 0;
            cursor.continue();
        };
        req.onerror = () => reject(req.error ?? new Error('cursor failed'));
    });
    await txDone(tx);
    return total;
}

async function evictOldest(db: IDBDatabase, bytesToFree: number): Promise<number> {
    if (bytesToFree <= 0) return 0;
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const idx = store.index(IDX_LAST_ACCESS);
    const req = idx.openCursor(); // ascending lastAccess (oldest first)
    const freed = await new Promise<number>((resolve, reject) => {
        let freedBytes = 0;
        req.onsuccess = () => {
            const cursor = req.result as IDBCursorWithValue | null;
            if (!cursor) {
                resolve(freedBytes);
                return;
            }
            const v = cursor.value as BlobRecord | undefined;
            const sz = v?.size ?? 0;
            store.delete(cursor.primaryKey);
            freedBytes += sz;
            stats.evictions++;
            if (freedBytes >= bytesToFree) {
                resolve(freedBytes);
                return;
            }
            cursor.continue();
        };
        req.onerror = () => reject(req.error ?? new Error('cursor failed'));
    });
    await txDone(tx);
    return freed;
}

async function enforceMaxBytes(maxBytes: number): Promise<void> {
    if (maxBytes <= 0) return;
    if (!stats.enabled || disabledForSession) return;
    const db = await openDb();
    const total = await estimateTotalBytes(db);
    if (total <= maxBytes) return;
    const toFree = total - maxBytes;
    await evictOldest(db, toFree);
}

export async function clearIndexedDbBlobCache(): Promise<void> {
    if (disabledForSession) return;
    if (!hasIndexedDb()) return;
    try {
        const db = await openDb();
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        await txDone(tx);
    } catch {
        // ignore
    }
}

export async function deleteBlobFromIndexedDb(url: string): Promise<void> {
    if (disabledForSession) return;
    if (!hasIndexedDb()) return;
    if (!url) return;
    try {
        const db = await openDb();
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(url);
        await txDone(tx);
    } catch {
        // ignore
    }
}


