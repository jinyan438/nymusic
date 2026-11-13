// 下载管理
const pendingDownloads = new Set();

async function downloadSong(dataset, listItemElement) {
    const downloadBtn = listItemElement.querySelector('.download-btn');
    const statusEl = listItemElement.querySelector('.download-status') || document.createElement('span');
    const icon = downloadBtn.querySelector('i');
    
    if (downloadBtn.classList.contains('downloaded')) {
        alert('歌曲已下载');
        return;
    }

    const { trackId, source } = dataset;
    const quality = DOM.downloadQualitySelect.value;
    const songKey = CacheKeys.getSongKey(source, trackId, quality);
    if (pendingDownloads.has(songKey)) return;
    pendingDownloads.add(songKey);
    downloadBtn.disabled = true;
    let songAssetsCache;
    let addedAudioCache = false;
    try {
        const directory = await DownloadDirectory.prepare();
        if (!directory) return;
        icon.className = 'fas fa-spinner fa-spin';
        statusEl.textContent = '0%';
        songAssetsCache = await caches.open(SONG_ASSETS_CACHE_NAME);
        let cachedAudio = await songAssetsCache.match(songKey);
        if (!cachedAudio) {
            const songUrl = await MusicAPI.getSongUrl(dataset, quality);
            const songResponse = await fetch(songUrl);
            if (!songResponse.ok) throw new Error(`音频下载失败（HTTP ${songResponse.status}）`);
            const contentType = songResponse.headers.get('Content-Type') || '';
            if (/json|text\//i.test(contentType)) throw new Error('音乐接口未返回音频文件');
            const total = +songResponse.headers.get('Content-Length');
            let loaded = 0;
            const res = new Response(new ReadableStream({
                async start(controller) {
                    try {
                        const reader = songResponse.body.getReader();
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            loaded += value.byteLength;
                            if (total > 0) statusEl.textContent = `${Math.round((loaded / total) * 100)}%`;
                            controller.enqueue(value);
                        }
                        controller.close();
                    } catch (error) {
                        controller.error(error);
                    }
                }
            }), { headers: songResponse.headers });
            const picKey = CacheKeys.getPicKey(source, trackId);
            const lyricKey = CacheKeys.getLyricKey(source, trackId);
            await Promise.all([
                songAssetsCache.put(songKey, res).then(() => { addedAudioCache = true; }),
                MusicAPI.fetchCover(dataset).then(image => songAssetsCache.put(picKey, image.clone()))
                    .catch(error => console.warn('封面下载失败:', error)),
                MusicAPI.getLyrics(dataset).then(text => songAssetsCache.put(lyricKey, new Response(text)))
                    .catch(error => console.warn('歌词下载失败:', error))
            ]);
            cachedAudio = await songAssetsCache.match(songKey);
        }
        if (!cachedAudio) throw new Error('无法读取已下载的音频');
        statusEl.textContent = '正在保存…';
        await DownloadDirectory.save(cachedAudio, dataset, quality, directory);

        icon.className = 'fas fa-check';
        downloadBtn.classList.add('downloaded');
        statusEl.textContent = '';
    } catch (error) {
        if (addedAudioCache) await songAssetsCache.delete(songKey).catch(() => {});
        console.error('下载失败:', error);
        alert(`下载失败: ${error.message}`);
        icon.className = 'fas fa-download';
    } finally {
        statusEl.textContent = '';
        downloadBtn.disabled = false;
        pendingDownloads.delete(songKey);
    }
}

async function exportSingleSong(dataset) {
    const { trackId, source } = dataset;
    const quality = DOM.downloadQualitySelect.value;
    const songKey = CacheKeys.getSongKey(source, trackId, quality);
    
    try {
        const directory = await DownloadDirectory.prepare();
        if (!directory) return;
        const songAssetsCache = await caches.open(SONG_ASSETS_CACHE_NAME);
        const response = await songAssetsCache.match(songKey);
        if (!response) {
            alert('歌曲未下载，请先下载');
            return;
        }
        
        await DownloadDirectory.save(response, dataset, quality, directory);
    } catch (error) {
        console.error('导出歌曲失败:', error);
        alert('导出失败: ' + error.message);
    }
}
