// 只读取标签和格式信息，跳过音频数据。
class AudioMetadataReader {
    static CHUNK_SIZE = 256 * 1024;
    static MAX_METADATA_SIZE = 64 * 1024 * 1024;

    constructor(size, readBytes) {
        this.size = size;
        this.readBytes = readBytes;
        this.header = null;
    }

    static fromFile(file) {
        return new AudioMetadataReader(file.size, async (offset, length) =>
            new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()));
    }

    static async fromNative(path, size) {
        const { Filesystem, LocalMusicFiles } = Capacitor.Plugins;
        if (!Number.isSafeInteger(size) || size <= 0) {
            size = (await Filesystem.stat({ path })).size;
        }
        return new AudioMetadataReader(size, async (offset, length) => {
            const result = await LocalMusicFiles.readRange({ path, offset, length });
            const binary = atob(result.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            return bytes;
        });
    }

    async read(offset, length) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
            offset < 0 || length < 0 || offset + length > this.size ||
            length > AudioMetadataReader.MAX_METADATA_SIZE) {
            throw new Error('无效的音频标签长度');
        }
        const bytes = new Uint8Array(length);
        let written = 0;
        if (this.header && offset < this.header.length) {
            const cached = this.header.subarray(offset, Math.min(offset + length, this.header.length));
            bytes.set(cached);
            written = cached.length;
        }
        while (written < length) {
            const count = Math.min(AudioMetadataReader.CHUNK_SIZE, length - written);
            const chunk = await this.readBytes(offset + written, count);
            if (chunk.length !== count) throw new Error('音频文件读取不完整');
            bytes.set(chunk, written);
            written += count;
        }
        return bytes;
    }

    join(parts) {
        const size = parts.reduce((sum, part) => sum + part.length, 0);
        if (size > AudioMetadataReader.MAX_METADATA_SIZE) throw new Error('音频标签过大');
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
            bytes.set(part, offset);
            offset += part.length;
        }
        return bytes.buffer;
    }

    async metadata(ext) {
        if (!['flac', 'mp3', 'wav', 'aiff', 'aif', 'm4a', 'aac'].includes(ext) || !this.size) {
            return new ArrayBuffer(0);
        }
        this.header = await this.read(0, Math.min(this.size, 64 * 1024));
        const header = new DataView(this.header.buffer);
        if (ext === 'mp3') {
            let tagSize = 0;
            if (header.byteLength >= 10 && header.getUint8(0) === 0x49 &&
                header.getUint8(1) === 0x44 && header.getUint8(2) === 0x33) {
                tagSize = 10 + ((header.getUint8(6) & 0x7f) << 21) +
                    ((header.getUint8(7) & 0x7f) << 14) +
                    ((header.getUint8(8) & 0x7f) << 7) + (header.getUint8(9) & 0x7f);
                if (header.getUint8(3) === 4 && (header.getUint8(5) & 0x10)) tagSize += 10;
                if (tagSize > this.size || tagSize > AudioMetadataReader.MAX_METADATA_SIZE - 65536) {
                    throw new Error('无效的 ID3 标签长度');
                }
            }
            return (await this.read(0, Math.min(this.size, tagSize + 65536))).buffer;
        }
        if (ext === 'flac') {
            if (header.byteLength < 4 || header.getUint32(0) !== 0x664c6143) return new ArrayBuffer(0);
            const parts = [this.header.slice(0, 4)];
            let offset = 4;
            let retained = 4;
            let lastHeader = null;
            while (offset + 4 <= this.size) {
                const block = await this.read(offset, 4);
                const last = (block[0] & 0x80) !== 0;
                const type = block[0] & 0x7f;
                const size = (block[1] << 16) | (block[2] << 8) | block[3];
                if (offset + 4 + size > this.size) throw new Error('FLAC 标签不完整');
                if ([0, 4, 6].includes(type)) {
                    retained += 4 + size;
                    if (retained > AudioMetadataReader.MAX_METADATA_SIZE) throw new Error('FLAC 标签过大');
                    block[0] = type;
                    parts.push(block, await this.read(offset + 4, size));
                    lastHeader = block;
                }
                offset += 4 + size;
                if (last) break;
            }
            if (lastHeader) lastHeader[0] |= 0x80;
            return this.join(parts);
        }
        if (ext === 'wav' || ext === 'aiff' || ext === 'aif') {
            const wav = ext === 'wav';
            if (header.byteLength < 12 || header.getUint32(0) !== (wav ? 0x52494646 : 0x464f524d)) {
                return new ArrayBuffer(0);
            }
            const parts = [this.header.slice(0, 12)];
            let offset = 12;
            while (offset + 8 <= this.size) {
                const chunk = await this.read(offset, 8);
                const view = new DataView(chunk.buffer);
                const type = view.getUint32(0);
                const size = view.getUint32(4, wav);
                if (wav && type === 0x64617461) {
                    parts.push(chunk);
                    break;
                }
                if (offset + 8 + size > this.size) throw new Error('音频格式块不完整');
                if (type === (wav ? 0x666d7420 : 0x434f4d4d)) {
                    parts.push(chunk, await this.read(offset + 8, size));
                    if (!wav) break;
                    if (size % 2) parts.push(new Uint8Array(1));
                }
                offset += 8 + size + (size % 2);
            }
            return this.join(parts);
        }
        // M4A 的 moov 可位于文件末尾，按 atom 大小直接跳过 mdat。
        let offset = 0;
        while (offset + 8 <= this.size) {
            const atom = new DataView((await this.read(offset, Math.min(16, this.size - offset))).buffer);
            let size = atom.getUint32(0);
            let headerSize = 8;
            if (size === 1) {
                if (atom.byteLength < 16) break;
                size = atom.getUint32(8) * 4294967296 + atom.getUint32(12);
                headerSize = 16;
            } else if (size === 0) {
                size = this.size - offset;
            }
            if (!Number.isSafeInteger(size) || size < headerSize || offset + size > this.size) break;
            if (atom.getUint32(4) === 0x6d6f6f76) {
                if (size > AudioMetadataReader.MAX_METADATA_SIZE) throw new Error('M4A 标签过大');
                const prefix = new Uint8Array(8);
                const prefixView = new DataView(prefix.buffer);
                prefixView.setUint32(0, size - headerSize + 8);
                prefixView.setUint32(4, 0x6d6f6f76);
                return this.join([prefix, await this.read(offset + headerSize, size - headerSize)]);
            }
            offset += size;
        }
        return new ArrayBuffer(0);
    }
}
