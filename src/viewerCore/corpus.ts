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

export async function fetchCorpusFile(rel: string): Promise<string> {
    const url = `/__usdjs_corpus?file=${encodeURIComponent(rel)}`;
    const res = await fetch(url);
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Corpus fetch failed (${res.status} ${res.statusText}): ${rel} - ${text}`);
    }
    return await res.text();
}


