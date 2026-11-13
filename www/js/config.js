// 配置和常量
const SEARCH_CACHE_NAME = 'search-results-cache-v1';
const SONG_ASSETS_CACHE_NAME = 'song-assets-cache-v1';
const API_BASE = 'https://music-dl.sayqz.com/api/';

// 缓存键生成器
const CacheKeys = {
    getSongKey: (source, id, br) => `${API_BASE}?source=${source}&id=${id}&type=url&br=${br}`,
    getPicKey: (source, id) => `${API_BASE}?source=${source}&id=${id}&type=pic`,
    getLyricKey: (source, id) => `${API_BASE}?source=${source}&id=${id}&type=lrc`,
    getSearchKey: (keyword, apiSource) => `search:${keyword}_${apiSource}`
};
