// 歌词API配置
const LYRICS_API_BASE = 'https://api.lrc.cx/lyrics';
// CORS代理列表（按优先级排序，Web端使用）
const CORS_PROXIES = [
    'https://corsproxy.io/?',
    'https://api.allorigins.win/raw?url='
];
// 请求超时时间（毫秒）
const LYRICS_FETCH_TIMEOUT = 10000;

// 清理歌曲/歌手名称（去除括号内容、特殊字符等）
function cleanSearchText(text) {
    if (!text) return '';
    return text
        .replace(/\s*[\(（\[【].*?[\)）\]】]\s*/g, '') // 去除括号内容
        .replace(/\s*-\s*.*$/, '') // 去除 - 后面的内容
        .replace(/[,，、;；:：!！?？]/g, ' ') // 替换标点为空格
        .trim();
}

// 检查是否在Capacitor原生环境
function isCapacitorNative() {
    return typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();
}

// 验证并返回有效歌词
function validateLyrics(lrcText) {
    if (!lrcText || !lrcText.includes('[') || !lrcText.includes(']')) {
        return null;
    }
    // 检查是否是无效歌词
    if (lrcText.includes('纯音乐') && lrcText.length < 100) {
        console.log('返回的是纯音乐占位歌词，忽略');
        return null;
    }
    return lrcText;
}

// 缓存歌词（异步，不阻塞）
function cacheLyrics(cleanTitle, cleanArtist, lyrics) {
    if (lyrics && cleanTitle) {
        IDB.setLyricsCache(cleanTitle, cleanArtist, lyrics).catch(e => 
            console.warn('缓存歌词失败:', e)
        );
    }
}

// 自动获取歌词（无歌词时调用，带缓存）
async function fetchLyricsFromAPI(title, artist, album) {
    // 清理搜索文本
    const cleanTitle = cleanSearchText(title);
    const cleanArtist = cleanSearchText(artist);
    
    console.log('原始标题:', title, '清理后:', cleanTitle);
    console.log('原始歌手:', artist, '清理后:', cleanArtist);
    
    // 先检查缓存
    try {
        const cachedLyrics = await IDB.getLyricsCache(cleanTitle, cleanArtist);
        if (cachedLyrics) {
            console.log('从缓存读取歌词');
            return cachedLyrics;
        }
    } catch (e) {
        console.warn('读取歌词缓存失败:', e);
    }
    
    // 构建查询参数
    const params = new URLSearchParams();
    if (cleanTitle) params.append('title', cleanTitle);
    if (cleanArtist) params.append('artist', cleanArtist);
    if (album) params.append('album', cleanSearchText(album));
    
    const originalUrl = `${LYRICS_API_BASE}?${params.toString()}`;
    console.log('歌词API原始URL:', originalUrl);
    
    // 安卓原生环境使用原生HTTP请求（绕过WebView限制）
    if (isCapacitorNative()) {
        console.log('安卓原生环境，尝试原生HTTP请求');
        try {
            // Capacitor 6+ 内置 CapacitorHttp
            if (typeof Capacitor !== 'undefined' && Capacitor.CapacitorHttp) {
                const response = await Capacitor.CapacitorHttp.request({
                    url: originalUrl,
                    method: 'GET',
                    headers: { 'Accept': 'text/plain, */*' }
                });
                
                console.log('原生HTTP响应状态:', response.status);
                if (response.status === 200 && response.data) {
                    const lrcText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
                    console.log('歌词API返回内容长度:', lrcText.length);
                    const validLyrics = validateLyrics(lrcText);
                    if (validLyrics) {
                        console.log('成功获取歌词');
                        cacheLyrics(cleanTitle, cleanArtist, validLyrics);
                        return validLyrics;
                    }
                }
            } else {
                // 回退到普通fetch
                console.log('CapacitorHttp不可用，使用fetch');
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), LYRICS_FETCH_TIMEOUT);
                const response = await fetch(originalUrl, { signal: controller.signal });
                clearTimeout(timeoutId);
                
                if (response.ok) {
                    const lrcText = await response.text();
                    console.log('fetch返回内容长度:', lrcText.length);
                    const validLyrics = validateLyrics(lrcText);
                    if (validLyrics) {
                        console.log('成功获取歌词');
                        cacheLyrics(cleanTitle, cleanArtist, validLyrics);
                        return validLyrics;
                    }
                }
            }
        } catch (error) {
            console.error('安卓请求失败:', error.message || error);
        }
        // 安卓直接请求失败，继续尝试代理
        console.log('安卓直接请求失败，尝试使用代理');
    }
    
    // 使用CORS代理（Web环境或安卓直接请求失败后）
    console.log('使用CORS代理获取歌词');
    for (const proxy of CORS_PROXIES) {
        try {
            const proxyUrl = proxy + encodeURIComponent(originalUrl);
            console.log('尝试代理:', proxy);
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000); // 8秒超时
            
            const response = await fetch(proxyUrl, {
                method: 'GET',
                headers: { 'Accept': 'text/plain, */*' },
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            console.log('歌词API响应状态:', response.status);
            
            if (response.ok) {
                const lrcText = await response.text();
                console.log('歌词API返回内容长度:', lrcText.length);
                const validLyrics = validateLyrics(lrcText);
                if (validLyrics) {
                    console.log('成功获取歌词');
                    cacheLyrics(cleanTitle, cleanArtist, validLyrics);
                    return validLyrics;
                }
            }
        } catch (error) {
            console.warn('代理请求失败:', proxy, error.message);
            continue;
        }
    }
    
    console.log('所有代理都失败了');
    return null;
}

