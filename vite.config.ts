import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import vue from '@vitejs/plugin-vue';
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';

// Default proxy timeout: 3 minutes (S3 HDRs can be slow and should not be cut off at 30s).
// Override via env: USDJS_PROXY_TIMEOUT_MS=...
const USDJS_PROXY_TIMEOUT_MS = Number(process.env.USDJS_PROXY_TIMEOUT_MS ?? 180_000);

// Feature flag: Use usdcat as fallback for binary USD conversion
// Can be controlled via:
// 1. Environment variable: USE_USDCAT_FALLBACK=false
// 2. URL parameter: ?usdcat_fallback=false (overrides env var)
// Defaults to true (usdcat fallback enabled)
function getUseUsdcatFallback(req?: any): boolean {
    // Check URL parameter first (client-side control)
    if (req?.url) {
        try {
            const url = new URL(req.url, 'http://localhost');
            const param = url.searchParams.get('usdcat_fallback');
            if (param !== null) {
                return param !== 'false' && param !== '0';
            }
        } catch {
            // Ignore URL parsing errors
        }
    }
    // Fall back to environment variable
    return process.env.USE_USDCAT_FALLBACK !== 'false';
}

const viewerRoot = path.dirname(fileURLToPath(import.meta.url));
const usdjsRoot = path.resolve(viewerRoot, '../usdjs');
const cacheDir = path.join(viewerRoot, '.cache', 'usd-conversions');

// Ensure cache directory exists
if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
}

// Cache for USD to USDA conversions
interface CacheEntry {
    usda: string;
    timestamp: number;
}

// In-memory cache for quick access
const conversionCache = new Map<string, CacheEntry>();

// Generate cache key for local file based on path and modification time
function getLocalFileCacheKey(filePath: string): string {
    try {
        const stats = fs.statSync(filePath);
        const key = `${filePath}:${stats.mtimeMs}:${stats.size}`;
        return createHash('sha256').update(key).digest('hex');
    } catch {
        // Fallback if stat fails
        return createHash('sha256').update(filePath).digest('hex');
    }
}

// Generate cache key for external URL based on URL and optional ETag/last-modified
function getExternalUrlCacheKey(url: string, etag?: string, lastModified?: string): string {
    const key = `${url}:${etag || ''}:${lastModified || ''}`;
    return createHash('sha256').update(key).digest('hex');
}

// Get cache file path
function getCacheFilePath(cacheKey: string): string {
    return path.join(cacheDir, `${cacheKey}.usda`);
}

// Read from cache (both memory and disk)
function getCachedConversion(cacheKey: string): string | null {
    // Check in-memory cache first
    const memEntry = conversionCache.get(cacheKey);
    if (memEntry) {
        return memEntry.usda;
    }

    // Check disk cache
    const cacheFile = getCacheFilePath(cacheKey);
    try {
        if (fs.existsSync(cacheFile)) {
            const usda = fs.readFileSync(cacheFile, 'utf8');
            // Also store in memory cache for faster subsequent access
            conversionCache.set(cacheKey, { usda, timestamp: Date.now() });
            return usda;
        }
    } catch (err) {
        // Log error but don't fail the request - will fall back to conversion
        console.warn(`Failed to read cache file for ${cacheKey}:`, err);
    }

    return null;
}

// Store conversion result in cache (both memory and disk)
function setCachedConversion(cacheKey: string, usda: string): void {
    // Store in memory cache
    conversionCache.set(cacheKey, { usda, timestamp: Date.now() });

    // Store in disk cache
    try {
        // Ensure cache directory exists
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }
        const cacheFile = getCacheFilePath(cacheKey);
        fs.writeFileSync(cacheFile, usda, 'utf8');
    } catch (err) {
        // Log error but don't fail the request
        console.warn(`Failed to write cache file for ${cacheKey}:`, err);
    }
}

// Max output size for usdcat (100MB should be more than enough for any reasonable USD file)
const MAX_USDCAT_OUTPUT_SIZE = 100 * 1024 * 1024;

