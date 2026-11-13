// 设置功能

// 设置加载与保存
async function loadSettings() {
    const musicSource = await IDB.getSetting('musicSource', 'aggregate');
    const playQuality = await IDB.getSetting('playQuality', 'flac');
    const downloadQuality = await IDB.getSetting('downloadQuality', 'flac');
    DOM.musicSourceSelect.value = musicSource;
    DOM.playQualitySelect.value = playQuality;
    DOM.downloadQualitySelect.value = downloadQuality;
}

async function saveMusicSource() {
    await IDB.setSetting('musicSource', DOM.musicSourceSelect.value);
}

async function savePlayQuality() {
    await IDB.setSetting('playQuality', DOM.playQualitySelect.value);
}

async function saveDownloadQuality() {
    await IDB.setSetting('downloadQuality', DOM.downloadQualitySelect.value);
}

async function clearSongCache() {
    if (!confirm('确定要清除所有已下载的歌曲吗？此操作不可恢复。')) return;
    await caches.delete(SONG_ASSETS_CACHE_NAME);
    alert('歌曲缓存已清除。');
    document.location.reload();
}

async function clearAllCache() {
    if (!confirm('确定要清除所有缓存数据吗（包括歌曲和搜索记录）？此操作不可恢复。')) return;
    await caches.delete(SONG_ASSETS_CACHE_NAME);
    await IDB.clearAll();
    playlist = [];
    alert('所有缓存已清除。');
    document.location.reload();
}
