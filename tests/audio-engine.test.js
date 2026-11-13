const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { webcrypto } = require('node:crypto');
const vm = require('node:vm');

class DetailEvent extends Event {
    constructor(type, options = {}) { super(type); this.detail = options.detail; }
}
class AudioElement extends EventTarget {
    constructor() { super(); this.paused = true; this.currentTime = 0; this.duration = 10; this.src = ''; }
    async play() { this.paused = false; this.dispatchEvent(new Event('play')); }
    pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
    removeAttribute() { this.src = ''; }
    load() {}
}
function harness(native = true) {
    const element = new AudioElement();
    const events = new Map();
    const requests = [];
    const chunks = [];
    const revoked = [];
    const files = new Map();
    let now = 0;
    const plugin = {
        async addListener(name, listener) { events.set(name, listener); return { remove() {} }; },
        async initialize() { return { clientId: '', paused: true, position: 0, duration: 0 }; },
        async stop() {},
        async load(request) { requests.push(request); return { ...request, paused: false, position: 0, duration: 10 }; },
        async seek({ position }) { return { clientId: playback.clientId, paused: false, position, duration: 10 }; }
    };
    const filesystem = {
        async stat({ path }) { if (!files.has(path)) throw new Error('Missing'); return { size: files.get(path).length }; },
        async writeFile(options) { const bytes = Buffer.from(options.data, 'base64'); chunks.push({ ...options, bytes }); files.set(options.path, bytes); },
        async appendFile(options) { const bytes = Buffer.from(options.data, 'base64'); chunks.push({ ...options, bytes }); files.set(options.path, Buffer.concat([files.get(options.path), bytes])); },
        async rename({ from, to }) { files.set(to, files.get(from)); files.delete(from); },
        async deleteFile({ path }) { files.delete(path); },
        async getUri({ path }) { return { uri: `file:///cache/${path}` }; }
    };
    const capacitor = { isNativePlatform: () => native, getPlatform: () => native ? 'android' : 'web', registerPlugin: () => plugin, Plugins: { Filesystem: filesystem } };
    const context = vm.createContext({
        EventTarget, Event, CustomEvent: DetailEvent, console, Uint8Array, TextEncoder, btoa,
        crypto: webcrypto, performance: { now: () => now }, Capacitor: capacitor,
        DOM: { audioPlayer: element }, document: { addEventListener() {} },
        URLSearchParams,
        URL: class extends URL {
            static createObjectURL() { return 'blob:cached'; }
            static revokeObjectURL(value) { revoked.push(value); }
        }
    });
    for (const file of ['native-audio-cache', 'audio-engine']) {
        vm.runInContext(readFileSync(join(__dirname, `../www/js/${file}.js`), 'utf8'), context);
    }
    const playback = vm.runInContext('Playback', context);
    return { playback, plugin, filesystem, files, events, element, requests, chunks, revoked, context, clock: value => { now = value; } };
}

test('Android forwards raw file paths and queue metadata to BASS without starting HTML audio', async () => {
    const { playback, requests, element } = harness();
    await playback.load({ uri: '/storage/Music/24bit.flac', track: { trackId: 'a' }, queue: [], index: -1 });
    assert.equal(requests[0].uri, '/storage/Music/24bit.flac');
    assert.equal(requests[0].track.trackId, 'a');
    assert.equal(element.src, '');
    assert.equal(element.paused, true);
    assert.equal(playback.paused, false);
});

test('Native progress uses the presented-frame clock and freezes during buffering or pause', () => {
    const { playback, clock } = harness();
    playback.clientId = 'current';
    clock(100);
    playback.applyState({ clientId: 'current', position: 2, duration: 10, paused: false, buffering: false });
    clock(1100);
    assert.equal(playback.currentTime, 3);
    playback.applyState({ clientId: 'current', position: 3, duration: 10, paused: false, buffering: true });
    clock(3100);
    assert.equal(playback.currentTime, 3);
    playback.applyState({ clientId: 'old', position: 9, duration: 10, paused: false });
    assert.equal(playback.currentTime, 3);
    playback.applyState({ clientId: 'current', position: 3, duration: 10, paused: true });
    clock(6100);
    assert.equal(playback.currentTime, 3);
});

test('Fast track changes discard cancelled native load results', async () => {
    const { playback, plugin } = harness();
    const pending = [];
    plugin.load = request => new Promise((resolve, reject) => pending.push({ request, resolve, reject }));
    const first = playback.load({ uri: 'https://example.org/first.flac' });
    while (pending.length < 1) await new Promise(setImmediate);
    const second = playback.load({ uri: 'https://example.org/second.flac' });
    while (pending.length < 2) await new Promise(setImmediate);
    pending[0].reject(new Error('Playback cancelled'));
    pending[1].resolve({ clientId: pending[1].request.clientId, paused: false, position: 0, duration: 240 });
    await Promise.all([first, second]);
    assert.equal(playback.duration, 240);
    assert.equal(playback.paused, false);
});

