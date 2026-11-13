const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { flac, ogg, mp3 } = require('./audio-format-fixtures');

const context = vm.createContext({ Uint8Array });
vm.runInContext(readFileSync(join(__dirname, '../www/js/audio-file-format.js'), 'utf8'), context);
const formats = vm.runInContext('AudioFileFormat', context);

test('Real 24bit FLAC bytes are recognized independently of the reported MIME type', async () => {
    const bytes = readFileSync(join(__dirname, '../android/app/src/androidTest/assets/pcm24-96000.flac'));
    const format = await formats.inspect(new Blob([bytes], { type: 'audio/ogg' }));
    assert.equal(format.extension, 'flac');
    assert.equal(format.mimeType, 'audio/flac');
    formats.assertQuality(format, 'flac24bit');
});

test('OGG containers retain their own format regardless of the enclosed codec', async () => {
    for (const codec of ['vorbis', 'opus', 'flac']) {
        const format = await formats.inspect(new Blob([ogg(codec)], { type: 'audio/flac' }));
        assert.equal(format.extension, 'ogg');
        assert.equal(format.mimeType, 'audio/ogg');
        formats.assertQuality(format, '128k');
        assert.throws(() => formats.assertQuality(format, 'flac'), /OGG.*FLAC/);
    }
});

test('MP3, ADTS AAC, WAV and M4A signatures are recognized without a Content-Type', async () => {
    const cases = [
        ['mp3', mp3()],
        ['aac', Buffer.from([0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc])],
        ['wav', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(24)])],
        ['m4a', Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(12)])]
    ];
    for (const [extension, bytes] of cases) {
        const format = await formats.inspect(new Blob([bytes]));
        assert.equal(format.extension, extension);
        assert.throws(() => formats.assertQuality(format, 'flac24bit'), /FLAC/);
    }
});

test('Large ID3 tags are skipped with bounded reads before inspecting MP3 or FLAC data', async () => {
    const size = 100000;
    const tag = Buffer.alloc(size + 10);
    tag.write('ID3'); tag[3] = 4;
    tag[6] = (size >> 21) & 127; tag[7] = (size >> 14) & 127;
    tag[8] = (size >> 7) & 127; tag[9] = size & 127;
    for (const [extension, audio] of [['mp3', mp3()], ['flac', flac()]]) {
        const blob = new Blob([tag, audio]);
        const slices = [];
        const format = await formats.inspect({ size: blob.size, slice(start, end) {
            slices.push([start, end]);
            assert.ok(end - start <= 512);
            return blob.slice(start, end);
        } });
        assert.equal(format.extension, extension);
        assert.deepEqual(slices, [[0, 512], [tag.length, tag.length + 512]]);
    }
});

test('ID3v2.4 footers do not get mistaken for the audio header', async () => {
    const tag = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0x10, 0, 0, 0, 0]);
    const format = await formats.inspect(new Blob([tag, Buffer.alloc(10), mp3()]));
    assert.equal(format.extension, 'mp3');
});

test('Empty, non-audio and truncated files are rejected despite an audio MIME type', async () => {
    await assert.rejects(formats.inspect(new Blob()), /为空/);
    for (const bytes of [Buffer.from('{"error":"expired"}'), Buffer.from('<html>error</html>'), Buffer.from('fLaC'), ogg().subarray(0, 26), Buffer.alloc(20)]) {
        await assert.rejects(formats.inspect(new Blob([bytes], { type: 'audio/flac' })), /无法识别/);
    }
});
