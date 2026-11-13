// 主入口和初始化
function initEventListeners() {
    // 搜索
    DOM.searchButton.addEventListener('click', searchMusic);
    DOM.searchInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') searchMusic(); });
    
    // 歌单
    DOM.importPlaylistBtn.addEventListener('click', importPlaylist);
    DOM.playlistIdInput.addEventListener('keyup', (e) => { if (e.key === 'Enter') importPlaylist(); });
    DOM.playlistBackBtn.addEventListener('click', () => showPage('playlist-page'));
    
    // 本地音乐
    DOM.scanLocalBtn.addEventListener('click', () => LocalMusic.scanFolder());
    DOM.localBackBtn.addEventListener('click', () => showPage('playlist-page'));
    
    // 排行榜
    DOM.toplistSourceSelect.addEventListener('change', loadToplists);
    DOM.toplistBackBtn.addEventListener('click', () => showPage('toplist-page'));
    
    // 播放控制
    DOM.audioPlayer.addEventListener('ended', handleSongEnd);
    DOM.prevBtn.addEventListener('click', playPrev);
    DOM.nextBtn.addEventListener('click', playNext);
    DOM.playPauseBtn.addEventListener('click', togglePlayPause);
    DOM.modeBtn.addEventListener('click', togglePlaybackMode);
    DOM.likeBtn.addEventListener('click', toggleLike);
    
    // 播放状态
    DOM.audioPlayer.addEventListener('play', () => {
        DOM.playPauseBtn.querySelector('i').className = 'fas fa-pause';
        DOM.albumArt.style.animationPlayState = 'running';
        startLyricsAnimation();
    });
    DOM.audioPlayer.addEventListener('pause', () => {
        DOM.playPauseBtn.querySelector('i').className = 'fas fa-play';
        DOM.albumArt.style.animationPlayState = 'paused';
        stopLyricsAnimation();
    });
    DOM.audioPlayer.addEventListener('timeupdate', updateProgress);
    DOM.audioPlayer.addEventListener('loadedmetadata', () => DOM.durationDisplay.textContent = formatTime(DOM.audioPlayer.duration));
    
    // 进度条
    DOM.progressBarWrapper.addEventListener('click', setProgress);
    
    // 设置
    DOM.musicSourceSelect.addEventListener('change', saveMusicSource);
    DOM.playQualitySelect.addEventListener('change', savePlayQuality);
    DOM.downloadQualitySelect.addEventListener('change', saveDownloadQuality);
    DOM.clearSongsCacheBtn.addEventListener('click', clearSongCache);
    DOM.clearAllCacheBtn.addEventListener('click', clearAllCache);
}

// 页面初始化
async function initApp() {
    await IDB.init();
    setupImageObserver();
    initNavigation();
    initEventListeners();
    initFullscreenLyrics();
    await loadPlaylist();
    await loadPlaybackMode();
    await loadSettings();
    await LocalMusic.init();
}

initApp();
