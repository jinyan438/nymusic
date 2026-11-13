// 排行榜功能
async function loadToplists() {
    const source = DOM.toplistSourceSelect.value;
    currentToplistSource = source;
    DOM.toplistCategories.innerHTML = '正在加载榜单...';
    DOM.toplistSongs.innerHTML = '';
    
    try {
        if (source === 'aggregate') {
            const [neteaseRes, qqRes] = await Promise.allSettled([
                MusicAPI.getToplists('netease'),
                MusicAPI.getToplists('qq')
            ]);
            if (currentToplistSource !== source) return;
            if (neteaseRes.status === 'rejected' && qqRes.status === 'rejected') throw qqRes.reason;
            const neteaseLists = neteaseRes.status === 'fulfilled' ? neteaseRes.value : [];
            const qqLists = qqRes.status === 'fulfilled' ? qqRes.value : [];
            
            aggregatedToplists = {};
            const mergedLists = [];
            
            neteaseLists.forEach(item => {
                const normalizedName = normalizeToplistName(item.name);
                aggregatedToplists[normalizedName] = { netease: item.id, qq: null, name: item.name, updateFrequency: item.updateFrequency };
                mergedLists.push({ ...item, normalizedName, sources: ['netease'] });
            });
            
            qqLists.forEach(item => {
                const normalizedName = normalizeToplistName(item.name);
                if (aggregatedToplists[normalizedName]) {
                    aggregatedToplists[normalizedName].qq = item.id;
                    const existing = mergedLists.find(m => m.normalizedName === normalizedName);
                    if (existing) existing.sources.push('qq');
                } else {
                    aggregatedToplists[normalizedName] = { netease: null, qq: item.id, name: item.name, updateFrequency: item.updateFrequency };
                    mergedLists.push({ ...item, normalizedName, sources: ['qq'] });
                }
            });
            
            renderToplistCategories(mergedLists, true);
        } else {
            const lists = await MusicAPI.getToplists(source);
            if (currentToplistSource !== source) return;
            renderToplistCategories(lists, false);
        }
    } catch (error) {
        if (currentToplistSource !== source) return;
        console.error('加载榜单失败:', error);
        DOM.toplistCategories.innerHTML = '<p style="color: var(--text-color-secondary);">加载榜单失败，请重试</p>';
    }
}

function renderToplistCategories(lists, isAggregate) {
    DOM.toplistCategories.innerHTML = '';
    lists.forEach(item => {
        const btn = document.createElement('button');
        btn.className = 'setting-button';
        btn.style.marginBottom = '0.5rem';
        const sourceIcons = isAggregate && item.sources ?
            `<small style="margin-left:0.5rem;color:var(--text-color-secondary);font-size:0.7rem;">${item.sources.map(s => s === 'netease' ? '网易' : 'QQ').join('+')}</small>` : '';
        btn.innerHTML = `
            <i class="fas fa-chart-line"></i>
            <span>${item.name}</span>${sourceIcons}
            ${item.updateFrequency ? `<small style="margin-left:auto;color:var(--text-color-secondary);font-size:0.75rem;">${item.updateFrequency}</small>` : ''}
        `;
        if (isAggregate) {
            btn.addEventListener('click', () => loadAggregatedToplistSongs(item.normalizedName, item.name));
        } else {
            btn.addEventListener('click', () => loadToplistSongs(item.id, item.name));
        }
        DOM.toplistCategories.appendChild(btn);
    });
}