test('Cached audio reaches the native file intact in bounded bridge chunks', async () => {
    const { playback, chunks, requests, files } = harness();
    const bytes = Uint8Array.from({ length: 450000 }, (_, i) => i % 251);
    await playback.load({
        uri: 'https://example.org/audio', cachedResponse: new Response(bytes), cacheKey: 'track-key',
        resolveQqMusicUrl: true, requestHeaders: { Cookie: 'uin=123' },
        queue: [{ uri: 'https://example.org/audio', resolveQqMusicUrl: true }], index: 0
    });
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.bytes.length <= 192 * 1024));
    assert.deepEqual(Buffer.concat(chunks.map(chunk => chunk.bytes)), Buffer.from(bytes));
    assert.equal(files.size, 1);
    assert.match([...files.keys()][0], /^bass-playback\/[a-f0-9]{64}\.audio$/);
    assert.equal(requests[0].uri, 'https://example.org/audio');
    assert.equal(requests[0].queue[0].uri, requests[0].uri);
    assert.equal(requests[0].resolveQqMusicUrl, true);
    assert.equal(requests[0].queue[0].resolveQqMusicUrl, true);
    assert.equal(requests[0].cacheKeys[0], 'track-key');
    assert.equal(requests[0].queue[0].cacheKeys[0], 'track-key');
});

test('Browser playback and object URL ownership remain functional', async () => {
    const { playback, element, revoked } = harness(false);
    await playback.load({ uri: 'blob:local-file' });
    assert.equal(element.src, 'blob:local-file');
    await playback.seek(4);
    assert.equal(element.currentTime, 4);
    await playback.load({ uri: 'https://example.org/music.mp3' });
    assert.ok(revoked.includes('blob:local-file'));
    assert.equal(element.src, 'https://example.org/music.mp3');
});

test('Repeated native playback reuses the file without reading or transferring the cached audio again', async () => {
    const { playback, chunks, requests, files } = harness();
    await playback.load({ uri: 'https://unused.example/audio', cachedResponse: new Response(new Uint8Array(450000)), cacheKey: 'same-track' });
    const written = chunks.length;
    await playback.load({
        uri: 'https://unused.example/audio', cacheKey: 'same-track',
        cachedResponse: { blob() { throw new Error('The complete song must not be read again'); } }
    });
    assert.equal(chunks.length, written);
    assert.equal(files.size, 1);
    assert.equal(requests[1].uri, requests[0].uri);
});

test('Cancelled native file preparation never publishes a partial song or starts obsolete playback', async () => {
    const { playback, filesystem, files, requests } = harness();
    const write = filesystem.writeFile;
    let release;
    filesystem.writeFile = async options => { await write(options); await new Promise(resolve => { release = resolve; }); };
    const pending = playback.load({ uri: 'https://unused.example/audio', cachedResponse: new Response(new Uint8Array(450000)), cacheKey: 'cancelled' });
    while (!release) await new Promise(setImmediate);
    await playback.stop();
    release();
    await pending;
    assert.equal(files.size, 0);
    assert.equal(requests.length, 0);
});

test('Native queue payload excludes covers and lyrics and retains raw local URIs', () => {
    const { context } = harness();
    context.playlist = [
        { source: 'local', trackId: '1', filePath: 'content://media/1', songName: 'Song', cover: 'large-cover', lyrics: 'large-lyrics' },
        { source: 'qq', trackId: '2', songName: 'Online' }
    ];
    context.playbackMode = 'order';
    context.DOM.playQualitySelect = { value: 'flac' };
    for (const name of ['config', 'qq-music-api', 'music-api', 'player']) {
        vm.runInContext(readFileSync(join(__dirname, `../www/js/${name}.js`), 'utf8'), context);
    }
    const result = vm.runInContext('getPlaybackContext(playlist[0])', context);
    assert.equal(result.queue[0].uri, 'content://media/1');
    assert.equal(result.index, 0);
    assert.equal(result.track.cover, undefined);
    assert.equal(result.track.lyrics, undefined);
    assert.equal(result.queue[1].resolveQqMusicUrl, true);
    const request = new URL(result.queue[1].uri);
    assert.equal(request.hostname, 'u.y.qq.com');
    assert.match(JSON.parse(request.searchParams.get('data')).req_0.param.filename[0], /^F000/);
    assert.equal(result.queue[1].cacheKeys.length, 4);
    assert.match(result.queue[1].cacheKeys[0], /source=qq&id=2&type=url&br=flac$/);
});

test('Android keeps QQ URL resolution in the service for uncached tracks', async () => {
    const { playback, requests } = harness();
    await playback.load({
        uri: 'https://u.y.qq.com/cgi-bin/musicu.fcg?data=request',
        resolveQqMusicUrl: true, requestHeaders: { Referer: 'https://y.qq.com/' },
        track: { source: 'qq', trackId: 'mid' }
    });
    assert.equal(requests[0].resolveQqMusicUrl, true);
    assert.equal(requests[0].requestHeaders.Referer, 'https://y.qq.com/');
});
