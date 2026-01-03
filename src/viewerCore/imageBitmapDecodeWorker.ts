// Vite module worker.
// Fetch + decode images into ImageBitmap off the main thread.
//
// NOTE: This relies on the browser's native decoders (png/jpg/webp/...). It does NOT support EXR.

type Req = {
    id: number;
    url: string;
};

type Res =
    | { id: number; ok: true; bitmap: ImageBitmap }
    | { id: number; ok: false; error: string };

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

function looksLikeExr(url: string): boolean {
    const hint = getUnderlyingAssetHint(url).toLowerCase();
    return hint.includes('.exr');
}

async function decodeToImageBitmap(url: string): Promise<ImageBitmap> {
    if (looksLikeExr(url)) {
        throw new Error('EXR is not supported by ImageBitmap worker decoder (use EXRLoader path)');
    }

    // NOTE:
    // - For same-origin URLs (our `/__usdjs_proxy` and `/__usdjs_corpus` endpoints), we should NOT force CORS mode
    //   nor credentials. In particular, the proxy sets `Access-Control-Allow-Origin: *` which can conflict with
    //   credentialed CORS fetches in some browsers/contexts.
    // - For cross-origin URLs, we want CORS fetch without credentials.
    let resp: Response;
    try {
        const origin = (self as any)?.location?.origin;
        const isSameOrigin = origin && new URL(url, origin).origin === origin;
        resp = await fetch(url, isSameOrigin ? undefined : { mode: 'cors', credentials: 'omit' as any });
    } catch {
        // Fallback to a plain fetch if URL parsing fails.
        resp = await fetch(url);
    }
    if (!resp.ok) throw new Error(`fetch failed: ${resp.status} ${resp.statusText}`);
    const blob = await resp.blob();

    // Prefer flipY so we can keep THREE.Texture.flipY=false (matches ImageBitmapLoader behavior).
    try {
        return await createImageBitmap(blob, { imageOrientation: 'flipY' as any });
    } catch {
        return await createImageBitmap(blob);
    }
}

self.onmessage = async (ev: MessageEvent<Req>) => {
    const { id, url } = ev.data ?? ({} as any);
    if (!id || !url) return;
    try {
        const bitmap = await decodeToImageBitmap(url);
        const msg: Res = { id, ok: true, bitmap };
        // Transfer ownership of the ImageBitmap to the main thread.
        (self as any).postMessage(msg, [bitmap as any]);
    } catch (e: any) {
        const msg: Res = { id, ok: false, error: String(e?.message ?? e) };
        (self as any).postMessage(msg);
    }
};
