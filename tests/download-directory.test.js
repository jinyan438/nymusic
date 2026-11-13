const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { flac, ogg, mp3 } = require('./audio-format-fixtures');

function harness({ native = true, saved = null, plugin = {}, filesystem = {}, picker } = {}) {
    const settings = new Map(saved ? [['downloadDirectory', saved]] : []);
    const context = vm.createContext({
        Response, TextEncoder, Uint8Array, btoa, console, crypto: webcrypto,
        DOM: { downloadDirectoryPath: {}, downloadDirectoryBtn: {} },
        IDB: { getSetting: async (key, fallback) => settings.get(key) || fallback, setSetting: async (key, value) => settings.set(key, value) },
        Capacitor: { isNativePlatform: () => native, Plugins: { MusicDownloads: plugin, Filesystem: filesystem } },
        showDirectoryPicker: picker
    });
    for (const name of ['config', 'native-audio-cache', 'audio-file-format', 'download-directory']) {
        vm.runInContext(readFileSync(join(__dirname, `../www/js/${name}.js`), 'utf8'), context);
    }
    return { directory: vm.runInContext('DownloadDirectory', context), context, settings };
}

test('Android folder selection persists its tree URI and display path and restores after restart', async () => {
    const selection = { uri: 'content://com.android.externalstorage.documents/tree/primary%3AMusic%2F%E7%89%9B%E9%9F%B3', name: '牛音', displayPath: '内部存储 / Music/牛音' };
    const { directory, settings, context } = harness({ plugin: { pickDirectory: async () => selection } });
    await directory.select();
    assert.equal(directory.directory.uri, selection.uri);
    assert.equal(context.DOM.downloadDirectoryPath.textContent, selection.displayPath);
    const restored = harness({ saved: settings.get('downloadDirectory') });
    await restored.directory.load();
    assert.equal(restored.directory.directory.uri, selection.uri);
    assert.equal(restored.context.DOM.downloadDirectoryPath.textContent, selection.displayPath);
});

test('Cancelling the folder picker preserves the previous destination', async () => {
    const saved = { kind: 'native', uri: 'content://tree/previous', name: '以前的目录' };
    const { directory, context, settings } = harness({ saved, plugin: { pickDirectory: async () => ({ cancelled: true }) } });
    await directory.load();
    assert.equal(await directory.select(), null);
    assert.equal(directory.directory.uri, saved.uri);
    assert.equal(settings.get('downloadDirectory'), saved);
    assert.equal(context.DOM.downloadDirectoryBtn.disabled, false);
});

test('Revoked Android folder access opens the system picker again', async () => {
    const saved = { kind: 'native', uri: 'content://tree/old', name: '旧目录' };
    const calls = [];
    const { directory } = harness({ saved, plugin: {
        async getDirectoryInfo() { throw Object.assign(new Error('Revoked'), { code: 'DIRECTORY_PERMISSION' }); },
        async pickDirectory(options) { calls.push(options); return { uri: 'content://tree/new', name: '新目录' }; }
    } });
    await directory.load();
    const target = await directory.prepare();
    assert.equal(target.uri, 'content://tree/new');
    assert.equal(calls[0].initialUri, saved.uri);
});

test('Downloads prepare reusable native audio in bounded chunks before exporting identical bytes', async () => {
    const chunks = [];
    const removed = [];
    const writes = [];
    const renames = [];
    const { directory } = harness({ plugin: { async saveCachedFile(options) { writes.push(options); return { uri: 'content://music/song' }; } }, filesystem: {
        async writeFile(options) { chunks.push(Buffer.from(options.data, 'base64')); },
        async appendFile(options) { chunks.push(Buffer.from(options.data, 'base64')); },
        async rename(options) { renames.push(options); },
        async getUri({ path }) { return { uri: `file:///cache/${path}` }; },
        async deleteFile(options) { removed.push(options); }
    } });
    const bytes = Uint8Array.from({ length: 450001 }, (_, i) => i % 251);
    bytes.set(flac());
    const target = { kind: 'native', uri: 'content://tree/selected' };
    await directory.save(new Response(bytes, { headers: { 'Content-Type': 'audio/flac' } }), { songName: '歌曲', artist: '歌手' }, 'flac', target);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from(bytes));
    assert.ok(chunks.every(chunk => chunk.length <= 192 * 1024));
    assert.equal(writes[0].directoryUri, target.uri);
    assert.equal(writes[0].name, '歌曲 - 歌手.flac');
    assert.equal(writes[0].mimeType, 'audio/flac');
    assert.equal(removed.length, 0);
    assert.equal(renames.length, 1);
    assert.match(renames[0].from, /\.part$/);
    assert.match(renames[0].to, /^bass-playback\/[a-f0-9]{64}\.audio$/);
    assert.equal(writes[0].sourceUri, `file:///cache/${renames[0].to}`);
});

