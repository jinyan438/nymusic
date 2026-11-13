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

function harness({ native = false, quality = '128k' } = {}) {
    const files = new Map();
    const loads = [], network = [], errors = [];
    const cache = { async match(key) { return files.get(key)?.clone(); } };
    const node = () => ({ style: {}, classList: { add() {}, remove() {} }, querySelector: () => ({}), appendChild() {} });
    const context = vm.createContext({
        console, Promise, URL: { createObjectURL: () => 'blob:cover' },
        currentTrackData: null, currentLyrics: [], currentLyricIndex: -1, playlist: [], playbackMode: 'order',
        showPage() {}, document: { createElement: node },
        DOM: {
            playQualitySelect: { value: quality }, songTitle: node(), artistName: node(), albumArt: node(),
            backgroundContainer: node(), lyricsContainer: node(), currentTimeDisplay: node(), durationDisplay: node(),
            progressBar: node(), likeBtn: node()
        },
        caches: { open: async () => cache },
        Playback: { isNative: native, load: async request => { loads.push(request); }, reportError: error => errors.push(error) },
        MusicAPI: {
            getPlaybackRequest: track => ({ uri: `https://audio.example/${track.trackId}`, resolveQqMusicUrl: true }),
            getSongUrl: async track => { network.push(`audio:${track.trackId}`); return `https://audio.example/${track.trackId}`; },
            getCoverUrl: async track => { network.push(`cover:${track.trackId}`); return 'https://image.example/cover'; },
            getLyrics: async track => { network.push(`lyrics:${track.trackId}`); return '[00:01]歌词'; }
        },
        loadBackgroundImageWithFallback() {},
        parseLyrics: () => [{ time: 1, text: '歌词' }]
    });
    for (const file of ['config', 'player']) vm.runInContext(readFileSync(join(__dirname, `../www/js/${file}.js`), 'utf8'), context);
    const keys = vm.runInContext('CacheKeys', context);
    return { context, files, keys, loads, network, errors, cache };
}

function cachedAssets(h, id = 'song') {
    h.files.set(h.keys.getPicKey('qq', id), new Response('cover'));
    h.files.set(h.keys.getLyricKey('qq', id), new Response('[00:01]歌词'));
}

test('Downloaded FLAC plays offline when the playback quality is set to 128k', async () => {
    const h = harness();
    cachedAssets(h);
    const key = h.keys.getSongKey('qq', 'song', 'flac');
    h.files.set(key, new Response('cached FLAC'));
    await vm.runInContext("playSong({source:'qq',trackId:'song',songName:'歌曲',artist:'歌手'})", h.context);
    assert.equal(h.loads[0].cacheKey, key);
    assert.equal(await h.loads[0].cachedResponse.text(), 'cached FLAC');
    assert.deepEqual(h.network, []);
    assert.deepEqual(h.errors, []);
});

test('The selected downloaded quality wins, otherwise the highest available downloaded quality is used', async () => {
    const h = harness({ quality: '320k' });
    cachedAssets(h);
    for (const quality of ['128k', '320k', 'flac', 'flac24bit']) {
        h.files.set(h.keys.getSongKey('qq', 'song', quality), new Response(quality));
    }
    await vm.runInContext("playSong({source:'qq',trackId:'song'})", h.context);
    assert.equal(await h.loads[0].cachedResponse.text(), '320k');
    h.files.delete(h.keys.getSongKey('qq', 'song', '320k'));
    await vm.runInContext("playSong({source:'qq',trackId:'song'})", h.context);
    assert.equal(await h.loads[1].cachedResponse.text(), 'flac24bit');
    assert.deepEqual(h.network, []);
});

test('Uncached songs still use the requested quality and normal online playback', async () => {
    const h = harness();
    cachedAssets(h);
    await vm.runInContext("playSong({source:'qq',trackId:'song'})", h.context);
    assert.equal(h.loads[0].uri, 'https://audio.example/song');
    assert.equal(h.loads[0].cachedResponse, null);
    assert.deepEqual(h.network, ['audio:song']);
});

test('Slow artwork and lyric services do not delay audio startup', async () => {
    const h = harness();
    const cover = deferred(), lyrics = deferred();
    h.context.MusicAPI.getCoverUrl = () => cover.promise;
    h.context.MusicAPI.getLyrics = () => lyrics.promise;
    const pending = vm.runInContext("playSong({source:'qq',trackId:'song'})", h.context);
    await new Promise(setImmediate);
    assert.equal(h.loads.length, 1);
    cover.resolve('https://image.example/cover'); lyrics.resolve('[00:01]歌词');
    await pending;
    assert.deepEqual(h.errors, []);
});

test('Cached lyrics and artwork appear while the native decoder is still loading audio', async () => {
    const h = harness({ native: true });
    cachedAssets(h);
    const audio = deferred();
    h.context.Playback.load = () => audio.promise;
    const pending = vm.runInContext("playSong({source:'qq',trackId:'song'})", h.context);
    await new Promise(setImmediate);
    assert.equal(h.context.DOM.albumArt.style.backgroundImage, 'url(blob:cover)');
    assert.equal(vm.runInContext('currentLyrics[0].text', h.context), '歌词');
    audio.resolve(); await pending;
});

test('Quick track changes do not start an obsolete cache lookup result', async () => {
    const h = harness();
    cachedAssets(h, 'first'); cachedAssets(h, 'second');
    const delayed = deferred();
    const match = h.cache.match;
    h.cache.match = key => key === h.keys.getSongKey('qq', 'first', '128k') ? delayed.promise : match(key);
    const first = vm.runInContext("playSong({source:'qq',trackId:'first'})", h.context);
    await vm.runInContext("playSong({source:'qq',trackId:'second'})", h.context);
    delayed.resolve(new Response('first audio')); await first;
    assert.equal(h.loads.length, 1);
    assert.equal(h.loads[0].uri, 'https://audio.example/second');
});
