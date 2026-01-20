import { resolveAssetPath, type SdfLayer } from '@cinevva/usdjs';

// Max binary file size to attempt parsing in the resolver (for composition)
// With optimized clone (SdfPath.primUnsafe), we can handle larger files
const MAX_BINARY_PARSE_SIZE = 200 * 1024 * 1024; // 200MB

// Resolver result - can return text (USDA) or pre-parsed layer (USDC/USDZ)
export type ResolverResult = {
    identifier: string;
    text?: string;
    layer?: SdfLayer;
};

export type TextResolver = {
    readText(assetPath: string, fromIdentifier?: string): Promise<ResolverResult>;
};

export function createTextResolver(opts: {
    externalFiles: Map<string, { name: string; text: string; binary?: ArrayBuffer }>;
    dbg: (...args: any[]) => void;
    /** Base URL for static asset fetching (for static sites without backend) */
    staticAssetBaseUrl?: string;
}): TextResolver {
    const { externalFiles, dbg } = opts;

    const textCache = new Map<string, ResolverResult>();
    const readHits = new Map<string, number>();
    return {
        async readText(assetPath: string, fromIdentifier?: string) {
            // Important: corpus entries are keyed as `[corpus]...` in the viewer, but the USD resolver
            // should operate on the real path. If we keep `[corpus]` in the identifier, resolveAssetPath()
            // will produce unstable/incorrect results and composition may repeatedly reload the same layer
            // under different identifiers (breaking expandArcsInLayer cycle guards).
            const fromId =
                typeof fromIdentifier === 'string' && fromIdentifier.startsWith('[corpus]')
                    ? fromIdentifier.replace('[corpus]', '')
                    : fromIdentifier;

            const resolved = resolveAssetPath(assetPath, fromId);

            // Fast path: avoid repeated string lookups / parsing cascades for the same layer
            const cached = textCache.get(resolved);
            if (cached) return cached;

            // Debug: track resolver churn (re-reading same resolved path is a strong signal of a loop)
            const n = (readHits.get(resolved) ?? 0) + 1;
            readHits.set(resolved, n);
            if (n === 1 || n === 2 || n === 5 || n === 10 || n % 25 === 0) {
                dbg('readText', { n, assetPath, fromIdentifier, fromId, resolved });
            }

            // Check if it's an external URL (http:// or https://)
            const isExternalUrl = resolved.match(/^https?:\/\//);
            if (isExternalUrl) {
                // For external URLs, use the Vite proxy endpoint to avoid CORS issues
                try {
                    const fetchViaProxy = async (bust: boolean): Promise<Response> => {
                        const proxyUrl = `/__usdjs_proxy?url=${encodeURIComponent(resolved)}${bust ? '&bust=1' : ''}`;
                        return await fetch(proxyUrl);
                    };

                    // First attempt (normal cache)
                    let response = await fetchViaProxy(false);
                    if (response.ok) {
                        const contentType = response.headers.get('content-type') || '';
                        // The proxy endpoint converts binary USD files to USDA text, so if we get text/plain, trust it
                        // Only skip if content-type explicitly indicates binary AND it's not text/plain (proxy didn't convert)
                        const isBinaryContentType = contentType.includes('application/octet-stream') && !contentType.includes('text/plain');
                        if (isBinaryContentType) {
                            console.warn(`Skipping external binary USD file (not supported): ${resolved}`);
                            return { identifier: resolved, text: '#usda 1.0\n' };
                        }

                        const text = await response.text();

                        // Validate that it looks like valid USDA text
                        // Check for binary data (non-printable characters in first few bytes)
                        const preview = text.substring(0, Math.min(100, text.length));
                        const hasBinaryChars = Array.from(preview).some((ch, i) => {
                            const code = ch.charCodeAt(0);
                            // Allow common text characters: printable ASCII, tabs, newlines, carriage returns
                            return code < 32 && code !== 9 && code !== 10 && code !== 13;
                        });

                        if (hasBinaryChars) {
                            console.warn(`Skipping external reference (appears to be binary data): ${resolved}`);
                            return { identifier: resolved, text: '#usda 1.0\n' };
                        }

                        // Check if this is MaterialX XML (valid format, not an error page)
                        const { isMaterialXContent } = await import('@cinevva/usdjs');
                        const isMaterialX = isMaterialXContent(text);

                        // Check for HTML error pages (but not MaterialX XML)
                        if (!isMaterialX && text.trim().startsWith('<') && text.includes('<html')) {
                            console.warn(`Skipping external reference (error page instead of USD): ${resolved}`);
                            return { identifier: resolved, text: '#usda 1.0\n' };
                        }

                        // Validate format: should be USDA or MaterialX
                        if (text.trim().length > 0 && !text.trim().startsWith('#usda') && !text.trim().startsWith('#USD') && !isMaterialX) {
                            console.warn(`Skipping external reference (doesn't look like USDA or MaterialX): ${resolved}`);
                            return { identifier: resolved, text: '#usda 1.0\n' };
                        }

                        // For USDA files, check for malformed @path@ references
                        if (!isMaterialX) {
                            // Check for malformed @path@ references (unterminated @)
                            // Count @ characters - should be even (pairs)
                            const atCount = (text.match(/@/g) || []).length;
                            if (atCount % 2 !== 0) {
                                console.warn(`Skipping external reference (malformed @path@ references): ${resolved}`);
                                return { identifier: resolved, text: '#usda 1.0\n' };
                            }

                            // Validate by parsing the *full* text (parsing a truncated prefix is very likely
                            // to fail with "got eof" on otherwise-valid files).
                            try {
                                // Import parseUsdaToLayer dynamically to avoid circular deps
                                const { parseUsdaToLayer } = await import('@cinevva/usdjs');
                                parseUsdaToLayer(text, { identifier: resolved });
                            } catch (parseErr: any) {
                                // If we got an EOF/truncation-style failure, retry once bypassing proxy cache.
                                const msg = String(parseErr?.message ?? parseErr ?? '');
                                const looksTruncated =
                                    msg.includes('got eof') ||
                                    msg.includes('got EOF') ||
                                    msg.includes('Expected "}"') ||
                                    msg.includes('Expected \\"}\\"');
                                if (looksTruncated) {
                                    try {
                                        response = await fetchViaProxy(true);
                                        if (response.ok) {
                                            const retryText = await response.text();
                                            // Re-run the same validation on the retried content.
                                            const { parseUsdaToLayer } = await import('@cinevva/usdjs');
                                            parseUsdaToLayer(retryText, { identifier: resolved });
                                            return { identifier: resolved, text: retryText };
                                        }
                                    } catch {
                                        // fall through to standard skip below
                                    }
                                }
                                // If quick parse fails, the full parse will likely fail too
                                console.warn(`Skipping external reference (parse validation failed): ${resolved}`, parseErr?.message || parseErr);
                                return { identifier: resolved, text: '#usda 1.0\n' };
                            }
                        }

                        return { identifier: resolved, text };
                    }
                    // If fetch succeeded but response wasn't ok, return empty file
                    console.warn(`Skipping external reference (HTTP ${response.status}): ${resolved}`);
                    return { identifier: resolved, text: '#usda 1.0\n' };
                } catch (err) {
                    // External URL not accessible - this is common for Omniverse samples.
                    // Log a warning but don't throw - the scene can still render without the referenced asset.
                    console.warn(`Skipping external reference (not accessible): ${resolved}`, err);
                    // Return empty USD file so composition doesn't fail
                    return { identifier: resolved, text: '#usda 1.0\n' };
                }
            }

            // For local/corpus files, check our externalFiles map
            // Try exact matches for both raw and `[corpus]`-prefixed keys.
            const exact = externalFiles.get(resolved) ?? externalFiles.get(`[corpus]${resolved}`);
            if (exact) {
                // If it's a binary file, parse it natively and return the layer directly
                if (exact.binary) {
                    // Skip very large binary files to avoid memory issues
                    if (exact.binary.byteLength > MAX_BINARY_PARSE_SIZE) {
                        console.warn(`Skipping large binary file (${(exact.binary.byteLength / 1024 / 1024).toFixed(1)}MB > ${MAX_BINARY_PARSE_SIZE / 1024 / 1024}MB limit): ${resolved}`);
                        return { identifier: resolved, text: '#usda 1.0\n' };
                    }
                    try {
                        const data = new Uint8Array(exact.binary);
                        const { parseUsdcToLayer, parseUsdzToLayer, isUsdzContent } = await import('@cinevva/usdjs');

                        let layer;
                        if (isUsdzContent(data)) {
                            layer = await parseUsdzToLayer(data, { identifier: resolved });
                        } else {
                            layer = parseUsdcToLayer(data, { identifier: resolved });
                        }

                        // Return the parsed layer directly - no serialization needed!
                        // NOTE: Don't cache the layer - stage.ts has its own layerCache
                        return { identifier: resolved, layer };
                    } catch (err: any) {
                        console.warn(`Failed to parse binary file ${resolved}:`, err?.message || err);
                        return { identifier: resolved, text: '#usda 1.0\n' };
                    }
                }
                const out = { identifier: resolved, text: exact.text };
                textCache.set(resolved, out);
                return out;
            }
            for (const [k, v] of externalFiles.entries()) {
                // Be tolerant of corpus prefix and varying absolute-ish identifiers.
                if (k.endsWith('/' + resolved) || k.endsWith(resolved) || k.endsWith(`/[corpus]${resolved}`) || k.endsWith(`[corpus]${resolved}`)) {
                    // Handle binary files - parse natively and return layer directly
                    if (v.binary) {
                        // Skip very large binary files to avoid memory issues
                        if (v.binary.byteLength > MAX_BINARY_PARSE_SIZE) {
                            console.warn(`Skipping large binary file (${(v.binary.byteLength / 1024 / 1024).toFixed(1)}MB > ${MAX_BINARY_PARSE_SIZE / 1024 / 1024}MB limit): ${resolved}`);
                            return { identifier: resolved, text: '#usda 1.0\n' };
                        }
                        try {
                            const data = new Uint8Array(v.binary);
                            const { parseUsdcToLayer, parseUsdzToLayer, isUsdzContent } = await import('@cinevva/usdjs');

                            let layer;
                            if (isUsdzContent(data)) {
                                layer = await parseUsdzToLayer(data, { identifier: resolved });
                            } else {
                                layer = parseUsdcToLayer(data, { identifier: resolved });
                            }

                            // Return the parsed layer directly - stage.ts has its own caching
                            return { identifier: resolved, layer };
                        } catch (err: any) {
                            console.warn(`Skipping binary file ${resolved} (parse failed):`, err?.message || err);
                            return { identifier: resolved, text: '#usda 1.0\n' };
                        }
                    }
                    const out = { identifier: resolved, text: v.text };
                    textCache.set(resolved, out);
                    return out;
                }
            }

            // If staticAssetBaseUrl is set, try fetching from static URL
            if (opts.staticAssetBaseUrl) {
                try {
                    // Build static URL from the resolved path
                    let relPath = resolved;
                    // Handle ./relative paths
                    if (relPath.startsWith('./')) {
                        relPath = relPath.slice(2);
                    }
                    
                    const baseUrl = opts.staticAssetBaseUrl.endsWith('/') 
                        ? opts.staticAssetBaseUrl 
                        : opts.staticAssetBaseUrl + '/';
                    const staticUrl = baseUrl + relPath;
                    
                    dbg('Fetching from static URL:', { assetPath, resolved, staticUrl });
                    
                    const response = await fetch(staticUrl);
                    if (response.ok) {
                        const text = await response.text();
                        
                        // Validate it looks like USDA
                        if (text.trim().startsWith('#usda') || text.trim().startsWith('#USD')) {
                            const out = { identifier: resolved, text };
                            textCache.set(resolved, out);
                            return out;
                        }
                        
                        // Check for binary USD (USDC)
                        if (text.substring(0, 8).includes('PXR-USDC')) {
                            // For binary files, we need to re-fetch as ArrayBuffer
                            const binaryResponse = await fetch(staticUrl);
                            const binary = await binaryResponse.arrayBuffer();
                            const data = new Uint8Array(binary);
                            const { parseUsdcToLayer } = await import('@cinevva/usdjs');
                            const layer = parseUsdcToLayer(data, { identifier: resolved });
                            return { identifier: resolved, layer };
                        }
                        
                        console.warn(`Static file doesn't look like USD: ${staticUrl}`);
                    } else {
                        dbg('Static fetch failed:', { staticUrl, status: response.status });
                    }
                } catch (err) {
                    dbg('Static fetch error:', { assetPath, resolved, err });
                }
            }

            // Only throw errors for local files that should exist
            throw new Error(`Resolver missing: ${assetPath} (resolved=${resolved})`);
        },
    };
}


