const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
    QqLoginSession, QqLoginCookieJar, QqLoginError, createQqLoginState, qqLoginHash, qqLoginTargetAllowed, parseQqLoginCallback, qqLoginTransport
} = require('../www/js/qq-login-api');

const qrImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aYioAAAAASUVORK5CYII=';
const callback = (code, redirect = '', name = '') => `ptuiCB('${code}','0','${redirect}','0','状态','${name}');`;
const signature = 'https://ptlogin2.graph.qq.com/check_sig?uin=123&ptsigx=test';

function flow({ codes = [66, 67, 0], noMusicCookie = false, badState = false, noSkey = false, musicCode = 0, musicData = {}, redirect = signature } = {}) {
    const calls = [];
    let currentTime = 1000;
    const transport = async options => {
        calls.push(options);
        const url = new URL(options.url);
        if (url.pathname === '/ptqrshow') return { status: 200, headers: { 'set-cookie': 'qrsig=qr-value==; Domain=.ptlogin2.qq.com; Path=/; Secure' }, data: qrImage };
        if (url.pathname === '/ptqrlogin') return { status: 200, headers: {}, data: callback(codes.shift(), redirect, '测试账号') };
        if (url.pathname === '/check_sig') return { status: 302, headers: { 'set-cookie': noSkey ? [] : ['p_skey=key=value==; Domain=.graph.qq.com; Path=/; Secure', 'p_uin=o123; Domain=.graph.qq.com; Path=/'] }, data: '' };
        if (url.pathname === '/oauth2.0/authorize') {
            const params = new URLSearchParams(options.body);
            assert.equal(params.get('client_id'), '100497308');
            assert.equal(params.get('g_tk'), String(qqLoginHash('key=value==', 5381)));
            assert.match(options.headers.Cookie, /p_skey=key=value==/);
            assert.equal(options.headers.Cookie.includes('qrsig'), false);
            return { status: 302, headers: { Location: `https://y.qq.com/portal/wx_redirect.html?code=authorization-code&state=${badState ? 'wrong' : params.get('state')}` }, data: '' };
        }
        if (url.pathname === '/cgi-bin/musicu.fcg') {
            assert.equal(options.method, 'POST');
            assert.equal(JSON.parse(options.body).req.param.code, 'authorization-code');
            assert.equal(options.headers.Cookie.includes('p_skey'), false);
            return { status: 200, headers: { 'set-cookie': noMusicCookie ? [] : [
                'uin=o123; Domain=.y.qq.com; Path=/; Secure',
                'qqmusic_key=music-key==; Domain=.y.qq.com; Path=/; Secure; HttpOnly'
            ] }, data: JSON.stringify({ code: 0, req: { code: musicCode, data: musicData } }) };
        }
        throw new Error('Unexpected auth endpoint');
    };
    const session = new QqLoginSession(transport, { now: () => currentTime, state: () => 'random-state' });
    return { session, calls, clock: value => { currentTime = value; } };
}

test('QR login handles missing image Content-Type and preserves the qrsig token', async () => {
    const { session, calls } = flow();
    const qr = await session.start();
    assert.equal(qr.image, 'data:image/png;base64,' + qrImage);
    assert.equal(qr.expiresAt, 121000);
    const waiting = await session.poll();
    assert.equal(waiting.state, 'waiting');
    const request = calls[1];
    assert.equal(new URL(request.url).searchParams.get('ptqrtoken'), String(qqLoginHash('qr-value==')));
    assert.equal(request.headers.Cookie, 'qrsig=qr-value==');
});

test('QR scan, confirmation, OAuth and QQ Music exchange must all finish before success', async () => {
    const { session, calls } = flow();
    await session.start();
    assert.equal((await session.poll()).state, 'waiting');
    assert.equal((await session.poll()).state, 'scanned');
    assert.equal(session.authenticated, false);
    const result = await session.poll();
    assert.equal(result.state, 'success');
    assert.equal(result.account.nickname, '测试账号');
    assert.equal(result.account.uin, '123');
    assert.match(result.account.cookie, /qqmusic_key=music-key==/);
    assert.equal(result.account.cookie.includes('qrsig'), false);
    assert.equal(result.account.cookie.includes('p_skey'), false);
    assert.equal(session.authenticated, true);
    assert.equal(calls.length, 7);
    await assert.rejects(session.poll(), /已完成/);
});

