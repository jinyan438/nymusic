const { qqLoginTargetAllowed, QQ_LOGIN_ENDPOINTS } = require('../www/js/qq-login-api');

async function readJson(request) {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
        length += chunk.length;
        if (length > 128 * 1024) throw new Error('Request too large');
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function handleQqLogin(request, response, fetchImpl) {
    const reply = (status, value) => response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'
    }).end(JSON.stringify(value));
    if (request.method !== 'POST') { reply(405, { error: 'Method not allowed' }); return; }
    if (!request.headers['content-type']?.startsWith('application/json') ||
        (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) {
        reply(403, { error: 'Unsupported origin or content type' }); return;
    }
    let options;
    try { options = await readJson(request); }
    catch (_) { reply(400, { error: 'Invalid login request' }); return; }
    if (!options || !qqLoginTargetAllowed(options.url, options.method)) { reply(403, { error: 'Unsupported QQ login URL' }); return; }
    try {
        const headers = { Referer: 'https://y.qq.com/' };
        for (const key of ['Cookie', 'Content-Type']) {
            const value = options.headers?.[key];
            if (value != null && typeof value !== 'string') throw new Error('Invalid header');
            if (value && /[\r\n]/.test(value)) throw new Error('Invalid header');
            if (value) headers[key] = value;
        }
        const referer = options.headers?.Referer;
        if (referer) {
            if (!['https://y.qq.com/', 'https://xui.ptlogin2.qq.com/', 'https://graph.qq.com/oauth2.0/login_jump'].includes(referer)) throw new Error('Invalid referer');
            headers.Referer = referer;
        }
        const origin = options.headers?.Origin;
        if (origin) {
            if (options.url !== QQ_LOGIN_ENDPOINTS.authorize || origin !== 'https://graph.qq.com') throw new Error('Invalid origin');
            headers.Origin = origin;
        }
        if (options.body != null && typeof options.body !== 'string') throw new Error('Invalid body');
        const upstream = await fetchImpl(options.url, {
            method: options.method, headers,
            ...(options.method === 'POST' ? { body: options.body || '' } : {}),
            redirect: 'manual', signal: AbortSignal.timeout(15000)
        });
        const chunks = [];
        let length = 0;
        if (upstream.body) for await (const chunk of upstream.body) {
            length += chunk.length;
            if (length > 2 * 1024 * 1024) throw new Error('Response too large');
            chunks.push(Buffer.from(chunk));
        }
        const resultHeaders = {};
        for (const key of ['location', 'content-type']) if (upstream.headers.has(key)) resultHeaders[key] = upstream.headers.get(key);
        resultHeaders['set-cookie'] = upstream.headers.getSetCookie?.() || upstream.headers.get('set-cookie') || [];
        const image = new URL(options.url).pathname === new URL(QQ_LOGIN_ENDPOINTS.qr).pathname;
        reply(200, { status: upstream.status, headers: resultHeaders, data: Buffer.concat(chunks).toString(image ? 'base64' : 'utf8') });
    } catch (_) { reply(502, { error: 'QQ 登录请求失败，请稍后重试' }); }
}

module.exports = { handleQqLogin };
