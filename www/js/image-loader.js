// 封面API配置 - 直接返回图片
const COVER_API_BASE = 'https://api.lrc.cx/cover';

// 检查是否在Capacitor原生环境
function isCoverCapacitorNative() {
    return typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();
}

// 清理歌曲/歌手名称用于封面搜索
function cleanCoverSearchText(text) {
    if (!text) return '';
    return text
        .replace(/\s*[\(（\[【].*?[\)）\]】]\s*/g, '') // 去除括号内容
        .replace(/\s*-\s*.*$/, '') // 去除 - 后面的内容
        .replace(/[,，、;；:：!！?？]/g, ' ') // 替换标点为空格
        .replace(/未知歌手|未知专辑|Unknown/gi, '') // 去除未知标记
        .trim();
}

// 从API获取封面URL（API直接返回图片，带缓存）
async function fetchCoverFromAPI(title, artist, album) {
    // 清理搜索文本
    const cleanTitle = cleanCoverSearchText(title);
    const cleanArtist = cleanCoverSearchText(artist);
    const cleanAlbum = cleanCoverSearchText(album);
    
    console.log('尝试从API获取封面 - 标题:', cleanTitle, '歌手:', cleanArtist);
    
    // 如果清理后没有有效信息，直接返回
    if (!cleanTitle && !cleanArtist) {
        console.log('没有有效的搜索信息');
        return null;
    }
    
    // 先检查缓存
    try {
        const cachedCover = await IDB.getCoverCache(cleanTitle, cleanArtist);
        if (cachedCover) {
            console.log('从缓存读取封面URL');
            return cachedCover;
        }
    } catch (e) {
        console.warn('读取封面缓存失败:', e);
    }
    
    // 构建查询参数
    const params = new URLSearchParams();
    if (cleanTitle) params.append('title', cleanTitle);
    if (cleanArtist) params.append('artist', cleanArtist);
    if (cleanAlbum) params.append('album', cleanAlbum);
    
    // API直接返回图片，所以URL就是封面URL
    const coverUrl = `${COVER_API_BASE}?${params.toString()}`;
    console.log('封面API URL:', coverUrl);
    
    let resultUrl;
    
    // 安卓原生环境直接返回URL（不需要验证，让图片加载器处理）
    if (isCoverCapacitorNative()) {
        console.log('安卓环境，直接返回封面URL');
        resultUrl = coverUrl;
    } else {
        // Web环境需要通过代理访问
        resultUrl = 'https://corsproxy.io/?' + encodeURIComponent(coverUrl);
        console.log('Web环境，使用代理URL:', resultUrl);
    }
    
    // 缓存封面URL（异步，不阻塞）
    IDB.setCoverCache(cleanTitle, cleanArtist, resultUrl).catch(e => 
        console.warn('缓存封面URL失败:', e)
    );
    
    return resultUrl;
}

// 显示封面到元素
async function displayCover(coverUrl, elements) {
    if (!coverUrl || !elements || elements.length === 0) return false;
    
    try {
        // 预加载图片
        await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = resolve;
            img.onerror = reject;
            img.src = coverUrl;
        });
        
        // 设置背景图
        elements.forEach(el => {
            if (el) el.style.backgroundImage = `url('${coverUrl}')`;
        });
        return true;
    } catch (error) {
        console.error('封面图片加载失败:', error);
        return false;
    }
}

// 图片加载器
async function loadImageWithRetry(apiUrl, imgElement) {
    while (document.body.contains(imgElement)) {
        try {
            await new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = resolve;
                image.onerror = reject;
                image.src = apiUrl;
            });
            imgElement.src = apiUrl;
            return;
        } catch (error) {
            console.error(`Error loading image from ${apiUrl}, will retry immediately.`, error);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

async function loadBackgroundImageWithRetry(apiUrl, elements, expectedTrackId) {
    while (currentTrackData && currentTrackData.trackId === expectedTrackId) {
        try {
            await new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = resolve;
                image.onerror = reject;
                image.src = apiUrl;
            });
            if (currentTrackData && currentTrackData.trackId === expectedTrackId) {
                elements.forEach(el => {
                    if (el) el.style.backgroundImage = `url(${apiUrl})`;
                });
            }
            return;
        } catch (error) {
            console.error(`Error loading background image from ${apiUrl}, will retry immediately.`, error);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

// 带回退的封面加载（原始封面失败后从API获取）
async function loadBackgroundImageWithFallback(apiUrl, elements, expectedTrackId, songName, artist) {
    let retryCount = 0;
    const maxRetries = 3;
    
    // 先尝试加载原始封面
    while (currentTrackData && currentTrackData.trackId === expectedTrackId && retryCount < maxRetries) {
        try {
            await new Promise((resolve, reject) => {
                const image = new Image();
                image.onload = resolve;
                image.onerror = reject;
                image.src = apiUrl;
            });
            if (currentTrackData && currentTrackData.trackId === expectedTrackId) {
                elements.forEach(el => {
                    if (el) el.style.backgroundImage = `url(${apiUrl})`;
                });
            }
            return; // 成功加载
        } catch (error) {
            retryCount++;
            console.warn(`封面加载失败 (${retryCount}/${maxRetries}):`, apiUrl);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    // 原始封面加载失败，尝试从API获取
    if (currentTrackData && currentTrackData.trackId === expectedTrackId) {
        console.log('原始封面加载失败，尝试从API获取封面');
        try {
            const coverUrl = await fetchCoverFromAPI(songName, artist, null);
            if (coverUrl && currentTrackData && currentTrackData.trackId === expectedTrackId) {
                await displayCover(coverUrl, elements);
                console.log('自动获取封面成功');
            }
        } catch (error) {
            console.error('自动获取封面失败:', error);
        }
    }
}

function setupImageObserver() {
    imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(async entry => {
            if (entry.isIntersecting) {
                const img = entry.target;
                const apiUrl = img.dataset.apiUrl;
                const songAssetsCache = await caches.open(SONG_ASSETS_CACHE_NAME);
                const cachedResponse = await songAssetsCache.match(apiUrl);
                
                if (cachedResponse) {
                    const blob = await cachedResponse.blob();
                    img.src = URL.createObjectURL(blob);
                } else {
                    loadImageWithRetry(apiUrl, img);
                }
                observer.unobserve(img);
            }
        });
    }, { rootMargin: "0px 0px 200px 0px" });
}
