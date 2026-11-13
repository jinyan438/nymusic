// 播放器核心
async function playSong(dataset, options = {}) {
    if (!dataset) return;
    
    // 如果是本地音乐，使用LocalMusic模块播放
    if (dataset.source === 'local') {
        await LocalMusic.playLocalTrack(dataset, dataset.playlistId, options);
        return;
    }
    
    currentTrackData = dataset;
    showPage('player-page');

    const { songName, artist } = dataset;
    const quality = DOM.playQualitySelect.value;
    
    DOM.songTitle.textContent = songName;
    DOM.artistName.textContent = artist;
    updateLikeButton();
    DOM.albumArt.style.backgroundImage = '';
    DOM.backgroundContainer.style.backgroundImage = '';
    DOM.albumArt.style.animationPlayState = 'paused';
    DOM.lyricsContainer.innerHTML = '正在加载...';
    DOM.currentTimeDisplay.textContent = '00:00';
    DOM.durationDisplay.textContent = '00:00';
    DOM.progressBar.style.width = '0%';
    currentLyrics = [];
    currentLyricIndex = -1;

    const songAssetsCache = await caches.open(SONG_ASSETS_CACHE_NAME).catch(error => {
        console.warn('读取歌曲缓存失败:', error);
        return null;
    });
    if (currentTrackData !== dataset) return;
    // 音频、封面和歌词独立加载，任何一项的网络等待都不会阻塞其他项。
    await Promise.allSettled([
        options.syncOnly ? Promise.resolve() : loadOnlineSongAudio(songAssetsCache, dataset, quality),
        loadOnlineSongCover(songAssetsCache, dataset),
        loadOnlineSongLyrics(songAssetsCache, dataset)
    ]);
}

async function loadOnlineSongAudio(songAssetsCache, dataset, quality) {
    try {
        const cached = await CacheKeys.findSong(songAssetsCache, dataset.source, dataset.trackId, quality);
        if (currentTrackData !== dataset) return;
        const request = Playback.isNative ? MusicAPI.getPlaybackRequest(dataset, quality)
            : { uri: cached.response ? '' : await MusicAPI.getSongUrl(dataset, quality) };
        if (currentTrackData !== dataset) return;
        await Playback.load({
            ...request, cachedResponse: cached.response, cacheKey: cached.key,
            ...getPlaybackContext(dataset)
        });
    } catch (error) {
        console.error('获取歌曲URL失败:', error);
        if (currentTrackData !== dataset) return;
        DOM.songTitle.textContent = '播放失败';
        Playback.reportError(error);
    }
}

async function loadOnlineSongCover(songAssetsCache, dataset) {
    const { trackId, source, songName, artist } = dataset;
    const picKey = CacheKeys.getPicKey(source, trackId);
    const picResponse = await songAssetsCache?.match(picKey);
    if (currentTrackData !== dataset) return;
    if (picResponse) {
        const blob = await picResponse.blob();
        if (currentTrackData !== dataset) return;
        const imageUrl = URL.createObjectURL(blob);
        DOM.albumArt.style.backgroundImage = `url(${imageUrl})`;
        DOM.backgroundContainer.style.backgroundImage = `url(${imageUrl})`;
    } else {
        try {
            const picUrl = await MusicAPI.getCoverUrl(dataset);
            if (currentTrackData !== dataset) return;
            loadBackgroundImageWithFallback(picUrl, [DOM.albumArt, DOM.backgroundContainer], trackId, songName, artist);
        } catch (error) {
            console.warn('获取封面失败:', error);
            const coverUrl = await fetchCoverFromAPI(songName, artist, dataset.album);
            if (coverUrl && currentTrackData === dataset) displayCover(coverUrl, [DOM.albumArt, DOM.backgroundContainer]);
        }
    }

}

