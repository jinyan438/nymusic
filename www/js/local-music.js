// 本地音乐模块 - 支持扫描本地文件夹和高解析度音频(24bit/192kHz)
const LocalMusic = {
    // 支持的音频格式
    SUPPORTED_FORMATS: ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg', '.wma', '.aiff', '.alac', '.dsd', '.dsf', '.dff'],
    
    // 本地歌单
    localPlaylists: [],
    currentLocalFolder: null,
    SCAN_CONCURRENCY: 4,
    METADATA_VERSION: 1,
    scanInProgress: false,
    scanHideTimer: null,
    
    // 初始化
    async init() {
        await this.loadLocalPlaylists();
        this.renderLocalPlaylists();
        console.log('本地音乐模块初始化完成, 歌单数量:', this.localPlaylists.length);
    },
    
    // 清除所有本地歌单（调试用）
    async clearAllLocalPlaylists() {
        this.localPlaylists = [];
        await this.saveLocalPlaylists();
        this.renderLocalPlaylists();
        console.log('已清除所有本地歌单');
    },
    
    // 检查是否在Capacitor环境
    isCapacitor() {
        return typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();
    },
    
    // 扫描文件夹（Web环境使用File System Access API）
    async scanFolder() {
        if (this.scanInProgress) return;
        this.setScanning(true);
        try {
            if (this.isCapacitor()) {
                await this.scanFolderNative();
            } else {
                await this.scanFolderWeb();
            }
        } finally {
            this.setScanning(false);
        }
    },

    setScanning(scanning) {
        this.scanInProgress = scanning;
        if (DOM.scanLocalBtn) DOM.scanLocalBtn.disabled = scanning;
    },
    
    // 扫描进度状态
    scanProgress: {
        total: 0,
        current: 0
    },
    
    // 更新扫描进度显示
    updateScanProgress(current, message) {
        this.scanProgress.current = current;
        const now = Date.now();
        if (!message && now - (this.scanProgress.lastUpdate || 0) < 100) return;
        this.scanProgress.lastUpdate = now;
        if (DOM.localScanStatus) {
            DOM.localScanStatus.textContent = message || `正在扫描... 已找到 ${current} 首歌曲`;
        }
        if (DOM.scanProgressFill) {
            // 使用动画效果，进度条会随着扫描数量增长
            const width = this.scanProgress.total > 0 ?
                Math.min(95, current / this.scanProgress.total * 95) : Math.min(90, current * 2);
            DOM.scanProgressFill.style.width = width + '%';
        }
    },
    
    // 显示扫描进度区域
    showScanProgress() {
        clearTimeout(this.scanHideTimer);
        this.scanProgress = { total: 0, current: 0 };
        if (DOM.localScanProgress) {
            DOM.localScanProgress.style.display = 'block';
        }
        if (DOM.scanProgressFill) {
            DOM.scanProgressFill.style.width = '0%';
        }
    },
    
    // 隐藏扫描进度区域
    hideScanProgress(delay = 0) {
        clearTimeout(this.scanHideTimer);
        this.scanHideTimer = setTimeout(() => {
            if (DOM.localScanProgress) {
                DOM.localScanProgress.style.display = 'none';
            }
        }, delay);
    },
    
    // Web环境扫描文件夹
    async scanFolderWeb() {
        try {
            if (!('showDirectoryPicker' in window)) {
                alert('您的浏览器不支持文件夹选择，请使用Chrome/Edge浏览器或在Android应用中使用');
                return;
            }
            
            const dirHandle = await window.showDirectoryPicker();
            const folderName = dirHandle.name;
            
            this.showScanProgress();
            this.updateScanProgress(0, '正在扫描...');
            
            const previousTracks = await this.getPreviousWebTracks(dirHandle);
            const tracks = await this.scanDirectoryRecursive(dirHandle, '', previousTracks);
            
            if (tracks.length === 0) {
                this.updateScanProgress(0, '未找到音频文件');
                if (DOM.scanProgressFill) DOM.scanProgressFill.style.width = '100%';
                this.hideScanProgress(2000);
                return;
            }
            
            // 扫描完成，进度条到100%
            if (DOM.scanProgressFill) DOM.scanProgressFill.style.width = '100%';
            
            // 创建本地歌单
            const playlist = {
                id: 'local_' + Date.now(),
                name: folderName,
                path: folderName,
                tracks: tracks,
                createTime: Date.now(),
                isLocal: true
            };
            
            // 检查是否已存在同名歌单（同一文件夹）
            const existingIndex = this.localPlaylists.findIndex(p => p.name === folderName);
            if (existingIndex !== -1) {
                // 已存在同名文件夹，询问是更新还是添加为新歌单
                const action = await this.showFolderExistsDialog(folderName);
                if (action === 'update') {
                    // 更新现有歌单
                    playlist.id = this.localPlaylists[existingIndex].id;
                    this.localPlaylists[existingIndex] = playlist;
                } else if (action === 'add') {
                    // 添加为新歌单（带时间戳）
                    playlist.name = folderName + ' (' + new Date().toLocaleTimeString() + ')';
                    this.localPlaylists.push(playlist);
                } else {
                    // 取消
                    this.hideScanProgress();
                    return;
                }
            } else {
                // 新文件夹，直接添加
                this.localPlaylists.push(playlist);
            }
            
            await this.saveLocalPlaylists();
            this.renderLocalPlaylists();
            
            this.updateScanProgress(tracks.length, `扫描完成，找到 ${tracks.length} 首歌曲`);
            if (DOM.scanProgressFill) DOM.scanProgressFill.style.width = '100%';
            this.hideScanProgress(2500);
            
            // 保存目录句柄以便后续访问
            this.saveDirHandle(playlist.id, dirHandle);
            
        } catch (error) {
            if (error.name !== 'AbortError') {
                console.error('扫描文件夹失败:', error);
                this.updateScanProgress(0, '扫描失败: ' + error.message);
                this.hideScanProgress(3000);
            } else {
                this.hideScanProgress();
            }
        }
    },
    
    // 显示文件夹已存在对话框
    showFolderExistsDialog(folderName) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'folder-picker-overlay';
            overlay.innerHTML = `
                <div class="folder-picker-dialog">
                    <h3>文件夹已存在</h3>
                    <p style="color:var(--text-color-secondary);margin:1rem 0;">文件夹"${folderName}"已在列表中，请选择操作：</p>
                    <div class="folder-picker-options">
                        <button class="folder-option" data-action="update">
                            <i class="fas fa-sync-alt"></i>
                            <span>更新现有歌单</span>
                        </button>
                        <button class="folder-option" data-action="add">
                            <i class="fas fa-plus"></i>
                            <span>添加为新歌单</span>
                        </button>
                    </div>
                    <button class="folder-picker-cancel">取消</button>
                </div>
            `;
            
            document.body.appendChild(overlay);
            
            overlay.querySelectorAll('.folder-option').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.body.removeChild(overlay);
                    resolve(btn.dataset.action);
                });
            });
            
            overlay.querySelector('.folder-picker-cancel').addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve('cancel');
            });
        });
    },

    async getPreviousWebTracks(handle) {
        for (const playlist of this.localPlaylists) {
            const savedHandle = this.getDirHandle(playlist.id) || await this.loadDirHandle(playlist.id);
            try {
                if (savedHandle && await handle.isSameEntry(savedHandle)) return playlist.tracks;
            } catch (error) {
                // 无法确认目录身份时重新读取，避免同名文件夹共用标签。
            }
        }
        return [];
    },

    // 先遍历目录，再由固定数量的 worker 解析；结果保持目录原有顺序。
    async scanDirectoryTree(root, basePath, readEntries, readTrack, previousTracks) {
        const files = [];
        const cache = new Map(previousTracks.map(track => [track.filePath, track]));
        const visit = async (directory, path, isRoot = false) => {
            try {
                const entries = await readEntries(directory);
                for await (const entry of entries) {
                    const entryPath = path ? `${path.replace(/\/$/, '')}/${entry.name}` : entry.name;
                    if (entry.kind === 'directory' || entry.type === 'directory') {
                        await visit(entry.kind ? entry : entryPath, entryPath);
                    } else if (this.SUPPORTED_FORMATS.includes('.' + entry.name.split('.').pop().toLowerCase())) {
                        files.push({ entry, path: entryPath });
                    }
                }
            } catch (error) {
                if (isRoot) throw error;
                console.warn('读取子目录失败:', path, error);
            }
        };
        await visit(root, basePath, true);
        this.scanProgress.total = files.length;
        const tracks = new Array(files.length);
        let next = 0;
        let completed = 0;
        const worker = async () => {
            while (next < files.length) {
                const index = next++;
                const { entry, path } = files[index];
                try {
                    tracks[index] = await readTrack(entry, path, cache.get(path));
                } catch (error) {
                    console.warn('解析文件失败:', entry.name, error);
                }
                this.updateScanProgress(++completed);
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.SCAN_CONCURRENCY, files.length) }, worker));
        return tracks.filter(Boolean);
    },

    canReuseTrack(track, size, lastModified) {
        return track && track.metadataVersion === this.METADATA_VERSION &&
            Number.isFinite(lastModified) && lastModified > 0 &&
            track.fileSize === size && track.fileLastModified === lastModified;
    },

    createLocalTrack(name, path, size, lastModified, metadata, previousTrack) {
        return {
            trackId: previousTrack?.trackId || 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            source: 'local',
            songName: metadata.title || name.replace(/\.[^/.]+$/, ''),
            artist: metadata.artist || '未知歌手',
            album: metadata.album || '未知专辑',
            duration: metadata.duration || 0,
            bitDepth: metadata.bitDepth || 16,
            sampleRate: metadata.sampleRate || 44100,
            format: name.split('.').pop().toUpperCase(),
            filePath: path,
            fileName: name,
            fileSize: size,
            fileLastModified: lastModified || 0,
            metadataVersion: metadata.readFailed ? 0 : this.METADATA_VERSION,
            isHiRes: metadata.bitDepth >= 24 || metadata.sampleRate > 48000,
            cover: metadata.cover || null,
            coverMimeType: metadata.coverMimeType || null,
            lyrics: metadata.lyrics || null
        };
    },

    async scanDirectoryRecursive(dirHandle, basePath = '', previousTracks = []) {
        return this.scanDirectoryTree(dirHandle, basePath, directory => directory.values(), async (entry, path, cached) => {
            const file = await entry.getFile();
            if (this.canReuseTrack(cached, file.size, file.lastModified)) return { ...cached };
            const metadata = await this.parseAudioMetadata(file);
            return this.createLocalTrack(entry.name, path, file.size, file.lastModified, metadata, cached);
        }, previousTracks);
    },
    
    // 解析音频元数据（支持24bit/192kHz、内嵌封面和歌词）
    async parseAudioMetadata(file) {
        const metadata = {
            title: null,
            artist: null,
            album: null,
            duration: 0,
            bitDepth: 16,
            sampleRate: 44100,
            cover: null,
            lyrics: null,
            coverMimeType: null
        };
        
        try {
            const ext = file.name.split('.').pop().toLowerCase();
            const arrayBuffer = await AudioMetadataReader.fromFile(file).metadata(ext);
            const dataView = new DataView(arrayBuffer);
            if (ext === 'flac' && dataView.byteLength >= 4) {
                await this.parseFLAC(dataView, metadata);
            } else if (ext === 'wav' && dataView.byteLength >= 12) {
                await this.parseWAV(dataView, metadata);
            } else if (ext === 'mp3' && dataView.byteLength >= 10) {
                await this.parseMP3(dataView, metadata);
            } else if ((ext === 'aiff' || ext === 'aif') && dataView.byteLength >= 12) {
                await this.parseAIFF(dataView, metadata);
            } else if (ext === 'm4a' || ext === 'aac') {
                await this.parseM4A(dataView, metadata);
            }
            
            // 使用Web Audio API获取时长
            if (!metadata.duration) {
                metadata.duration = await this.getAudioDuration(file);
            }
            
        } catch (error) {
            metadata.readFailed = true;
            console.error('解析元数据失败:', error);
        }
        
        return metadata;
    },
    
    // 解析FLAC文件（支持24bit/192kHz、内嵌封面和歌词）
    async parseFLAC(dataView, metadata) {
        // 检查FLAC标识
        if (dataView.getUint32(0) !== 0x664C6143) return; // "fLaC"
        
        let offset = 4;
        let isLastBlock = false;
        
        while (!isLastBlock && offset < dataView.byteLength - 4) {
            const blockHeader = dataView.getUint8(offset);
            isLastBlock = (blockHeader & 0x80) !== 0;
            const blockType = blockHeader & 0x7F;
            const blockSize = (dataView.getUint8(offset + 1) << 16) | 
                             (dataView.getUint8(offset + 2) << 8) | 
                             dataView.getUint8(offset + 3);
            offset += 4;
            
            if (blockType === 0) { // STREAMINFO
                const byte12 = dataView.getUint8(offset + 12);
                
                metadata.sampleRate = (dataView.getUint8(offset + 10) << 12) |
                                     (dataView.getUint8(offset + 11) << 4) |
                                     (dataView.getUint8(offset + 12) >> 4);
                
                metadata.bitDepth = ((byte12 & 0x01) << 4) | ((dataView.getUint8(offset + 13) >> 4) & 0x0F);
                metadata.bitDepth += 1;
                
                const totalSamples = ((dataView.getUint8(offset + 13) & 0x0F) * Math.pow(2, 32)) +
                                    dataView.getUint32(offset + 14);
                
                if (metadata.sampleRate > 0) {
                    metadata.duration = totalSamples / metadata.sampleRate;
                }
            } else if (blockType === 4) { // VORBIS_COMMENT
                this.parseVorbisComment(dataView, offset, blockSize, metadata);
            } else if (blockType === 6) { // PICTURE
                this.parseFLACPicture(dataView, offset, blockSize, metadata);
            }
            
            offset += blockSize;
        }
    },
    
    // 解析FLAC内嵌图片
    parseFLACPicture(dataView, offset, blockSize, metadata) {
        try {
            let pos = offset;
            const endPos = offset + blockSize;
            
            // 图片类型 (4 bytes, big-endian)
            // 0=其他, 1=文件图标, 2=其他文件图标, 3=封面(front), 4=封底(back)...
            const pictureType = dataView.getUint32(pos);
            pos += 4;
            
            // MIME类型长度 (4 bytes, big-endian)
            const mimeLength = dataView.getUint32(pos);
            pos += 4;
            
            if (mimeLength > 256 || pos + mimeLength > endPos) return;
            
            const mimeBytes = new Uint8Array(dataView.buffer, pos, mimeLength);
            const mimeType = new TextDecoder().decode(mimeBytes);
            pos += mimeLength;
            
            // 描述长度 (4 bytes, big-endian)
            const descLength = dataView.getUint32(pos);
            pos += 4;
            
            if (descLength > 10000 || pos + descLength > endPos) return;
            pos += descLength;
            
            // 宽度(4) + 高度(4) + 色深(4) + 索引色数量(4) = 16 bytes
            pos += 16;
            
            // 图片数据长度 (4 bytes, big-endian)
            const dataLength = dataView.getUint32(pos);
            pos += 4;
            
            if (dataLength > 0 && dataLength < 50000000 && pos + dataLength <= dataView.byteLength) {
                // 优先使用封面类型3(front cover)，但如果没有封面则接受任何类型
                if (!metadata.cover || pictureType === 3) {
                    const imageData = new Uint8Array(dataView.buffer, pos, dataLength);
                    metadata.cover = this.arrayBufferToBase64(imageData);
                    metadata.coverMimeType = mimeType || 'image/jpeg';
                }
            }
        } catch (e) {
            console.warn('解析FLAC图片失败:', e);
        }
    },

    // 解析Vorbis注释（FLAC/OGG元数据，支持歌词和封面）
    parseVorbisComment(dataView, offset, blockSize, metadata) {
        try {
            const decoder = new TextDecoder('utf-8');
            let pos = offset;
            
            // 厂商字符串长度
            const vendorLength = dataView.getUint32(pos, true);
            pos += 4 + vendorLength;
            
            // 注释数量
            const commentCount = dataView.getUint32(pos, true);
            pos += 4;
            
            for (let i = 0; i < commentCount && pos < offset + blockSize; i++) {
                const commentLength = dataView.getUint32(pos, true);
                pos += 4;
                
                if (pos + commentLength > dataView.byteLength) break;
                
                const commentBytes = new Uint8Array(dataView.buffer, pos, commentLength);
                const comment = decoder.decode(commentBytes);
                pos += commentLength;
                
                const eqIndex = comment.indexOf('=');
                if (eqIndex > 0) {
                    const key = comment.substring(0, eqIndex).toUpperCase();
                    const value = comment.substring(eqIndex + 1);
                    
                    if (key === 'TITLE') metadata.title = value;
                    else if (key === 'ARTIST') metadata.artist = value;
                    else if (key === 'ALBUM') metadata.album = value;
                    else if (key === 'LYRICS' || key === 'UNSYNCEDLYRICS' || key === 'UNSYNCED LYRICS') {
                        metadata.lyrics = value;
                    } else if (key === 'METADATA_BLOCK_PICTURE' && !metadata.cover) {
                        // 有些工具会把封面存在Vorbis注释中（base64编码）
                        this.parseVorbisCommentPicture(value, metadata);
                    }
                }
            }
        } catch (e) {
            console.warn('解析Vorbis注释失败:', e);
        }
    },
    
    // 解析Vorbis注释中的封面（METADATA_BLOCK_PICTURE）
    parseVorbisCommentPicture(base64Data, metadata) {
        try {
            const binaryString = atob(base64Data);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }
            const dataView = new DataView(bytes.buffer);
            
            // 解析PICTURE块结构
            let pos = 0;
            const pictureType = dataView.getUint32(pos);
            pos += 4;
            
            const mimeLength = dataView.getUint32(pos);
            pos += 4;
            const mimeBytes = new Uint8Array(bytes.buffer, pos, mimeLength);
            const mimeType = new TextDecoder().decode(mimeBytes);
            pos += mimeLength;
            
            const descLength = dataView.getUint32(pos);
            pos += 4 + descLength + 16; // 跳过描述和宽高等
            
            const dataLength = dataView.getUint32(pos);
            pos += 4;
            
            if (dataLength > 0 && pos + dataLength <= bytes.length) {
                const imageData = new Uint8Array(bytes.buffer, pos, dataLength);
                metadata.cover = this.arrayBufferToBase64(imageData);
                metadata.coverMimeType = mimeType || 'image/jpeg';
            }
        } catch (e) {
            console.warn('解析Vorbis注释封面失败:', e);
        }
    },
    
    // 解析WAV文件（支持24bit/192kHz）
    async parseWAV(dataView, metadata) {
        // 检查RIFF标识
        if (dataView.getUint32(0) !== 0x52494646) return; // "RIFF"
        if (dataView.getUint32(8) !== 0x57415645) return; // "WAVE"
        
        let offset = 12;
        let byteRate = 0;
        
        while (offset <= dataView.byteLength - 8) {
            const chunkId = dataView.getUint32(offset);
            const chunkSize = dataView.getUint32(offset + 4, true);
            offset += 8;
            
            if (chunkId === 0x666D7420) { // "fmt "
                if (chunkSize < 16 || offset + chunkSize > dataView.byteLength) break;
                const audioFormat = dataView.getUint16(offset, true);
                const numChannels = dataView.getUint16(offset + 2, true);
                metadata.sampleRate = dataView.getUint32(offset + 4, true);
                byteRate = dataView.getUint32(offset + 8, true);
                const blockAlign = dataView.getUint16(offset + 12, true);
                metadata.bitDepth = dataView.getUint16(offset + 14, true);
            } else if (chunkId === 0x64617461) { // "data"
                const dataSize = chunkSize;
                metadata.duration = byteRate > 0 ? dataSize / byteRate : 0;
                break;
            }
            
            offset += chunkSize;
            if (chunkSize % 2 !== 0) offset++; // 对齐
        }
    },
    
    // 解析MP3文件
    async parseMP3(dataView, metadata) {
        let offset = 0;
        
        // 检查ID3v2标签
        if (dataView.getUint8(0) === 0x49 && dataView.getUint8(1) === 0x44 && dataView.getUint8(2) === 0x33) {
            const majorVersion = dataView.getUint8(3); // ID3v2.3 = 3, ID3v2.4 = 4
            const id3Size = ((dataView.getUint8(6) & 0x7F) << 21) |
                           ((dataView.getUint8(7) & 0x7F) << 14) |
                           ((dataView.getUint8(8) & 0x7F) << 7) |
                           (dataView.getUint8(9) & 0x7F);
            
            this.parseID3v2(dataView, 10, id3Size, metadata, majorVersion);
            offset = 10 + id3Size;
        }
        
        // 查找MP3帧头
        while (offset < dataView.byteLength - 4) {
            if (dataView.getUint8(offset) === 0xFF && (dataView.getUint8(offset + 1) & 0xE0) === 0xE0) {
                const header = dataView.getUint32(offset);
                const version = (header >> 19) & 0x03;
                const layer = (header >> 17) & 0x03;
                const sampleRateIndex = (header >> 10) & 0x03;
                
                const sampleRates = {
                    0: [44100, 22050, 11025],
                    1: [48000, 24000, 12000],
                    2: [32000, 16000, 8000]
                };
                
                if (sampleRates[sampleRateIndex]) {
                    const versionIndex = version === 3 ? 0 : (version === 2 ? 1 : 2);
                    metadata.sampleRate = sampleRates[sampleRateIndex][versionIndex];
                }
                
                metadata.bitDepth = 16; // MP3固定16位
                break;
            }
            offset++;
        }
    },
    
    // 解析ID3v2标签（支持封面和歌词）
    parseID3v2(dataView, offset, size, metadata, majorVersion = 3) {
        const end = Math.min(offset + size, dataView.byteLength);
        
        while (offset < end - 10) {
            // 检查是否到达填充区域
            if (dataView.getUint8(offset) === 0) break;
            
            const frameId = String.fromCharCode(
                dataView.getUint8(offset),
                dataView.getUint8(offset + 1),
                dataView.getUint8(offset + 2),
                dataView.getUint8(offset + 3)
            );
            
            // 检查frameId是否有效
            if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
            
            let frameSize;
            if (majorVersion === 4) {
                // ID3v2.4 使用同步安全整数
                frameSize = ((dataView.getUint8(offset + 4) & 0x7F) << 21) |
                           ((dataView.getUint8(offset + 5) & 0x7F) << 14) |
                           ((dataView.getUint8(offset + 6) & 0x7F) << 7) |
                           (dataView.getUint8(offset + 7) & 0x7F);
            } else {
                // ID3v2.3 使用普通整数
                frameSize = (dataView.getUint8(offset + 4) << 24) |
                           (dataView.getUint8(offset + 5) << 16) |
                           (dataView.getUint8(offset + 6) << 8) |
                           dataView.getUint8(offset + 7);
            }
            
            if (frameSize === 0 || frameSize > size || offset + 10 + frameSize > end) break;
            
            offset += 10;
            
            if (frameId === 'TIT2' || frameId === 'TPE1' || frameId === 'TALB') {
                const text = this.parseID3TextFrame(dataView, offset, frameSize);
                if (frameId === 'TIT2') metadata.title = text;
                else if (frameId === 'TPE1') metadata.artist = text;
                else if (frameId === 'TALB') metadata.album = text;
            } else if (frameId === 'APIC') {
                // 解析内嵌封面
                this.parseAPIC(dataView, offset, frameSize, metadata);
            } else if (frameId === 'USLT' || frameId === 'SYLT') {
                // 解析歌词 (USLT=非同步歌词, SYLT=同步歌词)
                this.parseID3Lyrics(dataView, offset, frameSize, metadata, frameId === 'SYLT');
            }
            
            offset += frameSize;
        }
    },
    
    // 解析ID3文本帧
    parseID3TextFrame(dataView, offset, frameSize) {
        const encoding = dataView.getUint8(offset);
        let text = '';
        
        try {
            if (encoding === 0 || encoding === 3) {
                const bytes = new Uint8Array(dataView.buffer, offset + 1, frameSize - 1);
                text = new TextDecoder('utf-8').decode(bytes).replace(/\0/g, '');
            } else if (encoding === 1) {
                // UTF-16 with BOM
                const bytes = new Uint8Array(dataView.buffer, offset + 1, frameSize - 1);
                const bom = (bytes[0] << 8) | bytes[1];
                const decoder = new TextDecoder(bom === 0xFFFE ? 'utf-16le' : 'utf-16be');
                text = decoder.decode(bytes.slice(2)).replace(/\0/g, '');
            } else if (encoding === 2) {
                const bytes = new Uint8Array(dataView.buffer, offset + 1, frameSize - 1);
                text = new TextDecoder('utf-16be').decode(bytes).replace(/\0/g, '');
            }
        } catch (e) {}
        
        return text;
    },
    
    // 解析APIC帧（内嵌封面）
    parseAPIC(dataView, offset, frameSize, metadata) {
        try {
            const endPos = offset + frameSize;
            const encoding = dataView.getUint8(offset);
            let pos = offset + 1;
            
            // 读取MIME类型 (以null结尾的字符串)
            let mimeType = '';
            while (pos < endPos && dataView.getUint8(pos) !== 0) {
                mimeType += String.fromCharCode(dataView.getUint8(pos));
                pos++;
            }
            pos++; // 跳过null终止符
            
            if (pos >= endPos) return;
            
            // 图片类型 (1 byte) - 0=其他, 3=封面(front cover)
            const pictureType = dataView.getUint8(pos);
            pos++;
            
            // 跳过描述 (根据编码类型)
            if (encoding === 0 || encoding === 3) {
                // ISO-8859-1 或 UTF-8: 单字节null终止
                while (pos < endPos && dataView.getUint8(pos) !== 0) pos++;
                pos++;
            } else {
                // UTF-16: 双字节null终止
                while (pos < endPos - 1) {
                    if (dataView.getUint8(pos) === 0 && dataView.getUint8(pos + 1) === 0) {
                        pos += 2;
                        break;
                    }
                    pos++;
                }
            }
            
            // 图片数据
            const imageLength = endPos - pos;
            
            if (imageLength > 100 && pos + imageLength <= dataView.byteLength) {
                const imageData = new Uint8Array(dataView.buffer, pos, imageLength);
                
                // 检测图片类型
                let detectedMime = mimeType;
                if (imageData[0] === 0xFF && imageData[1] === 0xD8) {
                    detectedMime = 'image/jpeg';
                } else if (imageData[0] === 0x89 && imageData[1] === 0x50) {
                    detectedMime = 'image/png';
                } else if (imageData[0] === 0x47 && imageData[1] === 0x49) {
                    detectedMime = 'image/gif';
                } else if (imageData[0] === 0x42 && imageData[1] === 0x4D) {
                    detectedMime = 'image/bmp';
                }
                
                // 优先使用封面类型3，但如果没有封面则接受任何类型
                if (!metadata.cover || pictureType === 3) {
                    metadata.cover = this.arrayBufferToBase64(imageData);
                    metadata.coverMimeType = detectedMime || 'image/jpeg';
                }
            }
        } catch (e) {
            console.warn('解析APIC失败:', e);
        }
    },
    
    // 解析ID3歌词帧
    parseID3Lyrics(dataView, offset, frameSize, metadata, isSynced) {
        try {
            const encoding = dataView.getUint8(offset);
            let pos = offset + 1;
            
            // 语言 (3 bytes)
            pos += 3;
            
            // 跳过内容描述
            if (encoding === 0 || encoding === 3) {
                while (pos < offset + frameSize && dataView.getUint8(pos) !== 0) pos++;
                pos++;
            } else {
                while (pos < offset + frameSize - 1) {
                    if (dataView.getUint8(pos) === 0 && dataView.getUint8(pos + 1) === 0) {
                        pos += 2;
                        break;
                    }
                    pos++;
                }
            }
            
            // 歌词内容
            const lyricsLength = offset + frameSize - pos;
            if (lyricsLength > 0) {
                const lyricsBytes = new Uint8Array(dataView.buffer, pos, lyricsLength);
                let lyrics = '';
                
                if (encoding === 0 || encoding === 3) {
                    lyrics = new TextDecoder('utf-8').decode(lyricsBytes).replace(/\0/g, '');
                } else if (encoding === 1) {
                    const bom = (lyricsBytes[0] << 8) | lyricsBytes[1];
                    const decoder = new TextDecoder(bom === 0xFFFE ? 'utf-16le' : 'utf-16be');
                    lyrics = decoder.decode(lyricsBytes.slice(2)).replace(/\0/g, '');
                } else if (encoding === 2) {
                    lyrics = new TextDecoder('utf-16be').decode(lyricsBytes).replace(/\0/g, '');
                }
                
                if (lyrics) {
                    metadata.lyrics = lyrics;
                }
            }
        } catch (e) {
            console.warn('解析歌词失败:', e);
        }
    },

    // 解析AIFF文件（支持24bit/192kHz）
    async parseAIFF(dataView, metadata) {
        // 检查FORM标识
        if (dataView.getUint32(0) !== 0x464F524D) return; // "FORM"
        
        const formType = dataView.getUint32(8);
        if (formType !== 0x41494646 && formType !== 0x41494643) return; // "AIFF" or "AIFC"
        
        let offset = 12;
        
        while (offset <= dataView.byteLength - 8) {
            const chunkId = dataView.getUint32(offset);
            const chunkSize = dataView.getUint32(offset + 4);
            offset += 8;
            
            if (chunkId === 0x434F4D4D) { // "COMM"
                if (chunkSize < 18 || offset + chunkSize > dataView.byteLength) break;
                const numChannels = dataView.getInt16(offset);
                const numSampleFrames = dataView.getUint32(offset + 2);
                metadata.bitDepth = dataView.getInt16(offset + 6);
                
                // 解析80位扩展精度浮点数（采样率）
                const exp = dataView.getUint16(offset + 8);
                const mantissa = dataView.getUint32(offset + 10);
                metadata.sampleRate = Math.round(mantissa * Math.pow(2, (exp - 16383 - 31)));
                
                if (metadata.sampleRate > 0) {
                    metadata.duration = numSampleFrames / metadata.sampleRate;
                }
                break;
            }
            
            offset += chunkSize;
            if (chunkSize % 2 !== 0) offset++;
        }
    },
    
    // 解析M4A/AAC文件（支持封面和歌词）
    async parseM4A(dataView, metadata) {
        try {
            let offset = 0;
            
            while (offset < dataView.byteLength - 8) {
                const size = dataView.getUint32(offset);
                const type = String.fromCharCode(
                    dataView.getUint8(offset + 4),
                    dataView.getUint8(offset + 5),
                    dataView.getUint8(offset + 6),
                    dataView.getUint8(offset + 7)
                );
                
                if (size === 0) break;
                
                if (type === 'moov' || type === 'udta' || type === 'meta' || type === 'ilst') {
                    // 递归进入容器atom
                    const headerSize = type === 'meta' ? 12 : 8;
                    offset += headerSize;
                    continue;
                }
                
                if (type === '©nam') {
                    metadata.title = this.parseM4ATextAtom(dataView, offset);
                } else if (type === '©ART') {
                    metadata.artist = this.parseM4ATextAtom(dataView, offset);
                } else if (type === '©alb') {
                    metadata.album = this.parseM4ATextAtom(dataView, offset);
                } else if (type === 'covr') {
                    this.parseM4ACover(dataView, offset, size, metadata);
                } else if (type === '©lyr') {
                    metadata.lyrics = this.parseM4ATextAtom(dataView, offset);
                } else if (type === 'mvhd' && size >= 28 && offset + size <= dataView.byteLength) {
                    const version = dataView.getUint8(offset + 8);
                    if (version === 0) {
                        const timescale = dataView.getUint32(offset + 20);
                        if (timescale) metadata.duration = dataView.getUint32(offset + 24) / timescale;
                    } else if (version === 1 && size >= 40) {
                        const timescale = dataView.getUint32(offset + 28);
                        const duration = dataView.getUint32(offset + 32) * 4294967296 + dataView.getUint32(offset + 36);
                        if (timescale) metadata.duration = duration / timescale;
                    }
                }
                
                offset += size;
            }
        } catch (e) {
            console.warn('解析M4A失败:', e);
        }
    },
    
    // 解析M4A文本atom
    parseM4ATextAtom(dataView, offset) {
        try {
            const size = dataView.getUint32(offset);
            // 跳过atom头(8) + data atom头(16)
            const textOffset = offset + 24;
            const textLength = size - 24;
            
            if (textLength > 0 && textOffset + textLength <= dataView.byteLength) {
                const bytes = new Uint8Array(dataView.buffer, textOffset, textLength);
                return new TextDecoder('utf-8').decode(bytes);
            }
        } catch (e) {}
        return null;
    },
    
    // 解析M4A封面
    parseM4ACover(dataView, offset, size, metadata) {
        try {
            // 跳过atom头(8) + data atom头(16)
            const dataOffset = offset + 24;
            const dataLength = size - 24;
            
            if (dataLength > 0 && dataOffset + dataLength <= dataView.byteLength) {
                const imageData = new Uint8Array(dataView.buffer, dataOffset, dataLength);
                metadata.cover = this.arrayBufferToBase64(imageData);
                
                // 检测图片类型
                if (imageData[0] === 0xFF && imageData[1] === 0xD8) {
                    metadata.coverMimeType = 'image/jpeg';
                } else if (imageData[0] === 0x89 && imageData[1] === 0x50) {
                    metadata.coverMimeType = 'image/png';
                } else {
                    metadata.coverMimeType = 'image/jpeg';
                }
            }
        } catch (e) {
            console.warn('解析M4A封面失败:', e);
        }
    },
    
    // ArrayBuffer转Base64
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        const parts = [];
        for (let i = 0; i < bytes.length; i += 0x8000) {
            parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
        }
        return btoa(parts.join(''));
    },
    
    // 使用Web Audio API获取音频时长
    async getAudioDuration(file) {
        return new Promise((resolve) => {
            const audio = new Audio();
            audio.preload = 'metadata';
            const url = URL.createObjectURL(file);
            const finish = (duration) => {
                clearTimeout(timer);
                audio.onloadedmetadata = null;
                audio.onerror = null;
                audio.removeAttribute('src');
                audio.load();
                URL.revokeObjectURL(url);
                resolve(Number.isFinite(duration) ? duration : 0);
            };
            const timer = setTimeout(() => finish(0), 5000);
            audio.onloadedmetadata = () => finish(audio.duration);
            audio.onerror = () => finish(0);
            audio.src = url;
        });
    },
    
    // 保存目录句柄（内存中）
    dirHandles: new Map(),
    
    // 保存目录句柄到内存和IndexedDB
    async saveDirHandle(playlistId, handle) {
        this.dirHandles.set(playlistId, handle);
        // 尝试持久化到IndexedDB（需要浏览器支持）
        try {
            const db = await this.openHandleDB();
            const tx = db.transaction('handles', 'readwrite');
            await tx.objectStore('handles').put({ id: playlistId, handle: handle });
            await tx.done;
        } catch (e) {
            console.warn('无法持久化目录句柄:', e);
        }
    },
    
    // 打开句柄存储数据库
    async openHandleDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('LocalMusicHandles', 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => resolve(request.result);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('handles')) {
                    db.createObjectStore('handles', { keyPath: 'id' });
                }
            };
        });
    },
    
    // 从IndexedDB加载目录句柄
    async loadDirHandle(playlistId) {
        try {
            const db = await this.openHandleDB();
            const tx = db.transaction('handles', 'readonly');
            const result = await new Promise((resolve, reject) => {
                const request = tx.objectStore('handles').get(playlistId);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            if (result && result.handle) {
                this.dirHandles.set(playlistId, result.handle);
                return result.handle;
            }
        } catch (e) {
            console.warn('无法加载目录句柄:', e);
        }
        return null;
    },
    
    getDirHandle(playlistId) {
        return this.dirHandles.get(playlistId);
    },
    
    // 请求重新授权访问目录
    async requestReauthorization(playlistId, folderName) {
        const confirmed = confirm(`需要重新授权访问"${folderName}"文件夹才能播放音乐。\n\n点击确定后请选择相同的文件夹。`);
        if (!confirmed) return false;
        
        try {
            const dirHandle = await window.showDirectoryPicker();
            // 验证是否是同一个文件夹
            if (dirHandle.name === folderName) {
                await this.saveDirHandle(playlistId, dirHandle);
                return true;
            } else {
                alert(`请选择"${folderName}"文件夹`);
                return false;
            }
        } catch (e) {
            if (e.name !== 'AbortError') {
                console.error('重新授权失败:', e);
            }
            return false;
        }
    },
    
    // 验证目录句柄权限
    async verifyPermission(handle) {
        if (!handle) return false;
        try {
            // 检查是否有读取权限
            const permission = await handle.queryPermission({ mode: 'read' });
            if (permission === 'granted') return true;
            
            // 请求权限
            const requestResult = await handle.requestPermission({ mode: 'read' });
            return requestResult === 'granted';
        } catch (e) {
            return false;
        }
    },
    
    // 获取文件用于播放（支持重新授权）
    async getFileForPlayback(track, playlistId) {
        let dirHandle = this.getDirHandle(playlistId);
        
        // 如果内存中没有，尝试从IndexedDB加载
        if (!dirHandle) {
            dirHandle = await this.loadDirHandle(playlistId);
        }
        
        // 验证权限
        if (dirHandle) {
            const hasPermission = await this.verifyPermission(dirHandle);
            if (!hasPermission) {
                dirHandle = null;
            }
        }
        
        if (!dirHandle) {
            throw new Error('NEED_REAUTH');
        }
        
        const pathParts = track.filePath.split('/');
        let currentHandle = dirHandle;
        
        for (let i = 0; i < pathParts.length - 1; i++) {
            currentHandle = await currentHandle.getDirectoryHandle(pathParts[i]);
        }
        
        const fileHandle = await currentHandle.getFileHandle(pathParts[pathParts.length - 1]);
        return await fileHandle.getFile();
    },
    
    // Android原生扫描
    async scanFolderNative() {
        try {
            // 使用文件选择器插件选择文件夹
            const result = await this.showNativeFolderPicker();
            if (!result) return;
            
            this.showScanProgress();
            this.updateScanProgress(0, '正在扫描...');
            
            const previousTracks = this.localPlaylists.find(playlist => playlist.path === result.path)?.tracks || [];
            const tracks = await this.scanNativeDirectory(result.path, previousTracks);
            
            if (tracks.length === 0) {
                this.updateScanProgress(0, '未找到音频文件');
                if (DOM.scanProgressFill) DOM.scanProgressFill.style.width = '100%';
                this.hideScanProgress(2000);
                return;
            }
            
            // 扫描完成，进度条到100%
            if (DOM.scanProgressFill) DOM.scanProgressFill.style.width = '100%';
            
            const playlist = {
                id: 'local_' + Date.now(),
                name: result.name,
                path: result.path,
                tracks: tracks,
                createTime: Date.now(),
                isLocal: true
            };
            
            // 检查是否已存在相同路径的歌单
            const existingIndex = this.localPlaylists.findIndex(p => p.path === result.path);
            if (existingIndex !== -1) {
                // 已存在相同路径，询问是更新还是添加为新歌单
                const action = await this.showFolderExistsDialog(result.name);
                if (action === 'update') {
                    // 更新现有歌单
                    playlist.id = this.localPlaylists[existingIndex].id;
                    this.localPlaylists[existingIndex] = playlist;
                } else if (action === 'add') {
                    // 添加为新歌单（带时间戳）
                    playlist.name = result.name + ' (' + new Date().toLocaleTimeString() + ')';
                    this.localPlaylists.push(playlist);
                } else {
                    // 取消
                    this.hideScanProgress();
                    return;
                }
            } else {
                // 新路径，直接添加
                this.localPlaylists.push(playlist);
            }
            
            await this.saveLocalPlaylists();
            this.renderLocalPlaylists();
            
            this.updateScanProgress(tracks.length, `扫描完成，找到 ${tracks.length} 首歌曲`);
            if (DOM.scanProgressFill) DOM.scanProgressFill.style.width = '100%';
            this.hideScanProgress(2500);
            
        } catch (error) {
            console.error('扫描失败:', error);
            this.updateScanProgress(0, '扫描失败: ' + error.message);
            this.hideScanProgress(3000);
        }
    },
    
    // 使用原生文件选择器选择文件夹
    async showNativeFolderPicker() {
        try {
            // 使用 @capawesome/capacitor-file-picker 插件
            const { FilePicker } = Capacitor.Plugins;
            
            if (FilePicker && FilePicker.pickDirectory) {
                const result = await FilePicker.pickDirectory();
                console.log('FilePicker结果:', result);
                if (result && result.path) {
                    // 处理content://URI，转换为实际路径
                    let path = result.path;
                    if (path.startsWith('content://')) {
                        // 尝试从URI中提取路径
                        path = this.convertContentUriToPath(path);
                    }
                    return { path: path, name: path.split('/').pop() };
                }
            }
        } catch (e) {
            console.warn('FilePicker不可用，使用备用方案:', e);
        }
        
        // 备用方案：显示预设路径选择对话框
        return this.showFolderPicker();
    },
    
    // 将content:// URI转换为文件路径
    convertContentUriToPath(uri) {
        // 尝试从常见的content URI格式中提取路径
        // content://com.android.externalstorage.documents/tree/primary%3AMusic
        try {
            const decoded = decodeURIComponent(uri);
            const match = decoded.match(/primary[:%](.+)/);
            if (match) {
                return '/storage/emulated/0/' + match[1].replace(/:/g, '/');
            }
            // 尝试其他格式
            const pathMatch = decoded.match(/\/storage\/[^/]+\/.+/);
            if (pathMatch) {
                return pathMatch[0];
            }
        } catch (e) {
            console.warn('URI转换失败:', e);
        }
        return uri;
    },
    
    // 显示文件夹选择器（备用方案）
    async showFolderPicker() {
        return new Promise((resolve) => {
            // 创建文件夹选择对话框
            const overlay = document.createElement('div');
            overlay.className = 'folder-picker-overlay';
            overlay.innerHTML = `
                <div class="folder-picker-dialog">
                    <h3>选择音乐文件夹</h3>
                    <div class="folder-picker-options">
                        <button class="folder-option" data-path="/storage/emulated/0/Music">
                            <i class="fas fa-music"></i>
                            <span>Music 文件夹</span>
                        </button>
                        <button class="folder-option" data-path="/storage/emulated/0/Download">
                            <i class="fas fa-download"></i>
                            <span>Download 文件夹</span>
                        </button>
                        <button class="folder-option" data-path="/storage/emulated/0/DCIM">
                            <i class="fas fa-folder"></i>
                            <span>DCIM 文件夹</span>
                        </button>
                        <button class="folder-option custom-path">
                            <i class="fas fa-edit"></i>
                            <span>自定义路径</span>
                        </button>
                    </div>
                    <div class="custom-path-input" style="display:none;">
                        <input type="text" placeholder="输入文件夹路径" value="/storage/emulated/0/">
                        <button class="confirm-path">确定</button>
                    </div>
                    <button class="folder-picker-cancel">取消</button>
                </div>
            `;
            
            document.body.appendChild(overlay);
            
            // 绑定事件
            overlay.querySelectorAll('.folder-option:not(.custom-path)').forEach(btn => {
                btn.addEventListener('click', () => {
                    const path = btn.dataset.path;
                    document.body.removeChild(overlay);
                    resolve({ path, name: path.split('/').pop() });
                });
            });
            
            overlay.querySelector('.custom-path').addEventListener('click', () => {
                overlay.querySelector('.custom-path-input').style.display = 'flex';
            });
            
            overlay.querySelector('.confirm-path').addEventListener('click', () => {
                const path = overlay.querySelector('.custom-path-input input').value.trim();
                if (path) {
                    document.body.removeChild(overlay);
                    resolve({ path, name: path.split('/').pop() });
                }
            });
            
            overlay.querySelector('.folder-picker-cancel').addEventListener('click', () => {
                document.body.removeChild(overlay);
                resolve(null);
            });
        });
    },

    // 扫描原生目录
    async scanNativeDirectory(path, previousTracks = []) {
        const { Filesystem } = Capacitor.Plugins;
        const readEntries = async (directoryPath) => {
            let result;
            try {
                // 绝对路径直接读取，避免每个目录先走一次错误的存储位置。
                result = await Filesystem.readdir({ path: directoryPath });
            } catch (e1) {
                try {
                    result = await Filesystem.readdir({ path: directoryPath, directory: 'EXTERNAL' });
                } catch (e2) {
                    result = await Filesystem.readdir({ path: directoryPath, directory: 'EXTERNAL_STORAGE' });
                }
            }
            return result.files || [];
        };
        return this.scanDirectoryTree(path, path, readEntries, async (file, fullPath, cached) => {
            const size = file.size || 0;
            const lastModified = file.mtime || 0;
            if (this.canReuseTrack(cached, size, lastModified)) return { ...cached };
            const metadata = await this.parseNativeAudioFile(file.uri || fullPath, size);
            return this.createLocalTrack(file.name, fullPath, size, lastModified, metadata, cached);
        }, previousTracks);
    },
    
    // 解析原生音频文件
    async parseNativeAudioFile(filePath, size) {
        const metadata = {
            title: null,
            artist: null,
            album: null,
            duration: 0,
            bitDepth: 16,
            sampleRate: 44100,
            cover: null,
            coverMimeType: null,
            lyrics: null
        };
        
        try {
            const ext = filePath.split('.').pop().toLowerCase();
            const reader = await AudioMetadataReader.fromNative(filePath, size);
            const dataView = new DataView(await reader.metadata(ext));
            
            if (ext === 'flac' && dataView.byteLength >= 4) {
                await this.parseFLAC(dataView, metadata);
            } else if (ext === 'wav' && dataView.byteLength >= 12) {
                await this.parseWAV(dataView, metadata);
            } else if (ext === 'mp3' && dataView.byteLength >= 10) {
                await this.parseMP3(dataView, metadata);
            } else if (ext === 'm4a' || ext === 'aac') {
                await this.parseM4A(dataView, metadata);
            } else if ((ext === 'aiff' || ext === 'aif') && dataView.byteLength >= 12) {
                await this.parseAIFF(dataView, metadata);
            }
            
        } catch (error) {
            metadata.readFailed = true;
            console.warn('解析原生文件失败:', error);
        }
        
        return metadata;
    },
    
    // 播放本地音乐
    async playLocalTrack(track, playlistId) {
        try {
            currentTrackData = { ...track, playlistId };
            showPage('player-page');
            
            DOM.songTitle.textContent = track.songName;
            
            // 显示音质信息 - 每首歌都显示 bit 和 kHz
            const qualityInfo = `${track.format} ${track.bitDepth}bit/${(track.sampleRate/1000).toFixed(1)}kHz`;
            DOM.artistName.textContent = `${track.artist} · ${qualityInfo}`;
            
            updateLikeButton();
            
            // 显示封面（使用扫描时保存的封面数据，无封面时自动获取）
            console.log('播放本地音乐, 封面数据:', track.cover ? '有(' + track.cover.length + '字符)' : '无');
            if (track.cover) {
                const coverUrl = `data:${track.coverMimeType || 'image/jpeg'};base64,${track.cover}`;
                DOM.albumArt.style.backgroundImage = `url('${coverUrl}')`;
                DOM.backgroundContainer.style.backgroundImage = `url('${coverUrl}')`;
            } else {
                // 先显示默认封面
                const defaultCover = this.generateDefaultCover(track.format);
                DOM.albumArt.style.backgroundImage = `url('${defaultCover}')`;
                DOM.backgroundContainer.style.backgroundImage = '';
                // 异步获取封面
                this.fetchAndDisplayCover(track);
            }
            DOM.albumArt.style.animationPlayState = 'paused';
            
            // 显示歌词（使用扫描时保存的歌词数据，无歌词时自动获取）
            currentLyrics = [];
            currentLyricIndex = -1;
            if (track.lyrics) {
                this.displayLocalLyrics(track.lyrics);
            } else {
                // 无内嵌歌词，自动从API获取
                DOM.lyricsContainer.innerHTML = '<p>正在搜索歌词...</p>';
                this.fetchAndDisplayLyrics(track);
            }
            
            DOM.currentTimeDisplay.textContent = '00:00';
            DOM.durationDisplay.textContent = formatTime(track.duration);
            DOM.progressBar.style.width = '0%';
            
            let audioUrl;
            
            if (this.isCapacitor()) {
                // Android原生播放
                const { Filesystem } = Capacitor.Plugins;
                const result = await Filesystem.getUri({ path: track.filePath });
                audioUrl = Capacitor.convertFileSrc(result.uri);
            } else {
                // Web播放 - 需要目录句柄，支持重新授权
                try {
                    const file = await this.getFileForPlayback(track, playlistId);
                    audioUrl = URL.createObjectURL(file);
                } catch (e) {
                    if (e.message === 'NEED_REAUTH') {
                        // 需要重新授权
                        const playlist = this.localPlaylists.find(p => p.id === playlistId);
                        const folderName = playlist ? playlist.name : '音乐';
                        const reauthorized = await this.requestReauthorization(playlistId, folderName);
                        if (reauthorized) {
                            // 重新授权成功，再次尝试播放
                            const file = await this.getFileForPlayback(track, playlistId);
                            audioUrl = URL.createObjectURL(file);
                        } else {
                            return;
                        }
                    } else {
                        throw e;
                    }
                }
            }
            
            DOM.audioPlayer.src = audioUrl;
            DOM.audioPlayer.play();
            
        } catch (error) {
            console.error('播放本地音乐失败:', error);
            alert('播放失败: ' + error.message);
        }
    },
    
    // 生成默认封面（使用Canvas绘制）
    generateDefaultCover(format) {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 400;
        const ctx = canvas.getContext('2d');
        
        // 渐变背景
        const gradient = ctx.createLinearGradient(0, 0, 400, 400);
        gradient.addColorStop(0, '#2c3e50');
        gradient.addColorStop(1, '#1a1a2e');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 400, 400);
        
        // 音符图标
        ctx.fillStyle = '#8e44ad';
        ctx.font = 'bold 120px FontAwesome, Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('♪', 200, 180);
        
        // 格式文字
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 36px Arial';
        ctx.fillText(format || 'AUDIO', 200, 300);
        
        return canvas.toDataURL('image/png');
    },
    
    // 自动获取并显示封面（本地音乐无内嵌封面时调用）
    async fetchAndDisplayCover(track) {
        try {
            const coverUrl = await fetchCoverFromAPI(track.songName, track.artist, track.album);
            if (coverUrl) {
                // 确保还是同一首歌
                if (currentTrackData && currentTrackData.trackId === track.trackId) {
                    await displayCover(coverUrl, [DOM.albumArt, DOM.backgroundContainer]);
                    console.log('本地音乐自动获取封面成功:', track.songName);
                }
            }
        } catch (error) {
            console.error('自动获取封面失败:', error);
        }
    },

    // 自动获取并显示歌词（本地音乐无内嵌歌词时调用）
    async fetchAndDisplayLyrics(track) {
        try {
            const lrcText = await fetchLyricsFromAPI(track.songName, track.artist, track.album);
            if (lrcText && displayLyrics(lrcText, DOM.lyricsContainer)) {
                console.log('本地音乐自动获取歌词成功:', track.songName);
            } else {
                DOM.lyricsContainer.innerHTML = '<p>暂无歌词</p>';
            }
        } catch (error) {
            console.error('自动获取歌词失败:', error);
            DOM.lyricsContainer.innerHTML = '<p>暂无歌词</p>';
        }
    },

    // 显示本地歌词
    displayLocalLyrics(lyricsText) {
        currentLyrics = [];
        currentLyricIndex = -1;
        
        if (!lyricsText) {
            DOM.lyricsContainer.innerHTML = '<p>暂无歌词</p>';
            return;
        }
        
        // 尝试解析LRC格式歌词
        const lines = lyricsText.split(/\r?\n/);
        const lrcRegex = /\[(\d{2}):(\d{2})(?:\.(\d{2,3}))?\]/g;
        let hasTimestamps = false;
        
        for (const line of lines) {
            if (lrcRegex.test(line)) {
                hasTimestamps = true;
                break;
            }
            lrcRegex.lastIndex = 0;
        }
        
        DOM.lyricsContainer.innerHTML = '';
        
        if (hasTimestamps) {
            // LRC格式歌词，使用现有的歌词解析
            currentLyrics = parseLyrics(lyricsText);
            currentLyrics.sort((a, b) => a.time - b.time);
            
            if (currentLyrics.length > 0) {
                currentLyrics.forEach(line => {
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
                    DOM.lyricsContainer.appendChild(p);
                });
            }
        } else {
            // 纯文本歌词
            lines.forEach(line => {
                if (line.trim()) {
                    const p = document.createElement('p');
                    p.textContent = line;
                    DOM.lyricsContainer.appendChild(p);
                }
            });
        }
    },
    
    // 保存本地歌单
    async saveLocalPlaylists() {
        await IDB.setSetting('localPlaylists', this.localPlaylists);
    },
    
    // 加载本地歌单
    async loadLocalPlaylists() {
        const saved = await IDB.getSetting('localPlaylists', []);
        this.localPlaylists = saved;
    },

    // 渲染本地歌单列表
    renderLocalPlaylists() {
        if (!DOM.localPlaylistsContainer) return;
        
        DOM.localPlaylistsContainer.innerHTML = '';
        
        if (this.localPlaylists.length === 0) {
            DOM.localPlaylistsContainer.innerHTML = '<p style="text-align:center;color:var(--text-color-secondary);font-size:0.9rem;">点击上方按钮扫描本地音乐文件夹<br><small>支持添加多个文件夹</small></p>';
            return;
        }
        
        // 显示文件夹统计
        const totalTracks = this.localPlaylists.reduce((sum, pl) => sum + pl.tracks.length, 0);
        const totalHiRes = this.localPlaylists.reduce((sum, pl) => sum + pl.tracks.filter(t => t.isHiRes).length, 0);
        
        const statsDiv = document.createElement('div');
        statsDiv.className = 'local-stats';
        statsDiv.innerHTML = `<small style="color:var(--text-color-secondary);">共 ${this.localPlaylists.length} 个文件夹，${totalTracks} 首歌曲${totalHiRes > 0 ? `，${totalHiRes} 首Hi-Res` : ''}</small>`;
        statsDiv.style.cssText = 'text-align:center;margin-bottom:0.5rem;';
        DOM.localPlaylistsContainer.appendChild(statsDiv);
        
        this.localPlaylists.forEach((pl, index) => {
            const hiResCount = pl.tracks.filter(t => t.isHiRes).length;
            const item = document.createElement('div');
            item.className = 'list-item';
            item.innerHTML = `
                <i class="fas fa-folder-open" style="font-size:1.5rem;margin-right:1rem;color:var(--primary-color);"></i>
                <div class="info">
                    <div class="song-name">${pl.name}</div>
                    <div class="artist-album">${pl.tracks.length} 首歌曲${hiResCount > 0 ? ` · ${hiResCount} 首Hi-Res` : ''}</div>
                </div>
                <div class="action-buttons">
                    <button class="action-btn refresh-local-btn" title="刷新"><i class="fas fa-sync-alt"></i></button>
                    <button class="action-btn remove-local-btn" title="移除"><i class="fas fa-trash-alt"></i></button>
                </div>
            `;
            
            addFastClick(item.querySelector('.info'), () => this.openLocalPlaylistDetail(index));
            item.querySelector('.refresh-local-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                await this.refreshLocalPlaylist(index);
            });
            item.querySelector('.remove-local-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`确定移除本地歌单 "${pl.name}" 吗？\n（不会删除实际文件）`)) {
                    this.localPlaylists.splice(index, 1);
                    this.saveLocalPlaylists();
                    this.renderLocalPlaylists();
                }
            });
            
            DOM.localPlaylistsContainer.appendChild(item);
        });
    },
    
    // 刷新本地歌单
    async refreshLocalPlaylist(index) {
        const pl = this.localPlaylists[index];
        if (!pl || this.scanInProgress) return;
        this.setScanning(true);
        this.showScanProgress();
        this.updateScanProgress(0, '正在刷新...');
        
        try {
            if (this.isCapacitor()) {
                const tracks = await this.scanNativeDirectory(pl.path, pl.tracks);
                pl.tracks = tracks;
            } else {
                const dirHandle = this.getDirHandle(pl.id) || await this.loadDirHandle(pl.id);
                if (!dirHandle) {
                    alert('需要重新选择文件夹');
                    this.hideScanProgress();
                    return;
                }
                if (!await this.verifyPermission(dirHandle)) {
                    this.hideScanProgress();
                    return;
                }
                const tracks = await this.scanDirectoryRecursive(dirHandle, '', pl.tracks);
                pl.tracks = tracks;
            }
            
            await this.saveLocalPlaylists();
            this.renderLocalPlaylists();
            this.updateScanProgress(pl.tracks.length, `刷新完成，共 ${pl.tracks.length} 首歌曲`);
            if (DOM.scanProgressFill) DOM.scanProgressFill.style.width = '100%';
            this.hideScanProgress(2500);
        } catch (error) {
            this.updateScanProgress(0, '刷新失败: ' + error.message);
            this.hideScanProgress(3000);
        } finally {
            this.setScanning(false);
        }
    },
    
    // 打开本地歌单详情
    openLocalPlaylistDetail(index) {
        const pl = this.localPlaylists[index];
        if (!pl) return;
        
        this.currentLocalFolder = { playlist: pl, index };
        
        showPage('local-detail-page');
        DOM.localDetailTitle.textContent = pl.name;
        
        const hiResCount = pl.tracks.filter(t => t.isHiRes).length;
        DOM.localDetailInfo.textContent = `${pl.tracks.length} 首歌曲${hiResCount > 0 ? ` · ${hiResCount} 首Hi-Res` : ''}`;
        
        this.renderLocalDetailSongs(pl);
    },
    
    // 渲染本地歌单详情歌曲列表
    renderLocalDetailSongs(pl) {
        DOM.localDetailSongs.innerHTML = '';
        
        if (pl.tracks.length === 0) {
            DOM.localDetailSongs.innerHTML = '<p style="text-align:center;color:var(--text-color-secondary);">文件夹是空的</p>';
            return;
        }
        
        pl.tracks.forEach((track, index) => {
            const item = document.createElement('div');
            item.className = 'list-item';
            
            const qualityBadge = track.isHiRes ? 
                `<span class="hires-badge">Hi-Res</span>` : '';
            
            const formatInfo = `${track.format} ${track.bitDepth}bit/${(track.sampleRate/1000).toFixed(1)}kHz`;
            
            // 封面图片：有内嵌封面则显示，否则先显示音符图标，再异步检查缓存
            let coverHtml;
            if (track.cover) {
                const coverUrl = `data:${track.coverMimeType || 'image/jpeg'};base64,${track.cover}`;
                coverHtml = `<img src="${coverUrl}" alt="封面" class="local-track-cover">`;
            } else {
                // 无内嵌封面，使用占位符，稍后异步加载缓存封面
                coverHtml = `<div class="local-track-icon" data-track-index="${index}"><i class="fas fa-music"></i></div>`;
            }
            
            item.innerHTML = `
                <span style="min-width:30px;text-align:center;color:var(--text-color-secondary);">${index + 1}</span>
                ${coverHtml}
                <div class="info">
                    <div class="song-name">${track.songName} ${qualityBadge}</div>
                    <div class="artist-album">${track.artist} · ${formatInfo}</div>
                </div>
                <div class="action-buttons">
                    <button class="action-btn disabled" title="本地音乐不支持收藏" disabled><i class="fas fa-lock"></i></button>
                </div>
            `;
            
            addFastClick(item.querySelector('.info'), () => {
                currentPlaylistIndex = index;
                // 设置当前播放列表为本地歌单
                playlist = pl.tracks.map(t => ({ ...t, playlistId: pl.id }));
                this.playLocalTrack(track, pl.id);
            });
            
            DOM.localDetailSongs.appendChild(item);
            
            // 异步加载缓存封面（无内嵌封面的歌曲）
            if (!track.cover) {
                this.loadCachedCoverForListItem(item, track, index);
            }
        });
    },
    
    // 为列表项加载缓存封面
    async loadCachedCoverForListItem(item, track, index) {
        try {
            const cleanTitle = cleanCoverSearchText(track.songName);
            const cleanArtist = cleanCoverSearchText(track.artist);
            
            if (!cleanTitle && !cleanArtist) return;
            
            const cachedCover = await IDB.getCoverCache(cleanTitle, cleanArtist);
            if (cachedCover) {
                const iconDiv = item.querySelector(`.local-track-icon[data-track-index="${index}"]`);
                if (iconDiv) {
                    // 替换图标为封面图片
                    const img = document.createElement('img');
                    img.src = cachedCover;
                    img.alt = '封面';
                    img.className = 'local-track-cover';
                    img.onerror = () => {
                        // 图片加载失败，恢复图标
                        img.replaceWith(iconDiv);
                    };
                    iconDiv.replaceWith(img);
                }
            }
        } catch (e) {
            // 忽略缓存读取错误
        }
    },
    
    // 格式化文件大小
    formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
};

// 播放本地音乐的全局函数
function playLocalSong(track, playlistId) {
    LocalMusic.playLocalTrack(track, playlistId);
}
