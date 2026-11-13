// QQ 扫码及授权换票参考 sansenjian/qq-music-api（Rain120 的 fork）。
// https://github.com/sansenjian/qq-music-api，授权见 third-party/qq-music-api.LICENSE。
const QQ_LOGIN_ENDPOINTS = {
    qr: 'https://ssl.ptlogin2.qq.com/ptqrshow',
    poll: 'https://ssl.ptlogin2.qq.com/ptqrlogin',
    signature: 'https://ptlogin2.graph.qq.com/check_sig',
    signatureSsl: 'https://ssl.ptlogin2.graph.qq.com/check_sig',
    authorize: 'https://graph.qq.com/oauth2.0/authorize',
    music: 'https://u.y.qq.com/cgi-bin/musicu.fcg'
};

function qqLoginTargetAllowed(value, method = 'GET') {
    try {
        const url = new URL(value);
        if (url.username || url.password || url.port || url.hash) return false;
        const endpoint = `${url.origin}${url.pathname}`;
        return method === 'GET'
            ? [QQ_LOGIN_ENDPOINTS.qr, QQ_LOGIN_ENDPOINTS.poll, QQ_LOGIN_ENDPOINTS.signature, QQ_LOGIN_ENDPOINTS.signatureSsl].includes(endpoint)
            : method === 'POST' && [QQ_LOGIN_ENDPOINTS.authorize, QQ_LOGIN_ENDPOINTS.music].includes(endpoint);
    } catch (_) { return false; }
}

class QqLoginError extends Error {
    constructor(stage, message) {
        super(message);
        this.name = 'QqLoginError';
        this.stage = stage;
        this.userMessage = message;
    }
}

