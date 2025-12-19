export function createCorpusHashHelpers(opts: {
    corpusPathPrefix: string;
    hashPrefixCorpus: string;
}): {
    normalizeCorpusPathForHash: (rel: string) => string;
    normalizeCorpusPathForFetch: (rel: string) => string;
    setCorpusHash: (rel: string | null) => void;
    readCorpusHash: () => string | null;
} {
    const { corpusPathPrefix: CORPUS_PATH_PREFIX, hashPrefixCorpus: HASH_PREFIX_CORPUS } = opts;

    const normalizeCorpusPathForHash = (rel: string): string => {
        // Ensure path starts with packages/usdjs/ for hash storage
        if (rel.startsWith(CORPUS_PATH_PREFIX)) {
            return rel;
        }
        return `${CORPUS_PATH_PREFIX}${rel}`;
    };

    const normalizeCorpusPathForFetch = (rel: string): string => {
        // Strip packages/usdjs/ prefix if present, since fetchCorpusFile expects relative paths
        if (rel.startsWith(CORPUS_PATH_PREFIX)) {
            return rel.slice(CORPUS_PATH_PREFIX.length);
        }
        return rel;
    };

    const setCorpusHash = (rel: string | null) => {
        try {
            const nextHash = rel ? `${HASH_PREFIX_CORPUS}${normalizeCorpusPathForHash(rel)}` : '';
            const url = new URL(window.location.href);
            url.hash = nextHash;
            history.replaceState(null, '', url);
        } catch {
            // ignore
        }
    };

    const readCorpusHash = (): string | null => {
        const h = window.location.hash ?? '';
        if (!h.startsWith(HASH_PREFIX_CORPUS)) return null;
        const raw = h.slice(HASH_PREFIX_CORPUS.length);
        if (!raw) return null;
        let decoded = raw;
        if (raw.includes('%')) {
            try {
                decoded = decodeURIComponent(raw);
            } catch {
                decoded = raw;
            }
        }
        // Return the full path as stored in hash (may or may not have packages/usdjs/ prefix for backward compatibility)
        return decoded;
    };

    return { normalizeCorpusPathForHash, normalizeCorpusPathForFetch, setCorpusHash, readCorpusHash };
}