test('QQ confirmation alone cannot count as a QQ Music login', async () => {
    for (const options of [{ noMusicCookie: true }, { musicCode: 1000 }, { noSkey: true }]) {
        const { session } = flow({ codes: [0], ...options });
        await session.start();
        await assert.rejects(session.poll(), /凭证|授权/);
        assert.equal(session.authenticated, false);
        assert.equal(session.authorizationFailed, true);
    }
});

test('Confirmed QQ callbacks on ssl.ptlogin2.graph.qq.com complete authorization', async () => {
    const redirect = 'https://ssl.ptlogin2.graph.qq.com/check_sig?pttype=1&uin=123&service=ptqrlogin&nodirect=0&ptsigx=test';
    const { session, calls } = flow({ codes: [0], redirect });
    await session.start();
    const result = await session.poll();
    assert.equal(result.state, 'success');
    assert.equal(new URL(calls[2].url).hostname, 'ssl.ptlogin2.graph.qq.com');
});

test('Successful QQ Music credentials in the JSON body do not require Set-Cookie headers', async () => {
    const { session } = flow({ codes: [0], noMusicCookie: true, musicData: {
        musicid: 456, str_musicid: '456', musickey: 'Q_H_L_music-key==', loginType: 2
    } });
    await session.start();
    const result = await session.poll();
    assert.equal(result.state, 'success');
    assert.equal(result.account.uin, '456');
    assert.match(result.account.cookie, /(?:^|; )uin=456(?:;|$)/);
    assert.match(result.account.cookie, /qqmusic_key=Q_H_L_music-key==/);
    assert.match(result.account.cookie, /qm_keyst=Q_H_L_music-key==/);
});

test('Native transport completes the SSL callback and accepts JSON credentials returned as an object', async t => {
    const previous = globalThis.Capacitor;
    const nativeRequests = [];
    const { session: fixture } = flow({ codes: [0], redirect: 'https://ssl.ptlogin2.graph.qq.com/check_sig?uin=123&ptsigx=test', noMusicCookie: true,
        musicData: { musicid: 456, musickey: 'Q_H_L_native==', str_musicid: '456' } });
    globalThis.Capacitor = { isNativePlatform: () => true, Plugins: { CapacitorHttp: { async request(options) {
        nativeRequests.push(options);
        const response = await fixture.transport({ ...options, body: options.data });
        if (Array.isArray(response.headers['set-cookie'])) response.headers['set-cookie'] = response.headers['set-cookie'].join(', ');
        if (new URL(options.url).pathname === '/cgi-bin/musicu.fcg') response.data = JSON.parse(response.data);
        return response;
    } } } };
    t.after(() => { globalThis.Capacitor = previous; });
    const session = new QqLoginSession(qqLoginTransport, { state: () => 'native-state' });
    await session.start();
    const result = await session.poll();
    assert.equal(result.state, 'success');
    assert.equal(result.account.uin, '456');
    assert.ok(nativeRequests.every(request => request.disableRedirects));
    assert.equal(nativeRequests[2].headers.Referer, 'https://xui.ptlogin2.qq.com/');
    assert.equal(nativeRequests[3].headers.Origin, 'https://graph.qq.com');
    assert.equal(nativeRequests[3].headers.Referer, 'https://graph.qq.com/oauth2.0/login_jump');
    assert.equal(nativeRequests[4].headers['Content-Type'], 'application/json');
});

test('Incomplete, rejected or unsafe body credentials are never stored as a successful login', async () => {
    for (const musicData of [
        { musicid: 456 }, { musickey: 'key' }, { musicid: 0, musickey: 'key' },
        { musicid: 456, musickey: 'key; injected=value' },
        { code: 1000, data: { musicid: 456, musickey: 'key' } }
    ]) {
        const { session } = flow({ codes: [0], noMusicCookie: true, musicData });
        await session.start();
        await assert.rejects(session.poll(), /凭证|授权/);
        assert.equal(session.authenticated, false);
    }
});

