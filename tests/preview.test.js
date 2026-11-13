const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { createPreviewServer } = require('../scripts/preview');

async function start(t, fetchImpl) {
    const server = createPreviewServer({ fetchImpl });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    return `http://127.0.0.1:${server.address().port}`;
}

test('The app styles, icons and font files load locally without an external request', async t => {
    const base = await start(t, async () => { assert.fail('UI assets contacted an external server'); });
    const html = await (await fetch(base)).text();
    const stylesheets = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map(match => match[1]);
    assert.ok(stylesheets.length > 0);
    for (const href of stylesheets) {
        const url = new URL(href, base);
        assert.equal(url.origin, base);
        const response = await fetch(url);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /^text\/css/);
        const css = await response.text();
        for (const match of css.matchAll(/url\(['"]?([^)'"\s]+\.(?:woff2|ttf))['"]?\)/g)) {
            const font = await fetch(new URL(match[1], url));
            assert.equal(font.status, 200);
            assert.match(font.headers.get('content-type'), /^font\//);
            assert.ok((await font.arrayBuffer()).byteLength > 0);
        }
    }
});

test('npm start serves the app with its QQ adapter and license in one process', async t => {
    const base = await start(t);
    assert.match(await (await fetch(base)).text(), /js\/qq-music-api.js/);
    const script = await fetch(`${base}/js/qq-music-api.js`);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.match(await script.text(), /const QQMusic/);
    assert.match(await (await fetch(`${base}/third-party/qq-music-api.LICENSE`)).text(), /MIT License/);
});

test('QQ proxy forwards cookie and Referer only to approved QQ endpoints', async t => {
    const calls = [];
    const base = await start(t, async (url, options) => { calls.push({ url, options }); return Response.json({ code: 0 }); });
    const target = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&w=test';
    const response = await fetch(`${base}/api/qq?url=${encodeURIComponent(target)}`, { headers: { 'X-QQ-Cookie': 'uin=123' } });
    assert.deepEqual(await response.json(), { code: 0 });
    assert.equal(String(calls[0].url), target);
    assert.equal(calls[0].options.headers.Cookie, 'uin=123');
    assert.equal(calls[0].options.headers.Referer, 'https://y.qq.com/');
    assert.equal(calls[0].options.redirect, 'manual');
});

test('QQ preview proxy rejects arbitrary hosts, credentials, ports and off-domain redirects', async t => {
    const base = await start(t, async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }));
    for (const target of ['http://127.0.0.1/private', 'https://example.org/', 'https://c.y.qq.com/other', 'https://user:pass@c.y.qq.com/soso/fcgi-bin/client_search_cp', 'https://c.y.qq.com:1234/soso/fcgi-bin/client_search_cp']) {
        assert.equal((await fetch(`${base}/api/qq?url=${encodeURIComponent(target)}`)).status, 403);
    }
    assert.equal((await fetch(`${base}/api/qq?url=bad`)).status, 400);
    const response = await fetch(`${base}/api/qq?url=${encodeURIComponent('https://c.y.qq.com/soso/fcgi-bin/client_search_cp')}`);
    assert.equal(response.status, 502);
});

test('Media proxy preserves range and content type without forwarding QQ credentials', async t => {
    const base = await start(t, async (_, options) => {
        assert.equal(options.headers.Range, 'bytes=4-');
        assert.equal(options.headers.Cookie, undefined);
        return new Response(new Uint8Array([4, 5, 6]), { status: 206, headers: { 'Content-Type': 'audio/mpeg', 'Content-Range': 'bytes 4-6/7' } });
    });
    const response = await fetch(`${base}/api/qq-media?url=${encodeURIComponent('http://isure.stream.qqmusic.qq.com/track.mp3')}`, { headers: { Range: 'bytes=4-', 'X-QQ-Cookie': 'uin=123' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    assert.equal(response.headers.get('content-range'), 'bytes 4-6/7');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([4, 5, 6]));
});

test('Same-project QR proxy returns image bytes and Set-Cookie without browser cookie restrictions', async t => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const base = await start(t, async (_, options) => {
        assert.equal(options.redirect, 'manual');
        return new Response(bytes, { headers: { 'Set-Cookie': 'qrsig=test==; Domain=.ptlogin2.qq.com; Path=/' } });
    });
    const response = await fetch(`${base}/api/qq-login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609', method: 'GET' })
    });
    const result = await response.json();
    assert.equal(result.status, 200);
    assert.equal(result.data, Buffer.from(bytes).toString('base64'));
    assert.match(result.headers['set-cookie'][0], /qrsig=test==/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
});

test('QQ authorization proxy keeps redirects visible to the session instead of following them', async t => {
    const base = await start(t, async (url, options) => {
        assert.equal(url, 'https://graph.qq.com/oauth2.0/authorize');
        assert.equal(options.method, 'POST');
        assert.equal(options.body, 'client_id=100497308&state=state');
        assert.equal(options.headers.Cookie, 'p_skey=test');
        assert.equal(options.headers.Referer, 'https://graph.qq.com/oauth2.0/login_jump');
        assert.equal(options.headers.Origin, 'https://graph.qq.com');
        assert.equal(options.redirect, 'manual');
        return new Response(null, { status: 302, headers: { Location: 'https://y.qq.com/portal/wx_redirect.html?code=test&state=state' } });
    });
    const response = await fetch(`${base}/api/qq-login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            url: 'https://graph.qq.com/oauth2.0/authorize', method: 'POST',
            body: 'client_id=100497308&state=state', headers: { Cookie: 'p_skey=test', 'Content-Type': 'application/x-www-form-urlencoded',
                Origin: 'https://graph.qq.com', Referer: 'https://graph.qq.com/oauth2.0/login_jump' }
        })
    });
    const result = await response.json();
    assert.equal(result.status, 302);
    assert.match(result.headers.location, /code=test/);
});

test('The preview proxy accepts the QQ SSL signature callback without following its redirect', async t => {
    const base = await start(t, async (url, options) => {
        assert.equal(new URL(url).hostname, 'ssl.ptlogin2.graph.qq.com');
        assert.equal(options.redirect, 'manual');
        assert.equal(options.headers.Referer, 'https://xui.ptlogin2.qq.com/');
        return new Response(null, { status: 302, headers: { 'Set-Cookie': 'p_skey=test; Domain=.graph.qq.com; Path=/' } });
    });
    const response = await fetch(`${base}/api/qq-login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            url: 'https://ssl.ptlogin2.graph.qq.com/check_sig?uin=123&ptsigx=test', method: 'GET',
            headers: { Referer: 'https://xui.ptlogin2.qq.com/' }
        })
    });
    assert.equal((await response.json()).status, 302);
});

test('Login proxy rejects cross-origin posts and requests outside the QR authorization flow', async t => {
    const base = await start(t, async () => { throw new Error('No upstream requests expected'); });
    const options = { url: 'https://ssl.ptlogin2.qq.com/ptqrshow', method: 'GET' };
    const post = (body, headers = {}) => fetch(`${base}/api/qq-login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
    });
    assert.equal((await fetch(`${base}/api/qq-login`)).status, 405);
    assert.equal((await post(options, { Origin: 'https://example.org' })).status, 403);
    assert.equal((await post(options, { 'Content-Type': 'text/plain' })).status, 403);
    for (const url of ['http://127.0.0.1/private', 'https://ssl.ptlogin2.qq.com.evil/ptqrshow', 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp', 'https://ssl.ptlogin2.qq.com:1234/ptqrshow']) {
        assert.equal((await post({ url, method: 'GET' })).status, 403);
    }
});