function createQqLoginState(provider = globalThis.crypto) {
    if (typeof provider?.randomUUID === 'function') return provider.randomUUID();
    if (typeof provider?.getRandomValues !== 'function') {
        throw new QqLoginError('authorize', '当前系统不支持安全登录，请更新 Android System WebView');
    }
    // 较旧的 Android WebView 没有 randomUUID，但支持安全随机数。
    const bytes = provider.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function qqLoginHash(value, seed = 0) {
    let hash = seed;
    for (let index = 0; index < value.length; index++) hash = (hash * 33 + value.charCodeAt(index)) | 0;
    return hash & 0x7fffffff;
}

function qqLoginHeader(headers, name) {
    const key = Object.keys(headers || {}).find(key => key.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : '';
}

class QqLoginCookieJar {
    constructor() { this.cookies = new Map(); }

    update(headers, location) {
        const url = new URL(location);
        const raw = qqLoginHeader(headers, 'set-cookie');
        const lines = (Array.isArray(raw) ? raw : [raw || '']).flatMap(line => line.split(/,(?=\s*[!#$%&'*+.^_`|~\w-]+=)/));
        for (const line of lines) {
            const [pair, ...attributes] = line.split(';');
            const separator = pair.indexOf('=');
            if (separator < 1) continue;
            const name = pair.slice(0, separator).trim();
            const value = pair.slice(separator + 1).trim();
            const options = Object.fromEntries(attributes.map(attribute => {
                const [key, ...rest] = attribute.trim().split('=');
                return [key.toLowerCase(), rest.join('=')];
            }));
            const domain = (options.domain || url.hostname).replace(/^\./, '').toLowerCase();
            if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) continue;
            const path = options.path || url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/';
            const key = `${domain}|${path}|${name}`;
            const expires = options.expires ? Date.parse(options.expires) : NaN;
            if (!value || Number(options['max-age']) === 0 || (Number.isFinite(expires) && expires <= Date.now())) {
                this.cookies.delete(key);
            } else {
                this.cookies.set(key, { name, value, domain, path, hostOnly: !options.domain, secure: 'secure' in options });
            }
        }
    }

    forUrl(location) {
        const url = new URL(location);
        return [...this.cookies.values()].filter(cookie =>
            (url.hostname === cookie.domain || (!cookie.hostOnly && url.hostname.endsWith(`.${cookie.domain}`))) &&
            (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`)) &&
            (!cookie.secure || url.protocol === 'https:')
        ).sort((left, right) => right.path.length - left.path.length);
    }

    header(location) { return this.forUrl(location).map(cookie => `${cookie.name}=${cookie.value}`).join('; '); }
    value(name, location) { return this.forUrl(location).find(cookie => cookie.name === name)?.value || ''; }
}

function parseQqLoginCallback(text) {
    if (!/^\s*ptuiCB\(/.test(text)) throw new Error('QQ 登录响应异常，请刷新二维码');
    const values = [...text.matchAll(/'((?:\\.|[^'\\])*)'/g)].map(match => match[1].replace(
        /\\(?:x([\da-f]{2})|u([\da-f]{4})|(.))/gi,
        (_, hex, unicode, character) => hex || unicode ? String.fromCharCode(parseInt(hex || unicode, 16)) : ({ n: '\n', r: '\r', t: '\t' })[character] || character
    ));
    if (values.length < 5 || !/^\d+$/.test(values[0])) throw new Error('QQ 登录响应异常，请刷新二维码');
    return { code: Number(values[0]), redirect: values[2], nickname: values[5] || '' };
}

async function qqLoginTransport(options) {
    if (!qqLoginTargetAllowed(options.url, options.method)) throw new Error('无效的 QQ 登录请求');
    const capacitor = globalThis.Capacitor;
    if (capacitor?.isNativePlatform?.()) {
        const http = capacitor.Plugins?.CapacitorHttp || capacitor.CapacitorHttp || capacitor.registerPlugin('CapacitorHttp');
        return http.request({
            url: options.url, method: options.method, headers: options.headers,
            ...(options.body != null ? { data: options.body } : {}),
            responseType: options.responseType || 'text', disableRedirects: true,
            connectTimeout: 15000, readTimeout: 15000
        });
    }
    const response = await fetch('/api/qq-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options), signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw new Error('QQ 登录请求失败，请稍后重试；网页预览请使用 npm start');
    return response.json();
}

class QqLoginSession {
    constructor(transport = qqLoginTransport, { now = () => Date.now(), state = createQqLoginState, onProgress = () => {} } = {}) {
        this.transport = transport;
        this.now = now;
        this.createState = state;
        this.onProgress = onProgress;
        this.stage = 'qr';
        this.jar = new QqLoginCookieJar();
        this.cancelled = false;
        this.expiresAt = 0;
        this.authenticated = false;
    }

    cancel() { this.cancelled = true; this.jar.cookies.clear(); }

    setStage(stage) { this.stage = stage; this.onProgress(stage); }

    async request(url, { method = 'GET', body, responseType = 'text', headers = {} } = {}) {
        if (this.cancelled) throw new Error('登录已取消');
        if (!qqLoginTargetAllowed(url, method)) throw new Error('无效的 QQ 授权地址');
        const labels = { qr: '获取二维码', poll: '检查扫码状态', signature: '获取 QQ 授权票据', authorize: '获取音乐授权', exchange: '登录 QQ 音乐' };
        let response;
        try {
            const referer = new URL(url).hostname.includes('ptlogin2') ? 'https://xui.ptlogin2.qq.com/' : 'https://y.qq.com/';
            response = await this.transport({
                url, method, responseType, ...(body != null ? { body } : {}),
                headers: { Referer: referer, Cookie: this.jar.header(url), ...headers }
            });
        } catch (_) {
            throw new QqLoginError(this.stage, `${labels[this.stage] || 'QQ 登录'}连接失败，请检查网络后重试`);
        }
        if (this.cancelled) throw new Error('登录已取消');
        if (response.status < 200 || response.status >= 400) {
            const status = Number.isInteger(Number(response.status)) ? Number(response.status) : 0;
            throw new QqLoginError(this.stage, `${labels[this.stage] || 'QQ 登录'}失败（HTTP ${status}），请重新扫码`);
        }
        this.jar.update(response.headers, url);
        return response;
    }

    async start() {
        const url = new URL(QQ_LOGIN_ENDPOINTS.qr);
        url.search = new URLSearchParams({
            appid: '716027609', e: '2', l: 'M', s: '3', d: '72', v: '4', t: String(this.now()),
            daid: '383', pt_3rd_aid: '100497308', u1: 'https://graph.qq.com/oauth2.0/login_jump'
        }).toString();
        const response = await this.request(url.href, { responseType: 'arraybuffer' });
        this.qrsig = this.jar.value('qrsig', QQ_LOGIN_ENDPOINTS.poll);
        const image = typeof response.data === 'string' ? response.data.replace(/\s/g, '') : '';
        // ptqrshow 实际可能省略 Content-Type，按图片签名判断。
        const type = image.startsWith('iVBORw0KGgo') ? 'image/png' : image.startsWith('/9j/') ? 'image/jpeg' : '';
        if (!this.qrsig || !type || !/^[\da-z+/]+=*$/i.test(image)) {
            throw new Error('无法获取 QQ 登录二维码，请刷新重试');
        }
        this.expiresAt = this.now() + 120000;
        return { image: `data:${type};base64,${image}`, expiresAt: this.expiresAt };
    }

    async poll() {
        if (!this.qrsig) throw new Error('请先获取二维码');
        if (this.now() >= this.expiresAt) return { state: 'expired' };
        if (this.authenticated) throw new Error('本次登录已完成');
        this.setStage('poll');
        const url = new URL(QQ_LOGIN_ENDPOINTS.poll);
        url.search = new URLSearchParams({
            u1: 'https://graph.qq.com/oauth2.0/login_jump', ptqrtoken: String(qqLoginHash(this.qrsig)),
            ptredirect: '0', h: '1', t: '1', g: '1', from_ui: '1', ptlang: '2052',
            action: `0-0-${this.now()}`, js_ver: '23111510', js_type: '1', login_sig: '',
            pt_uistyle: '40', aid: '716027609', daid: '383', pt_3rd_aid: '100497308', pt_js_version: 'v1.48.1'
        }).toString();
        const response = await this.request(url.href);
        const callback = parseQqLoginCallback(String(response.data));
        if (callback.code === 66) return { state: 'waiting' };
        if (callback.code === 67) return { state: 'scanned' };
        if (callback.code === 65) return { state: 'expired' };
        if (callback.code === 68) return { state: 'cancelled' };
        if (callback.code !== 0) throw new Error('QQ 登录未完成，请刷新二维码重试');
        let account;
        try { account = await this.authorize(callback.redirect, callback.nickname); }
        catch (error) { this.authorizationFailed = true; throw error; }
        this.authenticated = true;
        return { state: 'success', account };
    }

    async authorize(signatureUrl, nickname) {
        this.setStage('signature');
        if (!qqLoginTargetAllowed(signatureUrl, 'GET') || new URL(signatureUrl).pathname !== '/check_sig') {
            throw new QqLoginError('signature', 'QQ 授权地址异常，请重新扫码');
        }
        await this.request(signatureUrl);
        const key = this.jar.value('p_skey', QQ_LOGIN_ENDPOINTS.authorize);
        if (!key) throw new QqLoginError('signature', 'QQ 已确认，但未取得授权票据，请重新扫码');
        this.setStage('authorize');
        const state = this.createState();
        const gtk = qqLoginHash(key, 5381);
        const authorization = await this.request(QQ_LOGIN_ENDPOINTS.authorize, {
            method: 'POST', headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Origin: 'https://graph.qq.com', Referer: 'https://graph.qq.com/oauth2.0/login_jump'
            },
            body: new URLSearchParams({
                response_type: 'code', client_id: '100497308',
                redirect_uri: 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/',
                scope: 'get_user_info,get_app_friends', state, switch: '', from_ptlogin: '1', src: '1',
                update_auth: '1', openapi: '1010_1030', g_tk: String(gtk), auth_time: new Date(this.now()).toString(), ui: state
            }).toString()
        });
        const location = qqLoginHeader(authorization.headers, 'location');
        let redirect;
        try { redirect = new URL(location); } catch (_) { throw new QqLoginError('authorize', 'QQ 授权未返回登录凭证，请重试'); }
        const code = redirect.searchParams.get('code');
        if (authorization.status < 300 || redirect.origin !== 'https://y.qq.com' || redirect.pathname !== '/portal/wx_redirect.html' || !code || redirect.searchParams.get('state') !== state) {
            throw new QqLoginError('authorize', 'QQ 授权校验失败，请重新扫码');
        }
        this.setStage('exchange');
        const login = await this.request(QQ_LOGIN_ENDPOINTS.music, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                comm: { g_tk: gtk, platform: 'yqq', ct: 24, cv: 0 },
                req: { module: 'QQConnectLogin.LoginServer', method: 'QQLogin', param: { code } }
            })
        });
        let payload;
        try { payload = typeof login.data === 'string' ? JSON.parse(login.data) : login.data; }
        catch (_) { throw new QqLoginError('exchange', 'QQ 音乐授权响应异常，请重试'); }
        const result = payload?.req || payload?.req_0;
        const codes = [payload?.code, result?.code];
        if (codes.some(code => Number(code) !== 0)) {
            const failedCode = codes.map(Number).find(code => Number.isInteger(code) && code !== 0);
            throw new QqLoginError('exchange', `QQ 音乐授权失败${failedCode != null ? `（返回码 ${failedCode}）` : ''}，请重新扫码`);
        }
        this.setStage('credential');
        const envelope = result?.data || {};
        if (envelope.code != null && Number(envelope.code) !== 0) throw new QqLoginError('credential', 'QQ 音乐未完成授权，请重新扫码');
        const data = envelope.data && typeof envelope.data === 'object' ? envelope.data : envelope;
        const text = value => typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
        const first = (...values) => values.map(text).find(Boolean) || '';
        const uin = first(data.str_musicid, data.musicid, data.musicId, data.uin,
            this.jar.value('qqmusic_uin', QQ_LOGIN_ENDPOINTS.music), this.jar.value('uin', QQ_LOGIN_ENDPOINTS.music)).replace(/^o/, '');
        const musicKey = first(data.musickey, data.musicKey, data.qm_keyst, data.qqmusic_key,
            this.jar.value('qqmusic_key', QQ_LOGIN_ENDPOINTS.music), this.jar.value('qm_keyst', QQ_LOGIN_ENDPOINTS.music));
        if (!/^\d+$/.test(uin) || /^0+$/.test(uin) || !musicKey || /[;\s]/.test(musicKey)) {
            throw new QqLoginError('credential', '未获取到完整的 QQ 音乐登录凭证，请重新扫码');
        }
        // QQLogin 可只通过 JSON 返回 musicid / musickey，不一定有 Set-Cookie。
        const cookies = new Map();
        for (const entry of this.jar.forUrl(QQ_LOGIN_ENDPOINTS.music)) if (!cookies.has(entry.name)) cookies.set(entry.name, entry.value);
        for (const name of ['uin', 'qqmusic_uin', 'qm_str_musicid']) cookies.set(name, uin);
        for (const name of ['qqmusic_key', 'qm_keyst']) cookies.set(name, musicKey);
        cookies.set('tmeLoginType', '2');
        const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
        return { cookie, uin, nickname: nickname || '', loggedInAt: this.now() };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { QQ_LOGIN_ENDPOINTS, QqLoginSession, QqLoginCookieJar, QqLoginError, createQqLoginState, qqLoginHash, qqLoginTargetAllowed, parseQqLoginCallback, qqLoginTransport };
}