async function loadOnlineSongLyrics(songAssetsCache, dataset) {
    const { trackId, source, songName, artist } = dataset;
    const lyricKey = CacheKeys.getLyricKey(source, trackId);
    const lyricResponse = await songAssetsCache?.match(lyricKey);
    try {
        let lrcText = '';
        if (lyricResponse) {
            lrcText = await lyricResponse.text();
        } else {
            lrcText = await MusicAPI.getLyrics(dataset);
        }
        if (currentTrackData !== dataset) return;
        
        currentLyrics = parseLyrics(lrcText);
        currentLyrics.sort((a, b) => a.time - b.time);
        DOM.lyricsContainer.innerHTML = '';
        
        // 检查是否是有效歌词（排除"暂无歌词"等占位内容）
        const hasValidLyrics = currentLyrics.length > 1 || 
            (currentLyrics.length === 1 && !currentLyrics[0].text.includes('暂无歌词') && !currentLyrics[0].text.includes('纯音乐'));
        
        if (hasValidLyrics) {
            currentLyrics.forEach(line => {
                const p = document.createElement('p');
                // 逐字渲染
                if (line.words) {
                    line.words.forEach(word => {
                        const span = document.createElement('span');
                        span.className = 'lyric-char';
                        span.textContent = word.text;
                        p.appendChild(span);
                    });
                } else if (line.chars) {
                    line.chars.forEach(char => {
                        const span = document.createElement('span');
                        span.className = 'lyric-char';
                        span.textContent = char;
                        p.appendChild(span);
                    });
                } else {
                    p.textContent = line.text;
                }
                DOM.lyricsContainer.appendChild(p);
            });
        } else {
            // 无歌词时自动从API获取
            console.log('触发自动获取歌词, 歌曲:', songName, '歌手:', artist);
            DOM.lyricsContainer.innerHTML = '<p>正在搜索歌词...</p>';
            try {
                const autoLyrics = await fetchLyricsFromAPI(songName, artist, null);
                if (currentTrackData !== dataset) return;
                console.log('fetchLyricsFromAPI返回:', autoLyrics ? '有内容' : 'null');
                if (autoLyrics && displayLyrics(autoLyrics, DOM.lyricsContainer)) {
                    console.log('自动获取歌词成功');
                } else {
                    console.log('displayLyrics返回false或autoLyrics为空');
                    DOM.lyricsContainer.innerHTML = '<p>暂无歌词</p>';
                }
            } catch (e) {
                if (currentTrackData !== dataset) return;
                console.error('自动获取歌词异常:', e);
                DOM.lyricsContainer.innerHTML = '<p>暂无歌词</p>';
            }
        }
    } catch (error) {
        if (currentTrackData !== dataset) return;
        console.error('获取歌词失败:', error);
        DOM.lyricsContainer.textContent = '获取歌词失败。';
    }
}

// 播放控制
function handleSongEnd() {
    if (Playback.isNative) return; // The service advances the queue while the WebView is asleep.
    if (playbackMode === 'repeat') {
        Playback.seek(0).then(() => Playback.play()).catch(error => Playback.reportError(error));
    } else {
        playNext();
    }
}

function playNext() {
    if (Playback.isNative) { Playback.next().catch(error => Playback.reportError(error)); return; }
    if (playlist.length === 0) return;
    if (currentPlaylistIndex === -1) {
        currentPlaylistIndex = 0;
    } else {
        switch (playbackMode) {
            case 'order':
                currentPlaylistIndex = (currentPlaylistIndex + 1) % playlist.length;
                break;
            case 'random':
                if (playlist.length > 1) {
                    let newIndex;
                    do {
                        newIndex = Math.floor(Math.random() * playlist.length);
                    } while (newIndex === currentPlaylistIndex);
                    currentPlaylistIndex = newIndex;
                }
                break;
            case 'repeat':
                break;
        }
    }
    playSong(playlist[currentPlaylistIndex]);
}

function playPrev() {
    if (Playback.isNative) { Playback.previous().catch(error => Playback.reportError(error)); return; }
    if (playlist.length === 0) return;
    if (currentPlaylistIndex !== -1) {
        if (playbackMode === 'random' && playlist.length > 1) {
            let newIndex;
            do {
                newIndex = Math.floor(Math.random() * playlist.length);
            } while (newIndex === currentPlaylistIndex);
            currentPlaylistIndex = newIndex;
        } else {
            currentPlaylistIndex = (currentPlaylistIndex - 1 + playlist.length) % playlist.length;
        }
        playSong(playlist[currentPlaylistIndex]);
    }
}

function togglePlayPause() {
    const action = Playback.paused ? Playback.play() : Playback.pause();
    Promise.resolve(action).catch(error => Playback.reportError(error));
}

function updateProgress() {
    const { duration, currentTime } = Playback;
    if (duration) {
        DOM.progressBar.style.width = `${(currentTime / duration) * 100}%`;
        DOM.currentTimeDisplay.textContent = formatTime(currentTime);
    }
}

// 使用 requestAnimationFrame 实现流畅的歌词更新
let lyricsAnimationId = null;
function startLyricsAnimation() {
    function animate() {
        updateLyrics();
        lyricsAnimationId = requestAnimationFrame(animate);
    }
    if (!lyricsAnimationId) {
        lyricsAnimationId = requestAnimationFrame(animate);
    }
}

function stopLyricsAnimation() {
    if (lyricsAnimationId) {
        cancelAnimationFrame(lyricsAnimationId);
        lyricsAnimationId = null;
    }
}

