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

function looksLikeExr(url: string): boolean {
  try {
    const u = new URL(url, 'http://local/');
    return u.pathname.toLowerCase().endsWith('.exr');
  } catch {
    return url.toLowerCase().includes('.exr');
  }
}

async function decodeToImageBitmap(url: string): Promise<ImageBitmap> {
  if (looksLikeExr(url)) {
    throw new Error('EXR is not supported by ImageBitmap worker decoder (use EXRLoader path)');
  }

  const resp = await fetch(url, { mode: 'cors', credentials: 'same-origin' as any });
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