test('Login state generation supports older WebViews without crypto.randomUUID', () => {
    let seed = 0;
    const provider = { getRandomValues(bytes) { bytes.fill(++seed); return bytes; } };
    const first = createQqLoginState(provider);
    const second = createQqLoginState(provider);
    assert.match(first, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    assert.notEqual(first, second);
    assert.throws(() => createQqLoginState({}), error => error instanceof QqLoginError && /WebView/.test(error.userMessage));
});

test('Transport failures produce a safe message identifying the failing authorization step', async () => {
    const session = new QqLoginSession(async () => { throw new Error('https://graph.qq.com/?code=secret&Cookie=sensitive'); });
    session.setStage('authorize');
    await assert.rejects(session.request('https://graph.qq.com/oauth2.0/authorize', { method: 'POST' }), error => {
        assert.equal(error.stage, 'authorize');
        assert.match(error.userMessage, /音乐授权.*连接失败/);
        assert.equal(/secret|sensitive|https:/.test(error.userMessage), false);
        return true;
    });
});

test('OAuth state mismatches and unexpected signature URLs never exchange a code', async () => {
    for (const options of [{ badState: true }, { redirect: 'https://example.org/check_sig?secret=1' }]) {
        const { session, calls } = flow({ codes: [0], ...options });
        await session.start();
        await assert.rejects(session.poll(), /校验|授权地址/);
        assert.equal(calls.some(call => new URL(call.url).pathname === '/cgi-bin/musicu.fcg'), false);
        assert.equal(calls.some(call => new URL(call.url).hostname === 'example.org'), false);
    }
});

test('QR expiration and cancellation stop before authorization', async () => {
    for (const [code, state] of [[65, 'expired'], [68, 'cancelled']]) {
        const { session, calls } = flow({ codes: [code] });
        await session.start();
        assert.equal((await session.poll()).state, state);
        assert.equal(calls.length, 2);
    }
    const { session, calls, clock } = flow();
    await session.start();
    clock(122000);
    assert.equal((await session.poll()).state, 'expired');
    assert.equal(calls.length, 1);
});

test('Cancelling a session ignores credentials from an in-flight HTTP result', async () => {
    let finish;
    const session = new QqLoginSession(() => new Promise(resolve => { finish = resolve; }));
    const pending = session.start();
    session.cancel();
    finish({ status: 200, headers: { 'set-cookie': 'qrsig=late; Path=/' }, data: qrImage });
    await assert.rejects(pending, /已取消/);
    assert.equal(session.jar.cookies.size, 0);
});

test('Cookie parsing keeps equals signs and Expires commas, and enforces domain and path', () => {
    const jar = new QqLoginCookieJar();
    jar.update({ 'Set-Cookie': 'p_skey=a=b==; Domain=.graph.qq.com; Path=/; Expires=Wed, 01 Jan 2100 00:00:00 GMT, second=value; Path=/oauth2.0; Secure' }, 'https://graph.qq.com/oauth2.0/authorize');
    assert.equal(jar.value('p_skey', 'https://graph.qq.com/oauth2.0/authorize'), 'a=b==');
    assert.equal(jar.forUrl('https://graph.qq.com/oauth2.0/authorize').length, 2);
    assert.equal(jar.forUrl('https://graph.qq.com/other').length, 1);
    assert.equal(jar.header('https://u.y.qq.com/'), '');
    jar.update({ 'set-cookie': 'malicious=no; Domain=.qq.com.evil; Path=/' }, 'https://graph.qq.com/');
    assert.equal(jar.cookies.size, 2);
    jar.update({ 'set-cookie': 'p_skey=; Domain=.graph.qq.com; Path=/; Max-Age=0' }, 'https://graph.qq.com/');
    assert.equal(jar.value('p_skey', 'https://graph.qq.com/'), '');
});

test('PT login callback is parsed as data, including escaped URLs and nicknames', () => {
    const parsed = parseQqLoginCallback("ptuiCB('0','0','https://ptlogin2.graph.qq.com/check_sig?a=1\\x26b=2','0','成功','小\\'明');");
    assert.equal(parsed.redirect, 'https://ptlogin2.graph.qq.com/check_sig?a=1&b=2');
    assert.equal(parsed.nickname, "小'明");
    assert.throws(() => parseQqLoginCallback('evil()'), /响应异常/);
});

test('Native login transport disables redirects and retains binary image response type', async t => {
    const previous = globalThis.Capacitor;
    const calls = [];
    globalThis.Capacitor = { isNativePlatform: () => true, Plugins: { CapacitorHttp: { request: async options => { calls.push(options); return { status: 200 }; } } } };
    t.after(() => { globalThis.Capacitor = previous; });
    await qqLoginTransport({ url: 'https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609', method: 'GET', responseType: 'arraybuffer', headers: {} });
    assert.equal(calls[0].disableRedirects, true);
    assert.equal(calls[0].responseType, 'arraybuffer');
    assert.equal(calls[0].readTimeout, 15000);
    assert.equal(qqLoginTargetAllowed('https://ssl.ptlogin2.qq.com.evil/ptqrshow'), false);
    assert.equal(qqLoginTargetAllowed('https://ssl.ptlogin2.qq.com:1234/ptqrshow'), false);
    assert.equal(qqLoginTargetAllowed('https://ssl.ptlogin2.qq.com/ptqrshow', 'POST'), false);
});
