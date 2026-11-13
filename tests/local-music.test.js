const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');

function loadMusic(plugins = {}) {
    const context = vm.createContext({
        console: { log() {}, warn() {}, error() {} },
        TextDecoder, Uint8Array, ArrayBuffer, DataView, atob, btoa,
        setTimeout, clearTimeout,
        DOM: { scanLocalBtn: {}, localScanStatus: {}, scanProgressFill: { style: {} }, localScanProgress: { style: {} } },
        Capacitor: { Plugins: plugins, isNativePlatform: () => true }
    });
    for (const file of ['audio-metadata-reader.js', 'local-music.js']) {
        vm.runInContext(readFileSync(join(__dirname, '../www/js', file), 'utf8'), context, { filename: file });
    }
    const music = vm.runInContext('LocalMusic', context);
    music.getAudioDuration = async () => 240;
    return { music, context, Reader: vm.runInContext('AudioMetadataReader', context) };
}

// 稀疏的虚拟大文件：不分配音频主体，并记录实际读取的范围。
function sparseFile(name, size, parts, lastModified = 1000) {
    const reads = [];
    const read = (offset, length) => {
        reads.push({ offset, length });
        const bytes = Buffer.alloc(length);
        for (const [position, data] of parts) {
            const start = Math.max(offset, position);
            const end = Math.min(offset + length, position + data.length);
            if (end > start) data.copy(bytes, start - offset, start - position, end - position);
        }
        return bytes;
    };
    return {
        name, size, lastModified, reads, read,
        slice(start, end) {
            return { arrayBuffer: async () => Uint8Array.from(read(start, end - start)).buffer };
        },
        arrayBuffer() { throw new Error('扫描不得读取整个音频文件'); }
    };
}

function wavFile(name = 'music.wav', channels = 2) {
    const size = 100 * 1024 * 1024;
    const header = Buffer.alloc(44);
    header.write('RIFF');
    header.writeUInt32LE(size - 8, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(192000, 24);
    header.writeUInt32LE(192000 * channels * 3, 28);
    header.writeUInt16LE(channels * 3, 32);
    header.writeUInt16LE(24, 34);
    header.write('data', 36);
    header.writeUInt32LE(size - 44, 40);
    return sparseFile(name, size, [[0, header]]);
}

function nativePlugins(files, directories, delay = 0) {
    let active = 0;
    let peak = 0;
    return {
        get peak() { return peak; },
        Filesystem: {
            async readdir({ path, directory }) {
                assert.equal(directory, undefined);
                if (!directories[path]) throw new Error('permission denied');
                return { files: directories[path] };
            },
            async stat({ path }) { return { size: files[path].size }; },
            readFile() { throw new Error('不得通过桥接传输整个音频文件'); }
        },
        LocalMusicFiles: {
            async readRange({ path, offset, length }) {
                assert.ok(length <= 256 * 1024);
                active++;
                peak = Math.max(peak, active);
                try {
                    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
                    return { data: files[path].read(offset, length).toString('base64') };
                } finally { active--; }
            }
        }
    };
}

function flacBlock(type, data, last = false) {
    const prefix = Buffer.alloc(4);
    prefix[0] = type | (last ? 0x80 : 0);
    prefix.writeUIntBE(data.length, 1, 3);
    return Buffer.concat([prefix, data]);
}

function flacFile() {
    const stream = Buffer.alloc(34);
    stream.writeBigUInt64BE((96000n << 44n) | (1n << 41n) | (23n << 36n) | 23040000n, 10);
    const comments = ['TITLE=测试歌曲', 'ARTIST=测试歌手', 'ALBUM=测试专辑', 'LYRICS=[00:01.00]测试歌词'];
    const fields = [Buffer.alloc(8)];
    fields[0].writeUInt32LE(comments.length, 4);
    for (const comment of comments) {
        const text = Buffer.from(comment);
        const length = Buffer.alloc(4);
        length.writeUInt32LE(text.length);
        fields.push(length, text);
    }
    const cover = Buffer.alloc(700 * 1024, 0x5a);
    cover.set([0xff, 0xd8, 0xff]);
    const picture = Buffer.alloc(42);
    picture.writeUInt32BE(3);
    picture.writeUInt32BE(10, 4);
    picture.write('image/jpeg', 8);
    picture.writeUInt32BE(cover.length, 38);
    const start = Buffer.concat([Buffer.from('fLaC'), flacBlock(0, stream), flacBlock(1, Buffer.alloc(2 * 1024 * 1024))]);
    const tags = Buffer.concat([flacBlock(4, Buffer.concat(fields)), flacBlock(6, Buffer.concat([picture, cover]), true)]);
    return { file: sparseFile('music.flac', 512 * 1024 * 1024, [[0, start], [start.length, tags]]), cover };
}

function atom(type, ...parts) {
    const payload = Buffer.concat(parts);
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, payload]);
}

