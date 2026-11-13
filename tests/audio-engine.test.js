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
    let now = 0;
    const plugin = {
        async addListener(name, listener) { events.set(name, listener); return { remove() {} }; },
        async initialize() { return { clientId: '', paused: true, position: 0, duration: 0 }; },
        async stop() {},
        async load(request) { requests.push(request); return { ...request, paused: false, position: 0, duration: 10 }; },
        async seek({ position }) { return { clientId: playback.clientId, paused: false, position, duration: 10 }; }
    };
    const filesystem = {
        async stat() { throw new Error('Missing'); },
        async writeFile(options) { chunks.push({ ...options, bytes: Buffer.from(options.data, 'base64') }); },
        async appendFile(options) { chunks.push({ ...options, bytes: Buffer.from(options.data, 'base64') }); },
        async rename() {},
        async deleteFile() {},
        async getUri({ path }) { return { uri: `file:///cache/${path}` }; }
    };
    const capacitor = { isNativePlatform: () => native, getPlatform: () => native ? 'android' : 'web', registerPlugin: () => plugin, Plugins: { Filesystem: filesystem } };
    const context = vm.createContext({
        EventTarget, Event, CustomEvent: DetailEvent, console, Uint8Array, TextEncoder, btoa,
        crypto: webcrypto, performance: { now: () => now }, Capacitor: capacitor,
        DOM: { audioPlayer: element }, document: { addEventListener() {} },
        URL: { createObjectURL: () => 'blob:cached', revokeObjectURL: value => revoked.push(value) }
    });
    vm.runInContext(readFileSync(join(__dirname, '../www/js/audio-engine.js'), 'utf8'), context);
    const playback = vm.runInContext('Playback', context);
    return { playback, plugin, events, element, requests, chunks, revoked, context, clock: value => { now = value; } };
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
    const { playback, chunks, requests } = harness();
    const bytes = Uint8Array.from({ length: 450000 }, (_, i) => i % 251);
    await playback.load({
        uri: 'https://example.org/audio', cachedResponse: new Response(bytes), cacheKey: 'track-key',
        queue: [{ uri: 'https://example.org/audio' }], index: 0
    });
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(chunk => chunk.bytes.length <= 192 * 1024));
    assert.deepEqual(Buffer.concat(chunks.map(chunk => chunk.bytes)), Buffer.from(bytes));
    assert.match(requests[0].uri, /^file:\/\/\/cache\/bass-playback\/[a-f0-9]{64}\.audio$/);
    assert.equal(requests[0].queue[0].uri, requests[0].uri);
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

test('Native queue payload excludes covers and lyrics and retains raw local URIs', () => {
    const { context } = harness();
    context.playlist = [
        { source: 'local', trackId: '1', filePath: 'content://media/1', songName: 'Song', cover: 'large-cover', lyrics: 'large-lyrics' },
        { source: 'qq', trackId: '2', songName: 'Online' }
    ];
    context.playbackMode = 'order';
    context.API_BASE = 'https://example.org/api';
    context.DOM.playQualitySelect = { value: 'flac' };
    vm.runInContext(readFileSync(join(__dirname, '../www/js/player.js'), 'utf8'), context);
    const result = vm.runInContext('getPlaybackContext(playlist[0])', context);
    assert.equal(result.queue[0].uri, 'content://media/1');
    assert.equal(result.index, 0);
    assert.equal(result.track.cover, undefined);
    assert.equal(result.track.lyrics, undefined);
    assert.match(result.queue[1].uri, /br=flac$/);
});
