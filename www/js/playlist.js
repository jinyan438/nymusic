// 歌单管理
async function savePlaylist() {
    await IDB.savePlaylist(playlist);
}

async function saveImportedPlaylists() {
    await IDB.saveImportedPlaylists(importedPlaylists);
}

async function loadPlaylist() {
    const savedPlaylist = await IDB.getPlaylist();
    if (savedPlaylist && savedPlaylist.length > 0) {
        playlist = savedPlaylist;
        renderPlaylist();
    }
    const savedImported = await IDB.getImportedPlaylists();
    if (savedImported && savedImported.length > 0) {
        importedPlaylists = savedImported;
        renderImportedPlaylists();
    }
}

function addToPlaylist(trackData) {
    if (playlist.some(track => track.trackId === trackData.trackId && track.source === trackData.source)) {
        alert('歌曲已在歌单中');
        return;
    }
    playlist.push(trackData);
    savePlaylist();
    renderPlaylist();
    alert('已添加到歌单');
}

function removeFromPlaylist(index) {
    playlist.splice(index, 1);
    savePlaylist();
    renderPlaylist();
    if (index === currentPlaylistIndex) currentPlaylistIndex--;
    else if (index < currentPlaylistIndex) currentPlaylistIndex--;
}

async function importPlaylist() {
    const source = DOM.playlistSourceSelect.value;
    const playlistId = DOM.playlistIdInput.value.trim();
    if (!playlistId) {
        alert('请输入歌单ID');
        return;
    }
    openPlaylistDetail(source, playlistId);
}

function renderImportedPlaylists() {
    DOM.importedPlaylistsContainer.innerHTML = '';
    if (importedPlaylists.length === 0) {
        DOM.importedPlaylistsContainer.innerHTML = '<p style="text-align:center;color:var(--text-color-secondary);font-size:0.9rem;">输入歌单ID获取歌单</p>';
        return;
    }

    importedPlaylists.forEach((pl, index) => {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.innerHTML = `
            <i class="fas fa-list-ul" style="font-size:1.5rem;margin-right:1rem;color:var(--primary-color);"></i>
            <div class="info">
                <div class="song-name">${pl.name}</div>
                <div class="artist-album">${pl.source === 'netease' ? '网易云' : 'QQ音乐'} · ${pl.author}</div>
            </div>
            <div class="action-buttons">
                <button class="action-btn remove-imported-btn" title="移除"><i class="fas fa-trash-alt"></i></button>
            </div>
        `;
        addFastClick(item.querySelector('.info'), () => openPlaylistDetail(pl.source, pl.id));
        item.querySelector('.remove-imported-btn').addEventListener('click', e => {
            e.stopPropagation();
            if (confirm(`确定移除歌单 "${pl.name}" 吗？`)) {
                importedPlaylists.splice(index, 1);
                saveImportedPlaylists();
                renderImportedPlaylists();
            }
        });
        DOM.importedPlaylistsContainer.appendChild(item);
    });
}


async function openPlaylistDetail(source, playlistId) {
    showPage('playlist-detail-page');
    DOM.playlistDetailTitle.textContent = '加载中...';
    DOM.playlistDetailAuthor.textContent = '';
    DOM.playlistDetailSongs.innerHTML = '<p style="text-align:center;">正在加载歌单...</p>';
    
    try {
        const data = await MusicAPI.getPlaylist(source, playlistId);
        if (data) {
            const info = data.info || {};
            const playlistName = info.name || '歌单';
            const playlistAuthor = info.author || '未知';
            
            DOM.playlistDetailTitle.textContent = playlistName;
            DOM.playlistDetailAuthor.textContent = playlistAuthor ? `创建者: ${playlistAuthor}` : '';
            
            if (!importedPlaylists.some(p => p.source === source && p.id === playlistId)) {
                importedPlaylists.unshift({ source, id: playlistId, name: playlistName, author: playlistAuthor });
                if (importedPlaylists.length > 20) importedPlaylists.pop();
                saveImportedPlaylists();
                renderImportedPlaylists();
            }
            
            const tracks = (data.list || []).map(item => ({
                ...item,
                artist: item.artist || '未知歌手',
                album: item.album || '',
                platform: source
            }));
            renderPlaylistDetailSongs(tracks);
        } else {
            DOM.playlistDetailSongs.innerHTML = '<p style="color:var(--text-color-secondary);">加载歌单失败，请检查ID是否正确</p>';
        }
    } catch (error) {
        console.error('加载歌单详情失败:', error);
        DOM.playlistDetailSongs.innerHTML = '<p style="color:var(--text-color-secondary);">加载失败，请重试</p>';
    }
}