function m4aFile(extendedMoov = false) {
    const moovOffset = 5 * 1024 * 1024 * 1024;
    const ftyp = atom('ftyp', Buffer.alloc(16));
    const mdat = Buffer.alloc(16);
    mdat.writeUInt32BE(1);
    mdat.write('mdat', 4);
    mdat.writeBigUInt64BE(BigInt(moovOffset - ftyp.length), 8);
    const mvhd = Buffer.alloc(100);
    mvhd.writeUInt32BE(1000, 12);
    mvhd.writeUInt32BE(240000, 16);
    const title = atom('©nam', atom('data', Buffer.alloc(8), Buffer.from('尾部标签')));
    const lyrics = atom('©lyr', atom('data', Buffer.alloc(8), Buffer.from('[00:01]歌词')));
    const cover = Buffer.alloc(300 * 1024, 0x55);
    cover.set([0x89, 0x50, 0x4e, 0x47]);
    let moov = atom('moov', atom('mvhd', mvhd), atom('udta', atom('meta', Buffer.alloc(4),
        atom('ilst', title, lyrics, atom('covr', atom('data', Buffer.alloc(8), cover))))));
    if (extendedMoov) {
        const header = Buffer.alloc(16);
        header.writeUInt32BE(1);
        header.write('moov', 4);
        header.writeBigUInt64BE(BigInt(moov.length + 8), 8);
        moov = Buffer.concat([header, moov.subarray(8)]);
    }
    return { file: sparseFile('music.m4a', moovOffset + moov.length, [[0, ftyp], [ftyp.length, mdat], [moovOffset, moov]]), cover };
}

test('WAV 扫描仅读取 64 KiB，保留 24bit/192kHz 和单声道时长', async () => {
    const { music } = loadMusic();
    for (const channels of [1, 2]) {
        const file = wavFile('music.wav', channels);
        const metadata = await music.parseAudioMetadata(file);
        assert.equal(metadata.bitDepth, 24);
        assert.equal(metadata.sampleRate, 192000);
        assert.equal(metadata.duration, (file.size - 44) / (192000 * channels * 3));
        assert.equal(file.reads.reduce((sum, read) => sum + read.length, 0), 65536);
    }
});

test('FLAC 跳过 padding 和音频，完整保留大封面、歌词和 Hi-Res 信息', async () => {
    const { music } = loadMusic();
    const { file, cover } = flacFile();
    const metadata = await music.parseAudioMetadata(file);
    assert.equal(metadata.title, '测试歌曲');
    assert.equal(metadata.artist, '测试歌手');
    assert.equal(metadata.album, '测试专辑');
    assert.equal(metadata.lyrics, '[00:01.00]测试歌词');
    assert.equal(metadata.bitDepth, 24);
    assert.equal(metadata.sampleRate, 96000);
    assert.equal(metadata.duration, 240);
    assert.equal(metadata.cover, cover.toString('base64'));
    assert.equal(metadata.coverMimeType, 'image/jpeg');
    assert.ok(file.reads.reduce((sum, read) => sum + read.length, 0) < 800 * 1024);
    assert.ok(file.reads.every(read => read.length <= 256 * 1024));
});

