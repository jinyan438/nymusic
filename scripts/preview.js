const http = require('node:http');
const { createReadStream } = require('node:fs');
const { stat } = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { QQ_ENDPOINTS } = require('../www/js/qq-music-api');
const { handleQqLogin } = require('./qq-login-proxy');

const webRoot = path.resolve(__dirname, '../www');
const apiEndpoints = new Set(Object.values(QQ_ENDPOINTS));
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };

function allowedTarget(url, media) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return false;
    if (!media) return apiEndpoints.has(`${url.origin}${url.pathname}`);
    return url.hostname === 'y.gtimg.cn' || url.hostname.endsWith('.stream.qqmusic.qq.com') || url.hostname === 'aqqmusic.tc.qq.com';
}

function createPreviewServer({ fetchImpl = fetch } = {}) {
    return http.createServer(async (request, response) => {
        try {
            if (new URL(request.url, 'http://localhost').pathname === '/api/qq-login') {
                await handleQqLogin(request, response, fetchImpl);
                return;
            }
            if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
            const location = new URL(request.url, 'http://localhost');
            if (location.pathname === '/api/qq' || location.pathname === '/api/qq-media') {
                const media = location.pathname === '/api/qq-media';
                let target;
                try { target = new URL(location.searchParams.get('url')); }
                catch (_) { response.writeHead(400).end('Invalid QQ URL'); return; }
                if (!allowedTarget(target, media)) { response.writeHead(403).end('Unsupported QQ URL'); return; }
                const headers = { Referer: 'https://y.qq.com/' };
                if (media && request.headers.range) headers.Range = request.headers.range;
                if (!media && request.headers['x-qq-cookie']) headers.Cookie = request.headers['x-qq-cookie'];
                let upstream;
                for (let redirects = 0; redirects <= 5; redirects++) {
                    upstream = await fetchImpl(target, { headers, method: request.method, redirect: 'manual', signal: AbortSignal.timeout(20000) });
                    if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
                    await upstream.body?.cancel();
                    const nextLocation = upstream.headers.get('location');
                    if (!nextLocation) throw new Error('Missing redirect');
                    target = new URL(nextLocation, target);
                    if (!allowedTarget(target, media) || redirects === 5) throw new Error('Unsupported redirect');
                }
                const resultHeaders = { 'Cache-Control': 'no-store' };
                for (const key of ['content-type', 'content-range', 'accept-ranges']) {
                    if (upstream.headers.has(key)) resultHeaders[key] = upstream.headers.get(key);
                }
                response.writeHead(upstream.status, resultHeaders);
                if (!upstream.body || request.method === 'HEAD') { response.end(); return; }
                const stream = Readable.fromWeb(upstream.body);
                stream.on('error', () => response.destroy());
                response.on('close', () => stream.destroy());
                stream.pipe(response);
                return;
            }
            const pathname = decodeURIComponent(location.pathname);
            const filename = path.resolve(webRoot, pathname === '/' ? 'index.html' : `.${pathname}`);
            const relative = path.relative(webRoot, filename);
            if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403).end(); return; }
            const file = await stat(filename).catch(() => null);
            if (!file?.isFile()) { response.writeHead(404).end('Not found'); return; }
            response.writeHead(200, { 'Content-Type': contentTypes[path.extname(filename)] || 'application/octet-stream', 'Content-Length': file.size });
            if (request.method === 'HEAD') response.end();
            else createReadStream(filename).on('error', () => response.destroy()).pipe(response);
        } catch (_) {
            if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }).end('QQ 音乐请求失败，请稍后重试');
            else response.destroy();
        }
    });
}

if (require.main === module) {
    const port = Number(process.env.PORT || 8080);
    const server = createPreviewServer();
    server.on('error', error => { console.error(`预览启动失败：${error.message}`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`牛音播放器：http://localhost:${port}`));
}

module.exports = { createPreviewServer, allowedTarget };