// 批量搜索歌词（返回多个结果供选择）
async function searchLyricsFromAPI(title, artist, album) {
    try {
        const params = new URLSearchParams();
        if (title) params.append('title', title);
        if (artist) params.append('artist', artist);
        if (album) params.append('album', album);
        
        // 使用同一个API端点
        const url = `${LYRICS_API_BASE}?${params.toString()}`;
        console.log('搜索歌词:', url);
        
        const response = await fetch(url);
        if (response.ok) {
            const lrcText = await response.text();
            if (lrcText && lrcText.includes('[')) {
                return [{ lyrics: lrcText, title, artist }];
            }
        }
        return [];
    } catch (error) {
        console.error('搜索歌词失败:', error);
        return [];
    }
}

// 显示歌词到容器（通用函数）
function displayLyrics(lrcText, container) {
    const lyrics = parseLyrics(lrcText);
    lyrics.sort((a, b) => a.time - b.time);
    container.innerHTML = '';
    
    // 检查是否是有效歌词（排除"暂无歌词"、"纯音乐"等占位内容）
    const hasValidLyrics = lyrics.length > 1 || 
        (lyrics.length === 1 && !lyrics[0].text.includes('暂无歌词') && !lyrics[0].text.includes('纯音乐'));
    
    if (hasValidLyrics) {
        currentLyrics = lyrics;
        currentLyricIndex = -1;
        lyrics.forEach(line => {
            const p = document.createElement('p');
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
            container.appendChild(p);
        });
        return true;
    }
    return false;
}

