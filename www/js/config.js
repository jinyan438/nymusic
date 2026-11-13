// 配置和常量
const SEARCH_CACHE_NAME = 'search-results-cache-v1';
const SONG_ASSETS_CACHE_NAME = 'song-assets-cache-v1';
const API_BASE = 'https://music-dl.sayqz.com/api/';

// 缓存键生成器
const CacheKeys = {
    getSongKey: (source, id, br) => `${API_BASE}?source=${source}&id=${id}&type=url&br=${br}`,
    getSongKeys(source, id, preferred) {
        return [...new Set([preferred, 'flac24bit', 'flac', '320k', '128k'])]
            .filter(quality => ['128k', '320k', 'flac', 'flac24bit'].includes(quality))
            .map(quality => this.getSongKey(source, id, quality));
    },
    async findSong(cache, source, id, preferred) {
        const keys = this.getSongKeys(source, id, preferred);
        for (const key of keys) {
            const response = await cache?.match(key);
            if (response) return { response, key };
        }
        return { response: null, key: keys[0] };
    },
    getPicKey: (source, id) => `${API_BASE}?source=${source}&id=${id}&type=pic`,
    getLyricKey: (source, id) => `${API_BASE}?source=${source}&id=${id}&type=lrc`,
    getSearchKey: (keyword, apiSource) => `search:${keyword}_${apiSource}${apiSource === 'qq' || apiSource === 'aggregate' ? ':qq-rain120-v1' : ''}`
};
