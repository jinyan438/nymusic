// 与原生解码器共享按缓存键命名的文件，下载完成后即可直接播放。
const NativeAudioCache = {
    sequence: 0,
    epoch: 0,

    filesystem(capacitor = globalThis.Capacitor) {
        return capacitor.Plugins?.Filesystem || capacitor.registerPlugin('Filesystem');
    },

    async path(key) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
        const name = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        return `bass-playback/${name}.audio`;
    },

    async getOrCreate(response, key, capacitor, cancelled = () => false) {
        const path = await this.path(key);
        const filesystem = this.filesystem(capacitor);
        try {
            const info = await filesystem.stat({ path, directory: 'CACHE' });
            // 已有原生文件时不再读取整首 CacheStorage 音频。
            if (info.size > 0) return (await filesystem.getUri({ path, directory: 'CACHE' })).uri;
        } catch (_) { /* 首次播放旧缓存或系统回收文件后，补建原生文件。 */ }
        if (cancelled()) throw new Error('Playback cancelled');
        return this.store(await response.blob(), key, capacitor, cancelled, path);
    },

    async store(blob, key, capacitor, cancelled = () => false, path) {
        if (!blob.size) throw new Error('歌曲缓存为空');
        path ||= await this.path(key);
        const filesystem = this.filesystem(capacitor);
        const epoch = this.epoch;
        const temporary = `${path}.${Date.now()}-${++this.sequence}.part`;
        const check = () => { if (cancelled() || epoch !== this.epoch) throw new Error('Playback cancelled'); };
        try {
            for (let offset = 0; offset < blob.size; offset += 192 * 1024) {
                check();
                const bytes = new Uint8Array(await blob.slice(offset, offset + 192 * 1024).arrayBuffer());
                let binary = '';
                for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
                const options = { path: temporary, directory: 'CACHE', data: btoa(binary) };
                if (offset === 0) await filesystem.writeFile({ ...options, recursive: true });
                else await filesystem.appendFile(options);
            }
            check();
            await filesystem.rename({ from: temporary, to: path, directory: 'CACHE', toDirectory: 'CACHE' });
            return (await filesystem.getUri({ path, directory: 'CACHE' })).uri;
        } catch (error) {
            await filesystem.deleteFile({ path: temporary, directory: 'CACHE' }).catch(() => {});
            throw error;
        }
    },

    async clear() {
        ++this.epoch;
        if (!globalThis.Capacitor?.isNativePlatform?.()) return;
        const filesystem = this.filesystem();
        try { await filesystem.rmdir({ path: 'bass-playback', directory: 'CACHE', recursive: true }); }
        catch (error) {
            // 文件夹尚未创建时，清理已经完成；其他错误应保留给调用方处理。
            try { await filesystem.stat({ path: 'bass-playback', directory: 'CACHE' }); }
            catch (_) { return; }
            throw error;
        }
    }
};