// Max input file size for usdcat conversion (skip conversion for very large files to avoid memory issues)
// Files larger than this will be served as binary for native parsing
const MAX_USDCAT_INPUT_SIZE = 50 * 1024 * 1024; // 50MB

// Convert external USD file to USDA using usdcat (helper for proxy endpoint)
async function convertExternalUsdToUsda(tmpFile: string, cacheKey: string, res: any): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const usdcat = spawn('usdcat', [tmpFile], { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdoutChunks: Buffer[] = [];
        let stdoutSize = 0;
        let stderr = '';
        let killed = false;

        usdcat.stdout.on('data', (chunk: Buffer) => {
            if (killed) return;
            stdoutSize += chunk.length;
            if (stdoutSize > MAX_USDCAT_OUTPUT_SIZE) {
                killed = true;
                usdcat.kill();
                return;
            }
            stdoutChunks.push(chunk);
        });

        usdcat.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        usdcat.on('close', (code) => {
            // Clean up temp file
            try {
                fs.unlinkSync(tmpFile);
            } catch { }

            if (killed) {
                res.statusCode = 413;
                res.setHeader('content-type', 'text/plain; charset=utf-8');
                res.end(`usdcat output exceeded ${MAX_USDCAT_OUTPUT_SIZE} bytes limit`);
                reject(new Error('usdcat output too large'));
                return;
            }

            const stdout = Buffer.concat(stdoutChunks).toString('utf8');

            if (code === 0 && stdout) {
                // Defensive: usdcat output should be valid USDA. If we cache a truncated/corrupt
                // conversion, the viewer will "drop" the external reference during validation.
                import('@cinevva/usdjs')
                    .then(({ parseUsdaToLayer }) => {
                        try {
                            parseUsdaToLayer(stdout, { identifier: tmpFile });
                        } catch (parseErr: any) {
                            res.statusCode = 500;
                            res.setHeader('content-type', 'text/plain; charset=utf-8');
                            res.end(
                                `usdcat produced invalid USDA (will not cache): ${parseErr?.message || parseErr}\n` +
                                `stderr:\n${stderr || ''}`
                            );
                            reject(parseErr);
                            return;
                        }

                        // Cache the result
                        setCachedConversion(cacheKey, stdout);
                        res.setHeader('content-type', 'text/plain; charset=utf-8');
                        res.end(stdout);
                        resolve();
                    })
                    .catch((importErr) => {
                        res.statusCode = 500;
                        res.setHeader('content-type', 'text/plain; charset=utf-8');
                        res.end(`Failed to load usdjs for validation: ${(importErr as any)?.message || importErr}`);
                        reject(importErr);
                    });
            } else {
                res.statusCode = 500;
                res.setHeader('content-type', 'text/plain; charset=utf-8');
                res.end(`usdcat failed (exit ${code}): ${stderr || 'unknown error'}`);
                reject(new Error(`usdcat failed: ${stderr}`));
            }
        });

        usdcat.on('error', (err) => {
            try {
                fs.unlinkSync(tmpFile);
            } catch { }
            res.statusCode = 500;
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            res.end(`usdcat spawn error: ${err.message}`);
            reject(err);
        });
    });
}