test('Directory export failures preserve the complete native audio for playback', async () => {
    const removed = [];
    const { directory } = harness({ plugin: { async saveCachedFile() { throw new Error('Disk full'); } }, filesystem: {
        async writeFile() {}, async rename() {}, async getUri() { return { uri: 'file:///cache/audio.audio' }; }, async deleteFile(options) { removed.push(options); }
    } });
    await assert.rejects(directory.save(new Response(mp3()), {}, '128k', { kind: 'native', uri: 'content://tree/selected' }), /Disk full/);
    assert.equal(removed.length, 0);
});

test('Incomplete native cache writes are removed and never exported', async () => {
    const removed = [];
    const { directory } = harness({ plugin: { async saveCachedFile() { assert.fail('Incomplete song exported'); } }, filesystem: {
        async writeFile() {}, async appendFile() { throw new Error('Disk full'); },
        async deleteFile(options) { removed.push(options); }
    } });
    const bytes = Buffer.alloc(450000); flac().copy(bytes);
    await assert.rejects(directory.save(new Response(bytes), {}, 'flac', { kind: 'native', uri: 'content://tree/selected' }), /Disk full/);
    assert.equal(removed.length, 1);
    assert.match(removed[0].path, /\.part$/);
});

test('Filenames preserve the detected audio format and remove invalid path characters', () => {
    const { directory } = harness();
    assert.equal(directory.fileInfo({ songName: '歌/曲:?', artist: '歌手*' }, { extension: 'mp3', mimeType: 'audio/mpeg' }).name, '歌_曲__ - 歌手_.mp3');
    const info = directory.fileInfo({ songName: '歌'.repeat(200), artist: '人' }, { extension: 'flac', mimeType: 'audio/flac' });
    assert.ok(Buffer.byteLength(info.name) < 255);
    assert.ok(info.name.endsWith('.flac'));
});

test('Web folder selection requests write access and persists the handle', async () => {
    const handle = { name: 'Music', async queryPermission() { return 'prompt'; }, async requestPermission() { return 'granted'; } };
    const calls = [];
    const { directory, settings } = harness({ native: false, picker: async options => { calls.push(options); return handle; } });
    const selected = await directory.prepare();
    assert.equal(calls[0].mode, 'readwrite');
    assert.equal(settings.get('downloadDirectory').handle, handle);
    assert.equal(selected.handle, handle);
    assert.equal((await directory.prepare()).handle, handle);
});

test('Web saves avoid overwriting existing audio files or folders', async () => {
    const files = new Map([['歌曲 - 歌手.flac', 'existing audio'], ['歌曲 - 歌手 (1).flac', 'existing folder']]);
    const handle = { async getFileHandle(name, options) {
        if (!options?.create) {
            if (files.get(name) === 'existing folder') throw Object.assign(new Error(), { name: 'TypeMismatchError' });
            if (!files.has(name)) throw Object.assign(new Error(), { name: 'NotFoundError' });
            return {};
        }
        return { async createWritable() { return { async write(blob) { files.set(name, Buffer.from(await blob.arrayBuffer())); }, async close() {} }; } };
    } };
    const { directory } = harness({ native: false });
    const result = await directory.save(new Response(flac(), { headers: { 'Content-Type': 'audio/flac' } }), { songName: '歌曲', artist: '歌手' }, 'flac', { kind: 'web', handle });
    assert.equal(result.name, '歌曲 - 歌手 (2).flac');
    assert.equal(files.get('歌曲 - 歌手.flac'), 'existing audio');
    assert.equal(files.get('歌曲 - 歌手 (1).flac'), 'existing folder');
    assert.deepEqual(files.get(result.name), flac());
});

test('FLAC audio mislabeled as audio/ogg is exported with a FLAC filename and MIME type', async () => {
    const { directory } = harness();
    const writes = [];
    directory.saveNative = async (blob, info) => { writes.push({ bytes: Buffer.from(await blob.arrayBuffer()), info }); };
    for (const quality of ['flac', 'flac24bit']) {
        await directory.save(new Response(flac(), { headers: { 'Content-Type': 'audio/ogg' } }), { songName: '歌曲', artist: '歌手' }, quality, { kind: 'native' });
    }
    assert.equal(writes.length, 2);
    for (const saved of writes) {
        assert.equal(saved.info.name, '歌曲 - 歌手.flac');
        assert.equal(saved.info.mimeType, 'audio/flac');
        assert.deepEqual(saved.bytes, flac());
    }
});

test('FLAC and Hi-Res selections reject real OGG data before creating any exported file', async () => {
    const { directory } = harness();
    let writes = 0;
    directory.saveNative = async () => { writes++; };
    for (const quality of ['flac', 'flac24bit']) {
        await assert.rejects(directory.save(new Response(ogg(), { headers: { 'Content-Type': 'audio/flac' } }), {}, quality, { kind: 'native' }), /OGG.*FLAC/);
    }
    assert.equal(writes, 0);
});