// 歌词处理
function parseLyrics(lrcText) {
    if (!lrcText) return [];
    const lines = lrcText.split('\n');
    const lyrics = [];
    const lineTimeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;
    // 逐字时间标签: <00:01.50>字
    const wordTimeRegex = /<(\d{2}):(\d{2})\.(\d{2,3})>([^<]*)/g;
    
    for (const line of lines) {
        const match = lineTimeRegex.exec(line);
        if (match) {
            const lineTime = parseInt(match[1]) * 60 + parseInt(match[2]) + parseInt(match[3].padEnd(3, '0')) / 1000;
            const content = line.replace(lineTimeRegex, '').trim();
            if (!content) continue;
            
            // 检查是否有逐字时间标签
            const words = [];
            let wordMatch;
            let hasWordTiming = false;
            
            while ((wordMatch = wordTimeRegex.exec(content)) !== null) {
                hasWordTiming = true;
                const wordTime = parseInt(wordMatch[1]) * 60 + parseInt(wordMatch[2]) + parseInt(wordMatch[3].padEnd(3, '0')) / 1000;
                const wordText = wordMatch[4];
                if (wordText) {
                    words.push({ time: wordTime, text: wordText });
                }
            }
            wordTimeRegex.lastIndex = 0; // 重置正则
            
            if (hasWordTiming && words.length > 0) {
                // 有逐字时间标签
                lyrics.push({ time: lineTime, text: content.replace(/<\d{2}:\d{2}\.\d{2,3}>/g, ''), words });
            } else {
                // 无逐字时间标签，自动生成均匀分布的逐字时间
                const plainText = content;
                const chars = plainText.split('');
                if (chars.length > 0) {
                    lyrics.push({ time: lineTime, text: plainText, words: null, chars });
                }
            }
        }
    }
    return lyrics;
}

// 平滑滚动动画状态
let lyricsScrollAnimation = { current: 0, target: 0, animating: false };
let fullscreenScrollAnimation = { current: 0, target: 0, animating: false };

// 使用 requestAnimationFrame 实现平滑滚动
function smoothScrollTo(container, targetY, animState) {
    animState.target = targetY;
    if (animState.animating) return;
    animState.animating = true;
    
    const animate = () => {
        const diff = animState.target - animState.current;
        // 使用更平滑的插值系数 (0.08 适合120Hz)
        const ease = 0.08;
        
        if (Math.abs(diff) < 0.5) {
            animState.current = animState.target;
            container.scrollTop = animState.current;
            animState.animating = false;
            return;
        }
        
        animState.current += diff * ease;
        container.scrollTop = animState.current;
        requestAnimationFrame(animate);
    };
    
    requestAnimationFrame(animate);
}

function updateLyrics() {
    if (currentLyrics.length === 0) return;
    const currentTime = Playback.currentTime;
    let newLyricIndex = -1;
    for (let i = 0; i < currentLyrics.length; i++) {
        if (currentTime >= currentLyrics[i].time) newLyricIndex = i;
        else break;
    }
    
    // 行切换时更新高亮和滚动
    if (newLyricIndex !== currentLyricIndex) {
        currentLyricIndex = newLyricIndex;
        // 更新普通歌词行高亮
        const allLyricLines = DOM.lyricsContainer.querySelectorAll('p');
        allLyricLines.forEach((line, index) => line.classList.toggle('active-lyric', index === currentLyricIndex));
        if (currentLyricIndex !== -1) {
            const activeLine = allLyricLines[currentLyricIndex];
            if (activeLine) {
                const containerHeight = DOM.lyricsContainer.clientHeight;
                const lineTop = activeLine.offsetTop;
                const lineHeight = activeLine.offsetHeight;
                const targetScroll = lineTop - (containerHeight / 2) + (lineHeight / 2);
                lyricsScrollAnimation.current = DOM.lyricsContainer.scrollTop;
                smoothScrollTo(DOM.lyricsContainer, targetScroll, lyricsScrollAnimation);
            }
        }
        // 更新全屏歌词行高亮
        const fullscreenLines = DOM.fullscreenLyricsContainer.querySelectorAll('p');
        fullscreenLines.forEach((line, index) => line.classList.toggle('active-lyric', index === currentLyricIndex));
        if (currentLyricIndex !== -1) {
            const activeFullscreenLine = fullscreenLines[currentLyricIndex];
            if (activeFullscreenLine) {
                const containerHeight = DOM.fullscreenLyricsContainer.clientHeight;
                const lineTop = activeFullscreenLine.offsetTop;
                const lineHeight = activeFullscreenLine.offsetHeight;
                const targetScroll = lineTop - (containerHeight / 2) + (lineHeight / 2);
                fullscreenScrollAnimation.current = DOM.fullscreenLyricsContainer.scrollTop;
                smoothScrollTo(DOM.fullscreenLyricsContainer, targetScroll, fullscreenScrollAnimation);
            }
        }
    }
    
    // 逐字高亮更新
    if (currentLyricIndex !== -1) {
        updateWordHighlight(DOM.lyricsContainer, currentLyricIndex, currentTime);
        updateWordHighlight(DOM.fullscreenLyricsContainer, currentLyricIndex, currentTime);
    }
}