// Convert binary USD to USDA using our parser (primary) or usdcat (fallback)
async function convertUsdToUsda(filePath: string, cacheKey: string, useUsdcatFallback: boolean = true): Promise<string> {
    // Check cache first
    const cached = getCachedConversion(cacheKey);
    if (cached) {
        return cached;
    }

    // Try parsing with our USDC/USDZ parser first (primary method)
    try {
        const buffer = fs.readFileSync(filePath);
        const data = new Uint8Array(buffer);

        // Check if it's USDC or USDZ
        const isUsdc = data.length >= 8 &&
            data[0] === 0x50 && data[1] === 0x58 && data[2] === 0x52 && data[3] === 0x2D &&
            data[4] === 0x55 && data[5] === 0x53 && data[6] === 0x44 && data[7] === 0x43;

        const isUsdz = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4B;

        if (isUsdc || isUsdz) {
            // Parse using our parser to validate
            const { parseUsdcToLayer, parseUsdzToLayer, isUsdcContent, isUsdzContent } = await import('@cinevva/usdjs');

            if (isUsdc) {
                // Validate USDC parsing works
                parseUsdcToLayer(data, { identifier: filePath });
            } else if (isUsdz) {
                // Validate USDZ parsing works
                await parseUsdzToLayer(data, { identifier: filePath });
            }

            // If parsing succeeds, use usdcat to convert to USDA text
            // (We don't have a USDA serializer yet, so we use usdcat for the conversion)
            // This validates the file with our parser but uses usdcat for output
            if (useUsdcatFallback) {
                return await convertUsdToUsdaWithUsdcat(filePath, cacheKey);
            } else {
                throw new Error('USDC/USDZ parser validation passed but USDA serialization not yet implemented. Enable usdcat_fallback URL parameter for conversion.');
            }
        }
    } catch (parseErr: any) {
        // If our parser fails, fall back to usdcat if enabled
        if (useUsdcatFallback) {
            console.warn(`USDC/USDZ parser failed for ${filePath}, falling back to usdcat:`, parseErr.message);
            return await convertUsdToUsdaWithUsdcat(filePath, cacheKey);
        } else {
            throw new Error(`USDC/USDZ parser failed: ${parseErr.message}`);
        }
    }

    // If not binary USD, fall back to usdcat
    if (useUsdcatFallback) {
        return await convertUsdToUsdaWithUsdcat(filePath, cacheKey);
    } else {
        throw new Error('File is not binary USD format and usdcat fallback is disabled');
    }
}