function setProgress(e) {
    const duration = Playback.duration;
    if (duration) Playback.seek((e.offsetX / this.clientWidth) * duration).catch(error => Playback.reportError(error));
}

function setPlaybackMode(mode) {
    playbackMode = mode;
    const icon = DOM.modeBtn.querySelector('i');
    switch (mode) {
        case 'order':
            icon.className = 'fas fa-bars';
            DOM.modeBtn.title = '顺序播放';
            break;
        case 'random':
            icon.className = 'fas fa-random';
            DOM.modeBtn.title = '随机播放';
            break;
        case 'repeat':
            icon.className = 'fas fa-redo-alt';
            DOM.modeBtn.title = '单曲循环';
            break;
    }
    IDB.setSetting('playbackMode', mode);
    Playback.setMode(mode).catch(error => console.warn('更新播放模式失败:', error));
}

function getPlaybackContext(track) {
    const entry = item => {
        const data = {};
        for (const key of ['trackId', 'source', 'songName', 'artist', 'album', 'albumMid', 'mediaId', 'filePath', 'playlistId', 'format']) {
            if (item[key] != null) data[key] = item[key];
        }
        return { ...MusicAPI.getPlaybackRequest(item, DOM.playQualitySelect.value), track: data };
    };
    const queue = playlist.map(entry);
    const index = playlist.findIndex(item => item.source === track.source && item.trackId === track.trackId);
    return { track: entry(track).track, queue, index, mode: playbackMode };
}

async function syncNativeTrack(event) {
    const data = event.detail;
    if (!data?.track) return;
    if (currentTrackData?.source === data.track.source && currentTrackData?.trackId === data.track.trackId) return;
    currentPlaylistIndex = data.index;
    let track = playlist.find(item => item.source === data.track.source && item.trackId === data.track.trackId);
    if (!track && data.track.source === 'local') {
        track = LocalMusic.localPlaylists.flatMap(list => list.tracks).find(item => item.trackId === data.track.trackId);
    }
    await playSong(track || data.track, { syncOnly: true });
}

function togglePlaybackMode() {
    const modes = ['order', 'random', 'repeat'];
    const nextIndex = (modes.indexOf(playbackMode) + 1) % modes.length;
    setPlaybackMode(modes[nextIndex]);
}

async function loadPlaybackMode() {
    const mode = await IDB.getSetting('playbackMode', 'order');
    setPlaybackMode(mode);
}

// 喜欢/收藏功能
function isInPlaylist(trackData) {
    if (!trackData) return false;
    return playlist.some(track => track.trackId === trackData.trackId && track.source === trackData.source);
}

function updateLikeButton() {
    if (!currentTrackData) {
        DOM.likeBtn.classList.remove('liked');
        DOM.likeBtn.querySelector('i').className = 'far fa-heart';
        DOM.likeBtn.disabled = false;
        return;
    }
    
    // 本地音乐禁用收藏功能
    if (currentTrackData.source === 'local') {
        DOM.likeBtn.classList.remove('liked');
        DOM.likeBtn.classList.add('disabled');
        DOM.likeBtn.querySelector('i').className = 'fas fa-lock';
        DOM.likeBtn.title = '本地音乐不支持收藏';
        DOM.likeBtn.disabled = true;
        return;
    }
    
    DOM.likeBtn.classList.remove('disabled');
    DOM.likeBtn.disabled = false;
    
    if (isInPlaylist(currentTrackData)) {
        DOM.likeBtn.classList.add('liked');
        DOM.likeBtn.querySelector('i').className = 'fas fa-heart';
        DOM.likeBtn.title = '已收藏';
    } else {
        DOM.likeBtn.classList.remove('liked');
        DOM.likeBtn.querySelector('i').className = 'far fa-heart';
        DOM.likeBtn.title = '添加到收藏';
    }
}

function toggleLike() {
    if (!currentTrackData) {
        alert('请先播放一首歌曲');
        return;
    }
    
    // 本地音乐不支持收藏
    if (currentTrackData.source === 'local') {
        return;
    }
    
    if (isInPlaylist(currentTrackData)) {
        // 从歌单移除
        const index = playlist.findIndex(track => 
            track.trackId === currentTrackData.trackId && track.source === currentTrackData.source
        );
        if (index !== -1) {
            playlist.splice(index, 1);
            savePlaylist();
            renderPlaylist();
        }
    } else {
        // 添加到歌单
        playlist.push(currentTrackData);
        savePlaylist();
        renderPlaylist();
    }
    updateLikeButton();
}
