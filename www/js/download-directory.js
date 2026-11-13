const DownloadDirectory = {
    directory: null,
    selecting: false,
    webWrites: Promise.resolve(),

    isNative() { return !!globalThis.Capacitor?.isNativePlatform?.(); },

    nativePlugin() {
        const capacitor = globalThis.Capacitor;
        return this.plugin ||= capacitor.Plugins?.MusicDownloads || capacitor.registerPlugin('MusicDownloads');
    },

    async load() {
        const saved = await IDB.getSetting('downloadDirectory', null);
        if (saved?.kind === (this.isNative() ? 'native' : 'web')) this.directory = saved;
        this.render();
    },

    render() {
        const label = DOM.downloadDirectoryPath;
        if (!label) return;
        label.textContent = this.directory?.displayPath || this.directory?.name || '选择文件夹';
        label.title = label.textContent;
    },

    async select() {
        if (this.selecting) return null;
        this.selecting = true;
        if (DOM.downloadDirectoryBtn) DOM.downloadDirectoryBtn.disabled = true;
        try {
            let selected;
            if (this.isNative()) {
                const result = await this.nativePlugin().pickDirectory({ initialUri: this.directory?.uri });
                if (result.cancelled) return null;
                selected = { kind: 'native', uri: result.uri, name: result.name, displayPath: result.displayPath };
            } else {
                if (typeof globalThis.showDirectoryPicker !== 'function') throw new Error('当前浏览器不支持选择下载目录，请使用 Chrome 或 Edge');
                const handle = await globalThis.showDirectoryPicker({ id: 'niuyin-downloads', mode: 'readwrite', startIn: this.directory?.handle || 'music' });
                selected = { kind: 'web', handle, name: handle.name, displayPath: handle.name };
            }
            await IDB.setSetting('downloadDirectory', selected);
            this.directory = selected;
            this.render();
            return selected;
        } catch (error) {
            if (error.name === 'AbortError') return null;
            throw error;
        } finally {
            this.selecting = false;
            if (DOM.downloadDirectoryBtn) DOM.downloadDirectoryBtn.disabled = false;
        }
    },

    async prepare() {
        if (!this.directory) return this.select();
        const directory = this.directory;
        if (directory.kind === 'native') {
            try { await this.nativePlugin().getDirectoryInfo({ uri: directory.uri }); }
            catch (error) {
                if (error.code === 'DIRECTORY_PERMISSION') return this.select();
                throw error;
            }
        } else {
            const options = { mode: 'readwrite' };
            let permission = await directory.handle.queryPermission(options);
            if (permission !== 'granted') permission = await directory.handle.requestPermission(options);
            if (permission !== 'granted') throw new Error('没有下载目录的写入权限，请在设置中重新选择文件夹');
        }
        // 后续切换设置不会改变这次下载的目标目录。
        return directory;
    },

    fileInfo(dataset, format) {
        let basename = `${dataset.songName || '未知歌曲'} - ${dataset.artist || '未知歌手'}`
            .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
        const characters = Array.from(basename);
        while (new TextEncoder().encode(characters.join('')).length > 220) characters.pop();
        basename = characters.join('') || '音乐';
        return { name: `${basename}.${format.extension}`, mimeType: format.mimeType };
    },

    async save(response, dataset, quality, directory) {
        const blob = await response.blob();
        const format = await AudioFileFormat.inspect(blob);
        AudioFileFormat.assertQuality(format, quality);
        const info = this.fileInfo(dataset, format);
        if (directory.kind === 'native') return this.saveNative(blob, info, directory, CacheKeys.getSongKey(dataset.source, dataset.trackId, quality));
        const write = this.webWrites.catch(() => {}).then(() => this.saveWeb(blob, info, directory));
        this.webWrites = write;
        return write;
    },

    async saveNative(blob, info, directory, key) {
        const sourceUri = await NativeAudioCache.store(blob, key, globalThis.Capacitor);
        return this.nativePlugin().saveCachedFile({ directoryUri: directory.uri, sourceUri, ...info });
    },

    async saveWeb(blob, info, directory) {
        const dot = info.name.lastIndexOf('.');
        let name = info.name;
        for (let index = 0; ; index++) {
            if (index) name = `${info.name.slice(0, dot)} (${index})${info.name.slice(dot)}`;
            try { await directory.handle.getFileHandle(name); }
            catch (error) {
                if (error.name === 'NotFoundError') break;
                if (error.name === 'TypeMismatchError') continue;
                throw error;
            }
        }
        const file = await directory.handle.getFileHandle(name, { create: true });
        let writer;
        try {
            writer = await file.createWritable();
            await writer.write(blob);
            await writer.close();
            return { name };
        } catch (error) {
            await writer?.abort().catch(() => {});
            await directory.handle.removeEntry(name).catch(() => {});
            throw error;
        }
    }
};
