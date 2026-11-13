// 去重函数：相同歌曲名+歌手名只保留第一个
function deduplicateResults(results) {
    const seen = new Set();
    return results.filter(track => {
        const key = `${track.name}_${track.artist}`.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// 搜索功能
async function searchMusic() {
    const keyword = DOM.searchInput.value.trim();
    if (!keyword) {
        alert('请输入搜索关键词');
        return;
    }

    const thisSearchId = Date.now();
    activeSearchId = thisSearchId;

    DOM.resultsContainer.innerHTML = '正在搜索...';
    const selectedSource = DOM.musicSourceSelect.value;

    let attemptCount = 0;
    while (activeSearchId === thisSearchId) {
        if (activeSearchId !== thisSearchId) break;
        
        attemptCount++;

        const cacheKey = CacheKeys.getSearchKey(keyword, selectedSource);
        if (attemptCount === 1) {
            const cachedResults = await IDB.getSearchCache(cacheKey);
            if (activeSearchId !== thisSearchId) return;
            if (cachedResults) {
                displayResults(cachedResults);
                return;
            }
        }
        
        let foundResults = false;
        try {
            let results = await MusicAPI.search(selectedSource, keyword);
            if (activeSearchId !== thisSearchId) return;
            if (results.length > 0) {
                if (selectedSource === 'aggregate') {
                    results = deduplicateResults(results);
                }
                await IDB.setSearchCache(cacheKey, results);
                if (activeSearchId !== thisSearchId) return;
                displayResults(results);
                foundResults = true;
            }
        } catch (error) {
            console.error('搜索失败:', error);
            if (activeSearchId !== thisSearchId) return;
            DOM.resultsContainer.textContent = error.message || '搜索失败，请重试';
            if (attemptCount >= 3) break;
        }

        if (foundResults) break;
        
        if (attemptCount >= 3) {
            DOM.resultsContainer.innerHTML = '没有找到相关歌曲，请尝试其他关键词。';
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}
