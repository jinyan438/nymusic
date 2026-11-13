// 统一在线音乐入口；缓存键与实际请求地址分开，保留已有离线歌曲。
const MusicAPI = {
    async legacy(source, type, params = {}) {
        const query = new URLSearchParams({ source, type, ...params });
        const response = await fetch(`${API_BASE}?${query}`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`音乐请求失败（HTTP ${response.status}）`);
        const body = await response.json();
        if (body.code !== 200 || !body.data) throw new Error(body.message || '音乐接口请求失败');
        return body.data;
    },

    async search(source, keyword) {
        if (source === 'aggregate') {
            const results = await Promise.allSettled(['netease', 'qq'].map(item => this.search(item, keyword)));
            if (results.every(result => result.status === 'rejected')) throw results[1].reason;
            return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
        }
        if (source === 'qq') return QQMusic.search(keyword);
        return (await this.legacy(source, 'search', { keyword, limit: 30 })).results || [];
    },

    async getToplists(source) {
        return source === 'qq' ? QQMusic.getToplists() : (await this.legacy(source, 'toplists')).list || [];
    },

    async getToplist(source, id) {
        return source === 'qq' ? QQMusic.getToplist(id) : (await this.legacy(source, 'toplist', { id })).list || [];
    },

    async getPlaylist(source, id) {
        return source === 'qq' ? QQMusic.getPlaylist(id) : this.legacy(source, 'playlist', { id });
    },

    getPlaybackRequest(track, quality) {
        if (track.source === 'local') return { uri: track.filePath };
        const request = track.source === 'qq' ? QQMusic.getPlaybackRequest(track, quality)
            : { uri: CacheKeys.getSongKey(track.source, track.trackId, quality) };
        return { ...request, cacheKeys: CacheKeys.getSongKeys(track.source, track.trackId, quality) };
    },

    async getSongUrl(track, quality) {
        return track.source === 'qq' ? QQMusic.getSongUrl(track, quality) : this.getPlaybackRequest(track, quality).uri;
    },

    async getCoverUrl(track) {
        return track.source === 'qq' ? QQMusic.getCoverUrl(track) : CacheKeys.getPicKey(track.source, track.trackId);
    },

    async getLyrics(track) {
        if (track.source === 'qq') return QQMusic.getLyrics(track);
        const response = await fetch(CacheKeys.getLyricKey(track.source, track.trackId));
        if (!response.ok) throw new Error('获取歌词失败');
        return response.text();
    },

    async fetchCover(track) {
        const url = await this.getCoverUrl(track);
        const response = await fetch(track.source === 'qq' ? QQMusic.mediaUrl(url) : url);
        if (!response.ok) throw new Error('获取封面失败');
        return response;
    }
};