// Convert USD to USDA using usdcat (fallback method)
async function convertUsdToUsdaWithUsdcat(filePath: string, cacheKey: string): Promise<string> {
    // Check cache first
    const cached = getCachedConversion(cacheKey);
    if (cached) {
        return cached;
    }

    // Perform conversion using usdcat
    return new Promise<string>((resolve, reject) => {
        const usdcat = spawn('usdcat', [filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
        const stdoutChunks: Buffer[] = [];
        let stdoutSize = 0;
        let stderr = '';
        let killed = false;

        usdcat.stdout.on('data', (chunk: Buffer) => {
            if (killed) return;
            stdoutSize += chunk.length;
            if (stdoutSize > MAX_USDCAT_OUTPUT_SIZE) {
                killed = true;
                usdcat.kill();
                return;
            }
            stdoutChunks.push(chunk);
        });

        usdcat.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        usdcat.on('close', (code) => {
            if (killed) {
                reject(new Error(`usdcat output exceeded ${MAX_USDCAT_OUTPUT_SIZE} bytes limit`));
                return;
            }
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            if (code === 0 && stdout) {
                // Cache the result
                setCachedConversion(cacheKey, stdout);
                resolve(stdout);
            } else {
                reject(new Error(`usdcat failed (exit ${code}): ${stderr || 'unknown error'}`));
            }
        });

        usdcat.on('error', (err) => {
            reject(new Error(`usdcat spawn error: ${err.message}`));
        });
    });
}

export default defineConfig({
    resolve: {
        // For HMR: resolve @cinevva/usdjs to source TypeScript instead of dist
        // This allows Vite to compile TypeScript on-the-fly and enable HMR
        alias: {
            '@cinevva/usdjs': path.resolve(usdjsRoot, 'src/index.ts'),
        },
    },
    plugins: [
        vue(),
        {
            name: 'usdjs-corpus-server',
            configureServer(server) {

                server.middlewares.use('/__usdjs_corpus', async (req, res) => {
                    try {
                        // Check URL parameter for usdcat fallback control
                        const useUsdcatFallback = getUseUsdcatFallback(req);

                        const looksLikeUsdc = (absPath: string): boolean => {
                            // `.usd` files can be either ASCII USDA or binary USDC.
                            // Binary USDC files start with the magic bytes `PXR-USDC`.
                            try {
                                const fd = fs.openSync(absPath, 'r');
                                try {
                                    const buf = Buffer.alloc(8);
                                    const n = fs.readSync(fd, buf, 0, buf.length, 0);
                                    const head = buf.subarray(0, n).toString('ascii');
                                    return head.startsWith('PXR-USDC');
                                } finally {
                                    fs.closeSync(fd);
                                }
                            } catch {
                                return false;
                            }
                        };

                        const u = new URL(req.url ?? '', 'http://localhost');
                        const rel = u.searchParams.get('file');
                        if (!rel) {
                            res.statusCode = 400;
                            res.end('missing ?file=');
                            return;
                        }

                        // Only allow reads under packages/usdjs/.
                        const abs = path.resolve(usdjsRoot, rel);
                        const normalizedUsdjsRoot = path.normalize(usdjsRoot);
                        const normalizedAbs = path.normalize(abs);
                        if (!normalizedAbs.startsWith(normalizedUsdjsRoot)) {
                            res.statusCode = 403;
                            res.end(`forbidden: ${rel} (resolved to ${abs}, root=${usdjsRoot})`);
                            return;
                        }
                        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
                            res.statusCode = 404;
                            res.end(`not found: ${rel} (resolved to ${abs})`);
                            return;
                        }

                        const ext = path.extname(abs).toLowerCase();
                        // Note: `.usd` can be text (USDA) or binary (USDC). Auto-detect by header.
                        const isBinaryUsd = ext === '.usdc' || ext === '.usdz' || (ext === '.usd' && looksLikeUsdc(abs));
                        const isTextUsd = ext === '.usda' || (ext === '.usd' && !isBinaryUsd);
                        const isOtherText = ext === '.txt' || ext === '.json';
                        const isMaterialX = ext === '.mtlx';

                        // Serve binary USD files (.usdc/.usdz) as binary - let client parse natively
                        if (isBinaryUsd) {
                            try {
                                // Validate with our parser first (but don't convert to text)
                                const buffer = fs.readFileSync(abs);
                                const data = new Uint8Array(buffer);

                                const isUsdc = data.length >= 8 &&
                                    data[0] === 0x50 && data[1] === 0x58 && data[2] === 0x52 && data[3] === 0x2D &&
                                    data[4] === 0x55 && data[5] === 0x53 && data[6] === 0x44 && data[7] === 0x43;

                                const isUsdz = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4B;

                                if (isUsdc || isUsdz) {
                                    // For very large files, skip validation and conversion - serve as binary directly
                                    // This avoids memory issues with 100MB+ USD files
                                    if (buffer.length > MAX_USDCAT_INPUT_SIZE) {
                                        console.log(`Large binary USD file (${(buffer.length / 1024 / 1024).toFixed(1)}MB), serving as binary: ${abs}`);
                                        res.setHeader('content-type', isUsdz ? 'model/vnd.usdz+zip' : 'application/x-usdc');
                                        res.setHeader('x-usd-format', isUsdz ? 'usdz' : 'usdc');
                                        res.statusCode = 200;
                                        res.end(buffer);
                                        return;
                                    }

                                    // Validate parsing works (but don't convert)
                                    const { parseUsdcToLayer, parseUsdzToLayer } = await import('@cinevva/usdjs');
                                    if (isUsdc) {
                                        parseUsdcToLayer(data, { identifier: abs });
                                    } else {
                                        await parseUsdzToLayer(data, { identifier: abs });
                                    }
                                    // Check if URL parameter forces text conversion via usdcat
                                    if (useUsdcatFallback) {
                                        // User requested usdcat fallback - convert to text even though parser succeeded
                                        const cacheKey = getLocalFileCacheKey(abs);
                                        const usda = await convertUsdToUsdaWithUsdcat(abs, cacheKey);
                                        res.setHeader('content-type', 'text/plain; charset=utf-8');
                                        res.statusCode = 200;
                                        res.end(usda);
                                        return;
                                    } else {
                                        // Parser validation passed - serve as binary for native loading
                                        res.setHeader('content-type', isUsdz ? 'model/vnd.usdz+zip' : 'application/x-usdc');
                                        res.setHeader('x-usd-format', isUsdz ? 'usdz' : 'usdc');
                                        res.statusCode = 200;
                                        res.end(buffer);
                                        return;
                                    }
                                }

                                // If not USDC/USDZ but marked as binary, fall back to conversion
                                if (useUsdcatFallback) {
                                    const cacheKey = getLocalFileCacheKey(abs);
                                    const usda = await convertUsdToUsdaWithUsdcat(abs, cacheKey);
                                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                                    res.statusCode = 200;
                                    res.end(usda);
                                    return;
                                } else {
                                    throw new Error('Binary USD file format not recognized');
                                }
                            } catch (err) {
                                // If parser validation fails, fall back to conversion if enabled
                                if (useUsdcatFallback) {
                                    try {
                                        const cacheKey = getLocalFileCacheKey(abs);
                                        const usda = await convertUsdToUsdaWithUsdcat(abs, cacheKey);
                                        res.setHeader('content-type', 'text/plain; charset=utf-8');
                                        res.statusCode = 200;
                                        res.end(usda);
                                        return;
                                    } catch (convertErr) {
                                        res.statusCode = 500;
                                        res.setHeader('content-type', 'text/plain; charset=utf-8');
                                        res.end(`Conversion error: ${(convertErr as any)?.message || convertErr}`);
                                        return;
                                    }
                                } else {
                                    res.statusCode = 500;
                                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                                    res.end(`Parser error: ${(err as any)?.message || err}`);
                                    return;
                                }
                            }
                        }

                        // MaterialX files (.mtlx) - XML-based material files
                        if (isMaterialX) {
                            const text = fs.readFileSync(abs, 'utf8');
                            res.setHeader('content-type', 'application/xml; charset=utf-8');
                            res.statusCode = 200;
                            res.end(text);
                            return;
                        }

                        // Text USD files (.usda/.usd) and other text files
                        if (isTextUsd || isOtherText) {
                            const text = fs.readFileSync(abs, 'utf8');
                            res.setHeader('content-type', 'text/plain; charset=utf-8');
                            res.statusCode = 200;
                            res.end(text);
                            return;
                        }

                        // Binary assets (textures, etc.)
                        const buf = fs.readFileSync(abs);
                        const mime =
                            ext === '.png'
                                ? 'image/png'
                                : ext === '.jpg' || ext === '.jpeg'
                                    ? 'image/jpeg'
                                    : ext === '.webp'
                                        ? 'image/webp'
                                        : ext === '.gif'
                                            ? 'image/gif'
                                            : ext === '.hdr'
                                                ? 'application/octet-stream'
                                                : ext === '.exr'
                                                    ? 'application/octet-stream'
                                                    : 'application/octet-stream';
                        res.setHeader('content-type', mime);
                        res.statusCode = 200;
                        res.end(buf);
                    } catch (e) {
                        res.statusCode = 500;
                        res.end(String((e as any)?.message ?? e));
                    }
                });

                // Proxy endpoint for external resources (avoids CORS issues)
                server.middlewares.use('/__usdjs_proxy', async (req, res) => {
                    try {
                        // Check URL parameter for usdcat fallback control
                        const useUsdcatFallback = getUseUsdcatFallback(req);

                        const u = new URL(req.url ?? '', 'http://localhost');
                        const targetUrl = u.searchParams.get('url');
                        const bust = u.searchParams.get('bust');
                        if (!targetUrl) {
                            res.statusCode = 400;
                            res.end('missing ?url=');
                            return;
                        }

                        // Validate that it's an external URL
                        if (!targetUrl.match(/^https?:\/\//)) {
                            res.statusCode = 400;
                            res.end('url must be http:// or https://');
                            return;
                        }

                        // Check if this is a USD file that might need conversion
                        const urlLower = targetUrl.toLowerCase();
                        const isUsdFile = urlLower.endsWith('.usd') || urlLower.endsWith('.usdc') || urlLower.endsWith('.usdz');

                        // Fetch the external resource server-side (avoid CORS issues), follow redirects, and
                        // use a longer timeout so large textures/HDRs don't randomly fail.
                        const maxRedirects = 5;

                        const startRequest = (urlToGet: string, redirectsLeft: number) => {
                            const urlObj = new URL(urlToGet);
                            const client = urlObj.protocol === 'https:' ? https : http;

                            const proxyReq = client.get(urlToGet, async (proxyRes) => {
                                const status = proxyRes.statusCode ?? 200;

                                // Handle redirects (common with CDN/S3).
                                if (status >= 300 && status < 400 && proxyRes.headers.location && redirectsLeft > 0) {
                                    const nextUrl = new URL(proxyRes.headers.location, urlToGet).toString();
                                    proxyRes.resume(); // discard body
                                    startRequest(nextUrl, redirectsLeft - 1);
                                    return;
                                }

                                // Set CORS headers to allow browser access
                                res.setHeader('access-control-allow-origin', '*');
                                res.setHeader('access-control-allow-methods', 'GET');
                                res.statusCode = status;

                                if (status >= 200 && status < 300) {
                                    // For USD files, we need to check if they're binary and convert them
                                    if (isUsdFile) {
                                        // Buffer the entire response to check if it's binary
                                        const chunks: Buffer[] = [];
                                        proxyRes.on('data', (chunk: Buffer) => {
                                            chunks.push(chunk);
                                        });

                                        proxyRes.on('end', async () => {
                                            const buffer = Buffer.concat(chunks);
                                            const contentType = proxyRes.headers['content-type'] || '';

                                            // Check if it's binary: content-type indicates binary OR first bytes are binary
                                            const isBinary = contentType.includes('application/octet-stream') ||
                                                urlLower.endsWith('.usdc') ||
                                                urlLower.endsWith('.usdz') ||
                                                (buffer.length > 0 && (buffer[0] === 0x50 && buffer[1] === 0x58 && buffer[2] === 0x52)); // PXR magic bytes

                                            // Also check if it doesn't start with #usda (text format)
                                            const textStart = buffer.subarray(0, Math.min(100, buffer.length)).toString('utf8');
                                            const looksLikeText = textStart.trim().startsWith('#usda') || textStart.trim().startsWith('#USD');

                                            if (isBinary || !looksLikeText) {
                                                // Convert binary USD to USDA text using our parser (primary) or usdcat (fallback)
                                                // Generate cache key from URL and response headers
                                                const etag = proxyRes.headers['etag'];
                                                const lastModified = proxyRes.headers['last-modified'];
                                                const cacheKey = getExternalUrlCacheKey(targetUrl, etag, lastModified);

                                                // Check cache first
                                                if (!bust) {
                                                    const cached = getCachedConversion(cacheKey);
                                                    if (cached) {
                                                        res.setHeader('content-type', 'text/plain; charset=utf-8');
                                                        res.end(cached);
                                                        return;
                                                    }
                                                }

                                                // Write buffer to temp file, then convert
                                                const tmpDir = path.join(viewerRoot, '.tmp');
                                                if (!fs.existsSync(tmpDir)) {
                                                    fs.mkdirSync(tmpDir, { recursive: true });
                                                }
                                                const tmpFile = path.join(tmpDir, `proxy_${Date.now()}_${Math.random().toString(36).substring(7)}.usdc`);

                                                try {
                                                    fs.writeFileSync(tmpFile, buffer);

                                                    // Try parsing with our parser first
                                                    try {
                                                        const data = new Uint8Array(buffer);
                                                        const isUsdc = data.length >= 8 &&
                                                            data[0] === 0x50 && data[1] === 0x58 && data[2] === 0x52 && data[3] === 0x2D &&
                                                            data[4] === 0x55 && data[5] === 0x53 && data[6] === 0x44 && data[7] === 0x43;

                                                        const isUsdz = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4B;

                                                        if (isUsdc || isUsdz) {
                                                            // Validate with our parser
                                                            const { parseUsdcToLayer, parseUsdzToLayer } = await import('@cinevva/usdjs');
                                                            if (isUsdc) {
                                                                parseUsdcToLayer(data, { identifier: targetUrl });
                                                            } else {
                                                                await parseUsdzToLayer(data, { identifier: targetUrl });
                                                            }
                                                            // Parser validation passed - use usdcat for conversion if enabled
                                                            if (useUsdcatFallback) {
                                                                await convertExternalUsdToUsda(tmpFile, cacheKey, res);
                                                            } else {
                                                                throw new Error('USDC/USDZ parser validation passed but USDA serialization not yet implemented. Add ?usdcat_fallback=true to URL to enable conversion.');
                                                            }
                                                        } else {
                                                            // Not binary USD, use usdcat if enabled
                                                            if (useUsdcatFallback) {
                                                                await convertExternalUsdToUsda(tmpFile, cacheKey, res);
                                                            } else {
                                                                throw new Error('File is not binary USD format and usdcat fallback is disabled. Add ?usdcat_fallback=true to URL.');
                                                            }
                                                        }
                                                    } catch (parseErr: any) {
                                                        // If our parser fails, fall back to usdcat if enabled
                                                        if (useUsdcatFallback) {
                                                            console.warn(`USDC/USDZ parser failed for ${targetUrl}, falling back to usdcat:`, parseErr.message);
                                                            await convertExternalUsdToUsda(tmpFile, cacheKey, res);
                                                        } else {
                                                            throw parseErr;
                                                        }
                                                    }
                                                } catch (convertErr) {
                                                    try {
                                                        fs.unlinkSync(tmpFile);
                                                    } catch { }
                                                    res.statusCode = 500;
                                                    res.setHeader('content-type', 'text/plain; charset=utf-8');
                                                    res.end(`Conversion error: ${(convertErr as any)?.message || convertErr}`);
                                                    return;
                                                }
                                                return;
                                            } else {
                                                // It's already text USDA, send as-is
                                                res.setHeader('content-type', 'text/plain; charset=utf-8');
                                                res.end(buffer.toString('utf8'));
                                            }
                                        });
                                    } else {
                                        // Not a USD file, stream as-is
                                        const headersToForward = ['content-type', 'content-length', 'content-encoding'];
                                        for (const header of headersToForward) {
                                            const value = proxyRes.headers[header];
                                            if (value) {
                                                res.setHeader(header, value);
                                            }
                                        }
                                        proxyRes.pipe(res);
                                    }
                                } else {
                                    // Non-2xx status - send error
                                    let errorBody = '';
                                    proxyRes.on('data', (chunk) => {
                                        errorBody += chunk.toString();
                                    });
                                    proxyRes.on('end', () => {
                                        res.end(errorBody || `HTTP ${status}`);
                                    });
                                }
                            });

                            proxyReq.on('error', (err) => {
                                if (!res.headersSent) {
                                    res.statusCode = 502;
                                    res.setHeader('content-type', 'text/plain');
                                    res.end(`Proxy error: ${err.message}`);
                                }
                            });

                            proxyReq.setTimeout(USDJS_PROXY_TIMEOUT_MS, () => {
                                proxyReq.destroy();
                                if (!res.headersSent) {
                                    res.statusCode = 504;
                                    res.setHeader('content-type', 'text/plain');
                                    res.end(`Proxy timeout after ${USDJS_PROXY_TIMEOUT_MS}ms`);
                                }
                            });
                        };

                        startRequest(targetUrl, maxRedirects);
                    } catch (e) {
                        res.statusCode = 500;
                        res.end(String((e as any)?.message ?? e));
                    }
                });
            },
        },
    ],
    optimizeDeps: {
        // Monaco's ESM + `?worker` can confuse Vite's dep optimizer; exclude to keep it stable in dev.
        exclude: [
            'monaco-editor',
            'monaco-editor/esm/vs/editor/editor.api',
            'monaco-editor/esm/vs/editor/editor.worker',
        ],
    },
    server: {
        port: 5178,
    },
});


