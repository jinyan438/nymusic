// IndexedDB 存储模块
const IDB = {
    DB_NAME: 'MusicPlayerDB',
    DB_VERSION: 2,
    STORES: {
        SETTINGS: 'settings',
        PLAYLIST: 'playlist',
        IMPORTED_PLAYLISTS: 'importedPlaylists',
        SEARCH_CACHE: 'searchCache',
        LYRICS_CACHE: 'lyricsCache',
        COVER_CACHE: 'coverCache'
    },
    db: null,

    async init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                
                // 设置存储
                if (!db.objectStoreNames.contains(this.STORES.SETTINGS)) {
                    db.createObjectStore(this.STORES.SETTINGS, { keyPath: 'key' });
                }
                
                // 播放列表存储
                if (!db.objectStoreNames.contains(this.STORES.PLAYLIST)) {
                    db.createObjectStore(this.STORES.PLAYLIST, { keyPath: 'id', autoIncrement: true });
                }
                
                // 导入的歌单存储
                if (!db.objectStoreNames.contains(this.STORES.IMPORTED_PLAYLISTS)) {
                    db.createObjectStore(this.STORES.IMPORTED_PLAYLISTS, { keyPath: 'id', autoIncrement: true });
                }
                
                // 搜索缓存存储
                if (!db.objectStoreNames.contains(this.STORES.SEARCH_CACHE)) {
                    db.createObjectStore(this.STORES.SEARCH_CACHE, { keyPath: 'key' });
                }
                
                // 歌词缓存存储
                if (!db.objectStoreNames.contains(this.STORES.LYRICS_CACHE)) {
                    db.createObjectStore(this.STORES.LYRICS_CACHE, { keyPath: 'key' });
                }
                
                // 封面缓存存储
                if (!db.objectStoreNames.contains(this.STORES.COVER_CACHE)) {
                    db.createObjectStore(this.STORES.COVER_CACHE, { keyPath: 'key' });
                }
            };
        });
    },

    async get(storeName, key) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result?.value ?? request.result);
        });
    },

    async set(storeName, key, value) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put({ key, value });
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    },

    async getAll(storeName) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
        });
    },

    async setAll(storeName, items) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            store.clear();
            items.forEach((item, index) => store.put({ ...item, id: index + 1 }));
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    },

    async clear(storeName) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.clear();
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve();
        });
    },

    async clearAll() {
        const stores = Object.values(this.STORES);
        for (const store of stores) {
            await this.clear(store);
        }
    },

    // 设置相关便捷方法
    async getSetting(key, defaultValue = null) {
        const result = await this.get(this.STORES.SETTINGS, key);
        return result !== undefined ? result : defaultValue;
    },

    async setSetting(key, value) {
        return this.set(this.STORES.SETTINGS, key, value);
    },

    // 播放列表便捷方法
    async getPlaylist() {
        const items = await this.getAll(this.STORES.PLAYLIST);
        return items.map(item => {
            const { id, ...rest } = item;
            return rest;
        });
    },

    async savePlaylist(items) {
        return this.setAll(this.STORES.PLAYLIST, items);
    },

    // 导入歌单便捷方法
    async getImportedPlaylists() {
        const items = await this.getAll(this.STORES.IMPORTED_PLAYLISTS);
        return items.map(item => {
            const { id, ...rest } = item;
            return rest;
        });
    },

    async saveImportedPlaylists(items) {
        return this.setAll(this.STORES.IMPORTED_PLAYLISTS, items);
    },

    // 搜索缓存便捷方法
    async getSearchCache(key) {
        return this.get(this.STORES.SEARCH_CACHE, key);
    },

    async setSearchCache(key, results) {
        return this.set(this.STORES.SEARCH_CACHE, key, results);
    },

    // 歌词缓存便捷方法
    async getLyricsCache(title, artist) {
        const key = `lyrics_${title}_${artist}`.toLowerCase();
        return this.get(this.STORES.LYRICS_CACHE, key);
    },

    async setLyricsCache(title, artist, lyrics) {
        const key = `lyrics_${title}_${artist}`.toLowerCase();
        return this.set(this.STORES.LYRICS_CACHE, key, lyrics);
    },

    // 封面缓存便捷方法
    async getCoverCache(title, artist) {
        const key = `cover_${title}_${artist}`.toLowerCase();
        return this.get(this.STORES.COVER_CACHE, key);
    },

    async setCoverCache(title, artist, coverUrl) {
        const key = `cover_${title}_${artist}`.toLowerCase();
        return this.set(this.STORES.COVER_CACHE, key, coverUrl);
    }
};
