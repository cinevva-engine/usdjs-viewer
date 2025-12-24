import { extractAssetStrings } from './usdParse';

export function extractDependencies(layer: any): string[] {
    const out: string[] = [];
    const sub = layer.metadata?.subLayers;
    out.push(...extractAssetStrings(sub));

    const prims: any[] = [];
    const walk = (p: any) => {
        prims.push(p);
        if (p.children) {
            for (const c of p.children.values()) walk(c);
        }
        // Also walk into variantSets - they contain variant-specific prims with their own references
        if (p.variantSets) {
            for (const variantSet of p.variantSets.values()) {
                if (variantSet.variants) {
                    for (const variantPrim of variantSet.variants.values()) {
                        walk(variantPrim);
                    }
                }
            }
        }
    };
    walk(layer.root);

    for (const p of prims) {
        if (!p.metadata) continue;
        out.push(...extractAssetStrings(p.metadata.references));
        out.push(...extractAssetStrings(p.metadata.payload));
    }
    return out.filter(Boolean);
}

export async function fetchCorpusFile(rel: string): Promise<string | ArrayBuffer> {
    // Check URL parameter for usdcat fallback control
    const urlParams = new URLSearchParams(window.location.search);
    const usdcatFallback = urlParams.get('usdcat_fallback');

    // Build URL with file parameter and optionally usdcat_fallback parameter
    const params = new URLSearchParams({ file: rel });
    if (usdcatFallback !== null) {
        params.set('usdcat_fallback', usdcatFallback);
    }

    const url = `/__usdjs_corpus?${params.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Corpus fetch failed (${res.status} ${res.statusText}): ${rel} - ${text}`);
    }

    // Check if this is a binary USD file (USDC/USDZ)
    const contentType = res.headers.get('content-type') || '';
    const usdFormat = res.headers.get('x-usd-format');

    if (usdFormat === 'usdc' || usdFormat === 'usdz' ||
        contentType.includes('application/x-usdc') ||
        contentType.includes('model/vnd.usdz')) {
        // Return as ArrayBuffer for native binary parsing
        return await res.arrayBuffer();
    }

    // Otherwise return as text (USDA)
    return await res.text();
}


