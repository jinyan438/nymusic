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
            if (cachedResults) {
                displayResults(cachedResults);
                return;
            }
        }
        
        let foundResults = false;
        try {
            let response;
            if (selectedSource === 'aggregate') {
                response = await fetch(`${API_BASE}?type=aggregateSearch&keyword=${encodeURIComponent(keyword)}`);
            } else {
                response = await fetch(`${API_BASE}?source=${selectedSource}&type=search&keyword=${encodeURIComponent(keyword)}&limit=30`);
            }
            const data = await response.json();
            if (data.code === 200 && data.data && data.data.results && data.data.results.length > 0) {
                let results = data.data.results;
                if (selectedSource === 'aggregate') {
                    results = deduplicateResults(results);
                }
                await IDB.setSearchCache(cacheKey, results);
                displayResults(results);
                foundResults = true;
            }
        } catch (error) {
            console.error('搜索失败:', error);
            DOM.resultsContainer.innerHTML = '搜索时发生错误，请重试...';
        }

        if (foundResults) break;
        
        if (attemptCount >= 3) {
            DOM.resultsContainer.innerHTML = '没有找到相关歌曲，请尝试其他关键词。';
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}
