// 下载管理
async function downloadSong(dataset, listItemElement) {
    const downloadBtn = listItemElement.querySelector('.download-btn');
    const statusEl = listItemElement.querySelector('.download-status');
    const icon = downloadBtn.querySelector('i');
    
    if (downloadBtn.classList.contains('downloaded')) {
        alert('歌曲已下载');
        return;
    }

    icon.className = 'fas fa-spinner fa-spin';
    statusEl.textContent = '0%';
    
    const { trackId, source } = dataset;
    const quality = DOM.downloadQualitySelect.value;
    const songAssetsCache = await caches.open(SONG_ASSETS_CACHE_NAME);
    
    try {
        const songUrl = `${API_BASE}?source=${source}&id=${trackId}&type=url&br=${quality}`;
        const songResponse = await fetch(songUrl);
        const total = +songResponse.headers.get('Content-Length');
        let loaded = 0;
        
        const res = new Response(new ReadableStream({
            async start(controller) {
                const reader = songResponse.body.getReader();
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    loaded += value.byteLength;
                    if (total > 0) {
                        statusEl.textContent = `${Math.round((loaded / total) * 100)}%`;
                    }
                    controller.enqueue(value);
                }
                controller.close();
            }
        }));
        
        const picKey = CacheKeys.getPicKey(source, trackId);
        const lyricKey = CacheKeys.getLyricKey(source, trackId);
        
        const picFetch = fetch(picKey)
            .then(imageRes => songAssetsCache.put(picKey, imageRes.clone()));

        const lyricFetch = fetch(lyricKey)
            .then(async lyricRes => {
                const lrcText = await lyricRes.text();
                return songAssetsCache.put(lyricKey, new Response(lrcText));
            });
        
        await Promise.all([
            songAssetsCache.put(CacheKeys.getSongKey(source, trackId, quality), res),
            picFetch.catch(e => console.warn('封面下载失败:', e)),
            lyricFetch.catch(e => console.warn('歌词下载失败:', e))
        ]);

        icon.className = 'fas fa-check';
        downloadBtn.classList.add('downloaded');
        statusEl.textContent = '';
    } catch (error) {
        console.error('下载失败:', error);
        alert(`下载失败: ${error.message}`);
        icon.className = 'fas fa-download';
        statusEl.textContent = '';
    }
}

async function exportSingleSong(dataset) {
    const { trackId, source, songName, artist } = dataset;
    const quality = DOM.downloadQualitySelect.value;
    const songAssetsCache = await caches.open(SONG_ASSETS_CACHE_NAME);
    const songKey = CacheKeys.getSongKey(source, trackId, quality);
    
    try {
        const response = await songAssetsCache.match(songKey);
        if (!response) {
            alert('歌曲未下载，请先下载');
            return;
        }
        
        const blob = await response.blob();
        const contentType = response.headers.get('Content-Type') || '';
        
        let ext = '.mp3';
        if (quality === 'flac' || quality === 'flac24bit' || contentType.includes('flac')) ext = '.flac';
        else if (contentType.includes('m4a') || contentType.includes('aac')) ext = '.m4a';
        
        const safeName = `${songName} - ${artist}`.replace(/[\\/:*?"<>|]/g, '_');
        
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `${safeName}${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
    } catch (error) {
        console.error('导出歌曲失败:', error);
        alert('导出失败: ' + error.message);
    }
}