async function loadAggregatedToplistSongs(normalizedName, displayName) {
    showPage('toplist-songs-page');
    DOM.toplistSongsTitle.textContent = displayName;
    DOM.toplistSongs.innerHTML = `<p style="text-align:center;">正在加载...</p>`;
    
    const toplistInfo = aggregatedToplists[normalizedName];
    if (!toplistInfo) return;
    
    try {
        const promises = [];
        if (toplistInfo.netease) {
            promises.push(
                MusicAPI.getToplist('netease', toplistInfo.netease)
                    .then(data => ({ source: 'netease', data }))
                    .catch(() => ({ source: 'netease', data: null }))
            );
        }
        if (toplistInfo.qq) {
            promises.push(
                MusicAPI.getToplist('qq', toplistInfo.qq)
                    .then(data => ({ source: 'qq', data }))
                    .catch(() => ({ source: 'qq', data: null }))
            );
        }
        
        const results = await Promise.all(promises);
        const neteaseTracks = [];
        const qqTracks = [];
        
        results.forEach(({ source, data }) => {
            if (data) {
                const tracks = data.map((item, idx) => ({
                    ...item,
                    artist: item.artist || '未知歌手',
                    album: item.album || '',
                    platform: source,
                    originalRank: idx + 1
                }));
                if (source === 'netease') neteaseTracks.push(...tracks);
                else qqTracks.push(...tracks);
            }
        });
        
        const mergedTracks = [];
        const seenSongs = new Set();
        const maxLen = Math.max(neteaseTracks.length, qqTracks.length);
        
        for (let i = 0; i < maxLen; i++) {
            if (i < neteaseTracks.length) {
                const track = neteaseTracks[i];
                const songKey = track.name.toLowerCase().trim();
                if (!seenSongs.has(songKey)) {
                    seenSongs.add(songKey);
                    mergedTracks.push(track);
                }
            }
            if (i < qqTracks.length) {
                const track = qqTracks[i];
                const songKey = track.name.toLowerCase().trim();
                if (!seenSongs.has(songKey)) {
                    seenSongs.add(songKey);
                    mergedTracks.push(track);
                }
            }
        }
        
        renderToplistSongs(mergedTracks);
    } catch (error) {
        console.error('加载聚合榜单歌曲失败:', error);
        DOM.toplistSongs.innerHTML = '<p style="color: var(--text-color-secondary);">加载失败，请重试</p>';
    }
}

async function loadToplistSongs(toplistId, toplistName) {
    showPage('toplist-songs-page');
    DOM.toplistSongsTitle.textContent = toplistName;
    DOM.toplistSongs.innerHTML = `<p style="text-align:center;">正在加载...</p>`;
    
    try {
        const source = currentToplistSource;
        const data = await MusicAPI.getToplist(source, toplistId);
        if (currentToplistSource !== source) return;
        const tracks = data.map(item => ({
            ...item,
            artist: item.artist || '未知歌手',
            album: item.album || '',
            platform: source
        }));
        renderToplistSongs(tracks);
    } catch (error) {
        console.error('加载榜单歌曲失败:', error);
        DOM.toplistSongs.innerHTML = '<p style="color: var(--text-color-secondary);">加载失败，请重试</p>';
    }
}

async function renderToplistSongs(tracks) {
    DOM.toplistSongs.innerHTML = '';
    
    const container = document.createElement('div');
    const songAssetsCache = await caches.open(SONG_ASSETS_CACHE_NAME);
    
    tracks.forEach(async (track, index) => {
        const item = document.createElement('div');
        item.className = 'list-item';
        
        const trackDataset = {
            trackId: track.id,
            source: track.platform,
            songName: track.name,
            artist: track.artist,
            album: track.album || '',
            albumMid: track.albumMid || '', mediaId: track.mediaId || ''
        };
        
        const songKey = CacheKeys.getSongKey(trackDataset.source, trackDataset.trackId, DOM.downloadQualitySelect.value);
        const isDownloaded = await songAssetsCache.match(songKey);
        const picUrl = CacheKeys.getPicKey(trackDataset.source, trackDataset.trackId);
        
        item.innerHTML = `
            <span style="min-width:30px;text-align:center;color:${index < 3 ? '#e74c3c' : 'var(--text-color-secondary)'};font-weight:${index < 3 ? '600' : '400'};">${index + 1}</span>
            <img data-api-url="${picUrl}" alt="专辑图" loading="lazy" style="width:45px;height:45px;">
            <div class="info">
                <div class="song-name">${trackDataset.songName}</div>
                <div class="artist-album">${trackDataset.artist}</div>
            </div>
            <div class="action-buttons">
                ${isDownloaded ? '<button class="action-btn export-btn" title="导出"><i class="fas fa-file-export"></i></button>' : ''}
                <button class="action-btn download-btn" title="下载"><i class="fas ${isDownloaded ? 'fa-check' : 'fa-download'}"></i></button>
                <button class="action-btn add-btn" title="添加"><i class="fas fa-plus"></i></button>
            </div>
        `;
        
        if (isDownloaded) item.querySelector('.download-btn').classList.add('downloaded');
        
        const imgElement = item.querySelector('img');
        observeTrackImage(imgElement, trackDataset);
        
        addFastClick(item.querySelector('.info'), () => playSong(trackDataset));
        item.querySelector('.add-btn').addEventListener('click', e => { e.stopPropagation(); addToPlaylist(trackDataset); });
        item.querySelector('.download-btn').addEventListener('click', e => { e.stopPropagation(); downloadSong(trackDataset, item); });
        
        const exportBtn = item.querySelector('.export-btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', e => { e.stopPropagation(); exportSingleSong(trackDataset); });
        }
        
        container.appendChild(item);
    });
    
    DOM.toplistSongs.appendChild(container);
}
