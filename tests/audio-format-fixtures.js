function flac() {
    const bytes = Buffer.alloc(42);
    bytes.write('fLaC');
    bytes[4] = 0x80;
    bytes.writeUIntBE(34, 5, 3);
    bytes.writeUInt16BE(16, 8);
    bytes.writeUInt16BE(16, 10);
    bytes.writeBigUInt64BE((96000n << 44n) | (1n << 41n) | (23n << 36n) | 64n, 18);
    return bytes;
}

function ogg(codec = 'vorbis') {
    const packet = codec === 'opus' ? Buffer.concat([Buffer.from('OpusHead'), Buffer.alloc(11)])
        : codec === 'flac' ? Buffer.concat([Buffer.from([0x7f]), Buffer.from('FLAC'), Buffer.alloc(4), flac()])
        : Buffer.concat([Buffer.from([1]), Buffer.from('vorbis'), Buffer.alloc(23)]);
    const header = Buffer.alloc(28);
    header.write('OggS'); header[5] = 2; header[26] = 1; header[27] = packet.length;
    return Buffer.concat([header, packet]);
}

function mp3() { return Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x64]), Buffer.alloc(413)]); }

module.exports = { flac, ogg, mp3 };
