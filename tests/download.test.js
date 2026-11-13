const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { flac, ogg } = require('./audio-format-fixtures');

function harness(response, options = {}) {
    const cache = new Map();
    const alerts = [];
    const status = { textContent: '' };
    const icon = { className: '' };
    const classes = new Set();
    const saved = [];
    const calls = [];
    const directory = { kind: 'native', uri: 'content://downloads/tree/music' };
    const button = { querySelector: () => icon, classList: { contains: key => classes.has(key), add: key => classes.add(key) } };
    // 榜单的下载按钮没有 download-status 节点，也必须能下载。
    const row = { querySelector: selector => selector === '.download-btn' ? button : null };
    const context = vm.createContext({
        URL, Response, ReadableStream, TextEncoder, Uint8Array, console, alert: value => alerts.push(value),
        document: { createElement: () => status }, DOM: { downloadQualitySelect: { value: 'flac' } },
        caches: { open: async () => ({ match: async key => cache.get(key)?.clone(), delete: async key => cache.delete(key), async put(key, value) {
            const blob = await value.blob();
            cache.set(key, new Response(blob, { headers: value.headers }));
        } }) },
        MusicAPI: {
            getSongUrl: async () => 'https://audio.example/track.flac',
            fetchCover: async () => new Response('cover', { headers: { 'Content-Type': 'image/jpeg' } }),
            getLyrics: async () => '[00:01.00]歌词'
        },
        DownloadDirectory: {
            prepare: async () => options.cancelled ? null : directory,
            async save(response, track, quality, target) {
                if (options.saveError) throw new Error(options.saveError);
                saved.push({ bytes: new Uint8Array(await response.arrayBuffer()), track, quality, target, type: response.headers.get('content-type') });
            }
        },
        fetch: async url => { calls.push(url); return response.clone(); }
    });
    for (const file of ['config', 'download']) vm.runInContext(readFileSync(join(__dirname, `../www/js/${file}.js`), 'utf8'), context);
    if (options.realDirectory) {
        for (const file of ['audio-file-format', 'download-directory']) vm.runInContext(readFileSync(join(__dirname, `../www/js/${file}.js`), 'utf8'), context);
        const downloads = vm.runInContext('DownloadDirectory', context);
        downloads.prepare = async () => directory;
        downloads.saveNative = async (blob, info, target) => saved.push({ bytes: Buffer.from(await blob.arrayBuffer()), info, target });
    }
    return { context, cache, alerts, icon, classes, row, button, saved, calls, directory };
}

test('QQ downloads cache audio bytes, content type, cover and decoded lyrics on rank rows', async () => {
    const bytes = new Uint8Array([102, 76, 97, 67, 1, 2, 3]);
    const { context, cache, alerts, classes, row, saved, directory } = harness(new Response(bytes, { headers: { 'Content-Type': 'audio/flac', 'Content-Length': bytes.length } }));
    context.row = row;
    await vm.runInContext("downloadSong({source:'qq', trackId:'mid'}, row)", context);
    const audio = [...cache.values()].find(value => value.headers.get('content-type') === 'audio/flac');
    assert.ok(audio);
    assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), bytes);
    assert.equal(cache.size, 3);
    assert.equal(classes.has('downloaded'), true);
    assert.deepEqual(alerts, []);
    assert.deepEqual(saved[0].bytes, bytes);
    assert.equal(saved[0].target, directory);
    assert.equal(saved[0].type, 'audio/flac');
});

test('Download errors never cache QQ error JSON as an audio file', async () => {
    const { context, cache, alerts, icon, row } = harness(Response.json({ code: 0, data: { playUrl: {} } }));
    context.row = row;
    await vm.runInContext("downloadSong({source:'qq', trackId:'mid'}, row)", context);
    assert.equal(cache.size, 0);
    assert.equal(icon.className, 'fas fa-download');
    assert.match(alerts[0], /未返回音频文件/);
});

