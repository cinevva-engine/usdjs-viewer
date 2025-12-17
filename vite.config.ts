import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import vue from '@vitejs/plugin-vue';
import https from 'node:https';
import http from 'node:http';
import { createHash } from 'node:crypto';

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

// Convert USD to USDA using usdcat with caching
async function convertUsdToUsda(filePath: string, cacheKey: string): Promise<string> {
    // Check cache first
    const cached = getCachedConversion(cacheKey);
    if (cached) {
        return cached;
    }

    // Perform conversion
    return new Promise<string>((resolve, reject) => {
        const usdcat = spawn('usdcat', [filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        usdcat.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        usdcat.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        usdcat.on('close', (code) => {
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

                        // Convert binary USD files (.usdc/.usdz) to USDA text using usdcat with caching
                        if (isBinaryUsd) {
                            try {
                                const cacheKey = getLocalFileCacheKey(abs);
                                const usda = await convertUsdToUsda(abs, cacheKey);
                                res.setHeader('content-type', 'text/plain; charset=utf-8');
                                res.statusCode = 200;
                                res.end(usda);
                            } catch (err) {
                                res.statusCode = 500;
                                res.setHeader('content-type', 'text/plain; charset=utf-8');
                                res.end(`Conversion error: ${(err as any)?.message || err}`);
                            }
                            return;
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
                        const u = new URL(req.url ?? '', 'http://localhost');
                        const targetUrl = u.searchParams.get('url');
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
                        
                        // Fetch the external resource server-side
                        const urlObj = new URL(targetUrl);
                        const client = urlObj.protocol === 'https:' ? https : http;
                        
                        const proxyReq = client.get(targetUrl, async (proxyRes) => {
                            // Forward status code
                            res.statusCode = proxyRes.statusCode ?? 200;
                            
                            // Set CORS headers to allow browser access
                            res.setHeader('access-control-allow-origin', '*');
                            res.setHeader('access-control-allow-methods', 'GET');
                            
                            if (proxyRes.statusCode && proxyRes.statusCode >= 200 && proxyRes.statusCode < 300) {
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
                                            // Convert binary USD to USDA text using usdcat with caching
                                            // Generate cache key from URL and response headers
                                            const etag = proxyRes.headers['etag'];
                                            const lastModified = proxyRes.headers['last-modified'];
                                            const cacheKey = getExternalUrlCacheKey(targetUrl, etag, lastModified);
                                            
                                            // Check cache first
                                            const cached = getCachedConversion(cacheKey);
                                            if (cached) {
                                                res.setHeader('content-type', 'text/plain; charset=utf-8');
                                                res.end(cached);
                                                return;
                                            }
                                            
                                            // Write buffer to temp file, then use usdcat
                                            const tmpDir = path.join(viewerRoot, '.tmp');
                                            if (!fs.existsSync(tmpDir)) {
                                                fs.mkdirSync(tmpDir, { recursive: true });
                                            }
                                            const tmpFile = path.join(tmpDir, `proxy_${Date.now()}_${Math.random().toString(36).substring(7)}.usdc`);
                                            
                                            try {
                                                fs.writeFileSync(tmpFile, buffer);
                                                
                                                await new Promise<void>((resolve, reject) => {
                                                    const usdcat = spawn('usdcat', [tmpFile], { stdio: ['ignore', 'pipe', 'pipe'] });
                                                    let stdout = '';
                                                    let stderr = '';
                                                    
                                                    usdcat.stdout.on('data', (chunk) => {
                                                        stdout += chunk.toString();
                                                    });
                                                    
                                                    usdcat.stderr.on('data', (chunk) => {
                                                        stderr += chunk.toString();
                                                    });
                                                    
                                                    usdcat.on('close', (code) => {
                                                        // Clean up temp file
                                                        try {
                                                            fs.unlinkSync(tmpFile);
                                                        } catch {}
                                                        
                                                        if (code === 0 && stdout) {
                                                            // Cache the result
                                                            setCachedConversion(cacheKey, stdout);
                                                            res.setHeader('content-type', 'text/plain; charset=utf-8');
                                                            res.end(stdout);
                                                            resolve();
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
                                                        } catch {}
                                                        res.statusCode = 500;
                                                        res.setHeader('content-type', 'text/plain; charset=utf-8');
                                                        res.end(`usdcat spawn error: ${err.message}`);
                                                        reject(err);
                                                    });
                                                });
                                            } catch (convertErr) {
                                                try {
                                                    fs.unlinkSync(tmpFile);
                                                } catch {}
                                                res.statusCode = 500;
                                                res.setHeader('content-type', 'text/plain; charset=utf-8');
                                                res.end(`Conversion error: ${(convertErr as any)?.message || convertErr}`);
                                            }
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
                                    res.end(errorBody || `HTTP ${proxyRes.statusCode}`);
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
                        
                        proxyReq.setTimeout(30000, () => {
                            proxyReq.destroy();
                            if (!res.headersSent) {
                                res.statusCode = 504;
                                res.setHeader('content-type', 'text/plain');
                                res.end('Proxy timeout');
                            }
                        });
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


