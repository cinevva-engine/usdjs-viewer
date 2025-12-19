import { UsdStage, resolveAssetPath } from '@cinevva/usdjs';

type NormalizeCorpusPathFn = (p: string) => string;
type FetchCorpusFileFn = (rel: string) => Promise<string>;
type ExtractDependenciesFn = (layer: any) => string[];
type SetCorpusHashFn = (rel: string | null) => void;

export async function loadCorpusEntryExternal(opts: {
  rel: string;
  CORPUS_PATH_PREFIX: string;
  normalizeCorpusPathForFetch: NormalizeCorpusPathFn;
  normalizeCorpusPathForHash: NormalizeCorpusPathFn;
  fetchCorpusFile: FetchCorpusFileFn;
  extractDependencies: ExtractDependenciesFn;
  externalFiles: Map<string, { name: string; text: string }>;
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
  externalFiles.set(corpusKey, { name: fullPath.split('/').pop() ?? fullPath, text: fetched });
  setEntryKey(corpusKey);
  setTextareaText(fetched);

  setCorpusHash(fullPath);

  // Prefetch dependencies for composition.
  const queue: Array<{ identifier: string; text: string }> = [{ identifier: rel, text: fetched }];
  const seen = new Set<string>([rel]);

  // Import MaterialX detection function
  const { isMaterialXContent } = await import('@cinevva/usdjs');

  while (queue.length) {
    const cur = queue.shift()!;
    try {
      // Skip dependency extraction for MaterialX files (they don't have USD-style references)
      if (isMaterialXContent(cur.text)) {
        continue;
      }
      const stage = UsdStage.openUSDA(cur.text, cur.identifier);
      const layer = stage.rootLayer;
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
          const text = await fetchCorpusFile(fetchPath);
          const fullPath = normalizeCorpusPathForHash(resolved);
          const depKey = `[corpus]${fullPath}`;
          externalFiles.set(depKey, { name: fullPath.split('/').pop() ?? fullPath, text });
          seen.add(resolved);
          queue.push({ identifier: resolved, text });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  dbg('corpus entry loaded', { rel, fullPath, fetchedBytes: fetched.length });
}