test('Cancelling folder selection starts no network request and restores the download button', async () => {
    const { context, calls, cache, alerts, button, row } = harness(new Response('audio'), { cancelled: true });
    context.row = row;
    await vm.runInContext("downloadSong({source:'qq', trackId:'mid'}, row)", context);
    assert.equal(calls.length, 0);
    assert.equal(cache.size, 0);
    assert.equal(button.disabled, false);
    assert.deepEqual(alerts, []);
});

test('Directory write failures leave the song retryable instead of marking it downloaded', async () => {
    const options = { saveError: '保存目录不可写' };
    const { context, cache, alerts, classes, button, row, saved } = harness(new Response('audio', { headers: { 'Content-Type': 'audio/flac' } }), options);
    context.row = row;
    await vm.runInContext("downloadSong({source:'qq', trackId:'mid'}, row)", context);
    assert.equal(classes.has('downloaded'), false);
    assert.equal(button.disabled, false);
    assert.equal([...cache.values()].some(value => value.headers.get('content-type') === 'audio/flac'), false);
    assert.match(alerts[0], /保存目录不可写/);
    options.saveError = null;
    await vm.runInContext("downloadSong({source:'qq', trackId:'mid'}, row)", context);
    assert.equal(classes.has('downloaded'), true);
    assert.equal(saved.length, 1);
});

test('Previously cached songs can be exported to the chosen folder without downloading again', async () => {
    const { context, cache, calls, saved, directory } = harness(new Response('network'));
    const bytes = new Uint8Array([1, 2, 3, 4]);
    cache.set('https://music-dl.sayqz.com/api/?source=qq&id=mid&type=url&br=flac', new Response(bytes, { headers: { 'Content-Type': 'audio/flac' } }));
    await vm.runInContext("exportSingleSong({source:'qq', trackId:'mid', songName:'歌曲', artist:'歌手'})", context);
    assert.equal(calls.length, 0);
    assert.deepEqual(saved[0].bytes, bytes);
    assert.equal(saved[0].target, directory);
    assert.equal(cache.size, 1);
});

test('A mislabeled FLAC download is saved as FLAC with its original audio bytes', async () => {
    const { context, alerts, classes, row, saved } = harness(new Response(flac(), { headers: { 'Content-Type': 'audio/ogg' } }), { realDirectory: true });
    context.row = row;
    await vm.runInContext("downloadSong({source:'qq', trackId:'mid', songName:'歌曲', artist:'歌手'}, row)", context);
    assert.deepEqual(alerts, []);
    assert.equal(classes.has('downloaded'), true);
    assert.equal(saved[0].info.name, '歌曲 - 歌手.flac');
    assert.equal(saved[0].info.mimeType, 'audio/flac');
    assert.deepEqual(saved[0].bytes, flac());
});

test('A Hi-Res request returning real OGG is rejected and removes the newly fetched audio cache', async () => {
    const { context, alerts, classes, row, saved, cache, button } = harness(new Response(ogg(), { headers: { 'Content-Type': 'audio/flac' } }), { realDirectory: true });
    context.DOM.downloadQualitySelect.value = 'flac24bit';
    context.row = row;
    await vm.runInContext("downloadSong({source:'qq', trackId:'mid'}, row)", context);
    assert.match(alerts[0], /OGG.*Hi-Res 24bit FLAC/);
    assert.equal(saved.length, 0);
    assert.equal(classes.has('downloaded'), false);
    assert.equal(button.disabled, false);
    assert.equal(cache.has('https://music-dl.sayqz.com/api/?source=qq&id=mid&type=url&br=flac24bit'), false);
});

test('Old FLAC caches with an incorrect OGG Content-Type can be re-exported without a network request', async () => {
    const { context, cache, calls, saved } = harness(new Response('network'), { realDirectory: true });
    cache.set('https://music-dl.sayqz.com/api/?source=qq&id=mid&type=url&br=flac', new Response(flac(), { headers: { 'Content-Type': 'audio/ogg' } }));
    await vm.runInContext("exportSingleSong({source:'qq', trackId:'mid', songName:'歌曲', artist:'歌手'})", context);
    assert.equal(calls.length, 0);
    assert.equal(saved[0].info.name, '歌曲 - 歌手.flac');
    assert.deepEqual(saved[0].bytes, flac());
    assert.equal(cache.size, 1);
});
