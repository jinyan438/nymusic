const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function harness(Session, initial = {}) {
    const timers = new Map();
    const settings = new Map(Object.entries(initial));
    const image = { hidden: true, src: '', classList: { add() {}, remove() {} }, removeAttribute() { this.src = ''; } };
    const dialog = { open: true, close() { this.open = false; }, showModal() { this.open = true; } };
    const DOM = { qqLoginDialog: dialog, qqLoginImage: image, qqLoginStatus: {}, qqLoginRefresh: {}, qqAccountName: {}, qqLoginBtn: {} };
    const QQMusic = { cookie: '', setCookie(value) { this.cookie = value; }, getUin() { return '123'; } };
    const context = vm.createContext({
        DOM, QQMusic, QqLoginSession: Session,
        IDB: { getSetting: async (key, fallback) => settings.has(key) ? settings.get(key) : fallback, setSetting: async (key, value) => settings.set(key, value) },
        setTimeout: callback => { const key = Symbol(); timers.set(key, callback); return key; },
        clearTimeout: key => timers.delete(key)
    });
    vm.runInContext(readFileSync(join(__dirname, '../www/js/qq-login.js'), 'utf8'), context);
    const ui = vm.runInContext('QQLogin', context);
    return { ui, DOM, QQMusic, settings, timers, async tick() { const [key, callback] = timers.entries().next().value; timers.delete(key); await callback(); } };
}

test('Refreshing QR codes ignores late images from the previous login session', async () => {
    const pending = [deferred(), deferred()];
    let index = 0;
    class Session { constructor() { this.index = index++; } start() { return pending[this.index].promise; } cancel() {} }
    const { ui, DOM, timers } = harness(Session);
    const first = ui.refresh();
    const second = ui.refresh();
    pending[1].resolve({ image: 'new-image' });
    await second;
    pending[0].resolve({ image: 'old-image' });
    await first;
    assert.equal(DOM.qqLoginImage.src, 'new-image');
    assert.equal(timers.size, 1);
    ui.stop();
    assert.equal(timers.size, 0);
    assert.equal(DOM.qqLoginImage.src, '');
});

test('Closing the QR dialog prevents an in-flight successful poll from saving credentials', async () => {
    const pending = deferred();
    class Session { async start() { return { image: 'qr' }; } poll() { return pending.promise; } cancel() {} }
    const { ui, DOM, timers, settings, tick } = harness(Session);
    await ui.refresh();
    const polling = tick();
    DOM.qqLoginDialog.close();
    ui.stop();
    pending.resolve({ state: 'success', account: { cookie: 'should-not-save', uin: '123' } });
    await polling;
    assert.equal(settings.size, 0);
    assert.equal(timers.size, 0);
});

test('Confirmed QQ Music credentials save atomically and are restored after reopening the app', async () => {
    class Session {
        async start() { return { image: 'qr' }; }
        async poll() { this.authenticated = true; return { state: 'success', account: { cookie: 'uin=123; qqmusic_key=example', nickname: '测试用户', uin: '123' } }; }
        cancel() {}
    }
    const { ui, DOM, QQMusic, settings, tick } = harness(Session);
    await ui.refresh();
    await tick();
    assert.equal(settings.size, 1);
    assert.equal(settings.get('qqLogin').account.nickname, '测试用户');
    assert.equal(QQMusic.cookie, 'uin=123; qqmusic_key=example');
    assert.equal(DOM.qqLoginDialog.open, false);
    const reopened = harness(Session, { qqLogin: settings.get('qqLogin'), qqCookie: 'old-cookie' });
    await reopened.ui.load();
    assert.equal(reopened.QQMusic.cookie, QQMusic.cookie);
    assert.equal(reopened.DOM.qqAccountName.textContent, '测试用户');
    assert.equal(reopened.DOM.qqLoginBtn.textContent, '重新登录');
});

test('Expired QR codes stop polling and old saved cookies remain compatible', async () => {
    class Session { async start() { return { image: 'qr' }; } async poll() { return { state: 'expired' }; } cancel() {} }
    const { ui, DOM, QQMusic, timers, tick } = harness(Session, { qqCookie: 'legacy-cookie' });
    await ui.load();
    assert.equal(QQMusic.cookie, 'legacy-cookie');
    await ui.refresh();
    await tick();
    assert.equal(timers.size, 0);
    assert.match(DOM.qqLoginStatus.textContent, /已过期/);
});

test('Authorization exchange failures do not keep reusing a one-time QQ code', async () => {
    class Session {
        async start() { return { image: 'qr' }; }
        async poll() { this.authorizationFailed = true; throw new Error('Authorization failed'); }
        cancel() {}
    }
    const { ui, DOM, timers, tick } = harness(Session);
    await ui.refresh();
    await tick();
    assert.equal(timers.size, 0);
    assert.match(DOM.qqLoginStatus.textContent, /登录失败/);
    assert.equal(DOM.qqLoginRefresh.disabled, false);
});

test('The QR dialog displays a safe authorization reason while keeping the previous account intact', async () => {
    class Session {
        async start() { return { image: 'qr' }; }
        async poll() {
            this.authorizationFailed = true;
            const error = new Error('Internal response contains secret tokens');
            error.name = 'QqLoginError';
            error.userMessage = 'QQ 已确认，但未取得授权票据，请重新扫码';
            throw error;
        }
        cancel() {}
    }
    const { ui, DOM, settings, QQMusic, timers, tick } = harness(Session, { qqCookie: 'old-cookie' });
    await ui.load();
    await ui.refresh();
    await tick();
    assert.equal(DOM.qqLoginStatus.textContent, 'QQ 已确认，但未取得授权票据，请重新扫码');
    assert.equal(QQMusic.cookie, 'old-cookie');
    assert.equal(settings.has('qqLogin'), false);
    assert.equal(timers.size, 0);
});