test('MP3 完整读取超过首块的大 ID3 封面和歌词，不读取音频主体', async () => {
    const frame = (id, payload) => {
        const header = Buffer.alloc(10);
        header.write(id);
        header.writeUInt32BE(payload.length, 4);
        return Buffer.concat([header, payload]);
    };
    const cover = Buffer.alloc(400 * 1024, 0x6a);
    cover.set([0xff, 0xd8, 0xff]);
    const tags = Buffer.concat([
        frame('TIT2', Buffer.concat([Buffer.from([3]), Buffer.from('MP3 标题')])),
        frame('USLT', Buffer.concat([Buffer.from([3]), Buffer.from('eng\0[00:01]歌词')])),
        frame('APIC', Buffer.concat([Buffer.from([3]), Buffer.from('image/jpeg\0'), Buffer.from([3, 0]), cover]))
    ]);
    const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) header[9 - i] = (tags.length >> (7 * i)) & 0x7f;
    const file = sparseFile('music.mp3', 120 * 1024 * 1024, [[0, Buffer.concat([header, tags, Buffer.from([0xff, 0xfb, 0x90, 0])])]]);
    const { music } = loadMusic();
    const metadata = await music.parseAudioMetadata(file);
    assert.equal(metadata.title, 'MP3 标题');
    assert.equal(metadata.lyrics, '[00:01]歌词');
    assert.equal(metadata.cover, cover.toString('base64'));
    assert.ok(file.reads.reduce((sum, read) => sum + read.length, 0) < 500 * 1024);
});

test('M4A 直接跳到 5 GiB 文件末尾的 moov，支持扩展 atom 长度', async () => {
    const { music } = loadMusic();
    for (const extended of [false, true]) {
        const { file, cover } = m4aFile(extended);
        const metadata = await music.parseAudioMetadata(file);
        assert.equal(metadata.title, '尾部标签');
        assert.equal(metadata.lyrics, '[00:01]歌词');
        assert.equal(metadata.duration, 240);
        assert.equal(metadata.cover, cover.toString('base64'));
        assert.ok(file.reads.reduce((sum, read) => sum + read.length, 0) < 400 * 1024);
    }
});

test('AIFF 可跳过声音块读取 COMM，保留采样率和时长', async () => {
    const offset = 16 * 1024 * 1024;
    const header = Buffer.alloc(20);
    header.write('FORM');
    header.writeUInt32BE(offset + 18, 4);
    header.write('AIFFSSND', 8);
    header.writeUInt32BE(offset - 20, 16);
    const comm = Buffer.alloc(26);
    comm.write('COMM');
    comm.writeUInt32BE(18, 4);
    comm.writeUInt16BE(2, 8);
    comm.writeUInt32BE(441000, 10);
    comm.writeUInt16BE(24, 14);
    Buffer.from('400eac44000000000000', 'hex').copy(comm, 16);
    const file = sparseFile('music.aiff', offset + comm.length, [[0, header], [offset, comm]]);
    const { music } = loadMusic();
    const metadata = await music.parseAudioMetadata(file);
    assert.equal(metadata.sampleRate, 44100);
    assert.equal(metadata.bitDepth, 24);
    assert.equal(metadata.duration, 10);
    assert.ok(file.reads.reduce((sum, read) => sum + read.length, 0) < 66000);
});

test('Android 扫描限制为 4 路读取，递归顺序稳定并忽略非音频', async () => {
    const files = {};
    const entries = [];
    for (let i = 0; i < 12; i++) {
        const file = wavFile(`track${i}.wav`);
        files['/Music/' + file.name] = file;
        entries.push({ name: file.name, type: 'file', size: file.size, mtime: file.lastModified });
    }
    entries.splice(3, 0, { name: 'Album', type: 'directory' });
    entries.push({ name: 'notes.txt', type: 'file' });
    const nested = wavFile('nested.wav');
    files['/Music/Album/nested.wav'] = nested;
    const plugins = nativePlugins(files, { '/Music': entries, '/Music/Album': [
        { name: nested.name, type: 'file', size: nested.size, mtime: nested.lastModified }
    ] }, 5);
    const { music } = loadMusic(plugins);
    const tracks = await music.scanNativeDirectory('/Music');
    assert.equal(tracks.length, 13);
    assert.equal(tracks[3].filePath, '/Music/Album/nested.wav');
    assert.equal(tracks[4].fileName, 'track3.wav');
    assert.equal(plugins.peak, 4);
    assert.ok(tracks.every(track => track.isHiRes && track.metadataVersion === music.METADATA_VERSION));
    assert.equal(music.scanProgress.current, 13);
});