// 逐字高亮更新
function updateWordHighlight(container, lineIndex, currentTime) {
    const lyricLine = currentLyrics[lineIndex];
    const lineElement = container.querySelectorAll('p')[lineIndex];
    if (!lineElement) return;
    
    const spans = lineElement.querySelectorAll('span.lyric-char');
    if (spans.length === 0) return;
    
    if (lyricLine.words) {
        // 有逐字时间标签
        spans.forEach((span, i) => {
            if (i < lyricLine.words.length) {
                const wordTime = lyricLine.words[i].time;
                const nextWordTime = i < lyricLine.words.length - 1 ? lyricLine.words[i + 1].time : null;
                
                if (currentTime >= wordTime) {
                    if (nextWordTime && currentTime < nextWordTime) {
                        // 当前字正在播放，计算进度
                        const progress = (currentTime - wordTime) / (nextWordTime - wordTime);
                        span.style.setProperty('--char-progress', Math.min(progress, 1));
                        span.classList.add('char-active');
                    } else if (!nextWordTime || currentTime >= nextWordTime) {
                        // 已播放完
                        span.style.setProperty('--char-progress', 1);
                        span.classList.add('char-active');
                    }
                } else {
                    span.style.setProperty('--char-progress', 0);
                    span.classList.remove('char-active');
                }
            }
        });
    } else if (lyricLine.chars) {
        // 无逐字时间，均匀分布
        const nextLineTime = lineIndex < currentLyrics.length - 1 ? currentLyrics[lineIndex + 1].time : lyricLine.time + 5;
        const duration = nextLineTime - lyricLine.time;
        const charDuration = duration / lyricLine.chars.length;
        
        spans.forEach((span, i) => {
            const charStartTime = lyricLine.time + i * charDuration;
            const charEndTime = charStartTime + charDuration;
            
            if (currentTime >= charStartTime) {
                if (currentTime < charEndTime) {
                    const progress = (currentTime - charStartTime) / charDuration;
                    span.style.setProperty('--char-progress', Math.min(progress, 1));
                    span.classList.add('char-active');
                } else {
                    span.style.setProperty('--char-progress', 1);
                    span.classList.add('char-active');
                }
            } else {
                span.style.setProperty('--char-progress', 0);
                span.classList.remove('char-active');
            }
        });
    }
}

// 全屏歌词模式
function openFullscreenLyrics() {
    DOM.fullscreenLyrics.classList.add('active');
    // 同步歌词内容
    DOM.fullscreenLyricsContainer.innerHTML = DOM.lyricsContainer.innerHTML;
    // 同步当前高亮
    const fullscreenLines = DOM.fullscreenLyricsContainer.querySelectorAll('p');
    fullscreenLines.forEach((line, index) => line.classList.toggle('active-lyric', index === currentLyricIndex));
    // 同步歌曲信息
    DOM.fullscreenSongTitle.textContent = DOM.songTitle.textContent;
    DOM.fullscreenArtistName.textContent = DOM.artistName.textContent;
    DOM.fullscreenLyricsBg.style.backgroundImage = `url(${DOM.albumArt.src})`;
}

function closeFullscreenLyrics() {
    DOM.fullscreenLyrics.classList.remove('active');
}

function initFullscreenLyrics() {
    DOM.lyricsContainer.addEventListener('click', openFullscreenLyrics);
    DOM.fullscreenLyricsClose.addEventListener('click', closeFullscreenLyrics);
}
