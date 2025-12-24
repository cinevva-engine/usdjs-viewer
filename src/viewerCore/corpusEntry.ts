import { UsdStage, resolveAssetPath } from '@cinevva/usdjs';

type NormalizeCorpusPathFn = (p: string) => string;
type FetchCorpusFileFn = (rel: string) => Promise<string | ArrayBuffer>;
type ExtractDependenciesFn = (layer: any) => string[];
type SetCorpusHashFn = (rel: string | null) => void;

export async function loadCorpusEntryExternal(opts: {
  rel: string;
  CORPUS_PATH_PREFIX: string;
  normalizeCorpusPathForFetch: NormalizeCorpusPathFn;
  normalizeCorpusPathForHash: NormalizeCorpusPathFn;
  fetchCorpusFile: FetchCorpusFileFn;
  extractDependencies: ExtractDependenciesFn;
  externalFiles: Map<string, { name: string; text: string; binary?: ArrayBuffer }>;
  setEntryKey: (k: string) => void;
  setTextareaText: (t: string) => void;
  setCorpusHash: SetCorpusHashFn;
  dbg: (...args: any[]) => void;
}) {
  const {
    rel,
    CORPUS_PATH_PREFIX,
    normalizeCorpusPathForFetch,
    normalizeCorpusPathForHash,
    fetchCorpusFile,
    extractDependencies,
    externalFiles,
    setEntryKey,
    setTextareaText,
    setCorpusHash,
    dbg,
  } = opts;

  // Normalize path for fetching (strip packages/usdjs/ if present)
  const fetchRel = normalizeCorpusPathForFetch(rel);
  const fetched = await fetchCorpusFile(fetchRel);
  // Use the full path for the corpus key and hash
  const fullPath = normalizeCorpusPathForHash(rel);
  const corpusKey = `[corpus]${fullPath}`;

  // Check if fetched is binary (ArrayBuffer) or text (string)
  if (fetched instanceof ArrayBuffer) {
    // Binary file - store as binary, text will be empty (will be parsed directly)
    externalFiles.set(corpusKey, {
      name: fullPath.split('/').pop() ?? fullPath,
      text: '',
      binary: fetched
    });
    setEntryKey(corpusKey);
    setTextareaText(''); // Binary files don't have text representation
  } else {
    // Text file - store as text
    externalFiles.set(corpusKey, {
      name: fullPath.split('/').pop() ?? fullPath,
      text: fetched
    });
    setEntryKey(corpusKey);
    setTextareaText(fetched);
  }

  setCorpusHash(fullPath);

  // Prefetch dependencies for composition.
  // Handle both binary and text files for dependency extraction
  const queue: Array<{ identifier: string; text?: string; binary?: ArrayBuffer }> = [];
  if (fetched instanceof ArrayBuffer) {
    queue.push({ identifier: rel, binary: fetched });
  } else {
    queue.push({ identifier: rel, text: fetched });
  }
  const seen = new Set<string>([rel]);

  // Import MaterialX detection function
  const { isMaterialXContent, isUsdzContent } = await import('@cinevva/usdjs');

  while (queue.length) {
    const cur = queue.shift()!;
    try {
      let stage: UsdStage;
      let layer: any;

      // Parse based on whether we have binary or text
      if (cur.binary) {
        // Binary file - parse natively
        const data = new Uint8Array(cur.binary);
        if (isUsdzContent(data)) {
          stage = await UsdStage.openUSDZ(data, cur.identifier);
        } else {
          stage = UsdStage.open(data, cur.identifier);
        }
        layer = stage.rootLayer;
      } else if (cur.text) {
        // Text file - parse as USDA
        // Skip dependency extraction for MaterialX files (they don't have USD-style references)
        if (isMaterialXContent(cur.text)) {
          continue;
        }
        stage = UsdStage.openUSDA(cur.text, cur.identifier);
        layer = stage.rootLayer;
      } else {
        continue;
      }

      const deps = extractDependencies(layer);
      for (const dep of deps) {
        const resolved = resolveAssetPath(dep, cur.identifier);
        if (seen.has(resolved)) continue;
        // Check for both prefixed and non-prefixed paths since identifiers may vary
        const isCorpusExternal = resolved.startsWith('test/corpus/external/') ||
          resolved.startsWith(`${CORPUS_PATH_PREFIX}test/corpus/external/`);
        if (!isCorpusExternal) continue;
        try {
          // Normalize the path for fetching (server expects paths without packages/usdjs/ prefix)
          const fetchPath = normalizeCorpusPathForFetch(resolved);
          const fetchedDep = await fetchCorpusFile(fetchPath);
          const fullPath = normalizeCorpusPathForHash(resolved);
          const depKey = `[corpus]${fullPath}`;

          if (fetchedDep instanceof ArrayBuffer) {
            externalFiles.set(depKey, {
              name: fullPath.split('/').pop() ?? fullPath,
              text: '',
              binary: fetchedDep
            });
            seen.add(resolved);
            queue.push({ identifier: resolved, binary: fetchedDep });
          } else {
            externalFiles.set(depKey, {
              name: fullPath.split('/').pop() ?? fullPath,
              text: fetchedDep
            });
            seen.add(resolved);
            queue.push({ identifier: resolved, text: fetchedDep });
          }
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  const fetchedSize = fetched instanceof ArrayBuffer ? fetched.byteLength : fetched.length;
  dbg('corpus entry loaded', { rel, fullPath, fetchedBytes: fetchedSize, isBinary: fetched instanceof ArrayBuffer });
}