async function renderPlaylistDetailSongs(tracks) {
    DOM.playlistDetailSongs.innerHTML = '';
    if (tracks.length === 0) {
        DOM.playlistDetailSongs.innerHTML = '<p style="text-align:center;color:var(--text-color-secondary);">歌单是空的</p>';
        return;
    }
    
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
            <span style="min-width:30px;text-align:center;color:var(--text-color-secondary);">${index + 1}</span>
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
        
        DOM.playlistDetailSongs.appendChild(item);
    });
}

async function renderList(container, tracks, isPlaylist) {
    container.innerHTML = '';
    if (tracks.length === 0) {
        container.innerHTML = `<p style="text-align:center; color: var(--text-color-secondary);">${isPlaylist ? '歌单是空的，快去搜索添加歌曲吧！' : '没有找到相关歌曲。'}</p>`;
        return;
    }
    
    const songAssetsCache = await caches.open(SONG_ASSETS_CACHE_NAME);
    
    tracks.forEach(async (track, index) => {
        const item = document.createElement('div');
        item.className = 'list-item';
        
        const trackDataset = isPlaylist ? track : {
            trackId: track.id,
            source: track.platform || track.source,
            songName: track.name,
            artist: track.artist,
            album: track.album || '',
            albumMid: track.albumMid || '', mediaId: track.mediaId || ''
        };
        
        const songKey = CacheKeys.getSongKey(trackDataset.source, trackDataset.trackId, DOM.downloadQualitySelect.value);
        const isDownloaded = await songAssetsCache.match(songKey);
        const picUrl = CacheKeys.getPicKey(trackDataset.source, trackDataset.trackId);

        item.innerHTML = `
            <img data-api-url="${picUrl}" alt="专辑图" loading="lazy">
            <div class="info">
                <div class="song-name">${trackDataset.songName}</div>
                <div class="artist-album">${trackDataset.artist} ${trackDataset.album ? '- ' + trackDataset.album : ''}</div>
            </div>
            <div class="action-buttons">
                <div class="download-status"></div>
                ${isDownloaded ? '<button class="action-btn export-btn" title="导出"><i class="fas fa-file-export"></i></button>' : ''}
                <button class="action-btn download-btn" title="下载"><i class="fas ${isDownloaded ? 'fa-check' : 'fa-download'}"></i></button>
                <button class="action-btn ${isPlaylist ? 'remove-btn' : 'add-btn'}" title="${isPlaylist ? '移除' : '添加'}">
                    <i class="fas ${isPlaylist ? 'fa-trash-alt' : 'fa-plus'}"></i>
                </button>
            </div>
        `;
        
        if (isDownloaded) item.querySelector('.download-btn').classList.add('downloaded');

        const imgElement = item.querySelector('img');
        observeTrackImage(imgElement, trackDataset);

        addFastClick(item.querySelector('.info'), () => {
            if (isPlaylist) currentPlaylistIndex = index;
            else currentPlaylistIndex = -1;
            playSong(trackDataset);
        });
        
        if (isPlaylist) {
            item.querySelector('.remove-btn').addEventListener('click', e => { e.stopPropagation(); removeFromPlaylist(index); });
        } else {
            item.querySelector('.add-btn').addEventListener('click', e => { e.stopPropagation(); addToPlaylist(trackDataset); });
        }

        item.querySelector('.download-btn').addEventListener('click', e => {
            e.stopPropagation();
            downloadSong(trackDataset, item);
        });
        
        const exportBtn = item.querySelector('.export-btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', e => {
                e.stopPropagation();
                exportSingleSong(trackDataset);
            });
        }

        container.appendChild(item);
    });
}

function renderPlaylist() {
    renderList(DOM.playlistItemsContainer, playlist, true);
}

function displayResults(tracks) {
    renderList(DOM.resultsContainer, tracks, false);
}