test('刷新跳过未变文件，重读修改/新增/旧版本文件，移除已删除歌曲并保留 ID', async () => {
    const files = {};
    const entries = [];
    for (const name of ['same.wav', 'changed.wav', 'resized.wav', 'legacy.wav', 'deleted.wav']) {
        const file = wavFile(name);
        files['/Music/' + name] = file;
        entries.push({ name, type: 'file', size: file.size, mtime: file.lastModified });
    }
    const plugins = nativePlugins(files, { '/Music': entries });
    const { music } = loadMusic(plugins);
    const previous = await music.scanNativeDirectory('/Music');
    for (const file of Object.values(files)) file.reads.length = 0;
    entries.find(entry => entry.name === 'changed.wav').mtime++;
    entries.find(entry => entry.name === 'resized.wav').size++;
    previous.find(track => track.fileName === 'legacy.wav').metadataVersion = 0;
    entries.splice(entries.findIndex(entry => entry.name === 'deleted.wav'), 1);
    const added = wavFile('new.wav');
    files['/Music/new.wav'] = added;
    entries.push({ name: added.name, type: 'file', size: added.size, mtime: added.lastModified });
    const tracks = await music.scanNativeDirectory('/Music', previous);
    assert.equal(files['/Music/same.wav'].reads.length, 0);
    for (const name of ['changed.wav', 'resized.wav', 'legacy.wav', 'new.wav']) {
        assert.ok(files['/Music/' + name].reads.length > 0);
    }
    assert.equal(tracks.length, 5);
    assert.ok(tracks.every(track => track.fileName !== 'deleted.wav'));
    assert.equal(tracks[1].trackId, previous[1].trackId);
});

test('Web 扫描和刷新也复用缓存，修改时间未知时重新解析', async () => {
    const file = wavFile();
    const handle = { async *values() { yield { name: file.name, kind: 'file', getFile: async () => file }; } };
    const { music } = loadMusic();
    const tracks = await music.scanDirectoryRecursive(handle, '');
    file.reads.length = 0;
    const refreshed = await music.scanDirectoryRecursive(handle, '', tracks);
    assert.equal(file.reads.length, 0);
    assert.equal(refreshed[0].trackId, tracks[0].trackId);
    file.lastModified = 0;
    await music.scanDirectoryRecursive(handle, '', refreshed);
    assert.ok(file.reads.length > 0);
});

test('读取失败不会缓存成成功；单个损坏文件不阻止其它歌曲', async () => {
    const broken = wavFile('broken.wav');
    broken.slice = () => ({ arrayBuffer: async () => { throw new Error('cannot read'); } });
    const valid = wavFile('valid.wav');
    const { music } = loadMusic();
    const handle = { async *values() {
        for (const file of [broken, valid]) yield { name: file.name, kind: 'file', getFile: async () => file };
    } };
    const tracks = await music.scanDirectoryRecursive(handle, '');
    assert.equal(tracks.length, 2);
    assert.equal(tracks[0].metadataVersion, 0);
    assert.equal(tracks[1].metadataVersion, music.METADATA_VERSION);
});

test('根目录读取失败时刷新保留原歌单，释放扫描锁', async () => {
    const { music, context } = loadMusic(nativePlugins({}, {}));
    const tracks = [{ trackId: 'keep', filePath: '/Music/a.wav' }];
    music.localPlaylists = [{ path: '/Music', tracks }];
    music.saveLocalPlaylists = async () => assert.fail('失败的扫描不能保存为空歌单');
    await music.refreshLocalPlaylist(0);
    assert.equal(music.localPlaylists[0].tracks, tracks);
    assert.equal(music.scanInProgress, false);
    assert.match(context.DOM.localScanStatus.textContent, /刷新失败/);
    clearTimeout(music.scanHideTimer);
});

test('恶意标签长度和短读会失败，不分配或传输完整音频', async () => {
    const { Reader } = loadMusic();
    const bad = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f]);
    const file = sparseFile('bad.mp3', 1024 * 1024 * 1024, [[0, bad]]);
    await assert.rejects(Reader.fromFile(file).metadata('mp3'), /ID3/);
    assert.equal(file.reads.length, 1);
    const short = new Reader(100, async () => new Uint8Array(1));
    await assert.rejects(short.read(0, 10), /不完整/);
    await assert.rejects(short.read(-1, 1), /无效/);
});
