// 根据文件内容识别导出格式；接口的 Content-Type 可能与音频内容不一致。
const AudioFileFormat = {
    async inspect(blob) {
        if (!blob.size) throw new Error('音频文件为空');
        let offset = 0;
        let bytes = new Uint8Array(await blob.slice(0, 512).arrayBuffer());
        const matches = (text, start = 0) => bytes.length >= start + text.length &&
            Array.from(text).every((char, index) => bytes[start + index] === char.charCodeAt(0));

        // MP3 和部分 FLAC 文件在音频前带有 ID3 标签。跳过标签，而非读取整个标签到内存。
        if (matches('ID3') && bytes.length >= 10 && [2, 3, 4].includes(bytes[3]) &&
            bytes.subarray(6, 10).every(value => value < 128)) {
            const size = bytes[6] * 0x200000 + bytes[7] * 0x4000 + bytes[8] * 0x80 + bytes[9];
            offset = 10 + size + (bytes[3] === 4 && (bytes[5] & 0x10) ? 10 : 0);
            bytes = new Uint8Array(await blob.slice(offset, offset + 512).arrayBuffer());
        }

        if (matches('fLaC') && blob.size - offset >= 42 && (bytes[4] & 0x7f) === 0 &&
            bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 34) {
            return { extension: 'flac', mimeType: 'audio/flac', label: 'FLAC' };
        }
        if (matches('OggS') && bytes.length >= 27 && bytes[4] === 0 && bytes.length >= 27 + bytes[26]) {
            return { extension: 'ogg', mimeType: 'audio/ogg', label: 'OGG' };
        }
        if ((matches('RIFF') || matches('RF64') || matches('RIFX')) && matches('WAVE', 8)) {
            return { extension: 'wav', mimeType: 'audio/wav', label: 'WAV' };
        }
        if (matches('ftyp', 4) && bytes.length >= 12) {
            return { extension: 'm4a', mimeType: 'audio/mp4', label: 'M4A' };
        }
        if (bytes.length >= 7 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) {
            return { extension: 'aac', mimeType: 'audio/aac', label: 'AAC' };
        }
        if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 &&
            (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) !== 0 &&
            (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0x0c) !== 0x0c) {
            return { extension: 'mp3', mimeType: 'audio/mpeg', label: 'MP3' };
        }
        throw new Error('无法识别下载文件的音频格式，请重试或更换音源');
    },

    assertQuality(format, quality) {
        if ((quality === 'flac' || quality === 'flac24bit') && format.extension !== 'flac') {
            const selected = quality === 'flac24bit' ? 'Hi-Res 24bit FLAC' : 'FLAC';
            throw new Error(`接口实际返回 ${format.label}，不是所选的 ${selected}，已取消保存`);
        }
    }
};
