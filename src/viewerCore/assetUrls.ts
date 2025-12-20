import { resolveAssetPath } from '@cinevva/usdjs';

export function createResolveAssetUrl(opts: {
  getCurrentIdentifier: () => string | null | undefined;
}): (assetPath: string, fromIdentifier?: string) => string | null {
  return (assetPath: string, fromIdentifier?: string): string | null => {
    try {
      const stripCorpusPrefix = (v: string): string => (v.startsWith('[corpus]') ? v.replace('[corpus]', '') : v);
      // Some upstream callers may accidentally pass corpus-keyed identifiers/paths (`[corpus]...`).
      // Normalize early so we don't accidentally join `[corpus]packages/usdjs/...` into a directory path.
      const normalizedAssetPath = stripCorpusPrefix(assetPath);

      // If it's an external URL (http:// or https://), use the proxy endpoint
      if (normalizedAssetPath.match(/^https?:\/\//)) {
        return `/__usdjs_proxy?url=${encodeURIComponent(normalizedAssetPath)}`;
      }
      // If the assetPath is already an absolute-ish corpus path, don't re-resolve it.
      // This is important for MaterialX-derived textures where we may normalize filenames
      // to `packages/usdjs/.../tex/foo.jpg`.
      if (normalizedAssetPath.startsWith('packages/usdjs/')) {
        const rel = normalizedAssetPath.slice('packages/usdjs/'.length);
        return `/__usdjs_corpus?file=${encodeURIComponent(rel)}`;
      }
      // Use the provided identifier, or fall back to currentIdentifier.
      // Important: viewer "corpus" entries often prefix identifiers with `[corpus]`,
      // but USD asset resolution should operate on the real underlying path.
      const rawIdentifier = fromIdentifier ?? opts.getCurrentIdentifier();
      const identifier =
        typeof rawIdentifier === 'string' && rawIdentifier.startsWith('[corpus]')
          ? rawIdentifier.replace('[corpus]', '')
          : rawIdentifier;

      const normalizePosixPath = (p: string): string => {
        // Keep URL-like strings intact (we handle those above, but be defensive).
        if (p.match(/^[a-z]+:\/\//i)) return p;
        const isAbs = p.startsWith('/');
        const parts = p.split('/').filter((seg) => seg.length > 0);
        const out: string[] = [];
        for (const seg of parts) {
          if (seg === '.') continue;
          if (seg === '..') {
            if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
            else out.push('..');
            continue;
          }
          out.push(seg);
        }
        return (isAbs ? '/' : '') + out.join('/');
      };

      const resolved = normalizePosixPath(resolveAssetPath(normalizedAssetPath, identifier as any));

      // If the resolved path is an external URL (e.g., when resolving relative to an external USD file),
      // use the proxy endpoint instead of corpus endpoint
      if (resolved.match(/^https?:\/\//)) {
        return `/__usdjs_proxy?url=${encodeURIComponent(resolved)}`;
      }

      // The endpoint expects paths relative to packages/usdjs/, but resolveAssetPath returns
      // paths starting with packages/usdjs/. Strip the prefix if present.
      let relPath = resolved;
      if (resolved.startsWith('packages/usdjs/')) {
        relPath = resolved.slice('packages/usdjs/'.length);
      }

      return `/__usdjs_corpus?file=${encodeURIComponent(relPath)}`;
    } catch (err) {
      try {
        const q = new URLSearchParams((window as any)?.location?.search ?? '');
        const USDDEBUG = q.get('usddebug') === '1' || (window as any)?.localStorage?.getItem?.('usddebug') === '1';
        if (USDDEBUG) {
          // eslint-disable-next-line no-console
          console.warn('[usdjs-viewer][resolveAssetUrl] failed', { assetPath, fromIdentifier, err });
        }
      } catch {
        // ignore
      }
      return null;
    }
  };
}

export function createGetReferenceImageUrl(opts: {
  getEntryKey: () => string;
}): () => string | null {
  return (): string | null => {
    const entryKey = opts.getEntryKey();

    // Only show reference images for corpus entries
    if (!entryKey.startsWith('[corpus]')) return null;

    // Extract the corpus path (remove [corpus] prefix)
    const corpusPath = entryKey.replace('[corpus]', '');

    // Normalize the path (handle packages/usdjs/ prefix)
    let relPath = corpusPath;
    if (relPath.startsWith('packages/usdjs/')) {
      relPath = relPath.slice('packages/usdjs/'.length);
    }

    const extensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];

    // Handle ft-lab sample_usd corpus
    const FTLAB_PREFIX = 'test/corpus/external/ft-lab-sample-usd/sample_usd-main/';
    if (relPath.startsWith(FTLAB_PREFIX)) {
      const sampleRel = relPath.slice(FTLAB_PREFIX.length);
      const baseName = sampleRel.replace(/\.(usda|usd|usdc|usdz)$/i, '');
      const lastSlash = baseName.lastIndexOf('/');
      if (lastSlash === -1) return null;
      const dir = baseName.slice(0, lastSlash);
      const fileName = baseName.slice(lastSlash + 1);
      // ft-lab uses images/ subfolder
      // ft-lab reference renders are typically JPEGs (e.g. OmniPBR_opacity.jpg).
      // Prefer .jpg first to avoid hard 404s when .png doesn't exist.
      const ftLabExts = ['.jpg', '.png', '.jpeg', '.webp', '.gif'];
      for (const ext of ftLabExts) {
        const refImageRel = `${FTLAB_PREFIX}${dir}/images/${fileName}${ext}`;
        return `/__usdjs_corpus?file=${encodeURIComponent(refImageRel)}`;
      }
      return null;
    }

    // Handle usd-wg/assets corpus
    const USDWG_PREFIX = 'test/corpus/external/usd-wg-assets/assets-main/';
    if (relPath.startsWith(USDWG_PREFIX)) {
      const sampleRel = relPath.slice(USDWG_PREFIX.length);
      const baseName = sampleRel.replace(/\.(usda|usd|usdc|usdz)$/i, '');
      const lastSlash = baseName.lastIndexOf('/');
      if (lastSlash === -1) return null;
      const dir = baseName.slice(0, lastSlash);
      const fileName = baseName.slice(lastSlash + 1);

      // usd-wg uses thumbnails/ and screenshots/ subfolders
      // Priority: thumbnails (cleaner), then screenshots (with _usdrecord suffix)
      // Pattern 1: dir/thumbnails/fileName.png
      // Pattern 2: dir/screenshots/fileName_usdrecord_22.08.png
      // Pattern 3: dir/screenshots/fileName.png (some don't have suffix)
      const candidates: string[] = [];

      // Try thumbnails first
      for (const ext of extensions) {
        candidates.push(`${USDWG_PREFIX}${dir}/thumbnails/${fileName}${ext}`);
      }
      // Then screenshots with usdrecord suffix
      for (const ext of extensions) {
        candidates.push(`${USDWG_PREFIX}${dir}/screenshots/${fileName}_usdrecord_22.08${ext}`);
      }
      // Then screenshots without suffix
      for (const ext of extensions) {
        candidates.push(`${USDWG_PREFIX}${dir}/screenshots/${fileName}${ext}`);
      }
      // Also try cards/ folder (used by some test assets)
      for (const ext of extensions) {
        candidates.push(`${USDWG_PREFIX}${dir}/cards/${fileName}_XPos${ext}`);
      }

      // Return first candidate - browser will handle 404 gracefully
      if (candidates.length > 0) {
        return `/__usdjs_corpus?file=${encodeURIComponent(candidates[0])}`;
      }
      return null;
    }

    return null;
  };
}


