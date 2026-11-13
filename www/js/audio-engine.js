// The UI uses this interface on both native and browser builds.
class AudioPlayback extends EventTarget {
    constructor(element, capacitor = globalThis.Capacitor) {
        super();
        this.element = element;
        this.capacitor = capacitor;
        this.isNative = !!capacitor?.isNativePlatform?.() && capacitor.getPlatform?.() === 'android';
        this.state = { paused: true, position: 0, duration: 0, buffering: false };
        this.receivedAt = performance.now();
        this.generation = 0;
        this.objectUrl = null;
        this.mode = 'order';
        if (!this.isNative) {
            for (const name of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'ended', 'error']) {
                element.addEventListener(name, () => this.dispatchEvent(new Event(name)));
            }
        }
    }

    get paused() { return this.isNative ? this.state.paused : this.element.paused; }
    get duration() { return this.isNative ? this.state.duration : this.element.duration; }
    get currentTime() {
        if (!this.isNative) return this.element.currentTime;
        const elapsed = !this.paused && !this.state.buffering ? (performance.now() - this.receivedAt) / 1000 : 0;
        const position = (this.state.position || 0) + elapsed;
        return this.duration > 0 ? Math.min(position, this.duration) : position;
    }

    async init() {
        if (!this.isNative) return;
        if (!this.initializing) {
            this.initializing = (async () => {
                this.plugin = typeof this.capacitor.registerPlugin === 'function'
                    ? this.capacitor.registerPlugin('BassAudio') : this.capacitor.Plugins.BassAudio;
                if (!this.plugin) throw new Error('BASS 播放插件未安装');
                this.listener = await this.plugin.addListener('state', state => this.applyState(state));
                this.trackListener = await this.plugin.addListener('track', data => {
                    if (this.clientId && data.clientId !== this.clientId) return;
                    this.dispatchEvent(new CustomEvent('trackchange', { detail: data }));
                });
                this.errorListener = await this.plugin.addListener('playbackError', data => {
                    if (!this.clientId || data.clientId === this.clientId) this.reportError(new Error(data.message));
                });
                const state = await this.plugin.initialize();
                if (!this.clientId) {
                    this.clientId = state.clientId;
                    this.applyState(state);
                    if (state.track) this.dispatchEvent(new CustomEvent('trackchange', { detail: state }));
                }
            })().catch(error => { this.initializing = null; throw error; });
        }
        await this.initializing;
    }

    applyState(state) {
        if (this.clientId && state.clientId !== this.clientId) return;
        const previous = this.state;
        this.state = state;
        this.receivedAt = performance.now();
        if (previous.duration !== state.duration || previous.trackId !== state.trackId) {
            this.dispatchEvent(new Event('loadedmetadata'));
        }
        if (previous.paused !== state.paused) this.dispatchEvent(new Event(state.paused ? 'pause' : 'play'));
        this.dispatchEvent(new Event('timeupdate'));
    }

    async load({ uri, cachedResponse, cacheKey, track, queue = [], index = -1, mode = this.mode }) {
        const generation = ++this.generation;
        await this.init();
        if (generation !== this.generation) return;
        if (!this.isNative) {
            this.element.pause();
            if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
            const objectUrl = cachedResponse ? URL.createObjectURL(await cachedResponse.blob()) : uri.startsWith('blob:') ? uri : null;
            if (generation !== this.generation) {
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                return;
            }
            this.objectUrl = objectUrl;
            this.element.src = this.objectUrl || uri;
            await this.element.play();
            return;
        }
        this.clientId = `web-${Date.now()}-${generation}`;
        await this.plugin.stop();
        if (generation !== this.generation) return;
        this.state = { paused: true, position: 0, duration: 0, buffering: true };
        this.dispatchEvent(new Event('pause'));
        try {
            if (cachedResponse) uri = await this.stageCachedAudio(cachedResponse, cacheKey, generation);
            if (generation !== this.generation) return;
            if (index >= 0 && queue[index]) queue[index] = { ...queue[index], uri };
            const state = await this.plugin.load({ uri, track, queue, index, mode, clientId: this.clientId });
            if (generation === this.generation) this.applyState(state);
        } catch (error) {
            if (generation === this.generation) throw error;
        }
    }

    // Copy CacheStorage blobs in bounded chunks. Native decoders cannot open blob: URLs.
    async stageCachedAudio(response, key, generation) {
        const filesystem = this.capacitor.Plugins.Filesystem;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
        const name = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        const path = `bass-playback/${name}.audio`;
        const blob = await response.blob();
        try {
            const info = await filesystem.stat({ path, directory: 'CACHE' });
            if (info.size === blob.size) return (await filesystem.getUri({ path, directory: 'CACHE' })).uri;
        } catch (_) { /* A new cached song needs a native file. */ }
        const temporary = `${path}.${generation}.part`;
        try {
            for (let offset = 0; offset < blob.size; offset += 192 * 1024) {
                if (generation !== this.generation) throw new Error('Playback cancelled');
                const bytes = new Uint8Array(await blob.slice(offset, offset + 192 * 1024).arrayBuffer());
                let binary = '';
                for (let start = 0; start < bytes.length; start += 8192) {
                    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
                }
                const options = { path: temporary, directory: 'CACHE', data: btoa(binary) };
                if (offset === 0) await filesystem.writeFile({ ...options, recursive: true });
                else await filesystem.appendFile(options);
            }
            if (blob.size === 0) throw new Error('歌曲缓存为空');
            await filesystem.rename({ from: temporary, to: path, directory: 'CACHE', toDirectory: 'CACHE' });
            return (await filesystem.getUri({ path, directory: 'CACHE' })).uri;
        } catch (error) {
            await filesystem.deleteFile({ path: temporary, directory: 'CACHE' }).catch(() => {});
            throw error;
        }
    }

    async play() { await this.init(); return this.isNative ? this.plugin.play() : this.element.play(); }
    async pause() { return this.isNative ? this.plugin?.pause() : this.element.pause(); }
    async seek(position) {
        if (!Number.isFinite(position)) return;
        position = Math.max(0, this.duration > 0 ? Math.min(position, this.duration) : position);
        if (!this.isNative) { this.element.currentTime = position; return; }
        const result = await this.plugin.seek({ position });
        this.applyState(result);
    }
    async stop() {
        ++this.generation;
        if (this.isNative) return this.plugin?.stop();
        this.element.pause();
        this.element.removeAttribute('src');
        this.element.load();
        if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
    }
    async next() { return this.plugin.next(); }
    async previous() { return this.plugin.previous(); }
    async setMode(mode) { this.mode = mode; if (this.plugin) await this.plugin.setMode({ mode }); }
    reportError(error) { this.dispatchEvent(new CustomEvent('error', { detail: error })); }
}

const Playback = new AudioPlayback(DOM.audioPlayer);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Playback.plugin) {
        Playback.plugin.getState().then(state => {
            Playback.applyState(state);
            if (state.track) Playback.dispatchEvent(new CustomEvent('trackchange', { detail: state }));
        }).catch(error => console.warn('读取播放状态失败:', error));
    }
});
